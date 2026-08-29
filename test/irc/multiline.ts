import {expect} from "chai";
import {MessageType} from "../../shared/types/msg";
import {joined, register, setup, Harness} from "./support";

/** The dev ircd's advertisement, plus everything else the harness registers with. */
const CAPS =
	"message-tags server-time echo-message batch labeled-response standard-replies " +
	"draft/chathistory=100 draft/event-playback draft/message-redaction " +
	"draft/multiline=max-bytes=16384,max-lines=100";
/** Same, but the server never echoes our own messages back. */
const NO_ECHO = CAPS.replace("echo-message ", "");

/** The lines of a `draft/multiline` batch `bob` said in #seance. */
function batchLines(h: Harness, ref: string, opener: string, ...lines: string[]): void {
	h.transport.line(`${opener} :bob!bob@host BATCH +${ref} draft/multiline #seance`);
	h.transport.lines(...lines);
	h.transport.line(`:bob!bob@host BATCH -${ref}`);
}

describe("draft/multiline", function () {
	describe("receiving", function () {
		it("joins a batch's lines into one message with the opener's tags", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			batchLines(
				h,
				"ml1",
				"@time=2026-08-25T12:01:00.000Z;msgid=m1;account=bobby",
				"@batch=ml1 :bob!bob@host PRIVMSG #seance :first line",
				"@batch=ml1 :bob!bob@host PRIVMSG #seance :second line"
			);

			const msgs = h.messages(chanId);
			expect(msgs).to.have.length(1);
			expect(msgs[0].text).to.equal("first line\nsecond line");
			expect(msgs[0].type).to.equal(MessageType.MESSAGE);
			expect(msgs[0].from?.nick).to.equal("bob");
			expect(msgs[0].msgid).to.equal("m1");
			expect(msgs[0].fromAccount).to.equal("bobby");
			expect(msgs[0].time.toISOString()).to.equal("2026-08-25T12:01:00.000Z");
		});

		it("appends a draft/multiline-concat line without a newline", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			batchLines(
				h,
				"ml2",
				"@msgid=m2",
				"@batch=ml2 :bob!bob@host PRIVMSG #seance :one long ",
				"@batch=ml2;draft/multiline-concat :bob!bob@host PRIVMSG #seance :sentence",
				"@batch=ml2 :bob!bob@host PRIVMSG #seance :and a second line"
			);

			expect(h.lastMessage(chanId).text).to.equal("one long sentence\nand a second line");
		});

		it("keeps blank lines inside the message", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			batchLines(
				h,
				"ml3",
				"@msgid=m3",
				"@batch=ml3 :bob!bob@host PRIVMSG #seance :top",
				"@batch=ml3 :bob!bob@host PRIVMSG #seance :",
				"@batch=ml3 :bob!bob@host PRIVMSG #seance :bottom"
			);

			expect(h.lastMessage(chanId).text).to.equal("top\n\nbottom");
		});

		it("carries the reply tag from the opener", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			batchLines(
				h,
				"ml4",
				"@msgid=m4;+draft/reply=parent",
				"@batch=ml4 :bob!bob@host PRIVMSG #seance :a",
				"@batch=ml4 :bob!bob@host PRIVMSG #seance :b"
			);

			expect(h.lastMessage(chanId).replyTo).to.equal("parent");
		});

		it("makes one message out of a NOTICE batch", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			batchLines(
				h,
				"ml5",
				"@msgid=m5",
				"@batch=ml5 :bob!bob@host NOTICE #seance :heads",
				"@batch=ml5 :bob!bob@host NOTICE #seance :up"
			);

			const msg = h.lastMessage(chanId);
			expect(msg.type).to.equal(MessageType.NOTICE);
			expect(msg.text).to.equal("heads\nup");
		});

		it("is one message inside a chathistory replay", function () {
			const h = setup();
			joined(h, CAPS);

			// An unsolicited chathistory batch is delivered as older history.
			h.transport.lines(
				":irc.test BATCH +outer chathistory #seance",
				"@batch=outer;time=2026-08-25T11:02:00.000Z;msgid=m6 :irc.test BATCH +ml draft/multiline #seance",
				"@batch=ml :bob!bob@host PRIVMSG #seance :first",
				"@batch=ml :bob!bob@host PRIVMSG #seance :second",
				"@batch=outer :irc.test BATCH -ml",
				":irc.test BATCH -outer"
			);

			const [more] = h.payloads<{messages: {text?: string; msgid?: string}[]}>("more");
			expect(more.messages.map((m) => m.text)).to.deep.equal(["first\nsecond"]);
			expect(more.messages[0].msgid).to.equal("m6");
		});
	});

	describe("sending", function () {
		it("wraps a multi-line message in one batch", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			h.client.input(chanId, "first line\nsecond line");

			expect(h.sent()).to.deep.equal([
				"BATCH +ml1 draft/multiline #seance",
				"@batch=ml1 PRIVMSG #seance :first line",
				"@batch=ml1 PRIVMSG #seance :second line",
				"BATCH -ml1",
			]);
		});

		it("puts the reply tag on the batch opener only", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			h.client.input(chanId, "a\nb", {reply: "parent"});

			const sent = h.sent();
			expect(sent[0]).to.equal("@+draft/reply=parent BATCH +ml1 draft/multiline #seance");
			expect(sent[1]).to.equal("@batch=ml1 PRIVMSG #seance :a");
		});

		it("splits an over-long line with the concat tag", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			h.client.input(chanId, `${"x".repeat(600)}\ntail`);

			const sent = h.sent();
			expect(sent).to.have.length(5);
			expect(sent[1].startsWith("@batch=ml1 PRIVMSG #seance :xxx")).to.equal(true);
			expect(sent[2].startsWith("@batch=ml1;draft/multiline-concat PRIVMSG")).to.equal(true);
			expect(sent[3]).to.equal("@batch=ml1 PRIVMSG #seance :tail");
			expect(sent[4]).to.equal("BATCH -ml1");
			// Reassembled by the receiver, the 600 x's are one line again.
			const bodies = sent.slice(1, 4).map((l) => l.slice(l.indexOf(" :") + 2));
			expect(bodies[0] + bodies[1]).to.equal("x".repeat(600));
		});

		it("keeps a blank line in the middle as an empty batch line", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			h.client.input(chanId, "top\n\nbottom\n");

			expect(h.sent()).to.deep.equal([
				"BATCH +ml1 draft/multiline #seance",
				"@batch=ml1 PRIVMSG #seance :top",
				"@batch=ml1 PRIVMSG #seance :",
				"@batch=ml1 PRIVMSG #seance :bottom",
				"BATCH -ml1",
			]);
		});

		it("sends a line at a time when the server has no draft/multiline", function () {
			const h = setup();
			const chanId = joined(h);

			h.client.input(chanId, "first\nsecond");

			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :first", "PRIVMSG #seance :second"]);
		});

		it("falls back to a line at a time over the server's max-lines", function () {
			const h = setup();
			const chanId = joined(h, `${CAPS.replace(",max-lines=100", ",max-lines=2")}`);

			h.client.input(chanId, "a\nb\nc");

			expect(h.sent()).to.deep.equal([
				"PRIVMSG #seance :a",
				"PRIVMSG #seance :b",
				"PRIVMSG #seance :c",
			]);
		});

		it("falls back to a line at a time over the server's max-bytes", function () {
			const h = setup();
			const chanId = joined(h, CAPS.replace("max-bytes=16384", "max-bytes=4"));

			h.client.input(chanId, "abc\ndef");

			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :abc", "PRIVMSG #seance :def"]);
		});

		it("still runs commands one line at a time, grouping the text between them", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			h.client.input(chanId, "hello\nthere\n/topic new topic\nbye");

			expect(h.sent()).to.deep.equal([
				"BATCH +ml1 draft/multiline #seance",
				"@batch=ml1 PRIVMSG #seance :hello",
				"@batch=ml1 PRIVMSG #seance :there",
				"BATCH -ml1",
				"TOPIC #seance :new topic",
				"PRIVMSG #seance :bye",
			]);
		});

		it("shows our own multiline message without echo-message", function () {
			const h = setup();
			const chanId = joined(h, NO_ECHO);

			h.client.input(chanId, "one\ntwo");

			const msgs = h.messages(chanId);
			expect(msgs).to.have.length(1);
			expect(msgs[0].text).to.equal("one\ntwo");
			expect(msgs[0].self).to.equal(true);
		});

		it("says the lines separately when the server FAILs the batch", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			h.client.input(chanId, "one\ntwo");
			h.sent();
			h.transport.line(
				":irc.test FAIL BATCH MULTILINE_COOLDOWN 3 :Multiline batch cooldown active"
			);

			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :one", "PRIVMSG #seance :two"]);
			// A cooldown is the server pacing us; nothing for the user to read.
			expect(h.messages(h.client.lobby.id)).to.have.length(0);
		});

		it("re-sends the batch the FAIL is about, not an echoed earlier one", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			h.client.input(chanId, "one\ntwo");
			h.client.input(chanId, "three\nfour");
			h.sent();
			// The first batch was taken: the server echoes it back to us.
			h.transport.lines(
				"@time=2026-08-25T12:02:00.000Z;msgid=e1 :alice!alice@host.example BATCH +srv1 draft/multiline #seance",
				"@batch=srv1 :alice!alice@host.example PRIVMSG #seance :one",
				"@batch=srv1 :alice!alice@host.example PRIVMSG #seance :two",
				":alice!alice@host.example BATCH -srv1"
			);
			h.transport.line(":irc.test FAIL BATCH MULTILINE_COOLDOWN 3 :Slow down");

			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :three", "PRIVMSG #seance :four"]);
		});

		it("reports a FAIL that is not a cooldown", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			h.client.input(chanId, "one\ntwo");
			h.sent();
			h.transport.line(":irc.test FAIL BATCH MULTILINE_MAX_BYTES 512 :Too big");

			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :one", "PRIVMSG #seance :two"]);
			expect(h.lastMessage(h.client.lobby.id).text).to.contain("MULTILINE_MAX_BYTES");
		});

		it("does not batch a single line", function () {
			const h = setup();
			const chanId = joined(h, CAPS);

			h.client.input(chanId, "just the one");

			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :just the one"]);
		});
	});

	describe("negotiation", function () {
		it("requests the cap and reads its limits", function () {
			const h = setup();
			register(h, CAPS);

			expect(h.client.caps.hasCapability("draft/multiline")).to.equal(true);
			expect(h.client.caps.value("draft/multiline")).to.equal(
				"max-bytes=16384,max-lines=100"
			);
		});
	});
});
