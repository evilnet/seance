import {isPhoneLayout} from "./helpers/device";

import {createRouter, createWebHashHistory, type RouteLocationRaw} from "vue-router";
import Connect from "../components/Windows/Connect.vue";
import Settings from "../components/Windows/Settings.vue";
import Help from "../components/Windows/Help.vue";
import Changelog from "../components/Windows/Changelog.vue";
import NetworkEdit from "../components/Windows/NetworkEdit.vue";
import SearchResults from "../components/Windows/SearchResults.vue";
import RoutedChat from "../components/RoutedChat.vue";
import {store} from "./store";

import AppearanceSettings from "../components/Settings/Appearance.vue";
import GeneralSettings from "../components/Settings/General.vue";
import NotificationSettings from "../components/Settings/Notifications.vue";
import AliasSettings from "../components/Settings/Aliases.vue";
import NetworkSettings from "../components/Settings/Networks.vue";
import {ClientChan} from "./types";
import {shouldShowGeneralSettings} from "./helpers/settingsTabs";
import * as saved from "./irc/saved-networks";
import {clearPendingTarget, setPendingTarget} from "./helpers/pendingTarget";

const router = createRouter({
	history: createWebHashHistory(),
	routes: [
		{
			// Kept so old bookmarks don't 404; there is no sign-in step any more
			path: "/sign-in",
			redirect: {name: "Connect"},
		},
		{
			name: "Connect",
			path: "/connect",
			component: Connect,
			props: (route) => ({queryParams: route.query}),
		},
		{
			path: "/settings",
			component: Settings,
			children: [
				{
					name: "Networks",
					path: "networks",
					component: NetworkSettings,
				},
				{
					name: "NetworkEdit",
					path: "networks/:uuid",
					component: NetworkEdit,
				},
				{
					name: "General",
					path: "",
					component: GeneralSettings,
					beforeEnter(to, from, next) {
						if (!shouldShowGeneralSettings()) {
							next({name: "Appearance"});
							return;
						}

						next();
					},
				},
				{
					name: "Appearance",
					path: "appearance",
					component: AppearanceSettings,
				},
				{
					name: "Notifications",
					path: "notifications",
					component: NotificationSettings,
				},
				{
					name: "Aliases",
					path: "aliases",
					component: AliasSettings,
				},
			],
		},
		{
			name: "Help",
			path: "/help",
			component: Help,
		},
		{
			name: "Changelog",
			path: "/changelog",
			component: Changelog,
		},
		{
			path: "/edit-network/:uuid",
			redirect: (to) => `/settings/networks/${String(to.params.uuid)}`,
		},
		{
			name: "RoutedChat",
			path: "/chan-:id",
			component: RoutedChat,
		},
		{
			name: "SearchResults",
			path: "/chan-:id/search",
			component: SearchResults,
		},
		{
			// A conversation by network uuid + channel/nick: the deep link a
			// notification can still follow after the page — and its
			// session-local channel ids — is gone. Resolves to the channel
			// when it exists; otherwise remembers the target and lands on the
			// network (or the connect form, whose autoconnect brings the
			// network up) until the join for it arrives (socket-events/join.ts).
			name: "NetworkTarget",
			path: "/net/:uuid/:target",
			component: RoutedChat,
			beforeEnter(to) {
				const uuid = String(to.params.uuid);
				const target = String(to.params.target);
				const hit = findChannelByName(uuid, target);

				if (hit) {
					return {name: "RoutedChat", params: {id: hit.id}, replace: true};
				}

				setPendingTarget(uuid, target);
				const network = store.getters.findNetwork(uuid);

				if (network && network.channels.length > 0) {
					return {
						name: "RoutedChat",
						params: {id: network.channels[0].id},
						replace: true,
					};
				}

				return {name: "Connect", replace: true};
			},
		},
	],
});

/**
 * Every in-app navigation is a replace: the history never grows past the
 * entry the app opened on.
 *
 * iOS hands a swipe from within ~17px of the screen edge to its own
 * back/forward gesture, installed app included, and the page cannot decline
 * it: it is not scroll overscroll, so `overscroll-behavior` and `touch-action`
 * do not reach it, and the sidebar's passive drag cannot `preventDefault`.
 * Both recognisers ran — the pane toggled and the route went back under it —
 * which surfaced as a stale second sidebar and swipes that "opened Settings".
 * The one thing that stops it is having nothing to go back to.
 *
 * Overridden once here rather than at each call site, `<router-link>`
 * included (it calls `router.push` on this instance), so a future push cannot
 * bring the bug back. `replace()` does not go through `push`, so no recursion.
 * The cost is the browser's Back button no longer stepping through
 * conversations; the sidebar is the navigation.
 */
router.push = ((to: RouteLocationRaw) => router.replace(to)) as typeof router.push;

