/**
 * IrcClient + SASL: the CAP REQ/ACK → AUTHENTICATE → CAP END wiring, and the
 * "a login that was asked for must succeed" policy
 * (`features.saslDisconnectOnFail`, on by default). The pure state machine is
 * covered in test/irc/sasl.ts.
 */
import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient, IrcClientOptions, saslRequiredHint} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {encodePlain, SASL_TIMEOUT_MS} from "../../client/js/irc/sasl";
import {DEFAULT_BRANDING, resetBranding, setBranding} from "../../client/js/branding";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {MessageType, SharedMsg} from "../../shared/types/msg";

/** Minimal in-memory transport: only what registration and line feeding need. */
class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
	closeCalls = 0;
	abandonCalls: string[] = [];
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
		this.closeCalls++;
		this.state = "closed";
	}

	/** What WsTransport.abandon() does: a lost-connection close, then the schedule. */
	abandon(reason: string): void {
		this.abandonCalls.push(reason);
		this.state = "reconnect-wait";
		this.emit({
			type: "close",
			code: 1006,
			reason,
			wasClean: false,
			willReconnect: true,
			delayMs: 1000,
		});
		this.emit({type: "reconnecting", attempt: 1, delayMs: 1000});
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

const OFFERED_CAPS = "multi-prefix account-notify cap-notify server-time echo-message message-tags";

let dispatch: sinon.SinonSpy;
/** Whether this file installed the spy (test/irc/client.ts has a root-level one). */
let ownsSpy = false;

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

function messages(chanId: number): SharedMsg[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "msg")
		.map((call) => call.args[1] as {chan: number; msg: SharedMsg})
		.filter((p) => p.chan === chanId)
		.map((p) => p.msg);
}

function errors(chanId: number): string[] {
	return messages(chanId)
		.filter((m) => m.type === MessageType.ERROR)
		.map((m) => m.text ?? "");
}

function texts(chanId: number): string[] {
	return messages(chanId).map((m) => m.text ?? "");
}

/** The QUIT a required-SASL abort sends, and nothing after it. */
function expectAborted(transport: FakeTransport, client: IrcClient): void {
	expect(transport.sent).to.not.include("CAP END");
	expect(transport.sent[transport.sent.length - 1]).to.equal("QUIT :SASL authentication failed");
	expect(transport.closeCalls).to.equal(1);
	expect(client.isQuitting).to.equal(true);
	expect(client.isConnected).to.equal(false);
	// The reason, why it is fatal, and what to do about it.
	expect(errors(client.lobby.id)).to.have.length(2);
	expect(errors(client.lobby.id)[1]).to.equal(
		"Not connecting to irc.test without the login you asked for."
	);
	expect(texts(client.lobby.id)).to.include(saslRequiredHint());
}

/** Options for the deploys that keep the old "connect anyway" behaviour. */
const CARRY_ON: Partial<IrcClientOptions> = {saslDisconnectOnFail: false};

function setup(overrides: Partial<IrcClientOptions> = {}): {
	client: IrcClient;
	transport: FakeTransport;
} {
	const transport = new FakeTransport();
	const client = new IrcClient({
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "",
		sasl: "plain",
		saslAccount: "alice",
		saslPassword: "s3cret",
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
		...overrides,
	});
	client.connect();
	transport.open();
	return {client, transport};
}

/** Send the LS, answer our REQ with an ACK, and return the requested cap names. */
function offer(transport: FakeTransport, offered: string): string[] {
	transport.line(`:irc.test CAP * LS :${offered}`);
	const req = transport.sent.find((l) => l.startsWith("CAP REQ :"));
	expect(req, "CAP REQ sent").to.be.a("string");
	const names = (req as string).slice("CAP REQ :".length).split(" ");
	transport.line(`:irc.test CAP alice ACK :${names.join(" ")}`);
	return names;
}

function finishRegistration(transport: FakeTransport): void {
	transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice NETWORK=SeanceDev CASEMAPPING=rfc1459 :are supported by this server",
		":irc.test 422 alice :MOTD File is missing"
	);
}

