import {expect} from "chai";
import {parseLine, IrcMessage} from "../../../client/js/irc/message";
import {
	banState,
	parseStatsHelp,
	STATS_ENTRIES,
	statsEntry,
	statsReport,
} from "../../../client/js/irc/profiles/nefarious/stats";
import type {OperReport, ReportSection, ReportTable, ReportValue} from "../../../shared/types/oper";

function L(...lines: string[]): IrcMessage[] {
	return lines.map((line) => {
		const msg = parseLine(line);

		if (!msg) {
			throw new Error(`unparsable fixture: ${line}`);
		}

		return msg;
	});
}

function tableOf(report: OperReport, index = 0): ReportTable {
	const tables = report.sections.filter((s) => s.table).map((s) => s.table as ReportTable);
	const table = tables[index];

	if (!table) {
		throw new Error(`no table #${index} in ${JSON.stringify(report.sections)}`);
	}

	return table;
}

function linesOf(report: OperReport): string[] {
	return report.sections.flatMap((s: ReportSection) => s.lines ?? []);
}

/** The value in `key` of every row. */
function column(table: ReportTable, key: string): (ReportValue | undefined)[] {
	return table.rows.map((row) => row[key]);
}

// -------------------------------------------------- live captures (dev rig, 2026-10-09)

const HELP_LIVE = L(
	":irc.seance.test NOTICE opr :i (access) - Connection authorization lines.",
	":irc.seance.test NOTICE opr :  (authtoken) - AUTHTOKEN services, token counts and JWT public keys.",
	":irc.seance.test NOTICE opr :  (chathistory) - CHATHISTORY storage statistics.",
	":irc.seance.test NOTICE opr :A (chathistoryads) - Chathistory federation advertisements.",
	":irc.seance.test NOTICE opr :y (classes) - Connection classes.",
	":irc.seance.test NOTICE opr :m (commands) - Message usage information.",
	":irc.seance.test NOTICE opr :c (connect) - Remote server connection lines.",
	":irc.seance.test NOTICE opr :D (crules) - Dynamic routing configuration.",
	":irc.seance.test NOTICE opr :  (dnsbl) - DNSBL statistics and configuration.",
	":irc.seance.test NOTICE opr :e (engine) - Report server event loop engine.",
	":irc.seance.test NOTICE opr :E (excepts) - Exception list.",
	":irc.seance.test NOTICE opr :f (features) - Feature settings.",
	":irc.seance.test NOTICE opr :F (featuresall) - All feature settings, including defaulted values.",
	":irc.seance.test NOTICE opr :  (gitsync) - GitSync statistics and configuration.",
	":irc.seance.test NOTICE opr :g (glines) - Global bans (G-lines).",
	":irc.seance.test NOTICE opr :j (histogram) - Message length histogram.",
	":irc.seance.test NOTICE opr :  (iauth) - IAuth statistics.",
	":irc.seance.test NOTICE opr :  (iauthconf) - IAuth configuration.",
	":irc.seance.test NOTICE opr :J (jupes) - Nickname jupes.",
	":irc.seance.test NOTICE opr :k (klines) - Local bans (K-Lines).",
	":irc.seance.test NOTICE opr :l (links) - Current connections information.",
	":irc.seance.test NOTICE opr :t (locals) - Local connection statistics (Total SND/RCV, etc).",
	":irc.seance.test NOTICE opr :R (mappings) - Service mappings.",
	":irc.seance.test NOTICE opr :d (maskrules) - Dynamic routing configuration.",
	":irc.seance.test NOTICE opr :z (memory) - Memory/Structure allocation information.",
	":irc.seance.test NOTICE opr :x (memusage) - List usage information.",
	":irc.seance.test NOTICE opr :  (metadata) - METADATA storage and queue statistics.",
	":irc.seance.test NOTICE opr :L (modules) - Dynamically loaded modules.",
	":irc.seance.test NOTICE opr :T (motds) - Configured Message Of The Day files.",
	":irc.seance.test NOTICE opr :a (nameservers) - DNS servers.",
	":irc.seance.test NOTICE opr :o (operators) - Operator information.",
	":irc.seance.test NOTICE opr :p (ports) - Listening ports.",
	":irc.seance.test NOTICE opr :q (quarantines) - Quarantined channels list.",
	":irc.seance.test NOTICE opr :S (shuns) - Global Shuns.",
	":irc.seance.test NOTICE opr :s (spoofhosts) - Spoofed hosts information.",
	":irc.seance.test NOTICE opr :u (uptime) - Current uptime & highest connection count.",
	":irc.seance.test NOTICE opr :r (usage) - System resource usage (Debug only).",
	":irc.seance.test NOTICE opr :w (userload) - Userload statistics.",
	":irc.seance.test NOTICE opr :U (uworld) - Service server information.",
	":irc.seance.test NOTICE opr :v (vservers) - Verbose server information.",
	":irc.seance.test NOTICE opr :V (vserversmach) - Verbose server information.",
	":irc.seance.test NOTICE opr :W (webirc) - WEBIRC configuration.",
	":irc.seance.test NOTICE opr :  (webpush) - WEBPUSH VAPID key ring and subscription statistics.",
	":irc.seance.test NOTICE opr :Z (zlines) - Global IP bans (Z-lines).",
	"@batch=AAA0;time=2026-10-09T16:45:44.276Z :irc.seance.test 219 opr * :End of /STATS report"
);

const END = (sel: string) =>
	`@batch=X;time=2026-10-09T16:47:14.181Z :irc.seance.test 219 opr ${sel} :End of /STATS report`;

