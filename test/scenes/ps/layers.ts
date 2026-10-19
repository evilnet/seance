import {expect} from "chai";
import {birdsAt} from "../../../client/js/scenes/ps/birds";
import {momentFor, WEATHERS, type Weather} from "../../../client/js/scenes/ps/engine";
import {bodyOpacity} from "../../../client/js/scenes/ps/grounds";
import {GATES, liveLayers, type Gate} from "../../../client/js/scenes/ps/layers";
import {levelsAt, paletteAt} from "../../../client/js/scenes/ps/palette";
import {sceneVars} from "../../../client/js/scenes/ps/markup";

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
