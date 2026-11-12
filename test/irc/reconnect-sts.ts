/**
 * STS and the retry schedule together: every dial applies the stored policy
 * (not only connect()), the insecure connection that reads an upgrade policy
 * carries nothing but QUIT, a policy is rescheduled at the close even once
 * expired, and long waits are spaced per address, not per dialer. These
 * drive the real WsTransport with a fake WebSocket, since its own retries
 * are the point; test/irc/sts.ts covers the rest of STS with a FakeTransport.
 */
import {expect} from "chai";
import sinon from "sinon";
import storage from "../../client/js/localStorage";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {NO_FAKE_LAG} from "../../client/js/irc/fakelag";
import {
	DIAL_CLAIM_SETTLE_MS,
	LAST_DIAL_KEY,
	QUICK_RETRY_MS,
	UNREACHED_JITTER_MS,
	UNREACHED_RETRY_MS,
	WsTransport,
	type TransportOptions,
} from "../../client/js/irc/transport";
import * as sts from "../../client/js/irc/sts";

const T0 = 1_700_000_000_000;
const HOST = "irc.example.org";
/** nefarious2's IPcheck: the 4th connection from an address whose gaps are all 40 s or less is refused. */
const IP_WINDOW_S = 40;
const IP_LIMIT = 4;

type Listener = (e: unknown) => void;

class WS {
	static all: WS[] = [];
	readonly OPEN = 1;
	readyState = 0;
	protocol = "";
	binaryType = "";
	sent: string[] = [];
	readonly at = Date.now();
	private h = new Map<string, Listener[]>();

	constructor(public url: string) {
		WS.all.push(this);
	}

	addEventListener(t: string, f: Listener): void {
		this.h.set(t, [...(this.h.get(t) ?? []), f]);
	}

	send(line: string): void {
		this.sent.push(line);
	}

	close(): void {
		this.readyState = 2;
	}

	fire(t: string, e: unknown): void {
		(this.h.get(t) ?? []).forEach((f) => f(e));
	}

	open(): void {
		this.readyState = 1;
		this.protocol = "text.ircv3.net";
		this.fire("open", {});
	}

	line(l: string): void {
		this.fire("message", {data: l});
	}

	drop(): void {
		this.readyState = 3;
		this.fire("close", {code: 1006, reason: "", wasClean: false});
	}
}

function network(port: number, tls: boolean, Impl: typeof WS = WS): IrcClient {
	return new IrcClient({
		host: HOST,
		port,
		tls,
		nick: "alice",
		join: "",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		ids: new IdAllocator(),
		bus: {dispatch: () => undefined},
		fakeLag: NO_FAKE_LAG,
		transportFactory: (o: TransportOptions) =>
			new WsTransport({...o, WebSocketImpl: Impl as never}),
	});
}

