import {expect} from "chai";
import sinon from "ts-sinon";
import socket from "../../client/js/socket";
import {IrcClient} from "../../client/js/irc/client";
import {IdAllocator} from "../../client/js/irc/ids";
import {useNoticeLogBackend, type LoggedNotice} from "../../client/js/irc/noticelog";
import {
	awaitServiceReply,
	checkServices,
	collectServiceReply,
	describeServiceCheck,
	SERVICE_REPLY_TIMEOUT_MS,
	servicesBan,
} from "../../client/js/irc/services";
import {sendQuiet, takeQuietLabel} from "../../client/js/irc/quiet";
import {snoopNicks} from "../../client/js/irc/servicesfeed";
import {parseBanReply, X3_DEFAULTS} from "../../client/js/irc/services/x3";
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

function messages(chanId: number): SharedMsg[] {
	return dispatch
		.getCalls()
		.filter((call) => call.args[0] === "msg")
		.map((call) => call.args[1] as {chan: number; msg: SharedMsg})
		.filter((p) => p.chan === chanId)
		.map((p) => p.msg);
}

const X3: ServicesConfig = {package: "x3", bots: {...X3_DEFAULTS}};

/** A registered client on a nefarious2 server, in #seance, with labeled-response. */
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
		":irc.test 005 opr CHANTYPES=#& PREFIX=(ov)@+ CHANMODES=b,k,Ll,imnpst CASEMAPPING=rfc1459 :are supported by this server",
		":irc.test 422 opr :MOTD File is missing",
		":opr!opr@host JOIN #seance",
		":irc.test 353 opr = #seance :@opr bob",
		":irc.test 366 opr #seance :End of /NAMES list."
	);
	transport.sent = [];
	dispatch.resetHistory();

	return {client, transport};
}

/** Join `name` on the fake server (the autojoin placeholders are not joined). */
function join(client: IrcClient, transport: FakeTransport, name: string): number {
	transport.lines(
		`:opr!opr@host JOIN ${name}`,
		`:irc.test 353 opr = ${name} :@opr O3 alice`,
		`:irc.test 366 opr ${name} :End of /NAMES list.`
	);
	transport.sent = [];
	dispatch.resetHistory();
	return client.findChannel(name)!.id;
}

/** The label the last line we sent carries (`@label=r1 …` → `r1`). */
function labelOf(line: string): string {
	const m = /^@label=(\S+) /.exec(line);
	return m ? m[1] : "";
}

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
	}
}

const B = "\x02";

