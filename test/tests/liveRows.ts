import {expect} from "chai";
import {MessageType} from "../../shared/types/msg";
import {
	chipKey,
	createLiveRows,
	liveKindOf,
	LIVE_MS,
	reactionArrival,
	type ArrivalKind,
	type LiveKind,
} from "../../client/js/liveRows";

describe("live rows (liveRows.ts)", function () {
	describe("liveKindOf", function () {
		it("marks others' messages, actions, mentions and joins", function () {
			expect(liveKindOf({type: MessageType.MESSAGE})).to.equal("message");
			expect(liveKindOf({type: MessageType.ACTION})).to.equal("message");
			expect(liveKindOf({type: MessageType.MESSAGE, highlight: true})).to.equal("mention");
			expect(liveKindOf({type: MessageType.ACTION, highlight: true})).to.equal("mention");
			expect(liveKindOf({type: MessageType.JOIN})).to.equal("join");
		});

		it("marks someone leaving: a part, a quit, a kick", function () {
			expect(liveKindOf({type: MessageType.PART})).to.equal("part");
			expect(liveKindOf({type: MessageType.QUIT})).to.equal("quit");
			expect(liveKindOf({type: MessageType.KICK})).to.equal("kick");
			// A kick's `self` is the kicker, and its highlight is us kicked:
			// someone leaves either way.
			expect(liveKindOf({type: MessageType.KICK, self: true})).to.equal("kick");
			expect(liveKindOf({type: MessageType.KICK, highlight: true})).to.equal("kick");
		});

		it("marks our own line as the server confirms it", function () {
			// The echo replacing a pending copy, or the line itself without
			// echo-message: both are a non-pending line of ours.
			expect(liveKindOf({type: MessageType.MESSAGE, self: true})).to.equal("self");
			expect(liveKindOf({type: MessageType.ACTION, self: true})).to.equal("self");
			expect(liveKindOf({type: MessageType.MESSAGE, self: true, highlight: true})).to.equal(
				"self"
			);
		});

		it("never marks a pending copy, an edit, our own status lines or another kind", function () {
			expect(liveKindOf({type: MessageType.MESSAGE, self: true, pending: true})).to.equal(
				null
			);
			expect(liveKindOf({type: MessageType.MESSAGE, self: true, editOf: "x"})).to.equal(null);
			expect(liveKindOf({type: MessageType.MESSAGE, pending: true})).to.equal(null);
			expect(liveKindOf({type: MessageType.MESSAGE, editOf: "x"})).to.equal(null);
			expect(liveKindOf({type: MessageType.KICK, editOf: "x"})).to.equal(null);

			for (const type of [MessageType.JOIN, MessageType.PART, MessageType.QUIT]) {
				expect(liveKindOf({type, self: true}), type).to.equal(null);
			}

			for (const type of [
				MessageType.NOTICE,
				MessageType.NICK,
				MessageType.MODE,
				MessageType.TOPIC,
				MessageType.AWAY,
			]) {
				expect(liveKindOf({type}), type).to.equal(null);
				expect(liveKindOf({type, self: true}), type).to.equal(null);
			}
		});
	});

	describe("reactionArrival", function () {
		const r = (text: string, ...nicks: string[]) => ({text, nicks});

		it("tells the message's first chip, another chip and another nick apart", function () {
			expect(reactionArrival(undefined, "👍", "bob", false)).to.equal("first");
			expect(reactionArrival([], "👍", "bob", false)).to.equal("first");
			expect(reactionArrival([r("👍", "bob")], "🎉", "carol", false)).to.equal("new");
			expect(reactionArrival([r("👍", "bob")], "👍", "carol", false)).to.equal("more");
		});

		it("marks nothing for a removal or a nick already on the chip", function () {
			expect(reactionArrival([r("👍", "bob")], "👍", "bob", true)).to.equal(null);
			expect(reactionArrival(undefined, "👍", "bob", true)).to.equal(null);
			expect(reactionArrival([r("👍", "Bob")], "👍", "bob", false)).to.equal(null);
		});
	});

	describe("createLiveRows", function () {
		let t = 0;
		const rows = () => createLiveRows<number, LiveKind>(() => t);

		beforeEach(function () {
			t = 0;
		});

		it("a mounted row takes its note once", function () {
			const live = rows();
			live.mark(7, "mention");
			expect(live.take(7)).to.equal("mention");
			// Mounted again (another conversation and back): not new.
			expect(live.take(7)).to.equal(null);
		});

		it("a row with no note takes nothing", function () {
			expect(rows().take(1)).to.equal(null);
		});

		it("a row that mounts after LIVE_MS is not new", function () {
			const live = rows();
			live.mark(3, "message");
			t = LIVE_MS;
			live.mark(4, "message");
			expect(live.take(3)).to.equal("message");
			t = LIVE_MS + 1;
			expect(live.take(4)).to.equal("message");
			live.mark(5, "join");
			t += LIVE_MS + 1;
			expect(live.take(5)).to.equal(null);
		});

		it("stale notes are dropped as new ones come", function () {
			const live = rows();
			live.mark(1, "message");
			t = LIVE_MS + 1;
			live.mark(2, "message");
			t = 0; // were it still held, a rewound clock would hand it out
			expect(live.take(1)).to.equal(null);
			expect(live.take(2)).to.equal("message");
		});
	});

	describe("chips", function () {
		it("are noted by message and text", function () {
			const chips = createLiveRows<string, ArrivalKind>(() => 0);
			chips.mark(chipKey(7, "👍"), "first");
			expect(chips.take(chipKey(7, "🎉"))).to.equal(null);
			expect(chips.take(chipKey(8, "👍"))).to.equal(null);
			expect(chips.take(chipKey(7, "👍"))).to.equal("first");
		});

		it("noted late with the time it arrived, fresh from that time", function () {
			// A reaction held behind a page of history (msg_updates.ts) is noted
			// when it is applied, with the time it came.
			let t = 0;
			const chips = createLiveRows<string, ArrivalKind>(() => t);
			t = LIVE_MS + 500;
			chips.mark(chipKey(7, "👍"), "first", 0);
			expect(chips.take(chipKey(7, "👍"))).to.equal(null);
			chips.mark(chipKey(7, "🎉"), "new", 600);
			expect(chips.take(chipKey(7, "🎉"))).to.equal("new");
		});
	});
});
