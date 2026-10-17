/**
 * The ps theme's NG scene (ps NG plan 1): classic's scene, still. The same
 * markup (scenes/ps/markup.ts) with every SMIL element taken out and every
 * svg's clock paused, its own stylesheet (styles.ts: no animation, no
 * transition, the in-flight layers out, each cloud at rest on its path), and
 * classic's gates applied at once, without fades. Its weather layer is
 * classic's with the rain in viewport-sized tiles (rain.ts) and never the heat
 * haze, and it never sets `ps-hot`. Once a minute while the page is visible
 * (and at once when it is shown) it writes the moment as classic does and
 * publishes exactly what classic publishes (publish.ts). It imports nothing
 * from scenes/ps/scene.ts, so classic's stepper, birds runtime and fades
 * never ride along.
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
import {overcastBuilder, placeYurt, watchComposer, watchLand} from "../ps/watchers";
import {GROUPS, groupOverride, groupsFor} from "./groups";
import {rainTiles} from "./rain";
import {NG_STILL_CSS} from "./styles";
import {phaseSeconds, tierFor, type Tier} from "./tiers";

const MOTION_CLASSES = [...GROUPS.map((g) => `psng-m-${g}`), "psng-calm"];
const SMIL = "animate, animateMotion, animateTransform, set";

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
	let yurt: ReturnType<typeof placeYurt> | undefined;
	let composer: ReturnType<typeof watchComposer> | undefined;
	let land: ReturnType<typeof watchLand> | undefined;
	let latest = initial;
	let reduceMotion = systemAccessibility().reduceMotion;
	let unsubscribe: (() => void) | undefined;
	const only = groupOverride(storage);
	const mounted = new Date();
	let tier: Tier = "still";

	// Exactly the classes of the tier's running groups; the rest come off. On a move from still (the
	// mount's included) the phase first, so the animations the classes start begin in it.
	const setGroups = () => {
		const next = tierFor(latest, reduceMotion);

		if (tier === "still" && next !== "still") {
			root.style.setProperty("--psng-t", `${phaseSeconds(new Date(), mounted)}s`);
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
	};

	const apply = (now: Date) => {
		const m = momentAt(now);
		const p = paletteAt(m);
		const vars = sceneVars(m, p);

		// The day's own clouds (weatherClouds: no SMIL) and its weather, replaced at once, together.
		if (weatherChanged(built, m.weather)) {
			overcast?.build(m.weather, false);

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
		root.dataset.view = state.view;
		root.classList.toggle("ps-private", state.view === "query");
		yurt?.refind();
		composer?.refind();

		if (state.visible && !visible) {
			visible = true;
			yurt?.seen();
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
			timer = undefined;
			unsubscribe?.();
			overcast?.end();
			yurt?.destroy();
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
		root.innerHTML = sceneMarkup(isPhoneLayout());
		stripSmil(root);
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
		yurt = placeYurt(root);
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
