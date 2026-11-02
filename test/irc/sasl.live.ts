/**
 * Live SASL check against a real nefarious2 (ircv3.2-upgrade).
 *
 * Skipped unless SEANCE_IRC_URL is set, e.g.
 *   SEANCE_IRC_URL=wss://localhost:8443/ NODE_ENV=test \
 *     pnpm exec mocha --config=test/.mocharc.yml \
 *     test/irc/sasl.live.ts
 *
 * The dev ircd has no services, so SASL cannot succeed. Three things are
 * checked and printed (`[sasl.live]` lines):
 *
 *   1. IrcClient with `saslDisconnectOnFail: false` registers anyway, with
 *      the failure reported in the lobby. As of 2026-08 the dev ircd does
 *      not even list `sasl` in CAP LS, so the report is "the server does
 *      not offer SASL".
 *   2. The same client with the default policy never registers: it reports
 *      the failure and QUITs (`features.saslDisconnectOnFail`).
 *   3. A raw WebSocket forces `CAP REQ :sasl` (nefarious2 ACKs it anyway)
 *      and drives {@link SaslAuth} against the real answers, to record the
 *      numeric the server uses without services: `904 :SASL authentication
 *      failed: request timed out`, ~10s after `AUTHENTICATE PLAIN`, with no
 *      `AUTHENTICATE +` first.
 *
 * Set SEANCE_IRC_VERBOSE=1 to print every raw line.
 */
import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {parseLine} from "../../client/js/irc/message";
import {SaslAuth, SaslResult} from "../../client/js/irc/sasl";
import {MessageType, SharedMsg} from "../../shared/types/msg";

const url = process.env.SEANCE_IRC_URL;
const describeLive = url ? describe : describe.skip;

function allowSelfSignedForLocalhost(target: string): void {
	const host = new URL(target).hostname;

	if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	}
}

async function waitFor(what: string, test: () => boolean, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();

	while (!test()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`timed out waiting for ${what}`);
		}

		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function log(text: string): void {
	// eslint-disable-next-line no-console
	console.log(`[sasl.live] ${text}`);
}

