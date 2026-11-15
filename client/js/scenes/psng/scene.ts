/**
 * The ps theme's NG scene (ps NG plan 1): classic's scene, still. The same
 * markup (scenes/ps/markup.ts) with every SMIL element taken out and every
 * svg's clock paused, its own stylesheet (styles.ts: no animation, no
 * transition, the in-flight layers out, each cloud at rest on its path), and
 * classic's gates applied at once, without fades. Its weather layer is
 * classic's with the rain in viewport-sized tiles (rain.ts) and never the heat
 * haze, and it never sets `ps-hot`. Once a minute while the page is visible
 * (and at once when it is shown) it writes and publishes the moment (publish.ts).
 */
import {isPhoneLayout} from "../../helpers/device";
import {onSystemAccessibility, systemAccessibility} from "../../helpers/systemAccessibility";
import storage from "../../localStorage";
import type {SceneHandle, SceneHostState} from "../../themeScene";
import {momentAt, type Weather} from "../ps/engine";
import {GATES, liveLayers, type Gate} from "../ps/layers";
import {sceneClasses, sceneMarkup, sceneVars, weatherChanged} from "../ps/markup";
import {paletteAt} from "../ps/palette";
import {HEAT_HAZE, weatherLayers} from "../ps/plains";
import {publishMoment, unpublish} from "../ps/publish";
import {overcastBuilder, watchComposer, watchLand} from "../ps/watchers";
import {fireDriver, ngSun} from "./flame";
import {GROUPS, groupOverride, groupsFor} from "./groups";
import {ngBirds} from "./poses";
import {rainTiles} from "./rain";
import {NG_STILL_CSS} from "./styles";
import {phaseSeconds, tierFor, type Tier} from "./tiers";

/** How long the scene stays still after the phone's drawer closes: its 160 ms slide, and some margin. */
export const RELEASE_MS = 400;
const MOTION_CLASSES = [...GROUPS.map((g) => `psng-m-${g}`), "psng-calm"];
const SMIL = "animate, animateMotion, animateTransform, set";
/** What a freeze pins inline. */
const PINNED = ["transform", "opacity"] as const;

/** Every SMIL element under `el` out of the page. */
const stripSmil = (el: Element) => el.querySelectorAll(SMIL).forEach((s) => s.remove());

/**
 * The day's weather as classic draws it (plains.ts `weatherLayers`, halved on a phone), but never
 * the heat haze, and the rain as viewport-sized tiles (rain.ts) in classic's place among the layers.
 */
function weatherMarkup(weather: Weather): string {
	return weatherLayers(weather, isPhoneLayout())
		.replace(HEAT_HAZE, "")
		.replace(/<div class="ps-rain">(.*?)<\/div>/, (_, drops: string) =>
			rainTiles(drops.split("<i ").length - 1, {
				width: window.innerWidth,
				height: window.innerHeight,
			})
		);
}

