/**
 * The ps theme's scene (docs/projects/ps-theme.md §3, §5): the plains behind
 * the whole app. Mounted into #theme-scene by the theme-scene hook
 * (client/js/themeScene.ts). It builds its elements once, then once a minute
 * (and whenever the page becomes visible) writes the engine's and the
 * palette's answer as custom properties on its root, and publishes on <html>
 * the four values the chrome reads, the day glass's four tints (glass.ts;
 * none at night), and the hour's sky as the browser's `theme-color`. The
 * weather layer holds the day's weather alone, rebuilt when the day's
 * weather changes with the day's own clouds (rain's four, the storm's
 * deck: plains.ts `weatherClouds`), and the root carries its classes
 * (`ps-windy`, `ps-storm`, `ps-hot`) and the skeins' direction (`ps-west`).
 * It keeps the yurt in the message column's far third (placeYurt). All
 * motion is CSS or SVG animation, held paused and advanced together
 * SCENE_FPS times a second by one timer (stepper.ts) rather than at the
 * screen's rate, or at the pace the Scene animation setting picks (the
 * host's `motion`: off, every five minutes, once a second, 24, or the
 * browser's own). A layer outside
 * its window (the stars by day, the skeins by day, the larks out of season…)
 * is out of the render tree with its SMIL paused, rather than animating at
 * opacity 0 (layers.ts). A hidden page's
 * scene is stopped outright; one nobody attends to rests, still, as a query's
 * does; in a query it is frosted (`ps-private`, ps.css)
 * and completely still, its colours still on the hour (spec §5.7). No Vue,
 * no store; the markup below (and
 * plains.ts's land, near grass, fireflies, yurt, smoke, clouds and weather,
 * and birds.ts's skeins and day birds) is constant for a day's weather, and
 * nothing user-supplied is ever written into it.
 */
import {isPhoneLayout} from "../../helpers/device";
import {onSystemAccessibility, systemAccessibility} from "../../helpers/systemAccessibility";
import type {SceneHandle, SceneHostState} from "../../themeScene";
import {momentAt, type Weather} from "./engine";
import {createStepper, keepPhase, stepModeFor} from "./stepper";
import {GATES, layerGates, liveLayers} from "./layers";
import {sceneClasses, sceneMarkup, sceneVars, weatherChanged} from "./markup";
import {paletteAt} from "./palette";
import {weatherLayers} from "./plains";
import {publishMoment, unpublish} from "./publish";
import {overcastBuilder, placeYurt, watchComposer, watchLand} from "./watchers";

// Moved to markup.ts, watchers.ts and grounds.ts; re-exported for classic's tests.
export {
	MOON,
	moonShape,
	sceneClasses,
	sceneMarkup,
	sceneVars,
	STAR_COUNT,
	stars,
	SUN,
	weatherChanged,
} from "./markup";
export {OVERCAST_FADE_MS} from "./watchers";

/** The clouds' drift animations, the wind's to keep in place (apply). */
function driftsOf(root: HTMLElement): Animation[] {
	return [...root.querySelectorAll(".ps-cloud")].flatMap((el) =>
		el.getAnimations().filter((a) => (a as CSSAnimation).animationName === "ps-drift")
	);
}