describe("services support: the liveness check (irc/services.ts checkServices)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("WHOISes each bot and reads online and the X3 look from the replies", async function () {
		const {client, transport} = setup();
		const check = checkServices(client, X3);

		expect(transport.sent.map((l) => l.replace(/^@label=\S+ /, ""))).to.deep.equal([
			"WHOIS O3",
			"WHOIS AuthServ",
			"WHOIS ChanServ",
		]);
		const [o3, authserv, chanserv] = transport.sent.map(labelOf);

		// O3: the usual realname. AuthServ: its own realname, but the
		// server calls it a service (310). ChanServ: no such nick.
		transport.lines(
			`@label=${o3} :irc.test BATCH +A labeled-response`,
			"@batch=A :irc.test 311 opr O3 O3 services.test * :Oper Services",
			"@batch=A :irc.test 318 opr O3 :End of /WHOIS list.",
			":irc.test BATCH -A",
			`@label=${authserv} :irc.test BATCH +B labeled-response`,
			"@batch=B :irc.test 311 opr AuthServ AuthServ services.test * :AfterNET accounts",
			"@batch=B :irc.test 310 opr AuthServ :is a Network Service",
			"@batch=B :irc.test 318 opr AuthServ :End of /WHOIS list.",
			":irc.test BATCH -B",
			`@label=${chanserv} :irc.test 401 opr ChanServ :No such nick`
		);

		const result = await check;
		expect(result.failure).to.equal(undefined);
		expect(result.results).to.deep.equal([
			{role: "oper", bot: "O3", online: true, looksLikeX3: true},
			{role: "account", bot: "AuthServ", online: true, looksLikeX3: true},
			{role: "channel", bot: "ChanServ", online: false, looksLikeX3: false},
		]);
		expect(describeServiceCheck(result)).to.equal(
			"ChanServ isn't online (no such nick). O3 and AuthServ are online and look like X3."
		);
		expect(messages(client.lobby.id), "the WHOIS replies are not shown").to.have.length(0);
	});

	it("skips blank roles and says so when none is named", async function () {
		const {client, transport} = setup();
		const check = checkServices(client, {
			package: "x3",
			bots: {...X3_DEFAULTS, account: "", channel: " "},
		});
		expect(transport.sent).to.have.length(1);
		const label = labelOf(transport.sent[0]);
		transport.lines(
			`@label=${label} :irc.test 311 opr O3 O3 services.test * :Something else`,
			`@label=${label} :irc.test 318 opr O3 :End of /WHOIS list.`
		);
		const result = await check;
		expect(result.results).to.deep.equal([
			{role: "oper", bot: "O3", online: true, looksLikeX3: false},
		]);
		expect(describeServiceCheck(result)).to.equal("✓ O3 is online. O3 doesn't look like X3.");

		const none = await checkServices(client, {
			package: "x3",
			bots: {oper: "", account: "", channel: "", report: "#x", snoop: ""},
		});
		expect(none.results).to.deep.equal([]);
		expect(describeServiceCheck(none)).to.equal("No bots to check: name at least one.");
	});

	it("reports the network being down rather than three absent bots", async function () {
		const {client, transport} = setup();
		transport.close();
		const result = await checkServices(client, X3);
		expect(result.failure).to.equal("closed");
		expect(describeServiceCheck(result)).to.equal(
			"Couldn't check: the network is not connected."
		);
	});

	it("words the all-online case with a tick", function () {
		const all = {
			results: [
				{role: "oper" as const, bot: "O3", online: true, looksLikeX3: true},
				{role: "account" as const, bot: "AuthServ", online: true, looksLikeX3: true},
				{role: "channel" as const, bot: "ChanServ", online: true, looksLikeX3: true},
			],
		};
		expect(describeServiceCheck(all)).to.equal(
			"✓ O3, AuthServ and ChanServ are online and look like X3."
		);
		expect(
			describeServiceCheck({results: all.results.map((r) => ({...r, online: false}))})
		).to.equal("O3, AuthServ and ChanServ aren't online (no such nick).");
		expect(describeServiceCheck({results: [], failure: "timeout"})).to.equal(
			"Couldn't check: the server did not answer."
		);
	});
});

describe("services support: a bot's reply (irc/services.ts awaitServiceReply)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("resolves on the matching NOTICE from that bot, and only that bot, still showing it", async function () {
		const {client, transport} = setup();
		const reply = awaitServiceReply(client, "O3", (text) => parseBanReply(text));

		transport.lines(
			":alice!a@h NOTICE opr :G-line issued for *@1.2.3.4.",
			":O3!O3@services.test NOTICE opr :O3 is a privileged service.",
			":O3!O3@services.test PRIVMSG opr :G-line issued for *@1.2.3.4.",
			`:o3!O3@services.test NOTICE opr :G-line issued for ${B}*@1.2.3.4${B}.`
		);

		const answer = await reply;
		expect(answer).to.deep.equal({
			kind: "reply",
			value: {ok: true, mask: "*@1.2.3.4", text: "G-line issued for *@1.2.3.4."},
		});

		// The reply opened no window by itself, and O3's words were shown.
		const shown = dispatch
			.getCalls()
			.filter((c) => c.args[0] === "msg")
			.map((c) => (c.args[1] as {msg: SharedMsg}).msg.text);
		expect(shown).to.include("G-line issued for \x02*@1.2.3.4\x02.");
	});

	it("gives up after the timeout, and at once when the socket closes", async function () {
		const clock = sinon.useFakeTimers();

		try {
			const {client, transport} = setup();
			const slow = awaitServiceReply(client, "O3", (text) => parseBanReply(text));
			clock.tick(SERVICE_REPLY_TIMEOUT_MS + 1);
			expect(await slow).to.deep.equal({kind: "timeout"});

			const cut = awaitServiceReply(client, "O3", (text) => parseBanReply(text));
			transport.close();
			expect(await cut).to.deep.equal({kind: "closed"});

			// Down: nothing to wait for.
			expect(await awaitServiceReply(client, "O3", () => true)).to.deep.equal({
				kind: "closed",
			});
		} finally {
			clock.restore();
		}
	});

	it("servicesBan sends the PRIVMSG to the oper service and resolves on its verdict", async function () {
		const {client, transport} = setup();
		client.setServices(X3);
		const ban = servicesBan(client, {
			type: "gline",
			mask: "*@1.2.3.4",
			seconds: 3600,
			reason: "spamming",
		});
		// Quiet (quiet.ts): labeled, so the PRIVMSG's echo opens no window.
		expect(transport.sent).to.deep.equal([
			"@label=svc1 PRIVMSG O3 :gline *@1.2.3.4 1h spamming",
		]);
		transport.line(":O3!O3@services.test NOTICE opr :Invalid G-line '*@1.2.3.4'.");
		expect(await ban).to.deep.equal({
			outcome: "refused",
			text: "Invalid G-line '*@1.2.3.4'.",
		});

		const ok = servicesBan(client, {type: "shun", mask: "*@h", seconds: 60, reason: "r"});
		transport.line(":O3!O3@services.test NOTICE opr :Shun issued for *@h.");
		expect(await ok).to.deep.equal({outcome: "ok", text: "Shun issued for *@h."});

		// The bot is not on the network: the server's 401 says so at once.
		const gone = servicesBan(client, {type: "gline", mask: "*@h", seconds: 60, reason: "r"});
		transport.line(":irc.test 401 opr O3 :No such nick");
		expect(await gone).to.deep.equal({
			outcome: "refused",
			text: "O3 is not online (no such nick).",
		});

		client.setServices(undefined);
		expect(
			await servicesBan(client, {type: "shun", mask: "x", seconds: 1, reason: "r"})
		).to.deep.equal({outcome: "closed", text: "No oper service is set up for this network."});
		expect(transport.sent).to.have.length(3);
	});
});

