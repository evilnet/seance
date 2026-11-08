import {expect} from "chai";
import sinon from "sinon";
import {RESTORE_MAX_WAIT_MS} from "../../client/js/irc/persistence";
import {
	BOUNCER_NETWORKS_MAX,
	isBouncerControl,
	isNetworkId,
	networksToAdd,
	type BouncerNetwork,
} from "../../client/js/irc/bouncer";
import {setup, register, Harness} from "./support";
import type {SharedMsg} from "../../shared/types/msg";

/** What ZNC 1.9 offers a client (its own caps plus the legacy `znc.in/*` names). */
const ZNC_CAPS =
	"batch cap-notify echo-message multi-prefix server-time userhost-in-names znc.in/batch znc.in/self-message znc.in/server-time-iso";

type MsgPayload = {chan: number; msg: SharedMsg; replay?: boolean};

/** ZNC's attach: our JOIN, NAMES, then the buffer in a `znc.in/playback` batch. */
function attach(h: Harness, lines: string[], target = "#seance", ref = "p1"): void {
	if (target.startsWith("#") && !h.client.findChannel(target)) {
		h.transport.lines(
			`:alice!alice@znc.host JOIN ${target}`,
			`:irc.test 353 alice = ${target} :@alice bob`,
			`:irc.test 366 alice ${target} :End of /NAMES list.`
		);
	}

	h.transport.line(`:znc.in BATCH +${ref} znc.in/playback ${target}`);

	for (const line of lines) {
		h.transport.line(`@batch=${ref};${line.slice(1)}`);
	}

	h.transport.line(`:znc.in BATCH -${ref}`);
}

function said(n: number, text = `buffered ${n}`, target = "#seance"): string {
	return `@time=2026-11-08T10:0${n}:00.000Z :bob!bob@host PRIVMSG ${target} :${text}`;
}

describe("Bouncers: ZNC buffer playback", function () {
	it("delivers the buffer as replay: unread, but no live notification", function () {
		const h = setup();
		register(h, ZNC_CAPS);
		attach(h, [said(1), said(2, "alice: are you there?")]);

		const chan = h.client.findChannel("#seance")!;
		const msgs = h
			.payloads<MsgPayload>("msg")
			.filter((p) => p.chan === chan.id && p.msg.from?.nick === "bob");
		expect(msgs.map((p) => p.msg.text)).to.deep.equal(["buffered 1", "alice: are you there?"]);
		expect(msgs.every((p) => p.replay)).to.equal(true);
		expect(new Date(msgs[0].msg.time).toISOString()).to.equal("2026-11-08T10:01:00.000Z");
		expect(chan.shared.unread).to.equal(2);
	});

	it("shows nothing twice when ZNC replays a buffer it did not clear", function () {
		const h = setup();
		register(h, ZNC_CAPS);
		attach(h, [said(1), said(2)]);
		const chan = h.client.findChannel("#seance")!;
		const count = () =>
			h.messages(chan.id).filter((m) => m.text?.startsWith("buffered")).length;
		expect(count()).to.equal(2);

		// A reconnect: same buffer again, plus one newer line.
		attach(h, [said(1), said(2), said(3)], "#seance", "p2");
		expect(count()).to.equal(3);
		expect(h.messages(chan.id).filter((m) => m.text === "buffered 3")).to.have.length(1);
	});

	it("skips a buffered line this connection already saw live", function () {
		const h = setup();
		register(h, ZNC_CAPS);
		attach(h, []);
		h.transport.line(said(4, "live one"));
		attach(h, [said(4, "live one"), said(5, "missed")], "#seance", "p3");

		const chan = h.client.findChannel("#seance")!;
		const texts = h.messages(chan.id).map((m) => m.text);
		expect(texts.filter((t) => t === "live one")).to.have.length(1);
		expect(texts).to.include("missed");
	});

	it("keeps two identical lines in the same second when both are new", function () {
		const h = setup();
		register(h, ZNC_CAPS);
		attach(h, [said(6, "ok"), said(6, "ok")]);

		const chan = h.client.findChannel("#seance")!;
		expect(h.messages(chan.id).filter((m) => m.text === "ok")).to.have.length(2);
	});

	it("opens a query from a buffered private message", function () {
		const h = setup();
		register(h, ZNC_CAPS);
		attach(h, ["@time=2026-11-08T10:05:00.000Z :bob!bob@host PRIVMSG alice :hi there"], "bob");

		const query = h.client.findChannel("bob");
		expect(query, "query opened").to.not.equal(undefined);
		expect(h.messages(query!.id).map((m) => m.text)).to.include("hi there");
	});
});

