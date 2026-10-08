import {expect} from "chai";
import {contrast, luminance} from "../../../client/js/scenes/ps/colour";
import {momentFor, type Moment, type Weather} from "../../../client/js/scenes/ps/engine";
import {
	backdropFiltered,
	composerAboveGrass,
	DAY_BRIGHTNESS,
	DAY_GLASS_MARK,
	DAY_GLASS_TEXT,
	DAY_TINT,
	dayTints,
	glassVars,
	GLASS_SURFACES,
	isBehind,
	lowestTint,
	MARK_SOLVE,
	SATURATE,
	surfaceTints,
	TEXT_SOLVE,
	throughDayGlass,
	tintsOver,
	TINT_CAP,
	TINT_FLOOR,
	TINT_STEP,
	type GlassSurface,
} from "../../../client/js/scenes/ps/glass";
import {sceneGrounds} from "../../../client/js/scenes/ps/grounds";
import {paletteAt} from "../../../client/js/scenes/ps/palette";
import {GRASS_EDGE_LOWEST} from "../../../client/js/scenes/ps/plains";

/** A moment at a local minute on a day of the year; the moon's phase does not matter to the grounds. */
const at = (minute: number, doy: number, weather: Weather = "clear"): Moment =>
	momentFor({minute, doy, dayNumber: doy, epochDays: 20000, weather});

/** 21 June 2026 (a clear day) and 2 May 2026 (a rainy one), the comparison page's dates. */
const JUNE = 172;
const MAY = 122;

/**
 * The luminous candidate's tints on the comparison page the user chose from
 * (tmp/ps-glass/, analyse.ts's moments: the minute and the next, the solve at
 * 4.6, the floor 0.40, the backdrop brightened 1.3 then saturated 1.12).
 */
const PAGE: Array<{
	what: string;
	minute: number;
	doy: number;
	weather: Weather;
	tints: Record<GlassSurface, number>;
}> = [
	{
		what: "clear noon, 21 June 12:30",
		minute: 750,
		doy: JUNE,
		weather: "clear",
		tints: {header: 0.46, composer: 0.4, side: 0.51, float: 0.6},
	},
	{
		what: "clear late afternoon, 19:24",
		minute: 1164,
		doy: JUNE,
		weather: "clear",
		tints: {header: 0.65, composer: 0.64, side: 0.65, float: 0.65},
	},
	{
		what: "the last minute of day glass, 20:23",
		minute: 1223,
		doy: JUNE,
		weather: "clear",
		tints: {header: 0.76, composer: 0.76, side: 0.76, float: 0.76},
	},
	{
		what: "rainy noon, 2 May 12:30",
		minute: 750,
		doy: MAY,
		weather: "rain",
		tints: {header: 0.54, composer: 0.48, side: 0.57, float: 0.62},
	},
];

/** The lowest luminance a ground may have under the day glass for every colour on it: text at 4.6, marks at 3.1. */
const NEED = Math.max(
	TEXT_SOLVE * (luminance(DAY_GLASS_TEXT) + 0.05) - 0.05,
	MARK_SOLVE * (luminance(DAY_GLASS_MARK) + 0.05) - 0.05
);

