/**
 * Pending outgoing messages (irc/pending.ts, bus-contract §1.9): with
 * `echo-message` a sent message shows at once as a pending copy, and the
 * server's echo replaces it — matched by `labeled-response` label when the
 * server relays it, else by content.
 */

import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {PENDING_TIMEOUT_MS, resetPending, showPending} from "../../client/js/irc/pending";
import {batchCooldownMs} from "../../client/js/irc/multiline";
import {replyTags} from "../../client/js/irc/wire";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import {ALL_CAPS, Harness, joined, setup, stubStorage} from "./support";

const NO_LABELS = ALL_CAPS.replace("labeled-response ", "");
const NO_ECHO = ALL_CAPS.replace("echo-message ", "");
const MULTILINE = `${ALL_CAPS} draft/multiline=max-bytes=4096,max-lines=10`;

interface SettledPayload {
	chan: number;
	id: number;
}

function settled(h: Harness): SettledPayload[] {
	return h.payloads<SettledPayload>("msg:settled");
}

function pendingIn(h: Harness, chanId: number): SharedMsg[] {
	return h.messages(chanId).filter((m) => m.pending);
}

function errorsIn(h: Harness, chanId: number): SharedMsg[] {
	return h.messages(chanId).filter((m) => m.type === MessageType.ERROR);
}

