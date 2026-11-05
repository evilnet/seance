import {expect} from "chai";
import {jumpStep} from "../../client/js/helpers/jumpToMessage";

const loaded = [{id: 10, msgid: "a"}, {id: 11, msgid: "b"}, {id: 12}];

describe("helpers/jumpToMessage.ts", function () {
	it("finds a loaded message by msgid, or by id", function () {
		expect(jumpStep(loaded, {msgid: "b"})).to.deep.equal({kind: "found", id: 11});
		expect(jumpStep(loaded, {id: 12})).to.deep.equal({kind: "found", id: 12});
	});

	it("goes to the edit that replaced a loaded message", function () {
		expect(jumpStep([{id: 10, msgid: "a", supersededBy: 13}], {msgid: "a"})).to.deep.equal({
			kind: "found",
			id: 13,
		});
	});

	it("calls a message missing when it is not loaded, however far back it is", function () {
		expect(jumpStep(loaded, {msgid: "old"})).to.deep.equal({kind: "missing"});
		expect(jumpStep([], {msgid: "old"})).to.deep.equal({kind: "missing"});
	});

	it("never takes a message with no msgid for the target", function () {
		expect(jumpStep(loaded, {msgid: undefined})).to.deep.equal({kind: "missing"});
	});
});
