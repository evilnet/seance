/**
 * The away state declared during registration (`draft/pre-away`,
 * client/js/irc/presence.ts `registrationAwayLine`) and the user's `/away`
 * remembered across reloads (client/js/irc/userAwayStore.ts).
 *
 * nefarious2's bouncer attaches a reconnect or a reload to the held
 * session; a connection that registers without saying it is away counts as
 * present, and the server announces the user back to everyone. So the
 * away goes out in the flush that carries `CAP END`, right before it.
 */

import {expect} from "chai";
import sinon from "sinon";
import {dispatchInput} from "../../client/js/irc/commands";
import * as saved from "../../client/js/irc/saved-networks";
import {
	USER_AWAY_KEY,
	getUserAway,
	pruneUserAway,
	setUserAway,
	useStorageBackend,
	type StorageBackend,
} from "../../client/js/irc/userAwayStore";
import {leavesAwayToWorker, MUTE_READ_FALLBACK_MS} from "../../client/js/irc/presence";
import {MessageType} from "../../shared/types/msg";
import {ALL_CAPS, Harness, setup} from "./support";

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

const UUID = "preaway-net";
const PRE_AWAY_CAPS = `${ALL_CAPS} draft/pre-away`;
const SASL_CAPS = `${PRE_AWAY_CAPS} sasl=PLAIN draft/persistence=attach,detach,list,attach-cursor`;

/** CAP LS / REQ / ACK; returns what was sent from the LS on. */
function negotiate(h: Harness, caps: string): string[] {
	h.sent();
	h.transport.open();
	h.transport.line(`:irc.test CAP * LS :${caps}`);
	const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop();
	expect(req, "CAP REQ sent").to.be.a("string");
	h.transport.line(`:irc.test CAP alice ACK :${(req as string).slice("CAP REQ :".length)}`);
	return h.sent();
}

function welcome(h: Harness): string[] {
	h.transport.lines(
		":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
		":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CASEMAPPING=rfc1459 :are supported by this server",
		":irc.test 422 alice :MOTD File is missing"
	);
	return h.sent();
}

/** Connect and register; returns [lines up to and including CAP END, lines after 001]. */
function connect(h: Harness, caps = PRE_AWAY_CAPS): [string[], string[]] {
	h.client.connect();
	const before = negotiate(h, caps);
	return [before, welcome(h)];
}

/** The socket drops and the client dials again. */
function reconnect(h: Harness, caps = PRE_AWAY_CAPS): [string[], string[]] {
	h.transport.closed();
	return connect(h, caps);
}

const aways = (lines: string[]) => lines.filter((l) => l.startsWith("AWAY"));

/** The lines from the first AWAY to CAP END, which must close the list. */
function tail(lines: string[]): string[] {
	expect(lines[lines.length - 1]).to.equal("CAP END");
	const i = lines.findIndex((l) => l.startsWith("AWAY"));
	return i < 0 ? ["CAP END"] : lines.slice(i);
}

function client(overrides = {}): Harness {
	return setup({uuid: UUID, ...overrides});
}

