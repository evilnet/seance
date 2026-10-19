import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient, IrcClientOptions, parseJoinList, buildUrl} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import * as saved from "../../client/js/irc/saved-networks";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {utf8ByteLength} from "../../client/js/irc/message";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {CTCP_REPLY_INTERVAL_MS} from "../../client/js/irc/handlers/privmsg";
import {ChanState, ChanType} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import type {SharedNetwork, SharedNetworkChan} from "../../shared/types/network";

/** In-memory transport driven by the tests. */
class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
	connectCalls = 0;
	closeCalls: {code: number; reason: string}[] = [];
	private listeners: ((ev: TransportEvent) => void)[] = [];

	on(listener: (ev: TransportEvent) => void): () => void {
		this.listeners.push(listener);

		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	connect(): void {
		this.connectCalls++;
		this.state = "connecting";
	}

	send(line: string): void {
		if (this.state !== "open") {
			throw new Error("WsTransport: not open");
		}

		this.sent.push(line);
	}

	close(code = 1000, reason = ""): void {
		this.closeCalls.push({code, reason});
		this.state = "closed";
	}

	// --- drivers ---
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

	closed(code: number, reason = "", willReconnect = false): void {
		this.state = willReconnect ? "reconnect-wait" : "closed";
		this.emit({
			type: "close",
			code,
			reason,
			wasClean: code === 1000,
			willReconnect,
			delayMs: willReconnect ? 1000 : undefined,
		});

		if (willReconnect) {
			this.emit({type: "reconnecting", attempt: 1, delayMs: 1000});
		}
	}

	retry(attempt: number): void {
		this.state = "connecting";
		this.emit({type: "retry", attempt});
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

const OFFERED_CAPS =
	"multi-prefix userhost-in-names extended-join away-notify account-notify cap-notify server-time echo-message account-tag chghost invite-notify labeled-response batch setname standard-replies message-tags";

const ISUPPORT_1 =
	":irc.test 005 alice MAXCHANNELS=20 NICKLEN=15 CHANTYPES=#& PREFIX=(ov)@+ STATUSMSG=@+ :are supported by this server";
const ISUPPORT_2 =
	":irc.test 005 alice CHANMODES=b,k,Ll,aCcDdHiMmNnOPpQRrSsTtZz CASEMAPPING=rfc1459 NETWORK=SeanceDev :are supported by this server";

interface Harness {
	client: IrcClient;
	transport: FakeTransport;
	dispatch: sinon.SinonSpy;
	sentAfter(): string[];
}

let dispatch: sinon.SinonSpy;

beforeEach(() => {
	dispatch = sinon.spy(socket, "dispatch");
});

afterEach(() => {
	dispatch.restore();
	socket.removeAllListeners();
});

function setup(overrides: Partial<IrcClientOptions> = {}, keywords: string[] = []): Harness {
	const transport = new FakeTransport();
	const client = new IrcClient({
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "#seance",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords, exceptions: []}),
		...overrides,
	});
	let mark = 0;

	return {
		client,
		transport,
		dispatch,
		sentAfter() {
			const result = transport.sent.slice(mark);
			mark = transport.sent.length;
			return result;
		},
	};
}

/** Every payload dispatched for `event`. */
function payloads<T = any>(event: string): T[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === event)
		.map((call) => call.args[1] as T);
}

/** Every `msg` payload dispatched, optionally for one channel id. */
function messages(chanId?: number): SharedMsg[] {
	return payloads<{chan: number; msg: SharedMsg}>("msg")
		.filter((p) => chanId === undefined || p.chan === chanId)
		.map((p) => p.msg);
}

function lastMessage(chanId?: number): SharedMsg {
	const list = messages(chanId);
	return list[list.length - 1];
}

/** Drive the fake server through CAP / 001 / 005 / MOTD end. */
function register(h: Harness, {echo = true, motd = "422"}: {echo?: boolean; motd?: string} = {}) {
	h.client.connect();
	h.transport.open();
	const offered = echo ? OFFERED_CAPS : OFFERED_CAPS.replace("echo-message ", "");
	h.transport.line(`:irc.test CAP * LS :${offered}`);
	const req = h.transport.sent.find((l) => l.startsWith("CAP REQ :"));
	expect(req, "CAP REQ sent").to.be.a("string");
	h.transport.line(`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`);
	h.transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		ISUPPORT_1,
		ISUPPORT_2
	);

	if (motd === "422") {
		h.transport.line(":irc.test 422 alice :MOTD File is missing");
	} else {
		h.transport.lines(
			":irc.test 375 alice :- irc.test Message of the Day -",
			":irc.test 372 alice :- hello",
			":irc.test 376 alice :End of /MOTD command."
		);
	}

	h.sentAfter();
}

