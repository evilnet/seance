import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {
	BURST,
	type ChannelModel,
	Investigation,
	PACE_MS,
	type UserModel,
} from "../../client/js/irc/investigate";
import {useNoticeLogBackend, type LoggedNotice} from "../../client/js/irc/noticelog";
import {useOperPrefsBackend} from "../../client/js/irc/operprefs";
import {SERVICE_QUIET_MS} from "../../client/js/irc/services";
import {fateText} from "../../client/js/helpers/verdict";
import {X3_DEFAULTS} from "../../client/js/irc/services/x3";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import type {ServicesConfig} from "../../shared/types/network";

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
let clock: sinon.SinonFakeTimers;

// A Saturday evening: the feed's times are relative to it.
const NOW = new Date(2026, 9, 10, 21, 0, 0).getTime();
const MIN = 60_000;

function installSpy(): void {
	const current = (socket as unknown as Record<string, unknown>).dispatch;

	if ((current as {isSinonProxy?: boolean}).isSinonProxy) {
		dispatch = current as sinon.SinonSpy;
		ownsSpy = false;
	} else {
		dispatch = sinon.spy(socket, "dispatch");
		ownsSpy = true;
	}

	useNoticeLogBackend({
		load: () => Promise.resolve(undefined),
		save: () => Promise.resolve(),
		remove: () => Promise.resolve(),
	});
	const prefs = new Map<string, string>();
	useOperPrefsBackend({
		get: (key) => prefs.get(key) ?? null,
		set: (key, value) => prefs.set(key, value),
	});
	clock = sinon.useFakeTimers({now: NOW, toFake: ["setTimeout", "clearTimeout", "Date"]});
}

function removeSpy(): void {
	clock.restore();

	if (ownsSpy) {
		dispatch.restore();
	}

	useNoticeLogBackend(null);
	useOperPrefsBackend(null);
	socket.removeAllListeners();
}

const X3: ServicesConfig = {package: "x3", bots: {...X3_DEFAULTS}};

/** A registered client on a nefarious2 server with labels, WHOX and #seance joined. */
function setup(opts: {opered?: boolean; services?: boolean; labels?: boolean} = {}): {
	client: IrcClient;
	transport: FakeTransport;
} {
	const caps =
		opts.labels === false
			? "batch message-tags server-time"
			: "batch labeled-response message-tags server-time";
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
		":irc.test 004 opr irc.test u2.10.12.14+Nefarious(2.0.0) abdgiknoqswxyzBDHLMNORWXY abCcDdhHikLlMmNnOopPQRrSsTtvZz bkLlov",
		":irc.test 005 opr CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,Ll,imnpst CASEMAPPING=rfc1459 WHOX :are supported by this server",
		":irc.test 422 opr :MOTD File is missing",
		":opr!opr@host JOIN #seance",
		":irc.test 353 opr = #seance :@opr bot1 bot2 bot3",
		":irc.test 366 opr #seance :End of /NAMES list."
	);

	if (opts.opered ?? true) {
		transport.line(":opr MODE opr :+o");
	}

	if (opts.services ?? true) {
		client.setServices(X3);
	}

	transport.sent = [];
	dispatch.resetHistory();

	return {client, transport};
}

/** `@label=rN …` → `rN`. */
function labelOf(line: string): string {
	return /^@label=(\S+) /.exec(line)?.[1] ?? "";
}

/** The bare command of a sent line (the label off). */
function commandOf(line: string): string {
	return line.replace(/^@\S+ /, "");
}

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
	}
}

let batches = 0;

/** Answer the labeled request `line` with a `labeled-response` batch of `lines`. */
function batchReply(transport: FakeTransport, line: string, lines: string[]): void {
	const ref = `B${++batches}`;
	transport.line(`@label=${labelOf(line)} :irc.test BATCH +${ref} labeled-response`);

	for (const l of lines) {
		transport.line(`@batch=${ref} ${l}`);
	}

	transport.line(`:irc.test BATCH -${ref}`);
}

const O = "\x0f";

