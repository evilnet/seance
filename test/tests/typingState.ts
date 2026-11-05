import {expect} from "chai";
import {t, tCount} from "../../client/js/i18n/core";
import {
	applyTyping,
	expireTyping,
	removeTyping,
	renameTyping,
	typingSummary,
	TYPING_ACTIVE_TTL,
	TYPING_PAUSED_TTL,
	TypingEntry,
} from "../../client/js/helpers/typingState";

describe("typing state (server→client `typing`)", function () {
	const T0 = 1_000_000;

	it("adds entries with the right expiry and keeps first-seen order", function () {
		let list: TypingEntry[] = [];
		list = applyTyping(list, "alice", "active", T0);
		list = applyTyping(list, "bob", "paused", T0);

		expect(list).to.deep.equal([
			{nick: "alice", state: "active", expiresAt: T0 + TYPING_ACTIVE_TTL},
			{nick: "bob", state: "paused", expiresAt: T0 + TYPING_PAUSED_TTL},
		]);
	});

	it("upserts by nick, case-insensitively, in place", function () {
		let list = applyTyping([], "alice", "active", T0);
		list = applyTyping(list, "bob", "active", T0);
		list = applyTyping(list, "ALICE", "paused", T0 + 100);

		expect(list.map((e) => e.nick)).to.deep.equal(["ALICE", "bob"]);
		expect(list[0]).to.deep.equal({
			nick: "ALICE",
			state: "paused",
			expiresAt: T0 + 100 + TYPING_PAUSED_TTL,
		});
	});

	it("removes on done and returns the same array when nothing changes", function () {
		const list = applyTyping([], "alice", "active", T0);
		expect(applyTyping(list, "nobody", "done", T0)).to.equal(list);
		expect(applyTyping(list, "Alice", "done", T0)).to.deep.equal([]);
		expect(removeTyping(list, "nobody")).to.equal(list);
		expect(removeTyping(list, "ALICE")).to.deep.equal([]);
	});

	it("never mutates the input array", function () {
		const list = applyTyping([], "alice", "active", T0);
		const copy = list.slice();
		applyTyping(list, "bob", "active", T0);
		applyTyping(list, "alice", "paused", T0);
		applyTyping(list, "alice", "done", T0);
		renameTyping(list, "alice", "alice2");
		expect(list).to.deep.equal(copy);
	});

	it("renames entries on nick change", function () {
		const list = applyTyping([], "alice", "paused", T0);
		const renamed = renameTyping(list, "ALICE", "alicia");
		expect(renamed).to.deep.equal([
			{nick: "alicia", state: "paused", expiresAt: T0 + TYPING_PAUSED_TTL},
		]);
		expect(renameTyping(list, "bob", "robert")).to.equal(list);
	});

	it("expires entries", function () {
		let list = applyTyping([], "alice", "active", T0);
		list = applyTyping(list, "bob", "paused", T0);

		expect(expireTyping(list, T0 + TYPING_ACTIVE_TTL - 1)).to.equal(list);
		expect(expireTyping(list, T0 + TYPING_ACTIVE_TTL).map((e) => e.nick)).to.deep.equal([
			"bob",
		]);
		expect(expireTyping(list, T0 + TYPING_PAUSED_TTL)).to.deep.equal([]);
	});

	it("summarises who is typing, in English through the catalog", function () {
		const e = (nick: string): TypingEntry => ({nick, state: "active", expiresAt: 0});
		const summary = (entries: TypingEntry[]) => typingSummary(entries, t, tCount);
		expect(summary([])).to.equal("");
		expect(summary([e("alice")])).to.equal("alice is typing…");
		expect(summary([e("alice"), e("bob")])).to.equal("alice and bob are typing…");
		expect(summary([e("alice"), e("bob"), e("carol")])).to.equal(
			"alice, bob and carol are typing…"
		);
		expect(summary([e("alice"), e("bob"), e("carol"), e("dave")])).to.equal(
			"alice, bob and 2 others are typing…"
		);
	});
});