describe("Pending outgoing messages (irc/pending.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		stubStorage();
		clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
	});

	afterEach(function () {
		clock.restore();
		sinon.restore();
		socket.removeAllListeners();
	});

	describe("with echo-message and labeled-response", function () {
		it("shows a pending copy of a sent message at once", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");

			expect(h.sent()).to.deep.equal(["@label=s1 PRIVMSG #seance :hi there"]);
			const copy = h.lastMessage(id);
			expect(copy.pending).to.equal(true);
			expect(copy.self).to.equal(true);
			expect(copy.type).to.equal(MessageType.MESSAGE);
			expect(copy.text).to.equal("hi there");
			expect(copy.from?.nick).to.equal("alice");
			expect(copy.msgid).to.equal(undefined);
			expect(copy.id).to.be.greaterThan(0);
			// A copy is not news: no counters travel with it.
			const payload = h.payloads<{unread?: number; highlight?: number}>("msg").pop();
			expect(payload?.unread).to.equal(undefined);
			expect(payload?.highlight).to.equal(undefined);
		});

		it("settles the copy when the labelled echo arrives, before the real message", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");
			const copy = h.lastMessage(id);

			h.transport.line(
				"@label=s1;msgid=m1;time=2026-08-25T12:00:01.000Z :alice!alice@host.example PRIVMSG #seance :hi there"
			);

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			const real = h.lastMessage(id);
			expect(real.msgid).to.equal("m1");
			expect(real.pending).to.equal(undefined);
			expect(real.self).to.equal(true);
			expect(real.id).to.not.equal(copy.id);
			const events = h.events();
			expect(events.lastIndexOf("msg:settled")).to.be.lessThan(events.lastIndexOf("msg"));
		});

		it("does not report a timeout once the echo has arrived", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");
			h.transport.line(
				"@label=s1;msgid=m1 :alice!alice@host.example PRIVMSG #seance :hi there"
			);

			clock.tick(PENDING_TIMEOUT_MS);

			expect(errorsIn(h, id)).to.deep.equal([]);
			expect(settled(h)).to.have.length(1);
		});

		it("settles a copy whose echo omits the label (a server that does not relay it)", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");
			const copy = h.lastMessage(id);

			// The echo of our own message, but without the label: not every
			// server relays it on the propagated echo-message copy. It is
			// still our echo (same nick, same text), so the copy settles.
			h.transport.line("@msgid=m1 :alice!alice@host.example PRIVMSG #seance :hi there");

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			expect(h.lastMessage(id).msgid).to.equal("m1");
		});

		it("leaves the copies alone for an unlabelled message of ours we did not send (another session)", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "from here");

			// Same account speaking from another device: a self echo with no
			// label and no pending copy of ours to match. Nothing settles.
			h.transport.line("@msgid=m1 :alice!alice@host.example PRIVMSG #seance :from the phone");

			expect(settled(h)).to.deep.equal([]);
			expect(pendingIn(h, id)).to.have.length(1);
			expect(pendingIn(h, id)[0].text).to.equal("from here");
			expect(h.lastMessage(id).text).to.equal("from the phone");
		});

		it("settles only the copy the echo labels", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "first");
			h.client.sendMessage("#seance", "second");
			const [first, second] = pendingIn(h, id);

			h.transport.line(
				"@label=s2;msgid=m2 :alice!alice@host.example PRIVMSG #seance :second"
			);

			expect(settled(h)).to.deep.equal([{chan: id, id: second.id}]);
			expect(first.pending).to.equal(true);
		});

		it("labels every chunk of a long message and shows a copy of each", function () {
			const h = setup();
			const id = joined(h);
			const text = "word ".repeat(120).trim(); // ~600 bytes: two lines
			h.client.sendMessage("#seance", text);

			const lines = h.sent();
			expect(lines).to.have.length(2);
			expect(lines[0]).to.match(/^@label=s1 PRIVMSG #seance :/);
			expect(lines[1]).to.match(/^@label=s2 PRIVMSG #seance :/);
			const copies = pendingIn(h, id);
			expect(copies.map((m) => m.text).join(" ")).to.equal(text);

			h.transport.line(`@label=s2;msgid=m2 :alice!alice@host.example ${lines[1].slice(10)}`);
			expect(settled(h)).to.deep.equal([{chan: id, id: copies[1].id}]);
		});

		it("carries the reply reference and the action type", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "waves", {action: true, tags: replyTags("m0")});

			expect(h.sent()).to.deep.equal([
				"@+reply=m0;+draft/reply=m0;label=s1 PRIVMSG #seance :\x01ACTION waves\x01",
			]);
			const copy = h.lastMessage(id);
			expect(copy.pending).to.equal(true);
			expect(copy.type).to.equal(MessageType.ACTION);
			expect(copy.text).to.equal("waves");
			expect(copy.replyTo).to.equal("m0");
		});

		it("shows a notice as a pending notice", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "heads up", {notice: true});

			expect(h.sent()).to.deep.equal(["@label=s1 NOTICE #seance :heads up"]);
			expect(h.lastMessage(id).type).to.equal(MessageType.NOTICE);
			expect(h.lastMessage(id).pending).to.equal(true);
		});

		it("puts a STATUSMSG copy in the channel with its group", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("@#seance", "ops only");

			const copy = h.lastMessage(id);
			expect(copy.pending).to.equal(true);
			expect(copy.statusmsgGroup).to.equal("@");
		});

		it("shows nothing pending for a target that is not open", function () {
			const h = setup();
			joined(h);
			h.dispatch.resetHistory();
			h.client.sendMessage("#elsewhere", "hello?");

			expect(h.sent()).to.deep.equal(["@label=s1 PRIVMSG #elsewhere :hello?"]);
			expect(h.payloads("msg")).to.deep.equal([]);
		});
	});

	describe("failures", function () {
		it("reports a labelled rejection with the server's reason and the text", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");
			const copy = h.lastMessage(id);

			h.transport.line("@label=s1 :irc.test 404 alice #seance :Cannot send to channel");

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			const errors = errorsIn(h, id);
			expect(errors.map((m) => m.text)).to.deep.equal([
				"Not sent (Cannot send to channel): hi there",
			]);
			const events = h.events();
			expect(events.lastIndexOf("msg:settled")).to.be.lessThan(events.lastIndexOf("msg"));
		});

		it("still shows an unrelated numeric the usual way", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");

			h.transport.line("@label=h99 :irc.test 404 alice #seance :Cannot send to channel");

			expect(settled(h)).to.deep.equal([]);
			expect(pendingIn(h, id)).to.have.length(1);
			expect(errorsIn(h, id)).to.have.length(1);
			expect(errorsIn(h, id)[0].text ?? "").to.not.match(/^Not sent/);
		});

		it("gives up when no echo arrives in time", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");
			const copy = h.lastMessage(id);

			clock.tick(PENDING_TIMEOUT_MS - 1);
			expect(settled(h)).to.deep.equal([]);
			clock.tick(1);

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			expect(errorsIn(h, id).map((m) => m.text)).to.deep.equal([
				"Not sent (no acknowledgement from the server): hi there",
			]);
		});

		it("does not settle a newer copy with the late echo of one that timed out", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "same");
			clock.tick(PENDING_TIMEOUT_MS);
			h.client.sendMessage("#seance", "same");
			const second = h.lastMessage(id);
			expect(second.pending).to.equal(true);

			// The first line's echo, late: its label names a copy already
			// given up on, so it settles nothing. The second copy waits for
			// its own answer.
			h.transport.line("@label=s1;msgid=m1 :alice!alice@host.example PRIVMSG #seance :same");
			expect(settled(h).map((s) => s.id)).to.not.include(second.id);

			h.transport.line("@label=s2 :irc.test 404 alice #seance :Cannot send to channel");
			expect(settled(h).map((s) => s.id)).to.include(second.id);
			expect(errorsIn(h, id).map((m) => m.text)).to.include(
				"Not sent (Cannot send to channel): same"
			);
		});

		it("fails every copy when the connection closes", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "one");
			h.client.sendMessage("#seance", "two");
			const copies = pendingIn(h, id);

			h.transport.closed();

			expect(settled(h).map((p) => p.id)).to.deep.equal(copies.map((m) => m.id));
			expect(errorsIn(h, id).map((m) => m.text)).to.deep.equal([
				"Not sent (connection lost): one",
				"Not sent (connection lost): two",
			]);
		});

		it("treats a labelled ACK as settled without an echo", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");
			const copy = h.lastMessage(id);

			h.transport.line("@label=s1 :irc.test ACK");

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			expect(errorsIn(h, id)).to.deep.equal([]);
		});
	});

	describe("labelled responses and repeated msgids", function () {
		function labelledBatch(h: Harness, label: string, ref: string, lines: string[]): void {
			h.transport.line(`@label=${label} :irc.test BATCH +${ref} labeled-response`);

			for (const line of lines) {
				h.transport.line(
					line.startsWith("@")
						? `@batch=${ref};${line.slice(1)}`
						: `@batch=${ref} ${line}`
				);
			}

			h.transport.line(`:irc.test BATCH -${ref}`);
		}

		it("reports a labelled FAIL for the message as not sent", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");
			const copy = h.lastMessage(id);

			h.transport.line("@label=s1 :irc.test FAIL PRIVMSG CANNOT_SEND #seance :You are muted");

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			expect(errorsIn(h, id).map((m) => m.text)).to.deep.equal([
				"Not sent (You are muted): hi there",
			]);
		});

		it("reports a FAIL inside the message's labelled batch as not sent", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "hi there");
			const copy = h.lastMessage(id);

			labelledBatch(h, "s1", "lb1", [
				":irc.test FAIL PRIVMSG CANNOT_SEND #seance :You are muted",
			]);

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			expect(errorsIn(h, id).map((m) => m.text)).to.deep.equal([
				"Not sent (You are muted): hi there",
			]);
		});

		it("settles the copy a labelled batch's echo answers, not the oldest with that text", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "same");
			h.client.sendMessage("#seance", "same");
			const [, second] = pendingIn(h, id);

			labelledBatch(h, "s2", "lb2", [
				"@msgid=m2 :alice!alice@host.example PRIVMSG #seance :same",
			]);

			expect(settled(h)).to.deep.equal([{chan: id, id: second.id}]);
		});

		it("leaves a copy alone for an unlabelled same-text line once the server labels echoes", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "first");
			h.transport.line("@label=s1;msgid=m1 :alice!alice@host.example PRIVMSG #seance :first");
			h.client.sendMessage("#seance", "hello");
			const copy = h.lastMessage(id);

			// The same account on another device says the same thing first.
			h.transport.line("@msgid=m9 :alice!alice@host.example PRIVMSG #seance :hello");
			expect(settled(h).map((s) => s.id)).to.not.include(copy.id);

			h.transport.line("@label=s2;msgid=m2 :alice!alice@host.example PRIVMSG #seance :hello");
			expect(settled(h).map((s) => s.id)).to.include(copy.id);
			expect(h.messages(id).filter((m) => m.text === "hello" && !m.pending)).to.have.length(
				2
			);
		});

		// nefarious2 tags a line to us `@batch=` *instead of* `@label=` while a
		// batch is open on the connection (send.c format_message_tags_for_ex:
		// fwd batch, else batch, else label). So the echo of a labelled line
		// can come back with no label of its own.
		it("settles the copy whose echo lands in another command's labelled batch", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "first");
			h.transport.line("@label=s1;msgid=m1 :alice!alice@host.example PRIVMSG #seance :first");
			h.client.sendMessage("#seance", "hello");
			const copy = h.lastMessage(id);

			// An async reply (a labelled LIST) holds a batch open; our echo joins it.
			labelledBatch(h, "r7", "lb7", [
				"@msgid=m2 :alice!alice@host.example PRIVMSG #seance :hello",
			]);
			clock.tick(PENDING_TIMEOUT_MS);

			expect(settled(h).map((s) => s.id)).to.include(copy.id);
			expect(errorsIn(h, id)).to.deep.equal([]);
			expect(h.messages(id).filter((m) => m.text === "hello" && !m.pending)).to.have.length(
				1
			);
		});

		it("settles the copy whose echo carries a batch tag instead of its label", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "first");
			h.transport.line("@label=s1;msgid=m1 :alice!alice@host.example PRIVMSG #seance :first");
			h.client.sendMessage("#seance", "hello");
			const copy = h.lastMessage(id);

			// A batch the client does not hold open (unknown ref): the line is
			// handled as it comes, unlabelled.
			h.transport.line("@batch=zz;msgid=m2 :alice!alice@host.example PRIVMSG #seance :hello");
			clock.tick(PENDING_TIMEOUT_MS);

			expect(settled(h).map((s) => s.id)).to.include(copy.id);
			expect(errorsIn(h, id)).to.deep.equal([]);
			expect(h.messages(id).filter((m) => m.text === "hello" && !m.pending)).to.have.length(
				1
			);
		});

		it("still settles nothing with a late echo in its own labelled batch", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "same");
			clock.tick(PENDING_TIMEOUT_MS);
			h.client.sendMessage("#seance", "same");
			const second = h.lastMessage(id);

			// The batch's label is the first line's own (s1): it decides, as a
			// label on the echo itself would.
			labelledBatch(h, "s1", "lb1", [
				"@msgid=m1 :alice!alice@host.example PRIVMSG #seance :same",
			]);

			expect(settled(h).map((s) => s.id)).to.not.include(second.id);
		});

		it("forgets that the server labels echoes when the connection closes", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "first");
			h.transport.line("@label=s1;msgid=m1 :alice!alice@host.example PRIVMSG #seance :first");

			// The next connection may reach a server that does not relay labels.
			resetPending(h.client, "connection lost");
			h.client.sendMessage("#seance", "hello");
			const copy = h.lastMessage(id);

			h.transport.line("@msgid=m2 :alice!alice@host.example PRIVMSG #seance :hello");
			expect(settled(h).map((s) => s.id)).to.include(copy.id);
		});

		it("shows a line once when the same msgid arrives twice (a message to ourselves)", function () {
			const h = setup();
			const id = joined(h);

			h.transport.line("@msgid=m1 :alice!alice@host.example PRIVMSG #seance :once");
			h.transport.line("@msgid=m1 :alice!alice@host.example PRIVMSG #seance :once");

			expect(h.messages(id).filter((m) => m.text === "once")).to.have.length(1);
		});

		it("applies an edit once when its msgid arrives twice", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=old :bob!bob@host.example PRIVMSG #seance :original");
			const edit =
				"@msgid=e1;+seance/edit=old :bob!bob@host.example PRIVMSG #seance :replacement";

			h.transport.line(edit);
			h.transport.line(edit);

			expect(h.messages(id).filter((m) => m.msgid === "e1")).to.have.length(1);
			expect(h.payloads("msg:edit")).to.have.length(1);
		});

		it("settles a copy sent without a label by text after labeled-response comes back", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "first");
			h.transport.line("@label=s1;msgid=m1 :alice!alice@host.example PRIVMSG #seance :first");
			h.transport.line(":irc.test CAP alice DEL :labeled-response");
			h.client.sendMessage("#seance", "hello");
			const copy = h.lastMessage(id);
			h.transport.line(":irc.test CAP alice NEW :labeled-response");
			h.transport.line(":irc.test CAP alice ACK :labeled-response");

			h.transport.line("@msgid=m2 :alice!alice@host.example PRIVMSG #seance :hello");

			expect(settled(h).map((s) => s.id)).to.include(copy.id);
		});

		it("matches unlabelled echoes by text again once labeled-response is deleted", function () {
			const h = setup();
			const id = joined(h);
			h.client.sendMessage("#seance", "first");
			h.transport.line("@label=s1;msgid=m1 :alice!alice@host.example PRIVMSG #seance :first");
			h.transport.line(":irc.test CAP alice DEL :labeled-response");
			h.client.sendMessage("#seance", "hello");
			const copy = h.lastMessage(id);

			h.transport.line("@msgid=m2 :alice!alice@host.example PRIVMSG #seance :hello");

			expect(settled(h).map((s) => s.id)).to.include(copy.id);
		});
	});

	describe("without labeled-response", function () {
		it("sends no label and settles the copy with the same text", function () {
			const h = setup();
			const id = joined(h, NO_LABELS);
			h.client.sendMessage("#seance", "hi there");
			const copy = h.lastMessage(id);

			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :hi there"]);
			expect(copy.pending).to.equal(true);

			h.transport.line("@msgid=m1 :alice!alice@host.example PRIVMSG #seance :hi there");
			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
		});

		it("prefers the copy whose text matches", function () {
			const h = setup();
			const id = joined(h, NO_LABELS);
			h.client.sendMessage("#seance", "first");
			h.client.sendMessage("#seance", "second");
			const [, second] = pendingIn(h, id);

			h.transport.line("@msgid=m2 :alice!alice@host.example PRIVMSG #seance :second");

			expect(settled(h)).to.deep.equal([{chan: id, id: second.id}]);
		});

		it("reports an unlabelled 404 against the one copy waiting for that target", function () {
			const h = setup();
			const id = joined(h, NO_LABELS);
			h.client.sendMessage("#seance", "first");
			const copy = h.lastMessage(id);

			h.transport.line(":irc.test 404 alice #seance :Cannot send to channel");

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			expect(errorsIn(h, id).map((m) => m.text)).to.deep.equal([
				"Not sent (Cannot send to channel): first",
			]);
		});

		it("fails neither copy on an unlabelled 404 when two wait for that target", function () {
			const h = setup();
			const id = joined(h, NO_LABELS);
			h.client.sendMessage("#seance", "a");
			h.client.sendMessage("#seance", "a");
			const [first, second] = pendingIn(h, id);

			// The 404 may be for the second; the first's echo follows.
			h.transport.line(":irc.test 404 alice #seance :Cannot send to channel");
			expect(settled(h)).to.deep.equal([]);

			h.transport.line(":alice!alice@host.example PRIVMSG #seance :a");
			expect(settled(h)).to.deep.equal([{chan: id, id: first.id}]);
			expect(second.pending).to.equal(true);
		});

		it("does not fail a copy on an unlabelled 401: it may answer another command (WHOIS)", function () {
			const h = setup();
			const id = joined(h, NO_LABELS);
			h.client.sendMessage("#seance", "first");
			const copy = h.lastMessage(id);

			h.transport.line(":irc.test 401 alice #seance :No such nick/channel");

			expect(settled(h)).to.deep.equal([]);
			expect(copy.pending).to.equal(true);
		});

		it("does not count a copy still queued to go out against an unlabelled 404", function () {
			const h = setup();
			const id = joined(h, NO_LABELS);
			const chan = h.client.findChannel("#seance")!;
			const queued = showPending(
				h.client,
				chan,
				{type: MessageType.MESSAGE, text: "later"},
				{arm: false}
			);

			h.transport.line(":irc.test 404 alice #seance :Cannot send to channel");

			expect(settled(h)).to.deep.equal([]);
			expect(pendingIn(h, id).map((m) => m.id)).to.deep.equal([queued.id]);
		});

		it("does not pin an unlabelled 404 on a notice copy", function () {
			const h = setup();
			const id = joined(h, NO_LABELS);
			h.client.sendMessage("#seance", "heads up", {notice: true});
			h.client.sendMessage("#seance", "hello");
			const [notice, msg] = pendingIn(h, id);

			h.transport.line(":irc.test 404 alice #seance :Cannot send to channel");

			expect(settled(h)).to.deep.equal([{chan: id, id: msg.id}]);
			expect(notice.pending).to.equal(true);
		});

		it("falls back to the oldest copy of the same kind when the server altered the text", function () {
			const h = setup();
			const id = joined(h, NO_LABELS);
			h.client.sendMessage("#seance", "\x02bold\x02");
			const copy = h.lastMessage(id);

			h.transport.line("@msgid=m1 :alice!alice@host.example PRIVMSG #seance :bold");

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
		});

		it("never settles a copy with an echo of another kind", function () {
			const h = setup();
			const id = joined(h, NO_LABELS);
			h.client.sendMessage("#seance", "hi there");

			h.transport.line(
				"@msgid=m1 :alice!alice@host.example PRIVMSG #seance :\x01ACTION hi there\x01"
			);

			expect(settled(h)).to.deep.equal([]);
			expect(pendingIn(h, id)).to.have.length(1);
		});
	});

	describe("without echo-message", function () {
		it("shows the local echo as before and nothing pending", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);
			h.client.sendMessage("#seance", "hi there");

			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :hi there"]);
			const shown = h.lastMessage(id);
			expect(shown.self).to.equal(true);
			expect(shown.pending).to.equal(undefined);
			expect(pendingIn(h, id)).to.deep.equal([]);

			clock.tick(PENDING_TIMEOUT_MS);
			expect(settled(h)).to.deep.equal([]);
			expect(errorsIn(h, id)).to.deep.equal([]);
		});
	});

	describe("multi-line messages", function () {
		function echoBatch(h: Harness, label: string, ...lines: string[]): void {
			h.transport.line(
				`@label=${label};msgid=mm1;time=2026-08-25T12:00:01.000Z :alice!alice@host.example BATCH +Gk1 draft/multiline #seance`
			);

			for (const line of lines) {
				h.transport.line(`@batch=Gk1 :alice!alice@host.example PRIVMSG #seance :${line}`);
			}

			h.transport.line(":alice!alice@host.example BATCH -Gk1");
		}

		it("shows one pending copy for the batch, labelled on the opener", function () {
			const h = setup();
			const id = joined(h, MULTILINE);
			h.client.input(id, "one\ntwo");

			expect(h.sent()).to.deep.equal([
				"@label=s1 BATCH +m1 draft/multiline #seance",
				"@batch=m1 PRIVMSG #seance :one",
				"@batch=m1 PRIVMSG #seance :two",
				"BATCH -m1",
			]);
			const copies = pendingIn(h, id);
			expect(copies.map((m) => m.text)).to.deep.equal(["one\ntwo"]);
		});

		it("settles the copy when the echoed batch carries the label", function () {
			const h = setup();
			const id = joined(h, MULTILINE);
			h.client.input(id, "one\ntwo");
			const copy = h.lastMessage(id);

			echoBatch(h, "s1", "one", "two");

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			const real = h.lastMessage(id);
			expect(real.text).to.equal("one\ntwo");
			expect(real.msgid).to.equal("mm1");
			expect(real.pending).to.equal(undefined);
		});

		it("shows every batch of a long message pending while they wait their turn", function () {
			const h = setup();
			const id = joined(h, `${ALL_CAPS} draft/multiline=max-bytes=4096,max-lines=2`);
			h.client.input(id, "one\ntwo\nthree");

			expect(h.sent()).to.have.length(4); // only the first batch is on the wire
			expect(pendingIn(h, id).map((m) => m.text)).to.deep.equal(["one\ntwo", "three"]);

			echoBatch(h, "s1", "one", "two");
			// The echo settles the first copy, but the second batch is paced
			// past the first batch's cooldown before it goes out (multiline.ts).
			expect(h.sent()).to.deep.equal([]);
			expect(settled(h).map((p) => p.id)).to.deep.equal([pendingIn(h, id)[0].id]);

			clock.tick(
				batchCooldownMs({
					lines: [
						{text: "one", concat: false},
						{text: "two", concat: false},
					],
					action: false,
				})
			);
			expect(h.sent()).to.deep.equal([
				"@label=s2 BATCH +m2 draft/multiline #seance",
				"@batch=m2 PRIVMSG #seance :three",
				"BATCH -m2",
			]);
		});

		it("drops the copies when the server rejects the batch (the failure is reported once)", function () {
			const h = setup();
			const id = joined(h, `${ALL_CAPS} draft/multiline=max-bytes=4096,max-lines=2`);
			h.client.input(id, "one\ntwo\nthree");
			const copies = pendingIn(h, id);

			h.transport.line(":irc.test FAIL BATCH MULTILINE_MAX_LINES 2 :Too many lines");

			expect(settled(h).map((p) => p.id)).to.deep.equal(copies.map((m) => m.id));
			const notSent = h.messages().filter((m) => m.text?.startsWith("Not sent"));
			expect(notSent).to.deep.equal([]);
			expect(h.messages().filter((m) => m.type === MessageType.ERROR)).to.have.length(1);
		});

		it("gives up on a batch whose echo never comes", function () {
			const h = setup();
			const id = joined(h, MULTILINE);
			h.client.input(id, "one\ntwo");
			const copy = h.lastMessage(id);

			clock.tick(PENDING_TIMEOUT_MS);

			expect(settled(h)).to.deep.equal([{chan: id, id: copy.id}]);
			expect(errorsIn(h, id).map((m) => m.text)).to.deep.equal([
				"Not sent (no acknowledgement from the server): one\ntwo",
			]);
		});
	});
});
