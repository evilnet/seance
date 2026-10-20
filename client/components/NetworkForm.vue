<template>
	<div
		id="connect"
		:class="['window', {'network-form-embedded': embedded}]"
		:role="embedded ? undefined : 'tabpanel'"
		aria-label="Edit network"
	>
		<div v-if="!embedded" class="header">
			<SidebarToggle />
		</div>
		<form :class="{container: !embedded}" method="post" action="" @submit.prevent="onSubmit">
			<h1 class="title">
				<input v-model="defaults.uuid" type="hidden" name="uuid" />
				Edit {{ displayName(defaults) }}
			</h1>

			<!--
				Only what `ConnectOptions` (client/js/irc/types.ts) and the saved
				network store support is offered. Dropped from TheLounge's form:
				server password, "only allow trusted certificates", SOCKS proxy,
				username / real name / leave message, SASL EXTERNAL (client
				certificates) and the STS lock — none of them apply to a browser
				WebSocket connection, or they wait on later phases (STS: D.6).
			-->
			<div v-if="status" class="connect-row connect-status">
				<label>Status</label>
				<div class="input-wrap">
					<span :class="['connection-status', statusClass]">{{ statusText }}</span>
					<button
						v-if="handleAction"
						type="button"
						class="btn btn-small connection-action"
						@click="onAction"
					>
						{{ actionLabel }}
					</button>
				</div>
			</div>

			<h2>Network settings</h2>
			<div class="connect-row">
				<label for="connect:name">Name</label>
				<input
					id="connect:name"
					v-model.trim="defaults.name"
					class="input"
					name="name"
					maxlength="100"
					placeholder="Optional, defaults to the server's network name"
				/>
			</div>
			<div class="connect-row">
				<label for="connect:host">Server</label>
				<div class="input-wrap">
					<input
						id="connect:host"
						v-model.trim="defaults.host"
						class="input"
						name="host"
						aria-label="Server address"
						autocapitalize="off"
						:autocorrect.attr="'off'"
						spellcheck="false"
						maxlength="255"
						required
					/>
					<span id="connect:portseparator">:</span>
					<input
						id="connect:port"
						v-model.number="defaults.port"
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
			<div class="connect-row">
				<label></label>
				<div class="input-wrap">
					<label class="tls">
						<input v-model="defaults.tls" v-switch type="checkbox" name="tls" />
						Use secure connection (TLS)
					</label>
					<label class="tls">
						<input
							v-model="defaults.autoconnect"
							v-switch
							type="checkbox"
							name="autoconnect"
						/>
						Connect automatically when the app starts
					</label>
				</div>
			</div>
			<div
				v-if="status ? status.connected || status.connecting : defaults.connected"
				class="connect-note"
			>
				Server, port, TLS, channels and authentication changes apply the next time this
				network connects (a network that is waiting to reconnect retries right away).
			</div>

			<h2>User preferences</h2>
			<div class="connect-row">
				<label for="connect:nick">Nick</label>
				<input
					id="connect:nick"
					v-model.trim="defaults.nick"
					class="input nick"
					name="nick"
					pattern="[^\s:!@]+"
					autocapitalize="off"
					:autocorrect.attr="'off'"
					spellcheck="false"
					maxlength="100"
					required
				/>
			</div>
			<div class="connect-row">
				<label for="connect:channels">Channels</label>
				<input
					id="connect:channels"
					v-model.trim="defaults.join"
					class="input"
					name="join"
					placeholder="#channel, #another key (joined on connect)"
					autocapitalize="off"
					:autocorrect.attr="'off'"
					spellcheck="false"
				/>
			</div>
			<div class="connect-row">
				<label for="connect:commands">
					Commands
					<span
						class="tooltipped tooltipped-ne tooltipped-no-delay"
						aria-label="One /command per line.
