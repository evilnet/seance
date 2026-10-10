import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {dispatchInput} from "../../client/js/irc/commands";
import {
	LoggedNotice,
	NoticeLog,
	trim,
	MAX_AGE_MS,
	MAX_ENTRIES,
	useNoticeLogBackend,
} from "../../client/js/irc/noticelog";
import {setRoute, setSnomaskPref, useOperPrefsBackend} from "../../client/js/irc/operprefs";
import {applyModeString, levelOf, parseFeature, parsePrivs} from "../../client/js/irc/oper";
import {parseLine} from "../../client/js/irc/message";
import {request, REQUEST_TIMEOUT_MS} from "../../client/js/irc/request";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import {MessageType, SharedMsg} from "../../shared/types/msg";
import type {SharedOperState} from "../../shared/types/oper";

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
		this.sent.push(line);
	}

	close(): void {
		this.state = "closed";
		this.emit({type: "close", code: 1006, reason: "", willReconnect: false});
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

let dispatch: sinon.SinonSpy;
let ownsSpy = false;
let prefsStore: Map<string, string>;
let logStore: Map<string, LoggedNotice[]>;

function installSpy(): void {
	const current = (socket as unknown as Record<string, unknown>).dispatch;

	if ((current as {isSinonProxy?: boolean}).isSinonProxy) {
		dispatch = current as sinon.SinonSpy;
		ownsSpy = false;
	} else {
		dispatch = sinon.spy(socket, "dispatch");
		ownsSpy = true;
	}

	prefsStore = new Map();
	useOperPrefsBackend({
		get: (key) => prefsStore.get(key) ?? null,
		set: (key, value) => prefsStore.set(key, value),
	});

	logStore = new Map();
	useNoticeLogBackend({
		load: (uuid) => Promise.resolve(logStore.get(uuid)),
		save(uuid, entries) {
			logStore.set(uuid, [...entries]);
			return Promise.resolve();
		},
		remove(uuid) {
			logStore.delete(uuid);
			return Promise.resolve();
		},
	});
}

function removeSpy(): void {
	if (ownsSpy) {
		dispatch.restore();
	}

	useOperPrefsBackend(null);
	useNoticeLogBackend(null);
	socket.removeAllListeners();
}

function messages(chanId: number): SharedMsg[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "msg")
		.map((call) => call.args[1] as {chan: number; msg: SharedMsg; unread?: number})
		.filter((p) => p.chan === chanId)
		.map((p) => p.msg);
}

function operStates(): SharedOperState[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "oper:state")
		.map((call) => (call.args[1] as {state: SharedOperState}).state);
}

const NEF_VERSION = "u2.10.12.14+Nefarious(2.0.0)";

/** A registered client on a nefarious2 server with labeled-response + batch. */
function setup(opts: {labels?: boolean; version?: string; uuid?: string} = {}): {
	client: IrcClient;
	transport: FakeTransport;
} {
	const labels = opts.labels ?? true;
	const caps = labels ? "batch labeled-response message-tags server-time" : "server-time";
	const transport = new FakeTransport();
	const client = new IrcClient({
		host: "irc.test",
		port: 8443,
		tls: true,
		nick: "opr",
		join: "#seance",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		uuid: opts.uuid,
		ids: new IdAllocator(),
		transportFactory: () => transport,
		highlights: () => ({keywords: [], exceptions: []}),
	});

	client.connect();
	transport.open();
	transport.lines(
		`:irc.test CAP * LS :${caps}`,
		`:irc.test CAP opr ACK :${caps}`,
		":irc.test 001 opr :Welcome to the SeanceDev IRC Network, opr",
		`:irc.test 004 opr irc.test ${
			opts.version ?? NEF_VERSION
		} abdgiknoqswxyzBDHLMNORWXY abCcDdhHikLlMmNnOopPQRrSsTtvZz bkLlov`,
		":irc.test 005 opr CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,Ll,imnpst CASEMAPPING=rfc1459 WHOX :are supported by this server",
		":irc.test 422 opr :MOTD File is missing",
		":opr!opr@host JOIN #seance",
		":irc.test 353 opr = #seance :@opr bob",
		":irc.test 366 opr #seance :End of /NAMES list."
	);
	transport.sent = [];
	dispatch.resetHistory();

	return {client, transport};
}

