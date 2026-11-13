import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {IrcClient, IrcClientOptions} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {ClientRegistry, registerBusHandlers} from "../../client/js/irc/bus";
import * as saved from "../../client/js/irc/saved-networks";
import {
	loginTrusted,
	trustLogin,
	useStorageBackend as useTrustBackend,
} from "../../client/js/irc/saslTrust";
import type {SavedNetwork, StorageBackend} from "../../client/js/irc/saved-networks";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import type {SharedNetwork} from "../../shared/types/network";

/** In-memory transport driven by the tests (same shape as test/irc/client.ts). */
class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
	closeCalls = 0;
	/** The URL the client built for this transport. */
	url = "";
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

	open(): void {
		this.state = "open";
		this.emit({type: "open", subprotocol: "text.ircv3.net"});
	}

	lines(...lines: string[]): void {
		lines.forEach((line) => this.emit({type: "line", line}));
	}

	closed(code = 1006, reason = "", willReconnect = false): void {
		this.state = willReconnect ? "reconnect-wait" : "closed";
		this.emit({type: "close", code, reason, wasClean: false, willReconnect});
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

class MemoryBackend implements StorageBackend {
	data = new Map<string, string>();
	get(key: string): string | null {
		return this.data.get(key) ?? null;
	}
	set(key: string, value: string): void {
		this.data.set(key, value);
	}
	remove(key: string): void {
		this.data.delete(key);
	}
}

/**
 * A stand-in for `manager.ts` (which imports the store and so cannot load
 * under mocha): the same Map-keyed registry with a shared id allocator and
 * `networksForInit` spanning every live client.
 */
class FakeManager implements ClientRegistry {
	clients = new Map<string, IrcClient>();
	transports = new Map<string, FakeTransport>();
	ids = new IdAllocator();
	removed: string[] = [];

	createNetwork(options: Partial<IrcClientOptions> & {uuid: string; nick: string}): IrcClient {
		// A fresh transport per factory call (like WsTransport), so a client
		// that reconfigures its endpoint gets a new one; transportOf() = latest.
		const transportFactory = (opts: {url: string}) => {
			const transport = new FakeTransport();
			transport.url = opts.url;
			this.transports.set(options.uuid, transport);

			return transport;
		};

		const client = new IrcClient({
			host: `${options.uuid}.test`,
			port: 8443,
			tls: true,
			join: "",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			ids: this.ids,
			transportFactory,
			networksForInit: () => Array.from(this.clients.values()).map((c) => c.network),
			...options,
		});
		this.clients.set(client.uuid, client);
		client.connect();
		return client;
	}

	clientForNetwork(uuid: string): IrcClient | undefined {
		return this.clients.get(uuid);
	}

	clientForChannel(chanId: number): IrcClient | undefined {
		for (const client of this.clients.values()) {
			if (client.channelById(chanId)) {
				return client;
			}
		}

		return undefined;
	}

	allClients(): IrcClient[] {
		return Array.from(this.clients.values());
	}

	remove(uuid: string): void {
		this.removed.push(uuid);
		this.clients.delete(uuid);
	}

	transportOf(client: IrcClient): FakeTransport {
		return this.transports.get(client.uuid) as FakeTransport;
	}
}

let dispatch: sinon.SinonSpy;
/** Whether this file installed the spy (test/irc/client.ts has a root-level one). */
let ownsSpy = false;
let manager: FakeManager;
let backend: MemoryBackend;

function setUp(): void {
	const current = (socket as unknown as Record<string, unknown>).dispatch;

	if ((current as {isSinonProxy?: boolean}).isSinonProxy) {
		dispatch = current as sinon.SinonSpy;
		ownsSpy = false;
	} else {
		dispatch = sinon.spy(socket, "dispatch");
		ownsSpy = true;
	}

	manager = new FakeManager();
	backend = new MemoryBackend();
	saved.useStorageBackend(backend);
	registerBusHandlers(socket, manager);
}

function tearDown(): void {
	// Close every socket: a registered client holds timers (the mute read,
	// the resume check) that would keep a lone run of this file waiting.
	for (const t of manager?.transports.values() ?? []) {
		if (t.state === "open") {
			t.closed(1000);
		}
	}

	if (ownsSpy) {
		dispatch.restore();
	}

	socket.removeAllListeners();
	saved.useStorageBackend(null);
}

function payloads<T = any>(event: string): T[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === event)
		.map((call) => call.args[1] as T);
}

