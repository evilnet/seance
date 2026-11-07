import {expect} from "chai";
import sinon from "sinon";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {
	INDEFINITE_MUTE_S,
	MUTE_ECHO_TIMEOUT_MS,
	MUTE_READ_DELAY_MS,
	claimMute,
	clearRemoteDnd,
	desiredUntil,
	formatMute,
	globalUntil,
	parseMute,
	withGlobal,
	withoutGlobal,
} from "../../client/js/irc/pushMute";
import {syncPresence} from "../../client/js/irc/presence";
import {
	MUTE_MEMORY_KEY,
	getMuteMemory,
	useStorageBackend as useMuteMemoryBackend,
	type StorageBackend,
} from "../../client/js/irc/muteMemory";
import * as saved from "../../client/js/irc/saved-networks";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";

describe("push mute value (irc/pushMute.ts)", function () {
	const NOW = 1_800_000_000;

	it("parses target:until entries and drops malformed ones", function () {
		expect(parseMute("*:1800000100;#seance:1800000200;bad;:5;bob:x")).to.deep.equal([
			{target: "*", until: 1800000100},
			{target: "#seance", until: 1800000200},
		]);
		expect(parseMute("")).to.deep.equal([]);
	});

	it("splits each entry at the first colon, as the server does", function () {
		expect(parseMute("#a:b:5")).to.deep.equal([]);
		expect(parseMute("#a:5:b")).to.deep.equal([]);
	});

	it("keeps indefinite entries (until 0 or a leading '-')", function () {
		expect(parseMute("x:0;y:-1")).to.deep.equal([
			{target: "x", until: 0},
			{target: "y", until: -1},
		]);
	});

	it("formats entries back", function () {
		expect(
			formatMute([
				{target: "*", until: 5},
				{target: "bob", until: 6},
			])
		).to.equal("*:5;bob:6");
	});

	it("reads the global entry only while it is live", function () {
		expect(globalUntil("*:1800000100", NOW)).to.equal(1800000100);
		expect(globalUntil("*:1799999999", NOW)).to.equal(null);
		expect(globalUntil("#seance:1800000100", NOW)).to.equal(null);
	});

	it("reads an indefinite global entry as Infinity", function () {
		expect(globalUntil("*:0", NOW)).to.equal(Number.POSITIVE_INFINITY);
		expect(globalUntil("*:-1", NOW)).to.equal(Number.POSITIVE_INFINITY);
	});

	it("keeps indefinite entries of other targets through both writes", function () {
		expect(withGlobal("x:0;y:-1", 1800000900, NOW)).to.equal("x:0;y:-1;*:1800000900");
		expect(withoutGlobal("x:0;y:-1;*:1800000900", NOW)).to.equal("x:0;y:-1");
	});

	it("sets the global entry and keeps the others", function () {
		expect(withGlobal("#seance:1800000200;*:1800000050", 1800000900, NOW)).to.equal(
			"#seance:1800000200;*:1800000900"
		);
	});

	it("drops expired entries when it writes", function () {
		expect(withGlobal("#old:1700000000;bob:1800000200", 1800000900, NOW)).to.equal(
			"bob:1800000200;*:1800000900"
		);
		expect(withoutGlobal("#old:1700000000;*:1800000900;bob:1800000200", NOW)).to.equal(
			"bob:1800000200"
		);
		expect(withoutGlobal("*:1800000900", NOW)).to.equal("");
	});
});

class FakeTransport implements Transport {
	state: TransportState = "closed";
	sent: string[] = [];
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
		const wasOpen = this.state === "open";
		this.state = "closed";

		if (wasOpen) {
			this.emit({
				type: "close",
				code: 1000,
				reason: "",
				wasClean: true,
				willReconnect: false,
			});
		}
	}

	open(): void {
		this.state = "open";
		this.emit({type: "open", subprotocol: "text.ircv3.net"});
	}

	line(line: string): void {
		this.emit({type: "line", line});
	}

	lines(...lines: string[]): void {
		lines.forEach((line) => this.line(line));
	}

	private emit(ev: TransportEvent): void {
		for (const listener of [...this.listeners]) {
			listener(ev);
		}
	}
}

const CAPS = "server-time message-tags batch labeled-response draft/metadata-2 draft/pre-away";

function connect(opts: {account?: boolean; metadata?: boolean} = {}) {
	const transport = new FakeTransport();
	const dispatch = sinon.spy();
	const client = new IrcClient({
		bus: {dispatch},
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "alice",
		join: "",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		uuid: "mute-net",
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
	});
	client.connect();
	transport.open();
	const caps = opts.metadata === false ? "server-time message-tags" : CAPS;
	transport.line(`:irc.test CAP * LS :${caps}`);
	const req = transport.sent.find((l) => l.startsWith("CAP REQ :")) as string;
	transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
	transport.line(":irc.test 001 alice :Welcome");
	transport.line(
		":irc.test 004 alice irc.test u2.10.12.14+Nefarious(2.0.0) iow bklmnopstv bklov"
	);

	if (opts.account !== false) {
		transport.line(":irc.test 900 alice alice!a@h alice :You are now logged in as alice");
	}

	transport.line(":irc.test 422 alice :MOTD File is missing");
	let mark = 0;

	const sent = () => {
		const out = transport.sent.slice(mark);
		mark = transport.sent.length;
		// The SUB/GET read is pinned by its own test; the rest watch writes and AWAY.
		return out.filter(
			(l) => (l.includes("METADATA") && !/ (SUB|GET) /.test(l)) || l.startsWith("AWAY")
		);
	};

	return {client, transport, dispatch, sent};
}

