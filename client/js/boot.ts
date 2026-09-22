// Application boot sequence.
//
// TheLounge drove this from a chain of server events (`auth:start` ->
// `auth:success` -> `configuration` -> `init`). With no server, boot is
// purely local: fetch the deployment branding (`config.json`), install the
// static configuration, apply stored settings, mark the app loaded, drop the
// loading splash and put the router on a sensible route (the connect form
// unless the URL says otherwise).

import configuration from "./configuration";
import {brandingFeatures, DEFAULT_UPLOAD_MAX_BYTES, loadBranding} from "./branding";
import {router, navigate, switchToChannel} from "./router";
import type {LocationQueryRaw} from "vue-router";
import {store} from "./store";
import parseIrcUri from "./helpers/parseIrcUri";
import {
	decideLinkTarget,
	linkSuggestion,
	sanitizeLinkParams,
	type LinkSuggestion,
} from "./helpers/linkTarget";
import * as saved from "./irc/saved-networks";
import type {SavedNetwork} from "./irc/saved-networks";
import {parseJoinList} from "./irc/client";
import {ChanState} from "../../shared/types/chan";
import socket from "./socket";
import {loadMentions} from "./mentions";
import storage from "./localStorage";
import {installNativeHooks} from "./native";
import {installForegroundHooks} from "./foreground";
import {installViewportHooks} from "./helpers/viewport";
import {onLaunch, openInstallGuideAtStart} from "./pwa";
// Also registers the IRC layer's bus handlers (input, names, more, network:*).
import {autoconnectSavedNetworks, clientForNetwork, createNetwork} from "./irc/manager";

declare global {
	interface Window {
		g_TheLoungeRemoveLoading?: () => void;
	}
}

// The URL the page was opened with, before handleQueryParams() strips it: the
// Launch Handler API replays the initial launch too, and it must not be
// applied twice.
const initialHref = document.location.href;

export async function boot(): Promise<void> {
	// Branding first: it decides the default theme and the document title,
	// and the connect form reads its defaults from it.
	const branding = await loadBranding();
	store.commit("branding", branding);
	document.title = branding.appName;

	if (branding.theme && configuration.themes.some((t) => t.name === branding.theme)) {
		configuration.defaultTheme = branding.theme;
	}

	if (branding.themeColor) {
		setThemeColor(branding.themeColor);
	}

	// Uploads exist only when the deploy names an uploader endpoint.
	configuration.fileUpload = branding.uploads !== undefined;
	configuration.fileUploadMaxFileSize =
		branding.uploads?.maxSizeBytes ?? DEFAULT_UPLOAD_MAX_BYTES;

	store.commit("serverConfiguration", configuration);

	// Before the settings store's first write (which would drop the old key):
	// the removed global "Enable browser notifications" checkbox, when it was
	// off, stamps notifyEnabled: false onto every saved network.
	saved.migrateGlobalNotify();

	// 'theme' setting depends on serverConfiguration.themes so
	// settings cannot be applied before this point
	void store.dispatch("settings/applyAll");

	// The branded default theme applies until the user picks one themselves.
	if (configuration.defaultTheme !== store.state.settings.theme && !hasStoredSetting("theme")) {
		void store.dispatch("settings/update", {
			name: "theme",
			value: configuration.defaultTheme,
		});
	}

	// If localStorage contains a theme that does not exist in this build, switch
	// back to the default theme.
	const currentTheme = configuration.themes.find((t) => t.name === store.state.settings.theme);

	if (currentTheme === undefined) {
		void store.dispatch("settings/update", {
			name: "theme",
			value: configuration.defaultTheme,
		});
	} else if (currentTheme.themeColor) {
		setThemeColor(currentTheme.themeColor);
	}

	loadMentions();
	installNativeHooks();
	installForegroundHooks();
	installViewportHooks();

	store.commit("appLoaded");

	try {
		await router.isReady();
	} catch (e: any) {
		// if the router throws an error, it means the route isn't matched,
		// so we can continue on.
	}

	if (window.g_TheLoungeRemoveLoading) {
		window.g_TheLoungeRemoveLoading();
	}

	// Installed app (manifest `launch_handler: focus-existing`): later
	// launches — web+irc:// links, ?uri= URLs — land here instead of reloading
	// the window, which would drop the IRC connection.
	onLaunch((url) => {
		if (url.href !== initialHref) {
			void handleQueryParams(url.search, false);
		}
	});

	if (await handleQueryParams()) {
		// The URL's web+irc:// link or connect parameters have been acted on:
		// a saved network is connecting, or the connect form is pre-filled
		// waiting for the user's approval.
		return;
	}

	// If we are on an unknown route, open the last known channel, or the
	// connect form if there is none.
	if (!router.currentRoute.value.name) {
		if (store.state.networks.length > 0) {
			await navigate("RoutedChat", {id: store.state.networks[0].channels[0].id});
		} else {
			await navigate("Connect");
		}
	}

	// The install guide, over whatever page opened: it is a modal, so it
	// goes up before a network's announce can move the view under it.
	openInstallGuideAtStart();

	// Startup owns autoconnect. Navigating to a screen must never create a
	// connection as a side effect (the old Connect-screen hook did exactly
	// that). Unknown-server links return above and resume this only after the
	// user accepts or declines their blocking prompt. Last, once the page has
	// its route: a network's announce moves the view to the remembered
	// conversation but leaves a page the user opened alone
	// (socket-events/network.ts), and it needs to know which it is on — and
	// the unknown-route fallback above must not run after it and override
	// the landing with the lobby.
	autoconnectSavedNetworks();
}

