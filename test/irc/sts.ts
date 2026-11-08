/**
 * STS (docs/projects/initial_conversion.md D.6): the policy store in sts.ts
 * and the IrcClient wiring — insecure → secure reconnect on `port=`, policy
 * caching on `duration=`, and the connect-time upgrade from a cached policy.
 */
import {expect} from "chai";
import sinon from "sinon";
import {ChanState} from "../../shared/types/chan";
import storage from "../../client/js/localStorage";
import {IrcClient, IrcClientOptions} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import * as sts from "../../client/js/irc/sts";
import type {ConnectOptions, Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportOptions, TransportState} from "../../client/js/irc/transport";
import type {SharedMsg} from "../../shared/types/msg";

/** Replace the localStorage wrapper with an in-memory map for the test. */
function fakeStorage(): Map<string, string> {
	const data = new Map<string, string>();
	sinon.stub(storage, "get").callsFake((key: string) => data.get(key) ?? null);
	sinon.stub(storage, "set").callsFake((key: string, value: string) => void data.set(key, value));
	sinon.stub(storage, "remove").callsFake((key: string) => void data.delete(key));
	return data;
}

class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
	connectCalls = 0;
	closeCalls = 0;
	private listeners: ((ev: TransportEvent) => void)[] = [];
	readonly url: string;

	constructor(url: string) {
		this.url = url;
	}

	on(listener: (ev: TransportEvent) => void): () => void {
		this.listeners.push(listener);

		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	connect(): void {
		this.connectCalls++;
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

	line(line: string): void {
		this.emit({type: "line", line});
	}

	closed(code = 1000): void {
		this.state = "closed";
		this.emit({type: "close", code, reason: "", wasClean: true, willReconnect: false});
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

const BASE: ConnectOptions = {
	host: "irc.example.org",
	port: 8067,
	tls: false,
	nick: "alice",
	join: "",
	sasl: "",
	saslAccount: "",
	saslPassword: "",
};

interface Harness {
	client: IrcClient;
	transports: FakeTransport[];
	dispatch: sinon.SinonSpy;
	lobbyTexts(): string[];
}

function setup(overrides: Partial<IrcClientOptions> = {}): Harness {
	const transports: FakeTransport[] = [];
	const dispatch = sinon.spy();
	const client = new IrcClient({
		...BASE,
		ids: new IdAllocator(),
		bus: {dispatch},
		transportFactory(opts: TransportOptions) {
			const t = new FakeTransport(opts.url);
			transports.push(t);
			return t;
		},
		...overrides,
	});

	return {
		client,
		transports,
		dispatch,
		lobbyTexts: () =>
			dispatch
				.getCalls()
				.filter((call) => call.args[0] === "msg")
				.map((call) => (call.args[1] as {msg: SharedMsg}).msg.text ?? ""),
	};
}

describe("STS", function () {
	let data: Map<string, string>;
	let clock: sinon.SinonFakeTimers;
	const T0 = 1_700_000_000_000;

	beforeEach(function () {
		data = fakeStorage();
		clock = sinon.useFakeTimers({now: T0, toFake: ["Date"]});
	});

	afterEach(function () {
		clock.restore();
		sinon.restore();
	});

	describe("parseStsValue", function () {
		it("reads port, duration and preload; ignores junk", function () {
			expect(sts.parseStsValue("port=6697,duration=300,preload")).to.deep.equal({
				port: 6697,
				duration: 300,
				preload: true,
			});
			expect(sts.parseStsValue("duration=0")).to.deep.equal({duration: 0, preload: false});
			expect(sts.parseStsValue("port=abc,duration=-5,foo=bar,PORT=70000")).to.deep.equal({
				preload: false,
			});
			expect(sts.parseStsValue("")).to.deep.equal({preload: false});
		});
	});

	describe("policy store", function () {
		it("stores under thelounge.sts keyed by lower-cased bare host", function () {
			sts.setPolicy("wss://IRC.Example.ORG/ws", {
				port: 8443,
				expiresAt: T0 + 1000,
				preload: true,
			});

			const stored = JSON.parse(data.get(sts.STORAGE_KEY) ?? "{}");
			expect(Object.keys(stored)).to.deep.equal(["irc.example.org"]);
			expect(sts.getPolicy("irc.example.org")).to.deep.equal({
				port: 8443,
				expiresAt: T0 + 1000,
				preload: true,
			});
			expect(sts.getPolicy("other.example.org")).to.equal(undefined);
		});

		it("expires policies and clearExpired drops them from storage", function () {
			sts.setPolicy("a.example", {port: 1, expiresAt: T0 + 1000, preload: false});
			sts.setPolicy("b.example", {port: 2, expiresAt: T0 + 5000, preload: false});

			clock.tick(1000);
			expect(sts.getPolicy("a.example")).to.equal(undefined);
			expect(sts.getPolicy("b.example")?.port).to.equal(2);

			sts.clearExpired();
			expect(Object.keys(JSON.parse(data.get(sts.STORAGE_KEY) ?? "{}"))).to.deep.equal([
				"b.example",
			]);

			clock.tick(5000);
			sts.clearExpired();
			expect(data.has(sts.STORAGE_KEY)).to.equal(false);
		});

		it("applyDuration caches for duration seconds and duration=0 deletes", function () {
			const policy = sts.applyDuration("irc.example.org", 8443, {
				duration: 300,
				preload: true,
			});
			expect(policy).to.deep.equal({
				port: 8443,
				expiresAt: T0 + 300_000,
				preload: true,
				duration: 300,
			});
			expect(sts.getPolicy("irc.example.org")?.preload).to.equal(true);

			sts.applyDuration("irc.example.org", 8443, {duration: 0, preload: false});
			expect(sts.getPolicy("irc.example.org")).to.equal(undefined);
			expect(data.has(sts.STORAGE_KEY)).to.equal(false);

			// No duration: nothing to store.
			sts.applyDuration("irc.example.org", 8443, {port: 6697, preload: false});
			expect(sts.getPolicy("irc.example.org")).to.equal(undefined);
		});

		it("refreshPolicy reschedules the expiry from now", function () {
			sts.applyDuration("irc.example.org", 8443, {duration: 300, preload: false});
			clock.tick(200_000);
			sts.refreshPolicy("irc.example.org");
			expect(sts.getPolicy("irc.example.org")?.expiresAt).to.equal(T0 + 500_000);
		});

		it("tolerates corrupt storage", function () {
			data.set(sts.STORAGE_KEY, "{not json");
			expect(sts.getPolicy("irc.example.org")).to.equal(undefined);
			expect(data.has(sts.STORAGE_KEY)).to.equal(false);

			data.set(
				sts.STORAGE_KEY,
				JSON.stringify({"irc.example.org": {port: "x"}, ok: {port: 5, expiresAt: T0 + 1}})
			);
			expect(sts.allPolicies()).to.deep.equal({
				ok: {port: 5, expiresAt: T0 + 1, preload: false},
			});
		});
	});

	describe("upgradeOptions", function () {
		it("returns the same object when there is no policy or tls is already on", function () {
			expect(sts.upgradeOptions(BASE)).to.equal(BASE);
			const secure = {...BASE, tls: true, port: 8443};
			sts.setPolicy("irc.example.org", {port: 9999, expiresAt: T0 + 1000, preload: false});
			expect(sts.upgradeOptions(secure)).to.equal(secure);
		});

		it("switches tls on and uses the policy port, but not once expired", function () {
			sts.setPolicy("irc.example.org", {port: 8443, expiresAt: T0 + 1000, preload: false});
			const upgraded = sts.upgradeOptions(BASE);
			expect(upgraded).to.not.equal(BASE);
			expect(upgraded).to.deep.equal({...BASE, tls: true, port: 8443});

			clock.tick(1000);
			expect(sts.upgradeOptions(BASE)).to.equal(BASE);
		});
	});

	describe("IrcClient", function () {
		it("on an insecure connection, sts port= reconnects securely exactly once", function () {
			const h = setup();
			h.client.connect();
			const [plain] = h.transports;
			expect(plain.url).to.equal("ws://irc.example.org:8067/");
			plain.open();
			plain.line(":irc.example.org CAP * LS * :multi-prefix");
			expect(h.transports).to.have.length(1);
			plain.line(":irc.example.org CAP * LS :sts=port=8443,duration=300 server-time");

			expect(plain.sent.some((l) => l.startsWith("QUIT"))).to.equal(true);
			expect(plain.closeCalls).to.equal(1);
			expect(h.transports).to.have.length(2);
			const secure = h.transports[1];
			expect(secure.url).to.equal("wss://irc.example.org:8443/");
			expect(secure.connectCalls).to.equal(1);
			expect(h.client.options.tls).to.equal(true);
			expect(h.client.options.port).to.equal(8443);
			expect(h.client.network.status.secure).to.equal(true);
			expect(h.lobbyTexts()).to.include(
				"Server requires a secure connection (STS): reconnecting on port 8443…"
			);
			// The insecure socket is torn down now (its close event is not ours
			// any more) and quietly: the line above said why.
			expect(h.lobbyTexts()).to.not.include("Disconnected.");
			// Nothing is cached from an insecure connection.
			expect(sts.getPolicy("irc.example.org")).to.equal(undefined);

			// The old socket's late close is ignored; the new one registers normally.
			plain.closed();
			expect(h.client.state).to.equal("connecting");
			secure.open();
			expect(secure.sent[0]).to.equal("CAP LS 302");
			secure.line(":irc.example.org CAP * LS :sts=port=8443,duration=300 server-time");
			expect(h.transports).to.have.length(2);
			expect(secure.closeCalls).to.equal(0);
			expect(sts.getPolicy("irc.example.org")).to.include({port: 8443, preload: false});
		});

		it("after registration, a CAP NEW upgrade tears the session down and rejoins over wss://", function () {
			const h = setup({join: "#seance"});
			h.client.connect();
			const [plain] = h.transports;
			plain.open();
			plain.line(":irc.example.org CAP * LS :cap-notify");
			plain.line(":irc.example.org 001 alice :Welcome");
			plain.line(":irc.example.org 422 alice :MOTD File is missing");
			plain.line(":alice!a@h JOIN #seance");
			plain.line(":irc.example.org 353 alice = #seance :alice bob");
			plain.line(":irc.example.org 366 alice #seance :End of /NAMES list.");
			const chan = h.client.findChannel("#seance")!;
			expect(chan.state).to.equal(ChanState.JOINED);

			plain.line(":irc.example.org CAP alice NEW :sts=port=8443,duration=300");
			expect(plain.sent[plain.sent.length - 1]).to.equal("QUIT :STS upgrade");
			expect(plain.closeCalls).to.equal(1);
			expect(chan.state, "torn down like any lost connection").to.equal(ChanState.PARTED);
			expect(chan.users.size).to.equal(0);
			expect(chan.rejoining, "the rejoin is not news").to.equal(true);
			expect(h.lobbyTexts()).to.not.include("Disconnected.");
			expect(h.transports).to.have.length(2);
			const secure = h.transports[1];
			expect(secure.url).to.equal("wss://irc.example.org:8443/");
			expect(secure.connectCalls).to.equal(1);

			plain.closed(); // the old socket's late close is not ours any more
			expect(h.transports).to.have.length(2);

			secure.open();
			secure.line(":irc.example.org CAP * LS :sts=duration=300");
			secure.line(":irc.example.org 001 alice :Welcome");
			secure.line(":irc.example.org 422 alice :MOTD File is missing");
			expect(secure.sent).to.include("JOIN #seance");
			expect(sts.getPolicy("irc.example.org")).to.include({port: 8443});
		});

		it("an upgrade keeps settings edited for this host on the secure endpoint, and leaves another host alone", function () {
			const upgradeWith = (edit: Partial<ConnectOptions>) => {
				const h = setup();
				h.client.connect();
				const [plain] = h.transports;
				plain.open();
				plain.line(":irc.example.org CAP * LS :cap-notify");
				plain.line(":irc.example.org 001 alice :Welcome");
				h.client.applySettings({...BASE, ...edit});
				plain.line(":irc.example.org CAP alice NEW :sts=port=8443,duration=300");
				return h;
			};

			const same = upgradeWith({join: "#other"});
			expect(same.transports[same.transports.length - 1].url).to.equal(
				"wss://irc.example.org:8443/"
			);
			expect(same.client.options.join, "the edit is kept").to.equal("#other");

			const recased = upgradeWith({host: "IRC.Example.org"});
			expect(recased.transports[recased.transports.length - 1].url).to.equal(
				"wss://IRC.Example.org:8443/"
			);

			const other = upgradeWith({host: "irc.other.org", port: 9000});
			expect(other.transports[other.transports.length - 1].url).to.equal(
				"ws://irc.other.org:9000/"
			);
		});

		it("ignores sts without port= on an insecure connection", function () {
			const h = setup();
			h.client.connect();
			h.transports[0].open();
			h.transports[0].line(":irc.example.org CAP * LS :sts=duration=300");
			expect(h.transports).to.have.length(1);
			expect(h.transports[0].closeCalls).to.equal(0);
			expect(sts.getPolicy("irc.example.org")).to.equal(undefined);
		});

		it("on a secure connection caches duration with the current port and ignores port=", function () {
			const h = setup({tls: true, port: 8443});
			h.client.connect();
			h.transports[0].open();
			h.transports[0].line(":irc.example.org CAP * LS :sts=port=6697,duration=600,preload");

			expect(h.transports).to.have.length(1);
			expect(h.transports[0].closeCalls).to.equal(0);
			expect(sts.getPolicy("irc.example.org")).to.deep.equal({
				port: 8443,
				expiresAt: T0 + 600_000,
				preload: true,
				duration: 600,
			});
			expect(h.client.editableInfo.hasSTSPolicy).to.equal(true);

			// duration=0 (e.g. via a later LS) removes it.
			h.transports[0].line(":irc.example.org CAP * LS :sts=duration=0");
			expect(sts.getPolicy("irc.example.org")).to.equal(undefined);
		});

		it("stores a policy a CAP NEW brings on a secure connection, and only for sts", function () {
			const h = setup({tls: true, port: 8443});
			h.client.connect();
			h.transports[0].open();
			h.transports[0].line(":irc.example.org CAP * LS :cap-notify");
			h.transports[0].line(":irc.example.org CAP alice NEW :away-notify");
			expect(sts.getPolicy("irc.example.org")).to.equal(undefined);

			h.transports[0].line(":irc.example.org CAP alice NEW :sts=port=6697,duration=600");
			expect(sts.getPolicy("irc.example.org")).to.deep.equal({
				port: 8443,
				expiresAt: T0 + 600_000,
				preload: false,
				duration: 600,
			});
		});

		it("reschedules the expiry when the secure connection closes", function () {
			const h = setup({tls: true, port: 8443});
			h.client.connect();
			h.transports[0].open();
			h.transports[0].line(":irc.example.org CAP * LS :sts=duration=300");
			clock.tick(250_000);
			h.transports[0].closed();
			expect(sts.getPolicy("irc.example.org")?.expiresAt).to.equal(T0 + 550_000);
		});

		it("upgrades a plain connect from a cached policy and reports it", function () {
			sts.setPolicy("irc.example.org", {port: 8443, expiresAt: T0 + 60_000, preload: false});
			const onStsUpgrade = sinon.spy();
			const h = setup({onStsUpgrade});
			h.client.connect();

			expect(h.transports).to.have.length(2); // constructor's ws:// one, then wss://
			expect(h.transports[0].connectCalls).to.equal(0);
			expect(h.transports[1].url).to.equal("wss://irc.example.org:8443/");
			expect(h.transports[1].connectCalls).to.equal(1);
			expect(h.client.options).to.include({tls: true, port: 8443});
			expect(h.client.uuid).to.equal("irc.example.org-8067-alice"); // identity is stable
			expect(onStsUpgrade.calledOnceWithExactly({port: 8443, tls: true})).to.equal(true);
			expect(h.lobbyTexts()).to.deep.equal([
				"Upgrading to TLS on port 8443 (STS policy)",
				"Connecting to irc.example.org:8443…",
			]);
		});

		it("does not upgrade from an expired policy", function () {
			sts.setPolicy("irc.example.org", {port: 8443, expiresAt: T0 + 1000, preload: false});
			clock.tick(1000);
			const onStsUpgrade = sinon.spy();
			const h = setup({onStsUpgrade});
			h.client.connect();

			expect(h.transports).to.have.length(1);
			expect(h.transports[0].url).to.equal("ws://irc.example.org:8067/");
			expect(onStsUpgrade.called).to.equal(false);
			expect(data.has(sts.STORAGE_KEY)).to.equal(false); // clearExpired ran
		});
	});
});
