<template>
	<div
		id="user-card-overlay"
		v-backdrop="close"
		class="screen-overlay"
		:class="{opened: !!data}"
		:data-escape-close="data ? 'user-card' : null"
	>
		<div
			v-if="data"
			id="user-card"
			ref="card"
			role="dialog"
			aria-modal="true"
			aria-labelledby="user-card-nick"
			tabindex="-1"
		>
			<div class="user-card-banner">
				<span :class="['user-card-tint', 'user', nickColor]"></span>
				<button
					type="button"
					class="user-card-close"
					:aria-label="t('avatar.cardClose')"
					:title="t('avatar.cardClose')"
					@click="close"
				></button>
			</div>

			<div class="user-card-head">
				<button
					v-if="view.kind === 'image'"
					type="button"
					class="user-card-avatar"
					:aria-label="t('avatar.view')"
					:title="t('avatar.view')"
					@click="viewAvatar"
				>
					<Avatar :uuid="data.network.uuid" :nick="data.nick" :self="self" size="card" />
				</button>
				<span v-else class="user-card-avatar">
					<Avatar :uuid="data.network.uuid" :nick="data.nick" :self="self" size="card" />
				</span>
				<div class="user-card-who">
					<strong id="user-card-nick" :class="['user', 'user-card-nick', nickColor]">{{
						data.nick
					}}</strong>
					<span v-if="whois?.real_name" class="user-card-realname">{{
						whois.real_name
					}}</span>
				</div>
				<ul v-if="badges.length" class="user-card-badges">
					<li
						v-for="badge in badges"
						:key="badge.kind"
						:class="['user-card-badge', 'user-card-badge-' + badge.kind]"
					>
						{{ badge.text }}
					</li>
				</ul>
				<div class="user-card-actions">
					<button
						v-if="self"
						type="button"
						class="btn btn-confirm user-card-change"
						@click="change"
					>
						{{ t("avatar.change") }}
					</button>
					<template v-else>
						<button
							type="button"
							class="btn btn-confirm user-card-message"
							@click="message"
						>
							{{ t("profile.message") }}
						</button>
						<button type="button" class="btn user-card-mention" @click="mention">
							{{ t("profile.mention") }}
						</button>
					</template>
					<button
						type="button"
						class="btn user-card-more"
						:aria-label="t('profile.more')"
						:title="t('profile.more')"
						@click="more"
					></button>
				</div>
			</div>

			<div v-if="view.kind === 'veiled'" class="user-card-veiled">
				<p>
					<I18nFrame :text="t('avatar.cardVeiled', {nick: KEEP, host: KEEP})"
						><template v-slot:nick
							><bdi>{{ data.nick }}</bdi></template
						><template v-slot:host
							><strong>{{ view.host }}</strong></template
						></I18nFrame
					>
				</p>
				<button type="button" class="btn btn-confirm" @click="showOnce">
					{{ t("avatar.showOnce") }}
				</button>
				<button v-if="account" type="button" class="user-card-link" @click="alwaysPerson">
					{{ t("avatar.alwaysPerson", {nick: data.nick}) }}
				</button>
				<button type="button" class="user-card-link" @click="alwaysHost">
					{{ t("avatar.alwaysHost", {host: view.host}) }}
				</button>
			</div>
			<p v-else-if="view.kind === 'none' && avatarsOn && !self" class="user-card-note">
				{{ t("avatar.cardNone", {nick: data.nick}) }}
			</p>

			<p v-if="status === 'offline'" class="user-card-note">
				{{ t("profile.offline", {nick: data.nick}) }}
			</p>
			<p v-else-if="status === 'unavailable'" class="user-card-note">
				{{ t("profile.unavailable") }}
			</p>

			<section
				v-if="channels.shared.length || channels.others.length"
				class="user-card-section"
			>
				<h2>{{ t("profile.inCommon") }}</h2>
				<ul v-if="channels.shared.length" class="user-card-channels">
					<li v-for="chan in channels.shared" :key="chan.name">
						<b v-if="chan.prefix">{{ chan.prefix }}</b
						><bdi>{{ chan.name }}</bdi>
					</li>
				</ul>
				<p v-if="channels.others.length" class="user-card-also">
					{{ t("profile.alsoIn", {channels: channels.others.join(", ")}) }}
				</p>
			</section>

			<section
				v-if="status === 'loading' || rows.length"
				class="user-card-section"
				:aria-busy="status === 'loading'"
			>
				<h2>{{ t("profile.connection") }}</h2>
				<div v-if="status === 'loading'" class="user-card-skeleton">
					<span class="sr-only">{{ t("profile.loading") }}</span>
					<i></i><i></i><i></i>
				</div>
				<dl v-else>
					<template v-for="row in rows" :key="row.label">
						<dt>{{ row.label }}</dt>
						<dd :dir="row.ltr ? 'ltr' : undefined" :class="{'oper-mono': row.mono}">
							{{ row.value }}
						</dd>
					</template>
				</dl>
			</section>

			<div class="user-card-foot">
				<button
					v-if="personTrusted"
					type="button"
					class="user-card-untrust"
					@click="stopTrusting"
				>
					{{ t("avatar.stopPerson", {nick: data.nick}) }}
				</button>
				<span v-else-if="answeredAt" class="user-card-updated">{{
					t("profile.updated", {time: formatRelativeTime(answeredAt)})
				}}</span>
				<button
					v-if="status !== 'loading'"
					type="button"
					class="btn btn-sm user-card-refresh"
					@click="lookUp(true)"
				>
					{{ t("profile.refresh") }}
				</button>
			</div>
		</div>
	</div>