export function mount(root: HTMLElement, initial: SceneHostState): SceneHandle {
	const html = document.documentElement;
	const found = document.querySelector('meta[name="theme-color"]');
	const meta = found instanceof HTMLMetaElement ? found : null;
	const themeColor = meta ? meta.content : null;
	let wrote: string | null = null;
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(NG_STILL_CSS);
	let timer: number | undefined;
	let visible = false;
	let built: Weather | null = null;
	let overcast: ReturnType<typeof overcastBuilder> | undefined;
	let weatherLayer: HTMLElement | undefined;
	let composer: ReturnType<typeof watchComposer> | undefined;
	let land: ReturnType<typeof watchLand> | undefined;
	let latest = initial;
	let reduceMotion = systemAccessibility().reduceMotion;
	let unsubscribe: (() => void) | undefined;
	const only = groupOverride(storage);
	const mounted = new Date();
	let tier: Tier = "still";
	let fire: ReturnType<typeof fireDriver> | undefined;
	let sunLive = false;
	let sunOn = false;
	let held = false;
	// Each frozen element with its own inline transform and opacity from before the pins (a
	// twinkling star's opacity is inline), put back as they were on thaw.
	let frozen: {el: HTMLElement; saved: [string, string][]}[] | null = null;
	let frozenAt: number | null = null;
	let restedS = 0; // seconds spent frozen since the mount, off --psng-t
	let viewport: HTMLElement | null = null;
	let drawer: MutationObserver | undefined;
	let release: number | undefined;

	// The fire's frame loop runs only in the full tier, with the sun's group on and its gate live;
	// anywhere else no frame is requested (calm keeps the one frame it has painted).
	const syncFire = () => {
		if (tier === "full" && sunOn && sunLive) {
			fire?.start();
		} else {
			fire?.stop();
		}
	};

	// A rest that ends on its own (the window left for another, a hidden page, a query) freezes the
	// scene where it stands instead of snapping it to its still places: each running animation's
	// transform and opacity pinned inline, then every animation removed (psng-frozen), the group
	// classes kept so nothing leaves the page. Its clock stops too: the time spent frozen is taken
	// off --psng-t, so the loops go on from where they stood. Reduced motion, the setting at Still and
	// the phone's drawer snap as before (the drawer: a read at a drag's start would cost its frame).
	const freeze = () => {
		const pins: [HTMLElement, string, string][] = [];

		for (const a of root.getAnimations?.({subtree: true}) ?? []) {
			const effect = a.effect as KeyframeEffect | null;
			const el = effect?.target as HTMLElement | null | undefined;

			if (!el || effect?.pseudoElement) {
				continue;
			}

			const touched = new Set(effect!.getKeyframes().flatMap((k) => Object.keys(k)));
			const cs = getComputedStyle(el);
			pins.push([
				el,
				touched.has("transform") ? cs.transform : "",
				touched.has("opacity") ? cs.opacity : "",
			]);
		}

		// The elements' own inline values, read before any pin is written.
		frozen = pins.map(([el]) => ({
			el,
			saved: PINNED.map((p): [string, string] => [
				el.style.getPropertyValue(p),
				el.style.getPropertyPriority(p),
			]),
		}));

		// Every read before any write: one style pass, not one per element.
		for (const [el, transform, opacity] of pins) {
			if (transform) {
				el.style.setProperty("transform", transform, "important");
			}

			if (opacity) {
				el.style.setProperty("opacity", opacity, "important");
			}
		}

		frozenAt = Date.now();
		root.classList.add("psng-frozen");
	};

	const thaw = () => {
		for (const {el, saved} of frozen ?? []) {
			PINNED.forEach((p, i) => {
				const [value, priority] = saved[i];

				if (value) {
					el.style.setProperty(p, value, priority);
				} else {
					el.style.removeProperty(p);
				}
			});
		}

		if (frozenAt !== null) {
			restedS += (Date.now() - frozenAt) / 1000;
		}

		frozen = null;
		frozenAt = null;
		root.classList.remove("psng-frozen");
	};

	// Exactly the classes of the tier's running groups; the rest come off. On a move from still (the
	// mount's included) the phase first, so the animations the classes start begin in it.
	const setGroups = () => {
		const next = held ? "still" : tierFor(latest, reduceMotion);
		const pause = next === "still" && !held && !reduceMotion && latest.motion !== "still";

		if (frozen && !pause) {
			thaw();
		}

		if (pause) {
			if (tier !== "still") {
				freeze();
				tier = next;
				sunOn = false;
				syncFire();
			}

			return;
		}

		// Only out of still: calm → full keeps --psng-t, since a rewrite would jump the clouds already
		// running; the groups full adds start from the phase written on the last still → moving move.
		if (tier === "still" && next !== "still") {
			root.style.setProperty("--psng-t", `${phaseSeconds(new Date(), mounted) - restedS}s`);
		}

		tier = next;
		const on = new Set(groupsFor(tier, only).values());
		const classes = new Set([...on].map((g) => `psng-m-${g}`));

		if (tier === "calm") {
			classes.add("psng-calm");
		}

		for (const name of MOTION_CLASSES) {
			root.classList.toggle(name, classes.has(name));
		}

		sunOn = on.has("sun");
		syncFire();
	};

	// On the phone layout the sidebar is a drawer whose live blur re-samples the scene every frame
	// of its slide; with the full tier moving behind it the slide lagged on an iPhone (calm and
	// still did not). While it is out (open, or following a finger) the scene is still: its
	// animations removed, not paused — a paused animation still costs iOS's compositor about what a
	// running one does (plan 1's ladder: paused 25, none 1.1). On the desktop menu-open only means
	// the sidebar is shown, so it holds nothing there.
	const syncHold = () => {
		const cls = viewport?.classList;
		const next =
			!!cls &&
			(cls.contains("menu-open") || cls.contains("menu-dragging")) &&
			isPhoneLayout();

		window.clearTimeout(release);
		release = undefined;

		if (next && !held) {
			held = true;
			setGroups();
		} else if (!next && held) {
			// Bringing the groups back costs the phone ~45 ms of style work (measured over USB): done
			// mid-slide it dropped the closing drawer's last frames, so it waits for the slide (160 ms).
			release = window.setTimeout(() => {
				release = undefined;
				held = false;
				setGroups();
			}, RELEASE_MS);
		}
	};

	// #viewport is the app's, which may mount after the scene: looked for again on each update.
	const findViewport = () => {
		if (viewport?.isConnected) {
			return;
		}

		drawer?.disconnect();
		viewport = document.getElementById("viewport");

		if (viewport) {
			drawer = new MutationObserver(syncHold);
			drawer.observe(viewport, {attributes: true, attributeFilter: ["class"]});
		}

		syncHold();
	};

	const apply = (now: Date) => {
		const m = momentAt(now);
		const p = paletteAt(m);
		const vars = sceneVars(m, p);

		// The day's own clouds (weatherClouds: no SMIL) and its weather, replaced at once, together.
		if (weatherChanged(built, m.weather)) {
			overcast?.build(m.weather);

			if (weatherLayer) {
				weatherLayer.innerHTML = weatherMarkup(m.weather);
				stripSmil(weatherLayer);
			}

			built = m.weather;
		}

		const live = liveLayers(vars);

		for (const gate of Object.keys(GATES) as Gate[]) {
			const {selector, index} = GATES[gate];
			const all = root.querySelectorAll(selector);

			for (const el of index === undefined ? [...all] : [all[index]]) {
				el?.classList.toggle("ps-off", !live[gate]);
			}
		}

		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
		}

		sunLive = live.sun;

		// A sun below its gate needs no fire frame: a night mount never computes one.
		if (sunLive) {
			fire?.setColours(p.sunFlame, p.sunEdge);
		}

		syncFire();

		// Never ps-hot: it asks for the heat haze, which NG never builds.
		for (const [name, on] of Object.entries(sceneClasses(m, p))) {
			root.classList.toggle(name, on && name !== "ps-hot");
		}

		wrote = publishMoment(root, html, meta, m, p);
	};

	// Once now, then on each minute boundary; the next minute is scheduled whatever this one does.
	const tick = () => {
		const now = new Date();

		try {
			apply(now);
		} finally {
			timer = window.setTimeout(
				tick,
				60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 20
			);
		}
	};

	const update = (state: SceneHostState) => {
		latest = state;
		setGroups();
		findViewport();
		root.dataset.view = state.view;
		root.classList.toggle("ps-private", state.view === "query");
		composer?.refind();

		if (state.visible && !visible) {
			visible = true;
			tick(); // synchronously, so a cold start paints the right sky
		} else if (!state.visible && visible) {
			visible = false;
			window.clearTimeout(timer);
			timer = undefined;
		}
	};

	const handle: SceneHandle = {
		update,
		destroy() {
			window.clearTimeout(timer);
			window.clearTimeout(release);
			timer = undefined;
			unsubscribe?.();
			drawer?.disconnect();
			fire?.destroy();
			composer?.destroy();
			land?.destroy();
			unpublish(html, meta, themeColor, wrote);
			document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
			root.replaceChildren();
			root.removeAttribute("style");
			root.classList.remove(
				"psng",
				"ps-private",
				"ps-windy",
				"ps-storm",
				"ps-hot",
				"ps-west",
				"psng-frozen",
				...MOTION_CLASSES
			);
			delete root.dataset.view;
			delete root.dataset.weather;
			delete root.dataset.season;
		},
	};

	// A throw anywhere in the mount takes down what was built before it reaches the host.
	try {
		root.classList.add("psng");
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
		// The birds rebuilt from their SMIL before it goes (poses.ts): wing poses, the buzzard in boxes.
		root.innerHTML = ngSun(ngBirds(sceneMarkup(isPhoneLayout())));
		stripSmil(root);
		const canvas = root.querySelector(".ps-fire");

		if (canvas && typeof (canvas as HTMLCanvasElement).getContext === "function") {
			fire = fireDriver(canvas as HTMLCanvasElement);
		}

		// Still with no SMIL left, but paused so nothing (the sun's filter) keeps a clock running.
		root.querySelectorAll("svg").forEach((svg) => svg.pauseAnimations());
		// The near grass sways as one box (styles.ts): its svg in a div.psng-sway, once.
		const blades = root.querySelector(".ps-blades");

		if (blades) {
			const sway = document.createElement("div");
			sway.className = "psng-sway";
			blades.replaceWith(sway);
			sway.append(blades);
		}

		overcast = overcastBuilder(root.querySelector(".ps-overcast") as HTMLElement);
		weatherLayer = root.querySelector(".ps-weather") as HTMLElement;
		composer = watchComposer(root, html);
		land = watchLand(root);
		unsubscribe = onSystemAccessibility((a) => {
			reduceMotion = a.reduceMotion;
			setGroups();
		});
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
