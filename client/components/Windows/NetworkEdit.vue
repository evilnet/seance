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
		>
			<template v-if="showSync" #extra>
				<h2>{{ t("settings.sync.heading") }}</h2>
				<SyncSwitch :uuid="homeUuid" />
			</template>
		</NetworkForm>
	</div>
</template>

<style>
.network-settings-back {
	display: inline-block;
	margin-top: 20px;
}

/* Settings sync inside the form (SyncSwitch.vue): its label is the whole
 * line and its button its own size, where `#connect label` is a quarter
 * wide and `#connect .btn` the full width (style.css). */
#connect .network-settings-sync label.opt {
	display: block;
	width: auto;
	margin-top: 0;
}

#connect .network-settings-sync .btn {
	width: auto;
	margin: 0;
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
import SyncSwitch from "../Settings/SyncSwitch.vue";
import {syncState} from "../../js/sync";
import NetworkForm, {ConnectionAction, NetworkFormDefaults} from "../NetworkForm.vue";

/**
 * Edit a network: `network:get` answers (synchronously, via the bus) with
 * the saved entry merged with the live client's state; the form edits a
 * local copy and `network:edit` writes it back to localStorage, renaming /
 * re-nicking the live network where that applies. The status row reads the
 * live network's `status` from the store; its button saves the form (so a
 * corrected port / TLS box is what gets used) and sends `/server`, or
 * `/disconnect` (which also cancels a pending reconnect).
 */
export default defineComponent({
	name: "NetworkEdit",
	components: {
		NetworkForm,
		SyncSwitch,
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

		const homeUuid = computed(() => String(route.params.uuid || ""));
		/**
		 * Settings sync (SyncSwitch.vue) is switched here, on the one network
		 * it is about: while it is live, and offline too where it is this
		 * device's sync home, to turn it off.
		 */
		const showSync = computed(
			() =>
				!!store.getters.findNetwork(homeUuid.value) ||
				syncState.value.home === homeUuid.value
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
				text: action === "connect" ? "/server" : "/disconnect",
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
			homeUuid,
			showSync,
			disabled,
			networkData,
			status,
			handleSubmit,
			handleAction,
		};
	},
});
</script>