/** A channel on `uuid` by name, case-insensitively (IRC names). */
function findChannelByName(uuid: string, name: string): ClientChan | undefined {
	const network = store.getters.findNetwork(uuid);
	const lower = name.toLowerCase();

	return network?.channels.find((c) => c.name.toLowerCase() === lower);
}

/** Show the conversation a notification names (network uuid + target),
 * or remember it until its join arrives. */
function openTarget(uuid: string, target: string): void {
	const hit = findChannelByName(uuid, target);

	if (hit) {
		clearPendingTarget();
		switchToChannel(hit);
		return;
	}

	setPendingTarget(uuid, target);
}

router.beforeEach((to, from, next) => {
	// Wait for boot to finish before allowing any navigation
	if (!store.state.appLoaded) {
		store.watch(
			(state) => state.appLoaded,
			() => next()
		);

		return;
	}

	next();
});

router.beforeEach((to, from) => {
	// Disallow navigating to non-existing routes
	if (!to.matched.length) {
		return false;
	}

	// Disallow navigating to invalid channels
	if (to.name === "RoutedChat" && !store.getters.findChannel(Number(to.params.id))) {
		return false;
	}

	// Disallow navigating to invalid networks
	if (
		to.name === "NetworkEdit" &&
		!store.getters.findNetwork(String(to.params.uuid)) &&
		!saved.get(String(to.params.uuid))
	) {
		return false;
	}

	return true;
});

/**
 * The conversation last shown: what "back" means (Escape on Help, the Android
 * back button) now that there is no history to step through.
 */
let lastConversationId: number | undefined;

/**
 * Leave a page the user opened on purpose (settings, help, a network's form)
 * for the conversation they came from, else the first one there is, else the
 * connect form. Returns whether it went anywhere.
 */
function leavePage(): boolean {
	const previous =
		lastConversationId === undefined
			? undefined
			: store.getters.findChannel(lastConversationId);

	if (previous) {
		switchToChannel(previous.channel);
		return true;
	}

	const network = store.state.networks.find((n) => n.channels.length > 0);

	if (network) {
		switchToChannel(network.channels[0]);
		return true;
	}

	if (router.currentRoute.value.name !== "Connect") {
		void navigate("Connect");
		return true;
	}

	return false;
}

router.afterEach((to) => {
	if (to.name === "RoutedChat") {
		lastConversationId = Number(to.params.id);
	}

	if (store.state.appLoaded) {
		if (isPhoneLayout()) {
			store.commit("sidebarOpen", false);
		}
	}

	if (store.state.activeChannel) {
		const channel = store.state.activeChannel.channel;

		if (to.name !== "RoutedChat") {
			store.commit("activeChannel", undefined);
		}

		// When switching out of a channel, mark everything as read
		if (channel.messages?.length > 0) {
			channel.firstUnread = channel.messages[channel.messages.length - 1].id;
		}

		if (channel.messages?.length > 100) {
			channel.messages.splice(0, channel.messages.length - 100);
			channel.moreHistoryAvailable = true;
		}
	}
});

async function navigate(routeName: string, params: any = {}) {
	// Always a replace (see the `router.push` override); a guard refusing the
	// navigation is not an error here.
	await router.replace({name: routeName, params}).catch(() => {});
}

function switchToChannel(channel: ClientChan) {
	void navigate("RoutedChat", {id: channel.id});
}

/**
 * Whether the view is on a page the user opened on purpose — settings, help,
 * the changelog, a network's edit form, search results — as opposed to the
 * connect form (where the app lands when it has nowhere better to be) or a
 * conversation. A network coming up — the saved networks dialed at boot, a
 * reconnect's `init` — moves the view to a conversation only when it is not:
 * a reload on settings brings the networks back in the sidebar and stays on
 * settings. A route that is not resolved yet counts as nowhere.
 */
function onStandalonePage(): boolean {
	const name = router.currentRoute.value.name;

	return name !== undefined && name !== null && name !== "Connect" && name !== "RoutedChat";
}

if ("serviceWorker" in navigator) {
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (!event.data || event.data.type !== "open") {
			return;
		}

		// A notification click: by network + target when the worker knows
		// them (they outlive this page's channel ids), else by `chan-<id>`.
		if (typeof event.data.network === "string" && typeof event.data.target === "string") {
			openTarget(event.data.network, event.data.target);
			return;
		}

		if (typeof event.data.channel === "string" && event.data.channel.startsWith("chan-")) {
			const id = parseInt(event.data.channel.substring(5), 10); // remove "chan-" prefix
			const channelTarget = store.getters.findChannel(id);

			if (channelTarget) {
				switchToChannel(channelTarget.channel);
			}
		}
	});
}

export {
	router,
	navigate,
	switchToChannel,
	onStandalonePage,
	openTarget,
	findChannelByName,
	leavePage,
};
