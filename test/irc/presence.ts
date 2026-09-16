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

interface Harness {
	client: IrcClient;
	transport: FakeTransport;
	sent(): string[];
}

function connect(opts: {attended?: boolean} = {}): Harness {
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
	transport.line(`:irc.test CAP * LS :${CAPS}`);
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
		transport,
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

	it("a page hidden while it connects says AWAY * once registered", function () {
		const h = connect({attended: false});
		expect(h.transport.sent.filter((l) => l === `AWAY ${AWAY_STAR}`)).to.have.length(1);
		h.client.setAttended(true);
		expect(h.sent()).to.deep.equal(["AWAY"]);
	});

	it("marks nothing read while unattended, and the open channel when attention returns", function () {
		const h = connect();
		const chanId = joined(h);
		socket.emit("open", chanId);
		clock.tick(MARKREAD_DEBOUNCE_MS);
		h.sent(); // MODE + the marker for the JOIN row

		h.client.setAttended(false);
		expect(h.sent()).to.deep.equal([`AWAY ${AWAY_STAR}`]);
		live(h, 1);
		live(h, 2);
		clock.tick(MARKREAD_DEBOUNCE_MS * 2);
		expect(h.sent(), "a hidden page read nothing").to.deep.equal([]);

		h.client.setAttended(true);
		clock.tick(MARKREAD_DEBOUNCE_MS);
		expect(h.sent()).to.deep.equal([
			"AWAY",
			"MARKREAD #seance timestamp=2026-08-25T12:02:00.000Z",
		]);
	});

	it("shows another user's AWAY * as away without a reason", function () {
		const h = connect();
		joined(h);
		h.transport.line(":bob!bob@host AWAY :*");
		const chan = h.client.findChannel("#seance")!;
		expect(chan.findUser("bob")?.away, "the star is not a reason to display").to.equal("");
	});
});
