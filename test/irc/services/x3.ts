import {expect} from "chai";
import {cleanIrcMessage} from "../../../shared/irc";
import {servicesProfileById, serviceNicksOf} from "../../../client/js/irc/services/index";
import {
	auditCoarse,
	banCommand,
	isServiceNick,
	parseAudit,
	parseBanReply,
	parseModuleLog,
	parseSnoop,
	x3,
	X3_DEFAULTS,
	x3Duration,
} from "../../../client/js/irc/services/x3";

/** A line as X3 sends it (`$b` expanded to \x02), then stripped as the feed does. */
const B = "\x02";
const strip = (text: string) => cleanIrcMessage(text);

// Every fixture is the format in docs/resources/x3-services.md §3, with the
// bold bytes X3 puts around the keyword.
const SNOOP = {
	nickChange: `[21:14:02] ${B}NICK${B} change alice -> alice_away`,
	join: `[21:14:03] ${B}JOIN${B} #seance by alice`,
	create: `[21:14:04] ${B}CREATE${B} #new by bob`,
	part: `[21:14:05] ${B}PART${B} #seance by alice (Leaving (for now))`,
	partNoReason: `[21:14:05] ${B}PART${B} #seance by alice ()`,
	kick: `[21:14:06] ${B}KICK${B} troll from #seance by alice`,
	kickServer: `[21:14:06] ${B}KICK${B} troll from #seance by irc.afternet.org`,
	connect: `[21:14:07] ${B}NICK${B} carol ~carol@203.0.113.9.example (carol) [203.0.113.9] on irc.afternet.org`,
	connectUnauthed: `[21:14:07] ${B}NICK${B} dave ~d@host.example () [203.0.113.10] on irc.afternet.org`,
	kill: `[21:14:08] ${B}KILL${B} troll (~t@203.0.113.7, on irc.afternet.org) by O3 (Excessive connections from a single host.)`,
	quit: `[21:14:09] ${B}QUIT${B} alice (~alice@host.example, on irc.afternet.org) (Quit: bye (for now))`,
	auth: `[21:14:10] ${B}AUTH${B} alice as alice`,
	umode: `[21:14:11] ${B}UMODE${B} alice +ix`,
	oper: `[21:14:12] ${B}OPER${B} rubin!~r@h.example [203.0.113.5] on irc.afternet.org`,
	mode: `[21:14:13] ${B}MODE${B} #seance +o-v alice bob by ChanServ`,
	modeNoArgs: `[21:14:14] ${B}MODE${B} #seance +m by alice`,
};

// The shape of AfterNET's own feed (2026-10-11; the values made up): for a
// connecting user the UMODE line comes first and, with `+x` among the
// modes, carries the cloaked host and the cloaked IP after them; the NICK
// line has the empty `()` of a user not authed and the server's mixed case.
const AFTERNET = {
	umodeCloak: `[17:07:07] ${B}UMODE${B} clonebot7 +xzCc AN-1A2B3C4D.example.net ABCDEF.123456.7890AB.CDEF01.IP`,
	connect: `[17:07:07] ${B}NICK${B} clonebot7 probe@host12.example.net () [192.0.2.10] on Hub.Example.Org`,
	umodeCloak2: `[17:10:12] ${B}UMODE${B} probe9 +xCc AN-5E6F7A8B.example.net 0F1E2D.3C4B5A.697887.7A6B5C.IP`,
	connect2: `[17:10:12] ${B}NICK${B} probe9 probe9@host34.example.net () [198.51.100.23] on Hub.Example.Org`,
};

