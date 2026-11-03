/**
 * Live `draft/multiline` round-trip against a real nefarious2
 * (ircv3.2-upgrade). Skipped unless SEANCE_IRC_URL is set:
 *
 *   SEANCE_IRC_URL=wss://localhost:8443/ NODE_ENV=test \
 *     pnpm exec mocha --config=test/.mocharc.yml \
 *     test/irc/multiline.live.ts
 *
 * SEANCE_IRC_CHANNEL overrides the channel (default #seance) — on a public
 * network point it at one you are welcome in. SEANCE_IRC_VERBOSE=1 prints the
 * whole transcript; the batch itself is printed either way, because what the
 * server does with a batch (rewriting the reference, where it puts
 * msgid/time, what it tells clients without the capability) is the finding
 * this test exists to record.
 *
 * One client joins, one capability-less peer listens, and one three-line
 * message goes out. The FAIL paths (`MULTILINE_MAX_LINES`,
 * `MULTILINE_MAX_BYTES`, …) are deliberately not probed: reaching them means
 * throwing 100+ lines or 16 KB at a live server, and the client plans its
 * batches under the advertised limits precisely so they cannot happen. They
 * are covered in test/irc/multiline.ts instead.
 */
import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {ChanState} from "../../shared/types/chan";
import type {SharedMsg} from "../../shared/types/msg";
import type {Transport} from "../../client/js/irc/types";
import {WsTransport, TransportOptions} from "../../client/js/irc/transport";

const url = process.env.SEANCE_IRC_URL;
const channel = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const describeLive = url ? describe : describe.skip;
const NO_RECONNECT = {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false};

function allowSelfSignedForLocalhost(target: string): void {
	const host = new URL(target).hostname;

	if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	}
}

