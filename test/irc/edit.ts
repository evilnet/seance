import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {EDIT_TIMEOUT_MS} from "../../client/js/irc/client";
import {MAX_LINE_BYTES, utf8ByteLength} from "../../client/js/irc/message";
import {ChanType} from "../../shared/types/chan";
import {MessageType} from "../../shared/types/msg";
import {ALL_CAPS, batch, joined, labelOf, setup, stubStorage} from "./support";

interface EditPayload {
	chan: number;
	id: number;
	replaces: number;
}

const NO_REDACT = ALL_CAPS.replace(" draft/message-redaction", "");
const NO_ECHO = ALL_CAPS.replace("echo-message ", "");

describe("Message edits (REDACT + +seance/edit)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		stubStorage();
		clock = sinon.useFakeTimers({
			now: new Date("2026-08-25T12:00:00.000Z"),
			toFake: ["setTimeout", "clearTimeout"],
		});
	});

	afterEach(function () {
		clock.restore();
		sinon.restore();
		socket.removeAllListeners();
	});

	/** Joined #seance with our own message m1 loaded (echoed by the server). */
	function withOwnMessage(caps = ALL_CAPS) {
		const h = setup();
		const id = joined(h, caps);
		h.transport.line(
			"@msgid=m1;time=2026-08-25T12:00:01.000Z :alice!alice@host.example PRIVMSG #seance :teh text"
		);
		const oldId = h.lastMessage(id).id;
		return {h, id, oldId};
	}

	describe("in a channel with draft/message-redaction", function () {
		it("redacts first and sends the tagged resend once the REDACT is echoed", function () {
			const {h, id, oldId} = withOwnMessage();
			h.client.input(id, "the text", {edit: "m1"});

			expect(h.sent()).to.deep.equal(["REDACT #seance m1 :edited"]);
			expect(h.client.hasPendingEdit("m1")).to.equal(true);

			h.transport.line(":alice!alice@host.example REDACT #seance m1 :edited");
			expect(h.sent()).to.deep.equal([
				"@+evilnet.github.io/edit=m1;+seance/edit=m1;label=s1 PRIVMSG #seance :the text",
			]);
			expect(h.client.hasPendingEdit("m1")).to.equal(false);
			// The old message is redacted like any other REDACT of a loaded message.
			expect(h.payloads<{id: number}>("msg:redact").map((p) => p.id)).to.deep.equal([oldId]);

			// The pending copy of the resend stands in the original's place at
			// once: its msg is followed by a msg:edit naming the copy.
			const copy = h.lastMessage(id);
			expect(copy.pending).to.equal(true);
			expect(copy.editOf).to.equal("m1");
			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: copy.id, replaces: oldId},
			]);

			// The server echoes the resend: the copy settles, then a normal msg
			// with editOf, then the msg:edit that puts it in the original's place.
			h.transport.line(
				"@+seance/edit=m1;msgid=m2;time=2026-08-25T12:00:02.000Z :alice!alice@host.example PRIVMSG #seance :the text"
			);
			const msg = h.lastMessage(id);
			expect(msg.editOf).to.equal("m1");
			expect(msg.self).to.equal(true);
			expect(msg.pending).to.equal(undefined);
			expect(h.payloads<{id: number}>("msg:settled").map((p) => p.id)).to.deep.equal([
				copy.id,
			]);
			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: copy.id, replaces: oldId},
				{chan: id, id: msg.id, replaces: oldId},
			]);
			const events = h.events();
			expect(events.lastIndexOf("msg:settled")).to.be.lessThan(events.lastIndexOf("msg"));
			expect(events.lastIndexOf("msg")).to.be.lessThan(events.lastIndexOf("msg:edit"));
		});

		it("sends the vendor edit tag and, for older builds, +seance/edit", function () {
			const {h, id} = withOwnMessage();
			h.client.input(id, "the text", {edit: "m1"});
			h.sent();
			h.transport.line(":alice!alice@host.example REDACT #seance m1 :edited");

			expect(h.sent()).to.deep.equal([
				"@+evilnet.github.io/edit=m1;+seance/edit=m1;label=s1 PRIVMSG #seance :the text",
			]);
		});

		it("keeps a long one-line edit within the line cap, both edit tags on the first line only", function () {
			const {h, id} = withOwnMessage();
			const text = Array.from({length: 120}, (_, i) => `wörd${i}`).join(" ");
			h.client.input(id, text, {edit: "m1"});
			h.sent();
			h.transport.line(":alice!alice@host.example REDACT #seance m1 :edited");

			const sent = h.sent();
			expect(sent.length).to.be.greaterThan(1);
			expect(sent[0]).to.match(
				/^@\+evilnet\.github\.io\/edit=m1;\+seance\/edit=m1;label=s1 /
			);

			for (const line of sent.slice(1)) {
				expect(line).to.not.match(/edit=/);
			}

			for (const line of sent) {
				expect(utf8ByteLength(line) + ":alice!alice@host.example ".length).to.be.at.most(
					MAX_LINE_BYTES
				);
			}
		});

		it("keeps a multiline edit's opener within the line cap, dropping +seance/edit when it must", function () {
			const h = setup();
			const id = joined(h, `${ALL_CAPS} draft/multiline=max-bytes=4096,max-lines=24`);
			const old = "x".repeat(220);
			h.transport.line(
				`@msgid=${old};time=2026-08-25T12:00:01.000Z :alice!alice@host.example PRIVMSG #seance :teh text`
			);
			h.client.input(id, "first line\nsecond line", {edit: old});
			h.sent();
			h.transport.line(`:alice!alice@host.example REDACT #seance ${old} :edited`);

			const opener = h.sent().find((l) => / BATCH \+/.test(l)) ?? "";
			expect(opener).to.include(`+evilnet.github.io/edit=${old}`);
			expect(utf8ByteLength(opener) + ":alice!alice@host.example ".length).to.be.at.most(
				MAX_LINE_BYTES
			);
		});

		it("keeps the reply reference on the resend", function () {
			const {h, id} = withOwnMessage();
			h.client.input(id, "the text", {edit: "m1", reply: "p1"});
			h.transport.line(":alice!alice@host.example REDACT #seance m1 :edited");

			expect(h.sent()).to.deep.equal([
				"REDACT #seance m1 :edited",
				"@+evilnet.github.io/edit=m1;+seance/edit=m1;+reply=p1;+draft/reply=p1;label=s1 PRIVMSG #seance :the text",
			]);
		});

		it("does not trigger on someone else's REDACT of the same msgid", function () {
			const {h, id} = withOwnMessage();
			h.client.input(id, "the text", {edit: "m1"});
			h.sent();
			h.transport.line(":bob!bob@host REDACT #seance m1 :mine now");

			expect(h.sent()).to.deep.equal([]);
			expect(h.client.hasPendingEdit("m1")).to.equal(true);
		});

		it("aborts on FAIL REDACT with an error in the channel", function () {
			const {h, id} = withOwnMessage();
			h.client.input(id, "the text", {edit: "m1"});
			h.sent();
			h.transport.line(
				"FAIL REDACT REDACT_FORBIDDEN #seance m1 :You are not authorized to redact this message"
			);

			expect(h.sent()).to.deep.equal([]);
			expect(h.client.hasPendingEdit("m1")).to.equal(false);
			const msg = h.lastMessage(id);
			expect(msg.type).to.equal(MessageType.ERROR);
			expect(msg.text).to.equal("Edit not sent: You are not allowed to delete that message.");
			expect(h.messages(h.client.lobby.id)).to.have.length(0);
		});

		it("aborts after the timeout", function () {
			const {h, id} = withOwnMessage();
			h.client.input(id, "the text", {edit: "m1"});
			h.sent();
			clock.tick(EDIT_TIMEOUT_MS - 1);
			expect(h.client.hasPendingEdit("m1")).to.equal(true);
			clock.tick(1);

			expect(h.client.hasPendingEdit("m1")).to.equal(false);
			expect(h.lastMessage(id).text).to.equal("Edit not sent: no reply from the server.");
			h.transport.line(":alice!alice@host.example REDACT #seance m1 :edited");
			expect(h.sent()).to.deep.equal([]); // a late echo sends nothing
		});

		it("refuses a second edit of the same message while one is pending", function () {
			const {h, id} = withOwnMessage();
			h.client.input(id, "one", {edit: "m1"});
			h.client.input(id, "two", {edit: "m1"});

			expect(h.sent()).to.deep.equal(["REDACT #seance m1 :edited"]);
			expect(h.lastMessage(id).text).to.match(/^Edit not sent: an edit .* already waiting/);
		});

		it("forgets pending edits when the connection drops", function () {
			const {h, id} = withOwnMessage();
			h.client.input(id, "the text", {edit: "m1"});
			h.transport.closed();

			expect(h.client.hasPendingEdit("m1")).to.equal(false);
			clock.tick(EDIT_TIMEOUT_MS);
			expect(h.messages(id).some((m) => /Edit not sent/.test(m.text ?? ""))).to.equal(false);
		});

		it("sends the whole edit as one message: newlines collapse, chunks share the reply tag but only the first carries the edit tag", function () {
			const {h, id} = withOwnMessage();
			const words = Array.from({length: 150}, (_, i) => `wörd${i}`).join(" ");
			h.client.input(id, `first line\nsecond ${words}`, {edit: "m1", reply: "p1"});
			h.transport.line(":alice!alice@host.example REDACT #seance m1 :edited");

			const [redact, ...sent] = h.sent();
			expect(redact).to.equal("REDACT #seance m1 :edited");
			expect(sent.length).to.be.greaterThan(1);
			expect(sent[0]).to.match(
				/^@\+evilnet\.github\.io\/edit=m1;\+seance\/edit=m1;\+reply=p1;\+draft\/reply=p1;label=s1 PRIVMSG #seance :first line second /
			);

			for (const line of sent.slice(1)) {
				expect(line).to.match(
					/^@\+reply=p1;\+draft\/reply=p1;label=s\d+ PRIVMSG #seance :/
				);
			}

			for (const line of sent) {
				expect(utf8ByteLength(line) + ":alice!alice@host.example ".length).to.be.at.most(
					MAX_LINE_BYTES
				);
			}
		});

		it("never parses the replacement text as a command, /me aside", function () {
			const {h, id} = withOwnMessage();
			h.client.input(id, "/join #elsewhere", {edit: "m1"});
			expect(h.sent()).to.deep.equal(["REDACT #seance m1 :edited"]);
			h.transport.line(":alice!alice@host.example REDACT #seance m1 :edited");
			expect(h.sent()).to.deep.equal([
				"@+evilnet.github.io/edit=m1;+seance/edit=m1;label=s1 PRIVMSG #seance :/join #elsewhere",
			]);
		});

		it("an edit starting /me replaces the message with an action", function () {
			const {h, id, oldId} = withOwnMessage();
			h.client.input(id, "/me was here", {edit: "m1", reply: "p1"});
			expect(h.sent()).to.deep.equal(["REDACT #seance m1 :edited"]);

			h.transport.line(":alice!alice@host.example REDACT #seance m1 :edited");
			expect(h.sent()).to.deep.equal([
				"@+evilnet.github.io/edit=m1;+seance/edit=m1;+reply=p1;+draft/reply=p1;label=s1 PRIVMSG #seance :\x01ACTION was here\x01",
			]);
			const copy = h.lastMessage(id);
			expect(copy.type).to.equal(MessageType.ACTION);
			expect(copy.editOf).to.equal("m1");

			h.transport.line(
				"@+seance/edit=m1;msgid=m2;time=2026-08-25T12:00:02.000Z :alice!alice@host.example PRIVMSG #seance :\x01ACTION was here\x01"
			);
			const msg = h.lastMessage(id);
			expect(msg.type).to.equal(MessageType.ACTION);
			expect(msg.text).to.equal("was here");
			expect(msg.editOf).to.equal("m1");
			expect(h.payloads<EditPayload>("msg:edit").at(-1)).to.deep.equal({
				chan: id,
				id: msg.id,
				replaces: oldId,
			});
		});

		it("edits an action: /me in the edit keeps it one, text without makes it plain", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@msgid=a1;time=2026-08-25T12:00:01.000Z :alice!alice@host.example PRIVMSG #seance :\x01ACTION waves\x01"
			);
			h.transport.line(
				"@msgid=a2;time=2026-08-25T12:00:01.500Z :alice!alice@host.example PRIVMSG #seance :\x01ACTION nods\x01"
			);
			h.client.input(id, "/ME waves hello", {edit: "a1"});
			h.transport.line(":alice!alice@host.example REDACT #seance a1 :edited");
			h.client.input(id, "nods", {edit: "a2"});
			h.transport.line(":alice!alice@host.example REDACT #seance a2 :edited");

			expect(h.sent()).to.deep.equal([
				"REDACT #seance a1 :edited",
				"@+evilnet.github.io/edit=a1;+seance/edit=a1;label=s1 PRIVMSG #seance :\x01ACTION waves hello\x01",
				"REDACT #seance a2 :edited",
				"@+evilnet.github.io/edit=a2;+seance/edit=a2;label=s2 PRIVMSG #seance :nods",
			]);
		});

		it("a /me edit with nothing after it sends nothing", function () {
			const {h, id} = withOwnMessage();
			h.client.input(id, "/me ", {edit: "m1"});
			expect(h.sent()).to.deep.equal([]);
			expect(h.client.hasPendingEdit("m1")).to.equal(false);
		});

		it("passes edit through the input bus emit", function () {
			const {h, id} = withOwnMessage();
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			socket.emit("input", {target: id, text: "via bus", edit: "m1"});
			expect(h.sent()).to.deep.equal(["REDACT #seance m1 :edited"]);
		});
	});

	describe("without REDACT", function () {
		it("only sends the tagged resend in a query", function () {
			const h = setup();
			joined(h);
			const query = h.client.announceChannel("bob", ChanType.QUERY);
			h.client.input(query.id, "the text", {edit: "q1", reply: "p1"});

			expect(h.sent()).to.deep.equal([
				"@+evilnet.github.io/edit=q1;+seance/edit=q1;+reply=p1;+draft/reply=p1;label=s1 PRIVMSG bob :the text",
			]);
			expect(h.client.hasPendingEdit("q1")).to.equal(false);
		});

		it("sends an action edit as the tagged resend in a query", function () {
			const h = setup();
			joined(h);
			const query = h.client.announceChannel("bob", ChanType.QUERY);
			h.client.input(query.id, "/me shrugs", {edit: "q1"});

			expect(h.sent()).to.deep.equal([
				"@+evilnet.github.io/edit=q1;+seance/edit=q1;label=s1 PRIVMSG bob :\x01ACTION shrugs\x01",
			]);
		});

		it("only sends the tagged resend when the cap is missing", function () {
			const {h, id} = withOwnMessage(NO_REDACT);
			h.client.input(id, "the text", {edit: "m1"});

			expect(h.sent()).to.deep.equal([
				"@+evilnet.github.io/edit=m1;+seance/edit=m1;label=s1 PRIVMSG #seance :the text",
			]);
			expect(h.payloads("msg:redact")).to.have.length(0);
		});

		it("replaces our own account-tagged line with our edit sent without echo-message", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);
			h.client.account = "alice"; // logged in
			h.transport.line(
				"@msgid=m1;account=alice;time=2026-08-25T12:00:01.000Z :alice!alice@host.example PRIVMSG #seance :teh text"
			);
			const oldId = h.lastMessage(id).id;
			h.client.input(id, "the text", {edit: "m1"});

			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: h.lastMessage(id).id, replaces: oldId},
			]);
		});

		it("replaces our own account-tagged line with a multiline edit sent without echo-message", function () {
			const h = setup();
			const id = joined(h, `${NO_ECHO} draft/multiline=max-bytes=4096,max-lines=24`);
			h.client.account = "alice"; // logged in
			h.transport.line(
				"@msgid=m1;account=alice;time=2026-08-25T12:00:01.000Z :alice!alice@host.example PRIVMSG #seance :teh text"
			);
			const oldId = h.lastMessage(id).id;
			h.client.input(id, "first line\nsecond line", {edit: "m1"});

			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: h.lastMessage(id).id, replaces: oldId},
			]);
		});

		it("does not wait for a REDACT echo without echo-message and applies the local echo", function () {
			const {h, id, oldId} = withOwnMessage(NO_ECHO);
			h.client.input(id, "the text", {edit: "m1"});

			expect(h.sent()).to.deep.equal([
				"REDACT #seance m1 :edited",
				"@+evilnet.github.io/edit=m1;+seance/edit=m1 PRIVMSG #seance :the text",
			]);
			expect(h.client.hasPendingEdit("m1")).to.equal(false);
			expect(h.payloads<{id: number; by: string}>("msg:redact")).to.have.length(1);
			expect(h.payloads<{id: number; by: string}>("msg:redact")[0]).to.include({
				id: oldId,
				by: "alice",
			});
			const msg = h.lastMessage(id);
			expect(msg.editOf).to.equal("m1");
			expect(msg.text).to.equal("the text");
			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: msg.id, replaces: oldId},
			]);
		});
	});

	describe("inbound +seance/edit", function () {
		it("dispatches msg:edit for another client's edit when the old message is loaded", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=b1 :bob!bob@host PRIVMSG #seance :teh");
			const oldId = h.lastMessage(id).id;
			h.transport.line("@msgid=b2;+seance/edit=b1 :bob!bob@host PRIVMSG #seance :the");

			const msg = h.lastMessage(id);
			expect(msg.editOf).to.equal("b1");
			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: msg.id, replaces: oldId},
			]);
		});

		it("does not count another client's edit as unread, but does count a highlight in it", function () {
			const h = setup();
			const id = joined(h);
			const unread = () => h.payloads<{unread: number}>("msg").pop()?.unread;
			h.transport.line("@msgid=b1 :bob!bob@host PRIVMSG #seance :teh");
			expect(unread()).to.equal(1);

			h.transport.line("@msgid=b2;+seance/edit=b1 :bob!bob@host PRIVMSG #seance :the");
			expect(unread()).to.equal(1);

			h.transport.line("@msgid=b3;+seance/edit=b2 :bob!bob@host PRIVMSG #seance :alice: the");
			expect(h.lastMessage(id).highlight).to.equal(true);
			expect(unread()).to.equal(2);
		});

		it("reads the vendor edit tag", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=b1 :bob!bob@host PRIVMSG #seance :teh");
			const oldId = h.lastMessage(id).id;
			h.transport.line(
				"@msgid=b2;+evilnet.github.io/edit=b1 :bob!bob@host PRIVMSG #seance :the"
			);

			const msg = h.lastMessage(id);
			expect(msg.editOf).to.equal("b1");
			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: msg.id, replaces: oldId},
			]);
		});

		it("reads an edit carrying both tags once", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=b1 :bob!bob@host PRIVMSG #seance :teh");
			h.transport.line(
				"@msgid=b2;+evilnet.github.io/edit=b1;+seance/edit=b1 :bob!bob@host PRIVMSG #seance :the"
			);

			expect(h.lastMessage(id).editOf).to.equal("b1");
			expect(h.payloads("msg:edit")).to.have.length(1);
		});

		it("lets no one but its author replace a loaded message", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=b1 :bob!bob@host PRIVMSG #seance :teh");
			h.transport.line(
				"@msgid=c1;+seance/edit=b1 :carol!carol@host PRIVMSG #seance :mine now"
			);

			expect(h.payloads("msg:edit")).to.have.length(0);
			expect(h.lastMessage(id).text).to.equal("mine now");
		});

		it("takes an author's edit across a nick case change", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=b1 :bob!bob@host PRIVMSG #seance :teh");
			const oldId = h.lastMessage(id).id;
			h.transport.line("@msgid=b2;+seance/edit=b1 :BOB!bob@host PRIVMSG #seance :the");

			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: h.lastMessage(id).id, replaces: oldId},
			]);
		});

		it("lets no one but its author replace an original delivered after the edit", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@msgid=c1;+seance/edit=o1 :carol!carol@host PRIVMSG #seance :mine now"
			);
			h.transport.line("@msgid=o1 :bob!bob@host PRIVMSG #seance :teh");

			expect(h.payloads("msg:edit")).to.have.length(0);
		});

		it("counts a line once when its author's edit comes before it", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.channelById(id)!;
			const before = chan.shared.unread;
			h.transport.line("@msgid=e1;+seance/edit=o1 :bob!bob@host PRIVMSG #seance :the");
			h.transport.line("@msgid=o1 :bob!bob@host PRIVMSG #seance :teh");

			expect(h.payloads("msg:edit")).to.have.length(1);
			expect(chan.shared.unread).to.equal(before + 1);
		});

		it("counts an edit in an older page whose original is not loaded", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			h.transport.line(":irc.test MARKREAD #seance timestamp=2026-08-25T10:00:00.000Z");
			h.transport.line(
				"@time=2026-08-25T12:00:09.000Z;msgid=n1 :carol!carol@host PRIVMSG #seance :newest"
			);
			const chan = h.client.channelById(id)!;
			const before = chan.shared.unread;

			socket.emit("more", {target: id, lastId: h.lastMessage(id).id, condensed: false});
			batch(
				h,
				[
					"@time=2026-08-25T11:00:00.000Z;msgid=e1;+seance/edit=o1 :bob!bob@host PRIVMSG #seance :the",
				],
				{label: labelOf(h.sent())}
			);

			expect(chan.shared.unread).to.equal(before + 1);
		});

		it("counts a chain of edits once when an older page brings its start", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			h.transport.line(":irc.test MARKREAD #seance timestamp=2026-08-25T10:00:00.000Z");
			const chan = h.client.channelById(id)!;
			const before = chan.shared.unread;
			h.transport.line(
				"@time=2026-08-25T12:00:09.000Z;msgid=e2;+seance/edit=e1 :bob!bob@host PRIVMSG #seance :third"
			);

			socket.emit("more", {target: id, lastId: h.lastMessage(id).id, condensed: false});
			batch(
				h,
				[
					"@time=2026-08-25T11:00:00.000Z;msgid=o :bob!bob@host PRIVMSG #seance :first",
					"@time=2026-08-25T11:00:01.000Z;msgid=e1;+seance/edit=o :bob!bob@host PRIVMSG #seance :second",
				],
				{label: labelOf(h.sent())}
			);

			expect(chan.shared.unread).to.equal(before + 1);
		});

		it("counts a chain of edits once when a catch-up brings its start", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.channelById(id)!;
			const before = chan.shared.unread;
			h.transport.line("@msgid=e2;+seance/edit=e1 :bob!bob@host PRIVMSG #seance :third");
			h.transport.line("@msgid=o :bob!bob@host PRIVMSG #seance :first");
			h.transport.line("@msgid=e1;+seance/edit=o :bob!bob@host PRIVMSG #seance :second");

			expect(chan.shared.unread).to.equal(before + 1);
		});

		it("counts two of one author's edits waiting for the same original once", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.channelById(id)!;
			const before = chan.shared.unread;
			h.transport.line("@msgid=e1;+seance/edit=o :bob!bob@host PRIVMSG #seance :second");
			h.transport.line("@msgid=e2;+seance/edit=o :bob!bob@host PRIVMSG #seance :third");
			h.transport.line("@msgid=o :bob!bob@host PRIVMSG #seance :first");

			expect(chan.shared.unread).to.equal(before + 1);
		});

		it("takes back nothing for an earlier revision already read", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.channelById(id)!;
			h.transport.line(
				"@time=2026-08-25T11:00:00.000Z;msgid=e1;+seance/edit=o :bob!bob@host PRIVMSG #seance :alice: second"
			);
			h.transport.line(
				"@time=2026-08-25T12:00:00.000Z;msgid=e2;+seance/edit=o :bob!bob@host PRIVMSG #seance :alice: third"
			);
			h.transport.line(":irc.test MARKREAD #seance timestamp=2026-08-25T11:30:00.000Z");
			const before = {unread: chan.shared.unread, highlight: chan.shared.highlight};
			h.transport.line(
				"@time=2026-08-25T10:00:00.000Z;msgid=o :bob!bob@host PRIVMSG #seance :first"
			);

			expect({unread: chan.shared.unread, highlight: chan.shared.highlight}).to.deep.equal(
				before
			);
		});

		it("counts a longer chain of edits once when a catch-up brings its start", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.channelById(id)!;
			const before = chan.shared.unread;
			h.transport.line("@msgid=e3;+seance/edit=e2 :bob!bob@host PRIVMSG #seance :fourth");
			h.transport.line("@msgid=o :bob!bob@host PRIVMSG #seance :first");
			h.transport.line("@msgid=e1;+seance/edit=o :bob!bob@host PRIVMSG #seance :second");
			h.transport.line("@msgid=e2;+seance/edit=e1 :bob!bob@host PRIVMSG #seance :third");

			expect(chan.shared.unread).to.equal(before + 1);
		});

		it("keeps the newest revision's count, whatever order they came in", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.channelById(id)!;
			h.transport.line(
				"@time=2026-08-25T12:00:00.000Z;msgid=e2;+seance/edit=o :bob!bob@host PRIVMSG #seance :third"
			);
			const newest = h.lastMessage(id).id;
			h.transport.line(
				"@time=2026-08-25T11:00:00.000Z;msgid=e1;+seance/edit=o :bob!bob@host PRIVMSG #seance :second"
			);
			h.transport.line(
				"@time=2026-08-25T10:00:00.000Z;msgid=o :bob!bob@host PRIVMSG #seance :first"
			);

			const earlier = h.lastMessage(id).id - 1;
			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: newest, replaces: earlier},
				{chan: id, id: newest, replaces: h.lastMessage(id).id},
			]);
			expect(chan.msgRefs.get(newest)?.unread).to.equal(true);
		});

		it("keeps every edit waiting for an original, and applies its author's", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@msgid=e1;account=bob;+seance/edit=o1 :bob!bob@host PRIVMSG #seance :the"
			);
			const authors = h.lastMessage(id).id;
			h.transport.line(
				"@msgid=m1;account=mallory;+seance/edit=o1 :mallory!m@host PRIVMSG #seance :mine"
			);
			h.transport.line("@msgid=o1;account=bob :bob!bob@host PRIVMSG #seance :teh");
			const original = h.lastMessage(id).id;

			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: authors, replaces: original},
			]);
		});

		it("turns someone else's edit that came first into a line of its own", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.channelById(id)!;
			const before = chan.shared.unread;
			h.transport.line(
				"@msgid=c1;+seance/edit=o1 :carol!carol@host PRIVMSG #seance :mine now"
			);
			const carols = h.lastMessage(id).id;
			h.transport.line("@msgid=o1 :bob!bob@host PRIVMSG #seance :teh");

			expect(h.payloads("msg:edit")).to.have.length(0);
			expect(h.payloads("msg:unedit")).to.deep.equal([{chan: id, id: carols}]);
			expect(chan.shared.unread).to.equal(before + 2);
		});

		it("counts nothing for an original its author's edit already replaced", function () {
			const h = setup();
			const id = joined(h);
			const last = () => h.payloads<{unread: number; highlight: number}>("msg").pop();
			h.transport.line("@msgid=e1;+seance/edit=o1 :bob!bob@host PRIVMSG #seance :the");
			const before = last();
			h.transport.line("@msgid=o1 :bob!bob@host PRIVMSG #seance :alice: teh");

			expect(h.payloads("msg:edit")).to.have.length(1);
			expect(last()).to.include({unread: before?.unread, highlight: before?.highlight});
			expect(h.client.channelById(id)!.shared.unread).to.equal(before?.unread);
		});

		it("counts nothing for an original its author's edit replaced, in an older page", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			h.transport.line(":irc.test MARKREAD #seance timestamp=2026-08-25T10:00:00.000Z");
			h.transport.line(
				"@time=2026-08-25T12:00:05.000Z;msgid=e1;+seance/edit=o1 :bob!bob@host PRIVMSG #seance :the"
			);
			const edit = h.lastMessage(id);
			const chan = h.client.channelById(id)!;
			const before = {unread: chan.shared.unread, highlight: chan.shared.highlight};

			socket.emit("more", {target: id, lastId: edit.id, condensed: false});
			batch(
				h,
				[
					"@time=2026-08-25T11:00:00.000Z;msgid=o1 :bob!bob@host PRIVMSG #seance :alice: teh",
				],
				{label: labelOf(h.sent())}
			);

			expect(h.payloads("msg:edit")).to.have.length(1);
			expect({unread: chan.shared.unread, highlight: chan.shared.highlight}).to.deep.equal(
				before
			);
		});

		it("counts someone else's edit of a loaded line as a line of its own", function () {
			const h = setup();
			const id = joined(h);
			const unread = () => h.payloads<{unread: number}>("msg").pop()?.unread;
			h.transport.line("@msgid=b1 :bob!bob@host PRIVMSG #seance :teh");
			h.transport.line(
				"@msgid=c1;+seance/edit=b1 :carol!carol@host PRIVMSG #seance :mine now"
			);

			expect(unread()).to.equal(2);
			expect(h.lastMessage(id).editOf).to.equal(undefined);
		});

		it("takes an edit across a nick change when both lines carry the same account", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=b1;account=bob :bob!bob@host PRIVMSG #seance :teh");
			const oldId = h.lastMessage(id).id;
			h.transport.line(":bob!bob@host NICK robert");
			h.transport.line(
				"@msgid=b2;account=bob;+seance/edit=b1 :robert!bob@host PRIVMSG #seance :the"
			);

			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: h.lastMessage(id).id, replaces: oldId},
			]);
		});

		it("refuses an edit from another account under the same nick", function () {
			const h = setup();
			joined(h);
			h.transport.line("@msgid=b1;account=bob :bob!bob@host PRIVMSG #seance :teh");
			h.transport.line(
				"@msgid=b2;account=mallory;+seance/edit=b1 :bob!m@host PRIVMSG #seance :mine now"
			);

			expect(h.payloads("msg:edit")).to.have.length(0);
		});

		it("refuses an edit without an account of a line that carried one", function () {
			const h = setup();
			joined(h);
			h.transport.line("@msgid=b1;account=bob :bob!bob@host PRIVMSG #seance :teh");
			h.transport.line("@msgid=b2;+seance/edit=b1 :bob!m@host PRIVMSG #seance :mine now");

			expect(h.payloads("msg:edit")).to.have.length(0);
		});

		it("refuses an edit under our nick without an account of our account-tagged line", function () {
			const h = setup();
			joined(h);
			h.transport.line(
				"@msgid=a1;account=alice :alice!alice@host.example PRIVMSG #seance :teh"
			);
			h.transport.line(
				"@msgid=a2;+seance/edit=a1 :alice!x@elsewhere PRIVMSG #seance :not me"
			);

			expect(h.payloads("msg:edit")).to.have.length(0);
		});

		it("takes our own edit replayed after our nick changed", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@msgid=a1;time=2026-08-25T12:00:01.000Z :alice!alice@host.example PRIVMSG #seance :teh"
			);
			const oldId = h.lastMessage(id).id;
			h.transport.line(":alice!alice@host.example NICK alicia");
			h.transport.line(
				"@msgid=a2;time=2026-08-25T12:00:02.000Z;+seance/edit=a1 :alice!alice@host.example PRIVMSG #seance :the"
			);

			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: h.lastMessage(id).id, replaces: oldId},
			]);
		});

		it("counts an original whose waiting edit was trimmed away", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=e1;+seance/edit=o1 :bob!bob@host PRIVMSG #seance :the");
			const chan = h.client.channelById(id)!;
			chan.forget([h.lastMessage(id).id]);
			const before = chan.shared.highlight;
			h.transport.line("@msgid=o1 :bob!bob@host PRIVMSG #seance :alice: teh");

			expect(h.payloads("msg:edit")).to.have.length(0);
			expect(chan.shared.highlight).to.equal(before + 1);
		});

		it("counts someone else's edit of a line in the same history page as a line of its own", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			h.transport.line(":irc.test MARKREAD #seance timestamp=2026-08-25T10:00:00.000Z");
			socket.emit("more", {target: id, lastId: -1, condensed: false});
			batch(
				h,
				[
					"@time=2026-08-25T11:00:00.000Z;msgid=h1 :bob!bob@host PRIVMSG #seance :teh",
					"@time=2026-08-25T11:00:05.000Z;msgid=h2;+seance/edit=h1 :carol!carol@host PRIVMSG #seance :mine now",
				],
				{label: labelOf(h.sent())}
			);

			expect(h.payloads("msg:edit")).to.have.length(0);
			expect(h.client.channelById(id)!.shared.unread).to.equal(2);
		});

		it("counts nothing more for our own late original once our edit replaced it", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@msgid=a2;time=2026-08-25T12:00:02.000Z;+seance/edit=a1 :alice!alice@host.example PRIVMSG #seance :the"
			);
			h.transport.line(
				"@msgid=b1;time=2026-08-25T12:00:03.000Z :bob!bob@host PRIVMSG #seance :alice: hi"
			);
			const chan = h.client.channelById(id)!;
			const before = {unread: chan.shared.unread, highlight: chan.shared.highlight};
			h.transport.line(
				"@msgid=a1;time=2026-08-25T12:00:01.000Z :alice!alice@host.example PRIVMSG #seance :teh"
			);

			expect(h.payloads("msg:edit")).to.have.length(1);
			expect(before).to.deep.equal({unread: 1, highlight: 1});
			expect({unread: chan.shared.unread, highlight: chan.shared.highlight}).to.deep.equal(
				before
			);
		});

		it("shows the message but no msg:edit when the old one is not loaded", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=b2;+seance/edit=gone :bob!bob@host PRIVMSG #seance :the");

			expect(h.lastMessage(id).editOf).to.equal("gone");
			expect(h.payloads("msg:edit")).to.have.length(0);
		});

		it("resolves edits inside a chathistory batch after delivery", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			socket.emit("more", {target: id, lastId: -1, condensed: false});
			const label = labelOf(h.sent());
			batch(
				h,
				[
					"@time=2026-08-25T11:00:00.000Z;msgid=h1 :bob!bob@host PRIVMSG #seance :teh",
					"@time=2026-08-25T11:00:05.000Z;msgid=h2;+seance/edit=h1 :bob!bob@host PRIVMSG #seance :the",
				],
				{label}
			);

			const [more] = h.payloads<{messages: {id: number; msgid?: string}[]}>("more");
			expect(more.messages.map((m) => m.msgid)).to.deep.equal(["h1", "h2"]);
			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: more.messages[1].id, replaces: more.messages[0].id},
			]);
			const events = h.events();
			expect(events.indexOf("more")).to.be.lessThan(events.indexOf("msg:edit"));
		});

		it("puts an edit shown first in the place of an original an older page brings", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});
			h.transport.line(
				"@time=2026-08-25T12:00:05.000Z;msgid=e1;+seance/edit=o1 :bob!bob@host PRIVMSG #seance :the"
			);
			const edit = h.lastMessage(id);
			expect(h.payloads("msg:edit")).to.have.length(0);

			socket.emit("more", {target: id, lastId: edit.id, condensed: false});
			batch(
				h,
				["@time=2026-08-25T11:00:00.000Z;msgid=o1 :bob!bob@host PRIVMSG #seance :teh"],
				{label: labelOf(h.sent())}
			);

			const [more] = h.payloads<{messages: {id: number; msgid?: string}[]}>("more");
			expect(more.messages.map((m) => m.msgid)).to.deep.equal(["o1"]);
			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: edit.id, replaces: more.messages[0].id},
			]);
			const events = h.events();
			expect(events.indexOf("more")).to.be.lessThan(events.indexOf("msg:edit"));
		});

		it("puts an edit shown first in the place of an original delivered after it", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line("@msgid=e1;+seance/edit=o1 :bob!bob@host PRIVMSG #seance :the");
			const edit = h.lastMessage(id);
			h.transport.line("@msgid=o1 :bob!bob@host PRIVMSG #seance :teh");
			const original = h.lastMessage(id);

			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: edit.id, replaces: original.id},
			]);
			// Once only: the original arriving again changes nothing more.
			h.transport.line("@msgid=o1 :bob!bob@host PRIVMSG #seance :teh");
			expect(h.payloads("msg:edit")).to.have.length(1);
		});

		it("resolves edits appended by a catch-up (AFTER) replay", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@msgid=b1;time=2026-08-25T12:00:01.000Z :bob!bob@host PRIVMSG #seance :teh"
			);
			const oldId = h.lastMessage(id).id;

			// Drop and come back: the re-JOIN asks for AFTER the newest message.
			h.transport.closed();
			h.client.connect();
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${ALL_CAPS}`);
			const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
			h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
			h.transport.lines(
				":irc.test 001 alice :Welcome back",
				":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CASEMAPPING=rfc1459 CHATHISTORY=100 :are supported by this server",
				":irc.test 422 alice :MOTD File is missing",
				":alice!alice@host.example JOIN #seance",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			const sent = h.sent();
			expect(sent.some((l) => /CHATHISTORY LATEST #seance \* \d+$/.test(l))).to.equal(true);
			batch(
				h,
				[
					"@time=2026-08-25T12:00:05.000Z;msgid=b2;+seance/edit=b1 :bob!bob@host PRIVMSG #seance :the",
				],
				{label: labelOf(sent), end: true}
			);

			const msg = h.lastMessage(id);
			expect(msg.msgid).to.equal("b2");
			expect(h.payloads<EditPayload>("msg:edit")).to.deep.equal([
				{chan: id, id: msg.id, replaces: oldId},
			]);
		});
	});
});