describe("X3 services profile (irc/services/x3)", function () {
	it("is registered under its id with the usual names", function () {
		expect(servicesProfileById("x3")).to.equal(x3);
		expect(servicesProfileById("nope")).to.equal(undefined);
		expect(servicesProfileById(undefined)).to.equal(undefined);
		expect(x3.defaults).to.deep.equal(X3_DEFAULTS);
		expect(X3_DEFAULTS).to.deep.equal({
			oper: "O3",
			account: "AuthServ",
			channel: "ChanServ",
			report: "#operserv",
			snoop: "#mrsnoopy",
		});
	});

	describe("the snoop feed (§3)", function () {
		it("parses every keyword with its fields", function () {
			expect(parseSnoop(strip(SNOOP.nickChange))).to.deep.equal({
				keyword: "nick",
				fields: {nick: "alice", newNick: "alice_away"},
			});
			expect(parseSnoop(strip(SNOOP.join))).to.deep.equal({
				keyword: "join",
				fields: {channel: "#seance", nick: "alice"},
			});
			expect(parseSnoop(strip(SNOOP.create))).to.deep.equal({
				keyword: "create",
				fields: {channel: "#new", nick: "bob"},
			});
			expect(parseSnoop(strip(SNOOP.part))).to.deep.equal({
				keyword: "part",
				fields: {channel: "#seance", nick: "alice", reason: "Leaving (for now)"},
			});
			expect(parseSnoop(strip(SNOOP.partNoReason))?.fields.reason).to.equal("");
			expect(parseSnoop(strip(SNOOP.kick))).to.deep.equal({
				keyword: "kick",
				fields: {nick: "troll", channel: "#seance", kicker: "alice"},
			});
			expect(parseSnoop(strip(SNOOP.kickServer))?.fields.kicker).to.equal("irc.afternet.org");
			expect(parseSnoop(strip(SNOOP.connect))).to.deep.equal({
				keyword: "connect",
				fields: {
					nick: "carol",
					ident: "~carol",
					host: "203.0.113.9.example",
					account: "carol",
					ip: "203.0.113.9",
					server: "irc.afternet.org",
				},
			});
			expect(parseSnoop(strip(SNOOP.connectUnauthed))?.fields).to.include({
				nick: "dave",
				account: "",
				ip: "203.0.113.10",
			});
			expect(parseSnoop(strip(SNOOP.kill))).to.deep.equal({
				keyword: "kill",
				fields: {
					nick: "troll",
					ident: "~t",
					host: "203.0.113.7",
					server: "irc.afternet.org",
					killer: "O3",
					reason: "Excessive connections from a single host.",
				},
			});
			expect(parseSnoop(strip(SNOOP.quit))).to.deep.equal({
				keyword: "quit",
				fields: {
					nick: "alice",
					ident: "~alice",
					host: "host.example",
					server: "irc.afternet.org",
					reason: "Quit: bye (for now)",
				},
			});
			expect(parseSnoop(strip(SNOOP.auth))).to.deep.equal({
				keyword: "auth",
				fields: {nick: "alice", account: "alice"},
			});
			expect(parseSnoop(strip(SNOOP.umode))).to.deep.equal({
				keyword: "umode",
				fields: {nick: "alice", modes: "+ix"},
			});
			expect(parseSnoop(strip(SNOOP.oper))).to.deep.equal({
				keyword: "oper",
				fields: {
					nick: "rubin",
					ident: "~r",
					host: "h.example",
					ip: "203.0.113.5",
					server: "irc.afternet.org",
				},
			});
			expect(parseSnoop(strip(SNOOP.mode))).to.deep.equal({
				keyword: "mode",
				fields: {channel: "#seance", modes: "+o-v alice bob", setter: "ChanServ"},
			});
			expect(parseSnoop(strip(SNOOP.modeNoArgs))?.fields).to.deep.equal({
				channel: "#seance",
				modes: "+m",
				setter: "alice",
			});
		});

		it("takes AfterNET's UMODE with the cloak pair after the modes, as cloak and cloakIp", function () {
			expect(parseSnoop(strip(AFTERNET.umodeCloak))).to.deep.equal({
				keyword: "umode",
				fields: {
					nick: "clonebot7",
					modes: "+xzCc",
					cloak: "AN-1A2B3C4D.example.net",
					cloakIp: "ABCDEF.123456.7890AB.CDEF01.IP",
				},
			});
			expect(parseSnoop(strip(AFTERNET.umodeCloak2))).to.deep.equal({
				keyword: "umode",
				fields: {
					nick: "probe9",
					modes: "+xCc",
					cloak: "AN-5E6F7A8B.example.net",
					cloakIp: "0F1E2D.3C4B5A.697887.7A6B5C.IP",
				},
			});

			// Never as a host or an IP: a cloak is not a place the cards compare.
			const fields = parseSnoop(strip(AFTERNET.umodeCloak))!.fields;
			expect(fields).to.not.have.any.keys("host", "ip");

			// Three words after the nick is neither form.
			expect(parseSnoop("[17:07:07] UMODE clonebot7 +x a b c")).to.equal(undefined);
		});

		it("takes AfterNET's connect lines: not authed, a mixed-case server", function () {
			expect(parseSnoop(strip(AFTERNET.connect))).to.deep.equal({
				keyword: "connect",
				fields: {
					nick: "clonebot7",
					ident: "probe",
					host: "host12.example.net",
					account: "",
					ip: "192.0.2.10",
					server: "Hub.Example.Org",
				},
			});
			expect(parseSnoop(strip(AFTERNET.connect2))?.fields).to.include({
				nick: "probe9",
				ident: "probe9",
				ip: "198.51.100.23",
				server: "Hub.Example.Org",
			});
		});

		it("does not match chat, a notice from a user, or an audit line", function () {
			expect(parseSnoop("hello everyone")).to.equal(undefined);
			expect(parseSnoop("[21:14:02] JOIN #seance by alice extra words")).to.equal(undefined);
			expect(parseSnoop("JOIN #seance by alice")).to.equal(undefined);
			expect(parseSnoop("[21:14:02] HELLO #seance by alice")).to.equal(undefined);
			expect(parseSnoop("() [rubin!~r@h:rubin]: gline *@1.2.3.4 1h spamming")).to.equal(
				undefined
			);
			expect(parseSnoop("")).to.equal(undefined);
		});
	});

	describe("the audit log (§4)", function () {
		it("parses a line with and without a channel and an account", function () {
			expect(parseAudit("() [Rubin!~r@h:rubin]: gline *@1.2.3.4 1h spamming")).to.deep.equal({
				channel: "",
				nick: "Rubin",
				ident: "~r",
				host: "h",
				account: "rubin",
				command: "gline",
				args: "*@1.2.3.4 1h spamming",
				coarse: "glines",
			});
			expect(parseAudit("(#foo) [n!i@h:acct]: clearbans")).to.deep.equal({
				channel: "#foo",
				nick: "n",
				ident: "i",
				host: "h",
				account: "acct",
				command: "clearbans",
				args: "",
				coarse: "modes",
			});
			expect(parseAudit("() [n!i@h]: stats x")).to.deep.equal({
				channel: "",
				nick: "n",
				ident: "i",
				host: "h",
				command: "stats",
				args: "x",
				coarse: "other",
			});
			expect(parseAudit("() [Rubin!~r@h:rubin]: god on")).to.include({
				command: "god",
				args: "on",
				coarse: "opers",
			});
			expect(parseAudit("() [Rubin!~r@h:rubin]: addalert foo notice nick bar*")).to.include({
				command: "addalert",
				coarse: "alerts",
			});
			expect(parseAudit("() [Rubin!~r@h:rubin]: GLINE *@1.2.3.4 1h x")?.command).to.equal(
				"gline"
			);
		});

		it("classifies the commands an oper cares about", function () {
			for (const c of ["gline", "ungline", "block", "refreshg", "shun", "sblock", "unshun"]) {
				expect(auditCoarse(c, ""), c).to.equal("glines");
			}

			expect(auditCoarse("trace", "gline nick foo*")).to.equal("glines");
			expect(auditCoarse("trace", "shun ip 1.2.*")).to.equal("glines");
			expect(auditCoarse("trace", "kill nick foo*")).to.equal("kills");
			expect(auditCoarse("trace", "print nick foo*")).to.equal("other");

			for (const c of ["clearbans", "clearmodes", "op", "deop", "kick", "mode", "invite"]) {
				expect(auditCoarse(c, ""), c).to.equal("modes");
			}

			expect(auditCoarse("god", "on")).to.equal("opers");
			expect(auditCoarse("addalert", "x")).to.equal("alerts");
			expect(auditCoarse("delalert", "x")).to.equal("alerts");
			expect(auditCoarse("rehash", "")).to.equal("rehash");
			expect(auditCoarse("die", "")).to.equal("rehash");
			expect(auditCoarse("restart", "")).to.equal("rehash");
			expect(auditCoarse("whois", "x")).to.equal("other");
			expect(auditCoarse("oset", "x password y")).to.equal("other");
		});

		it("does not match chat or a snoop line", function () {
			expect(parseAudit("hello everyone")).to.equal(undefined);
			expect(parseAudit("(not a channel) [n!i@h]: x")).to.equal(undefined);
			expect(parseAudit("() [n!i@h]:")).to.equal(undefined);
			expect(parseAudit("() [n!i@h]: ")).to.equal(undefined);
			expect(parseAudit("[21:14:03] JOIN #seance by alice")).to.equal(undefined);
			expect(parseAudit("[rubin!~r@h:rubin]: gline x")).to.equal(undefined);
		});
	});

	it("parses a module log line (`<Facility> <severity>: <message>`)", function () {
		expect(parseModuleLog("OpServ info: Found alice in bad-word channel #x")).to.deep.equal({
			facility: "OpServ",
			severity: "info",
			message: "Found alice in bad-word channel #x",
		});
		expect(parseModuleLog("x3 error: something broke: badly")).to.deep.equal({
			facility: "x3",
			severity: "error",
			message: "something broke: badly",
		});
		expect(parseModuleLog("alice says: hello")).to.equal(undefined);
		expect(parseModuleLog("OpServ loud: x")).to.equal(undefined);
		expect(parseModuleLog("() [n!i@h]: gline x")).to.equal(undefined);
	});

	describe("bans through O3 (§7)", function () {
		it("writes durations in X3's units", function () {
			expect(x3Duration(3600)).to.equal("1h");
			expect(x3Duration(90)).to.equal("1m30s");
			expect(x3Duration(86400 + 3600)).to.equal("1d1h");
			expect(x3Duration(7 * 86400)).to.equal("1w");
			expect(x3Duration(0)).to.equal("0s");
			expect(x3Duration(-5)).to.equal("0s");
		});

		it("builds the command as a PRIVMSG to the bot, reason last", function () {
			expect(
				banCommand("O3", {
					type: "gline",
					mask: "*@1.2.3.4",
					seconds: 3600,
					reason: "spamming",
				})
			).to.equal("PRIVMSG O3 :gline *@1.2.3.4 1h spamming");
			expect(
				banCommand("O3", {type: "shun", mask: "*@h.example", seconds: 60, reason: "a b c"})
			).to.equal("PRIVMSG O3 :shun *@h.example 1m a b c");
		});

		it("recognises O3's replies, bold stripped", function () {
			expect(parseBanReply(strip(`G-line issued for ${B}*@1.2.3.4${B}.`))).to.deep.equal({
				ok: true,
				mask: "*@1.2.3.4",
				text: "G-line issued for *@1.2.3.4.",
			});
			expect(parseBanReply("Shun issued for *@h.example.")).to.include({
				ok: true,
				mask: "*@h.example",
			});
			expect(parseBanReply("Invalid G-line '*@1.2.3.0/24'.")).to.deep.equal({
				ok: false,
				mask: "*@1.2.3.0/24",
				text: "Invalid G-line '*@1.2.3.0/24'.",
			});
			expect(parseBanReply(strip(`Gline *@*? Now ${B}that${B} would be smooth.`))).to.include(
				{
					ok: false,
					mask: "*@*",
				}
			);
			expect(parseBanReply("Gline *@*?  Now that would be smooth.")?.ok).to.equal(false);
			expect(parseBanReply("Invalid time span '1x'.")).to.include({ok: false, mask: "1x"});
			expect(parseBanReply("Access denied.")).to.deep.equal({
				ok: false,
				text: "Access denied.",
			});
			expect(parseBanReply("G-line removed for *@1.2.3.4.")?.ok).to.equal(true);
			expect(parseBanReply("O3 is a privileged service.")).to.equal(undefined);
			expect(parseBanReply("hello")).to.equal(undefined);
		});
	});

	it("knows its bots by nick, case-insensitively, and leaves blanks out", function () {
		expect(isServiceNick("o3", X3_DEFAULTS)).to.equal(true);
		expect(isServiceNick("ChanServ", X3_DEFAULTS)).to.equal(true);
		expect(isServiceNick("alice", X3_DEFAULTS)).to.equal(false);
		expect(isServiceNick("", {...X3_DEFAULTS, account: ""})).to.equal(false);
		expect(serviceNicksOf({package: "x3", bots: {...X3_DEFAULTS, account: ""}})).to.deep.equal([
			"O3",
			"ChanServ",
		]);
		expect(serviceNicksOf(undefined)).to.deep.equal([]);
	});
});