describe("the away state across reloads and reconnects (draft/pre-away)", function () {
	let backend: MemoryBackend;
	let savedBackend: MemoryBackend;

	beforeEach(function () {
		backend = new MemoryBackend();
		savedBackend = new MemoryBackend();
		useStorageBackend(backend);
		saved.useStorageBackend(savedBackend);
	});

	afterEach(function () {
		useStorageBackend(null);
		saved.useStorageBackend(null);
	});

	it("keeps no away text under a name every object has", function () {
		expect(getUserAway("constructor")).to.equal(null);
		expect(getUserAway("__proto__")).to.equal(null);
		setUserAway("__proto__", "brb");
		expect(getUserAway("__proto__")).to.equal("brb");
	});

	it("requests draft/pre-away", function () {
		const h = client();
		const [before] = connect(h);
		const req = before.find((l) => l.startsWith("CAP REQ :")) as string;
		expect(req.slice("CAP REQ :".length).split(" ")).to.include("draft/pre-away");
	});

	it("declares a /away right before CAP END on a reconnect, and says it once more after registration", function () {
		const h = client();
		connect(h);
		dispatchInput(h.client, h.client.lobby, "/away gone fishing");
		expect(aways(h.sent())).to.deep.equal(["AWAY :gone fishing"]);

		const [before, after] = reconnect(h);
		expect(tail(before)).to.deep.equal(["AWAY :gone fishing", "CAP END"]);
		// nefarious2 resets the connection's own away record once it has
		// applied the declaration (presence.ts presenceRegistered).
		expect(aways(after)).to.deep.equal(["AWAY :gone fishing"]);
		expect(h.client.presence.userAway).to.equal(true);

		h.dispatch.resetHistory();
		h.transport.line(":irc.test 306 alice :You have been marked as being away");
		expect(
			h.messages(h.client.lobby.id).filter((m) => m.type === MessageType.AWAY),
			"its 306 is not news"
		).to.deep.equal([]);
	});

	it("with SASL: PERSISTENCE ATTACH, then the AWAY, then CAP END", function () {
		saved.save({
			uuid: UUID,
			name: "",
			host: "irc.test",
			port: 8443,
			tls: true,
			nick: "alice",
			join: "#seance",
			sasl: "plain",
			saslAccount: "alice",
			saslPassword: "",
			cursor: {msgid: "m-42", time: Date.parse("2026-08-28T11:00:00.000Z")},
		});
		backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "gone fishing"}));
		const s = client({sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});

		s.client.connect();
		const opened = negotiate(s, SASL_CAPS);
		expect(aways(opened), "no AWAY before SASL is done").to.deep.equal([]);
		expect(opened).to.not.include("CAP END");
		s.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		const flush = s.sent();
		const from = flush.findIndex((l) => l.startsWith("PERSISTENCE ATTACH"));
		expect(flush.slice(from)).to.deep.equal([
			"PERSISTENCE ATTACH default m-42",
			"AWAY :gone fishing",
			"CAP END",
		]);
		expect(aways(welcome(s))).to.deep.equal(["AWAY :gone fishing"]);
	});

	it("a reload declares the /away the storage holds", function () {
		backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "x"}));
		const h = client();
		expect(h.client.presence.userAway).to.equal(true);
		const [before, after] = connect(h);
		expect(tail(before)).to.deep.equal(["AWAY :x", "CAP END"]);
		expect(aways(after)).to.deep.equal(["AWAY :x"]);
	});

	it("a bare /away is kept and declared as the single space it sent", function () {
		const h = client();
		connect(h);
		dispatchInput(h.client, h.client.lobby, "/away");
		expect(getUserAway(UUID)).to.equal(" ");
		const [before] = reconnect(h);
		expect(tail(before)).to.deep.equal(["AWAY : ", "CAP END"]);
	});

	it("/back forgets it: the next registration declares nothing", function () {
		const h = client();
		connect(h);
		dispatchInput(h.client, h.client.lobby, "/away x");
		dispatchInput(h.client, h.client.lobby, "/back");
		expect(getUserAway(UUID)).to.equal(null);
		expect(backend.get(USER_AWAY_KEY)).to.equal(null);

		const [before, after] = reconnect(h);
		expect(aways(before)).to.deep.equal([]);
		expect(aways(after)).to.deep.equal([]);
		// A reload too.
		expect(client().client.presence.userAway).to.equal(false);
	});

	it("removing the network forgets it", function () {
		const h = client();
		connect(h);
		dispatchInput(h.client, h.client.lobby, "/away x");
		saved.remove(UUID);
		expect(getUserAway(UUID)).to.equal(null);
	});

	for (const [label, arrange] of [
		["do not disturb", (h: Harness) => h.client.setGlobalDnd(true, null)],
		["away mode", (h: Harness) => h.client.setPresenceMode("away")],
		["a hidden page", (h: Harness) => h.client.setAttended(false)],
		["global mode away", (h: Harness) => h.client.setGlobalMode({value: "away", at: 1})],
	] as const) {
		it(`${label} at connect declares AWAY * during registration, and says it once more after`, function () {
			const h = client();
			arrange(h);
			const [before, after] = connect(h);
			expect(tail(before)).to.deep.equal(["AWAY *", "CAP END"]);
			expect(aways(after)).to.deep.equal(["AWAY *"]);
			expect(h.client.presence.starSent).to.equal(true);

			// The page comes back (or the mode goes): AWAY, once.
			h.client.setGlobalMode({value: "auto", at: 2});
			h.client.setGlobalDnd(false, null);
			h.client.setPresenceMode("auto");
			h.client.setAttended(true);
			expect(aways(h.sent())).to.deep.equal(["AWAY"]);
		});

		it(`${label} on a reconnect declares AWAY * again`, function () {
			const h = client();
			connect(h);
			arrange(h);
			expect(aways(h.sent())).to.deep.equal(["AWAY *"]);
			const [before, after] = reconnect(h);
			expect(tail(before)).to.deep.equal(["AWAY *", "CAP END"]);
			expect(aways(after)).to.deep.equal(["AWAY *"]);
		});
	}

	it("away mode resuming a session another device left present stays away (the repeat after registration)", function () {
		// Measured on nefarious2 (tools/scenarios/presence-modes-two-devices.mjs
		// step 7): device B on Online closed last, so the held session was
		// present; A on Away resumed it, declared AWAY * before CAP END, and
		// the server counted A present until A said it again.
		const h = client();
		h.client.setPresenceMode("away");
		const [before, after] = connect(h);
		expect(tail(before)).to.deep.equal(["AWAY *", "CAP END"]);
		expect(aways(after)).to.deep.equal(["AWAY *"]);
		expect(h.client.presence.starSent).to.equal(true);
		expect(h.client.presence.quietReplies, "its 306 kept quiet").to.equal(1);
	});

	it("a hidden page in online mode declares nothing", function () {
		const h = client();
		h.client.setPresenceMode("online");
		h.client.setAttended(false);
		const [before, after] = connect(h);
		expect(aways(before)).to.deep.equal([]);
		expect(aways(after)).to.deep.equal([]);
	});

	it("an attended page on auto, no DND, declares nothing", function () {
		const [before, after] = connect(client());
		expect(aways(before)).to.deep.equal([]);
		expect(aways(after)).to.deep.equal([]);
	});

	describe("without draft/pre-away", function () {
		it("sends nothing during registration, then the /away once, its 306 unshown", function () {
			backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "x"}));
			const h = client();
			const [before, after] = connect(h, ALL_CAPS);
			expect(aways(before)).to.deep.equal([]);
			expect(aways(after)).to.deep.equal(["AWAY :x"]);

			h.dispatch.resetHistory();
			h.transport.line(":irc.test 306 alice :You have been marked as being away");
			expect(
				h.messages(h.client.lobby.id).filter((m) => m.type === MessageType.AWAY)
			).to.deep.equal([]);
			expect(aways(h.sent())).to.deep.equal([]);
		});

		it("a hidden page on Auto says nothing; Away mode says a real away message", function () {
			// Without the cap `AWAY *` is an away message of "*", and Auto would
			// tell the channel about every tab switch (presence.ts speaksPreAway).
			const h = client();
			h.client.setAttended(false);
			const [before, after] = connect(h, ALL_CAPS);
			expect(aways(before)).to.deep.equal([]);
			expect(aways(after)).to.deep.equal([]);

			h.client.setPresenceMode("away");
			expect(aways(h.sent())).to.deep.equal(["AWAY :Away"]);
		});

		it("a NAKed draft/pre-away falls back to after registration", function () {
			backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "x"}));
			const h = client();
			h.client.connect();
			h.sent();
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${PRE_AWAY_CAPS}`);
			// Pipelined: the declaration rode on the requested cap.
			expect(tail(h.sent())).to.deep.equal(["AWAY :x", "CAP END"]);
			const req = h.transport.sent.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
			h.transport.line(`:irc.test CAP alice NAK :${req.slice("CAP REQ :".length)}`);

			// The per-cap retries: everything but pre-away is ACKed.
			for (const line of h.sent().filter((l) => l.startsWith("CAP REQ :"))) {
				const name = line.slice("CAP REQ :".length);
				h.transport.line(
					`:irc.test CAP alice ${name === "draft/pre-away" ? "NAK" : "ACK"} :${name}`
				);
			}

			expect(aways(welcome(h))).to.deep.equal(["AWAY :x"]);
		});
	});

	describe("a NAKed REQ whose per-cap retry is ACKed before 001", function () {
		/** LS, then NAK the whole REQ and ACK every per-cap retry. */
		function nakThenRetry(h: Harness, caps: string): string[] {
			h.client.connect();
			h.sent();
			h.transport.open();
			h.transport.line(`:irc.test CAP * LS :${caps}`);
			const first = h.sent();
			const req = first.filter((l) => l.startsWith("CAP REQ :")).pop() as string;
			h.transport.line(`:irc.test CAP alice NAK :${req.slice("CAP REQ :".length)}`);

			for (const line of h.sent().filter((l) => l.startsWith("CAP REQ :"))) {
				h.transport.line(`:irc.test CAP alice ACK :${line.slice("CAP REQ :".length)}`);
			}

			return first;
		}

		it("says the /away again after 001: the server read it with the cap off", function () {
			backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "x"}));
			const h = client();
			const first = nakThenRetry(h, PRE_AWAY_CAPS);
			expect(tail(first), "pipelined under the REQ that is NAKed").to.deep.equal([
				"AWAY :x",
				"CAP END",
			]);
			expect(h.client.caps.hasCapability("draft/pre-away")).to.equal(true);
			expect(aways(welcome(h))).to.deep.equal(["AWAY :x"]);
		});

		it("says AWAY * again after 001 for a hidden page, and counts it sent", function () {
			const h = client();
			h.client.setAttended(false);
			const first = nakThenRetry(h, PRE_AWAY_CAPS);
			expect(tail(first)).to.deep.equal(["AWAY *", "CAP END"]);
			expect(aways(welcome(h))).to.deep.equal(["AWAY *"]);
			expect(h.client.presence.starSent).to.equal(true);
		});

		it("with SASL the declaration rides on the ACKed retry, and is said once more after 001", function () {
			backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "x"}));
			const h = client({sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
			const first = nakThenRetry(h, SASL_CAPS);
			expect(aways(first), "nothing before SASL is done").to.deep.equal([]);
			h.transport.lines(
				"AUTHENTICATE +",
				":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
				":irc.test 903 alice :SASL authentication successful"
			);
			expect(tail(h.sent())).to.deep.equal(["AWAY :x", "CAP END"]);
			expect(aways(welcome(h))).to.deep.equal(["AWAY :x"]);
		});
	});

	it("a required login that fails declares nothing and leaves no star counted", function () {
		const h = client({sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		h.client.setAttended(false);
		h.client.connect();
		h.sent();
		h.transport.open();
		// No sasl offered: the login cannot happen, the client QUITs.
		h.transport.line(`:irc.test CAP * LS :${PRE_AWAY_CAPS}`);
		const sent = h.sent();
		expect(sent).to.include("QUIT :SASL authentication failed");
		expect(aways(sent)).to.deep.equal([]);
		expect(sent).to.not.include("CAP END");
		expect(h.client.presence.starSent).to.equal(false);
	});

	it("prunes the /away of networks that are gone", function () {
		backend.set(USER_AWAY_KEY, JSON.stringify({kept: "a", gone: "b"}));
		pruneUserAway(["kept", "other"]);
		expect(JSON.parse(backend.get(USER_AWAY_KEY) as string)).to.deep.equal({kept: "a"});
		pruneUserAway([]);
		expect(backend.get(USER_AWAY_KEY)).to.equal(null);
	});
});

describe("another user's AWAY * (draft/pre-away)", function () {
	const open: Harness[] = [];

	// The JOIN's CHATHISTORY is never answered: close the socket so its
	// 15 s timeout does not keep mocha waiting.
	afterEach(function () {
		open.splice(0).forEach((h) => h.transport.closed());
	});

	function registered(): Harness {
		const h = setup();
		open.push(h);
		connect(h);
		h.transport.line(":alice!a@host JOIN #seance");
		h.transport.lines(
			":irc.test 353 alice = #seance :alice bob",
			":irc.test 366 alice #seance :End of /NAMES list."
		);
		h.sent();
		return h;
	}

	it("keeps the star apart from present, so a query still sees bob come back", function () {
		const h = registered();
		dispatchInput(h.client, h.client.lobby, "/query bob");
		const query = h.client.findChannel("bob");
		expect(query).to.not.equal(undefined);
		const chan = h.client.findChannel("#seance");
		h.dispatch.resetHistory();

		h.transport.line(":bob!b@host AWAY :lunch");
		h.transport.line(":bob!b@host AWAY *");
		expect(query?.userAway).to.equal("*");
		expect(chan?.findUser("bob")?.away, "away in the user list too").to.equal("*");
		h.transport.line(":bob!b@host AWAY");
		expect(chan?.findUser("bob")?.away).to.equal("");

		const types = h.messages(query?.id).map((m) => m.type);
		expect(types).to.deep.equal([MessageType.AWAY, MessageType.BACK]);
	});

	it("shows a 301 star as away without a message, in a whois and in a query", function () {
		const h = registered();
		h.transport.lines(
			":irc.test 311 alice bob ~bob host.example * :Bob Example",
			":irc.test 301 alice bob :*",
			":irc.test 318 alice bob :End of /WHOIS list."
		);
		const whois = h.messages().find((m) => m.type === MessageType.WHOIS);
		expect(whois?.whois?.away, "the card shows Away, no message").to.equal("*");

		dispatchInput(h.client, h.client.lobby, "/query bob");
		const query = h.client.findChannel("bob");
		h.dispatch.resetHistory();
		h.transport.line(":irc.test 301 alice bob :*");
		h.transport.line(":irc.test 301 alice bob :*");
		const shown = h.messages(query?.id).filter((m) => m.type === MessageType.AWAY);
		expect(
			shown.map((m) => m.text),
			"is away, no message"
		).to.deep.equal([""]);
		expect(query?.userAway).to.equal("*");
	});
});

describe("a closing page leaves AWAY * to the service worker (presence.ts leavesAwayToWorker)", function () {
	const stashed = (uuid: string) => uuid === UUID;

	function held(): Harness {
		const h = setup({uuid: UUID});
		connect(h);
		h.transport.line(":irc.test PERSISTENCE STATUS ON ON");
		return h;
	}

	it("a present Auto connection whose session is held and whose login is stashed", function () {
		expect(leavesAwayToWorker(held().client, stashed)).to.equal(true);
	});

	it("an alias of another device's session (STATUS ON OFF), and before any STATUS", function () {
		const h = setup({uuid: UUID, sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		h.client.connect();
		negotiate(h, SASL_CAPS);
		h.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		welcome(h);
		expect(leavesAwayToWorker(h.client, stashed), "no STATUS yet").to.equal(true);
		h.transport.lines(
			":irc.test NOTE BOUNCER ALIAS_ATTACHED :Attached to session x as alias",
			":irc.test PERSISTENCE STATUS ON OFF"
		);
		expect(h.client.persistenceHold).to.equal(false);
		expect(leavesAwayToWorker(h.client, stashed), "an alias").to.equal(true);

		// A primary told not to hold reads ON OFF too: only an alias's counts.
		const primary = setup({
			uuid: UUID,
			sasl: "plain",
			saslAccount: "alice",
			saslPassword: "s3cret",
		});
		primary.client.connect();
		negotiate(primary, SASL_CAPS);
		primary.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		welcome(primary);
		primary.transport.line(":irc.test PERSISTENCE STATUS ON OFF");
		expect(leavesAwayToWorker(primary.client, stashed), "a primary reading ON OFF").to.equal(
			false
		);

		// The server says it will not hold the session: believed.
		h.transport.line(":irc.test PERSISTENCE STATUS OFF OFF");
		expect(leavesAwayToWorker(h.client, stashed)).to.equal(false);
	});

	for (const [label, arrange] of [
		["no stashed login", () => setup({uuid: "other-net"})],
		["no persistence (the close is a QUIT)", () => setup({uuid: UUID})],
	] as const) {
		it(`not with ${label}`, function () {
			const h = arrange();
			connect(h);
			expect(leavesAwayToWorker(h.client, stashed)).to.equal(false);
		});
	}

	for (const [label, arrange] of [
		["/away", (h: Harness) => dispatchInput(h.client, h.client.lobby, "/away x")],
		["a star already sent", (h: Harness) => h.client.setAttended(false)],
		["do not disturb", (h: Harness) => h.client.setGlobalDnd(true, null)],
		["away mode", (h: Harness) => h.client.setPresenceMode("away")],
		["online mode", (h: Harness) => h.client.setPresenceMode("online")],
		["a closed socket", (h: Harness) => h.transport.closed()],
	] as const) {
		it(`not with ${label}`, function () {
			const h = held();
			arrange(h);
			expect(leavesAwayToWorker(h.client, stashed)).to.equal(false);
		});
	}
});

describe("a held session says AWAY once remote DND is known (presence.ts armResumeCheck)", function () {
	const META_CAPS = `${SASL_CAPS} draft/metadata-2`;
	const RESTORE = [
		":irc.test BATCH +r1 draft/persistence",
		"@batch=r1 :alice!a@host JOIN #seance",
		":irc.test BATCH -r1",
	];
	const EMPTY = ":irc.test 766 alice alice draft/webpush/mute :key not set";
	const OTHER_DND = ":irc.test 761 alice alice draft/webpush/mute * :*:0";
	let clock: sinon.SinonFakeTimers;
	let backend: MemoryBackend;

	beforeEach(function () {
		clock = sinon.useFakeTimers({
			now: Date.UTC(2026, 9, 13),
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
		backend = new MemoryBackend();
		useStorageBackend(backend);
	});

	afterEach(function () {
		clock.restore();
		useStorageBackend(null);
	});

	/** SASL login, registration, then `lines` (the restoration batch, say); returns what was sent after 001. */
	function register(caps: string, arrange?: (h: Harness) => void, lines: string[] = RESTORE) {
		const h = setup({uuid: UUID, sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		arrange?.(h);
		h.client.connect();
		negotiate(h, caps);
		h.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful"
		);
		h.sent();
		// The server's order: STATUS inside the MOTD burst, before its end.
		h.transport.lines(
			":irc.test 001 alice :Welcome to the SeanceDev IRC Network, alice",
			":irc.test 005 alice CHANTYPES=#& PREFIX=(ov)@+ CASEMAPPING=rfc1459 :are supported by this server",
			":irc.test PERSISTENCE STATUS ON ON",
			":irc.test 422 alice :MOTD File is missing",
			...lines
		);
		return h;
	}

	it("waits for the mute read: another device's DND makes it AWAY *, never a bare AWAY", function () {
		const h = register(META_CAPS);
		expect(aways(h.sent()), "nothing in the connect burst").to.deep.equal([]);
		clock.tick(10_000);
		expect(h.sent()).to.include(
			"METADATA * GET draft/webpush/mute seance/presence seance/mode draft/webpush/payload seance/closed"
		);
		h.transport.line(OTHER_DND);
		expect(aways(h.sent())).to.deep.equal(["AWAY *"]);
	});

	it("says AWAY once after the read finds no DND, its 305 unshown", function () {
		const h = register(META_CAPS);
		clock.tick(10_000);
		h.sent();
		h.transport.line(EMPTY);
		expect(aways(h.sent())).to.deep.equal(["AWAY"]);
		h.dispatch.resetHistory();
		h.transport.line(":irc.test 305 alice :You are no longer marked as being away");
		expect(h.messages(h.client.lobby.id)).to.deep.equal([]);
		h.transport.line(EMPTY);
		expect(aways(h.sent()), "once").to.deep.equal([]);
	});

	it("says it at once where the mute list cannot be read (no draft/metadata-2)", function () {
		const h = register(SASL_CAPS);
		expect(aways(h.sent())).to.deep.equal(["AWAY"]);
	});

	// No batch tells a resume from a fresh session: nefarious2 sends no
	// restoration batch for a held session with no channels, and no replay
	// batch when nothing was missed. So every primary connection to a held
	// session says it once after the read; a fresh one only gets a quiet 305
	// (the rule changed in round 3: it used to say nothing).
	// A fresh session is arranged the same way (STATUS ON ON, no batch), and
	// its 305 is kept quiet as in "says AWAY once after the read" above.
	it("a held session with no channels (no batch at all) says AWAY after the read", function () {
		const h = register(META_CAPS, undefined, []);
		expect(aways(h.sent())).to.deep.equal([]);
		clock.tick(10_000);
		h.transport.line(EMPTY);
		expect(aways(h.sent())).to.deep.equal(["AWAY"]);
	});

	it("goes ahead without the read after MUTE_READ_FALLBACK_MS (a FAIL METADATA, say)", function () {
		const h = register(META_CAPS);
		clock.tick(10_000);
		h.transport.line(
			"FAIL METADATA RATE_LIMITED draft/webpush/mute :Too many requests, slow down"
		);
		expect(aways(h.sent())).to.deep.equal([]);
		clock.tick(MUTE_READ_FALLBACK_MS - 10_000);
		const after = h.sent();
		expect(aways(after)).to.deep.equal(["AWAY"]);
		// ...and asks for the list once more: without it this connection
		// would never mute push for this device's DND.
		expect(after.filter((l) => l.includes("METADATA"))).to.deep.equal([
			"METADATA * GET draft/webpush/mute",
		]);
		h.transport.line(OTHER_DND);
		expect(h.client.muteKnown).to.equal(true);
		expect(aways(h.sent())).to.deep.equal(["AWAY *"]);
		clock.tick(MUTE_READ_FALLBACK_MS);
		expect(
			h.sent().filter((l) => l.includes("METADATA")),
			"once"
		).to.deep.equal([]);
	});

	it("a session the bouncer does not hold (STATUS OFF OFF) says nothing", function () {
		const h = setup({uuid: UUID, sasl: "plain", saslAccount: "alice", saslPassword: "s3cret"});
		h.client.connect();
		negotiate(h, META_CAPS);
		h.transport.lines(
			"AUTHENTICATE +",
			":irc.test 900 alice alice!alice@host alice :You are now logged in as alice",
			":irc.test 903 alice :SASL authentication successful",
			":irc.test 001 alice :Welcome",
			":irc.test PERSISTENCE STATUS OFF OFF",
			":irc.test 422 alice :MOTD File is missing"
		);
		clock.tick(10_000);
		h.transport.line(EMPTY);
		expect(aways(h.sent())).to.deep.equal([]);
	});

	it("an alias attach says nothing", function () {
		const h = register(META_CAPS, undefined, [
			":irc.test NOTE BOUNCER ALIAS_ATTACHED :Attached to session x as alias",
			...RESTORE,
		]);
		clock.tick(10_000);
		h.transport.line(EMPTY);
		expect(aways(h.sent())).to.deep.equal([]);
	});

	for (const [label, arrange, declared] of [
		[
			"/away",
			// What a reload's constructor loads after a /away.
			() => backend.set(USER_AWAY_KEY, JSON.stringify({[UUID]: "x"})),
			"AWAY :x",
		],
		["do not disturb", (h?: Harness) => h?.client.setGlobalDnd(true, null), "AWAY *"],
		["away mode", (h?: Harness) => h?.client.setPresenceMode("away"), "AWAY *"],
		["a hidden page", (h?: Harness) => h?.client.setAttended(false), "AWAY *"],
	] as const) {
		it(`${label} suppresses it`, function () {
			if (label === "/away") {
				arrange();
			}

			const h = register(META_CAPS, label === "/away" ? undefined : arrange);
			const end = h.transport.sent.indexOf("CAP END");
			expect(h.transport.sent.slice(0, end), "declared before CAP END").to.include(declared);
			clock.tick(10_000);
			expect(h.sent(), "the resume check was armed").to.include(
				"METADATA * GET draft/webpush/mute seance/presence seance/mode draft/webpush/payload seance/closed"
			);
			h.transport.line(EMPTY);
			expect(aways(h.sent()).filter((l) => l === "AWAY")).to.deep.equal([]);
		});
	}
});

describe("a peer's star in a query (handlers/away.ts)", function () {
	it("present → * → back shows nothing, every time; lunch → * → back still says back", function () {
		const h = setup();
		connect(h);
		dispatchInput(h.client, h.client.lobby, "/query bob");
		const query = h.client.findChannel("bob");
		h.dispatch.resetHistory();

		for (let i = 0; i < 3; i++) {
			h.transport.line(":bob!b@host AWAY *");
			h.transport.line(":bob!b@host AWAY");
		}

		expect(h.messages(query?.id)).to.deep.equal([]);

		h.transport.lines(":bob!b@host AWAY :lunch", ":bob!b@host AWAY *", ":bob!b@host AWAY");
		expect(h.messages(query?.id).map((m) => m.type)).to.deep.equal([
			MessageType.AWAY,
			MessageType.BACK,
		]);
	});
});
