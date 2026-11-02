/**
 * Live integration test for IrcClient against a real nefarious2 (ircv3.2-upgrade).
 *
 * Skipped unless SEANCE_IRC_URL is set, e.g.
 *   SEANCE_IRC_URL=wss://localhost:8443/ NODE_ENV=test \
 *     pnpm exec mocha --config=test/.mocharc.yml \
 *     test/irc/client.live.ts
 *
 * A second participant joins over plain TCP (SEANCE_IRC_TCP_PORT, default 6667
 * on the same host) so joins, messages, nick changes and parts can be observed
 * from both sides. See docs/resources/nefarious2-dev.md for the dev server.
 */
import {expect} from "chai";
import net from "node:net";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {ChanState} from "../../shared/types/chan";
import {MessageType, SharedMsg} from "../../shared/types/msg";

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

/** A bare-bones IRC participant on the plain TCP port. */
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
				this.send(`USER ${this.nick} 0 * :Seance live test peer`);
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

	async waitForLine(what: string, test: (line: string) => boolean): Promise<void> {
		await waitFor(what, () => this.lines.some(test));
	}

	end(): void {
		this.sock?.end();
		this.sock = null;
	}
}

describeLive("IrcClient (live nefarious2)", function () {
	this.timeout(60_000);

	let dispatch: sinon.SinonSpy;
	let client: IrcClient;
	let peer: TcpPeer;
	const transcript: string[] = [];

	afterEach(() => {
		dispatch.restore();
		socket.removeAllListeners();
		peer?.end();

		if (process.env.SEANCE_IRC_VERBOSE) {
			process.stderr.write(transcript.join("\n") + "\n");
		}
	});

	function messages(chanId?: number): SharedMsg[] {
		return dispatch
			.getCalls()
			.filter((call) => call.args[0] === "msg")
			.map((call) => call.args[1] as {chan: number; msg: SharedMsg})
			.filter((p) => chanId === undefined || p.chan === chanId)
			.map((p) => p.msg);
	}

	function payloads<T = any>(event: string): T[] {
		return dispatch
			.getCalls()
			.filter((call) => call.args[0] === event)
			.map((call) => call.args[1] as T);
	}

	it("registers, joins #seance and exchanges traffic with a TCP participant", async function () {
		allowSelfSignedForLocalhost(url as string);
		const parsed = new URL(url as string);
		const tag = Math.floor(1000 + Math.random() * 9000);
		const tcpPort = parseInt(process.env.SEANCE_IRC_TCP_PORT ?? "6667", 10);
		dispatch = sinon.stub(socket, "dispatch").callsFake((event: string, payload: unknown) => {
			transcript.push(`${event} ${JSON.stringify(payload)}`);
			return false;
		});

		client = new IrcClient({
			host: parsed.hostname + (parsed.pathname === "/" ? "" : parsed.pathname),
			port: parseInt(parsed.port, 10) || (parsed.protocol === "wss:" ? 443 : 80),
			tls: parsed.protocol === "wss:",
			nick: `seancews${tag}`,
			join: "#seance",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			ids: new IdAllocator(),
			reconnect: {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false},
		});
		const chan = client.findChannel("#seance")!;
		const lobby = client.lobby;

		// 1. Register and auto-join.
		client.connect();
		await waitFor("init", () => payloads("init").length > 0);
		expect(client.isConnected).to.equal(true);
		expect(client.caps.hasCapability("echo-message"), "echo-message negotiated").to.equal(true);
		expect(payloads("network:status").slice(-1)[0]).to.include({connected: true});
		await waitFor("JOIN #seance", () => chan.state === ChanState.JOINED);
		await waitFor("end of NAMES", () => chan.findUser(client.nick) !== undefined);
		expect(client.host, "own host learned from the JOIN echo / 396").to.not.equal("");
		expect(
			payloads<{serverOptions: {NETWORK: string}}>("network:options").slice(-1)[0]
				.serverOptions.NETWORK
		).to.be.a("string").that.is.not.empty;

		// 2. A second participant joins over TCP.
		peer = new TcpPeer(`seancetcp${tag}`, parsed.hostname, tcpPort);
		await peer.connect();
		peer.send("JOIN #seance");
		await waitFor(
			"peer JOIN seen",
			() =>
				messages(chan.id).some(
					(m) => m.type === MessageType.JOIN && m.from?.nick === peer.nick
				) && chan.findUser(peer.nick) !== undefined
		);

		// 3. Their message reaches us...
		peer.send("PRIVMSG #seance :hello from tcp");
		await waitFor("peer message", () =>
			messages(chan.id).some((m) => m.text === "hello from tcp" && m.from?.nick === peer.nick)
		);
		const theirs = messages(chan.id).find((m) => m.text === "hello from tcp")!;
		expect(theirs.type).to.equal(MessageType.MESSAGE);
		expect(theirs.self).to.equal(false);

		// 4. ...and ours comes back as an echo (self) and reaches them.
		client.input(chan.id, "hello from ws");
		await waitFor("own echo", () =>
			messages(chan.id).some((m) => m.text === "hello from ws" && m.self === true)
		);
		await peer.waitForLine(
			"peer received our message",
			(line) =>
				line.includes("PRIVMSG #seance :hello from ws") &&
				line.startsWith(`:${client.nick}!`)
		);
		expect(messages(chan.id).filter((m) => m.text === "hello from ws")).to.have.length(1);

		// 5. Topic via /topic.
		const topic = `Seance live test ${tag}`;
		client.input(chan.id, `/topic ${topic}`);
		await waitFor("topic dispatched", () =>
			payloads<{chan: number; topic: string}>("topic").some(
				(p) => p.chan === chan.id && p.topic === topic
			)
		);
		expect(chan.shared.topic).to.equal(topic);
		expect(
			messages(chan.id).some(
				(m) => m.type === MessageType.TOPIC && m.from?.nick === client.nick
			)
		).to.equal(true);

		// 6. Peer nick change.
		peer.send(`NICK seancetcp${tag}b`);
		await waitFor("peer NICK seen", () =>
			messages(chan.id).some(
				(m) => m.type === MessageType.NICK && m.new_nick === `seancetcp${tag}b`
			)
		);
		expect(chan.findUser(peer.nick)).to.equal(undefined);
		expect(chan.findUser(`seancetcp${tag}b`)).to.not.equal(undefined);

		// 7. Peer parts.
		peer.send("PART #seance :bye");
		await waitFor("peer PART seen", () =>
			messages(chan.id).some((m) => m.type === MessageType.PART && m.text === "bye")
		);
		expect(chan.findUser(`seancetcp${tag}b`)).to.equal(undefined);

		// 8. Typing into the lobby is refused locally; an unknown command lands
		//    in the lobby as the server's error.
		client.input(lobby.id, "this is not a command");
		expect(messages(lobby.id).slice(-1)[0]).to.include({
			type: MessageType.ERROR,
			text: "Messages can not be sent to lobbies.",
		});
		client.input(chan.id, "/raw NOTACOMMAND");
		await waitFor("421 in the lobby", () =>
			messages(lobby.id).some(
				(m) => m.type === MessageType.ERROR && m.error === "unknown_command"
			)
		);

		// 9. Clean disconnect: no reconnect, network:status false.
		client.disconnect("live test done");
		await waitFor("close", () => client.state === "disconnected");
		expect(payloads("network:status").slice(-1)[0]).to.include({connected: false});
		expect(payloads("connecting")).to.have.length(1);
		peer.send("QUIT :done");
	});
});
