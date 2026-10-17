import {expect} from "chai";
import {tierFor} from "../../../client/js/scenes/psng/tiers";
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
});
