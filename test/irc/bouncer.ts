import {expect} from "chai";
import sinon from "sinon";
import {RESTORE_MAX_WAIT_MS} from "../../client/js/irc/persistence";
import {
	BOUNCER_NETWORKS_MAX,
	bouncerRequest,
	followRename,
	isBouncerControl,
	isNetworkId,
	networksToAdd,
	panelValue,
	sameBouncerAccount,
	type BouncerNetwork,
} from "../../client/js/irc/bouncer";
import {setup, register, Harness} from "./support";
import * as saved from "../../client/js/irc/saved-networks";
import * as querylog from "../../client/js/irc/querylog";
import {MessageType, type SharedMsg} from "../../shared/types/msg";
import type {StorageBackend} from "../../client/js/irc/saved-networks";

/** In-memory stand-in for the localStorage wrapper. */
class MemoryStorage implements StorageBackend {
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

	it("skips a buffered query line this device kept from before a reload", function () {
		querylog.useStorageBackend(new MemoryStorage());

		try {
			const h = setup();
			// What a page that went away left in the query log: one line from
			// bob, one of ours (an action), both still in ZNC's QueryLog buffer.
			const kept = (nick: string, type: MessageType, text: string, minute: number) =>
				({
					type,
					text,
					time: new Date(`2026-11-08T10:0${minute}:00.000Z`),
					from: {nick, mode: ""},
					self: nick === "alice",
				} as unknown as SharedMsg);
			h.client.queryLog.append("bob", kept("bob", MessageType.MESSAGE, "hi there", 5));
			h.client.queryLog.append("bob", kept("alice", MessageType.ACTION, "waves", 6));
			register(h, ZNC_CAPS);
			attach(
				h,
				[
					"@time=2026-11-08T10:05:00.000Z :bob!bob@host PRIVMSG alice :hi there",
					"@time=2026-11-08T10:06:00.000Z :alice!alice@host PRIVMSG bob :\x01ACTION waves\x01",
					"@time=2026-11-08T10:07:00.000Z :bob!bob@host PRIVMSG alice :new since",
				],
				"bob"
			);

			const query = h.client.findChannel("bob")!;
			const delivered = h
				.payloads<MsgPayload>("msg")
				.filter((p) => p.chan === query.id)
				.map((p) => p.msg.text);
			expect(delivered).to.deep.equal(["new since"]);
		} finally {
			querylog.useStorageBackend(null);
		}
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

	/** This entry has been behind the bouncer before (`SavedNetwork.bouncerSettled`). */
	function settled(h: Harness): void {
		saved.save({
			uuid: h.client.uuid,
			name: "",
			host: "irc.test",
			port: 6697,
			tls: true,
			nick: "alice",
			join: "#seance,#gone",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			bouncerSettled: true,
		});
	}

	beforeEach(function () {
		saved.useStorageBackend(new MemoryStorage());
	});

	afterEach(function () {
		saved.useStorageBackend(null);
	});

	it("does not JOIN again a channel the bouncer no longer holds", function () {
		const h = setup({join: "#seance,#gone"});
		settled(h);
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

	it("JOINs the typed channels on the first connect behind a bouncer, and only then", function () {
		const h = setup({join: "#seance,#new"});
		register(h, ZNC_CAPS);
		clock.tick(RESTORE_MAX_WAIT_MS);

		expect(joins(h)).to.deep.equal(["JOIN #new,#seance"]); // by name
		expect(saved.get(h.client.uuid)).to.equal(undefined); // unsaved: kept for this page

		// Parted from another client meanwhile; the next registration leaves it so.
		h.transport.sent = [];
		h.client.autojoin();
		expect(joins(h)).to.deep.equal([]);
	});

	it("JOINs the typed channels again once the entry is pointed at another ZNC network", function () {
		const h = setup({join: "#seance", serverPassword: "alice/libera:pw"});
		register(h, ZNC_CAPS);
		clock.tick(RESTORE_MAX_WAIT_MS);
		expect(joins(h)).to.have.length(1);

		// The same network with a new password is the same login.
		h.client.applySettings({...h.client.options, serverPassword: "alice/libera:new"});
		h.transport.sent = [];
		h.client.autojoin();
		expect(joins(h)).to.deep.equal([]);

		h.client.applySettings({...h.client.options, serverPassword: "alice/oftc:pw"});
		h.transport.sent = [];
		h.client.autojoin();
		expect(joins(h)).to.have.length(1);
	});

	it("remembers the first connect in the saved entry", function () {
		const h = setup({join: "#seance"});
		settled(h);
		saved.save({...saved.get(h.client.uuid)!, bouncerSettled: undefined});
		register(h, ZNC_CAPS);
		clock.tick(RESTORE_MAX_WAIT_MS);

		expect(joins(h)).to.have.length(1);
		expect(saved.get(h.client.uuid)?.bouncerSettled).to.equal(true);
	});

	it("knows soju by its BOUNCER_NETID", function () {
		const h = setup({join: "#seance,#gone"});
		settled(h);
		register(h, "batch server-time message-tags echo-message", [
			":irc.test 005 alice BOUNCER_NETID=3 :are supported by this server",
		]);
		h.transport.line(":alice!alice@soju JOIN #seance");
		clock.tick(RESTORE_MAX_WAIT_MS);

		expect(h.client.behindBouncer).to.equal(true);
		expect(joins(h)).to.deep.equal([]);
	});

	it("does not take Ergo for ZNC: it offers znc.in/self-message and znc.in/playback itself", function () {
		const h = setup({join: "#seance"});
		settled(h);
		register(
			h,
			"account-notify away-notify batch cap-notify chghost draft/chathistory echo-message extended-join invite-notify labeled-response message-tags multi-prefix server-time setname userhost-in-names znc.in/playback znc.in/self-message"
		);

		expect(h.client.behindZnc).to.equal(false);
		expect(h.client.behindBouncer).to.equal(false);
		expect(joins(h)).to.have.length(1);
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
				return {added: networks.map((net) => net.name), over: []};
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

	it("says in the lobby which networks were left out for want of room", function () {
		const h = setup({onBouncerNetworks: () => ({added: [], over: ["EFnet", "IRCnet"]})});
		control(h);
		h.transport.line(":irc.test BOUNCER NETWORK 7 name=EFnet");

		const lobby = h.messages(h.client.lobby.id).map((m) => m.text ?? "");
		expect(lobby.some((text) => text.startsWith("Not added: EFnet, IRCnet."))).to.equal(true);
	});

	it("names a network left out once per connection, not at each of its state changes", function () {
		const over = ["EFnet"];
		const h = setup({onBouncerNetworks: () => ({added: [], over: [...over]})});
		control(h);
		h.transport.lines(
			":irc.test BOUNCER NETWORK 7 name=EFnet;state=connecting",
			":irc.test BOUNCER NETWORK 7 state=connected",
			":irc.test BOUNCER NETWORK 7 state=disconnected"
		);
		over.push("IRCnet");
		h.transport.line(":irc.test BOUNCER NETWORK 8 name=IRCnet");

		const notes = h
			.messages(h.client.lobby.id)
			.map((m) => m.text ?? "")
			.filter((text) => text.startsWith("Not added:"));
		expect(notes).to.have.length(2);
		expect(notes[0]).to.match(/^Not added: EFnet\./);
		expect(notes[1]).to.match(/^Not added: IRCnet\./);
	});

	it("does not ask again when -notify sends the list by itself", function () {
		const h = setup({onBouncerNetworks: () => ({added: [], over: []})});
		control(h);
		clock.tick(RESTORE_MAX_WAIT_MS);

		expect(h.transport.sent).to.not.include("BOUNCER LISTNETWORKS");
	});

	it("offers a network added on the bouncer later (-notify), and reports a removed one", function () {
		const offered: BouncerNetwork[] = [];
		const removed: string[] = [];
		const h = setup({
			onBouncerNetworks(networks) {
				offered.push(...networks);
				return {added: [], over: []};
			},
			onBouncerNetworkRemoved: (id) => removed.push(id),
		});
		control(h);
		h.transport.lines(
			":irc.test BOUNCER NETWORK 7 name=EFnet;state=connecting",
			":irc.test BOUNCER NETWORK 1 *"
		);

		expect(offered).to.deep.equal([{id: "7", name: "EFnet"}]);
		expect(removed).to.deep.equal(["1"]);
	});

	type NetworksPayload = {
		network: string;
		networks: {netid: string; attrs: Record<string, string>}[];
		editable: boolean;
	};

	it("keeps each network's attributes for the panel, merging what -notify changes", function () {
		const offered: BouncerNetwork[] = [];
		const h = setup({
			onBouncerNetworks(networks) {
				offered.push(...networks);
				return {added: [], over: []};
			},
		});
		control(h);
		h.transport.lines(
			":irc.test BATCH +n soju.im/bouncer-networks",
			"@batch=n :irc.test BOUNCER NETWORK 1 name=Libera;host=irc.libera.chat;state=connecting;error=timeout",
			":irc.test BATCH -n",
			// A change carries only what changed; a key without a value is removed.
			":irc.test BOUNCER NETWORK 1 state=connected;error="
		);

		const last = h.payloads<NetworksPayload>("bouncer:networks").at(-1)!;
		expect(last.network).to.equal(h.client.uuid);
		expect(last.networks).to.deep.equal([
			{netid: "1", attrs: {name: "Libera", host: "irc.libera.chat", state: "connected"}},
		]);
		// No labeled-response: the panel lists, but cannot ask for changes.
		expect(last.editable).to.equal(false);
		// The change is offered under the network's name, not its bare id.
		expect(offered.map((net) => net.name)).to.deep.equal(["Libera", "Libera"]);
	});

	it("forgets a network a whole list leaves out, and one deleted (-notify *)", function () {
		const h = setup({onBouncerNetworks: () => ({added: [], over: []})});
		control(h);
		h.transport.lines(
			":irc.test BATCH +a soju.im/bouncer-networks",
			"@batch=a :irc.test BOUNCER NETWORK 1 name=Libera",
			"@batch=a :irc.test BOUNCER NETWORK 2 name=OFTC",
			"@batch=a :irc.test BOUNCER NETWORK 3 name=EFnet",
			":irc.test BATCH -a",
			":irc.test BATCH +b soju.im/bouncer-networks",
			"@batch=b :irc.test BOUNCER NETWORK 1 name=Libera",
			"@batch=b :irc.test BOUNCER NETWORK 3 name=EFnet",
			":irc.test BATCH -b",
			":irc.test BOUNCER NETWORK 3 *"
		);

		const last = h.payloads<NetworksPayload>("bouncer:networks").at(-1)!;
		expect(last.networks.map((net) => net.netid)).to.deep.equal(["1"]);
	});

	it("stops a bound network the bouncer deleted (FAIL BOUNCER INVALID_NETID)", function () {
		let gone = 0;
		const h = setup({bouncerNetId: "42", onBouncerNetworkGone: () => gone++});
		register(h, SOJU_CAPS, [
			":irc.test FAIL BOUNCER INVALID_NETID BIND 42 :Unknown network ID",
		]);

		expect(gone).to.equal(1);
		expect(h.client.isQuitting).to.equal(true);
		expect(h.transport.sent.some((line) => line.startsWith("QUIT"))).to.equal(true);
		expect(h.messages(h.client.lobby.id).map((m) => m.text)).to.include(
			"This network was deleted on the bouncer, so it no longer connects. You can remove it here."
		);
	});

	it("stops on a refused BIND before 001 too, without reconnecting", function () {
		let gone = 0;
		const h = setup({bouncerNetId: "42", onBouncerNetworkGone: () => gone++});
		h.client.connect();
		h.transport.open();
		h.transport.line(`:irc.test CAP * LS :${SOJU_CAPS}`);
		h.transport.line(":irc.test FAIL BOUNCER INVALID_NETID 42 :Unknown network ID");

		expect(gone).to.equal(1);
		expect(h.client.isQuitting).to.equal(true);
	});

	it("leaves an INVALID_NETID about another id to the lobby", function () {
		let gone = 0;
		const h = setup({bouncerNetId: "42", onBouncerNetworkGone: () => gone++});
		register(h, SOJU_CAPS);
		h.transport.line(":irc.test FAIL BOUNCER INVALID_NETID BIND 7 :Unknown network ID");

		expect(gone).to.equal(0);
		expect(h.client.isQuitting).to.equal(false);
	});

	it("adds nothing for a login without SASL: soju binds only a SASL account", function () {
		const offered: BouncerNetwork[] = [];
		const h = setup({
			onBouncerNetworks(networks) {
				offered.push(...networks);
				return {added: [], over: []};
			},
		});
		register(h, SOJU_CAPS);
		h.transport.line(":irc.test BOUNCER NETWORK 7 name=EFnet");

		expect(offered).to.deep.equal([]);
	});

	it("takes a state-only update for a network it never added as nothing new", function () {
		const offered: BouncerNetwork[] = [];
		const h = setup({
			onBouncerNetworks(networks) {
				offered.push(...networks);
				return {added: [], over: []};
			},
		});
		control(h);
		h.transport.line(":irc.test BOUNCER NETWORK 3 state=connected;error");

		expect(offered).to.deep.equal([]);
	});

	it("passes a rename on the bouncer on (-notify, and in a full list)", function () {
		const renames: [string, string][] = [];
		const h = setup({
			onBouncerNetworks: () => ({added: [], over: []}),
			onBouncerNetworkRenamed: (id, name) => renames.push([id, name]),
		});
		control(h);
		h.transport.lines(
			":irc.test BOUNCER NETWORK 2 name=Up2Renamed",
			":irc.test BATCH +n soju.im/bouncer-networks",
			"@batch=n :irc.test BOUNCER NETWORK 3 name=Up3;host=irc.example;state=connected",
			":irc.test BATCH -n",
			// A state change alone renames nothing.
			":irc.test BOUNCER NETWORK 3 state=connecting"
		);

		expect(renames).to.deep.equal([
			["2", "Up2Renamed"],
			["3", "Up3"],
		]);
	});

	it("says in the lobby why a login without SASL gets no networks", function () {
		const h = setup({onBouncerNetworks: () => ({added: [], over: []})});
		register(h, SOJU_CAPS);
		h.transport.lines(
			":irc.test BATCH +n soju.im/bouncer-networks",
			"@batch=n :irc.test BOUNCER NETWORK 7 name=EFnet",
			":irc.test BATCH -n",
			":irc.test BOUNCER NETWORK 8 name=IRCnet"
		);

		const notes = h
			.messages(h.client.lobby.id)
			.filter((m) => (m.text ?? "").startsWith("This bouncer has networks"));
		expect(notes).to.have.length(1);
	});

	it("takes soju's admin +o on the control connection as no oper: no PRIVS to soju", async function () {
		const h = setup({onBouncerNetworks: () => ({added: [], over: []})});
		control(h, SOJU_CAPS.replace("batch", "batch labeled-response"));
		h.transport.line(`:${h.client.nick}!${h.client.nick}@host MODE ${h.client.nick} +o`);
		await Promise.resolve();

		expect(h.client.oper.level).to.equal("none");
		expect(h.transport.sent.some((line) => /PRIVS/.test(line))).to.equal(false);
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
		const h = setup({onBouncerNetworks: () => ({added: [], over: []})});
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
				return {added: [], over: []};
			},
		});
		control(h);
		h.transport.line(":irc.test BOUNCER NETWORK 7 name=EFnet");

		expect(isBouncerControl(h.client)).to.equal(false);
		expect(offered).to.deep.equal([]);
	});
});

describe("Bouncers: the panel's requests (bouncerRequest)", function () {
	const LABELED =
		"batch server-time message-tags labeled-response soju.im/bouncer-networks soju.im/bouncer-networks-notify";

	function labelOf(line: string): string {
		return /^@label=(\S+) /.exec(line)?.[1] ?? "";
	}

	function control(caps = LABELED, offered: BouncerNetwork[] = []): Harness {
		const h = setup({
			onBouncerNetworks(networks) {
				offered.push(...networks);
				return {added: [], over: []};
			},
		});
		register(h, caps);
		h.client.saslOk = true;
		return h;
	}

	it("adds a network, labeled; the bouncer's own NETWORK line inside the reply is taken", async function () {
		const offered: BouncerNetwork[] = [];
		const h = control(LABELED, offered);
		const reply = bouncerRequest(h.client, "ADDNETWORK", undefined, {
			host: "irc.libera.chat",
			name: "Libera Chat",
		});
		const sent = h.transport.sent.at(-1)!;

		expect(sent.replace(/^@label=\S+ /, "")).to.equal(
			"BOUNCER ADDNETWORK host=irc.libera.chat;name=Libera\\sChat"
		);
		h.transport.lines(
			`@label=${labelOf(sent)} :irc.test BATCH +L labeled-response`,
			"@batch=L :irc.test BOUNCER NETWORK 9 host=irc.libera.chat;name=Libera\\sChat;state=connecting",
			"@batch=L :irc.test BOUNCER ADDNETWORK 9",
			":irc.test BATCH -L"
		);

		expect(await reply).to.deep.equal({ok: true, netid: "9"});
		expect(offered).to.deep.equal([{id: "9", name: "Libera Chat"}]);
		const last = h
			.payloads<{networks: {netid: string}[]; editable: boolean}>("bouncer:networks")
			.at(-1)!;
		expect(last.networks.map((net) => net.netid)).to.deep.equal(["9"]);
		expect(last.editable).to.equal(true);
	});

	it("passes on the bouncer's refusal in its own words", async function () {
		const h = control();
		const reply = bouncerRequest(h.client, "DELNETWORK", "4");
		const sent = h.transport.sent.at(-1)!;

		expect(sent.replace(/^@label=\S+ /, "")).to.equal("BOUNCER DELNETWORK 4");
		h.transport.line(
			`@label=${labelOf(
				sent
			)} :irc.test FAIL BOUNCER INVALID_NETID DELNETWORK 4 :Unknown network ID`
		);

		expect(await reply).to.deep.equal({ok: false, error: "Unknown network ID"});
	});

	it("sends nothing without labeled-response: the answer could not be told apart", async function () {
		const h = control(
			"batch server-time message-tags soju.im/bouncer-networks soju.im/bouncer-networks-notify"
		);
		const before = h.transport.sent.length;
		const reply = await bouncerRequest(h.client, "CHANGENETWORK", "1", {name: "x"});

		expect(reply.ok).to.equal(false);
		expect(reply.error).to.be.a("string").and.not.equal("");
		expect(h.transport.sent.length).to.equal(before);
	});

	it("refuses a change too long for one line, and an id it could not send back", async function () {
		const h = control();
		const before = h.transport.sent.length;

		expect(
			(await bouncerRequest(h.client, "ADDNETWORK", undefined, {realname: "x".repeat(480)}))
				.ok
		).to.equal(false);
		expect((await bouncerRequest(h.client, "DELNETWORK", "1 2")).ok).to.equal(false);
		expect(h.transport.sent.length).to.equal(before);
	});
});

describe("Bouncers: following a rename on the bouncer (followRename)", function () {
	it("follows while the name is still the bouncer's", function () {
		expect(followRename({name: "Up2", bouncerName: "Up2"}, "Up2Renamed")).to.equal(
			"Up2Renamed"
		);
	});

	it("keeps a name the user chose", function () {
		expect(followRename({name: "Work", bouncerName: "Up2"}, "Up2Renamed")).to.equal(undefined);
	});

	it("follows an entry saved before the bouncer's name was kept", function () {
		expect(followRename({name: "Up2"}, "Up2Renamed")).to.equal("Up2Renamed");
	});

	it("changes nothing for the same name", function () {
		expect(followRename({name: "Up2", bouncerName: "Up2"}, "Up2")).to.equal(undefined);
	});
});

describe("Bouncers: the panel's field values (panelValue)", function () {
	it("trims what is typed into a field", function () {
		expect(panelValue("host", " irc.example ")).to.equal("irc.example");
		expect(panelValue("nickname", "\talice\n")).to.equal("alice");
	});

	it("sends a password as typed: its spaces are part of it", function () {
		expect(panelValue("pass", " secret ")).to.equal(" secret ");
		expect(panelValue("pass", "   ")).to.equal("   ");
	});
});

describe("Bouncers: one bouncer account (sameBouncerAccount)", function () {
	const control = {host: "soju.a", port: 6697, tls: true, saslAccount: "alice"};

	it("is the same account where it connects and logs in alike", function () {
		expect(sameBouncerAccount(control, {...control})).to.equal(true);
		expect(
			sameBouncerAccount({...control, saslAccount: ""}, {...control, saslAccount: undefined})
		).to.equal(true);
	});

	it("is another account on another host, port, TLS or login", function () {
		// An edit saved while the old connection is still up (it applies on
		// reconnect): a list heard there must not pair the edited entry with
		// the old connection's passwords (manager.ts addBouncerNetworks).
		expect(sameBouncerAccount(control, {...control, host: "soju.b"})).to.equal(false);
		expect(sameBouncerAccount(control, {...control, port: 6667})).to.equal(false);
		expect(sameBouncerAccount(control, {...control, tls: false})).to.equal(false);
		expect(sameBouncerAccount(control, {...control, saslAccount: "bob"})).to.equal(false);
	});
});

describe("Bouncers: which listed networks to add (networksToAdd)", function () {
	const net = (id: string, name = `net${id}`): BouncerNetwork => ({id, name});

	const ids = (list: BouncerNetwork[]) => list.map((n) => n.id);

	it("skips the ones offered before and repeats; one saved already is only marked seen", function () {
		const plan = networksToAdd(
			[net("1"), net("2"), net("3"), net("3")],
			new Set(["1"]),
			(n) => n.id === "2",
			0
		);
		expect(ids(plan.add)).to.deep.equal(["3"]);
		// The one saved by hand is offered too: removing it later is final.
		expect(plan.seen).to.deep.equal(["2", "3"]);
		expect(plan.over).to.deep.equal([]);
	});

	it("adds while fewer than BOUNCER_NETWORKS_MAX of the account's networks are saved", function () {
		const many = Array.from({length: BOUNCER_NETWORKS_MAX + 5}, (_, i) => net(String(i)));
		const plan = networksToAdd(many, new Set(), () => false, 3);
		expect(plan.add).to.have.length(BOUNCER_NETWORKS_MAX - 3);
		expect(plan.over).to.have.length(8);
		// Left out for want of room: not seen, so a later list can add them.
		expect(plan.seen).to.deep.equal(ids(plan.add));
	});

	it("a network removed here makes room for one left out before", function () {
		const many = Array.from({length: BOUNCER_NETWORKS_MAX + 1}, (_, i) => net(String(i)));
		const first = networksToAdd(many, new Set(), () => false, 0);
		expect(ids(first.over)).to.deep.equal([String(BOUNCER_NETWORKS_MAX)]);

		// One removed: BOUNCER_NETWORKS_MAX - 1 saved, the same list again.
		const again = networksToAdd(
			many,
			new Set(first.seen),
			() => false,
			BOUNCER_NETWORKS_MAX - 1
		);
		expect(ids(again.add)).to.deep.equal([String(BOUNCER_NETWORKS_MAX)]);
		expect(again.over).to.deep.equal([]);
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
