import {expect} from "chai";
import {momentAt, type Weather} from "../../../client/js/scenes/ps/engine";
import {
	indoorGrounds,
	indoorLevels,
	indoorVars,
	roofColourAt,
	ROOM_COLOURS,
	ROOM_GROUNDS,
	ROOM_LIT,
	ROOM_NIGHT,
	roomCss,
	shadeRoom,
} from "../../../client/js/scenes/ps/indoor";
import {paletteAt} from "../../../client/js/scenes/ps/palette";

const at = (d: Date, w?: Weather) => {
	const m = momentAt(d, w);
	return {m, p: paletteAt(m)};
};

describe("ps yurt: the room's colour and light by the minute (indoor.ts, docs/projects/ps-yurt.md §6)", function () {
	it("is lit by day and shaded at night", function () {
		const noon = at(new Date(2026, 5, 21, 12, 30), "clear");
		const night = at(new Date(2026, 5, 21, 23, 0), "clear");
		expect(indoorLevels(noon.m, noon.p))
			.to.include({shade: 0, lamp: 0})
			.and.have.property("beam")
			.above(0.9);
		const n = indoorLevels(night.m, night.p);
		expect(n.shade).to.be.closeTo(0.74, 0.001);
		expect(n.lamp).to.equal(1);
		expect(n.fire).to.be.closeTo(0.8, 0.001);
		expect(n.beam).to.equal(0);
	});

	it("dims and lights the lamp in a storm, and has no beam under cloud", function () {
		const {m, p} = at(new Date(2026, 5, 21, 12, 30), "storm");
		const l = indoorLevels(m, p);
		expect(l.lamp).to.equal(1);
		expect(l.beam).to.equal(0);
		expect(l.shade).to.be.closeTo(0.55 * 0.46, 1e-9);
	});

	it("lights the golden hour's glow at the golden hour alone: never at night, never under cloud", function () {
		const golden = at(new Date(2026, 5, 21, 19, 30), "clear");
		const night = at(new Date(2026, 5, 21, 23, 0), "clear");
		const storm = at(new Date(2026, 5, 21, 19, 30), "storm");
		const rain = at(new Date(2026, 5, 21, 19, 30), "rain");
		expect(indoorLevels(golden.m, golden.p).golden).to.be.above(0.1);
		expect(indoorLevels(night.m, night.p).golden).to.equal(0);
		expect(indoorLevels(storm.m, storm.p).golden).to.equal(0);
		expect(indoorLevels(rain.m, rain.p).golden).to.equal(0);
		expect(roomCss()).to.contain(".ps-yt-golden { opacity: var(--ps-in-golden); }");
	});

	it("shows the sun in the back window only while it is above the horizon", function () {
		for (let min = 0; min < 24 * 60; min += 10) {
			const {m, p} = at(new Date(2026, 5, 21, 0, min), "clear");
			const sun = indoorLevels(m, p).sun;
			expect(sun, `minute ${min}`).to.be.within(0, 1);

			if (m.sun.alt < 0) {
				expect(sun, `minute ${min}, the sun at ${m.sun.alt}`).to.equal(0);
			}
		}

		const after = at(new Date(2026, 5, 21, 21, 0), "clear");
		expect(indoorLevels(after.m, after.p).sun).to.equal(0);
	});

	it("takes what the fire's and the lamp's glows reach as grounds under them, but not the stove drawn over its own glow", function () {
		const {m, p} = at(new Date(2026, 5, 21, 23, 0), "clear");
		const areas = indoorGrounds(m, p).map((g) => g.area);

		for (const key of [
			"furn",
			"furnL",
			"wood",
			"woodL",
			"blue",
			"cream",
			"curtain",
			"mattress",
			"quiltTop",
			"monitor",
		]) {
			expect(areas).to.include(`room ${key} under the fire`);
			expect(areas).to.include(`room ${key} under the lamp`);
		}

		for (const key of ["ironD", "ironShadow", "ironTop", "pipe", "roofA", "crown"]) {
			expect(areas).to.not.include(`room ${key} under the fire`);
			expect(areas).to.not.include(`room ${key} under the lamp`);
		}
	});

	it("the fire burns while the chimney smokes, and its glow with it (§16)", function () {
		const noon = at(new Date(2026, 5, 21, 12, 30), "clear");
		const night = at(new Date(2026, 5, 21, 23, 0), "clear");
		const storm = at(new Date(2026, 5, 21, 12, 30), "storm");
		expect(indoorLevels(noon.m, noon.p)).to.include({burn: 0, fire: 0});
		const n = indoorLevels(night.m, night.p);
		expect(n.burn).to.equal(1);
		expect(n.fire).to.be.closeTo(0.8, 0.001);
		expect(indoorLevels(storm.m, storm.p), "a stormy day").to.include({burn: 0, fire: 0});
		let dusk: ReturnType<typeof at> | undefined;

		for (let min = 18 * 60; min < 24 * 60 && !dusk; min++) {
			const c = at(new Date(2026, 5, 21, 0, min), "clear");

			if (c.p.smokeOpacity > 0 && c.p.smokeOpacity < 1) {
				dusk = c;
			}
		}

		expect(dusk, "a minute of dusk").to.not.equal(undefined);
		expect(indoorLevels(dusk!.m, dusk!.p).burn).to.equal(dusk!.p.smokeOpacity);
		expect(roomCss()).to.contain(".ps-yt-burn { opacity: var(--ps-in-burn); }");
	});

	it("writes exactly the nine levels", function () {
		const {m, p} = at(new Date(2026, 5, 21, 18, 30), "clear");
		expect(Object.keys(indoorVars(m, p)).sort()).to.deep.equal([
			"--ps-in-beam",
			"--ps-in-burn",
			"--ps-in-fire",
			"--ps-in-golden",
			"--ps-in-lamp",
			"--ps-in-screen",
			"--ps-in-shade",
			"--ps-in-sun",
			"--ps-in-warm",
		]);
	});

	it("mixes every colour the way the page does", function () {
		expect(shadeRoom("#c8602f", {shade: 0, warm: 0})).to.equal("#c8602f");
		expect(shadeRoom("#c8602f", {shade: 1, warm: 0})).to.equal(ROOM_NIGHT);
		const css = roomCss();

		for (const k of Object.keys(ROOM_COLOURS)) {
			expect(css, k).to.contain(`.ps-yt-c-${k} {`);
		}

		expect(css).to.contain("calc(var(--ps-in-shade) * 100%)").and.contain("var(--ps-moon-op)");
	});

	it("lists the room's grounds: every ground key, the panes in the plains' own colours, nothing from ROOM_LIT", function () {
		const {m, p} = at(new Date(2026, 5, 21, 12, 30), "clear");
		const g = indoorGrounds(m, p);
		ROOM_GROUNDS.forEach((k) => expect(g.map((x) => x.area)).to.include(`room ${k}`));
		expect(g.map((x) => x.hex))
			.to.include(p.skyTop)
			.and.include(p.mount);
		ROOM_LIT.forEach((hex) => expect(g.map((x) => x.hex)).to.not.include(hex));
		expect(g.filter((x) => x.zone === "top").map((x) => x.area)).to.include("room roofA");
	});

	it("gives the canvas the roof's colour", function () {
		const {m, p} = at(new Date(2026, 5, 21, 23, 0), "clear");
		expect(roofColourAt(m, p)).to.equal(shadeRoom(ROOM_COLOURS.roofA, indoorLevels(m, p)));
	});
});
