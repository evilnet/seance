import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {HISTORY_TIMEOUT_MS, pendingHistory} from "../../client/js/irc/history";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {ChanType} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";

class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
	private listeners: ((ev: TransportEvent) => void)[] = [];

	on(listener: (ev: TransportEvent) => void): () => void {
		this.listeners.push(listener);

		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	connect(): void {
		this.state = "connecting";
	}

	send(line: string): void {
		if (this.state !== "open") {
			throw new Error("WsTransport: not open");
		}

		this.sent.push(line);
	}

	close(): void {
		this.state = "closed";
	}

	open(): void {
		this.state = "open";
		this.emit({type: "open", subprotocol: "text.ircv3.net"});
	}

	line(line: string): void {
		this.emit({type: "line", line});
	}

	lines(...lines: string[]): void {
		lines.forEach((line) => this.line(line));
	}

	closed(): void {
		this.state = "closed";
		this.emit({type: "close", code: 1006, reason: "", wasClean: false, willReconnect: false});
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

interface MorePayload {
	chan: number;
	messages: SharedMsg[];
	totalMessages: number;
}

interface MsgPayload {
	chan: number;
	msg: SharedMsg;
	unread?: number;
	highlight?: number;
}

let dispatch: sinon.SinonSpy;
/** Whether this file installed the spy (test/irc/client.ts has a root-level one). */
let ownsSpy = false;
let clock: sinon.SinonFakeTimers;

function installSpy(): void {
	const current = (socket as unknown as Record<string, unknown>).dispatch;

	if ((current as {isSinonProxy?: boolean}).isSinonProxy) {
		dispatch = current as sinon.SinonSpy;
		ownsSpy = false;
		return;
	}

	dispatch = sinon.spy(socket, "dispatch");
	ownsSpy = true;
}

function removeSpy(): void {
	if (ownsSpy) {
		dispatch.restore();
	}

	socket.removeAllListeners();
}

function payloads<T>(event: string): T[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === event)
		.map((call) => call.args[1] as T);
}

function mores(chanId?: number): MorePayload[] {
	return payloads<MorePayload>("more").filter((p) => chanId === undefined || p.chan === chanId);
}

function msgs(chanId?: number): MsgPayload[] {
	return payloads<MsgPayload>("msg").filter((p) => chanId === undefined || p.chan === chanId);
}

interface SetupOptions {
	chathistory?: boolean;
	labels?: boolean;
	isupport?: string;
	join?: string;
}

interface Harness {
	client: IrcClient;
	transport: FakeTransport;
	chan: () => number;
	/** Lines sent since the last call. */
	sent: () => string[];
}

const BASE_CAPS = "batch message-tags server-time echo-message extended-join draft/event-playback";

/** A registered client (not yet in any channel). */
function setup(opts: SetupOptions = {}): Harness {
	const transport = new FakeTransport();
	const client = new IrcClient({
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: opts.join ?? "#seance",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
	});
	let mark = 0;
	const caps = [
		BASE_CAPS,
		opts.chathistory === false ? "" : "draft/chathistory=100",
		opts.labels === false ? "" : "labeled-response",
	]
		.filter((s) => s.length > 0)
		.join(" ");

	client.connect();
	transport.open();
	transport.line(`:irc.test CAP * LS :${caps}`);
	const req = transport.sent.find((l) => l.startsWith("CAP REQ :"));
	expect(req, "CAP REQ sent").to.be.a("string");
	transport.line(`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`);
	transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		`:irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,l,imnpst CASEMAPPING=rfc1459 ${
			opts.isupport ?? "CHATHISTORY=100 MSGREFTYPES=timestamp,msgid"
		} :are supported by this server`,
		":irc.test 422 alice :MOTD File is missing"
	);
	registerBusHandlers(socket, {
		clientForChannel: (chanId) => (client.channelById(chanId) ? client : undefined),
		clientForNetwork: (uuid) => (uuid === client.uuid ? client : undefined),
		allClients: () => [client],
		createNetwork: () => client,
		remove: () => undefined,
	});
	mark = transport.sent.length;

	return {
		client,
		transport,
		chan: () => client.findChannel("#seance")!.id,
		sent() {
			const result = transport.sent.slice(mark);
			mark = transport.sent.length;
			return result;
		},
	};
}

