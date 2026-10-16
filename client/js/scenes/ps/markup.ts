/**
 * The ps scene's markup and what its CSS reads (docs/projects/ps-theme.md
 * §5): the layers' constant markup, the custom properties and classes the
 * minute writes on the scene's root, and the moon's lit shape. Moved out of
 * scene.ts so a renderer other than classic's can build the same plains
 * without importing scene.ts (and with it the stepper and the gates). No DOM,
 * no Vue, no store: mocha loads it directly.
 */
import {birdsAt, dayBirdsMarkup, skeinsMarkup} from "./birds";
import {rng, type Moment, type MoonPhase, type Weather} from "./engine";
import {bodyOpacity} from "./grounds";
import {levelsAt, WEATHER, type Palette} from "./palette";
import {clouds, FIREFLIES, fireflies, landSvg, nearGrass, smoke, yurtSvg} from "./plains";

export const STAR_COUNT = 190;
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
export const MOON = `<div class="ps-moon"><svg viewBox="-60 -60 120 120">
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

export const SUN = `<div class="ps-sun"><div class="ps-rays"></div><svg viewBox="-100 -100 200 200">
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

export function stars(): string {
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
