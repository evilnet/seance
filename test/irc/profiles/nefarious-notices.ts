import {expect} from "chai";
import {
	classifyNotice,
	NOTICE_KINDS,
	RULE_KINDS,
} from "../../../client/js/irc/profiles/nefarious/notices";
import {NEFARIOUS_SNOMASK} from "../../../client/js/irc/profiles/nefarious/snomask";

type Case = [text: string, kind: string, category: string, fields?: Record<string, string>];

/**
 * One line per kind at least, built from the format strings in the
 * nefarious2 source (docs/resources/nefarious2-oper.md §5). The first four
 * were captured live from the dev rig.
 */
const CASES: Case[] = [
	// --- captured live (2026-10-09, tools/nefarious-dev)
	[
		"opr (opr@172.17.0.1) is now a global operator (O)",
		"oper.up",
		"OLDSNO",
		{nick: "opr", user: "opr", host: "opr@172.17.0.1", level: "global"},
	],
	[
		"Received KILL message for victim[@172.17.0.1] from opr Path: 172.17.0.1!opr (testing kill)",
		"kill.oper",
		"OPERKILL",
		{
			nick: "victim",
			ip: "172.17.0.1",
			killer: "opr",
			path: "172.17.0.1!opr",
			reason: "testing kill",
		},
	],
	[
		"opr adding local JUPE for badnick, expiring at 1791565027: reserved",
		"jupe.add",
		"NETWORK",
		{oper: "opr", scope: "local", target: "badnick", expires: "1791565027", reason: "reserved"},
	],
	[
		"HACK(4): opr MODE #seance +m [1791564392]",
		"hack.mode",
		"HACK4",
		{nick: "opr", channel: "#seance", modes: "+m", ts: "1791564392", level: "4"},
	],

	// --- clients
	[
		"Client connecting: alice (~alice@cpe-203-0-113-7.example.net) [203.0.113.7] {Users} [Alice [the] Example] <ABAAC>",
		"client.connect",
		"CONNEXIT",
		{
			nick: "alice",
			user: "~alice",
			host: "~alice@cpe-203-0-113-7.example.net",
			ip: "203.0.113.7",
			class: "Users",
			realname: "Alice [the] Example",
			numnick: "ABAAC",
		},
	],
	[
		"Client exiting: alice (~alice@cpe.example.net) [Quit: brb [phone]] [203.0.113.7] <ABAAC>",
		"client.exit",
		"CONNEXIT",
		{
			nick: "alice",
			host: "~alice@cpe.example.net",
			reason: "Quit: brb [phone]",
			ip: "203.0.113.7",
		},
	],
	[
		"Nick change: From alice to alice_ [~alice@cpe.example.net] <ABAAC>",
		"nick.change",
		"NICKCHG",
		{nick: "alice", newNick: "alice_", host: "~alice@cpe.example.net", numnick: "ABAAC"},
	],
	[
		"WEBIRC Client host: from gw.example.net [198.51.100.9] to user.example.org [203.0.113.40]",
		"webirc.host",
		"WEBIRC",
		{
			gateway: "gw.example.net",
			gatewayIp: "198.51.100.9",
			host: "user.example.org",
			ip: "203.0.113.40",
		},
	],
	[
		"WEBIRC Attempt with invalid IP address from gw.example.net [198.51.100.9]",
		"webirc.invalid",
		"WEBIRC",
		{what: "IP address", host: "gw.example.net", ip: "198.51.100.9"},
	],
	[
		"WEBIRC Attempt unauthorized from gw.example.net [198.51.100.9]",
		"webirc.unauthorized",
		"WEBIRC",
		{host: "gw.example.net", ip: "198.51.100.9"},
	],
	[
		"Config parse error in file ircd.conf on line 42: syntax error",
		"config.error",
		"WEBIRC",
		{file: "ircd.conf", line: "42", message: "syntax error"},
	],

	// --- kills and hits
	[
		"Received KILL message for bob from hub.example.net Path: hub.example.net!hub.example.net (Nick collision)",
		"kill.server",
		"SERVKILL",
		{nick: "bob", server: "hub.example.net", reason: "Nick collision"},
	],
	[
		"Received KILL message for carol from opr2 Path: leaf.example.net!opr2 (spamming)",
		"kill.oper",
		"OPERKILL",
		{nick: "carol", killer: "opr2", reason: "spamming"},
	],
	[
		"G-line active for spammer[~bot@203.0.113.66]",
		"ban.hit",
		"GLINE",
		{type: "G-line", nick: "spammer", user: "~bot", ip: "203.0.113.66"},
	],
	[
		"K-line active for Unregistered Client *[@203.0.113.67]",
		"ban.hit",
		"OPERKILL",
		{type: "K-line", nick: "*", ip: "203.0.113.67", unregistered: "yes"},
	],
	[
		"Z-line active for zz[@203.0.113.68]",
		"ban.hit",
		"GLINE",
		{type: "Z-line", ip: "203.0.113.68"},
	],
	["Shun active for remoteuser", "ban.hit", "GLINE", {type: "Shun", nick: "remoteuser"}],
	[
		"GLINE [INFO]: Shun match: mask=*@203.0.113.0/24 reason=no spam please victim=bot!~bot@x.example ip=203.0.113.5 sockhost=x.example host=x.example realhost=x.example matched_via=cidr matched_value=203.0.113.5",
		"shun.match",
		"GLINE",
		{
			mask: "*@203.0.113.0/24",
			reason: "no spam please",
			nick: "bot",
			ip: "203.0.113.5",
			via: "cidr",
		},
	],

	// --- bans being changed
	[
		"opr adding global GLINE for *@203.0.113.7, expiring at 1791650000: spam bots",
		"ban.add",
		"GLINE",
		{
			oper: "opr",
			scope: "global",
			type: "G-line",
			mask: "*@203.0.113.7",
			expires: "1791650000",
			reason: "spam bots",
		},
	],
	[
		"services.example.net adding deactivated local BADCHAN for #warez, expiring at 1791650000: AUTO no warez",
		"ban.add",
		"AUTO",
		{
			server: "services.example.net",
			state: "deactivated ",
			scope: "local",
			type: "channel ban",
			mask: "#warez",
		},
	],
	[
		"opr adding global SHUN for $Rfree?money, expiring at 1791650000: spam",
		"ban.add",
		"GLINE",
		{type: "shun", mask: "$Rfree?money"},
	],
	[
		"opr adding local ZLINE for 203.0.113.0/24, expiring at 1791650000: scanners",
		"ban.add",
		"GLINE",
		{type: "Z-line", scope: "local", mask: "203.0.113.0/24"},
	],
	[
		"opr activating global GLINE for *@203.0.113.7, expiring at 1791650000: spam bots",
		"ban.activate",
		"GLINE",
		{oper: "opr", type: "G-line", mask: "*@203.0.113.7", expires: "1791650000"},
	],
	[
		"opr deactivating global SHUN for *@203.0.113.7, expiring at 1791650000: spam",
		"ban.deactivate",
		"GLINE",
		{oper: "opr", action: "deactivated", scope: "global", type: "shun", mask: "*@203.0.113.7"},
	],
	[
		"hub.example.net removing local ZLINE for 203.0.113.9, expiring at 1791650000: oops",
		"ban.deactivate",
		"GLINE",
		{
			server: "hub.example.net",
			action: "removed",
			scope: "local",
			type: "Z-line",
			mask: "203.0.113.9",
		},
	],
	[
		'opr modifying global GLINE for *@203.0.113.7: globally activating G-line; changing expiration time to 1791660000 and changing reason to "still spam"',
		"ban.modify",
		"GLINE",
		{
			oper: "opr",
			type: "G-line",
			mask: "*@203.0.113.7",
			changes:
				' globally activating G-line; changing expiration time to 1791660000 and changing reason to "still spam"',
		},
	],
	[
		'opr modifying global ZLINE for 203.0.113.9: changing reason to "AUTO scanner"',
		"ban.modify",
		"AUTO",
		{type: "Z-line", mask: "203.0.113.9"},
	],
	[
		"opr removing local GLINE for baduser@*",
		"ban.remove",
		"GLINE",
		{oper: "opr", scope: "local", type: "G-line", mask: "baduser@*"},
	],
	[
		"opr force removing GLINE for *@203.0.113.7 (mistake)",
		"ban.forceremove",
		"GLINE",
		{oper: "opr", type: "G-line", mask: "*@203.0.113.7", reason: "mistake"},
	],
	// The setter is a server name when a server or services set it (or with
	// HIS_SNOTICES off): it goes in `server`, not `oper`.
	[
		"services.example.net activating global BADCHAN for #warez, expiring at 1791650000: no",
		"ban.activate",
		"GLINE",
		{server: "services.example.net", type: "channel ban", mask: "#warez"},
	],
	[
		"services.example.net modifying global SHUN for *@203.0.113.7: changing expiration time to 1791660000",
		"ban.modify",
		"GLINE",
		{server: "services.example.net", type: "shun"},
	],
	[
		"leaf.example.net removing local SHUN for *@203.0.113.8",
		"ban.remove",
		"GLINE",
		{server: "leaf.example.net", type: "shun"},
	],
	[
		"hub.example.net force removing ZLINE for 203.0.113.9 (cleanup)",
		"ban.forceremove",
		"GLINE",
		{server: "hub.example.net", type: "Z-line", reason: "cleanup"},
	],
	[
		"Temporary shun applied to troll[~t@203.0.113.80] (calm down)",
		"tempshun.apply",
		"GLINE",
		{nick: "troll", user: "~t", ip: "203.0.113.80", reason: "calm down"},
	],
	[
		"Temporary shun removed from troll (no reason)",
		"tempshun.remove",
		"GLINE",
		{nick: "troll", reason: "no reason"},
	],
	[
		"DNSBL blocked connection from bot (unknown@203.0.113.90) [203.0.113.90]",
		"dnsbl.block",
		"GLINE",
		{nick: "bot", user: "unknown", host: "unknown@203.0.113.90", ip: "203.0.113.90"},
	],
	[
		"DNSBL blocked anonymous connection from bot (unknown@x.example) [203.0.113.91]",
		"dnsbl.block",
		"GLINE",
		{anonymous: "yes", ip: "203.0.113.91"},
	],

	// --- jupes
	[
		"hub.example.net adding JUPE for evil.example.net, expiring at 1791650000: rogue",
		"jupe.add",
		"NETWORK",
		{server: "hub.example.net", scope: "global", target: "evil.example.net"},
	],
	[
		"opr activating JUPE for evil.example.net, expiring at 1791650000: rogue",
		"jupe.activate",
		"NETWORK",
		{oper: "opr", target: "evil.example.net", expires: "1791650000", reason: "rogue"},
	],
	[
		"hub.example.net activating JUPE for evil.example.net, expiring at 1791650000: rogue",
		"jupe.activate",
		"NETWORK",
		{server: "hub.example.net"},
	],
	[
		"hub.example.net deactivating JUPE for evil.example.net, expiring at 1791650000: rogue",
		"jupe.deactivate",
		"NETWORK",
		{server: "hub.example.net", action: "deactivated"},
	],
	[
		"opr deactivating JUPE for evil.example.net, expiring at 1791650000: rogue",
		"jupe.deactivate",
		"NETWORK",
		{oper: "opr", action: "deactivated", target: "evil.example.net"},
	],
	[
		"opr removing local JUPE for badnick, expiring at 1791565027: reserved",
		"jupe.deactivate",
		"NETWORK",
		{action: "removed", target: "badnick"},
	],

	// --- opers
	[
		"lop (lop@10.0.0.2) is now a local operator (o)",
		"oper.up",
		"OLDSNO",
		{nick: "lop", level: "local", role: "a local operator"},
	],
	// X3's auto-oper on login, relayed from the services server.
	[
		"rubin (rubin@afternet.org) is now an IRC Operator",
		"oper.up",
		"OLDSNO",
		{nick: "rubin", host: "rubin@afternet.org", level: "global", role: "an IRC operator"},
	],
	[
		"rubin (rubin@afternet.org) is now an IRC Administrator",
		"oper.up",
		"OLDSNO",
		{level: "admin", role: "an IRC administrator"},
	],
	[
		"Failed OPER attempt by mallory (~m@203.0.113.13) (password mis-match)",
		"oper.fail",
		"OLDREALOP",
		{nick: "mallory", host: "~m@203.0.113.13", reason: "password mis-match"},
	],
	[
		"Failed remote OPER attempt by mallory (~m@203.0.113.13) (no remote oper priv)",
		"oper.fail",
		"OLDREALOP",
		{remote: "remote ", reason: "no remote oper priv"},
	],
	[
		"Failed OPER attempt by mallory (~m@203.0.113.13) (attach failed after async)",
		"oper.fail",
		"OLDREALOP",
		{reason: "attach failed after async"},
	],
	[
		"opr used BOUNCER ORESET on session k3J9xQ (account alice)",
		"bouncer.oreset",
		"OLDSNO",
		{oper: "opr", session: "k3J9xQ", account: "alice"},
	],
	[
		"nosy (~n@203.0.113.20) did a /whois on you.",
		"whois.notify",
		"WHOIS",
		{nick: "nosy", host: "~n@203.0.113.20"},
	],

	// --- links and the network
	[
		"Net junction: hub.example.net leaf.example.net",
		"net.junction",
		"NETWORK",
		{uplink: "hub.example.net", server: "leaf.example.net"},
	],
	[
		"Net break: hub.example.net leaf.example.net (Ping timeout)",
		"net.break",
		"NETWORK",
		{uplink: "hub.example.net", server: "leaf.example.net", reason: "Ping timeout"},
	],
	[
		"Completed net.burst from leaf.example.net.",
		"net.burst",
		"NETWORK",
		{server: "leaf.example.net"},
	],
	[
		"leaf.example.net acknowledged end of net.burst.",
		"net.burstack",
		"NETWORK",
		{server: "leaf.example.net"},
	],
	[
		"Timestamp drift from leaf.example.net (-12s); issuing SETTIME to correct this",
		"net.drift",
		"NETWORK",
		{server: "leaf.example.net", seconds: "-12"},
	],
	[
		"Link with leaf.example.net established.",
		"link.established",
		"OLDSNO",
		{server: "leaf.example.net"},
	],
	[
		"Link with leaf.example.net canceled: Server Exists",
		"link.cancelled",
		"OLDSNO",
		{server: "leaf.example.net", reason: "Server Exists"},
	],
	[
		"Connection to leaf.example.net activated.",
		"link.connecting",
		"OLDSNO",
		{server: "leaf.example.net"},
	],
	[
		"Server leaf.example.net connect DNS pending",
		"link.connecting",
		"OLDSNO",
		{server: "leaf.example.net"},
	],
	[
		"Connection failed to leaf.example.net: Connection refused",
		"link.failed",
		"OLDSNO",
		{server: "leaf.example.net"},
	],
	[
		"Connect to leaf.example.net failed: host lookup",
		"link.failed",
		"OLDSNO",
		{server: "leaf.example.net"},
	],
	[
		"Host leaf.example.net is not enabled for connecting: no Connect block",
		"link.failed",
		"OLDSNO",
		{server: "leaf.example.net"},
	],
	[
		"No response from leaf.example.net, closing link",
		"link.timeout",
		"OLDSNO",
		{server: "leaf.example.net"},
	],
	[
		"Access denied (passwd mismatch) rogue.example.net",
		"link.refused",
		"OLDSNO",
		{server: "rogue.example.net"},
	],
	[
		"Bogus server name (bad..name) from rogue.example.net",
		"link.refused",
		"OLDSNO",
		{server: "rogue.example.net"},
	],
	[
		"Local SQUIT by opr [irc.seance.test]:",
		"squit",
		"OLDSNO",
		{scope: "Local", oper: "opr", server: "irc.seance.test"},
	],
	[
		"Received SQUIT leaf.example.net from hub.example.net :",
		"squit.received",
		"OLDSNO",
		{server: "leaf.example.net", from: "hub.example.net"},
	],
	[
		"ERROR :from leaf.example.net via hub.example.net -- Closing Link",
		"server.error",
		"OLDSNO",
		{server: "leaf.example.net", uplink: "hub.example.net", message: "Closing Link"},
	],
	[
		"Max SendQ limit exceeded for leaf.example.net: 9000123 > 9000000",
		"sendq.exceeded",
		"OLDSNO",
		{server: "leaf.example.net", size: "9000123", limit: "9000000"},
	],

	// --- administration
	["opr is rehashing Server config file", "rehash", "OLDSNO", {oper: "opr"}],
	[
		"opr [hub.example.net] is remotely rehashing Server config file",
		"rehash",
		"OLDSNO",
		{oper: "opr", remote: "remotely ", via: " from hub.example.net"},
	],
	["Got signal SIGHUP, reloading ircd conf. file", "rehash.signal", "OLDSNO", {signal: "SIGHUP"}],
	[
		"Got signal SIGUSR1, reloading SSL certificates",
		"rehash.signal",
		"OLDSNO",
		{signal: "SIGUSR1"},
	],
	["Restarting server: received RESTART", "restart", "OLDSNO", {reason: "received RESTART"}],
	[
		"SETTIME from hub.example.net, clock is set 3 seconds backwards",
		"clock",
		"OLDSNO",
		{server: "hub.example.net", seconds: "3", direction: "backwards"},
	],
	["clock adjusted by adding 4", "clock", "OLDSNO", {seconds: "4"}],
	[
		"Connected to a net with a timestamp-clock difference of 61 seconds! Used SETTIME to correct this.",
		"clock",
		"OLDSNO",
		{seconds: "61"},
	],
	[
		"opr is running STORE DEFRAG on history",
		"store.defrag",
		"OLDSNO",
		{oper: "opr", target: "history"},
	],
	[
		"GitSync: Wrote 2048 bytes to ircd.conf (commit 1a2b3c4d), rehashing",
		"gitsync",
		"OLDSNO",
		{message: "Wrote 2048 bytes to ircd.conf (commit 1a2b3c4d), rehashing"},
	],
	["GitSync triggered by opr", "gitsync", "OLDSNO", {message: "triggered by opr"}],
	[
		"GitSync: WARNING! Host key for git.example.net has CHANGED!",
		"gitsync.fail",
		"OLDSNO",
		{message: "WARNING! Host key for git.example.net has CHANGED!"},
	],
	["GitSync: Rejecting connection - possible MITM attack!", "gitsync.fail", "OLDSNO"],
	[
		"SNI: Certificate loaded for 'irc.example.net'",
		"tls.loaded",
		"OLDSNO",
		{host: "irc.example.net"},
	],
	[
		"SNI: Failed to load certificate for 'irc.example.net'",
		"tls.fail",
		"OLDSNO",
		{host: "irc.example.net"},
	],
	[
		"WEBPUSH: current VAPID key now abcdef0123456789... (rotation)",
		"webpush.key",
		"OLDSNO",
		{key: "abcdef0123456789…", reason: "rotation"},
	],
	["WEBPUSH: current VAPID key cleared (no keys)", "webpush.key", "OLDSNO", {key: "cleared"}],
	[
		"WEBPUSH: libcurl not available",
		"webpush.error",
		"OLDSNO",
		{message: "libcurl not available"},
	],
	[
		"Nick collision on bob (hub.example.net 1791500000 <- leaf.example.net 1791500001 (Different user@host))",
		"nick.collision",
		"OLDSNO",
		{nick: "bob"},
	],
	[
		"Nick change collision from bob to carol (hub.example.net 1791500000 <- leaf.example.net 1791500001)",
		"nick.collision",
		"OLDSNO",
		{nick: "bob", newNick: "carol"},
	],
	[
		"Bad Nick: 1nvalid From: hub.example.net leaf.example.net",
		"nick.collision",
		"OLDSNO",
		{nick: "1nvalid"},
	],
	[
		"Bouncer post-burst reconcile: demoted local primary alice to alias of alice (account alice, session k3J9xQ)",
		"bouncer.event",
		"OLDSNO",
	],
	[
		"Same-account override: bouncer-account dual session alice vs incoming alice on hub.example.net — applying older-wins (stability) instead of newer-wins (reconnect ghost)",
		"bouncer.event",
		"OLDSNO",
	],
	["Unable to write tunefile..", "server.internal", "OLDSNO"],

	// --- modes and kicks
	[
		"BOUNCE or HACK(3): leaf.example.net MODE #chan -o bob [1791400000]",
		"hack.mode",
		"HACK3",
		{server: "leaf.example.net", channel: "#chan", modes: "-o bob", level: "3"},
	],
	[
		"HACK(2): bob MODE #chan +o bob [1791400000]",
		"hack.mode",
		"HACK2",
		{nick: "bob", channel: "#chan", modes: "+o bob"},
	],
	[
		"HACK: services.example.net KICK #chan bob banned (no reason)",
		"hack.kick",
		"HACK4",
		{
			server: "services.example.net",
			channel: "#chan",
			target: "bob",
			reason: "banned (no reason)",
		},
	],
	[
		"HACK: bob KICK #chan carol bye",
		"hack.kick",
		"HACK4",
		{nick: "bob", channel: "#chan", target: "carol", reason: "bye"},
	],
	[
		"OPER JOIN: opr JOIN &secret (overriding +k)",
		"oper.join",
		"HACK4",
		{nick: "opr", channel: "&secret", mode: "k"},
	],
	[
		"Deop of +k user on #chan by services.example.net",
		"deop.service",
		"HACK4",
		{channel: "#chan", server: "services.example.net"},
	],

	// --- connection noise
	["Unauthorized connection from bot.", "conn.unauth", "UNAUTH", {nick: "bot"}],
	[
		"Connection from bot[@203.0.113.3] rejected: class Locked requires SASL but services unavailable.",
		"conn.unauth",
		"UNAUTH",
		{nick: "bot", ip: "203.0.113.3", class: "Locked"},
	],
	[
		"Too many connections in class Users for bot[~b@203.0.113.4].",
		"conn.toomany",
		"TOOMANY",
		{nick: "bot", ip: "203.0.113.4", class: "Users"},
	],
	[
		"Too many connections from same IP for bot[@203.0.113.4].",
		"conn.toomany",
		"TOOMANY",
		{nick: "bot", ip: "203.0.113.4"},
	],
	[
		"IP# Mismatch: 203.0.113.5 != fake.example.net[198.51.100.5]",
		"conn.ipmismatch",
		"IPMISMATCH",
		{ip: "203.0.113.5", host: "fake.example.net", resolved: "198.51.100.5"},
	],
	[
		"SSL Error for connection attempt: error:0A00010B:SSL routines::wrong version number",
		"conn.tlserror",
		"TCPCOMMON",
	],
	["Unable to accept connection: Too many open files", "conn.tlserror", "TCPCOMMON"],
	["iauth version 1.2 running.", "iauth", "AUTH"],
	[
		"IAuth circuit breaker OPEN: bypassing IAUTH_REQUIRED after 5 consecutive timeouts",
		"iauth",
		"AUTH",
	],

	// --- log lines
	[
		"SYSTEM [CRIT]: Server terminating: received DIE",
		"log.alert",
		"OLDSNO",
		{subsystem: "SYSTEM", level: "CRIT", message: "Server terminating: received DIE"},
	],
	[
		"OPER [WARNING]: something odd",
		"log.alert",
		"OLDREALOP",
		{subsystem: "OPER", level: "WARNING"},
	],
	[
		"IAUTH [INFO]: IAuth changed hostname for 203.0.113.7 from a.example to b.example",
		"log.info",
		"NETWORK",
		{subsystem: "IAUTH", level: "INFO"},
	],
	[
		"OPER [INFO]: OPER (seanceop) by (opr!opr@172.17.0.1)",
		"log.info",
		"OLDREALOP",
		{subsystem: "OPER", message: "OPER (seanceop) by (opr!opr@172.17.0.1)"},
	],
];

