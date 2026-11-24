import {expect} from "chai";
import controlTakesKey from "../../client/js/helpers/controlTakesKey";

// The suite has no DOM: a target is only what the listener reads off it, so a
// fake stands in — `closest` returns the control when the element, or an
// ancestor of it, takes the key.
function control(inside: boolean, seen: string[] = []) {
	return {
		closest(selector: string) {
			seen.push(selector);

			return inside ? {selector} : null;
		},
	};
}

describe("Enter and Space stay with a focused control (client/js/helpers/controlTakesKey.ts)", function () {
	it("gives Enter and Space to a control the focus is on", function () {
		expect(controlTakesKey(control(true), 13)).to.equal(true);
		expect(controlTakesKey(control(true), 32)).to.equal(true);
	});

	it("gives neither key to the chat, so they still reach the composer", function () {
		expect(controlTakesKey(control(false), 13)).to.equal(false);
		expect(controlTakesKey(control(false), 32)).to.equal(false);
	});

	it("leaves a printable key to the composer even with a button focused", function () {
		const seen: string[] = [];

		expect(controlTakesKey(control(true, seen), 65)).to.equal(false);
		// Nothing to look up for a key that is not one of the two.
		expect(seen).to.deep.equal([]);
	});

	it("gives the other keys of the redirect back to the composer", function () {
		// PageDown (34) scrolls the message list, Backspace (8) is ignored:
		// neither becomes a control's own key.
		expect(controlTakesKey(control(true), 34)).to.equal(false);
		expect(controlTakesKey(control(true), 8)).to.equal(false);
	});

	it("does not throw on a target without closest()", function () {
		// A key event on the document or the window has no element to climb.
		expect(controlTakesKey(null, 13)).to.equal(false);
		expect(controlTakesKey({} as EventTarget, 13)).to.equal(false);
		expect(controlTakesKey({} as EventTarget, 32)).to.equal(false);
	});

	it("asks for the controls that take these keys, and no others", function () {
		const seen: string[] = [];

		controlTakesKey(control(true, seen), 13);

		expect(seen).to.have.length(1);
		expect(seen[0]).to.include("button");
		expect(seen[0]).to.include("a[href]");
		expect(seen[0]).to.include("select");
		expect(seen[0]).to.include("summary");
		expect(seen[0]).to.include('[role="button"]');
	});
});
