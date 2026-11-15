import {expect} from "chai";
import {MessageType} from "../../shared/types/msg";
import {
	createChatCues,
	cueForMessage,
	CUE_MS,
	QUIET_MS,
	type ChatCue,
} from "../../client/js/chatCues";

/** The cue rules on a hand-wound clock, recording what they showed. */
function rig(allowed = () => true) {
	let t = 0;
	let timers: {at: number; fn: () => void}[] = [];
	const shown: (ChatCue | null)[] = [];
	const fire = createChatCues({
		show: (cue) => shown.push(cue),
		allowed,
		now: () => t,
		after(ms, fn) {
			const timer = {at: t + ms, fn};
			timers.push(timer);
			return () => (timers = timers.filter((x) => x !== timer));
		},
	});
	const advance = (ms: number) => {
		t += ms;
		const due = timers.filter((x) => x.at <= t);
		timers = timers.filter((x) => x.at > t);
		due.forEach((x) => x.fn());
	};
	return {fire, shown, advance};
}

describe("chat cues (chatCues.ts)", function () {
	describe("cueForMessage", function () {
		it("cues others' joins, parts, messages and mentions", function () {
			expect(cueForMessage({type: MessageType.JOIN})).to.equal("join");
			expect(cueForMessage({type: MessageType.PART})).to.equal("part");
			expect(cueForMessage({type: MessageType.QUIT})).to.equal("part");
			expect(cueForMessage({type: MessageType.KICK})).to.equal("part");
			expect(cueForMessage({type: MessageType.MESSAGE})).to.equal("message");
			expect(cueForMessage({type: MessageType.ACTION})).to.equal("message");
			expect(cueForMessage({type: MessageType.MESSAGE, highlight: true})).to.equal("mention");
		});

		it("never cues our own lines, a pending copy, an edit or anything else", function () {
			expect(cueForMessage({type: MessageType.JOIN, self: true})).to.equal(null);
			expect(cueForMessage({type: MessageType.MESSAGE, pending: true})).to.equal(null);
			expect(cueForMessage({type: MessageType.MESSAGE, editOf: "x"})).to.equal(null);
			expect(cueForMessage({type: MessageType.NOTICE})).to.equal(null);
			expect(cueForMessage({type: MessageType.TOPIC})).to.equal(null);
			expect(cueForMessage({type: MessageType.MODE})).to.equal(null);
		});
	});

	describe("createChatCues", function () {
		it("shows a cue for CUE_MS, then ends it", function () {
			const {fire, shown, advance} = rig();
			fire("join");
			advance(CUE_MS - 1);
			expect(shown).to.deep.equal(["join"]);
			advance(1);
			expect(shown).to.deep.equal(["join", null]);
		});

		it("drops a second cue while one shows, and waits QUIET_MS after one ends", function () {
			const {fire, shown, advance} = rig();
			fire("join");
			fire("message");
			fire("join");
			advance(CUE_MS);
			fire("message");
			advance(QUIET_MS);
			fire("message");
			expect(shown).to.deep.equal(["join", null, "message"]);
		});

		it("a mention replaces any other cue and skips the quiet, but not another mention", function () {
			const {fire, shown, advance} = rig();
			fire("message");
			fire("mention");
			fire("mention");
			// The mention's own full time, not what was left of the message's.
			advance(CUE_MS - 1);
			expect(shown).to.deep.equal(["message", "mention"]);
			advance(1);
			fire("mention");
			expect(shown).to.deep.equal(["message", "mention", null, "mention"]);
		});

		it("shows nothing while not allowed (hidden page, reduced motion)", function () {
			let ok = false;
			const {fire, shown} = rig(() => ok);
			fire("mention");
			expect(shown).to.deep.equal([]);
			ok = true;
			fire("join");
			expect(shown).to.deep.equal(["join"]);
		});
	});
});