describe("ps glass: the luminous day glass (plan 3 task 7b, the user's pick)", function () {
	it("keeps the page's figures: a tint between 0.40 and 0.78, the backdrop brightened 1.3 then saturated 1.12, solved to 4.6", function () {
		expect(TINT_FLOOR).to.equal(0.4);
		expect(TINT_CAP).to.equal(0.78);
		expect(DAY_BRIGHTNESS).to.equal(1.3);
		expect(SATURATE).to.equal(1.12);
		expect(TEXT_SOLVE).to.equal(4.6);
		expect(MARK_SOLVE).to.equal(3.1);
		expect(DAY_TINT).to.equal("#fffbf4");
		expect(GLASS_SURFACES).to.deep.equal(["header", "composer", "side", "float"]);
	});

	it("models the backdrop filter as Chromium draws it: brightness, then saturate, per channel in sRGB (the probe's pixels)", function () {
		// tmp/ps-glass/probe: blur(0.625rem) brightness(1.3) saturate(1.12) over flat patches, headless Chromium.
		const CHROMIUM: Array<[string, string]> = [
			["#408fe6", "#49bcff"],
			["#2c3a76", "#374ba3"],
			["#651e36", "#8c2447"],
			["#cc5a2e", "#ff7232"],
			["#91c05e", "#b8fc6e"],
			["#4966ac", "#5b85eb"],
			["#fffef6", "#ffffff"],
		];

		for (const [ground, drawn] of CHROMIUM) {
			const got = backdropFiltered(ground);

			for (const i of [1, 3, 5]) {
				expect(
					Math.abs(
						parseInt(got.slice(i, i + 2), 16) - parseInt(drawn.slice(i, i + 2), 16)
					),
					`${ground}: ${got} against Chromium's ${drawn}`
				).to.be.at.most(1);
			}
		}
	});

	it("tints over the filtered backdrop: the tint at 0 is the filtered ground, at 1 the tint itself", function () {
		expect(throughDayGlass("#408fe6", 0)).to.equal(backdropFiltered("#408fe6"));
		expect(throughDayGlass("#408fe6", 1)).to.equal(DAY_TINT);
	});

	it("counts the grounds each surface can stand over, as the page did", function () {
		const m = at(1223, JUNE);
		const all = sceneGrounds(m, paletteAt(m));
		const areas = (s: GlassSurface) => all.filter((g) => isBehind(s, g)).map((g) => g.area);
		const yurt = /^(felt|door|roof|crown|band|pool|smoke)/;

		// The header: the sky's top, the clouds, the bodies above the horizon line.
		expect(areas("header")).to.include.members(["skyTop", "cloud", "cloud underside"]);
		expect(areas("header").filter((a) => !/^(skyTop|cloud|moon |sun )/.test(a))).to.deep.equal(
			[]
		);
		// The composer: the near grass.
		expect([...new Set(areas("composer"))].sort()).to.deep.equal([
			"blade",
			"grass",
			"pool on grass",
		]);
		// A docked sidebar or user list: everything but the yurt, its pool and its smoke.
		expect(areas("side").filter((a) => yurt.test(a))).to.deep.equal([]);
		expect(areas("side")).to.include.members(["skyTop", "hill1", "tree", "river top", "cloud"]);
		// A drawer, an overlaid list, a chip: everything.
		expect(areas("float")).to.deep.equal(all.map((g) => g.area));
	});

	for (const p of PAGE) {
		it(`reproduces the page over its own window (the minute and the next): ${p.what}`, function () {
			expect(
				surfaceTints([at(p.minute, p.doy, p.weather), at(p.minute + 1, p.doy, p.weather)])
			).to.deep.equal(p.tints);
		});
	}

	it("solves the lowest tint on a 0.01 grid at which every ground clears the need, clamped to [0.40, 0.78]", function () {
		const m = at(1164, JUNE);
		const grounds = sceneGrounds(m, paletteAt(m)).map((g) => g.hex);
		const t = lowestTint(grounds);
		expect(t).to.be.within(TINT_FLOOR + 0.01, TINT_CAP - 0.01);
		expect(Math.round(t * 100)).to.equal(t * 100);
		const clears = (a: number) =>
			grounds.every((g) => luminance(throughDayGlass(g, a)) >= NEED);
		expect(clears(t), `at ${t}`).to.equal(true);
		expect(clears(Math.round(t * 100 - 1) / 100), `at ${t} − 0.01`).to.equal(false);

		// The clamp: a white ground needs no tint, a black one more than the cap.
		expect(lowestTint(["#ffffff"])).to.equal(TINT_FLOOR);
		expect(lowestTint(["#000000"])).to.equal(TINT_CAP);
		expect(lowestTint([])).to.equal(TINT_FLOOR);
	});

	it("holds the glass's text at 4.6 and its marks at 3.1 wherever the tint is under the cap", function () {
		const m = at(750, JUNE);
		const all = sceneGrounds(m, paletteAt(m));
		const tints = surfaceTints([m]);

		for (const s of GLASS_SURFACES) {
			for (const g of all.filter((x) => isBehind(s, x))) {
				const under = throughDayGlass(g.hex, tints[s]);
				expect(contrast(DAY_GLASS_TEXT, under), `${s} over ${g.name}`).to.be.at.least(
					TEXT_SOLVE
				);
				expect(contrast(DAY_GLASS_MARK, under), `${s} over ${g.name}`).to.be.at.least(
					MARK_SOLVE
				);
			}
		}
	});

	it(`caches a ${TINT_STEP}-minute step: at least each minute's own tint, and the page's figures at its moments`, function () {
		for (const p of PAGE) {
			const cached = dayTints(at(p.minute, p.doy, p.weather));
			const own = surfaceTints([at(p.minute, p.doy, p.weather)]);

			for (const s of GLASS_SURFACES) {
				expect(cached[s], `${p.what}: ${s}`).to.be.at.least(own[s]);
			}

			expect(cached, p.what).to.deep.equal(p.tints);
		}
	});

	it("gives every minute of a step, and a fractional minute (a catch-up at :40 s), its step's tints", function () {
		const start = dayTints(at(1160, JUNE));

		for (const minute of [1160, 1161, 1163.67, 1164.999]) {
			expect(dayTints(at(minute, JUNE)), String(minute)).to.deep.equal(start);
		}

		// Each minute of the step and the next step's first (the tint must hold through the 0.8 s ease into the next).
		const window = surfaceTints([1160, 1161, 1162, 1163, 1164, 1165].map((t) => at(t, JUNE)));
		expect(start).to.deep.equal(window);
	});

	describe("the composer above the near grass (fix rounds 1 and 2, the controller's rulings)", function () {
		// A 900 px scene at the top of the page: the grass edge's lowest point is 0.86 × 900 = 774 px.
		const scene = {top: 0, height: 900};
		const edge = scene.top + scene.height * GRASS_EDGE_LOWEST;

		it("takes the threshold from the land's own geometry: the grass edge's lowest point, 0.86 of the scene", function () {
			expect(GRASS_EDGE_LOWEST).to.be.closeTo(0.44 + (0.56 * 300) / 400, 1e-12);
		});

		it("is not above the grass with its top exactly on the band's top, and is 1 px above it", function () {
			expect(composerAboveGrass({top: edge}, scene)).to.equal(false);
			expect(composerAboveGrass({top: edge - 1}, scene)).to.equal(true);
			expect(
				composerAboveGrass({top: 839}, scene),
				"a plain composer at 1280 × 900"
			).to.equal(false);
			expect(composerAboveGrass({top: 754}, scene), "a reply bar and three lines").to.equal(
				true
			);
		});

		it("measures against the scene's own box, wherever it sits on the page", function () {
			const lower = {top: 120, height: 600};
			const lowerEdge = 120 + 600 * GRASS_EDGE_LOWEST;
			expect(composerAboveGrass({top: lowerEdge}, lower)).to.equal(false);
			expect(composerAboveGrass({top: lowerEdge - 1}, lower)).to.equal(true);
			// A composer lifted mid-scene (a touch keyboard: #viewport follows the visible band, the scene the layout viewport).
			expect(composerAboveGrass({top: 400}, {top: 0, height: 844})).to.equal(true);
		});

		it("needs the float tint over the yurt: at the composer's own tint the soft ink falls under 4.5 on the door, at the float tint every yurt ground holds 4.6", function () {
			// A clear noon, and the worst moment the composer model found (a veiled door, stormy 1 Feb 08:30).
			for (const m of [at(750, JUNE), at(510, 32, "storm")]) {
				const all = sceneGrounds(m, paletteAt(m));
				const tints = tintsOver(all);
				const yurt = all.filter((g) => /^(felt|door|roof|crown|band|pool)/.test(g.area));
				const door = yurt.find((g) => g.area === "door")!;
				const where = `doy ${m.doy} ${m.minute} min ${m.weather}`;
				expect(
					contrast(DAY_GLASS_TEXT, throughDayGlass(door.hex, tints.composer)),
					`${where}: the composer's ${tints.composer} over ${door.name}`
				).to.be.below(4.5);

				for (const g of yurt) {
					expect(
						contrast(DAY_GLASS_TEXT, throughDayGlass(g.hex, tints.float)),
						`${where}: the float ${tints.float} over ${g.name}`
					).to.be.at.least(TEXT_SOLVE);
				}
			}
		});
	});

	it("publishes the four day tints on <html> by day, and takes them off at night so the night glass keeps its own", function () {
		const day = at(750, JUNE);
		expect(glassVars(day, "day")).to.deep.equal({
			"--ps-g-tint-header": "0.46",
			"--ps-g-tint-composer": "0.40",
			"--ps-g-tint-side": "0.51",
			"--ps-g-tint-float": "0.60",
		});
		expect(glassVars(at(30, JUNE), "night")).to.deep.equal({
			"--ps-g-tint-header": null,
			"--ps-g-tint-composer": null,
			"--ps-g-tint-side": null,
			"--ps-g-tint-float": null,
		});
	});
});
