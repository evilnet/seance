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

	it("writes exactly the seven levels", function () {
		const {m, p} = at(new Date(2026, 5, 21, 18, 30), "clear");
		expect(Object.keys(indoorVars(m, p)).sort()).to.deep.equal([
			"--ps-in-beam",
			"--ps-in-fire",
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
