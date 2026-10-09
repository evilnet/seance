<template>
	<div v-if="link.shown" ref="container" class="preview" dir="ltr">
		<div
			ref="content"
			:class="[
				'toggle-content',
				'toggle-type-' + link.type,
				{'media-revealed': revealed && link.sourceLoaded},
			]"
		>
			<!-- The veil: what stands in for the media until the reader asks
			for it. It has a fixed height so scrollback does not jump, and it
			doubles as the loading and error state once revealed. -->
			<div
				v-if="!revealed || !link.sourceLoaded"
				:class="['media-veil', {loading: revealed, failed}]"
			>
				<button
					type="button"
					class="media-veil-main"
					:aria-label="veilLabel"
					:disabled="revealed"
					@click="reveal"
				>
					<span class="media-veil-icon" :data-kind="link.type" aria-hidden="true"></span>
					<span class="media-veil-text">
						<span class="media-veil-title">{{ veilTitle }}</span>
						<span class="media-veil-hint">{{ veilHint }}</span>
					</span>
				</button>
				<button
					v-if="hasScopes"
					type="button"
					class="media-veil-trust"
					:title="trustTitle"
					aria-haspopup="menu"
					@click="openTrustMenu"
				>
					{{ trustedKinds.length > 0 ? "Always shown" : "Always show" }}
					<span class="media-veil-caret" aria-hidden="true"></span>
				</button>
			</div>
			<!-- Hover is the frame's, not the image's: the preview's tools float
			over the image, and pointing at them must not stop it. -->
			<div
				v-if="revealed"
				v-show="link.sourceLoaded"
				class="media-frame"
				@mouseenter="hovered = true"
				@mouseleave="hovered = false"
			>
				<template v-if="link.type === 'image'">
					<a
						:href="link.link"
						class="toggle-thumbnail"
						target="_blank"
						rel="noopener noreferrer"
						@click="onThumbnailClick"
					>
						<!-- An animation plays once, then this still of it stands in
						until the pointer is over it (or it is the newest message):
						see `shouldPlay`. Drawing a cross-origin image taints the
						canvas, which only forbids reading it back; it shows. -->
						<canvas
							v-show="frozen"
							ref="still"
							class="media-still"
							aria-hidden="true"
						/>
						<!-- No loading="lazy" here: v-show hides the element until it
						has loaded, and a lazy image with no box never becomes
						eligible to load, so @load would never fire. -->
						<img
							v-show="link.sourceLoaded && !frozen"
							ref="image"
							:src="link.thumb"
							decoding="async"
							referrerpolicy="no-referrer"
							alt=""
							@load="onPreviewReady"
							@error="onPreviewError"
							@abort="onPreviewError"
						/>
					</a>
				</template>
				<!-- Shown on `loadedmetadata`, not `canplay`: iOS Safari does not
				fire `canplay` for `preload="metadata"` until playback starts, so a
				video gated on it never appeared there.
				Media elements with <source> children fire `error` on the
				last <source>, not on themselves, hence the listener on both. -->
				<template v-else-if="link.type === 'video'">
					<video
						v-show="link.sourceLoaded"
						preload="metadata"
						controls
						playsinline
						referrerpolicy="no-referrer"
						@loadedmetadata="onPreviewReady"
						@error="onPreviewError"
					>
						<source :src="link.media" :type="link.mediaType" @error="onPreviewError" />
					</video>
				</template>
				<template v-else-if="link.type === 'audio'">
					<audio
						v-show="link.sourceLoaded"
						controls
						preload="metadata"
						referrerpolicy="no-referrer"
						@loadedmetadata="onPreviewReady"
						@error="onPreviewError"
					>
						<source :src="link.media" :type="link.mediaType" @error="onPreviewError" />
					</audio>
				</template>
				<div class="media-tools" role="group" aria-label="Preview actions">
					<button
						type="button"
						class="media-tool media-tool-hide"
						title="Hide this preview"
						aria-label="Hide this preview"
						@click="hide"
					></button>
					<button
						v-if="hasScopes"
						type="button"
						:class="[
							'media-tool',
							'media-tool-trust',
							{active: trustedKinds.length > 0},
						]"
						:title="trustTitle"
						:aria-label="trustTitle"
						aria-haspopup="menu"
						@click="openTrustMenu"
					></button>
					<a
						class="media-tool media-tool-open"
						:href="link.link"
						target="_blank"
						rel="noopener noreferrer"
						title="Open in a new tab"
						aria-label="Open in a new tab"
					></a>
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, inject, nextTick, onUnmounted, PropType, ref, watch} from "vue";
import {onBeforeRouteUpdate} from "vue-router";
import {useStore} from "../js/store";
import eventbus from "../js/eventbus";
import type {ClientChan, ClientLinkPreview} from "../js/types";
import {
	isPreviewRevealed,
	mediaFileName,
	mediaHost,
	trustedScopesOf,
} from "../js/helpers/mediaTrust";
import {mediaScopesOf, mediaTrustMenu} from "../js/helpers/mediaTrustMenu";
import {animationInfo, isAnimatedImageBytes} from "../js/helpers/animatedImage";
import {onSystemAccessibility, systemAccessibility} from "../js/helpers/systemAccessibility";
import {imageViewerKey} from "./App.vue";

