import {expect} from "chai";
import sinon from "sinon";
// First: support loads client.ts, which pushMute.ts needs initialised (the
// pushMute ↔ presence ↔ client import cycle).
import {register, setup, type Harness} from "./support";
import {
	MODE_KEY,
	PRESENCE_KEY,
	formatStamped,
	newer,
	parseStamped,
} from "../../client/js/irc/presenceShare";
import {MUTE_READ_DELAY_MS} from "../../client/js/irc/pushMute";
import {MUTE_READ_FALLBACK_MS} from "../../client/js/irc/presence";
import {
	SYNC_WINDOW_MS,
	lastInSync,
	useStorageBackend as useSyncBackend,
} from "../../client/js/irc/presenceSync";
import type {StorageBackend} from "../../client/js/irc/saved-networks";

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

const CAPS = "server-time message-tags batch labeled-response draft/metadata-2 draft/pre-away";
const LOGIN = ":irc.test 900 alice alice!a@h alice :You are now logged in as alice";
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MODES = ["online", "auto", "away", "dnd"];

describe("shared presence values (irc/presenceShare.ts)", function () {
	it("parses <word> <ms> against its word list, and nothing else", function () {
		expect(parseStamped("away 1792000000000", MODES)).to.deep.equal({
			value: "away",
			at: 1792000000000,
		});
		expect(parseStamped("away 5", ["online", "auto", "away"])).to.deep.equal({
			value: "away",
			at: 5,
		});

		for (const bad of [
			"",
			"away",
			"away x",
			"busy 1792000000000",
			"away 1792000000000 x",
			" away 1",
			"away -1",
			"away 0",
			"away 05",
		]) {
			expect(parseStamped(bad, MODES), bad).to.equal(null);
		}

		expect(parseStamped("maybe 5", ["online", "auto", "away"])).to.equal(null);
	});

	it("formats it back", function () {
		expect(formatStamped({value: "dnd", at: 5})).to.equal("dnd 5");
	});

	it("orders by time, then by the word", function () {
		expect(newer({value: "auto", at: 2}, {value: "away", at: 1})).to.equal(true);
		expect(newer({value: "away", at: 1}, {value: "auto", at: 2})).to.equal(false);
		expect(newer({value: "online", at: 1}, {value: "away", at: 1})).to.equal(true);
		expect(newer({value: "away", at: 1}, {value: "online", at: 1})).to.equal(false);
		expect(newer({value: "on", at: 1}, {value: "off", at: 1})).to.equal(true);
		expect(newer({value: "away", at: 1}, {value: "away", at: 1})).to.equal(false);
	});
});

