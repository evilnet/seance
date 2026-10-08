import {expect} from "chai";
import {
	momentAt,
	momentFor,
	sunTimes,
	WEATHERS,
	type Weather,
} from "../../../client/js/scenes/ps/engine";
import {publishedFor} from "../../../client/js/scenes/ps/grounds";
import {birdsAt, dayBirdsMarkup, skeinsMarkup} from "../../../client/js/scenes/ps/birds";
import {paletteAt} from "../../../client/js/scenes/ps/palette";
import {clouds, FIREFLIES, smoke, yurtSvg} from "../../../client/js/scenes/ps/plains";
import {
	moonShape,
	sceneClasses,
	sceneMarkup,
	sceneVars,
	themeColorFor,
	weatherChanged,
} from "../../../client/js/scenes/ps/scene";

const days = (iso: string) => Date.parse(iso) / 86400000;

describe("ps scene: what it writes", function () {
	it("shows the sun by day and not the moon", function () {
		const {rise, set} = sunTimes(172);
		const m = momentFor({
			minute: (rise + set) / 2,
			doy: 172,
			dayNumber: 20626,
			epochDays: days("2026-09-26T12:00:00Z"),
			weather: "clear",
		});
		const v = sceneVars(m, paletteAt(m));
		expect(v["--ps-sun-op"]).to.equal("1.00");
		expect(v["--ps-moon-op"]).to.equal("0.000");
		expect(v["--ps-sun-scale"]).to.equal("1.000");
	});

	it("shows a full moon at night, and none at all on a new moon", function () {
		const night = (iso: string) =>
			momentFor({
				minute: 30,
				doy: 269,
				dayNumber: 20722,
				epochDays: days(iso),
				weather: "clear",
			});
		const full = night("2026-09-26T16:52:00Z");
		expect(Number(sceneVars(full, paletteAt(full))["--ps-moon-op"])).to.be.greaterThan(0.9);
		expect(sceneVars(full, paletteAt(full))["--ps-sun-op"]).to.equal("0");
		const fresh = night("2026-10-10T16:00:00Z");
		expect(sceneVars(fresh, paletteAt(fresh))["--ps-moon-op"]).to.equal("0.000");
	});

	it("hides the sun behind rain in proportion to the weather", function () {
		const {rise, set} = sunTimes(121);
		const m = momentFor({
			minute: (rise + set) / 2,
			doy: 121,
			dayNumber: 20574,
			epochDays: 20574,
			weather: "rain",
		});
		expect(sceneVars(m, paletteAt(m))["--ps-sun-op"]).to.equal("0.35");
	});

	it("draws the phase with one ellipse, mirrored when waning", function () {
		expect(
			moonShape({elongation: 0, illumination: 0, waning: false, present: false})
		).to.deep.equal({rx: 30, fill: "#000", mirror: false});
		expect(
			moonShape({elongation: 90, illumination: 0.5, waning: false, present: true}).rx
		).to.be.closeTo(0, 1e-9);
		expect(
			moonShape({elongation: 180, illumination: 1, waning: false, present: true})
		).to.deep.include({fill: "#fff"});
		expect(
			moonShape({elongation: 300, illumination: 0.25, waning: true, present: true})
		).to.deep.include({mirror: true, fill: "#000"});
	});

	it("gives the browser's theme-color the hour's sky-top, the colour it publishes as the canvas", function () {
		const {rise, set} = sunTimes(172);

		for (const minute of [0, rise, (rise + set) / 2, set, 1380]) {
			const m = momentFor({
				minute,
				doy: 172,
				dayNumber: 20626,
				epochDays: 20626,
				weather: "clear",
			});
			const published = publishedFor(paletteAt(m), m);
			expect(themeColorFor(published)).to.equal(published.canvas);
			expect(themeColorFor(published)).to.equal(paletteAt(m).skyTop);
		}
	});
});

