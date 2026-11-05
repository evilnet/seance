<template>
	<div
		id="connect"
		:class="['window', {'link-approval': fromLink}]"
		:role="fromLink ? 'dialog' : 'tabpanel'"
		:aria-modal="fromLink ? 'true' : undefined"
		:aria-label="ariaLabel"
	>
		<div v-if="!fromLink" class="header">
			<SidebarToggle />
		</div>
		<form
			v-if="signInMode"
			class="container sign-in"
			method="post"
			action=""
			@submit.prevent="onSubmit"
		>
			<h1 class="title">{{ t("connect.signInTitle") }}</h1>

			<div v-if="linkNotice" class="connect-notice connect-link-notice">
				{{ linkNotice }}
			</div>

			<p v-if="signInIntro" class="sign-in-intro">{{ signInIntro }}</p>

			<div class="connect-row connect-network">
				<label>{{ t("connect.network") }}</label>
				<div class="input-wrap">
					<strong>{{ networkLabel }}</strong>
				</div>
			</div>
			<div class="connect-row">
				<label for="connect:saslAccount">{{ t("connect.account") }}</label>
				<input
					id="connect:saslAccount"
					v-model.trim="form.saslAccount"
					dir="auto"
					class="input"
					name="saslAccount"
					maxlength="100"
					autocomplete="username"
					required
				/>
			</div>
			<div class="connect-row">
				<label for="connect:saslPassword">{{ t("connect.password") }}</label>
				<RevealPassword v-slot:default="slotProps" class="input-wrap password-container">
					<input
						id="connect:saslPassword"
						ref="passwordInput"
						v-model="form.saslPassword"
						dir="auto"
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
						<input v-model="rememberMe" v-switch type="checkbox" name="rememberMe" />
						{{ t("connect.rememberMe") }}
					</label>
				</div>
			</div>

			<div v-if="notice" class="connect-notice">{{ notice }}</div>
			<div v-if="submitted" class="connect-notice">
				{{
					t("connect.connectingAs", {
						nick: submitted.nick,
						network: networkLabel,
					})
				}}
			</div>

			<div :class="{'link-approval-buttons': fromLink}">
				<button v-if="fromLink" type="button" class="btn btn-cancel" @click="cancelLink">
					{{ t("connect.notNow") }}
				</button>
				<button type="submit" class="btn btn-signin">
					{{ t("connect.signInSubmit") }}
				</button>
			</div>

			<template v-if="guestAccess">
				<h2 class="sign-in-guest">{{ t("connect.guestTitle") }}</h2>
				<div class="connect-row">
					<label for="connect:guestNick">{{ t("connect.nick") }}</label>
					<input
						id="connect:guestNick"
						v-model.trim="guestNick"
						dir="auto"
						class="input nick"
						name="guestNick"
						pattern="[^\s:!@]+"
						maxlength="100"
						@keydown.enter.prevent="onGuest"
					/>
				</div>
				<button type="button" class="btn btn-guest" @click="onGuest">
					{{ t("connect.guestSubmit") }}
				</button>
			</template>
		</form>
		<form v-else class="container" method="post" action="" @submit.prevent="onSubmit">
			<h1 class="title">
				{{ fromLink ? t("connect.newServerTitle") : t("connect.title") }}
			</h1>

			<div v-if="linkNotice" class="connect-notice connect-link-notice">
				{{ linkNotice }}
			</div>

			<h2 v-if="!hostLocked">{{ t("connect.server") }}</h2>
			<div v-if="hostLocked" class="connect-row connect-network">
				<label>{{ t("connect.network") }}</label>
				<div class="input-wrap">
					<strong>{{ networkLabel }}</strong>
				</div>
			</div>
			<div v-if="!hostLocked" class="connect-row">
				<label for="connect:host">{{ t("connect.server") }}</label>
				<div class="input-wrap">
					<input
						id="connect:host"
						v-model.trim="form.host"
						dir="auto"
						class="input"
						name="host"
						:aria-label="serverAddressLabel"
						placeholder="irc.example.org"
						autocapitalize="off"
						:autocorrect.attr="'off'"
						spellcheck="false"
						maxlength="255"
						required
					/>
					<span id="connect:portseparator">:</span>
					<input
						id="connect:port"
						v-model.number="form.port"
						dir="auto"
						class="input"
						type="number"
						min="1"
						max="65535"
						name="port"
						:aria-label="serverPortLabel"
						required
					/>
				</div>
			</div>
			<div v-if="!hostLocked" class="connect-row">
				<label></label>
				<div class="input-wrap">
					<label class="tls">
						<input v-model="form.tls" v-switch type="checkbox" name="tls" />
						{{ t("connect.useTls") }}
					</label>
				</div>
			</div>

			<h2>{{ t("connect.user") }}</h2>
			<div class="connect-row">
				<label for="connect:nick">{{ t("connect.nick") }}</label>
				<input
					id="connect:nick"
					v-model.trim="form.nick"
					dir="auto"
					class="input nick"
					name="nick"
					pattern="[^\s:!@]+"
					maxlength="100"
					autocapitalize="off"
					:autocorrect.attr="'off'"
					spellcheck="false"
					required
				/>
			</div>
			<div class="connect-row">
				<label for="connect:channels">{{ t("connect.channels") }}</label>
				<input
					id="connect:channels"
					v-model.trim="form.join"
					dir="auto"
					class="input"
					name="join"
					:placeholder="channelsPlaceholder"
					autocapitalize="off"
					:autocorrect.attr="'off'"
					spellcheck="false"
				/>
			</div>

			<h2 id="label-auth">{{ t("connect.authentication") }}</h2>
			<div class="connect-row">
				<label></label>
				<div class="input-wrap">
					<label class="tls">
						<input v-model="showSasl" v-switch type="checkbox" name="sasl" />
						{{ t("connect.saslToggle") }}
					</label>
				</div>
			</div>
			<template v-if="showSasl">
				<div class="connect-row">
					<label for="connect:saslAccount">{{ t("connect.account") }}</label>
					<input
						id="connect:saslAccount"
						v-model.trim="form.saslAccount"
						dir="auto"
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
					<label for="connect:saslPassword">{{ t("connect.password") }}</label>
					<RevealPassword
						v-slot:default="slotProps"
						class="input-wrap password-container"
					>
						<input
							id="connect:saslPassword"
							ref="passwordInput"
							v-model="form.saslPassword"
							dir="auto"
							class="input"
							:type="slotProps.isVisible ? 'text' : 'password'"
							name="saslPassword"
							maxlength="300"
							autocomplete="current-password"
							required
						/>
					</RevealPassword>
				</div>
				<div class="connect-row">
					<label></label>
					<div class="input-wrap">
						<label class="tls">
							<input
								v-model="pushEnabled"
								v-switch
								type="checkbox"
								name="pushEnabled"
							/>
							{{ t("connect.pushNotifications") }}
						</label>
					</div>
				</div>
				<div v-if="showSavedNetworks" class="connect-row">
					<label></label>
					<div class="input-wrap">
						<label class="tls">
							<input
								v-model="rememberPassword"
								v-switch
								type="checkbox"
								name="rememberPassword"
							/>
							{{ t("connect.rememberPassword") }}
						</label>
					</div>
				</div>
			</template>

			<div class="connect-row">
				<label></label>
				<div class="input-wrap">
					<label class="tls">
						<input
							v-model="notifyEnabled"
							v-switch
							type="checkbox"
							name="notifyEnabled"
							@change="onNotifyToggle"
						/>
						{{ t("connect.browserNotifications") }}
					</label>
				</div>
			</div>

			<div v-if="showSavedNetworks" class="connect-row">
				<label></label>
				<div class="input-wrap">
					<label class="tls">
						<input v-model="autoconnect" v-switch type="checkbox" name="autoconnect" />
						{{ t("connect.autoconnect") }}
					</label>
				</div>
			</div>

			<div v-if="notice" class="connect-notice">{{ notice }}</div>
			<div v-if="submitted" class="connect-notice">
				{{
					t("connect.connectingAs", {
						nick: submitted.nick,
						network: `${submitted.host}:${submitted.port}`,
					})
				}}
			</div>

			<div :class="{'link-approval-buttons': fromLink}">
				<button v-if="fromLink" type="button" class="btn btn-cancel" @click="cancelLink">
					{{ t("connect.notNow") }}
				</button>
				<button type="submit" class="btn">{{ t("connect.submit") }}</button>
			</div>
		</form>
	</div>
