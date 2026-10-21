/**
 * Attention → `AWAY *` (client/js/irc/presence.ts).
 *
 * A hidden page tells the server it is unattended with `AWAY *`
 * (`draft/pre-away`: away for an unspecified reason, per connection), a
 * page that comes back sends `AWAY`; a `/away` the user set is left alone;
 * an unattended page marks nothing read, and the return of attention
 * marks the open channel read.
 */

import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {dispatchInput} from "../../client/js/irc/commands";
import {MARKREAD_DEBOUNCE_MS} from "../../client/js/irc/handlers/markread";
import {AWAY_STAR} from "../../client/js/irc/presence";
import {MessageType} from "../../shared/types/msg";
import {effectiveMode, type GlobalMode, type NetworkMode} from "../../client/js/helpers/dnd";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";

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

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

const CAPS = "server-time message-tags batch labeled-response draft/read-marker";

/** Enough for the fake-lag clock to make room for a background line. */
const FAKE_LAG_ROOM_MS = 10_000;

interface Harness {
	client: IrcClient;
	transport: FakeTransport;
	dispatch: sinon.SinonSpy;
	sent(): string[];
	dispatch: sinon.SinonSpy;
}

/** `preAway` (default on): the server offers `draft/pre-away`, as nefarious2 does. */
function connect(opts: {attended?: boolean; preAway?: boolean} = {}): Harness {
	const transport = new FakeTransport();
	const dispatch = sinon.spy();
	const client = new IrcClient({
		bus: {dispatch},
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "#seance",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		uuid: "presence-net",
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
	});
	let mark = 0;

	if (opts.attended === false) {
		client.setAttended(false); // hidden before it connected: nothing can be sent yet
	}

	client.connect();
	transport.open();
	transport.line(`:irc.test CAP * LS :${CAPS}${opts.preAway === false ? "" : " draft/pre-away"}`);
	const req = transport.sent.find((l) => l.startsWith("CAP REQ :"));
	expect(req, "CAP REQ sent").to.be.a("string");
	transport.line(`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`);
	transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,l,imnpst CASEMAPPING=rfc1459 :are supported by this server",
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
		dispatch,
		transport,
		dispatch,
		sent() {
			const result = transport.sent.slice(mark);
			mark = transport.sent.length;
			return result;
		},
	};
}

/** JOIN #seance confirmed; the automatic history request answered empty. */
function joined(h: Harness): number {
	h.transport.lines(
		"@time=2026-08-25T12:00:00.000Z;msgid=join-1 :alice!alice@host JOIN #seance alice :Alice",
		":irc.test 353 alice = #seance :@alice bob",
		":irc.test 366 alice #seance :End of /NAMES list."
	);
	const label = h
		.sent()
		.find((l) => l.includes("CHATHISTORY"))
		?.match(/^@label=([^ ;]+)/)?.[1];
	h.transport.line(
		`${label ? `@label=${label} ` : ""}:irc.test BATCH +hist1 chathistory #seance`
	);
	h.transport.line(":irc.test BATCH -hist1");
	h.sent();
	return h.client.findChannel("#seance")!.id;
}

function live(h: Harness, minute: number): void {
	const mm = String(minute).padStart(2, "0");
	h.transport.line(
		`@time=2026-08-25T12:${mm}:00.000Z;msgid=m${minute} :bob!bob@host PRIVMSG #seance :message ${minute}`
	);
}