async function waitFor(what: string, test: () => boolean, timeoutMs = 15_000): Promise<void> {
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

/**
 * A second connection that negotiates nothing — no `CAP LS`, no capabilities
 * — so it sees what every client without `draft/multiline` sees. It only
 * listens; its JOIN is all it puts in the channel. Without it the server's
 * "Message truncated for N legacy recipients" warning is a claim; with it,
 * an observation.
 */
class LegacyPeer {
	readonly nick: string;
	readonly lines: string[] = [];
	private readonly transport: WsTransport;

	constructor(target: string, nick: string) {
		this.nick = nick;
		this.transport = new WsTransport({url: target, reconnect: NO_RECONNECT});
		this.transport.on((ev) => {
			if (ev.type === "open") {
				// No CAP at all: a plain RFC registration.
				this.transport.send(`NICK ${nick}`);
				this.transport.send(`USER ${nick} 0 * :Seance legacy peer`);
			} else if (ev.type === "line") {
				this.lines.push(ev.line); // PING is answered by the transport
			}
		});
	}

	connect(): void {
		this.transport.connect();
	}

	get registered(): boolean {
		return this.lines.some((line) => / 001 /.test(line));
	}

	join(chan: string): void {
		this.transport.send(`JOIN ${chan}`);
	}

	joined(chan: string): boolean {
		return this.lines.some(
			(line) =>
				line.includes(`${this.nick}!`) && / JOIN :?/i.test(line) && line.endsWith(chan)
		);
	}

	/** Message bodies this peer saw in `chan`. */
	said(chan: string): string[] {
		const re = new RegExp(`^(?:@\\S+ )?:\\S+ PRIVMSG ${chan} :(.*)$`, "i");

		return this.lines.map((line) => re.exec(line)?.[1]).filter((body) => body !== undefined);
	}

	close(): void {
		this.transport.close();
	}
}

describeLive("draft/multiline (live nefarious2)", function () {
	this.timeout(90_000);

	let dispatch: sinon.SinonStub;
	let client: IrcClient | undefined;
	let peer: LegacyPeer | undefined;
	const transcript: string[] = [];

	afterEach(() => {
		dispatch.restore();
		socket.removeAllListeners();
		client?.disconnect("multiline live test done");
		peer?.close();

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

	it("sends a three-line message as one batch and reads it back as one message", async function () {
		allowSelfSignedForLocalhost(url as string);
		const parsed = new URL(url as string);
		const tag = Math.floor(1000 + Math.random() * 9000);
		dispatch = sinon.stub(socket, "dispatch").callsFake(() => false);

		client = new IrcClient({
			host: parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname),
			port: parseInt(parsed.port, 10) || (parsed.protocol === "wss:" ? 443 : 80),
			tls: parsed.protocol === "wss:",
			nick: `mlws${tag}`,
			join: channel,
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			ids: new IdAllocator(),
			transportFactory: recordingTransport(transcript),
			reconnect: NO_RECONNECT,
		});

		const chan = client.findChannel(channel)!;

		client.connect();
		await waitFor("init", () => payloads("init").length > 0);

		const limits = client.multilineLimits();

		process.stderr.write(`draft/multiline limits → ${JSON.stringify(limits)}\n`);
		expect(limits, "the server must offer a usable draft/multiline").to.not.equal(undefined);
		await waitFor(`JOIN ${channel}`, () => chan.state === ChanState.JOINED, 30_000);

		// A second connection from one address is what a public network
		// throttles first; when it does not come up, the run still covers
		// everything else and says so rather than failing.
		peer = new LegacyPeer(url as string, `mlleg${tag}`);
		peer.connect();

		try {
			await waitFor("the legacy peer to register", () => peer!.registered, 20_000);
			peer.join(channel);
			await waitFor("the legacy peer to join", () => peer!.joined(channel));
		} catch (err) {
			process.stderr.write(`no legacy peer this run: ${String(err)}\n`);
			peer.close();
			peer = undefined;
		}

		// One send, one message: the token identifies it in a channel other
		// people are talking in, and sits on the first line so the whole
		// message is findable by it.
		const token = `ml${tag}`;
		const text = `${token} line one\nline two\nline three`;
		const before = transcript.length;

		client.input(chan.id, text);

		const ours = () =>
			payloads<{chan: number; msg: SharedMsg}>("msg").filter(
				(p) => p.chan === chan.id && (p.msg.text ?? "").includes(token)
			);

		await waitFor("our own message back", () => ours().length > 0);
		// Give a second batch, if the server were to split one, and the
		// legacy peer's copy, time to arrive.
		await new Promise((resolve) => setTimeout(resolve, 2_000));

		process.stderr.write(transcript.slice(before).join("\n") + "\n");
		// Everything the peer saw, not only the lines carrying the token —
		// whether lines two and three arrive at all is the whole question.
		process.stderr.write(
			`legacy peer saw ${JSON.stringify(peer ? peer.said(channel).slice(-6) : null)}\n`
		);

		const sent = transcript.slice(before).filter((line) => line.startsWith(">> "));
		const open = sent.findIndex((line) => /^>> (?:@\S+ )?BATCH \+/.test(line));

		expect(open, `a multiline batch opener, got ${JSON.stringify(sent)}`).to.not.equal(-1);

		// Everything after the batch belongs to something else — the read
		// marker Seance sends on seeing its own message, a PONG.
		const batch = sent.slice(open, open + 5);
		const ref = /BATCH \+(\S+) /.exec(batch[0])![1];

		expect(batch[0]).to.equal(`>> BATCH +${ref} draft/multiline ${channel}`);
		expect(batch[1]).to.equal(`>> @batch=${ref} PRIVMSG ${channel} :${token} line one`);
		expect(batch[2]).to.equal(`>> @batch=${ref} PRIVMSG ${channel} :line two`);
		expect(batch[3]).to.equal(`>> @batch=${ref} PRIVMSG ${channel} :line three`);
		expect(batch[4]).to.equal(`>> BATCH -${ref}`);
		expect(
			sent.filter((line) => line.includes("PRIVMSG") && !line.includes("@batch=")),
			"no line was sent outside the batch"
		).to.have.length(0);

		// What came back: one message, the line feeds intact.
		const got = ours();

		expect(got, "one message, not one per line").to.have.length(1);
		expect(got[0].msg.text).to.equal(text);
		expect(got[0].msg.self).to.equal(true);

		if (client.caps.hasCapability("echo-message")) {
			// The echo is the server's own batch, so it carries the msgid it
			// gave the message (from the opener — that is where the draft puts
			// it, and where multilineBatch reads it).
			expect(got[0].msg.msgid, "a msgid off the batch opener").to.be.a("string");
			expect(got[0].msg.msgid).to.not.equal("");
		} else {
			process.stderr.write("no echo-message: the message shown is the local synthesis\n");
		}

		// Not in the draft: with a capability-less client in the channel,
		// nefarious2 answers the batch with `WARN BATCH MULTILINE_FALLBACK`.
		// It is swallowed (handlers/standard-replies.ts) — one red line under
		// every multi-line message would be worse than useless.
		const warned = transcript
			.slice(before)
			.filter((line) => line.startsWith("<< ") && line.includes("MULTILINE_FALLBACK"));

		process.stderr.write(`fallback warnings → ${JSON.stringify(warned)}\n`);
		expect(
			payloads<{msg: SharedMsg}>("msg").filter((p) =>
				(p.msg.text ?? "").includes("MULTILINE_FALLBACK")
			),
			"the fallback warning is not shown to the user"
		).to.have.length(0);

		// The draft: "When delivering multiline batches to clients that have
		// not negotiated the multiline capability, servers MUST deliver the
		// component messages without using a multiline BATCH." nefarious2
		// does exactly that — the warning's "truncated" is a misnomer, the
		// lines all arrive, just not as one message. Which is the reason it
		// can be swallowed: nothing was lost to report.
		if (peer) {
			const bodies = peer.said(channel);
			const at = bodies.findIndex((body) => body.includes(token));

			expect(at, "the legacy peer saw the message").to.not.equal(-1);
			expect(bodies.slice(at, at + 3), "every line reached the legacy peer").to.deep.equal([
				`${token} line one`,
				"line two",
				"line three",
			]);
		}
	});
});
