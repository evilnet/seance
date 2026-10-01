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
 * motion is CSS or SVG animation; no script runs per frame. A layer outside
 * its window (the stars by day, the skeins by day, the larks out of season…)
 * is out of the render tree with its SMIL paused, rather than animating at
 * opacity 0 (layers.ts). A hidden page's
 * scene is stopped outright; in a query it is frosted (`ps-private`, ps.css)
 * and completely still, its colours still on the hour (spec §5.7). No Vue,
 * no store; the markup below (and
 * plains.ts's land, near grass, fireflies, yurt, smoke, clouds and weather,
 * and birds.ts's skeins and day birds) is constant for a day's weather, and
 * nothing user-supplied is ever written into it.
 */
import {isPhoneLayout} from "../../helpers/device";
import type {SceneHandle, SceneHostState} from "../../themeScene";
import {birdsAt, dayBirdsMarkup, skeinsMarkup} from "./birds";
import {momentAt, rng, type Moment, type MoonPhase, type Weather} from "./engine";
import {composerAboveGrass, GLASS_TINT_VARS, glassVars} from "./glass";
import {bodyOpacity, publishedFor, type Published} from "./grounds";
import {FADE_MARGIN_MS, GATES, layerGates, liveLayers} from "./layers";
import {levelsAt, paletteAt, WEATHER, type Palette} from "./palette";
import {
	clouds,
	FIREFLIES,
	fireflies,
	landSvg,
	nearGrass,
	smoke,
	weatherClouds,
	weatherLayers,
	yurtSvg,
} from "./plains";
import {yurtFollower} from "./yurt";

const STAR_COUNT = 190;
const RAD = Math.PI / 180;

/** Everything the scene's CSS reads, as custom properties on #theme-scene. */
export function sceneVars(m: Moment, p: Palette): Record<string, string> {
	const wx = WEATHER[m.weather];
	const heat = 1 - Math.max(0, m.sun.alt);
	const glowX = m.sun.up ? Math.min(92, Math.max(8, m.sun.x)) : m.minute < 720 ? 10 : 90;
	const bodies = bodyOpacity(m, p);
	const l = levelsAt(m, p);
	const b = birdsAt(m, p);
	return {
		"--ps-sky-top": p.skyTop,
		"--ps-sky-mid": p.skyMid,
		"--ps-sky-hor": p.skyHorizon,
		"--ps-stars": p.stars.toFixed(3),
		"--ps-milky": p.milky.toFixed(3),
		"--ps-glow": p.glow,
		"--ps-glow-op": p.glowOpacity.toFixed(3),
		"--ps-glow-x": `${glowX.toFixed(2)}%`,
		"--ps-sun-x": `${m.sun.x.toFixed(2)}%`,
		"--ps-sun-y": `${m.sun.y.toFixed(2)}%`,
		"--ps-sun-scale": (1 + 0.45 * heat).toFixed(3),
		"--ps-sun-op": m.sun.up ? bodies.sun.toFixed(2) : "0",
		"--ps-sun-mid": p.sunMid,
		"--ps-sun-edge": p.sunEdge,
		"--ps-sun-flame": p.sunFlame,
		"--ps-sun-bloom": p.sunBloom,
		"--ps-moon-x": `${m.moon.x.toFixed(2)}%`,
		"--ps-moon-y": `${m.moon.y.toFixed(2)}%`,
		"--ps-moon-op": bodies.moon.toFixed(3),
		// The land bands (Palette already carries these; plan 1 never published them).
		"--ps-mount": p.mount,
		"--ps-far": p.far,
		"--ps-hill2": p.hill2,
		"--ps-hill1": p.hill1,
		"--ps-grass": p.grass,
		"--ps-blade": p.blade,
		"--ps-felt": p.felt,
		"--ps-band": p.band,
		"--ps-door": p.door,
		"--ps-cloud": p.cloud,
		"--ps-cloud-under": p.cloudUnder,
		// The derived land and yurt colours (plan 3, palette.ts's mixOklab recipes).
		"--ps-mount2": p.mount2,
		"--ps-tree": p.tree,
		"--ps-trunk": p.trunk,
		"--ps-shrub": p.shrub,
		"--ps-tuft2": p.tuft2,
		"--ps-tuft1": p.tuft1,
		"--ps-tuft-lit": p.tuftLit,
		"--ps-riverbed": p.riverbed,
		"--ps-bedstone": p.bedstone,
		"--ps-river-hi": p.riverHi,
		"--ps-river-sky-top": p.riverSkyTop,
		"--ps-river-sky-bottom": p.riverSkyBottom,
		"--ps-felt-shade": p.feltShade,
		"--ps-roof-top": p.roofTop,
		"--ps-roof-bottom": p.roofBottom,
		"--ps-roof-stroke": p.roofStroke,
		"--ps-band-mark": p.bandMark,
		"--ps-rope": p.rope,
		"--ps-rib": p.rib,
		"--ps-door-orn": p.doorOrn,
		"--ps-crown": p.crown,
		"--ps-pipe": p.pipe,
		"--ps-stone": p.stone,
		"--ps-wood": p.wood,
		// The day's levels.
		"--ps-water": l.water.toFixed(2),
		"--ps-flowers": l.flowers.toFixed(2),
		"--ps-snowcap": l.snowcap.toFixed(2),
		"--ps-ff-op": l.fireflies.toFixed(2),
		"--ps-wind-op": l.wind.toFixed(2),
		"--ps-sway": `${l.sway}deg`,
		"--ps-heat-op": l.heat.toFixed(2),
		"--ps-veil": l.veil.toFixed(2),
		"--ps-veil-c": l.veilColour,
		"--ps-rain-op": wx.rain.toFixed(2),
		"--ps-snow-op": wx.snow.toFixed(2),
		"--ps-tuft-lit-op": l.tuftLit.toFixed(2),
		"--ps-night-glow": p.nightGlow.toFixed(3),
		"--ps-smoke-op": p.smokeOpacity.toFixed(3),
		"--ps-smoke": p.smoke,
		"--ps-dark": p.dark.toFixed(3),
		// The birds (birds.ts): the skeins' layer and how many of its flocks
		// fly, their moonlit inks (N2) and alpha; each day bird's switch and
		// their ink.
		"--ps-skeins-op": b.skeinsOpacity.toFixed(2),
		"--ps-skein-count": String(b.skeins),
		"--ps-bird-ink": b.ink,
		"--ps-bird-wing": b.wing,
		"--ps-bird-belly": b.belly,
		"--ps-bird-alpha": b.alpha.toFixed(3),
		"--ps-buzzard-op": b.buzzard ? "1" : "0",
		"--ps-lark-op": b.larks ? "1" : "0",
		"--ps-db-ink": b.dayInk,
	};
}

/**
 * Whether the weather layer must be rebuilt: on the first tick (nothing built
 * yet) and whenever the day's weather is not the one built — at local
 * midnight with the page open, or on waking into another day. Only the
 * weather that is happening exists in the page (spec §10).
 */
export function weatherChanged(prev: Weather | null, next: Weather): boolean {
	return prev !== next;
}

/**
 * How long the day's own clouds take to fade out and in when the day's
 * weather changes in view (ps.css `.ps-overcast-set`'s transition), in ms.
 */
export const OVERCAST_FADE_MS = 2000;

/**
 * The root's classes: the weather's, from the day's levels (what ps.css keys
 * the wind, the lightning and the haze on), and the skeins' direction
 * (birds.ts: south-west from midsummer on).
 */
export function sceneClasses(
	m: Moment,
	p: Palette
): {"ps-windy": boolean; "ps-storm": boolean; "ps-hot": boolean; "ps-west": boolean} {
	const l = levelsAt(m, p);
	return {
		"ps-windy": l.windy,
		"ps-storm": l.storm,
		"ps-hot": l.hot,
		"ps-west": birdsAt(m, p).west,
	};
}

/**
 * The browser's chrome colour (`<meta name="theme-color">`) for the hour: the
 * sky-top the scene publishes as the page canvas, so the browser's bar runs
 * on into the sky under it (docs/projects/ps-theme.md §6).
 */
export function themeColorFor(published: Published): string {
	return published.canvas;
}

/**
 * The moon's lit shape (heart-theme.md §11.2b): a dark disc, the near half lit,
 * then one ellipse of horizontal radius R·|cos D|, dark for a crescent and lit
 * for a gibbous, the whole mirrored when waning. R is 30 in the moon's viewBox.
 */
export function moonShape(phase: MoonPhase): {rx: number; fill: "#000" | "#fff"; mirror: boolean} {
	const f = phase.waning ? 360 - phase.elongation : phase.elongation;
	return {
		rx: Math.abs(30 * Math.cos(f * RAD)),
		fill: f < 90 ? "#000" : "#fff",
		mirror: phase.waning,
	};
}

/* The mockup's moon and sun, ids prefixed so nothing else on the page can collide. */
const MOON = `<div class="ps-moon"><svg viewBox="-60 -60 120 120">
<defs>
<radialGradient id="ps-m-halo"><stop offset="0" stop-color="#e3e9ff" stop-opacity=".42"/><stop offset=".55" stop-color="#c7d2ff" stop-opacity=".12"/><stop offset="1" stop-color="#c7d2ff" stop-opacity="0"/></radialGradient>
<radialGradient id="ps-m-disc" cx=".42" cy=".4" r=".7"><stop offset="0" stop-color="#fdfaf0"/><stop offset=".62" stop-color="#ece5cf"/><stop offset="1" stop-color="#c9c0a6"/></radialGradient>
<filter id="ps-m-soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.3"/></filter>
<mask id="ps-m-phase" maskUnits="userSpaceOnUse" x="-60" y="-60" width="120" height="120">
<rect x="-60" y="-60" width="120" height="120" fill="#000"/>
<g class="ps-m-shape"><path d="M0,-30 A30,30 0 0 1 0,30 Z" fill="#fff"/><ellipse class="ps-m-ell" rx="0" ry="30" fill="#000"/></g>
</mask>
</defs>
<circle r="60" fill="url(#ps-m-halo)"/>
<circle r="30" fill="#39426a" opacity=".32"/>
<g mask="url(#ps-m-phase)">
<circle r="30" fill="url(#ps-m-disc)"/>
<g filter="url(#ps-m-soft)" fill="#8f8c82" opacity=".5"><ellipse cx="-9" cy="-11" rx="9" ry="7"/><ellipse cx="3" cy="-12" rx="6" ry="5"/><ellipse cx="7" cy="-2" rx="7" ry="6"/><ellipse cx="14" cy="6" rx="4.5" ry="6"/><ellipse cx="-15" cy="3" rx="7" ry="10"/><ellipse cx="-4" cy="10" rx="5" ry="4"/></g>
<g fill="none" stroke="#b6af9c" stroke-width=".7" opacity=".7"><circle cx="-4" cy="21" r="2.4"/><circle cx="17" cy="-15" r="1.8"/><circle cx="-20" cy="-14" r="1.5"/><circle cx="10" cy="18" r="1.4"/><circle cx="21" cy="10" r="1.2"/></g>
<path d="M-4,21 L-11,28 M-4,21 L4,27 M-4,21 L-4,12 M-4,21 L-14,17 M-4,21 L6,16" stroke="#f4efdf" stroke-width=".5" opacity=".35"/>
</g>
</svg></div>`;

const SUN = `<div class="ps-sun"><div class="ps-rays"></div><svg viewBox="-100 -100 200 200">
<defs>
<radialGradient id="ps-s-bloom"><stop offset="0" style="stop-color: var(--ps-sun-bloom)" stop-opacity=".95"/><stop offset=".5" style="stop-color: var(--ps-sun-bloom)" stop-opacity=".25"/><stop offset="1" style="stop-color: var(--ps-sun-bloom)" stop-opacity="0"/></radialGradient>
<radialGradient id="ps-s-flame"><stop offset="0" style="stop-color: var(--ps-sun-flame)"/><stop offset=".6" style="stop-color: var(--ps-sun-flame)" stop-opacity=".8"/><stop offset="1" style="stop-color: var(--ps-sun-edge)" stop-opacity="0"/></radialGradient>
<radialGradient id="ps-s-core" cx=".45" cy=".42" r=".62"><stop offset="0" stop-color="#fffef6"/><stop offset=".38" stop-color="#fff3c2"/><stop offset=".78" style="stop-color: var(--ps-sun-mid)"/><stop offset="1" style="stop-color: var(--ps-sun-edge)"/></radialGradient>
<filter id="ps-s-fire" x="-60%" y="-60%" width="220%" height="220%">
<feTurbulence type="fractalNoise" baseFrequency="0.034 0.052" numOctaves="3" seed="7" result="n"><animate attributeName="baseFrequency" dur="7s" repeatCount="indefinite" values="0.034 0.052;0.046 0.036;0.03 0.06;0.034 0.052"/></feTurbulence>
<feDisplacementMap in="SourceGraphic" in2="n" scale="26" xChannelSelector="R" yChannelSelector="G"/>
<feGaussianBlur stdDeviation="1.2"/>
</filter>
</defs>
<circle r="98" fill="url(#ps-s-bloom)"/>
<g filter="url(#ps-s-fire)"><circle r="56" fill="url(#ps-s-flame)"/></g>
<circle r="37" fill="url(#ps-s-core)"/>
</svg></div>`;

function stars(): string {
	const r = rng(90210);
	let out = "";

	for (let i = 0; i < STAR_COUNT; i++) {
		const big = r() > 0.9;
		const twinkle = r() > 0.72;
		const cls = [big ? "b" : "", twinkle ? "tw" : ""].filter(Boolean).join(" ");
		out +=
			`<i class="${cls}" style="left:${(r() * 100).toFixed(2)}%;top:${(r() * 100).toFixed(
				2
			)}%;` +
			`opacity:${(0.35 + r() * 0.65).toFixed(2)};--tw:${(2.5 + r() * 4).toFixed(1)}s"></i>`;
	}

	return out;
}

/**
 * The scene's layers, back to front (docs/projects/ps-theme.md §5.1): the sky
 * is the root's own background; then the Milky Way, the stars, the horizon
 * glow, the moon and the sun; the clouds (the weather's own, left empty
 * here for the first tick to build, behind the five); the ground group —
 * the land and river, the fireflies, the yurt and its smoke, the animal
 * layer (switched off in ps.css) — which the heat haze bends as one; the
 * near grass in front of it, outside the haze; the birds (birds.ts: the
 * skeins, then the steppe's own by day), each an <svg> of its own, so
 * mount's pause holds their wingbeats; then the weather's veil, and the
 * weather layer, left empty here: the first tick builds the day's weather
 * into it (mount's `apply`), and a new day's weather replaces it (and the
 * weather's own clouds with it). A phone (the phone layout at mount)
 * gets half the fireflies. All of them sit in one wrapper, `.ps-frost`, the
 * one group the private view blurs (spec §5.7: one filtered group is one
 * raster); the sky stays the root's own.
 */
export function sceneMarkup(phone: boolean): string {
	return (
		`<div class="ps-frost">` +
		`<div class="ps-milky"></div><div class="ps-stars">${stars()}</div><div class="ps-glow"></div>` +
		MOON +
		SUN +
		`<div class="ps-cloud-field"><div class="ps-overcast"></div>${clouds()}</div>` +
		`<div class="ps-ground">` +
		landSvg() +
		`<div class="ps-fireflies">${fireflies(phone ? FIREFLIES / 2 : FIREFLIES)}</div>` +
		`<div class="ps-yurt">${yurtSvg()}</div>` +
		`<div class="ps-smoke">${smoke()}</div>` +
		`<div class="ps-animals"></div>` +
		`</div>` +
		nearGrass() +
		`<div class="ps-skeins">${skeinsMarkup()}</div>` +
		`<div class="ps-daybirds">${dayBirdsMarkup()}</div>` +
		`<div class="ps-veil"></div>` +
		`<div class="ps-weather"></div>` +
		`</div>`
	);
}

/**
 * Keeps the yurt in the message column's far third (yurt.ts, spec §5.3). It
 * observes `#chat .chat` — MessageList.vue's scroll container; not `#chat`,
 * which holds the user list too — and the scene itself, and hands each
 * measurement to the follow-or-fade rule, which writes `--ps-yurt-left` on
 * the root and toggles `ps-yurt-moving`; a scene not laid out yet (no box
 * until ps.css shows it) places nothing. A conversation switch can replace
 * the column, so it is looked for again on every host update and whenever
 * the one observed leaves the page; with no column on screen (Settings,
 * Help, the connect form) the yurt keeps its place, clamped to the scene as
 * it is. Each measurement carries the yurt's own width (its computed width,
 * not its box on screen, which the private view's frost scales), so the
 * place is clamped with the whole yurt in the scene, and `seen()` (the
 * scene's first visible update) starts the load's window, in which the first
 * place measured is taken without a fade.
 */
function placeYurt(root: HTMLElement): {seen(): void; refind(): void; destroy(): void} {
	const yurt = root.querySelector(".ps-yurt") as HTMLElement;
	const follower = yurtFollower({
		place: (px) => root.style.setProperty("--ps-yurt-left", `${px.toFixed(2)}px`),
		hide: (on) => root.classList.toggle("ps-yurt-moving", on),
		now: () => performance.now(),
		after(ms, fn) {
			const id = window.setTimeout(fn, ms);
			return () => window.clearTimeout(id);
		},
		nextFrame(fn) {
			const id = window.requestAnimationFrame(fn);
			return () => window.cancelAnimationFrame(id);
		},
	});
	let column: Element | null = null;
	let frame: number | undefined;

	const measure = () => {
		const scene = root.getBoundingClientRect();
		const box = column?.isConnected ? column.getBoundingClientRect() : null;
		follower.measure(
			box && box.width > 0 ? {left: box.left - scene.left, width: box.width} : null,
			{
				width: scene.width,
				rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
				yurtWidth: parseFloat(getComputedStyle(yurt).width) || 0,
			}
		);
	};

	// The column and the scene itself: the theme switch mounts the scene
	// before ps.css applies, while #theme-scene is still display: none and
	// measures 0 × 0 (the column's first observation then places nothing), and
	// its display fires an observation of its own; so does the window
	// narrowing with no column, which clamps the kept place again.
	const observer = new ResizeObserver(() => {
		measure();

		if (!column?.isConnected) {
			findSoon(); // it left the page; its replacement, if any, is there by the next frame
		}
	});

	observer.observe(root);

	function find() {
		const found = document.querySelector("#chat .chat");

		if (found === column) {
			return;
		}

		if (column) {
			observer.unobserve(column);
		}

		column = found;

		if (column) {
			observer.observe(column); // its first observation measures it
		}
	}

	// Also on the next frame: the host's update comes before Vue has patched
	// the page, and a ResizeObserver callback must not start observing itself.
	function findSoon() {
		if (frame === undefined) {
			frame = window.requestAnimationFrame(() => {
				frame = undefined;
				find();
			});
		}
	}

	return {
		seen: () => follower.seen(),
		refind() {
			find();
			findSoon();
		},
		destroy() {
			observer.disconnect();
			follower.stop();

			if (frame !== undefined) {
				window.cancelAnimationFrame(frame);
				frame = undefined;
			}

			root.classList.remove("ps-yurt-moving");
		},
	};
}

/**
 * Marks <html> `ps-form-tall` while the composer's top edge stands above the
 * near grass (glass.ts composerAboveGrass), so ps.css gives it the float tint
 * (the controller's ruling, task 7b fix round 1). One ResizeObserver
 * watches #form (a reply bar, a longer draft, a font step), #viewport (a
 * touch keyboard: #viewport follows --viewport-height while the scene stays
 * on the layout viewport) and the scene itself: the theme switch mounts the
 * scene before ps.css applies (settings.ts calls setTheme before it swaps the
 * link), while #theme-scene is still display: none and measures 0 × 0, and
 * its display then fires an observation. A new #form also rises into place
 * (ps.css ps-rise: 8 px, a transform no observer sees), so the end of its
 * own animation checks again. Each check reads both boxes afresh, as
 * placeYurt's measure does; the window's resize checks too. #form is looked
 * for again on every host update and whenever the one observed leaves the
 * page; with none on the page (the connect form) there is no class.
 */
function watchComposer(root: HTMLElement, html: HTMLElement): {refind(): void; destroy(): void} {
	let form: Element | null = null;
	let viewport: Element | null = null;
	let frame: number | undefined;

	const check = () => {
		html.classList.toggle(
			"ps-form-tall",
			!!form?.isConnected &&
				composerAboveGrass(form.getBoundingClientRect(), root.getBoundingClientRect())
		);
	};

	const observer = new ResizeObserver(() => {
		if (form?.isConnected) {
			check();
		} else {
			findSoon(); // it left the page; its replacement, if any, is there by the next frame
		}
	});

	observer.observe(root);
	const onResize = () => check();

	// Its own entrance only: animations inside it bubble here too.
	const onSettled = (event: Event) => {
		if (event.target === form) {
			check();
		}
	};

	const listen = (el: Element, on: boolean) => {
		for (const type of ["animationend", "animationcancel"]) {
			if (on) {
				el.addEventListener(type, onSettled);
			} else {
				el.removeEventListener(type, onSettled);
			}
		}
	};

	function find() {
		const nextForm = document.getElementById("form");
		const nextViewport = document.getElementById("viewport");

		if (nextForm !== form) {
			if (form) {
				observer.unobserve(form);
				listen(form, false);
			}

			form = nextForm;

			if (form) {
				observer.observe(form); // its first observation checks it
				listen(form, true);
			} else {
				html.classList.remove("ps-form-tall");
			}
		}

		if (nextViewport !== viewport) {
			if (viewport) {
				observer.unobserve(viewport);
			}

			viewport = nextViewport;

			if (viewport) {
				observer.observe(viewport);
			}
		}
	}

	// Also on the next frame, as placeYurt does: the host's update comes before Vue has patched the page.
	function findSoon() {
		if (frame === undefined) {
			frame = window.requestAnimationFrame(() => {
				frame = undefined;
				find();
			});
		}
	}

	window.addEventListener("resize", onResize);

	return {
		refind() {
			find();
			findSoon();
		},
		destroy() {
			observer.disconnect();
			window.removeEventListener("resize", onResize);

			if (form) {
				listen(form, false);
			}

			if (frame !== undefined) {
				window.cancelAnimationFrame(frame);
				frame = undefined;
			}

			html.classList.remove("ps-form-tall");
		},
	};
}

export function mount(root: HTMLElement, initial: SceneHostState): SceneHandle {
	const html = document.documentElement;
	const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
	root.innerHTML = sceneMarkup(isPhoneLayout());
	const ellipse = root.querySelector(".ps-m-ell") as SVGEllipseElement;
	const shape = root.querySelector(".ps-m-shape") as SVGGElement;
	const weatherLayer = root.querySelector(".ps-weather") as HTMLElement;
	const overcast = root.querySelector(".ps-overcast") as HTMLElement;
	// The weather the layer holds: none until the first tick builds the day's.
	let built: Weather | null = null;
	// A fade of the weather's own clouds under way: ends it now (the outgoing out of the page).
	let endFade: (() => void) | undefined;
	// The theme's own theme-color, kept to hand back on destroy; and the last
	// colour the scene wrote, so a destroy after something else has written the
	// tag (the next theme's colour, the deploy's) leaves that alone.
	const meta = document.querySelector('meta[name="theme-color"]');
	const themeColor = meta instanceof HTMLMetaElement ? meta.content : null;
	let wrote: string | null = null;
	let timer: number | undefined;
	let visible = false;

	// Whose SMIL runs while the scene does: nothing in a layer out of the
	// render tree (layers.ts), and the heat haze only while it bends the
	// ground (ps-hot). Only the svgs whose state differs are touched.
	const syncSvgs = () => {
		const run = !root.classList.contains("ps-paused");
		const hot = root.classList.contains("ps-hot");

		for (const svg of root.querySelectorAll("svg")) {
			const live =
				run && !svg.closest(".ps-off") && (hot || !svg.classList.contains("ps-heat-haze"));

			if (live === svg.animationsPaused()) {
				if (live) {
					svg.unpauseAnimations();
				} else {
					svg.pauseAnimations();
				}
			}
		}
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

	// The day's own clouds (plains.ts `weatherClouds`) are one set in the
	// overcast, `.ps-overcast-set`. A new day's replaces the old at once, or,
	// when `fade` (the minute's tick crossing midnight on a page in view, the
	// scene running), cross-fades with it (the user dislikes clouds popping):
	// the incoming set is put in at 0 and its style computed there, so its
	// transition runs as the class comes off; the outgoing fades to 0 and
	// leaves the page once its fade is over, as a gated layer does.
	const buildOvercast = (weather: Weather, fade: boolean) => {
		endFade?.();
		const markup = weatherClouds(weather);
		const leaving = [...overcast.children];
		const set = markup ? document.createElement("div") : null;

		if (set) {
			set.className = "ps-overcast-set";
			set.innerHTML = markup;
		}

		if (!fade) {
			overcast.replaceChildren(...(set ? [set] : []));
			return;
		}

		for (const el of leaving) {
			el.classList.add("ps-leaving");
		}

		if (set) {
			set.classList.add("ps-arriving");
			overcast.prepend(set); // behind the outgoing, which fades off it
			void getComputedStyle(set).opacity;
			set.classList.remove("ps-arriving");
		}

		if (leaving.length > 0) {
			const wait = window.setTimeout(() => endFade?.(), OVERCAST_FADE_MS + FADE_MARGIN_MS);

			endFade = () => {
				window.clearTimeout(wait);
				endFade = undefined;
				leaving.forEach((el) => el.remove());
			};
		}
	};

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
			buildOvercast(m.weather, fade && built !== null);
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

		// After the rebuild, so the haze exists before ps-hot asks for it.
		for (const [name, on] of Object.entries(sceneClasses(m, p))) {
			root.classList.toggle(name, on);
		}

		// The new weather's SMIL, and the haze's with ps-hot. A layer built
		// while the scene is stopped (reduced motion) starts stopped.
		syncSvgs();

		const lit = moonShape(m.phase);
		ellipse.setAttribute("rx", lit.rx.toFixed(2));
		ellipse.setAttribute("fill", lit.fill);
		shape.setAttribute("transform", lit.mirror ? "scale(-1,1)" : "");
		root.dataset.weather = m.weather;
		root.dataset.season = m.season.main;
		const out = publishedFor(p, m);
		html.dataset.psLight = out.light;
		html.dataset.psText = out.text;
		html.style.setProperty("--ps-halo", out.halo);
		html.style.setProperty("--canvas-bg-color", out.canvas);

		// The luminous day glass's tints, one per surface (glass.ts); none at night.
		for (const [name, value] of Object.entries(glassVars(m, out.light))) {
			if (value === null) {
				html.style.removeProperty(name);
			} else {
				html.style.setProperty(name, value);
			}
		}

		if (meta instanceof HTMLMetaElement) {
			wrote = themeColorFor(out);
			meta.content = wrote;
		}
	};

	const motion = (run: boolean) => {
		root.classList.toggle("ps-paused", !run);
		syncSvgs();
	};

	// A query's scene is frosted and completely still (spec §5.7): ps.css
	// blurs it under ps-private, and it is paused as a hidden page's is, its
	// SVG clocks too; the minute's tick keeps running while the page is
	// visible, so its colours still follow the hour. A hidden page stops it
	// whatever the view.
	let privateView = false;
	const running = () => visible && !reduced.matches && !privateView;
	const onReduced = () => motion(running());

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

	const update = (state: SceneHostState) => {
		root.dataset.view = state.view;
		privateView = state.view === "query";
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
			endFade?.();
			motion(false);
		} else {
			motion(running()); // a query opened or left: still or running again
		}
	};

	const handle: SceneHandle = {
		update,
		destroy() {
			window.clearTimeout(timer);
			timer = undefined;
			gates.stop();
			endFade?.();
			reduced.removeEventListener("change", onReduced);
			yurt?.destroy();
			composer?.destroy();
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
			delete html.dataset.psLight;
			delete html.dataset.psText;
			html.style.removeProperty("--ps-halo");
			html.style.removeProperty("--canvas-bg-color");

			for (const name of GLASS_TINT_VARS) {
				html.style.removeProperty(name);
			}

			if (meta instanceof HTMLMetaElement && themeColor !== null && meta.content === wrote) {
				meta.content = themeColor;
			}
		},
	};

	// From the first listener on, a throw (a bad moment in the first tick, a
	// failed measurement) takes down everything already built (observers,
	// listeners, frames, the minute's timer, what was written on <html>)
	// before it reaches the host, whose daylight fallback would otherwise
	// stand over a scene still running. The first error is the one reported.
	try {
		reduced.addEventListener("change", onReduced);
		yurt = placeYurt(root);
		composer = watchComposer(root, html);
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
