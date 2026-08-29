/**
 * Live `draft/multiline` test against a real nefarious2 (ircv3.2-upgrade
 * branch, `CAP_draft_multiline` on by default). Skipped unless
 * SEANCE_IRC_URL is set:
 *
 *   SEANCE_IRC_URL=wss://localhost:8443/ npx cross-env NODE_ENV=test \
 *     TS_NODE_PROJECT=./test/tsconfig.json npx mocha --config=test/.mocharc.yml \
 *     test/irc/multiline.live.ts
 *
 * An IrcClient joins a channel of its own, types a three-line message and
 * checks that the batch it put on the wire comes back — through
 * `echo-message`, the server's own re-batching — as a single `msg` whose
 * text still has its newlines. SEANCE_IRC_VERBOSE=1 prints the transcript.
 */
import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {ChanState} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";
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

describeLive("draft/multiline (live nefarious2)", function () {
	this.timeout(60_000);

	let dispatch: sinon.SinonStub;
	let client: IrcClient | undefined;
	const transcript: string[] = [];

	afterEach(() => {
		dispatch.restore();
		socket.removeAllListeners();
		client?.disconnect("multiline live test done");

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

	it("sends a batch and gets one message back", async function () {
		allowSelfSignedForLocalhost(url as string);
		const parsed = new URL(url as string);
		const tag = Math.floor(1000 + Math.random() * 9000);
		const channel = `#mline${tag}`;
		dispatch = sinon.stub(socket, "dispatch").returns(false);

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
			reconnect: {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false},
		});
		const chan = client.findChannel(channel)!;
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
		expect(client.caps.hasCapability("draft/multiline"), "draft/multiline").to.equal(true);
		expect(client.caps.value("draft/multiline")).to.match(/max-bytes=\d+/);
		await waitFor("JOIN", () => chan.state === ChanState.JOINED);

		const before = transcript.length;
		client.input(chan.id, "first line\n\nthird line");
		await waitFor("the batch to be sent", () =>
			transcript.slice(before).some((l) => l.startsWith(">> BATCH -"))
		);

		const sent = transcript
			.slice(before)
			.filter((l) => l.startsWith(">> "))
			.map((l) => l.slice(3));
		const ref = sent[0].match(/^BATCH \+(\S+) draft\/multiline /)![1];
		expect(sent).to.deep.equal([
			`BATCH +${ref} draft/multiline ${channel}`,
			`@batch=${ref} PRIVMSG ${channel} :first line`,
			`@batch=${ref} PRIVMSG ${channel} :`,
			`@batch=${ref} PRIVMSG ${channel} :third line`,
			`BATCH -${ref}`,
		]);

		// echo-message: the server re-batches it back to us, and the batch
		// handler joins it into the one message the user typed.
		const said = () =>
			payloads<{chan: number; msg: SharedMsg}>("msg").filter(
				(p) => p.chan === chan.id && p.msg.type === MessageType.MESSAGE
			);
		await waitFor("the echo", () => said().length > 0);
		const echoed = said();
		expect(echoed).to.have.length(1);
		expect(echoed[0].msg.text).to.equal("first line\n\nthird line");
		expect(echoed[0].msg.msgid, "the opener's msgid").to.be.a("string");
	});
});