/** The label the last line we sent carries (`@label=r1 …` → `r1`). */
function lastLabel(transport: FakeTransport): string {
	const m = /^@label=(\S+) /.exec(transport.sent[transport.sent.length - 1] ?? "");
	return m ? m[1] : "";
}

/** Let promise callbacks run (requests resolve asynchronously). */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

describe("oper tools: labeled requests (irc/request.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("resolves with the whole labeled batch, and the handlers never see it", async function () {
		const {client, transport} = setup();
		const reply = request(client, "STATS u");

		expect(transport.sent).to.deep.equal(["@label=r1 STATS u"]);
		transport.lines(
			"@label=r1 :irc.test BATCH +AA labeled-response",
			"@batch=AA :irc.test 242 opr :Server Up 0 days, 0:01:59",
			"@batch=AA :irc.test 250 opr :Highest connection count: 3 (3 clients)",
			"@batch=AA :irc.test 219 opr u :End of /STATS report",
			":irc.test BATCH -AA"
		);

		const unit = await reply;
		expect(unit.outcome).to.equal("batch");
		expect(unit.lines.map((m) => m.command)).to.deep.equal(["242", "250", "219"]);
		expect(messages(client.lobby.id), "no raw lines").to.have.length(0);
	});

	it("takes an untagged server NOTICE inside our open batch into it (evilnet/nefarious2#119)", async function () {
		const {client, transport} = setup();
		const reply = request(client, "STATS w");
		const label = lastLabel(transport);

		transport.lines(
			`@label=${label} :irc.test BATCH +AB labeled-response`,
			":irc.test NOTICE opr :Minute  Hour    Day   Yest. YYest. Userload for:",
			":irc.test NOTICE opr :   0.0     0.0     0     0     0   local clients",
			"@batch=AB :irc.test 219 opr w :End of /STATS report",
			":irc.test BATCH -AB"
		);

		const unit = await reply;
		expect(unit.lines.map((m) => m.command)).to.deep.equal(["NOTICE", "NOTICE", "219"]);
		expect(messages(client.lobby.id)).to.have.length(0);
	});

	it("collects an untagged reply it named and resolves on the ACK (evilnet/nefarious2#120)", async function () {
		const {client, transport} = setup();
		const reply = request(client, "PRIVS", {untagged: ["270"]});
		const label = lastLabel(transport);

		transport.lines(
			":irc.test 270 opr opr :CHAN_LIMIT KILL CHECK",
			`@label=${label} :irc.test ACK`
		);

		const unit = await reply;
		expect(unit.outcome).to.equal("ack");
		expect(unit.lines.map((m) => m.command)).to.deep.equal(["270"]);
	});

	it("collects labeled lines until an end numeric when the server does not batch", async function () {
		const {client, transport} = setup();
		const reply = request(client, "GLINE", {end: ["281"]});
		const label = lastLabel(transport);

		transport.lines(
			`@label=${label} :irc.test 280 opr *@1.2.3.4 1791600000 1791500000 1791600000 * + :spam`,
			`@label=${label} :irc.test 281 opr :End of G-line List`
		);

		const unit = await reply;
		expect(unit.outcome).to.equal("lines");
		expect(unit.lines.map((m) => m.command)).to.deep.equal(["280", "281"]);
	});

	it("ends on an error numeric even with end numerics given", async function () {
		const {client, transport} = setup();
		const reply = request(client, "GLINE +x@y * 1h :z", {end: ["281"]});
		transport.line(
			`@label=${lastLabel(
				transport
			)} :irc.test 481 opr :Permission Denied: Insufficient privileges`
		);

		const unit = await reply;
		expect(unit.lines.map((m) => m.command)).to.deep.equal(["481"]);
	});

	it("leaves someone else's labeled batch to the normal handlers", function () {
		const {client, transport} = setup();
		const chan = client.findChannel("#seance")!;

		transport.lines(
			"@label=s9 :irc.test BATCH +AC labeled-response",
			"@batch=AC :bob!b@h PRIVMSG #seance :hello",
			":irc.test BATCH -AC"
		);

		expect(messages(chan.id).map((m) => m.text)).to.deep.equal(["hello"]);
	});

	it("resolves `closed` when the socket goes, and `timeout` when the server never finishes", async function () {
		const clock = sinon.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});

		try {
			const {client, transport} = setup();
			const slow = request(client, "STATS g");
			clock.tick(REQUEST_TIMEOUT_MS + 1);
			expect((await slow).outcome).to.equal("timeout");

			const cut = request(client, "STATS g");
			transport.close();
			expect((await cut).outcome).to.equal("closed");
		} finally {
			clock.restore();
		}
	});

	it("does not send at all without labeled-response", async function () {
		const {client, transport} = setup({labels: false});
		const unit = await request(client, "STATS u");

		expect(unit.outcome).to.equal("closed");
		expect(transport.sent).to.deep.equal([]);
	});
});