</template>

<style>
#connect .connect-notice {
	padding: 10px;
	margin-bottom: 10px;
	border-radius: 2px;
	background-color: #d9edf7;
	color: #31708f;
}

#connect .connect-network .input-wrap {
	padding: 6px 0;
}

#connect .connect-link-notice {
	background-color: #fcf8e3;
	color: #8a6d3b;
}

#connect.link-approval {
	position: fixed;
	inset: 0;
	z-index: 999;
	background: rgb(0 0 0 / 90%);
	padding: 20px;
}

#connect.link-approval .container {
	width: min(560px, 100%);
	margin: auto;
	padding: 24px;
	border-radius: 5px;
	background: var(--window-bg-color);
}

#connect .link-approval-buttons {
	display: flex;
	gap: 10px;
}

#connect .link-approval-buttons .btn {
	flex: 1;
}

#connect .link-approval-buttons .btn-cancel {
	background: transparent;
	color: var(--body-color);
}

/* The sign-in panel: the same rows, with the guest half set apart by a rule
 * so the two ways in read as two choices rather than one long form. */
#connect .sign-in-intro {
	margin: 0 0 1.25rem;
	color: var(--body-color-muted, inherit);
}

#connect .sign-in-guest {
	margin-top: 2rem;
}

/* The language row: a quiet utility at the bottom of the form, not one of
 * the connect fields. Its copy is long (the label carries a gloss), so it
 * takes the full row width instead of the 25% field-label column, muted. */