describe("services support: quiet lookups (irc/quiet.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	it("drops the echo of a labeled lookup: no msg, no query window for the bot", async function () {
		const {client, transport} = setup();
		const windows = () => client.channels.map((c) => c.name);

		expect(sendQuiet(client, "PRIVMSG O3 :whois alice")).to.equal(true);
		expect(transport.sent).to.deep.equal(["@label=svc1 PRIVMSG O3 :whois alice"]);

		// The echo, labeled as nefarious2 relays it; also an ACK and a batch.
		transport.line("@label=svc1 :opr!opr@host PRIVMSG O3 :whois alice");
		sendQuiet(client, "PRIVMSG O3 :whois bob");
		transport.line("@label=svc2 ACK");
		sendQuiet(client, "PRIVMSG O3 :whois carol");
		transport.lines(
			"@label=svc3 :irc.test BATCH +q labeled-response",
			"@batch=q :opr!opr@host PRIVMSG O3 :whois carol",
			":irc.test BATCH -q"
		);
		await flush();

		expect(
			dispatch
				.getCalls()
				.filter((c) => c.args[0] === "msg")
				.map((c) => JSON.stringify(c.args[1]))
		).to.deep.equal([]);
		expect(windows()).to.deep.equal(["irc.test", "#seance"]);

		// An unlabeled self message is still what it always was: a /msg.
		transport.line(":opr!opr@host PRIVMSG O3 :hello");
		expect(windows()).to.deep.equal(["irc.test", "#seance", "O3"]);

		// A label the server never echoes (a 401 instead) is forgotten and the
		// numeric is shown: the oper should know the bot is not there.
		sendQuiet(client, "PRIVMSG Nobody :whois x");
		transport.line("@label=svc4 :irc.test 401 opr Nobody :No such nick");
		expect(
			dispatch
				.getCalls()
				.filter((c) => c.args[0] === "msg")
				.map((c) => (c.args[1] as {msg: SharedMsg}).msg.type)
		).to.include("error");
		expect(takeQuietLabel(client, "svc4")).to.equal(false);

		// Without labeled-response the line goes out plain (and its echo shows).
		const plain = new FakeTransport();
		const other = new IrcClient({
			host: "irc.test",
			port: 8443,
			tls: true,
			nick: "opr",
			join: "",
			sasl: "",
			saslAccount: "",
			saslPassword: "",
			ids: new IdAllocator(),
			transportFactory: () => plain,
			highlights: () => ({keywords: [], exceptions: []}),
		});
		other.connect();
		plain.open();
		plain.lines(
			":irc.test CAP * LS :batch",
			":irc.test CAP opr ACK :batch",
			":irc.test 001 opr :hi"
		);
		plain.sent = [];
		sendQuiet(other, "PRIVMSG O3 :whois alice");
		expect(plain.sent).to.deep.equal(["PRIVMSG O3 :whois alice"]);
	});

	it("shows no NOTICE a collector consumed, and still shows one nobody waits for", async function () {
		const {client, transport} = setup();
		const shown = () =>
			dispatch
				.getCalls()
				.filter((c) => c.args[0] === "msg")
				.map((c) => (c.args[1] as {msg: SharedMsg}).msg.text);

		const reply = collectServiceReply(client, "O3", {
			accept: (text) =>
				/^Nick\s*:/.test(text) ? "start" : /^Server\s*:/.test(text) ? "end" : "take",
		});
		transport.lines(
			":O3!O3@services.test NOTICE opr :Nick         : alice",
			":O3!O3@services.test NOTICE opr :Host         : a@h",
			":O3!O3@services.test NOTICE opr :Server       : leaf1"
		);
		const answer = await reply;
		expect(answer.kind).to.equal("reply");
		expect(shown()).to.deep.equal([]);
		expect(client.channels.map((c) => c.name)).to.deep.equal(["irc.test", "#seance"]);

		// Nobody is waiting now: the bot's next notice is shown as any notice is.
		transport.line(":O3!O3@services.test NOTICE opr :Something unasked for.");
		expect(shown()).to.deep.equal(["Something unasked for."]);

		// A quiet awaitServiceReply consumes the line it accepts and no other.
		const one = awaitServiceReply(
			client,
			"O3",
			(text) => (/^Added/.test(text) ? text : undefined),
			{
				quiet: true,
			}
		);
		transport.lines(
			":O3!O3@services.test NOTICE opr :Not the answer.",
			":O3!O3@services.test NOTICE opr :Added alert named x."
		);
		expect(await one).to.deep.equal({kind: "reply", value: "Added alert named x."});
		expect(shown()).to.deep.equal(["Something unasked for.", "Not the answer."]);
	});
});