/** Drop the socket and register again on the same client (a reconnect). */
function reconnect(h: ReturnType<typeof connect>): void {
	h.transport.close();
	const from = h.transport.sent.length;
	h.transport.open();
	h.transport.line(`:irc.test CAP * LS :${CAPS}`);
	const req = h.transport.sent.slice(from).find((l) => l.startsWith("CAP REQ :")) as string;
	h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
	h.transport.line(":irc.test 001 alice :Welcome");
	h.transport.line(
		":irc.test 004 alice irc.test u2.10.12.14+Nefarious(2.0.0) iow bklmnopstv bklov"
	);
	h.transport.line(":irc.test 900 alice alice!a@h alice :You are now logged in as alice");
	h.transport.line(":irc.test 422 alice :MOTD File is missing");
}

describe("push mute on the wire (irc/pushMute.ts)", function () {
	let clock: sinon.SinonFakeTimers;
	const NOW_MS = Date.UTC(2026, 9, 12, 12, 0, 0);
	const NOW_S = NOW_MS / 1000;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: NOW_MS, toFake: ["setTimeout", "clearTimeout", "Date"]});
	});

	afterEach(function () {
		clock.restore();
	});

	it("reads the key after the connect burst, not in it", function () {
		const h = connect();
		const metadata = () => h.transport.sent.filter((l) => l.includes("METADATA"));
		clock.tick(MUTE_READ_DELAY_MS - 1);
		expect(metadata()).to.deep.equal([]);
		clock.tick(1);
		expect(metadata()).to.deep.equal([
			"METADATA * SUB draft/webpush/mute seance/presence seance/mode seance/closed",
			"METADATA * GET draft/webpush/mute seance/presence seance/mode draft/webpush/payload seance/closed",
		]);
	});

	it("asks for the payload tier in the login read", function () {
		const h = connect();
		clock.tick(MUTE_READ_DELAY_MS);
		const get = h.transport.sent.find((l) => l.startsWith("METADATA * GET "));
		expect(get).to.match(/ draft\/webpush\/payload seance\/closed$/);
	});

	it("rewrites a public payload tier as private, keeping its value", function () {
		const h = connect();
		clock.tick(MUTE_READ_DELAY_MS);
		h.sent();
		h.transport.line(":irc.test 761 alice alice draft/webpush/payload * :route");
		expect(h.transport.sent.slice(-1)).to.deep.equal([
			"METADATA * SET draft/webpush/payload private :route",
		]);
		expect(h.sent()).to.deep.equal(["METADATA * SET draft/webpush/payload private :route"]);
	});

	it("leaves a private payload tier alone", function () {
		const h = connect();
		clock.tick(MUTE_READ_DELAY_MS);
		const before = h.transport.sent.length;
		h.transport.line(":irc.test 761 alice alice draft/webpush/payload private :full");
		expect(h.transport.sent.slice(before)).to.deep.equal([]);
	});

	it("ignores another user's public payload tier", function () {
		const h = connect();
		clock.tick(MUTE_READ_DELAY_MS);
		const before = h.transport.sent.length;
		h.transport.line(":irc.test 761 alice bob draft/webpush/payload * :full");
		expect(h.transport.sent.slice(before)).to.deep.equal([]);
	});

	it("does not read the key on a connection closed before the delay", function () {
		const h = connect();
		h.sent();
		h.transport.close();
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.transport.sent.filter((l) => l.includes("METADATA"))).to.deep.equal([]);
	});

	it("never touches METADATA without an account or the cap, and DND still goes away", function () {
		for (const opts of [{account: false}, {metadata: false}]) {
			const h = connect(opts);
			h.client.setGlobalDnd(true, null);
			clock.tick(MUTE_READ_DELAY_MS);
			// The raw lines: sent() hides SUB and GET, the very lines this pins.
			expect(h.transport.sent.filter((l) => l.includes("METADATA"))).to.deep.equal([]);
			// Its no-metadata server offers no pre-away either: a real away message there.
			expect(h.sent()).to.include(opts.metadata === false ? "AWAY :Away" : "AWAY *");
		}
	});

	it("waits for the GET answer before writing, then writes the global entry", function () {
		const h = connect();
		h.sent();
		h.client.setGlobalDnd(true, NOW_MS + 3600_000);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		h.transport.line(":irc.test 761 alice alice draft/webpush/mute * :#seance:9999999999");
		expect(h.sent()).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :#seance:9999999999;*:${NOW_S + 3600}`,
		]);
	});

	it("indefinite DND writes 30 days and renews under 7", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.sent();
		h.client.setPresenceMode("dnd");
		expect(h.sent()).to.deep.equal([
			"AWAY *",
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + INDEFINITE_MUTE_S}`,
		]);

		// Any change makes a sync; the global switch on and off is one.
		const poke = () => {
			h.client.setGlobalDnd(true, null);
			h.client.setGlobalDnd(false, null);
		};

		clock.tick(22 * 86400 * 1000); // 8 days left: nothing
		poke();
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		clock.tick(2 * 86400 * 1000); // 6 days left: renew once
		poke();
		expect(h.sent().filter((l) => l.includes("SET")).length).to.equal(1);
	});

	it("off clears the entry and remoteDnd together", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		// The server's echo of our own write:
		h.transport.line(
			`:irc.test METADATA alice draft/webpush/mute * :*:${NOW_S + INDEFINITE_MUTE_S}`
		);
		expect(h.client.remoteDnd).to.equal(true);
		h.sent();
		h.client.setGlobalDnd(false, null);
		expect(h.sent()).to.deep.equal(["METADATA * SET draft/webpush/mute", "AWAY"]);
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.client.presenceSnapshot().dnd).to.equal(false);
		// The echo of the clear changes nothing.
		h.transport.lines(
			":irc.test 766 alice alice draft/webpush/mute :key not set",
			":irc.test METADATA alice draft/webpush/mute *"
		);
		expect(h.sent()).to.deep.equal([]);
	});

	it("another device's entry is DND here and is left alone until cleared", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.sent();
		h.transport.line(`:irc.test METADATA alice draft/webpush/mute * :*:${NOW_S + 600}`);
		expect(h.client.presenceSnapshot().dnd).to.equal(true);
		expect(h.sent()).to.deep.equal(["AWAY *"]);
		h.client.setGlobalDnd(false, null);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		clearRemoteDnd(h.client);
		expect(h.sent()).to.deep.equal(["METADATA * SET draft/webpush/mute", "AWAY"]);
	});

	it("another user's entry in a shared channel is not ours", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.sent();
		h.transport.line(`:irc.test METADATA bob draft/webpush/mute * :*:${NOW_S + 600}`);
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.sent()).to.deep.equal([]);
	});

	it("an indefinite entry set elsewhere is never rewritten", function () {
		for (const until of ["0", "-1"]) {
			const h = connect();
			h.transport.line(`:irc.test 761 alice alice draft/webpush/mute * :*:${until}`);
			expect(h.client.remoteDnd).to.equal(true);
			expect(h.sent()).to.deep.equal(["AWAY *"]);
			h.client.setGlobalDnd(true, NOW_MS + 3600_000);
			h.client.setGlobalDnd(true, null);
			h.client.setPresenceMode("dnd");
			clock.tick(29 * 86400 * 1000);
			h.client.setGlobalDnd(false, null);
			h.client.setPresenceMode("auto");
			syncPresence(h.client);
			expect(h.sent()).to.deep.equal([]);
			expect(h.client.muteOwned).to.equal(false);
			expect(h.client.remoteDnd).to.equal(true);
		}
	});

	it("another device clearing our entry: no rewrite, dnd:cleared reported", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		// The server echoes our write before it relays the other device's.
		h.transport.line(
			`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S + INDEFINITE_MUTE_S}`
		);
		h.sent();
		h.dispatch.resetHistory();
		h.transport.line(":irc.test METADATA alice draft/webpush/mute * :#seance:9999999999");
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		expect(h.dispatch.getCalls().filter((c) => c.args[0] === "dnd:cleared")).to.have.length(1);
		expect(
			h.dispatch.getCalls().find((c) => c.args[0] === "dnd:cleared")?.args[1]
		).to.deep.equal({network: "mute-net"});
		// Local DND ends (the controller's turnOff) and later starts again: writes again.
		h.client.setGlobalDnd(false, null);
		h.client.setGlobalDnd(true, null);
		expect(h.sent().filter((l) => l.includes("SET")).length).to.equal(1);
	});

	it("echoes of our own writes still in flight are not another device's", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		const on = `*:${NOW_S + INDEFINITE_MUTE_S}`;
		h.transport.lines(
			`:irc.test 761 alice alice draft/webpush/mute * :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`
		);
		h.sent();
		h.dispatch.resetHistory();
		// Off, then on again before either write is echoed.
		h.client.setGlobalDnd(false, null);
		h.client.setGlobalDnd(true, null);
		expect(h.sent()).to.deep.equal([
			"METADATA * SET draft/webpush/mute",
			"AWAY",
			"AWAY *",
			`METADATA * SET draft/webpush/mute private :${on}`,
		]);
		h.transport.lines(
			":irc.test 766 alice alice draft/webpush/mute :key not set",
			":irc.test METADATA alice draft/webpush/mute *",
			`:irc.test 761 alice alice draft/webpush/mute * :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`
		);
		expect(h.dispatch.getCalls().some((c) => c.args[0] === "dnd:cleared")).to.equal(false);
		expect(h.sent()).to.deep.equal([]);
		expect(h.client.muteSuppressed).to.equal(false);
		expect(h.client.muteOwned).to.equal(true);
		expect(h.client.remoteDnd).to.equal(true);
	});

	it("a late echo of our write does not flap AWAY", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		h.client.setGlobalDnd(false, null);
		h.sent();
		const on = `*:${NOW_S + INDEFINITE_MUTE_S}`;
		h.transport.lines(
			`:irc.test 761 alice alice draft/webpush/mute * :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`
		);
		expect(h.client.remoteDnd).to.equal(false);
		h.transport.lines(
			":irc.test 766 alice alice draft/webpush/mute :key not set",
			":irc.test METADATA alice draft/webpush/mute *"
		);
		expect(h.sent()).to.deep.equal([]);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("another device's change after our echo still counts", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		const on = `*:${NOW_S + INDEFINITE_MUTE_S}`;
		h.transport.lines(
			`:irc.test 761 alice alice draft/webpush/mute * :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`,
			":irc.test METADATA alice draft/webpush/mute *"
		);
		expect(h.client.muteSuppressed).to.equal(true);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("a write never echoed stops hiding other devices' values", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		h.client.setGlobalDnd(false, null);
		// Both writes refused (no echo); much later another device sets a value.
		clock.tick(MUTE_ECHO_TIMEOUT_MS + 1);
		h.transport.line(`:irc.test METADATA alice draft/webpush/mute * :*:${NOW_S + 3600}`);
		expect(h.client.remoteDnd).to.equal(true);
	});

	it("an entry set elsewhere is adopted, never rewritten (no ping-pong)", function () {
		const cases: {mine: (h: ReturnType<typeof connect>) => void; theirs: string}[] = [
			// Ours indefinite, theirs timed with under 7 days left.
			{mine: (h) => h.client.setGlobalDnd(true, null), theirs: `*:${NOW_S + 3600}`},
			// Ours timed, theirs indefinite.
			{
				mine: (h) => h.client.setGlobalDnd(true, NOW_MS + 3600_000),
				theirs: `*:${NOW_S + INDEFINITE_MUTE_S}`,
			},
			// Ours timed, theirs a different timed end.
			{
				mine: (h) => h.client.setGlobalDnd(true, NOW_MS + 3600_000),
				theirs: `*:${NOW_S + 7200}`,
			},
		];

		for (const {mine, theirs} of cases) {
			const h = connect();
			h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
			mine(h);
			const ours = h.sent().find((l) => l.includes("SET")) as string;
			const value = ours.slice(ours.indexOf(" :") + 2);
			h.transport.lines(
				`:irc.test 761 alice alice draft/webpush/mute private :${value}`,
				`:irc.test METADATA alice draft/webpush/mute * :${value}`
			);
			expect(h.client.muteOwned).to.equal(true);
			// The other device (the same account) writes its own end.
			h.transport.line(`:irc.test METADATA alice draft/webpush/mute * :${theirs}`);
			expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
			expect(h.client.muteOwned).to.equal(false);
			// Later syncs, and the other device writing again, change nothing.
			h.client.setGlobalDnd(false, null);
			mine(h);
			syncPresence(h.client);
			h.transport.line(`:irc.test METADATA alice draft/webpush/mute * :${theirs}`);
			expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
			expect(h.client.presenceSnapshot().dnd).to.equal(true);
		}
	});

	it("keeps our entry when another device changes only a channel's mute", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		const on = `*:${NOW_S + INDEFINITE_MUTE_S}`;
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute private :${on}`);
		h.transport.line(`:irc.test METADATA alice draft/webpush/mute * :#seance:9999999999;${on}`);
		expect(h.client.muteOwned).to.equal(true);
		h.sent();
		h.client.setGlobalDnd(false, null);
		expect(h.sent()).to.deep.equal([
			"METADATA * SET draft/webpush/mute private :#seance:9999999999",
			"AWAY",
		]);
	});

	it("an adopted timed entry expiring makes room for ours", function () {
		const h = connect();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute private :*:${NOW_S + 600}`);
		h.client.setGlobalDnd(true, null);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		clock.tick(601_000);
		syncPresence(h.client);
		expect(h.sent()).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 601 + INDEFINITE_MUTE_S}`,
		]);
		expect(h.client.muteOwned).to.equal(true);
		expect(h.client.presenceSnapshot().dnd).to.equal(true);
	});

	it("an adopted timed entry cleared elsewhere reports dnd:cleared", function () {
		const h = connect();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute private :*:${NOW_S + 600}`);
		h.client.setGlobalDnd(true, NOW_MS + 3600_000);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		h.dispatch.resetHistory();
		h.transport.line(":irc.test METADATA alice draft/webpush/mute *");
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		expect(h.dispatch.getCalls().some((c) => c.args[0] === "dnd:cleared")).to.equal(true);
	});

	it("a refused write behind an echoed one stops hiding foreign values", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, NOW_MS + 3600_000);
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute private :*:${NOW_S + 3600}`);
		// The end moves: a second write, which the server refuses (no echo).
		h.client.setGlobalDnd(true, NOW_MS + 7200_000);
		expect(h.sent().filter((l) => l.includes("SET"))).to.have.length(2);
		expect(h.client.mutePending.map((p) => p.echoed)).to.deep.equal([true, false]);
		clock.tick(MUTE_ECHO_TIMEOUT_MS + 1);
		h.dispatch.resetHistory();
		// Another device turns DND off.
		h.transport.line(":irc.test METADATA alice draft/webpush/mute *");
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.dispatch.getCalls().some((c) => c.args[0] === "dnd:cleared")).to.equal(true);
		expect(h.client.mutePending).to.deep.equal([]);
	});

	it("keeps no more pending writes than the last timeout's", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");

		for (let i = 0; i < 20; i++) {
			h.client.setGlobalDnd(true, null);
			h.client.setGlobalDnd(false, null);
			clock.tick(MUTE_ECHO_TIMEOUT_MS);
		}

		// Any echo prunes by age: only the newest round's two writes remain,
		// and this echo of its clear drops the write before it.
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		expect(h.client.mutePending.map((p) => p.value)).to.deep.equal([""]);
	});

	it("stays bounded when no write is ever echoed", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");

		for (let i = 0; i < 20; i++) {
			h.client.setGlobalDnd(true, null);
			h.client.setGlobalDnd(false, null);
			clock.tick(MUTE_ECHO_TIMEOUT_MS + 1);
			// This round's two writes; each write pruned the round before.
			expect(h.client.mutePending.length).to.equal(2);
		}

		expect(h.sent().filter((l) => l.includes("SET"))).to.have.length(40);
		h.transport.close();
		expect(h.client.mutePending).to.deep.equal([]);
	});

	it("our own entry read back after a reconnect is still ours", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, NOW_MS + 3600_000);
		const on = `*:${NOW_S + 3600}`;
		h.transport.lines(
			`:irc.test 761 alice alice draft/webpush/mute private :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`
		);
		reconnect(h);
		h.sent();
		h.dispatch.resetHistory();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute private :${on}`);
		expect(h.client.muteOwned).to.equal(true);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		expect(h.dispatch.getCalls().some((c) => c.args[0] === "dnd:cleared")).to.equal(false);
		h.client.setGlobalDnd(false, null);
		expect(h.sent()).to.deep.equal(["METADATA * SET draft/webpush/mute", "AWAY"]);
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.client.presenceSnapshot().dnd).to.equal(false);
	});

	it("a different entry read back after a reconnect is adopted", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, NOW_MS + 3600_000);
		const on = `*:${NOW_S + 3600}`;
		h.transport.lines(
			`:irc.test 761 alice alice draft/webpush/mute private :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`
		);
		reconnect(h);
		h.sent();
		h.dispatch.resetHistory();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute private :*:${NOW_S + 7200}`);
		expect(h.client.muteOwned).to.equal(false);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		expect(h.dispatch.getCalls().some((c) => c.args[0] === "dnd:cleared")).to.equal(false);
		h.client.setGlobalDnd(false, null);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		expect(h.client.remoteDnd).to.equal(true);
	});

	it("our indefinite entry read back after a reconnect is still renewed", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setPresenceMode("dnd");
		const on = `*:${NOW_S + INDEFINITE_MUTE_S}`;
		h.transport.lines(
			`:irc.test 761 alice alice draft/webpush/mute private :${on}`,
			`:irc.test METADATA alice draft/webpush/mute * :${on}`
		);
		clock.tick(24 * 86400 * 1000); // 6 days left
		reconnect(h);
		h.sent();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute private :${on}`);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${
				NOW_S + 24 * 86400 + INDEFINITE_MUTE_S
			}`,
		]);
		expect(h.client.muteOwned).to.equal(true);
	});

	it("takes a private value under another nick, never a public one", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.sent();
		h.transport.line(`:irc.test METADATA bob draft/webpush/mute * :*:${NOW_S + 600}`);
		h.transport.line(`:irc.test 761 alice bob draft/webpush/mute * :*:${NOW_S + 600}`);
		expect(h.client.remoteDnd).to.equal(false);
		h.transport.line(`:irc.test METADATA alice_ draft/webpush/mute private :*:${NOW_S + 600}`);
		expect(h.client.remoteDnd).to.equal(true);
		expect(h.sent()).to.deep.equal(["AWAY *"]);
	});

	it("a timed DND ending clears itself", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, NOW_MS + 3600_000);
		h.transport.line(`:irc.test METADATA alice draft/webpush/mute * :*:${NOW_S + 3600}`);
		h.sent();
		clock.tick(3600_000 + 60_000);
		// What the minute tick runs: the controller's apply(), then syncPresenceAll().
		h.client.setGlobalDnd(false, null);
		syncPresence(h.client);
		expect(h.sent()).to.deep.equal(["AWAY"]);
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.client.presenceSnapshot().dnd).to.equal(false);
	});

	it("another device's timed entry expiring", function () {
		const h = connect();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S + 600}`);
		expect(h.sent()).to.deep.equal(["AWAY *"]);
		clock.tick(601_000);
		syncPresence(h.client);
		expect(h.sent()).to.deep.equal(["AWAY"]);
	});

	it("clearing an entry we adopted: no rewrite, dnd:cleared reported", function () {
		const h = connect();
		// Our indefinite DND finds another device's matching entry and writes nothing.
		h.transport.line(
			`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S + INDEFINITE_MUTE_S}`
		);
		h.client.setGlobalDnd(true, null);
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		h.dispatch.resetHistory();
		h.transport.line(":irc.test METADATA alice draft/webpush/mute * :");
		expect(h.sent().filter((l) => l.includes("SET"))).to.deep.equal([]);
		expect(h.dispatch.getCalls().some((c) => c.args[0] === "dnd:cleared")).to.equal(true);
	});

	it("an expired entry is not DND", function () {
		const h = connect();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S - 1}`);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("forgets the value on close", function () {
		const h = connect();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S + 600}`);
		expect(h.client.remoteDnd).to.equal(true);
		h.transport.close();
		expect(h.client.muteKnown).to.equal(false);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("keeps the metadata replies out of the lobby", function () {
		const h = connect();
		h.dispatch.resetHistory();
		h.transport.lines(
			":irc.test 770 alice draft/webpush/mute",
			":irc.test 761 alice alice draft/webpush/mute * :",
			":irc.test 762 alice :end of metadata",
			":irc.test 766 alice alice draft/webpush/mute :key not set"
		);
		expect(h.dispatch.getCalls().filter((c) => c.args[0] === "msg")).to.deep.equal([]);
	});

	it("a timed DND past its end, before the minute tick: mode dnd's entry is not rewritten", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setPresenceMode("dnd");
		h.client.setGlobalDnd(true, NOW_MS + 60_000);
		clock.tick(61_000);
		syncPresence(h.client);
		const sets = h.sent().filter((l) => l.includes(" SET "));
		const last = sets[sets.length - 1];
		expect(last).to.equal(
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 61 + INDEFINITE_MUTE_S}`
		);
		h.transport.line(
			`:irc.test METADATA alice draft/webpush/mute private :${last.split(" :")[1]}`
		);

		for (let i = 0; i < 3; i++) {
			clock.tick(1000);
			syncPresence(h.client);
		}

		expect(h.sent().filter((l) => l.includes(" SET "))).to.deep.equal([]);
	});

	it("keeps the payload tier's replies quiet too", function () {
		const h = connect();
		h.dispatch.resetHistory();
		h.transport.lines(
			":irc.test 761 alice alice draft/webpush/payload * :full",
			":irc.test 766 alice alice draft/webpush/payload :key not set",
			":irc.test 770 alice draft/webpush/mute draft/webpush/payload"
		);
		expect(h.dispatch.getCalls().filter((c) => c.args[0] === "msg")).to.deep.equal([]);
	});

	it("shows the replies for any other key, as a raw /metadata asked", function () {
		const h = connect();
		h.dispatch.resetHistory();
		h.transport.lines(
			":irc.test 761 alice alice avatar * :https://example.test/a.png",
			":irc.test 766 alice alice display-name :key not set",
			":irc.test 770 alice avatar"
		);
		const shown = h.dispatch.getCalls().filter((c) => c.args[0] === "msg");
		expect(shown).to.have.length(3);
		expect(shown.map((c) => (c.args[1] as {msg: {command: string}}).msg.command)).to.deep.equal(
			["761", "766", "770"]
		);
	});

	it("/quit takes our own entry with it, before the QUIT", function () {
		const h = connect();
		h.transport.line(":irc.test 766 alice alice draft/webpush/mute :key not set");
		h.client.setGlobalDnd(true, null);
		h.transport.line(
			`:irc.test METADATA alice draft/webpush/mute * :*:${NOW_S + INDEFINITE_MUTE_S}`
		);
		const from = h.transport.sent.length;
		h.client.quit();
		const lines = h.transport.sent.slice(from);
		expect(lines[0]).to.equal("METADATA * SET draft/webpush/mute");
		expect(lines[1]).to.match(/^QUIT /);
	});

	it("/quit leaves another device's entry alone", function () {
		const h = connect();
		h.transport.line(`:irc.test 761 alice alice draft/webpush/mute * :*:${NOW_S + 600}`);
		const from = h.transport.sent.length;
		h.client.quit();
		expect(h.transport.sent.slice(from).filter((l) => l.includes("METADATA"))).to.deep.equal(
			[]
		);
	});
});

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

