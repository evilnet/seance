import {expect} from "chai";
import sinon from "ts-sinon";
import {
	CONNECT_TIMEOUT_MS,
	WsTransport,
	TransportEvent,
	TransportOptions,
} from "../../client/js/irc/transport";

type Handler = (ev: unknown) => void;

/** Minimal in-memory stand-in for the browser WebSocket, driven by the tests. */
class FakeWebSocket {
	// `object[]` because eslint's core no-use-before-define rejects a self-typed static.
	static instances: object[] = [];
	static throwOnConstruct = false;

	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readyState = 0;
	protocol = "";
	binaryType = "blob";
	sent: string[] = [];
	closeCalls: {code: number; reason: string}[] = [];
	private handlers = new Map<string, Handler[]>();

	constructor(public url: string, public protocols?: string | string[]) {
		if (FakeWebSocket.throwOnConstruct) {
			throw new SyntaxError("bad url");
		}

		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, handler: Handler): void {
		this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
	}

	send(data: string): void {
		if (this.readyState !== this.OPEN) {
			throw new Error("InvalidStateError");
		}

		this.sent.push(data);
	}

	close(code = 1000, reason = ""): void {
		this.closeCalls.push({code, reason});
		this.readyState = this.CLOSING;
	}

	// --- test drivers ---
	open(protocol = "text.ircv3.net"): void {
		this.readyState = this.OPEN;
		this.protocol = protocol;
		this.dispatch("open", {});
	}

	message(data: string | ArrayBuffer): void {
		this.dispatch("message", {data});
	}

	closed(code: number, reason = "", wasClean = code === 1000): void {
		this.readyState = this.CLOSED;
		this.dispatch("close", {code, reason, wasClean});
	}

	error(message?: string): void {
		this.dispatch("error", {message});
	}

	private dispatch(type: string, ev: unknown): void {
		(this.handlers.get(type) ?? []).forEach((h) => h(ev));
	}
}

const WebSocketImpl = FakeWebSocket as unknown as typeof WebSocket;
const noReconnect = {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false};
const fastReconnect = {
	enabled: true,
	initialDelayMs: 100,
	maxDelayMs: 1000,
	factor: 2,
	jitter: false,
};
/** Open at least this long → the backoff resets (transport.ts STABLE_CONNECTION_MS). */
const STABLE_MS = 30_000;

function make(extra: Partial<TransportOptions> = {}): {t: WsTransport; events: TransportEvent[]} {
	const t = new WsTransport({url: "wss://example.test/", WebSocketImpl, ...extra});
	const events: TransportEvent[] = [];
	t.on((ev) => events.push(ev));
	return {t, events};
}

function last(): FakeWebSocket {
	return FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket;
}

function lines(events: TransportEvent[]): string[] {
	return events.filter((e) => e.type === "line").map((e) => (e as {line: string}).line);
}