</template>

<style>
#user-card {
	background: var(--window-bg-color);
	color: var(--body-color);
	border-radius: 1rem;
	margin: 0.625rem;
	width: min(28rem, calc(100% - 1.25rem));
	max-height: calc(100% - 1.25rem);
	overflow-y: auto;
	box-shadow: 0 1rem 3rem rgb(0 0 0 / 55%);
	display: flex;
	flex-direction: column;
	user-select: text;
}

#user-card:focus {
	outline: 0;
}

/* The nick's own colour (as `.user` draws it), faded: no picture is fetched for it. */
.user-card-banner {
	position: relative;
	flex: none;
	height: 4rem;
}

.user-card-tint {
	position: absolute;
	inset: 0;
	background: linear-gradient(120deg, currentcolor, transparent 75%);
	opacity: 0.45;
}

.user-card-close {
	position: absolute;
	z-index: 1;
	inset-block-start: 0.625rem;
	inset-inline-end: 0.625rem;
	width: 2rem;
	height: 2rem;
	border: 0;
	border-radius: 50%;
	background: rgb(0 0 0 / 45%);
	color: #fff;
	font-size: 1rem;
}

.user-card-close::before {
	font-family: FontAwesome;
	content: "\f00d"; /* https://fontawesome.com/icons/times?style=solid */
}

.user-card-head {
	position: relative;
	display: flex;
	flex-direction: column;
	gap: 0.625rem;
	padding: 0 1.25rem 1rem;
	margin-block-start: -2.5rem;
}

.user-card-avatar {
	align-self: flex-start;
	padding: 0;
	border: 0.1875rem solid var(--window-bg-color);
	border-radius: var(--avatar-radius, 50%);
	background: var(--window-bg-color);
	line-height: 0;
	position: relative;
}

button.user-card-avatar {
	cursor: zoom-in;
}

.user-card-avatar .avatar-card {
	width: 5.5rem;
	height: 5.5rem;
	font-size: 2.25rem;
}

.user-card-who {
	display: flex;
	flex-direction: column;
	gap: 0.125rem;
	min-width: 0;
}

.user-card-nick {
	font-size: 1.25rem;
	overflow-wrap: anywhere;
}

