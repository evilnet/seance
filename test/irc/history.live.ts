/**
 * Live CHATHISTORY test against a real nefarious2 (ircv3.2-upgrade branch,
 * `CHATHISTORY_REQUIRE_AUTH` off). Skipped unless SEANCE_IRC_URL is set:
 *
 *   SEANCE_IRC_URL=wss://localhost:8443/ NODE_ENV=test \
 *     pnpm exec mocha --config=test/.mocharc.yml \
 *     test/irc/history.live.ts
 *
 * A TCP participant (SEANCE_IRC_TCP_PORT, default 6667) seeds #seance with
 * three messages; a fresh IrcClient then joins and must get them back from
 * its automatic `CHATHISTORY LATEST`, and a `more` emit must produce a
 * `BEFORE` request that is answered. SEANCE_IRC_VERBOSE=1 prints the raw
 * transcript.
 */
import {expect} from "chai";
import net from "node:net";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {registerBusHandlers} from "../../client/js/irc/bus";
import {ChanState} from "../../shared/types/chan";
import type {SharedMsg} from "../../shared/types/msg";
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

class TcpPeer {
	readonly lines: string[] = [];
	readonly nick: string;
	private readonly host: string;
	private readonly port: number;
	private sock: net.Socket | null = null;
	private buffer = "";