Each command will be executed in
the server tab on new connection"
					>
						<button class="extra-help" type="button" />
					</span>
				</label>
				<textarea
					id="connect:commands"
					ref="commandsInput"
					v-model="commandsText"
					autocomplete="off"
					class="input"
					name="commands"
					@input="resizeCommandsInput"
				/>
			</div>

			<h2 id="label-auth">Authentication</h2>
			<div class="connect-row connect-auth" role="group" aria-labelledby="label-auth">
				<label class="opt">
					<input v-model="defaults.sasl" type="radio" name="sasl" value="" />
					No authentication
				</label>
				<label class="opt">
					<input v-model="defaults.sasl" type="radio" name="sasl" value="plain" />
					Username + password (SASL PLAIN)
				</label>
			</div>

			<template v-if="defaults.sasl === 'plain'">
				<div class="connect-row">
					<label for="connect:saslAccount">Account</label>
					<input
						id="connect:saslAccount"
						v-model.trim="defaults.saslAccount"
						class="input"
						name="saslAccount"
						maxlength="100"
						autocomplete="username"
						autocapitalize="off"
						:autocorrect.attr="'off'"
						spellcheck="false"
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
							v-model="defaults.saslPassword"
							class="input"
							:type="slotProps.isVisible ? 'text' : 'password'"
							name="saslPassword"
							maxlength="300"
							autocomplete="current-password"
							placeholder="Leave empty to keep the current password"
						/>
					</RevealPassword>
				</div>
				<div class="connect-row">
					<label></label>
					<div class="input-wrap">
						<label class="tls">
							<input
								v-model="defaults.rememberPassword"
								v-switch
								type="checkbox"
								name="rememberPassword"
							/>
							Remember password on this device
						</label>
					</div>
				</div>
				<div class="connect-row">
					<label></label>
					<div class="input-wrap">
						<label class="tls">
							<input
								v-model="defaults.pushEnabled"
								v-switch
								type="checkbox"
								name="pushEnabled"
							/>
							Push notifications for this network
							<span
								class="tooltipped tooltipped-n tooltipped-no-delay"
								aria-label="Register this device for push notifications on this network. The server must support the draft/webpush capability. Push needs authentication, so this only appears with SASL configured. Each network is set up independently."
							>
								<button class="extra-help" />
							</span>
						</label>
					</div>
				</div>
				<div
					v-if="defaults.pushEnabled && pushInfo.stale"
					id="pushStaleRow"
					class="connect-row"
				>
					<label></label>
					<div class="input-wrap">
						<div class="push-stale-hint">
							This server's push identity (its key) changed, so this device's push
							subscription for it no longer works.
						</div>
						<button id="pushRenew" type="button" class="btn" @click.prevent="renewPush">
							Renew push notifications
						</button>
					</div>
				</div>
			</template>

			<div class="connect-row">
				<label></label>
				<div class="input-wrap">
					<label class="tls">
						<input
							v-model="defaults.notifyEnabled"
							v-switch
							type="checkbox"
							name="notifyEnabled"
							@change="onNotifyToggle"
						/>
						Browser notifications for this network
						<span
							class="tooltipped tooltipped-n tooltipped-no-delay"
							aria-label="Show browser notifications for highlights and queries on this network. Needs the browser's permission; asks when first saved. Each network is set up independently."
						>
							<button class="extra-help" />
						</span>
					</label>
				</div>
			</div>

			<div class="connect-row">
				<label for="connect:presenceMode">Presence</label>
				<div class="input-wrap">
					<!-- The dot menu's four words; what each means is the hint. -->
					<select
						id="connect:presenceMode"
						v-model="presenceMode"
						class="input"
						name="presenceMode"
						aria-describedby="connect-presence-hint"
					>
						<option value="global">Same as global</option>
						<option value="online">Online</option>
						<option value="auto">Auto</option>
						<option value="away">Away</option>
						<option value="dnd">Do not disturb</option>
					</select>
					<div id="connect-presence-hint" class="presence-mode-hint">
						{{ presenceHint }}
					</div>
				</div>
			</div>

			<!--
				Services support (docs/projects/oper-tools.md): shown once this
				network is connected and opered. The package's conventional names
				are prefilled when picked (empty fields only), and the bots are
				WHOISed as the fields change so the oper sees they are there.
			-->
			<template v-if="showServices">
				<h2 id="label-services">Services support</h2>
				<div class="connect-row">
					<label for="connect:servicesPackage">Services package</label>
					<select
						id="connect:servicesPackage"
						v-model="servicesPackage"
						class="input"
						name="servicesPackage"
						@change="onServicesPackage"
					>
						<option value="">None</option>
						<option v-for="p in SERVICES_PROFILES" :key="p.id" :value="p.id">
							{{ p.name }}
						</option>
					</select>
				</div>
				<template v-if="servicesPackage">
					<div v-for="role in SERVICE_ROLE_FIELDS" :key="role.id" class="connect-row">
						<label :for="'connect:services-' + role.id">{{ role.label }}</label>
						<input
							:id="'connect:services-' + role.id"
							v-model.trim="serviceBots[role.id]"
							class="input"
							:name="'services-' + role.id"
							:placeholder="role.placeholder"
							autocapitalize="off"
							:autocorrect.attr="'off'"
							spellcheck="false"
							maxlength="100"
						/>
					</div>
					<div class="connect-row">
						<label></label>
						<div class="input-wrap services-notes">
							<p class="services-help">
								Prefilled with {{ servicesName }}'s usual names; change them if this
								network renamed its bots. Leave a channel blank if the network
								doesn't run it.
							</p>
							<p
								:class="['services-check', {ok: checkOk, pending: checkPending}]"
								role="status"
								aria-live="polite"
							>
								{{ checkText }}
							</p>
						</div>
					</div>
				</template>
			</template>

			<div>
				<button type="submit" class="btn" :disabled="disabled ? true : false">
					Save network
				</button>
			</div>
		</form>
	</div>