.user-card-realname {
	font-size: 0.875rem;
	color: var(--body-color-muted);
	overflow-wrap: anywhere;
}

.user-card-badges {
	display: flex;
	flex-wrap: wrap;
	gap: 0.375rem;
	margin: 0;
	padding: 0;
	list-style: none;
}

.user-card-badge {
	font-size: 0.75rem;
	line-height: 1.2;
	padding: 0.25rem 0.625rem;
	border-radius: 1rem;
	border: 1px solid rgb(128 128 128 / 30%);
	background: rgb(128 128 128 / 12%);
	overflow-wrap: anywhere;
}

.user-card-badge-away {
	border-color: rgb(224 163 64 / 45%);
}

.user-card-badge-account {
	border-color: rgb(110 190 105 / 45%);
}

.user-card-badge-oper {
	border-color: rgb(170 130 230 / 50%);
}

.user-card-actions {
	display: flex;
	gap: 0.5rem;
	margin-block-start: 0.25rem;
}

.user-card-actions .btn {
	flex: 1 1 0;
	margin: 0;
}

.user-card-actions .user-card-more {
	flex: none;
	width: 2.75rem;
	padding: 0;
}

.user-card-more::before {
	font-family: FontAwesome;
	content: "\f141"; /* https://fontawesome.com/icons/ellipsis-h?style=solid */
}

.user-card-veiled {
	display: flex;
	flex-direction: column;
	gap: 0.375rem;
	margin: 0 1.25rem 1rem;
	padding: 0.75rem 0.875rem;
	border-radius: 0.625rem;
	background: rgb(128 128 128 / 12%);
}

.user-card-veiled p,
.user-card-note {
	margin: 0 0 0.25rem;
	font-size: 0.8125rem;
	line-height: 1.45;
	color: var(--body-color-muted);
}

.user-card-note {
	margin: 0 1.25rem 1rem;
}

.user-card-veiled .btn {
	margin: 0 0 0.25rem;
	white-space: normal;
}

.user-card-veiled .user-card-link {
	font-size: 0.8125rem;
	padding: 0.125rem 0;
}

.user-card-section {
	display: flex;
	flex-direction: column;
	gap: 0.625rem;
	padding: 0.875rem 1.25rem;
	border-block-start: 1px solid rgb(128 128 128 / 20%);
}

.user-card-section h2 {
	margin: 0;
	font-size: 0.6875rem;
	font-weight: 600;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	color: var(--body-color-muted);
}

.user-card-channels {
	display: flex;
	flex-wrap: wrap;
	gap: 0.375rem;
	margin: 0;
	padding: 0;
	list-style: none;
}

.user-card-channels li {
	font-size: 0.8125rem;
	padding: 0.25rem 0.5625rem;
	border-radius: 0.4375rem;
	background: rgb(128 128 128 / 14%);
}

.user-card-channels b {
	color: var(--link-color);
}

.user-card-also {
	margin: 0;
	font-size: 0.75rem;
	color: var(--body-color-muted);
	overflow-wrap: anywhere;
}

.user-card-section dl {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 0.5rem 1rem;
	margin: 0;
	font-size: 0.8125rem;
	line-height: 1.4;
}

.user-card-section dt {
	color: var(--body-color-muted);
}

.user-card-section dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}