#connect .connect-locale {
	display: block;
	margin-top: 0.625rem;
}

#connect .connect-locale label {
	width: 100%;
	margin-top: 0;
	margin-bottom: 0.375rem;
	color: var(--body-color-muted, inherit);
}

/* The stock `.btn` is already an outline, so the two ways in would look
 * alike; the account form is the primary one, and fills. `.btn-guest` keeps
 * the outline (and its class, which the browser scenario clicks). */
#connect .btn-signin {
	background: var(--button-color);
	color: var(--button-text-color-hover);
}
</style>

<script lang="ts">
import {computed, defineComponent, onMounted, reactive, ref, watch} from "vue";

import {useStore} from "../../js/store";
import {brandingFeatures, expandNick, nickFromAccount} from "../../js/branding";
import {autoconnectSavedNetworks, createNetwork} from "../../js/irc/manager";
import * as saved from "../../js/irc/saved-networks";
import {defaultPort, SavedNetwork} from "../../js/irc/saved-networks";
import {mergeJoinLists} from "../../js/helpers/linkTarget";
import {askNativeAlertPermission, nativeAlertsAvailable} from "../../js/helpers/nativeAlerts";
import {router, switchToChannel} from "../../js/router";
import {useI18n} from "../../js/i18n";
import type {ConnectOptions} from "../../js/irc/types";
import RevealPassword from "../RevealPassword.vue";
import SidebarToggle from "../SidebarToggle.vue";

export type {ConnectOptions};

/**
 * URL parameters that pre-fill the form (and so beat the last-used entry).
 * `saslPassword` is deliberately not accepted: a link must not carry secrets
 * (docs/projects/irc-link-new-server-dialog.md).
 */
