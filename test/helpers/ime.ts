import {expect} from "chai";
import {isImeComposing} from "../../client/js/helpers/ime";

function key(init: {isComposing?: boolean; keyCode?: number}): KeyboardEvent {
	return {isComposing: false, keyCode: 13, ...init} as KeyboardEvent;
}

describe("isImeComposing (helpers/ime.ts)", function () {
	it("is a Return marked as composing (Chrome, Firefox)", function () {
		expect(isImeComposing(key({isComposing: true}))).to.equal(true);
	});

	it("is a Return with keyCode 229 after the composition ended (Safari)", function () {
		expect(isImeComposing(key({keyCode: 229}))).to.equal(true);
	});

	it("is not a plain Return", function () {
		expect(isImeComposing(key({}))).to.equal(false);
	});
});