describeLive("IrcClient SASL (live nefarious2)", function () {
	this.timeout(90_000);

	let dispatch: sinon.SinonSpy;
	const rawLines: string[] = [];

	afterEach(() => {
		dispatch?.restore();
		socket.removeAllListeners();

		if (process.env.SEANCE_IRC_VERBOSE) {
			process.stderr.write(rawLines.join("\n") + "\n");
		}

		rawLines.length = 0;
	});

	function messages(chanId: number): SharedMsg[] {
		return dispatch
			.getCalls()
			.filter((call) => call.args[0] === "msg")
			.map((call) => call.args[1] as {chan: number; msg: SharedMsg})
			.filter((p) => p.chan === chanId)
			.map((p) => p.msg);
	}

	function payloads(event: string): unknown[] {
		return dispatch
			.getCalls()
			.filter((call) => call.args[0] === event)
			.map((call) => call.args[1] as unknown);
	}

	it("forced CAP REQ :sasl — records what the server answers without services", async function () {
		allowSelfSignedForLocalhost(url as string);
		const nick = `seanceraw${Math.floor(1000 + Math.random() * 9000)}`;
		const ws = new WebSocket(url as string, ["text.ircv3.net"]);
		const auth = new SaslAuth("PLAIN", {
			account: "seance-nobody",
			password: "definitely-wrong",
		});
		const sent: string[] = [];
		const started = Date.now();
		let outcome: SaslResult | null = null;
		let outcomeAt = 0;
		let welcomed = false;
		let closed = false;

		const send = (line: string) => {
			sent.push(line);
			ws.send(`${line}\r\n`);
		};

		await new Promise<void>((resolve, reject) => {
			ws.onerror = (ev) =>
				reject(new Error(`websocket error: ${(ev as {message?: string}).message ?? ""}`));
			ws.onopen = () => resolve();
		});

		ws.onclose = () => {
			closed = true;
		};

		ws.onmessage = (ev) => {
			for (const line of String(ev.data).split(/\r?\n/)) {
				if (!line) {
					continue;
				}

				rawLines.push(line);
				const msg = parseLine(line);

				if (!msg) {
					continue;
				}

				if (msg.command === "PING") {
					send(`PONG :${msg.params[0] ?? ""}`);
				} else if (
					msg.command === "CAP" &&
					msg.params[1] === "LS" &&
					msg.params[2] !== "*"
				) {
					send("CAP REQ :sasl");
				} else if (msg.command === "CAP" && msg.params[1] === "ACK") {
					auth.start().forEach(send);
				} else if (msg.command === "CAP" && msg.params[1] === "NAK") {
					send("CAP END");
				} else if (msg.command === "AUTHENTICATE" || /^90[0-8]$/.test(msg.command)) {
					const res = auth.handle(msg);
					res.send.forEach(send);

					if (res.done && !outcome) {
						outcome = res;
						outcomeAt = Date.now() - started;
						send("CAP END");
					}
				} else if (msg.command === "001") {
					welcomed = true;
				}
			}
		};

		send("CAP LS 302");
		send(`NICK ${nick}`);
		send("USER seance 0 * :Seance SASL live test");

		await waitFor("001 after the SASL exchange", () => welcomed, 45_000);
		send("QUIT :done");
		await waitFor("close", () => closed, 5_000).catch(() => ws.close());

		const saslLines = rawLines.filter((l) =>
			/(^AUTHENTICATE | 90[0-8] | CAP \S+ (ACK|NAK))/.test(l)
		);
		log(`raw: sent ${JSON.stringify(sent.filter((l) => /^(CAP|AUTHENTICATE)/.test(l)))}`);

		for (const line of saslLines) {
			log(`raw: ${line}`);
		}

		log(`raw: outcome after ${(outcomeAt / 1000).toFixed(1)}s: ${JSON.stringify(outcome)}`);

		expect(sent).to.include("CAP END");
		expect(outcome, "SASL exchange reached an outcome").to.not.equal(null);
		expect((outcome as SaslResult).ok).to.equal(false);
		expect(
			rawLines.some((l) => / 90[2-7] /.test(l)),
			"a SASL failure numeric"
		).to.equal(true);
	});

	it("IrcClient with a bad account still registers when the deploy allows it", async function () {
		allowSelfSignedForLocalhost(url as string);
		// ircu IPcheck throttles a quick reconnect after a short-lived connection, so the
		// ~10s raw exchange above runs first; still give the server a moment.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const parsed = new URL(url as string);
		const tag = Math.floor(1000 + Math.random() * 9000);
		dispatch = sinon.stub(socket, "dispatch").returns(false);

		const client = new IrcClient({
			host: parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname),
			port: parseInt(parsed.port, 10) || (parsed.protocol === "wss:" ? 443 : 80),
			tls: parsed.protocol === "wss:",
			nick: `seancesasl${tag}`,
			join: "",
			sasl: "plain",
			saslAccount: process.env.SEANCE_SASL_ACCOUNT ?? "seance-nobody",
			saslPassword: process.env.SEANCE_SASL_PASSWORD ?? "definitely-wrong",
			saslDisconnectOnFail: false,
			ids: new IdAllocator(),
			reconnect: {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false},
		});
		client.transport.on((ev) => {
			if (ev.type === "line") {
				rawLines.push(ev.line);
			}
		});

		client.connect();
		await waitFor("init", () => payloads("init").length > 0);

		const saslValue = client.caps.value("sasl");
		const enabled = client.caps.hasCapability("sasl");
		const numerics = rawLines
			.map((line) => line.split(" ")[1])
			.filter((cmd) => /^90[0-8]$/.test(cmd ?? ""));
		log(
			`client: sasl cap ${
				saslValue === undefined ? "not advertised" : `value=${JSON.stringify(saslValue)}`
			}, enabled=${enabled}, numerics=${JSON.stringify(numerics)}, account=${JSON.stringify(
				client.account
			)}`
		);

		expect(client.isConnected).to.equal(true);
		expect(client.sasl, "exchange finished").to.equal(null);

		const saslErrors = messages(client.lobby.id).filter(
			(m) => m.type === MessageType.ERROR && /^SASL authentication failed/.test(m.text ?? "")
		);

		// Either way the user is told; only the disconnect is optional.
		expect(saslErrors, "one SASL failure reported in the lobby").to.have.length(1);
		log(`client: ${saslErrors[0].text}`);

		expect(client.account).to.equal("");
		client.disconnect("live sasl test done");
		await waitFor("close", () => client.state === "disconnected");
	});

	it("IrcClient with a bad account does not register under the default policy", async function () {
		allowSelfSignedForLocalhost(url as string);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const parsed = new URL(url as string);
		const tag = Math.floor(1000 + Math.random() * 9000);
		dispatch = sinon.stub(socket, "dispatch").returns(false);

		const client = new IrcClient({
			host: parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname),
			port: parseInt(parsed.port, 10) || (parsed.protocol === "wss:" ? 443 : 80),
			tls: parsed.protocol === "wss:",
			nick: `seancereq${tag}`,
			join: "",
			sasl: "plain",
			saslAccount: process.env.SEANCE_SASL_ACCOUNT ?? "seance-nobody",
			saslPassword: process.env.SEANCE_SASL_PASSWORD ?? "definitely-wrong",
			ids: new IdAllocator(),
			reconnect: {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false},
		});
		client.transport.on((ev) => {
			if (ev.type === "line") {
				rawLines.push(ev.line);
			}
		});

		client.connect();
		await waitFor("the client to give up", () => client.isQuitting, 40_000);

		const reported = messages(client.lobby.id)
			.filter((m) => m.type === MessageType.ERROR)
			.map((m) => m.text ?? "");
		log(`required: ${JSON.stringify(reported)}`);

		expect(reported[0], "the reason").to.match(/^SASL authentication failed: /);
		expect(reported).to.include(
			`Not connecting to ${client.options.host} without the login you asked for.`
		);
		expect(payloads("init"), "never registered").to.have.length(0);
		expect(client.isConnected).to.equal(false);
		expect(
			rawLines.some((l) => / 001 /.test(l)),
			"no welcome"
		).to.equal(false);

		await waitFor("close", () => client.state === "disconnected", 20_000);
	});
});
