/**
 * The Alerts tab's lines for nefarious2 (docs/projects/oper-tools.md,
 * "The panel, redrawn"): the 67 notice kinds and the WALLOPS family folded
 * into a dozen things an oper has an opinion about, each one a Here /
 * Network / Off control. The kinds a line names are routed together; the
 * server's many flavours of "server event" are merged here and never
 * shown one by one. Kinds in no line (WHOIS notifications, WebIRC, the
 * log mirror, TLS, web push, housekeeping) are the folded "Everything
 * else" row, one line per kind.
 */

import type {AlertLine} from "../types";

export const ALERT_LINES: AlertLine[] = [
	// --- Oper actions
	{
		id: "bans",
		label: "Bans added or removed",
		section: "actions",
		kinds: [
			"ban.add",
			"ban.activate",
			"ban.deactivate",
			"ban.modify",
			"ban.remove",
			"ban.forceremove",
			"tempshun.apply",
			"tempshun.remove",
		],
	},
	{
		id: "ban-hits",
		label: "Ban hits",
		hint: "someone connected into a ban",
		section: "actions",
		kinds: ["ban.hit", "shun.match", "dnsbl.block"],
	},
	{id: "kills", label: "Kills", section: "actions", kinds: ["kill.oper", "kill.server"]},
	{
		id: "services",
		label: "Services actions",
		hint: "OPMODE, kicks, deops by services",
		section: "actions",
		kinds: ["hack.mode", "hack.kick", "oper.join", "deop.service"],
	},
	{id: "oper-up", label: "Someone opers up", section: "actions", kinds: ["oper.up"]},
	{id: "oper-fail", label: "Failed /oper attempts", section: "actions", kinds: ["oper.fail"]},
	{
		id: "jupes",
		label: "Jupes",
		section: "actions",
		kinds: ["jupe.add", "jupe.activate", "jupe.deactivate"],
	},

	// --- The network
	{
		id: "links",
		label: "Servers linking and splitting",
		section: "network",
		kinds: [
			"net.junction",
			"net.break",
			"squit",
			"squit.received",
			"link.established",
			"link.cancelled",
			"link.connecting",
			"link.failed",
			"link.timeout",
			"link.refused",
			"server.error",
			"sendq.exceeded",
			"net.burst",
			"net.burstack",
			"net.drift",
		],
	},
	{
		id: "rehash",
		label: "Rehashes and restarts",
		section: "network",
		kinds: ["rehash", "rehash.signal", "restart", "clock"],
	},
	{
		id: "wallops",
		label: "WALLOPS",
		section: "network",
		kinds: ["wallops", "wallusers", "wallops.server", "desynch"],
	},
	{
		id: "refused",
		label: "Refused connections",
		hint: "bad password, SASL required",
		section: "network",
		kinds: ["conn.unauth", "conn.toomany", "conn.ipmismatch", "conn.tlserror"],
	},
	{
		id: "connexit",
		label: "Every connect and quit",
		hint: "noisy; what IP alerts would read",
		section: "network",
		kinds: ["client.connect", "client.exit", "nick.change"],
	},
];