describe("attention and AWAY * (presence.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({
			now: new Date("2026-08-25T12:10:00.000Z"),
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
	});

	afterEach(function () {
		clock.restore();
		sinon.restore();
		socket.removeAllListeners();
	});

	it("says AWAY * when the page is hidden and AWAY when it comes back", function () {
		const h = connect();
		h.client.setAttended(false);
		expect(h.sent()).to.deep.equal([`AWAY ${AWAY_STAR}`]);
		h.client.setAttended(false); // no repeat
		expect(h.sent()).to.deep.equal([]);
		h.client.setAttended(true);
		expect(h.sent()).to.deep.equal(["AWAY"]);
		h.client.setAttended(true);
		expect(h.sent()).to.deep.equal([]);
	});

	it("leaves a /away the user set alone, and clears nothing it did not set", function () {
		const h = connect();
		dispatchInput(h.client, h.client.lobby, "/away lunch");
		expect(h.sent()).to.deep.equal(["AWAY :lunch"]);
		h.client.setAttended(false);
		expect(h.sent(), "the user's away stands").to.deep.equal([]);
		h.client.setAttended(true);
		expect(h.sent(), "and is not cleared by attention").to.deep.equal([]);
		dispatchInput(h.client, h.client.lobby, "/back");
		expect(h.sent()).to.deep.equal(["AWAY"]);
		h.client.setAttended(false);
		expect(h.sent(), "automatic again after /back").to.deep.equal([`AWAY ${AWAY_STAR}`]);
	});

	it("a page hidden while it connects declares AWAY * and says it once more registered", function () {
		// Before CAP END (draft/pre-away), then the repeat after registration
		// (nefarious2 resets the declared state, presence.ts presenceRegistered).
		const h = connect({attended: false});
		expect(h.transport.sent.filter((l) => l === `AWAY ${AWAY_STAR}`)).to.have.length(2);
		h.client.setAttended(true);
		expect(h.sent()).to.deep.equal(["AWAY"]);
	});

	it("marks nothing read while unattended, and the open channel when attention returns", function () {
		const h = connect();
		const chanId = joined(h);
		socket.emit("open", chanId);
		clock.tick(MARKREAD_DEBOUNCE_MS + FAKE_LAG_ROOM_MS);
		h.sent(); // MODE + the marker for the JOIN row

		h.client.setAttended(false);
		expect(h.sent()).to.deep.equal([`AWAY ${AWAY_STAR}`]);
		live(h, 1);
		live(h, 2);
		clock.tick(MARKREAD_DEBOUNCE_MS * 2);
		expect(h.sent(), "a hidden page read nothing").to.deep.equal([]);
		const chan = h.client.channelById(chanId)!;
		expect(chan.shared.unread, "counted while nobody looked").to.equal(2);

		h.client.setAttended(true);
		expect(chan.shared.unread, "read by looking, as opening it would").to.equal(0);
		// …and the page is told: it shows the open conversation's count
		// (the app badge) while nobody looks.
		const told = h.dispatch.getCalls().filter((c) => c.args[0] === "markread");
		expect(told.pop()?.args[1]).to.include({chan: chanId, unread: 0, highlight: 0});
		// The marker is background work: it waits for room on the fake-lag
		// clock the AWAY lines just spent (fakelag.ts).
		clock.tick(MARKREAD_DEBOUNCE_MS + FAKE_LAG_ROOM_MS);
		expect(h.sent()).to.deep.equal([
			"AWAY",
			"MARKREAD #seance timestamp=2026-08-25T12:02:00.000Z",
		]);
	});

	it("opening a channel someone is looking at tells the page it is read", function () {
		const h = connect();
		const chanId = joined(h);
		clock.tick(MARKREAD_DEBOUNCE_MS);
		live(h, 1);
		h.sent();

		socket.emit("open", chanId);
		const told = h.dispatch.getCalls().filter((c) => c.args[0] === "markread");
		// Counters only: the page keeps its new-messages line where it is.
		expect(told.pop()?.args[1]).to.deep.equal({
			chan: chanId,
			firstUnread: 0,
			unread: 0,
			highlight: 0,
		});
		clock.tick(MARKREAD_DEBOUNCE_MS);
		expect(h.sent()).to.include("MARKREAD #seance timestamp=2026-08-25T12:01:00.000Z");
	});

	it("opening a channel nobody is looking at reads nothing until attention returns", function () {
		const h = connect();
		const chanId = joined(h);
		clock.tick(MARKREAD_DEBOUNCE_MS);
		live(h, 1);
		live(h, 2);
		const chan = h.client.channelById(chanId)!;
		h.client.setAttended(false);
		h.sent();

		// A hidden page lands on it (a cold start, a deep link): not read yet,
		// and the page is not told otherwise (it shows the IRC layer's count).
		const told = () => h.dispatch.getCalls().filter((c) => c.args[0] === "markread");
		const before = told().length;
		socket.emit("open", chanId);
		clock.tick(MARKREAD_DEBOUNCE_MS);
		expect(chan.shared.unread).to.equal(2);
		expect(told()).to.have.length(before);
		expect(h.sent().filter((l) => l.startsWith("MARKREAD"))).to.deep.equal([]);

		h.client.setAttended(true);
		clock.tick(MARKREAD_DEBOUNCE_MS + FAKE_LAG_ROOM_MS);
		expect(chan.shared.unread).to.equal(0);
		expect(h.sent()).to.include("MARKREAD #seance timestamp=2026-08-25T12:02:00.000Z");
	});

	it("prints nothing for the replies to its own AWAY * and AWAY, but still for the user's", function () {
		const h = connect();
		const lobby = h.client.lobby;
		const before = lobby.shared.totalMessages;

		h.client.setAttended(false);
		h.sent();
		h.transport.line(":irc.seance.test 306 alice :You have been marked as being away");
		expect(lobby.shared.totalMessages, "306 for AWAY * is noise").to.equal(before);

		h.client.setAttended(true);
		h.sent();
		h.transport.line(":irc.seance.test 305 alice :You are no longer marked as being away");
		expect(lobby.shared.totalMessages, "305 for the automatic AWAY is noise").to.equal(before);

		// The self away-notify echo of a star (another connection of the
		// account) is the same signal: silent.
		h.transport.line(":alice!alice@host AWAY :*");
		expect(lobby.shared.totalMessages).to.equal(before);

		dispatchInput(h.client, h.client.lobby, "/away lunch");
		h.sent();
		h.transport.line(":irc.seance.test 306 alice :You have been marked as being away");
		expect(lobby.shared.totalMessages, "the user's own /away is acknowledged").to.equal(
			before + 1
		);
	});

	it("shows another user's AWAY * as away without a reason, and says nothing about it", function () {
		const h = connect();
		joined(h);
		h.transport.line(":bob!bob@host PRIVMSG alice :hi");
		const query = h.client.findChannel("bob")!;
		const before = query.shared.totalMessages;
		h.transport.line(":bob!bob@host AWAY :*");
		const chan = h.client.findChannel("#seance")!;
		// The marker itself: away with no reason, which is not present ("").
		expect(chan.findUser("bob")?.away, "away, the star kept as its marker").to.equal("*");
		expect(query.shared.totalMessages, "a star is not news in the query").to.equal(before);
		h.transport.line(":bob!bob@host AWAY :lunch");
		expect(query.shared.totalMessages, "a real away is").to.equal(before + 1);
	});
});