/** Register and have the server confirm our JOIN to #seance with a NAMES burst. */
function joined(h: Harness, users = "@alice bob +carol"): number {
	register(h);
	h.transport.lines(
		":alice!alice@host.example JOIN #seance",
		`:irc.test 353 alice = #seance :${users}`,
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	h.sentAfter();
	return h.client.findChannel("#seance")!.id;
}

describe("IrcClient", function () {
	describe("connection and registration", function () {
		it("announces the network (lobby first, PARTED placeholders) and connects", function () {
			const h = setup({join: "#seance, #other key"});
			h.client.connect();

			const [{network}] = payloads<{network: SharedNetwork}>("network");
			expect(network.uuid).to.equal("irc.test-8443-alice");
			expect(network.channels.map((c) => c.name)).to.deep.equal([
				"irc.test",
				"#other",
				"#seance",
			]);
			expect(network.channels[0].type).to.equal(ChanType.LOBBY);
			expect(network.channels[0].id).to.equal(1);
			expect(network.channels[1].state).to.equal(ChanState.PARTED);
			expect(network.channels[1].key).to.equal("key");
			expect(network.status.connected).to.equal(false);
			expect(payloads("connecting")).to.have.length(1);
			expect(h.transport.connectCalls).to.equal(1);
			expect(h.client.state).to.equal("connecting");
			expect(lastMessage(1).text).to.match(/^Connecting to irc.test:8443/);
		});

		it("sends CAP LS 302, NICK and USER on open", function () {
			const h = setup();
			h.client.connect();
			h.transport.open();

			expect(h.transport.sent).to.deep.equal([
				"CAP LS 302",
				"NICK alice",
				"USER alice 0 * :alice",
			]);
			expect(h.client.state).to.equal("registering");
		});

		it("requests the offered caps and pipelines CAP END behind the REQ", function () {
			const h = setup();
			h.client.connect();
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${OFFERED_CAPS}`);

			const req = h.transport.sent[3];
			expect(req).to.match(/^CAP REQ :multi-prefix /);
			expect(req).to.include("echo-message");
			// No round trip spent waiting for the ACK (ibutsu's suggestion).
			expect(h.transport.sent[4]).to.equal("CAP END");
			expect(h.transport.sent).to.have.length(5);

			h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
			expect(h.transport.sent).to.have.length(5);
			expect(h.client.caps.hasCapability("echo-message")).to.equal(true);
		});

		it("takes the nick from 001 and dispatches `nick`", function () {
			const h = setup();
			h.client.connect();
			h.transport.open();
			h.transport.line(":irc.test 001 alice_1 :Welcome");

			expect(h.client.nick).to.equal("alice_1");
			expect(payloads("nick")).to.deep.equal([{network: h.client.uuid, nick: "alice_1"}]);
		});

		it("applies 005 to serverOptions and the network name", function () {
			const h = setup();
			register(h);

			const options =
				payloads<{serverOptions: SharedNetwork["serverOptions"]}>("network:options");
			expect(options).to.have.length(2);
			expect(options[1].serverOptions.PREFIX.prefix).to.deep.equal([
				{mode: "o", symbol: "@"},
				{mode: "v", symbol: "+"},
			]);
			expect(options[1].serverOptions.PREFIX.modeToSymbol).to.deep.equal({o: "@", v: "+"});
			expect(options[1].serverOptions.CHANTYPES).to.deep.equal(["#", "&"]);
			expect(options[1].serverOptions.NETWORK).to.equal("SeanceDev");
			expect(payloads("network:name")).to.deep.equal([
				{uuid: h.client.uuid, name: "SeanceDev"},
			]);
			expect(h.client.network.name).to.equal("SeanceDev");
			expect(h.client.lobby.name).to.equal("SeanceDev");
		});

		it("dispatches init after 422, lobby first, active = first channel, then auto-JOINs", function () {
			const h = setup();
			register(h);

			const [init] = payloads<{active: number; networks: SharedNetwork[]}>("init");
			expect(init.networks).to.have.length(1);
			expect(init.networks[0].channels[0].type).to.equal(ChanType.LOBBY);
			expect(init.networks[0].channels[1].name).to.equal("#seance");
			expect(init.active).to.equal(init.networks[0].channels[1].id);
			expect(init.active).to.be.at.least(1);
			expect(init.networks[0].status.connected).to.equal(true);
			expect(payloads("network:status")).to.deep.equal([
				{network: h.client.uuid, connected: false, connecting: true, secure: true},
				{network: h.client.uuid, connected: true, connecting: false, secure: true},
			]);
			expect(h.transport.sent).to.include("JOIN #seance");
			expect(h.client.isConnected).to.equal(true);
			expect(h.client.state).to.equal("registered");
			expect(payloads<string[]>("commands")[0]).to.include("/msg");
		});

		it("collects the MOTD into one monospace block and registers on 376", function () {
			const h = setup();
			register(h, {motd: "376"});

			const motd = messages(1).find((m) => m.type === MessageType.MONOSPACE_BLOCK);
			expect(motd?.text).to.equal("- irc.test Message of the Day -\n- hello");
			expect(payloads("init")).to.have.length(1);
		});

		it("retries with a trailing underscore when the nick is in use during registration", function () {
			const h = setup();
			h.client.connect();
			h.transport.open();
			h.transport.line(":irc.test 433 * alice :Nickname is already in use.");

			expect(h.transport.sent[h.transport.sent.length - 1]).to.equal("NICK alice_");
			expect(h.client.nick).to.equal("alice_");
			expect(payloads("nick")).to.deep.equal([{network: h.client.uuid, nick: "alice_"}]);
			expect(lastMessage(1).type).to.equal(MessageType.ERROR);
			expect(lastMessage(1).text).to.equal("alice: Nickname is already in use.");
		});

		it("learns NICKLEN from a nick the server cut back, instead of looping", function () {
			const h = setup({nick: "abcdefghijklmno"});
			h.client.connect();
			h.transport.open();
			const nicks = () => h.transport.sent.filter((l) => l.startsWith("NICK ")).slice(1);

			// nefarious2 cuts `abcdefghijklmno_` to its 15, which is taken
			h.transport.line(":irc.test 433 * abcdefghijklmno :Nickname is already in use.");
			expect(nicks()).to.deep.equal(["NICK abcdefghijklmno_"]);
			h.transport.line(":irc.test 433 * abcdefghijklmno :Nickname is already in use.");
			expect(nicks()[1]).to.equal("NICK abcdefghijklmn_");

			// that one is taken too: the end changes, still 15 long
			h.transport.line(":irc.test 433 * abcdefghijklmn_ :Nickname is already in use.");
			expect(nicks()[2]).to.match(/^NICK abcdefghijk\d{4}$/);
		});

		it("learns NICKLEN from a fallback refused as too long (Ergo)", function () {
			const h = setup({nick: "abcdefghijklmno"});
			h.client.connect();
			h.transport.open();
			const nicks = () => h.transport.sent.filter((l) => l.startsWith("NICK ")).slice(1);

			h.transport.line(":irc.test 433 * abcdefghijklmno :Nickname is already in use.");
			expect(nicks()).to.deep.equal(["NICK abcdefghijklmno_"]);
			h.transport.line(":irc.test 432 * abcdefghijklmno_ :Erroneous Nickname");
			expect(nicks()[1]).to.equal("NICK abcdefghijklmn_");

			h.transport.line(":irc.test 433 * abcdefghijklmn_ :Nickname is already in use.");
			expect(nicks()[2]).to.match(/^NICK abcdefghijk\d{4}$/);
		});

		it("forgets a learned NICKLEN on the next connection", function () {
			const h = setup({nick: "abcdefghijklmno"});
			h.client.connect();
			h.transport.open();
			h.transport.line(":irc.test 433 * abcdefghijklmno :Nickname is already in use.");
			h.transport.line(":irc.test 433 * abcdefghijklmno :Nickname is already in use.");
			expect(h.client.learnedNickLen).to.equal(15);

			h.transport.open();
			expect(h.client.learnedNickLen).to.equal(undefined);
		});

		it("still picks a random nick when the nick asked for is refused", function () {
			const h = setup({nick: "bad*nick"});
			h.client.connect();
			h.transport.open();
			h.transport.line(":irc.test 432 * bad*nick :Erroneous Nickname");
			expect(h.client.nick).to.match(/^seance\d{4}$/);
		});

		it("only reports a nick collision after registration", function () {
			const h = setup();
			register(h);
			h.transport.line(":irc.test 433 alice bob :Nickname is already in use.");

			expect(h.sentAfter()).to.deep.equal([]);
			expect(h.client.nick).to.equal("alice");
			expect(lastMessage(1).text).to.equal("bob: Nickname is already in use.");
		});

		it("learns its own host from 396 and the ident/host from its JOIN echo", function () {
			const h = setup();
			register(h);
			h.transport.line(":irc.test 396 alice alice.users.seance :is now your hidden host");
			expect(h.client.host).to.equal("alice.users.seance");

			h.transport.line(":alice!~al@real.host JOIN #seance");
			expect(h.client.ident).to.equal("~al");
			expect(h.client.host).to.equal("real.host");
		});
	});

	describe("JOIN", function () {
		it("turns our placeholder into a JOINED channel; modes are asked on first open, not on JOIN", function () {
			const h = setup();
			register(h);
			const chan = h.client.findChannel("#seance")!;
			h.transport.line("@time=2026-08-24T10:00:00.000Z :alice!alice@host JOIN #seance");

			expect(chan.state).to.equal(ChanState.JOINED);
			expect(payloads("channel:state")).to.deep.equal([
				{chan: chan.id, state: ChanState.JOINED},
			]);
			expect(h.sentAfter().filter((l) => l.startsWith("MODE"))).to.deep.equal([]);
			h.client.open(chan.id);
			expect(h.sentAfter().filter((l) => l.startsWith("MODE"))).to.deep.equal([
				"MODE #seance",
			]);
			const msg = lastMessage(chan.id);
			expect(msg.type).to.equal(MessageType.JOIN);
			expect(msg.self).to.equal(true);
			expect(msg.hostmask).to.equal("alice@host");
			expect(msg.time.toISOString()).to.equal("2026-08-24T10:00:00.000Z");
			expect(chan.findUser("alice")).to.not.equal(undefined);
			expect(payloads("users")).to.deep.equal([{chan: chan.id}]);
		});

		it("creates and announces a channel we join that was not configured", function () {
			const h = setup();
			register(h);
			h.transport.line(":alice!alice@host JOIN #new");

			const [join] =
				payloads<{index: number; chan: SharedNetworkChan; shouldOpen: boolean}>("join");
			expect(join.chan.name).to.equal("#new");
			expect(join.chan.state).to.equal(ChanState.JOINED);
			expect(join.chan.type).to.equal(ChanType.CHANNEL);
			expect(join.index).to.equal(1); // "#new" sorts before "#seance"
			expect(join.shouldOpen).to.equal(false);
			expect(h.client.channels.map((c) => c.name)).to.deep.equal([
				"SeanceDev",
				"#new",
				"#seance",
			]);
		});

		it("opens the window of a channel the user asked to /join, not of one nobody asked for", function () {
			const h = setup();
			register(h);
			h.client.input(h.client.lobby.id, "/join #New");
			expect(h.sentAfter()).to.deep.equal(["JOIN #New"]);

			// The server's confirmation, then a channel we never asked for
			// (a forced join, a held session restoring one).
			h.transport.line(":alice!alice@host JOIN #new");
			h.transport.line(":alice!alice@host JOIN #forced");

			const joins = payloads<{chan: SharedNetworkChan; shouldOpen: boolean}>("join");
			expect(joins.map((j) => [j.chan.name, j.shouldOpen])).to.deep.equal([
				["#new", true],
				["#forced", false],
			]);

			// The request is consumed by its JOIN: leave and get put back, and
			// the window is not opened again.
			h.transport.line(":alice!alice@host PART #new");
			expect(h.client.findChannel("#new")).to.equal(undefined);
			h.transport.line(":alice!alice@host JOIN #new");
			const again = payloads<{chan: SharedNetworkChan; shouldOpen: boolean}>("join");
			expect(again).to.have.length(3);
			expect(again[2].chan.name).to.equal("#new");
			expect(again[2].shouldOpen).to.equal(false);
		});

		it("adds other users with extended-join account and gecos", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(":dave!dave@host JOIN #seance daveacct :Dave Example");

			const msg = lastMessage(id);
			expect(msg.type).to.equal(MessageType.JOIN);
			expect(msg.from).to.deep.equal({nick: "dave", mode: ""});
			expect(msg.gecos).to.equal("Dave Example");
			expect(msg.account).to.equal("daveacct");
			expect(msg.self).to.equal(false);
			expect(h.client.findChannel("#seance")!.findUser("dave")!.nick).to.equal("dave");
		});

		it("drops a realname that is only the nick again", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(":dave!dave@host JOIN #seance * :Dave");

			const msg = lastMessage(id);
			expect(msg.type).to.equal(MessageType.JOIN);
			expect(msg.gecos).to.equal(undefined);
			expect(msg.account).to.equal(undefined);
		});
	});

	describe("PRIVMSG / NOTICE", function () {
		it("delivers a channel message with time, msgid and sender mode", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(
				"@time=2026-08-24T12:34:56.000Z;msgid=abc123 :bob!bob@host PRIVMSG #seance :hello world"
			);

			const [payload] =
				payloads<{chan: number; msg: SharedMsg; unread: number}>("msg").slice(-1);
			expect(payload.chan).to.equal(id);
			expect(payload.msg.type).to.equal(MessageType.MESSAGE);
			expect(payload.msg.text).to.equal("hello world");
			expect(payload.msg.from).to.deep.equal({nick: "bob", mode: ""});
			expect(payload.msg.msgid).to.equal("abc123");
			expect(payload.msg.self).to.equal(false);
			expect(payload.msg.highlight).to.equal(false);
			expect(payload.msg.time.toISOString()).to.equal("2026-08-24T12:34:56.000Z");
			expect(payload.unread).to.equal(1);
			expect(h.client.findChannel("#seance")!.findUser("bob")!.lastMessage).to.equal(
				Date.parse("2026-08-24T12:34:56.000Z")
			);
		});

		it("waits for the server echo when echo-message is enabled", function () {
			const h = setup();
			const id = joined(h);
			const before = messages(id).length;
			h.client.sendMessage("#seance", "hi there");

			expect(h.sentAfter()).to.deep.equal(["@label=s1 PRIVMSG #seance :hi there"]);
			// Shown at once as a pending copy, replaced by the echo
			// (test/irc/pending.ts has the rest of that).
			expect(messages(id)).to.have.length(before + 1);
			expect(lastMessage(id).pending).to.equal(true);

			h.transport.line("@label=s1 :alice!alice@host.example PRIVMSG #seance :hi there");
			const msg = lastMessage(id);
			expect(msg.self).to.equal(true);
			expect(msg.text).to.equal("hi there");
			expect(msg.highlight).to.equal(false);
			expect(msg.pending).to.equal(undefined);
		});

		it("echoes locally when echo-message is not available", function () {
			const h = setup();
			register(h, {echo: false});
			h.transport.lines(
				":alice!alice@host JOIN #seance",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			const id = h.client.findChannel("#seance")!.id;
			h.client.sendMessage("#seance", "local echo");

			expect(h.client.caps.hasCapability("echo-message")).to.equal(false);
			const msg = lastMessage(id);
			expect(msg.self).to.equal(true);
			expect(msg.text).to.equal("local echo");
			expect(msg.from?.nick).to.equal("alice");
		});

		it("computes highlight from the nick and custom keywords, never for self", function () {
			const h = setup({}, ["seance"]);
			const id = joined(h);
			h.transport.line(":bob!bob@host PRIVMSG #seance :alice: ping");
			expect(lastMessage(id).highlight).to.equal(true);
			expect(payloads<{highlight: number}>("msg").slice(-1)[0].highlight).to.equal(1);

			h.transport.line(":bob!bob@host PRIVMSG #seance :I like Seance a lot");
			expect(lastMessage(id).highlight).to.equal(true);

			h.transport.line(":bob!bob@host PRIVMSG #seance :nothing for you");
			expect(lastMessage(id).highlight).to.equal(false);

			h.transport.line(":alice!alice@host PRIVMSG #seance :alice talking about alice");
			expect(lastMessage(id).highlight).to.equal(false);
		});

		it("opens a query on the first private message and highlights it", function () {
			const h = setup();
			joined(h);
			h.transport.line(":eve!eve@host PRIVMSG alice :psst");

			const [join] =
				payloads<{chan: SharedNetworkChan; shouldOpen: boolean; index: number}>("join");
			expect(join.chan.type).to.equal(ChanType.QUERY);
			expect(join.chan.name).to.equal("eve");
			expect(join.shouldOpen).to.equal(false);
			expect(join.index).to.be.at.least(1);
			const msg = lastMessage(join.chan.id);
			expect(msg.text).to.equal("psst");
			expect(msg.highlight).to.equal(true);

			// The second one reuses the window.
			h.transport.line(":eve!eve@host PRIVMSG alice :again");
			expect(payloads("join")).to.have.length(1);
			expect(lastMessage(join.chan.id).text).to.equal("again");
		});

		it("picks up highlight settings and nick changes immediately", function () {
			// Guards the memoized highlight regex: the cache must be keyed
			// on the live settings and the current nick, never go stale.
			let keywords: string[] = [];
			const h = setup({highlights: () => ({keywords, exceptions: []})});
			const id = joined(h);

			h.transport.line(":bob!bob@host PRIVMSG #seance :the ghost appears");
			expect(lastMessage(id).highlight).to.equal(false);

			keywords = ["ghost"];
			h.transport.line(":bob!bob@host PRIVMSG #seance :the ghost appears");
			expect(lastMessage(id).highlight).to.equal(true);

			h.transport.line(":alice!alice@host NICK :spectre");
			h.transport.line(":bob!bob@host PRIVMSG #seance :spectre, you around?");
			expect(lastMessage(id).highlight).to.equal(true);
			h.transport.line(":bob!bob@host PRIVMSG #seance :alice, you around?");
			expect(lastMessage(id).highlight).to.equal(false);
		});

		it("applies highlightExceptions to the query auto-highlight", function () {
			// The old server ran the exception regex over *any* highlight,
			// including the query one (attic message.ts); keep that.
			const h = setup({highlights: () => ({keywords: [], exceptions: ["lunch"]})});
			joined(h);
			h.transport.line(":eve!eve@host PRIVMSG alice :want to grab lunch?");

			const [join] = payloads<{chan: SharedNetworkChan}>("join");
			expect(lastMessage(join.chan.id).highlight).to.equal(false);

			h.transport.line(":eve!eve@host PRIVMSG alice :urgent, ping me");
			expect(lastMessage(join.chan.id).highlight).to.equal(true);
		});

		it("sends a private message to the sender's query window", function () {
			const h = setup();
			joined(h);
			h.client.input(h.client.findChannel("#seance")!.id, "/msg eve hello eve");
			expect(h.sentAfter()).to.deep.equal(["@label=s1 PRIVMSG eve :hello eve"]);

			h.transport.line(":alice!alice@host PRIVMSG eve :hello eve");
			const query = h.client.findChannel("eve")!;
			expect(query.type).to.equal(ChanType.QUERY);
			expect(lastMessage(query.id).self).to.equal(true);
		});

		it("routes server and untargeted notices to the lobby", function () {
			const h = setup();
			joined(h);
			h.transport.line(":irc.test NOTICE alice :*** You are connected");
			expect(lastMessage(1).type).to.equal(MessageType.NOTICE);
			expect(lastMessage(1).from?.nick).to.equal("irc.test");

			h.transport.line(":NickServ!services@services NOTICE alice :This nick is registered");
			const notice = lastMessage(1);
			expect(notice.showInActive).to.equal(true);
			expect(notice.from?.nick).to.equal("NickServ");
			expect(h.client.findChannel("NickServ")).to.equal(undefined);
		});

		it("turns CTCP ACTION into an action and STATUSMSG targets into the channel", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(":bob!bob@host PRIVMSG #seance :\x01ACTION waves\x01");
			expect(lastMessage(id).type).to.equal(MessageType.ACTION);
			expect(lastMessage(id).text).to.equal("waves");

			h.transport.line(":bob!bob@host PRIVMSG @#seance :ops only");
			expect(lastMessage(id).text).to.equal("ops only");
			expect(lastMessage(id).statusmsgGroup).to.equal("@");
		});

		it("answers CTCP VERSION and reports it in the lobby", function () {
			const h = setup();
			joined(h);
			h.transport.line(":bob!bob@host PRIVMSG alice :\x01VERSION\x01");

			expect(h.sentAfter()).to.deep.equal(["NOTICE bob :\x01VERSION Seance\x01"]);
			expect(lastMessage(1).type).to.equal(MessageType.CTCP_REQUEST);
		});

		it("answers one CTCP request per interval, so a burst cannot flood us off", function () {
			const clock = sinon.useFakeTimers({now: 1_700_000_000_000, toFake: ["Date"]});

			try {
				const h = setup();
				joined(h);

				for (let i = 0; i < 5; i++) {
					h.transport.line(`:bob!bob@host PRIVMSG #seance :\x01PING ${i}\x01`);
				}

				expect(h.sentAfter()).to.deep.equal(["NOTICE bob :\x01PING 0\x01"]);
				expect(
					messages(1).filter((m) => m.type === MessageType.CTCP_REQUEST)
				).to.have.length(5);

				clock.tick(CTCP_REPLY_INTERVAL_MS);
				h.transport.line(":bob!bob@host PRIVMSG alice :\x01VERSION\x01");
				expect(h.sentAfter()).to.deep.equal(["NOTICE bob :\x01VERSION Seance\x01"]);
			} finally {
				clock.restore();
			}
		});

		it("does not echo a long PING argument, so each reply costs the same fake lag", function () {
			const h = setup();
			joined(h);
			h.transport.line(`:bob!bob@host PRIVMSG alice :\x01PING ${"x".repeat(450)}\x01`);

			expect(h.sentAfter()).to.deep.equal(["NOTICE bob :\x01PING\x01"]);
		});
	});

	describe("NAMES", function () {
		it("accumulates 353 with multi-prefix and userhost-in-names until 366", function () {
			const h = setup();
			register(h);
			h.transport.line(":alice!alice@host JOIN #seance");
			const chan = h.client.findChannel("#seance")!;
			const usersBefore = payloads("users").length;

			h.transport.line(":irc.test 353 alice = #seance :@+bob!bob@b.host +carol!carol@c.host");
			h.transport.line(":irc.test 353 alice = #seance :alice!alice@host @dave");
			expect(payloads("users")).to.have.length(usersBefore);

			h.transport.line(":irc.test 366 alice #seance :End of /NAMES list.");
			expect(payloads("users")).to.have.length(usersBefore + 1);

			const sorted = chan.sortedUsers((s) => h.client.prefixRank(s));
			expect(sorted.map((u) => `${u.mode}${u.nick}`)).to.deep.equal([
				"@bob",
				"@dave",
				"+carol",
				"alice",
			]);
			expect(chan.findUser("bob")!.modes).to.deep.equal(["@", "+"]);
			expect(chan.findUser("BOB")!.nick).to.equal("bob");
		});
	});

	describe("TOPIC", function () {
		it("applies 332/333 on join without a sender", function () {
			const h = setup();
			const id = joined(h);
			h.transport.lines(
				":irc.test 332 alice #seance :Welcome to Seance",
				":irc.test 333 alice #seance bob!bob@host 1756000000"
			);

			expect(payloads("topic")).to.deep.equal([{chan: id, topic: "Welcome to Seance"}]);
			const [topic, setBy] = messages(id).slice(-2);
			expect(topic.type).to.equal(MessageType.TOPIC);
			expect(topic.from).to.equal(undefined);
			expect(topic.text).to.equal("Welcome to Seance");
			expect(setBy.type).to.equal(MessageType.TOPIC_SET_BY);
			expect(setBy.from?.nick).to.equal("bob");
			expect(setBy.when?.getTime()).to.equal(1756000000000);
			expect(h.client.findChannel("#seance")!.shared.topic).to.equal("Welcome to Seance");
		});

		it("applies a TOPIC change with its sender", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(":bob!bob@host TOPIC #seance :New topic");

			expect(payloads("topic")).to.deep.equal([{chan: id, topic: "New topic"}]);
			expect(lastMessage(id).from).to.deep.equal({nick: "bob", mode: ""});
			expect(lastMessage(id).text).to.equal("New topic");
		});
	});

	describe("MODE", function () {
		it("updates prefix modes on users and reports the change", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;
			h.transport.line(":alice!alice@host MODE #seance +ov bob bob");

			expect(chan.findUser("bob")!.modes).to.deep.equal(["@", "+"]);
			expect(chan.findUser("bob")!.mode).to.equal("@");
			const msg = lastMessage(id);
			expect(msg.type).to.equal(MessageType.MODE);
			expect(msg.text).to.equal("+ov bob bob");
			expect(msg.users).to.deep.equal(["bob", "bob"]);
			expect(msg.self).to.equal(true);
			expect(payloads("users").slice(-1)).to.deep.equal([{chan: id}]);

			h.transport.line(":alice!alice@host MODE #seance -o bob");
			expect(chan.findUser("bob")!.modes).to.deep.equal(["+"]);
		});

		it("parses parameters per CHANMODES and captures the key", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;
			h.transport.line(":bob!bob@host MODE #seance +bkl *!*@bad.host secret 42");

			expect(chan.shared.key).to.equal("secret");
			expect(lastMessage(id).text).to.equal("+bkl *!*@bad.host secret 42");

			h.transport.line(":irc.test 324 alice #seance +ntk secret");
			expect(lastMessage(id).type).to.equal(MessageType.MODE_CHANNEL);
			expect(lastMessage(id).text).to.equal("+ntk secret");

			h.transport.line(":bob!bob@host MODE #seance -k secret");
			expect(chan.shared.key).to.equal("");
		});

		it("shows 324 once: a repeat after a reconnect is state, /mode asks again", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;

			h.transport.line(":irc.test 324 alice #seance +tn");
			expect(lastMessage(id).type).to.equal(MessageType.MODE_CHANNEL);
			expect(lastMessage(id).text).to.equal("+tn");

			// Every (re)JOIN asks again; the same answer is not news.
			const before = messages(id).length;
			h.transport.line(":irc.test 324 alice #seance +tn");
			expect(messages(id)).to.have.length(before);

			// …but a change is, and so is an answer the user asked for.
			h.transport.line(":irc.test 324 alice #seance +tnm");
			expect(lastMessage(id).text).to.equal("+tnm");

			h.client.input(id, "/mode");
			expect(chan.modesAsked).to.equal(true);
			h.transport.line(":irc.test 324 alice #seance +tnm");
			expect(messages(id).slice(-1)[0].text).to.equal("+tnm");
			expect(messages(id).filter((m) => m.text === "+tnm")).to.have.length(2);
		});

		it("puts our own user modes in the lobby", function () {
			const h = setup();
			register(h);
			h.transport.line(":alice!alice@host MODE alice +xz");

			expect(lastMessage(1).type).to.equal(MessageType.MODE);
			expect(lastMessage(1).text).to.equal("+xz");
			expect(lastMessage(1).self).to.equal(true);
		});
	});

	describe("PART / QUIT / KICK", function () {
		it("removes a parting user and keeps their reason", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(":bob!bob@host PART #seance :bye");

			expect(lastMessage(id).type).to.equal(MessageType.PART);
			expect(lastMessage(id).text).to.equal("bye");
			expect(lastMessage(id).hostmask).to.equal("bob@host");
			expect(h.client.findChannel("#seance")!.findUser("bob")).to.equal(undefined);
		});

		it("drops the channel when we part", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(":alice!alice@host PART #seance");

			expect(payloads("part")).to.deep.equal([{chan: id}]);
			expect(h.client.findChannel("#seance")).to.equal(undefined);
			expect(h.client.channels).to.have.length(1);
		});

		it("announces a QUIT in every channel the user shared", function () {
			const h = setup();
			const id = joined(h);
			h.transport.lines(
				":alice!alice@host JOIN #other",
				":irc.test 353 alice = #other :alice bob",
				":irc.test 366 alice #other :End of /NAMES list."
			);
			const other = h.client.findChannel("#other")!;
			h.transport.line(":bob!bob@host QUIT :Ping timeout");

			expect(lastMessage(id).type).to.equal(MessageType.QUIT);
			expect(lastMessage(id).text).to.equal("Ping timeout");
			expect(lastMessage(other.id).type).to.equal(MessageType.QUIT);
			expect(h.client.findChannel("#seance")!.findUser("bob")).to.equal(undefined);
			expect(other.findUser("bob")).to.equal(undefined);
		});

		it("handles kicks of others and of ourselves", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;
			h.transport.line(":alice!alice@host KICK #seance bob :go away");

			let msg = lastMessage(id);
			expect(msg.type).to.equal(MessageType.KICK);
			expect(msg.target).to.deep.equal({nick: "bob", mode: ""});
			expect(msg.self).to.equal(true);
			expect(msg.highlight).to.equal(false);
			expect(chan.findUser("bob")).to.equal(undefined);

			h.transport.line(":carol!carol@host KICK #seance alice :no");
			msg = lastMessage(id);
			expect(msg.highlight).to.equal(true);
			expect(msg.from).to.deep.equal({nick: "carol", mode: "+"});
			expect(chan.state).to.equal(ChanState.PARTED);
			expect(chan.users.size).to.equal(0);
			expect(payloads("channel:state").slice(-1)).to.deep.equal([
				{chan: id, state: ChanState.PARTED},
			]);
		});
	});

	describe("NICK", function () {
		it("renames other users in place", function () {
			const h = setup();
			const id = joined(h);
			const chan = h.client.findChannel("#seance")!;
			h.transport.line(":carol!carol@host NICK :caroline");

			expect(lastMessage(id).type).to.equal(MessageType.NICK);
			expect(lastMessage(id).from).to.deep.equal({nick: "carol", mode: "+"});
			expect(lastMessage(id).new_nick).to.equal("caroline");
			expect(chan.findUser("carol")).to.equal(undefined);
			expect(chan.findUser("caroline")!.modes).to.deep.equal(["+"]);
		});

		it("updates our own nick and tells the UI", function () {
			const h = setup();
			joined(h);
			h.transport.line(":alice!alice@host NICK :alicia");

			expect(h.client.nick).to.equal("alicia");
			expect(payloads("nick").slice(-1)).to.deep.equal([
				{network: h.client.uuid, nick: "alicia"},
			]);
			expect(messages(1).some((m) => m.text === "You're now known as alicia")).to.equal(true);
			expect(h.client.isSelf("ALICIA")).to.equal(true);
		});
	});

	describe("reconnect", function () {
		it("reports a connection that never opened as 'could not connect', hint once", function () {
			const h = setup();
			h.client.connect();
			h.transport.closed(1006, "", true);

			const first = messages(1);
			expect(
				first.some(
					(m) =>
						m.type === MessageType.ERROR &&
						m.text === "Could not connect to wss://irc.test:8443/."
				)
			).to.equal(true);
			expect(first.some((m) => /accept the warning/.test(m.text ?? ""))).to.equal(true);

			// The automatic retry fails too: headline again, but no second hint.
			h.transport.closed(1006, "", true);
			const hints = messages(1).filter((m) => /accept the warning/.test(m.text ?? ""));
			expect(hints).to.have.length(1);
		});

		it("announces the retry when its wait is over", function () {
			const h = setup();
			h.client.connect();
			h.transport.closed(1006, "", true);
			h.transport.retry(1);

			expect(lastMessage(1).text).to.equal("Connecting to irc.test:8443… (attempt 1)");
			expect(h.client.state).to.equal("connecting");
		});

		it("reports a drop before registration completed as such", function () {
			const h = setup();
			h.client.connect();
			h.transport.open();
			h.transport.closed(1006, "", false);

			expect(
				messages(1).some(
					(m) =>
						m.text ===
						"Connection to irc.test closed during IRC registration (connection lost). Not reconnecting."
				)
			).to.equal(true);
		});

		it("says when the retry is due (retryAt) and drops it once the dial starts", function () {
			// The transport's close carries the wait before its retry; the
			// UI counts it down (the strip above the input) and offers a
			// "Connect now". A dial in progress has no due time.
			const clock = sinon.useFakeTimers({now: 1_700_000_000_000, toFake: ["Date"]});

			try {
				const h = setup();
				joined(h);
				h.transport.closed(1006, "", true); // the fake retries 1000 ms later

				expect(payloads("network:status").slice(-1)).to.deep.equal([
					{
						network: h.client.uuid,
						connected: false,
						connecting: true,
						secure: true,
						retryAt: Date.now() + 1000,
					},
				]);
				expect(h.client.network.status.retryAt).to.equal(Date.now() + 1000);

				h.transport.retry(1);

				expect(payloads("network:status").slice(-1)).to.deep.equal([
					{network: h.client.uuid, connected: false, connecting: true, secure: true},
				]);
				expect(h.client.network.status).to.not.have.property("retryAt");

				// Registering again reports connected, without a due time.
				register(h);
				expect(payloads("network:status").slice(-1)).to.deep.equal([
					{network: h.client.uuid, connected: true, connecting: false, secure: true},
				]);
			} finally {
				clock.restore();
			}
		});

		it("marks everything parted on an unclean close and re-joins after re-registering", function () {
			const h = setup();
			const id = joined(h);
			h.transport.lines(
				":alice!alice@host JOIN #left",
				":alice!alice@host PART #left",
				":alice!alice@host JOIN #kept"
			);
			const kept = h.client.findChannel("#kept")!;
			h.transport.closed(1006, "", true);

			expect(payloads("network:status").slice(-1)[0]).to.include({
				network: h.client.uuid,
				connected: false,
				connecting: true,
				secure: true,
			});
			expect(h.client.isConnected).to.equal(false);
			expect(h.client.state).to.equal("connecting");
			expect(h.client.network.status.connecting).to.equal(true);
			expect(h.client.findChannel("#seance")!.state).to.equal(ChanState.PARTED);
			expect(h.client.findChannel("#seance")!.users.size).to.equal(0);
			expect(kept.state).to.equal(ChanState.PARTED);
			expect(payloads("connecting")).to.have.length(2);
			expect(messages(1).some((m) => m.type === MessageType.ERROR)).to.equal(true);
			expect(messages(1).some((m) => /^Reconnecting (in|now)/.test(m.text ?? ""))).to.equal(
				true
			);

			// The transport reconnects on its own; a new registration follows.
			h.sentAfter();
			h.transport.open();
			expect(h.sentAfter()).to.deep.equal([
				"CAP LS 302",
				"NICK alice",
				"USER alice 0 * :alice",
			]);
			h.transport.line(`:irc.test CAP * LS :${OFFERED_CAPS}`);
			const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
			h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
			h.transport.lines(":irc.test 001 alice :Welcome back", ":irc.test 422 alice :No MOTD");

			const sent = h.sentAfter();
			// One JOIN for the whole autojoin list.
			const joins = sent.filter((l) => l.startsWith("JOIN "));
			expect(joins).to.have.length(1);
			expect(joins[0].split(" ")[1].split(",")).to.have.members(["#seance", "#kept"]);
			expect(joins[0]).to.not.include("#left");
			expect(payloads("init")).to.have.length(2);
			const chans = payloads<{networks: SharedNetwork[]}>("init")[1].networks[0].channels;
			expect(chans.map((c) => c.name)).to.deep.equal(["SeanceDev", "#kept", "#seance"]);
			expect(chans[2].id).to.equal(id); // ids survive the reconnect
		});

		it("disconnect() while waiting to reconnect cancels the retry and settles the state", function () {
			const h = setup();
			joined(h);
			h.transport.closed(1006, "", true);
			expect(h.client.state).to.equal("connecting");
			expect(h.client.network.status).to.include({
				connected: false,
				connecting: true,
				secure: true,
			});
			expect(h.client.network.status.retryAt).to.be.a("number");

			h.client.disconnect();

			expect(h.transport.closeCalls).to.have.length(1);
			expect(h.client.state).to.equal("disconnected");
			expect(h.client.network.status).to.deep.equal({
				connected: false,
				connecting: false,
				secure: true,
			});
			expect(payloads("network:status").slice(-1)).to.deep.equal([
				{network: h.client.uuid, connected: false, connecting: false, secure: true},
			]);
			expect(lastMessage(1).text).to.equal("Reconnect cancelled.");

			// /connect brings it back with a fresh attempt.
			h.client.input(1, "/connect");
			expect(h.transport.connectCalls).to.equal(2);
			expect(h.client.network.status.connecting).to.equal(true);
		});

		it("reports an error instead of throwing on input while disconnected", function () {
			const h = setup();
			const id = joined(h);
			h.transport.closed(1006, "", true);
			h.sentAfter();
			h.client.input(id, "hello?");

			expect(h.sentAfter()).to.deep.equal([]);
			const msg = lastMessage(id);
			expect(msg.type).to.equal(MessageType.ERROR);
			expect(msg.text).to.match(/not connected/);
		});

		it("treats the close after our own QUIT as clean", function () {
			const h = setup();
			joined(h);
			h.sentAfter();
			h.client.disconnect("bye");

			expect(h.sentAfter()).to.deep.equal(["QUIT :bye"]);
			expect(h.transport.closeCalls).to.have.length(1);

			const errorsBefore = messages(1).filter((m) => m.type === MessageType.ERROR).length;
			h.transport.line("ERROR :Closing Link: alice by irc.test (Quit: bye)");
			h.transport.closed(1006, "", false);
			expect(messages(1).filter((m) => m.type === MessageType.ERROR)).to.have.length(
				errorsBefore
			);
			expect(payloads("network:status").slice(-1)[0].connected).to.equal(false);
			expect(h.client.state).to.equal("disconnected");
		});

		it("dispatches `quit` for /quit", function () {
			const h = setup();
			joined(h);
			h.sentAfter();
			h.client.input(1, "/quit see you");

			expect(payloads("quit")).to.deep.equal([{network: h.client.uuid}]);
			expect(h.sentAfter()).to.deep.equal(["QUIT :see you"]);
		});
	});

	describe("input", function () {
		it("sends plain text as PRIVMSG to the current channel", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "hello #seance");
			expect(h.sentAfter()).to.deep.equal(["@label=s1 PRIVMSG #seance :hello #seance"]);
		});

		it("refuses plain text in the lobby", function () {
			const h = setup();
			joined(h);
			h.client.input(1, "hello lobby");
			expect(h.sentAfter()).to.deep.equal([]);
			expect(lastMessage(1).type).to.equal(MessageType.ERROR);
			expect(lastMessage(1).text).to.equal("Messages can not be sent to lobbies.");
		});

		it("sends /me as a CTCP ACTION", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/me waves");
			expect(h.sentAfter()).to.deep.equal([
				"@label=s1 PRIVMSG #seance :\x01ACTION waves\x01",
			]);
		});

		it("treats // as an escaped slash", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "//not a command");
			expect(h.sentAfter()).to.deep.equal(["@label=s1 PRIVMSG #seance :/not a command"]);
		});

		it("sends every line of multi-line input separately", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "one\ntwo\r\n\nthree");
			expect(h.sentAfter()).to.deep.equal([
				"@label=s1 PRIVMSG #seance :one",
				"@label=s2 PRIVMSG #seance :two",
				"@label=s3 PRIVMSG #seance :three",
			]);
		});

		it("splits oversized messages into lines of at most 500 bytes", function () {
			const h = setup();
			const id = joined(h);
			const words = Array.from({length: 200}, (_, i) => `wörd${i}`).join(" ");
			h.client.input(id, words);

			const sent = h.sentAfter();
			expect(sent.length).to.be.greaterThan(1);
			// What the server relays: our source in front of the line, tags kept.
			const source = ":alice!alice@host.example ";

			for (const line of sent) {
				expect(line).to.match(/^@label=s\d+ PRIVMSG #seance :wörd\d+/);
				expect(utf8ByteLength(line) + source.length).to.be.at.most(500);
			}

			const joinedText = sent
				.map((l) => l.slice(l.indexOf("PRIVMSG #seance :") + "PRIVMSG #seance :".length))
				.join(" ");
			expect(joinedText).to.equal(words);
		});

		it("sends /raw verbatim and unknown commands as-is", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/raw WHOIS bob");
			h.client.input(id, "/quote  PING :x");
			h.client.input(id, "/frobnicate bob");
			expect(h.sentAfter()).to.deep.equal(["WHOIS bob", " PING :x", "frobnicate bob"]);
		});

		it("handles /join, /part, /topic and /nick", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/join #a,b key1");
			h.client.input(id, "/topic  spaced  out ");
			h.client.input(id, "/topic");
			h.client.input(id, "/cleartopic");
			h.client.input(id, "/nick bobby");
			h.client.input(id, "/part see ya");
			expect(h.sentAfter()).to.deep.equal([
				"JOIN #a,#b key1",
				"TOPIC #seance : spaced  out ",
				"TOPIC #seance",
				"TOPIC #seance :",
				"NICK bobby",
				"PART #seance :see ya",
			]);
		});

		it("closes queries and parted channels locally", function () {
			const h = setup();
			const id = joined(h);
			h.transport.line(":eve!eve@host PRIVMSG alice :hi");
			const query = h.client.findChannel("eve")!;
			h.client.input(query.id, "/close");
			expect(payloads("part")).to.deep.equal([{chan: query.id}]);
			expect(h.client.findChannel("eve")).to.equal(undefined);

			h.transport.line(":carol!carol@host KICK #seance alice");
			h.sentAfter();
			h.client.input(id, "/close");
			expect(h.sentAfter()).to.deep.equal([]);
			expect(payloads("part")).to.deep.equal([{chan: query.id}, {chan: id}]);
		});

		it("opens a query window with /query", function () {
			const h = setup();
			const id = joined(h);
			h.client.input(id, "/query eve");
			const [join] = payloads<{chan: SharedNetworkChan; shouldOpen: boolean}>("join");
			expect(join.chan.type).to.equal(ChanType.QUERY);
			expect(join.shouldOpen).to.equal(true);

			h.client.input(id, "/query #nochan");
			expect(payloads("join")).to.have.length(1);
			expect(lastMessage(id).type).to.equal(MessageType.ERROR);
			expect(lastMessage(id).text).to.match(/use \/join instead/);
		});
	});

	describe("bus handlers", function () {
		it("answers names, more, open and input emits for the owning client", function () {
			const h = setup();
			const id = joined(h);
			registerBusHandlers(socket, {
				clientForChannel: (chanId) => (h.client.channelById(chanId) ? h.client : undefined),
				clientForNetwork: (uuid) => (uuid === h.client.uuid ? h.client : undefined),
				allClients: () => [h.client],
				createNetwork: () => h.client,
				remove: () => undefined,
			});

			socket.emit("names", {target: id});
			const [names] = payloads<{id: number; users: {nick: string; mode: string}[]}>("names");
			expect(names.id).to.equal(id);
			expect(names.users.map((u) => u.nick)).to.deep.equal(["alice", "carol", "bob"]);
			expect(names.users[0]).to.include({mode: "@", away: "", lastMessage: 0});

			socket.emit("more", {target: id, lastId: -1, condensed: false});
			const [more] =
				payloads<{chan: number; messages: unknown[]; totalMessages: number}>("more");
			expect(more.chan).to.equal(id);
			expect(more.messages).to.deep.equal([]);
			expect(more.totalMessages).to.equal(
				h.client.findChannel("#seance")!.shared.totalMessages
			);

			socket.emit("more", {target: 999, lastId: -1, condensed: false});
			expect(payloads("more")).to.have.length(2);

			h.transport.line(":bob!bob@host PRIVMSG #seance :unread one");
			expect(h.client.findChannel("#seance")!.shared.unread).to.equal(1);
			socket.emit("open", id);
			expect(h.client.findChannel("#seance")!.shared.unread).to.equal(0);
			h.transport.line(":bob!bob@host PRIVMSG #seance :unread two");
			expect(h.client.findChannel("#seance")!.shared.unread).to.equal(0);

			socket.emit("input", {target: id, text: "via bus"});
			expect(h.transport.sent[h.transport.sent.length - 1]).to.equal(
				"@label=s1 PRIVMSG #seance :via bus"
			);

			// A notification's reply names the network and target, and the
			// message it answers (bus-contract §2.1).
			socket.emit("send", {
				network: h.client.uuid,
				target: "#seance",
				text: "from a notification",
				replyTo: "BjAAAaBjrep9",
			});
			expect(h.transport.sent[h.transport.sent.length - 1]).to.equal(
				"@+draft/reply=BjAAAaBjrep9;label=s2 PRIVMSG #seance :from a notification"
			);

			socket.emit("network:get", h.client.uuid);
			expect(payloads<{uuid: string; host: string}>("network:info")[0]).to.include({
				uuid: h.client.uuid,
				host: "irc.test",
			});
		});
	});

	describe("helpers", function () {
		it("builds WebSocket URLs from host, port and tls", function () {
			expect(buildUrl("irc.example.org", 8443, true)).to.equal("wss://irc.example.org:8443/");
			expect(buildUrl("irc.example.org/irc/ws", 8067, false)).to.equal(
				"ws://irc.example.org:8067/irc/ws"
			);
			expect(buildUrl("wss://irc.example.org/", 443, true)).to.equal(
				"wss://irc.example.org:443/"
			);
			expect(buildUrl("::1", 8443, true)).to.equal("wss://[::1]:8443/");
		});

		it("parses the join list with keys and missing prefixes", function () {
			expect(parseJoinList("#a key, b ,&c, #A")).to.deep.equal([
				{name: "#a", key: "key"},
				{name: "#b", key: ""},
				{name: "&c", key: ""},
			]);
			expect(parseJoinList("")).to.deep.equal([]);
		});
	});
});

