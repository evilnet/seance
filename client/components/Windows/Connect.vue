<template>
	<div id="connect" class="window" role="tabpanel" aria-label="Connect">
		<div class="header">
			<SidebarToggle />
		</div>
		<form class="container" method="post" action="" @submit.prevent="onSubmit">
			<h1 class="title">{{ t("connect.title") }}</h1>

			<h2 v-if="showSavedNetworks">{{ t("connect.savedNetworks") }}</h2>
			<div
				v-if="showSavedNetworks && savedNetworks.length === 0"
				class="saved-networks-empty"
			>
				{{ t("connect.savedNetworksEmpty") }}
			</div>
			<ul
				v-else-if="showSavedNetworks"
				class="saved-networks"
				:aria-label="t('connect.savedNetworks')"
			>
				<li
					v-for="net in savedNetworks"
					:key="net.uuid"
					:class="['saved-network', {selected: net.uuid === selectedUuid}]"
				>
					<button
						type="button"
						class="saved-network-pick"
						:title="'Fill the form with ' + displayName(net)"
						@click="prefill(net)"
					>
						<span class="saved-network-name">{{ displayName(net) }}</span>
						<span class="saved-network-detail">
							<template v-if="!hostLocked">{{ net.host }}:{{ net.port }} · </template
							>{{ net.nick }}
							<template v-if="net.autoconnect"> · auto</template>
						</span>
					</button>
					<button
						type="button"
						class="btn btn-small"
						:disabled="savedNetworkBusy(net.uuid)"
						@click="connectSaved(net)"
					>
						{{ savedNetworkLabel(net.uuid) }}
					</button>
					<button
						type="button"
						class="btn btn-small saved-network-delete"
						:aria-label="'Delete ' + displayName(net)"
						title="Delete this saved network"
						@click="removeSaved(net)"
					>
						✕
					</button>
				</li>
			</ul>

			<h2 v-if="!hostLocked">Server</h2>
			<div v-if="hostLocked" class="connect-row connect-network">
				<label>Network</label>
				<div class="input-wrap">
					<strong>{{ networkLabel }}</strong>
				</div>
			</div>
			<div v-if="!hostLocked" class="connect-row">
				<label for="connect:host">Server</label>
				<div class="input-wrap">
					<input
						id="connect:host"
						v-model.trim="form.host"
						class="input"
						name="host"
						aria-label="Server address"
						placeholder="irc.example.org"
						maxlength="255"
						required
					/>
					<span id="connect:portseparator">:</span>
					<input
						id="connect:port"
						v-model.number="form.port"
						class="input"
						type="number"
						min="1"
						max="65535"
						name="port"
						aria-label="Server port"
						required
					/>
				</div>
			</div>
			<div v-if="!hostLocked" class="connect-row">
				<label></label>
				<div class="input-wrap">
					<label class="tls">
						<input v-model="form.tls" type="checkbox" name="tls" />
						Use secure connection (TLS)
					</label>
				</div>
			</div>

			<h2>User</h2>
			<div class="connect-row">
				<label for="connect:nick">Nick</label>
				<input
					id="connect:nick"
					v-model.trim="form.nick"
					class="input nick"
					name="nick"
					pattern="[^\s:!@]+"
					maxlength="100"
					required
				/>
			</div>
			<div class="connect-row">
				<label for="connect:channels">Channels</label>
				<input
					id="connect:channels"
					v-model.trim="form.join"
					class="input"
					name="join"
					placeholder="#channel, #another (optional)"
				/>
			</div>

			<h2 id="label-auth">Authentication</h2>
			<div class="connect-row">
				<label></label>
				<div class="input-wrap">
					<label class="tls">
						<input v-model="showSasl" type="checkbox" name="sasl" />
						I have a services account (SASL)
					</label>
				</div>
			</div>
			<template v-if="showSasl">
				<div class="connect-row">
					<label for="connect:saslAccount">Account</label>
					<input
						id="connect:saslAccount"
						v-model.trim="form.saslAccount"
						class="input"
						name="saslAccount"
						maxlength="100"
						autocomplete="username"
						required
					/>
				</div>
				<div class="connect-row">
					<label for="connect:saslPassword">Password</label>
					<RevealPassword
						v-slot:default="slotProps"
						class="input-wrap password-container"
					>
						<input
							id="connect:saslPassword"
							ref="passwordInput"
							v-model="form.saslPassword"
							class="input"
							:type="slotProps.isVisible ? 'text' : 'password'"
							name="saslPassword"
							maxlength="300"
							autocomplete="current-password"
							required
						/>
					</RevealPassword>
				</div>
				<div v-if="showSavedNetworks" class="connect-row">
					<label></label>
					<div class="input-wrap">
						<label class="tls">
							<input
								v-model="rememberPassword"
								type="checkbox"
								name="rememberPassword"
							/>
							Remember password on this device
						</label>
					</div>
				</div>
			</template>

			<div v-if="showSavedNetworks" class="connect-row">
				<label></label>
				<div class="input-wrap">
					<label class="tls">
						<input v-model="autoconnect" type="checkbox" name="autoconnect" />
						Connect automatically when the app starts
					</label>
				</div>
			</div>

			<div v-if="notice" class="connect-notice">{{ notice }}</div>
			<div v-if="submitted" class="connect-notice">
				Connecting as <strong>{{ submitted.nick }}</strong> to
				<strong>{{ submitted.host }}:{{ submitted.port }}</strong
				>…
			</div>

			<div>
				<button type="submit" class="btn">{{ t("connect.submit") }}</button>
			</div>
		</form>
	</div>