describe("oper tools: oper state (irc/oper.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("parses mode strings, levels, PRIVS and GET replies", function () {
		const modes = new Set<string>();
		applyModeString(modes, "+owsg-w+x");
		expect(Array.from(modes).sort().join("")).to.equal("gosx");
		expect(levelOf(modes)).to.equal("global");
		expect(levelOf(new Set(["O"]))).to.equal("local");
		expect(levelOf(new Set(["o", "a"]))).to.equal("admin");
		expect(levelOf(new Set(["i"]))).to.equal("none");

		expect(
			parsePrivs(parseLine(":irc.test 270 opr opr :CHAN_LIMIT KILL WIDE_GLINE")!)
		).to.deep.equal(["CHAN_LIMIT", "KILL", "WIDE_GLINE"]);
		expect(
			parseFeature(parseLine(":irc.test 284 opr :Boolean value of CONNEXIT_NOTICES: FALSE")!)
		).to.deep.equal({
			name: "CONNEXIT_NOTICES",
			value: "FALSE",
		});
		expect(
			parseFeature(
				parseLine(":irc.test 284 opr :Integer value of SNOMASK_OPERDEFAULT: 5645")!
			)
		).to.deep.equal({name: "SNOMASK_OPERDEFAULT", value: "5645"});
	});

	it("an own +o (whoever set it) asks for PRIVS, the snomask and the features", async function () {
		const {client, transport} = setup();

		transport.line(":opr!opr@host MODE opr +owsg");
		await flush();

		expect(operStates().at(-1)).to.include({
			level: "global",
			umodes: "gosw",
			profile: "nefarious2",
		});
		expect(transport.sent.map((l) => l.replace(/^@label=\S+ /, ""))).to.have.members([
			"PRIVS",
			"MODE opr +s +0",
			"GET CONNEXIT_NOTICES",
			"GET SNOMASK_OPERDEFAULT",
		]);

		const labelOf = (cmd: string) =>
			/^@label=(\S+) /.exec(transport.sent.find((l) => l.endsWith(cmd))!)![1];

		transport.lines(
			":irc.test 270 opr opr :CHAN_LIMIT KILL CHECK",
			`@label=${labelOf("PRIVS")} :irc.test ACK`,
			`@label=${labelOf("+s +0")} :irc.test 008 opr 5645 :: Server notice mask (0x160d)`,
			`@label=${labelOf(
				"CONNEXIT_NOTICES"
			)} :irc.test 284 opr :Boolean value of CONNEXIT_NOTICES: FALSE`,
			`@label=${labelOf(
				"SNOMASK_OPERDEFAULT"
			)} :irc.test 284 opr :Integer value of SNOMASK_OPERDEFAULT: 5645`
		);
		await flush();

		const state = operStates().at(-1)!;
		expect(state.privs).to.deep.equal(["CHAN_LIMIT", "KILL", "CHECK"]);
		expect(state.privsKnown).to.equal(true);
		expect(state.snomask).to.equal(5645);
		expect(state.features).to.deep.equal({
			CONNEXIT_NOTICES: "FALSE",
			SNOMASK_OPERDEFAULT: "5645",
		});
		expect(client.oper.level).to.equal("global");
		expect(
			messages(client.lobby.id).filter((m) => m.type !== MessageType.MODE),
			"replies not shown raw"
		).to.have.length(0);
	});

	it("puts back the snomask chosen last time after oper-up", async function () {
		const {client, transport} = setup();
		setSnomaskPref(client.uuid, 983039);

		transport.line(":opr!opr@host MODE opr +ow");
		await flush();
		const privs = transport.sent.find((l) => l.endsWith("PRIVS"))!;
		transport.line(`${/^(@label=\S+) /.exec(privs)![1]} :irc.test ACK`);

		for (const line of transport.sent.filter((l) => l.includes(" GET "))) {
			transport.line(`${/^(@label=\S+) /.exec(line)![1]} :irc.test ACK`);
		}

		await flush();

		expect(transport.sent.at(-1)).to.match(/^@label=\S+ MODE opr \+s 983039$/);
	});

	it("-o drops the level and the privileges; the snomask goes with -s", function () {
		const {client, transport} = setup();
		transport.line(":opr!opr@host MODE opr +ows");
		client.oper.privs = ["KILL"];
		client.oper.snomask = 5645;

		transport.line(":opr!opr@host MODE opr -o");
		expect(client.oper.level).to.equal("none");
		expect(client.oper.privs).to.deep.equal([]);
		expect(client.oper.snomask).to.equal(5645);

		transport.line(":opr!opr@host MODE opr -s");
		expect(client.oper.snomask).to.equal(undefined);
	});

	it("asks for the privileges again when services change them", async function () {
		const {client, transport} = setup();
		transport.line(":opr!opr@host MODE opr +o");
		await flush();
		const before = transport.sent.filter((l) => l.endsWith(" PRIVS")).length;

		transport.line(":irc.test NOTICE opr :Your privileges were modified");
		expect(transport.sent.filter((l) => l.endsWith(" PRIVS")).length).to.equal(before + 1);
		expect(messages(client.lobby.id).at(-1)?.text, "still shown").to.equal(
			"Your privileges were modified"
		);
	});

	it("an +o that lands before 001 is followed up once registration is done", function () {
		const transport = new FakeTransport();
		const client = new IrcClient({
			host: "irc.test",
			port: 8443,
			tls: true,
			nick: "opr",
			join: "",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			ids: new IdAllocator(),
			transportFactory: () => transport,
			highlights: () => ({keywords: [], exceptions: []}),
		});

		client.connect();
		transport.open();
		transport.lines(
			":irc.test CAP * LS :batch labeled-response",
			":irc.test CAP opr ACK :batch labeled-response",
			":opr!opr@host MODE opr +o"
		);
		expect(client.oper.level).to.equal("global");
		expect(
			transport.sent.some((l) => l.endsWith("PRIVS")),
			"nothing asked before 001"
		).to.equal(false);

		transport.lines(":irc.test 001 opr :Welcome", ":irc.test 422 opr :MOTD File is missing");
		expect(transport.sent.some((l) => /^@label=\S+ PRIVS$/.test(l))).to.equal(true);
	});

	it("a typed /mode +s answer (008) updates the snomask and says so where the user is", function () {
		const {client, transport} = setup();
		transport.line(":opr!opr@host MODE opr +os");
		transport.line(":irc.test 008 opr 983039 :: Server notice mask (0xeffff)");

		expect(client.oper.snomask).to.equal(983039);
		const shown = messages(client.lobby.id).find((m) =>
			m.text?.startsWith("Server notice mask")
		);
		expect(shown).to.include({
			text: "Server notice mask: 983039 (0xeffff)",
			showInActive: true,
		});
	});
});

