<template>
	<div
		id="image-viewer"
		ref="viewer"
		:class="{opened: link !== null, settling, 'controls-hidden': controlsHidden}"
		:style="{'--viewer-dim': dim}"
		:data-escape-close="link !== null ? 'image-viewer' : null"
		@wheel="onMouseWheel"
		@gesturestart="onGestureStart"
		@gesturechange="onGestureChange"
		@gestureend.prevent
		@touchstart="onTouchStart"
		@touchmove.passive.stop="onTouchMove"
		@touchend.stop="onTouchEnd"
		@touchcancel.stop="onTouchCancel"
		@click="onClick"
		@contextmenu="onContextMenu"
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
				alt=""
				:class="{loading: !loaded}"
				:style="computeImageStyles"
				@load="onImageLoad"
				@mousedown="onImageMouseDown"
				@dblclick="onImageDoubleClick"
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
import {isShell} from "../js/helpers/shell";
import {openExternal} from "../js/helpers/openLink";
import {writeClipboard} from "../js/clipboard";
import type {ContextMenuItem} from "../js/helpers/contextMenu";
import {
	type Axis,
	type Box,
	type Fingers,
	type Point,
	type Tap,
	type View,
	clampCentre,
	clampScale,
	doubleTapScale,
	isDoubleTap,
	isFitted,
	lockAxis,
	LONG_PRESS_MS,
	MAX_SCALE,
	DOUBLE_TAP_MS,
	pinch,
	rubber,
	softCentre,
	softScale,
	swipeOutcome,
	TAP_MAX_MS,
	TAP_SLOP_PX,
	ZOOM_STEP,
	zoomAbout,
} from "../js/helpers/viewerGesture";
import {ClientChan, ClientLinkPreview} from "../js/types";
import {SharedMsg} from "../../shared/types/msg";

// How long the picture takes to come to rest, fly out or spring back
// (style.css, #image-viewer.settling).
const SETTLE_MS = 200;

// How far up or down a swipe goes before the backdrop is gone.
const DIM_FRACTION = 0.6;

