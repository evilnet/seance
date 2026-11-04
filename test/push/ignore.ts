import {expect} from "chai";
import {ignoredSender} from "../../client/js/push/ignore";

describe("push ignore list (client/js/push/ignore.ts)", function () {
	const nickEntry = {nick: "troll", ident: "*", hostname: "*"};
	const hostEntry = {nick: "*", ident: "*", hostname: "*.evil.example"};

	it("matches a nick entry, case-insensitively, with or without user and host", function () {
		expect(ignoredSender([nickEntry], "Troll")).to.equal(true);
		expect(ignoredSender([nickEntry], "troll", "t", "home.example")).to.equal(true);
		expect(ignoredSender([nickEntry], "friend", "t", "home.example")).to.equal(false);
	});

	it("matches a host entry only where the push carries the host", function () {
		expect(ignoredSender([hostEntry], "anyone", "x", "box.evil.example")).to.equal(true);
		// The JSON tier names the nick alone: a host mask cannot match it.
		expect(ignoredSender([hostEntry], "anyone")).to.equal(false);
	});

	it("is false for nothing mirrored, a damaged mirror or no nick", function () {
		expect(ignoredSender(undefined, "troll")).to.equal(false);
		expect(ignoredSender("troll", "troll")).to.equal(false);
		expect(ignoredSender([{nick: 5}, null], "troll")).to.equal(false);
		expect(ignoredSender([nickEntry], "")).to.equal(false);
	});
});
