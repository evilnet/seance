// The image viewer's geometry and gesture rules (ImageViewer.vue), kept free
// of the DOM so mocha can hold them: where a pinch or a zoom puts the picture,
// how far past an edge a drag may stretch, which way a swipe locks, and what a
// swipe or a second tap means when the finger lifts.
//
// A view is the picture's centre in the viewer's own coordinates and its
// scale; a box is the viewer's content box (its padding taken off, the Mac
// app's traffic-light strip), the area the picture is fitted and kept in.

export type Point = {x: number; y: number};
export type View = {x: number; y: number; scale: number};
type Size = {width: number; height: number};
export type Box = {left: number; top: number; width: number; height: number};

/** The most the picture is ever zoomed, in CSS pixels per image pixel. */
export const MAX_SCALE = 3;

/** One finger moved less than this is still a tap, and no swipe has a way yet. */
export const TAP_SLOP_PX = 10;
/** A tap is lifted within this. */
export const TAP_MAX_MS = 400;
/** A second tap this soon after the first, this close to it, is a double tap. */
export const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 30;

/** Within this of the fitted scale the picture counts as fitted. */
const FITTED_TOLERANCE = 1.05;

export function clampScale(scale: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, scale));
}

export function isFitted(scale: number, fitScale: number): boolean {
	return scale <= fitScale * FITTED_TOLERANCE;
}

/** Zoom to `scale` about `point`, keeping the part of the picture under it there. */
export function zoomAbout(view: View, scale: number, point: Point): View {
	const ratio = scale / view.scale;

	return {
		x: point.x - (point.x - view.x) * ratio,
		y: point.y - (point.y - view.y) * ratio,
		scale,
	};
}

/** Fingers reduced to one point and how far apart they are. */
export type Fingers = {x: number; y: number; spread: number};

/**
 * Where a pinch that began with the picture at `base` and the fingers at
 * `from` puts it with the fingers at `to`: the part of the picture that was
 * under the fingers stays under them, through both the zoom and the pan.
 * `scaleOf` bounds the raw scale (softScale while the fingers are down).
 */
export function pinch(
	base: View,
	from: Fingers,
	to: Fingers,
	scaleOf: (scale: number) => number
): View {
	const scale = scaleOf(base.scale * (to.spread / from.spread));
	const ratio = scale / base.scale;

	return {
		x: to.x - (from.x - base.x) * ratio,
		y: to.y - (from.y - base.y) * ratio,
		scale,
	};
}

/**
 * How far a drag `overshoot` past a limit shows, in a space `extent` wide:
 * the further it goes the less each pixel counts, and it never reaches
 * `extent`. Sign kept.
 */
export function rubber(overshoot: number, extent: number): number {
	if (overshoot === 0 || extent <= 0) {
		return 0;
	}

	const shown = (1 - 1 / ((Math.abs(overshoot) * 0.55) / extent + 1)) * extent;
	return Math.sign(overshoot) * shown;
}

/** A scale pulled past [min, max] stretches beyond it, damped. */
export function softScale(scale: number, min: number, max: number): number {
	if (scale < min) {
		return min - rubber(min - scale, min);
	}

	if (scale > max) {
		return max + rubber(scale - max, max);
	}

	return scale;
}

/** The centre on one axis that keeps the picture where it belongs. */
function clampAxis(centre: number, length: number, start: number, extent: number): number {
	// Smaller than the box: centred in it. Larger: no edge comes inside it.
	if (length <= extent) {
		return start + extent / 2;
	}

	return Math.min(start + length / 2, Math.max(start + extent - length / 2, centre));
}

/** The view's centre moved to where the picture belongs in the box. */
export function clampCentre(view: View, size: Size, box: Box): Point {
	return {
		x: clampAxis(view.x, size.width * view.scale, box.left, box.width),
		y: clampAxis(view.y, size.height * view.scale, box.top, box.height),
	};
}

/** As clampCentre, but a centre dragged past where it belongs stretches there. */
export function softCentre(view: View, size: Size, box: Box): Point {
	const hard = clampCentre(view, size, box);

	return {
		x: hard.x + rubber(view.x - hard.x, box.width),
		y: hard.y + rubber(view.y - hard.y, box.height),
	};
}

export type Axis = "x" | "y";

/** The way a one-finger drag goes once it is past the slop, or null before. */
export function lockAxis(dx: number, dy: number): Axis | null {
	if (Math.hypot(dx, dy) < TAP_SLOP_PX) {
		return null;
	}

	return Math.abs(dx) > Math.abs(dy) ? "x" : "y";
}

type SwipeOutcome = "close" | "next" | "previous" | "stay";

export type Swipe = {
	axis: Axis;
	/** How far the finger went on that axis. */
	distance: number;
	/** Its speed at the end, px/ms, signed the same way. */
	velocity: number;
	/** The box's extent on that axis. */
	extent: number;
	/** Right to left: the next picture comes from the left. */
	rtl: boolean;
	hasNext: boolean;
	hasPrevious: boolean;
};

/** Whether a sideways drag `dx` goes toward the next picture: left, or right
 * to left, right. */
export function isForward(dx: number, rtl: boolean): boolean {
	return rtl ? dx > 0 : dx < 0;
}

/** A drag this far across the box, or a flick, carries its swipe. */
const SWIPE_CLOSE_FRACTION = 0.2;
const SWIPE_STEP_FRACTION = 0.25;
const FLICK_SPEED = 0.5;
const FLICK_MIN_PX = 30;

/**
 * What a one-finger swipe on a fitted picture does when the finger lifts:
 * up or down closes the viewer, sideways goes to the neighbouring picture
 * (left is next, or previous right to left), and a short, slow or impossible
 * one springs back.
 */
export function swipeOutcome(s: Swipe): SwipeOutcome {
	const fraction = s.axis === "y" ? SWIPE_CLOSE_FRACTION : SWIPE_STEP_FRACTION;
	const far = Math.abs(s.distance) > s.extent * fraction;
	// A flick counts only in the way the drag went: a drag back toward the
	// start is the reader changing their mind.
	const flicked =
		Math.abs(s.distance) > FLICK_MIN_PX &&
		Math.abs(s.velocity) > FLICK_SPEED &&
		Math.sign(s.velocity) === Math.sign(s.distance);

	if (!far && !flicked) {
		return "stay";
	}

	if (s.axis === "y") {
		return "close";
	}

	if (isForward(s.distance, s.rtl)) {
		return s.hasNext ? "next" : "stay";
	}

	return s.hasPrevious ? "previous" : "stay";
}

export type Tap = {x: number; y: number; at: number};

/** Whether `now` is the second tap of a double tap begun by `previous`. */
export function isDoubleTap(previous: Tap | null, now: Tap): boolean {
	return (
		!!previous &&
		now.at - previous.at < DOUBLE_TAP_MS &&
		Math.hypot(now.x - previous.x, now.y - previous.y) < DOUBLE_TAP_SLOP_PX
	);
}

/**
 * The scale a double tap (or double click) goes to: back to fitted from any
 * zoom, else close up — two and a half times the fitted size, at least the
 * picture's own pixels, at most MAX_SCALE.
 */
export function doubleTapScale(scale: number, fitScale: number): number {
	if (!isFitted(scale, fitScale)) {
		return fitScale;
	}

	return Math.min(MAX_SCALE, Math.max(1, fitScale * 2.5));
}

/** The keyboard's and the wheel's zoom step. */
export const ZOOM_STEP = 1.25;
