<template>
	<div class="network-settings">
		<div class="network-settings-heading">
			<div>
				<h2>Networks</h2>
				<p>Manage the IRC networks saved in this browser.</p>
			</div>
			<router-link v-if="canAddNetwork" class="btn" to="/connect">Add network</router-link>
		</div>

		<p v-if="networks.length === 0" class="network-settings-empty">No networks saved yet.</p>
		<ul v-else class="network-settings-list">
			<li v-for="network in networks" :key="network.uuid" class="network-settings-item">
				<div class="network-settings-summary">
					<strong>{{ displayName(network) }}</strong>
					<span>{{ network.host }}:{{ network.port }}</span>
					<span :class="['network-settings-status', statusClass(network.uuid)]">
						{{ statusLabel(network.uuid) }}
					</span>
				</div>
				<div class="network-settings-actions">
					<button
						type="button"
						class="btn btn-sm"
						:disabled="isConnecting(network.uuid)"
						@click="connect(network)"
					>
						{{ connectLabel(network.uuid) }}
					</button>
					<router-link class="btn btn-sm" :to="`/settings/networks/${network.uuid}`">
						Edit
					</router-link>
					<button type="button" class="btn btn-sm btn-danger" @click="remove(network)">
						Delete
					</button>
				</div>
			</li>
		</ul>
	</div>
</template>

<style>
.network-settings-heading,
.network-settings-item,
.network-settings-actions {
	display: flex;
	align-items: center;
}

.network-settings-heading {
	justify-content: space-between;
	gap: 20px;
}

.network-settings-heading h2 {
	margin-top: 0; /* the tab's first heading (Windows/Settings.vue) */
	margin-bottom: 5px;
}

.network-settings-heading p {
	margin: 0;
	color: var(--body-color-muted);
}

.network-settings-heading > .btn {
	flex-shrink: 0;
}

.network-settings-empty {
	padding: 20px;
	margin-top: 20px;
	text-align: center;
	border: 1px dashed var(--body-color-muted);
	border-radius: 4px;
	color: var(--body-color-muted);
}

.network-settings-list {
	list-style: none;
	padding: 0;
	margin: 20px 0 0;
}

.network-settings-item {
	justify-content: space-between;
	gap: 15px;
	padding: 14px 0;
	border-bottom: 1px solid rgb(128 128 128 / 25%);
}

.network-settings-summary {
	display: grid;
	min-width: 0;
}

.network-settings-summary > span {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--body-color-muted);
}

.network-settings-status::before {
	content: "●";
	margin-right: 5px;
}

.network-settings-status.is-connected::before {
	color: #2ecc40;
}

.network-settings-status.is-connecting::before {
	color: #f39c12;
}

.network-settings-status.is-disconnected::before {
	color: #999;
}

.network-settings-actions {
	gap: 6px;
	flex-shrink: 0;
}

.network-settings-actions .btn {
	margin: 0;
}

@media (max-width: 600px) {
	.network-settings-item {
		align-items: stretch;
		flex-direction: column;
	}

	.network-settings-actions .btn {
		flex: 1;
		text-align: center;
	}
}
</style>

<script lang="ts">
import {computed, defineComponent, ref} from "vue";
import {brandingFeatures} from "../../js/branding";
import eventbus from "../../js/eventbus";
import {createNetwork} from "../../js/irc/manager";
import * as saved from "../../js/irc/saved-networks";
import type {SavedNetwork} from "../../js/irc/saved-networks";
import {switchToChannel} from "../../js/router";
import socket from "../../js/socket";
import {useStore} from "../../js/store";
import webpush from "../../js/webpush";

export default defineComponent({
	name: "NetworkSettings",
	setup() {
		const store = useStore();
		const networks = ref(saved.list());
		const live = (uuid: string) => store.getters.findNetwork(uuid);
		const canAddNetwork = computed(
			() =>
				brandingFeatures(store.state.branding).multiNetwork ||
				(store.state.networks.length === 0 && networks.value.length === 0)
		);
		const isConnecting = (uuid: string) => !!live(uuid)?.status.connecting;

		const statusLabel = (uuid: string) => {
			const status = live(uuid)?.status;
			return status?.connected
				? "Connected"
				: status?.connecting
				? "Connecting…"
				: "Disconnected";
		};

		const statusClass = (uuid: string) =>
			live(uuid)?.status.connected
				? "is-connected"
				: live(uuid)?.status.connecting
				? "is-connecting"
				: "is-disconnected";

		const connectLabel = (uuid: string) =>
			live(uuid)?.status.connected
				? "Open"
				: live(uuid)?.status.connecting
				? "Connecting…"
				: "Connect";

		const connect = (network: SavedNetwork) => {
			const current = live(network.uuid);

			if (!current) {
				createNetwork(network);
				return;
			}

			if (current.status.connected) {
				switchToChannel(current.channels[0]);
				return;
			}

			if (!current.status.connecting) {
				socket.emit("input", {target: current.channels[0].id, text: "/connect"});
			}
		};

		const remove = (network: SavedNetwork) => {
			eventbus.emit(
				"confirm-dialog",
				{
					title: `Delete ${saved.displayName(network)}?`,
					text: "This removes the saved network and disconnects it if it is running.",
					button: "Delete network",
				},
				async (confirmed: boolean) => {
					if (!confirmed) {
						return;
					}

					await webpush.unsubscribe(network.uuid);
					saved.remove(network.uuid);
					const current = live(network.uuid);

					if (current) {
						socket.emit("input", {target: current.channels[0].id, text: "/quit"});
					}

					networks.value = saved.list();
				}
			);
		};

		return {
			networks,
			canAddNetwork,
			isConnecting,
			displayName: saved.displayName,
			statusLabel,
			statusClass,
			connectLabel,
			connect,
			remove,
		};
	},
});
</script>
