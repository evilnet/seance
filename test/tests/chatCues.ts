import {expect} from "chai";
import {MessageType} from "../../shared/types/msg";
import {createChatCues, cueForMessage, CUE_MS, type ChatCue} from "../../client/js/chatCues";

/** The cue rules on a hand-wound clock, recording what they showed. */
function rig(allowed = () => true) {
	let t = 0;
	let timers: {at: number; fn: () => void}[] = [];
	const shown: (ChatCue | null)[] = [];
	const cues = createChatCues({
		show: (cue) => shown.push(cue),
		allowed,
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
	return {fire: (c: ChatCue) => cues.fire(c), clear: () => cues.clear(), shown, advance};
}

describe("chat cues (chatCues.ts)", function () {
	describe("cueForMessage", function () {
		it("cues others' joins, messages and mentions", function () {
			expect(cueForMessage({type: MessageType.JOIN})).to.equal("join");
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
			expect(cueForMessage({type: MessageType.PART})).to.equal(null);
			expect(cueForMessage({type: MessageType.QUIT})).to.equal(null);
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

		it("every cue shows, each replacing the last with its own full time", function () {
			const {fire, shown, advance} = rig();
			fire("join");
			advance(CUE_MS - 1);
			fire("message");
			fire("message");
			advance(CUE_MS - 1);
			expect(shown).to.deep.equal(["join", "message", "message"]);
			advance(1);
			expect(shown).to.deep.equal(["join", "message", "message", null]);
		});

		it("only a mention cuts a mention short", function () {
			const {fire, shown, advance} = rig();
			fire("mention");
			fire("message");
			fire("join");
			fire("mention");
			advance(CUE_MS);
			fire("message");
			expect(shown).to.deep.equal(["mention", "mention", null, "message"]);
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

		it("clear ends the cue showing and its timer, and is a no-op with none", function () {
			const {fire, clear, shown, advance} = rig();
			fire("mention");
			clear();
			advance(CUE_MS);
			clear();
			fire("message");
			expect(shown).to.deep.equal(["mention", null, "message"]);
		});
	});
});