describe("nefarious2 STATS", function () {
	describe("catalogue and selector resolution", function () {
		it("matches the live help list, plus webhook, sorted by long name", function () {
			const live = parseStatsHelp(HELP_LIVE);
			const catalogue = STATS_ENTRIES.filter((e) => e.name !== "webhook");

			expect(live).to.have.length(44);
			expect(catalogue).to.deep.equal(live);
			expect(STATS_ENTRIES.find((e) => e.name === "webhook")?.letter).to.equal("");

			const names = STATS_ENTRIES.map((e) => e.name);
			expect(names).to.deep.equal([...names].sort());
		});

		it("parses long-name-only entries with an empty letter", function () {
			const live = parseStatsHelp(HELP_LIVE);
			expect(live[1]).to.deep.equal({
				letter: "",
				name: "authtoken",
				description: "AUTHTOKEN services, token counts and JWT public keys.",
			});
			expect(live[0]).to.deep.equal({
				letter: "i",
				name: "access",
				description: "Connection authorization lines.",
			});
		});

		it("ignores everything but help NOTICEs", function () {
			expect(
				parseStatsHelp(
					L(
						":irc.seance.test NOTICE opr :Minute  Hour    Day   Yest. YYest. Userload for:",
						":irc.seance.test 219 opr * :End of /STATS report",
						":irc.seance.test 242 opr :Server Up 0 days, 0:01:59"
					)
				)
			).to.deep.equal([]);
		});

		it("folds case only for the case-insensitive letters", function () {
			expect(statsEntry("G")?.name).to.equal("glines");
			expect(statsEntry("g")?.name).to.equal("glines");
			expect(statsEntry("O")?.name).to.equal("operators");
			expect(statsEntry("P")?.name).to.equal("ports");
			expect(statsEntry("Y")?.name).to.equal("classes");
			expect(statsEntry("K")?.name).to.equal("klines");
			expect(statsEntry("C")?.name).to.equal("connect");
			expect(statsEntry("I")?.name).to.equal("access");
			expect(statsEntry("Q")?.name).to.equal("quarantines");
			expect(statsEntry("X")?.name).to.equal("memusage");

			// case-sensitive pairs stay apart
			expect(statsEntry("S")?.name).to.equal("shuns");
			expect(statsEntry("s")?.name).to.equal("spoofhosts");
			expect(statsEntry("Z")?.name).to.equal("zlines");
			expect(statsEntry("z")?.name).to.equal("memory");
			expect(statsEntry("V")?.name).to.equal("vserversmach");
			expect(statsEntry("v")?.name).to.equal("vservers");
			expect(statsEntry("J")?.name).to.equal("jupes");
			expect(statsEntry("j")?.name).to.equal("histogram");

			// no case folding for a letter without an entry of its own
			expect(statsEntry("M")).to.equal(undefined);
			expect(statsEntry("N")).to.equal(undefined);
		});

		it("resolves long names case-insensitively, and nothing for help or unknown", function () {
			expect(statsEntry("webpush")?.name).to.equal("webpush");
			expect(statsEntry("WebPush")?.name).to.equal("webpush");
			expect(statsEntry("GLINES")?.name).to.equal("glines");
			expect(statsEntry("*")).to.equal(undefined);
			expect(statsEntry("")).to.equal(undefined);
			expect(statsEntry("bogus")).to.equal(undefined);
		});
	});

	describe("help", function () {
		it("renders the live help list as a table", function () {
			const report = statsReport("", HELP_LIVE, "STATS");
			expect(report.kind).to.equal("stats");
			expect(report.title).to.equal("STATS selectors");
			expect(report.subtitle).to.equal("STATS *");
			expect(report.command).to.equal("STATS");
			expect(report.raw).to.have.length(45);

			const table = tableOf(report);
			expect(table.rows).to.have.length(44);
			expect(table.rows[0]).to.deep.equal({
				letter: {t: "mono", v: "i"},
				name: {t: "mono", v: "access"},
				description: {t: "text", v: "Connection authorization lines."},
			});
			expect(table.rows[1].letter).to.equal(undefined);
			expect(report.notes).to.equal(undefined);
		});

		it("notes an unknown selector the server answered with its list", function () {
			const report = statsReport("bogus", HELP_LIVE, "STATS bogus");
			expect(report.title).to.equal("STATS selectors");
			expect(tableOf(report).rows).to.have.length(44);
			expect(report.notes?.[0]).to.contain("bogus");
		});

		it("shows the help table when a known selector is missing from this build", function () {
			const report = statsReport("webhook", HELP_LIVE, "STATS webhook");
			expect(report.title).to.equal("STATS selectors");
			expect(tableOf(report).rows).to.have.length(44);
		});
	});

	describe("live replies", function () {
		it("u: uptime and highest connection count", function () {
			const report = statsReport(
				"u",
				L(
					"@batch=AAC7;time=2026-10-09T16:47:14.181Z :irc.seance.test 242 opr :Server Up 0 days, 0:01:59",
					"@batch=AAC7;time=2026-10-09T16:47:14.181Z :irc.seance.test 250 opr :Highest connection count: 3 (3 clients)",
					END("u")
				),
				"STATS u"
			);
			expect(report.title).to.equal("Uptime");
			expect(report.subtitle).to.equal("STATS u");
			expect(report.sections[0].entries).to.deep.equal([
				{label: "Up for", value: {t: "duration", v: 119}},
				{label: "Highest connection count", value: {t: "number", v: 3}},
				{label: "Highest client count", value: {t: "number", v: 3}},
			]);
		});

		it("u: days count into the uptime", function () {
			const report = statsReport(
				"u",
				L(":srv 242 opr :Server Up 2 days, 3:04:05", END("u")),
				"STATS u"
			);
			expect(report.sections[0].entries?.[0].value).to.deep.equal({
				t: "duration",
				v: 2 * 86400 + 3 * 3600 + 4 * 60 + 5,
			});
		});

		it("o: operator blocks", function () {
			const report = statsReport(
				"o",
				L(
					"@batch=AAC8;time=2026-10-09T16:47:16.483Z :irc.seance.test 243 opr O *@* * seanceop Opers",
					END("o")
				),
				"STATS o"
			);
			expect(report.title).to.equal("Operator blocks");
			expect(tableOf(report).rows).to.deep.equal([
				{
					name: {t: "text", v: "seanceop"},
					mask: {t: "host", v: "*@*"},
					kind: {t: "text", v: "global"},
					class: {t: "text", v: "Opers"},
				},
			]);
		});

		it("p: listening ports with flag chips", function () {
			const report = statsReport(
				"p",
				L(
					":irc.seance.test 217 opr P 8444 0 CE46A active *",
					":irc.seance.test 217 opr P 8067 0 C46W active *",
					":irc.seance.test 217 opr P 8443 0 CE46W active *",
					":irc.seance.test 217 opr P 9998 0 CE46 active *",
					":irc.seance.test 217 opr P 6697 0 CE46 active *",
					":irc.seance.test 217 opr P 7000 0 C46 active *",
					":irc.seance.test 217 opr P 6667 1 C46 active *",
					":irc.seance.test 217 opr P 16667 0 C46 active *",
					":irc.seance.test 217 opr P 4497 0 SE46 active *",
					END("p")
				),
				"STATS p"
			);
			const table = tableOf(report);
			expect(report.title).to.equal("Listening ports");
			expect(table.rows).to.have.length(9);
			expect(table.rows[0]).to.deep.equal({
				port: {t: "mono", v: "8444"},
				conns: {t: "number", v: 0},
				kind: {t: "text", v: "client"},
				flags: {t: "chips", v: ["TLS", "IPv4", "IPv6", "autodetect"]},
				state: {t: "state", v: "active", ok: true},
				bind: {t: "mono", v: "*"},
			});
			expect(table.rows[1].flags).to.deep.equal({
				t: "chips",
				v: ["IPv4", "IPv6", "WebSocket"],
			});
			expect(table.rows[6].conns).to.deep.equal({t: "number", v: 1});
			expect(table.rows[8].kind).to.deep.equal({t: "text", v: "server"});
			expect(table.columns.find((c) => c.key === "port")?.align).to.equal("right");
		});

		it("p: a disabled port and a non-oper's missing bind address", function () {
			const table = tableOf(
				statsReport("p", L(":srv 217 nick P 7000 0 CH46P disabled", END("p")), "STATS p")
			);
			expect(table.rows[0].state).to.deep.equal({t: "state", v: "disabled", ok: false});
			expect(table.rows[0].bind).to.equal(undefined);
			expect(table.rows[0].flags).to.deep.equal({
				t: "chips",
				v: ["hidden", "IPv4", "IPv6", "paste"],
			});
		});

		it("y: connection classes", function () {
			const report = statsReport(
				"y",
				L(
					":irc.seance.test 218 opr Y default 120 600 1 40000 1024 0",
					":irc.seance.test 218 opr Y Users 90 0 4000 160000 1024 1",
					":irc.seance.test 218 opr Y Opers 90 0 100 160000 1024 1",
					":irc.seance.test 218 opr Y Local 90 0 100 160000 1024 0",
					":irc.seance.test 218 opr Y LeafServer 90 300 0 9000000 1024 0",
					":irc.seance.test 218 opr Y Server 90 300 1 9000000 1024 0",
					END("y")
				),
				"STATS y"
			);
			const table = tableOf(report);
			expect(report.title).to.equal("Connection classes");
			expect(table.rows).to.have.length(6);
			expect(table.rows[1]).to.deep.equal({
				class: {t: "text", v: "Users"},
				ping: {t: "duration", v: 90},
				connfreq: {t: "duration", v: 0},
				maxlinks: {t: "number", v: 4000},
				sendq: {t: "bytes", v: 160000},
				recvq: {t: "bytes", v: 1024},
				links: {t: "number", v: 1},
			});
		});

		it("y: an invalid class says so", function () {
			const table = tableOf(
				statsReport("Y", L(":srv 218 opr y Old 90 0 10 1000 1024 0", END("Y")), "STATS Y")
			);
			expect(table.rows[0].class).to.deep.equal({t: "text", v: "Old (invalid)"});
		});

		it("l: only the header row is nothing to show", function () {
			const report = statsReport(
				"l",
				L(
					"@batch=AAC11;time=2026-10-09T16:47:23.390Z :irc.seance.test 211 opr Connection SendQ SendM SendKBytes RcveM RcveKBytes :Open since",
					END("l")
				),
				"STATS l"
			);
			expect(report.title).to.equal("Connections");
			expect(report.sections).to.deep.equal([]);
			expect(report.notes).to.deep.equal(["Nothing to show"]);
			expect(report.raw).to.have.length(2);
		});

		it("l: connection rows, kilobytes in bytes", function () {
			const table = tableOf(
				statsReport(
					"l",
					L(
						":srv 211 opr Connection SendQ SendM SendKBytes RcveM RcveKBytes :Open since",
						":srv 211 opr hub.example.net 12 3400 210 5600 377 :86400",
						END("l")
					),
					"STATS l"
				)
			);
			expect(table.rows).to.deep.equal([
				{
					name: {t: "text", v: "hub.example.net"},
					sendq: {t: "bytes", v: 12},
					sentMsgs: {t: "number", v: 3400},
					sentBytes: {t: "bytes", v: 210 * 1024},
					recvMsgs: {t: "number", v: 5600},
					recvBytes: {t: "bytes", v: 377 * 1024},
					open: {t: "duration", v: 86400},
				},
			]);
		});

		it("w: the userload NOTICEs as a table", function () {
			const report = statsReport(
				"w",
				L(
					":irc.seance.test NOTICE opr :Minute  Hour    Day   Yest. YYest. Userload for:",
					":irc.seance.test NOTICE opr :   0.0     0.0     0     0     0   local clients",
					":irc.seance.test NOTICE opr :   1.4     0.0     0     0     0   total clients",
					":irc.seance.test NOTICE opr :   1.4     0.0     0     0     0   total connections",
					END("w")
				),
				"STATS w"
			);
			const table = tableOf(report);
			expect(report.title).to.equal("User load");
			expect(table.rows).to.have.length(3);
			expect(table.rows[1]).to.deep.equal({
				what: {t: "text", v: "total clients"},
				minute: {t: "number", v: 1.4},
				hour: {t: "number", v: 0},
				day: {t: "number", v: 0},
				yesterday: {t: "number", v: 0},
				before: {t: "number", v: 0},
			});
			expect(linesOf(report)).to.deep.equal([]);
		});

		for (const sel of ["g", "S", "Z", "J"]) {
			it(`${sel}: an empty list is nothing to show`, function () {
				const report = statsReport(sel, L(END(sel)), `STATS ${sel}`);
				expect(report.sections).to.deep.equal([]);
				expect(report.notes).to.deep.equal(["Nothing to show"]);
				expect(report.error).to.equal(undefined);
			});
		}

		it("titles the ban lists", function () {
			expect(statsReport("g", L(END("g")), "STATS g").title).to.equal("G-lines");
			expect(statsReport("S", L(END("S")), "STATS S").title).to.equal("Shuns");
			expect(statsReport("Z", L(END("Z")), "STATS Z").title).to.equal("Z-lines");
			expect(statsReport("J", L(END("J")), "STATS J").title).to.equal("Nick jupes");
		});

		it("481: an error report keeps the raw lines", function () {
			const report = statsReport(
				"k",
				L(":irc.seance.test 481 opr :Permission Denied: Insufficient privileges"),
				"STATS k"
			);
			expect(report.error).to.equal("Permission Denied: Insufficient privileges");
			expect(report.sections).to.deep.equal([]);
			expect(report.raw).to.deep.equal(["Permission Denied: Insufficient privileges"]);
			expect(report.title).to.equal("K-lines");
			expect(report.subtitle).to.equal("STATS k");
		});

		it("461: a non-oper's K-line query without a mask", function () {
			const report = statsReport(
				"K",
				L(":srv 461 nick STATS K :Not enough parameters"),
				"STATS K"
			);
			expect(report.error).to.equal("STATS K: Not enough parameters");
		});
	});

	describe("ban lists", function () {
		const now = 1791564000;

		it("g: decodes expiry, lastmod, lifetime and the state tokens", function () {
			const report = statsReport(
				"G",
				L(
					`:srv 247 opr G *@203.0.113.7 ${now + 3600} ${now} ${now + 7200} + :spam bots`,
					`:srv 247 opr G baduser@* ${now + 60} ${now - 10} ${
						now + 60
					} - :testing suffix`,
					`:srv 247 opr G $Rspam*bot ${now + 600} ${now} ${now + 600} >- :realname ban`,
					`:srv 247 opr G *@198.51.100.0/24 ${now + 600} ${now} ${
						now + 600
					} <+ :local off`,
					`:srv 247 opr G *@192.0.2.1 0 0 0 >+ :forever`,
					END("G")
				),
				"STATS G"
			);
			const table = tableOf(report);
			expect(report.title).to.equal("G-lines");
			expect(table.rows[0]).to.deep.equal({
				mask: {t: "mask", v: "*@203.0.113.7"},
				expires: {t: "expiry", v: (now + 3600) * 1000},
				lastmod: {t: "time", v: now * 1000},
				lifetime: {t: "expiry", v: (now + 7200) * 1000},
				state: {t: "state", v: "active", ok: true},
				reason: {t: "text", v: "spam bots"},
			});
			expect(column(table, "state")).to.deep.equal([
				{t: "state", v: "active", ok: true},
				{t: "state", v: "inactive", ok: false},
				{t: "state", v: "active (locally activated)", ok: true},
				{t: "state", v: "inactive (locally deactivated)", ok: false},
				{t: "state", v: "active (locally activated)", ok: true},
			]);
			expect(table.rows[2].mask).to.deep.equal({t: "mask", v: "$Rspam*bot"});
			expect(table.rows[4].expires).to.deep.equal({t: "expiry", v: 0});
			expect(table.rows[4].lastmod).to.equal(undefined);
		});

		it("banState: every token", function () {
			expect(banState("+")).to.deep.equal({t: "state", v: "active", ok: true});
			expect(banState("-")).to.deep.equal({t: "state", v: "inactive", ok: false});
			const ok = (token: string) => (banState(token) as {ok: boolean}).ok;
			expect(ok(">+")).to.equal(true);
			expect(ok(">-")).to.equal(true);
			expect(ok("<+")).to.equal(false);
			expect(ok("<-")).to.equal(false);
		});

		it("S: shuns share the layout", function () {
			const table = tableOf(
				statsReport(
					"S",
					L(
						`:srv 542 opr S *@10.1.1.1 ${now + 600} ${now} ${now + 600} + :shush`,
						END("S")
					),
					"STATS S"
				)
			);
			expect(table.rows[0].mask).to.deep.equal({t: "mask", v: "*@10.1.1.1"});
			expect(table.rows[0].reason).to.deep.equal({t: "text", v: "shush"});
			expect(table.rows[0].state).to.deep.equal({t: "state", v: "active", ok: true});
		});

		it("Z: Z-lines", function () {
			const table = tableOf(
				statsReport(
					"Z",
					L(
						`:srv 546 opr Z 10.2.2.2 ${now + 600} ${now} ${now + 600} - :zap them`,
						END("Z")
					),
					"STATS Z"
				)
			);
			expect(table.rows[0]).to.deep.equal({
				mask: {t: "mask", v: "10.2.2.2"},
				expires: {t: "expiry", v: (now + 600) * 1000},
				lastmod: {t: "time", v: now * 1000},
				lifetime: {t: "expiry", v: (now + 600) * 1000},
				state: {t: "state", v: "inactive", ok: false},
				reason: {t: "text", v: "zap them"},
			});
		});

		it("J: nick jupes", function () {
			const table = tableOf(
				statsReport(
					"J",
					L(":srv 222 opr J badnick", ":srv 222 opr J X*", END("J")),
					"STATS J"
				)
			);
			expect(column(table, "nick")).to.deep.equal([
				{t: "mono", v: "badnick"},
				{t: "mono", v: "X*"},
			]);
		});

		it("k: quoted fields, host and CIDR kinds", function () {
			const table = tableOf(
				statsReport(
					"k",
					L(
						`:srv 216 opr K *@evil.example "no spam please" "*" "*" * * 0 0`,
						`:srv 216 opr k *@198.51.100.0/24 "scanner range" "*bot*" "mIRC*" US NA 0 0`,
						END("k")
					),
					"STATS k"
				)
			);
			expect(table.rows[0]).to.deep.equal({
				mask: {t: "host", v: "*@evil.example"},
				type: {t: "text", v: "host"},
				reason: {t: "text", v: "no spam please"},
				realname: {t: "mono", v: "*"},
				version: {t: "mono", v: "*"},
				country: {t: "mono", v: "*"},
				continent: {t: "mono", v: "*"},
			});
			expect(table.rows[1].type).to.deep.equal({t: "text", v: "CIDR"});
			expect(table.rows[1].realname).to.deep.equal({t: "mono", v: "*bot*"});
			expect(table.rows[1].country).to.deep.equal({t: "mono", v: "US"});
		});
	});

	describe("config and usage tables", function () {
		it("m: command counts, busiest first", function () {
			const table = tableOf(
				statsReport(
					"m",
					L(
						":srv 212 opr NICK 12 73",
						":srv 212 opr PRIVMSG 940 81234",
						":srv 212 opr JOIN 40 600",
						END("m")
					),
					"STATS m"
				)
			);
			expect(column(table, "command")).to.deep.equal([
				{t: "mono", v: "PRIVMSG"},
				{t: "mono", v: "JOIN"},
				{t: "mono", v: "NICK"},
			]);
			expect(table.rows[2]).to.deep.equal({
				command: {t: "mono", v: "NICK"},
				count: {t: "number", v: 12},
				bytes: {t: "bytes", v: 73},
			});
		});

		it("c: connect blocks", function () {
			const table = tableOf(
				statsReport(
					"C",
					L(
						":srv 213 opr C hub.example.net * 192.0.2.10 4400 1 * Server",
						":srv 213 opr C leaf.example.net * leaf.example.net 4400 0 <NULL> LeafServer",
						END("C")
					),
					"STATS C"
				)
			);
			expect(table.rows[0]).to.deep.equal({
				name: {t: "server", v: "hub.example.net"},
				host: {t: "host", v: "192.0.2.10"},
				port: {t: "mono", v: "4400"},
				max: {t: "number", v: 1},
				hub: {t: "mono", v: "*"},
				class: {t: "text", v: "Server"},
			});
			expect(table.rows[1].hub).to.equal(undefined);
		});

		it("i: client blocks (live row) and a v6 mask with its 0 prefix", function () {
			const table = tableOf(
				statsReport(
					"I",
					L(
						":srv 215 nick I * 65535 * 0 Users",
						":srv 215 nick I *@* 10 0::1/128 6667 Local",
						END("I")
					),
					"STATS I"
				)
			);
			expect(table.rows[0]).to.deep.equal({
				host: {t: "host", v: "*"},
				max: {t: "number", v: 65535},
				ip: {t: "mono", v: "*"},
				port: {t: "mono", v: "0"},
				class: {t: "text", v: "Users"},
			});
			// The server writes `0::1/128` so the mask cannot be read as a trailing.
			expect(table.rows[1].ip).to.deep.equal({t: "ip", v: "::1/128"});
		});

		it("E: excepts with flag chips, and none", function () {
			const table = tableOf(
				statsReport(
					"E",
					L(
						":srv 223 opr E *@192.0.2.5 * gzI",
						":srv 223 opr E bot@*.example *",
						END("E")
					),
					"STATS E"
				)
			);
			expect(table.rows[0]).to.deep.equal({
				mask: {t: "host", v: "*@192.0.2.5"},
				flags: {t: "chips", v: ["G-line", "Z-line", "IPcheck"]},
			});
			expect(table.rows[1].flags).to.deep.equal({t: "chips", v: []});
		});

		it("F: features, set and default, with LOG lines and spaced values", function () {
			const report = statsReport(
				"F",
				L(
					":srv 238 opr F LOG SYSTEM FILE ircd.log",
					":srv 238 opr F NETWORK SeanceDev",
					":srv 238 opr F CAP_draft_event_playback TRUE",
					":srv 238 opr f HIS_SERVERINFO The Nefarious Network",
					":srv 238 opr f MAXCHANNELSPERUSER 20",
					":srv 238 opr f SOME_STRING",
					":srv 238 opr F LOG syslog",
					END("F")
				),
				"STATS F"
			);
			const table = tableOf(report);
			expect(report.title).to.equal("Features (all)");
			expect(table.rows[0]).to.deep.equal({
				name: {t: "mono", v: "LOG SYSTEM FILE"},
				value: {t: "mono", v: "ircd.log"},
				set: {t: "state", v: "set", ok: true},
			});
			expect(table.rows[1].value).to.deep.equal({t: "mono", v: "SeanceDev"});
			expect(table.rows[3]).to.deep.equal({
				name: {t: "mono", v: "HIS_SERVERINFO"},
				value: {t: "mono", v: "The Nefarious Network"},
				set: {t: "state", v: "default", ok: false},
			});
			expect(table.rows[5].value).to.deep.equal({t: "text", v: "not set"});
			expect(table.rows[6]).to.deep.equal({
				name: {t: "mono", v: "LOG"},
				value: {t: "mono", v: "syslog"},
				set: {t: "state", v: "set", ok: true},
			});
			expect(statsReport("f", L(END("f")), "STATS f").title).to.equal("Features (changed)");
		});

		it("q: quarantined channels", function () {
			const table = tableOf(
				statsReport("q", L(":srv 228 opr Q #warez :no warez here", END("q")), "STATS q")
			);
			expect(table.rows[0]).to.deep.equal({
				channel: {t: "channel", v: "#warez"},
				reason: {t: "text", v: "no warez here"},
			});
		});

		it("s: spoofed hosts, the non-oper's bare @", function () {
			const table = tableOf(
				statsReport(
					"s",
					L(
						":srv 245 opr 1 oper staff.example *@*.example",
						":srv 245 nick 2 user vhost.example @",
						END("s")
					),
					"STATS s"
				)
			);
			expect(table.rows[0]).to.deep.equal({
				index: {t: "number", v: 1},
				kind: {t: "text", v: "oper"},
				spoof: {t: "host", v: "staff.example"},
				mask: {t: "host", v: "*@*.example"},
			});
			expect(table.rows[1].mask).to.equal(undefined);
		});

		it("W: webirc blocks", function () {
			const table = tableOf(
				statsReport(
					"W",
					L(
						":srv 220 opr W *@192.0.2.80 * (none) ua :Example web gateway",
						":srv 220 opr W gw@gw.example * cgiirc * :",
						END("W")
					),
					"STATS W"
				)
			);
			expect(table.rows[0]).to.deep.equal({
				mask: {t: "host", v: "*@192.0.2.80"},
				ident: undefined,
				flags: {t: "chips", v: ["user ident", "trust account"]},
				description: {t: "text", v: "Example web gateway"},
			});
			expect(table.rows[1].ident).to.deep.equal({t: "mono", v: "cgiirc"});
			expect(table.rows[1].flags).to.deep.equal({t: "chips", v: []});
		});

		it("U: service servers", function () {
			const table = tableOf(
				statsReport("U", L(":srv 248 opr U services.example.net", END("U")), "STATS U")
			);
			expect(table.rows[0]).to.deep.equal({server: {t: "server", v: "services.example.net"}});
		});

		it("V: the machine-readable server list (live row)", function () {
			const report = statsReport(
				"V",
				L(
					":irc.seance.test 236 nick irc.seance.test irc.seance.test ----6- 0 AB 1 60000 0 0 0 1 4095 P10 1791564315 :Seance dev",
					":irc.seance.test 236 nick leaf.seance.test irc.seance.test BAH--O 1 AC 2 3 12 5 7 40 4095 P10 1791564400 :A leaf server",
					END("V")
				),
				"STATS V"
			);
			const table = tableOf(report);
			expect(report.title).to.equal("Servers");
			expect(table.rows[0]).to.deep.equal({
				server: {t: "server", v: "irc.seance.test"},
				uplink: {t: "server", v: "irc.seance.test"},
				flags: {t: "chips", v: ["IPv6"]},
				hops: {t: "number", v: 0},
				numeric: {t: "mono", v: "AB"},
				lag: {t: "number", v: 60000},
				rtt: {t: "number", v: 0},
				up: {t: "number", v: 0},
				down: {t: "number", v: 0},
				clients: {t: "number", v: 1},
				proto: {t: "text", v: "P10"},
				linkts: {t: "time", v: 1791564315 * 1000},
				info: {t: "text", v: "Seance dev"},
			});
			expect(table.rows[1].flags).to.deep.equal({
				t: "chips",
				v: ["bursting", "burst ack", "hub", "oplevels"],
			});
		});

		it("v: the human-readable form stays monospaced lines", function () {
			const report = statsReport(
				"v",
				L(
					":irc.seance.test 236 nick Servername           Uplink               Flags  Hops Numeric   Lag  RTT   Up Down Clients/Max Proto LinkTS     :Info",
					END("v")
				),
				"STATS v"
			);
			expect(report.sections.some((s) => s.table)).to.equal(false);
			expect(linesOf(report)).to.have.length(1);
		});

		it("T: MOTD files", function () {
			const table = tableOf(
				statsReport(
					"T",
					L(":srv 246 opr T *.example.net /etc/ircd/example.motd", END("T")),
					"STATS T"
				)
			);
			expect(table.rows[0]).to.deep.equal({
				mask: {t: "host", v: "*.example.net"},
				path: {t: "mono", v: "/etc/ircd/example.motd"},
			});
		});

		it("d / D: routing rules keep their spaces", function () {
			const table = tableOf(
				statsReport(
					"D",
					L(
						":srv 275 opr D *.eu.example connected(*.us.example) && !directcon(hub*)",
						END("D")
					),
					"STATS D"
				)
			);
			expect(table.rows[0]).to.deep.equal({
				kind: {t: "text", v: "all"},
				mask: {t: "mask", v: "*.eu.example"},
				rule: {t: "mono", v: "connected(*.us.example) && !directcon(hub*)"},
			});
			expect(statsReport("d", L(":srv 275 opr d * x", END("d")), "STATS d").title).to.equal(
				"Routing rules (masks)"
			);
		});

		it("L: modules (live row), the header skipped", function () {
			const table = tableOf(
				statsReport(
					"L",
					L(
						":srv 241 nick Module  Description      Entry Point",
						":srv 241 nick crypt_bcrypt  Bcrypt password hash ($2y$).     0xD3A83640",
						END("L")
					),
					"STATS L"
				)
			);
			expect(table.rows).to.deep.equal([
				{
					module: {t: "mono", v: "crypt_bcrypt"},
					description: {t: "text", v: "Bcrypt password hash ($2y$)."},
					entry: {t: "mono", v: "0xD3A83640"},
				},
			]);
		});

		it("e: the event engine (live row)", function () {
			const report = statsReport(
				"e",
				L(":srv 237 nick epoll() :Event loop engine", END("e")),
				"STATS e"
			);
			expect(report.title).to.equal("Event engine");
			expect(report.sections[0].entries).to.deep.equal([
				{label: "Engine", value: {t: "mono", v: "epoll()"}},
			]);
		});

		it("a: nameservers (live row)", function () {
			const table = tableOf(
				statsReport("a", L(":srv 226 nick 192.168.1.1", END("a")), "STATS a")
			);
			expect(table.rows[0]).to.deep.equal({ip: {t: "ip", v: "192.168.1.1"}});
		});

		it("R: mappings, the padded header skipped", function () {
			const table = tableOf(
				statsReport(
					"R",
					L(
						":srv 276 nick Command   Name      Prepend    Target",
						":srv 276 nick NICKSERV  NS        *          NickServ@services.example",
						END("R")
					),
					"STATS R"
				)
			);
			expect(table.rows).to.deep.equal([
				{
					command: {t: "mono", v: "NICKSERV"},
					name: {t: "mono", v: "NS"},
					prepend: undefined,
					target: {t: "text", v: "NickServ@services.example"},
				},
			]);
		});
	});

	describe("free text and subsystems", function () {
		it("t / r / j / x / z: 249 free text as monospaced lines", function () {
			const report = statsReport(
				"t",
				L(":srv 249 nick :accepts 9 refused 0", ":srv 249 nick :connected 3 1", END("t")),
				"STATS t"
			);
			expect(report.title).to.equal("Local traffic");
			expect(report.sections).to.deep.equal([
				{lines: ["accepts 9 refused 0", "connected 3 1"]},
			]);

			const r = statsReport(
				"r",
				L(":srv 249 nick :CPU Secs 0:1 User 0:0 System 0:0", END("r")),
				"STATS r"
			);
			expect(linesOf(r)).to.deep.equal(["CPU Secs 0:1 User 0:0 System 0:0"]);

			const j = statsReport(
				"j",
				L(
					":srv 249 nick :Histogram of message lengths (12 messages)",
					":srv 249 nick :   0: 1 2 3",
					END("j")
				),
				"STATS j"
			);
			expect(linesOf(j)).to.have.length(2);
			expect(j.sections.some((s) => s.entries)).to.equal(false);
		});

		it("webpush: title, key/value entries, the key ring lines kept", function () {
			const report = statsReport(
				"webpush",
				L(
					":srv 249 nick W :WEBPUSH VAPID key ring",
					":srv 249 nick W :  Store: available, ring loaded",
					":srv 249 nick W :  Delivery: libkc HTTP transport ready",
					":srv 249 nick W :  Subscriptions: ~12, store 4096 bytes",
					":srv 249 nick W :  Current key: abc123",
					":srv 249 nick W :  Key abc123def4567890... gen 2 created 1791560000 origin config refs 3 (current)",
					END("webpush")
				),
				"STATS webpush"
			);
			expect(report.title).to.equal("Web push");
			expect(report.sections).to.have.length(1);
			const section = report.sections[0];
			expect(section.title).to.equal("WEBPUSH VAPID key ring");
			expect(section.entries).to.deep.equal([
				{label: "Store", value: {t: "text", v: "available, ring loaded"}},
				{label: "Delivery", value: {t: "text", v: "libkc HTTP transport ready"}},
				{label: "Subscriptions", value: {t: "text", v: "~12, store 4096 bytes"}},
				{label: "Current key", value: {t: "text", v: "abc123"}},
			]);
			expect(section.lines).to.deep.equal([
				"Key abc123def4567890... gen 2 created 1791560000 origin config refs 3 (current)",
			]);
		});

		it("dnsbl / chathistory / metadata: live samples, numbers typed", function () {
			const dnsbl = statsReport(
				"dnsbl",
				L(
					":srv 249 nick D :DNSBL Statistics",
					":srv 249 nick D :  Enabled: NO",
					":srv 249 nick D :  Total lookups: 17",
					END("dnsbl")
				),
				"STATS dnsbl"
			);
			expect(dnsbl.sections[0].title).to.equal("DNSBL Statistics");
			expect(dnsbl.sections[0].entries).to.deep.equal([
				{label: "Enabled", value: {t: "text", v: "NO"}},
				{label: "Total lookups", value: {t: "number", v: 17}},
			]);

			const history = statsReport(
				"CHATHISTORY",
				L(
					":srv 249 nick H :CHATHISTORY Statistics",
					":srv 249 nick H :  Backend: RocksDB (available)",
					END("CHATHISTORY")
				),
				"STATS CHATHISTORY"
			);
			expect(history.title).to.equal("Chathistory storage");
			expect(history.sections[0].entries?.[0]).to.deep.equal({
				label: "Backend",
				value: {t: "text", v: "RocksDB (available)"},
			});

			const metadata = statsReport(
				"metadata",
				L(
					":srv 249 nick M :METADATA Statistics",
					":srv 249 nick M :  Read markers: ~0 entries",
					END("metadata")
				),
				"STATS metadata"
			);
			expect(metadata.sections[0].entries?.[0].label).to.equal("Read markers");
		});

		it("chathistoryads: unindented Key: value lines are entries too", function () {
			const report = statsReport(
				"A",
				L(
					":srv 249 nick A :Chathistory Federation Advertisements",
					":srv 249 nick A :  hub.example: STORE retention=7 days (updated 12s ago)",
					":srv 249 nick A :Summary: 1 storage server(s) of 2 advertised",
					":srv 249 nick A :Local: STORE enabled, retention=7 days",
					END("A")
				),
				"STATS A"
			);
			expect(report.title).to.equal("Chathistory federation");
			expect(report.sections[0].entries?.map((e) => e.label)).to.deep.equal([
				"hub.example",
				"Summary",
				"Local",
			]);
		});

		it("authtoken: a key line starts a block, PEM lines are kept", function () {
			const report = statsReport(
				"authtoken",
				L(
					":srv 249 nick A :AUTHTOKEN services: 1, outstanding tokens: 0, expire 600 s",
					":srv 249 nick A :FILEHOST https://files.example/up jwt pass :File host",
					":srv 249 nick A :  -----BEGIN PUBLIC KEY-----",
					":srv 249 nick A :  MIIBIjANBgkq",
					":srv 249 nick A :  -----END PUBLIC KEY-----",
					END("authtoken")
				),
				"STATS authtoken"
			);
			expect(report.sections).to.have.length(2);
			expect(report.sections[0].title).to.equal(
				"AUTHTOKEN services: 1, outstanding tokens: 0, expire 600 s"
			);
			expect(report.sections[1].title).to.equal(
				"FILEHOST https://files.example/up jwt pass :File host"
			);
			expect(report.sections[1].lines).to.deep.equal([
				"-----BEGIN PUBLIC KEY-----",
				"MIIBIjANBgkq",
				"-----END PUBLIC KEY-----",
			]);
		});

		it("gitsync: untagged lines, the title's colon dropped", function () {
			const report = statsReport(
				"gitsync",
				L(
					":srv 249 nick :GitSync Statistics:",
					":srv 249 nick :  Status: Enabled",
					":srv 249 nick :  Successful syncs: 4",
					END("gitsync")
				),
				"STATS gitsync"
			);
			expect(report.sections[0]).to.deep.equal({
				title: "GitSync Statistics",
				entries: [
					{label: "Status", value: {t: "text", v: "Enabled"}},
					{label: "Successful syncs", value: {t: "number", v: 4}},
				],
			});
		});
	});

	describe("never drops content", function () {
		it("keeps rows that do not parse as lines under the table", function () {
			const report = statsReport(
				"o",
				L(
					":srv 243 opr O *@* * seanceop Opers",
					":srv 243 opr garbage",
					":srv NOTICE opr :stray",
					END("o")
				),
				"STATS o"
			);
			expect(tableOf(report).rows).to.have.length(1);
			expect(linesOf(report)).to.deep.equal(["garbage", "stray"]);
		});

		it("drops the 219 and BATCH framing from raw-to-sections but keeps raw", function () {
			const lines = L(
				"@label=L1 :srv BATCH +AA labeled-response",
				":srv 243 opr O *@* * seanceop Opers",
				END("o"),
				":srv BATCH -AA"
			);
			const report = statsReport("o", lines, "STATS o");
			expect(linesOf(report)).to.deep.equal([]);
			expect(report.raw).to.have.length(4);
		});

		it("an unknown shape for a known selector falls back to lines", function () {
			const report = statsReport(
				"uptime",
				L(":srv 249 nick :whatever", END("uptime")),
				"STATS uptime"
			);
			expect(linesOf(report)).to.deep.equal(["whatever"]);
		});
	});
});