describe("IrcClient SASL", function () {
	beforeEach(installSpy);
	afterEach(function () {
		removeSpy();
		resetBranding();
	});

	it("requests sasl, authenticates with PLAIN and then sends CAP END", function () {
		const {client, transport} = setup();
		const requested = offer(transport, `${OFFERED_CAPS} sasl=PLAIN,EXTERNAL`);

		expect(requested).to.include("sasl");
		expect(transport.sent).to.not.include("CAP END");
		expect(transport.sent[transport.sent.length - 1]).to.equal("AUTHENTICATE PLAIN");
		expect(client.sasl).to.not.equal(null);

		transport.line("AUTHENTICATE +");
		expect(transport.sent[transport.sent.length - 1]).to.equal(
			`AUTHENTICATE ${encodePlain("alice", "s3cret")}`
		);
		expect(transport.sent).to.not.include("CAP END");

		transport.lines(
			":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		expect(transport.sent[transport.sent.length - 1]).to.equal("CAP END");
		expect(transport.sent.filter((l) => l === "CAP END")).to.have.length(1);
		expect(client.sasl).to.equal(null);
		expect(client.account).to.equal("alice");
		expect(errors(client.lobby.id)).to.deep.equal([]);
		expect(messages(client.lobby.id).map((m) => m.text)).to.include(
			"You are now logged in as alice"
		);

		finishRegistration(transport);
		expect(client.isConnected).to.equal(true);
	});

	it("aborts the connection on a 904, quoting what the server said", function () {
		const {client, transport} = setup();
		offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
		transport.line("AUTHENTICATE +");
		transport.line(":irc.test 904 alice :SASL authentication failed: invalid credentials");

		expect(errors(client.lobby.id)[0]).to.equal(
			"SASL authentication failed: SASL authentication failed: invalid credentials"
		);
		expectAborted(transport, client);
		expect(client.account).to.equal("");
	});

	it("tells the manager to stop a refused login connecting by itself", function () {
		// The same credentials would be refused again at every page load, and
		// an autoconnecting network that never registers leaves no way back
		// to the connect screen to fix them (manager.ts onSaslRejected).
		let rejected = 0;
		const {client, transport} = setup({onSaslRejected: () => rejected++});

		offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
		transport.line("AUTHENTICATE +");
		transport.line(":irc.test 904 alice :SASL authentication failed");

		expect(rejected).to.equal(1);
		expectAborted(transport, client);
	});

	it("sends the view to the lobby, where the refusal is reported", function () {
		// The connect flow has landed on an autojoin channel by now; the
		// explanation is in the lobby, so network:aborted moves the view there.
		const {client, transport} = setup();

		offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
		transport.line("AUTHENTICATE +");
		transport.line(":irc.test 904 alice :SASL authentication failed");

		const aborted = dispatch.getCalls().filter((c) => c.args[0] === "network:aborted");
		expect(aborted).to.have.length(1);
		expect(aborted[0].args[1]).to.deep.equal({
			network: client.uuid,
			reason: "SASL authentication failed",
		});
	});

	it("does not move the view when the deploy connects anyway", function () {
		const {transport} = setup(CARRY_ON);

		offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
		transport.line("AUTHENTICATE +");
		transport.line(":irc.test 904 alice :SASL authentication failed");

		expect(dispatch.getCalls().filter((c) => c.args[0] === "network:aborted")).to.be.empty;
	});

	it("leaves autoconnect alone when the deploy connects anyway", function () {
		// Nothing was dropped, so there is no loop to break.
		let rejected = 0;
		const {transport} = setup({...CARRY_ON, onSaslRejected: () => rejected++});

		offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
		transport.line("AUTHENTICATE +");
		transport.line(":irc.test 904 alice :SASL authentication failed");

		expect(rejected).to.equal(0);
	});

	it("reports a 904 and still completes registration when the deploy allows it", function () {
		const {client, transport} = setup(CARRY_ON);
		offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
		transport.line("AUTHENTICATE +");
		transport.line(":irc.test 904 alice :SASL authentication failed");

		expect(errors(client.lobby.id)).to.deep.equal([
			"SASL authentication failed: SASL authentication failed",
		]);
		expect(transport.sent[transport.sent.length - 1]).to.equal("CAP END");
		expect(transport.closeCalls).to.equal(0);
		expect(client.account).to.equal("");

		finishRegistration(transport);
		expect(client.isConnected).to.equal(true);
		expect(client.state).to.equal("registered");
	});

	it("takes features.saslDisconnectOnFail from the deploy config", function () {
		setBranding({
			...DEFAULT_BRANDING,
			features: {...DEFAULT_BRANDING.features, saslDisconnectOnFail: false},
		});

		const {client, transport} = setup();
		offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
		transport.line("AUTHENTICATE +");
		transport.line(":irc.test 904 alice :SASL authentication failed");

		expect(errors(client.lobby.id)).to.have.length(1);
		expect(transport.sent[transport.sent.length - 1]).to.equal("CAP END");
		expect(transport.closeCalls).to.equal(0);
	});

	it("aborts before CAP LS when SASL is on but there is nothing to log in with", function () {
		const {client, transport} = setup({saslPassword: ""});

		expect(errors(client.lobby.id)[0]).to.equal(
			"SASL authentication failed: no account name or password is configured"
		);
		expect(transport.sent).to.not.include("CAP LS 302");
		expectAborted(transport, client);
	});

	it("aborts when the server does not offer the sasl cap", function () {
		const {client, transport} = setup();
		// The failure happens while the negotiator is still building its
		// reply, so not even the `CAP REQ` goes out: we QUIT instead.
		transport.line(`:irc.test CAP * LS :${OFFERED_CAPS}`);

		expect(transport.sent).to.not.include("AUTHENTICATE PLAIN");
		expect(transport.sent.some((l) => l.startsWith("CAP REQ"))).to.equal(false);
		expect(client.sasl).to.equal(null);
		expect(errors(client.lobby.id)[0]).to.equal(
			"SASL authentication failed: the server does not offer SASL"
		);
		expectAborted(transport, client);
	});

	it("reports the missing cap and connects anyway when the deploy allows it", function () {
		const {client, transport} = setup(CARRY_ON);
		const requested = offer(transport, OFFERED_CAPS);

		expect(requested).to.not.include("sasl");
		expect(transport.sent[transport.sent.length - 1]).to.equal("CAP END");
		expect(errors(client.lobby.id)).to.deep.equal([
			"SASL authentication failed: the server does not offer SASL",
		]);

		finishRegistration(transport);
		expect(client.isConnected).to.equal(true);
	});

	it("aborts, naming the mechanisms, when PLAIN is not among the advertised ones", function () {
		const {client, transport} = setup();
		transport.line(`:irc.test CAP * LS :${OFFERED_CAPS} sasl=EXTERNAL,SCRAM-SHA-256`);

		expect(errors(client.lobby.id)[0]).to.equal(
			"SASL authentication failed: the server offers SASL EXTERNAL,SCRAM-SHA-256, not PLAIN"
		);
		expectAborted(transport, client);
	});

	it("does not request sasl when PLAIN is not advertised, and may still connect", function () {
		const {transport} = setup(CARRY_ON);
		const requested = offer(transport, `${OFFERED_CAPS} sasl=EXTERNAL`);

		expect(requested).to.not.include("sasl");
		expect(transport.sent[transport.sent.length - 1]).to.equal("CAP END");
	});

	it("requests sasl when the cap has no value (no CAP 302)", function () {
		const {transport} = setup();
		const requested = offer(transport, `${OFFERED_CAPS} sasl`);

		expect(requested).to.include("sasl");
		expect(transport.sent[transport.sent.length - 1]).to.equal("AUTHENTICATE PLAIN");
	});

	it("does not touch SASL when no account is configured", function () {
		const {transport} = setup({sasl: "", saslAccount: "", saslPassword: ""});
		const requested = offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);

		expect(requested).to.not.include("sasl");
		expect(transport.sent[transport.sent.length - 1]).to.equal("CAP END");
	});

	it("pipelines AUTHENTICATE behind the REQ, and aborts to CAP END when the server NAKs sasl", function () {
		const {client, transport} = setup(CARRY_ON);
		transport.line(`:irc.test CAP * LS :${OFFERED_CAPS} sasl=PLAIN`);
		const req = transport.sent.find((l) => l.startsWith("CAP REQ :")) as string;
		const names = req.slice("CAP REQ :".length).split(" ");
		// The opener goes out with the REQ: no round trip waiting for the ACK.
		expect(transport.sent[transport.sent.indexOf(req) + 1]).to.equal("AUTHENTICATE PLAIN");
		expect(client.sasl).to.not.equal(null);

		// A NAKed multi-cap REQ is retried one cap at a time...
		transport.line(`:irc.test CAP alice NAK :${names.join(" ")}`);
		expect(transport.sent.filter((l) => l === "CAP REQ :sasl")).to.have.length(1);
		expect(transport.sent).to.not.include("CAP END");

		// ...and a NAK of `sasl` itself ends the exchange.
		transport.line(":irc.test CAP alice NAK :sasl");
		expect(transport.sent.slice(-2)).to.deep.equal(["AUTHENTICATE *", "CAP END"]);
		expect(client.sasl).to.equal(null);
	});

	it("aborts the connection when the server NAKs sasl", function () {
		const {client, transport} = setup();
		transport.line(`:irc.test CAP * LS :${OFFERED_CAPS} sasl=PLAIN`);
		const req = transport.sent.find((l) => l.startsWith("CAP REQ :")) as string;
		transport.line(`:irc.test CAP alice NAK :${req.slice("CAP REQ :".length)}`);
		transport.line(":irc.test CAP alice NAK :sasl");

		expect(errors(client.lobby.id)[0]).to.equal(
			"SASL authentication failed: the server refused the sasl capability"
		);
		// The abort still goes out: the server is told before we quit.
		expect(transport.sent).to.include("AUTHENTICATE *");
		expectAborted(transport, client);
	});

	it("aborts with AUTHENTICATE * after the timeout and continues", function () {
		const clock = sinon.useFakeTimers();

		try {
			const {client, transport} = setup(CARRY_ON);
			offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
			expect(transport.sent[transport.sent.length - 1]).to.equal("AUTHENTICATE PLAIN");

			clock.tick(SASL_TIMEOUT_MS + 1);

			expect(transport.sent.slice(-2)).to.deep.equal(["AUTHENTICATE *", "CAP END"]);
			expect(client.sasl).to.equal(null);
			expect(errors(client.lobby.id)).to.deep.equal([
				"SASL authentication failed: timed out waiting for the server",
			]);

			// The server's answer to our abort is shown but does not resend CAP END.
			transport.line(":irc.test 906 alice :SASL authentication aborted");
			expect(transport.sent.filter((l) => l === "CAP END")).to.have.length(1);
			expect(errors(client.lobby.id)).to.have.length(2);

			finishRegistration(transport);
			expect(client.isConnected).to.equal(true);
		} finally {
			clock.restore();
		}
	});

	it("QUITs and retries when the exchange times out: the server, not the login, is the problem", function () {
		// A phone coming back to a slow services link must not be left
		// disconnected for good; it also must not register unauthenticated.
		const clock = sinon.useFakeTimers();

		try {
			const {client, transport} = setup();
			offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);

			clock.tick(SASL_TIMEOUT_MS + 1);

			expect(errors(client.lobby.id)[0]).to.equal(
				"SASL authentication failed: timed out waiting for the server"
			);
			expect(transport.sent).to.include("AUTHENTICATE *");
			expect(transport.sent).to.not.include("CAP END");
			expect(transport.sent[transport.sent.length - 1]).to.equal(
				"QUIT :SASL authentication failed"
			);
			expect(transport.abandonCalls).to.deep.equal(["SASL timed out"]);
			expect(transport.closeCalls).to.equal(0);
			expect(client.isQuitting).to.equal(false);
			expect(client.isConnected).to.equal(false);
			expect(errors(client.lobby.id)).to.deep.equal([
				"SASL authentication failed: timed out waiting for the server",
				"Not connecting to irc.test without the login you asked for; trying again.",
			]);
			// Not a credentials problem, and the close that followed was ours.
			expect(texts(client.lobby.id)).to.not.include(saslRequiredHint());
			expect(texts(client.lobby.id)).to.include("Reconnecting in 1s (attempt 1)…");
		} finally {
			clock.restore();
		}
	});

	it("does not fire the timeout once the exchange completed", function () {
		const clock = sinon.useFakeTimers();

		try {
			const {client, transport} = setup();
			offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
			transport.line("AUTHENTICATE +");
			transport.line(":irc.test 903 alice :SASL authentication successful");
			const sentBefore = transport.sent.length;

			clock.tick(SASL_TIMEOUT_MS * 2);

			expect(transport.sent).to.have.length(sentBefore);
			expect(errors(client.lobby.id)).to.deep.equal([]);
		} finally {
			clock.restore();
		}
	});

	it("tracks 901 (logged out) after registration", function () {
		const {client, transport} = setup();
		offer(transport, `${OFFERED_CAPS} sasl=PLAIN`);
		transport.line("AUTHENTICATE +");
		transport.lines(
			":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		finishRegistration(transport);
		expect(client.account).to.equal("alice");

		transport.line(":irc.test 901 alice alice!alice@host :You are now logged out");
		expect(client.account).to.equal("");
		expect(messages(client.lobby.id).map((m) => m.text)).to.include("You are now logged out");
	});

	it("EXTERNAL stub sends AUTHENTICATE EXTERNAL and an empty response", function () {
		const {transport} = setup({sasl: "external", saslAccount: "", saslPassword: ""});
		const requested = offer(transport, `${OFFERED_CAPS} sasl=PLAIN,EXTERNAL`);

		expect(requested).to.include("sasl");
		expect(transport.sent[transport.sent.length - 1]).to.equal("AUTHENTICATE EXTERNAL");
		transport.line("AUTHENTICATE +");
		expect(transport.sent[transport.sent.length - 1]).to.equal("AUTHENTICATE +");
	});
});