describe("presence modes and do not disturb (presence.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({
			now: new Date("2026-08-25T12:10:00.000Z"),
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
	});

	afterEach(function () {
		clock.restore();
		socket.removeAllListeners();
	});

	// Every mode × attention × the page's DND, on the wire: the last AWAY
	// line says what the server shows. (A visible but unfocused page is
	// unattended too: foreground.ts calls setAttended(false) after
	// UNFOCUSED_AWAY_MS, the same call as a hidden page.)
	for (const mode of ["online", "auto", "away", "dnd"] as const) {
		for (const attended of [true, false]) {
			for (const dnd of [false, true]) {
				const star =
					dnd || mode === "dnd" || mode === "away" || (mode === "auto" && !attended);
				it(`${mode}, ${attended ? "attended" : "unattended"}, page DND ${
					dnd ? "on" : "off"
				}: ${star ? "AWAY *" : "present"}`, function () {
					const h = connect();
					h.client.setPresenceMode(mode);
					h.client.setAttended(attended);
					h.client.setGlobalDnd(dnd, null);
					const aways = h.transport.sent.filter(
						(l) => l === "AWAY" || l === `AWAY ${AWAY_STAR}`
					);
					const last = aways[aways.length - 1];
					expect(last ?? "AWAY").to.equal(star ? `AWAY ${AWAY_STAR}` : "AWAY");
					expect(h.client.presence.starSent).to.equal(star);
					expect(h.client.presenceSnapshot()).to.deep.equal({
						mode,
						effective: mode,
						dnd: dnd || mode === "dnd",
						away: star,
					});
				});
			}
		}
	}

	it("a network on Same as global follows the global mode; its own mode ignores it", function () {
		const cases: [NetworkMode, GlobalMode, boolean, string][] = [
			["global", "online", false, "present"],
			["global", "auto", true, "present"],
			["global", "auto", false, "AWAY *"],
			["global", "away", true, "AWAY *"],
			["online", "away", true, "present"],
			["away", "online", true, "AWAY *"],
		];

		for (const [own, global, attended, want] of cases) {
			const h = connect();
			h.client.setGlobalMode({value: global, at: 1});
			h.client.setPresenceMode(own);
			h.client.setAttended(attended);
			const aways = h.transport.sent.filter((l) => l === "AWAY" || l === "AWAY *");
			const label = `${own} under global ${global}, ${attended ? "attended" : "unattended"}`;
			expect(aways.at(-1) ?? "AWAY", label).to.equal(want === "present" ? "AWAY" : "AWAY *");
			expect(h.client.presenceSnapshot().effective, label).to.equal(
				effectiveMode(own, global)
			);
		}
	});

	describe("without draft/pre-away (a standard server, docs/projects/do-not-disturb.md)", function () {
		// There `AWAY *` is a literal away message "*", and every tab switch
		// on Auto would be broadcast to the channel as away and back.
		const aways = (h: Harness) => h.sent().filter((l) => l.startsWith("AWAY"));

		it("Auto sends nothing when the page goes unattended or comes back", function () {
			const h = connect({preAway: false});
			h.sent();
			h.client.setAttended(false);
			expect(aways(h)).to.deep.equal([]);
			h.client.setAttended(true);
			expect(aways(h)).to.deep.equal([]);
			expect(h.client.presenceSnapshot().away).to.equal(false);
		});

		it("Away and do not disturb send a real away message, and back sends AWAY", function () {
			const h = connect({preAway: false});
			h.sent();
			h.client.setPresenceMode("away");
			expect(aways(h)).to.deep.equal(["AWAY :Away"]);
			h.client.setPresenceMode("online");
			expect(aways(h)).to.deep.equal(["AWAY"]);
			h.client.setGlobalDnd(true, null);
			expect(aways(h)).to.deep.equal(["AWAY :Away"]);
			h.client.setGlobalDnd(false, null);
			// The global mode reaches a network following it.
			h.client.setPresenceMode("global");
			h.client.setGlobalMode({value: "away", at: 1});
			expect(aways(h)).to.deep.equal(["AWAY", "AWAY :Away"]);
		});

		it("/back under do not disturb says the real message too", function () {
			const h = connect({preAway: false});
			h.client.setGlobalDnd(true, null);
			dispatchInput(h.client, h.client.lobby, "/away lunch");
			h.sent();
			dispatchInput(h.client, h.client.lobby, "/back");
			expect(aways(h)).to.deep.equal(["AWAY :Away"]);
		});

		it("with draft/pre-away an unattended Auto page still says AWAY *", function () {
			const h = connect();
			h.sent();
			h.client.setAttended(false);
			expect(aways(h)).to.deep.equal(["AWAY *"]);
		});
	});

	it("online never sends AWAY *, even hidden", function () {
		const h = connect();
		h.client.setPresenceMode("online");
		h.client.setAttended(false);
		expect(h.sent()).to.deep.equal([]);
	});

	it("away sends AWAY * at once and keeps it when attention returns", function () {
		const h = connect();
		h.client.setPresenceMode("away");
		expect(h.sent()).to.deep.equal([`AWAY ${AWAY_STAR}`]);
		h.client.setAttended(false);
		h.client.setAttended(true);
		expect(h.sent()).to.deep.equal([]);
	});

	it("a mode change on a hidden page takes effect straight away", function () {
		const h = connect();
		h.client.setPresenceMode("online");
		h.client.setAttended(false);
		h.sent();
		h.client.setPresenceMode("auto");
		expect(h.sent()).to.deep.equal([`AWAY ${AWAY_STAR}`]);
		h.client.setPresenceMode("online");
		expect(h.sent()).to.deep.equal(["AWAY"]);
	});

	it("global DND makes even an online network away", function () {
		const h = connect();
		h.client.setPresenceMode("online");
		h.client.setGlobalDnd(true, null);
		expect(h.sent()).to.deep.equal([`AWAY ${AWAY_STAR}`]);
		h.client.setGlobalDnd(false, null);
		expect(h.sent()).to.deep.equal(["AWAY"]);
	});

	it("/away wins over every mode", function () {
		const h = connect();
		dispatchInput(h.client, h.client.lobby, "/away lunch");
		h.sent();
		h.client.setPresenceMode("away");
		h.client.setGlobalDnd(true, null);
		expect(h.sent()).to.deep.equal([]);
	});

	it("reports its presence to the store", function () {
		const h = connect();
		h.dispatch.resetHistory();
		h.client.setPresenceMode("dnd");
		const call = h.dispatch.getCalls().find((c) => c.args[0] === "network:presence");
		expect(call?.args[1]).to.deep.equal({
			network: "presence-net",
			presence: {mode: "dnd", effective: "dnd", dnd: true, away: true},
		});
		expect(h.client.network.presence).to.deep.equal({
			mode: "dnd",
			effective: "dnd",
			dnd: true,
			away: true,
		});
	});

	it("sends nothing before registration, then the away once welcomed (no pre-away: a real message)", function () {
		const transport = new FakeTransport();
		const client = new IrcClient({
			bus: {dispatch: sinon.spy()},
			host: "irc.test",
			port: 8443,
			tls: true,
			nick: "carol",
			join: "",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			uuid: "presence-pre",
			ids: new IdAllocator(),
			transportFactory: () => transport,
			highlights: () => ({keywords: [], exceptions: []}),
		});
		client.connect();
		transport.open();
		client.setPresenceMode("away");
		client.setGlobalDnd(true, null);
		expect(transport.sent.filter((l) => l.startsWith("AWAY"))).to.deep.equal([]);
		transport.line(`:irc.test CAP * LS :${CAPS}`);
		const req = transport.sent.find((l) => l.startsWith("CAP REQ :")) as string;
		transport.line(`:irc.test CAP carol ACK :${req.slice("CAP REQ :".length)}`);
		transport.lines(
			":irc.test 001 carol :Welcome to the SeanceDev IRC Network, carol",
			":irc.test 005 carol CHANTYPES=#& PREFIX=(ov)@+ CASEMAPPING=rfc1459 :are supported by this server",
			":irc.test 422 carol :MOTD File is missing"
		);
		expect(transport.sent.filter((l) => l.startsWith("AWAY"))).to.deep.equal(["AWAY :Away"]);
	});

	it("an unchanged snapshot dispatches no second network:presence", function () {
		const h = connect();
		h.client.setPresenceMode("dnd");
		h.dispatch.resetHistory();
		h.client.setAttended(false);
		h.client.setGlobalDnd(true, null);
		expect(
			h.dispatch.getCalls().filter((c) => c.args[0] === "network:presence")
		).to.have.length(0);
	});

	it("a closed connection is no longer reported away", function () {
		const h = connect();
		h.client.setPresenceMode("away");
		h.dispatch.resetHistory();
		h.transport.state = "closed";
		(h.client as unknown as {onClose(c: number, r: string, w: boolean): void}).onClose(
			1006,
			"",
			true
		);
		expect(h.client.presence.starSent).to.equal(false);
		const call = h.dispatch.getCalls().find((c) => c.args[0] === "network:presence");
		expect(call?.args[1].presence.away).to.equal(false);
	});

	describe("/back", function () {
		it("in dnd mode sends only AWAY *, keeps the star, and shows the 306", function () {
			const h = connect();
			h.client.setPresenceMode("dnd");
			h.transport.line(":irc.test 306 alice :You have been marked as being away"); // ours, quiet
			dispatchInput(h.client, h.client.lobby, "/away lunch");
			h.sent();
			dispatchInput(h.client, h.client.lobby, "/back");
			expect(h.sent()).to.deep.equal([`AWAY ${AWAY_STAR}`]);
			expect(h.client.presence.starSent).to.equal(true);
			h.dispatch.resetHistory();
			h.transport.line(":irc.test 306 alice :You have been marked as being away");
			const shown = h.dispatch
				.getCalls()
				.filter((c) => c.args[0] === "msg")
				.map((c) => c.args[1] as {chan: number; msg: {type: string}});
			expect(shown.map((m) => [m.chan, m.msg.type])).to.deep.equal([
				[h.client.lobby.id, MessageType.AWAY],
			]);
		});

		it("on an attended auto page sends only AWAY", function () {
			const h = connect();
			dispatchInput(h.client, h.client.lobby, "/away lunch");
			h.sent();
			dispatchInput(h.client, h.client.lobby, "/back");
			expect(h.sent()).to.deep.equal(["AWAY"]);
			expect(h.client.presence.starSent).to.equal(false);
		});

		it("on a hidden auto page sends only AWAY *", function () {
			const h = connect();
			h.client.setAttended(false);
			dispatchInput(h.client, h.client.lobby, "/away x");
			h.sent();
			dispatchInput(h.client, h.client.lobby, "/back");
			expect(h.sent()).to.deep.equal([`AWAY ${AWAY_STAR}`]);
			expect(h.client.presence.starSent).to.equal(true);
		});
	});
});