/** Server confirms our JOIN to #seance (bob and carol present). */
function join(h: Harness): string[] {
	h.transport.lines(
		"@time=2026-08-25T12:00:00.000Z;msgid=join-1 :alice!alice@host JOIN #seance alice :Alice",
		":irc.test 353 alice = #seance :@alice bob carol",
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	return h.sent();
}

/** The label of the last CHATHISTORY line sent, or undefined. */
function labelOf(line: string | undefined): string | undefined {
	return line?.match(/^@label=([^ ;]+)/)?.[1];
}

/** Send a chathistory batch: `lines` get the batch tag added. */
function batch(
	h: Harness,
	lines: string[],
	opts: {ref?: string; target?: string; label?: string} = {}
): void {
	const ref = opts.ref ?? "hist1";
	const target = opts.target ?? "#seance";
	h.transport.line(
		`${opts.label ? `@label=${opts.label} ` : ""}:irc.test BATCH +${ref} chathistory ${target}`
	);

	for (const line of lines) {
		h.transport.line(
			line.startsWith("@") ? `@batch=${ref};${line.slice(1)}` : `@batch=${ref} ${line}`
		);
	}

	h.transport.line(`:irc.test BATCH -${ref}`);
}

/** Join and answer the automatic LATEST with `lines` (default: nothing). */
function joined(h: Harness, lines: string[] = []): number {
	const label = labelOf(join(h).find((l) => l.includes("CHATHISTORY")));
	batch(h, lines, {label});
	dispatch.resetHistory();
	h.sent();
	return h.chan();
}

/** Answer whatever request `sentLines` contains. */
function reply(h: Harness, sentLines: string[], lines: string[], target?: string): void {
	const label = labelOf(sentLines.find((l) => l.includes("CHATHISTORY")));
	batch(h, lines, {label, target});
}

function hist(n: number, nick = "bob", text = `message ${n}`): string {
	const minute = String(n).padStart(2, "0");
	return `@time=2026-08-25T11:${minute}:00.000Z;msgid=m${n} :${nick}!${nick}@host PRIVMSG #seance :${text}`;
}

describe("Chat history (history.ts)", function () {
	beforeEach(function () {
		installSpy();
		clock = sinon.useFakeTimers({
			now: new Date("2026-08-25T12:00:00.000Z"),
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
	});

	afterEach(function () {
		clock.restore();
		removeSpy();
	});

	describe("requests", function () {
		it("asks for the latest 50 messages when our JOIN is confirmed", function () {
			const h = setup();
			const sent = join(h);

			const line = sent.find((l) => l.includes("CHATHISTORY"));
			expect(line).to.match(/^@label=h\d+ CHATHISTORY LATEST #seance \* 50$/);
			expect(pendingHistory(h.client)).to.have.length(1);
			expect(h.client.findChannel("#seance")!.historyRequested).to.equal(true);
		});

		it("caps the limit at ISUPPORT CHATHISTORY", function () {
			const h = setup({isupport: "CHATHISTORY=30 MSGREFTYPES=timestamp,msgid"});
			expect(join(h).find((l) => l.includes("CHATHISTORY"))).to.match(
				/LATEST #seance \* 30$/
			);

			const id = joined(h);
			socket.emit("more", {target: id, lastId: -1, condensed: false});
			expect(h.sent()[0]).to.match(/LATEST #seance \* 30$/);
		});

		it("sends no label when labeled-response is off", function () {
			const h = setup({labels: false});
			expect(join(h).find((l) => l.includes("CHATHISTORY"))).to.equal(
				"CHATHISTORY LATEST #seance * 50"
			);
		});

		it("`more` sends BEFORE msgid=<first shown message> with limit 100", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@msgid=live-7;time=2026-08-25T12:01:00.000Z :bob!bob@host PRIVMSG #seance :hi"
			);
			const [{msg}] = msgs(id);

			socket.emit("more", {target: id, lastId: msg.id, condensed: false});

			expect(h.sent()).to.deep.equal([
				`@label=${labelOf(
					h.transport.sent.slice(-1)[0]
				)} CHATHISTORY BEFORE #seance msgid=live-7 100`,
			]);
			expect(mores(), "no reply until the batch closes").to.have.length(0);
		});

		it("`more` from a history message (negative id) sends BEFORE, not LATEST", function () {
			const h = setup();
			const id = joined(h);

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			reply(h, h.sent(), [hist(1), hist(2)]);
			const [more] = mores(id);
			const oldest = more.messages[0];
			expect(oldest.id).to.be.below(-1);
			expect(more.messages.map((m) => m.id)).to.not.include(-1);

			socket.emit("more", {target: id, lastId: oldest.id, condensed: false});

			expect(h.sent()[0]).to.match(/CHATHISTORY BEFORE #seance msgid=m1 100$/);
		});

		it("falls back to timestamp= when the message has no msgid", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@time=2026-08-25T12:01:30.500Z :bob!bob@host PRIVMSG #seance :no msgid"
			);
			const [{msg}] = msgs(id);

			socket.emit("more", {target: id, lastId: msg.id, condensed: false});

			expect(h.sent()[0]).to.match(
				/CHATHISTORY BEFORE #seance timestamp=2026-08-25T12:01:30\.500Z 100$/
			);
		});

		it("uses timestamp= when MSGREFTYPES excludes msgid", function () {
			const h = setup({isupport: "CHATHISTORY=100 MSGREFTYPES=timestamp"});
			const id = joined(h);
			h.transport.line(
				"@msgid=x;time=2026-08-25T12:02:00.000Z :bob!bob@host PRIVMSG #seance :hi"
			);
			const [{msg}] = msgs(id);

			socket.emit("more", {target: id, lastId: msg.id, condensed: false});

			expect(h.sent()[0]).to.match(/BEFORE #seance timestamp=2026-08-25T12:02:00\.000Z 100$/);
		});

		it("`more` with lastId -1 asks for LATEST", function () {
			const h = setup();
			const id = joined(h);

			socket.emit("more", {target: id, lastId: -1, condensed: false});

			expect(h.sent()[0]).to.match(/CHATHISTORY LATEST #seance \* 100$/);
		});

		it("answers `more` immediately when lastId is unknown", function () {
			const h = setup();
			const id = joined(h);

			socket.emit("more", {target: id, lastId: 424242, condensed: false});

			expect(h.sent()).to.deep.equal([]);
			expect(mores(id)).to.deep.equal([
				{
					chan: id,
					messages: [],
					totalMessages: h.client.findChannel("#seance")!.shared.totalMessages,
				},
			]);
		});

		it("keeps the old behaviour without draft/chathistory", function () {
			const h = setup({chathistory: false});
			expect(join(h).some((l) => l.includes("CHATHISTORY"))).to.equal(false);
			const id = h.chan();
			dispatch.resetHistory();

			socket.emit("more", {target: id, lastId: -1, condensed: false});

			expect(h.sent()).to.deep.equal([]);
			expect(mores(id)).to.have.length(1);
			expect(mores(id)[0].messages).to.deep.equal([]);
		});

		it("never requests history for the lobby", function () {
			const h = setup();
			joined(h);

			socket.emit("more", {target: h.client.lobby.id, lastId: -1, condensed: false});

			expect(h.sent()).to.deep.equal([]);
			expect(mores(h.client.lobby.id)).to.have.length(1);
		});

		it("requests query history by nick", function () {
			const h = setup();
			joined(h);
			h.transport.line(
				"@msgid=pm1;time=2026-08-25T12:03:00.000Z :bob!bob@host PRIVMSG alice :psst"
			);
			const query = h.client.findChannel("bob")!;
			expect(query.type).to.equal(ChanType.QUERY);
			const [{msg}] = msgs(query.id);
			dispatch.resetHistory();

			socket.emit("more", {target: query.id, lastId: msg.id, condensed: false});
			const sent = h.sent();
			expect(sent[0]).to.match(/CHATHISTORY BEFORE bob msgid=pm1 100$/);

			reply(
				h,
				sent,
				[
					"@time=2026-08-25T11:50:00.000Z;msgid=pm0 :alice!alice@host PRIVMSG bob :earlier from me",
					"@time=2026-08-25T11:51:00.000Z;msgid=pm0b :bob!bob@host PRIVMSG alice :earlier from bob",
				],
				"bob"
			);

			const [more] = mores(query.id);
			expect(more.messages.map((m) => [m.from?.nick, m.text, m.self])).to.deep.equal([
				["alice", "earlier from me", true],
				["bob", "earlier from bob", false],
			]);
		});
	});

	describe("replies", function () {
		it("answers `more` with the batch, oldest first, ids below everything shown", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@msgid=live-1;time=2026-08-25T12:01:00.000Z :bob!bob@host PRIVMSG #seance :live"
			);
			const live = msgs(id)[0].msg;
			const chan = h.client.findChannel("#seance")!;
			const before = chan.shared.totalMessages;

			socket.emit("more", {target: id, lastId: live.id, condensed: false});
			reply(h, h.sent(), [
				hist(1),
				`@time=2026-08-25T11:02:00.000Z;msgid=m2 :carol!carol@host PRIVMSG #seance :\x01ACTION waves\x01`,
				"@time=2026-08-25T11:03:00.000Z;msgid=m3 :bob!bob@host NOTICE #seance :note",
			]);

			expect(mores(id)).to.have.length(1);
			const [more] = mores(id);
			expect(more.messages.map((m) => m.text)).to.deep.equal(["message 1", "waves", "note"]);
			expect(more.messages.map((m) => m.type)).to.deep.equal([
				MessageType.MESSAGE,
				MessageType.ACTION,
				MessageType.NOTICE,
			]);
			expect(more.messages.map((m) => m.msgid)).to.deep.equal(["m1", "m2", "m3"]);
			expect(more.messages[0].time).to.deep.equal(new Date("2026-08-25T11:01:00.000Z"));
			expect(more.messages[0].from).to.include({nick: "bob"});
			const ids = more.messages.map((m) => m.id);
			expect(ids).to.deep.equal([...ids].sort((a, b) => a - b));
			expect(Math.max(...ids)).to.be.below(Math.min(...msgs(id).map((p) => p.msg.id)));
			expect(chan.shared.totalMessages).to.equal(before + 3);
			// Short page: no more history (totalMessages == shown + new).
			expect(more.totalMessages).to.equal(before + 3);
			expect(pendingHistory(h.client)).to.have.length(0);
			expect(chan.msgRefs.get(ids[0])).to.deep.include({msgid: "m1"});
		});

		it("keeps `moreHistoryAvailable` while the server returns full pages", function () {
			const h = setup({isupport: "CHATHISTORY=2"});
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			reply(h, h.sent(), [hist(1), hist(2)]);

			const [more] = mores(id);
			expect(more.messages).to.have.length(2);
			expect(more.totalMessages).to.equal(chan.shared.totalMessages + 1);
		});

		it("drops messages the channel already shows (by msgid) but not repeats within the batch", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@msgid=m2;time=2026-08-25T11:02:00.000Z :bob!bob@host PRIVMSG #seance :message 2"
			);

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			reply(h, h.sent(), [
				hist(1),
				hist(2),
				hist(3, "bob", "line a"),
				hist(3, "bob", "line b"),
			]);

			const [more] = mores(id);
			expect(more.messages.map((m) => m.text)).to.deep.equal([
				"message 1",
				"line a",
				"line b",
			]);
		});

		it("matches the reply by label, whatever the target spelling", function () {
			const h = setup();
			const id = joined(h);

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			const [first] = h.sent();
			socket.emit("more", {target: id, lastId: -1, condensed: false});
			const [second] = h.sent();
			expect(pendingHistory(h.client)).to.have.length(2);

			batch(h, [hist(2)], {label: labelOf(second), target: "#SEANCE", ref: "r2"});
			expect(pendingHistory(h.client).map((r) => r.label)).to.deep.equal([labelOf(first)]);
			batch(h, [hist(1)], {label: labelOf(first), ref: "r1"});

			expect(mores(id).map((m) => m.messages[0].text)).to.deep.equal([
				"message 2",
				"message 1",
			]);
			expect(pendingHistory(h.client)).to.have.length(0);
		});

		it("matches by target without labels", function () {
			const h = setup({labels: false});
			const id = joined(h);

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			batch(h, [hist(1)]);

			expect(mores(id)).to.have.length(1);
			expect(mores(id)[0].messages[0].text).to.equal("message 1");
		});

		it("FAIL CHATHISTORY answers `more` with nothing and is still shown", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			const label = labelOf(h.sent()[0]);
			h.transport.line(
				`@label=${label} :irc.test FAIL CHATHISTORY MESSAGE_ERROR LATEST #seance :Failed to retrieve history`
			);

			expect(mores(id)).to.deep.equal([
				{chan: id, messages: [], totalMessages: chan.shared.totalMessages},
			]);
			expect(pendingHistory(h.client)).to.have.length(0);
			const shown = msgs(h.client.lobby.id).slice(-1)[0].msg;
			expect(shown.type).to.equal(MessageType.ERROR);
			expect(shown.text).to.include("Failed to retrieve history");
		});

		it("a labeled ACK answers `more` with nothing", function () {
			const h = setup();
			const id = joined(h);

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			h.transport.line(`@label=${labelOf(h.sent()[0])} :irc.test ACK`);

			expect(mores(id)).to.have.length(1);
			expect(mores(id)[0].messages).to.deep.equal([]);
			expect(pendingHistory(h.client)).to.have.length(0);
		});

		it("times out after 15s with an empty reply that keeps the button, then ignores a late batch", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			const sent = h.sent();
			clock.tick(HISTORY_TIMEOUT_MS - 1);
			expect(mores(id)).to.have.length(0);
			clock.tick(1);

			expect(mores(id)).to.deep.equal([
				{chan: id, messages: [], totalMessages: chan.shared.totalMessages + 1},
			]);
			expect(pendingHistory(h.client)).to.have.length(0);

			// A late reply is still worth showing: it arrives as one more `more`.
			reply(h, sent, [hist(1)]);
			expect(mores(id)).to.have.length(2);
			expect(mores(id)[1].messages.map((m) => m.text)).to.deep.equal(["message 1"]);
		});

		it("answers pending requests when the transport closes", function () {
			const h = setup();
			const id = joined(h);

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			h.transport.closed();

			expect(mores(id)).to.have.length(1);
			expect(mores(id)[0].messages).to.deep.equal([]);
			expect(pendingHistory(h.client)).to.have.length(0);
		});

		it("history never highlights, notifies or counts as unread", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;
			h.client.open(h.client.lobby.id); // #seance is not the active channel
			expect(chan.shared.unread).to.equal(0);

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			reply(h, h.sent(), [
				hist(1, "bob", "alice: are you there?"),
				hist(2, "carol", "hey alice"),
			]);

			const [more] = mores(id);
			expect(more.messages.map((m) => m.highlight)).to.deep.equal([false, false]);
			expect(chan.shared.unread).to.equal(0);
			expect(chan.shared.highlight).to.equal(0);
			expect(msgs(id), "nothing dispatched as a live msg").to.have.length(0);

			// A live mention still highlights.
			h.transport.line(":bob!bob@host PRIVMSG #seance :alice ping");
			expect(msgs(id)[0].msg.highlight).to.equal(true);
			expect(chan.shared.highlight).to.equal(1);
		});

		it("renders event-playback lines as their message types without touching state", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;
			h.transport.line(":irc.test 332 alice #seance :current topic");
			dispatch.resetHistory();

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			reply(h, h.sent(), [
				"@time=2026-08-25T11:00:00.000Z :dave!dave@host JOIN #seance dave :Dave",
				"@time=2026-08-25T11:01:00.000Z :alice!alice@host JOIN #seance",
				"@time=2026-08-25T11:02:00.000Z :bob!bob@host PART #seance :brb",
				"@time=2026-08-25T11:03:00.000Z :carol!carol@host QUIT :Ping timeout",
				"@time=2026-08-25T11:04:00.000Z :alice!alice@host NICK :alice2",
				"@time=2026-08-25T11:05:00.000Z;msgid=ev-topic :dave!dave@host TOPIC #seance :old topic",
				"@time=2026-08-25T11:06:00.000Z :dave!dave@host MODE #seance +o bob",
				"@time=2026-08-25T11:07:00.000Z :dave!dave@host KICK #seance carol :out",
				"@time=2026-08-25T11:08:00.000Z :alice!alice@host PART #seance :cycling",
			]);

			const [more] = mores(id);
			expect(more.messages.map((m) => m.type)).to.deep.equal([
				MessageType.JOIN,
				MessageType.JOIN,
				MessageType.PART,
				MessageType.QUIT,
				MessageType.NICK,
				MessageType.TOPIC,
				MessageType.MODE,
				MessageType.KICK,
				MessageType.PART,
			]);
			expect(more.messages[1].self).to.equal(true);
			expect(more.messages[4]).to.include({new_nick: "alice2"});
			expect(more.messages[5].msgid, "msgid carried onto event messages").to.equal(
				"ev-topic"
			);
			expect(more.messages[6].text).to.equal("+o bob");
			expect(more.messages[7].target).to.include({nick: "carol"});
			// State is untouched: users, topic, our nick, no MODE query, channel kept.
			expect(chan.findUser("bob")).to.not.equal(undefined);
			expect(chan.findUser("carol")).to.not.equal(undefined);
			expect(chan.findUser("dave")).to.equal(undefined);
			expect(chan.findUser("bob")!.mode).to.equal("");
			expect(chan.shared.topic).to.equal("current topic");
			expect(h.client.nick).to.equal("alice");
			expect(h.client.channels).to.include(chan);
			expect(h.sent().filter((l) => l.startsWith("MODE"))).to.deep.equal([]);
			expect(payloads("topic")).to.have.length(0);
			expect(payloads("users")).to.have.length(0);
			expect(payloads("part")).to.have.length(0);
		});

		it("does not answer CTCP requests found in history", function () {
			const h = setup();
			const id = joined(h);

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			reply(h, h.sent(), [
				"@time=2026-08-25T11:00:00.000Z :bob!bob@host PRIVMSG #seance :\x01VERSION\x01",
				hist(1),
			]);

			expect(h.sent().filter((l) => l.startsWith("NOTICE"))).to.deep.equal([]);
			expect(mores(id)[0].messages.map((m) => m.text)).to.deep.equal(["message 1"]);
			expect(msgs(h.client.lobby.id)).to.have.length(0);
		});

		it("joins a nested multiline batch into one message of the chathistory batch", function () {
			const h = setup();
			const id = joined(h);

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			const label = labelOf(h.sent()[0]);
			h.transport.lines(
				`@label=${label} :irc.test BATCH +outer chathistory #seance`,
				`@batch=outer;${hist(1).slice(1)}`,
				"@batch=outer;time=2026-08-25T11:02:00.000Z;msgid=m2 :irc.test BATCH +ml draft/multiline #seance",
				"@batch=ml :bob!bob@host PRIVMSG #seance :first line",
				"@batch=ml :bob!bob@host PRIVMSG #seance :second line",
				"@batch=outer :irc.test BATCH -ml",
				`@batch=outer;${hist(3).slice(1)}`,
				":irc.test BATCH -outer"
			);

			const [more] = mores(id);
			expect(more.messages.map((m) => m.text)).to.deep.equal([
				"message 1",
				"first line\nsecond line",
				"message 3",
			]);
		});

		it("shows an unsolicited chathistory batch as older history", function () {
			const h = setup();
			const id = joined(h);

			batch(h, [hist(1)], {ref: "auto"});

			expect(mores(id)).to.have.length(1);
			expect(mores(id)[0].messages[0].text).to.equal("message 1");
		});

		it("the LATEST on join is delivered as `more` (prepended, not live)", function () {
			const h = setup();
			const sent = join(h);
			const id = h.chan();
			dispatch.resetHistory();

			reply(h, sent, [hist(1), hist(2)]);

			expect(msgs(id)).to.have.length(0);
			expect(mores(id)).to.have.length(1);
			expect(mores(id)[0].messages.map((m) => m.text)).to.deep.equal([
				"message 1",
				"message 2",
			]);
			// The newest history message becomes the catch-up reference only
			// when nothing live was shown; here the JOIN line came first.
			expect(h.client.findChannel("#seance")!.newestRef?.msgid).to.equal("join-1");
			expect(mores(id)[0].messages.some((m) => m.msgid === "join-1")).to.equal(false);
		});
	});

	describe("catch-up after a reconnect", function () {
		function reconnect(
			h: Harness,
			isupport = "CHATHISTORY=100 MSGREFTYPES=timestamp,msgid"
		): string[] {
			h.transport.closed();
			dispatch.resetHistory();
			h.client.connect();
			h.transport.open();
			h.transport.line(
				"@time=x :irc.test CAP * LS :draft/chathistory=100 labeled-response batch message-tags server-time"
			);
			const req = h.transport.sent.find(
				(l, i) => i >= h.transport.sent.length - 4 && l.startsWith("CAP REQ :")
			);
			h.transport.line(
				`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`
			);
			h.transport.lines(
				":irc.test 001 alice :Welcome back",
				`:irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,l,imnpst CASEMAPPING=rfc1459 ${isupport} :are supported by this server`,
				":irc.test 422 alice :MOTD File is missing"
			);
			h.sent();
			h.transport.lines(
				"@time=2026-08-25T12:30:00.000Z;msgid=join-2 :alice!alice@host JOIN #seance",
				":irc.test 353 alice = #seance :@alice bob",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			return h.sent();
		}

		it("asks for messages AFTER the newest one seen and appends them without unread effects", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;
			h.transport.line(
				"@msgid=last-seen;time=2026-08-25T12:10:00.000Z :bob!bob@host PRIVMSG #seance :before the drop"
			);
			h.client.open(h.client.lobby.id);
			expect(chan.shared.unread).to.equal(1);

			const sent = reconnect(h);
			// (Our own JOIN line is a `self` message, which resets the counter.)
			const unreadBefore = chan.shared.unread;
			expect(sent.find((l) => l.includes("CHATHISTORY"))).to.match(
				/CHATHISTORY AFTER #seance msgid=last-seen 100$/
			);
			expect(pendingHistory(h.client)[0]).to.include({mode: "append"});

			reply(h, sent, [
				"@time=2026-08-25T12:15:00.000Z;msgid=gap-1 :bob!bob@host PRIVMSG #seance :alice you there?",
				"@time=2026-08-25T12:16:00.000Z;msgid=gap-2 :bob!bob@host PRIVMSG #seance :guess not",
			]);

			expect(mores(id)).to.have.length(0);
			const gap = msgs(id).filter((p) => p.msg.msgid?.startsWith("gap"));
			expect(gap.map((p) => p.msg.text)).to.deep.equal(["alice you there?", "guess not"]);
			expect(gap.map((p) => p.msg.highlight)).to.deep.equal([false, false]);
			expect(gap.every((p) => p.msg.id > 0)).to.equal(true);
			expect(chan.shared.unread).to.equal(unreadBefore);
			expect(chan.shared.highlight).to.equal(0);
			expect(chan.newestRef?.msgid).to.equal("gap-2");
			expect(pendingHistory(h.client)).to.have.length(0);
		});

		it("pages AFTER again while the server returns full pages", function () {
			const h = setup({isupport: "CHATHISTORY=2 MSGREFTYPES=timestamp,msgid"});
			const id = joined(h);
			h.transport.line(
				"@msgid=seen;time=2026-08-25T12:10:00.000Z :bob!bob@host PRIVMSG #seance :x"
			);

			const sent = reconnect(h, "CHATHISTORY=2 MSGREFTYPES=timestamp,msgid");
			expect(sent.find((l) => l.includes("CHATHISTORY"))).to.match(
				/AFTER #seance msgid=seen 2$/
			);
			reply(h, sent, [
				"@time=2026-08-25T12:15:00.000Z;msgid=g1 :bob!bob@host PRIVMSG #seance :one",
				"@time=2026-08-25T12:16:00.000Z;msgid=g2 :bob!bob@host PRIVMSG #seance :two",
			]);

			const next = h.sent();
			expect(next[0]).to.match(/CHATHISTORY AFTER #seance msgid=g2 2$/);
			reply(h, next, [
				"@time=2026-08-25T12:17:00.000Z;msgid=g3 :bob!bob@host PRIVMSG #seance :three",
			]);

			expect(h.sent()).to.deep.equal([]);
			expect(msgs(id).map((p) => p.msg.text)).to.include.members(["one", "two", "three"]);
		});

		it("uses LATEST on a re-JOIN when no history was ever loaded", function () {
			const h = setup({chathistory: false});
			join(h);
			h.transport.line("@msgid=seen :bob!bob@host PRIVMSG #seance :x");

			const sent = reconnect(h);
			expect(sent.find((l) => l.includes("CHATHISTORY"))).to.match(/LATEST #seance \* 50$/);
		});
	});
});
