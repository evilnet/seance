import {expect} from "chai";
import {checkReport} from "../../../client/js/irc/profiles/nefarious/check";
import {IrcMessage, parseLine} from "../../../client/js/irc/message";
import type {OperReport, ReportEntry, ReportSection, ReportValue} from "../../../shared/types/oper";

/** `:irc.seance.test <code> <me> :<text>` for each [code, text] pair. */
function reply(me: string, rows: [string, string][]): IrcMessage[] {
	return rows.map(([code, text]) => {
		const msg = parseLine(`:irc.seance.test ${code} ${me} :${text}`);

		if (!msg) {
			throw new Error(`unparsable: ${code} ${text}`);
		}

		return msg;
	});
}

function section(report: OperReport, title: string): ReportSection {
	const found = report.sections.find((s) => s.title === title);

	if (!found) {
		throw new Error(`no section ${title} in ${report.sections.map((s) => s.title).join(", ")}`);
	}

	return found;
}

function entry(report: OperReport, title: string, label: string): ReportEntry["value"] {
	const found = section(report, title).entries?.find((e) => e.label === label);

	if (!found) {
		throw new Error(`no entry ${label} in section ${title}`);
	}

	return found.value;
}

function single(value: ReportEntry["value"]): ReportValue {
	if (Array.isArray(value)) {
		throw new Error("expected a single value");
	}

	return value;
}

const O = "\x0f";

// Live, 2026-10-09, dev rig (`CHECK opr`, an oper checking itself).
const CHECK_OPR = reply("opr", [
	["290", " "],
	["286", "Information for user opr"],
	["290", " "],
	["290", "           Nick:: opr (ABAAA)"],
	["290", "      Signed on:: Fri Oct  9 16:45:37 2026"],
	["290", "      Timestamp:: Fri Oct  9 16:45:37 2026 (1791564337)"],
	["290", "  User/Hostmask:: opr@172.17.0.1"],
	["290", " Real User/Host:: opr@172.17.0.1 (172.17.0.1)"],
	["290", `      Real Name:: Real Name of opr${O}`],
	["290", "         Status:: IRC Operator"],
	["290", "         Opered:: Local O:Line as seanceop"],
	["290", "          Class:: Opers"],
	[
		"290",
		"     Privileges:: CHAN_LIMIT SHOW_INVIS SHOW_ALL_INVIS KILL LOCAL_KILL REHASH RESTART ",
	],
	[
		"290",
		"     Privileges:: DIE JUPE LOCAL_JUPE OPMODE WHOX SEE_CHAN PROPAGATE DISPLAY SEE_OPERS ",
	],
	["290", "     Privileges:: WIDE_GLINE LIST_CHAN FORCE_OPMODE CHECK WIDE_SHUN REMOTEREHASH "],
	["290", "     Privileges:: WIDE_ZLINE TEMPSHUN GITSYNC "],
	["290", "   Capabilities:: account-tag batch extended-join labeled-response message-tags "],
	["290", "   Capabilities:: server-time "],
	["290", "   Connected to:: irc.seance.test"],
	["290", "     Session ID:: AaEhjlCmcAGhWVFeRQHNFQ"],
	["290", "       Umode(s):: +owgx"],
	["290", "     Channel(s):: @#seance "],
	["290", " "],
	["290", "          Ports:: 50470 -> 6667 (client -> server)"],
	["290", "      Data sent:: 0.261 Kb (12 protocol messages)"],
	["290", "  Data received:: 9.312 Kb (108 protocol messages)"],
	["290", "  receiveQ size:: 0 bytes (max. 1024 bytes)"],
	["290", "     sendQ size:: 946 bytes (max. 160000 bytes)"],
	["291", " "],
]);