describe("shared presence on the wire (irc/presenceShare.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: T0, toFake: ["setTimeout", "clearTimeout", "Date"]});
	});

	afterEach(function () {
		clock.restore();
	});

	function registered(opts: {account?: boolean; metadata?: boolean} = {}): Harness {
		const h = setup({join: ""});
		register(
			h,
			opts.metadata === false ? "server-time message-tags" : CAPS,
			opts.account === false ? [] : [LOGIN]
		);
		return h;
	}

	/** Registered with an account and the cap, the login read sent. */
	function connected(opts: {account?: boolean; metadata?: boolean} = {}): Harness {
		const h = registered(opts);
		clock.tick(MUTE_READ_DELAY_MS);
		h.sent();
		return h;
	}

	const sets = (h: Harness, key: string) =>
		h.sent().filter((l) => l.startsWith(`METADATA * SET ${key} `));
	const answer = (h: Harness, key: string, value: string | null) =>
		h.transport.line(
			value === null
				? `:irc.test 766 alice alice ${key} :key not set`
				: `:irc.test 761 alice alice ${key} private :${value}`
		);
	const live = (h: Harness, key: string, value: string) =>
		h.transport.line(`:irc.test METADATA alice ${key} private :${value}`);

	it("a key named after Object.prototype's members is nobody's", function () {
		const h = connected();
		const error = sinon.stub(console, "error");

		try {
			live(h, "__proto__", "x");
			live(h, "constructor", "x");
		} finally {
			error.restore();
		}

		expect(error.called).to.equal(false);
	});

	it("the login read subscribes to and gets the mute and both shared keys", function () {
		const h = registered();
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => / (SUB|GET) /.test(l))).to.deep.equal([
			`METADATA * SUB draft/webpush/mute ${PRESENCE_KEY} ${MODE_KEY} seance/closed`,
			`METADATA * GET draft/webpush/mute ${PRESENCE_KEY} ${MODE_KEY} draft/webpush/payload seance/closed`,
		]);
	});

	describe("the mode (seance/presence)", function () {
		it("adopts a server choice newer than the device's", function () {
			const h = connected();
			h.client.setPresenceMode("online", T0 - 5000);
			h.sent();
			answer(h, PRESENCE_KEY, `away ${T0 - 1000}`);
			expect(h.client.presenceMode).to.equal("away");
			expect(h.client.presenceAt).to.equal(T0 - 1000);
			expect(h.sent()).to.include("AWAY *");
			expect(h.payloads("network:presence-shared")).to.deep.equal([
				{network: h.client.uuid, mode: "away", at: T0 - 1000},
			]);
		});

		it("adopts a server choice when the device never chose", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `dnd ${T0 - 1000}`);
			expect(h.client.presenceMode).to.equal("dnd");
		});

		it("writes a device choice newer than the server's, then its echoes write nothing", function () {
			const h = connected();
			h.client.setPresenceMode("away", T0 - 100);
			h.sent();
			answer(h, PRESENCE_KEY, `online ${T0 - 5000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0 - 100}`,
			]);
			expect(h.client.presenceMode).to.equal("away");
			answer(h, PRESENCE_KEY, `away ${T0 - 100}`);
			live(h, PRESENCE_KEY, `away ${T0 - 100}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			expect(h.payloads("network:presence-shared")).to.deep.equal([]);
		});

		it("an empty server: writes a device choice, nothing when there is none", function () {
			const chosen = connected();
			chosen.client.setPresenceMode("auto", T0 - 100);
			answer(chosen, PRESENCE_KEY, null);
			expect(sets(chosen, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :auto ${T0 - 100}`,
			]);

			const never = connected();
			answer(never, PRESENCE_KEY, null);
			expect(sets(never, PRESENCE_KEY)).to.deep.equal([]);
		});

		it("an older value arriving after ours is written back once, and its echo ends it", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `away ${T0 - 100}`);
			h.sent();
			live(h, PRESENCE_KEY, `online ${T0 - 5000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0 - 100}`,
			]);
			expect(h.client.presenceMode).to.equal("away");
			live(h, PRESENCE_KEY, `away ${T0 - 100}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
		});

		it("a choice on another device reaches this one live", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `auto ${T0 - 5000}`);
			h.sent();
			live(h, PRESENCE_KEY, `away ${T0 - 10}`);
			expect(h.client.presenceMode).to.equal("away");
			expect(h.sent()).to.include("AWAY *");
		});

		it("a choice made here after the read is written at once", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `auto ${T0 - 5000}`);
			h.client.setPresenceMode("dnd", T0);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :dnd ${T0}`,
			]);
		});

		it("ignores a value it cannot read", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, `busy ${T0 - 10}`);
			expect(h.client.presenceMode).to.equal("global");
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			h.client.setPresenceMode("away", T0 - 5);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0 - 5}`,
			]);
		});

		it("an unknown value is not answered with a write; a choice made after it is written", function () {
			// spec § 3: a later client can extend the format without us fighting it.
			const h = connected();
			h.client.setPresenceMode("online", T0 - 100);
			answer(h, PRESENCE_KEY, `busy ${T0 + 5000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			live(h, PRESENCE_KEY, `busy ${T0 + 6000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			expect(h.client.presenceMode).to.equal("online");
			h.client.setPresenceMode("away", T0);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0}`,
			]);
		});

		it("a choice before the read waits for it", function () {
			const h = registered();
			h.client.setPresenceMode("away", T0);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			clock.tick(MUTE_READ_DELAY_MS);
			answer(h, PRESENCE_KEY, `online ${T0 - 1000}`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :away ${T0}`,
			]);
		});

		it("a reconnect reads again before writing", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, null);
			h.transport.closed(); // support's close() is silent; closed() reports it

			h.client.setPresenceMode("dnd", T0 + 1);
			expect(h.client.presenceKnown).to.equal(false);
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${CAPS}`);
			const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
			h.transport.lines(
				`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`,
				":irc.test 001 alice :Welcome",
				LOGIN,
				":irc.test 422 alice :MOTD File is missing"
			);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			clock.tick(MUTE_READ_DELAY_MS);
			answer(h, PRESENCE_KEY, null);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([
				`METADATA * SET ${PRESENCE_KEY} private :dnd ${T0 + 1}`,
			]);
		});

		it("a FAIL METADATA writes nothing more until the next read", function () {
			const h = connected();
			answer(h, PRESENCE_KEY, null);
			h.client.setPresenceMode("away", T0);
			h.sent();
			h.transport.line(`:irc.test FAIL METADATA RATE_LIMITED ${PRESENCE_KEY} 5 :Rate limit`);
			expect(sets(h, PRESENCE_KEY)).to.deep.equal([]);
			expect(h.client.presenceMode).to.equal("away");
		});

		it("a FAIL METADATA for our own keys is shown to nobody; another key's still is", function () {
			// A server with draft/metadata-2 that does not take these key names
			// answers every SUB and GET with FAILs on each connect.
			const h = connected();

			for (const key of ["draft/webpush/mute", PRESENCE_KEY, MODE_KEY]) {
				h.transport.line(`:irc.test FAIL METADATA KEY_INVALID ${key} :Invalid key`);
			}

			// The spec's shapes with the target first.
			h.transport.line(`:irc.test FAIL METADATA KEY_NO_PERMISSION * ${PRESENCE_KEY} :Denied`);
			h.transport.line(`:irc.test FAIL METADATA KEY_NOT_SET * ${MODE_KEY} :Not set`);
			h.transport.line(`:irc.test FAIL METADATA RATE_LIMITED * ${MODE_KEY} 5 :Slow down`);

			expect(h.messages().filter((m) => /METADATA/.test(m.text ?? ""))).to.deep.equal([]);
			h.transport.line(":irc.test FAIL METADATA KEY_INVALID user/avatar :Invalid key");
			expect(h.messages().filter((m) => /METADATA/.test(m.text ?? ""))).to.have.length(1);
		});

		it("never reads or writes without an account or the cap", function () {
			for (const opts of [{account: false}, {metadata: false}]) {
				const h = connected(opts);
				h.client.setPresenceMode("away", T0);
				expect(h.transport.sent.filter((l) => l.includes(PRESENCE_KEY))).to.deep.equal([]);
				expect(h.client.presenceMode).to.equal("away");
			}
		});

		it("global is a network's shared mode like the others", function () {
			const h = connected();
			h.client.setPresenceMode("online", T0 - 5000);
			answer(h, PRESENCE_KEY, `global ${T0 - 1000}`);
			expect(h.client.presenceMode).to.equal("global");
			expect(h.client.effectiveMode).to.equal("auto");
		});

		it("a network on global follows the global mode live, its own mode and time unchanged", function () {
			const h = connected();
			h.client.setPresenceMode("global", T0 - 9000);
			answer(h, PRESENCE_KEY, `global ${T0 - 9000}`);
			answer(h, MODE_KEY, `auto ${T0 - 9000}`);
			h.sent();
			live(h, MODE_KEY, `away ${T0 - 10}`);
			expect(h.client.effectiveMode).to.equal("away");
			expect(h.client.presenceMode).to.equal("global");
			expect(h.client.presenceAt).to.equal(T0 - 9000);
			expect(h.sent()).to.include("AWAY *");
		});

		it("seance/away (the 2026-10-15 key) is not read", function () {
			const h = connected();
			live(h, "seance/away", `on ${T0}`);
			expect(h.client.globalMode).to.deep.equal({value: "auto", at: null});
		});

		it("a mode set with no time leaves the time alone", function () {
			const h = connected();
			h.client.setPresenceMode("away");
			expect(h.client.presenceAt).to.equal(undefined);
		});
	});

	describe("the global mode (seance/mode)", function () {
		it("adopts a newer server switch: applied here and reported to the page", function () {
			const h = connected();
			answer(h, MODE_KEY, `away ${T0 - 1000}`);
			expect(h.client.globalMode).to.deep.equal({value: "away", at: T0 - 1000});
			expect(h.sent()).to.include("AWAY *");
			expect(h.payloads("mode:shared")).to.deep.equal([
				{network: h.client.uuid, mode: "away", at: T0 - 1000},
			]);
		});

		it("writes the device's newer switch, then its echoes write nothing", function () {
			const h = connected();
			h.client.setGlobalMode({value: "away", at: T0 - 100});
			h.sent();
			answer(h, MODE_KEY, `auto ${T0 - 5000}`);
			expect(sets(h, MODE_KEY)).to.deep.equal([
				`METADATA * SET ${MODE_KEY} private :away ${T0 - 100}`,
			]);
			answer(h, MODE_KEY, `away ${T0 - 100}`);
			live(h, MODE_KEY, `away ${T0 - 100}`);
			expect(sets(h, MODE_KEY)).to.deep.equal([]);
			expect(h.payloads("mode:shared")).to.deep.equal([]);
		});

		it("a switch never touched writes nothing to an empty server", function () {
			const h = connected();
			answer(h, MODE_KEY, null);
			expect(sets(h, MODE_KEY)).to.deep.equal([]);
		});

		it("the page's switch after the read is written at once, and turning it off sends AWAY", function () {
			const h = connected();
			answer(h, MODE_KEY, null);
			h.client.setGlobalMode({value: "away", at: T0});
			expect(h.sent()).to.deep.equal([
				"AWAY *",
				`METADATA * SET ${MODE_KEY} private :away ${T0}`,
			]);
			h.client.setGlobalMode({value: "auto", at: T0 + 1});
			expect(h.sent()).to.deep.equal([
				"AWAY",
				`METADATA * SET ${MODE_KEY} private :auto ${T0 + 1}`,
			]);
		});

		it("an unknown value is not answered with a write, even with a switch of our own", function () {
			const h = connected();
			h.client.setGlobalMode({value: "away", at: T0 - 100});
			answer(h, MODE_KEY, `maybe ${T0}`);
			expect(sets(h, MODE_KEY)).to.deep.equal([]);
			expect(h.client.globalMode).to.deep.equal({value: "away", at: T0 - 100});
		});

		it("ignores a value it cannot read", function () {
			const h = connected();
			answer(h, MODE_KEY, `maybe ${T0}`);
			expect(h.client.globalMode).to.deep.equal({value: "auto", at: null});
			expect(sets(h, MODE_KEY)).to.deep.equal([]);
		});
	});
});

