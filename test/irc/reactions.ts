import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {ignoreListFor} from "../../client/js/ignore";
import {MAX_LINE_BYTES, utf8ByteLength} from "../../client/js/irc/message";
import {MessageType} from "../../shared/types/msg";
import {ALL_CAPS, batch, joined, labelOf, setup, stubStorage} from "./support";

interface ReactPayload {
	chan: number;
	id: number;
	text: string;
	nick: string;
	remove: boolean;
}

const NO_ECHO = ALL_CAPS.replace("echo-message ", "");

describe("Replies and reactions (handlers/tagmsg.ts, +draft/reply)", function () {
	beforeEach(function () {
		stubStorage();
	});

	afterEach(function () {
		sinon.restore();
		socket.removeAllListeners();
	});

	describe("outbound reactions", function () {
		it("sends a react TAGMSG with escaped tag values", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.channelById(id)!;

			expect(h.client.react(chan, "m1", "a b;c\\d")).to.equal(true);
			expect(h.sent()).to.deep.equal([
				"@+draft/react=a\\sb\\:c\\\\d;+draft/reply=m1 TAGMSG #seance",
			]);
		});

		it("sends an unreact TAGMSG", function () {
			const h = setup();
			const id = joined(h);

			h.client.react(h.client.channelById(id)!, "m1", "👍", true);
			expect(h.sent()).to.deep.equal(["@+draft/unreact=👍;+draft/reply=m1 TAGMSG #seance"]);
		});

		it("/react defaults to the newest message with a msgid, /unreact takes an explicit one", function () {
			const h = setup();
			const id = joined(h);
			h.transport.lines(
				"@time=2026-08-25T12:01:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :first",
				"@time=2026-08-25T12:02:00.000Z;msgid=m2 :bob!bob@host PRIVMSG #seance :second"
			);
			h.client.pushMessage(h.client.channelById(id)!, {text: "local line, no msgid"});

			h.client.input(id, "/react 👍");
			h.client.input(id, "/unreact 👍 m1");
			expect(h.sent()).to.deep.equal([
				"@+draft/react=👍;+draft/reply=m2 TAGMSG #seance",
				"@+draft/unreact=👍;+draft/reply=m1 TAGMSG #seance",
			]);
		});

		it("/react skips channel events, which carry a msgid but show no reactions", function () {
			const h = setup();
			const id = joined(h);
			h.transport.lines(
				"@time=2026-08-25T12:01:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :hi",
				"@time=2026-08-25T12:02:00.000Z;msgid=m2 :bob!bob@host PRIVMSG #seance :\x01ACTION waves\x01",
				"@time=2026-08-25T12:03:00.000Z;msgid=ev-join :dave!dave@host JOIN #seance",
				"@time=2026-08-25T12:04:00.000Z;msgid=ev-quit :dave!dave@host QUIT :bye"
			);

			h.client.input(id, "/react 👍");
			expect(h.sent()).to.deep.equal(["@+draft/react=👍;+draft/reply=m2 TAGMSG #seance"]);
		});

		it("/react takes words, emoji runs and shortcodes, msgid or not", function () {
			const h = setup();
			const id = joined(h);
			h.transport.lines(
				"@time=2026-08-25T12:01:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :first",
				"@time=2026-08-25T12:02:00.000Z;msgid=m2 :bob!bob@host PRIVMSG #seance :second"
			);

			// Everything up to a msgid that names a message loaded here is the
			// reaction, so a last word is not mistaken for one.
			h.client.input(id, "/react so cool");
			h.client.input(id, "/react 🎉🎉🎉 m1");
			h.client.input(id, "/react :tada:");
			h.client.input(id, "/react   spaced   out  ");

			expect(h.sent()).to.deep.equal([
				"@+draft/react=so\\scool;+draft/reply=m2 TAGMSG #seance",
				"@+draft/react=🎉🎉🎉;+draft/reply=m1 TAGMSG #seance",
				"@+draft/react=🎉;+draft/reply=m2 TAGMSG #seance",
				"@+draft/react=spaced\\sout;+draft/reply=m2 TAGMSG #seance",
			]);
		});

		it("/react refuses to run without a message or in the lobby", function () {
			const h = setup();
			joined(h);
			// A channel whose only lines carry no msgid (our untagged JOIN).
			h.transport.lines(
				":alice!alice@host.example JOIN #empty",
				":irc.test 366 alice #empty :End of /NAMES list."
			);
			const id = h.client.findChannel("#empty")!.id;
			h.sent();

			h.client.input(id, "/react 👍");
			expect(h.lastMessage(id).type).to.equal(MessageType.ERROR);
			h.client.input(h.client.lobby.id, "/react 👍 m1");
			expect(h.lastMessage(h.client.lobby.id).text).to.match(/channels and queries/);
			h.client.input(id, "/react");
			expect(h.lastMessage(id).text).to.match(/^Usage/);
			expect(h.sent()).to.deep.equal([]);
		});

		it("refuses without message-tags", function () {
			const h = setup();
			const id = joined(h, "server-time echo-message");

			expect(h.client.react(h.client.channelById(id)!, "m1", "👍")).to.equal(false);
			expect(h.lastMessage(id).type).to.equal(MessageType.ERROR);
			expect(h.sent()).to.deep.equal([]);
		});

		it("routes the msg:react bus emit to the owning client", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});

			socket.emit("msg:react", {target: id, msgid: "m1", text: "🎉"});
			socket.emit("msg:react", {target: id, msgid: "m1", text: "🎉", remove: true});
			socket.emit("msg:react", {target: 999, msgid: "m1", text: "🎉"});
			expect(h.sent()).to.deep.equal([
				"@+draft/react=🎉;+draft/reply=m1 TAGMSG #seance",
				"@+draft/unreact=🎉;+draft/reply=m1 TAGMSG #seance",
			]);
		});
	});

	describe("inbound reactions", function () {
		function withMessage(caps = ALL_CAPS): {
			h: ReturnType<typeof setup>;
			id: number;
			msgId: number;
		} {
			const h = setup();
			const id = joined(h, caps);
			h.transport.line(
				"@time=2026-08-25T12:01:00.000Z;msgid=m1 :bob!bob@host PRIVMSG #seance :hello"
			);
			const msgId = h.lastMessage(id).id;
			return {h, id, msgId};
		}

		it("resolves another user's reaction to msg:react on the loaded message", function () {
			const {h, id, msgId} = withMessage();
			h.transport.line(
				"@+draft/react=👍;+draft/reply=m1;msgid=t1;time=2026-08-25T12:02:00.000Z :carol!carol@host TAGMSG #seance"
			);
			h.transport.line(
				"@+draft/unreact=👍;+draft/reply=m1;msgid=t2;time=2026-08-25T12:03:00.000Z :carol!carol@host TAGMSG #seance"
			);

			expect(h.payloads<ReactPayload>("msg:react")).to.deep.equal([
				{chan: id, id: msgId, text: "👍", nick: "carol", remove: false},
				{chan: id, id: msgId, text: "👍", nick: "carol", remove: true},
			]);
			expect(h.messages(id)).to.have.length(1); // nothing pushed as a message
		});

		it("unescapes the reaction text and accepts the ratified +reply tag", function () {
			const {h, msgId} = withMessage();
			h.transport.line("@+draft/react=a\\sb\\:c;+reply=m1 :carol!carol@host TAGMSG #seance");

			const [payload] = h.payloads<ReactPayload>("msg:react");
			expect(payload.id).to.equal(msgId);
			expect(payload.text).to.equal("a b;c");
		});

		it("applies our own echoed reaction (echo-message)", function () {
			const {h, id, msgId} = withMessage();
			h.client.react(h.client.channelById(id)!, "m1", "👍");
			expect(h.payloads("msg:react")).to.have.length(0);

			h.transport.line(
				"@+draft/react=👍;+draft/reply=m1;msgid=t1 :alice!alice@host.example TAGMSG #seance"
			);
			expect(h.payloads<ReactPayload>("msg:react")).to.deep.equal([
				{chan: id, id: msgId, text: "👍", nick: "alice", remove: false},
			]);
		});

		it("echoes our own reaction locally without echo-message", function () {
			const {h, id, msgId} = withMessage(NO_ECHO);
			h.client.react(h.client.channelById(id)!, "m1", "👍");

			expect(h.sent()).to.deep.equal(["@+draft/react=👍;+draft/reply=m1 TAGMSG #seance"]);
			expect(h.payloads<ReactPayload>("msg:react")).to.deep.equal([
				{chan: id, id: msgId, text: "👍", nick: "alice", remove: false},
			]);
		});

		it("drops reactions from ignored users", function () {
			const {h} = withMessage();
			ignoreListFor(h.client.uuid).add("carol!*@*");
			h.transport.line("@+draft/react=👍;+draft/reply=m1 :carol!carol@host TAGMSG #seance");
			h.transport.line("@+draft/react=👍;+draft/reply=m1 :dave!dave@host TAGMSG #seance");

			expect(h.payloads<ReactPayload>("msg:react").map((p) => p.nick)).to.deep.equal([
				"dave",
			]);
		});

		it("ignores +typing and reactions without a reply tag", function () {
			const {h} = withMessage();
			h.transport.lines(
				"@+typing=active;msgid=t1 :carol!carol@host TAGMSG #seance",
				"@+draft/react=👍 :carol!carol@host TAGMSG #seance",
				"@+draft/reply=m1 :carol!carol@host TAGMSG #seance",
				"@+draft/react=;+draft/reply=m1 :carol!carol@host TAGMSG #seance"
			);

			expect(h.payloads("msg:react")).to.have.length(0);
			expect(h.messages()).to.have.length(1);
		});

		it("drops reactions to unknown messages and unloaded targets silently", function () {
			const {h} = withMessage();
			h.transport.lines(
				"@+draft/react=👍;+draft/reply=nope :carol!carol@host TAGMSG #seance",
				"@+draft/react=👍;+draft/reply=m1 :carol!carol@host TAGMSG #other",
				"@+draft/react=👍;+draft/reply=m1 :carol!carol@host TAGMSG alice"
			);

			expect(h.payloads("msg:react")).to.have.length(0);
			expect(h.messages()).to.have.length(1);
			expect(h.client.findChannel("carol")).to.equal(undefined); // no query opened
		});

		it("attaches private reactions to the query with the other party", function () {
			const h = setup();
			joined(h);
			h.transport.line("@msgid=p1 :carol!carol@host PRIVMSG alice :psst");
			const query = h.client.findChannel("carol")!;
			const target = h.lastMessage(query.id).id;

			// carol reacts to her own message in our query; then we do, echoed
			// back with the target as the parameter.
			h.transport.line("@+draft/react=🙂;+draft/reply=p1 :carol!carol@host TAGMSG alice");
			h.transport.line(
				"@+draft/react=🙃;+draft/reply=p1 :alice!alice@host.example TAGMSG carol"
			);

			expect(h.payloads<ReactPayload>("msg:react")).to.deep.equal([
				{chan: query.id, id: target, text: "🙂", nick: "carol", remove: false},
				{chan: query.id, id: target, text: "🙃", nick: "alice", remove: false},
			]);
		});

		it("replays reactions from a chathistory batch after the batch is delivered", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/raw nothing"); // keep the client busy; no-op
			h.sent();

			h.client.open(id);
			// Ask for older history via the bus, answer with a message and a
			// reaction to it inside the same batch.
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
					"@time=2026-08-25T11:00:00.000Z;msgid=h1 :bob!bob@host PRIVMSG #seance :old",
					"@time=2026-08-25T11:00:05.000Z;msgid=h2;+draft/react=👍;+draft/reply=h1 :carol!carol@host TAGMSG #seance",
					"@time=2026-08-25T11:00:06.000Z;msgid=h3;+draft/react=👍;+draft/reply=missing :carol!carol@host TAGMSG #seance",
				],
				{label}
			);

			const more =
				h.payloads<{chan: number; messages: {id: number; msgid?: string}[]}>("more");
			expect(more).to.have.length(1);
			expect(more[0].messages.map((m) => m.msgid)).to.deep.equal(["h1"]);
			const oldId = more[0].messages[0].id;
			expect(oldId).to.be.lessThan(0);
			expect(h.payloads<ReactPayload>("msg:react")).to.deep.equal([
				{chan: id, id: oldId, text: "👍", nick: "carol", remove: false},
			]);
			const events = h.events();
			expect(events.indexOf("more")).to.be.lessThan(events.indexOf("msg:react"));
		});
	});

	describe("replies", function () {
		it("puts +draft/reply on plain text and /me, never on /msg or /notice", function () {
			const h = setup();
			const id = joined(h);

			h.client.input(id, "yes", {reply: "m1"});
			h.client.input(id, "/me nods", {reply: "m1"});
			h.client.input(id, "/msg bob hi", {reply: "m1"});
			h.client.input(id, "/notice bob hi", {reply: "m1"});
			expect(h.sent()).to.deep.equal([
				"@+draft/reply=m1;label=s1 PRIVMSG #seance :yes",
				"@+draft/reply=m1;label=s2 PRIVMSG #seance :\x01ACTION nods\x01",
				"@label=s3 PRIVMSG bob :hi",
				"@label=s4 NOTICE bob :hi",
			]);
		});

		it("passes reply through the input bus emit", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: () => h.client,
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});

			socket.emit("input", {target: id, text: "via bus", reply: "m1"});
			expect(h.sent()).to.deep.equal(["@+draft/reply=m1;label=s1 PRIVMSG #seance :via bus"]);
		});

		it("reads +reply and +draft/reply into replyTo", function () {
			const h = setup();
			const id = joined(h);
			h.transport.lines(
				"@msgid=m2;+draft/reply=m1 :bob!bob@host PRIVMSG #seance :draft",
				"@msgid=m3;+reply=m1 :bob!bob@host PRIVMSG #seance :ratified",
				"@msgid=m4 :bob!bob@host PRIVMSG #seance :plain"
			);

			const [draft, ratified, plain] = h.messages(id);
			expect(draft.replyTo).to.equal("m1");
			expect(ratified.replyTo).to.equal("m1");
			expect(plain.replyTo).to.equal(undefined);
		});

		it("keeps the reply tag on the local echo without echo-message", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);
			h.client.input(id, "yes", {reply: "m1"});

			const msg = h.lastMessage(id);
			expect(msg.self).to.equal(true);
			expect(msg.replyTo).to.equal("m1");
		});

		it("counts the tag block against the line budget when splitting", function () {
			const h = setup();
			const id = joined(h);
			const words = Array.from({length: 200}, (_, i) => `wörd${i}`).join(" ");
			const parent = "ABAAAAAaA8Iz[f";
			h.client.input(id, words, {reply: parent});

			const sent = h.sent();
			expect(sent.length).to.be.greaterThan(1);
			// What the server relays: our source in front of what we sent.
			const source = ":alice!alice@host.example ";

			for (const line of sent) {
				expect(line).to.match(
					/^@\+draft\/reply=ABAAAAAaA8Iz\[f;label=s\d+ PRIVMSG #seance :wörd\d+/
				);
				expect(utf8ByteLength(line) + source.length).to.be.at.most(MAX_LINE_BYTES);
			}

			const body = "PRIVMSG #seance :";
			expect(sent.map((l) => l.slice(l.indexOf(body) + body.length)).join(" ")).to.equal(
				words
			);
		});
	});
});