</template>

<style>
#connect .connect-notice,
#connect .saved-networks-empty {
	padding: 10px;
	margin-bottom: 10px;
	border-radius: 2px;
	background-color: #d9edf7;
	color: #31708f;
}

#connect .saved-networks {
	list-style: none;
	margin: 0 0 10px;
	padding: 0;
}

#connect .saved-network {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 6px;
	border-radius: 3px;
}

#connect .saved-network.selected {
	background-color: rgb(132 206 136 / 15%);
}

#connect .saved-network-pick {
	flex-grow: 1;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	text-align: left;
	cursor: pointer;
	padding: 4px 6px;
	border: 0;
	background: none;
	color: inherit;
	font: inherit;
	min-width: 0;
}

#connect .saved-network-pick:hover,
#connect .saved-network-pick:focus {
	text-decoration: underline;
}

#connect .saved-network-name {
	font-weight: bold;
}

#connect .saved-network-detail {
	font-size: 12px;
	opacity: 0.7;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 100%;
}

#connect .saved-network .btn {
	width: auto;
	margin: 0;
	flex-shrink: 0;
}

#connect .saved-network-delete {
	letter-spacing: 0;
	word-spacing: 0;
}

#connect .connect-network .input-wrap {
	padding: 6px 0;
}
</style>

<script lang="ts">
import {defineComponent, onMounted, reactive, ref, watch} from "vue";

import {useStore} from "../../js/store";
import {brandingFeatures, brandingString, expandNick} from "../../js/branding";
import {autoconnectSavedNetworks, createNetwork} from "../../js/irc/manager";
import * as saved from "../../js/irc/saved-networks";
import {defaultPort, displayName, SavedNetwork} from "../../js/irc/saved-networks";
import type {ConnectOptions} from "../../js/irc/types";
import RevealPassword from "../RevealPassword.vue";
import SidebarToggle from "../SidebarToggle.vue";

export type {ConnectOptions};

/** URL parameters that pre-fill the form (and so beat the last-used entry). */
const CONNECT_PARAMS = [
	"host",
	"port",
	"tls",
	"nick",
	"join",
	"channels",
	"saslAccount",
	"saslPassword",
];

