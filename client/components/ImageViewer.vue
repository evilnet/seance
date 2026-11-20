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
				@error="onImageLoad"
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
import {setImageViewerOpen} from "../js/helpers/imageViewer";
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
	isForward,
	lockAxis,
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
		// A swipe's close or step, run once the picture has flown out.
		let departure: (() => void) | null = null;

		// The transition is over, or cut short: a departure happens now. A
		// swipe that flew the picture out has decided, so a finger that comes
		// down before it lands does not take the step back.
		const finishSettling = () => {
			clearTimeout(settleTimer);
			settling.value = false;
			const then = departure;
			departure = null;
			then?.();
		};

		// Move the picture to `view` under the transition, then run its
		// `departure` if it is flying out. With reduced motion it jumps there
		// and the departure runs at once.
		const settle = (view: Partial<View>, then?: () => void) => {
			finishSettling();
			Object.assign(transform.value, view);
			departure = then ?? null;

			if (reduceMotion()) {
				finishSettling();
				return;
			}

			settling.value = true;
			settleTimer = setTimeout(finishSettling, SETTLE_MS);
		};

		// A single tap's (or click's) action, held back while a second could
		// still make it a double.
		let tapTimer: ReturnType<typeof setTimeout> | undefined;
		// The last tap on the picture, while a second could still make it a double tap.
		let lastTap: Tap | null = null;

		const cancelTap = () => {
			clearTimeout(tapTimer);
			lastTap = null;
		};

		const closeViewer = () => {
			if (link.value === null) {
				return;
			}

			cancelTap();
			// Closing anyway: a departure is moot.
			departure = null;
			finishSettling();
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

		// The middle of the picture's box: what the keyboard zooms about.
		const boxCentre = (): Point => {
			const view = fittedView();
			return view ? {x: view.x, y: view.y} : {x: 0, y: 0};
		};

		// The scale that fits the picture in the box, never past its own pixels.
		const measureFit = (viewerEl: HTMLElement, imageEl: HTMLImageElement) => {
			const {width, height} = contentBox(viewerEl);
			// A picture that failed to load has no size: shown as it is.
			const scale = Math.min(1, width / imageEl.width, height / imageEl.height) || 1;
			return Math.max(scale, 0.1);
		};

		const prepareImage = () => {
			const viewerEl = viewer.value;
			const imageEl = image.value;

			if (!viewerEl || !imageEl) {
				return;
			}

			position.value.x = Math.floor(-imageEl.naturalWidth / 2);
			position.value.y = Math.floor(-imageEl.naturalHeight / 2);
			fitScale = measureFit(viewerEl, imageEl);
			Object.assign(transform.value, fittedView());
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
			// Not yet loaded: its load fits it.
			if (!viewer.value || link.value === null || !loaded.value) {
				return;
			}

			// Fitted, it stays fitted to the new size.
			if (isFitted(transform.value.scale, fitScale)) {
				prepareImage();
				return;
			}

			// Zoomed, it stays zoomed, but the fitted size moved with the box
			// (a phone turned): no smaller than the new fit, edges kept out.
			if (image.value) {
				fitScale = measureFit(viewer.value, image.value);
			}

			Object.assign(transform.value, restingView(transform.value, boxCentre()));
		};

		// Zoom to `scale` about a point in the viewer, kept within bounds;
		// animated for a step (a double tap, a key), not for a continuous zoom.
		const zoomTo = (scale: number, point: Point, animate = false) => {
			if (!viewer.value || link.value === null) {
				return;
			}

			const rest = restingView(zoomAbout(transform.value, scale, point), point);

			if (animate) {
				settle(rest);
			} else {
				finishSettling();
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

		const zoomIn = () => zoomTo(transform.value.scale * ZOOM_STEP, boxCentre(), true);
		const zoomOut = () => zoomTo(transform.value.scale / ZOOM_STEP, boxCentre(), true);
		const zoomReset = () => zoomTo(fitScale, boxCentre(), true);

		// Reduce multiple touch points into a single x/y/spread, in the
		// viewer's coordinates (`offset`: the viewer's own top left on screen).
		const reduceTouches = (touches: TouchList, offset: Point): Fingers => {
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

			return {
				x: totalX / touches.length - offset.x,
				y: totalY / touches.length - offset.y,
				spread: totalSpread / touches.length,
			};
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
		// The touchend is cancelled, so the compatibility mouse events (whose
		// mouseup would pan) and the click never follow; a tap on a button is
		// given its click, and a touch on the open link starts no gesture and
		// keeps its own. No touch leaves the viewer:
		// the sidebar's swipe listens on <body>.
		type Gesture = {
			from: Fingers;
			// The fingers as they last were: what a spring back zooms about.
			last: Fingers;
			base: View;
			// Where the first finger came down, on screen.
			origin: Point;
			// Measured once as the touch begins: none of it changes under a
			// finger, and reading layout at touch rate is what makes a drag lag.
			offset: Point;
			box: Box;
			size: {width: number; height: number};
			rtl: boolean;
			fingers: number;
			multi: boolean;
			moved: number;
			startedAt: number;
			// Fitted under one finger: a swipe, once it has a way. A second
			// finger makes it a pinch for good.
			swipe: boolean;
			axis: Axis | null;
			samples: Tap[];
			// Nothing more to do with this touch but swallow it: it landed as
			// a swipe's step or close went ahead.
			spent: boolean;
			// Where the fingers have put the picture before any stretch past
			// its bounds damps it: what the fingers carry on from when one
			// lifts or joins. Null while it is the transform itself.
			raw: View | null;
			// A button the touch began on: a tap there is its click.
			control: HTMLElement | null;
		};
		let gesture: Gesture | null = null;

		// The fingers changed: measure from where they and the picture are now.
		const rebase = (g: Gesture, touches: TouchList) => {
			g.from = reduceTouches(touches, g.offset);
			g.base = g.raw ?? {...transform.value};
			g.fingers = touches.length;
		};

		// Keep the finger's last moments, to read its speed from.
		const sample = (g: Gesture, at: Point) => {
			const now = Date.now();
			g.samples.push({x: at.x, y: at.y, at: now});

			while (g.samples.length > 2 && now - g.samples[0].at > VELOCITY_WINDOW_MS) {
				g.samples.shift();
			}
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

		const moveSwipe = (g: Gesture, touch: Fingers) => {
			const dx = touch.x - g.from.x;
			const dy = touch.y - g.from.y;

			g.axis = g.axis ?? lockAxis(dx, dy);

			if (!g.axis) {
				return;
			}

			sample(g, touch);

			if (g.axis === "y") {
				transform.value.x = g.base.x;
				transform.value.y = g.base.y + dy;
				dim.value = Math.max(0, 1 - Math.abs(dy) / (g.box.height * DIM_FRACTION));
			} else {
				// Toward a picture there is: it follows the finger. Toward
				// none: it stretches.
				const there = isForward(dx, g.rtl) ? nextImage.value : previousImage.value;
				transform.value.x = g.base.x + (there ? dx : rubber(dx, g.box.width));
				transform.value.y = g.base.y;
			}
		};

		// A swipe given up (a second finger, a cancelled touch): the picture
		// goes back to fitted and the backdrop comes back.
		const unswipe = (animate: boolean) => {
			const rest = fittedView();
			dim.value = 1;

			if (!rest) {
				return;
			}

			if (animate) {
				settle(rest);
			} else {
				Object.assign(transform.value, rest);
			}
		};

		const endSwipe = (g: Gesture, axis: Axis) => {
			const rest = fittedView();

			if (!rest) {
				return;
			}

			// The finger as it lifts: one that stopped before lifting has no
			// speed left, however fast it went before.
			sample(g, g.last);

			const distance = g.last[axis] - g.from[axis];
			const extent = axis === "x" ? g.box.width : g.box.height;
			const outcome = swipeOutcome({
				axis,
				distance,
				velocity: velocityOf(g, axis),
				extent,
				rtl: g.rtl,
				hasNext: !!nextImage.value,
				hasPrevious: !!previousImage.value,
			});
			const away = (Math.sign(distance) || 1) * extent;
			// What happens when the picture is out is for the picture that
			// flew out: a key or an arrow may have stepped already.
			const from = link.value;

			if (outcome === "close") {
				dim.value = 0;
				settle({y: rest.y + away}, () => link.value === from && closeViewer());
			} else if (outcome === "next" || outcome === "previous") {
				const step = outcome === "next" ? next : previous;
				settle({x: rest.x + away}, () => link.value === from && step());
			} else {
				unswipe(true);
			}
		};

		const onTouchMove = (e: TouchEvent) => {
			const g = gesture;

			if (!g || g.spent) {
				return;
			}

			if (e.touches.length !== g.fingers) {
				rebase(g, e.touches);
			}

			const touch = reduceTouches(e.touches, g.offset);
			g.last = touch;

			if (!g.multi) {
				g.moved = Math.max(g.moved, Math.hypot(touch.x - g.from.x, touch.y - g.from.y));
			}

			// No longer a tap: an earlier tap waiting for it as its second
			// does not show or hide the buttons under a swipe or a pinch.
			if (g.multi || g.moved >= TAP_SLOP_PX) {
				cancelTap();
			}

			if (g.swipe) {
				moveSwipe(g, touch);
				return;
			}

			const raw = pinch(g.base, g.from, touch, (s) => s);
			const view = zoomAbout(raw, softScale(raw.scale, fitScale, MAX_SCALE), touch);
			g.raw = raw;
			Object.assign(transform.value, {...softCentre(view, g.size, g.box), scale: view.scale});
		};

		// Whether a point on screen is off the picture as it is drawn now,
		// zoom and pan included: the backdrop around it.
		const outsideImage = (point: Point) => {
			const rect = image.value?.getBoundingClientRect();

			return (
				!!rect &&
				(point.x < rect.left ||
					point.x > rect.right ||
					point.y < rect.top ||
					point.y > rect.bottom)
			);
		};

		const onImageTap = (point: Point) => {
			const tap = {...point, at: Date.now()};

			if (isDoubleTap(lastTap, tap)) {
				cancelTap();
				toggleZoom(point);
				return;
			}

			// Wait for a second tap before taking this one as a single tap.
			cancelTap();
			lastTap = tap;
			tapTimer = setTimeout(() => {
				lastTap = null;
				controlsHidden.value = !controlsHidden.value;
			}, DOUBLE_TAP_MS);
		};

		// The last finger is off (or the touch was taken from us, `cancelled`):
		// what the gesture was is decided.
		const release = (g: Gesture, cancelled: boolean) => {
			gesture = null;

			if (g.spent) {
				return;
			}

			if (g.swipe && g.axis) {
				if (cancelled) {
					unswipe(true);
				} else {
					endSwipe(g, g.axis);
				}

				return;
			}

			const tapped =
				!cancelled &&
				!g.multi &&
				g.moved < TAP_SLOP_PX &&
				Date.now() - g.startedAt < TAP_MAX_MS;

			if (!tapped) {
				springBack(g.last);
			} else if (g.control) {
				g.control.click();
			} else if (outsideImage(g.origin)) {
				closeViewer();
			} else {
				onImageTap({x: g.from.x, y: g.from.y});
			}
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

			release(g, false);
		};

		const onTouchCancel = () => {
			if (gesture) {
				release(gesture, true);
			}
		};

		const onTouchStart = (e: TouchEvent) => {
			// prevent sidebar touchstart event, we don't want to interact with sidebar while in image viewer
			e.stopImmediatePropagation();

			if (gesture) {
				if (gesture.spent) {
					return;
				}

				// Another finger joins, wherever it lands: a pinch, never a tap
				// or a swipe. A swipe under way gives the picture back first.
				gesture.multi = true;

				if (gesture.swipe && gesture.axis) {
					unswipe(false);
					gesture.raw = null;
				}

				gesture.swipe = false;
				rebase(gesture, e.touches);
				return;
			}

			const viewerEl = viewer.value;

			// The open link keeps its own tap. A button's strip is part of the
			// screen a swipe starts from (the next and previous ones run its
			// full height), so a touch there is a gesture too, and a tap on it
			// is the button's click.
			const target = e.target as Element | null;

			if (!viewerEl || target?.closest?.("a")) {
				return;
			}

			// A finger on the picture as it comes to rest takes it from there;
			// one that lands as a swipe's step or close goes ahead is spent
			// (the picture it would move is on its way out).
			const departing = !!departure;
			finishSettling();

			if (departing) {
				// A close takes the viewer away under the finger, and its
				// touchend and click would land on the chat beneath: the touch
				// goes no further than here.
				e.preventDefault();
			}

			const rect = viewerEl.getBoundingClientRect();
			const offset = {x: rect.left, y: rect.top};
			const first = reduceTouches(e.touches, offset);
			gesture = {
				from: first,
				last: first,
				base: {...transform.value},
				origin: {x: e.touches[0].clientX, y: e.touches[0].clientY},
				offset,
				box: contentBox(viewerEl),
				size: imageSize(),
				rtl: isRtl(),
				fingers: e.touches.length,
				multi: e.touches.length > 1,
				moved: 0,
				startedAt: Date.now(),
				swipe: e.touches.length === 1 && isFitted(transform.value.scale, fitScale),
				axis: null,
				samples: [{x: first.x, y: first.y, at: Date.now()}],
				spent: departing,
				raw: null,
				control: target?.closest?.("button") ?? null,
			};
		};

		// A mouse pan just ended; its click is not a close.
		let panEnded = false;

		// A left-button drag pans the picture, kept in bounds; a click on it
		// closes it once the double-click wait is over.
		const onImageMouseDown = (e: MouseEvent) => {
			// only left mouse
			if (e.button !== 0) {
				return;
			}

			e.stopPropagation();
			e.preventDefault();
			// A press after a click (a drag, or the second click of a slow
			// double click) is not that click's close.
			clearTimeout(tapTimer);

			const viewerEl = viewer.value;

			if (!viewerEl || !image.value) {
				return;
			}

			finishSettling();

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

		// iOS sends them for a two-finger touch too, alongside the touch
		// events: the touch pinch owns those, with its stretch.
		const onGestureStart = (e: Event) => {
			e.preventDefault();

			if (gesture) {
				return;
			}

			pinchFrom = transform.value.scale;
		};

		const onGestureChange = (e: Event) => {
			e.preventDefault();

			if (gesture) {
				return;
			}

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
			// A wheel after a click on the picture keeps it open.
			clearTimeout(tapTimer);

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
				// Elsewhere a wheel zooms about the pointer, up (away from you)
				// in, as a pinch outward does: a notch (100 px, or 3 lines) by
				// a step, a touchpad's or a fine wheel's many small deltas by
				// as much in all.
				const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
				const steps = Math.max(-1, Math.min(1, -px / 100));
				zoomAt(transform.value.scale * ZOOM_STEP ** steps, e.clientX, e.clientY);
			}
		};

		const onClick = (e: Event) => {
			// If click triggers on the image, ignore it
			if (e.target === image.value || panEnded) {
				return;
			}

			closeViewer();
		};

		// Escape, Android's back (native.ts) and a close request
		// (helpers/imageViewer.ts) close the topmost layer only.
		const onEscape = (layer: string | null) => {
			if (layer === "image-viewer") {
				closeViewer();
			}
		};

		const bindKeys = () => {
			Mousetrap.bind("left", () => (isRtl() ? next() : previous()));
			Mousetrap.bind("right", () => (isRtl() ? previous() : next()));
			// Not typed into the composer behind the viewer (Mousetrap hears
			// it, its mousetrap class): false keeps the key.
			const zoomKey = (zoom: () => void) => () => {
				zoom();
				return false;
			};

			Mousetrap.bind(["plus", "="], zoomKey(zoomIn));
			Mousetrap.bind("-", zoomKey(zoomOut));
			Mousetrap.bind("0", zoomKey(zoomReset));
		};

		const unbindKeys = () => {
			Mousetrap.unbind(["left", "right", "plus", "=", "-", "0"]);
		};

		watch(link, (newLink, oldLink) => {
			if (newLink === null) {
				// Closed under a finger (Android's back, Escape): the <img> it
				// rested on is gone, so its touchend never reaches the viewer.
				gesture = null;

				controlsHidden.value = false;
				loaded.value = false;
				setImageViewerOpen(false);
				eventbus.off("escapekey", onEscape);
				eventbus.off("resize", correctPosition);
				unbindKeys();
				return;
			}

			// A click's pending close (or a tap's) was for the last picture.
			cancelTap();

			// A new picture is shown once it has loaded and been fitted; the
			// same picture again (another preview of it) loads no more.
			if (newLink.thumb !== oldLink?.thumb) {
				loaded.value = false;
			} else {
				prepareImage();
			}

			setPrevNextImages();

			if (!oldLink) {
				// A swipe that closed it left the backdrop faded.
				dim.value = 1;
				setImageViewerOpen(true);
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
