import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {useNoticeLogBackend} from "../../client/js/irc/noticelog";
import {
	addAlert,
	delAlert,
	describeFailure,
	listAlerts,
	operLevel,
	opersAmong,
	replaceAlert,
	tracePrint,
} from "../../client/js/irc/alerts";
import {X3_DEFAULTS} from "../../client/js/irc/services/x3";
import type {Transport} from "../../client/js/irc/types";
import type {TransportEvent, TransportState} from "../../client/js/irc/transport";
import type {ServicesConfig} from "../../shared/types/network";
import type {SharedMsg} from "../../shared/types/msg";

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
}

function removeSpy(): void {
	if (ownsSpy) {
		dispatch.restore();
	}

	useNoticeLogBackend(null);
	socket.removeAllListeners();
}

const X3: ServicesConfig = {package: "x3", bots: {...X3_DEFAULTS}};
const B = "\x02";
const U = "\x1f";

/** A registered, opered client on a nefarious2 server with labels and WHOX, X3 set up. */
function setup(): {client: IrcClient; transport: FakeTransport} {
	const caps = "batch labeled-response message-tags server-time";
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
		":irc.test 422 opr :MOTD File is missing"
	);
	client.setServices(X3);
	transport.sent = [];
	dispatch.resetHistory();

	return {client, transport};
}

function notice(transport: FakeTransport, bot: string, ...lines: string[]): void {
	for (const line of lines) {
		transport.line(`:${bot}!${bot}@services.test NOTICE opr :${line}`);
	}
}

function shown(): string[] {
	return dispatch
		.getCalls()
		.filter((c) => c.args[0] === "msg")
		.map((c) => (c.args[1] as {msg: SharedMsg}).msg.text ?? "");
}

/** x3-services.md §7, STATS ALERTS: `$b%-20s$b %-6s (by <owner>)` and the three detail lines. */
const STATS_ALERTS = [
	`${B}Current O3 alerts matching '${B}*${B}'${B}`,
	"--------------------------------------------",
	"Name Action (by Oper)",
	"--------------------------------------------",
	`${B}seance-bots         ${B} NOTICE (by rubin)`,
	` ${U}Expires:${U}: 2026-10-18 21:00:00 +0000`,
	` ${U}Criteria${U}: authed no info irc?client ident r???? reason bot group in #seance, see rubin`,
	` ${U}Triggered${U}: Never`,
	`${B}clones               ${B} GLINE  (by O3)`,
	` ${U}Criteria${U}: clones 5 abuse trusted`,
	` ${U}Triggered${U}: 2d, 3h`,
	"----------------End of Alerts-----------------",
];

/** §7 TRACE PRINT: `%-15s\002 \002%10s\002@\002%s (%s)`, no ` (acct)` when not authed. */
const TRACE_PRINT = [
	"The following users were found:",
	"---------------------------------------------",
	"Nick User@Host (Account)",
	"---------------------------------------------",
	`spamfan2       ${B} ${B}     r8821${B}@${B}203-0-113-7.example.net`,
	`spamfan3       ${B} ${B}     r1002${B}@${B}203-0-113-8.example.net (spammy)`,
	`opr            ${B} ${B}       opr${B}@${B}oper.example.net (rubin)`,
	"------------ Found    3 matches -----------",
];

