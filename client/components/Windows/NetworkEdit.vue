<template>
	<div>
		<router-link class="network-settings-back" to="/settings/networks">
			{{ t("windows.networkEdit.back") }}
		</router-link>
		<NetworkForm
			v-if="networkData"
			:handle-submit="handleSubmit"
			:handle-action="handleAction"
			:status="status"
			:defaults="networkData"
			:disabled="disabled"
			:embedded="true"
		/>
	</div>
</template>

<style>
.network-settings-back {
	display: inline-block;
	margin-top: 20px;
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, reactive, ref, watch} from "vue";
import {useRoute} from "vue-router";
import {navigate} from "../../js/router";
import socket from "../../js/socket";
import {useI18n} from "../../js/i18n";
import {useStore} from "../../js/store";
import * as saved from "../../js/irc/saved-networks";
import type {SavedNetwork} from "../../js/irc/saved-networks";
import webpush from "../../js/webpush";
import NetworkForm, {ConnectionAction, NetworkFormDefaults} from "../NetworkForm.vue";

/**
 * Edit a network: `network:get` answers (synchronously, via the bus) with
 * the saved entry merged with the live client's state; the form edits a
 * local copy and `network:edit` writes it back to localStorage, renaming /
 * re-nicking the live network where that applies. The status row reads the
 * live network's `status` from the store; its button saves the form (so a
 * corrected port / TLS box is what gets used) and sends `/connect`, or
 * `/disconnect` (which also cancels a pending reconnect).
 */
export default defineComponent({
	name: "NetworkEdit",
	components: {
		NetworkForm,
	},
	setup() {
		const route = useRoute();
		const store = useStore();
		const {t} = useI18n();

		const disabled = ref(false);
		const networkData = ref<NetworkFormDefaults | null>(null);
		const status = computed(
			() => store.getters.findNetwork(String(route.params.uuid || ""))?.status ?? null
		);

		const setNetworkData = () => {
			const uuid = String(route.params.uuid || "");
			let received: NetworkFormDefaults | null = null;

			const onInfo = (data: {uuid: string}) => {
				if (data.uuid === uuid) {
					received = reactive({...(data as NetworkFormDefaults)});
				}
			};

			socket.on("network:info", onInfo);
			socket.emit("network:get", uuid);
			socket.off("network:info", onInfo);

			if (!received) {
				const stored = saved.get(uuid);
				const network = store.getters.findNetwork(uuid);
				received = stored
					? reactive({...stored, connected: network?.status.connected ?? false})
					: network
					? reactive({
							uuid,
							name: network.name,
							host: "",
							port: 8443,
							tls: network.status.secure,
							nick: network.nick,
							join: "",
							sasl: "",
							saslAccount: "",
							saslPassword: "",
							connected: network.status.connected,
					  })
					: null;
			}

			networkData.value = received;
		};

		const handleSubmit = (data: SavedNetwork) => {
			disabled.value = true;
			// Read before the emit: `network:edit` saves synchronously, and the
			// push side needs the previous flag to react to a change.
			const pushWas = saved.pushEnabledOf(saved.get(data.uuid));
			socket.emit("network:edit", data);
			webpush.onNetworkSaved(data, pushWas);
			void navigate("Networks");
			disabled.value = false;
		};

		const handleAction = (action: ConnectionAction, data: SavedNetwork) => {
			const network = store.getters.findNetwork(data.uuid);

			if (!network) {
				return;
			}

			if (action === "connect") {
				const pushWas = saved.pushEnabledOf(saved.get(data.uuid));
				socket.emit("network:edit", data);
				webpush.onNetworkSaved(data, pushWas);
			}

			socket.emit("input", {
				target: network.channels[0].id,
				text: action === "connect" ? "/connect" : "/disconnect",
			});
		};

		watch(
			() => route.params.uuid,
			() => {
				setNetworkData();
			}
		);

		onMounted(() => {
			setNetworkData();
		});

		return {
			t,
			disabled,
			networkData,
			status,
			handleSubmit,
			handleAction,
		};
	},
});
</script>