/**
 * Act on `?uri=web+irc://...` or plain `?host=...` connection parameters in
 * the URL. A link is a *suggestion*: when it names a server (host + port) the
 * user has saved before, connect to (or focus) that network and open the
 * channels it asks for; anything unknown pre-fills the connect form and waits
 * for the user — nothing connects and nothing is persisted until they approve
 * it there (docs/projects/irc-link-new-server-dialog.md). Secrets and
 * autoconnect flags are never taken from a URL. Returns true when there was
 * something to apply.
 *
 * @param search   the query string to read (defaults to the page URL's)
 * @param clean    strip the query from the address bar afterwards (only
 *                 meaningful for the page's own URL)
 */
async function handleQueryParams(
	search: string = document.location.search,
	clean: boolean = true
): Promise<boolean> {
	if (!("URLSearchParams" in window) || !search) {
		return false;
	}

	const params = new URLSearchParams(search);
	const raw = params.has("uri")
		? (parseIrcUri(String(params.get("uri"))) as Record<string, unknown>)
		: (Object.fromEntries(params.entries()) as Record<string, unknown>);

	if (clean) {
		removeQueryParams();
	}

	const suggestion = linkSuggestion(raw);

	if (!suggestion) {
		// No server named: the leftover parameters (nick, join, ...) still
		// pre-fill the connect form like they always did — minus secrets.
		await router.push({name: "Connect", query: sanitizeLinkParams(raw)});
		return true;
	}

	const branding = store.state.branding;
	const pinned = branding.defaultNetwork;
	const locked =
		!!pinned && (pinned.lockHost === true || !brandingFeatures(branding).allowCustomServer);
	const decision = decideLinkTarget(suggestion, {
		saved: saved.list(),
		lockedHost: locked ? pinned?.host : undefined,
	});

	if (decision.kind === "locked") {
		// This deploy connects to its own server only; say so instead of
		// silently offering an unrelated form.
		await router.push({
			name: "Connect",
			query: {linkIgnored: saved.hostnameOf(suggestion.host)},
		});
		return true;
	}

	if (decision.kind === "saved") {
		const entry = decision.network;
		const live = clientForNetwork(entry.uuid);

		// The connection would need a password nobody stored: back to the
		// form, pre-filled from the saved entry, to type it.
		if (!live?.isConnected && entry.sasl === "plain" && !entry.saslPassword) {
			await router.push({
				name: "Connect",
				query: {savedLink: entry.uuid, join: suggestion.join, fromLink: "1"},
			});
			return true;
		}

		openSavedTarget(entry, suggestion.join);
		return true;
	}

	// An unknown server: the "add server" dialog, nothing saved until the
	// user chooses to connect.
	await router.push({name: "Connect", query: suggestionQuery(decision.suggestion)});
	return true;
}

/** The Connect-route query for a link the user still has to approve. */
function suggestionQuery(suggestion: LinkSuggestion): LocationQueryRaw {
	const query: LocationQueryRaw = {
		fromLink: "1",
		host: suggestion.host,
		port: String(suggestion.port),
		tls: suggestion.tls ? "1" : "0",
	};

	if (suggestion.join) {
		query.join = suggestion.join;
	}

	if (suggestion.nick) {
		query.nick = suggestion.nick;
	}

	if (suggestion.saslAccount) {
		query.saslAccount = suggestion.saslAccount;
	}

	return query;
}

/**
 * A link named a server the user already approved: reuse the live connection
 * or dial it again, then open the channels the link asked for. Channels we
 * are not in yet are JOINed — the server's confirmation focuses them
 * (socket-events/join.ts) — and one we are already in is focused directly.
 */
function openSavedTarget(entry: SavedNetwork, join: string): void {
	const wanted = parseJoinList(join);
	const live = clientForNetwork(entry.uuid);
	const client = live?.isConnected ? live : createNetwork(entry);

	const openChannels = () => {
		const missing = wanted.filter((chan) => {
			const known = client.findChannel(chan.name);
			return !known || (known.state !== ChanState.JOINED && !known.autoJoin);
		});

		if (missing.length > 0) {
			const names = missing.map((chan) => chan.name).join(",");
			const keys = missing
				.map((chan) => chan.key)
				.join(",")
				.replace(/,+$/, "");
			client.input(client.lobby.id, keys ? `/join ${names} ${keys}` : `/join ${names}`);
		}

		const focus =
			wanted.map((chan) => client.findChannel(chan.name)).find((chan) => chan) ??
			(wanted.length === 0 ? client.lobby : undefined);
		const stored = focus && store.getters.findChannel(focus.id);

		if (stored) {
			switchToChannel(stored.channel);
		}
	};

	if (client.isConnected) {
		openChannels();
		return;
	}

	// Wait out the (re)connect; `init` has populated the store by the time
	// `network:status` reports the registration.
	const onStatus = ({network, connected}: {network: string; connected: boolean}) => {
		if (network !== entry.uuid || !connected) {
			return;
		}

		socket.off("network:status", onStatus);
		openChannels();
	};

	socket.on("network:status", onStatus);
}

function hasStoredSetting(name: string): boolean {
	try {
		const stored: unknown = JSON.parse(storage.get("settings") || "{}");
		return typeof stored === "object" && stored !== null && name in stored;
	} catch (e) {
		return false;
	}
}

function setThemeColor(color: string): void {
	const meta = document.querySelector('meta[name="theme-color"]');

	if (meta instanceof HTMLMetaElement) {
		meta.content = color;
	}
}

// Remove query parameters from url without reloading the page
function removeQueryParams(): void {
	const cleanUri = window.location.origin + window.location.pathname + window.location.hash;
	window.history.replaceState(null, "", cleanUri);
}
