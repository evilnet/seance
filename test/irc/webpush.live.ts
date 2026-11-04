/**
 * Live `draft/webpush` subscription test against a real nefarious2
 * (ircv3.2-upgrade branch with `CAP_draft_webpush` on and a VAPID key —
 * testnet or tools/nefarious-dev with the same features).
 * Skipped unless SEANCE_IRC_URL is set:
 *
 *   SEANCE_IRC_URL=ws://127.0.0.1:8067/ NODE_ENV=test \
 *     pnpm exec mocha --config=test/.mocharc.yml \
 *     test/irc/webpush.live.ts
 *
 * The ircd must run iauthd-ts with the static `SASLDB` users for the SASL
 * account (testnet defaults: SEANCE_IRC_ACCOUNT=testaccount,
 * SEANCE_IRC_PASSWORD=mypassword). Asserts the whole phase-1 round-trip from
 * docs/projects/push-subscription.md: the cap negotiates with a VAPID key,
 * a logged-in client's WEBPUSH REGISTER is echoed back, a bad keys payload
 * is answered with FAIL WEBPUSH INVALID_PARAMS, and WEBPUSH UNREGISTER
 * echoes even for an endpoint the server never had. SEANCE_IRC_VERBOSE=1
 * prints the raw transcript.
 */
import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import type {Transport} from "../../client/js/irc/types";
import {WsTransport, TransportOptions} from "../../client/js/irc/transport";

const url = process.env.SEANCE_IRC_URL;
const describeLive = url ? describe : describe.skip;
const ACCOUNT = process.env.SEANCE_IRC_ACCOUNT ?? "testaccount";
const PASSWORD = process.env.SEANCE_IRC_PASSWORD ?? "mypassword";

const ENDPOINT = "https://push.example.com/send/seance-live-test-1";
// Shape-real material: 88-char p256dh (65-byte point) + 22-char auth
// (16 bytes) in URL-safe base64 — what PushSubscription.toJSON() produces.
const P256DH =
	"BNbxR4Jd7rN9P6bVzUJKlOZYFfM2bGhF7vW9hB0cQKJ3qXGfL6mYvXrP8nSdWqT4A1cUeZiO5tRlKyHsMwNvXu8A";
const AUTH = "dGhpc0lzQVRlc3RBdXRoQQ";

function allowSelfSignedForLocalhost(target: string): void {
	const host = new URL(target).hostname;

	if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	}
}

async function waitFor(what: string, test: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();

	while (!test()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`timed out waiting for ${what}`);
		}

		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

interface WebpushState {
	network: string;
	action: string;
	endpoint: string;
	ok: boolean;
	code?: string;
	reason?: string;
}

describeLive("WEBPUSH (live nefarious2)", function () {
	this.timeout(60_000);

	let dispatch: sinon.SinonStub;
	let client: IrcClient | undefined;
	const transcript: string[] = [];

	afterEach(() => {
		dispatch.restore();
		socket.removeAllListeners();
		client?.disconnect("webpush live test done");

		if (process.env.SEANCE_IRC_VERBOSE) {
			process.stderr.write(transcript.join("\n") + "\n");
		}
	});

	function payloads<T = unknown>(event: string): T[] {
		return dispatch
			.getCalls()
			.filter((call) => call.args[0] === event)
			.map((call) => call.args[1] as T);
	}

	function connect(nick: string, sasl: boolean): void {
		allowSelfSignedForLocalhost(url as string);
		const parsed = new URL(url as string);

		client = new IrcClient({
			host: parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname),
			port: parseInt(parsed.port, 10) || (parsed.protocol === "wss:" ? 443 : 80),
			tls: parsed.protocol === "wss:",
			nick,
			join: "",
			sasl: sasl ? "plain" : "",
			saslAccount: sasl ? ACCOUNT : "",
			saslPassword: sasl ? PASSWORD : "",
			ids: new IdAllocator(),
			transportFactory(opts: TransportOptions): Transport {
				const inner = new WsTransport(opts);
				inner.on((ev) => {
					if (ev.type === "line") {
						transcript.push(`<< ${ev.line}`);
					}
				});
				const send = inner.send.bind(inner);

				inner.send = (line: string) => {
					transcript.push(`>> ${line}`);
					send(line);
				};

				return inner;
			},
			reconnect: {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false},
		});
		client.connect();
	}

	it("negotiates the cap, announces VAPID, and echoes REGISTER + UNREGISTER", async function () {
		dispatch = sinon.stub(socket, "dispatch").callsFake(() => false);
		connect(`webpush${Math.floor(1000 + Math.random() * 9000)}`, true);

		await waitFor("registered", () => payloads("init").length > 0);
		expect(client!.caps.hasCapability("draft/webpush"), "draft/webpush enabled").to.equal(true);

		const available = payloads<{network: string; vapid: string | undefined}>(
			"webpush:available"
		);
		expect(available).to.have.lengthOf(1);
		expect(available[0].vapid, "a VAPID key is advertised").to.be.a("string").with.lengthOf(87); // urlb64 of the 65-byte uncompressed P-256 point

		client!.webpushRegister(ENDPOINT, {p256dh: P256DH, auth: AUTH});
		await waitFor(
			"REGISTER echo",
			() =>
				payloads<WebpushState>("webpush:state").some(
					(p) => p.ok && p.action === "REGISTER" && p.endpoint === ENDPOINT
				),
			15_000
		);

		client!.webpushUnregister(ENDPOINT);
		await waitFor(
			"UNREGISTER echo",
			() =>
				payloads<WebpushState>("webpush:state").some(
					(p) => p.ok && p.action === "UNREGISTER" && p.endpoint === ENDPOINT
				),
			15_000
		);
	});

	it("reports FAIL for a keys payload without auth", async function () {
		dispatch = sinon.stub(socket, "dispatch").callsFake(() => false);
		connect(`webpush${Math.floor(1000 + Math.random() * 9000)}`, true);

		await waitFor("registered", () => payloads("init").length > 0);

		client!.webpushRegister(ENDPOINT, {p256dh: P256DH, auth: ""});
		await waitFor(
			"FAIL WEBPUSH",
			() =>
				payloads<WebpushState>("webpush:state").some(
					(p) => !p.ok && p.code === "INVALID_PARAMS" && p.action === "REGISTER"
				),
			15_000
		);
	});

	it("refuses WEBPUSH REGISTER without an account (ACCOUNT_REQUIRED)", async function () {
		dispatch = sinon.stub(socket, "dispatch").callsFake(() => false);
		connect(`anonpush${Math.floor(100 + Math.random() * 900)}`, false);

		await waitFor("registered", () => payloads("init").length > 0);
		expect(client!.caps.hasCapability("draft/webpush")).to.equal(true);

		client!.webpushRegister(ENDPOINT, {p256dh: P256DH, auth: AUTH});
		await waitFor(
			"FAIL WEBPUSH ACCOUNT_REQUIRED",
			() =>
				payloads<WebpushState>("webpush:state").some(
					(p) => !p.ok && p.code === "ACCOUNT_REQUIRED"
				),
			15_000
		);
	});
});