describe("oper tools: server notice and WALLOPS routing (irc/snotice.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("an important notice shows in the active window, without unread", function () {
		const {client, transport} = setup();
		const unread = client.lobby.shared.unread;
		transport.line(
			":irc.test NOTICE * :*** Notice -- opr (opr@172.17.0.1) is now a global operator (O)"
		);

		const [msg] = messages(client.lobby.id);
		expect(msg.type).to.equal(MessageType.SNOTICE);
		expect(msg.text).to.equal("opr (opr@172.17.0.1) is now a global operator (O)");
		expect(msg.showInActive).to.equal(true);
		expect(msg.snotice).to.deep.include({kind: "oper.up", category: "OLDSNO", route: "active"});
		expect(msg.snotice!.origin, "our own server is not named").to.equal(undefined);
		expect(client.lobby.shared.unread).to.equal(unread);

		transport.line(":leaf.test NOTICE * :*** Notice -- bob (b@h) is now a global operator (O)");
		expect(messages(client.lobby.id)[1].snotice!.origin).to.equal("leaf.test");
	});

	it("a routine notice stays in the network window without unread", function () {
		const {client, transport} = setup();
		const unread = client.lobby.shared.unread;
		transport.line(
			":irc.test NOTICE * :*** Notice -- Client connecting: bob (bob@cpe.example) [203.0.113.7] {Users} [Bob [the] Builder] <ABAAC>"
		);

		const [msg] = messages(client.lobby.id);
		expect(msg.snotice).to.deep.include({kind: "client.connect", route: "network"});
		expect(msg.snotice!.fields).to.include({nick: "bob", ip: "203.0.113.7"});
		expect(msg.showInActive).to.equal(undefined);
		expect(client.lobby.shared.unread).to.equal(unread);
	});

	it("follows the oper's routing choices: off drops it, active promotes it", function () {
		const {client, transport} = setup();
		setRoute(client.uuid, "client.connect", "off");
		transport.line(
			":irc.test NOTICE * :*** Notice -- Client connecting: bob (b@h) [1.2.3.4] {Users} [Bob] <ABAAC>"
		);
		expect(messages(client.lobby.id)).to.have.length(0);

		setRoute(client.uuid, "client.connect", "active");
		transport.line(
			":irc.test NOTICE * :*** Notice -- Client connecting: bob (b@h) [1.2.3.4] {Users} [Bob] <ABAAC>"
		);
		expect(messages(client.lobby.id)[0].showInActive).to.equal(true);
	});

	it("an unrecognised notice goes to the network window as `unknown`", function () {
		const {client, transport} = setup();
		transport.line(":irc.test NOTICE * :*** Notice -- something nobody has seen before");

		const [msg] = messages(client.lobby.id);
		expect(msg.snotice).to.deep.include({kind: "unknown", category: "OTHER", route: "network"});
	});

	it("leaves other notices alone: a service's, and the pre-registration ones", function () {
		const {client, transport} = setup();
		transport.line(":X3!X3@services.test NOTICE opr :*** Notice -- not from a server");
		transport.line(":irc.test NOTICE opr :Highest connection count: 3 (3 clients)");

		expect(messages(client.lobby.id).map((m) => m.type)).to.deep.equal([
			MessageType.NOTICE,
			MessageType.NOTICE,
		]);
	});

	it("tells WALLOPS, WALLUSERS, server WALLOPS and DESYNCH apart", function () {
		const {client, transport} = setup();
		transport.lines(
			":rubin!r@h WALLOPS :* split in 5",
			":rubin!r@h WALLOPS :$ maintenance tonight",
			":irc.test WALLOPS :* Remote CONNECT leaf.test 4400 from rubin",
			":irc.test WALLOPS :Protocol Violation from hub.test: bad"
		);

		const msgs = messages(client.lobby.id);
		expect(msgs.map((m) => [m.snotice!.kind, m.text, m.showInActive])).to.deep.equal([
			["wallops", "split in 5", true],
			["wallusers", "maintenance tonight", true],
			["wallops.server", "Remote CONNECT leaf.test 4400 from rubin", true],
			["desynch", "Protocol Violation from hub.test: bad", undefined],
		]);
		expect(msgs[0]).to.deep.include({
			type: MessageType.WALLOPS,
			from: {nick: "rubin", mode: ""},
		});
	});

	it("keeps every routed line in the notice log, but not the dropped ones", function () {
		const {client, transport} = setup();
		setRoute(client.uuid, "desynch", "off");
		transport.lines(
			":irc.test NOTICE * :*** Notice -- opr (opr@h) is now a global operator (O)",
			":irc.test WALLOPS :Protocol Violation from hub.test: bad",
			":rubin!r@h WALLOPS :* hi"
		);

		expect(client.noticeLog.all().map((e) => e.snotice.kind)).to.deep.equal([
			"oper.up",
			"wallops",
		]);
	});
});