// Live, 2026-10-09 (`CHECK victim`, an away client).
const CHECK_VICTIM = reply("opr", [
	["290", " "],
	["286", "Information for user victim"],
	["290", " "],
	["290", "           Nick:: victim (ABAAE)"],
	["290", "      Signed on:: Fri Oct  9 16:46:35 2026"],
	["290", "      Timestamp:: Fri Oct  9 16:46:35 2026 (1791564395)"],
	["290", "  User/Hostmask:: victim@172.17.0.1"],
	["290", " Real User/Host:: victim@172.17.0.1 (172.17.0.1)"],
	["290", `      Real Name:: Real Name of victim${O}`],
	["290", "         Status:: Client"],
	["290", "          Class:: Users"],
	["290", "   Capabilities:: account-tag batch extended-join labeled-response message-tags "],
	["290", "   Capabilities:: server-time "],
	["290", "   Connected to:: irc.seance.test"],
	["290", "     Session ID:: AaEhjzU9cAGlgnpaKNwfig"],
	["290", "       Umode(s):: +x"],
	["290", "     Channel(s):: #seance "],
	["290", "       Idle for:: 0 days, 00:00:04"],
	["290", "   Away message:: gone fishing"],
	["290", " "],
	["290", "          Ports:: 47604 -> 6667 (client -> server)"],
	["290", "      Data sent:: 0.176 Kb (7 protocol messages)"],
	["290", "  Data received:: 3.305 Kb (28 protocol messages)"],
	["290", "  receiveQ size:: 0 bytes (max. 1024 bytes)"],
	["290", "     sendQ size:: 0 bytes (max. 160000 bytes)"],
	["291", " "],
]);

// Live, 2026-10-09 (`CHECK #seance`).
const CHECK_SEANCE = reply("opr", [
	["290", " "],
	["286", "Information for channel #seance"],
	["290", " "],
	["290", "   Creation time:: Fri Oct  9 16:45:37 2026"],
	["290", "           Topic:: <none>"],
	["290", " Channel mode(s):: <none>"],
	["290", "Users (@ = op, + = voice, < = delayed, ~ = alias)"],
	["287", `         @opr (opr@172.17.0.1)   (Real Name of opr${O}) `],
	["290", " "],
	["290", "Total users:: 1 (1 ops, 0 voiced, 0 clones, 0 authed, 0 delayed, 0 aliases)"],
	["290", " "],
	["290", "Bans on channel::"],
	["290", "<none>"],
	["291", " "],
]);

// Reconstructed from m_check.c: a logged-in TLS user with a bouncer session.
const CHECK_ALICE = reply("rubin", [
	["290", " "],
	["286", "Information for user alice"],
	["290", " "],
	["290", "           Nick:: alice (ABAAC)"],
	["290", "      Signed on:: Thu Oct  9 09:12:44 2026"],
	["290", "      Timestamp:: Thu Oct  9 09:12:44 2026 (1791537164)"],
	["290", "  User/Hostmask:: ~alice@alice.users.seance.test"],
	["290", " Real User/Host:: ~alice@cpe-203-0-113-7.example.net (203.0.113.7)"],
	["290", `      Real Name:: Alice Example${O}`],
	["290", "         Status:: Client"],
	["290", "          Class:: Local"],
	["290", "   Capabilities:: multi-prefix extended-join away-notify account-notify sasl "],
	["290", "   Capabilities:: cap-notify server-time echo-message account-tag chghost "],
	["290", "          Marks:: tor-exit, dnsbl-hit"],
	["290", "   Connected to:: irc.seance.test"],
	["290", "    SSL Ciphers:: TLSv1.3-TLS_AES_256_GCM_SHA384-256bits"],
	["290", "       Umode(s):: +ixzr alice:1788000000"],
	["290", "     Channel(s):: @#seance +#help *#ops "],
	["290", "       Idle for:: 1 day, 02:03:12"],
	["290", "   Away message:: lunch"],
	["290", " "],
	["290", "          Ports:: 51234 -> 8443 (client -> server)"],
	["290", "      Data sent:: 12.345 Kb (210 protocol messages)"],
	["290", "  Data received:: 301.007 Kb (4120 protocol messages)"],
	["290", "  receiveQ size:: 0 bytes (max. 1024 bytes)"],
	["290", "     sendQ size:: 0 bytes (max. 160000 bytes)"],
	["290", " "],
	["290", "Bouncer Session::"],
	["290", "  Session state:: ACTIVE"],
	["290", "     Session ID:: k3J9xQ"],
	["290", "Managing server:: irc.seance.test (local)"],
	["290", "    Connections:: 2 (1 primary, 1 alias)"],
	["290", "        Primary:: ABAAC on irc.seance.test, idle 192s"],
	["290", "          Alias:: ACAAB on leaf.seance.test, idle 30s"],
	["290", "  Hold override:: default"],
	["290", "  Session since:: Mon Oct  6 18:00:01 2026"],
	["290", "   Resume count:: 14"],
	[
		"290",
		" Session totals:: 2210.512 Kb sent / 9921.004 Kb recv (31002 msgs sent / 220431 recv)",
	],
	["290", " "],
	["290", "  Primary::"],
	["290", "             IP:: 203.0.113.7"],
	["290", "      Connected:: Thu Oct  9 09:12:44 2026"],
	["290", "           Port:: 51234 -> 8443"],
	["290", "            TLS:: yes"],
	["290", "     Away state:: away"],
	["290", " "],
	["290", "Aliases:: (1)"],
	["290", "  [1] ACAAB on leaf.seance.test :: +ixzr (local)"],
	["290", " "],
	["290", "Connection History:: (2 unique hosts)"],
	[
		"290",
		"  [1] 203.0.113.7 (cpe-203-0-113-7.example.net) :: 12x, last: Thu Oct  9 09:12:44 2026 -> connected",
	],
	[
		"290",
		"  [2] 198.51.100.4 (198.51.100.4) :: 2x, last: Wed Oct  8 20:01:10 2026 -> Wed Oct  8 20:01:10 2026",
	],
	["291", " "],
]);

