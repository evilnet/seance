import {expect} from "chai";
import {
	applyEdit,
	applyReaction,
	applyRedaction,
	findMessageById,
	myReactions,
	replyQuote,
} from "../../client/js/helpers/messageUpdates";
import {MessageType, SharedMsg} from "../../shared/types/msg";

function msg(id: number, extra: Partial<SharedMsg> = {}): SharedMsg {
	return {
		id,
		time: new Date(1000 + id),
		type: MessageType.MESSAGE,
		users: [],
		msgid: `m${id}`,
		text: `text ${id}`,
		from: {nick: `nick${id}`, mode: ""},
		...extra,
	};
}

describe("message updates (msg:react / msg:redact / msg:edit)", function () {
	it("lists the reactions one nick has, whatever case they use", function () {
		const m = msg(1, {
			reactions: [
				{text: "👍", nicks: ["Alice", "bob"]},
				{text: "lol", nicks: ["bob"]},
				{text: "🎉", nicks: ["alICE"]},
			],
		});

		expect(myReactions(m, "alice")).to.deep.equal(["👍", "🎉"]);
		expect(myReactions(m, "bob")).to.deep.equal(["👍", "lol"]);
		expect(myReactions(m, "carol")).to.be.empty;
		expect(myReactions(msg(2), "alice")).to.be.empty;
	});

	it("finds messages by id, newest first", function () {
		const list = [msg(1), msg(2), msg(3)];
		expect(findMessageById(list, 2)).to.equal(list[1]);
		expect(findMessageById(list, 9)).to.be.undefined;
	});

	it("aggregates reactions, one nick per text, in first-seen order", function () {
		const m = msg(1);
		applyReaction(m, "👍", "alice", false);
		applyReaction(m, "❤️", "bob", false);
		applyReaction(m, "👍", "bob", false);
		applyReaction(m, "👍", "Alice", false); // duplicate (case-insensitive)

		expect(m.reactions).to.deep.equal([
			{text: "👍", nicks: ["alice", "bob"]},
			{text: "❤️", nicks: ["bob"]},
		]);
	});

	it("removes a nick and drops the entry at zero", function () {
		const m = msg(1);
		applyReaction(m, "👍", "alice", false);
		applyReaction(m, "👍", "bob", false);
		applyReaction(m, "🔥", "alice", false);

		applyReaction(m, "👍", "ALICE", true);
		expect(m.reactions).to.deep.equal([
			{text: "👍", nicks: ["bob"]},
			{text: "🔥", nicks: ["alice"]},
		]);

		applyReaction(m, "👍", "bob", true);
		expect(m.reactions).to.deep.equal([{text: "🔥", nicks: ["alice"]}]);

		applyReaction(m, "🔥", "alice", true);
		expect(m.reactions).to.be.undefined;

		// removing what is not there is a no-op
		applyReaction(m, "🔥", "alice", true);
		expect(m.reactions).to.be.undefined;
	});

	it("replaces the reactions array instead of mutating it", function () {
		const m = msg(1);
		applyReaction(m, "👍", "alice", false);
		const before = m.reactions;
		applyReaction(m, "👍", "bob", false);
		expect(m.reactions).to.not.equal(before);
		expect(before).to.deep.equal([{text: "👍", nicks: ["alice"]}]);
	});

	it("keeps the text on redaction", function () {
		const m = msg(1);
		const time = new Date();
		applyRedaction(m, {by: "op", reason: "spam", time});
		expect(m.redacted).to.deep.equal({by: "op", reason: "spam", time});
		expect(m.text).to.equal("text 1");
	});

	describe("applyEdit", function () {
		const ids = (list: SharedMsg[]) => list.map((m) => m.id);

		it("puts the edit in the original's place, with the original's time", function () {
			const list = [msg(1), msg(2), msg(3), msg(4, {editOf: "m2"})];
			const placed = applyEdit(list, 2, 4);

			expect(placed?.original).to.equal(list[1]);
			expect(placed?.replacement).to.equal(list[2]);
			expect(ids(list)).to.deep.equal([1, 2, 4, 3]);
			expect(list[1].supersededBy).to.equal(4);
			expect(list[2].time).to.deep.equal(new Date(1002));
			expect(list[2].editedAt).to.deep.equal(new Date(1004));
			// the original keeps its own time: it is what the edit inherited
			expect(list[1].time).to.deep.equal(new Date(1002));
		});

		it("chains: an edit of an edit keeps the first original's time", function () {
			const list = [msg(1), msg(2), msg(3, {editOf: "m1"})];
			applyEdit(list, 1, 3);
			list.push(msg(4, {editOf: "m3"}));
			applyEdit(list, 3, 4);

			expect(ids(list)).to.deep.equal([1, 3, 4, 2]);
			expect(list[1].supersededBy).to.equal(4);
			expect(list[2].time).to.deep.equal(new Date(1001));
			expect(list[2].editedAt).to.deep.equal(new Date(1004));
		});

		it("puts the newest of a chain in the place of an original that arrives last", function () {
			// E3 replaced an original not yet loaded, E4 replaced E3; then
			// an older page brings the original (1) in.
			const list = [msg(2), msg(3, {editOf: "m1"}), msg(4, {editOf: "m3"})];
			applyEdit(list, 3, 4);
			list.unshift(msg(1));
			const placed = applyEdit(list, 1, 3);

			expect(ids(list)).to.deep.equal([1, 3, 4, 2]);
			expect(placed?.replacement?.id).to.equal(4);
			// The one shown (4) stands where 1 was, with 1's time.
			expect(list[2].time).to.deep.equal(new Date(1001));
			expect(list[2].editedAt).to.deep.equal(new Date(1004));
			expect(list[0].supersededBy).to.equal(3);
			expect(list[1].supersededBy).to.equal(4);
		});

		it("changes nothing on a repeated dispatch", function () {
			const list = [msg(1), msg(2), msg(3, {editOf: "m1"})];
			applyEdit(list, 1, 3);
			applyEdit(list, 1, 3);

			expect(ids(list)).to.deep.equal([1, 3, 2]);
			expect(list[1].time).to.deep.equal(new Date(1001));
			expect(list[1].editedAt).to.deep.equal(new Date(1003));
		});

		it("hides the original even when the replacement is not loaded", function () {
			const list = [msg(1), msg(2)];
			const placed = applyEdit(list, 1, 9);

			expect(placed?.original).to.equal(list[0]);
			expect(placed?.replacement).to.equal(undefined);
			expect(list[0].supersededBy).to.equal(9);
			expect(ids(list)).to.deep.equal([1, 2]);
		});

		it("leaves the edit where it is when the original is not loaded", function () {
			const list = [msg(1), msg(2, {editOf: "gone"})];
			expect(applyEdit(list, 9, 2)).to.equal(undefined);
			expect(ids(list)).to.deep.equal([1, 2]);
			expect(list[1].editedAt).to.equal(undefined);
			expect(list[1].time).to.deep.equal(new Date(1002));
		});

		it("moves a replacement that sits ahead of its original", function () {
			const list = [msg(3, {editOf: "m1"}), msg(1), msg(2)];
			applyEdit(list, 1, 3);
			expect(ids(list)).to.deep.equal([1, 3, 2]);
		});
	});

	it("builds reply quotes from loaded parents only", function () {
		const list = [
			msg(1, {text: "  a   very\n long ".padEnd(120, "x")}),
			msg(2, {supersededBy: 3}),
			msg(3, {msgid: "m2", editOf: "m2", text: "new text"}),
		];

		const quote = replyQuote(list, "m1");
		expect(quote?.id).to.equal(1);
		expect(quote?.nick).to.equal("nick1");
		// raw and whole: QuotePreview.vue styles and cuts it
		expect(quote?.text).to.equal("  a   very\n long ".padEnd(120, "x"));

		// superseded message is skipped, the replacement (same msgid here) wins
		expect(replyQuote(list, "m2")?.text).to.equal("new text");
		expect(replyQuote(list, "nope")).to.be.undefined;
	});
});
