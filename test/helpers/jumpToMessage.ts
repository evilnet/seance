import {expect} from "chai";
import {MAX_JUMP_PAGES, jumpStep} from "../../client/js/helpers/jumpToMessage";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 12, minute));
const loaded = [
	{id: 10, msgid: "a", time: at(10)},
	{id: 11, msgid: "b", time: at(11)},
	{id: 12, time: at(12)},
];

describe("helpers/jumpToMessage.ts", function () {
	it("finds a loaded message by msgid, or by id", function () {
		expect(jumpStep(loaded, {msgid: "b"}, true, 0)).to.deep.equal({kind: "found", id: 11});
		expect(jumpStep(loaded, {id: 12}, true, 0)).to.deep.equal({kind: "found", id: 12});
	});

	it("takes the earlier of the two when given both", function () {
		expect(jumpStep(loaded, {id: 10, msgid: "b"}, true, 0)).to.deep.equal({
			kind: "found",
			id: 10,
		});
	});

	it("asks for an older page while the message is older than what is loaded", function () {
		const target = {msgid: "old", time: at(5).toISOString()};
		expect(jumpStep(loaded, target, true, 0)).to.deep.equal({kind: "more"});
		expect(jumpStep([], target, true, 0)).to.deep.equal({kind: "more"});
	});

	it("stops asking after a few pages, or when there is nothing more", function () {
		const target = {msgid: "old", time: at(5).toISOString()};
		const nearest = {kind: "nearest", id: 10};
		expect(jumpStep(loaded, target, true, MAX_JUMP_PAGES)).to.deep.equal(nearest);
		expect(jumpStep(loaded, target, false, 0)).to.deep.equal(nearest);
	});

	it("goes to the first message at or after the time of one that is gone", function () {
		const target = {msgid: "deleted", time: at(11).toISOString()};
		expect(jumpStep(loaded, target, true, 0)).to.deep.equal({kind: "nearest", id: 11});
	});

	it("gives up on a message newer than everything loaded, or without a time", function () {
		expect(jumpStep(loaded, {msgid: "x", time: at(30).toISOString()}, true, 0)).to.deep.equal({
			kind: "none",
		});
		expect(jumpStep(loaded, {msgid: "x"}, true, 0)).to.deep.equal({kind: "none"});
	});
});