describe("Bouncers: the bouncer's channel list", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
	});

	afterEach(function () {
		clock.restore();
	});

	const joins = (h: Harness) => h.transport.sent.filter((line) => /^JOIN /.test(line));

	it("does not JOIN again a channel the bouncer no longer holds", function () {
		const h = setup({join: "#seance,#gone"});
		register(h, ZNC_CAPS);
		h.transport.lines(
			":alice!alice@znc.host JOIN #seance",
			":irc.test 353 alice = #seance :@alice bob",
			":irc.test 366 alice #seance :End of /NAMES list."
		);
		clock.tick(RESTORE_MAX_WAIT_MS);

		expect(joins(h)).to.deep.equal([]);
		expect(h.client.findChannel("#seance")?.state).to.not.equal(undefined);
	});

	it("never JOINs the saved channels behind a bouncer, even one that holds none", function () {
		const h = setup({join: "#seance,#new"});
		register(h, ZNC_CAPS);
		clock.tick(RESTORE_MAX_WAIT_MS);

		expect(joins(h)).to.deep.equal([]);
	});

	it("knows soju by its BOUNCER_NETID", function () {
		const h = setup({join: "#seance,#gone"});
		register(h, "batch server-time message-tags echo-message", [
			":irc.test 005 alice BOUNCER_NETID=3 :are supported by this server",
		]);
		h.transport.line(":alice!alice@soju JOIN #seance");
		clock.tick(RESTORE_MAX_WAIT_MS);

		expect(h.client.behindBouncer).to.equal(true);
		expect(joins(h)).to.deep.equal([]);
	});

	it("leaves a plain server alone: the saved channels go out at once", function () {
		const h = setup({join: "#seance"});
		register(h, "batch server-time message-tags echo-message");

		expect(h.client.behindBouncer).to.equal(false);
		expect(joins(h)).to.have.length(1);
	});
});

