import {expect} from "chai";
import {
	contrast,
	hexRgb,
	luminance,
	mix,
	mixOklab,
	shift,
} from "../../../client/js/scenes/ps/colour";
import {momentFor, sunTimes} from "../../../client/js/scenes/ps/engine";
import {
	GLASS_NIGHT_AT,
	LAND,
	levelsAt,
	paletteAt,
	REF,
	SEASON_LAND,
	STOPS,
	stopsAt,
	TEXT_LIGHT_AT,
	WEATHER,
} from "../../../client/js/scenes/ps/palette";
import {publishedFor} from "../../../client/js/scenes/ps/grounds";

const COLOURS = [
	"top",
	"mid",
	"hor",
	"mount",
	"far",
	"hill2",
	"hill1",
	"grass",
	"blade",
	"felt",
	"band",
	"door",
	"cloud",
	"under",
	"glow",
] as const;

/** A moment at a given canonical position on a given day. Only valid for `canon` in [390, 1155] (daytime): outside it, `canonical()`'s night branch is not linear, so the inverse used here does not land where it says. */
function at(
	canon: number,
	doy: number,
	weather: "clear" | "rain" | "storm" | "wind" | "snow" | "heat" = "clear"
) {
	const {rise, set} = sunTimes(doy);
	const minute = rise + ((canon - 390) / (1155 - 390)) * (set - rise);
	return momentFor({minute, doy, dayNumber: 20000, epochDays: 20000, weather});
}

/** A moment at a real local minute on a given day (for night and dusk moments `at()` cannot reach). */
function localAt(
	minute: number,
	doy: number,
	weather: "clear" | "rain" | "storm" | "wind" | "snow" | "heat" = "clear"
) {
	return momentFor({minute, doy, dayNumber: 20000, epochDays: 20000, weather});
}

