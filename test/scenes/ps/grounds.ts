import {expect} from "chai";
import {contrast, luminance, mix} from "../../../client/js/scenes/ps/colour";
import {
	momentFor,
	SOLAR_NOON,
	sunTimes,
	WEATHERS,
	type Moment,
	type Weather,
} from "../../../client/js/scenes/ps/engine";
import {
	ALPHA_HALO,
	AREAS,
	bodyOpacity,
	INK,
	INK_FAINT_HELD,
	inkHolds,
	inkWindow,
	publishedFor,
	SCHEDULE_STEP,
	sceneGrounds,
	treatmentFor,
} from "../../../client/js/scenes/ps/grounds";
import {
	GLASS_NIGHT_AT,
	levelsAt,
	paletteAt,
	stopsAt,
	TEXT_LIGHT_AT,
} from "../../../client/js/scenes/ps/palette";
import {sceneVars} from "../../../client/js/scenes/ps/scene";
import {SAMPLING} from "../../../tools/ps/legibility";

/** A moment at a local minute on a day of the year; the moon's phase does not matter to the grounds. */
const at = (minute: number, doy: number, weather: Weather = "clear"): Moment =>
	momentFor({minute, doy, dayNumber: doy, epochDays: 20000, weather});

const areas = (m: Moment) => sceneGrounds(m, paletteAt(m)).map((g) => g.area);