describe("Bouncers: soju's networks (soju.im/bouncer-networks)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
	});

	afterEach(function () {
		clock.restore();
	});

	const SOJU_CAPS =
		"batch server-time message-tags echo-message soju.im/bouncer-networks soju.im/bouncer-networks-notify";

	/** The control connection, logged in with SASL as soju requires for BIND. */
	function control(h: Harness, caps = SOJU_CAPS, before: string[] = []): void {
		register(h, caps, before);
		h.client.saslOk = true;
	}

	it("asks the control connection for the networks, and JOINs nothing there", function () {
		const offered: BouncerNetwork[][] = [];
		const h = setup({
			join: "#seance",
			onBouncerNetworks(networks) {
				offered.push(networks);
				return networks.map((net) => net.name);
			},
		});
		control(h, "batch server-time message-tags echo-message soju.im/bouncer-networks", [
			":irc.test 005 alice CHANTYPES= :are supported by this server",
		]);
		clock.tick(RESTORE_MAX_WAIT_MS);

		expect(isBouncerControl(h.client)).to.equal(true);
		expect(h.transport.sent).to.include("BOUNCER LISTNETWORKS");
		expect(h.transport.sent.filter((line) => line.startsWith("JOIN "))).to.deep.equal([]);

		h.transport.lines(
			":irc.test BATCH +n soju.im/bouncer-networks",
			"@batch=n :irc.test BOUNCER NETWORK 1 name=Libera;host=irc.libera.chat;state=connected",
			"@batch=n :irc.test BOUNCER NETWORK 2 host=irc.oftc.net",
			"@batch=n :irc.test BOUNCER NETWORK bad:id name=Evil",
			":irc.test BATCH -n"
		);

		expect(offered).to.deep.equal([
			[
				{id: "1", name: "Libera"},
				{id: "2", name: "irc.oftc.net"},
			],
		]);
		expect(h.messages(h.client.lobby.id).map((m) => m.text)).to.include(
			"Added this bouncer's networks: Libera, irc.oftc.net"
		);
	});

	it("does not ask again when -notify sends the list by itself", function () {
		const h = setup({onBouncerNetworks: () => []});
		control(h);
		clock.tick(RESTORE_MAX_WAIT_MS);

		expect(h.transport.sent).to.not.include("BOUNCER LISTNETWORKS");
	});

	it("offers a network added on the bouncer later (-notify), and ignores a removed one", function () {
		const offered: BouncerNetwork[] = [];
		const h = setup({
			onBouncerNetworks(networks) {
				offered.push(...networks);
				return [];
			},
		});
		control(h);
		h.transport.lines(
			":irc.test BOUNCER NETWORK 7 name=EFnet;state=connecting",
			":irc.test BOUNCER NETWORK 1 *"
		);

		expect(offered).to.deep.equal([{id: "7", name: "EFnet"}]);
	});

	it("adds nothing for a login without SASL: soju binds only a SASL account", function () {
		const offered: BouncerNetwork[] = [];
		const h = setup({
			onBouncerNetworks(networks) {
				offered.push(...networks);
				return [];
			},
		});
		register(h, SOJU_CAPS);
		h.transport.line(":irc.test BOUNCER NETWORK 7 name=EFnet");

		expect(offered).to.deep.equal([]);
	});

	it("binds a network added from the bouncer before CAP END", function () {
		const h = setup({bouncerNetId: "42"});
		h.client.connect();
		h.transport.open();
		h.transport.line(`:irc.test CAP * LS :${SOJU_CAPS}`);
		const req = h.transport.sent.findIndex((line) => line.startsWith("CAP REQ :"));
		const tail = h.transport.sent.slice(req);

		expect(tail.indexOf("BOUNCER BIND 42")).to.be.greaterThan(0);
		expect(tail.indexOf("BOUNCER BIND 42")).to.be.lessThan(tail.indexOf("CAP END"));
	});

	it("binds nothing on a server without the extension", function () {
		const h = setup({bouncerNetId: "42"});
		h.client.connect();
		h.transport.open();
		h.transport.line(":irc.test CAP * LS :batch server-time");

		expect(h.transport.sent.some((line) => line.startsWith("BOUNCER"))).to.equal(false);
	});

	it("is not a control connection once bound (BOUNCER_NETID)", function () {
		const h = setup({onBouncerNetworks: () => []});
		control(h, "batch server-time soju.im/bouncer-networks", [
			":irc.test 005 alice BOUNCER_NETID=1 :are supported by this server",
		]);

		expect(isBouncerControl(h.client)).to.equal(false);
		expect(h.transport.sent).to.not.include("BOUNCER LISTNETWORKS");
	});

	it("is not a control connection when it asked to bind, even if soju refused", function () {
		const offered: BouncerNetwork[] = [];
		const h = setup({
			bouncerNetId: "42",
			onBouncerNetworks(networks) {
				offered.push(...networks);
				return [];
			},
		});
		control(h);
		h.transport.line(":irc.test BOUNCER NETWORK 7 name=EFnet");

		expect(isBouncerControl(h.client)).to.equal(false);
		expect(offered).to.deep.equal([]);
	});
});

describe("Bouncers: which listed networks to add (networksToAdd)", function () {
	const net = (id: string, name = `net${id}`): BouncerNetwork => ({id, name});

	it("skips the ones offered before, the ones saved already, and repeats", function () {
		const picked = networksToAdd(
			[net("1"), net("2"), net("3"), net("3")],
			new Set(["1"]),
			(n) => n.id === "2"
		);
		expect(picked.map((n) => n.id)).to.deep.equal(["3"]);
	});

	it("adds at most BOUNCER_NETWORKS_MAX from one list", function () {
		const many = Array.from({length: BOUNCER_NETWORKS_MAX + 5}, (_, i) => net(String(i)));
		expect(networksToAdd(many, new Set(), () => false)).to.have.length(BOUNCER_NETWORKS_MAX);
	});

	it("counts what the entry offered before, so -notify lines one by one stop at the cap too", function () {
		const seen = new Set<string>();

		for (let i = 0; i < BOUNCER_NETWORKS_MAX + 5; i++) {
			networksToAdd([net(`n${i}`)], seen, () => false).forEach((n) => seen.add(n.id));
		}

		expect(seen.size).to.equal(BOUNCER_NETWORKS_MAX);
		expect(networksToAdd([net("late")], seen, () => false)).to.deep.equal([]);
	});

	it("takes only ids that are safe to send back in BOUNCER BIND", function () {
		expect(isNetworkId("42")).to.equal(true);
		expect(isNetworkId("a.b_c~d-e")).to.equal(true);
		expect(isNetworkId("")).to.equal(false);
		expect(isNetworkId("4 2")).to.equal(false);
		expect(isNetworkId(":42")).to.equal(false);
		expect(isNetworkId("x".repeat(65))).to.equal(false);
		expect(isNetworkId(42)).to.equal(false);
	});
});
