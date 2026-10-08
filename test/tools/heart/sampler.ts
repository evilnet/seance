import {expect} from "chai";
import {cyc, sampleGait, samplePose, sampleWobble} from "../../../tools/heart/lib/sampler.mjs";

describe("tools/heart sampler", function () {
	const keys: [number, number, string?][] = [
		[0, 0, "linear"],
		[50, 10, "linear"],
		[100, 0],
	];

	it("cyc interpolates a cyclic key list by phase, wrapping and offsetting", function () {
		expect(cyc(keys, 0)).to.equal(0);
		expect(cyc(keys, 0.25)).to.equal(5);
		expect(cyc(keys, 0.5)).to.equal(10);
		expect(cyc(keys, 1.25)).to.equal(5);
		expect(cyc(keys, 0.25, 0.25)).to.equal(0);
		// the default easing between 50 and 100 is smoothstep: 75% is the midpoint
		expect(cyc(keys, 0.75)).to.equal(5);
	});

	it("sampleGait emits dur × fps frames per cycle with the gait's channels", function () {
		const gait = {dur: 0.5, phases: {"leg.near": 0, "leg.far": 0.5}, ch: {"leg.up": keys}};
		const channels = [
			{name: "leg.near.up", key: "leg.up", phase: 0},
			{name: "leg.far.up", key: "leg.up", phase: 0.5},
			{name: "ty", key: "ty", rest: 3},
		];
		const out: {t: number; v: Record<string, number>}[] = [];
		const end = sampleGait(gait, channels, 1, 10, out, 2);
		expect(out).to.have.length(5);
		expect(end).to.be.closeTo(2.5, 1e-9);
		expect(out[0].t).to.equal(2);
		expect(out[0].v).to.deep.equal({"leg.near.up": 0, "leg.far.up": 10, ty: 3});
	});

	it("samplePose blends from the previous frame then holds", function () {
		const channels = [{name: "a", key: "a", rest: 0}];
		const out = [{t: 0, v: {a: 10}}];
		const end = samplePose({a: 0}, channels, 0.2, 0.2, 10, out, 0.1);
		expect(end).to.be.closeTo(0.5, 1e-9);
		expect(out.slice(1).map((f) => f.v.a)).to.deep.equal([10, 5, 0, 0]);
	});

	it("sampleWobble eases into a sinusoid around the pose", function () {
		const channels = [{name: "a", key: "a", rest: 0}];
		const out = [{t: 0, v: {a: 4}}];
		sampleWobble({a: 4}, {a: [4, 2, 1]}, channels, 1, 4, out, 0);
		expect(out.slice(1).map((f) => +f.v.a.toFixed(3))).to.deep.equal([4, 6, 4, 2]);
	});
});