describe("oper tools: commands (irc/commands/oper.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("/stats u becomes one report message where it was typed", async function () {
		const {client, transport} = setup();
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/stats u");
		expect(transport.sent).to.deep.equal(["@label=r1 STATS u"]);

		transport.lines(
			"@label=r1 :irc.test BATCH +AA labeled-response",
			"@batch=AA :irc.test 242 opr :Server Up 0 days, 0:01:59",
			"@batch=AA :irc.test 219 opr u :End of /STATS report",
			":irc.test BATCH -AA"
		);
		await flush();

		const msgs = messages(chan.id);
		expect(msgs).to.have.length(1);
		expect(msgs[0].type).to.equal(MessageType.REPORT);
		expect(msgs[0].report!.kind).to.equal("stats");
		expect(msgs[0].report!.command).to.equal("STATS u");
		expect(msgs[0].report!.raw).to.include("Server Up 0 days, 0:01:59");
	});

	it("/check reports an error reply as the card's error", async function () {
		const {client, transport} = setup();
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/check bob");
		transport.line(
			`@label=${lastLabel(
				transport
			)} :irc.test 481 opr :Permission Denied: Insufficient privileges`
		);
		await flush();

		const [msg] = messages(chan.id);
		expect(msg.type).to.equal(MessageType.REPORT);
		expect(msg.report!.error).to.be.a("string").and.not.equal("");
	});

	it("/privs shows the privileges as chips and keeps our own", async function () {
		const {client, transport} = setup();
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/privs");
		transport.lines(
			":irc.test 270 opr opr :KILL CHECK",
			`@label=${lastLabel(transport)} :irc.test ACK`
		);
		await flush();

		const [msg] = messages(chan.id);
		expect(msg.report!.sections[0].entries![0].value).to.deep.equal({
			t: "chips",
			v: ["KILL", "CHECK"],
		});
		expect(client.oper.privs).to.deep.equal(["KILL", "CHECK"]);
	});

	it("without labeled-response the commands go out plainly", function () {
		const {client, transport} = setup({labels: false});
		const chan = client.findChannel("#seance")!;

		dispatchInput(client, chan, "/stats g");
		dispatchInput(client, chan, "/check #seance -o");
		expect(transport.sent).to.deep.equal(["STATS g", "CHECK #seance -o"]);
	});
});

