/**
 * Live `draft/read-marker` test against a real nefarious2 (ircv3.2-upgrade
 * branch, `CAP_draft_read_marker` on — tools/nefarious-dev/local.conf).
 * Skipped unless SEANCE_IRC_URL is set:
 *
 *   SEANCE_IRC_URL=wss://localhost:8443/ NODE_ENV=test \
 *     pnpm exec mocha --config=test/.mocharc.yml \
 *     test/irc/markread.live.ts
 *
 * An unauthenticated IrcClient joins #seance, sends `MARKREAD #seance
 * timestamp=<now>`, reads it back with a bare `MARKREAD #seance` and checks
 * that an older marker is answered with the stored one. nefarious2 anchors
 * markers of clients without an account to their session and (as of the
 * ircv3.2-upgrade branch) does not echo an accepted set to such clients, so
 * the echo is only printed, not asserted. SEANCE_IRC_VERBOSE=1 prints the
 * raw transcript.
 */
import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {ChanState} from "../../shared/types/chan";
import type {Transport} from "../../client/js/irc/types";
import {WsTransport, TransportOptions} from "../../client/js/irc/transport";

const url = process.env.SEANCE_IRC_URL;
const describeLive = url ? describe : describe.skip;

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

/** Wraps WsTransport to record every raw line in both directions. */
function recordingTransport(transcript: string[]): (opts: TransportOptions) => Transport {
	return (opts) => {
		const inner = new WsTransport(opts);
		inner.on((ev) => {
			if (ev.type === "line") {
				transcript.push(`<< ${ev.line}`);
			} else {
				transcript.push(`-- ${ev.type}`);
			}
		});
		const send = inner.send.bind(inner);

		inner.send = (line: string) => {
			transcript.push(`>> ${line}`);
			send(line);
		};

		return inner;
	};
}

describeLive("MARKREAD (live nefarious2)", function () {
	this.timeout(60_000);

	let dispatch: sinon.SinonStub;
	let client: IrcClient | undefined;
	const transcript: string[] = [];
	const events: string[] = [];

	afterEach(() => {
		dispatch.restore();
		socket.removeAllListeners();
		client?.disconnect("markread live test done");

		if (process.env.SEANCE_IRC_VERBOSE) {
			process.stderr.write(transcript.join("\n") + "\n" + events.join("\n") + "\n");
		}
	});

	function payloads<T = unknown>(event: string): T[] {
		return dispatch
			.getCalls()
			.filter((call) => call.args[0] === event)
			.map((call) => call.args[1] as T);
	}

	it("echoes a MARKREAD set by the client", async function () {
		allowSelfSignedForLocalhost(url as string);
		const parsed = new URL(url as string);
		const tag = Math.floor(1000 + Math.random() * 9000);
		dispatch = sinon.stub(socket, "dispatch").callsFake((...args: unknown[]) => {
			const [event, payload] = args as [string, unknown];
			events.push(`${event} ${JSON.stringify(payload)}`);
			return false;
		});

		client = new IrcClient({
			host: parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname),
			port: parseInt(parsed.port, 10) || (parsed.protocol === "wss:" ? 443 : 80),
			tls: parsed.protocol === "wss:",
			nick: `markws${tag}`,
			join: "#seance",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			ids: new IdAllocator(),
			transportFactory: recordingTransport(transcript),
			reconnect: {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false},
		});
		const chan = client.findChannel("#seance")!;
		const live = client;
		registerBusHandlers(socket, {
			clientForChannel: (id) => (live.channelById(id) ? live : undefined),
			clientForNetwork: (uuid) => (uuid === live.uuid ? live : undefined),
			allClients: () => [live],
			createNetwork: () => live,
			remove: () => undefined,
		});
		client.connect();
		await waitFor("init", () => payloads("init").length > 0);
		expect(client.caps.hasCapability("draft/read-marker"), "draft/read-marker").to.equal(true);
		await waitFor("JOIN", () => chan.state === ChanState.JOINED);

		// The JOIN hook asks for the stored marker; see what the server says.
		await waitFor("fetch sent", () => transcript.includes(">> MARKREAD #seance"));
		const isReply = (l: string) =>
			l.startsWith("<<") && / (MARKREAD|FAIL MARKREAD)\b/.test(l) && l.includes("#seance");
		await waitFor("reply to the fetch", () => transcript.some(isReply), 5_000).catch(
			() => undefined
		);
		const fetchReplies = transcript.filter(isReply);
		process.stderr.write(
			`MARKREAD fetch after JOIN → ${
				fetchReplies.length > 0 ? fetchReplies.join(" | ") : "(no reply)"
			}\n`
		);

		// Set a marker. The spec says the server echoes it to every session of
		// the account; nefarious2 does that for account-anchored markers only,
		// so treat the echo as informational and verify through a GET instead.
		let before = transcript.length;
		const stamp = new Date().toISOString();
		client.send(`MARKREAD #seance timestamp=${stamp}`);
		await waitFor("echo of the set", () => transcript.slice(before).some(isReply), 3_000).catch(
			() => undefined
		);
		const echo = transcript.slice(before).find(isReply);
		process.stderr.write(`MARKREAD set → ${echo ?? "(no echo within 3s)"}\n`);

		before = transcript.length;
		client.send("MARKREAD #seance");
		await waitFor("GET reply", () => transcript.slice(before).some(isReply));
		const got = transcript.slice(before).find(isReply)!;
		process.stderr.write(`MARKREAD get → ${got}\n`);
		expect(got).to.match(/ MARKREAD #seance timestamp=/);
		expect(got).to.include(`timestamp=${stamp}`);
		expect(chan.readMarker?.toISOString()).to.equal(stamp);

		// An older marker must be answered with the stored, newer one.
		before = transcript.length;
		const older = new Date(Date.parse(stamp) - 60_000).toISOString();
		client.send(`MARKREAD #seance timestamp=${older}`);
		await waitFor("reply to the older set", () => transcript.slice(before).some(isReply));
		const kept = transcript.slice(before).find(isReply)!;
		process.stderr.write(`MARKREAD set (older) → ${kept}\n`);
		expect(kept).to.include(`timestamp=${stamp}`);
		expect(chan.readMarker?.toISOString()).to.equal(stamp);
	});
});