describe("subscribing to the shared keys (client.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: T0, toFake: ["setTimeout", "clearTimeout", "Date"]});
	});

	afterEach(function () {
		clock.restore();
	});

	const SUB = `METADATA * SUB draft/webpush/mute ${PRESENCE_KEY} ${MODE_KEY} seance/closed`;
	const GET = `METADATA * GET draft/webpush/mute ${PRESENCE_KEY} ${MODE_KEY} draft/webpush/payload seance/closed`;

	/** A SASL login on a server offering `metadata`; returns the CAP END flush. */
	function saslLogin(h: Harness, metadata: string, batch = "batch"): string[] {
		h.client.connect();
		h.transport.open();
		h.transport.line(
			`:irc.test CAP * LS :server-time message-tags ${batch} sasl=PLAIN ${metadata}`
		);
		const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
		h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
		h.sent();
		h.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!a@h alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		return h.sent();
	}

	const welcome = (h: Harness) =>
		h.transport.lines(
			":irc.test 001 alice :Welcome",
			":irc.test 422 alice :MOTD File is missing"
		);

	it("subscribes before CAP END when the server offers before-connect, then only GETs", function () {
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		const flush = saslLogin(h, "draft/metadata-2=before-connect,max-subs=50");
		expect(flush.slice(-2)).to.deep.equal([SUB, "CAP END"]);
		welcome(h);
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => l.startsWith("METADATA"))).to.deep.equal([GET]);
	});

	it("without before-connect, subscribes with the login read as before", function () {
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		const flush = saslLogin(h, "draft/metadata-2=max-subs=50");
		expect(flush.filter((l) => l.startsWith("METADATA"))).to.deep.equal([]);
		welcome(h);
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => l.startsWith("METADATA"))).to.deep.equal([SUB, GET]);
	});

	it("without batch, neither subscribes before CAP END nor reads the keys", function () {
		// draft/metadata-2 MUST have batch: its burst and lists are batches.
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		const flush = saslLogin(h, "draft/metadata-2=before-connect,max-subs=50", "");
		expect(flush.filter((l) => l.startsWith("METADATA"))).to.deep.equal([]);
		expect(h.client.metadataBeforeConnect).to.equal(false);
		welcome(h);
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => l.startsWith("METADATA"))).to.deep.equal([]);
	});

	/** LS without batch or metadata-2; both arrive by CAP NEW during SASL, unanswered at 903. */
	function newDuringSasl(h: Harness, offer: string): string[] {
		h.client.connect();
		h.transport.open();
		h.transport.line(":irc.test CAP * LS :server-time cap-notify sasl=PLAIN");
		const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
		h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
		h.transport.line(`:irc.test CAP alice NEW :${offer}`);
		h.sent();
		h.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!a@h alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		return h.sent();
	}

	it("sends no SUB before CAP END while metadata-2 is pending and batch is off", function () {
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		const flush = newDuringSasl(h, "draft/metadata-2=before-connect");
		expect(h.client.caps.isRequesting("draft/metadata-2")).to.equal(true);
		expect(flush.filter((l) => l.startsWith("METADATA"))).to.deep.equal([]);
		expect(h.client.metadataBeforeConnect).to.equal(false);
	});

	it("forgets a SUB sent while batch was pending once batch is refused by 001", function () {
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		const flush = newDuringSasl(h, "batch draft/metadata-2=before-connect");
		// batch is still asked for, so the SUB may go out: nefarious2 keeps it if batch comes.
		expect(flush.filter((l) => l.startsWith("METADATA"))).to.deep.equal([SUB]);
		h.transport.line(":irc.test CAP alice NAK :batch draft/metadata-2");
		h.transport.lines(
			":irc.test CAP alice NAK :batch",
			":irc.test CAP alice ACK :draft/metadata-2"
		);
		welcome(h);
		expect(h.client.metadataBeforeConnect).to.equal(false);
		expect(h.client.metadataSubscribed).to.equal(false);
	});

	it("starts the reads when batch arrives after 001, and stops them when it goes", function () {
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		saslLogin(h, "cap-notify draft/metadata-2=max-subs=50", "");
		welcome(h);
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => l.startsWith("METADATA"))).to.deep.equal([]);

		h.transport.line(":irc.test CAP alice NEW :batch");
		expect(h.sent()).to.deep.equal(["CAP REQ :batch"]);
		h.transport.line(":irc.test CAP alice ACK :batch");
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => l.startsWith("METADATA"))).to.deep.equal([SUB, GET]);

		// The registration hold ends with metadata's use: nothing would end it.
		h.client.metadataBeforeConnect = true;
		h.transport.line(":irc.test CAP alice DEL :batch");
		expect(h.client.metadataBeforeConnect).to.equal(false);
		h.transport.line(":irc.test CAP alice NEW :batch");
		h.transport.line(":irc.test CAP alice ACK :batch");
		clock.tick(MUTE_READ_DELAY_MS);
		h.sent();

		// batch deleted while a fresh read waits: the read does not go out.
		h.transport.line(":irc.test CAP alice DEL :batch");
		h.transport.line(":irc.test CAP alice NEW :batch");
		h.transport.line(":irc.test CAP alice ACK :batch");
		h.transport.line(":irc.test CAP alice DEL :batch");
		h.sent();
		clock.tick(MUTE_READ_DELAY_MS);
		expect(h.sent().filter((l) => l.startsWith("METADATA"))).to.deep.equal([]);
		expect(h.client.metadataSubscribed).to.equal(false);
	});

	it("a reconnect subscribes again", function () {
		const h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		saslLogin(h, "draft/metadata-2=before-connect");
		welcome(h);
		h.transport.closed();
		expect(h.client.metadataSubscribed).to.equal(false);
	});
});