.user-card-skeleton {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

.user-card-skeleton i {
	height: 0.625rem;
	border-radius: 0.25rem;
	background: rgb(128 128 128 / 20%);
}

.user-card-skeleton i:nth-of-type(1) {
	width: 85%;
}

.user-card-skeleton i:nth-of-type(2) {
	width: 60%;
}

.user-card-skeleton i:nth-of-type(3) {
	width: 70%;
}

.user-card-foot {
	display: flex;
	align-items: center;
	gap: 0.625rem;
	padding: 0.625rem 1.25rem;
	border-block-start: 1px solid rgb(128 128 128 / 20%);
	font-size: 0.75rem;
	color: var(--body-color-muted);
}

.user-card-foot .user-card-refresh {
	margin: 0;
	margin-inline-start: auto;
	padding: 0.25rem 0.625rem;
	font-size: 0.75rem;
}

.user-card-untrust,
.user-card-link {
	padding: 0;
	border: 0;
	background: none;
	color: var(--body-color-muted);
	font-size: 0.75rem;
	text-decoration: underline;
	text-align: start;
}

/* A phone: a sheet from the bottom edge. */
@media (max-width: 479px) {
	#user-card-overlay {
		justify-content: flex-end;
	}

	#user-card {
		width: 100%;
		margin: 0;
		max-height: calc(100% - 3rem);
		border-end-start-radius: 0;
		border-end-end-radius: 0;
		padding-block-end: env(safe-area-inset-bottom);
	}

	.user-card-actions .btn {
		min-height: 2.75rem;
	}
}
</style>

<script lang="ts">
// The user profile: a person's avatar at a size you can see, who they are and
// how they are connected (a quiet WHOIS, `whois:profile:ask`, never printed in
// the chat), the choices about loading their picture in plain sentences, and
// Message / Mention / the user menu. Opened by a click on an avatar
// (Username.vue) or from the user menu (helpers/contextMenu.ts
// `openUserCard`); our own offers "Change your avatar" (Settings → Avatar).
// Its avatar shows by the same rules as everywhere else (avatars/policy.ts):
// a veiled picture loads only when asked.
import {computed, defineComponent, inject, nextTick, onMounted, onUnmounted, ref} from "vue";
import {useRouter} from "vue-router";
import type {WhoisData, WhoisProfileAnswer, WhoisProfileStatus} from "../../shared/types/whois";
import {
	avatarsEnabled,
	isPersonTrusted,
	loadOnce,
	personKey,
	trustPerson,
	untrustPerson,
} from "../js/avatars/prefs";
import {accountFor, viewFor} from "../js/avatars/view";
import eventbus from "../js/eventbus";
import {channelByName} from "../js/helpers/channelByName";
import colorClass from "../js/helpers/colorClass";
import {focusInput} from "../js/helpers/compose";
import {queryUser} from "../js/helpers/contextMenu";
import findChannels from "../js/helpers/ircmessageparser/findChannels";
import {trustHost} from "../js/helpers/mediaTrust";
import {useI18n} from "../js/i18n";
import {KEEP} from "../js/i18n/core";
import {formatRelativeTime} from "../js/i18n/dates";
import {namesEqual} from "../js/irc/casemap";
import {AWAY_STAR} from "../js/irc/presence";
import {switchToChannel} from "../js/router";
import socket from "../js/socket";
import {useStore} from "../js/store";
import type {ClientChan, ClientNetwork} from "../js/types";
import {imageViewerKey} from "./App.vue";
import Avatar from "./Avatar.vue";
import I18nFrame from "./I18nFrame.vue";

type CardData = {
	network: ClientNetwork;
	channel: ClientChan;
	nick: string;
	address?: string;
};

type Row = {label: string; value: string; ltr?: boolean; mono?: boolean};

