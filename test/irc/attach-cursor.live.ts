/**
 * Live `PERSISTENCE ATTACH <profile> <msgid>` catch-up cursor test against a
 * real nefarious2 with `BOUNCER_ENABLE` and accounts (the AfterNET
 * e-testnet). Skipped unless SEANCE_IRC_URL is set:
 *
 *   SEANCE_IRC_URL=ws://127.0.0.1:18067/ SEANCE_IRC_SASL_ACCOUNT=seance1 \
 *     SEANCE_IRC_SASL_PASSWORD=seancepass1 NODE_ENV=test \
 *     pnpm exec mocha \
 *     --config=test/.mocharc.yml test/irc/attach-cursor.live.ts
 *
 * Node's global `WebSocket` (what `WsTransport` uses) always sends a closing
 * handshake, and a *clean* WebSocket close makes nefarious2 destroy the held
 * session instead of holding it. So the client dials a tiny `node:net` proxy
 * that pipes to the ircd, and "the phone lost its network" is both sides of
 * that proxied connection being `destroy()`ed — no close frame, no QUIT.
 *
 * SEANCE_IRC_VERBOSE=1 prints the raw transcript and the bus events.
 */
import {expect} from "chai";
import net from "node:net";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import * as saved from "../../client/js/irc/saved-networks";
import type {StorageBackend} from "../../client/js/irc/saved-networks";
import {ChanState, ChanType} from "../../shared/types/chan";
import type {SharedMsg} from "../../shared/types/msg";
import type {Transport} from "../../client/js/irc/types";
import {WsTransport, TransportOptions} from "../../client/js/irc/transport";

const url = process.env.SEANCE_IRC_URL;
const describeLive = url ? describe : describe.skip;

const ACCOUNT = process.env.SEANCE_IRC_SASL_ACCOUNT ?? process.env.SEANCE_SASL_ACCOUNT ?? "seance1";
const PASSWORD =
	process.env.SEANCE_IRC_SASL_PASSWORD ?? process.env.SEANCE_SASL_PASSWORD ?? "seancepass1";
const PEER_ACCOUNT = process.env.SEANCE_IRC_PEER_ACCOUNT ?? "seance2";
const PEER_PASSWORD = process.env.SEANCE_IRC_PEER_PASSWORD ?? PASSWORD;
const CHANNEL = "#seance";
const UUID = "attach-cursor-live";

async function waitFor(what: string, test: () => boolean, timeoutMs = 20_000): Promise<void> {
	const start = Date.now();

	while (!test()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`timed out waiting for ${what}`);
		}

		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** localStorage stand-in so the cursor is stored somewhere inspectable. */
class MemoryBackend implements StorageBackend {
	data = new Map<string, string>();

	get(key: string): string | null {
		return this.data.has(key) ? (this.data.get(key) as string) : null;
	}

	set(key: string, value: string): void {
		this.data.set(key, value);
	}

	remove(key: string): void {
		this.data.delete(key);
	}
}

/**
 * TCP pass-through in front of the ircd's `ws://` port. `killAll()` destroys
 * both halves of every live pair without a WebSocket close frame, which is
 * the only drop nefarious2 holds a session for.
 */
class TcpProxy {
	readonly pairs: net.Socket[][] = [];
	connections = 0;
	private readonly upstreamHost: string;
	private readonly upstreamPort: number;
	private server: net.Server | null = null;

	constructor(upstreamHost: string, upstreamPort: number) {
		this.upstreamHost = upstreamHost;
		this.upstreamPort = upstreamPort;
	}

	listen(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = net.createServer((down) => {
				this.connections++;
				down.pause();
				const up = net.connect(this.upstreamPort, this.upstreamHost, () => {
					down.pipe(up);
					up.pipe(down);
					down.resume();
				});
				const pair = [down, up];
				this.pairs.push(pair);

				const drop = () => {
					down.destroy();
					up.destroy();
				};

				down.on("error", drop);
				up.on("error", drop);
				down.on("close", () => up.destroy());
				up.on("close", () => down.destroy());
			});
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				this.server = server;
				resolve((server.address() as net.AddressInfo).port);
			});
		});
	}

	/** The phone loses its network: no FIN dance at the WebSocket layer. */
	killAll(): void {
		for (const [down, up] of this.pairs) {
			down.destroy();
			up.destroy();
		}

		this.pairs.length = 0;
	}

	close(): void {
		this.killAll();
		this.server?.close();
		this.server = null;
	}
}