	constructor(nick: string, host: string, port: number) {
		this.nick = nick;
		this.host = host;
		this.port = port;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const sock = net.connect(this.port, this.host, () => {
				this.send(`NICK ${this.nick}`);
				this.send(`USER ${this.nick} 0 * :Seance history peer`);
			});
			sock.setEncoding("utf8");
			sock.on("error", reject);
			sock.on("data", (chunk: string) => {
				this.buffer += chunk;
				const parts = this.buffer.split(/\r?\n/);
				this.buffer = parts.pop() ?? "";

				for (const line of parts) {
					this.lines.push(line);

					if (line.startsWith("PING")) {
						this.send(`PONG${line.slice(4)}`);
					}

					if (/ 001 /.test(line)) {
						resolve();
					}
				}
			});
			this.sock = sock;
		});
	}

	send(line: string): void {
		this.sock?.write(`${line}\r\n`);
	}

	end(): void {
		this.sock?.end();
		this.sock = null;
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

describeLive("CHATHISTORY (live nefarious2)", function () {
	this.timeout(60_000);

	let dispatch: sinon.SinonStub;
	const clients: IrcClient[] = [];
	let peer: TcpPeer;
	const transcript: string[] = [];
	const events: string[] = [];

	afterEach(() => {
		dispatch.restore();
		socket.removeAllListeners();
		peer?.end();

		for (const client of clients) {
			client.disconnect("history live test done");
		}

		if (process.env.SEANCE_IRC_VERBOSE) {
			process.stderr.write(transcript.join("\n") + "\n" + events.join("\n") + "\n");
		}
	});

	function payloads<T = any>(event: string): T[] {
		return dispatch
			.getCalls()
			.filter((call) => call.args[0] === event)
			.map((call) => call.args[1] as T);
	}

	function makeClient(nick: string, ids: IdAllocator): IrcClient {
		const parsed = new URL(url as string);
		const client = new IrcClient({
			host: parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname),
			port: parseInt(parsed.port, 10) || (parsed.protocol === "wss:" ? 443 : 80),
			tls: parsed.protocol === "wss:",
			nick,
			join: "#seance",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			ids,
			transportFactory: recordingTransport(transcript),
			reconnect: {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false},
		});
		clients.push(client);
		return client;
	}

	it("gets seeded messages back via LATEST on join and answers `more` via BEFORE", async function () {
		allowSelfSignedForLocalhost(url as string);
		const parsed = new URL(url as string);
		const tag = Math.floor(1000 + Math.random() * 9000);
		const tcpPort = parseInt(process.env.SEANCE_IRC_TCP_PORT ?? "6667", 10);
		dispatch = sinon.stub(socket, "dispatch").callsFake((...args: unknown[]) => {
			const [event, payload] = args as [string, unknown];
			events.push(`${event} ${JSON.stringify(payload)}`);
			return false;
		});
		const ids = new IdAllocator();

		// 1. Seed: a TCP peer joins and says three things.
		peer = new TcpPeer(`histtcp${tag}`, parsed.hostname, tcpPort);
		await peer.connect();
		peer.send("JOIN #seance");
		await waitFor("peer joined", () => peer.lines.some((l) => / JOIN :?#seance/i.test(l)));
		const texts = [1, 2, 3].map((n) => `history seed ${tag} ${n}`);

		for (const text of texts) {
			peer.send(`PRIVMSG #seance :${text}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		await new Promise((resolve) => setTimeout(resolve, 500));

		// 2. A fresh client joins: its LATEST must bring the three lines back.
		const client = makeClient(`histws${tag}`, ids);
		const chan = client.findChannel("#seance")!;
		registerBusHandlers(socket, {
			clientForChannel: (id) => (client.channelById(id) ? client : undefined),
			clientForNetwork: (uuid) => (uuid === client.uuid ? client : undefined),
			allClients: () => [client],
			createNetwork: () => client,
			remove: () => undefined,
		});
		client.connect();
		await waitFor("init", () => payloads("init").length > 0);
		expect(client.caps.hasCapability("draft/chathistory"), "draft/chathistory").to.equal(true);
		expect(client.caps.hasCapability("batch"), "batch").to.equal(true);
		expect(client.isupport.chathistory, "ISUPPORT CHATHISTORY").to.be.a("number");
		await waitFor("JOIN", () => chan.state === ChanState.JOINED);

		const latest = transcript.find(
			(l) => l.startsWith(">>") && l.includes("CHATHISTORY LATEST")
		);
		expect(latest, "LATEST request sent").to.be.a("string");
		expect(latest).to.match(/CHATHISTORY LATEST #seance \* \d+$/);

		await waitFor("chathistory batch answered", () => payloads("more").length > 0, 15_000);
		const [more] =
			payloads<{chan: number; messages: SharedMsg[]; totalMessages: number}>("more");
		expect(more.chan).to.equal(chan.id);
		const seeded = more.messages.filter((m) => texts.includes(m.text ?? ""));
		expect(
			seeded.map((m) => m.text),
			"the three seeded lines, oldest first"
		).to.deep.equal(texts);
		expect(seeded.every((m) => m.from?.nick === peer.nick)).to.equal(true);
		expect(
			seeded.every((m) => typeof m.msgid === "string" && m.msgid.length > 0),
			"msgid tags"
		).to.equal(true);
		expect(seeded.every((m) => m.highlight === false)).to.equal(true);
		expect(
			seeded.every((m) => m.id < 0),
			"history ids below live ids"
		).to.equal(true);

		const open = transcript.find((l) => /<< .*BATCH \+\S+ chathistory #seance/.test(l));
		const close = transcript.find((l) => /<< .*BATCH -/.test(l));
		expect(open, "batch open line").to.be.a("string");
		expect(close, "batch close line").to.be.a("string");
		const inside = transcript.filter((l) => l.startsWith("<< @batch="));
		expect(inside.length).to.be.at.least(3);
		expect(
			inside.every((l) => /(^|;)time=/.test(l)),
			"@time on every batch line"
		).to.equal(true);

		// 3. `more` from the UI: BEFORE the first message shown.
		const firstShown = more.messages[0];
		dispatch.resetHistory();
		socket.emit("more", {target: chan.id, lastId: firstShown.id, condensed: false});
		await waitFor("BEFORE sent", () =>
			transcript.some((l) => l.startsWith(">>") && l.includes("CHATHISTORY BEFORE"))
		);
		const before = transcript.find(
			(l) => l.startsWith(">>") && l.includes("CHATHISTORY BEFORE")
		)!;
		expect(before).to.match(/CHATHISTORY BEFORE #seance (msgid|timestamp)=\S+ \d+$/);
		await waitFor("BEFORE answered", () => payloads("more").length > 0, 15_000);
		const [older] = payloads<{chan: number; messages: SharedMsg[]}>("more");
		expect(older.chan).to.equal(chan.id);
		expect(
			older.messages.some((m) => texts.includes(m.text ?? "")),
			"no seeded line repeated"
		).to.equal(false);
		expect(chan.historyRequested).to.equal(true);

		peer.send("QUIT :done");
	});
});
