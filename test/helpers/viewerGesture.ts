import {expect} from "chai";
import {
	clampCentre,
	clampScale,
	DOUBLE_TAP_MS,
	doubleTapScale,
	isDoubleTap,
	lockAxis,
	MAX_SCALE,
	pinch,
	rubber,
	softCentre,
	softScale,
	swipeOutcome,
	type Swipe,
	zoomAbout,
} from "../../client/js/helpers/viewerGesture";

const box = {left: 0, top: 0, width: 400, height: 800};
const size = {width: 1000, height: 500};

describe("viewerGesture", function () {
	describe("zoomAbout", function () {
		it("keeps the point under the pointer where it was", function () {
			const view = {x: 200, y: 400, scale: 0.4};
			const point = {x: 50, y: 300};
			const next = zoomAbout(view, 1.2, point);
			// The image pixel under the point, before and after.
			const before = (point.x - view.x) / view.scale;
			const after = (point.x - next.x) / next.scale;

			expect(after).to.be.closeTo(before, 1e-9);
			expect((point.y - next.y) / next.scale).to.be.closeTo(
				(point.y - view.y) / view.scale,
				1e-9
			);
			expect(next.scale).to.equal(1.2);
		});
	});

	describe("pinch", function () {
		const base = {x: 200, y: 400, scale: 0.4};
		const same = (s: number) => s;

		it("zooms about the fingers, not the middle of the screen", function () {
			const from = {x: 40, y: 600, spread: 100};
			const to = {x: 40, y: 600, spread: 200};
			const next = pinch(base, from, to, same);

			expect(next.scale).to.be.closeTo(0.8, 1e-9);
			// The image pixel under the fingers stays under them.
			expect((to.x - next.x) / next.scale).to.be.closeTo(
				(from.x - base.x) / base.scale,
				1e-9
			);
			expect((to.y - next.y) / next.scale).to.be.closeTo(
				(from.y - base.y) / base.scale,
				1e-9
			);
		});

		it("pans with the fingers when they do not spread", function () {
			const next = pinch(
				base,
				{x: 100, y: 100, spread: 50},
				{x: 130, y: 90, spread: 50},
				same
			);

			expect(next).to.deep.equal({x: 230, y: 390, scale: 0.4});
		});

		it("takes the scale through the given bound", function () {
			const next = pinch(base, {x: 0, y: 0, spread: 10}, {x: 0, y: 0, spread: 1000}, (s) =>
				clampScale(s, 0.4, MAX_SCALE)
			);

			expect(next.scale).to.equal(MAX_SCALE);
		});
	});

	describe("rubber and the soft bounds", function () {
		it("shows less than the overshoot, never the whole extent, and keeps the sign", function () {
			expect(rubber(0, 100)).to.equal(0);
			expect(rubber(50, 100)).to.be.within(0, 50);
			expect(rubber(-50, 100)).to.equal(-rubber(50, 100));
			expect(rubber(1e9, 100)).to.be.below(100);
			expect(rubber(100, 100)).to.be.above(rubber(50, 100));
		});

		it("lets a scale stretch past its bounds, damped", function () {
			expect(softScale(1, 0.5, 2)).to.equal(1);
			expect(softScale(0.25, 0.5, 2)).to.be.within(0.25, 0.5);
			expect(softScale(4, 0.5, 2)).to.be.within(2, 4);
		});

		it("centres a picture smaller than the box and keeps a larger one's edges out", function () {
			// 1000×500 at 0.4 is 400×200: as wide as the box, shorter.
			expect(clampCentre({x: 10, y: 10, scale: 0.4}, size, box)).to.deep.equal({
				x: 200,
				y: 400,
			});
			// At 2 it is 2000×1000: its left edge may not come inside x=0.
			expect(clampCentre({x: 1500, y: 400, scale: 2}, size, box)).to.deep.equal({
				x: 1000,
				y: 400,
			});
			expect(clampCentre({x: -900, y: 400, scale: 2}, size, box)).to.deep.equal({
				x: -600,
				y: 400,
			});
		});

		it("lets a centre dragged past its place stretch toward the drag", function () {
			const soft = softCentre({x: 1100, y: 500, scale: 2}, size, box);

			expect(soft.x).to.be.within(1000, 1100);
			expect(soft.y).to.equal(500);
		});
	});

	describe("lockAxis", function () {
		it("waits out the slop, then takes the larger way", function () {
			expect(lockAxis(3, 4)).to.equal(null);
			expect(lockAxis(30, 4)).to.equal("x");
			expect(lockAxis(-3, 40)).to.equal("y");
		});
	});

	describe("swipeOutcome", function () {
		const swipe = (s: Partial<Swipe>): Swipe => ({
			axis: "x",
			distance: 0,
			velocity: 0,
			extent: 400,
			rtl: false,
			hasNext: true,
			hasPrevious: true,
			...s,
		});

		it("closes on a long or quick drag up or down", function () {
			expect(swipeOutcome(swipe({axis: "y", extent: 800, distance: 200}))).to.equal("close");
			expect(swipeOutcome(swipe({axis: "y", extent: 800, distance: -200}))).to.equal("close");
			expect(
				swipeOutcome(swipe({axis: "y", extent: 800, distance: 60, velocity: 1}))
			).to.equal("close");
		});

		it("springs back from a short, slow or reversed drag", function () {
			expect(swipeOutcome(swipe({axis: "y", extent: 800, distance: 60}))).to.equal("stay");
			expect(
				swipeOutcome(swipe({axis: "y", extent: 800, distance: 60, velocity: -1}))
			).to.equal("stay");
			expect(swipeOutcome(swipe({distance: 20, velocity: 2}))).to.equal("stay");
		});

		it("goes to the next picture on a drag left, the previous on a drag right", function () {
			expect(swipeOutcome(swipe({distance: -150}))).to.equal("next");
			expect(swipeOutcome(swipe({distance: 150}))).to.equal("previous");
		});

		it("mirrors right to left", function () {
			expect(swipeOutcome(swipe({rtl: true, distance: -150}))).to.equal("previous");
			expect(swipeOutcome(swipe({rtl: true, distance: 150}))).to.equal("next");
		});

		it("stays where there is no picture that way", function () {
			expect(swipeOutcome(swipe({distance: -150, hasNext: false}))).to.equal("stay");
			expect(swipeOutcome(swipe({distance: 150, hasPrevious: false}))).to.equal("stay");
		});
	});

	describe("double tap", function () {
		it("needs the second tap soon and close", function () {
			const first = {x: 100, y: 100, at: 1000};

			expect(isDoubleTap(null, first)).to.equal(false);
			expect(isDoubleTap(first, {x: 110, y: 105, at: 1200})).to.equal(true);
			expect(isDoubleTap(first, {x: 110, y: 105, at: 1000 + DOUBLE_TAP_MS})).to.equal(false);
			expect(isDoubleTap(first, {x: 200, y: 100, at: 1100})).to.equal(false);
		});

		it("zooms a fitted picture in and any zoomed one back to fitted", function () {
			// A large picture fitted at 0.2 goes to its own pixels.
			expect(doubleTapScale(0.2, 0.2)).to.equal(1);
			// A small one shown at its own size goes to 2.5×.
			expect(doubleTapScale(1, 1)).to.equal(2.5);
			// Never past the maximum.
			expect(doubleTapScale(1.4, 1.4)).to.equal(MAX_SCALE);
			// Zoomed: back to fitted.
			expect(doubleTapScale(1.5, 0.2)).to.equal(0.2);
		});
	});
});
