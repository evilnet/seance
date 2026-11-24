<template>
	<span
		v-if="shown"
		:class="[
			'avatar',
			'avatar-' + size,
			view.kind === 'image' && ready ? 'avatar-image' : 'avatar-tile',
			{
				'avatar-veiled': view.kind === 'veiled',
				'avatar-pending': view.kind === 'image' && !ready,
			},
		]"
		:data-nick="nick"
		aria-hidden="true"
		><span
			v-if="view.kind !== 'image' || !ready"
			class="avatar-initial"
			:data-initial="initial"
		></span
		><img
			v-if="view.kind === 'image'"
			ref="img"
			:key="view.src"
			:src="view.src"
			alt=""
			referrerpolicy="no-referrer"
			decoding="async"
			draggable="false"
			@load="onLoad"
			@error="onError"
	/></span>
</template>

<script lang="ts">
// A user's avatar (draft/metadata-2 `avatar`), or their initial on a tile
// in the colour of the text around it (inside a nick: the nick colour): beside a nick in a line, in the user list, in the
// sidebar and the account settings. Whether the picture itself loads is
// avatars/policy.ts's call; a picture that fails, or is absurdly large,
// falls back to the tile for the rest of the page. Decorative: the nick is
// always next to it, so it is hidden from assistive technology.
import {computed, defineComponent, onMounted, PropType, ref, watch} from "vue";
import {avatarsEnabled, markFailed} from "../js/avatars/prefs";
import {viewFor} from "../js/avatars/view";
import {useStore} from "../js/store";

/** Wider or taller than this, the picture is not drawn (decoding it is the cost). */
const MAX_DIMENSION = 4096;

/**
 * Pictures that have loaded on this page: drawn at once wherever they show
 * up next (a new line, a scroll back). One the page has not drawn yet shows
 * the initial until it loads, then fades in, rather than popping in empty.
 */
const drawn = new Set<string>();

export default defineComponent({
	name: "Avatar",
	props: {
		uuid: {type: String, required: true},
		nick: {type: String, required: true},
		/** The line's account-tag, when shown beside a line. */
		account: {type: String, required: false},
		self: Boolean,
		size: {type: String as PropType<"line" | "list" | "card" | "large">, default: "line"},
	},
	setup(props) {
		const store = useStore();

		const shown = computed(() => avatarsEnabled(props.uuid) && props.nick !== "");

		const view = computed(() =>
			viewFor(store, {
				uuid: props.uuid,
				nick: props.nick,
				account: props.account,
				self: props.self,
			})
		);

		// The first letter, skipping the punctuation nicks often start with.
		const initial = computed(() => {
			const match = /[\p{L}\p{N}]/u.exec(props.nick);
			return match ? match[0] : props.nick.charAt(0);
		});

		const onError = () => {
			if (view.value.kind === "image") {
				markFailed(view.value.href);
			}
		};

		const img = ref<HTMLImageElement | null>(null);
		const srcOf = () => (view.value.kind === "image" ? view.value.src : "");
		const ready = ref(drawn.has(srcOf()));

		watch(srcOf, (src) => {
			ready.value = drawn.has(src);
		});

		const settle = (el: HTMLImageElement) => {
			if (view.value.kind !== "image") {
				return;
			}

			if (el.naturalWidth > MAX_DIMENSION || el.naturalHeight > MAX_DIMENSION) {
				markFailed(view.value.href);
				return;
			}

			drawn.add(view.value.src);
			ready.value = true;
		};

		const onLoad = (event: Event) => settle(event.target as HTMLImageElement);

		// Already in the browser's cache: no load event may come after mount.
		onMounted(() => {
			if (!ready.value && img.value?.complete && img.value.naturalWidth > 0) {
				settle(img.value);
			}
		});

		return {shown, view, initial, ready, img, onError, onLoad};
	},
});
</script>