const CHECK_SEANCE = [
	":irc.test 290 opr : ",
	":irc.test 286 opr :Information for channel #seance",
	":irc.test 290 opr : ",
	":irc.test 290 opr :   Creation time:: Sat Oct 10 20:50:00 2026",
	":irc.test 290 opr :           Topic:: bots welcome",
	":irc.test 290 opr :          Set by:: opr",
	":irc.test 290 opr : Channel mode(s):: +nt",
	":irc.test 290 opr :Users (@ = op, + = voice, < = delayed, ~ = alias)",
	`:irc.test 287 opr :         @opr (opr@172.17.0.1)   (Real Name of opr${O}) `,
	`:irc.test 287 opr :          bot1 (r8821@203-0-113-1.example.net)   (irc client${O}) `,
	`:irc.test 287 opr :          bot2 (r1234@203-0-113-2.example.net)   (irc client${O}) `,
	`:irc.test 287 opr :          bot3 (r5555@203-0-113-3.example.net)   (irc client${O}) acct3`,
	":irc.test 290 opr : ",
	":irc.test 290 opr :Total users:: 4 (1 ops, 0 voiced, 0 clones, 1 authed, 0 delayed, 0 aliases)",
	":irc.test 290 opr : ",
	":irc.test 290 opr :Bans on channel::",
	":irc.test 290 opr :[1] - *!*@spam.example.org - Set by opr, on Sat Oct 10 20:55:00 2026",
	":irc.test 291 opr : ",
];

/** `354 <me> <token> <chan> <user> <ip> <host> <server> <nick> <flags> <hops> <idle> <account> :<realname>` */
function whoxRow(
	token: string,
	nick: string,
	ident: string,
	ip: string,
	host: string,
	flags: string,
	account: string,
	realname: string
): string {
	return `:irc.test 354 opr ${token} #seance ${ident} ${ip} ${host} leaf2.example.org ${nick} ${flags} 0 12 ${account} :${realname}`;
}

function whoReply(token: string): string[] {
	return [
		whoxRow(token, "opr", "opr", "172.17.0.1", "172.17.0.1", "H*@", "0", "Real Name of opr"),
		whoxRow(
			token,
			"bot1",
			"r8821",
			"203.0.113.1",
			"203-0-113-1.example.net",
			"H",
			"0",
			"irc client"
		),
		whoxRow(
			token,
			"bot2",
			"r1234",
			"203.0.113.2",
			"203-0-113-2.example.net",
			"H",
			"0",
			"irc client"
		),
		whoxRow(
			token,
			"bot3",
			"r5555",
			"203.0.113.3",
			"203-0-113-3.example.net",
			"H",
			"acct3",
			"irc client"
		),
		":irc.test 315 opr #seance :End of /WHO list.",
	];
}

// docs/resources/x3-services.md §7 CHANINFO, verbatim shapes.
const CHANINFO = [
	"#seance Information",
	"Created on: Sat Oct 10 20:50:00 2026 (1791665400)",
	"Modes: +nt",
	"Topic (set by opr, Sat Oct 10 20:51:00 2026): bots welcome",
	"Bans (1):",
	"*!*@spam.example.org by opr (Sat Oct 10 20:55:00 2026)",
	'4 users ("/msg O3 chaninfo #seance users" for the list)',
];

// §9 ChanServ INFO.
const CHANSERV_INFO = [
	"Information About #seance",
	"------------------------",
	"Owner:                acct3",
	"Total User Count:     4",
	"Registered:           3w, 2d ago.",
	"Registrar:            acct3",
	"---------------End of Info--------------",
];

// §7 WHOIS (labels padded to 13).
function o3Whois(
	nick: string,
	ident: string,
	host: string,
	ip: string,
	extra: string[] = []
): string[] {
	return [
		`Nick         : ${nick}`,
		`Host         : ${ident}@${host}`,
		`Real IP      : ${ip}`,
		"Country      : Netherlands",
		"City         : Amsterdam",
		"Version      : irssi v1.4.5",
		"No_notices   : NO",
		"Info         : irc client",
		"Numnick      : ABAAE",
		"Server       : leaf2.example.org",
		"Account      : Not authenticated",
		"IRCd Privs   : ",
		"Nick Age     : 5 minutes",
		...extra,
	];
}

