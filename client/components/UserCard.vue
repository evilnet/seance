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
			<div class="user-card-head">
				<button
					v-if="view.kind === 'image'"
					type="button"
					class="user-card-avatar-button"
					:aria-label="t('avatar.view')"
					:title="t('avatar.view')"
					@click="viewAvatar"
				>
					<Avatar :uuid="data.network.uuid" :nick="data.nick" :self="self" size="card" />
				</button>
				<Avatar
					v-else
					:uuid="data.network.uuid"
					:nick="data.nick"
					:self="self"
					size="card"
				/>
				<div class="user-card-who">
					<strong id="user-card-nick" :class="['user', 'user-card-nick', nickColor]">{{
						data.nick
					}}</strong>
					<span v-if="accountLine" class="user-card-detail">{{ accountLine }}</span>
					<span v-if="data.address" class="user-card-detail" dir="ltr">{{
						data.address
					}}</span>
				</div>
				<button
					type="button"
					class="user-card-close"
					:aria-label="t('avatar.cardClose')"
					:title="t('avatar.cardClose')"
					@click="close"
				></button>
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
				<button v-if="account" type="button" class="btn" @click="alwaysPerson">
					{{ t("avatar.alwaysPerson", {nick: data.nick}) }}
				</button>
				<button type="button" class="btn" @click="alwaysHost">
					{{ t("avatar.alwaysHost", {host: view.host}) }}
				</button>
			</div>
			<p v-else-if="view.kind === 'none' && avatarsOn && !self" class="user-card-note">
				{{ t("avatar.cardNone", {nick: data.nick}) }}
			</p>

			<div class="user-card-actions">
				<button
					v-if="view.kind === 'image'"
					type="button"
					class="btn user-card-view"
					@click="viewAvatar"
				>
					{{ t("avatar.view") }}
				</button>
				<button v-if="self" type="button" class="btn user-card-change" @click="change">
					{{ t("avatar.change") }}
				</button>
				<template v-else>
					<button type="button" class="btn user-card-message" @click="message">
						{{ t("menu.directMessages") }}
					</button>
					<button type="button" class="btn user-card-whois" @click="whois">
						{{ t("menu.whois") }}
					</button>
				</template>
			</div>
			<button
				v-if="personTrusted"
				type="button"
				class="user-card-untrust"
				@click="stopTrusting"
			>
				{{ t("avatar.stopPerson", {nick: data.nick}) }}
			</button>
		</div>
	</div>
</template>

<style>
#user-card {
	background: var(--window-bg-color);
	color: var(--body-color);
	border-radius: 0.875rem;
	padding: 1.25rem;
	margin: 0.625rem;
	width: min(24rem, calc(100% - 1.25rem));
	box-shadow: 0 0.625rem 2.5rem rgb(0 0 0 / 50%);
	display: flex;
	flex-direction: column;
	gap: 1rem;
	user-select: text;
}

#user-card:focus {
	outline: 0;
}

.user-card-head {
	display: flex;
	align-items: center;
	gap: 0.875rem;
}

.user-card-avatar-button {
	padding: 0;
	border: 0;
	background: none;
	cursor: zoom-in;
	border-radius: var(--avatar-radius, 50%);
	flex: none;
}

.user-card-who {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 0.1875rem;
}

.user-card-nick {
	font-size: 1rem;
	overflow-wrap: anywhere;
}

.user-card-detail {
	font-size: 0.8125rem;
	color: var(--body-color-muted);
	overflow-wrap: anywhere;
}

.user-card-close {
	align-self: flex-start;
	flex: none;
	width: 2rem;
	height: 2rem;
	border: 0;
	border-radius: 50%;
	background: none;
	color: var(--body-color-muted);
	font-size: 1rem;
}

.user-card-close::before {
	font-family: FontAwesome;
	content: "\f00d"; /* https://fontawesome.com/icons/times?style=solid */
}

.user-card-close:hover,
.user-card-close:focus-visible {
	color: var(--body-color);
}

.user-card-veiled {
	display: flex;
	flex-direction: column;
	gap: 0.375rem;
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

.user-card-veiled .btn {
	margin: 0;
	text-align: start;
	white-space: normal;
}

.user-card-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
}

.user-card-actions .btn {
	flex: 1 1 8rem;
	margin: 0;
}

.user-card-untrust {
	align-self: flex-start;
	padding: 0;
	border: 0;
	background: none;
	color: var(--body-color-muted);
	font-size: 0.8125rem;
	text-decoration: underline;
}
</style>

<script lang="ts">
// The user card: a person's avatar at a size you can see, who they are
// (account, address), the choices about loading their picture in plain
// sentences, and Message / Whois. Opened by a click on an avatar
// (Username.vue) or from the user menu (helpers/contextMenu.ts
// `openUserCard`); our own card offers "Change your avatar" (Settings →
// Avatar). Its avatar shows by the same rules as everywhere else
// (avatars/policy.ts): a veiled picture loads only when asked.
import {computed, defineComponent, inject, nextTick, onMounted, onUnmounted, ref} from "vue";
import {useRouter} from "vue-router";
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
import colorClass from "../js/helpers/colorClass";
import {queryUser, whoisUser} from "../js/helpers/contextMenu";
import {trustHost} from "../js/helpers/mediaTrust";
import {useI18n} from "../js/i18n";
import {KEEP} from "../js/i18n/core";
import {namesEqual} from "../js/irc/casemap";
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

		const self = computed(
			() =>
				!!data.value &&
				namesEqual(
					data.value.nick,
					data.value.network.nick,
					data.value.network.serverOptions.CASEMAPPING
				)
		);
		const subject = computed(() =>
			data.value
				? {uuid: data.value.network.uuid, nick: data.value.nick, self: self.value}
				: null
		);
		const view = computed(() =>
			subject.value ? viewFor(store, subject.value) : ({kind: "none"} as const)
		);
		const account = computed(() => (subject.value ? accountFor(subject.value) : null));
		const avatarsOn = computed(() => !!data.value && avatarsEnabled(data.value.network.uuid));
		const nickColor = computed(() =>
			data.value && store.state.settings.coloredNicks ? colorClass(data.value.nick) : ""
		);
		const accountLine = computed(() =>
			account.value ? t("avatar.cardSignedIn", {account: account.value}) : ""
		);
		const personTrusted = computed(
			() =>
				!!data.value &&
				!self.value &&
				view.value.kind === "image" &&
				!!account.value &&
				isPersonTrusted(data.value.network.uuid, account.value, view.value.host)
		);

		const close = () => {
			data.value = null;
		};

		const open = (next: CardData) => {
			data.value = next;
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

		const whois = () => {
			if (data.value) {
				whoisUser(data.value.network, data.value.channel, data.value.nick);
			}

			close();
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
		});

		onUnmounted(() => {
			eventbus.off("usercard:open", open);
			eventbus.off("escapekey", onEscape);
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
			accountLine,
			personTrusted,
			close,
			showOnce,
			alwaysPerson,
			alwaysHost,
			stopTrusting,
			viewAvatar,
			message,
			whois,
			change,
		};
	},
});
</script>