describe("STS and the retry schedule", function () {
	const data = new Map<string, string>();
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		sinon.stub(storage, "get").callsFake((k: string) => data.get(k) ?? null);
		sinon.stub(storage, "set").callsFake((k: string, v: string) => void data.set(k, v));
		sinon.stub(storage, "remove").callsFake((k: string) => void data.delete(k));
		sinon.stub(Math, "random").returns(0.999999);
		clock = sinon.useFakeTimers({now: T0});
		WS.all = [];
	});

	afterEach(function () {
		clock.restore();
		sinon.restore();
		data.clear();
	});

	describe("every dial applies the stored policy", function () {
		/** A plain network up on ws://, and a policy for its host learned by another network. */
		function plainThenPolicy(): IrcClient {
			const plain = network(8067, false);
			plain.connect();
			WS.all[0].open();
			WS.all[0].line(":srv CAP * LS :multi-prefix");

			const secure = network(8443, true);
			secure.connect();
			WS.all[1].open();
			WS.all[1].line(":srv CAP * LS :sts=duration=3600");
			expect(sts.getPolicy(HOST)).to.not.equal(undefined);
			return plain;
		}

		it("the transport's automatic retry", function () {
			const plain = plainThenPolicy();

			WS.all[0].drop();
			clock.tick(5000);

			expect(WS.all).to.have.length(3);
			expect(WS.all[2].url).to.match(/^wss:\/\/irc\.example\.org:8443\//);
			expect(plain.options).to.include({tls: true, port: 8443});

			// The plain transport's retry does not dial later on its own.
			clock.tick(120_000);
			expect(WS.all.filter((ws) => ws.url.startsWith("ws:"))).to.have.length(1);
		});

		it("the retry after a probe's loss", function () {
			const plain = plainThenPolicy();

			plain.transport.probe?.(1000);
			clock.tick(1000); // the probe gives up
			clock.tick(1); // and the loss is retried at once

			expect(WS.all).to.have.length(3);
			expect(WS.all[2].url).to.match(/^wss:\/\/irc\.example\.org:8443\//);
		});

		it("the foreground poke's redial of a stuck dial", function () {
			const plain = network(8067, false);
			plain.connect(); // never opens
			sts.setPolicy(HOST, {port: 8443, expiresAt: T0 + 3_600_000, preload: false});

			plain.redial();

			expect(WS.all).to.have.length(2);
			expect(WS.all[1].url).to.match(/^wss:\/\/irc\.example\.org:8443\//);
			clock.tick(120_000);
			expect(WS.all.filter((ws) => ws.url.startsWith("ws:"))).to.have.length(1);
		});

		it("the foreground poke in a short wait, which leaves no plain retry behind", function () {
			const plain = plainThenPolicy();

			WS.all[0].drop();
			plain.connect(); // the poke

			expect(WS.all).to.have.length(3);
			expect(WS.all[2].url).to.match(/^wss:\/\/irc\.example\.org:8443\//);
			clock.tick(120_000);
			expect(WS.all.filter((ws) => ws.url.startsWith("ws:"))).to.have.length(1);
		});
	});

	it("an upgraded retry that fails at once keeps its own countdown", function () {
		// A WebSocket whose constructor refuses wss:// (a blocked URL, say).
		const Throwing = class extends WS {
			constructor(url: string) {
				if (url.startsWith("wss:")) {
					throw new Error("blocked");
				}

				super(url);
			}
		};
		const plain = network(8067, false, Throwing);
		plain.connect();
		WS.all[0].open();
		sts.setPolicy(HOST, {
			port: 8443,
			expiresAt: T0 + 3_600_000,
			preload: false,
			duration: 3600,
		});
		WS.all[0].drop();
		clock.tick(5000);

		expect(plain.options.tls).to.equal(true);
		expect((plain as unknown as {retryAt?: number}).retryAt, "retryAt").to.be.a("number");
	});

	it("an insecure LS with sts=port= is answered by the upgrade alone", function () {
		const plain = network(8067, false);
		plain.connect();
		WS.all[0].open();
		const before = WS.all[0].sent.length;
		WS.all[0].line(":srv CAP * LS :multi-prefix sts=port=8443");
		const after = WS.all[0].sent.slice(before);

		expect(WS.all[1]?.url).to.match(/^wss:\/\/irc\.example\.org:8443\//);
		expect(after).to.deep.equal(["QUIT :STS upgrade"]);

		// The secure connection still pipelines CAP END behind the REQ.
		WS.all[1].open();
		const opened = WS.all[1].sent.length;
		WS.all[1].line(":srv CAP * LS :multi-prefix sts=port=8443,duration=60");
		expect(WS.all[1].sent.slice(opened)).to.deep.equal(["CAP REQ :multi-prefix", "CAP END"]);
	});

	it("an insecure multi-line LS upgrades on its last line, from a value on an earlier one", function () {
		const plain = network(8067, false);
		plain.connect();
		WS.all[0].open();
		WS.all[0].line(":srv CAP * LS * :sts=port=8443");
		const before = WS.all[0].sent.length;
		WS.all[0].line(":srv CAP * LS :multi-prefix");

		expect(WS.all[0].sent.slice(before)).to.deep.equal(["QUIT :STS upgrade"]);
		expect(WS.all[1]?.url).to.match(/^wss:\/\/irc\.example\.org:8443\//);
	});

	describe("the close reschedules the policy", function () {
		it("also once its expiry passed during the connection", function () {
			const secure = network(8443, true);
			secure.connect();
			WS.all[0].open();
			WS.all[0].line(":srv CAP * LS :sts=duration=60");
			clock.tick(120_000);
			WS.all[0].drop();

			expect(secure.options.tls).to.equal(true);
			expect(sts.getPolicy(HOST)?.expiresAt).to.equal(T0 + 120_000 + 60_000);
		});

		it("but a dial that never opened does not bring an expired one back", function () {
			sts.setPolicy(HOST, {port: 8443, expiresAt: T0 + 1000, preload: false, duration: 1});
			const secure = network(8443, true);
			secure.connect();
			clock.tick(5000);
			WS.all[0].drop();

			expect(sts.getPolicy(HOST)).to.equal(undefined);
		});

		it("also when another dial pruned it from the store meanwhile", function () {
			const secure = network(8443, true);
			secure.connect();
			WS.all[0].open();
			WS.all[0].line(":srv CAP * LS :sts=duration=60");
			clock.tick(120_000);
			sts.clearExpired(); // what another network's dial does
			expect(sts.getPolicy(HOST)).to.equal(undefined);
			WS.all[0].drop();

			expect(sts.getPolicy(HOST)?.expiresAt).to.equal(T0 + 120_000 + 60_000);
		});

		it("but not one the connection removed with duration=0", function () {
			const secure = network(8443, true);
			secure.connect();
			WS.all[0].open();
			WS.all[0].line(":srv CAP * LS :sts=duration=60");
			WS.all[0].line(":srv CAP alice NEW :sts=duration=0");
			WS.all[0].drop();

			expect(sts.getPolicy(HOST)).to.equal(undefined);
		});

		it("but not one another connection to the host removed with duration=0", function () {
			const a = network(8443, true);
			const b = network(8443, true);
			a.connect();
			WS.all[0].open();
			WS.all[0].line(":srv CAP * LS :sts=duration=60");
			b.connect();
			WS.all[1].open();
			WS.all[1].line(":srv CAP * LS :sts=duration=0");
			expect(sts.getPolicy(HOST)).to.equal(undefined);
			WS.all[0].drop();

			expect(sts.getPolicy(HOST)).to.equal(undefined);
		});

		it("nor one removed before the host's next policy was learned and pruned", function () {
			const a = network(8443, true);
			const b = network(8443, true);
			const c = network(9443, true);
			a.connect();
			WS.all[0].open();
			WS.all[0].line(":srv CAP * LS :sts=duration=3600");
			b.connect();
			WS.all[1].open();
			WS.all[1].line(":srv CAP * LS :sts=duration=0");
			c.connect();
			WS.all[2].open();
			WS.all[2].line(":srv CAP * LS :sts=duration=1");
			clock.tick(5000);
			sts.clearExpired(); // what another network's dial does
			WS.all[0].drop();

			expect(sts.getPolicy(HOST)).to.equal(undefined);
		});

		it("and a policy learned after a removal is rescheduled again", function () {
			const a = network(8443, true);
			a.connect();
			WS.all[0].open();
			WS.all[0].line(":srv CAP * LS :sts=duration=0");
			WS.all[0].line(":srv CAP alice NEW :sts=duration=60");
			clock.tick(120_000);
			sts.clearExpired(); // what another network's dial does
			WS.all[0].drop();

			expect(sts.getPolicy(HOST)?.expiresAt).to.equal(T0 + 120_000 + 60_000);
		});

		it("when the page goes away", function () {
			const secure = network(8443, true);
			secure.connect();
			WS.all[0].open();
			WS.all[0].line(":srv CAP * LS :sts=duration=60");
			WS.all[0].line(":srv CAP alice ACK :sts");
			WS.all[0].line(":srv 001 alice :Welcome");
			WS.all[0].line(":srv 376 alice :End of MOTD");
			clock.tick(120_000);

			secure.unload();

			expect(WS.all[0].sent.at(-1)).to.equal("QUIT :page closed");
			expect(sts.getPolicy(HOST)?.expiresAt).to.equal(T0 + 120_000 + 60_000);
		});
	});

	describe("long waits are spaced per address", function () {
		/**
		 * nefarious2's IPcheck as its notes describe it: a connection within
		 * the window of the address's last one extends the chain, and the
		 * `IP_LIMIT`-th is refused (which renews the window too); the close of
		 * the address's connections moves the window's start to the close.
		 */
		function ipcheck(): {pump(): void; dropAll(): void; opened: Set<WS>} {
			const ip = {last: -Infinity, chain: 0};
			const opened = new Set<WS>();
			const seen = new Set<WS>();

			return {
				opened,
				dropAll() {
					for (const ws of [...opened]) {
						opened.delete(ws);
						ip.last = Date.now();
						ws.drop();
					}
				},
				pump() {
					for (const ws of WS.all) {
						if (seen.has(ws)) {
							continue;
						}

						seen.add(ws);
						ip.chain = ws.at - ip.last <= IP_WINDOW_S * 1000 ? ip.chain + 1 : 1;
						ip.last = ws.at;

						if (ip.chain >= IP_LIMIT) {
							ws.drop();
						} else {
							ws.open();
							opened.add(ws);
						}
					}
				},
			};
		}

		it("two dialers on one address keep each other's long waits past the window", function () {
			// A server that refuses every dial before it opens.
			const dials: number[] = [];
			const refuse = () => {
				for (const ws of WS.all.slice(dials.length)) {
					dials.push(ws.at);
					ws.drop();
				}
			};
			const nets = [network(8443, true), network(8443, true)];
			nets[0].connect();
			clock.tick(500);
			nets[1].connect();

			for (let s = 0; s < 600; s++) {
				refuse();
				clock.tick(500);
			}

			// Past both quick runs (and their first long wait), every gap
			// between the address's dials is past the window.
			const quick = 2 * (QUICK_RETRY_MS.length + 2);
			const gaps = dials.slice(quick).map((at, i) => at - dials[quick + i - 1]);
			expect(gaps.length).to.be.at.least(4);
			expect(Math.min(...gaps)).to.be.above(IP_WINDOW_S * 1000);
			expect(Math.max(...gaps)).to.be.at.most(
				UNREACHED_RETRY_MS + UNREACHED_JITTER_MS + DIAL_CLAIM_SETTLE_MS
			);
		});

		it("a long wait whose claim on the host another tab overwrote does not dial", function () {
			const t = new WsTransport({url: `wss://${HOST}:8443/`, WebSocketImpl: WS as never});
			t.connect();

			// Refused before opening until the long wait after the quick retries.
			for (let i = 0; i <= QUICK_RETRY_MS.length; i++) {
				WS.all.at(-1)?.drop();
				clock.tick(QUICK_RETRY_MS[i] ?? 0);
			}

			const before = WS.all.length;
			clock.tick(UNREACHED_RETRY_MS + UNREACHED_JITTER_MS); // the wait ends: our claim is written
			// Another tab's wait ended at the same moment: its claim lands after ours.
			const claims = JSON.parse(data.get(LAST_DIAL_KEY) ?? "{}") as Record<string, unknown>;
			claims[HOST] = {at: Date.now(), by: "another tab"};
			data.set(LAST_DIAL_KEY, JSON.stringify(claims));
			clock.tick(DIAL_CLAIM_SETTLE_MS);

			expect(WS.all.length, "dials").to.equal(before);
			expect(t.state).to.equal("reconnect-wait");
			t.close();
		});

		it("two networks on one address get back in after IPcheck refused them", function () {
			const server = ipcheck();
			const nets = [network(8443, true), network(8443, true)];
			nets[0].connect();
			nets[1].connect();
			server.pump();
			clock.tick(1000);

			// Both drop a second in: the retries pile up within the window.
			server.dropAll();

			for (let s = 0; s < 20; s++) {
				clock.tick(1000);
				server.pump();
			}

			server.dropAll();

			for (let s = 0; s < 600; s++) {
				clock.tick(1000);
				server.pump();
			}

			expect(server.opened.size, "connections that got back in").to.be.at.least(1);
		});
	});
});