function notice(transport: FakeTransport, bot: string, lines: string[]): void {
	for (const line of lines) {
		transport.line(`:${bot}!${bot}@services.test NOTICE opr :${line}`);
	}
}

function snoop(keyword: string, fields: Record<string, string>, at: number): LoggedNotice {
	return {
		time: NOW + at * MIN,
		type: "snoop",
		text: keyword,
		snotice: {kind: `x3.snoop.${keyword}`, category: "SERVICES", fields, route: "network"},
	};
}

function snotice(
	kind: string,
	fields: Record<string, string>,
	at: number,
	category = "CONNEXIT"
): LoggedNotice {
	return {
		time: NOW + at * MIN,
		type: "snotice",
		text: kind,
		snotice: {kind, category, fields, route: "network"},
	};
}

describe("the channel investigation (irc/investigate.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("asks CHECK, WHO and chaninfo in one burst, paces the rest, and fills the model as answers come", async function () {
		const {client, transport} = setup();
		client.noticeLog.append(snoop("join", {channel: "#seance", nick: "bot1"}, -3));
		client.noticeLog.append(snoop("join", {channel: "#seance", nick: "bot2"}, -2.5));
		client.noticeLog.append(
			snoop(
				"connect",
				{
					nick: "bot2",
					ident: "r1234",
					host: "h",
					account: "",
					ip: "203.0.113.2",
					server: "leaf2.example.org",
				},
				-4
			)
		);

		const inv = new Investigation(client, "channel", "#seance");
		const changes = sinon.spy();
		inv.onChange = changes;
		inv.start();

		expect(transport.sent.map(commandOf)).to.deep.equal([
			"CHECK #seance",
			`WHO #seance %tcuihsnfdlar,${transport.sent[1].split(",").pop()}`,
			"PRIVMSG O3 :chaninfo #seance",
		]);
		expect(BURST).to.equal(3);
		expect(inv.sources).to.deep.equal({
			check: "asking",
			who: "asking",
			chaninfo: "asking",
			registration: "asking",
		});

		const [checkLine, whoLine] = transport.sent;
		const token = whoLine.split(",").pop()!;

		batchReply(transport, checkLine, CHECK_SEANCE);
		await flush();

		let model = inv.model as ChannelModel;
		expect(inv.sources.check).to.equal("done");
		expect(model.topic).to.equal("bots welcome");
		expect(model.modes).to.equal("+nt");
		expect(model.bans.map((b) => b.mask)).to.deep.equal(["*!*@spam.example.org"]);
		expect(model.users.map((u) => u.nick)).to.deep.equal(["opr", "bot1", "bot2", "bot3"]);
		expect(model.users[3].account).to.equal("acct3");
		expect(model.users[1].authed).to.equal(false);
		expect(model.users[0].op).to.equal(true);
		expect(model.users[1].joinedAt).to.equal(NOW - 3 * MIN);
		expect(model.users[2].connectedAt).to.equal(NOW - 4 * MIN);

		batchReply(transport, whoLine, whoReply(token));
		await flush();

		model = inv.model as ChannelModel;
		expect(inv.sources.who).to.equal("done");
		expect(model.users[1].ip).to.equal("203.0.113.1");
		expect(model.users[1].server).to.equal("leaf2.example.org");
		expect(model.users[1].idle).to.equal(12);
		expect(inv.sources.userip, "every user has an IP: USERIP not needed").to.equal("off");

		// Three of the four share: not authed is only 3 of 4 = threshold 3.
		const facts = model.commonality!.facts;
		expect(model.commonality!.threshold).to.equal(3);
		expect(facts.map((f) => f.label)).to.include.members([
			"realname 'irc client'",
			"ident r + 4 digits",
			"203.0.113.*",
			"server leaf2.example.org",
		]);
		expect(facts.find((f) => f.key === "identShape")!.value).to.equal("r????");
		// bot3 is authed and opr's realname differs: only bot1 and bot2 share every fact.
		expect(facts.find((f) => f.key === "authed")!.nicks).to.deep.equal(["opr", "bot1", "bot2"]);
		expect(model.commonality!.sharingAll).to.deep.equal(["bot1", "bot2"]);

		// O3's chaninfo: the created time from the unix stamp, the bans.
		notice(transport, "O3", CHANINFO);
		await flush();
		model = inv.model as ChannelModel;
		expect(inv.sources.chaninfo).to.equal("done");
		expect(model.createdAt).to.equal(1791665400 * 1000);
		expect(model.topicBy).to.equal("opr");

		// The next bot query waits for the pace, then ChanServ's info.
		expect(transport.sent).to.have.length(3);
		clock.tick(PACE_MS);
		await flush();
		expect(commandOf(transport.sent[3])).to.equal("PRIVMSG ChanServ :info #seance");
		notice(transport, "ChanServ", CHANSERV_INFO);
		await flush();
		model = inv.model as ChannelModel;
		expect(model.registered).to.equal(true);
		expect(model.registeredSince).to.equal("3w, 2d");
		expect(model.owner).to.equal("acct3");

		// Then one O3 whois per user, 2 s apart, countries last.
		clock.tick(PACE_MS);
		await flush();
		expect(commandOf(transport.sent[4])).to.equal("PRIVMSG O3 :whois opr");
		expect(transport.sent).to.have.length(5);
		notice(transport, "O3", o3Whois("opr", "opr", "172.17.0.1", "172.17.0.1"));
		clock.tick(SERVICE_QUIET_MS);
		await flush();
		expect(transport.sent, "the next whois waits for the pace").to.have.length(5);
		clock.tick(PACE_MS - SERVICE_QUIET_MS);
		await flush();
		expect(commandOf(transport.sent[5])).to.equal("PRIVMSG O3 :whois bot1");
		notice(
			transport,
			"O3",
			o3Whois("bot1", "r8821", "203-0-113-1.example.net", "203.0.113.1", [
				"Channels     : #seance #other ",
			])
		);
		clock.tick(SERVICE_QUIET_MS);
		await flush();

		model = inv.model as ChannelModel;
		const bot1 = model.users.find((u) => u.nick === "bot1")!;
		expect(bot1.lookup).to.equal("done");
		expect(bot1.country).to.equal("Netherlands");
		expect(bot1.version).to.equal("irssi v1.4.5");
		expect(bot1.channels).to.deep.equal(["#seance", "#other"]);
		expect(model.recent.map((e) => e.text)).to.deep.equal(["bot1 and bot2 joined"]);
		expect(model.snoopMissing).to.equal("#mrsnoopy");
		expect(
			inv.raw.some((l) => l.includes("Information for channel")),
			"raw CHECK lines"
		).to.equal(true);
		expect(
			inv.raw.some((l) => l.startsWith("-O3- Nick")),
			"raw bot lines"
		).to.equal(true);
		expect(changes.callCount).to.be.greaterThan(4);

		inv.stop();
		clock.tick(PACE_MS * 2);
		await flush();
		expect(transport.sent, "nothing after stop").to.have.length(6);
	});

	it("without services asks the server alone, and USERIP for anyone WHO gave no IP", async function () {
		const {client, transport} = setup({services: false});
		const inv = new Investigation(client, "channel", "#seance");
		inv.start();

		expect(transport.sent.map(commandOf)).to.have.length(2);
		expect(inv.sources.chaninfo).to.equal("off");
		expect(inv.sources.lookups).to.equal("off");

		const [checkLine, whoLine] = transport.sent;
		const token = whoLine.split(",").pop()!;
		batchReply(transport, checkLine, CHECK_SEANCE);
		// A non-oper's WHO: the IP column is 255.255.255.255.
		batchReply(transport, whoLine, [
			whoxRow(
				token,
				"bot1",
				"r8821",
				"255.255.255.255",
				"203-0-113-1.example.net",
				"H",
				"0",
				"irc client"
			),
			":irc.test 315 opr #seance :End of /WHO list.",
		]);
		await flush();

		// Four users without an IP: one USERIP of them all (five fit), in the burst's last slot.
		expect(commandOf(transport.sent[2])).to.equal("USERIP opr bot1 bot2 bot3");
		expect(inv.sources.userip).to.equal("asking");
		transport.lines(
			":irc.test 340 opr :bot1=+r8821@203.0.113.1 bot2=+r1234@203.0.113.2",
			`@label=${labelOf(transport.sent[2])} :irc.test ACK`
		);
		await flush();

		const model = inv.model as ChannelModel;
		expect(model.users.find((u) => u.nick === "bot1")!.ip).to.equal("203.0.113.1");
		expect(model.users.find((u) => u.nick === "bot2")!.ip).to.equal("203.0.113.2");
		expect(inv.sources.userip).to.equal("done");
		expect(model.snoopMissing).to.equal(undefined);
	});

	it("counts matches with trace count from the shared facts' criteria", async function () {
		const {client, transport} = setup();
		const inv = new Investigation(client, "channel", "#seance");
		inv.start();
		const [checkLine, whoLine] = transport.sent;
		batchReply(transport, checkLine, CHECK_SEANCE);
		batchReply(transport, whoLine, whoReply(whoLine.split(",").pop()!));
		await flush();

		expect(inv.criteria()).to.deep.equal([
			"authed no",
			"info irc?client",
			"ident r????",
			"ip 203.0.113.0/24",
			"server leaf2.example.org",
		]);

		inv.traceCount();
		expect((inv.model as ChannelModel).traceCount?.state).to.equal("asking");
		// The services lane is busy with chaninfo; answer it, then the count goes out after the pace.
		notice(transport, "O3", CHANINFO);
		await flush();
		clock.tick(PACE_MS);
		await flush();
		const sent = transport.sent.map(commandOf);
		expect(sent).to.include("PRIVMSG ChanServ :info #seance");
		notice(transport, "ChanServ", CHANSERV_INFO);
		await flush();
		clock.tick(PACE_MS);
		await flush();
		// User lookups were queued before the count: they go first.
		expect(commandOf(transport.sent[transport.sent.length - 1])).to.equal(
			"PRIVMSG O3 :whois opr"
		);
	});
});

