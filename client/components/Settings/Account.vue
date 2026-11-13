<template>
	<div class="network-settings account-settings">
		<div class="network-settings-heading">
			<h2>{{ t("settings.account.heading") }}</h2>
		</div>

		<div class="network-settings-item">
			<div class="network-settings-summary">
				<strong>{{ networkName }}</strong>
				<span class="account-identity">{{ identity }}</span>
				<span :class="['network-settings-status', statusClass]">{{ statusLabel }}</span>
			</div>
			<div class="network-settings-actions">
				<button
					v-if="online"
					type="button"
					class="btn btn-sm account-disconnect"
					@click="disconnect"
				>
					{{ t("settings.account.disconnect") }}
				</button>
				<button
					v-else-if="entry || live"
					type="button"
					class="btn btn-sm account-connect"
					@click="connect"
				>
					{{ t("settings.networks.connect") }}
				</button>
				<button
					v-if="account"
					type="button"
					class="btn btn-sm account-sign-out"
					@click="signOut"
				>
					{{ t("settings.account.signOut") }}
				</button>
				<button v-else type="button" class="btn btn-sm account-sign-in" @click="signIn">
					{{ t("settings.account.signIn") }}
				</button>
			</div>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {accountRequired} from "../../js/branding";
import eventbus from "../../js/eventbus";
import useSavedNetworks from "../../js/hooks/use-saved-networks";
import {useI18n} from "../../js/i18n";
import {createNetwork} from "../../js/irc/manager";
import * as saved from "../../js/irc/saved-networks";
import {navigate, router} from "../../js/router";
import socket from "../../js/socket";
import {useStore} from "../../js/store";
import webpush from "../../js/webpush";

/**
 * Settings → Networks on a sign-in deploy that keeps its network as it set
 * it (`features.editNetworks: false`): no list, no edit form, no delete —
 * the one network, who this device signs in as, and the two things a user
 * may still do with it: connect or disconnect, and sign in or sign out.
 */
export default defineComponent({
	name: "AccountSettings",
	setup() {
		const store = useStore();
		const {t} = useI18n();
		const savedNetworks = useSavedNetworks();

		/** The deploy's one network as it is live here, if it is. */
		const live = computed(() => store.state.networks[0]);

		/**
		 * The saved entry this device signs in with: the live network's, else
		 * the most recently used (a sign-in deploy keeps one; `list()` is
		 * newest first).
		 */
		const entry = computed(() => {
			const uuid = live.value?.uuid;
			return uuid
				? savedNetworks.value.find((net) => net.uuid === uuid)
				: savedNetworks.value[0];
		});

		/** The account it signs in as; empty for a guest or nobody. */
		const account = computed(() =>
			entry.value?.sasl === "plain" ? entry.value.saslAccount : ""
		);

		const networkName = computed(
			() =>
				live.value?.name ||
				(entry.value ? saved.displayName(entry.value) : "") ||
				store.state.branding.defaultNetwork?.name ||
				store.state.branding.appName
		);

		const identity = computed(() => {
			if (account.value) {
				return t("settings.account.signedIn", {account: account.value});
			}

			// A deploy that lets only accounts in has no guests: an entry left
			// from when it did is nobody signed in.
			const nick = accountRequired() ? "" : live.value?.nick || entry.value?.nick;
			return nick ? t("settings.account.guest", {nick}) : t("settings.account.signedOut");
		});

		const online = computed(
			() => !!live.value && (live.value.status.connected || live.value.status.connecting)
		);

		const statusLabel = computed(() => {
			const status = live.value?.status;
			return status?.connected
				? t("settings.networks.connected")
				: status?.connecting
				? t("settings.networks.connecting")
				: t("settings.networks.disconnected");
		});

		const statusClass = computed(() => {
			const status = live.value?.status;
			return status?.connected
				? "is-connected"
				: status?.connecting
				? "is-connecting"
				: "is-disconnected";
		});

		const disconnect = () => {
			if (live.value) {
				socket.emit("input", {target: live.value.channels[0].id, text: "/disconnect"});
			}
		};

		const connect = () => {
			if (live.value) {
				socket.emit("input", {target: live.value.channels[0].id, text: "/connect"});
				return;
			}

			// The entry as stored now, which is what createNetwork writes back.
			const net = entry.value ? saved.get(entry.value.uuid) : undefined;

			if (!net) {
				void navigate("Connect");
				return;
			}

			if (saved.needsPassword(net)) {
				// The sign-in panel, filled from the entry, asks for it.
				void router.push({name: "Connect", query: {savedLink: net.uuid}});
				return;
			}

			createNetwork(net);
		};

		/** The sign-in panel; a live guest session lasts until the user signs
		 * in there (Connect.vue ends it then), so changing their mind costs
		 * nothing. */
		const signIn = () => {
			void navigate("Connect");
		};

		/** Forget this device's sign-in: its push subscription (while the
		 * connection can still tell the server), the saved entry with its
		 * password and private logs, and the connection itself. */
		const signOut = () => {
			const net = entry.value;

			if (!net) {
				return;
			}

			eventbus.emit(
				"confirm-dialog",
				{
					title: t("settings.account.signOutTitle", {name: networkName.value}),
					text: t("settings.account.signOutText"),
					button: t("settings.account.signOutButton"),
				},
				async (confirmed: boolean) => {
					if (!confirmed) {
						return;
					}

					await webpush.unsubscribe(net.uuid);
					saved.remove(net.uuid);
					const current = store.getters.findNetwork(net.uuid);

					if (current) {
						socket.emit("input", {target: current.channels[0].id, text: "/quit"});
					}

					await navigate("Connect");
				}
			);
		};

		return {
			t,
			live,
			entry,
			account,
			networkName,
			identity,
			online,
			statusLabel,
			statusClass,
			connect,
			disconnect,
			signIn,
			signOut,
		};
	},
});
</script>