describe("WsTransport", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		FakeWebSocket.instances = [];
		FakeWebSocket.throwOnConstruct = false;
		clock = sinon.useFakeTimers();
	});

	afterEach(function () {
		clock.restore();
	});

	describe("connect / open", function () {
		it("opens with the default subprotocol and reports it", function () {
			const {t, events} = make();
			expect(t.state).to.equal("closed");
			t.connect();
			expect(t.state).to.equal("connecting");
			expect(FakeWebSocket.instances).to.have.length(1);
			expect(last().url).to.equal("wss://example.test/");
			expect(last().protocols).to.deep.equal(["text.ircv3.net"]);
			expect(last().binaryType).to.equal("arraybuffer");
			last().open("text.ircv3.net");
			expect(t.state).to.equal("open");
			expect(events).to.deep.equal([{type: "open", subprotocol: "text.ircv3.net"}]);
		});

		it("passes custom subprotocols through", function () {
			const {t} = make({subprotocols: ["binary.ircv3.net", "text.ircv3.net"]});
			t.connect();
			expect(last().protocols).to.deep.equal(["binary.ircv3.net", "text.ircv3.net"]);
		});

		it("is a no-op while connecting or open", function () {
			const {t} = make();
			t.connect();
			t.connect();
			last().open();
			t.connect();
			expect(FakeWebSocket.instances).to.have.length(1);
		});

		it("falls back to globalThis.WebSocket when nothing is injected", function () {
			const original = globalThis.WebSocket;
			globalThis.WebSocket = WebSocketImpl;

			try {
				const t = new WsTransport({url: "wss://example.test/"});
				t.connect();
				expect(FakeWebSocket.instances).to.have.length(1);
			} finally {
				globalThis.WebSocket = original;
			}
		});

		it("treats a constructor exception as a failed open", function () {
			FakeWebSocket.throwOnConstruct = true;
			const {t, events} = make({reconnect: noReconnect});
			t.connect();
			expect(t.state).to.equal("closed");
			expect(events.map((e) => e.type)).to.deep.equal(["error", "close"]);
			expect(events[0]).to.deep.equal({type: "error", message: "bad url"});
		});
	});

	describe("inbound lines", function () {
		it("emits one line event per text frame", function () {
			const {t, events} = make();
			t.connect();
			last().open();
			last().message(":irc.test 001 me :Welcome");
			expect(lines(events)).to.deep.equal([":irc.test 001 me :Welcome"]);
		});

		it("strips trailing CR/LF and ignores empty frames", function () {
			const {t, events} = make();
			t.connect();
			last().open();
			last().message("NOTICE * :hi\r\n");
			last().message("NOTICE * :lf\n");
			last().message("");
			last().message("\r\n");
			expect(lines(events)).to.deep.equal(["NOTICE * :hi", "NOTICE * :lf"]);
		});

		it("splits frames that contain several lines", function () {
			const {t, events} = make();
			t.connect();
			last().open();
			last().message("A\r\nB\r\n\r\nC");
			expect(lines(events)).to.deep.equal(["A", "B", "C"]);
		});

		it("decodes binary frames as UTF-8", function () {
			const {t, events} = make();
			t.connect();
			last().open();
			last().message(new TextEncoder().encode("PRIVMSG #x :héllo\r\n").buffer);
			expect(lines(events)).to.deep.equal(["PRIVMSG #x :héllo"]);
		});
	});

	describe("PING", function () {
		it("answers PING with a trailing parameter and still surfaces the line", function () {
			const {t, events} = make();
			t.connect();
			last().open();
			last().message("PING :irc.seance.test");
			expect(last().sent).to.deep.equal(["PONG :irc.seance.test"]);
			expect(lines(events)).to.deep.equal(["PING :irc.seance.test"]);
		});

		it("answers PING with a bare parameter verbatim", function () {
			const {t} = make();
			t.connect();
			last().open();
			last().message("PING 1234567890");
			last().message("ping abc def");
			last().message(":irc.seance.test PING :token");
			last().message("PING");
			expect(last().sent).to.deep.equal([
				"PONG 1234567890",
				"PONG abc def",
				"PONG :token",
				"PONG",
			]);
		});

		it("does not interpret anything else", function () {
			const {t} = make();
			t.connect();
			last().open();
			last().message("PINGX :no");
			last().message(":nick!u@h PRIVMSG #c :PING :x");
			expect(last().sent).to.deep.equal([]);
		});
	});

	describe("send()", function () {
		it("sends the line as a single frame without CRLF", function () {
			const {t} = make();
			t.connect();
			last().open();
			t.send("NICK seance");
			expect(last().sent).to.deep.equal(["NICK seance"]);
		});

		it("throws Error when not open", function () {
			const {t} = make();
			expect(() => t.send("NICK x")).to.throw(Error, /not open/);
			t.connect();
			expect(() => t.send("NICK x")).to.throw(Error, /not open/);
		});

		it("rejects CR, LF and NUL with RangeError", function () {
			const {t} = make();
			t.connect();
			last().open();
			expect(() => t.send("NICK x\r\n")).to.throw(RangeError);
			expect(() => t.send("NICK\nx")).to.throw(RangeError);
			expect(() => t.send("NICK\0x")).to.throw(RangeError);
			expect(last().sent).to.deep.equal([]);
		});

		it("enforces maxLineBytes in UTF-8 bytes, not characters", function () {
			const {t} = make({maxLineBytes: 10});
			t.connect();
			last().open();
			t.send("ééééé"); // 5 chars, 10 bytes
			expect(() => t.send("éééééé")).to.throw(RangeError, /12 bytes/);
			expect(() => t.send("x".repeat(11))).to.throw(RangeError);
			expect(last().sent).to.deep.equal(["ééééé"]);
		});

		it("defaults maxLineBytes to 500", function () {
			const {t} = make();
			t.connect();
			last().open();
			t.send("x".repeat(500));
			expect(() => t.send("x".repeat(501))).to.throw(RangeError);
		});
	});

	describe("close()", function () {
		it("closes the socket and does not reconnect", function () {
			const {t, events} = make({reconnect: fastReconnect});
			t.connect();
			last().open();
			t.close(1000, "bye");
			expect(t.state).to.equal("closed");
			expect(last().closeCalls).to.deep.equal([{code: 1000, reason: "bye"}]);
			last().closed(1000, "bye");
			expect(events[events.length - 1]).to.deep.equal({
				type: "close",
				code: 1000,
				reason: "bye",
				wasClean: true,
				willReconnect: false,
				delayMs: undefined,
			});
			clock.tick(10_000);
			expect(FakeWebSocket.instances).to.have.length(1);
			expect(events.some((e) => e.type === "reconnecting")).to.equal(false);
		});

		it("does not reconnect even when the close is unclean (e.g. 1006 after QUIT)", function () {
			const {t, events} = make({reconnect: fastReconnect});
			t.connect();
			last().open();
			t.close();
			last().closed(1006, "", false);
			expect(t.state).to.equal("closed");
			expect(events[events.length - 1]).to.include({willReconnect: false});
			clock.tick(10_000);
			expect(FakeWebSocket.instances).to.have.length(1);
		});

		it("cancels a pending reconnect", function () {
			const {t} = make({reconnect: fastReconnect});
			t.connect();
			last().closed(1006, "", false);
			expect(t.state).to.equal("reconnect-wait");
			t.close();
			expect(t.state).to.equal("closed");
			clock.tick(10_000);
			expect(FakeWebSocket.instances).to.have.length(1);
		});

		it("does not schedule a retry when a close listener closes the transport", function () {
			const {t, events} = make({reconnect: fastReconnect});
			t.on((ev) => {
				if (ev.type === "close" && ev.willReconnect) {
					t.close();
				}
			});
			t.connect();
			last().closed(1006, "", false);
			expect(t.state).to.equal("closed");
			expect(events.some((e) => e.type === "reconnecting")).to.equal(false);
			clock.tick(10_000);
			expect(FakeWebSocket.instances).to.have.length(1);
		});
	});

	describe("probe()", function () {
		it("sends a PING and, without any inbound data for 10 s, drops the socket as lost", function () {
			const {t, events} = make({reconnect: fastReconnect});
			t.connect();
			const ws = last();
			ws.open();
			t.probe();
			expect(ws.sent).to.deep.equal(["PING :probe"]);
			t.probe(); // one at a time
			expect(ws.sent).to.have.length(1);

			clock.tick(9_999);
			expect(t.state).to.equal("open");
			clock.tick(1);
			expect(ws.closeCalls).to.have.length(1);
			expect(t.state).to.equal("reconnect-wait");
			expect(events[events.length - 2]).to.include({
				type: "close",
				code: 1006,
				reason: "no reply to PING",
				willReconnect: true,
			});

			// The dead socket's own close event, whenever it comes, is ignored.
			ws.closed(1006, "", false);
			expect(events.filter((e) => e.type === "close")).to.have.length(1);
			clock.tick(100);
			expect(t.state).to.equal("connecting");
			expect(FakeWebSocket.instances).to.have.length(2);
		});

		it("is satisfied by any inbound line, and is a no-op unless open", function () {
			const {t} = make({reconnect: fastReconnect});
			t.probe();
			expect(FakeWebSocket.instances).to.have.length(0);
			t.connect();
			const ws = last();
			ws.open();
			t.probe();
			clock.tick(5_000);
			ws.message(":irc.test PONG irc.test :probe");
			clock.tick(20_000);
			expect(t.state).to.equal("open");
			expect(ws.closeCalls).to.have.length(0);
		});
	});

	describe("reconnect", function () {
		it("schedules reconnects with exponential backoff capped at maxDelayMs", function () {
			const {t, events} = make({reconnect: fastReconnect});
			t.connect();
			const expected = [100, 200, 400, 800, 1000, 1000];

			expected.forEach((delayMs, i) => {
				expect(FakeWebSocket.instances).to.have.length(i + 1);
				last().closed(1006, "", false);
				expect(t.state).to.equal("reconnect-wait");
				const closeEv = events[events.length - 2];
				const reconnEv = events[events.length - 1];
				expect(closeEv).to.include({
					type: "close",
					code: 1006,
					willReconnect: true,
					delayMs,
				});
				expect(reconnEv).to.deep.equal({type: "reconnecting", attempt: i + 1, delayMs});
				clock.tick(delayMs - 1);
				expect(FakeWebSocket.instances).to.have.length(i + 1);
				clock.tick(1);
				expect(FakeWebSocket.instances).to.have.length(i + 2);
				expect(t.state).to.equal("connecting");
				// The dial itself is announced when the wait is over.
				expect(events[events.length - 1]).to.deep.equal({type: "retry", attempt: i + 1});
			});
		});

		it("applies jitter within [3/4 base, base]: a wait at the cap clears an ircu clone window", function () {
			// nefarious2's IPcheck refuses the fourth connection from an address
			// when each gap is 40 s or less, and a refusal renews the window; a
			// capped wait must therefore never drop under 45 s (of the 60 s cap).
			const delaysWith = (random: number): number[] => {
				const stub = sinon.stub(Math, "random").returns(random);

				try {
					const {t, events} = make({reconnect: {...fastReconnect, jitter: true}});
					const delays: number[] = [];
					t.connect();

					// Through the timer path, so the attempt counter keeps growing.
					for (let i = 0; i < 8; i++) {
						last().closed(1006, "", false);
						const ev = events[events.length - 1] as {
							type: "reconnecting";
							delayMs: number;
						};
						delays.push(ev.delayMs);
						clock.tick(ev.delayMs);
					}

					return delays;
				} finally {
					stub.restore();
				}
			};

			const floor = delaysWith(0);
			expect(floor[0]).to.equal(75);
			floor.slice(4).forEach((d) => expect(d).to.equal(750));

			const ceiling = delaysWith(0.999_999);
			expect(ceiling[0]).to.equal(100);
			ceiling.slice(4).forEach((d) => expect(d).to.equal(1000));
		});

		it("does not reconnect when disabled", function () {
			const {t, events} = make({reconnect: noReconnect});
			t.connect();
			last().closed(1006, "", false);
			expect(t.state).to.equal("closed");
			expect(events).to.deep.equal([
				{
					type: "close",
					code: 1006,
					reason: "",
					wasClean: false,
					willReconnect: false,
					delayMs: undefined,
				},
			]);
		});

		it("resets the backoff after a connection that stayed open >= 30 s", function () {
			const {t, events} = make({reconnect: fastReconnect});
			t.connect();
			last().closed(1006, "", false); // attempt 1 → 100
			clock.tick(100);
			last().closed(1006, "", false); // attempt 2 → 200
			clock.tick(200);
			last().closed(1006, "", false); // attempt 3 → 400
			clock.tick(400);

			last().open();
			clock.tick(29_000);
			last().closed(1006, "", false); // short-lived: attempt 4 → 800
			expect(events[events.length - 1]).to.deep.equal({
				type: "reconnecting",
				attempt: 4,
				delayMs: 800,
			});
			clock.tick(800);

			last().open();
			clock.tick(30_000);
			last().closed(1006, "", false); // long-lived: back to attempt 1, and at once
			expect(events[events.length - 1]).to.deep.equal({
				type: "reconnecting",
				attempt: 1,
				delayMs: 0,
			});
		});

		it("retries at once when a long-lived connection drops, then backs off", function () {
			const {t, events} = make({reconnect: fastReconnect});
			t.connect();
			last().open();
			clock.tick(STABLE_MS);
			last().closed(1006, "", false);

			// No wait: the phone came back and the user is looking at the screen.
			expect(events[events.length - 1]).to.deep.equal({
				type: "reconnecting",
				attempt: 1,
				delayMs: 0,
			});
			clock.tick(0);
			expect(FakeWebSocket.instances).to.have.length(2);
			expect(t.state).to.equal("connecting");

			// That retry failing is a real outage: the usual backoff from here.
			last().closed(1006, "", false);
			expect(events[events.length - 1]).to.deep.equal({
				type: "reconnecting",
				attempt: 2,
				delayMs: 200,
			});
		});

		it("cancelReconnect() stops the pending attempt", function () {
			const {t} = make({reconnect: fastReconnect});
			t.connect();
			last().closed(1006, "", false);
			t.cancelReconnect();
			expect(t.state).to.equal("closed");
			clock.tick(10_000);
			expect(FakeWebSocket.instances).to.have.length(1);
		});

		it("connect() during reconnect-wait retries immediately", function () {
			const {t} = make({reconnect: fastReconnect});
			t.connect();
			last().closed(1006, "", false);
			t.connect();
			expect(FakeWebSocket.instances).to.have.length(2);
			clock.tick(10_000);
			expect(FakeWebSocket.instances).to.have.length(2);
		});

		it("ignores events from a superseded socket", function () {
			const {t, events} = make({reconnect: fastReconnect});
			t.connect();
			const first = last();
			t.close();
			t.connect();
			first.closed(1000);
			first.message("PING :stale");
			expect(events.filter((e) => e.type === "close")).to.have.length(0);
			expect(lines(events)).to.deep.equal([]);
			expect(t.state).to.equal("connecting");
		});
	});

	describe("on()", function () {
		it("returns an unsubscribe function", function () {
			const t = new WsTransport({url: "wss://example.test/", WebSocketImpl});
			const seen: TransportEvent[] = [];
			const off = t.on((ev) => seen.push(ev));
			t.connect();
			last().open();
			off();
			last().message("PING :x");
			expect(seen).to.have.length(1);
		});

		it("surfaces socket errors", function () {
			const {t, events} = make();
			t.connect();
			last().error("boom");
			last().error();
			expect(events).to.deep.equal([
				{type: "error", message: "boom"},
				{type: "error", message: "WebSocket error"},
			]);
		});
	});
});

