import {expect} from "chai";
import {stanceTravel} from "../../../tools/heart/lib/travel.mjs";

describe("tools/heart travel", function () {
	it("moves the body forward by what the planted foot moves back, holds through flight, stops when nothing is planted", function () {
		const g = 100;
		// one foot: planted and sliding back 10/frame for 4 frames, then lifted for 2, then planted still
		const frames = [
			{t: 0, feet: [{layer: "near", x: 40, y: g}]},
			{t: 0.1, feet: [{layer: "near", x: 30, y: g}]},
			{t: 0.2, feet: [{layer: "near", x: 20, y: g}]},
			{t: 0.3, feet: [{layer: "near", x: 10, y: g}]},
			{t: 0.4, feet: [{layer: "near", x: 20, y: g - 30}]}, // in the air: swinging forward
			{t: 0.5, feet: [{layer: "near", x: 40, y: g - 30}]},
			{t: 0.6, feet: [{layer: "near", x: 40, y: g}]},
			{t: 0.7, feet: [{layer: "near", x: 40, y: g}]},
			{t: 1.2, feet: [{layer: "near", x: 40, y: g}]},
			{t: 1.3, feet: [{layer: "near", x: 40, y: g}]},
		];
		const {x, v} = stanceTravel(frames, g);
		expect(v[1]).to.be.closeTo(100, 1e-9);
		expect(v[2]).to.be.closeTo(100, 1e-9);
		expect(v[3]).to.be.closeTo(100, 1e-9);
		expect(v[4]).to.be.closeTo(100, 1e-9); // flight: the last velocity holds
		expect(v[5]).to.be.closeTo(100, 1e-9);
		expect(v[6]).to.be.closeTo(100, 1e-9); // the landing frame: planted now, not in the frame before
		expect(v[7]).to.equal(0); // planted in both and still
		expect(x[3]).to.be.closeTo(30, 1e-9);
		expect(x[7]).to.be.closeTo(60, 1e-9);
		expect(x[9]).to.be.closeTo(60, 1e-9);
	});

	it("takes the lowest planted foot and forgets the velocity after a long flight", function () {
		const g = 100;
		const frames = [
			{
				t: 0,
				feet: [
					{layer: "far", x: 0, y: g - 4},
					{layer: "near", x: 50, y: g},
				],
			},
			{
				t: 0.1,
				feet: [
					{layer: "far", x: 20, y: g - 4},
					{layer: "near", x: 45, y: g},
				],
			},
			{
				t: 0.2,
				feet: [
					{layer: "far", x: 20, y: g - 40},
					{layer: "near", x: 45, y: g - 40},
				],
			},
			{
				t: 0.6,
				feet: [
					{layer: "far", x: 20, y: g - 40},
					{layer: "near", x: 45, y: g - 40},
				],
			},
		];
		const {v} = stanceTravel(frames, g);
		expect(v[1]).to.equal(50); // the near foot, lower, wins over the far one moving the other way
		expect(v[2]).to.equal(50);
		expect(v[3]).to.equal(0); // 0.4 s in the air: not a stride any more
	});

	it("clamps a planted foot that swings forward to zero instead of reading it as backward", function () {
		const g = 100;
		// planted in both frames (on the ground both times), but the foot
		// moves forward (dx > 0): a touch-down mid-swing, never the body
		// stepping back.
		const frames = [
			{t: 0, feet: [{layer: "near", x: 10, y: g}]},
			{t: 0.1, feet: [{layer: "near", x: 20, y: g}]},
		];
		const {x, v} = stanceTravel(frames, g);
		expect(v[1]).to.equal(0);
		expect(x[1]).to.equal(0);
	});
});