export default defineComponent({
	name: "Connect",
	components: {
		RevealPassword,
		SidebarToggle,
	},
	props: {
		queryParams: Object,
	},
	setup(props) {
		const store = useStore();
		// Branding is loaded before the app renders, so a snapshot is enough.
		const branding = store.state.branding;
		const features = brandingFeatures(branding);
		const network = branding.defaultNetwork;
		const defaults = store.state.serverConfiguration?.defaults;
		const t = (key: string) => brandingString(key, branding);

		const tls = network?.tls ?? defaults?.tls ?? true;
		// The server the deploy points at. Pinned when the host is locked.
		const server = {
			host: network?.host || defaults?.host || "",
			port:
				network?.port ??
				// 6697 is TheLounge's plain-IRC default; not meaningful over WebSocket.
				(defaults?.port && defaults.port !== 6697 ? defaults.port : defaultPort(tls)),
			tls,
		};
		const form = reactive<ConnectOptions>({
			...server,
			nick: network?.nick ? expandNick(network.nick) : defaults?.nick || "",
			join: network?.channels?.join(", ") || defaults?.join || "",
			sasl: defaults?.sasl === "plain" ? "plain" : "",
			saslAccount: defaults?.saslAccount || "",
			saslPassword: defaults?.saslPassword || "",
		});

		// `lockHost` hides the server fields; `allowCustomServer: false` does the
		// same and additionally ignores any other host from saved networks or
		// URL parameters.
		const hostLocked = !!network && (network.lockHost === true || !features.allowCustomServer);
		const networkLabel = network?.name || server.host;
		const showSavedNetworks = features.saveNetworks;

		const pinServer = () => {
			if (hostLocked) {
				Object.assign(form, server);
			}
		};

		const showSasl = ref(false);
		const rememberPassword = ref(false);
		const autoconnect = ref(false);
		/** The saved entry the form was filled from; its uuid is reused on connect. */
		const selectedUuid = ref<string | null>(null);
		const savedNetworks = ref<SavedNetwork[]>(saved.list());
		const submitted = ref<ConnectOptions | null>(null);
		const notice = ref("");
		const passwordInput = ref<HTMLInputElement | null>(null);

		const refreshSaved = () => {
			savedNetworks.value = saved.list();
		};

		const prefill = (net: SavedNetwork) => {
			form.host = net.host;
			form.port = net.port;
			form.tls = net.tls;
			form.nick = net.nick;
			form.join = net.join;
			form.sasl = net.sasl;
			form.saslAccount = net.saslAccount;
			form.saslPassword = net.saslPassword;
			showSasl.value = net.sasl === "plain";
			rememberPassword.value = !!net.rememberPassword;
			autoconnect.value = !!net.autoconnect;
			selectedUuid.value = net.uuid;
			notice.value = "";
			pinServer();
		};

		const hasConnectParams = CONNECT_PARAMS.some(
			(key) => props.queryParams && props.queryParams[key] !== undefined
		);

		if (hasConnectParams) {
			applyQueryParams(form, props.queryParams);
			pinServer();
			showSasl.value = form.sasl === "plain" || !!form.saslAccount;
		} else {
			// Pre-fill from the last-used entry only while nothing is live yet:
			// with networks up, this screen is "add another network" and starts
			// blank (the picker above still reuses a saved entry in one click).
			const last =
				showSavedNetworks && store.state.networks.length === 0
					? saved.lastUsed()
					: undefined;

			if (last) {
				prefill(last);
			} else {
				showSasl.value = form.sasl === "plain" || !!form.saslAccount;
			}
		}

		// Follow the TLS checkbox while the port is still one of the defaults.
		watch(
			() => form.tls,
			(useTls) => {
				if (form.port === defaultPort(!useTls)) {
					form.port = defaultPort(useTls);
				}
			}
		);

		const onSubmit = () => {
			form.sasl = showSasl.value ? "plain" : "";

			if (!showSasl.value) {
				form.saslAccount = "";
				form.saslPassword = "";
			}

			submitted.value = {...form};
			notice.value = "";
			const client = createNetwork({
				...submitted.value,
				uuid: selectedUuid.value ?? undefined,
				rememberPassword: showSasl.value && rememberPassword.value,
				autoconnect: autoconnect.value,
			});
			selectedUuid.value = client.uuid;
			refreshSaved();
		};

		/** Connect straight from the picker, unless a password still has to be typed. */
		const connectSaved = (net: SavedNetwork) => {
			prefill(net);

			if (net.sasl === "plain" && !net.saslPassword) {
				notice.value = `Enter the password for ${net.saslAccount} to connect.`;
				void Promise.resolve().then(() => passwordInput.value?.focus());
				return;
			}

			onSubmit();
		};

		const removeSaved = (net: SavedNetwork) => {
			saved.remove(net.uuid);

			if (selectedUuid.value === net.uuid) {
				selectedUuid.value = null;
			}

			refreshSaved();
		};

		/** Live connection state of a saved entry, scoped to that network's uuid. */
		const statusOf = (uuid: string) => store.getters.findNetwork(uuid)?.status ?? null;

		const savedNetworkBusy = (uuid: string) => {
			const status = statusOf(uuid);
			return !!(status?.connected || status?.connecting);
		};

		const savedNetworkLabel = (uuid: string) => {
			const status = statusOf(uuid);
			return status?.connected ? "Connected" : status?.connecting ? "Connecting…" : "Connect";
		};

		onMounted(() => {
			// `?autoconnect=1` with a host and nick skips the form entirely.
			if (isTruthyParam(props.queryParams?.autoconnect) && form.host && form.nick) {
				onSubmit();
			}

			// Saved networks flagged autoconnect (once per page load).
			autoconnectSavedNetworks();
			refreshSaved();
		});

		return {
			form,
			t,
			hostLocked,
			networkLabel,
			showSavedNetworks,
			showSasl,
			rememberPassword,
			autoconnect,
			selectedUuid,
			savedNetworks,
			submitted,
			notice,
			passwordInput,
			displayName,
			prefill,
			connectSaved,
			removeSaved,
			savedNetworkBusy,
			savedNetworkLabel,
			onSubmit,
		};
	},
});