describe("WsTransport foreground recovery", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		FakeWebSocket.instances = [];
		FakeWebSocket.throwOnConstruct = false;
		clock = sinon.useFakeTimers();
	});

	afterEach(function () {
		clock.restore();
	});

	it("probe() takes a shorter deadline for the foreground poke", function () {
		const {t, events} = make({reconnect: noReconnect});
		t.connect();
		last().open();

		t.probe(4000);
		clock.tick(3999);
		expect(t.state).to.equal("open");

		clock.tick(1);
		expect(t.state).to.equal("closed");
		expect(events.at(-1)).to.include({type: "close", code: 1006, reason: "no reply to PING"});
	});

	it("abandons a dial that never opens and retries with the usual backoff", function () {
		const {t, events} = make({reconnect: fastReconnect});
		t.connect();
		const stuck = last();

		clock.tick(CONNECT_TIMEOUT_MS - 1);
		expect(t.state).to.equal("connecting");

		clock.tick(1);
		expect(stuck.closeCalls).to.have.lengthOf(1);
		expect(t.state).to.equal("reconnect-wait");
		expect(events.at(-2)).to.include({type: "close", reason: "connect timed out"});

		// A late open on the abandoned socket changes nothing.
		stuck.open();
		expect(t.state).to.equal("reconnect-wait");

		clock.tick(fastReconnect.initialDelayMs);
		expect(FakeWebSocket.instances).to.have.lengthOf(2);
		expect(t.state).to.equal("connecting");
	});

	it("reports how long the dial has been in flight", function () {
		const {t} = make({reconnect: noReconnect});
		expect(t.connectingForMs()).to.equal(0);

		t.connect();
		clock.tick(2500);
		expect(t.connectingForMs()).to.equal(2500);

		last().open();
		expect(t.connectingForMs()).to.equal(0);
	});

	it("redial() drops a stuck dial and starts a fresh one at once", function () {
		const {t} = make({reconnect: fastReconnect});
		t.connect();
		const stuck = last();
		clock.tick(5000);

		t.redial();

		expect(stuck.closeCalls).to.have.lengthOf(1);
		expect(FakeWebSocket.instances).to.have.lengthOf(2);
		expect(t.state).to.equal("connecting");
		expect(t.connectingForMs()).to.equal(0);

		// The abandoned socket's events are ignored; the new one's count.
		stuck.closed(1006);
		expect(t.state).to.equal("connecting");
		last().open();
		expect(t.state).to.equal("open");
	});

	it("redial() while waiting to reconnect just connects now", function () {
		const {t} = make({reconnect: fastReconnect});
		t.connect();
		last().open();
		last().closed(1006);
		expect(t.state).to.equal("reconnect-wait");

		t.redial();
		expect(t.state).to.equal("connecting");
		expect(FakeWebSocket.instances).to.have.lengthOf(2);
	});

	it("retries at once when the socket dies during a probe, even if young", function () {
		// The foreground poke probes before the OS delivers the close: the
		// close that follows is the answer, and the user is waiting.
		const {t, events} = make({reconnect: fastReconnect});
		t.connect();
		last().open();
		clock.tick(3000); // far from the 30 s stable mark

		t.probe(4000);
		last().closed(1006, "", false);

		expect(events[events.length - 1]).to.deep.equal({
			type: "reconnecting",
			attempt: 1,
			delayMs: 0,
		});
		clock.tick(0);
		expect(t.state).to.equal("connecting");
		expect(FakeWebSocket.instances).to.have.lengthOf(2);

		// A young connection lost with no probe in flight still backs off.
		last().open();
		clock.tick(3000);
		last().closed(1006, "", false);
		expect(events[events.length - 1]).to.include({type: "reconnecting", attempt: 2});
		expect((events[events.length - 1] as {delayMs: number}).delayMs).to.be.greaterThan(0);
	});
});

