import {expect} from "chai";
import {birdsAt} from "../../../client/js/scenes/ps/birds";
import {momentFor, WEATHERS, type Weather} from "../../../client/js/scenes/ps/engine";
import {bodyOpacity} from "../../../client/js/scenes/ps/grounds";
import {
	FADE_MARGIN_MS,
	GATES,
	layerGates,
	liveLayers,
	type Gate,
	type GateEffects,
} from "../../../client/js/scenes/ps/layers";
import {levelsAt, paletteAt} from "../../../client/js/scenes/ps/palette";
import {sceneVars} from "../../../client/js/scenes/ps/scene";

const at = (doy: number, minute: number, weather: Weather) =>
	momentFor({minute, doy, dayNumber: 20574, epochDays: 20574 + minute / 1440, weather});

const liveAt = (doy: number, minute: number, weather: Weather) => {
	const m = at(doy, minute, weather);
	return liveLayers(sceneVars(m, paletteAt(m)));
};

/** The live layers' names, sorted. */
const on = (live: Record<Gate, boolean>) =>
	(Object.keys(live) as Gate[]).filter((g) => live[g]).sort();

describe("ps layers: what is in the render tree (layers.ts, spec §10)", function () {
	describe("liveLayers: a layer is live exactly while it shows", function () {
		it("keeps the sun and the buzzard at a clear noon, and nothing that shows only at night or in season", function () {
			// 25 September: the skeins' passage, but they fly at night; no larks in autumn.
			expect(on(liveAt(268, 725, "clear"))).to.deep.equal(["buzzard", "sun"]);
		});

		it("flies all three skeins at dusk, with the stars, the fireflies and the smoke coming up", function () {
			expect(on(liveAt(268, 1110, "clear"))).to.deep.equal([
				"fireflies",
				"flock0",
				"flock1",
				"flock2",
				"skeins",
				"smoke",
				"stars",
				"sun",
			]);
		});

		it("takes the sun out once it is down", function () {
			expect(liveAt(268, 1325, "clear").sun).to.equal(false);
			expect(on(liveAt(268, 1325, "clear"))).to.not.include("sun");
		});

		it("flies only the first flock on a snowy night: the others leave the tree", function () {
			// And the snow's seeds blow: autumn's wind shows them at night too.
			expect(on(liveAt(268, 1325, "snow"))).to.deep.equal([
				"flock0",
				"seeds",
				"skeins",
				"smoke",
				"stars",
			]);
		});

		it("takes every bird out of the tree in rain and in a storm, at every hour (the user, 2026-09-26)", function () {
			// A rainy or stormy night in the passage: no skein, no flock.
			expect(on(liveAt(268, 1325, "rain"))).to.deep.equal(["seeds", "smoke", "stars"]);
			expect(on(liveAt(268, 1325, "storm"))).to.deep.equal(["seeds", "smoke", "stars"]);
			const BIRDS: Gate[] = ["skeins", "flock0", "flock1", "flock2", "buzzard", "larks"];

			for (const weather of ["rain", "storm"] as const) {
				for (const doy of [15, 60, 100, 121, 182, 268, 300, 340]) {
					for (let minute = 0; minute < 1440; minute += 10) {
						const live = liveAt(doy, minute, weather);
						expect(
							BIRDS.filter((g) => live[g]),
							`day ${doy} ${minute} ${weather}`
						).to.deep.equal([]);
					}
				}
			}
		});

		it("flies no skein on a night with none (1 July: no passage)", function () {
			expect(on(liveAt(182, 1380, "clear"))).to.deep.equal(["fireflies", "smoke", "stars"]);
		});

		it("raises the larks in season and shows the heat band on a hot midday", function () {
			expect(on(liveAt(182, 725, "heat"))).to.deep.equal([
				"buzzard",
				"heatband",
				"larks",
				"sun",
			]);
			expect(on(liveAt(121, 725, "clear")), "1 May").to.deep.equal([
				"buzzard",
				"larks",
				"sun",
			]);
		});

		it("blows the seeds while the wind shows them, and takes them out when it shows none (a snowy 1 February)", function () {
			expect(liveAt(268, 725, "rain").seeds, "a rainy autumn noon").to.equal(true);
			expect(liveAt(288, 725, "wind").seeds, "a windy one").to.equal(true);
			expect(liveAt(268, 725, "clear").seeds, "no wind at all").to.equal(false);
			// The weather layer builds seeds whenever the weather has wind, but
			// deep in winter the wind's level, and --ps-wind-op, is 0.
			const m = at(32, 725, "snow");
			expect(sceneVars(m, paletteAt(m))["--ps-wind-op"]).to.equal("0.00");
			expect(liveAt(32, 725, "snow").seeds).to.equal(false);
		});

		it("follows the model at every moment: live exactly when what ps.css paints the layer with is above 0", function () {
			for (const doy of [15, 60, 121, 182, 268, 330]) {
				for (const weather of WEATHERS) {
					for (let minute = 0; minute < 1440; minute += 20) {
						const m = at(doy, minute, weather);
						const p = paletteAt(m);
						const l = levelsAt(m, p);
						const b = birdsAt(m, p);
						const live = liveLayers(sceneVars(m, p));
						const skeins = Number(b.skeinsOpacity.toFixed(2)) > 0;
						const where = `day ${doy} ${minute} ${weather}`;
						expect(live.skeins, `${where} skeins`).to.equal(skeins);

						for (const i of [0, 1, 2]) {
							const flock = `flock${i}` as Gate;
							expect(live[flock], `${where} ${flock}`).to.equal(
								skeins && i < b.skeins
							);
						}

						expect(live.buzzard, `${where} buzzard`).to.equal(b.buzzard);
						expect(live.larks, `${where} larks`).to.equal(b.larks);
						expect(live.stars, `${where} stars`).to.equal(
							Number(p.stars.toFixed(3)) > 0
						);
						expect(live.fireflies, `${where} fireflies`).to.equal(
							Number(l.fireflies.toFixed(2)) > 0
						);
						expect(live.smoke, `${where} smoke`).to.equal(
							Number(p.smokeOpacity.toFixed(3)) > 0
						);
						expect(live.heatband, `${where} heat band`).to.equal(
							Number(l.heat.toFixed(2)) > 0
						);
						expect(live.seeds, `${where} seeds`).to.equal(
							Number(l.wind.toFixed(2)) > 0
						);
						expect(live.sun, `${where} sun`).to.equal(
							m.sun.up && Number(bodyOpacity(m, p).sun.toFixed(2)) > 0
						);
					}
				}
			}
		});
	});

	describe("GATES", function () {
		it("names every animated layer that has a window, back to front", function () {
			expect(Object.keys(GATES)).to.deep.equal([
				"stars",
				"sun",
				"fireflies",
				"smoke",
				"skeins",
				"flock0",
				"flock1",
				"flock2",
				"buzzard",
				"larks",
				"seeds",
				"heatband",
			]);
		});

		it("keeps each layer in the tree through its own fade in ps.css, and no longer", function () {
			const fades = Object.fromEntries(
				(Object.keys(GATES) as Gate[]).map((g) => [g, GATES[g].fadeMs])
			);
			expect(fades).to.deep.equal({
				stars: 0,
				sun: 0,
				fireflies: 0,
				smoke: 380,
				skeins: 1400,
				flock0: 1800,
				flock1: 1800,
				flock2: 1800,
				buzzard: 1400,
				larks: 1400,
				seeds: 0,
				heatband: 0,
			});
			expect(FADE_MARGIN_MS).to.be.within(1, 200);
		});

		it("finds each flock by its number among the skeins' flocks", function () {
			expect(
				[GATES.flock0, GATES.flock1, GATES.flock2].map((g) => [g.selector, g.index])
			).to.deep.equal([
				[".ps-flock", 0],
				[".ps-flock", 1],
				[".ps-flock", 2],
			]);
		});
	});
});