// Reconstructed: a channel with a topic, a key, a clone pair and a ban.
const CHECK_BUSY = reply("rubin", [
	["290", " "],
	["286", "Information for channel #seance"],
	["290", " "],
	["290", "   Creation time:: Mon Sep  1 10:00:00 2026"],
	["290", "           Topic:: Welcome to #seance"],
	["290", "          Set by:: alice"],
	["290", " Channel mode(s):: +tnlk 50 sekrit"],
	["290", "Users (@ = op, + = voice, < = delayed, ~ = alias)"],
	["287", `         @alice (~alice@cpe-203-0-113-7.example.net)   (Alice Example${O}) alice`],
	["287", `      2  +bob (bob@198.51.100.4)   (Bob${O}) `],
	["287", `      2   bob2 (bob@198.51.100.4)   (Bob's bot (v2)${O}) `],
	["287", `          rubin (rubin@localhost)   (Rubin${O}) rubin`],
	["290", " "],
	["290", "Total users:: 4 (1 ops, 1 voiced, 2 clones, 2 authed, 0 delayed, 0 aliases)"],
	["290", " "],
	["290", "Bans on channel::"],
	["290", "[1] - *!*@spam.example - Set by alice, on Thu Oct  9 08:00:00 2026"],
	[
		"290",
		"[2] - *!*@*.bad.example - Set by X!services@services.afternet.org, on Thu Oct  9 08:05:00 2026",
	],
	["291", " "],
]);

// Reconstructed: `CHECK 198.51.100.0/24 -c`.
const CHECK_HOST = reply("rubin", [
	["290", " "],
	["286", "Information for host *!*@198.51.100.0/24"],
	["290", " "],
	["290", "No.   Nick                            User        Host"],
	["290", "1     bob                             bob         198.51.100.4"],
	["290", "      on channels: +#seance #help "],
	["290", " "],
	["290", "2     bob2                            bob         198.51.100.4"],
	["290", "      on channels: #seance "],
	["290", " "],
	["290", " "],
	["290", "Matching records found:: 2"],
	["291", " "],
]);

// Reconstructed: a search past MAX_CHECK_OUTPUT (the server sends a second
// footer and 291 after the truncation's).
const CHECK_TRUNCATED = reply("rubin", [
	["290", " "],
	["286", "Information for host *!*@*.example.net"],
	["290", " "],
	["290", "No.   Nick                            User        Host"],
	["290", "1     a1                              u           h1.example.net"],
	["290", "2     a2                              u           h2.example.net"],
	["290", "More than 1001 results, truncating..."],
	["291", " "],
	["290", " "],
	["290", "Matching records found:: 1002"],
	["291", " "],
]);