describe("WsTransport: a request to connect restarts the schedule", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		FakeWebSocket.instances = [];
		FakeWebSocket.throwOnConstruct = false;
		clock = sinon.useFakeTimers();
	});

	afterEach(function () {
		clock.restore();
	});

	/** Fail `n` dials in a row through the timer path; returns the last delay scheduled. */
	function failTimes(events: TransportEvent[], n: number): number {
		let delay = 0;

		for (let i = 0; i < n; i++) {
			last().closed(1006, "", false);
			delay = (events[events.length - 1] as {delayMs: number}).delayMs;

			if (i < n - 1) {
				clock.tick(delay);
			}
		}

		return delay;
	}

	it("connect() while waiting dials now and, if that fails, waits the first delay again", function () {
		// The foreground poke after a long absence: the retries that piled up
		// while the app was away must not make the user wait out the cap.
		const {t, events} = make({reconnect: fastReconnect});
		t.connect();
		expect(failTimes(events, 4)).to.equal(800);
		expect(t.state).to.equal("reconnect-wait");

		t.connect();
		expect(t.state).to.equal("connecting");
		expect(FakeWebSocket.instances).to.have.lengthOf(5);

		last().closed(1006, "", false);
		expect(events[events.length - 1]).to.deep.equal({
			type: "reconnecting",
			attempt: 1,
			delayMs: 100,
		});
	});

	it("redial() of a stuck dial restarts the schedule too", function () {
		const {t, events} = make({reconnect: fastReconnect});
		t.connect();
		clock.tick(failTimes(events, 3));
		expect(t.state).to.equal("connecting");
		clock.tick(5000);

		t.redial();
		last().closed(1006, "", false);
		expect(events[events.length - 1]).to.deep.equal({
			type: "reconnecting",
			attempt: 1,
			delayMs: 100,
		});
	});

	it("a socket lost during a probe retries at once whatever the attempt count", function () {
		// A phone whose connections are each shorter than the stable mark
		// never resets the counter by staying up; the poke's probe does.
		const {t, events} = make({reconnect: fastReconnect});
		t.connect();
		clock.tick(failTimes(events, 3));
		last().open();
		clock.tick(3000);

		t.probe(4000);
		last().closed(1006, "", false);
		expect(events[events.length - 1]).to.deep.equal({
			type: "reconnecting",
			attempt: 1,
			delayMs: 0,
		});

		// Only that first retry is immediate: the schedule then resumes from attempt 2.
		clock.tick(0);
		last().closed(1006, "", false);
		expect(events[events.length - 1]).to.deep.equal({
			type: "reconnecting",
			attempt: 2,
			delayMs: 200,
		});
	});
});

