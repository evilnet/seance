import {expect} from "chai";
import {jumpStep} from "../../client/js/helpers/jumpToMessage";

const loaded = [{id: 10, msgid: "a"}, {id: 11, msgid: "b"}, {id: 12}];

describe("helpers/jumpToMessage.ts", function () {
	it("finds a loaded message by msgid, or by id", function () {
		expect(jumpStep(loaded, {msgid: "b"}, false)).to.deep.equal({kind: "found", id: 11});
		expect(jumpStep(loaded, {id: 12}, false)).to.deep.equal({kind: "found", id: 12});
	});

	it("finds a loaded message even with the first page still to come", function () {
		expect(jumpStep(loaded, {msgid: "a"}, true)).to.deep.equal({kind: "found", id: 10});
	});

	it("waits for the channel's first page before calling a message missing", function () {
		expect(jumpStep([], {msgid: "old"}, true)).to.deep.equal({kind: "first-page"});
		expect(jumpStep(loaded, {msgid: "old"}, true)).to.deep.equal({kind: "first-page"});
	});

	it("calls a message missing once the first page is in, however far back it is", function () {
		expect(jumpStep(loaded, {msgid: "old"}, false)).to.deep.equal({kind: "missing"});
		expect(jumpStep([], {msgid: "old"}, false)).to.deep.equal({kind: "missing"});
	});

	it("never takes a message with no msgid for the target", function () {
		expect(jumpStep(loaded, {msgid: undefined}, false)).to.deep.equal({kind: "missing"});
	});
});
