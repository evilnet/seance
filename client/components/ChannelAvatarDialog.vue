<template>
	<div
		id="channel-avatar-overlay"
		v-backdrop="close"
		class="screen-overlay"
		:class="{opened: !!request}"
		:data-escape-close="request ? 'channel-avatar' : null"
	>
		<div
			v-if="request"
			id="channel-avatar-dialog"
			ref="card"
			role="dialog"
			aria-modal="true"
			:aria-label="t('avatar.channelHeading', {channel: request.channel})"
			tabindex="-1"
			@keydown.tab="onTab"
		>
			<button
				type="button"
				class="channel-avatar-close"
				:aria-label="t('avatar.cardClose')"
				:title="t('avatar.cardClose')"
				@click="close"
			></button>
			<AvatarSettings :uuid="request.network" :channel="request.channel" />
		</div>
	</div>
</template>

<style>
/* Visible at once as it opens (it fades out as the others do), so the
   dialog can take focus in the same tick. */
#channel-avatar-overlay.opened {
	transition: opacity 0.2s;
}

#channel-avatar-dialog {
	position: relative;
	background: var(--window-bg-color);
	color: var(--body-color);
	border-radius: 1rem;
	margin: 0.625rem;
	padding: 0.5rem 1.25rem 1rem;
	width: min(30rem, calc(100% - 1.25rem));
	max-height: calc(100% - 1.25rem);
	overflow-y: auto;
	box-shadow: 0 1rem 3rem rgb(0 0 0 / 55%);
	user-select: text;
}

#channel-avatar-dialog:focus {
	outline: 0;
}

/* The heading's line keeps clear of the close button. */
#channel-avatar-dialog .avatar-settings h3 {
	padding-inline-end: 2rem;
}

.channel-avatar-close {
	position: absolute;
	z-index: 1;
	inset-block-start: 0.625rem;
	inset-inline-end: 0.625rem;
	width: 2rem;
	height: 2rem;
	border: 0;
	border-radius: 50%;
	background: color-mix(in srgb, var(--body-color) 10%, transparent);
	color: var(--body-color);
	font-size: 1rem;
}

.channel-avatar-close::before {
	font-family: FontAwesome;
	content: "\f00d"; /* https://fontawesome.com/icons/times?style=solid */
}
</style>

<script lang="ts">
// A channel's avatar (draft/metadata-2 `avatar` on the channel): the same
// controls as our own in Settings → Avatar (Settings/AvatarSettings.vue with
// `channel`), in a dialog the channel's menu opens ("Channel avatar…",
// helpers/contextMenu.ts) for its half-ops and ops, and IRC operators.
import {defineComponent, nextTick, onMounted, onUnmounted, ref} from "vue";
import AvatarSettings from "./Settings/AvatarSettings.vue";
import eventbus from "../js/eventbus";
import {trapTab} from "../js/helpers/trapTab";
import {useI18n} from "../js/i18n";

/** What the dialog is opened with. */
export type ChannelAvatarRequest = {
	/** The network's uuid. */
	network: string;
	channel: string;
};

export default defineComponent({
	name: "ChannelAvatarDialog",
	components: {AvatarSettings},
	setup() {
		const {t} = useI18n();
		const request = ref<ChannelAvatarRequest | null>(null);
		const card = ref<HTMLElement>();

		// Focus: into the dialog as it opens, round inside it on Tab, and back
		// to what opened it as it closes, unless something has taken it since.
		let opener: HTMLElement | null = null;

		const onTab = (event: KeyboardEvent) => {
			if (card.value) {
				trapTab(event, card.value);
			}
		};

		const close = () => {
			if (!request.value) {
				return;
			}

			request.value = null;
			const back = opener;
			opener = null;
			void nextTick(() => {
				const now = document.activeElement;

				if ((!now || now === document.body) && back?.isConnected) {
					back.focus();
				}
			});
		};

		const open = (next: ChannelAvatarRequest) => {
			if (!request.value) {
				const active = document.activeElement;
				opener = active instanceof HTMLElement && active !== document.body ? active : null;
			}

			request.value = next;
			void nextTick(() => card.value?.focus());
		};

		const onEscape = (layer: string | null) => {
			if (layer === "channel-avatar") {
				close();
			}
		};

		onMounted(() => {
			eventbus.on("channel-avatar:open", open);
			eventbus.on("escapekey", onEscape);
		});

		onUnmounted(() => {
			eventbus.off("channel-avatar:open", open);
			eventbus.off("escapekey", onEscape);
		});

		return {t, request, card, onTab, close};
	},
});
</script>