describe("IrcClient channel order", function () {
	const data = new Map<string, string>();

	beforeEach(function () {
		data.clear();
		saved.useStorageBackend({
			get: (key) => data.get(key) ?? null,
			set: (key, value) => void data.set(key, value),
			remove: (key) => void data.delete(key),
		});
	});

	afterEach(function () {
		saved.useStorageBackend(null);
	});

	it("inserts alphabetically when nothing is remembered", function () {
		const {client} = setup({join: "#zeta,#alpha,#mid"});
		expect(client.channels.map((c) => c.name)).to.deep.equal([
			"irc.test",
			"#alpha",
			"#mid",
			"#zeta",
		]);
	});

	it("places channels in the remembered order, unknown names after, alphabetically", function () {
		saved.setChannelOrder("net-1", ["#zeta", "#Mid"]);
		const h = setup({uuid: "net-1", join: "#alpha,#mid,#zeta"});
		const {client, transport} = h;

		expect(client.channels.map((c) => c.name)).to.deep.equal([
			"irc.test",
			"#zeta",
			"#mid",
			"#alpha",
		]);

		// A JOIN nobody listed (a held session's restore) lands by the same rule.
		register(h);
		transport.line(":alice!a@h JOIN #beta");
		transport.line(":alice!a@h JOIN #aaa");

		expect(client.channels.map((c) => c.name).slice(1)).to.deep.equal([
			"#zeta",
			"#mid",
			"#aaa",
			"#alpha",
			"#beta",
		]);
	});
});