describe("services support: the feed (irc/servicesfeed.ts)", function () {
	beforeEach(installSpy);
	afterEach(removeSpy);

	function logged(client: IrcClient): LoggedNotice[] {
		return client.noticeLog.all();
	}

	it("keeps a snoop line from the oper bot in the snoop channel, and shows it unchanged", async function () {
		const {client, transport} = setup();
		client.setServices(X3);
		const snoopy = join(client, transport, "#MrSnoopy");

		const raw = `[21:14:03] ${B}JOIN${B} #seance by alice`;
		// A minute ago: the log keeps a day (noticelog.ts MAX_AGE_MS), so a
		// fixed date here fails from the day after it.
		const sent = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000).toISOString();
		transport.line(`@time=${sent} :O3!O3@services.test PRIVMSG #MrSnoopy :${raw}`);
		await flush();

		const shown = messages(snoopy);
		expect(shown).to.have.length(1);
		expect(shown[0].text, "the channel message is as sent").to.equal(raw);
		expect(shown[0].from?.nick).to.equal("O3");

		expect(logged(client)).to.deep.equal([
			{
				time: Date.parse(sent),
				type: "snoop",
				text: "[21:14:03] JOIN #seance by alice",
				snotice: {
					kind: "x3.snoop.join",
					category: "SERVICES",
					fields: {channel: "#seance", nick: "alice"},
					route: "network",
				},
			},
		]);
		expect(messages(client.lobby.id), "nothing routed to the lobby").to.have.length(0);
	});

	it("keeps an audit line and a module log line in the report channel, from any of the bots", async function () {
		const {client, transport} = setup();
		client.setServices(X3);
		join(client, transport, "#operserv");

		transport.lines(
			":O3!O3@services.test PRIVMSG #operserv :() [Rubin!~r@h:rubin]: gline *@1.2.3.4 1h spamming",
			":ChanServ!ChanServ@services.test PRIVMSG #operserv :(#foo) [n!i@h:acct]: clearbans",
			":O3!O3@services.test PRIVMSG #operserv :OpServ info: Found alice in bad-word channel #x"
		);
		await flush();

		const entries = logged(client);
		expect(entries.map((e) => [e.type, e.snotice.kind, e.from])).to.deep.equal([
			["audit", "x3.audit.glines", "Rubin"],
			["audit", "x3.audit.modes", "n"],
			["audit", "x3.log.info", undefined],
		]);
		expect(entries[0].snotice.fields).to.deep.equal({
			nick: "Rubin",
			ident: "~r",
			host: "h",
			command: "gline",
			args: "*@1.2.3.4 1h spamming",
			account: "rubin",
		});
		expect(entries[1].snotice.fields.channel).to.equal("#foo");
		expect(entries[2].snotice.fields).to.deep.equal({
			facility: "OpServ",
			severity: "info",
			message: "Found alice in bad-word channel #x",
		});
	});

	it("ignores chat, other channels, other senders, replays and a network without services", async function () {
		const {client, transport} = setup();
		client.setServices(X3);
		const snoopy = join(client, transport, "#mrsnoopy");

		transport.lines(
			// a user, even in the right shape
			`:alice!a@h PRIVMSG #mrsnoopy :[21:14:03] ${B}JOIN${B} #seance by alice`,
			// the bot, chatting
			":O3!O3@services.test PRIVMSG #mrsnoopy :hello opers",
			// the bot, in another channel
			`:O3!O3@services.test PRIVMSG #seance :[21:14:03] ${B}JOIN${B} #seance by alice`,
			// a NOTICE, not a PRIVMSG
			`:O3!O3@services.test NOTICE #mrsnoopy :[21:14:03] ${B}JOIN${B} #seance by alice`,
			// an audit line in the snoop channel (not the report channel)
			":O3!O3@services.test PRIVMSG #mrsnoopy :() [Rubin!~r@h:rubin]: gline *@1.2.3.4 1h x"
		);
		await flush();
		expect(logged(client)).to.deep.equal([]);
		expect(messages(snoopy).length).to.be.greaterThan(2);

		client.setServices(undefined);
		transport.line(
			`:O3!O3@services.test PRIVMSG #mrsnoopy :[21:14:03] ${B}JOIN${B} #seance by alice`
		);
		await flush();
		expect(logged(client)).to.deep.equal([]);
	});

	it("renders the nicks a snoop line names as nicks, in the channel or not, and never as a highlight", async function () {
		const {client, transport} = setup();
		client.setServices(X3);
		const snoopy = join(client, transport, "#mrsnoopy"); // opr, O3 and alice are in it
		const o3 = (text: string) => `:O3!O3@services.test PRIVMSG #mrsnoopy :${text}`;

		transport.lines(
			o3(
				`[17:07:07] ${B}UMODE${B} clonebot7 +xzCc AN-1A2B3C4D.example.net ABCDEF.123456.7890AB.CDEF01.IP`
			),
			o3(
				`[17:07:07] ${B}NICK${B} clonebot7 probe@host12.example.net () [192.0.2.10] on Hub.Example.Org`
			),
			o3(`[21:14:02] ${B}NICK${B} change alice -> alice_away`),
			o3(`[21:14:03] ${B}JOIN${B} #example by clonebot7`),
			o3(`[21:14:06] ${B}KICK${B} troll from #seance by bob`),
			o3(`[21:14:06] ${B}KICK${B} troll from #seance by irc.afternet.org`),
			o3(
				`[21:14:08] ${B}KILL${B} troll (~t@203.0.113.7, on irc.afternet.org) by O3 (Excessive connections from a single host.)`
			),
			o3(`[21:14:10] ${B}AUTH${B} carol as carol`),
			o3(`[21:14:12] ${B}OPER${B} rubin!~r@h.example [203.0.113.5] on irc.afternet.org`),
			o3(`[21:14:13] ${B}MODE${B} #seance +o-v alice bob by ChanServ`),
			o3(`[21:14:14] ${B}MODE${B} #seance +m by irc.afternet.org`),
			// Our own connect, as the feed reports it: not a word to us; nor is
			// a line that names nobody clickable and has our nick in it.
			o3(`[21:14:07] ${B}NICK${B} opr ~o@host.example () [203.0.113.10] on irc.afternet.org`),
			o3(`[21:14:15] ${B}MODE${B} #seance +b opr!*@* by irc.afternet.org`),
			// The bot chatting, naming us: a highlight as any message is.
			o3("opr: look at this")
		);
		await flush();

		const shown = messages(snoopy);
		expect(shown.map((m) => [...m.users].sort())).to.deep.equal([
			["clonebot7"],
			["clonebot7"],
			["alice", "alice_away"],
			["clonebot7"],
			["bob", "troll"],
			["troll"],
			["O3", "troll"],
			["carol"],
			["rubin"],
			["ChanServ", "alice"],
			[],
			["opr"],
			["opr"],
			["opr"],
		]);
		expect(shown.map((m) => m.highlight)).to.deep.equal([
			...Array<boolean>(13).fill(false),
			true,
		]);

		// The nicks it adds are a rendering matter: the channel's unread is
		// what any message in it brings, and no highlight is counted.
		const counts = dispatch
			.getCalls()
			.filter((call) => call.args[0] === "msg")
			.map((call) => call.args[1] as {chan: number; unread: number; highlight: number})
			.filter((p) => p.chan === snoopy)
			.map((p) => [p.unread, p.highlight]);
		expect(counts.map((c) => c[0])).to.deep.equal(Array.from({length: 14}, (_, i) => i + 1));
		expect(counts.map((c) => c[1])).to.deep.equal([...Array<number>(13).fill(0), 1]);
		expect(logged(client).map((e) => e.snotice.kind)).to.have.length(13);
	});

	it("marks the nicks of a replayed snoop line too, without growing the notice log", async function () {
		// A chathistory page after a reload, or a reconnect's catch-up: the
		// log already has those lines, the scrollback still needs its nicks.
		const {client, transport} = setup();
		client.setServices(X3);
		const snoopy = join(client, transport, "#mrsnoopy");

		transport.lines(
			":irc.test BATCH +hist1 chathistory #mrsnoopy",
			`@batch=hist1;time=2026-10-10T21:14:07.000Z;msgid=m1 :O3!O3@services.test PRIVMSG #mrsnoopy :[21:14:07] ${B}NICK${B} clonebot7 probe@host12.example.net () [192.0.2.10] on Hub.Example.Org`,
			`@batch=hist1;time=2026-10-10T21:14:08.000Z;msgid=m2 :O3!O3@services.test PRIVMSG #mrsnoopy :[21:14:08] ${B}NICK${B} opr ~o@host.example () [203.0.113.10] on irc.afternet.org`,
			":irc.test BATCH -hist1"
		);
		await flush();

		// A replay lands as one `more` page, not as live `msg` events.
		const pages = dispatch
			.getCalls()
			.filter((call) => call.args[0] === "more")
			.map((call) => call.args[1] as {chan: number; messages: SharedMsg[]})
			.filter((p) => p.chan === snoopy);
		expect(pages).to.have.length(1);
		const shown = pages[0].messages;
		expect(shown.map((m) => m.users)).to.deep.equal([["clonebot7"], ["opr"]]);
		expect(shown.map((m) => m.highlight)).to.deep.equal([false, false]);
		expect(messages(snoopy), "no live msg for a replayed line").to.deep.equal([]);
		expect(logged(client), "nothing appended from a replay").to.deep.equal([]);
	});

	it("snoopNicks: every nick a line names, once each, never a server, nothing for other entries", function () {
		const entry = (kind: string, fields: Record<string, string>): LoggedNotice => ({
			time: 0,
			type: "snoop",
			text: "",
			snotice: {kind, category: "SERVICES", fields, route: "network"},
		});
		expect(snoopNicks(undefined)).to.deep.equal([]);
		expect(snoopNicks({...entry("x3.audit.glines", {nick: "a"}), type: "audit"})).to.deep.equal(
			[]
		);
		expect(snoopNicks(entry("x3.snoop.nick", {nick: "a", newNick: "b"}))).to.deep.equal([
			"a",
			"b",
		]);
		expect(
			snoopNicks(entry("x3.snoop.kick", {nick: "a", channel: "#c", kicker: "a"}))
		).to.deep.equal(["a"]);
		expect(
			snoopNicks(entry("x3.snoop.kill", {nick: "a", killer: "irc.example.org"}))
		).to.deep.equal(["a"]);
		expect(snoopNicks(entry("x3.snoop.mode", {channel: "#c", setter: ""}))).to.deep.equal([]);
	});

	it("takes the report channel's lines from a channel that is both, snoop first", async function () {
		const {client, transport} = setup();
		client.setServices({package: "x3", bots: {...X3_DEFAULTS, report: "#mrsnoopy"}});
		join(client, transport, "#mrsnoopy");

		transport.lines(
			`:O3!O3@services.test PRIVMSG #mrsnoopy :[21:14:12] ${B}OPER${B} rubin!~r@h.example [203.0.113.5] on irc.afternet.org`,
			":O3!O3@services.test PRIVMSG #mrsnoopy :() [Rubin!~r@h:rubin]: god on"
		);
		await flush();
		expect(logged(client).map((e) => e.snotice.kind)).to.deep.equal([
			"x3.snoop.oper",
			"x3.audit.opers",
		]);
	});
});