/**
 * Log in over a *WebSocket*, then close cleanly — which is what makes
 * nefarious2 destroy a held session, so an earlier run's session cannot
 * replay into this one.
 *
 * It has to be a WebSocket: `bounce_revive_ghost()` transplants the new
 * connection's fd onto the account's persisted client struct without
 * carrying `FLAG_WEBSOCKET` over, so an account whose session was last
 * created by a plain-TCP login answers every later WebSocket login with an
 * *unframed* post-registration burst (undici: "Expected RSV1 to be clear").
 */
function resetSession(target: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(target, ["text.ircv3.net"]);
		const send = (line: string) => ws.send(`${line}\r\n`);
		let sentEnd = false;
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("timed out resetting the held session"));
		}, 20_000);

		ws.onopen = () => {
			send("CAP LS 302");
			send("CAP REQ :sasl draft/persistence message-tags server-time standard-replies");
			send(`NICK ${ACCOUNT}`);
			send(`USER ${ACCOUNT} 0 * :Seance session reset`);
		};

		ws.onerror = () => undefined;

		ws.onclose = () => {
			clearTimeout(timer);
			resolve();
		};

		ws.onmessage = (ev: MessageEvent) => {
			for (const line of String(ev.data).split(/\r?\n/)) {
				if (!line) {
					continue;
				}

				if (line.startsWith("PING")) {
					send(`PONG${line.slice(4)}`);
				} else if (/ CAP \S+ ACK /.test(line)) {
					send("AUTHENTICATE PLAIN");
				} else if (line.startsWith("AUTHENTICATE +")) {
					send(
						`AUTHENTICATE ${Buffer.from(
							`${ACCOUNT}\0${ACCOUNT}\0${PASSWORD}`,
							"utf8"
						).toString("base64")}`
					);
				} else if (/ (903|904|905|906|907) /.test(line) && !sentEnd) {
					sentEnd = true;
					send("CAP END");
				} else if (/ (376|422) /.test(line)) {
					setTimeout(() => ws.close(), 300);
				}
			}
		};
	});
}

/** A plain-TCP IRC participant, optionally logged in with SASL PLAIN. */
class TcpPeer {
	readonly lines: string[] = [];
	readonly nick: string;
	private readonly host: string;
	private readonly port: number;
	private readonly account?: {name: string; password: string};
	private sock: net.Socket | null = null;
	private buffer = "";

	constructor(
		nick: string,
		host: string,
		port: number,
		account?: {name: string; password: string}
	) {
		this.nick = nick;
		this.host = host;
		this.port = port;
		this.account = account;
	}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const sock = net.connect(this.port, this.host, () => {
				this.send("CAP LS 302");

				if (this.account) {
					this.send("CAP REQ :message-tags server-time sasl echo-message");
				}

				this.send(`NICK ${this.nick}`);
				this.send(`USER ${this.nick} 0 * :Seance cursor peer`);

				if (!this.account) {
					this.send("CAP END");
				}
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
					} else if (this.account && / CAP \S+ (ACK|NAK) /.test(line)) {
						this.send(line.includes(" ACK ") ? "AUTHENTICATE PLAIN" : "CAP END");
					} else if (this.account && line.startsWith("AUTHENTICATE +")) {
						const {name, password} = this.account;
						this.send(
							`AUTHENTICATE ${Buffer.from(
								`${name}\0${name}\0${password}`,
								"utf8"
							).toString("base64")}`
						);
					} else if (this.account && / (903|904|905|906|907) /.test(line)) {
						this.send("CAP END");
					} else if (/ 001 /.test(line)) {
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

	quit(): void {
		this.send("QUIT :done");
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
				transcript.push(`-- ${ev.type} ${JSON.stringify(ev)}`);
			}
		});
		const send = inner.send.bind(inner);

		inner.send = (line: string) => {
			transcript.push(`>> ${line}`);
			return send(line);
		};