describe("WsTransport.abandon()", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		FakeWebSocket.instances = [];
		FakeWebSocket.throwOnConstruct = false;
		clock = sinon.useFakeTimers();
	});

	afterEach(function () {
		clock.restore();
	});

	it("drops an open socket and reconnects on the usual schedule", function () {
		const {t, events} = make({reconnect: fastReconnect});
		t.connect();
		const ws = last();
		ws.open();
		clock.tick(12_000);

		t.abandon("SASL timed out");

		expect(ws.closeCalls).to.have.lengthOf(1);
		expect(t.state).to.equal("reconnect-wait");
		expect(events[events.length - 2]).to.include({
			type: "close",
			code: 1006,
			reason: "SASL timed out",
			wasClean: false,
			willReconnect: true,
		});
		expect(events[events.length - 1]).to.deep.equal({
			type: "reconnecting",
			attempt: 1,
			delayMs: 100,
		});

		// The abandoned socket's late close changes nothing.
		ws.closed(1006);
		expect(t.state).to.equal("reconnect-wait");

		clock.tick(100);
		expect(FakeWebSocket.instances).to.have.lengthOf(2);
		expect(t.state).to.equal("connecting");
	});

	it("gives up a dial in flight the same way, and its connect timeout with it", function () {
		const {t, events} = make({reconnect: fastReconnect});
		t.connect();
		const stuck = last();
		clock.tick(2000);

		t.abandon("giving up");

		expect(stuck.closeCalls).to.have.lengthOf(1);
		expect(t.state).to.equal("reconnect-wait");
		expect(events[events.length - 2]).to.include({type: "close", reason: "giving up"});

		clock.tick(100); // the retry dials
		expect(FakeWebSocket.instances).to.have.lengthOf(2);

		// The abandoned dial's own timeout must not fire on the new socket.
		clock.tick(CONNECT_TIMEOUT_MS - 2100);
		expect(events.filter((e) => e.type === "close")).to.have.lengthOf(1);
		expect(t.state).to.equal("connecting");
	});

	it("is a no-op unless connecting or open", function () {
		const {t, events} = make({reconnect: fastReconnect});
		t.abandon("nothing to drop");
		expect(events).to.deep.equal([]);
		expect(t.state).to.equal("closed");

		t.connect();
		last().closed(1006, "", false);
		const before = events.length;
		t.abandon("already waiting");
		expect(events).to.have.lengthOf(before);
		expect(t.state).to.equal("reconnect-wait");
	});
});