/** Drive one client through CAP / 001 / 005 / 422 as `nick`. */
function register(client: IrcClient): void {
	const transport = manager.transportOf(client);
	const nick = client.nick;
	transport.open();
	transport.lines(`:irc.test CAP * LS :multi-prefix echo-message server-time`);
	const req = transport.sent.find((l) => l.startsWith("CAP REQ :")) as string;
	transport.lines(`:irc.test CAP ${nick} ACK :${req.slice("CAP REQ :".length)}`);
	transport.lines(
		`:irc.test 001 ${nick} :Welcome, ${nick}`,
		`:irc.test 005 ${nick} CHANTYPES=#& PREFIX=(ov)@+ NETWORK=${client.uuid.toUpperCase()} :are supported`,
		`:irc.test 422 ${nick} :MOTD File is missing`
	);
}

function joined(client: IrcClient, channel: string): number {
	const transport = manager.transportOf(client);
	const nick = client.nick;
	transport.lines(
		`:${nick}!${nick}@host JOIN ${channel}`,
		`:irc.test 353 ${nick} = ${channel} :@${nick} bob`,
		`:irc.test 366 ${nick} ${channel} :End of /NAMES list.`
	);
	return client.findChannel(channel)!.id;
}

describe("multiple networks", function () {
	beforeEach(setUp);
	afterEach(tearDown);

	it("keeps both networks in every init and allocates unique channel ids", function () {
		const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
		const b = manager.createNetwork({uuid: "net-b", nick: "alice", join: "#two"});

		const announced = payloads<{network: SharedNetwork}>("network");
		expect(announced.map((p) => p.network.uuid)).to.deep.equal(["net-a", "net-b"]);

		register(a);
		let inits = payloads<{active: number; networks: SharedNetwork[]}>("init");
		expect(inits).to.have.length(1);
		expect(inits[0].networks.map((n) => n.uuid)).to.deep.equal(["net-a", "net-b"]);
		expect(inits[0].networks[0].status.connected).to.equal(true);
		expect(inits[0].networks[1].status.connected).to.equal(false);

		register(b);
		inits = payloads("init");
		expect(inits).to.have.length(2);
		expect(inits[1].networks.map((n) => n.uuid)).to.deep.equal(["net-a", "net-b"]);
		expect(inits[1].networks.every((n) => n.status.connected)).to.equal(true);
		expect(inits[1].networks.map((n) => n.name)).to.deep.equal(["NET-A", "NET-B"]);

		const ids = inits[1].networks.flatMap((n) => n.channels.map((c) => c.id));
		expect(new Set(ids).size).to.equal(ids.length);
		expect(inits[1].active).to.equal(b.findChannel("#two")!.id);

		const status = payloads<{network: string; connected: boolean}>("network:status");
		expect(status).to.deep.include({
			network: "net-a",
			connected: true,
			connecting: false,
			secure: true,
		});
		expect(status).to.deep.include({
			network: "net-b",
			connected: true,
			connecting: false,
			secure: true,
		});
	});

	it("routes input, names, more and open by channel id to the owning client", function () {
		const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
		const b = manager.createNetwork({uuid: "net-b", nick: "alice", join: "#two"});
		register(a);
		register(b);
		const one = joined(a, "#one");
		const two = joined(b, "#two");
		const ta = manager.transportOf(a);
		const tb = manager.transportOf(b);
		const sentA = ta.sent.length;
		const sentB = tb.sent.length;

		socket.emit("input", {target: two, text: "hello two"});
		expect(tb.sent.slice(sentB)).to.deep.equal(["PRIVMSG #two :hello two"]);
		expect(ta.sent).to.have.length(sentA);

		socket.emit("input", {target: one, text: "/nick alice1"});
		expect(ta.sent.slice(sentA)).to.deep.equal(["NICK alice1"]);
		expect(tb.sent).to.have.length(sentB + 1);

		socket.emit("names", {target: two});
		const [names] = payloads<{id: number; users: {nick: string}[]}>("names");
		expect(names.id).to.equal(two);
		expect(names.users.map((u) => u.nick)).to.deep.equal(["alice", "bob"]);

		socket.emit("more", {target: one, lastId: -1, condensed: false});
		expect(payloads<{chan: number}>("more")[0].chan).to.equal(one);

		// Unread counting follows the open channel across networks.
		ta.lines(":bob!bob@host PRIVMSG #one :ping a");
		tb.lines(":bob!bob@host PRIVMSG #two :ping b");
		expect(a.findChannel("#one")!.shared.unread).to.equal(1);
		expect(b.findChannel("#two")!.shared.unread).to.equal(1);
		socket.emit("open", two);
		expect(b.findChannel("#two")!.shared.unread).to.equal(0);
		expect(a.findChannel("#one")!.shared.unread).to.equal(1);
		tb.lines(":bob!bob@host PRIVMSG #two :ping b again");
		expect(b.findChannel("#two")!.shared.unread).to.equal(0);
	});

	it("quitting one network leaves the other untouched", function () {
		const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
		const b = manager.createNetwork({uuid: "net-b", nick: "alice", join: "#two"});
		register(a);
		register(b);
		const one = joined(a, "#one");
		const two = joined(b, "#two");
		const ta = manager.transportOf(a);
		const tb = manager.transportOf(b);

		socket.emit("input", {target: two, text: "/quit bye"});
		expect(payloads<{network: string}>("quit")).to.deep.equal([{network: "net-b"}]);
		expect(manager.removed).to.deep.equal(["net-b"]);
		expect(tb.sent[tb.sent.length - 1]).to.equal("QUIT :bye");
		expect(tb.closeCalls).to.equal(1);
		tb.closed(1000);

		expect(ta.closeCalls).to.equal(0);
		expect(a.isConnected).to.equal(true);
		expect(a.findChannel("#one")!.users.size).to.equal(2);
		expect(manager.clientForChannel(one)).to.equal(a);
		expect(manager.clientForChannel(two)).to.equal(undefined);

		const statuses = payloads<{network: string; connected: boolean; connecting: boolean}>(
			"network:status"
		);
		expect(
			statuses.filter((s) => s.network === "net-a" && !s.connected && !s.connecting)
		).to.have.length(0);

		// A later (re)registration of the survivor no longer mentions the quitter.
		ta.closed(1006, "gone");
		register(a);
		const inits = payloads<{networks: SharedNetwork[]}>("init");
		expect(inits[inits.length - 1].networks.map((n) => n.uuid)).to.deep.equal(["net-a"]);
	});

	it("a dropped connection only affects its own network", function () {
		const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
		const b = manager.createNetwork({uuid: "net-b", nick: "alice", join: "#two"});
		register(a);
		register(b);
		joined(a, "#one");
		const two = joined(b, "#two");

		manager.transportOf(a).closed(1006, "connection reset");

		expect(a.isConnected).to.equal(false);
		expect(a.findChannel("#one")!.users.size).to.equal(0);
		expect(b.isConnected).to.equal(true);
		expect(b.findChannel("#two")!.users.size).to.equal(2);

		const down = payloads<{network: string; connected: boolean; connecting: boolean}>(
			"network:status"
		).filter((s) => !s.connected && !s.connecting);
		expect(down).to.deep.equal([
			{network: "net-a", connected: false, connecting: false, secure: true},
		]);
		expect(manager.clientForNetwork("net-a")).to.equal(a);

		socket.emit("input", {target: two, text: "still here"});
		const tb = manager.transportOf(b);
		expect(tb.sent[tb.sent.length - 1]).to.equal("PRIVMSG #two :still here");
	});

	describe("network:get / network:edit against the saved store", function () {
		function stored(overrides: Partial<SavedNetwork> = {}): SavedNetwork {
			return saved.save({
				uuid: "net-a",
				name: "",
				host: "net-a.test",
				port: 8443,
				tls: true,
				nick: "alice",
				join: "#one",
				sasl: "plain",
				saslAccount: "alice",
				saslPassword: "pw",
				rememberPassword: true,
				commands: ["/msg NickServ IDENTIFY pw"],
				...overrides,
			});
		}

		it("merges the saved entry with live state for network:get", function () {
			stored({name: "Home"});
			const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
			register(a);
			manager.transportOf(a).lines(":alice!alice@host NICK :alice_");

			socket.emit("network:get", "net-a");
			const [info] = payloads<Record<string, unknown>>("network:info");
			expect(info).to.include({
				uuid: "net-a",
				name: "Home",
				nick: "alice_",
				host: "net-a.test",
				sasl: "plain",
				saslAccount: "alice",
				saslPassword: "pw",
				connected: true,
			});
			expect(info.commands).to.deep.equal(["/msg NickServ IDENTIFY pw"]);
		});

		it("answers network:get for a saved network that is not live, and stays silent for unknown ones", function () {
			stored();
			socket.emit("network:get", "net-a");
			socket.emit("network:get", "nope");

			const infos = payloads<Record<string, unknown>>("network:info");
			expect(infos).to.have.length(1);
			expect(infos[0]).to.include({uuid: "net-a", host: "net-a.test", connected: false});
		});

		it("editing the credentials of a network with no live client forgets its login", function () {
			useTrustBackend(backend);

			try {
				stored({sasl: "plain", saslAccount: "alice", saslPassword: "hunter2"});
				trustLogin("net-a", "alice");

				// A blank password field keeps the remembered one: nothing changed.
				socket.emit("network:edit", {
					uuid: "net-a",
					host: "net-a.test",
					port: "8443",
					nick: "alice",
					sasl: "plain",
					saslAccount: "alice",
					saslPassword: "",
					rememberPassword: "on",
				});
				expect(loginTrusted("net-a", "alice")).to.equal(true);

				socket.emit("network:edit", {
					uuid: "net-a",
					host: "net-a.test",
					port: "8443",
					nick: "alice",
					sasl: "plain",
					saslAccount: "alice",
					saslPassword: "hunter3",
					rememberPassword: "on",
				});
				expect(loginTrusted("net-a", "alice")).to.equal(false);
			} finally {
				useTrustBackend(null);
			}
		});

		it("network:edit saves, sends NICK when connected and renames live", function () {
			stored();
			const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
			register(a);
			const ta = manager.transportOf(a);
			const mark = ta.sent.length;

			socket.emit("network:edit", {
				uuid: "net-a",
				name: "Home",
				host: "new.test",
				port: "8067",
				nick: "alice2",
				join: "#one, #two",
				sasl: "plain",
				saslAccount: "alice",
				saslPassword: "",
				commands: "/join #late",
				rememberPassword: "on",
			});

			expect(ta.sent.slice(mark)).to.deep.equal(["NICK alice2"]);
			expect(a.name).to.equal("Home");
			expect(payloads<{uuid: string; name: string}>("network:name")).to.deep.include({
				uuid: "net-a",
				name: "Home",
			});

			const entry = saved.get("net-a");
			expect(entry).to.include({
				name: "Home",
				host: "new.test",
				port: 8067,
				tls: false,
				nick: "alice2",
				join: "#one, #two",
				saslPassword: "pw",
			});
			expect(entry?.commands).to.deep.equal(["/join #late"]);

			const infos = payloads<Record<string, unknown>>("network:info");
			expect(infos[infos.length - 1]).to.include({uuid: "net-a", name: "Home"});
		});

		describe("a blank password when the password is not remembered (#189)", function () {
			function live(): IrcClient {
				stored({rememberPassword: false});
				expect(saved.get("net-a")?.saslPassword).to.equal("");
				const a = manager.createNetwork({
					uuid: "net-a",
					nick: "alice",
					join: "#one",
					sasl: "plain",
					saslAccount: "alice",
					saslPassword: "pw",
				});
				// Waiting to reconnect, so the edit applies at once (applySettings).
				manager.transportOf(a).closed(1006, "", true);
				return a;
			}

			const form = (overrides: Record<string, unknown> = {}) => ({
				uuid: "net-a",
				host: "net-a.test",
				port: "8443",
				tls: "on",
				nick: "alice",
				join: "#one, #two",
				sasl: "plain",
				saslAccount: "alice",
				saslPassword: "",
				...overrides,
			});

			it("keeps the running connection's password, without writing it to disk", function () {
				const a = live();

				socket.emit("network:edit", form());

				expect(a.options.saslPassword).to.equal("pw");
				expect(saved.get("net-a")).to.include({join: "#one, #two", saslPassword: ""});
				expect(saved.needsPassword(saved.get("net-a")!)).to.equal(true);
			});

			it("keeps it across an account change, as a remembered one is kept", function () {
				const a = live();

				socket.emit("network:edit", form({saslAccount: "bob"}));

				expect(a.options).to.include({saslAccount: "bob", saslPassword: "pw"});
			});

			it("keeps it for a missing or whitespace-only field", function () {
				const a = live();

				socket.emit("network:edit", form({saslPassword: "   "}));
				expect(a.options.saslPassword).to.equal("pw");

				const {saslPassword: _omitted, ...rest} = form();
				socket.emit("network:edit", rest);
				expect(a.options.saslPassword).to.equal("pw");
			});

			it("writes it to disk when Remember is switched on in the same edit", function () {
				const a = live();

				socket.emit("network:edit", form({rememberPassword: "on"}));

				expect(a.options.saslPassword).to.equal("pw");
				expect(saved.get("net-a")?.saslPassword).to.equal("pw");
			});

			it("keeps a password typed in an earlier edit that is still waiting for the next connect", function () {
				stored({rememberPassword: false});
				const a = manager.createNetwork({
					uuid: "net-a",
					nick: "alice",
					join: "#one",
					sasl: "plain",
					saslAccount: "alice",
					saslPassword: "old",
				});

				socket.emit("network:edit", form({saslPassword: "new"}));
				socket.emit("network:edit", form());

				expect(a.options.saslPassword).to.equal("old"); // still connecting
				expect(a.nextOptions.saslPassword).to.equal("new");
			});

			it("does not forget the login of an unchanged network with no live client", function () {
				useTrustBackend(backend);

				try {
					stored({rememberPassword: false});
					trustLogin("net-a", "alice");

					socket.emit("network:edit", form());

					expect(loginTrusted("net-a", "alice")).to.equal(true);
				} finally {
					useTrustBackend(null);
				}
			});

			it("takes a password typed into the form", function () {
				const a = live();

				socket.emit("network:edit", form({saslPassword: "new"}));

				expect(a.options.saslPassword).to.equal("new");
				expect(saved.get("net-a")?.saslPassword).to.equal("");
			});
		});

		it("network:edit switches host/port/TLS at once and retries while waiting to reconnect", function () {
			stored();
			const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
			const before = manager.transportOf(a);
			expect(before.url).to.equal("wss://net-a.test:8443/");
			before.closed(1006, "", true); // the transport is now in backoff

			socket.emit("network:edit", {
				uuid: "net-a",
				host: "net-a.test",
				port: "8067",
				nick: "alice",
				join: "#one",
			});

			const after = manager.transportOf(a);
			expect(after).to.not.equal(before);
			expect(before.closeCalls).to.equal(1);
			expect(after.url).to.equal("ws://net-a.test:8067/");
			expect(after.state).to.equal("connecting");
			expect(a.options).to.include({host: "net-a.test", port: 8067, tls: false});

			const texts = payloads<{chan: number; msg: {text?: string}}>("msg")
				.filter((p) => p.chan === a.lobby.id)
				.map((p) => p.msg.text);
			expect(texts[texts.length - 1]).to.equal("Connecting to net-a.test:8067…");
		});

		it("network:edit while connected waits for the next connect, then uses the new endpoint", function () {
			stored();
			const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
			register(a);
			const live = manager.transportOf(a);

			socket.emit("network:edit", {
				uuid: "net-a",
				host: "other.test",
				port: "8067",
				nick: "alice",
				join: "#one, #two",
				sasl: "plain",
				saslAccount: "alice",
				saslPassword: "",
			});

			// Nothing happens to the live connection.
			expect(manager.transportOf(a)).to.equal(live);
			expect(live.state).to.equal("open");
			expect(live.closeCalls).to.equal(0);
			expect(a.options).to.include({host: "net-a.test", port: 8443, tls: true});

			// The automatic reconnect after a drop goes to the new endpoint.
			live.closed(1006, "connection reset", true);
			const next = manager.transportOf(a);
			expect(next).to.not.equal(live);
			expect(live.closeCalls).to.equal(1);
			expect(next.url).to.equal("ws://other.test:8067/");
			expect(next.state).to.equal("connecting");
			expect(a.options).to.include({
				host: "other.test",
				port: 8067,
				tls: false,
				join: "#one, #two",
				saslPassword: "pw",
			});
		});

		it("network:edit of non-endpoint fields never replaces the transport", function () {
			stored();
			const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
			const t = manager.transportOf(a);
			t.closed(1006, "", true);

			socket.emit("network:edit", {
				uuid: "net-a",
				host: "net-a.test",
				port: "8443",
				tls: "on",
				nick: "alice",
				join: "#one, #three",
			});

			expect(manager.transportOf(a)).to.equal(t);
			expect(t.closeCalls).to.equal(0);
			expect(t.state).to.equal("reconnect-wait");
			expect(a.options).to.include({port: 8443, tls: true, join: "#one, #three"});
		});

		it("network:edit applies the nick locally when disconnected and seeds unsaved networks", function () {
			const a = manager.createNetwork({uuid: "net-a", nick: "alice", join: "#one"});
			expect(saved.get("net-a")).to.equal(undefined);

			socket.emit("network:edit", {uuid: "net-a", nick: "alice3", host: "net-a.test"});

			expect(a.nick).to.equal("alice3");
			expect(payloads<{network: string; nick: string}>("nick")).to.deep.include({
				network: "net-a",
				nick: "alice3",
			});
			expect(saved.get("net-a")).to.include({host: "net-a.test", nick: "alice3", tls: false});

			socket.emit("network:edit", {uuid: "unknown", nick: "x"});
			expect(saved.get("unknown")).to.equal(undefined);
		});
	});

	describe("presence mode through the bus (network:presence-mode, network:edit, dnd:cleared)", function () {
		function stored(): SavedNetwork {
			return saved.save({
				uuid: "net-a",
				name: "",
				host: "net-a.test",
				port: 8443,
				tls: true,
				nick: "alice",
				join: "",
				sasl: "",
				saslAccount: "",
				saslPassword: "",
			});
		}

		/** Register with an account and the metadata cap, the mute list read empty. */
		function registerWithMute(client: IrcClient): FakeTransport {
			const t = manager.transportOf(client);
			t.open();
			t.lines(`:irc.test CAP * LS :server-time message-tags batch draft/metadata-2`);
			const req = t.sent.find((l) => l.startsWith("CAP REQ :")) as string;
			t.lines(
				`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`,
				":irc.test 001 alice :Welcome",
				":irc.test 900 alice alice!a@h alice :You are now logged in as alice",
				":irc.test 422 alice :MOTD File is missing",
				":irc.test 766 alice alice draft/webpush/mute :key not set"
			);
			return t;
		}

		it("network:presence-mode saves a saved network's mode and applies it", function () {
			stored();
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			socket.emit("network:presence-mode", {network: "net-a", mode: "away"});
			expect(a.presenceMode).to.equal("away");
			expect(saved.get("net-a")?.presenceMode).to.equal("away");
			socket.emit("network:presence-mode", {network: "net-a", mode: "auto"});
			expect(a.presenceMode).to.equal("auto");
			// An explicit auto is kept: no key is Same as global now.
			expect(saved.get("net-a")?.presenceMode).to.equal("auto");
		});

		it("network:presence-mode on an unsaved network applies it and saves nothing", function () {
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			socket.emit("network:presence-mode", {network: "net-a", mode: "dnd"});
			expect(a.presenceMode).to.equal("dnd");
			expect(saved.get("net-a")).to.equal(undefined);
		});

		it("network:edit of an unsaved network keeps the mode the dot set", function () {
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			socket.emit("network:presence-mode", {network: "net-a", mode: "dnd"});
			// The form posts no presenceMode when its select was not touched.
			socket.emit("network:edit", {uuid: "net-a", nick: "alice", host: "net-a.test"});
			expect(a.presenceMode).to.equal("dnd");
			expect(saved.get("net-a")?.presenceMode).to.equal("dnd");
		});

		it("network:edit of a saved network keeps the mode the dot set", function () {
			stored();
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			socket.emit("network:presence-mode", {network: "net-a", mode: "away"});
			socket.emit("network:edit", {uuid: "net-a", nick: "alice", host: "net-a.test"});
			expect(a.presenceMode).to.equal("away");
			expect(saved.get("net-a")?.presenceMode).to.equal("away");
		});

		it("another device's mute clear leaves a shared mode dnd as it is (probe C)", function () {
			// The mode is the shared choice (irc/presenceShare.ts): a device that
			// leaves dnd sends its new mode through seance/presence. Resetting it
			// to auto here would stamp a newer choice than the one that cleared
			// the mute, and every device would adopt auto instead.
			stored();
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			const t = registerWithMute(a);
			socket.emit("network:presence-mode", {network: "net-a", mode: "dnd"});
			const at = a.presenceAt;
			const set = t.sent.find((l) =>
				l.startsWith("METADATA * SET draft/webpush/mute")
			) as string;
			const value = set.split("private :")[1];
			t.lines(
				`:irc.test 761 alice alice draft/webpush/mute private :${value}`,
				`:irc.test METADATA alice draft/webpush/mute * :${value}`
			);
			const mark = t.sent.length;
			t.lines(":irc.test METADATA alice draft/webpush/mute *");
			expect(a.presenceMode).to.equal("dnd");
			expect(a.presenceAt).to.equal(at);
			expect(saved.get("net-a")?.presenceMode).to.equal("dnd");
			const after = t.sent.slice(mark);
			expect(after.filter((l) => l.includes("seance/presence"))).to.deep.equal([]);
			expect(after).to.not.include("AWAY");
		});

		it("dnd:cleared leaves a network in another mode as it is", function () {
			stored();
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			socket.emit("network:presence-mode", {network: "net-a", mode: "away"});
			socket.dispatch("dnd:cleared", {network: "net-a"});
			expect(a.presenceMode).to.equal("away");
			expect(saved.get("net-a")?.presenceMode).to.equal("away");
		});

		it("network:presence-mode global clears the saved mode and follows the global one", function () {
			saved.save({...stored(), presenceMode: "away"});
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			socket.emit("network:presence-mode", {network: "net-a", mode: "global"});
			expect(a.presenceMode).to.equal("global");
			expect(saved.get("net-a")).to.not.have.property("presenceMode");
			expect(saved.get("net-a")?.presenceAt).to.be.a("number");
		});

		it("a choice on the dot is stamped, on the client and the saved entry", function () {
			stored();
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			const before = Date.now();
			socket.emit("network:presence-mode", {network: "net-a", mode: "away"});
			expect(saved.get("net-a")?.presenceAt).to.be.at.least(before);
			expect(a.presenceAt).to.equal(saved.get("net-a")?.presenceAt);
		});

		it("network:presence-shared saves the adopted mode and its time", function () {
			stored();
			manager.createNetwork({uuid: "net-a", nick: "alice"});
			socket.dispatch("network:presence-shared", {
				network: "net-a",
				mode: "dnd",
				at: 1792000000000,
			});
			expect(saved.get("net-a")?.presenceMode).to.equal("dnd");
			expect(saved.get("net-a")?.presenceAt).to.equal(1792000000000);
		});

		it("network:edit never takes the mode's time from the form (its defaults may be stale)", function () {
			saved.save({...stored(), presenceMode: "away", presenceAt: 1000});
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			a.setPresenceMode("away", 1000);
			// Adopted from another device while the form was open:
			socket.dispatch("network:presence-shared", {network: "net-a", mode: "away", at: 2000});
			a.setPresenceMode("away", 2000);
			// The form posts its defaults back, the old time among them.
			socket.emit("network:edit", {
				uuid: "net-a",
				nick: "alice2",
				host: "net-a.test",
				presenceMode: "away",
				presenceAt: 1000,
			});
			expect(saved.get("net-a")?.presenceAt).to.equal(2000);
			expect(a.presenceAt).to.equal(2000);
		});

		it("network:edit of an unsaved network keeps the dot's time", function () {
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			socket.emit("network:presence-mode", {network: "net-a", mode: "dnd"});
			const at = a.presenceAt;
			socket.emit("network:edit", {uuid: "net-a", nick: "alice", host: "net-a.test"});
			expect(saved.get("net-a")?.presenceAt).to.equal(at);
		});

		it("network:edit with a new mode stamps it; with the same mode stamps nothing", function () {
			saved.save({...stored(), presenceMode: "away", presenceAt: 1000});
			const a = manager.createNetwork({uuid: "net-a", nick: "alice"});
			a.setPresenceMode("away", 1000);
			socket.emit("network:edit", {
				uuid: "net-a",
				nick: "alice",
				host: "net-a.test",
				presenceMode: "away",
			});
			expect(saved.get("net-a")?.presenceAt).to.equal(1000);
			expect(a.presenceAt).to.equal(1000);

			socket.emit("network:edit", {
				uuid: "net-a",
				nick: "alice",
				host: "net-a.test",
				presenceMode: "online",
			});
			expect(saved.get("net-a")?.presenceAt).to.be.greaterThan(1000);
			expect(a.presenceMode).to.equal("online");
			expect(a.presenceAt).to.equal(saved.get("net-a")?.presenceAt);
		});
	});
});