describe("ps grounds: what the words are held over (plan 3, the rulings table)", function () {
	it("names every painted area of the plains the ruling lists, and the sky", function () {
		expect(AREAS).to.include.members([
			"mount",
			"mount2",
			"far",
			"hill2",
			"hill1",
			"grass",
			"blade",
			"tree",
			"riverbed",
			"river top",
			"river bottom",
			"felt shade",
			"felt",
			"felt glow",
			"door glow",
			"roof top",
			"roof bottom",
			"crown glow",
			"band",
			"door",
			"pool on hill1",
			"pool on grass",
			"cloud",
			"cloud underside",
		]);

		// A clear noon and a clear night, both hold the whole list.
		for (const m of [at(750, 172), at(0, 172)]) {
			expect(areas(m)).to.include.members(["skyTop", "skyMid", "skyHorizon", ...AREAS]);
		}
	});

	it("leaves out the small marks and the lines, and the worn path the user took away", function () {
		const all = areas(at(0, 32, "snow")).concat(areas(at(750, 172)));

		for (const mark of [
			"tuft",
			"shrub",
			"trunk",
			"stone",
			"bedstone",
			"band mark",
			"crown",
			"pipe",
			"wood",
			"rope",
			"rib",
			"rim",
			"path",
			"spill",
			"star",
			"firefly",
			"flash",
		]) {
			// "crown glow" is the crown's glow, an area; the crown itself is a mark.
			expect(
				all.filter((a) => a === mark || (a.startsWith(`${mark} `) && a !== "crown glow")),
				mark
			).to.deep.equal([]);
		}
	});

	it("counts the smoke over the far land and the horizon only while the yurt smokes", function () {
		expect(areas(at(750, 172)).filter((a) => a.startsWith("smoke"))).to.deep.equal([]);
		expect(
			areas(at(0, 172))
				.filter((a) => a.startsWith("smoke"))
				.sort()
		).to.deep.equal([
			"smoke over far",
			"smoke over mount",
			"smoke over mount2",
			"smoke over skyHorizon",
		]);
	});

	it("lays the door's pool on the ground at night and nothing by day", function () {
		const byName = (m: Moment) =>
			Object.fromEntries(sceneGrounds(m, paletteAt(m)).map((g) => [g.area, g.hex]));
		const noon = at(750, 172);
		expect(byName(noon)["pool on grass"]).to.equal(paletteAt(noon).grass);
		const night = at(0, 172);
		const p = paletteAt(night);
		expect(byName(night)["pool on grass"]).to.equal(
			mix(p.grass, "#ffc47a", 0.78 * p.nightGlow)
		);
	});

	it("takes every ground under the veil on a veiled day, and only there (the veil covers the whole scene)", function () {
		for (const weather of ["rain", "storm", "snow"] as const) {
			const m = at(750, 121, weather);
			const p = paletteAt(m);
			const l = levelsAt(m, p);
			expect(l.veil, weather).to.be.above(0);
			const g = sceneGrounds(m, p);
			const sky = g.filter((x) => x.area === "skyTop");
			expect(
				sky.map((x) => x.hex),
				weather
			).to.deep.equal([mix(p.skyTop, l.veilColour, l.veil)]);
			expect(g.filter((x) => x.area === "band").map((x) => x.hex)).to.deep.equal([
				mix(p.band, l.veilColour, l.veil),
			]);
		}

		const clear = at(750, 121);
		expect(
			sceneGrounds(clear, paletteAt(clear)).find((x) => x.area === "skyTop")!.hex
		).to.equal(paletteAt(clear).skyTop);
	});

	it("never counts the sun under the horizon line: the mountains hide it", function () {
		for (const doy of [1, 121, 172, 295]) {
			const {rise, set} = sunTimes(doy);

			for (let minute = Math.floor(rise) - 40; minute <= Math.ceil(set) + 40; minute += 2) {
				const m = at(minute, doy);
				const suns = sceneGrounds(m, paletteAt(m)).filter((g) => g.body === "sun");

				if (m.sun.alt < 0 || !m.sun.up) {
					expect(suns, `doy ${doy} minute ${minute}`).to.deep.equal([]);
				}
			}
		}

		const noon = at(750, 172);
		expect(sceneGrounds(noon, paletteAt(noon)).filter((g) => g.body === "sun").length).to.equal(
			4
		);
	});

	it("counts the moon's disc whatever its phase, at the opacity the scene draws a present moon", function () {
		const m = at(60, 172);
		const p = paletteAt(m);
		const discs = sceneGrounds({...m, phase: {...m.phase, present: false}}, p).filter(
			(g) => g.body === "moon"
		);
		expect(discs.length).to.equal(4);
		const op = Number(
			bodyOpacity({...m, phase: {...m.phase, present: true}}, p).moon.toFixed(3)
		);
		expect(discs[0].hex).to.equal(mix(p.skyTop, "#fdfaf0", op));
	});

	it("gives the scene's own sun and moon opacity (sceneVars reads the same function)", function () {
		for (const m of [at(750, 172), at(60, 172), at(750, 121, "storm")]) {
			const p = paletteAt(m);
			const o = bodyOpacity(m, p);
			const vars = sceneVars(m, p);
			expect(vars["--ps-moon-op"]).to.equal(o.moon.toFixed(3));
			expect(vars["--ps-sun-op"]).to.equal(m.sun.up ? o.sun.toFixed(2) : "0");
		}
	});
});

