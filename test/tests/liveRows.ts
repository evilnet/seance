import {expect} from "chai";
import {MessageType} from "../../shared/types/msg";
import {createLiveRows, liveKindOf, LIVE_MS} from "../../client/js/liveRows";

describe("live rows (liveRows.ts)", function () {
	describe("liveKindOf", function () {
		it("marks others' messages, actions, mentions and joins", function () {
			expect(liveKindOf({type: MessageType.MESSAGE})).to.equal("message");
			expect(liveKindOf({type: MessageType.ACTION})).to.equal("message");
			expect(liveKindOf({type: MessageType.MESSAGE, highlight: true})).to.equal("mention");
			expect(liveKindOf({type: MessageType.ACTION, highlight: true})).to.equal("mention");
			expect(liveKindOf({type: MessageType.JOIN})).to.equal("join");
		});

		it("never marks our own lines, a pending copy, an edit or another kind", function () {
			expect(liveKindOf({type: MessageType.MESSAGE, self: true})).to.equal(null);
			expect(liveKindOf({type: MessageType.JOIN, self: true})).to.equal(null);
			expect(liveKindOf({type: MessageType.MESSAGE, pending: true})).to.equal(null);
			expect(liveKindOf({type: MessageType.MESSAGE, editOf: "x"})).to.equal(null);

			for (const type of [
				MessageType.NOTICE,
				MessageType.PART,
				MessageType.QUIT,
				MessageType.MODE,
				MessageType.TOPIC,
			]) {
				expect(liveKindOf({type}), type).to.equal(null);
			}
		});
	});

	describe("createLiveRows", function () {
		let t = 0;
		const rows = () => createLiveRows(() => t);

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
});