describe("the user investigation (irc/investigate.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	const CHECK_USER = [
		":irc.test 290 opr : ",
		":irc.test 286 opr :Information for user spamfan2",
		":irc.test 290 opr : ",
		":irc.test 290 opr :           Nick:: spamfan2 (ABAAE)",
		":irc.test 290 opr :      Signed on:: Sat Oct 10 20:55:00 2026",
		":irc.test 290 opr :      Timestamp:: Sat Oct 10 20:55:00 2026 (1791665700)",
		":irc.test 290 opr :  User/Hostmask:: r8821@203-0-113-7.example.net",
		":irc.test 290 opr : Real User/Host:: r8821@203-0-113-7.example.net (203.0.113.7)",
		`:irc.test 290 opr :      Real Name:: irc client${O}`,
		":irc.test 290 opr :         Status:: Client",
		":irc.test 290 opr :          Class:: Users",
		":irc.test 290 opr :   Connected to:: leaf2.example.org",
		":irc.test 290 opr :       Umode(s):: +x",
		":irc.test 290 opr :     Channel(s):: #seance ",
		":irc.test 290 opr :       Idle for:: 0 days, 00:01:04",
		":irc.test 291 opr : ",
	];

	it("asks CHECK, WHOIS and USERIP at once, the ban lists paced, and judges from the feed", async function () {
		const {client, transport} = setup();
		client.noticeLog.append(
			snotice(
				"client.connect",
				{
					nick: "spamfan",
					user: "r1234",
					host: "r1234@203-0-113-7.example.net",
					ip: "203.0.113.7",
					realname: "irc client",
				},
				-22 * 60 // the log keeps a day; Friday evening
			)
		);
		client.noticeLog.append(
			snotice(
				"ban.add",
				{
					oper: "rubin",
					scope: "global",
					type: "G-line",
					mask: "*@203.0.113.0/24",
					expires: "1791900000",
					reason: "bot group",
				},
				-22 * 60 + 5,
				"GLINE"
			)
		);

		const inv = new Investigation(client, "user", "spamfan2");
		inv.start();

		expect(transport.sent.map(commandOf)).to.deep.equal([
			"CHECK spamfan2",
			"WHOIS spamfan2 spamfan2",
			"USERIP spamfan2",
		]);
		expect(inv.sources.stats).to.equal("asking");

		const [checkLine, whoisLine, useripLine] = transport.sent;
		batchReply(transport, checkLine, CHECK_USER);
		await flush();

		let model = inv.model as UserModel;
		expect(model.snoopMissing, "the snoop channel is configured and not joined").to.equal(
			"#mrsnoopy"
		);
		expect(model.user.ip).to.equal("203.0.113.7");
		expect(model.user.host).to.equal("203-0-113-7.example.net");
		expect(model.user.ident).to.equal("r8821");
		expect(model.user.realname).to.equal("irc client");
		expect(model.user.server).to.equal("leaf2.example.org");
		expect(model.user.modes).to.equal("+x");
		expect(model.user.authed).to.equal(false);
		expect(model.user.channels).to.deep.equal(["#seance"]);
		expect(model.user.idle).to.equal(64);
		expect(model.user.connectedAt).to.equal(Date.UTC(2026, 9, 10, 20, 55, 0));
		expect(inv.noteKey).to.equal("203.0.113.7");

		// Seen before, from the feed, before any ban list is in.
		expect(model.seen.map((s) => s.nick)).to.deep.equal(["spamfan"]);
		expect(model.seen[0].matched).to.deep.equal(["ip", "host", "realname"]);
		expect(fateText(model.seen[0].fate!)).to.equal("G-lined by rubin for 'bot group'");
		expect(model.verdict).to.equal(
			"Likely the same as spamfan (Fri): same IP, same host, same realname, same ident shape; G-lined then by rubin for 'bot group'."
		);

		batchReply(transport, whoisLine, [
			":irc.test 311 opr spamfan2 r8821 203-0-113-7.example.net * :irc client",
			":irc.test 312 opr spamfan2 leaf2.example.org :Leaf two",
			":irc.test 317 opr spamfan2 64 1791665700 :seconds idle, signon time",
			":irc.test 318 opr spamfan2 :End of /WHOIS list.",
		]);
		transport.lines(
			":irc.test 340 opr :spamfan2=+r8821@203.0.113.7",
			`@label=${labelOf(useripLine)} :irc.test ACK`
		);
		await flush();
		expect(inv.sources.whois).to.equal("done");
		expect(inv.sources.userip).to.equal("done");

		// STATS g, S, Z one every PACE_MS after the burst.
		expect(transport.sent).to.have.length(3);
		clock.tick(PACE_MS);
		await flush();
		expect(commandOf(transport.sent[3])).to.equal("STATS g");
		batchReply(transport, transport.sent[3], [
			":irc.test 247 opr G *@203.0.113.0/24 1791900000 1791493200 1792000000 + :bot group",
			":irc.test 247 opr G *@198.51.100.9 1791900000 1791493200 1792000000 + :other",
			":irc.test 219 opr g :End of /STATS report",
		]);
		await flush();
		model = inv.model as UserModel;
		expect(model.liveBans.map((b) => b.mask)).to.deep.equal(["*@203.0.113.0/24"]);
		expect(model.liveBans[0].by).to.equal("rubin");
		expect(model.verdict).to.equal(
			"Covered by a live G-line: *@203.0.113.0/24 (rubin, 22 h ago)."
		);

		clock.tick(PACE_MS);
		await flush();
		expect(commandOf(transport.sent[4])).to.equal("STATS S");
		batchReply(transport, transport.sent[4], [":irc.test 219 opr S :End of /STATS report"]);
		clock.tick(PACE_MS);
		await flush();
		expect(commandOf(transport.sent[5])).to.equal("STATS Z");
		batchReply(transport, transport.sent[5], [":irc.test 219 opr Z :End of /STATS report"]);
		await flush();
		expect(inv.sources.stats).to.equal("done");
		expect(inv.sources.gtrace, "the server listed bans: gtrace not asked").to.equal("off");

		// O3's whois, last: the country and version.
		clock.tick(PACE_MS);
		await flush();
		expect(commandOf(transport.sent[6])).to.equal("PRIVMSG O3 :whois spamfan2");
		notice(
			transport,
			"O3",
			o3Whois("spamfan2", "r8821", "203-0-113-7.example.net", "203.0.113.7")
		);
		clock.tick(SERVICE_QUIET_MS);
		await flush();
		model = inv.model as UserModel;
		expect(model.user.country).to.equal("Netherlands");
		expect(model.user.city).to.equal("Amsterdam");
		expect(model.user.version).to.equal("irssi v1.4.5");
		expect(model.user.nickAge).to.equal("5 minutes");
		expect(inv.sources.account, "not authed: AuthServ not asked").to.equal(undefined);
		clock.tick(PACE_MS);
		await flush();
		expect(transport.sent).to.have.length(7);
	});

	it("waits for all three ban lists before asking O3's gtrace", async function () {
		const {client, transport} = setup();
		const inv = new Investigation(client, "user", "spamfan2");
		inv.start();
		const [checkLine, whoisLine, useripLine] = transport.sent;
		batchReply(transport, checkLine, CHECK_USER);
		batchReply(transport, whoisLine, [":irc.test 318 opr spamfan2 :End of /WHOIS list."]);
		transport.lines(
			":irc.test 340 opr :spamfan2=+r8821@203.0.113.7",
			`@label=${labelOf(useripLine)} :irc.test ACK`
		);
		await flush();

		// No G-line: that alone is not "the server listed none".
		clock.tick(PACE_MS);
		await flush();
		batchReply(transport, transport.sent[3], [":irc.test 219 opr g :End of /STATS report"]);
		await flush();
		expect(inv.sources.gtrace).to.not.equal("asking");

		clock.tick(PACE_MS);
		await flush();
		expect(commandOf(transport.sent[4])).to.equal("STATS S");
		batchReply(transport, transport.sent[4], [
			":irc.test 542 opr S *@203.0.113.7 1791900000 1791493200 1792000000 + :shush",
			":irc.test 219 opr S :End of /STATS report",
		]);
		clock.tick(PACE_MS);
		await flush();
		batchReply(transport, transport.sent[5], [":irc.test 219 opr Z :End of /STATS report"]);
		await flush();
		expect(inv.sources.gtrace, "a shun is listed").to.equal("off");
	});

	it("asks AuthServ about the account once known, and O3's gtrace when the server lists no bans", async function () {
		const {client, transport} = setup({opered: false});
		const inv = new Investigation(client, "user", "alice");
		inv.start();

		expect(inv.sources.stats).to.equal("off");
		expect(inv.notes.stats).to.equal("not opered");
		const [checkLine, whoisLine] = transport.sent;
		batchReply(transport, checkLine, [
			":irc.test 481 opr :Permission Denied: Insufficient privileges",
		]);
		batchReply(transport, whoisLine, [
			":irc.test 311 opr alice alice host.example.org * :Alice",
			":irc.test 330 opr alice alice :is logged in as",
			":irc.test 318 opr alice :End of /WHOIS list.",
		]);
		await flush();

		expect(inv.sources.check).to.equal("failed");
		expect(inv.notes.check).to.equal("Permission denied: you are not an IRC operator");
		const model = inv.model as UserModel;
		expect(model.user.account).to.equal("alice");
		expect(inv.noteKey).to.equal("alice");

		// The services lane: O3 whois first (queued at start), then AuthServ, then gtrace.
		clock.tick(PACE_MS);
		await flush();
		let lane = transport.sent.map(commandOf).filter((l) => l.startsWith("PRIVMSG"));
		expect(lane).to.deep.equal(["PRIVMSG O3 :whois alice"]);
		notice(transport, "O3", ["User with nick alice does not exist."]);
		await flush();
		clock.tick(PACE_MS);
		await flush();
		lane = transport.sent.map(commandOf).filter((l) => l.startsWith("PRIVMSG"));
		expect(lane[1]).to.equal("PRIVMSG AuthServ :accountinfo alice");
		notice(transport, "AuthServ", [
			"Account Information for alice",
			"-----------------------------",
			"Registered on: Sat Oct 3 20:00:00 2026",
			"Last seen: Right now!",
			"Flags: None",
			"Last quit hostmask: alice@old.example.org",
			"Hostmask(s): *@host.example.org *@old.example.org",
			"Channel(s): Owner:#alice",
			"----------End of Account Info-----------",
		]);
		await flush();
		expect((inv.model as UserModel).lastQuitHostmask).to.equal("alice@old.example.org");
		expect((inv.model as UserModel).hostmasks).to.deep.equal([
			"*@host.example.org",
			"*@old.example.org",
		]);

		clock.tick(PACE_MS);
		await flush();
		lane = transport.sent.map(commandOf).filter((l) => l.startsWith("PRIVMSG"));
		expect(lane[2]).to.equal("PRIVMSG O3 :gtrace print host superset host.example.org");
		notice(transport, "O3", [
			"The following glines were found:",
			"*@*.example.org (issued 3 days by rubin, expires 4 days): the lot",
			"-----------Found   1 Matches------------",
		]);
		await flush();
		expect((inv.model as UserModel).serviceBans).to.deep.equal([
			{
				mask: "*@*.example.org",
				issuedAgo: "3 days",
				issuedBy: "rubin",
				expiresIn: "4 days",
				reason: "the lot",
			},
		]);
		expect(inv.sources.gtrace).to.equal("done");
	});

	it("without labeled replies still asks O3's gtrace once a host is known", async function () {
		const {client, transport} = setup({labels: false});
		const inv = new Investigation(client, "user", "carol");
		inv.start();
		expect(inv.sources.stats).to.equal("off");

		clock.tick(PACE_MS);
		await flush();
		notice(transport, "O3", o3Whois("carol", "c", "c.example.net", "198.51.100.9"));
		clock.tick(PACE_MS);
		await flush();
		expect(transport.sent.map(commandOf)).to.include(
			"PRIVMSG O3 :gtrace print host superset c.example.net"
		);
		inv.stop();
	});

	it("refresh asks everything again from a blank model", async function () {
		const {client, transport} = setup({services: false});
		const inv = new Investigation(client, "user", "bob");
		inv.start();
		batchReply(transport, transport.sent[1], [
			":irc.test 311 opr bob bob h.example.org * :Bob",
			":irc.test 318 opr bob :End of /WHOIS list.",
		]);
		await flush();
		expect((inv.model as UserModel).user.realname).to.equal("Bob");

		transport.sent = [];
		inv.refresh();
		expect((inv.model as UserModel).user.realname).to.equal(undefined);
		// The connection's pacer has spent its burst on the first run: one
		// command back every PACE_MS.
		expect(transport.sent).to.deep.equal([]);
		clock.tick(PACE_MS);
		expect(transport.sent.map(commandOf)).to.deep.equal(["CHECK bob"]);
		clock.tick(PACE_MS * 2);
		expect(transport.sent.map(commandOf)).to.deep.equal([
			"CHECK bob",
			"WHOIS bob bob",
			"USERIP bob",
		]);
		inv.stop();
	});

	it("two cards on one connection share the pace", function () {
		const {client, transport} = setup({services: false, opered: false});
		const a = new Investigation(client, "user", "alice");
		const b = new Investigation(client, "user", "bob");
		a.start();
		b.start();
		expect(transport.sent.map(commandOf), "one burst for both").to.deep.equal([
			"CHECK alice",
			"WHOIS alice alice",
			"USERIP alice",
		]);
		clock.tick(PACE_MS);
		expect(commandOf(transport.sent[3])).to.equal("CHECK bob");
		a.stop();
		clock.tick(PACE_MS * 2);
		expect(
			transport.sent.map(commandOf).slice(4),
			"alice's queue dropped, bob's goes on"
		).to.deep.equal(["WHOIS bob bob", "USERIP bob"]);
		b.stop();
	});
});