export function mount(root: HTMLElement, initial: SceneHostState): SceneHandle {
	const html = document.documentElement;
	const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
	root.innerHTML = sceneMarkup(isPhoneLayout());
	const weatherLayer = root.querySelector(".ps-weather") as HTMLElement;
	const overcast = overcastBuilder(root.querySelector(".ps-overcast") as HTMLElement);
	// The weather the layer holds: none until the first tick builds the day's.
	let built: Weather | null = null;
	// The theme's own theme-color, kept to hand back on destroy; and the last
	// colour the scene wrote, so a destroy after something else has written the
	// tag (the next theme's colour, the deploy's) leaves that alone.
	const found = document.querySelector('meta[name="theme-color"]');
	const meta = found instanceof HTMLMetaElement ? found : null;
	const themeColor = meta ? meta.content : null;
	let wrote: string | null = null;
	let timer: number | undefined;
	let visible = false;

	// Every SVG clock stays paused and every CSS animation in the scene is
	// held: the stepper advances them SCENE_FPS times a second while the
	// scene runs (stepper.ts). Of the SMIL it steps none in a layer out of
	// the render tree (layers.ts), and the heat haze's only while it bends
	// the ground (ps-hot). syncSvgs is called whenever those change.
	let sceneMotion = initial.motion;
	const stepper = createStepper({
		mode: stepModeFor(sceneMotion) ?? undefined,
		animations: () =>
			root
				.getAnimations({subtree: true})
				// CSS animations only (a CSSTransition has no animationName).
				.filter((a): a is CSSAnimation => "animationName" in a),
		svgs() {
			const hot = root.classList.contains("ps-hot");
			return [...root.querySelectorAll("svg")].filter(
				(svg) => !svg.closest(".ps-off") && (hot || !svg.classList.contains("ps-heat-haze"))
			);
		},
		now: () => performance.now(),
		after(ms, fn) {
			const id = window.setTimeout(fn, ms);
			return () => window.clearTimeout(id);
		},
	});

	const syncSvgs = () => {
		for (const svg of root.querySelectorAll("svg")) {
			if (!svg.animationsPaused()) {
				svg.pauseAnimations();
			}
		}

		stepper.refresh();
	};

	// The layers with a window (layers.ts): out of the render tree outside it.
	const gates = layerGates({
		set(gate, off) {
			const {selector, index} = GATES[gate];
			const all = root.querySelectorAll(selector);

			for (const el of index === undefined ? [...all] : [all[index]]) {
				el?.classList.toggle("ps-off", off);
			}

			syncSvgs();
		},
		flush() {
			return getComputedStyle(root).opacity; // reading it computes the page's style
		},
		after(ms, fn) {
			const id = window.setTimeout(fn, ms);
			return () => window.clearTimeout(id);
		},
	});
	let applied = false;

	const apply = (now: Date, fade: boolean) => {
		const m = momentAt(now);
		const p = paletteAt(m);
		const vars = sceneVars(m, p);

		// Only the day's weather exists in the page (spec §10): a new day's
		// replaces yesterday's, built for the layout as it is now, and so do
		// its own clouds (the five drift on, never rebuilt). Before the
		// gates, so a new heat band is gated with the rest; nothing in the
		// weather layer transitions, and the overcast's fade computes its own
		// start, so the style the gates may compute first changes nothing
		// there.
		if (weatherChanged(built, m.weather)) {
			weatherLayer.innerHTML = weatherLayers(m.weather, isPhoneLayout());
			overcast.build(m.weather, fade && built !== null);
			built = m.weather;
			// The weather layer's gated elements are new: the gates decide them afresh.
			gates.forget("seeds");
			gates.forget("heatband");
		}

		gates.apply(
			liveLayers(vars),
			() => {
				for (const [name, value] of Object.entries(vars)) {
					root.style.setProperty(name, value);
				}
			},
			!applied
		);
		applied = true;

		// After the rebuild, so the haze exists before ps-hot asks for it. The
		// wind changes the clouds' drift's duration (ps.css ps-windy), and the
		// same time under another loop length is another place: each cloud is
		// put back at its place in its loop under the new one.
		const classes = sceneClasses(m, p);
		const windChanges = classes["ps-windy"] !== root.classList.contains("ps-windy");
		const drifts = windChanges ? driftsOf(root) : [];
		const places = drifts.map((a) => a.effect?.getComputedTiming().progress ?? null);

		for (const [name, on] of Object.entries(classes)) {
			root.classList.toggle(name, on);
		}

		if (drifts.length > 0) {
			drifts.forEach((a, i) => {
				const place = places[i];
				const timing = a.effect?.getTiming();

				if (place !== null && timing) {
					a.currentTime = keepPhase(place, Number(timing.delay), Number(timing.duration));
				}
			});
			stepper.reread();
		}

		// The new weather's SMIL, and the haze's with ps-hot. A layer built
		// while the scene is stopped (reduced motion) starts stopped.
		syncSvgs();

		wrote = publishMoment(root, html, meta, m, p);
	};

	const motion = (run: boolean) => {
		root.classList.toggle("ps-paused", !run);
		syncSvgs();

		if (run) {
			stepper.start();
		} else {
			stepper.stop();
		}
	};

	// A query's scene is frosted and completely still (spec §5.7): ps.css
	// blurs it under ps-private, and it is paused as a hidden page's is, its
	// SVG clocks too; the minute's tick keeps running while the page is
	// visible, so its colours still follow the hour. A hidden page stops it
	// whatever the view. A page nobody attends to (themeScene.ts
	// createAttention: a desktop window without the focus, or left without
	// input) rests the same way, so neither the scene nor the glass over it
	// is redrawn while no one looks; it moves on from where it stood.
	let privateView = false;
	let attended = initial.attended;
	const running = () =>
		visible &&
		attended &&
		sceneMotion !== "still" &&
		!reduced.matches &&
		!systemAccessibility().reduceMotion &&
		!privateView;
	const onReduced = () => motion(running());
	let stopFollowingMotion: (() => void) | undefined;

	// Once now, then on each minute boundary. The next minute is scheduled
	// whatever this one's apply does: one bad minute throws (and is reported),
	// and the scene still draws the next rather than freezing. Only the
	// minute's own tick on a running scene fades the day's clouds: the catch-up
	// of a page coming into view (the day changed while it was hidden) draws
	// the day as it is.
	const tick = (live: boolean) => {
		const now = new Date();

		try {
			apply(now, live && running());
		} finally {
			timer = window.setTimeout(
				() => tick(true),
				60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 20
			);
		}
	};

	// Built in mount's try below; a half-built mount's destroy skips what is missing.
	let yurt: ReturnType<typeof placeYurt> | undefined;
	let composer: ReturnType<typeof watchComposer> | undefined;
	let land: ReturnType<typeof watchLand> | undefined;

	const update = (state: SceneHostState) => {
		root.dataset.view = state.view;
		privateView = state.view === "query";
		attended = state.attended;

		// The Scene animation setting: a new pace (stepper.ts), or off, which
		// holds the scene as a rest does.
		if (state.motion !== sceneMotion) {
			sceneMotion = state.motion;
			const mode = stepModeFor(sceneMotion);

			if (mode) {
				stepper.setMode(mode);
			}
		}

		root.classList.toggle("ps-private", privateView);
		yurt?.refind();
		composer?.refind();

		if (state.visible && !visible) {
			visible = true;
			yurt?.seen(); // the first time opens the load's window (yurt.ts SETTLE_MS)
			motion(running());
			tick(false); // catch up at once: a laptop that slept shows the right sky
		} else if (!state.visible && visible) {
			visible = false;
			window.clearTimeout(timer);
			timer = undefined;
			gates.settle(); // no fade is seen on a hidden page, and no timer runs there
			overcast.end();
			motion(false);
		} else {
			motion(running()); // a query opened or left: still or running again
		}
	};

	const handle: SceneHandle = {
		update,
		destroy() {
			stepper.stop();
			window.clearTimeout(timer);
			timer = undefined;
			gates.stop();
			overcast.end();
			reduced.removeEventListener("change", onReduced);
			stopFollowingMotion?.();
			yurt?.destroy();
			composer?.destroy();
			land?.destroy();
			root.replaceChildren();
			root.removeAttribute("style");
			root.classList.remove(
				"ps-paused",
				"ps-private",
				"ps-windy",
				"ps-storm",
				"ps-hot",
				"ps-west"
			);
			delete root.dataset.view;
			delete root.dataset.weather;
			delete root.dataset.season;
			unpublish(html, meta, themeColor, wrote);
		},
	};

	// From the first listener on, a throw (a bad moment in the first tick, a
	// failed measurement) takes down everything already built (observers,
	// listeners, frames, the minute's timer, what was written on <html>)
	// before it reaches the host, whose daylight fallback would otherwise
	// stand over a scene still running. The first error is the one reported.
	try {
		reduced.addEventListener("change", onReduced);
		// The Android shell reports Remove animations itself: its WebView
		// answers the media query with the value its process started with.
		stopFollowingMotion = onSystemAccessibility(onReduced);
		yurt = placeYurt(root);
		composer = watchComposer(root, html);
		land = watchLand(root);
		// A scene mounted into a hidden page starts stopped; the first visible update starts it.
		motion(false);
		update(initial);
	} catch (error) {
		try {
			handle.destroy();
		} catch {
			// the mount's own error is the one to rethrow
		}

		throw error;
	}

	return handle;
}