function isTruthyParam(value: unknown): boolean {
	if (Array.isArray(value)) {
		value = value[0];
	}

	return value === "" || value === "1" || value === "true" || value === true;
}

/**
 * Pre-fill the form from `?host=...&nick=...` style URL parameters or the
 * output of `parseIrcUri` for `web+irc://` links. `channels` is accepted as an
 * alias for `join` for compatibility with other clients.
 */
function applyQueryParams(form: ConnectOptions, params?: Record<string, any>) {
	if (!params) {
		return;
	}

	const first = (value: unknown): string | undefined => {
		if (Array.isArray(value)) {
			value = value[0];
		}

		return value === undefined || value === null ? undefined : String(value);
	};

	const host = first(params.host);
	const port = first(params.port);
	const tls = first(params.tls);
	const nick = first(params.nick);
	const join = first(params.join ?? params.channels);
	const saslAccount = first(params.saslAccount);
	const saslPassword = first(params.saslPassword);

	if (host) {
		form.host = host;
	}

	if (port && !Number.isNaN(Number(port))) {
		form.port = Number(port);
	}

	if (tls !== undefined) {
		form.tls = !(tls === "0" || tls === "false");
	}

	if (nick) {
		form.nick = nick;
	}

	if (join) {
		form.join = join
			.split(",")
			.map((chan) => chan.trim())
			.filter((chan) => chan.length > 0)
			.map((chan) => (chan.match(/^[#&!+]/) ? chan : `#${chan}`))
			.join(", ");
	}

	if (saslAccount) {
		form.saslAccount = saslAccount;
		form.sasl = "plain";
	}

	if (saslPassword) {
		form.saslPassword = saslPassword;
	}
}
</script>
