<template>
	<div
		id="image-viewer"
		ref="viewer"
		:class="{opened: link !== null}"
		@wheel="onMouseWheel"
		@touchstart="onTouchStart"
		@touchmove.passive.stop="onTouchMove"
		@touchend.stop="onTouchEnd"
		@touchcancel.stop="endGesture"
		@click="onClick"
	>
		<template v-if="link !== null">
			<button class="close-btn" :aria-label="closeAria"></button>

			<button
				v-if="previousImage"
				class="previous-image-btn"
				:aria-label="previousAria"
				@click.stop="previous"
			></button>
			<button
				v-if="nextImage"
				class="next-image-btn"
				:aria-label="nextAria"
				@click.stop="next"
			></button>

			<a class="open-btn" :href="link.link" target="_blank" rel="noopener"></a>

			<img
				ref="image"
				:src="link.thumb"
				referrerpolicy="no-referrer"
				alt=""
				:style="computeImageStyles"
				@load="onImageLoad"
				@mousedown="onImageMouseDown"
			/>
		</template>
	</div>
</template>

<script lang="ts">
import Mousetrap from "mousetrap";
import {computed, defineComponent, ref, watch} from "vue";
import eventbus from "../js/eventbus";
import {useI18n} from "../js/i18n";
import {useStore} from "../js/store";
import {isPreviewRevealed} from "../js/helpers/mediaTrust";
import {setImageViewerClose} from "../js/helpers/imageViewer";
import {ClientChan, ClientLinkPreview} from "../js/types";
import {SharedMsg} from "../../shared/types/msg";

// A tap: one finger, moved less than this, lifted within this.
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 400;