describe("ps grounds: the words' treatment (the user's white sooner, 2026-09-25)", function () {
	this.timeout(120000);

	it("holds dark ink only where ink and the faint ink it keeps clear their floors through the halo over every ground", function () {
		for (const m of [at(750, 172), at(750, 32, "snow"), at(1010, 295)]) {
			const p = paletteAt(m);
			const halo = mix(p.skyHorizon, "#ffffff", 0.55);
			const worst = Math.min(
				...sceneGrounds(m, p).map((g) => luminance(mix(g.hex, halo, ALPHA_HALO)))
			);
			const inkClears = (hex: string, floor: number) =>
				sceneGrounds(m, p).every(
					(g) => contrast(hex, mix(g.hex, halo, ALPHA_HALO)) >= floor
				);
			expect(inkHolds(m, p), `${m.doy} ${m.minute} ${m.weather}, worst ${worst}`).to.equal(
				inkClears(INK, 4.5) && inkClears(INK_FAINT_HELD, 3)
			);
		}
	});

	it("keeps TEXT_LIGHT_AT as the other trigger: light whenever it is darker than 0.05", function () {
		const m = at(0, 32, "snow");
		expect(treatmentFor(m, {dark: TEXT_LIGHT_AT + 0.01})).to.equal("light");
	});

	it("takes the darkness it reads from the stops, as paletteAt does", function () {
		for (const m of [at(0, 1), at(420, 121), at(750, 172), at(1130, 295, "snow")]) {
			expect(stopsAt(m.canonical).dark).to.equal(paletteAt(m).dark);
		}
	});

	it("runs a day's ink window on the dense sweep's 5-minute grid, and uses ink only at samples where it holds", function () {
		expect(SCHEDULE_STEP).to.equal(SAMPLING.dense.step);

		for (const doy of [1, 32, 121, 172, 295, 355]) {
			for (const weather of WEATHERS) {
				const w = inkWindow(doy, weather);
				expect(w.from % SCHEDULE_STEP, `${doy} ${weather}`).to.equal(0);
				expect(w.to % SCHEDULE_STEP).to.equal(0);

				if (w.to > w.from) {
					expect(w.from, `${doy} ${weather} starts before noon`).to.be.below(SOLAR_NOON);

					for (let t = w.from; t < w.to; t += SCHEDULE_STEP) {
						const m = at(t, doy, weather);
						const p = paletteAt(m);
						expect(
							p.dark <= TEXT_LIGHT_AT && inkHolds(m, p),
							`${doy} ${t} ${weather}`
						).to.equal(true);
					}
				}
			}
		}
	});

	it("never flickers: on every sampled day, minute by minute, the words change at most once before solar noon and once after", function () {
		const flips: string[] = [];

		for (const doy of SAMPLING.sparse.days) {
			for (const weather of WEATHERS) {
				let prev: string | null = null;
				const count = {am: 0, pm: 0};

				for (let minute = 0; minute < 1440; minute++) {
					const m = at(minute, doy, weather);
					const text = treatmentFor(m, stopsAt(m.canonical));

					if (prev !== null && text !== prev) {
						count[minute < SOLAR_NOON ? "am" : "pm"]++;
					}

					prev = text;
				}

				if (count.am > 1 || count.pm > 1) {
					flips.push(`doy ${doy} ${weather}: ${count.am} before noon, ${count.pm} after`);
				}
			}
		}

		expect(flips).to.deep.equal([]);
	});

	it("keeps a day whose morning never reaches ink light all day (a clear day, by the real-phrase halo)", function () {
		const w = inkWindow(172, "clear");
		expect(w.to).to.equal(w.from);

		for (let minute = 0; minute < 1440; minute += 30) {
			const m = at(minute, 172);
			expect(treatmentFor(m, paletteAt(m)), `${minute}`).to.equal("light");
		}
	});

	it("gives the pinned moments their treatment: light at a clear noon, a stormy noon and the golden hour", function () {
		for (const m of [at(750, 172), at(750, 121, "storm"), at(1010, 295)]) {
			expect(
				publishedFor(paletteAt(m), m).text,
				`${m.doy} ${m.minute} ${m.weather}`
			).to.equal("light");
		}
	});

	it("keeps dark ink on a snowy noon, where the snow's pale veil lets it hold", function () {
		const m = at(750, 32, "snow");
		expect(publishedFor(paletteAt(m), m).text).to.equal("ink");
	});
});

describe("ps grounds: what the chrome reads (publishedFor)", function () {
	it("turns the glass at 0.5, and gives the halo and the canvas", function () {
		const m = at(750, 213);
		const p = paletteAt(m);
		const out = publishedFor(p, m);
		expect(out.halo).to.equal(mix(p.skyHorizon, "#ffffff", 0.55));
		expect(out.canvas).to.equal(p.skyTop);
		expect(publishedFor({...p, dark: GLASS_NIGHT_AT}, m).light).to.equal("day");
		expect(publishedFor({...p, dark: GLASS_NIGHT_AT + 0.01}, m).light).to.equal("night");
		expect(publishedFor({...p, dark: TEXT_LIGHT_AT + 0.01}, m).text).to.equal("light");
	});
});