// The finger's speed is measured over this much of its last movement.
const VELOCITY_WINDOW_MS = 100;

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

		// The picture's top left before its transform: half its own size up
		// and left of the point the transform moves it to.
		const position = ref<Point>({x: 0, y: 0});

		// The picture's centre in the viewer, and its scale.
		const transform = ref<View>({scale: 1, x: 0, y: 0});

		// The picture moves under a transition (coming to rest, flying out):
		// style.css animates the transform while this is set.
		const settling = ref(false);
		// The backdrop's strength, 0–1: a swipe up or down fades it.
		const dim = ref(1);
		// A tap on the picture hides the buttons, the next shows them.
		const controlsHidden = ref(false);
		// The current picture has loaded and been fitted; until then it is
		// not shown (a swap would show the new picture at the old one's zoom).
		const loaded = ref(false);

		// The scale prepareImage() fitted the picture to: the least it zooms out to.
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

		const reduceMotion = () => document.documentElement.hasAttribute("data-reduce-motion");

		let settleTimer: ReturnType<typeof setTimeout> | undefined;

		// Move the picture to `view` under the transition, then run `then`.
		// With reduced motion it jumps there and `then` runs at once.
		const settle = (view: Partial<View>, then?: () => void) => {
			clearTimeout(settleTimer);
			Object.assign(transform.value, view);

			if (reduceMotion()) {
				settling.value = false;
				then?.();
				return;
			}

			settling.value = true;
			settleTimer = setTimeout(() => {
				settling.value = false;
				then?.();
			}, SETTLE_MS);
		};

		const stopSettling = () => {
			clearTimeout(settleTimer);
			settling.value = false;
		};

		let tapTimer: ReturnType<typeof setTimeout> | undefined;
		// The last tap on the picture, while a second could still make it a double tap.
		let lastTap: Tap | null = null;

		const closeViewer = () => {
			if (link.value === null) {
				return;
			}

			clearTimeout(tapTimer);
			lastTap = null;
			stopSettling();
			// A menu opened on the picture goes with it.
			eventbus.emit("contextmenu:cancel");
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
			const links = (channel.value.past?.rows ?? channel.value.messages)
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

		// Right to left, the previous picture is on the right (its button sits
		// at the inline start, style.css): the arrow keys and the swipes follow.
		const isRtl = () => !!viewer.value && getComputedStyle(viewer.value).direction === "rtl";

		// The viewer's content box, in its own coordinates: the picture is
		// fitted and kept inside it. A platform that keeps the picture clear of
		// the window's own controls (the Mac app's traffic lights, style.css)
		// pads the viewer; elsewhere it is the whole viewer.
		const contentBox = (viewerEl: HTMLElement): Box => {
			const style = getComputedStyle(viewerEl);
			const left = parseFloat(style.paddingLeft) || 0;
			const top = parseFloat(style.paddingTop) || 0;

			return {
				left,
				top,
				width: viewerEl.clientWidth - left - (parseFloat(style.paddingRight) || 0),
				height: viewerEl.clientHeight - top - (parseFloat(style.paddingBottom) || 0),
			};
		};

		// The picture's laid-out size, before its scale.
		const imageSize = () => ({
			width: image.value?.width ?? 0,
			height: image.value?.height ?? 0,
		});

		// A point on screen in the viewer's coordinates, the transform's.
		const toViewer = (clientX: number, clientY: number): Point => {
			const rect = viewer.value?.getBoundingClientRect();
			return {x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0)};
		};

		// The fitted view: where a swipe springs back to.
		const fittedView = (): View | null => {
			if (!viewer.value) {
				return null;
			}

			const box = contentBox(viewer.value);
			return {x: box.left + box.width / 2, y: box.top + box.height / 2, scale: fitScale};
		};

		const prepareImage = () => {
			const viewerEl = viewer.value;
			const imageEl = image.value;

			if (!viewerEl || !imageEl) {
				return;
			}

			const {width, height} = contentBox(viewerEl);
			const scale = Math.min(1, width / imageEl.width, height / imageEl.height);

			stopSettling();
			position.value.x = Math.floor(-imageEl.naturalWidth / 2);
			position.value.y = Math.floor(-imageEl.naturalHeight / 2);
			fitScale = Math.max(scale, 0.1);
			Object.assign(transform.value, fittedView());
			dim.value = 1;
			loaded.value = true;
		};

		const onImageLoad = () => {
			prepareImage();
		};

		// The scale and place the picture comes to rest at from `view`:
		// between fitted and the maximum, no edge inside the box. A scale
		// pulled past either is brought back about `anchor`.
		const restingView = (view: View, anchor: Point): View => {
			if (!viewer.value) {
				return view;
			}

			const scale = clampScale(view.scale, fitScale, MAX_SCALE);
			const zoomed = scale === view.scale ? view : zoomAbout(view, scale, anchor);
			return {...clampCentre(zoomed, imageSize(), contentBox(viewer.value)), scale};
		};

		// Bring the picture back inside its bounds, animated.
		const springBack = (anchor: Point) => {
			const rest = restingView(transform.value, anchor);

			if (
				rest.x !== transform.value.x ||
				rest.y !== transform.value.y ||
				rest.scale !== transform.value.scale
			) {
				settle(rest);
			}

			dim.value = 1;
		};

		// The picture kept where it belongs (after a resize, a wheel pan).
		const correctPosition = () => {
			if (!viewer.value || link.value === null) {
				return;
			}

			// Fitted, it stays fitted to the new size.
			if (isFitted(transform.value.scale, fitScale)) {
				prepareImage();
				return;
			}

			Object.assign(
				transform.value,
				clampCentre(transform.value, imageSize(), contentBox(viewer.value))
			);
		};

		// Zoom to `scale` about a point in the viewer, kept within bounds;
		// animated for a step (a double tap, a key), not for a continuous zoom.
		const zoomTo = (scale: number, point: Point, animate = false) => {
			if (!viewer.value || link.value === null) {
				return;
			}

			const view = zoomAbout(transform.value, clampScale(scale, fitScale, MAX_SCALE), point);
			const rest = {
				...clampCentre(view, imageSize(), contentBox(viewer.value)),
				scale: view.scale,
			};

			if (animate) {
				settle(rest);
			} else {
				stopSettling();
				Object.assign(transform.value, rest);
			}
		};

		const zoomAt = (scale: number, clientX: number, clientY: number) => {
			zoomTo(scale, toViewer(clientX, clientY));
		};

		// Fitted: zoom in on the point. Zoomed: back to fitted.
		const toggleZoom = (point: Point) => {
			zoomTo(doubleTapScale(transform.value.scale, fitScale), point, true);
		};

		// The keyboard zooms about the middle of the picture's box.
		const boxCentre = (): Point => {
			const view = fittedView();
			return view ? {x: view.x, y: view.y} : {x: 0, y: 0};
		};

		const zoomIn = () => zoomTo(transform.value.scale * ZOOM_STEP, boxCentre(), true);
		const zoomOut = () => zoomTo(transform.value.scale / ZOOM_STEP, boxCentre(), true);
		const zoomReset = () => zoomTo(fitScale, boxCentre(), true);

		// The picture's menu: Open, Copy link and, where the platform has a
		// share sheet, Share. Only in the app shells: a browser's own menu
		// (Safari's long-press callout, Chrome's image menu, a desktop's
		// right click) can save and copy the picture itself, which a page
		// cannot do for an image from another site.
		const menuEnabled = () => isShell();

		const openMenu = (at: {clientX: number; clientY: number; target: EventTarget | null}) => {
			const current = link.value;

			if (!current) {
				return;
			}

			const items: ContextMenuItem[] = [
				{
					label: t("image.menu.open"),
					type: "item",
					class: "image-open",
					action: () => openExternal(current.link),
				},
				{
					label: t("image.menu.copyLink"),
					type: "item",
					class: "image-copy",
					action: () => void writeClipboard(current.link),
				},
			];

			if (typeof navigator.share === "function") {
				items.push({
					label: t("image.menu.share"),
					type: "item",
					class: "image-share",
					action() {
						// Dismissed or refused: nothing to report.
						navigator.share({url: current.link}).catch(() => {});
					},
				});
			}

			// The menu takes a pointer event: where it opens, and one to cancel.
			const event = {
				clientX: at.clientX,
				clientY: at.clientY,
				target: at.target,
				preventDefault() {},
			} as unknown as MouseEvent;

			eventbus.emit("contextmenu:items", {event, items});
		};

		// Reduce multiple touch points into a single x/y/spread, in the
		// viewer's coordinates.
		const reduceTouches = (touches: TouchList): Fingers => {
			let totalX = 0;
			let totalY = 0;
			let totalSpread = 0;

			for (let i = 0; i < touches.length; i++) {
				const x = touches[i].clientX;
				const y = touches[i].clientY;

				totalX += x;
				totalY += y;

				for (let i2 = 0; i2 < touches.length; i2++) {
					if (i !== i2) {
						const x2 = touches[i2].clientX;
						const y2 = touches[i2].clientY;
						totalSpread += Math.sqrt((x - x2) * (x - x2) + (y - y2) * (y - y2));
					}
				}
			}

			if (totalSpread === 0) {
				totalSpread = 1;
			}

			const point = toViewer(totalX / touches.length, totalY / touches.length);
			return {x: point.x, y: point.y, spread: totalSpread / touches.length};
		};

		// Touch: the viewer owns every touch on it, wherever it lands (the
		// fitted picture on a phone is a small part of the screen).
		// - Fitted, one finger swipes: up or down closes the viewer,
		//   sideways goes to the next or previous picture (helpers/
		//   viewerGesture.ts swipeOutcome), short of that it springs back.
		// - Zoomed, one finger pans; two fingers pinch anywhere, about the
		//   point between them. Past an edge, or past fitted or the maximum,
		//   the picture stretches and springs back when the fingers lift.
		// - A tap on the backdrop closes at once; a tap on the picture shows
		//   or hides the buttons, unless a second tap follows, which zooms
		//   in on that point (or back out to fitted).
		// - A long press on the picture opens its menu (in the app shells).
		// The touchend is cancelled, so the compatibility mouse events (whose
		// mouseup would pan) and the click never follow; a touch on a button
		// starts no gesture and keeps its click. No touch leaves the viewer:
		// the sidebar's swipe listens on <body>.
		type Sample = {x: number; y: number; at: number};
		type Gesture = {
			from: Fingers;
			// The fingers as they last were: what a spring back zooms about.
			last: Fingers;
			base: View;
			// Where the first finger came down, on screen.
			origin: {clientX: number; clientY: number};
			fingers: number;
			multi: boolean;
			moved: number;
			startedAt: number;
			// Fitted under one finger: a swipe, once it has a way.
			swipe: boolean;
			axis: Axis | null;
			samples: Sample[];
			pressTimer: ReturnType<typeof setTimeout> | undefined;
			// The long press opened the menu: the rest of the touch is its.
			pressed: boolean;
			target: EventTarget | null;
		};
		let gesture: Gesture | null = null;

		// The fingers changed: measure from where they and the picture are now.
		const rebase = (g: Gesture, touches: TouchList) => {
			g.from = reduceTouches(touches);
			g.base = {...transform.value};
			g.fingers = touches.length;
		};

		const cancelPress = (g: Gesture) => {
			clearTimeout(g.pressTimer);
			g.pressTimer = undefined;
		};

		const pressed = (g: Gesture) => {
			cancelPress(g);
			g.pressed = true;
			openMenu({...g.origin, target: g.target});
		};

		// The swipe's speed along its axis over its last moments, px/ms.
		const velocityOf = (g: Gesture, axis: Axis) => {
			const last = g.samples[g.samples.length - 1];
			const first = g.samples[0];

			if (!last || !first || last.at === first.at) {
				return 0;
			}

			return (last[axis] - first[axis]) / (last.at - first.at);
		};

		const hasNeighbour = (forward: boolean) =>
			forward ? !!nextImage.value : !!previousImage.value;

		const moveSwipe = (g: Gesture, touch: Fingers) => {
			const dx = touch.x - g.from.x;
			const dy = touch.y - g.from.y;

			g.axis = g.axis ?? lockAxis(dx, dy);

			if (!g.axis || !viewer.value) {
				return;
			}

			const now = Date.now();
			g.samples.push({x: touch.x, y: touch.y, at: now});

			while (g.samples.length > 2 && now - g.samples[0].at > VELOCITY_WINDOW_MS) {
				g.samples.shift();
			}

			const box = contentBox(viewer.value);

			if (g.axis === "y") {
				transform.value.x = g.base.x;
				transform.value.y = g.base.y + dy;
				dim.value = Math.max(0, 1 - Math.abs(dy) / (box.height * DIM_FRACTION));
			} else {
				// Toward a picture there is: it follows the finger. Toward
				// none: it stretches.
				const forward = isRtl() ? dx > 0 : dx < 0;
				transform.value.x = g.base.x + (hasNeighbour(forward) ? dx : rubber(dx, box.width));
				transform.value.y = g.base.y;
			}
		};

		const endSwipe = (g: Gesture, axis: Axis) => {
			const viewerEl = viewer.value;
			const rest = fittedView();

			if (!viewerEl || !rest) {
				return;
			}

			const box = contentBox(viewerEl);
			const last = g.samples[g.samples.length - 1];
			const distance = last ? last[axis] - g.from[axis] : 0;
			const outcome = swipeOutcome({
				axis,
				distance,
				velocity: velocityOf(g, axis),
				extent: axis === "x" ? box.width : box.height,
				rtl: isRtl(),
				hasNext: !!nextImage.value,
				hasPrevious: !!previousImage.value,
			});
			const away = Math.sign(distance) || 1;

			if (outcome === "close") {
				dim.value = 0;
				settle({y: rest.y + away * box.height}, closeViewer);
			} else if (outcome === "next" || outcome === "previous") {
				settle({x: rest.x + away * box.width}, outcome === "next" ? next : previous);
			} else {
				dim.value = 1;
				settle(rest);
			}
		};

		const onTouchMove = (e: TouchEvent) => {
			const g = gesture;

			if (!g || g.pressed) {
				return;
			}

			if (e.touches.length !== g.fingers) {
				rebase(g, e.touches);
			}

			const touch = reduceTouches(e.touches);
			g.last = touch;

			if (!g.multi) {
				g.moved = Math.max(g.moved, Math.hypot(touch.x - g.from.x, touch.y - g.from.y));

				if (g.moved >= TAP_SLOP_PX) {
					cancelPress(g);
				}
			}

			if (g.swipe && !g.multi) {
				moveSwipe(g, touch);
				return;
			}

			if (!viewer.value) {
				return;
			}

			const view = pinch(g.base, g.from, touch, (s) => softScale(s, fitScale, MAX_SCALE));
			Object.assign(transform.value, {
				...softCentre(view, imageSize(), contentBox(viewer.value)),
				scale: view.scale,
			});
		};

		// Whether a point on screen is off the picture as it is drawn now,
		// zoom and pan included: the backdrop around it.
		const outsideImage = (point: {clientX: number; clientY: number}) => {
			const rect = image.value?.getBoundingClientRect();

			return (
				!!rect &&
				(point.clientX < rect.left ||
					point.clientX > rect.right ||
					point.clientY < rect.top ||
					point.clientY > rect.bottom)
			);
		};

		const onImageTap = (point: Point) => {
			const tap = {...point, at: Date.now()};

			if (isDoubleTap(lastTap, tap)) {
				clearTimeout(tapTimer);
				lastTap = null;
				toggleZoom(point);
				return;
			}

			// Wait for a second tap before taking this one as a single tap.
			lastTap = tap;
			clearTimeout(tapTimer);
			tapTimer = setTimeout(() => {
				lastTap = null;
				controlsHidden.value = !controlsHidden.value;
			}, DOUBLE_TAP_MS);
		};

		const onTouchEnd = (e: TouchEvent) => {
			const g = gesture;

			if (!g) {
				return;
			}

			e.preventDefault();

			if (e.touches.length > 0) {
				// A finger of a pinch lifted: the rest pan on from here.
				rebase(g, e.touches);
				return;
			}

			gesture = null;
			cancelPress(g);

			if (g.pressed) {
				return;
			}

			if (g.swipe && !g.multi && g.axis) {
				endSwipe(g, g.axis);
				return;
			}

			const tapped =
				!g.multi && g.moved < TAP_SLOP_PX && Date.now() - g.startedAt < TAP_MAX_MS;

			if (!tapped) {
				springBack(g.last);
				return;
			}

			if (outsideImage(g.origin)) {
				closeViewer();
			} else {
				onImageTap({x: g.from.x, y: g.from.y});
			}
		};

		// The touch was taken from us (or the viewer closed under it): put
		// the picture back where it belongs.
		const onTouchCancel = () => {
			const g = gesture;
			gesture = null;

			if (!g) {
				return;
			}

			cancelPress(g);

			if (g.swipe && !g.multi && g.axis) {
				const rest = fittedView();
				dim.value = 1;

				if (rest) {
					settle(rest);
				}

				return;
			}

			springBack(g.last);
		};

		const onTouchStart = (e: TouchEvent) => {
			// prevent sidebar touchstart event, we don't want to interact with sidebar while in image viewer
			e.stopImmediatePropagation();

			if (gesture) {
				if (gesture.pressed) {
					return;
				}

				// Another finger joins, wherever it lands: a pinch, never a tap
				// or a swipe. A swipe under way gives the picture back first.
				gesture.multi = true;
				cancelPress(gesture);

				if (gesture.swipe && gesture.axis) {
					dim.value = 1;
					Object.assign(transform.value, fittedView());
				}

				rebase(gesture, e.touches);
				return;
			}

			// The buttons and the open link keep their own taps.
			if ((e.target as Element | null)?.closest?.("button, a")) {
				return;
			}

			// A finger on the picture as it comes to rest takes it from there.
			stopSettling();

			const first = reduceTouches(e.touches);
			const g: Gesture = {
				from: first,
				last: first,
				base: {...transform.value},
				origin: {clientX: e.touches[0].clientX, clientY: e.touches[0].clientY},
				fingers: e.touches.length,
				multi: e.touches.length > 1,
				moved: 0,
				startedAt: Date.now(),
				swipe: e.touches.length === 1 && isFitted(transform.value.scale, fitScale),
				axis: null,
				samples: [{x: first.x, y: first.y, at: Date.now()}],
				pressTimer: undefined,
				pressed: false,
				target: e.target,
			};

			if (!g.multi && menuEnabled() && e.target === image.value) {
				g.pressTimer = setTimeout(() => {
					if (gesture === g && !g.multi && g.moved < TAP_SLOP_PX) {
						pressed(g);
					}
				}, LONG_PRESS_MS);
			}

			gesture = g;
		};

		// The platform's own long press (Android's WebView fires contextmenu)
		// and a right click. In a browser its own menu stands; in the app
		// shells the picture's menu replaces it.
		const onContextMenu = (e: MouseEvent) => {
			if (!menuEnabled()) {
				return;
			}

			e.preventDefault();

			if (gesture) {
				// A long press the platform noticed before our timer did.
				if (!gesture.pressed && !gesture.multi && gesture.moved < TAP_SLOP_PX) {
					pressed(gesture);
				}

				return;
			}

			if (e.target === image.value) {
				openMenu(e);
			}
		};

		// A mouse pan just ended; its click is not a close.
		let panEnded = false;

		// Image mouse manipulation:
		// 1. Mouse wheel scrolling will zoom in and out
		// 2. If image is zoomed in, simply dragging it will move it around
		const onImageMouseDown = (e: MouseEvent) => {
			// only left mouse
			if (e.button !== 0) {
				return;
			}

			e.stopPropagation();
			e.preventDefault();

			const viewerEl = viewer.value;

			if (!viewerEl || !image.value) {
				return;
			}

			stopSettling();

			const startX = e.clientX;
			const startY = e.clientY;
			const base = {...transform.value};
			const box = contentBox(viewerEl);
			let movedDistance = 0;

			const mouseMove = (moveEvent: MouseEvent) => {
				moveEvent.stopPropagation();
				moveEvent.preventDefault();

				const dx = moveEvent.clientX - startX;
				const dy = moveEvent.clientY - startY;

				movedDistance = Math.max(movedDistance, Math.abs(dx), Math.abs(dy));
				Object.assign(
					transform.value,
					clampCentre({...base, x: base.x + dx, y: base.y + dy}, imageSize(), box)
				);
			};

			// On the window, not the image: a pan that leaves the image is still
			// the pan, and its release is not a click on the backdrop.
			const mouseUp = (upEvent: MouseEvent) => {
				window.removeEventListener("mousemove", mouseMove);
				window.removeEventListener("mouseup", mouseUp);

				if (movedDistance >= 2) {
					// The click that follows lands on the backdrop when the
					// release did: it ends the pan, it does not close.
					panEnded = true;
					setTimeout(() => (panEnded = false), 0);
					return;
				}

				// A click on the picture closes, as it always has — once no
				// second click has made it a double click, which zooms.
				if (upEvent.button === 0 && upEvent.target === image.value) {
					clearTimeout(tapTimer);
					tapTimer = setTimeout(closeViewer, DOUBLE_TAP_MS);
				}
			};

			window.addEventListener("mousemove", mouseMove);
			window.addEventListener("mouseup", mouseUp);
		};

		const onImageDoubleClick = (e: MouseEvent) => {
			clearTimeout(tapTimer);
			toggleZoom(toViewer(e.clientX, e.clientY));
		};

		// WebKit (Safari, and the Mac app's WKWebView) sends a trackpad pinch
		// as gesture events, not wheels: scale is relative to the gesture's
		// start.
		type PinchEvent = Event & {scale: number; clientX: number; clientY: number};
		let pinchFrom = 1;

		const onGestureStart = (e: Event) => {
			e.preventDefault();
			pinchFrom = transform.value.scale;
		};

		const onGestureChange = (e: Event) => {
			e.preventDefault();
			const pinchEvent = e as PinchEvent;
			zoomAt(pinchFrom * pinchEvent.scale, pinchEvent.clientX, pinchEvent.clientY);
		};

		const scrollPans =
			document.documentElement.dataset.platform === "macos" ||
			/^Mac/.test(navigator.platform);

		const onMouseWheel = (e: WheelEvent) => {
			// if image viewer is closing (css animation), you can still trigger mousewheel
			if (link.value === null) {
				return;
			}

			e.preventDefault();

			if (e.ctrlKey) {
				// A trackpad pinch arrives in Chromium and Firefox as a wheel
				// with ctrlKey set: zoom by it, about the pointer.
				zoomAt(transform.value.scale * Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
			} else if (scrollPans) {
				// On a Mac a scroll is the trackpad's two fingers (or a mouse
				// wheel): it moves the picture, as Preview's does; the pinch
				// zooms.
				transform.value.x -= e.deltaX;
				transform.value.y -= e.deltaY;
				correctPosition();
			} else if (e.deltaY !== 0) {
				// Elsewhere a wheel zooms in steps, about the pointer: up
				// (away from you) in, as a pinch outward does.
				const step = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
				zoomAt(transform.value.scale * step, e.clientX, e.clientY);
			}
		};

		const onClick = (e: Event) => {
			// If click triggers on the image, ignore it
			if (e.target === image.value || panEnded) {
				return;
			}

			closeViewer();
		};

		// Escape (and Android's back, native.ts) closes the topmost layer
		// only: a menu open on the picture before the viewer under it.
		const onEscape = (layer: string | null) => {
			if (layer === "image-viewer") {
				closeViewer();
			}
		};

		const bindKeys = () => {
			Mousetrap.bind("left", () => (isRtl() ? next() : previous()));
			Mousetrap.bind("right", () => (isRtl() ? previous() : next()));
			Mousetrap.bind(["plus", "="], zoomIn);
			Mousetrap.bind("-", zoomOut);
			Mousetrap.bind("0", zoomReset);
		};

		const unbindKeys = () => {
			Mousetrap.unbind(["left", "right", "plus", "=", "-", "0"]);
		};

		watch(link, (newLink, oldLink) => {
			if (newLink === null) {
				// Closed under a finger (Android's back, Escape): the <img> it
				// rested on is gone, so its touchend never reaches the viewer.
				if (gesture) {
					cancelPress(gesture);
					gesture = null;
				}

				stopSettling();
				dim.value = 1;
				controlsHidden.value = false;
				loaded.value = false;
				setImageViewerClose(null);
				eventbus.off("escapekey", onEscape);
				eventbus.off("resize", correctPosition);
				unbindKeys();
				return;
			}

			// A new picture is shown once it has loaded and been fitted; the
			// same picture again (another preview of it) loads no more.
			if (newLink.thumb !== oldLink?.thumb) {
				loaded.value = false;
			} else {
				prepareImage();
			}

			setPrevNextImages();

			if (!oldLink) {
				setImageViewerClose(closeViewer);
				eventbus.on("escapekey", onEscape);
				eventbus.on("resize", correctPosition);
				bindKeys();
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
			settling,
			dim,
			controlsHidden,
			loaded,
			closeViewer,
			next,
			previous,
			onImageLoad,
			onImageMouseDown,
			onImageDoubleClick,
			onMouseWheel,
			onGestureStart,
			onGestureChange,
			onClick,
			onContextMenu,
			onTouchStart,
			onTouchMove,
			onTouchEnd,
			onTouchCancel,
			previousImage,
			nextImage,
			computeImageStyles,
			viewer,
		};
	},
});
</script>