</template>

<style>
.presence-mode-hint {
	margin-block-start: 0.25rem;
	font-size: 0.8125rem;
	color: var(--body-color-muted);
}

.push-stale-hint {
	margin-bottom: 8px;
	font-size: 90%;
	opacity: 0.85;
}

/* The auth radios stack one per line at full width. `#connect .connect-row`
 * (style.css) is `display: flex` at the same specificity, and `#connect label`
 * is 25% wide, so plain `.connect-auth` rules lose or tie depending on bundle
 * order - chain the classes to win outright. */
#connect .connect-row.connect-auth {
	display: block;
	margin-bottom: 10px;
}

#connect.network-form-embedded {
	display: block;
	height: auto;
	overflow: visible;
	background: transparent;
	border-radius: 0;
	box-shadow: none;
}

#connect.network-form-embedded h1 {
	font-size: 1.75rem;
}

#connect .connect-row.connect-auth .opt {
	display: block;
	width: 100%;
}

#connect .connect-row.connect-auth input {
	margin: 0.15em 0.5em 0 0;
}

#connect .connect-note {
	padding: 10px;
	margin: 10px 0;
	border-radius: 2px;
	background-color: #d9edf7;
	color: #31708f;
}

#connect .connect-status .input-wrap {
	display: flex;
	align-items: center;
	gap: 12px;
	margin-top: 8px;
}

#connect .connection-status::before {
	content: "●";
	margin-right: 6px;
}

#connect .connection-status.is-connected::before {
	color: #2ecc40;
}

#connect .connection-status.is-connecting::before {
	color: #f39c12;
}

#connect .connection-status.is-disconnected::before {
	color: #e74c3c;
}

#connect .btn.connection-action {
	width: auto;
	margin: 0;
}

#connect .services-notes {
	margin-top: 8px;
}

#connect .services-help,
#connect .services-check {
	margin: 0 0 6px;
	font-size: 90%;
	opacity: 0.85;
}

