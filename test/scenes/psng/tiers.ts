import {expect} from "chai";
import {phaseSeconds, tierFor} from "../../../client/js/scenes/psng/tiers";
import type {SceneHostState, SceneMotion} from "../../../client/js/themeScene";

describe("ps NG tiers (psng/tiers.ts)", function () {
	const motions: SceneMotion[] = ["auto", "full", "calm", "still"];
	let rows = 0;

	for (const visible of [true, false]) {
		for (const attended of [true, false]) {
			for (const view of ["channel", "query"] as const) {
				for (const reduce of [true, false]) {
					for (const motion of motions) {
						const state: SceneHostState = {visible, attended, view, motion};
						const still = !visible || !attended || view === "query" || reduce;
						const want =
							still || motion === "still"
								? "still"
								: motion === "calm"
								? "calm"
								: "full";
						rows++;
						it(`${JSON.stringify(state)} reduce=${reduce} is ${want}`, function () {
							expect(tierFor(state, reduce)).to.equal(want);
						});
					}
				}
			}
		}
	}

	it("covers every combination", function () {
		expect(rows).to.equal(64);
	});

	it("phaseSeconds: from local midnight of the reference's day, past its midnight too", function () {
		const mounted = new Date(2026, 5, 21, 9);
		expect(phaseSeconds(new Date(2026, 5, 21, 0, 1, 30), mounted)).to.equal(90);
		expect(phaseSeconds(new Date(2026, 5, 22, 0, 0, 10), mounted)).to.equal(86410);
	});
});