		return inner;
	};
}

describeLive("PERSISTENCE ATTACH cursor (live nefarious2 with a bouncer)", function () {
	this.timeout(180_000);

	let dispatch: sinon.SinonSpy;
	let ownsSpy = false;
	let backend: MemoryBackend;
	let proxy: TcpProxy;
	let peer: TcpPeer;
	let client: IrcClient | undefined;
	const transcript: string[] = [];
	const events: string[] = [];
	let tcpHost = "127.0.0.1";
	let tcpPort = 16667;

	beforeEach(async function () {
		const parsed = new URL(url as string);
		tcpHost = parsed.hostname;
		tcpPort = parseInt(process.env.SEANCE_IRC_TCP_PORT ?? "16667", 10);
		transcript.length = 0;
		events.length = 0;

		const current = (socket as unknown as Record<string, unknown>).dispatch;

		if ((current as {isSinonProxy?: boolean}).isSinonProxy) {
			dispatch = current as sinon.SinonSpy;
			ownsSpy = false;
		} else {
			dispatch = sinon.stub(socket, "dispatch").callsFake((...args: unknown[]) => {
				const [event, payload] = args as [string, unknown];
				events.push(`${event} ${JSON.stringify(payload)}`);
				return false;
			});
			ownsSpy = true;
		}

		backend = new MemoryBackend();
		saved.useStorageBackend(backend);

		// A session held by an earlier run would replay into this one.
		await resetSession(url as string);
		await sleep(500);

		proxy = new TcpProxy(parsed.hostname, parseInt(parsed.port, 10) || 8067);
		const port = await proxy.listen();
		peer = new TcpPeer(PEER_ACCOUNT, tcpHost, tcpPort, {
			name: PEER_ACCOUNT,
			password: PEER_PASSWORD,
		});
		await peer.connect();
		peer.send(`JOIN ${CHANNEL}`);
		await waitFor("peer joined", () => peer.lines.some((l) => / 366 /.test(l)));

		saved.save({
			uuid: UUID,
			name: "",
			host: "127.0.0.1",
			port,
			tls: false,
			nick: ACCOUNT,
			join: CHANNEL,
			sasl: "plain",
			saslAccount: ACCOUNT,
			saslPassword: PASSWORD,
		});

		client = new IrcClient({
			uuid: UUID,
			host: "127.0.0.1",
			port,
			tls: false,
			nick: ACCOUNT,
			join: CHANNEL,
			sasl: "plain",
			saslAccount: ACCOUNT,
			saslPassword: PASSWORD,
			ids: new IdAllocator(),
			transportFactory: recordingTransport(transcript),
			// Long enough that the helper's gap lines all happen while the
			// client is down, so the server's replay is what delivers them.
			reconnect: {
				enabled: true,
				initialDelayMs: 5_000,
				maxDelayMs: 10_000,
				factor: 2,
				jitter: false,
			},
		});
	});

	afterEach(async function () {
		client?.disconnect("attach-cursor live test done");
		await sleep(300);
		peer?.quit();
		proxy?.close();
		saved.useStorageBackend(null);

		if (ownsSpy) {
			dispatch.restore();
		}

		socket.removeAllListeners();

		if (process.env.SEANCE_IRC_VERBOSE) {
			process.stderr.write(transcript.join("\n") + "\n---\n" + events.join("\n") + "\n");
		}

		client = undefined;
	});

	function payloads<T = any>(event: string, from = 0): T[] {
		return dispatch
			.getCalls()
			.slice(from)
			.filter((call) => call.args[0] === event)
			.map((call) => call.args[1] as T);
	}

	function messagesFor(chanId: number, from = 0): SharedMsg[] {
		return payloads<{chan: number; msg: SharedMsg}>("msg", from)
			.filter((p) => p.chan === chanId)
			.map((p) => p.msg);
	}

	function allMessages(from = 0): SharedMsg[] {
		return payloads<{chan: number; msg: SharedMsg}>("msg", from).map((p) => p.msg);
	}

	const sentFrom = (index: number) =>
		transcript
			.slice(index)
			.filter((l) => l.startsWith(">> "))
			.map((l) => l.slice(3));

	/** Register, join and settle; returns the channel. */
	async function connectAndJoin(): Promise<ReturnType<IrcClient["findChannel"]>> {
		const irc = client as IrcClient;
		irc.connect();
		await waitFor("init", () => payloads("init").length > 0, 30_000);
		expect(irc.account, "SASL logged in").to.equal(ACCOUNT);
		expect(
			irc.caps.value("draft/persistence"),
			"the server offers the attach-cursor token"
		).to.match(/(^|,)attach-cursor(,|$)/);
		await waitFor("JOIN", () => irc.findChannel(CHANNEL)?.state === ChanState.JOINED, 30_000);
		await sleep(1_500); // let the LATEST fill and MARKREAD land
		return irc.findChannel(CHANNEL);
	}

	it("replays the gap from the cursor and asks for no CHATHISTORY itself", async function () {
		const irc = client as IrcClient;
		const tag = Math.floor(1000 + Math.random() * 9000);
		const chan = (await connectAndJoin())!;

		// A topic, so a repeat after the reconnect would be visible.
		peer.send(`TOPIC ${CHANNEL} :cursor live topic ${tag}`);
		await sleep(500);

		// 1. The anchor: the newest thing we hold becomes the cursor.
		const anchor = `cursor anchor ${tag}`;
		peer.send(`PRIVMSG ${CHANNEL} :${anchor}`);
		await waitFor("anchor delivered", () =>
			messagesFor(chan.id).some((m) => m.text === anchor)
		);
		const anchorMsgid = messagesFor(chan.id).find((m) => m.text === anchor)?.msgid;
		expect(anchorMsgid, "the anchor carries a msgid").to.be.a("string");
		expect(irc.cursor?.msgid, "cursor followed the newest message").to.equal(anchorMsgid);

		await sleep(1_200); // the throttled write
		expect(saved.get(UUID)?.cursor?.msgid, "cursor persisted").to.equal(anchorMsgid);

		// 2. The phone loses its network.
		const dropAt = transcript.length;
		const dropCall = dispatch.getCalls().length;
		proxy.killAll();
		await waitFor(
			"transport closed",
			() => transcript.slice(dropAt).some((l) => l.startsWith("-- close")),
			15_000
		);

		// 3. The gap: three channel lines and a PM.
		const gap = [1, 2, 3].map((n) => `gap line ${tag} ${n}`);

		for (const text of gap) {
			peer.send(`PRIVMSG ${CHANNEL} :${text}`);
			await sleep(300);
		}

		const pmText = `gap pm ${tag}`;
		peer.send(`PRIVMSG ${ACCOUNT} :${pmText}`);
		await sleep(500);

		// 4. The reconnect drives itself.
		await waitFor("re-registered", () => irc.state === "registered", 60_000);
		await waitFor(
			"the server's replay finished",
			() => transcript.slice(dropAt).some((l) => l.includes("Session resumed.")),
			60_000
		);
		await sleep(1_500);

		const sent = sentFrom(dropAt);
		const attach = sent.findIndex((l) => l.startsWith("PERSISTENCE ATTACH"));
		expect(attach, "PERSISTENCE ATTACH sent on the reconnect").to.be.greaterThan(-1);
		expect(sent[attach]).to.equal(`PERSISTENCE ATTACH default ${anchorMsgid}`);
		expect(sent[attach + 1], "immediately before CAP END").to.equal("CAP END");
		expect(irc.serverReplay, "the ack was taken").to.equal(true);

		// 5. The gap arrived as live messages, once, in order.
		const replayed = messagesFor(chan.id, dropCall);
		expect(
			replayed.filter((m) => gap.includes(m.text ?? "")).map((m) => m.text),
			"the three channel lines, appended in order"
		).to.deep.equal(gap);
		expect(
			replayed.every((m) => (m.id as number) > 0),
			"appended as live ids, not history ids"
		).to.equal(true);
		expect(
			payloads<{chan: number}>("more", dropCall).filter((p) => p.chan === chan.id),
			"no `more` page for the channel"
		).to.deep.equal([]);
		expect(
			replayed.filter((m) => m.text === anchor),
			"nothing before the cursor repeated"
		).to.deep.equal([]);

		const query = irc.findChannel(PEER_ACCOUNT);
		expect(query?.type, "the PM opened a query").to.equal(ChanType.QUERY);
		expect(
			messagesFor(query!.id, dropCall).map((m) => m.text),
			"the PM, once"
		).to.deep.equal([pmText]);

		// 6. No per-channel catch-up, no re-JOIN, no visible chatter.
		expect(
			sent.filter((l) => l.startsWith("CHATHISTORY")),
			"no CHATHISTORY after the reconnect"
		).to.deep.equal([]);
		expect(
			sent.filter((l) => l.startsWith("JOIN")),
			"no re-JOIN"
		).to.deep.equal([]);

		const visible = allMessages(dropCall).map((m) => m.text ?? "");
		expect(
			visible.filter((t) => /Session resumed/.test(t)),
			"the resume NOTICE is hidden"
		).to.deep.equal([]);
		expect(
			visible.filter((t) => /cursor live topic/.test(t)),
			"the topic is not repeated"
		).to.deep.equal([]);
		expect(
			visible.filter((t) => /has joined|PERSISTENCE|Cursor msgid/.test(t)),
			"no join / persistence lines"
		).to.deep.equal([]);

		// 7. The cursor moved on and was written back.
		const newest = messagesFor(query!.id, dropCall)[0];
		expect(irc.cursor?.msgid, "cursor is the newest replayed msgid").to.equal(newest.msgid);
		await sleep(1_200);
		expect(saved.get(UUID)?.cursor?.msgid).to.equal(newest.msgid);
	});

	it("converges silently when the stored cursor is unknown to the server", async function () {
		const irc = client as IrcClient;
		const tag = Math.floor(1000 + Math.random() * 9000);
		const chan = (await connectAndJoin())!;

		const before = `pre-drop line ${tag}`;
		peer.send(`PRIVMSG ${CHANNEL} :${before}`);
		await waitFor("pre-drop line", () => messagesFor(chan.id).some((m) => m.text === before));

		// Pretend the stored cursor aged out of the server's index.
		const bogus = "f".repeat(24);
		irc.cursor = {msgid: bogus, time: Date.now()};
		saved.setCursor(UUID, irc.cursor);

		const dropAt = transcript.length;
		const dropCall = dispatch.getCalls().length;
		proxy.killAll();
		await waitFor(
			"transport closed",
			() => transcript.slice(dropAt).some((l) => l.startsWith("-- close")),
			15_000
		);

		const gap = [1, 2].map((n) => `bogus gap ${tag} ${n}`);

		for (const text of gap) {
			peer.send(`PRIVMSG ${CHANNEL} :${text}`);
			await sleep(300);
		}

		await waitFor("re-registered", () => irc.state === "registered", 60_000);
		await waitFor(
			"the server's replay finished",
			() => transcript.slice(dropAt).some((l) => l.includes("Session resumed.")),
			60_000
		);
		await sleep(1_500);

		const lines = transcript.slice(dropAt);
		expect(
			lines.some(
				(l) => l.startsWith(">> ") && l.includes(`PERSISTENCE ATTACH default ${bogus}`)
			),
			"the bogus cursor was offered"
		).to.equal(true);
		expect(
			lines.some((l) => l.startsWith("<< ") && l.includes("FAIL PERSISTENCE CURSOR_UNKNOWN")),
			"the server said CURSOR_UNKNOWN"
		).to.equal(true);

		const visible = allMessages(dropCall).map((m) => m.text ?? "");
		expect(
			visible.filter((t) =>
				/CURSOR_UNKNOWN|Cursor msgid|PERSISTENCE|Session resumed/.test(t)
			),
			"nothing about it reaches the user"
		).to.deep.equal([]);
		expect(irc.serverReplay, "the replay still runs").to.equal(true);

		// The over-wide replay is deduped by msgid, and the gap still lands.
		const after = messagesFor(chan.id, dropCall);
		expect(
			after.filter((m) => m.text === before),
			"the pre-drop line is not shown twice"
		).to.deep.equal([]);
		expect(
			after.filter((m) => gap.includes(m.text ?? "")).map((m) => m.text),
			"the gap arrived"
		).to.deep.equal(gap);
	});
});