const BIT_NAMES = new Set([...NEFARIOUS_SNOMASK.bits.map((b) => b.name), "WHOIS"]);

describe("nefarious2 server notice classifier", function () {
	for (const [text, kind, category, fields] of CASES) {
		it(`${kind}: ${text.slice(0, 70)}`, function () {
			const event = classifyNotice(text);
			expect(event, "classified").to.not.equal(undefined);
			expect(event!.kind).to.equal(kind);
			expect(event!.category).to.equal(category);

			if (fields) {
				expect(event!.fields).to.include(fields);
			}
		});
	}

	it("leaves unknown text unclassified", function () {
		expect(classifyNotice("Something we have never seen")).to.equal(undefined);
		expect(classifyNotice("")).to.equal(undefined);
	});

	it("has unique kinds, each with a label, a template and a known category", function () {
		const seen = new Set<string>();

		for (const k of NOTICE_KINDS) {
			expect(seen.has(k.kind), `duplicate ${k.kind}`).to.equal(false);
			seen.add(k.kind);
			expect(k.label, k.kind).to.be.a("string").and.not.equal("");
			expect(k.template, k.kind).to.be.a("string").and.not.equal("");
			expect(BIT_NAMES.has(k.category), `${k.kind}: ${k.category}`).to.equal(true);
			expect(["active", "network", "off"]).to.include(k.route);
		}
	});

	it("only produces kinds that are listed", function () {
		const listed = new Set(NOTICE_KINDS.map((k) => k.kind));

		for (const kind of RULE_KINDS) {
			expect(listed.has(kind), kind).to.equal(true);
		}
	});

	it("has a sample for every listed kind", function () {
		const sampled = new Set(CASES.map((c) => c[1]));

		for (const k of NOTICE_KINDS) {
			expect(sampled.has(k.kind), `no sample for ${k.kind}`).to.equal(true);
		}
	});

	it("only uses template placeholders that some sample of the kind fills", function () {
		const produced = new Map<string, Set<string>>();

		for (const [text] of CASES) {
			const event = classifyNotice(text);

			if (!event) {
				continue;
			}

			const set = produced.get(event.kind) ?? new Set<string>();
			Object.keys(event.fields).forEach((f) => set.add(f));
			produced.set(event.kind, set);
		}

		for (const k of NOTICE_KINDS) {
			const fields = produced.get(k.kind) ?? new Set<string>();

			for (const [, name] of (k.template ?? "").matchAll(/\{(\w+)\}/g)) {
				expect(fields.has(name), `${k.kind}: {${name}}`).to.equal(true);
			}
		}
	});

	it("follows the proposal's routing table", function () {
		const route = (kind: string) => NOTICE_KINDS.find((k) => k.kind === kind)?.route;

		for (const kind of [
			"ban.add",
			"ban.modify",
			"ban.forceremove",
			"jupe.add",
			"tempshun.apply",
			"kill.oper",
			"oper.up",
			"oper.fail",
			"net.break",
			"net.junction",
			"squit",
			"server.error",
			"rehash",
			"restart",
			"clock",
			"config.error",
			"gitsync.fail",
			"tls.fail",
			"webirc.unauthorized",
			"log.alert",
			"whois.notify",
		]) {
			expect(route(kind), kind).to.equal("active");
		}

		for (const kind of [
			"client.connect",
			"client.exit",
			"nick.change",
			"webirc.host",
			"ban.hit",
			"kill.server",
			"nick.collision",
			"hack.mode",
			"conn.unauth",
			"conn.toomany",
			"conn.ipmismatch",
			"conn.tlserror",
			"dnsbl.block",
			"iauth",
			"net.burst",
			"bouncer.event",
			"log.info",
		]) {
			expect(route(kind), kind).to.equal("network");
		}
	});
});
