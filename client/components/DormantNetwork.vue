<template>
	<!-- A saved network this page has not connected (autoconnect off, or a
	     password to type): the lobby row's shape, greyed, one tap to dial. -->
	<div :id="'saved-network-' + network.uuid" class="network dormant-network">
		<div
			class="channel-list-item dormant-network-row"
			data-type="lobby"
			:title="connectLabel"
			@click="connect"
		>
			<div class="lobby-wrap">
				<div class="lobby-title">
					<span class="collapse-network" />
					<button
						type="button"
						class="name dormant-network-connect"
						:aria-label="connectLabel"
						@click.stop="connect"
					>
						<bdi>{{ name }}</bdi>
					</button>
				</div>
				<div class="lobby-status">
					<div class="lobby-tools">
						<span class="connection-status-icon is-disconnected" aria-hidden="true" />
						<span class="dormant-network-state">{{ stateLabel }}</span>
						<span
							:aria-label="editLabel"
							class="edit-network-tooltip tooltipped tooltipped-e tooltipped-no-touch"
						>
							<button
								type="button"
								class="edit-network"
								:aria-label="editLabel"
								@click.stop="editNetwork"
							/>
						</span>
					</div>
					<span class="lobby-presence"
						><span v-if="network.nick" class="lobby-nick"
							><bdi>{{ network.nick }}</bdi></span
						></span
					>
				</div>
			</div>
		</div>
	</div>
</template>

<style>
/* Greyed: present, not live. The row keeps the lobby's layout so the name
sits where it will once connected; hovering or focusing brings it most of the
way back, the cue that a tap dials it. */
#sidebar .dormant-network .dormant-network-row {
	opacity: 0.55;
	transition: opacity 0.2s;
}

#sidebar .dormant-network .dormant-network-row:hover,
#sidebar .dormant-network .dormant-network-row:focus-within {
	opacity: 0.9;
}

html[data-contrast="more"] #sidebar .dormant-network .dormant-network-row {
	opacity: 0.8;
}

html[data-reduce-motion] #sidebar .dormant-network .dormant-network-row {
	transition: none;
}

.dormant-network .dormant-network-connect {
	flex: 1 1 auto;
	min-inline-size: 0;
	padding: 0;
	border: 0;
	background: none;
	color: inherit;
	font: inherit;
	text-align: start;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	cursor: pointer;
}

.dormant-network .connection-status-icon {
	display: inline-block;
	cursor: inherit;
}

.dormant-network .dormant-network-state {
	white-space: nowrap;
	color: var(--rail-fg-muted, rgb(183 197 209 / 75%));
}
</style>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {useRouter} from "vue-router";
import {createNetwork} from "../js/irc/manager";
import * as saved from "../js/irc/saved-networks";
import type {SavedNetwork} from "../js/irc/saved-networks";
import {useI18n} from "../js/i18n";
import {brandingFeatures} from "../js/branding";

export default defineComponent({
	name: "DormantNetwork",
	props: {
		network: {
			type: Object as PropType<SavedNetwork>,
			required: true,
		},
	},
	setup(props) {
		const router = useRouter();
		const {t} = useI18n();
		const name = computed(() => saved.displayName(props.network));
		/** A login whose password was not kept cannot dial by itself. */
		const needsPassword = computed(
			() => props.network.sasl === "plain" && !props.network.saslPassword
		);
		const connectLabel = computed(() => t("sidebar.savedNetworkConnect", {name: name.value}));
		const stateLabel = computed(() =>
			needsPassword.value ? t("sidebar.savedNetworkPassword") : t("sidebar.savedNetworkOff")
		);
		const editLabel = computed(() =>
			brandingFeatures().editNetworks ? t("lobby.edit") : t("lobby.account")
		);

		const connect = () => {
			// The entry as stored now: the row's copy is only as new as what
			// it shows, and createNetwork writes what it is given back.
			const entry = saved.get(props.network.uuid);

			if (!entry) {
				return;
			}

			if (entry.sasl === "plain" && !entry.saslPassword) {
				// The connect form, filled from the entry, asks for it.
				void router.push({name: "Connect", query: {savedLink: entry.uuid}});
				return;
			}

			// The network announces itself and takes this row's place.
			createNetwork(entry);
		};

		const editNetwork = () => {
			// A deploy that keeps its network as it set it has no edit form;
			// the gear opens its Account page instead.
			void router.push(
				brandingFeatures().editNetworks
					? `/settings/networks/${props.network.uuid}`
					: "/settings/networks"
			);
		};

		return {name, connectLabel, stateLabel, editLabel, connect, editNetwork};
	},
});
</script>