describe("oper tools: the notice log (irc/noticelog.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	const entry = (time: number, kind = "oper.up"): LoggedNotice => ({
		time,
		type: "snotice",
		text: `t${time}`,
		snotice: {kind, category: "OLDSNO", fields: {}, route: "network"},
	});

	it("keeps the newest entries within a day", function () {
		const now = 10 * MAX_AGE_MS;
		const many = Array.from({length: MAX_ENTRIES + 5}, (_, i) => entry(now - 1000 + i / 10));
		expect(trim(many, now)).to.have.length(MAX_ENTRIES);
		expect(
			trim([entry(now - MAX_AGE_MS - 1), entry(now)], now).map((e) => e.time)
		).to.deep.equal([now]);
	});

	it("loads what was stored ahead of what arrived meanwhile, and saves saved networks only", async function () {
		const clock = sinon.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout"],
			now: 5 * MAX_AGE_MS,
		});

		try {
			let saved = false;
			const t = Date.now();
			logStore.set("n1", [entry(t - 1000)]);
			const log = new NoticeLog("n1", () => saved);
			log.append(entry(t));
			await log.load();
			expect(log.all().map((e) => e.time)).to.deep.equal([t - 1000, t]);

			log.append(entry(t + 1));
			log.flush();
			expect(logStore.get("n1"), "unsaved network: not written").to.have.length(1);

			saved = true;
			log.append(entry(t + 2));
			log.flush();
			expect(logStore.get("n1")).to.have.length(4);
		} finally {
			clock.restore();
		}
	});
});