#connect .services-check.ok {
	color: var(--link-color);
	opacity: 1;
}

#connect .services-check.pending {
	font-style: italic;
}
</style>

<script lang="ts">
import RevealPassword from "./RevealPassword.vue";
import SidebarToggle from "./SidebarToggle.vue";
import {
	computed,
	defineComponent,
	nextTick,
	onMounted,
	onUnmounted,
	PropType,
	reactive,
	ref,
	watch,
} from "vue";
import {
	displayName,
	parseCommands,
	presenceModeOf,
	SavedNetwork,
	SERVICE_ROLES,
} from "../js/irc/saved-networks";
import type {NetworkMode} from "../js/helpers/dnd";
import dnd from "../js/dnd";
import {SERVICES_PROFILES, servicesProfileById} from "../js/irc/services/index";
import {describeServiceCheck} from "../js/irc/services";
import {servicesCheck} from "../js/helpers/operRequest";
import {isOperOn} from "../js/helpers/operMenu";
import {askNativeAlertPermission, nativeAlertsAvailable} from "../js/helpers/nativeAlerts";
import {useStore} from "../js/store";
import webpush from "../js/webpush";
import type {ServicesConfig, SharedNetworkStatus} from "../../shared/types/network";
// What each presence mode means, under the select (the dot menu's words).
const PRESENCE_HINTS: Record<NetworkMode, string> = {
	global: "Follows the global mode under the logo.",
	online: "Never away.",
	auto: "Away when you're not looking.",
	away: "Always away.",
	dnd: "Away and silenced.",
};

/** The services roles as the form shows them, in order. */
const SERVICE_ROLE_FIELDS: {
	id: typeof SERVICE_ROLES[number];
	label: string;
	placeholder: string;
}[] = [
	{id: "oper", label: "Oper service", placeholder: "The bot that takes G-lines"},
	{id: "account", label: "Account service", placeholder: "The bot that holds accounts"},
	{id: "channel", label: "Channel service", placeholder: "The bot that holds channels"},
	{
		id: "report",
		label: "Oper report channel",
		placeholder: "Where services report oper commands",
	},
	{id: "snoop", label: "Snoop channel", placeholder: "The connect and join feed"},
];

/** How long the bots' fields rest before they are checked again. */
const CHECK_DELAY_MS = 600;

function blankBots(): ServicesConfig["bots"] {
	return {oper: "", account: "", channel: "", report: "", snoop: ""};
}

/** What the edit form binds to: a saved entry plus the live connection flag. */
export type NetworkFormDefaults = SavedNetwork & {
	connected?: boolean;
};

/** What the status button asks for; `connect` saves the form first. */
export type ConnectionAction = "connect" | "disconnect";