describe("push mute across a reload or a reconnect (irc/muteMemory.ts)", function () {
	let clock: sinon.SinonFakeTimers;
	let backend: MemoryBackend;
	const NOW_MS = Date.UTC(2026, 9, 12, 12, 0, 0);
	const NOW_S = NOW_MS / 1000;
	const HOUR_MS = 3600_000;
	const sets = (lines: string[]) => lines.filter((l) => l.includes("SET"));
	const cleared = (h: ReturnType<typeof connect>) =>
		h.dispatch.getCalls().filter((c) => c.args[0] === "dnd:cleared");

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: NOW_MS, toFake: ["setTimeout", "clearTimeout", "Date"]});
		backend = new MemoryBackend();
		useMuteMemoryBackend(backend);
	});

	afterEach(function () {
		clock.restore();
		useMuteMemoryBackend(null);
	});

	/** The server answers our newest write, both echoes. */
	function echo(h: ReturnType<typeof connect>, value: string): void {
		h.transport.lines(
			value
				? `:irc.test 761 alice alice draft/webpush/mute private :${value}`
				: ":irc.test 766 alice alice draft/webpush/mute :key not set",
			value
				? `:irc.test METADATA alice draft/webpush/mute * :${value}`
				: ":irc.test METADATA alice draft/webpush/mute *"
		);
	}

	/** The GET's answer on a fresh registration. */
	function read(h: ReturnType<typeof connect>, value: string): void {
		h.transport.line(
			value
				? `:irc.test 761 alice alice draft/webpush/mute private :${value}`
				: ":irc.test 766 alice alice draft/webpush/mute :key not set"
		);
	}

	/** A page with DND `until` (null: indefinite) whose entry the server confirmed. */
	function confirmed(until: number | null): {h: ReturnType<typeof connect>; value: string} {
		const h = connect();
		read(h, "");
		h.client.setGlobalDnd(true, until);
		const value = `*:${until === null ? NOW_S + INDEFINITE_MUTE_S : until / 1000}`;
		expect(sets(h.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :${value}`,
		]);
		echo(h, value);
		return {h, value};
	}

	/** The page loaded again: a new client on the same network, DND applied at boot. */
	function reload(active: boolean, until: number | null): ReturnType<typeof connect> {
		const h = connect();
		h.client.setGlobalDnd(active, until);
		h.sent();
		return h;
	}

	it("has no memory under a name every object has", function () {
		expect(getMuteMemory("constructor")).to.deep.equal({
			ownedUntil: null,
			confirmedUntil: null,
		});
	});

	it("remembers what it wrote and what the server confirmed, per network", function () {
		const {h, value} = confirmed(NOW_MS + 8 * HOUR_MS);
		expect(getMuteMemory("mute-net")).to.deep.equal({
			ownedUntil: NOW_S + 8 * 3600,
			confirmedUntil: NOW_S + 8 * 3600,
		});
		expect(JSON.parse(backend.data.get(MUTE_MEMORY_KEY) as string)).to.have.key("mute-net");
		h.client.setGlobalDnd(true, NOW_MS + HOUR_MS);
		expect(getMuteMemory("mute-net")).to.deep.equal({
			ownedUntil: NOW_S + 3600,
			confirmedUntil: NOW_S + 8 * 3600,
		});
		expect(value).to.equal(`*:${NOW_S + 8 * 3600}`);
	});

	it("after a reload, For 1 hour shortens our indefinite entry and its end lifts it", function () {
		const first = confirmed(null).value;
		clock.tick(86400_000); // 29 days left: no renewal due
		const now = NOW_S + 86400;
		const h = reload(true, null);
		read(h, first);
		expect(h.client.muteOwned).to.equal(true);
		expect(sets(h.sent())).to.deep.equal([]);
		h.client.setGlobalDnd(true, (now + 3600) * 1000);
		expect(sets(h.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${now + 3600}`,
		]);
		echo(h, `*:${now + 3600}`);
		clock.tick(HOUR_MS + 1000);
		// The hour is over: the server's entry has lapsed, nothing to remove.
		h.client.setGlobalDnd(false, null);
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.client.presenceSnapshot().dnd).to.equal(false);
		expect(h.sent()).to.deep.equal(["AWAY"]);
	});

	it("after a reload, 8 hours to 1 hour rewrites our entry", function () {
		const first = confirmed(NOW_MS + 8 * HOUR_MS).value;
		const h = reload(true, NOW_MS + 8 * HOUR_MS);
		read(h, first);
		expect(sets(h.sent())).to.deep.equal([]);
		h.client.setGlobalDnd(true, NOW_MS + HOUR_MS);
		expect(sets(h.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 3600}`,
		]);
	});

	it("after a reload, the schedule switched off mid-window clears our entry", function () {
		const first = confirmed(NOW_MS + 2 * HOUR_MS).value;
		const h = reload(true, NOW_MS + 2 * HOUR_MS);
		read(h, first);
		h.sent();
		h.client.setGlobalDnd(false, null);
		expect(h.sent()).to.deep.equal(["METADATA * SET draft/webpush/mute", "AWAY"]);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("after a reload, an edited schedule window rewrites our entry's end", function () {
		const first = confirmed(NOW_MS + 2 * HOUR_MS).value;
		const h = reload(true, NOW_MS + 2 * HOUR_MS);
		read(h, first);
		h.client.setGlobalDnd(true, NOW_MS + 5 * HOUR_MS);
		expect(sets(h.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 5 * 3600}`,
		]);
	});

	it("without this device's memory an entry is adopted, until the user claims it", function () {
		// The final review's probe A: our own `*:+29d` read back, no memory of it.
		const h = connect();
		h.client.setGlobalDnd(true, null);
		read(h, `*:${NOW_S + 29 * 86400}`);
		h.sent();
		h.client.setGlobalDnd(true, NOW_MS + HOUR_MS);
		expect(sets(h.sent())).to.deep.equal([]);
		h.client.setGlobalDnd(true, null);
		// "For 1 hour" from the pill: claimed, then applied.
		claimMute(h.client);
		h.client.setGlobalDnd(true, NOW_MS + HOUR_MS);
		expect(sets(h.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 3600}`,
		]);
		echo(h, `*:${NOW_S + 3600}`);
		clock.tick(HOUR_MS + 1000);
		h.client.setGlobalDnd(false, null);
		expect(h.sent()).to.deep.equal(["AWAY"]);
		expect(h.client.remoteDnd).to.equal(false);
		expect(h.client.presenceSnapshot().dnd).to.equal(false);
	});

	it("a claim made before the GET waits for it, and reports no clear", function () {
		confirmed(NOW_MS + 8 * HOUR_MS);
		const h = connect();
		h.client.setGlobalDnd(true, NOW_MS + 8 * HOUR_MS);
		h.sent();
		claimMute(h.client);
		h.client.setGlobalDnd(true, NOW_MS + HOUR_MS);
		expect(sets(h.sent())).to.deep.equal([]);
		h.dispatch.resetHistory();
		// Another device's entry, then: claimed over.
		read(h, `*:${NOW_S + 3 * 3600}`);
		expect(sets(h.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 3600}`,
		]);
		expect(cleared(h)).to.have.length(0);
	});

	it("a claim that wants no entry leaves another device's DND alone", function () {
		const h = connect();
		read(h, `*:${NOW_S + 3600}`);
		h.sent();
		claimMute(h.client);
		syncPresence(h.client);
		expect(sets(h.sent())).to.deep.equal([]);
		expect(h.client.remoteDnd).to.equal(true);
		expect(h.client.muteClaim).to.equal(false);
	});

	it("a claim lifts the suppression another device's Off left", function () {
		const h = connect();
		read(h, "");
		h.client.setGlobalDnd(true, NOW_MS + 8 * HOUR_MS);
		echo(h, `*:${NOW_S + 8 * 3600}`);
		h.transport.line(":irc.test METADATA alice draft/webpush/mute *");
		expect(h.client.muteSuppressed).to.equal(true);
		h.sent();
		claimMute(h.client);
		h.client.setGlobalDnd(true, NOW_MS + HOUR_MS);
		expect(sets(h.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 3600}`,
		]);
	});

	it("another device's Off while we were disconnected stays off (probe B)", function () {
		const {h} = confirmed(NOW_MS + 8 * HOUR_MS);
		reconnect(h);
		h.sent();
		h.dispatch.resetHistory();
		read(h, "");
		expect(sets(h.sent())).to.deep.equal([]);
		expect(cleared(h).map((c) => c.args[1] as unknown)).to.deep.equal([{network: "mute-net"}]);
		expect(h.client.muteSuppressed).to.equal(true);
		// The next tick writes nothing either.
		syncPresence(h.client);
		expect(sets(h.sent())).to.deep.equal([]);
		// And the next reconnect does not report it again.
		reconnect(h);
		h.dispatch.resetHistory();
		read(h, "");
		expect(cleared(h)).to.have.length(0);
	});

	it("another device's Off before this page loaded again stays off", function () {
		confirmed(NOW_MS + 8 * HOUR_MS);
		const h = reload(true, NOW_MS + 8 * HOUR_MS);
		h.dispatch.resetHistory();
		read(h, "");
		expect(sets(h.sent())).to.deep.equal([]);
		expect(cleared(h)).to.have.length(1);
	});

	it("our entry ending by itself while away is no Off from elsewhere", function () {
		const {h} = confirmed(NOW_MS + HOUR_MS);
		h.transport.close();
		clock.tick(2 * HOUR_MS);
		h.client.setGlobalDnd(true, NOW_MS + 5 * HOUR_MS);
		reconnect(h);
		h.sent();
		h.dispatch.resetHistory();
		read(h, "");
		expect(cleared(h)).to.have.length(0);
		expect(sets(h.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 5 * 3600}`,
		]);
	});

	it("a write lost with the dying socket is written again, not adopted", function () {
		const {h} = confirmed(NOW_MS + 8 * HOUR_MS);
		h.client.setGlobalDnd(true, NOW_MS + HOUR_MS);
		expect(sets(h.sent())).to.have.length(1); // never echoed
		reconnect(h);
		h.sent();
		h.dispatch.resetHistory();
		read(h, `*:${NOW_S + 8 * 3600}`);
		expect(sets(h.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 3600}`,
		]);
		expect(h.client.muteOwned).to.equal(true);
		expect(cleared(h)).to.have.length(0);
	});

	it("another device's Off while our newer write was lost stays off", function () {
		const {h} = confirmed(NOW_MS + 8 * HOUR_MS);
		h.client.setGlobalDnd(true, NOW_MS + HOUR_MS);
		expect(sets(h.sent())).to.have.length(1); // dies with the socket
		reconnect(h);
		h.sent();
		h.dispatch.resetHistory();
		// Neither our 1 h nor our confirmed 8 h: someone took it away.
		read(h, "");
		expect(sets(h.sent())).to.deep.equal([]);
		expect(cleared(h)).to.have.length(1);
		expect(h.client.muteSuppressed).to.equal(true);
	});

	it("a clear lost with the dying socket is sent again", function () {
		const {h} = confirmed(NOW_MS + 8 * HOUR_MS);
		h.client.setGlobalDnd(false, null);
		expect(h.sent()).to.include("METADATA * SET draft/webpush/mute");
		reconnect(h);
		h.sent();
		read(h, `*:${NOW_S + 8 * 3600}`);
		expect(sets(h.sent())).to.deep.equal(["METADATA * SET draft/webpush/mute"]);
		expect(h.client.remoteDnd).to.equal(false);
	});

	it("a write that landed though its echo was lost is ours after a reload", function () {
		confirmed(NOW_MS + 8 * HOUR_MS).h.client.setGlobalDnd(true, NOW_MS + HOUR_MS);
		const h = reload(true, NOW_MS + HOUR_MS);
		read(h, `*:${NOW_S + 3600}`);
		expect(h.client.muteOwned).to.equal(true);
		expect(getMuteMemory("mute-net").confirmedUntil).to.equal(NOW_S + 3600);
		h.client.setGlobalDnd(false, null);
		expect(sets(h.sent())).to.deep.equal(["METADATA * SET draft/webpush/mute"]);
	});

	it("our own confirmed Off, then DND again after a reload: written, no clear reported", function () {
		const {h} = confirmed(NOW_MS + 8 * HOUR_MS);
		h.client.setGlobalDnd(false, null);
		echo(h, "");
		expect(getMuteMemory("mute-net")).to.deep.equal({ownedUntil: null, confirmedUntil: null});
		const h2 = reload(true, NOW_MS + 2 * HOUR_MS);
		h2.dispatch.resetHistory();
		read(h2, "");
		expect(cleared(h2)).to.have.length(0);
		expect(sets(h2.sent())).to.deep.equal([
			`METADATA * SET draft/webpush/mute private :*:${NOW_S + 2 * 3600}`,
		]);
	});

	it("another device's entry read back after a reload is adopted and forgets ours", function () {
		confirmed(NOW_MS + 8 * HOUR_MS);
		const h = reload(true, NOW_MS + 8 * HOUR_MS);
		read(h, `*:${NOW_S + 3 * 3600}`);
		expect(h.client.muteOwned).to.equal(false);
		expect(sets(h.sent())).to.deep.equal([]);
		expect(getMuteMemory("mute-net")).to.deep.equal({ownedUntil: null, confirmedUntil: null});
	});

	it("removing the network forgets this device's memory of it", function () {
		confirmed(NOW_MS + 8 * HOUR_MS);
		saved.remove("mute-net");
		expect(backend.data.has(MUTE_MEMORY_KEY)).to.equal(false);
	});

	it("a timed DND already over wants no entry; a network in mode dnd still does", function () {
		const h = connect();
		h.client.setGlobalDnd(true, NOW_MS - 1000);
		expect(desiredUntil(h.client, NOW_S)).to.equal(null);
		h.client.setPresenceMode("dnd");
		expect(desiredUntil(h.client, NOW_S)).to.equal(NOW_S + INDEFINITE_MUTE_S);
	});

	it("a network in mode dnd cleared elsewhere reports it (probe C; bus.ts sets auto)", function () {
		const h = connect();
		read(h, "");
		h.client.setPresenceMode("dnd");
		const value = `*:${NOW_S + INDEFINITE_MUTE_S}`;
		echo(h, value);
		h.sent();
		h.dispatch.resetHistory();
		h.transport.line(":irc.test METADATA alice draft/webpush/mute *");
		expect(cleared(h)).to.have.length(1);
		expect(h.client.muteSuppressed).to.equal(true);
		// What bus.ts does on dnd:cleared (test/irc/multi-network.ts).
		h.client.setPresenceMode("auto");
		expect(h.client.presenceSnapshot().dnd).to.equal(false);
		expect(h.client.muteSuppressed).to.equal(false);
		expect(sets(h.sent())).to.deep.equal([]);
	});
});
