import {expect} from "chai";

import {createPowerMerge, framesSayLowPower, lowPowerFrom} from "../../client/js/helpers/power";

describe("power", () => {
	describe("lowPowerFrom", () => {
		it("a charging battery is not low", () => {
			expect(lowPowerFrom({battery: {charging: true, level: 0.05}, saver: null})).to.equal(
				false
			);
		});

		it("a discharging battery at 20 % is not low", () => {
			expect(lowPowerFrom({battery: {charging: false, level: 0.2}, saver: null})).to.equal(
				false
			);
		});

		it("a discharging battery at 19 % is low", () => {
			expect(lowPowerFrom({battery: {charging: false, level: 0.19}, saver: null})).to.equal(
				true
			);
		});

		it("the saver alone is low", () => {
			expect(lowPowerFrom({battery: null, saver: true})).to.equal(true);
		});

		it("no reading is not low", () => {
			expect(lowPowerFrom({battery: null, saver: null})).to.equal(false);
		});
	});

	describe("createPowerMerge", () => {
		const collect = () => {
			const calls: boolean[] = [];
			return {calls, merge: createPowerMerge((low) => calls.push(low))};
		};

		it("tells the level crossing", () => {
			const {calls, merge} = collect();
			merge.update({battery: {charging: false, level: 0.5}});
			merge.update({battery: {charging: false, level: 0.1}});
			expect(calls).to.deep.equal([false, true]);
		});

		it("the battery does not cancel the saver (saver first)", () => {
			const {calls, merge} = collect();
			merge.update({saver: true});
			merge.update({battery: {charging: true, level: 0.9}});
			expect(calls).to.deep.equal([true]);
			merge.update({saver: false});
			expect(calls).to.deep.equal([true, false]);
		});

		it("the battery does not cancel the saver (battery first)", () => {
			const {calls, merge} = collect();
			merge.update({battery: {charging: true, level: 0.9}});
			merge.update({saver: true});
			expect(calls).to.deep.equal([false, true]);
			merge.update({saver: false});
			expect(calls).to.deep.equal([false, true, false]);
		});

		it("a repeat that changes nothing calls set no more", () => {
			const {calls, merge} = collect();
			merge.update({battery: null});
			merge.update({battery: null});
			merge.update({saver: false});
			expect(calls).to.deep.equal([false]);
		});
	});

	describe("framesSayLowPower", () => {
		it("30 fps (33 ms a frame) is low power", () => {
			expect(framesSayLowPower(33)).to.equal(true);
		});

		it("60 fps (17 ms) is not", () => {
			expect(framesSayLowPower(17)).to.equal(false);
		});

		it("120 fps (8.3 ms) is not", () => {
			expect(framesSayLowPower(8.3)).to.equal(false);
		});
	});
});