export default defineComponent({
	name: "NetworkForm",
	components: {
		RevealPassword,
		SidebarToggle,
	},
	props: {
		handleSubmit: {
			type: Function as PropType<(network: SavedNetwork) => void>,
			required: true,
		},
		defaults: {
			type: Object as PropType<NetworkFormDefaults>,
			required: true,
		},
		disabled: Boolean,
		embedded: Boolean,
		/** Live connection state; shows the status row when given. */
		status: {
			type: Object as PropType<SharedNetworkStatus | null>,
			default: null,
		},
		/** Connect / cancel / disconnect from the status row. */
		handleAction: {
			type: Function as PropType<(action: ConnectionAction, network: SavedNetwork) => void>,
			default: undefined,
		},
	},
	setup(props) {
		const store = useStore();
		const commandsInput = ref<HTMLTextAreaElement | null>(null);
		const commandsText = ref((props.defaults.commands ?? []).join("\n"));

		// --- Services support: the package and the bots by role, shown once
		// this network is connected and opered (nothing to set up before).
		const liveNetwork = computed(() =>
			props.defaults.uuid ? store.getters.findNetwork(props.defaults.uuid) : undefined
		);
		// The network's presence mode (the lobby dot's four, client/js/dnd.ts).
		// Until the select is touched it shows the live mode, which the dot
		// may have changed since this form was filled, and the field is not
		// posted, so saving the form keeps what is stored. Same as global is
		// no key at all, hence presenceModeOf; a pick is posted as is, and
		// "global" clears the key.
		const presenceTouched = ref(false);
		const presenceMode = computed<NetworkMode>({
			get: () =>
				presenceTouched.value
					? presenceModeOf(props.defaults)
					: liveNetwork.value?.presence?.mode ?? presenceModeOf(props.defaults),
			set(mode) {
				presenceTouched.value = true;
				props.defaults.presenceMode = mode;
			},
		});
		// Same as global names what the global mode is now.
		const presenceHint = computed(() =>
			presenceMode.value === "global"
				? `Follows the global mode under the logo, now ${
						{online: "Online", auto: "Auto", away: "Away"}[dnd.state.mode.value]
				  }.`
				: PRESENCE_HINTS[presenceMode.value]
		);
		// Another network (or a fresh copy of this one) is a fresh form.
		watch(
			() => props.defaults,
			() => {
				presenceTouched.value = false;
			}
		);
		const showServices = computed(
			() => !!props.defaults.uuid && !!props.status?.connected && isOperOn(liveNetwork.value)
		);
		const servicesPackage = ref<string>(props.defaults.services?.package ?? "");
		const serviceBots = reactive<ServicesConfig["bots"]>({
			...blankBots(),
			...(props.defaults.services?.bots ?? {}),
		});
		const servicesName = computed(
			() => servicesProfileById(servicesPackage.value)?.name ?? "the package"
		);
		const checkText = ref("");
		const checkOk = ref(false);
		const checkPending = ref(false);
		let checkTimer: ReturnType<typeof setTimeout> | undefined;
		let checkSeq = 0;

		const servicesValue = (): ServicesConfig | undefined => {
			const profile = servicesProfileById(servicesPackage.value);
			return profile ? {package: profile.id, bots: {...serviceBots}} : undefined;
		};

		/** Picking a package fills the empty fields with its usual names, never a typed one. */
		const onServicesPackage = () => {
			const profile = servicesProfileById(servicesPackage.value);

			if (!profile) {
				return;
			}

			for (const role of SERVICE_ROLES) {
				if (serviceBots[role].trim() === "") {
					serviceBots[role] = profile.defaults[role];
				}
			}
		};

		/** WHOIS the bots and say in plain words which are there. */
		const runCheck = async () => {
			const services = servicesValue();
			const uuid = props.defaults.uuid;

			if (!services || !uuid || !showServices.value) {
				checkText.value = "";
				checkOk.value = false;
				return;
			}

			const seq = ++checkSeq;
			checkPending.value = true;
			checkText.value = "Checking that the bots are online…";
			const reply = await servicesCheck(uuid, services);

			if (seq !== checkSeq) {
				return; // the fields moved on
			}

			checkPending.value = false;
			checkText.value = describeServiceCheck(reply, servicesName.value);
			checkOk.value =
				!reply.failure && reply.results.length > 0 && reply.results.every((r) => r.online);
		};

		const scheduleCheck = () => {
			clearTimeout(checkTimer);
			checkSeq++;
			checkPending.value = false;

			if (!servicesPackage.value || !showServices.value) {
				checkText.value = "";
				checkOk.value = false;
				return;
			}

			checkTimer = setTimeout(() => void runCheck(), CHECK_DELAY_MS);
		};

		watch([servicesPackage, () => ({...serviceBots}), showServices], scheduleCheck, {
			deep: true,
		});

		// Another network's entry: its own setting, not the last one's.
		watch(
			() => props.defaults.uuid,
			() => {
				servicesPackage.value = props.defaults.services?.package ?? "";
				Object.assign(serviceBots, blankBots(), props.defaults.services?.bots ?? {});
			}
		);

		onUnmounted(() => {
			clearTimeout(checkTimer);
			checkSeq++;
		});

		// This device's push situation for the network being edited (reactive
		// over webpush's servers/subscriptions): `stale` — a subscription is
		// stored, but not for the key this server announces — offers Renew.
		const pushInfo = computed(() => webpush.networkPushInfo(props.defaults.uuid ?? ""));

		const renewPush = () => {
			if (props.defaults.uuid) {
				webpush.renew(props.defaults.uuid);
			}
		};

		/** The toggle itself is the user gesture: ask for the Notification
		 * permission the first time a network's browser notifications are
		 * switched on (only while the decision is still open). */
		const onNotifyToggle = () => {
			if (props.defaults.notifyEnabled && nativeAlertsAvailable()) {
				void askNativeAlertPermission();
				return;
			}

			if (
				props.defaults.notifyEnabled &&
				typeof Notification !== "undefined" &&
				Notification.permission === "default"
			) {
				void Notification.requestPermission().catch(() => undefined);
			}
		};

		const resizeCommandsInput = () => {
			if (!commandsInput.value) {
				return;
			}

			// Reset height first so it can down size
			commandsInput.value.style.height = "";

			// 2 pixels to account for the border
			commandsInput.value.style.height = `${Math.ceil(
				commandsInput.value.scrollHeight + 2
			)}px`;
		};

		watch(
			() => props.defaults.commands,
			(commands) => {
				commandsText.value = (commands ?? []).join("\n");
				void nextTick(() => {
					resizeCommandsInput();
				});
			}
		);

		onMounted(() => {
			resizeCommandsInput();
		});

		// Keep the port on nefarious2's defaults while the TLS box is toggled.
		watch(
			() => props.defaults.tls,
			(isSecureChecked) => {
				const ports = [8067, 8443];
				const newPort = isSecureChecked ? 1 : 0;

				if (props.defaults.port === ports[1 - newPort]) {
					props.defaults.port = ports[newPort];
				}
			}
		);

		const formData = (): SavedNetwork => {
			const data: SavedNetwork = {
				...props.defaults,
				commands: parseCommands(commandsText.value),
				// The key is always sent: absent would mean "keep", and
				// undefined means None. A form without the section (not opered
				// right now) hands back what was stored.
				services: showServices.value ? servicesValue() : props.defaults.services,
			};
			delete (data as NetworkFormDefaults).connected;

			if (!presenceTouched.value) {
				delete data.presenceMode;
			}

			return data;
		};

		const onSubmit = () => {
			props.handleSubmit(formData());
		};

		const statusText = computed(() => {
			const s = props.status;

			if (!s) {
				return "";
			}

			if (s.connected) {
				return s.secure ? "Connected (TLS)" : "Connected (not secure)";
			}

			return s.connecting ? "Connecting…" : "Disconnected";
		});

		const statusClass = computed(() =>
			props.status?.connected
				? "is-connected"
				: props.status?.connecting
				? "is-connecting"
				: "is-disconnected"
		);

		const actionLabel = computed(() =>
			props.status?.connected ? "Disconnect" : props.status?.connecting ? "Cancel" : "Connect"
		);

		const onAction = () => {
			const busy = !!(props.status?.connected || props.status?.connecting);
			props.handleAction?.(busy ? "disconnect" : "connect", formData());
		};

		return {
			presenceMode,
			presenceHint,
			pushInfo,
			renewPush,
			onNotifyToggle,
			SERVICES_PROFILES,
			SERVICE_ROLE_FIELDS,
			showServices,
			servicesPackage,
			serviceBots,
			servicesName,
			onServicesPackage,
			checkText,
			checkOk,
			checkPending,
			commandsInput,
			commandsText,
			resizeCommandsInput,
			displayName,
			onSubmit,
			statusText,
			statusClass,
			actionLabel,
			onAction,
		};
	},
});
</script>