const CONNECT_PARAMS = ["host", "port", "tls", "nick", "join", "channels", "saslAccount"];

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
		// Every label here — including the branding-catalog keys — speaks
		// through useI18n's t: reactive on a locale change, and the deploy's
		// `strings` overrides still win there (useI18n applies them ahead of
		// the catalog lookup, the same rule brandingString applied).
		const {t} = useI18n();
		// Bound attributes read computeds, not inline calls, so the key stays
		// double-quoted for the pot↔call-site check.
		const ariaLabel = computed(() => t("connect.ariaLabel"));
		const serverAddressLabel = computed(() => t("connect.serverAddress"));
		const serverPortLabel = computed(() => t("connect.serverPort"));
		const channelsPlaceholder = computed(() => t("connect.channelsPlaceholder"));
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

		// The sign-in panel replaces the whole form; `brandingFeatures` only
		// reports it when there is a `defaultNetwork` to sign in to, and pins
		// the server when it does.
		const signInMode = features.signIn;
		const guestAccess = features.guestAccess;
		// A computed, not a snapshot: the intro must follow a locale change.
		const signInIntro = computed(() => t("connect.signInIntro"));
		/** The guest half's own field, so prefilling an account leaves it be. */
		const guestNick = ref(network?.nick ? expandNick(network.nick) : "");
		/** "Stay signed in": remember the password *and* connect on next load,
		 * which together are what make the sign-in screen a first-run screen. */
		const rememberMe = ref(false);

		const showSasl = ref(false);
		const rememberPassword = ref(false);
		const autoconnect = ref(false);
		/** Push defaults to on for a new network: the flag means "register when
		 * the server supports it", which is what nearly everyone wants. */
		const pushEnabled = ref(true);

		/** Browser notifications default to on for a new network (no
		 * authentication involved, unlike push). */
		const notifyEnabled = ref(true);

		/** The toggle itself is the user gesture for the Notification
		 * permission ask (only while the decision is still open). */
		const onNotifyToggle = () => {
			if (notifyEnabled.value && nativeAlertsAvailable()) {
				void askNativeAlertPermission();
				return;
			}

			if (
				notifyEnabled.value &&
				typeof Notification !== "undefined" &&
				Notification.permission === "default"
			) {
				void Notification.requestPermission().catch(() => undefined);
			}
		};

		/** The saved entry the form was filled from; its uuid is reused on connect. */
		const selectedUuid = ref<string | null>(null);
		const submitted = ref<ConnectOptions | null>(null);
		const notice = ref("");
		const passwordInput = ref<HTMLInputElement | null>(null);

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
			pushEnabled.value = net.pushEnabled !== false;
			notifyEnabled.value = net.notifyEnabled !== false;
			selectedUuid.value = net.uuid;
			notice.value = "";
			pinServer();
		};

		const hasConnectParams = CONNECT_PARAMS.some(
			(key) => props.queryParams && props.queryParams[key] !== undefined
		);

		// boot.ts routes here when a web+irc:// link (or a ?host= URL) names a
		// server that is not approved yet (`fromLink`), was refused by a locked
		// deploy (`linkIgnored`), or matches a saved network that still needs
		// its password typed (`savedLink`). See docs/resources/irc-links.md.
		const savedLinkUuid = firstParam(props.queryParams?.savedLink);
		const savedLink = savedLinkUuid ? saved.get(savedLinkUuid) : undefined;
		const linkIgnored = firstParam(props.queryParams?.linkIgnored);
		const fromLink = isTruthyParam(props.queryParams?.fromLink);
		let focusPassword = false;

		if (savedLink) {
			prefill(savedLink);
			const linkJoin = firstParam(props.queryParams?.join);

			if (linkJoin) {
				form.join = mergeJoinLists(form.join, linkJoin);
			}

			if (savedLink.sasl === "plain" && !savedLink.saslPassword) {
				notice.value = t("connect.enterPassword", {account: savedLink.saslAccount});
				focusPassword = true;
			}
		} else if (hasConnectParams) {
			applyQueryParams(form, props.queryParams);
			pinServer();
			showSasl.value = form.sasl === "plain" || !!form.saslAccount;
		} else {
			// Pre-fill from the last-used entry only while nothing is live yet;
			// with networks up, this screen is "add another network" and starts
			// blank. Existing entries are managed in Settings → Networks.
			const last =
				showSavedNetworks && store.state.networks.length === 0
					? saved.lastUsed()
					: undefined;

			if (last) {
				prefill(last);

				if (signInMode) {
					rememberMe.value = rememberPassword.value;

					// A returning guest gets their own nick back; a returning
					// account holder gets the account, and the guest field
					// keeps the deploy's pattern.
					if (last.sasl !== "plain" && last.nick) {
						guestNick.value = last.nick;
					}
				}
			} else {
				showSasl.value = form.sasl === "plain" || !!form.saslAccount;
			}
		}

		// What the link asked for, said out loud — the approval step's context.
		// A computed so a locale change re-renders it while the dialog is up.
		const linkNotice = computed(() => {
			if (linkIgnored) {
				return t("connect.linkIgnored", {network: networkLabel, host: linkIgnored});
			}

			if (fromLink && !savedLink && form.host) {
				return form.join
					? t("connect.linkSuggestJoin", {
							host: form.host,
							port: form.port,
							channels: form.join,
					  })
					: t("connect.linkSuggest", {host: form.host, port: form.port});
			}

			return "";
		});

		// Follow the TLS checkbox while the port is still one of the defaults.
		watch(
			() => form.tls,
			(useTls) => {
				if (form.port === defaultPort(!useTls)) {
					form.port = defaultPort(useTls);
				}
			}
		);

		/**
		 * A sign-in deploy connects to one server, so it keeps one saved
		 * entry: signing in again — as the same account, as someone else, or
		 * as a guest — replaces it instead of leaving a list of
		 * near-identical networks behind (`findMatching` keys on the nick,
		 * and a guest's nick changes every visit).
		 */
		const signInUuid = () =>
			selectedUuid.value ??
			saved.list().find((net) => net.host === server.host && net.port === server.port)?.uuid;

		/** The tail every path on this screen shares. */
		const start = (options: {rememberPassword: boolean; autoconnect: boolean}) => {
			submitted.value = {...form};
			notice.value = "";
			const client = createNetwork({
				...submitted.value,
				uuid: (signInMode ? signInUuid() : selectedUuid.value) ?? undefined,
				pushEnabled: pushEnabled.value,
				notifyEnabled: notifyEnabled.value,
				...options,
			});
			selectedUuid.value = client.uuid;
			autoconnectSavedNetworks();
		};

		/** Sign in: the account and password are the SASL credentials, and the
		 * account is the nick unless it holds characters a nick may not. */
		const onSignIn = () => {
			form.sasl = "plain";
			// The last resort only comes up for an account with no
			// nick-legal character at all on a deploy that sets no nick
			// pattern; an empty NICK must never reach the wire.
			form.nick = nickFromAccount(
				form.saslAccount,
				guestNick.value || expandNick("guest????")
			);

			const remember = showSavedNetworks && rememberMe.value;
			start({rememberPassword: remember, autoconnect: remember});
		};

		/** Connect as a guest: no SASL, and nothing kept for the next visit. */
		const onGuest = () => {
			const nick = guestNick.value.trim();

			if (!/^[^\s:!@]+$/.test(nick)) {
				notice.value = t("connect.guestNickRequired");
				return;
			}

			form.nick = nick;
			form.sasl = "";
			form.saslAccount = "";
			form.saslPassword = "";
			start({rememberPassword: false, autoconnect: false});
		};

		const onSubmit = () => {
			if (signInMode) {
				onSignIn();
				return;
			}

			form.sasl = showSasl.value ? "plain" : "";

			if (!showSasl.value) {
				form.saslAccount = "";
				form.saslPassword = "";
			}

			start({
				rememberPassword: showSasl.value && rememberPassword.value,
				autoconnect: autoconnect.value,
			});
		};

		const cancelLink = async () => {
			autoconnectSavedNetworks();

			// createNetwork dispatches its lobby synchronously and normally moves
			// us away from this dialog. If there was nothing to start, return to
			// an existing network or the ordinary blank connect screen.
			if (router.currentRoute.value.name !== "Connect") {
				return;
			}

			const firstChannel = store.state.networks[0]?.channels[0];

			if (firstChannel) {
				switchToChannel(firstChannel);
			} else {
				await router.replace({name: "Connect"});
			}
		};

		onMounted(() => {
			// A link to a saved network whose password was not remembered:
			// everything is filled in but the password, so put the cursor there.
			if (focusPassword) {
				passwordInput.value?.focus();
			}
		});

		return {
			form,
			store,
			t,
			ariaLabel,
			serverAddressLabel,
			serverPortLabel,
			channelsPlaceholder,
			signInMode,
			guestAccess,
			signInIntro,
			guestNick,
			rememberMe,
			onGuest,
			hostLocked,
			networkLabel,
			showSavedNetworks,
			showSasl,
			rememberPassword,
			autoconnect,
			pushEnabled,
			notifyEnabled,
			onNotifyToggle,
			selectedUuid,
			submitted,
			notice,
			linkNotice,
			fromLink,
			passwordInput,
			onSubmit,
			cancelLink,
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

	const host = firstParam(params.host);
	const port = firstParam(params.port);
	const tls = firstParam(params.tls);
	const nick = firstParam(params.nick);
	const join = firstParam(params.join ?? params.channels);
	const saslAccount = firstParam(params.saslAccount);

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
}

/** First value of a possibly-repeated query parameter, as a string. */
function firstParam(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		value = value[0];
	}

	return value === undefined || value === null ? undefined : String(value);
}
</script>
