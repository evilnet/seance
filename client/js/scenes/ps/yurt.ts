/**
 * Where the ps theme's yurt stands (docs/projects/ps-theme.md §5.3): in the
 * far third of the message column, 72 % of its width from its left edge; with
 * no column on screen, where it last stood; before any column was measured,
 * at 70 % of the scene (ps.css's own default). Wherever that is, the whole
 * yurt stays inside the scene: a narrow phone would otherwise cut its eave.
 *
 * It never slides. A change under 1.5 rem (a window being dragged wider)
 * is followed at once; a larger one (the user list opens, a private
 * conversation opens) fades the yurt and its smoke out where they stood,
 * jumps while unseen and fades them in where they now stand. A change that
 * comes while a fade is running retargets that fade's jump; there is never a
 * second fade, so two quick toggles end where the last one put it. The one
 * exception is the page's load: the first place measured within 1 s of the
 * scene first being seen is taken at once, so an ordinary load onto a
 * channel shows no move; a page opened on Settings still fades to the
 * column when a conversation opens later. A measurement against a scene not
 * laid out yet (no width: ps.css has not shown it) places nothing and leaves
 * that window unspent; with no column, the last place is clamped again to
 * the scene as it now is.
 *
 * Pure and DOM-free: scene.ts measures the column and carries out the effects
 * (a custom property, a class, a clock, a timer and a frame), so mocha drives
 * all of it.
 */

/** The yurt's centre, as a fraction of the message column's width from its left edge. */
export const YURT_AT = 0.72;
/** Before any column was measured: a fraction of the scene's width (the mockup's 70 %). */
export const YURT_DEFAULT = 0.7;
/** How long the yurt takes to fade out before it jumps (ps.css fades it in 0.38 s). */
export const FADE_MS = 400;
/** A change of place under this many rem is followed at once, without a fade. */
export const FOLLOW_REM = 1.5;
/** The load: the first place measured this soon after the scene is first seen is taken at once. */
export const SETTLE_MS = 1000;

/** The message column's box, in px from the scene's left. */
export interface Column {
	left: number;
	width: number;
}

/**
 * The yurt's centre in px from the scene's left: 72 % across the column; with
 * no column, `last`; with neither, 70 % of the scene. Clamped so the whole
 * yurt (`yurtWidth`, its rendered width) is inside the scene; one wider than
 * the scene stands in its middle.
 */
export function yurtPlace(
	column: Column | null,
	last: number | null,
	sceneWidth: number,
	yurtWidth: number
): number {
	const place = column ? column.left + YURT_AT * column.width : last ?? YURT_DEFAULT * sceneWidth;
	const half = yurtWidth / 2;

	if (sceneWidth <= yurtWidth) {
		return sceneWidth / 2;
	}

	return Math.min(sceneWidth - half, Math.max(half, place));
}

/**
 * What a change of place from `current` to `next` does: `follow` it at once
 * when it is under 1.5 rem and nothing is fading; `fade` for a larger one;
 * `retarget` whenever a fade is already running (its jump takes the new place).
 */
export function yurtMove(
	current: number,
	next: number,
	remPx: number,
	fading: boolean
): "follow" | "fade" | "retarget" {
	if (fading) {
		return "retarget";
	}

	return Math.abs(next - current) < FOLLOW_REM * remPx ? "follow" : "fade";
}

/** What the follower asks of the page. Each scheduler returns its own cancel. */
export interface YurtEffects {
	/** Stand the yurt and its smoke at `px` from the scene's left. */
	place(px: number): void;
	/** Fade the yurt and its smoke out (true) or back in (false). */
	hide(on: boolean): void;
	/** A monotonic clock, in ms. */
	now(): number;
	after(ms: number, fn: () => void): () => void;
	nextFrame(fn: () => void): () => void;
}

/** The scene at a measurement: its width, the page's rem, and the yurt's rendered width, in px. */
export interface YurtScene {
	width: number;
	rem: number;
	yurtWidth: number;
}

export interface YurtFollower {
	/** The scene has become visible. Only the first call counts: it opens the load's window. */
	seen(): void;
	/** One measurement of the column (null: none on screen, or one not laid out). */
	measure(column: Column | null, scene: YurtScene): void;
	/** Where the yurt stands, in px; null while ps.css's 70 % stands. */
	readonly place: number | null;
	readonly fading: boolean;
	/** Cancel a fade in flight; nothing further happens. */
	stop(): void;
}

/**
 * The yurt's follow-or-fade rule over time: each measurement is followed at
 * once, faded to, or taken as a running fade's new target. A fade hides the
 * yurt, waits FADE_MS, places it at the latest target, and shows it on the
 * next frame (re-placing it first if the target moved in between). The first
 * place measured before the scene has been seen, or within SETTLE_MS of the
 * first time it was, is taken at once.
 */
export function yurtFollower(fx: YurtEffects): YurtFollower {
	let shown: number | null = null;
	let target = 0;
	let fading = false;
	let firstSeen: number | null = null;
	let cancelTimer: (() => void) | null = null;
	let cancelFrame: (() => void) | null = null;

	const put = (px: number) => {
		shown = px;
		fx.place(px);
	};

	const reveal = () => {
		cancelFrame = null;

		if (target !== shown) {
			put(target);
		}

		fading = false;
		fx.hide(false);
	};

	const jump = () => {
		cancelTimer = null;
		put(target);
		cancelFrame = fx.nextFrame(reveal);
	};

	/** Nothing placed yet, and the load is still settling (or nobody has seen the scene). */
	const loading = () =>
		shown === null && !fading && (firstSeen === null || fx.now() - firstSeen <= SETTLE_MS);

	return {
		get place() {
			return shown;
		},

		get fading() {
			return fading;
		},

		seen() {
			firstSeen ??= fx.now();
		},

		measure(column, scene) {
			// A scene not laid out yet (display: none until ps.css applies, and a
			// theme switch mounts the scene first) has nothing to stand the yurt
			// on: nothing is placed, so the load's window is not spent on it.
			if (scene.width <= 0) {
				return;
			}

			let next: number;

			if (!column || column.width <= 0) {
				// No column (Settings, Help, the connect form) keeps the place, and
				// a fade in flight still lands where it was going, each clamped to
				// the scene as it is now (a window narrowed there). Before any
				// place, ps.css's 70 % clamps itself.
				if (fading) {
					target = yurtPlace(null, target, scene.width, scene.yurtWidth);
					return;
				}

				if (shown === null) {
					return;
				}

				next = yurtPlace(null, shown, scene.width, scene.yurtWidth);

				if (next === shown) {
					return;
				}
			} else {
				next = yurtPlace(column, shown, scene.width, scene.yurtWidth);

				if (loading()) {
					put(next);
					return;
				}
			}

			const current = shown ?? yurtPlace(null, null, scene.width, scene.yurtWidth);

			switch (yurtMove(current, next, scene.rem, fading)) {
				case "follow":
					if (next !== shown) {
						put(next);
					}

					return;
				case "retarget":
					target = next;
					return;
				case "fade":
					target = next;
					fading = true;
					fx.hide(true);
					cancelTimer = fx.after(FADE_MS, jump);
			}
		},

		stop() {
			cancelTimer?.();
			cancelFrame?.();
			cancelTimer = null;
			cancelFrame = null;
		},
	};
}