/** A scripted clock for the gates: timers by virtual milliseconds, and a log of every effect in order. */
function harness() {
	let now = 0;
	const timers: Array<{at: number; fn: () => void; live: boolean}> = [];
	const log: string[] = [];

	const fx: GateEffects = {
		set: (gate, off) => log.push(`${off ? "off" : "on"} ${gate}`),
		flush: () => log.push("flush"),
		after(ms, fn) {
			const t = {at: now + ms, fn, live: true};
			timers.push(t);

			return () => {
				t.live = false;
			};
		},
	};

	return {
		fx,
		log,
		write: () => log.push("write"),
		advance(ms: number) {
			now += ms;

			for (const t of timers) {
				if (t.live && t.at <= now) {
					t.live = false;
					t.fn();
				}
			}
		},
		pending: () => timers.filter((t) => t.live).length,
	};
}

const NONE = Object.fromEntries(Object.keys(GATES).map((g) => [g, false])) as Record<Gate, boolean>;
const only = (...gates: Gate[]) => ({...NONE, ...Object.fromEntries(gates.map((g) => [g, true]))});
const NOON = only("sun", "buzzard");
const DUSK = only("sun", "stars", "fireflies", "smoke", "skeins", "flock0", "flock1", "flock2");

describe("ps layers: the gates over time (layerGates)", function () {
	it("takes every layer outside its window out at once on the scene's first moment, and fades nothing in", function () {
		const h = harness();
		layerGates(h.fx).apply(NOON, h.write, true);
		expect(h.log).to.deep.equal([
			"write",
			"off stars",
			"off fireflies",
			"off smoke",
			"off skeins",
			"off flock0",
			"off flock1",
			"off flock2",
			"off larks",
			"off seeds",
			"off heatband",
		]);
		expect(h.pending()).to.equal(0);
	});

	it("puts a layer back before the values that fade it in are written, with the style computed in between", function () {
		const h = harness();
		const gates = layerGates(h.fx);
		gates.apply(NOON, h.write, true);
		h.log.length = 0;
		gates.apply(DUSK, h.write, false);
		expect(h.log).to.deep.equal([
			"on stars",
			"on fireflies",
			"on smoke",
			"on skeins",
			"on flock0",
			"on flock1",
			"on flock2",
			"flush",
			"write",
		]);
	});

	it("takes a fading layer out only once its fade is over", function () {
		const h = harness();
		const gates = layerGates(h.fx);
		gates.apply(NOON, h.write, true);
		h.log.length = 0;
		gates.apply(only("sun"), h.write, false);
		expect(h.log, "the buzzard fades first").to.deep.equal(["write"]);
		h.advance(GATES.buzzard.fadeMs);
		expect(h.log, "not before its fade is over").to.deep.equal(["write"]);
		h.advance(FADE_MARGIN_MS);
		expect(h.log).to.deep.equal(["write", "off buzzard"]);
		expect(h.pending()).to.equal(0);
	});

	it("takes a layer with no fade out at once", function () {
		const h = harness();
		const gates = layerGates(h.fx);
		gates.apply(DUSK, h.write, true);
		h.log.length = 0;
		gates.apply(only("sun", "smoke", "skeins", "flock0", "flock1", "flock2"), h.write, false);
		expect(h.log).to.deep.equal(["write", "off stars", "off fireflies"]);
	});

	it("keeps a layer that comes back during its fade: nothing put back, nothing computed, no late removal", function () {
		const h = harness();
		const gates = layerGates(h.fx);
		gates.apply(NOON, h.write, true);
		gates.apply(only("sun"), h.write, false);
		h.advance(500);
		h.log.length = 0;
		gates.apply(NOON, h.write, false);
		expect(h.log).to.deep.equal(["write"]);
		h.advance(5000);
		expect(h.log).to.deep.equal(["write"]);
		expect(h.pending()).to.equal(0);
	});

	it("fades a flock out over its own 1.8 s when the night's count drops", function () {
		const h = harness();
		const gates = layerGates(h.fx);
		gates.apply(DUSK, h.write, true);
		h.log.length = 0;
		gates.apply({...DUSK, flock1: false, flock2: false}, h.write, false);
		h.advance(GATES.skeins.fadeMs + FADE_MARGIN_MS);
		expect(h.log).to.deep.equal(["write"]);
		h.advance(GATES.flock1.fadeMs - GATES.skeins.fadeMs);
		expect(h.log).to.deep.equal(["write", "off flock1", "off flock2"]);
	});

	it("takes out at once what was waiting for its fade when the page is hidden", function () {
		const h = harness();
		const gates = layerGates(h.fx);
		gates.apply(DUSK, h.write, true);
		gates.apply(only("sun", "stars"), h.write, false);
		// The fireflies had no fade and went at once; the smoke, the skeins and the flocks were fading.
		h.log.length = 0;
		gates.settle();
		expect(h.log).to.deep.equal([
			"off smoke",
			"off skeins",
			"off flock0",
			"off flock1",
			"off flock2",
		]);
		expect(h.pending()).to.equal(0);
	});

	it("forgets a rebuilt layer: its new element is in the tree until the gates say otherwise", function () {
		const h = harness();
		const gates = layerGates(h.fx);
		gates.apply(NOON, h.write, true);
		gates.forget("heatband");
		h.log.length = 0;
		gates.apply(NOON, h.write, false);
		expect(h.log).to.deep.equal(["write", "off heatband"]);
	});

	it("cancels every wait when stopped", function () {
		const h = harness();
		const gates = layerGates(h.fx);
		gates.apply(DUSK, h.write, true);
		gates.apply(NOON, h.write, false);
		expect(h.pending()).to.be.greaterThan(0);
		gates.stop();
		expect(h.pending()).to.equal(0);
	});
});
