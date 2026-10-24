import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {SEANCE_CAPS} from "../../client/js/irc/caps";
import {MARKREAD_DEBOUNCE_MS} from "../../client/js/irc/handlers/markread";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import type {SharedMsg} from "../../shared/types/msg";
import type {InboxEntry} from "../../shared/types/mention";
import {NO_FAKE_LAG} from "../../client/js/irc/fakelag";

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

	/** The socket is lost; the transport will redial. */
	drop(): void {
		this.state = "closed";
		this.emit({type: "close", code: 1006, reason: "", wasClean: false, willReconnect: true});
	}

	line(line: string): void {
		this.emit({type: "line", line});
	}

	lines(...lines: string[]): void {
		lines.forEach((line) => this.line(line));
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

interface MarkreadPayload {
	chan: number;
	firstUnread: number;
	unread: number;
	highlight: number;
}

interface MsgPayload {
	chan: number;
	msg: SharedMsg;
	unread?: number;
	highlight?: number;
}

let dispatch: sinon.SinonSpy;
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

interface Harness {
	client: IrcClient;
	transport: FakeTransport;
	chan: () => number;
	/** Lines sent since the last call. */
	sent: () => string[];
}

const BASE_CAPS = "batch message-tags server-time echo-message extended-join draft/chathistory";

/** A registered client (not yet in any channel). */
function setup(opts: {readMarker?: boolean; account?: string} = {}): Harness {
	const transport = new FakeTransport();
	const client = new IrcClient({
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "#seance",
		sasl: "",
		saslAccount: opts.account ?? "",
		saslPassword: "",
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
		fakeLag: NO_FAKE_LAG,
	});
	let mark = 0;
	const caps = opts.readMarker === false ? BASE_CAPS : `${BASE_CAPS} draft/read-marker`;

	client.connect();
	transport.open();
	transport.line(`:irc.test CAP * LS :${caps}`);
	const req = transport.sent.find((l) => l.startsWith("CAP REQ :"));
	expect(req, "CAP REQ sent").to.be.a("string");
	transport.line(`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`);
	transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,l,imnpst CASEMAPPING=rfc1459 CHATHISTORY=100 MSGREFTYPES=timestamp,msgid :are supported by this server",
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

/** Server confirms our JOIN to #seance; returns the lines we sent in response. */
function join(h: Harness): string[] {
	h.transport.lines(
		"@time=2026-08-25T12:00:00.000Z;msgid=join-1 :alice!alice@host JOIN #seance alice :Alice",
		":irc.test 353 alice = #seance :@alice bob",
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	return h.sent();
}

/** Join, answer the automatic LATEST with nothing, and forget what was dispatched so far. */
function joined(h: Harness): number {
	const label = join(h)
		.find((l) => l.includes("CHATHISTORY"))
		?.match(/^@label=([^ ;]+)/)?.[1];
	h.transport.line(
		`${label ? `@label=${label} ` : ""}:irc.test BATCH +hist1 chathistory #seance`
	);
	h.transport.line(":irc.test BATCH -hist1");
	dispatch.resetHistory();
	h.sent();
	return h.chan();
}

/** A live PRIVMSG from bob at 12:MM (message ids are allocated in order). */
function live(h: Harness, minute: number, text = `message ${minute}`): number {
	const mm = String(minute).padStart(2, "0");
	h.transport.line(
		`@time=2026-08-25T12:${mm}:00.000Z;msgid=m${minute} :bob!bob@host PRIVMSG #seance :${text}`
	);
	const all = payloads<MsgPayload>("msg");
	return all[all.length - 1].msg.id;
}

function marker(h: Harness, stamp: string): void {
	h.transport.line(`:irc.test MARKREAD #seance ${stamp}`);
}

describe("Read markers (handlers/markread.ts)", function () {
	beforeEach(function () {
		installSpy();
		clock = sinon.useFakeTimers({
			now: new Date("2026-08-25T12:30:00.000Z"),
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
	});

	afterEach(function () {
		clock.restore();
		removeSpy();
	});

	it("requests draft/read-marker when the server offers it", function () {
		expect(SEANCE_CAPS.wanted).to.include("draft/read-marker");
		const h = setup();
		const req = h.transport.sent.find((l) => l.startsWith("CAP REQ :"))!;
		expect(req).to.include("draft/read-marker");
		expect(h.client.caps.hasCapability("draft/read-marker")).to.equal(true);
	});

	it("moves firstUnread to the last message at or before an inbound marker and recounts", function () {
		const h = setup();
		const chanId = joined(h);
		const chan = h.client.findChannel("#seance")!;
		const joinMsg = chan.shared.firstUnread; // our own JOIN line is the last one read
		live(h, 1);
		const m2 = live(h, 2);
		live(h, 3, "alice: ping");
		live(h, 4);
		expect(chan.shared.unread).to.equal(4);
		expect(chan.shared.highlight).to.equal(1);
		expect(chan.shared.firstUnread).to.equal(joinMsg);

		marker(h, "timestamp=2026-08-25T12:02:30.000Z");

		expect(chan.shared.firstUnread).to.equal(m2);
		expect(chan.shared.unread).to.equal(2);
		expect(chan.shared.highlight).to.equal(1);
		expect(chan.readMarker?.toISOString()).to.equal("2026-08-25T12:02:30.000Z");
		expect(payloads<MarkreadPayload>("markread")).to.deep.equal([
			{chan: chanId, firstUnread: m2, unread: 2, highlight: 1},
		]);
	});

	it("marks everything read when the marker is at or after the newest message", function () {
		const h = setup();
		const chanId = joined(h);
		const chan = h.client.findChannel("#seance")!;
		live(h, 1);
		live(h, 2, "alice: hi");
		const m3 = live(h, 3);

		marker(h, "timestamp=2026-08-25T12:03:00.000Z");

		expect(chan.shared.firstUnread).to.equal(m3);
		expect(chan.shared.unread).to.equal(0);
		expect(chan.shared.highlight).to.equal(0);
		expect(payloads<MarkreadPayload>("markread")).to.deep.equal([
			{chan: chanId, firstUnread: m3, unread: 0, highlight: 0},
		]);
	});

	it("ignores a marker older than everything shown, `timestamp=*` and `*`", function () {
		const h = setup();
		joined(h);
		const chan = h.client.findChannel("#seance")!;
		const before = chan.shared.firstUnread;
		live(h, 5);
		live(h, 6);

		marker(h, "timestamp=2026-08-25T11:00:00.000Z");
		marker(h, "timestamp=*");
		marker(h, "*");
		h.transport.line(":irc.test MARKREAD #seance");

		expect(chan.shared.firstUnread).to.equal(before);
		expect(chan.shared.unread).to.equal(2);
		expect(payloads("markread")).to.have.length(0);
	});

	it("never moves the marker backwards", function () {
		const h = setup();
		joined(h);
		const chan = h.client.findChannel("#seance")!;
		live(h, 1);
		live(h, 2);
		const m3 = live(h, 3);
		live(h, 4);

		marker(h, "timestamp=2026-08-25T12:03:00.000Z");
		expect(chan.shared.firstUnread).to.equal(m3);
		expect(chan.shared.unread).to.equal(1);
		dispatch.resetHistory();

		marker(h, "timestamp=2026-08-25T12:01:00.000Z");
		expect(chan.shared.firstUnread).to.equal(m3);
		expect(chan.shared.unread).to.equal(1);
		expect(payloads("markread")).to.have.length(0);

		// Our own message is read by definition; an older marker stays behind it.
		h.transport.line(
			"@time=2026-08-25T12:05:00.000Z;msgid=m5 :alice!alice@host PRIVMSG #seance :mine"
		);
		const mine = chan.shared.firstUnread;
		expect(mine).to.be.greaterThan(m3);
		marker(h, "timestamp=2026-08-25T12:04:00.000Z");
		expect(chan.shared.firstUnread).to.equal(mine);
	});

	it("sends MARKREAD with the newest message's time when the channel is opened, debounced", function () {
		const h = setup();
		const chanId = joined(h);
		live(h, 1);
		live(h, 2);

		socket.emit("open", chanId);
		socket.emit("open", chanId);
		// Opening also asks for the channel modes once (catchup.ts); not a marker.
		expect(h.sent()).to.deep.equal(["MODE #seance"]);

		clock.tick(MARKREAD_DEBOUNCE_MS - 1);
		expect(h.sent()).to.deep.equal([]);
		clock.tick(1);
		expect(h.sent()).to.deep.equal(["MARKREAD #seance timestamp=2026-08-25T12:02:00.000Z"]);

		// Nothing newer: the server's echo moves nothing, and opening again
		// sends nothing (each open only tells the page it is read).
		const told = payloads("markread").length;
		h.transport.line(":irc.test MARKREAD #seance timestamp=2026-08-25T12:02:00.000Z");
		expect(payloads("markread")).to.have.length(told);
		socket.emit("open", chanId);
		clock.tick(MARKREAD_DEBOUNCE_MS);
		expect(h.sent()).to.deep.equal([]);
		expect(payloads<{unread: number}>("markread").map((p) => p.unread)).to.deep.equal(
			Array(told + 1).fill(0)
		);
	});

	it("marks messages read as they arrive in the open channel, one send per second", function () {
		const h = setup();
		const chanId = joined(h);
		const chan = h.client.findChannel("#seance")!;
		socket.emit("open", chanId);
		clock.tick(MARKREAD_DEBOUNCE_MS);
		h.sent();

		live(h, 10);
		live(h, 11);
		expect(chan.shared.unread).to.equal(0);
		clock.tick(MARKREAD_DEBOUNCE_MS - 1);
		live(h, 12);
		clock.tick(1);
		expect(h.sent()).to.deep.equal(["MARKREAD #seance timestamp=2026-08-25T12:12:00.000Z"]);
	});

	describe("across a reconnect (nothing before 001: the server answers `451 Register first.`)", function () {
		/** Redial and negotiate caps, stopping short of 001. */
		function reopen(h: Harness): void {
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${BASE_CAPS} draft/read-marker`);
			const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop();
			h.transport.line(`:irc.test CAP alice ACK :${req!.slice("CAP REQ :".length)}`);
		}

		function welcome(h: Harness): void {
			h.transport.lines(
				":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
				":irc.test 422 alice :MOTD File is missing"
			);
		}

		const markreads = (lines: string[]) => lines.filter((l) => l.startsWith("MARKREAD"));

		it("holds a marker that comes due while registering and sends it once registered", function () {
			const h = setup();
			const chanId = joined(h);
			live(h, 1); // unread: the channel is not open

			h.transport.drop();
			reopen(h);
			h.sent();

			// The page comes back and shows the channel while the new
			// connection is still registering.
			socket.emit("open", chanId);
			clock.tick(MARKREAD_DEBOUNCE_MS);
			expect(markreads(h.sent())).to.deep.equal([]);

			welcome(h);
			expect(markreads(h.sent())).to.deep.equal([
				"MARKREAD #seance timestamp=2026-08-25T12:01:00.000Z",
			]);
			clock.tick(MARKREAD_DEBOUNCE_MS);
			expect(markreads(h.sent())).to.deep.equal([]);
		});

		it("sends a marker the lost socket was holding once registered again", function () {
			const h = setup();
			const chanId = joined(h);
			socket.emit("open", chanId);
			live(h, 2);
			h.sent();

			h.transport.drop(); // inside the debounce
			clock.tick(MARKREAD_DEBOUNCE_MS);
			reopen(h);
			expect(markreads(h.sent())).to.deep.equal([]);

			welcome(h);
			expect(markreads(h.sent())).to.deep.equal([
				"MARKREAD #seance timestamp=2026-08-25T12:02:00.000Z",
			]);
		});

		for (const account of ["alice", ""]) {
			it(`${account ? "asks" : "does not ask"} again after a reconnect for ${
				account ? "an account (read elsewhere meanwhile)" : "a guest"
			}`, function () {
				const h = setup({account});
				expect(join(h)).to.include("MARKREAD #seance");
				marker(h, "timestamp=*");

				h.transport.drop();
				reopen(h);
				welcome(h);
				// The server says nothing after the re-JOIN: an account's is asked.
				const out = [...h.sent(), ...join(h)];
				clock.tick(30_000);
				out.push(...h.sent());
				expect(markreads(out).includes("MARKREAD #seance")).to.equal(!!account);
			});
		}

		it("asks for no marker or history page before 001", function () {
			const h = setup();
			joined(h);
			h.transport.drop();
			reopen(h);
			h.sent();

			socket.emit("markread", {
				network: h.client.uuid,
				target: "#seance",
				time: "2026-08-25T12:02:00.000Z",
			});
			socket.emit("more", {target: h.chan(), lastId: -1});
			expect(h.sent().filter((l) => /MARKREAD|CHATHISTORY/.test(l))).to.deep.equal([]);
		});
	});

	it("sends a marker for our own messages but not for our JOIN", function () {
		const h = setup();
		join(h);
		clock.tick(MARKREAD_DEBOUNCE_MS * 2);
		expect(h.sent()).to.deep.equal([]);

		h.transport.line(
			"@time=2026-08-25T12:07:00.000Z;msgid=m7 :alice!alice@host PRIVMSG #seance :mine"
		);
		clock.tick(MARKREAD_DEBOUNCE_MS);
		expect(h.sent()).to.deep.equal(["MARKREAD #seance timestamp=2026-08-25T12:07:00.000Z"]);
	});

	it("does not count messages at or before a known marker as unread", function () {
		const h = setup();
		joined(h);
		const chan = h.client.findChannel("#seance")!;
		marker(h, "timestamp=2026-08-25T12:05:00.000Z");

		live(h, 4); // e.g. a reconnect catch-up, already read elsewhere
		live(h, 5);
		expect(chan.shared.unread).to.equal(0);
		live(h, 6);
		expect(chan.shared.unread).to.equal(1);
	});

	it("sends nothing when the server does not offer the cap", function () {
		const h = setup({readMarker: false});
		const chanId = joined(h);
		live(h, 1);
		socket.emit("open", chanId);
		clock.tick(MARKREAD_DEBOUNCE_MS * 2);
		expect(h.sent()).to.deep.equal(["MODE #seance"]);
		expect(h.transport.sent.some((l) => l.startsWith("MARKREAD"))).to.equal(false);
	});

	it("asks for the stored marker after our JOIN, before the history it counts", function () {
		const h = setup();
		const lines = join(h);
		const history = lines.findIndex((l) => l.includes("CHATHISTORY LATEST #seance"));
		const fetch = lines.indexOf("MARKREAD #seance");
		expect(fetch, "MARKREAD fetch").to.be.at.least(0);
		expect(history, "CHATHISTORY LATEST").to.be.greaterThan(fetch);

		const without = setup({readMarker: false});
		expect(join(without)).to.not.include("MARKREAD #seance");
	});

	it("asks once: an answer of `*` (no marker stored) is still an answer", function () {
		const h = setup();
		expect(join(h)).to.include("MARKREAD #seance");
		h.transport.line(":irc.test MARKREAD #seance timestamp=*");
		const chan = h.client.findChannel("#seance")!;
		expect(chan.markerAnswered).to.equal(true);

		// The same channel joined again on the next connection: not asked.
		h.transport.line(":alice!alice@host KICK #seance alice :bye");
		expect(join(h)).to.not.include("MARKREAD #seance");
	});

	describe("a marker asked for by the page (the `markread` emit — a notification's Mark read)", function () {
		it("sends MARKREAD for the target at the given time, at once", function () {
			const h = setup();
			const chanId = joined(h);
			live(h, 1);
			live(h, 2);

			socket.emit("markread", {
				network: h.client.uuid,
				target: "#seance",
				time: "2026-08-25T12:02:00.000Z",
			});
			expect(h.sent()).to.deep.equal(["MARKREAD #seance timestamp=2026-08-25T12:02:00.000Z"]);
			// …and the badge with it: the server's echo of the same marker
			// changes nothing, so it is applied here.
			const chan = h.client.findChannel("#seance")!;
			expect(chan.shared.unread).to.equal(0);
			expect(payloads<{chan: number; unread: number}>("markread").pop()).to.include({
				chan: chanId,
				unread: 0,
			});

			// The channel's marker moved with it: opening it has nothing newer to send.
			socket.emit("open", chanId);
			clock.tick(MARKREAD_DEBOUNCE_MS);
			expect(h.sent()).to.deep.equal(["MODE #seance"]);
		});

		it("marks a query read even when no window for it is open", function () {
			const h = setup();
			joined(h);

			socket.emit("markread", {
				network: h.client.uuid,
				target: "bob",
				time: "2026-08-25T12:02:00.000Z",
			});
			expect(h.sent()).to.deep.equal(["MARKREAD bob timestamp=2026-08-25T12:02:00.000Z"]);
		});

		it("sends nothing without the cap", function () {
			const h = setup({readMarker: false});
			joined(h);

			socket.emit("markread", {
				network: h.client.uuid,
				target: "#seance",
				time: "2026-08-25T12:02:00.000Z",
			});
			expect(h.sent()).to.deep.equal([]);
		});
	});
});

describe("The inbox's events (docs/projects/inbox.md)", function () {
	interface InboxRead {
		network: string;
		target: string;
		time: string;
	}

	const added = () => payloads<{entries: InboxEntry[]}>("inbox:add").flatMap((p) => p.entries);

	beforeEach(function () {
		installSpy();
		clock = sinon.useFakeTimers({
			now: new Date("2026-08-25T12:30:00.000Z"),
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
	});

	afterEach(function () {
		clock.restore();
		removeSpy();
	});

	it("adds an unread highlight as an entry by network, target and msgid, and nothing else", function () {
		const h = setup();
		joined(h);
		live(h, 1);
		live(h, 2, "alice: ping");

		expect(added()).to.deep.equal([
			{
				network: h.client.uuid,
				target: "#seance",
				msgid: "m2",
				time: "2026-08-25T12:02:00.000Z",
				type: "message",
				text: "alice: ping",
				from: added()[0].from,
			},
		]);
		expect(added()[0].from.nick).to.equal("bob");
	});

	it("adds no highlight in the conversation someone is looking at", function () {
		const h = setup();
		const chanId = joined(h);
		socket.emit("open", chanId);
		live(h, 1, "alice: ping");
		expect(added()).to.have.length(0);
	});

	it("adds no highlight already read on another session", function () {
		const h = setup();
		joined(h);
		marker(h, "timestamp=2026-08-25T12:05:00.000Z");
		live(h, 4, "alice: old news"); // e.g. a catch-up line
		expect(added()).to.have.length(0);
		live(h, 6, "alice: new");
		expect(added().map((e) => e.msgid)).to.deep.equal(["m6"]);
	});

	it("adds a query line, and nothing from the lobby, which no read point clears", function () {
		const h = setup();
		joined(h);
		h.transport.line(
			"@time=2026-08-25T12:10:00.000Z;msgid=q1 :carol!carol@host PRIVMSG alice :hello there"
		);
		h.transport.line(
			"@time=2026-08-25T12:11:00.000Z;msgid=n1 :dave!dave@host NOTICE alice :alice: a notice"
		);

		const lobbyLine = payloads<MsgPayload>("msg").find((p) => p.msg.msgid === "n1");
		expect(lobbyLine?.chan, "the notice landed in the lobby").to.equal(h.client.lobby.id);
		expect(lobbyLine?.msg.highlight, "and highlights").to.equal(true);
		expect(added().map((e) => [e.target, e.msgid])).to.deep.equal([["carol", "q1"]]);
	});

	it("says how far a conversation is read, whoever read it", function () {
		const h = setup();
		const chanId = joined(h);
		live(h, 1, "alice: ping");

		marker(h, "timestamp=2026-08-25T12:00:30.000Z"); // another session
		live(h, 2);
		socket.emit("open", chanId); // this device: read to the newest line

		expect(payloads<InboxRead>("inbox:read")).to.deep.equal([
			{network: h.client.uuid, target: "#seance", time: "2026-08-25T12:00:30.000Z"},
			{network: h.client.uuid, target: "#seance", time: "2026-08-25T12:02:00.000Z"},
		]);
	});

	it("adds the highlights past the marker in a history page, not the older ones", function () {
		const h = setup();
		const label = join(h)
			.find((l) => l.includes("CHATHISTORY"))
			?.match(/^@label=([^ ;]+)/)?.[1];
		marker(h, "timestamp=2026-08-25T11:30:00.000Z");
		h.transport.lines(
			`${label ? `@label=${label} ` : ""}:irc.test BATCH +hist1 chathistory #seance`,
			"@batch=hist1;time=2026-08-25T11:00:00.000Z;msgid=h1 :bob!bob@host PRIVMSG #seance :alice: read already",
			"@batch=hist1;time=2026-08-25T11:45:00.000Z;msgid=h2 :bob!bob@host PRIVMSG #seance :nothing to see",
			"@batch=hist1;time=2026-08-25T11:50:00.000Z;msgid=h3 :bob!bob@host PRIVMSG #seance :alice: unread",
			":irc.test BATCH -hist1"
		);

		expect(added().map((e) => e.msgid)).to.deep.equal(["h3"]);
	});

	it("marks a query's entry as one for the whole conversation", function () {
		const h = setup();
		joined(h);
		h.transport.line(
			"@time=2026-08-25T12:10:00.000Z;msgid=q1 :carol!carol@host PRIVMSG alice :hello there"
		);
		h.transport.line(
			"@time=2026-08-25T12:10:00.000Z;msgid=q2 :carol!carol@host PRIVMSG alice :still there?"
		);
		expect(added().map((e) => [e.msgid, e.query])).to.deep.equal([
			["q1", true],
			["q2", true],
		]);
		live(h, 11, "alice: in a channel");
		expect(added()[2]).to.not.have.property("query");
	});

	it("cuts a long line to just before the mention", function () {
		const h = setup();
		joined(h);
		const lead = "lorem ipsum dolor sit amet ".repeat(5);
		live(h, 1, `${lead}so what do you think, alice?`);
		const text = added()[0].text;
		expect(text.startsWith("…"), text).to.equal(true);
		expect(text.endsWith("so what do you think, alice?")).to.equal(true);
		expect(text.length).to.be.lessThan(70);
	});

	it("reports a deleted message's msgid, loaded or not", function () {
		const h = setup();
		joined(h);
		h.transport.line(":bob!bob@host REDACT #seance never-loaded");
		expect(payloads("inbox:drop")).to.deep.equal([
			{network: h.client.uuid, target: "#seance", msgid: "never-loaded"},
		]);
	});

	it("reports an edit's original with the editor, for the inbox to check", function () {
		const h = setup();
		joined(h);
		h.transport.line(
			"@time=2026-08-25T12:10:00.000Z;msgid=e1;+seance/edit=gone :bob!bob@host PRIVMSG #seance :fixed"
		);
		expect(payloads("inbox:drop")).to.deep.equal([
			{network: h.client.uuid, target: "#seance", msgid: "gone", by: "bob"},
		]);
	});

	it("a marker that arrives after a highlight it covers reports the read point past it", function () {
		const h = setup();
		joined(h);
		live(h, 3, "alice: caught up before the marker came");
		expect(added().map((e) => e.msgid)).to.deep.equal(["m3"]);

		marker(h, "timestamp=2026-08-25T12:03:00.000Z");
		const read = payloads<InboxRead>("inbox:read");
		expect(read[read.length - 1].time).to.equal("2026-08-25T12:03:00.000Z");
	});
});