export default defineComponent({
	name: "UserCard",
	components: {Avatar, I18nFrame},
	setup() {
		const store = useStore();
		const router = useRouter();
		const {t} = useI18n();
		const imageViewer = inject(imageViewerKey);
		const data = ref<CardData | null>(null);
		const card = ref<HTMLElement | null>(null);
		const status = ref<WhoisProfileStatus | "loading">("loading");
		const whois = ref<WhoisData | null>(null);
		const answeredAt = ref(0);

		const casemap = () => data.value?.network.serverOptions.CASEMAPPING;
		const sameNick = (a: string, b: string) => namesEqual(a, b, casemap());

		const self = computed(
			() => !!data.value && sameNick(data.value.nick, data.value.network.nick)
		);
		const subject = computed(() =>
			data.value
				? {uuid: data.value.network.uuid, nick: data.value.nick, self: self.value}
				: null
		);
		const view = computed(() =>
			subject.value ? viewFor(store, subject.value) : ({kind: "none"} as const)
		);
		const account = computed(
			() =>
				(whois.value?.whowas ? undefined : whois.value?.account) ??
				(subject.value ? accountFor(subject.value) : null)
		);
		const avatarsOn = computed(() => !!data.value && avatarsEnabled(data.value.network.uuid));
		const nickColor = computed(() =>
			data.value && store.state.settings.coloredNicks ? colorClass(data.value.nick) : ""
		);
		const personTrusted = computed(
			() =>
				!!data.value &&
				!self.value &&
				view.value.kind === "image" &&
				!!account.value &&
				isPersonTrusted(data.value.network.uuid, account.value, view.value.host)
		);

		// Only what is true shows; a missing account says nothing.
		const badges = computed(() => {
			const w = status.value === "online" ? whois.value : null;
			const list: {kind: string; text: string}[] = [];

			if (w?.away !== undefined) {
				list.push({
					kind: "away",
					text:
						w.away === AWAY_STAR
							? t("profile.awayNoMessage")
							: t("profile.away", {message: w.away}),
				});
			}

			if (account.value && status.value !== "offline") {
				list.push({
					kind: "account",
					text: t("avatar.cardSignedIn", {account: account.value}),
				});
			}

			if (w?.secure) {
				list.push({kind: "secure", text: t("profile.secure")});
			}

			if (w?.operator) {
				list.push({kind: "oper", text: t("profile.oper")});
			}

			if (w?.bot) {
				list.push({kind: "bot", text: t("profile.bot")});
			}

			return list;
		});

		// The channels the WHOIS lists, the ones we are in first.
		const channels = computed(() => {
			const shared: {name: string; prefix: string}[] = [];
			const others: string[] = [];
			const network = data.value?.network;

			if (!network || status.value !== "online" || !whois.value?.channels) {
				return {shared, others};
			}

			const text = whois.value.channels;
			const {CHANTYPES, PREFIX} = network.serverOptions;

			for (const {channel: name, start} of findChannels(text, CHANTYPES, PREFIX.symbols)) {
				if (channelByName(network, name)) {
					const prefix = text.slice(text.lastIndexOf(" ", start - 1) + 1, start);
					shared.push({name, prefix});
				} else {
					others.push(name);
				}
			}

			return {shared, others};
		});

		const rows = computed(() => {
			const w = whois.value;
			const list: Row[] = [];

			const address = w ? `${w.ident}@${w.hostname}` : data.value?.address;

			if (address) {
				list.push({label: t("profile.address"), value: address, ltr: true});
			}

			if (!w) {
				return list;
			}

			if (w.actual_ip || w.actual_hostname) {
				const real = [w.actual_hostname, w.actual_ip].filter(Boolean).join(" ");
				list.push({label: t("profile.realAddress"), value: real, ltr: true});
			}

			if (w.whowas) {
				// WHOWAS's 312 carries the server and when the nick left it.
				if (w.server_info) {
					list.push({label: t("profile.lastSeen"), value: w.server_info});
				}

				return list;
			}

			if (w.server) {
				const info = w.server_info ? ` · ${w.server_info}` : "";
				list.push({label: t("profile.server"), value: `${w.server}${info}`});
			}

			if (w.logonTime) {
				list.push({label: t("profile.signedOn"), value: formatRelativeTime(w.logonTime)});
			}

			if (w.idleTime) {
				list.push({label: t("profile.lastActive"), value: formatRelativeTime(w.idleTime)});
			}

			if (w.certfp) {
				list.push({label: t("profile.certificate"), value: w.certfp, mono: true});
			}

			return list;
		});

		const lookUp = (fresh = false) => {
			if (!data.value) {
				return;
			}

			status.value = "loading";
			socket.emit("whois:profile:ask", {
				network: data.value.network.uuid,
				nick: data.value.nick,
				fresh,
			});
		};

		const onProfile = (answer: WhoisProfileAnswer) => {
			if (
				!data.value ||
				answer.network !== data.value.network.uuid ||
				!sameNick(answer.nick, data.value.nick)
			) {
				return;
			}

			status.value = answer.status;
			whois.value = answer.whois ?? null;
			answeredAt.value = Date.now();
		};

		const close = () => {
			data.value = null;
		};

		const open = (next: CardData) => {
			data.value = next;
			whois.value = null;
			answeredAt.value = 0;
			lookUp();
			void nextTick(() => card.value?.focus());
		};

		const showOnce = () => {
			if (view.value.kind === "veiled") {
				loadOnce(view.value.href);
			}
		};

		const alwaysPerson = () => {
			if (data.value && account.value && view.value.kind === "veiled") {
				trustPerson(data.value.network.uuid, account.value, view.value.host);
			}
		};

		const alwaysHost = () => {
			if (view.value.kind === "veiled") {
				trustHost(view.value.host);
			}
		};

		const stopTrusting = () => {
			if (data.value && account.value && view.value.kind === "image") {
				untrustPerson(personKey(data.value.network.uuid, account.value, view.value.host));
			}
		};

		// The picture in the image viewer, as a link preview would open it:
		// already loaded here, so the viewer fetches nothing new.
		const viewAvatar = () => {
			const viewer = imageViewer?.value;

			if (!viewer || view.value.kind !== "image") {
				return;
			}

			const picture: ClientLinkPreview = {
				type: "image",
				head: "",
				body: "",
				thumb: view.value.src,
				size: -1,
				link: view.value.href,
				revealed: true,
			};
			close();
			viewer.channel = null;
			viewer.link = picture;
		};

		const message = () => {
			if (data.value) {
				queryUser(data.value.network, data.value.channel, data.value.nick);
			}

			close();
		};

		// The nick into the message box of the window the profile was opened from.
		const mention = () => {
			const current = data.value;
			close();

			if (!current) {
				return;
			}

			// At the start, the nick-postfix setting follows it as Tab completion's does.
			const chan = current.channel;
			const draft = chan.pendingMessage;
			const postfix = store.state.settings.nickPostfix || ": ";
			chan.pendingMessage =
				draft.trim() === ""
					? `${current.nick}${postfix}`
					: `${draft.replace(/\s*$/, " ")}${current.nick} `;
			switchToChannel(chan);
			void nextTick(focusInput);
		};

		// The user menu (Ignore, op actions, Whois in the chat …) where the button is.
		const more = (event: MouseEvent) => {
			const current = data.value;
			close();

			if (!current) {
				return;
			}

			// ContextMenu finds the user's modes in the channel itself.
			eventbus.emit("contextmenu:user", {
				event,
				user: {nick: current.nick, modes: []},
				network: current.network,
				channel: current.channel,
				address: current.address,
			});
		};

		const change = () => {
			const uuid = data.value?.network.uuid;
			close();
			void router.push({name: "Avatars", query: uuid ? {network: uuid} : {}});
		};

		const onEscape = (layer: string | null) => {
			if (layer === "user-card") {
				close();
			}
		};

		onMounted(() => {
			eventbus.on("usercard:open", open);
			eventbus.on("escapekey", onEscape);
			socket.on("whois:profile", onProfile);
		});

		onUnmounted(() => {
			eventbus.off("usercard:open", open);
			eventbus.off("escapekey", onEscape);
			socket.off("whois:profile", onProfile);
		});

		return {
			t,
			KEEP,
			data,
			card,
			self,
			view,
			account,
			avatarsOn,
			nickColor,
			personTrusted,
			status,
			whois,
			answeredAt,
			formatRelativeTime,
			badges,
			channels,
			rows,
			close,
			lookUp,
			showOnce,
			alwaysPerson,
			alwaysHost,
			stopTrusting,
			viewAvatar,
			message,
			mention,
			more,
			change,
		};
	},
});
</script>