describe("ps scene: plan 3's land, yurt and level vars", function () {
	const HEX = /^#[0-9a-f]{6}$/;

	function moment() {
		const doy = 213;
		const {rise, set} = sunTimes(doy);
		return momentFor({
			minute: (rise + set) / 2,
			doy,
			dayNumber: 20626,
			epochDays: 20626,
			weather: "clear",
		});
	}

	it("writes every land band, derived colour and river-sky stop as a hex custom property", function () {
		const m = moment();
		const v = sceneVars(m, paletteAt(m));
		const HEX_NAMES = [
			"--ps-mount",
			"--ps-far",
			"--ps-hill2",
			"--ps-hill1",
			"--ps-grass",
			"--ps-blade",
			"--ps-felt",
			"--ps-band",
			"--ps-door",
			"--ps-cloud",
			"--ps-cloud-under",
			"--ps-mount2",
			"--ps-tree",
			"--ps-trunk",
			"--ps-shrub",
			"--ps-tuft2",
			"--ps-tuft1",
			"--ps-tuft-lit",
			"--ps-riverbed",
			"--ps-bedstone",
			"--ps-river-hi",
			"--ps-river-sky-top",
			"--ps-river-sky-bottom",
			"--ps-felt-shade",
			"--ps-roof-top",
			"--ps-roof-bottom",
			"--ps-roof-stroke",
			"--ps-band-mark",
			"--ps-rope",
			"--ps-rib",
			"--ps-door-orn",
			"--ps-crown",
			"--ps-pipe",
			"--ps-stone",
			"--ps-wood",
		];

		for (const name of HEX_NAMES) {
			expect(v[name], name).to.match(HEX);
		}

		// The worn path is gone (the user, 2026-09-25), and so is its colour.
		expect(v).to.not.have.property("--ps-path");
	});

	it("writes the day's levels as numbers, sway in degrees, and the veil's colour as its own string", function () {
		const m = moment();
		const p = paletteAt(m);
		const v = sceneVars(m, p);
		const NUMERIC_NAMES = [
			"--ps-water",
			"--ps-flowers",
			"--ps-snowcap",
			"--ps-ff-op",
			"--ps-wind-op",
			"--ps-heat-op",
			"--ps-veil",
			"--ps-tuft-lit-op",
			"--ps-night-glow",
			"--ps-smoke-op",
			"--ps-dark",
		];

		for (const name of NUMERIC_NAMES) {
			expect(Number.isNaN(Number(v[name])), name).to.equal(false);
		}

		expect(v["--ps-sway"]).to.match(/^-?[\d.]+deg$/);
		expect(v["--ps-veil-c"]).to.match(/^#[0-9a-f]{6}$/);
		expect(v["--ps-smoke"]).to.match(/^rgb\(/);
		expect(v["--ps-dark"]).to.equal(p.dark.toFixed(3));
	});
});

describe("ps scene: the birds' vars and the flight's direction (plan 3 task 6)", function () {
	const HEX = /^#[0-9a-f]{6}$/;
	const night = (doy: number, weather: Weather = "clear") =>
		momentFor({minute: 1380, doy, dayNumber: 20574, epochDays: 20574.9, weather});

	it("writes what birds.ts says: the skeins' layer and count, the moonlit inks and alpha, the day birds and their ink", function () {
		for (const m of [night(121), night(305, "storm"), night(213)]) {
			const p = paletteAt(m);
			const b = birdsAt(m, p);
			const v = sceneVars(m, p);
			expect(v["--ps-skeins-op"]).to.equal(b.skeinsOpacity.toFixed(2));
			expect(v["--ps-skein-count"]).to.equal(String(b.skeins));
			expect(v["--ps-bird-ink"]).to.equal(b.ink);
			expect(v["--ps-bird-wing"]).to.equal(b.wing);
			expect(v["--ps-bird-belly"]).to.equal(b.belly);
			expect(v["--ps-bird-alpha"]).to.equal(b.alpha.toFixed(3));
			expect(v["--ps-buzzard-op"]).to.equal(b.buzzard ? "1" : "0");
			expect(v["--ps-lark-op"]).to.equal(b.larks ? "1" : "0");
			expect(v["--ps-db-ink"]).to.equal(b.dayInk);

			for (const name of [
				"--ps-bird-ink",
				"--ps-bird-wing",
				"--ps-bird-belly",
				"--ps-db-ink",
			]) {
				expect(v[name], name).to.match(HEX);
			}
		}

		expect(sceneVars(night(121), paletteAt(night(121)))["--ps-skeins-op"]).to.equal("1.00");
		expect(sceneVars(night(121), paletteAt(night(121)))["--ps-skein-count"]).to.equal("3");
		// No skein in a storm (the user, 2026-09-26); snow still flies one.
		const storm = sceneVars(night(305, "storm"), paletteAt(night(305, "storm")));
		expect([storm["--ps-skeins-op"], storm["--ps-skein-count"]]).to.deep.equal(["0.00", "0"]);
		const snow = sceneVars(night(305, "snow"), paletteAt(night(305, "snow")));
		expect([snow["--ps-skeins-op"], snow["--ps-skein-count"]]).to.deep.equal(["1.00", "1"]);
		expect(sceneVars(night(213), paletteAt(night(213)))["--ps-skeins-op"]).to.equal("0.00");
	});

	it("no longer writes plan 3's provisional residents level: each day bird has its own", function () {
		const v = sceneVars(night(121), paletteAt(night(121)));
		expect(v).to.not.have.property("--ps-residents-op");
	});

	it("flies west from midsummer on (ps-west), east before", function () {
		const west = (doy: number) => sceneClasses(night(doy), paletteAt(night(doy)))["ps-west"];
		expect(west(121)).to.equal(false);
		expect(west(189)).to.equal(false);
		expect(west(190)).to.equal(true);
		expect(west(305)).to.equal(true);
	});
});

describe("ps scene: the day's weather (plan 3 task 4)", function () {
	function at(weather: Weather, minute?: number) {
		const doy = 200;
		const {rise, set} = sunTimes(doy);
		return momentFor({
			minute: minute ?? (rise + set) / 2,
			doy,
			dayNumber: 20653,
			epochDays: 20653,
			weather,
		});
	}

	it("rebuilds the weather layer when the day's weather is new: first, or changed", function () {
		expect(weatherChanged(null, "rain")).to.equal(true);
		expect(weatherChanged(null, "clear")).to.equal(true);
		expect(weatherChanged("clear", "rain")).to.equal(true);
		expect(weatherChanged("rain", "clear")).to.equal(true);
		expect(weatherChanged("rain", "rain")).to.equal(false);

		for (const w of WEATHERS) {
			expect(weatherChanged(w, w), w).to.equal(false);
		}
	});

	it("sees the change at local midnight with the page open: a rainy 26 September, a clear 27th", function () {
		// Local dates, so the day is the same in any timezone the suite runs in.
		const before = momentAt(new Date(2026, 8, 26, 23, 59, 50));
		const after = momentAt(new Date(2026, 8, 27, 0, 0, 10));
		expect(before.weather).to.equal("rain");
		expect(after.weather).to.equal("clear");
		expect(weatherChanged(before.weather, after.weather)).to.equal(true);
		// And within the day the layer is left alone.
		const noon = momentAt(new Date(2026, 8, 26, 12, 0));
		expect(weatherChanged(noon.weather, before.weather)).to.equal(false);
	});

	it("turns the day's booleans into the root's classes: windy, storm, hot", function () {
		const classes = (weather: Weather, minute?: number) => {
			const m = at(weather, minute);
			return sceneClasses(m, paletteAt(m));
		};

		expect(classes("clear")).to.deep.equal({
			"ps-windy": false,
			"ps-storm": false,
			"ps-hot": false,
			"ps-west": true,
		});
		expect(classes("wind")).to.deep.include({"ps-windy": true, "ps-storm": false});
		// A storm blows too (its wind is 0.6, over the 0.5 line), as the mockup's.
		expect(classes("storm")).to.deep.include({"ps-windy": true, "ps-storm": true});
		expect(classes("rain")).to.deep.include({"ps-windy": false, "ps-storm": false});
		expect(classes("heat")).to.deep.include({"ps-hot": true});
		// Hot only while the day is light: a heat day's midnight is not.
		expect(classes("heat", 0)).to.deep.include({"ps-hot": false});
	});

	it("writes the rain's and the snow's opacity, the mockup's --rain-op and --snow-op", function () {
		const vars = (weather: Weather) => {
			const m = at(weather);
			return sceneVars(m, paletteAt(m));
		};

		expect(vars("rain")["--ps-rain-op"]).to.equal("0.90");
		expect(vars("storm")["--ps-rain-op"]).to.equal("1.00");
		expect(vars("clear")["--ps-rain-op"]).to.equal("0.00");
		expect(vars("snow")["--ps-snow-op"]).to.equal("0.95");
		expect(vars("rain")["--ps-snow-op"]).to.equal("0.00");
	});
});

describe("ps scene: the layers it builds (sceneMarkup)", function () {
	/** The class of every top-level element in `markup`, in order. */
	function topLevel(markup: string): string[] {
		const out: string[] = [];
		let depth = 0;

		for (const m of markup.matchAll(/<(\/?)(div|svg)\b([^>]*)>/g)) {
			if (m[1]) {
				depth--;
			} else {
				if (depth === 0) {
					out.push(/class="([^"]*)"/.exec(m[3])?.[1] ?? "");
				}

				depth++;
			}
		}

		return out;
	}

	/** The inside of the first `<div class="${name}">…</div>` in `markup`, nested divs included. */
	function inside(markup: string, name: string): string {
		const open = `<div class="${name}">`;
		const start = markup.indexOf(open);
		expect(start, name).to.be.at.least(0);
		let depth = 0;

		for (const m of markup.slice(start).matchAll(/<(\/?)div\b[^>]*>/g)) {
			depth += m[1] ? -1 : 1;

			if (depth === 0) {
				return markup.slice(start + open.length, start + m.index!);
			}
		}

		throw new Error(`${name} is not closed`);
	}

	it("wraps every layer in one .ps-frost, the one group the private view blurs (spec §5.7)", function () {
		for (const phone of [false, true]) {
			const markup = sceneMarkup(phone);
			expect(topLevel(markup)).to.deep.equal(["ps-frost"]);
			expect(markup.startsWith('<div class="ps-frost">')).to.equal(true);
			expect(markup.endsWith("</div>")).to.equal(true);
			expect(`<div class="ps-frost">${inside(markup, "ps-frost")}</div>`).to.equal(markup);
		}
	});

	it("puts the layers in the spec's order (§5.1): sky things, the bodies, the clouds, the ground, the near grass, the birds, the veil, the weather", function () {
		expect(topLevel(inside(sceneMarkup(false), "ps-frost"))).to.deep.equal([
			"ps-milky",
			"ps-stars",
			"ps-glow",
			"ps-moon",
			"ps-sun",
			"ps-cloud-field",
			"ps-ground",
			"ps-blades",
			"ps-skeins",
			"ps-daybirds",
			"ps-veil",
			"ps-weather",
		]);
	});

	it("flies birds.ts's skeins and the steppe's own birds in their layers, the same on a phone", function () {
		for (const phone of [false, true]) {
			const markup = sceneMarkup(phone);
			expect(inside(markup, "ps-skeins")).to.equal(skeinsMarkup());
			expect(inside(markup, "ps-daybirds")).to.equal(dayBirdsMarkup());
		}
	});

	it("builds every bird at mount as an <svg> of its own in the root, so the pause holds every wingbeat", function () {
		// mount's motion() calls pauseAnimations() on every <svg> in the root,
		// and sceneMarkup is the root's whole content at mount: a SMIL
		// animation anywhere but inside an <svg> of the markup would escape it.
		const markup = sceneMarkup(false);
		let svgDepth = 0;
		let smil = 0;

		for (const m of markup.matchAll(
			/<(\/?)(svg|animate|animateTransform|animateMotion)\b[^>]*?(\/?)>/g
		)) {
			if (m[2] === "svg") {
				svgDepth += m[1] ? -1 : m[3] ? 0 : 1;
			} else if (!m[1]) {
				smil++;
				expect(svgDepth, m[0].slice(0, 60)).to.be.greaterThan(0);
			}
		}

		expect(svgDepth).to.equal(0);
		// The sun's fire (1), the skeins' 38 birds (3 each), the buzzard (2) and three larks (2 each).
		expect(smil).to.equal(1 + 38 * 3 + 2 + 3 * 2);
		expect(inside(markup, "ps-skeins").match(/<svg viewBox="0 0 32 20"/g)).to.have.length(38);
	});

	it("drifts plains.ts's five clouds in the cloud field, behind the weather's own, left empty: the first tick builds the day's", function () {
		for (const phone of [false, true]) {
			const field = inside(sceneMarkup(phone), "ps-cloud-field");
			expect(field).to.equal(`<div class="ps-overcast"></div>${clouds()}`);
			expect(topLevel(field)).to.deep.equal([
				"ps-overcast",
				"ps-cloud",
				"ps-cloud",
				"ps-cloud",
				"ps-cloud",
				"ps-cloud",
			]);
		}
	});

	it("leaves the veil and the weather layer empty: the first tick builds the day's weather", function () {
		for (const phone of [false, true]) {
			const markup = sceneMarkup(phone);
			expect(inside(markup, "ps-veil")).to.equal("");
			expect(inside(markup, "ps-weather")).to.equal("");
			expect(markup).to.not.include('id="ps-heat"');

			for (const layer of ["ps-rain", "ps-snow", "ps-seeds", "ps-flash", "ps-heatband"]) {
				expect(markup, layer).to.not.include(`class="${layer}"`);
			}
		}
	});

	it("holds the land, the fireflies, the yurt, its smoke and the animal layer in the ground group, in that order", function () {
		// The yurt after the fireflies, as the mockup's ground has it; the smoke
		// inside the group too (the plan's ruling), so the heat haze bends it.
		const ground = inside(sceneMarkup(false), "ps-ground");
		expect(topLevel(ground)).to.deep.equal([
			"ps-land",
			"ps-fireflies",
			"ps-yurt",
			"ps-smoke",
			"ps-animals",
		]);
	});

	it("builds the yurt from plains.ts and the smoke's five puffs", function () {
		const markup = sceneMarkup(false);
		expect(inside(markup, "ps-yurt")).to.equal(yurtSvg());
		expect(inside(markup, "ps-smoke")).to.equal(smoke());
	});

	it("halves the fireflies on a phone", function () {
		const count = (phone: boolean) =>
			inside(sceneMarkup(phone), "ps-fireflies").match(/<i /g)?.length ?? 0;
		expect(count(false)).to.equal(FIREFLIES);
		expect(count(true)).to.equal(FIREFLIES / 2);
	});

	it("keeps plan 1's 190 stars", function () {
		expect(inside(sceneMarkup(false), "ps-stars").match(/<i /g)).to.have.length(190);
	});

	it("builds the same markup every time", function () {
		expect(sceneMarkup(false)).to.equal(sceneMarkup(false));
	});
});
