import {expect} from "chai";
import {
	paper,
	Circle,
	Ellipse,
	P,
	scaled,
	safeUnite,
	largest,
	resample,
	align,
	filletConcave,
	feetOf,
	outlineFrame,
} from "../../../tools/heart/lib/outline.mjs";

/** Two circles and a leg: the smallest rig that exercises near and far layers. */
const blob = {
	n: 64,
	nFar: 24,
	fillet: 4,
	farGroups: (items: unknown[]) => [items],
	root: {
		pivot: [0, 0],
		ty: "ty",
		children: [
			{
				pivot: [40, 40],
				rot: "leg",
				layer: "far",
				shapes: [P("M-4,0 L4,0 L4,30 L-4,30 Z")],
				foot: [0, 30],
			},
			{shapes: [Ellipse(50, 40, 30, 16), Circle(78, 34, 12)], marker: [90, 34]},
			{
				pivot: [60, 44],
				rot: "leg",
				shapes: [P("M-4,-6 L4,-6 L4,26 L-4,26 Z")],
				foot: [0, 26],
			},
		],
	},
};

describe("tools/heart outlines", function () {
	it("unites the near parts into one closed outline and keeps the largest piece", function () {
		const u = safeUnite([Circle(0, 0, 10), Circle(12, 0, 10)]);
		expect(u).to.not.be.null;
		expect(Math.abs(largest(u!).area)).to.be.greaterThan(Math.PI * 100 * 1.5);
	});

	it("refuses a union that grew past its parts (a hull-like blob)", function () {
		// Two far-apart circles unite into a CompoundPath whose area is their sum: fine.
		expect(safeUnite([Circle(0, 0, 10), Circle(100, 0, 10)])).to.not.be.null;
		// A cap smaller than the piece it caps at a coincident vertex is the case the mockup hit;
		// safeUnite's contract is the area check, so a fake item with an inflated area must be refused.
		const a = Circle(0, 0, 10);
		const blown = Object.create(a);
		blown.unite = () => ({area: 1e6, className: "Path"});
		expect(safeUnite([blown, Circle(3, 0, 4)])).to.be.null;
	});

	it("resamples clockwise from the marker and aligns to the previous frame", function () {
		const pts = resample(Circle(0, 0, 10), 8, new paper.Point(10, 0));
		expect(pts).to.have.length(16);
		expect(pts[0]).to.be.closeTo(10, 1e-6);
		expect(pts[1]).to.be.closeTo(0, 1e-6);
		// rotate the list by two points; align finds its way back
		const rolled = [...pts.slice(4), ...pts.slice(0, 4)];
		expect(align(rolled, pts).map((n) => +n.toFixed(6))).to.deep.equal(
			pts.map((n) => +n.toFixed(6))
		);
	});

	it("fillets only the concave vertices", function () {
		// a square with a notch: the notch's inner corner is concave, the outer corners convex
		const sq = [0, 0, 10, 0, 10, 4, 8, 4, 8, 6, 10, 6, 10, 10, 0, 10];
		const out = filletConcave(sq, 3, 0.5);
		expect(out.slice(0, 4)).to.deep.equal([0, 0, 10, 0]); // convex corners untouched
		expect(out[6]).to.be.greaterThan(8); // the notch's inner corner moved toward its neighbours
	});

	it("collects feet in rig space and outlines a frame with near and far layers", function () {
		const feet = feetOf(blob, {ty: 0, leg: 0});
		expect(feet).to.deep.equal([
			{layer: "far", x: 40, y: 70},
			{layer: "near", x: 60, y: 70},
		]);
		const frame = outlineFrame(blob, {ty: 0, leg: 0}, null);
		expect(frame.failed).to.be.false;
		expect(frame.layers.map((l) => l.cls)).to.deep.equal(["far", "near"]);
		expect(frame.layers[0].pts).to.have.length(48);
		expect(frame.layers[1].pts).to.have.length(128);
		const next = outlineFrame(blob, {ty: -2, leg: 10}, frame.layers);
		expect(next.layers[1].pts).to.have.length(128);
	});

	it("scaled clones about the origin", function () {
		const [c] = scaled([Circle(10, 0, 5)], 2, 1);
		expect(c.bounds.center.x).to.be.closeTo(20, 1e-6);
		expect(c.bounds.width).to.be.closeTo(20, 1e-6);
	});
});