describe("ps colour arithmetic", function () {
	it("mixes in sRGB the way the mockup did", function () {
		expect(mix("#000000", "#ffffff", 0.5)).to.equal("#808080");
		expect(mix("#102030", "#102030", 0.3)).to.equal("#102030");
		expect(shift("#808080", "#000000", "#101010", 1)).to.equal("#909090");
		expect(shift("#f0f0f0", "#000000", "#404040", 1)).to.equal("#ffffff");
		expect(hexRgb("#0a0b0c")).to.deep.equal([10, 11, 12]);
	});

	it("measures WCAG contrast", function () {
		expect(contrast("#000000", "#ffffff")).to.be.closeTo(21, 1e-9);
		expect(luminance("#ffffff")).to.be.closeTo(1, 1e-9);
	});

	it("mixes in OKLab the way CSS color-mix(in oklab, …) does, gamut-clamped", function () {
		expect(mixOklab("#ffffff", "#000000", 0.5)).to.equal("#636363");
		expect(mixOklab("#3a2a1c", "#1f3a24", 1)).to.equal("#3a2a1c");
		expect(mixOklab("#3a2a1c", "#1f3a24", 0)).to.equal("#1f3a24");

		for (const [a, b, w] of [
			["#a4b9d6", "#c6dc9c", 0.72],
			["#99cc72", "#1f3a24", 0.55],
			["#152033", "#fff6c8", 0.7],
		] as const) {
			expect(mixOklab(a, b, w)).to.match(/^#[0-9a-f]{6}$/);
		}
	});

	/**
	 * White/black (above) is achromatic in every colour space -- it cannot
	 * tell Cartesian OKLab mixing from polar OKLCH mixing, and a weight of 0
	 * or 1 only exercises mixOklab's early return. These three come from an
	 * INDEPENDENT source: headless Chromium's own `color-mix(in oklab, …)`,
	 * read off a 1×1 canvas with getImageData (review fix round 1, 2026-09-25;
	 * recipe at /claude-settings/jobs/819200df/tmp/oklab-golden.html, run via
	 * tools/browser-drive.mjs --chrome=/seance/tmp/chrome-pw.sh). Re-run twice
	 * and byte-identical both times; alpha was 255 (opaque) throughout, so no
	 * premultiplied-alpha rounding entered the readback. A `color-mix(in
	 * srgb, …)` of pair 1 at the same weight read back #716345 -- different
	 * from oklab's #81694a below, confirming the canvas really interpolated
	 * in OKLab and did not silently fall back to sRGB.
	 *
	 * A polar OKLCH mix of pair 1 (lightness and chroma linear, hue by the
	 * short arc) gives #747202 -- nowhere near Chromium's #81694a -- so this
	 * would catch mixOklab mixing in OKLCH instead of Cartesian OKLab.
	 */
	it("matches Chromium's own color-mix(in oklab, …), read off a canvas", function () {
		expect(mixOklab("#c2562b", "#1f6f5e", 0.5)).to.equal("#81694a");
		expect(mixOklab("#579b3b", "#1f3a24", 0.72)).to.equal("#467e36");
		expect(mixOklab("#b5634b", "#f3e3c6", 0.45)).to.equal("#d9a98d");
	});
});

describe("ps palette: the stops", function () {
	it("keeps the mockup's thirteen stops, midnight to midnight", function () {
		expect(STOPS).to.have.length(13);
		expect(STOPS[0].t).to.equal(0);
		expect(STOPS[12].t).to.equal(1440);

		for (let i = 1; i < STOPS.length; i++) {
			expect(STOPS[i].t).to.be.greaterThan(STOPS[i - 1].t);
		}

		const {t: _a, ...first} = STOPS[0];
		const {t: _b, ...last} = STOPS[12];
		expect(first).to.deep.equal(last);
	});

	it("lands exactly on every stop, so no stop is skipped or doubled", function () {
		for (const stop of STOPS.slice(0, 12)) {
			const s = stopsAt(stop.t);

			for (const c of COLOURS) {
				expect(s[c], `${c} at ${stop.t}`).to.equal(stop[c]);
			}

			expect(s.dark).to.equal(stop.dark);
		}
	});

	it("changes by at most a few steps a minute, so no hour jumps", function () {
		for (let t = 0; t < 1440; t++) {
			const a = stopsAt(t);
			const b = stopsAt(t + 1);

			for (const c of COLOURS) {
				const [x, y] = [hexRgb(a[c]), hexRgb(b[c])];
				const step = Math.max(...x.map((v, i) => Math.abs(v - y[i])));
				expect(step, `${c} at ${t}`).to.be.at.most(8);
			}
		}
	});
});

describe("ps palette: a moment", function () {
	it("paints the season's own land at midsummer noon", function () {
		const p = paletteAt(at(780, 213));

		for (const land of LAND) {
			const [x, y] = [hexRgb(p[land]), hexRgb(SEASON_LAND.summer[land])];
			expect(Math.max(...x.map((v, i) => Math.abs(v - y[i]))), land).to.be.at.most(1);
		}

		expect(REF.grass).to.equal("#69b04a");
	});

	it("greys the clouds and dims the horizon glow in rain", function () {
		const clear = paletteAt(at(1080, 121, "clear"));
		const rain = paletteAt(at(1080, 121, "rain"));
		expect(rain.cloud).to.not.equal(clear.cloud);
		expect(rain.glowOpacity).to.be.closeTo(
			clear.glowOpacity * (1 - WEATHER.rain.hide * 0.8),
			1e-9
		);
	});

	it("burns the sun gold overhead and orange at the horizon", function () {
		const noon = paletteAt(at(772, 172));
		expect(noon.sunMid).to.equal(mix("#ffe07a", "#ff9c3e", 1 - at(772, 172).sun.alt));
		const low = paletteAt(at(391, 172));
		expect(hexRgb(low.sunEdge)[1]).to.be.below(hexRgb(noon.sunEdge)[1]);
	});
});

describe("ps palette: what the chrome reads", function () {
	it("turns the words light from darkness 0.05 (on a snowy noon, where dark ink holds), and the glass at 0.5", function () {
		const m = at(780, 32, "snow");
		const base = paletteAt(m);
		expect(publishedFor({...base, dark: TEXT_LIGHT_AT}, m).text).to.equal("ink");
		expect(publishedFor({...base, dark: TEXT_LIGHT_AT + 0.01}, m).text).to.equal("light");
		expect(publishedFor({...base, dark: GLASS_NIGHT_AT}, m).light).to.equal("day");
		expect(publishedFor({...base, dark: GLASS_NIGHT_AT + 0.01}, m).light).to.equal("night");
	});

	it("haloes daytime ink in the horizon's colour, lifted toward white, and gives the canvas the sky-top", function () {
		const m = at(780, 213);
		const p = paletteAt(m);
		const out = publishedFor(p, m);
		expect(out.halo).to.equal(mix(p.skyHorizon, "#ffffff", 0.55));
		expect(out.canvas).to.equal(p.skyTop);
	});
});

describe("ps palette: plan 3's derived land and yurt colours", function () {
	const MOMENTS = {
		"noon, midsummer": at(780, 213),
		"dusk, full autumn": localAt(sunTimes(305).set + 20, 305),
		"midnight, full winter": localAt(0, 32),
	};

	for (const [name, m] of Object.entries(MOMENTS)) {
		it(`ports the mockup's color-mix recipes verbatim at ${name}`, function () {
			const p = paletteAt(m);
			expect(p.mount2).to.equal(mixOklab(p.mount, p.far, 0.72));
			expect(p.tree).to.equal(mixOklab(p.hill2, "#1f3a24", 0.55));
			expect(p.trunk).to.equal(mixOklab(p.hill2, "#3a2a1c", 0.4));
			expect(p.shrub).to.equal(mixOklab(p.far, "#28402c", 0.55));
			expect(p.tuft2).to.equal(mixOklab(p.hill2, p.blade, 0.72));
			expect(p.tuft1).to.equal(mixOklab(p.hill1, p.blade, 0.7));
			expect(p.tuftLit).to.equal(mixOklab(p.hill1, "#fff6c8", 0.7));
			expect(p.riverbed).to.equal(mixOklab(p.hill1, "#dcc9a0", 0.42));
			expect(p.bedstone).to.equal(mixOklab(p.hill1, "#a99c80", 0.3));
			expect(p.riverHi).to.equal(mixOklab(p.skyHorizon, "#ffffff", 0.6));
			expect(p.riverSkyTop).to.equal(p.skyHorizon);
			expect(p.riverSkyBottom).to.equal(p.skyMid);
			expect(p.feltShade).to.equal(mixOklab(p.felt, "#3a3040", 0.8));
			expect(p.roofTop).to.equal(mixOklab(p.felt, "#ffffff", 0.92));
			expect(p.roofBottom).to.equal(mixOklab(p.felt, "#4a3c3c", 0.78));
			expect(p.roofStroke).to.equal(mixOklab(p.felt, "#5a4a3e", 0.55));
			expect(p.bandMark).to.equal(mixOklab(p.band, "#f3e3c6", 0.45));
			expect(p.rope).to.equal(mixOklab(p.felt, "#5a4636", 0.55));
			expect(p.rib).to.equal(mixOklab(p.felt, "#6a5a4a", 0.72));
			expect(p.doorOrn).to.equal(mixOklab(p.door, "#f3c66a", 0.35));
			expect(p.crown).to.equal(mixOklab(p.felt, "#5a4a3e", 0.6));
			expect(p.pipe).to.equal(mixOklab(p.felt, "#4d4640", 0.3));
			expect(p.stone).to.equal(mixOklab(p.grass, "#a8a39a", 0.45));
			expect(p.wood).to.equal(mixOklab(p.hill1, "#7a5638", 0.3));
			expect(p).to.not.have.property("path");
		});
	}
});

describe("ps palette: plan 3's levels", function () {
	it("dries the river in high summer and runs it full in winter", function () {
		expect(levelsAt(at(780, 213), paletteAt(at(780, 213))).water).to.equal(0);
		expect(levelsAt(localAt(0, 32), paletteAt(localAt(0, 32))).water).to.equal(1);
	});

	it("blooms flowers in spring, half as much from summer alone", function () {
		expect(levelsAt(at(780, 121), paletteAt(at(780, 121))).flowers).to.equal(1);
		expect(levelsAt(at(780, 213), paletteAt(at(780, 213))).flowers).to.be.closeTo(0.55, 1e-9);
	});

	it("caps the snowline in deep winter, or shows it whenever it is snowing", function () {
		const winter = localAt(0, 32);
		expect(levelsAt(winter, paletteAt(winter)).snowcap).to.be.closeTo(1, 1e-9);
		const summer = at(780, 213);
		expect(levelsAt(summer, paletteAt(summer)).snowcap).to.equal(0);
		const snowing = at(780, 213, "snow");
		expect(levelsAt(snowing, paletteAt(snowing)).snowcap).to.be.closeTo(0.9, 1e-9);
	});

	it("lights fireflies on a warm dark evening, never at noon or in the rain", function () {
		const noon = at(780, 213);
		expect(levelsAt(noon, paletteAt(noon)).fireflies).to.equal(0);
		const evening = localAt(22 * 60, 213, "clear");
		expect(levelsAt(evening, paletteAt(evening)).fireflies).to.be.greaterThan(0);
		const rainy = localAt(22 * 60, 213, "rain");
		expect(levelsAt(rainy, paletteAt(rainy)).fireflies).to.equal(0);
	});

	it("blows and sways more in the wind, and settles the weather's own booleans", function () {
		// Midsummer noon: dark 0, season weights all in summer (verified
		// against engine.ts directly). wind × (1 − .6×0) × (0 + .6×1 + .8×0)
		// = 1 × 1 × .6 = .6.
		const m = at(780, 213, "wind");
		const p = paletteAt(m);
		const l = levelsAt(m, p);
		expect(p.dark).to.equal(0);
		expect(m.season.weights).to.deep.equal({winter: 0, spring: 0, summer: 1, autumn: 0});
		expect(l.wind).to.be.closeTo(0.6, 1e-9);
		expect(l.sway).to.equal(WEATHER.wind.sway);
		expect(l.windy).to.equal(true);
		expect(l.storm).to.equal(false);
		const storm = paletteAt(at(780, 213, "storm"));
		expect(levelsAt(at(780, 213, "storm"), storm).storm).to.equal(true);
	});

	it("bakes the day at noon under a heat weather, and only then", function () {
		// Midsummer noon: dark 0, so day = 1. heat × max(0, 1 − .7) / .3 =
		// 1 × .3 / .3 = 1 exactly.
		const noon = at(780, 213, "heat");
		const pNoon = paletteAt(noon);
		const lNoon = levelsAt(noon, pNoon);
		expect(pNoon.dark).to.equal(0);
		expect(lNoon.heat).to.be.closeTo(1, 1e-9);
		expect(lNoon.hot).to.equal(true);
		const night = localAt(0, 213, "heat");
		const pNight = paletteAt(night);
		expect(levelsAt(night, pNight).hot).to.equal(false);
	});

	it("carries the weather's own dim and its colour as the veil", function () {
		const m = at(780, 121, "rain");
		const p = paletteAt(m);
		const l = levelsAt(m, p);
		expect(l.veil).to.equal(WEATHER.rain.dim);
		expect(l.veilColour).to.equal(WEATHER.rain.dimc);
	});

	it("lights the tufts most by day, least at full night", function () {
		const noon = at(780, 213);
		expect(levelsAt(noon, paletteAt(noon)).tuftLit).to.be.closeTo(0.5, 1e-9);
		const midnight = localAt(0, 32);
		const p = paletteAt(midnight);
		expect(levelsAt(midnight, p).tuftLit).to.be.closeTo(Math.max(0, 0.5 - 0.45 * p.dark), 1e-9);
	});

	it("leaves the birds to birds.ts: the approved mockup's timing replaced plan 3's provisional levels", function () {
		const m = localAt(23 * 60, 121);
		expect(levelsAt(m, paletteAt(m))).to.not.have.any.keys(
			"skeins",
			"skeinsWest",
			"residents",
			"birdInk"
		);
	});
});