/** Extensions an image preview may animate in: GIF and WebP usually do, PNG (APNG) and AVIF rarely. */
const ANIMATABLE = /\.(gif|webp|png|apng|avif)$/i;
const USUALLY_ANIMATED = /\.(gif|webp)$/i;
/** One play when the file cannot be read (its host sends no CORS headers). */
const FALLBACK_PLAY_MS = 6000;
/** Bounds on a measured play: a 0-frame oddity, a 10-minute GIF. */
const MIN_PLAY_MS = 1000;
const MAX_PLAY_MS = 60000;
/** Past this the file is not read again for its timing: the fallback applies. */
const MAX_PROBE_BYTES = 16 * 1024 * 1024;

function pathOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return url.split(/[?#]/)[0];
	}
}

/**
 * How long one play of the animation at `url` lasts: read from the file
 * (`animationInfo`) when its host allows a CORS read — mostly a cache hit,
 * the `<img>` has just fetched it — `null` when the file is a still, and
 * undefined when it could not be read.
 */
async function probePlay(url: string): Promise<number | null | undefined> {
	try {
		const response = await fetch(url, {
			mode: "cors",
			credentials: "omit",
			referrerPolicy: "no-referrer",
			cache: "force-cache",
		});
		const length = Number(response.headers.get("content-length") ?? 0);

		if (!response.ok || length > MAX_PROBE_BYTES) {
			return undefined;
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		const info = animationInfo(bytes);

		if (info) {
			return info.frames > 1 ? info.durationMs : null;
		}

		// An AVIF sequence animates, but its timing is not read here.
		return isAnimatedImageBytes(bytes) ? FALLBACK_PLAY_MS : null;
	} catch {
		return undefined;
	}
}

// Renders one preview built by `client/js/helpers/mediaPreview.ts`. Only
// direct media (image/video/audio) is supported: there is no server to fetch
// page metadata, so the old "link" (title/description/favicon), "loading" and
// "error" preview types no longer exist. The CSS classes (`preview`,
// `toggle-content`, `toggle-type-*`, `toggle-thumbnail`) are unchanged so
// themes keep working.
//
// Media is click-to-reveal by default (`mediaReveal` setting): nothing is
// fetched from the media host until the reader chooses to see it, once for
// this preview or always for its host, its channel or its sender's account
// (`helpers/mediaTrust.ts`, menu in `helpers/mediaTrustMenu.ts`). Revealed
// media carries a small toolbar to hide it again or change that trust.
const kindLabel: Record<string, string> = {
	image: "image",
	video: "video",
	audio: "audio",
};

export default defineComponent({
	name: "LinkPreview",
	props: {
		link: {
			type: Object as PropType<ClientLinkPreview>,
			required: true,
		},
		keepScrollPosition: {
			type: Function as PropType<() => void>,
			required: true,
		},
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const store = useStore();
		const imageViewer = inject(imageViewerKey);

		onBeforeRouteUpdate((to, from, next) => {
			// cancel the navigation if the user is trying to close the image viewer
			if (imageViewer?.value?.link) {
				imageViewer.value.closeViewer();
				return next(false);
			}

			next();
		});

		const content = ref<HTMLDivElement | null>(null);
		const container = ref<HTMLDivElement | null>(null);
		const failed = ref(false);

		const host = computed(() => mediaHost(props.link.link));
		const fileName = computed(() => mediaFileName(props.link.link));
		const hasScopes = computed(() => mediaScopesOf(props.link).length > 0);
		const trustedKinds = computed(() => trustedScopesOf(props.link));
		const revealed = computed(() =>
			isPreviewRevealed(props.link, store.state.settings.mediaReveal === "always")
		);

		const kind = computed(() => kindLabel[props.link.type] ?? "media");
		const veilTitle = computed(() => {
			if (failed.value) {
				return `Couldn't load this ${kind.value}`;
			}

			if (revealed.value) {
				return `Loading ${kind.value}…`;
			}

			const noun = kind.value.charAt(0).toUpperCase() + kind.value.slice(1);
			return host.value ? `${noun} from ${host.value}` : noun;
		});
		const veilHint = computed(() => {
			if (failed.value) {
				return "Click to try again";
			}

			if (revealed.value) {
				return fileName.value;
			}

			return fileName.value ? `${fileName.value} · Click to show` : "Click to show";
		});
		const veilLabel = computed(() =>
			host.value ? `Show ${kind.value} from ${host.value}` : `Show ${kind.value}`
		);
		const trustTitle = computed(() => {
			const shown = mediaScopesOf(props.link)
				.filter((s) => trustedKinds.value.includes(s.kind))
				.map((s) => s.label);

			return shown.length > 0
				? `Always shown ${shown.join(", ")} — change`
				: "Always show media from this site, this person or in this channel";
		});

		// ---- An animation plays once, then holds still ----------------
		// It plays on while the pointer is over it, and keeps looping while
		// its message is the newest in the conversation; the image viewer
		// always animates. With reduced motion asked for, it only ever
		// plays under the pointer.
		const image = ref<HTMLImageElement | null>(null);
		const still = ref<HTMLCanvasElement | null>(null);
		const hovered = ref(false);
		/** The file animates (or is presumed to): it has a still to hold. */
		const animates = ref(false);
		const playedOnce = ref(false);
		const frozen = ref(false);
		let playTimer: ReturnType<typeof setTimeout> | null = null;
		// The system's Reduce Motion, live (helpers/systemAccessibility.ts).
		const reducedMotion = ref(systemAccessibility().reduceMotion);
		const stopFollowingMotion = onSystemAccessibility((state) => {
			reducedMotion.value = state.reduceMotion;
		});

		const isNewest = computed(() => {
			const last = props.channel.messages[props.channel.messages.length - 1];
			return last?.previews?.some((p) => p.link === props.link.link) ?? false;
		});
		const shouldPlay = computed(
			() =>
				!animates.value ||
				hovered.value ||
				(!reducedMotion.value && (isNewest.value || !playedOnce.value))
		);

		/** Hold the frame on screen now, in the box the image has. */
		const freeze = () => {
			const img = image.value;
			const canvas = still.value;

			if (!img || !canvas || frozen.value || !props.link.sourceLoaded) {
				return;
			}

			const box = img.getBoundingClientRect();

			if (box.width === 0 || box.height === 0) {
				return;
			}

			const scale = window.devicePixelRatio || 1;
			canvas.width = Math.round(box.width * scale);
			canvas.height = Math.round(box.height * scale);
			// Height follows from the width attributes' ratio (style.css).
			canvas.style.width = `${box.width}px`;
			canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
			frozen.value = true;
		};

		watch(shouldPlay, (play) => {
			if (play) {
				frozen.value = false;
			} else {
				freeze();
			}
		});

		const clearPlay = () => {
			if (playTimer !== null) {
				clearTimeout(playTimer);
				playTimer = null;
			}
		};

		/** The image is on screen: learn whether it animates and for how long one play is. */
		const watchPlayback = async () => {
			clearPlay();
			animates.value = false;
			playedOnce.value = false;
			frozen.value = false;

			const path = pathOf(props.link.thumb);

			if (props.link.type !== "image" || !ANIMATABLE.test(path)) {
				return;
			}

			// Reduced motion: hold the first frame from the start, not from
			// whenever the file has been read.
			if (reducedMotion.value && USUALLY_ANIMATED.test(path)) {
				animates.value = true;
				await nextTick();
				freeze();
			}

			const started = Date.now();
			const probed = await probePlay(props.link.thumb);

			if (probed === null) {
				animates.value = false; // a still after all
				return;
			}

			const playMs =
				probed === undefined && USUALLY_ANIMATED.test(path) ? FALLBACK_PLAY_MS : probed;

			if (!props.link.sourceLoaded || playMs === null || playMs === undefined) {
				animates.value = false;
				return;
			}

			animates.value = true;
			const left =
				Math.min(MAX_PLAY_MS, Math.max(MIN_PLAY_MS, playMs)) - (Date.now() - started);
			playTimer = setTimeout(() => {
				playTimer = null;
				playedOnce.value = true;
			}, Math.max(0, left));

			// Reduced motion: hold the first frame from the start.
			if (!shouldPlay.value) {
				await nextTick();
				freeze();
			}
		};

		const onPreviewReady = () => {
			failed.value = false;
			props.link.sourceLoaded = true;

			props.keepScrollPosition();

			if (props.link.type === "image") {
				void watchPlayback();
			}
		};

		const onPreviewError = () => {
			// The browser could not load or decode the media: fall back to the
			// veil in its error state (the link itself is still in the text)
			// and stop a trusted scope from retrying on every re-render.
			props.link.sourceLoaded = false;
			props.link.revealed = false;
			failed.value = true;
		};

		const reveal = () => {
			failed.value = false;
			props.link.revealed = true;
		};

		const hide = () => {
			clearPlay();
			animates.value = false;
			frozen.value = false;
			props.link.revealed = false;
			props.link.sourceLoaded = false;
			props.keepScrollPosition();
		};

		const onTrustChange = (_kind: string, trusted: boolean) => {
			if (trusted) {
				// Trusting from a hidden preview means "and show this one too".
				if (props.link.revealed === false) {
					failed.value = false;
					props.link.revealed = undefined;
				}
			} else if (revealed.value && props.link.revealed !== true) {
				// Whatever is on screen stays on screen: the reader already saw
				// it, and this is about what happens next time.
				props.link.revealed = true;
			}
		};

		const openTrustMenu = (event: MouseEvent) => {
			const items = mediaTrustMenu(props.link, onTrustChange);

			if (items.length === 0) {
				return;
			}

			// The context menu positions itself at the pointer; a keyboard
			// activation has no pointer, so anchor it under the button.
			let at = event;

			if (event.clientX === 0 && event.clientY === 0) {
				const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
				at = new MouseEvent("click", {
					clientX: rect.left,
					clientY: rect.bottom,
					bubbles: false,
				});
			}

			eventbus.emit("contextmenu:items", {event: at, items});
		};

		const onThumbnailClick = (e: MouseEvent) => {
			e.preventDefault();

			if (!imageViewer?.value) {
				return;
			}

			imageViewer.value.channel = props.channel;
			imageViewer.value.link = props.link;
		};

		const updateShownState = () => {
			// User has manually toggled the preview, do not apply default
			if (props.link.shown !== null && props.link.shown !== undefined) {
				return;
			}

			props.link.shown = store.state.settings.media;
		};

		updateShownState();

		watch(
			() => props.link.type,
			() => {
				updateShownState();
			}
		);

		onUnmounted(() => {
			stopFollowingMotion();
			clearPlay();
			// Let this preview go through load/loadedmetadata events again,
			// Otherwise the browser can cause a resize on video elements
			props.link.sourceLoaded = false;
		});

		return {
			content,
			container,
			failed,
			host,
			hasScopes,
			trustedKinds,
			revealed,
			veilTitle,
			veilHint,
			veilLabel,
			trustTitle,
			onPreviewReady,
			onPreviewError,
			image,
			still,
			hovered,
			frozen,
			reveal,
			hide,
			openTrustMenu,
			onThumbnailClick,
		};
	},
});
</script>
