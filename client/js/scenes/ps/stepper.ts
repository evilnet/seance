import type {SceneMotion} from "../../themeScene";

/**
 * The scene's frame rate (docs/projects/ps-theme.md §10.3). Left to the
 * browser, every running animation restyles its element on every main frame,
 * 60 times a second, and each frame moves what the chrome's glass blurs. The
 * plains move slowly; SCENE_FPS frames a second are plenty (the user's call,
 * 2026-10-05). So the scene's own CSS animations and SMIL clocks are held
 * paused, and one timer advances them all together by the real time elapsed,
 * SCENE_FPS times a second: the browser draws a frame only when they move.
 * The ps theme's Scene animation setting picks another pace (stepModeFor):
 * once a second, once every five minutes, or the browser's own playback at
 * the screen's rate, which this hands back to it rather than stepping on a
 * timer that no vsync aligns.
 *
 * Only CSS animations are stepped. Transitions (a layer's fade, the day/night
 * flip, the overcast's cross-fade) run natively, since the scene times its
 * own clean-ups against them. Writes only in a step: reading an animation's
 * state between writes would make the browser restyle once per animation, so
 * what to step is collected by refresh(), which the scene calls when its
 * layers change, and a step only writes. No Vue, no DOM: the scene hands in
 * its animations and its SVGs, so mocha drives it.
 */

/** Frames a second the scene is drawn at by default. 24 divides 120 and 144 Hz screens evenly; on 60 Hz it lands on two vsyncs out of five. */
export const SCENE_FPS = 24;

/** The sparse level's pace: the scene moves on once every five minutes (and on coming back, StepMode.catchUp). */
export const SPARSE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How the stepper moves the scene: the browser's own playback at the screen's
 * rate (`native`), or held and advanced every `interval` ms; `catchUp` steps
 * at once on every start by all the time since the last step, so a scene
 * that moves only now and then is up to date the moment it is looked at.
 */
export type StepMode = {kind: "native"} | {kind: "step"; interval: number; catchUp: boolean};

/** The step mode for a motion level (the ps theme's Scene animation setting); null for off, which never runs. */
export function stepModeFor(motion: SceneMotion): StepMode | null {
	switch (motion) {
		case "off":
			return null;
		case "sparse":
			return {kind: "step", interval: SPARSE_INTERVAL_MS, catchUp: true};
		case "1s":
			return {kind: "step", interval: 1000, catchUp: false};
		case "60":
			return {kind: "native"};
		default:
			return {kind: "step", interval: 1000 / SCENE_FPS, catchUp: false};
	}
}

/** The part of a CSSAnimation the stepper uses. */
export interface StepAnimation {
	readonly playState: string;
	currentTime: number | null | CSSNumberish;
	pause(): void;
	play(): void;
	cancel(): void;
	addEventListener(type: "cancel", listener: () => void): void;
}

/** The part of an SVG root element the stepper uses. */
export interface StepSvg {
	animationsPaused(): boolean;
	pauseAnimations(): void;
	unpauseAnimations(): void;
	getCurrentTime(): number;
	setCurrentTime(seconds: number): void;
}

export interface Stepper {
	/** Move from now on (a resume starts from where it stood, unless the mode catches up). */
	start(): void;
	/** Hold everything where it stands; no timer is left. */
	stop(): void;
	/** Collect what to move again: the scene's animations and SVGs changed. Holds, or plays, whatever is new. */
	refresh(): void;
	/** Read every animation's time again: something other than a step moved them (keepPhase). */
	reread(): void;
	/** Change the pace; a running stepper carries on at the new one. */
	setMode(mode: StepMode): void;
	readonly running: boolean;
}