describe("WsTransport: the dial gate (irc/dialLedger.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		FakeWebSocket.instances = [];
		FakeWebSocket.throwOnConstruct = false;
		clock = sinon.useFakeTimers();
	});

	afterEach(function () {
		clock.restore();
	});

	/** A gate closed until `until` (fake-clock ms), recording every dial. */
	function gate(until: number) {
		const g = {
			until,
			record: sinon.spy(),
			closed: sinon.spy(),
			waitMs: (now: number) => Math.max(0, g.until - now),
		};
		return g;
	}

	it("defers a connect the server would refuse", function () {
		const g = gate(30_000);
		const {t, events} = make({reconnect: fastReconnect, gate: g});
		t.connect();
		expect(FakeWebSocket.instances).to.have.length(0);
		expect(t.state).to.equal("reconnect-wait");
		expect(events[events.length - 1]).to.deep.equal({
			type: "reconnecting",
			attempt: 0,
			delayMs: 30_000,
			throttled: true,
		});
		clock.tick(29_999);
		expect(FakeWebSocket.instances).to.have.length(0);
		clock.tick(1);
		expect(FakeWebSocket.instances).to.have.length(1);
	});

	it("a connect() during the wait waits too", function () {
		const g = gate(30_000);
		const {t} = make({reconnect: fastReconnect, gate: g});
		t.connect();
		clock.tick(10_000);
		t.connect();
		expect(FakeWebSocket.instances).to.have.length(0);
		clock.tick(20_000);
		expect(FakeWebSocket.instances).to.have.length(1);
	});

	it("never retries earlier than the gate allows after a close", function () {
		const g = gate(0);
		const {t, events} = make({reconnect: fastReconnect, gate: g});
		t.connect();
		g.until = 20_000;
		last().closed(1006, "", false);
		expect(events[events.length - 2]).to.include({type: "close", delayMs: 20_000});
		expect(events[events.length - 1]).to.deep.equal({
			type: "reconnecting",
			attempt: 1,
			delayMs: 20_000,
			throttled: true,
		});
		clock.tick(19_999);
		expect(FakeWebSocket.instances).to.have.length(1);
		clock.tick(1);
		expect(FakeWebSocket.instances).to.have.length(2);
	});

	it("keeps the backoff when it is longer than the gate", function () {
		const g = gate(0);
		const {t, events} = make({reconnect: fastReconnect, gate: g});
		t.connect();
		g.until = 50;
		last().closed(1006, "", false);
		expect(events[events.length - 1]).to.deep.equal({
			type: "reconnecting",
			attempt: 1,
			delayMs: 100,
		});
	});

	it("records every dial it makes, refused ones included", function () {
		const g = gate(0);
		const {t} = make({reconnect: fastReconnect, gate: g});
		t.connect();
		last().closed(1006, "", false);
		clock.tick(100);
		expect(FakeWebSocket.instances).to.have.length(2);
		expect(g.record.args).to.deep.equal([[0], [100]]);
	});

	it("tells the gate when any dial ends: one that never opened counted at the accept", function () {
		const g = gate(0);
		const {t} = make({reconnect: fastReconnect, gate: g});
		t.connect();
		last().closed(1006, "", false); // refused before it opened
		expect(g.closed.args).to.deep.equal([[0]]);
		clock.tick(100);
		last().open();
		clock.tick(5_000);
		last().closed(1006, "", false);
		expect(g.closed.args).to.deep.equal([[0], [5_100]]);
	});

	it("tells the gate when a dial times out or is given up for a fresh one", function () {
		const g = gate(0);
		const {t} = make({gate: g});
		t.connect();
		clock.tick(CONNECT_TIMEOUT_MS); // TLS or the upgrade stalled
		expect(g.closed.args).to.deep.equal([[CONNECT_TIMEOUT_MS]]);
		t.connect();
		clock.tick(1_000);
		t.redial(); // the foreground poke drops the stuck dial
		expect(g.closed.args).to.deep.equal([[CONNECT_TIMEOUT_MS], [CONNECT_TIMEOUT_MS + 1_000]]);
	});

	it("does not record a dial made offline", function () {
		const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", {
			value: {onLine: false},
			configurable: true,
		});

		try {
			const g = gate(0);
			const {t} = make({gate: g});
			t.connect();
			expect(FakeWebSocket.instances).to.have.length(1);
			expect(g.record.called).to.equal(false);
			last().closed(1006, "", false);
			expect(g.closed.called).to.equal(false);
		} finally {
			if (nav) {
				Object.defineProperty(globalThis, "navigator", nav);
			} else {
				delete (globalThis as {navigator?: unknown}).navigator;
			}
		}
	});

	it("records a dial made 'offline' that opens anyway, once, and its end", function () {
		// `onLine` can be wrong: a socket that opened reached the server.
		const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", {
			value: {onLine: false},
			configurable: true,
		});

		try {
			const g = gate(0);
			const {t} = make({gate: g});
			t.connect();
			expect(g.record.called).to.equal(false);
			clock.tick(300);
			last().open();
			expect(g.record.args).to.deep.equal([[300]]);
			clock.tick(5_000);
			last().closed(1006, "", false);
			expect(g.closed.args).to.deep.equal([[5_300]]);
		} finally {
			if (nav) {
				Object.defineProperty(globalThis, "navigator", nav);
			} else {
				delete (globalThis as {navigator?: unknown}).navigator;
			}
		}
	});

	it("records an online dial once, not again when it opens", function () {
		const g = gate(0);
		const {t} = make({gate: g});
		t.connect();
		clock.tick(300);
		last().open();
		expect(g.record.args).to.deep.equal([[0]]);
	});
});