// Reconstructed: `CHECK irc.seance.test`.
const CHECK_SERVER = reply("rubin", [
	["290", " "],
	["286", "Information for server irc.seance.test"],
	["290", " "],
	["290", "   Connected at:: Sat Sep 12 03:51:34 2026 (1789184294)"],
	["290", "    Server name:: irc.seance.test"],
	["290", "        Numeric:: AB --> 1"],
	["290", "          Users:: 3 / 4095"],
	["290", "         Status:: Network Hub"],
	["290", "          Class:: Server"],
	["290", " "],
	["290", "Downlinks::"],
	["290", "[1] - +hub2.seance.test"],
	["290", "[2] - *leaf.seance.test"],
	["290", "[3] -  quiet.seance.test"],
	["291", " "],
]);

describe("nefarious2 CHECK reports", function () {
	describe("user card", function () {
		it("reads an oper checking itself (live)", function () {
			const report = checkReport(CHECK_OPR, "CHECK opr")!;

			expect(report.kind).to.equal("check-user");
			expect(report.title).to.equal("CHECK opr");
			expect(report.subtitle).to.equal("User");
			expect(report.command).to.equal("CHECK opr");
			expect(report.error).to.equal(undefined);
			expect(report.raw).to.have.length(CHECK_OPR.length);

			expect(entry(report, "Identity", "Nick")).to.deep.equal({t: "nick", v: "opr"});
			expect(entry(report, "Identity", "Numeric")).to.deep.equal({t: "text", v: "ABAAA"});
			expect(entry(report, "Identity", "Real host")).to.deep.equal({
				t: "host",
				v: "opr@172.17.0.1",
			});
			expect(entry(report, "Identity", "IP")).to.deep.equal({t: "ip", v: "172.17.0.1"});
			expect(entry(report, "Identity", "Real name")).to.deep.equal({
				t: "text",
				v: "Real Name of opr",
			});
			expect(entry(report, "Identity", "Server")).to.deep.equal({
				t: "server",
				v: "irc.seance.test",
			});
			expect(entry(report, "Identity", "Session ID")).to.deep.equal({
				t: "mono",
				v: "AaEhjlCmcAGhWVFeRQHNFQ",
			});
		});

		it("parses ctime as UTC and agrees with the unix timestamp", function () {
			const report = checkReport(CHECK_OPR, "CHECK opr")!;
			const signed = single(entry(report, "Connection", "Signed on"));
			const ts = single(entry(report, "Connection", "Nick TS"));

			expect(signed).to.deep.equal({
				t: "time",
				v: Date.UTC(2026, 9, 9, 16, 45, 37),
				text: "Fri Oct  9 16:45:37 2026",
			});
			expect(ts.t).to.equal("time");
			expect((ts as {v: number}).v).to.equal(1791564337000);
			expect((signed as {v: number}).v).to.equal(1791564337000);
		});

		it("merges wrapped privileges and capabilities", function () {
			const report = checkReport(CHECK_OPR, "CHECK opr")!;
			const privs = single(entry(report, "Oper", "Privileges"));

			expect(privs.t).to.equal("chips");
			expect((privs as {v: string[]}).v).to.have.length(25);
			expect((privs as {v: string[]}).v.slice(0, 3)).to.deep.equal([
				"CHAN_LIMIT",
				"SHOW_INVIS",
				"SHOW_ALL_INVIS",
			]);
			expect((privs as {v: string[]}).v).to.include("GITSYNC");
			expect(entry(report, "Oper", "Opered")).to.deep.equal({
				t: "text",
				v: "Local O:Line as seanceop",
			});
			expect(entry(report, "Capabilities", "Capabilities")).to.deep.equal({
				t: "chips",
				v: [
					"account-tag",
					"batch",
					"extended-join",
					"labeled-response",
					"message-tags",
					"server-time",
				],
			});
			// One entry each, not one per wrapped line.
			expect(section(report, "Oper").entries).to.have.length(2);
		});

		it("splits channel prefixes", function () {
			const report = checkReport(CHECK_OPR, "CHECK opr")!;

			expect(entry(report, "Channels", "Channels")).to.deep.equal([
				{t: "channel", v: "#seance", prefix: "@"},
			]);

			const alice = checkReport(CHECK_ALICE, "CHECK alice")!;

			expect(entry(alice, "Channels", "Channels")).to.deep.equal([
				{t: "channel", v: "#seance", prefix: "@"},
				{t: "channel", v: "#help", prefix: "+"},
				{t: "channel", v: "#ops", prefix: "*"},
			]);
		});

		it("counts traffic in bytes: the part after the dot is a byte remainder", function () {
			const report = checkReport(CHECK_OPR, "CHECK opr")!;

			expect(entry(report, "Traffic", "Sent")).to.deep.equal([
				{t: "bytes", v: 261},
				{t: "text", v: "12 messages"},
			]);
			expect(entry(report, "Traffic", "Received")).to.deep.equal([
				{t: "bytes", v: 9 * 1024 + 312},
				{t: "text", v: "108 messages"},
			]);
			expect(entry(report, "Traffic", "Send queue")).to.deep.equal([
				{t: "bytes", v: 946},
				{t: "text", v: "of"},
				{t: "bytes", v: 160000},
			]);
		});

		it("reads idle time and away for a client (live)", function () {
			const report = checkReport(CHECK_VICTIM, "CHECK victim")!;

			expect(report.title).to.equal("CHECK victim");
			expect(entry(report, "Connection", "Idle")).to.deep.equal({t: "duration", v: 4});
			expect(entry(report, "Connection", "Away")).to.deep.equal({
				t: "text",
				v: "gone fishing",
			});
			expect(entry(report, "Connection", "User modes")).to.deep.equal({t: "mono", v: "+x"});
			expect(entry(report, "Identity", "Status")).to.deep.equal({t: "text", v: "Client"});
			expect(report.sections.map((s) => s.title)).not.to.include("Oper");
		});

		it("takes the account from the user modes only when the user is +r", function () {
			const alice = checkReport(CHECK_ALICE, "CHECK alice")!;

			expect(entry(alice, "Identity", "Account")).to.deep.equal({t: "text", v: "alice"});
			expect(entry(alice, "Connection", "User modes")).to.deep.equal({
				t: "mono",
				v: "+ixzr",
			});
			expect(entry(alice, "Connection", "Idle")).to.deep.equal({
				t: "duration",
				v: 86400 + 2 * 3600 + 3 * 60 + 12,
			});
			expect(entry(alice, "Connection", "TLS cipher")).to.deep.equal({
				t: "mono",
				v: "TLSv1.3-TLS_AES_256_GCM_SHA384-256bits",
			});
			expect(entry(alice, "Marks", "Marks")).to.deep.equal({
				t: "chips",
				v: ["tor-exit", "dnsbl-hit"],
			});
			expect(entry(alice, "Traffic", "Received")).to.deep.equal([
				{t: "bytes", v: 301 * 1024 + 7},
				{t: "text", v: "4120 messages"},
			]);
		});

		it("lays out the bouncer block, its primary, aliases and history", function () {
			const alice = checkReport(CHECK_ALICE, "CHECK alice")!;

			expect(entry(alice, "Bouncer session", "State")).to.deep.equal({
				t: "state",
				v: "ACTIVE",
				ok: true,
			});
			// The bouncer's Session ID is the bouncer's, not the connection's.
			expect(entry(alice, "Bouncer session", "Session ID")).to.deep.equal({
				t: "mono",
				v: "k3J9xQ",
			});
			expect(entry(alice, "Bouncer session", "Managing server")).to.deep.equal([
				{t: "server", v: "irc.seance.test"},
				{t: "text", v: "local"},
			]);
			expect(entry(alice, "Bouncer session", "Primary")).to.deep.equal([
				{t: "mono", v: "ABAAC"},
				{t: "server", v: "irc.seance.test"},
				{t: "text", v: "idle"},
				{t: "duration", v: 192},
			]);
			expect(entry(alice, "Bouncer session", "Resumes")).to.deep.equal({
				t: "number",
				v: 14,
			});
			expect(entry(alice, "Bouncer session", "Sent")).to.deep.equal([
				{t: "bytes", v: 2210 * 1024 + 512},
				{t: "text", v: "31002 messages"},
			]);
			expect(entry(alice, "Bouncer primary", "IP")).to.deep.equal({
				t: "ip",
				v: "203.0.113.7",
			});
			expect(entry(alice, "Bouncer primary", "TLS")).to.deep.equal({
				t: "state",
				v: "yes",
				ok: true,
			});

			const aliases = section(alice, "Bouncer aliases").table!;
			expect(aliases.rows).to.have.length(1);
			expect(aliases.rows[0]).to.deep.equal({
				n: {t: "number", v: 1},
				numeric: {t: "mono", v: "ACAAB"},
				server: {t: "server", v: "leaf.seance.test"},
				modes: {t: "mono", v: "+ixzr"},
				local: {t: "text", v: "local"},
			});

			const history = section(alice, "Connection history").table!;
			expect(history.rows).to.have.length(2);
			expect(history.rows[0].until).to.deep.equal({t: "state", v: "connected", ok: true});
			expect(history.rows[0].count).to.deep.equal({t: "number", v: 12});
			expect(history.rows[0].host).to.deep.equal({
				t: "host",
				v: "cpe-203-0-113-7.example.net",
			});
			// Both times come from one static buffer: an identical "until" is dropped.
			expect(history.rows[1].until).to.equal(undefined);
			expect(history.rows[1].last).to.deep.equal({
				t: "time",
				v: Date.UTC(2026, 9, 8, 20, 1, 10),
				text: "Wed Oct  8 20:01:10 2026",
			});
		});

		it("keeps lines it does not know in an Other section", function () {
			const lines = reply("rubin", [
				["290", " "],
				["286", "Information for user zed"],
				["290", " "],
				["290", "           Nick:: zed (ABAAZ)"],
				["290", "   Shiny new field:: something"],
				["291", " "],
			]);
			const report = checkReport(lines, "CHECK zed")!;

			expect(entry(report, "Other", "Shiny new field")).to.deep.equal({
				t: "text",
				v: "something",
			});
		});

		it("keeps the -b machine lines verbatim", function () {
			const lines = reply("rubin", [
				["290", " "],
				["286", "Information for user alice"],
				["290", " "],
				["290", "           Nick:: alice (ABAAC)"],
				["290", " "],
				["290", "Bouncer Session::"],
				["290", "  Session state:: HOLDING"],
				["290", " "],
				["290", "BouncerPrimary:: ABAAC alice 1791537164 k3J9xQ irc.seance.test local"],
				["291", " "],
			]);
			const report = checkReport(lines, "CHECK alice -b")!;

			expect(entry(report, "Bouncer session", "State")).to.deep.equal({
				t: "state",
				v: "HOLDING",
				ok: false,
			});
			expect(section(report, "Bouncer detail").lines).to.deep.equal([
				"BouncerPrimary:: ABAAC alice 1791537164 k3J9xQ irc.seance.test local",
			]);
		});
	});

	describe("channel card", function () {
		it("reads a channel with nothing set (live)", function () {
			const report = checkReport(CHECK_SEANCE, "CHECK #seance")!;

			expect(report.kind).to.equal("check-channel");
			expect(report.title).to.equal("CHECK #seance");
			expect(entry(report, "Channel", "Created")).to.deep.equal({
				t: "time",
				v: Date.UTC(2026, 9, 9, 16, 45, 37),
				text: "Fri Oct  9 16:45:37 2026",
			});
			expect(entry(report, "Channel", "Topic")).to.deep.equal({t: "text", v: "<none>"});
			expect(entry(report, "Channel", "Modes")).to.deep.equal({t: "text", v: "<none>"});

			const members = section(report, "Members").table!;
			expect(members.rows).to.deep.equal([
				{
					status: {t: "text", v: "op"},
					nick: {t: "nick", v: "opr"},
					host: {t: "host", v: "opr@172.17.0.1"},
					realname: {t: "text", v: "Real Name of opr"},
					account: undefined,
					clones: undefined,
					oplevel: undefined,
				},
			]);
			expect(members.columns.map((c) => c.key)).to.deep.equal([
				"status",
				"nick",
				"host",
				"realname",
			]);
			expect(entry(report, "Totals", "Users")).to.deep.equal({t: "number", v: 1});
			expect(entry(report, "Totals", "Ops")).to.deep.equal({t: "number", v: 1});
			expect(report.sections.map((s) => s.title)).not.to.include("Bans");
		});

		it("reads members, clones, accounts, topic and bans", function () {
			const report = checkReport(CHECK_BUSY, "CHECK #seance")!;

			expect(entry(report, "Channel", "Topic")).to.deep.equal({
				t: "text",
				v: "Welcome to #seance",
			});
			expect(entry(report, "Channel", "Topic set by")).to.deep.equal({
				t: "nick",
				v: "alice",
			});
			expect(entry(report, "Channel", "Modes")).to.deep.equal({
				t: "mono",
				v: "+tnlk 50 sekrit",
			});

			const members = section(report, "Members").table!;
			expect(members.columns.map((c) => c.key)).to.deep.equal([
				"status",
				"nick",
				"host",
				"realname",
				"account",
				"clones",
			]);
			expect(members.rows).to.have.length(4);
			expect(members.rows[0].account).to.deep.equal({t: "text", v: "alice"});
			expect(members.rows[1].status).to.deep.equal({t: "text", v: "voice"});
			expect(members.rows[1].clones).to.deep.equal({t: "number", v: 2});
			expect(members.rows[2].status).to.equal(undefined);
			expect(members.rows[2].clones).to.deep.equal({t: "number", v: 2});
			// A realname with brackets of its own survives.
			expect(members.rows[2].realname).to.deep.equal({t: "text", v: "Bob's bot (v2)"});
			expect(members.rows[3].nick).to.deep.equal({t: "nick", v: "rubin"});
			expect(members.rows[3].clones).to.equal(undefined);

			expect(entry(report, "Totals", "Clones")).to.deep.equal({t: "number", v: 2});
			expect(entry(report, "Totals", "Authed")).to.deep.equal({t: "number", v: 2});

			const bans = section(report, "Bans").table!;
			expect(bans.rows).to.have.length(2);
			expect(bans.rows[0]).to.deep.equal({
				n: {t: "number", v: 1},
				mask: {t: "mask", v: "*!*@spam.example"},
				by: {t: "nick", v: "alice"},
				when: {
					t: "time",
					v: Date.UTC(2026, 9, 9, 8, 0, 0),
					text: "Thu Oct  9 08:00:00 2026",
				},
			});
			expect(bans.rows[1].by).to.deep.equal({t: "nick", v: "X"});
		});

		it("reads oplevels, zombies and halfops", function () {
			const lines = reply("rubin", [
				["290", " "],
				["286", "Information for channel #ol"],
				["290", " "],
				["290", "Users (@ = op, % = halfop, + = voice, < = delayed, ~ = alias)"],
				// " " + oplevel "%3d" + " " + clones "   " + zombie " " + status "@"
				["287", ` 999     @boss (b@h)   (Boss${O}) `],
				["287", `        !%ghost (g@h)   (Ghost${O}) `],
				["290", " "],
				[
					"290",
					"Total users:: 2 (1 ops, 1 halfops, 0 voiced, 0 clones, 0 authed, 0 delayed, 0 aliases)",
				],
				["291", " "],
			]);
			const report = checkReport(lines, "CHECK #ol")!;
			const rows = section(report, "Members").table!.rows;

			expect(rows[0].oplevel).to.deep.equal({t: "number", v: 999});
			expect(rows[0].status).to.deep.equal({t: "text", v: "op"});
			expect(rows[1].status).to.deep.equal({t: "text", v: "zombie halfop"});
			expect(entry(report, "Totals", "Halfops")).to.deep.equal({t: "number", v: 1});
		});
	});

	describe("server card", function () {
		it("reads the server and its downlinks", function () {
			const report = checkReport(CHECK_SERVER, "CHECK irc.seance.test")!;

			expect(report.kind).to.equal("check-server");
			expect(report.subtitle).to.equal("Server");
			expect(entry(report, "Server", "Connected")).to.deep.equal({
				t: "time",
				v: 1789184294000,
				text: "Sat Sep 12 03:51:34 2026",
			});
			expect(entry(report, "Server", "Users")).to.deep.equal([
				{t: "number", v: 3},
				{t: "text", v: "of"},
				{t: "number", v: 4095},
			]);
			expect(entry(report, "Server", "Status")).to.deep.equal({
				t: "text",
				v: "Network Hub",
			});

			const links = section(report, "Downlinks").table!;
			expect(links.rows).to.deep.equal([
				{
					n: {t: "number", v: 1},
					name: {t: "server", v: "hub2.seance.test"},
					flag: {t: "state", v: "hub", ok: true},
				},
				{
					n: {t: "number", v: 2},
					name: {t: "server", v: "leaf.seance.test"},
					flag: {t: "state", v: "bursting", ok: false},
				},
				{
					n: {t: "number", v: 3},
					name: {t: "server", v: "quiet.seance.test"},
					flag: undefined,
				},
			]);
		});
	});

	describe("host search", function () {
		it("reads the matches and their channels (-c)", function () {
			const report = checkReport(CHECK_HOST, "CHECK 198.51.100.0/24 -c")!;

			expect(report.kind).to.equal("check-host");
			expect(report.title).to.equal("CHECK *!*@198.51.100.0/24");
			expect(report.subtitle).to.equal("2 matches");

			const table = section(report, "Matches").table!;
			expect(table.columns.map((c) => c.key)).to.deep.equal([
				"n",
				"nick",
				"user",
				"host",
				"channels",
			]);
			expect(table.rows[0]).to.deep.equal({
				n: {t: "number", v: 1},
				nick: {t: "nick", v: "bob"},
				user: {t: "text", v: "bob"},
				host: {t: "ip", v: "198.51.100.4"},
				channels: {t: "chips", v: ["+#seance", "#help"]},
			});
			expect(table.rows[1].channels).to.deep.equal({t: "chips", v: ["#seance"]});
		});

		it("stops at the first 291 of a truncated search and says so", function () {
			const report = checkReport(CHECK_TRUNCATED, "CHECK *.example.net")!;
			const table = section(report, "Matches").table!;

			expect(table.rows).to.have.length(2);
			expect(table.columns.map((c) => c.key)).to.deep.equal(["n", "nick", "user", "host"]);
			expect(table.rows[0].host).to.deep.equal({t: "host", v: "h1.example.net"});
			expect(report.notes).to.have.length(1);
			expect(report.notes![0]).to.match(/^More than 1001 results, truncating\.\.\./);
			// The stray footer after the first 291 is not read.
			expect(report.subtitle).to.equal("2 matches");
			expect(report.sections.map((s) => s.title)).to.deep.equal(["Matches"]);
		});
	});

	describe("errors", function () {
		it("says when nothing matched (292)", function () {
			const lines = reply("rubin", [["292", "CHECK nobody No matching record(s) found"]]);
			const report = checkReport(lines, "CHECK nobody")!;

			expect(report.kind).to.equal("check");
			expect(report.title).to.equal("CHECK nobody");
			expect(report.error).to.equal("No matching user, channel, server or host for nobody");
			expect(report.sections).to.deep.equal([]);
			expect(report.raw).to.deep.equal(["CHECK nobody No matching record(s) found"]);
		});

		it("says when the user is not an oper (481)", function () {
			const lines = reply("rubin", [["481", "Permission Denied: Insufficient privileges"]]);
			const report = checkReport(lines, "CHECK alice")!;

			expect(report.title).to.equal("CHECK alice");
			expect(report.error).to.equal("Permission denied: you are not an IRC operator");
		});

		it("says when the oper lacks the CHECK privilege (517)", function () {
			const msg = parseLine(":irc.seance.test 517 rubin CHECK :Command disabled.")!;
			const report = checkReport([msg], "CHECK #seance -u")!;

			expect(report.title).to.equal("CHECK #seance");
			expect(report.error).to.equal("You don't have the CHECK privilege");
		});

		it("is not a CHECK reply without a header or an error", function () {
			const msg = parseLine(":irc.seance.test 219 rubin g :End of /STATS report")!;

			expect(checkReport([msg], "STATS g")).to.equal(undefined);
			expect(checkReport([], "CHECK x")).to.equal(undefined);
		});
	});
});