describe("away until the shared state is read (presence.ts shareUnread)", function () {
	// A device that missed a change (the global Away set on another device)
	// declared its own stale state at login and showed the account back
	// until the registration burst brought the change (measured live). Only
	// a device that may have missed one holds: a reload or a quick reconnect
	// of a connection that was in sync says nothing at all.
	let clock: sinon.SinonFakeTimers;
	let backend: MemoryBackend;

	beforeEach(function () {
		clock = sinon.useFakeTimers({now: T0, toFake: ["setTimeout", "clearTimeout", "Date"]});
		backend = new MemoryBackend();
		useSyncBackend(backend);
	});

	afterEach(function () {
		clock.restore();
		useSyncBackend(null);
	});

	const NEF =
		"server-time message-tags batch sasl=PLAIN draft/pre-away draft/metadata-2=before-connect";

	it("has no sync time under a name every object has", function () {
		expect(lastInSync("constructor")).to.equal(null);
	});

	function login(
		caps = NEF,
		h = setup({join: "", sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"})
	): Harness {
		h.client.connect();
		h.transport.open();
		h.transport.line(`:irc.test CAP * LS :${caps}`);
		const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
		h.transport.line(`:irc.test CAP alice ACK :${req.slice("CAP REQ :".length)}`);
		h.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!a@h alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		return h;
	}

	const welcome = (h: Harness) =>
		h.transport.lines(
			":irc.test 001 alice :Welcome",
			":irc.test 422 alice :MOTD File is missing"
		);
	const burst = (h: Harness, ...values: string[]) =>
		h.transport.lines(
			":irc.test BATCH +m1 metadata alice",
			...values.map((v) => `@batch=m1 :irc.test METADATA alice ${v}`),
			":irc.test BATCH -m1"
		);
	const aways = (lines: string[]) => lines.filter((l) => l.startsWith("AWAY"));
	/** The same network after a reload: a new client with the old one's uuid. */
	const reloaded = (h: Harness) =>
		login(
			NEF,
			setup({
				join: "",
				sasl: "plain",
				saslAccount: "alice",
				saslPassword: "s3cret",
				uuid: h.client.uuid,
			})
		);

	/** A connection that read the shared state, then went quiet for `quietMs` and closed. */
	function syncedThenClosed(quietMs: number): Harness {
		const h = login();
		welcome(h);
		burst(h);
		clock.tick(MUTE_READ_DELAY_MS);
		h.transport.lines(
			`:irc.test 766 alice alice draft/webpush/mute :key not set`,
			`:irc.test 766 alice alice ${PRESENCE_KEY} :key not set`,
			`:irc.test 766 alice alice ${MODE_KEY} :key not set`
		);
		clock.tick(quietMs);
		h.transport.closed();
		h.sent();
		return h;
	}

	it("a device never in sync declares away at login, and says back once the burst is read", function () {
		const h = login();
		expect(aways(h.sent()), "declared before CAP END").to.deep.equal(["AWAY *"]);
		welcome(h);
		expect(aways(h.sent()), "the repeat after registration").to.deep.equal(["AWAY *"]);
		burst(h, "draft/persistence/hold private :1");
		expect(aways(h.sent()), "nothing shared says away: back").to.deep.equal(["AWAY"]);
	});

	it("the global Away read in the burst keeps it away: nobody sees it come back", function () {
		const h = login();
		welcome(h);
		h.sent();
		burst(
			h,
			`seance/mode private :away ${T0 - 1000}`,
			`seance/presence private :global ${T0 - 2000}`
		);
		expect(aways(h.sent())).to.deep.equal([]);
		expect(h.client.globalMode).to.deep.equal({value: "away", at: T0 - 1000});
	});

	it("another device's do not disturb in the burst keeps it away", function () {
		const h = login();
		welcome(h);
		h.sent();
		burst(h, "draft/webpush/mute private :*:0");
		expect(aways(h.sent())).to.deep.equal([]);
		expect(h.client.remoteDnd).to.equal(true);
	});

	it("a burst without the mute key reads nothing into it (the burst can be stale)", function () {
		const h = login();
		welcome(h);
		burst(h);
		expect(h.client.muteKnown).to.equal(false);
		expect(h.client.presenceKnown).to.equal(false);
		expect(h.client.globalKnown).to.equal(false);
	});

	it("Online is held away until the read too", function () {
		const h = login();
		h.client.setPresenceMode("online");
		expect(aways(h.sent())).to.include("AWAY *");
	});

	it("with no burst and no answer, the read's fallback ends the hold", function () {
		const h = login();
		welcome(h);
		h.sent();
		clock.tick(MUTE_READ_FALLBACK_MS);
		expect(aways(h.sent())).to.deep.equal(["AWAY"]);
	});

	it("a login without draft/metadata-2 shares nothing and declares nothing", function () {
		const h = login("server-time message-tags batch sasl=PLAIN draft/pre-away");
		expect(aways(h.sent())).to.deep.equal([]);
	});

	it("a quick reconnect of a connection in sync declares nothing", function () {
		const h = syncedThenClosed(1000);
		login(NEF, h);
		expect(aways(h.sent())).to.deep.equal([]);
		welcome(h);
		burst(h);
		expect(aways(h.sent())).to.deep.equal([]);
	});

	it("a reload in the window declares nothing: the time is kept on the device", function () {
		const h = reloaded(syncedThenClosed(1000));
		expect(aways(h.sent())).to.deep.equal([]);
	});

	it("a connection silent for longer than the window holds, however late its close came", function () {
		// A socket the OS killed in the background reports its close only
		// when the page wakes: the last line in, not the close, dates it.
		const h = reloaded(syncedThenClosed(SYNC_WINDOW_MS + 1000));
		expect(aways(h.sent())).to.deep.equal(["AWAY *"]);
	});

	it("a reload after the window holds", function () {
		const old = syncedThenClosed(1000);
		clock.tick(SYNC_WINDOW_MS);
		const h = reloaded(old);
		expect(aways(h.sent())).to.deep.equal(["AWAY *"]);
	});
});