export function createStepper(deps: {
	/** The scene's CSS animations (not its transitions), its style computed. */
	animations(): StepAnimation[];
	/** The SVGs whose SMIL moves: in a layer in its window, the heat haze only on a hot day. */
	svgs(): StepSvg[];
	now(): number;
	after(ms: number, fn: () => void): () => void;
	mode?: StepMode;
}): Stepper {
	let mode: StepMode = deps.mode ?? {kind: "step", interval: 1000 / SCENE_FPS, catchUp: false};
	let running = false;
	// Each animation's scene time, kept here so a step never reads one back.
	let times = new Map<StepAnimation, number>();
	let svgs: StepSvg[] = [];
	// When the last step was taken (a catching-up mode measures from it).
	let last: number | null = null;
	let cancel: (() => void) | undefined;

	const playing = () => running && mode.kind === "native";

	// An animation its element's style cancels between two refreshes
	// (reduced motion switched on, a layer gone from the render tree) must
	// not be stepped: a time written to a cancelled animation brings it back,
	// held where it was. Its own cancel event drops it, and cancels it again
	// if a step got to it first; a step itself never reads, which would cost
	// a style recalculation each (measured: 48 a second at 24, not 24).
	const watched = new WeakSet<StepAnimation>();

	const watch = (a: StepAnimation) => {
		if (watched.has(a)) {
			return;
		}

		watched.add(a);
		a.addEventListener("cancel", () => {
			if (times.delete(a) && a.playState !== "idle") {
				a.cancel();
			}
		});
	};

	const refresh = () => {
		const next = new Map<StepAnimation, number>();
		const found = deps.animations();

		for (const a of found) {
			next.set(a, times.get(a) ?? Number(a.currentTime ?? 0));
			watch(a);
		}

		// Native playback plays what it finds; every other state holds it.
		for (const a of found) {
			if (playing()) {
				if (a.playState !== "running") {
					a.play();
				}
			} else if (a.playState === "running") {
				a.pause();
			}
		}

		times = next;
		svgs = deps.svgs();

		for (const svg of svgs) {
			if (playing()) {
				if (svg.animationsPaused()) {
					svg.unpauseAnimations();
				}
			} else if (!svg.animationsPaused()) {
				svg.pauseAnimations();
			}
		}
	};

	const step = () => {
		if (mode.kind !== "step") {
			return;
		}

		const now = deps.now();
		const dt = last === null ? 0 : now - last;
		last = now;

		for (const [a, t] of times) {
			const u = t + dt;
			times.set(a, u);
			a.currentTime = u;
		}

		for (const svg of svgs) {
			svg.setCurrentTime(svg.getCurrentTime() + dt / 1000);
		}

		cancel = deps.after(mode.interval, step);
	};

	const start = () => {
		if (running) {
			return;
		}

		running = true;
		// What the animations hold now is the truth: native playback, or
		// another mode, may have moved them since this map was written.
		times = new Map();
		refresh();

		if (mode.kind === "native") {
			return;
		}

		if (mode.catchUp && last !== null) {
			step(); // by all the time since the last step: up to date at once
		} else {
			last = deps.now();
			cancel = deps.after(mode.interval, step);
		}
	};

	const stop = () => {
		if (!running) {
			return;
		}

		cancel?.();
		cancel = undefined;
		running = false;

		if (mode.kind === "native") {
			// A script's play() outlasts animation-play-state: hold them by hand.
			refresh();
		}
	};

	return {
		get running() {
			return running;
		},
		start,
		stop,
		refresh,
		reread() {
			times = new Map();
			refresh();
		},
		setMode(next: StepMode) {
			const was = running;
			stop();
			mode = next;

			if (was) {
				start();
			}
		},
	};
}

/**
 * The time that puts an infinite animation at `progress` (0 to 1) of a loop
 * under its present timing: in the first whole loop after its delay, which
 * may be negative and longer than a loop. The ps scene's clouds keep their
 * place with it when the wind changes their drift's duration (scene.ts):
 * the same time under a shorter loop is another place, and they jumped.
 */
export function keepPhase(progress: number, delay: number, duration: number): number {
	const loop = Math.max(1, Math.ceil(-delay / duration));
	return delay + duration * (loop + progress);
}