describe("the alert builder's wire side (irc/alerts.ts, services/x3/alerts.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("lists the oper's alerts from STATS ALERTS, quietly", async function () {
		const {client, transport} = setup();
		const list = listAlerts(client);

		expect(transport.sent).to.deep.equal(["@label=svc1 PRIVMSG O3 :stats alerts"]);
		notice(transport, "O3", ...STATS_ALERTS);
		const result = await list;

		expect(result.kind).to.equal("reply");
		expect(result.kind === "reply" && result.value).to.deep.equal([
			{
				name: "seance-bots",
				reaction: "notice",
				owner: "rubin",
				expires: "2026-10-18 21:00:00 +0000",
				criteria:
					"authed no info irc?client ident r???? reason bot group in #seance, see rubin",
				triggered: "Never",
			},
			{
				name: "clones",
				reaction: "gline",
				owner: "O3",
				criteria: "clones 5 abuse trusted",
				triggered: "2d, 3h",
			},
		]);
		// Every line was consumed: none in a window, no query for O3.
		expect(shown()).to.deep.equal([]);
		expect(client.channels.map((c) => c.name)).to.deep.equal(["irc.test", "#seance"]);

		// The bot not online: the server's 401.
		const missing = listAlerts(client);
		transport.line(":irc.test 401 opr O3 :No such nick");
		expect(await missing).to.deep.equal({kind: "missing"});
		expect(describeFailure(client, {kind: "missing"})).to.equal(
			"O3 is not online (no such nick)."
		);

		// No package: nothing to ask.
		client.setServices(undefined);
		expect(await listAlerts(client)).to.deep.equal({kind: "unavailable"});
	});

	it("reads who matches from TRACE PRINT, the empty answer, and a criteria complaint", async function () {
		const {client, transport} = setup();
		const trace = tracePrint(client, "authed no ident r????");

		expect(transport.sent).to.deep.equal([
			"@label=svc1 PRIVMSG O3 :trace print authed no ident r????",
		]);
		notice(transport, "O3", ...TRACE_PRINT);
		const result = await trace;
		expect(result.kind === "reply" && result.value).to.deep.equal({
			count: 3,
			users: [
				{nick: "spamfan2", ident: "r8821", host: "203-0-113-7.example.net"},
				{
					nick: "spamfan3",
					ident: "r1002",
					host: "203-0-113-8.example.net",
					account: "spammy",
				},
				{nick: "opr", ident: "opr", host: "oper.example.net", account: "rubin"},
			],
		});
		expect(shown()).to.deep.equal([]);

		const none = tracePrint(client, "ident zzz");
		notice(transport, "O3", "Nothing matched the criteria of your search.");
		expect((await none).kind === "reply" && (await none)).to.deep.include({
			value: {count: 0, users: []},
		});

		const bad = tracePrint(client, "frobnicate yes");
		notice(transport, "O3", `${B}frobnicate${B} is an invalid search criteria.`);
		const complaint = await bad;
		expect(complaint.kind === "reply" && complaint.value).to.deep.equal({
			count: 0,
			users: [],
			error: "frobnicate is an invalid search criteria.",
		});
	});

	it("finds the opers among the matched nicks with one WHOX", async function () {
		const {client, transport} = setup();
		const who = opersAmong(client, ["spamfan2", "spamfan3", "opr"]);
		const line = transport.sent[0];
		const label = /^@label=(\S+) /.exec(line)?.[1];
		const token = line.split(",").pop();

		expect(line).to.equal(`@label=${label} WHO spamfan2,spamfan3,opr %nf,${token}`);
		transport.lines(
			`@label=${label} :irc.test BATCH +w labeled-response`,
			`@batch=w :irc.test 354 opr ${token} spamfan2 H`,
			`@batch=w :irc.test 354 opr ${token} spamfan3 H`,
			`@batch=w :irc.test 354 opr ${token} opr H*`,
			`@batch=w :irc.test 315 opr spamfan2,spamfan3,opr :End of /WHO list.`,
			":irc.test BATCH -w"
		);
		expect(await who).to.deep.equal(["opr"]);
		expect(await opersAmong(client, [])).to.deep.equal([]);
	});

	it("adds an alert and reports O3's verdict in its words, the two-line failures too", async function () {
		const {client, transport} = setup();
		const command =
			"addalert seance-bots notice expire 1w authed no ident r???? reason see opr";
		const add = addAlert(client, command);

		expect(transport.sent).to.deep.equal([`@label=svc1 PRIVMSG O3 :${command}`]);
		notice(transport, "O3", `Added alert named ${B}seance-bots${B}.`);
		expect(await add).to.deep.equal({
			kind: "reply",
			value: {ok: true, text: "Added alert named seance-bots."},
			lines: ["Added alert named seance-bots."],
		});

		const dup = addAlert(client, command);
		notice(
			transport,
			"O3",
			`An alert named ${B}seance-bots${B} already exists.`,
			"Unable to add alert.  Check syntax, required parts, and access"
		);
		expect((await dup).kind === "reply" && (await dup)).to.deep.include({
			value: {
				ok: false,
				text: "An alert named seance-bots already exists. Unable to add alert.  Check syntax, required parts, and access",
			},
		});

		const bad = addAlert(client, "addalert x notice frob yes");
		notice(
			transport,
			"O3",
			`${B}frob${B} is an invalid search criteria.`,
			"Unable to add alert.  Check syntax, required parts, and access"
		);
		const complaint = await bad;
		expect(complaint.kind === "reply" && complaint.value?.ok).to.equal(false);
		expect(complaint.kind === "reply" && complaint.value?.text).to.match(
			/^frob is an invalid search criteria\. Unable to add alert\./
		);

		const unknown = addAlert(client, "addalert x frob");
		notice(transport, "O3", `Unknown alert reaction ${B}frob${B}.`);
		expect((await unknown).kind === "reply" && (await unknown)).to.deep.include({
			value: {ok: false, text: "Unknown alert reaction frob."},
		});

		// Nothing of that reached a window.
		expect(shown()).to.deep.equal([]);
	});

	it("removes an alert, and replaces one as delete then add", async function () {
		const {client, transport} = setup();
		const del = delAlert(client, "seance-bots");

		expect(transport.sent).to.deep.equal(["@label=svc1 PRIVMSG O3 :delalert seance-bots"]);
		notice(transport, "O3", `Removed alert named ${B}seance-bots${B}.`);
		expect((await del).kind === "reply" && (await del)).to.deep.include({
			value: {ok: true, text: "Removed alert named seance-bots."},
		});

		const gone = delAlert(client, "nope");
		notice(transport, "O3", `No alert named ${B}nope${B} could be found.`);
		expect((await gone).kind === "reply" && (await gone)).to.deep.include({
			value: {ok: false, text: "No alert named nope could be found."},
		});

		transport.sent = [];
		const replaced = replaceAlert(
			client,
			"seance-bots",
			"addalert seance-bots gline ident r????"
		);
		await Promise.resolve();
		expect(transport.sent).to.deep.equal(["@label=svc3 PRIVMSG O3 :delalert seance-bots"]);
		notice(transport, "O3", `Removed alert named ${B}seance-bots${B}.`);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(transport.sent[1]).to.equal(
			"@label=svc4 PRIVMSG O3 :addalert seance-bots gline ident r????"
		);
		notice(transport, "O3", `Added alert named ${B}seance-bots${B}.`);
		const both = await replaced;
		expect(both.deleted.kind === "reply" && both.deleted.value?.ok).to.equal(true);
		expect(both.added?.kind === "reply" && both.added.value?.ok).to.equal(true);

		// The bot gone: the delete fails and the add is not tried.
		const half = replaceAlert(client, "x", "addalert x notice ident a");
		transport.line(":irc.test 401 opr O3 :No such nick");
		expect(await half).to.deep.equal({deleted: {kind: "missing"}});
	});

	it("asks AuthServ for the oper's own level once, when logged in", async function () {
		const {client, transport} = setup();

		expect(await operLevel(client)).to.equal(undefined);
		expect(transport.sent).to.deep.equal([]);

		transport.line(":irc.test 900 opr opr!opr@host rubin :You are now logged in as rubin");
		const level = operLevel(client);
		expect(transport.sent).to.deep.equal(["@label=svc1 PRIVMSG AuthServ :accountinfo rubin"]);
		notice(
			transport,
			"AuthServ",
			`${B}Account Information for rubin${B}`,
			"--------------------------------------",
			"Registered on: Sat Oct 10 21:00:00 2026",
			"Flags: +o",
			"Opserv level: 900 ",
			"Last quit hostmask: opr@host",
			"Hostmask(s): *@host",
			"----------End of Account Info-----------"
		);
		expect(await level).to.equal(900);
		expect(await operLevel(client)).to.equal(900);
		expect(transport.sent).to.have.length(1);
	});
});