export default defineComponent({
	name: "ImageViewer",
	setup() {
		const store = useStore();
		const {t} = useI18n();
		const closeAria = computed(() => t("image.close"));
		const previousAria = computed(() => t("image.previous"));
		const nextAria = computed(() => t("image.next"));
		const viewer = ref<HTMLDivElement>();
		const image = ref<HTMLImageElement>();

		const link = ref<ClientLinkPreview | null>(null);
		const previousImage = ref<ClientLinkPreview | null>();
		const nextImage = ref<ClientLinkPreview | null>();
		const channel = ref<ClientChan | null>();

		const position = ref<{
			x: number;
			y: number;
		}>({
			x: 0,
			y: 0,
		});

		const transform = ref<{
			scale: number;
			x: number;
			y: number;
		}>({
			scale: 1,
			x: 0,
			y: 0,
		});

		// The scale prepareImage() fitted the image to: a tap closes only there.
		let fitScale = 1;

		const computeImageStyles = computed(() => {
			// Sub pixels may cause the image to blur in certain browsers
			// round it down to prevent that
			const transformX = Math.floor(transform.value.x);
			const transformY = Math.floor(transform.value.y);

			return {
				left: `${position.value.x}px`,
				top: `${position.value.y}px`,
				transform: `translate3d(${transformX}px, ${transformY}px, 0) scale3d(${transform.value.scale}, ${transform.value.scale}, 1)`,
			};
		});

		const closeViewer = () => {
			if (link.value === null) {
				return;
			}

			channel.value = null;
			previousImage.value = null;
			nextImage.value = null;
			link.value = null;
		};

		const setPrevNextImages = () => {
			if (!channel.value || !link.value) {
				return null;
			}

			// Only images the reader has revealed: stepping through the
			// viewer must not load media they chose not to see — nor a
			// deleted message's, which sit hidden behind its placeholder.
			const autoReveal = store.state.settings.mediaReveal === "always";
			const links = channel.value.messages
				.filter((msg: SharedMsg) => !msg.redacted)
				.map((msg: SharedMsg) => msg.previews)
				.flat()
				.filter(
					(preview): preview is ClientLinkPreview =>
						!!preview && !!preview.thumb && isPreviewRevealed(preview, autoReveal)
				);

			const currentIndex = links.indexOf(link.value);

			previousImage.value = links[currentIndex - 1] || null;
			nextImage.value = links[currentIndex + 1] || null;
		};

		const previous = () => {
			if (previousImage.value) {
				link.value = previousImage.value;
			}
		};

		const next = () => {
			if (nextImage.value) {
				link.value = nextImage.value;
			}
		};

		const prepareImage = () => {
			const viewerEl = viewer.value;
			const imageEl = image.value;

			if (!viewerEl || !imageEl) {
				return;
			}

			const width = viewerEl.offsetWidth;
			const height = viewerEl.offsetHeight;
			const scale = Math.min(1, width / imageEl.width, height / imageEl.height);

			position.value.x = Math.floor(-image.value!.naturalWidth / 2);
			position.value.y = Math.floor(-image.value!.naturalHeight / 2);
			transform.value.scale = Math.max(scale, 0.1);
			fitScale = transform.value.scale;
			transform.value.x = width / 2;
			transform.value.y = height / 2;
		};

		const onImageLoad = () => {
			prepareImage();
		};

		const calculateZoomShift = (newScale: number, x: number, y: number, oldScale: number) => {
			if (!image.value || !viewer.value) {
				return;
			}

			const imageWidth = image.value.width;
			const centerX = viewer.value.offsetWidth / 2;
			const centerY = viewer.value.offsetHeight / 2;

			return {
				x:
					centerX -
					((centerX - (y - (imageWidth * x) / 2)) / x) * newScale +
					(imageWidth * newScale) / 2,
				y:
					centerY -
					((centerY - (oldScale - (imageWidth * x) / 2)) / x) * newScale +
					(imageWidth * newScale) / 2,
			};
		};

		const correctPosition = () => {
			const imageEl = image.value;
			const viewerEl = viewer.value;

			if (!imageEl || !viewerEl) {
				return;
			}

			const widthScaled = imageEl.width * transform.value.scale;
			const heightScaled = imageEl.height * transform.value.scale;
			const containerWidth = viewerEl.offsetWidth;
			const containerHeight = viewerEl.offsetHeight;

			if (widthScaled < containerWidth) {
				transform.value.x = containerWidth / 2;
			} else if (transform.value.x - widthScaled / 2 > 0) {
				transform.value.x = widthScaled / 2;
			} else if (transform.value.x + widthScaled / 2 < containerWidth) {
				transform.value.x = containerWidth - widthScaled / 2;
			}

			if (heightScaled < containerHeight) {
				transform.value.y = containerHeight / 2;
			} else if (transform.value.y - heightScaled / 2 > 0) {
				transform.value.y = heightScaled / 2;
			} else if (transform.value.y + heightScaled / 2 < containerHeight) {
				transform.value.y = containerHeight - heightScaled / 2;
			}
		};

		// Reduce multiple touch points into a single x/y/scale
		const reduceTouches = (touches: TouchList) => {
			let totalX = 0;
			let totalY = 0;
			let totalScale = 0;

			for (let i = 0; i < touches.length; i++) {
				const x = touches[i].clientX;
				const y = touches[i].clientY;

				totalX += x;
				totalY += y;

				for (let i2 = 0; i2 < touches.length; i2++) {
					if (i !== i2) {
						const x2 = touches[i2].clientX;
						const y2 = touches[i2].clientY;
						totalScale += Math.sqrt((x - x2) * (x - x2) + (y - y2) * (y - y2));
					}
				}
			}

			if (totalScale === 0) {
				totalScale = 1;
			}

			return {
				x: totalX / touches.length,
				y: totalY / touches.length,
				scale: totalScale / touches.length,
			};
		};

		// Touch: the viewer owns every touch on it — one finger pans, two
		// pinch, wherever they land (the fitted image on a phone is a small
		// part of the screen, and a pinch starting beside it used to do
		// nothing and then close the viewer). Only a tap closes: one finger
		// that barely moved, anywhere on an image at its fitted size, and on
		// the backdrop beside a zoomed one (a tap on the zoomed image itself
		// does nothing). The touchend is cancelled, so the compatibility
		// mouse events (whose mouseup closes on a click) and the click never
		// follow; a touch on a button starts no gesture and keeps its click.
		// No touch leaves the viewer: the sidebar's swipe and the two-finger
		// channel swipe listen on <body>.
		type Gesture = {
			ref: {x: number; y: number; scale: number};
			base: {x: number; y: number; scale: number};
			origin: {x: number; y: number};
			fingers: number;
			multi: boolean;
			moved: number;
			startedAt: number;
		};
		let gesture: Gesture | null = null;

		// The fingers changed: measure from where they and the image are now.
		const rebase = (g: Gesture, touches: TouchList) => {
			g.ref = reduceTouches(touches);
			g.base = {...transform.value};
			g.fingers = touches.length;
		};

		const onTouchMove = (e: TouchEvent) => {
			if (!gesture) {
				return;
			}

			if (e.touches.length !== gesture.fingers) {
				rebase(gesture, e.touches);
			}

			const touch = reduceTouches(e.touches);

			if (!gesture.multi) {
				gesture.moved = Math.max(
					gesture.moved,
					Math.hypot(touch.x - gesture.origin.x, touch.y - gesture.origin.y)
				);
			}

			const deltaX = touch.x - gesture.ref.x;
			const deltaY = touch.y - gesture.ref.y;
			const deltaScale = touch.scale / gesture.ref.scale;
			const newScale = Math.min(3, Math.max(0.1, gesture.base.scale * deltaScale));
			const fixedPosition = calculateZoomShift(
				newScale,
				gesture.base.scale,
				gesture.base.x,
				gesture.base.y
			);

			if (!fixedPosition) {
				return;
			}

			transform.value.x = fixedPosition.x + deltaX;
			transform.value.y = fixedPosition.y + deltaY;
			transform.value.scale = newScale;
			correctPosition();
		};

		const endGesture = () => {
			gesture = null;
			correctPosition();
		};

		// Whether a point is off the image as it is drawn now, zoom and pan
		// included: the backdrop around it.
		const outsideImage = (point: {x: number; y: number}) => {
			const rect = image.value?.getBoundingClientRect();

			return (
				!!rect &&
				(point.x < rect.left ||
					point.x > rect.right ||
					point.y < rect.top ||
					point.y > rect.bottom)
			);
		};

		const onTouchEnd = (e: TouchEvent) => {
			if (!gesture) {
				return;
			}

			e.preventDefault();

			if (e.touches.length > 0) {
				// A finger of a pinch lifted: the rest pan on from here.
				rebase(gesture, e.touches);
				return;
			}

			const tapped =
				!gesture.multi &&
				gesture.moved < TAP_SLOP_PX &&
				Date.now() - gesture.startedAt < TAP_MAX_MS &&
				(transform.value.scale <= fitScale * 1.05 || outsideImage(gesture.origin));

			endGesture();

			if (tapped) {
				closeViewer();
			}
		};

		const onTouchStart = (e: TouchEvent) => {
			// prevent sidebar touchstart event, we don't want to interact with sidebar while in image viewer
			e.stopImmediatePropagation();

			if (gesture) {
				// Another finger joins, wherever it lands: a pinch, never a tap.
				gesture.multi = true;
				rebase(gesture, e.touches);
				return;
			}

			// The buttons and the open link keep their own taps.
			if ((e.target as Element | null)?.closest?.("button, a")) {
				return;
			}

			const first = reduceTouches(e.touches);
			gesture = {
				ref: first,
				base: {...transform.value},
				origin: {x: first.x, y: first.y},
				fingers: e.touches.length,
				multi: e.touches.length > 1,
				moved: 0,
				startedAt: Date.now(),
			};
		};

		// A mouse pan just ended; its click is not a close.
		let panEnded = false;

		// Image mouse manipulation:
		// 1. Mouse wheel scrolling will zoom in and out
		// 2. If image is zoomed in, simply dragging it will move it around
		const onImageMouseDown = (e: MouseEvent) => {
			// todo: ignore if in touch event currently?

			// only left mouse
			// TODO: e.buttons?
			if (e.which !== 1) {
				return;
			}

			e.stopPropagation();
			e.preventDefault();

			const viewerEl = viewer.value;
			const imageEl = image.value;

			if (!viewerEl || !imageEl) {
				return;
			}

			const startX = e.clientX;
			const startY = e.clientY;
			const startTransformX = transform.value.x;
			const startTransformY = transform.value.y;
			const widthScaled = imageEl.width * transform.value.scale;
			const heightScaled = imageEl.height * transform.value.scale;
			const containerWidth = viewerEl.offsetWidth;
			const containerHeight = viewerEl.offsetHeight;
			const centerX = transform.value.x - widthScaled / 2;
			const centerY = transform.value.y - heightScaled / 2;
			let movedDistance = 0;

			const mouseMove = (moveEvent: MouseEvent) => {
				moveEvent.stopPropagation();
				moveEvent.preventDefault();

				const newX = moveEvent.clientX - startX;
				const newY = moveEvent.clientY - startY;

				movedDistance = Math.max(movedDistance, Math.abs(newX), Math.abs(newY));

				if (centerX < 0 || widthScaled + centerX > containerWidth) {
					transform.value.x = startTransformX + newX;
				}

				if (centerY < 0 || heightScaled + centerY > containerHeight) {
					transform.value.y = startTransformY + newY;
				}

				correctPosition();
			};

			// On the window, not the image: a pan that leaves the image is still
			// the pan, and its release is not a click on the backdrop.
			const mouseUp = (upEvent: MouseEvent) => {
				correctPosition();
				window.removeEventListener("mousemove", mouseMove);
				window.removeEventListener("mouseup", mouseUp);

				if (movedDistance >= 2) {
					// The click that follows lands on the backdrop when the
					// release did: it ends the pan, it does not close.
					panEnded = true;
					setTimeout(() => (panEnded = false), 0);
					return;
				}

				if (upEvent.button === 0 && upEvent.target === image.value) {
					closeViewer();
				}
			};

			window.addEventListener("mousemove", mouseMove);
			window.addEventListener("mouseup", mouseUp);
		};

		// If image is zoomed in, holding ctrl while scrolling will move the image up and down
		const onMouseWheel = (e: WheelEvent) => {
			// if image viewer is closing (css animation), you can still trigger mousewheel
			// TODO: Figure out a better fix for this
			if (link.value === null) {
				return;
			}

			e.preventDefault(); // TODO: Can this be passive?

			if (e.ctrlKey) {
				transform.value.y += e.deltaY;
			} else {
				const delta = e.deltaY > 0 ? 0.1 : -0.1;
				const newScale = Math.min(3, Math.max(0.1, transform.value.scale + delta));
				const fixedPosition = calculateZoomShift(
					newScale,
					transform.value.scale,
					transform.value.x,
					transform.value.y
				);

				if (!fixedPosition) {
					return;
				}

				transform.value.scale = newScale;
				transform.value.x = fixedPosition.x;
				transform.value.y = fixedPosition.y;
			}

			correctPosition();
		};

		const onClick = (e: Event) => {
			// If click triggers on the image, ignore it
			if (e.target === image.value || panEnded) {
				return;
			}

			closeViewer();
		};

		watch(link, (newLink, oldLink) => {
			if (newLink === null) {
				// Closed under a finger (Android's back, Escape): the <img> it
				// rested on is gone, so its touchend never reaches the viewer.
				endGesture();
				setImageViewerClose(null);
				eventbus.off("escapekey", closeViewer);
				eventbus.off("resize", correctPosition);
				Mousetrap.unbind("left");
				Mousetrap.unbind("right");
				return;
			}

			setPrevNextImages();

			if (!oldLink) {
				setImageViewerClose(closeViewer);
				eventbus.on("escapekey", closeViewer);
				eventbus.on("resize", correctPosition);
				Mousetrap.bind("left", previous);
				Mousetrap.bind("right", next);
			}
		});

		return {
			t,
			closeAria,
			previousAria,
			nextAria,
			link,
			channel,
			image,
			transform,
			closeViewer,
			next,
			previous,
			onImageLoad,
			onImageMouseDown,
			onMouseWheel,
			onClick,
			onTouchStart,
			onTouchMove,
			onTouchEnd,
			endGesture,
			previousImage,
			nextImage,
			computeImageStyles,
			viewer,
		};
	},
});
</script>
