import {expect} from "chai";
import {tipPlacement} from "../../client/js/helpers/tipPlacement";

describe("tipPlacement", function () {
	const viewport = {width: 1000, height: 800};
	const chip = (left: number, top: number) => ({left, top, right: left + 40, bottom: top + 20});

	it("centres the label above its anchor, its pointer at the anchor's centre", function () {
		const p = tipPlacement(chip(480, 400), {width: 200, height: 60}, viewport);
		expect(p).to.deep.equal({left: 400, top: 334, above: true, arrow: 100, pointer: true});
	});

	it("slides it along to keep clear of the left and right edges, the pointer still on the anchor", function () {
		const atStart = tipPlacement(chip(10, 400), {width: 320, height: 60}, viewport);
		expect(atStart.left).to.equal(8);
		expect(atStart.arrow).to.equal(22);

		const atEnd = tipPlacement(chip(950, 400), {width: 320, height: 60}, viewport);
		expect(atEnd.left).to.equal(1000 - 8 - 320);
		expect(atEnd.arrow).to.equal(970 - atEnd.left);
	});

	it("goes below when above has not the room and below has", function () {
		const p = tipPlacement(chip(480, 40), {width: 200, height: 120}, viewport);
		expect(p.above).to.equal(false);
		expect(p.top).to.equal(66);
		expect(p.pointer).to.equal(true);
	});

	it("stays above when neither side has the room and above has more, held on screen over its anchor", function () {
		const p = tipPlacement(chip(480, 700), {width: 300, height: 790}, viewport);
		expect(p.above).to.equal(true);
		expect(p.top).to.equal(8);
		expect(p.pointer).to.equal(false);
	});

	it("keeps the pointer clear of the label's rounded ends", function () {
		const p = tipPlacement(chip(0, 400), {width: 320, height: 40}, {width: 400, height: 800});
		expect(p.arrow).to.be.at.least(10);
		expect(p.arrow).to.be.at.most(310);
	});
});
