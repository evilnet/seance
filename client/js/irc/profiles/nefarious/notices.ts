/**
 * nefarious2 server notices: every kind the classifier recognises, with its
 * default route, and the classifier itself. The catalogue (and the source
 * line of each format string) is docs/resources/nefarious2-oper.md §5; the
 * default routes are the table in docs/projects/oper-tools.md, feature 1:
 * what an oper acts on goes to the active window, routine traffic to the
 * network window.
 *
 * The text arrives without its `*** Notice -- ` prefix. Rules are tried in
 * order, first match wins; the log-derived `SUBSYS [LEVEL]: …` lines come
 * first because their message can look like anything. Every regex is
 * anchored at both ends, and free text that may contain brackets
 * (realnames, quit reasons) is pinned by what follows it.
 */

import type {NoticeKind, SnoticeEvent} from "../types";

type Fields = Record<string, string>;

interface Rule {
	kind: string;
	re: RegExp;
	map: (m: RegExpExecArray) => Fields;
	/** Overrides the kind's category for this match (AUTO bans, K-line hits). */
	category?: (m: RegExpExecArray, fields: Fields) => string;
}

export const NOTICE_KINDS: NoticeKind[] = [
	// --- clients (CONNEXIT, NICKCHG, WEBIRC host changes)
	{
		kind: "client.connect",
		label: "Client connects",
		category: "CONNEXIT",
		route: "network",
		template: "{nick} ({host}) connected from {ip}, class {class}: {realname}",
	},
	{
		kind: "client.exit",
		label: "Client exits",
		category: "CONNEXIT",
		route: "network",
		template: "{nick} ({host}) from {ip} quit: {reason}",
	},
	{
		kind: "nick.change",
		label: "Nick changes",
		category: "NICKCHG",
		route: "network",
		template: "{nick} ({host}) is now {newNick}",
	},
	{
		kind: "webirc.host",
		label: "WebIRC host changes",
		category: "WEBIRC",
		route: "network",
		template: "WebIRC gateway {gateway} ({gatewayIp}) connected {host} ({ip})",
	},
	{
		kind: "webirc.invalid",
		label: "Bad WEBIRC attempts",
		category: "WEBIRC",
		route: "active",
		template: "WEBIRC from {host} ({ip}) with an invalid {what}",
	},
	{
		kind: "webirc.unauthorized",
		label: "Unauthorized WEBIRC",
		category: "WEBIRC",
		route: "active",
		template: "Unauthorized WEBIRC attempt from {host} ({ip})",
	},
	{
		kind: "config.error",
		label: "Config parse errors",
		category: "WEBIRC",
		route: "active",
		template: "Config parse error in {file} line {line}: {message}",
	},

	// --- kills and ban hits
	{
		kind: "kill.oper",
		label: "Oper kills",
		category: "OPERKILL",
		route: "active",
		template: "{killer} killed {nick}: {reason}",
	},
	{
		kind: "kill.server",
		label: "Server kills",
		category: "SERVKILL",
		route: "network",
		template: "{server} killed {nick}: {reason}",
	},
	{
		kind: "ban.hit",
		label: "Ban hits",
		category: "GLINE",
		route: "network",
		template: "{type} hit {nick}",
	},
	{
		kind: "shun.match",
		label: "Shun matches (log)",
		category: "GLINE",
		route: "network",
		template: "Shun {mask} matched {nick} ({ip}) via {via}",
	},

	// --- bans being changed (GLINE / AUTO)
	{
		kind: "ban.add",
		label: "Bans added",
		category: "GLINE",
		route: "active",
		template:
			"{oper}{server} added a {state}{scope} {type} on {mask}, expiring {expires}: {reason}",
	},
	{
		kind: "ban.activate",
		label: "Bans activated",
		category: "GLINE",
		route: "active",
		template:
			"{oper}{server} activated the global {type} on {mask}, expiring {expires}: {reason}",
	},
	{
		kind: "ban.deactivate",
		label: "Bans removed or deactivated",
		category: "GLINE",
		route: "active",
		template: "{oper}{server} {action} the {scope} {type} on {mask}: {reason}",
	},
	{
		kind: "ban.modify",
		label: "Bans changed",
		category: "GLINE",
		route: "active",
		template: "{oper}{server} changed the global {type} on {mask}:{changes}",
	},
	{
		kind: "ban.remove",
		label: "Local bans removed",
		category: "GLINE",
		route: "active",
		template: "{oper}{server} removed the local {type} on {mask}",
	},
	{
		kind: "ban.forceremove",
		label: "Bans force-removed",
		category: "GLINE",
		route: "active",
		template: "{oper}{server} force-removed the {type} on {mask}: {reason}",
	},
	{
		kind: "tempshun.apply",
		label: "Temporary shuns applied",
		category: "GLINE",
		route: "active",
		template: "Temporary shun on {nick}: {reason}",
	},
	{
		kind: "tempshun.remove",
		label: "Temporary shuns removed",
		category: "GLINE",
		route: "active",
		template: "Temporary shun lifted from {nick}: {reason}",
	},
	{
		kind: "dnsbl.block",
		label: "DNSBL blocks",
		category: "GLINE",
		route: "network",
		template: "DNSBL blocked {nick} ({host}) from {ip}",
	},

	// --- jupes (NETWORK)
	{
		kind: "jupe.add",
		label: "Jupes added",
		category: "NETWORK",
		route: "active",
		template: "{oper}{server} juped {target} ({scope}), expiring {expires}: {reason}",
	},
	{
		kind: "jupe.activate",
		label: "Jupes activated",
		category: "NETWORK",
		route: "active",
		template: "{oper}{server} activated the jupe on {target}, expiring {expires}: {reason}",
	},
	{
		kind: "jupe.deactivate",
		label: "Jupes removed",
		category: "NETWORK",
		route: "active",
		template: "{oper}{server} {action} the jupe on {target}: {reason}",
	},

	// --- opers
	{
		kind: "oper.up",
		label: "Opers coming up",
		category: "OLDSNO",
		route: "active",
		template: "{nick} ({host}) is now {role}",
	},
	{
		kind: "oper.fail",
		label: "Failed OPER attempts",
		category: "OLDREALOP",
		route: "active",
		template: "Failed {remote}OPER attempt by {nick} ({host}): {reason}",
	},
	{
		kind: "bouncer.oreset",
		label: "Bouncer session resets",
		category: "OLDSNO",
		route: "active",
		template: "{oper} reset bouncer session {session} of account {account}",
	},
	{
		kind: "whois.notify",
		label: "Someone WHOISed you",
		category: "WHOIS",
		route: "active",
		template: "{nick} ({host}) did a /whois on you",
	},

	// --- links and the network
	{
		kind: "net.junction",
		label: "Net junctions",
		category: "NETWORK",
		route: "active",
		template: "Net junction: {server} linked to {uplink}",
	},
	{
		kind: "net.break",
		label: "Net breaks",
		category: "NETWORK",
		route: "active",
		template: "Net break: {server} split from {uplink} ({reason})",
	},
	{
		kind: "net.burst",
		label: "Burst completed",
		category: "NETWORK",
		route: "network",
		template: "Completed net.burst from {server}",
	},
	{
		kind: "net.burstack",
		label: "Burst acknowledged",
		category: "NETWORK",
		route: "network",
		template: "{server} acknowledged end of net.burst",
	},
	{
		kind: "net.drift",
		label: "Timestamp drift",
		category: "NETWORK",
		route: "active",
		template: "Timestamp drift from {server} ({seconds}s); issuing SETTIME",
	},
	{
		kind: "link.established",
		label: "Links established",
		category: "OLDSNO",
		route: "active",
		template: "Link with {server} established",
	},
	{
		kind: "link.cancelled",
		label: "Links cancelled",
		category: "OLDSNO",
		route: "active",
		template: "Link with {server} cancelled: {reason}",
	},
	{
		kind: "link.connecting",
		label: "Server connects in progress",
		category: "OLDSNO",
		route: "network",
		template: "{message}",
	},
	{
		kind: "link.failed",
		label: "Server connects failed",
		category: "OLDSNO",
		route: "active",
		template: "{message}",
	},
	{
		kind: "link.timeout",
		label: "Server links timing out",
		category: "OLDSNO",
		route: "active",
		template: "No response from {server}, closing link",
	},
	{
		kind: "link.refused",
		label: "Server links refused",
		category: "OLDSNO",
		route: "active",
		template: "{message}",
	},
	{
		kind: "squit",
		label: "SQUITs",
		category: "OLDSNO",
		route: "active",
		template: "{scope} SQUIT by {oper} on {server}",
	},
	{
		kind: "squit.received",
		label: "SQUITs received",
		category: "OLDSNO",
		route: "active",
		template: "Received SQUIT for {server} from {from}",
	},
	{
		kind: "server.error",
		label: "ERROR from servers",
		category: "OLDSNO",
		route: "active",
		template: "ERROR from {server}: {message}",
	},
	{
		kind: "sendq.exceeded",
		label: "SendQ exceeded on a link",
		category: "OLDSNO",
		route: "active",
		template: "Max SendQ exceeded for {server}: {size} > {limit}",
	},

	// --- server administration
	{
		kind: "rehash",
		label: "Rehashes",
		category: "OLDSNO",
		route: "active",
		template: "{oper} is {remote}rehashing the server config{via}",
	},
	{
		kind: "rehash.signal",
		label: "Rehash or reload by signal",
		category: "OLDSNO",
		route: "active",
		template: "{message}",
	},
	{
		kind: "restart",
		label: "Restarts",
		category: "OLDSNO",
		route: "active",
		template: "Restarting server: {reason}",
	},
	{
		kind: "clock",
		label: "Clock changes",
		category: "OLDSNO",
		route: "active",
		template: "{message}",
	},
	{
		kind: "store.defrag",
		label: "Storage maintenance",
		category: "OLDSNO",
		route: "active",
		template: "{oper} is running STORE DEFRAG on {target}",
	},
	{
		kind: "gitsync",
		label: "GitSync",
		category: "OLDSNO",
		route: "network",
		template: "GitSync: {message}",
	},
	{
		kind: "gitsync.fail",
		label: "GitSync failures",
		category: "OLDSNO",
		route: "active",
		template: "GitSync: {message}",
	},
	{
		kind: "tls.loaded",
		label: "TLS certificates loaded",
		category: "OLDSNO",
		route: "network",
		template: "TLS certificate loaded for {host}",
	},
	{
		kind: "tls.fail",
		label: "TLS certificate failures",
		category: "OLDSNO",
		route: "active",
		template: "TLS certificate failed to load for {host}",
	},
	{
		kind: "webpush.key",
		label: "Web push key changes",
		category: "OLDSNO",
		route: "network",
		template: "Web push: current VAPID key {key} ({reason})",
	},
	{
		kind: "webpush.error",
		label: "Web push errors",
		category: "OLDSNO",
		route: "active",
		template: "Web push: {message}",
	},
	{
		kind: "nick.collision",
		label: "Nick collisions",
		category: "OLDSNO",
		route: "network",
		template: "{message}",
	},
	{
		kind: "bouncer.event",
		label: "Bouncer housekeeping",
		category: "OLDSNO",
		route: "network",
		template: "{message}",
	},
	{
		kind: "server.internal",
		label: "Internal server notes",
		category: "OLDSNO",
		route: "network",
		template: "{message}",
	},

	// --- channel modes and kicks (HACK2/3/4)
	{
		kind: "hack.mode",
		label: "Server, services and OPMODE modes",
		category: "HACK4",
		route: "network",
		template: "{nick}{server} set {modes} on {channel}",
	},
	{
		kind: "hack.kick",
		label: "Server and services kicks",
		category: "HACK4",
		route: "network",
		template: "{nick}{server} kicked {target} from {channel}: {reason}",
	},
	{
		kind: "oper.join",
		label: "Oper join overrides",
		category: "HACK4",
		route: "network",
		template: "{nick} joined {channel} overriding +{mode}",
	},
	{
		kind: "deop.service",
		label: "Deops of services",
		category: "HACK4",
		route: "network",
		template: "A +k user was deopped on {channel} by {server}",
	},

	// --- connection noise
	{
		kind: "conn.unauth",
		label: "Refused connections",
		category: "UNAUTH",
		route: "network",
		template: "{message}",
	},
	{
		kind: "conn.toomany",
		label: "Too many connections",
		category: "TOOMANY",
		route: "network",
		template: "{message}",
	},
	{
		kind: "conn.ipmismatch",
		label: "IP mismatches",
		category: "IPMISMATCH",
		route: "network",
		template: "IP mismatch: {ip} does not match {host} [{resolved}]",
	},
	{
		kind: "conn.tlserror",
		label: "Socket and TLS errors",
		category: "TCPCOMMON",
		route: "network",
		template: "{message}",
	},
	{
		kind: "iauth",
		label: "IAuth notices",
		category: "AUTH",
		route: "network",
		template: "IAuth: {message}",
	},

	// --- log lines mirrored as notices
	{
		kind: "log.alert",
		label: "Log errors and warnings",
		category: "OLDSNO",
		route: "active",
		template: "{subsystem} {level}: {message}",
	},
	{
		kind: "log.info",
		label: "Log information",
		category: "OLDSNO",
		route: "network",
		template: "{subsystem} {level}: {message}",
	},
];

/** A name in a line notice's setter position: a server when it has a dot. */
function who(name: string): Fields {
	return name.includes(".") ? {server: name} : {oper: name};
}

/** `nick[ident@ip]` (a local client, `get_client_name(SHOW_IP)`) or a bare nick. */
function client(name: string): Fields {
	const m = /^(.+?)\[([^@\]]*)@([^\]]+)\]$/.exec(name);

	if (!m) {
		return {nick: name};
	}

	return m[2] ? {nick: m[1], user: m[2], ip: m[3]} : {nick: m[1], ip: m[3]};
}

/** A source that is a nick or a server (HACK notices, KICKs). */
function actor(name: string): Fields {
	return name.includes(".") ? {server: name} : {nick: name};
}

const BAN_TYPE = "(GLINE|BADCHAN|SHUN|ZLINE)";

/** The ban type as people say it. */
function banType(raw: string): string {
	switch (raw) {
		case "GLINE":
			return "G-line";
		case "ZLINE":
			return "Z-line";
		case "SHUN":
			return "shun";
		case "BADCHAN":
			return "channel ban";
		default:
			return raw;
	}
}

/** AUTO bans travel on their own bit (reason starting with `AUTO`). */
function autoCategory(reason: string | undefined): string {
	return reason !== undefined && reason.slice(0, 4).toUpperCase() === "AUTO" ? "AUTO" : "GLINE";
}

/** Default snomask bit of each log subsystem (ircd_log.c:154-168). */
const LOG_BIT: Record<string, string> = {
	CONFIG: "OLDSNO",
	OPERMODE: "HACK4",
	GLINE: "GLINE",
	JUPE: "NETWORK",
	NETWORK: "NETWORK",
	IAUTH: "NETWORK",
	OPER: "OLDREALOP",
};

const LOG_SUBSYSTEMS =
	"SYSTEM|CONFIG|OPERMODE|GLINE|JUPE|WHO|NETWORK|OPERKILL|SERVKILL|USER|OPER|RESOLVER|SOCKET|IAUTH|DEBUG";
const LOG_LEVELS = "CRIT|ERROR|WARNING|NOTICE|TRACE|INFO|DEBUG";

const RULES: Rule[] = [
	// --- log lines (first: their message can be anything)
	{
		kind: "shun.match",
		re: /^GLINE \[INFO\]: Shun match: mask=(\S+) reason=(.*) victim=([^!\s]+)!([^@\s]+)@(\S+) ip=(\S+) sockhost=(\S+) host=(\S+) realhost=(\S+) matched_via=(\S+) matched_value=(\S+)$/,
		map: (m) => ({
			mask: m[1],
			reason: m[2],
			nick: m[3],
			user: m[4],
			host: `${m[4]}@${m[9]}`,
			ip: m[6],
			via: m[10],
			value: m[11],
		}),
	},
	{
		kind: "log.alert",
		re: new RegExp(`^(${LOG_SUBSYSTEMS}) \\[(CRIT|ERROR|WARNING)\\]: (.*)$`),
		map: (m) => ({subsystem: m[1], level: m[2], message: m[3]}),
		category: (m) => (m[2] === "CRIT" ? "OLDSNO" : LOG_BIT[m[1]] ?? "OLDSNO"),
	},
	{
		kind: "log.info",
		re: new RegExp(`^(${LOG_SUBSYSTEMS}) \\[(${LOG_LEVELS})\\]: (.*)$`),
		map: (m) => ({subsystem: m[1], level: m[2], message: m[3]}),
		category: (m) => (m[2] === "DEBUG" ? "DEBUG" : LOG_BIT[m[1]] ?? "OLDSNO"),
	},

	// --- clients
	{
		kind: "client.connect",
		re: /^Client connecting: (\S+) \(([^@\s]+)@(\S+)\) \[([^\]]*)\] \{([^}]*)\} \[(.*)\] <(\S+)>$/,
		map: (m) => ({
			nick: m[1],
			user: m[2],
			host: `${m[2]}@${m[3]}`,
			ip: m[4],
			class: m[5],
			realname: m[6],
			numnick: m[7],
		}),
	},
	{
		// The quit reason may hold brackets: everything up to the last `] [`.
		kind: "client.exit",
		re: /^Client exiting: (\S+) \(([^@\s]+)@(\S+)\) \[(.*)\] \[([^\]]*)\] <(\S+)>$/,
		map: (m) => ({
			nick: m[1],
			user: m[2],
			host: `${m[2]}@${m[3]}`,
			reason: m[4],
			ip: m[5],
			numnick: m[6],
		}),
	},
	{
		kind: "nick.change",
		re: /^Nick change: From (\S+) to (\S+) \[([^@\s]+)@([^\]\s]+)\] <(\S+)>$/,
		map: (m) => ({
			nick: m[1],
			newNick: m[2],
			user: m[3],
			host: `${m[3]}@${m[4]}`,
			numnick: m[5],
		}),
	},
	{
		kind: "webirc.host",
		re: /^WEBIRC Client host: from (\S+) \[([^\]]*)\] to (\S+) \[([^\]]*)\]$/,
		map: (m) => ({gateway: m[1], gatewayIp: m[2], host: m[3], ip: m[4]}),
	},
	{
		kind: "webirc.invalid",
		re: /^WEBIRC Attempt with invalid (password|parameters|IP address|host name) from (\S+) \[([^\]]*)\]$/,
		map: (m) => ({what: m[1], host: m[2], ip: m[3]}),
	},
	{
		kind: "webirc.unauthorized",
		re: /^WEBIRC Attempt unauthorized from (\S+) \[([^\]]*)\]$/,
		map: (m) => ({host: m[1], ip: m[2]}),
	},
	{
		kind: "config.error",
		re: /^Config parse error in file (.+) on line (\d+): (.*)$/,
		map: (m) => ({file: m[1], line: m[2], message: m[3]}),
	},

	// --- kills and hits
	{
		kind: "kill.oper",
		re: /^Received KILL message for (\S+) from ([^.\s]+) Path: (\S+) \((.*)\)$/,
		map: (m) => ({...client(m[1]), killer: m[2], path: m[3], reason: m[4]}),
	},
	{
		kind: "kill.server",
		re: /^Received KILL message for (\S+) from (\S+\.\S*) Path: (\S+) \((.*)\)$/,
		map: (m) => ({...client(m[1]), server: m[2], path: m[3], reason: m[4]}),
	},
	{
		kind: "ban.hit",
		re: /^(G-line|K-line|Z-line|Shun) active for (Unregistered Client )?(\S+)$/,
		map: (m) => ({
			type: m[1] === "Shun" ? "Shun" : m[1],
			...client(m[3]),
			...(m[2] ? {unregistered: "yes"} : {}),
		}),
		category: (m) => (m[1] === "K-line" ? "OPERKILL" : "GLINE"),
	},

	// --- bans being changed
	{
		kind: "ban.add",
		re: new RegExp(
			`^(\\S+) adding (deactivated )?(local|global) ${BAN_TYPE} for (\\S+), expiring at (\\d+): (.*)$`
		),
		map: (m) => ({
			...who(m[1]),
			...(m[2] ? {state: "deactivated "} : {}),
			scope: m[3],
			type: banType(m[4]),
			mask: m[5],
			expires: m[6],
			reason: m[7],
		}),
		category: (m) => autoCategory(m[7]),
	},
	{
		kind: "ban.activate",
		re: new RegExp(
			`^(\\S+) activating global ${BAN_TYPE} for (\\S+), expiring at (\\d+): (.*)$`
		),
		map: (m) => ({
			...who(m[1]),
			scope: "global",
			type: banType(m[2]),
			mask: m[3],
			expires: m[4],
			reason: m[5],
		}),
	},
	{
		kind: "ban.deactivate",
		re: new RegExp(
			`^(\\S+) (removing local|removing global|deactivating global) ${BAN_TYPE} for (\\S+), expiring at (\\d+): (.*)$`
		),
		map: (m) => ({
			...who(m[1]),
			action: m[2].startsWith("removing") ? "removed" : "deactivated",
			scope: m[2].endsWith("local") ? "local" : "global",
			type: banType(m[3]),
			mask: m[4],
			expires: m[5],
			reason: m[6],
		}),
	},
	{
		kind: "ban.modify",
		re: new RegExp(`^(\\S+) modifying global ${BAN_TYPE} for (\\S+):(.*)$`),
		map: (m) => ({
			...who(m[1]),
			scope: "global",
			type: banType(m[2]),
			mask: m[3],
			changes: m[4],
		}),
		// The old reason is not in the line: AUTO is told by a new one.
		category: (m) => (/changing reason to "AUTO/i.test(m[4]) ? "AUTO" : "GLINE"),
	},
	{
		kind: "ban.remove",
		re: new RegExp(`^(\\S+) removing local ${BAN_TYPE} for (\\S+)$`),
		map: (m) => ({...who(m[1]), scope: "local", type: banType(m[2]), mask: m[3]}),
	},
	{
		kind: "ban.forceremove",
		re: /^(\S+) force removing (GLINE|SHUN|ZLINE) for (\S+) \((.*)\)$/,
		map: (m) => ({...who(m[1]), type: banType(m[2]), mask: m[3], reason: m[4]}),
	},
	{
		kind: "tempshun.apply",
		re: /^Temporary shun applied to (\S+) \((.*)\)$/,
		map: (m) => ({...client(m[1]), reason: m[2]}),
	},
	{
		kind: "tempshun.remove",
		re: /^Temporary shun removed from (\S+) \((.*)\)$/,
		map: (m) => ({...client(m[1]), reason: m[2]}),
	},
	{
		kind: "dnsbl.block",
		re: /^DNSBL blocked (anonymous )?connection from (\S+) \(([^@\s]+)@(\S+)\) \[([^\]]*)\]$/,
		map: (m) => ({
			nick: m[2],
			user: m[3],
			host: `${m[3]}@${m[4]}`,
			ip: m[5],
			...(m[1] ? {anonymous: "yes"} : {}),
		}),
	},

	// --- jupes
	{
		kind: "jupe.add",
		re: /^(\S+) adding (local )?JUPE for (\S+), expiring at (\d+): (.*)$/,
		map: (m) => ({
			...who(m[1]),
			scope: m[2] ? "local" : "global",
			target: m[3],
			expires: m[4],
			reason: m[5],
		}),
	},
	{
		kind: "jupe.activate",
		re: /^(\S+) activating JUPE for (\S+), expiring at (\d+): (.*)$/,
		map: (m) => ({...who(m[1]), target: m[2], expires: m[3], reason: m[4]}),
	},
	{
		kind: "jupe.deactivate",
		re: /^(\S+) (removing local|deactivating) JUPE for (\S+), expiring at (\d+): (.*)$/,
		map: (m) => ({
			...who(m[1]),
			action: m[2] === "deactivating" ? "deactivated" : "removed",
			target: m[3],
			expires: m[4],
			reason: m[5],
		}),
	},

	// --- opers
	{
		// `O` is a global oper, `o` a local one: the reverse of the umodes.
		kind: "oper.up",
		re: /^(\S+) \(([^@\s]+)@(\S+)\) is now a (global|local) operator \(([Oo])\)$/,
		map: (m) => ({
			nick: m[1],
			user: m[2],
			host: `${m[2]}@${m[3]}`,
			level: m[4],
			role: `a ${m[4]} operator`,
		}),
	},
	{
		// X3's auto-oper on login (nickserv.c handle_loc_auth_oper), relayed
		// as a global notice from the services server.
		kind: "oper.up",
		re: /^(\S+) \(([^@\s]+)@(\S+)\) is now an IRC (Operator|Administrator)$/,
		map: (m) => ({
			nick: m[1],
			user: m[2],
			host: `${m[2]}@${m[3]}`,
			level: m[4] === "Administrator" ? "admin" : "global",
			role: m[4] === "Administrator" ? "an IRC administrator" : "an IRC operator",
		}),
	},
	{
		kind: "oper.fail",
		re: /^Failed (remote )?OPER attempt by (\S+) \(([^@\s]+)@(\S+)\) \((.*)\)$/,
		map: (m) => ({
			...(m[1] ? {remote: "remote "} : {}),
			nick: m[2],
			user: m[3],
			host: `${m[3]}@${m[4]}`,
			reason: m[5],
		}),
	},
	{
		kind: "bouncer.oreset",
		re: /^(\S+) used BOUNCER ORESET on session (\S+) \(account (\S+)\)$/,
		map: (m) => ({oper: m[1], session: m[2], account: m[3]}),
	},
	{
		kind: "whois.notify",
		re: /^(\S+) \(([^@\s]+)@(\S+)\) did a \/whois on you\.$/,
		map: (m) => ({nick: m[1], user: m[2], host: `${m[2]}@${m[3]}`}),
	},

	// --- links and the network
	{
		kind: "net.junction",
		re: /^Net junction: (\S+) (\S+)$/,
		map: (m) => ({uplink: m[1], server: m[2]}),
	},
	{
		kind: "net.break",
		re: /^Net break: (\S+) (\S+) \((.*)\)$/,
		map: (m) => ({uplink: m[1], server: m[2], reason: m[3]}),
	},
	{
		kind: "net.burst",
		re: /^Completed net\.burst from (\S+)\.$/,
		map: (m) => ({server: m[1]}),
	},
	{
		kind: "net.burstack",
		re: /^(\S+) acknowledged end of net\.burst\.$/,
		map: (m) => ({server: m[1]}),
	},
	{
		kind: "net.drift",
		re: /^Timestamp drift from (\S+) \((-?\d+)s\); issuing SETTIME to correct this$/,
		map: (m) => ({server: m[1], seconds: m[2]}),
	},
	{
		kind: "link.established",
		re: /^Link with (\S+) established\.$/,
		map: (m) => ({server: m[1]}),
	},
	{
		kind: "link.cancelled",
		re: /^Link with (\S+) canceled: (.*)$/,
		map: (m) => ({server: m[1], reason: m[2]}),
	},
	{
		kind: "link.connecting",
		re: /^(?:Connection to (\S+) activated\.|Server (\S+) connect DNS pending)$/,
		map: (m) => ({server: m[1] ?? m[2], message: m[0]}),
	},
	{
		kind: "link.failed",
		re: /^(?:Connect to (\S+) failed: host lookup|Connection failed to (\S+): .*|Lost Server Line for (\S+)|Server (\S+) already present from \S+|Host (\S+) is not enabled for connecting: no Connect block|Connect Error: lost Connect block for (\S+))$/,
		map: (m) => ({server: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6], message: m[0]}),
	},
	{
		kind: "link.timeout",
		re: /^No response from (\S+), closing link$/,
		map: (m) => ({server: m[1]}),
	},
	{
		kind: "link.refused",
		re: /^(?:Bogus server name \((\S+)\) from (\S+)|Refused connection from (\S+)\.|Received unauthorized connection from (\S+)\.|Access denied\. No conf line for server (\S+)|Access denied \((?:SSL fingerprint|passwd) mismatch\) (\S+))$/,
		map: (m) => ({server: m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[1], message: m[0]}),
	},
	{
		kind: "squit",
		re: /^(Local|Remote) SQUIT by (\S+) \[(\S+)\]:$/,
		map: (m) => ({scope: m[1], oper: m[2], server: m[3]}),
	},
	{
		kind: "squit.received",
		re: /^Received SQUIT (\S+) from (\S+) :$/,
		map: (m) => ({server: m[1], from: m[2]}),
	},
	{
		kind: "server.error",
		re: /^ERROR :from (\S+)(?: via (\S+))? -- (.*)$/,
		map: (m) => ({server: m[1], ...(m[2] ? {uplink: m[2]} : {}), message: m[3]}),
	},
	{
		kind: "sendq.exceeded",
		re: /^Max SendQ limit exceeded for (\S+): (\d+) > (\d+)$/,
		map: (m) => ({server: m[1], size: m[2], limit: m[3]}),
	},

	// --- server administration
	{
		kind: "rehash",
		re: /^(\S+)(?: \[(\S+)\])? is (remotely )?rehashing Server config file$/,
		map: (m) => ({
			oper: m[1],
			...(m[3] ? {remote: "remotely "} : {}),
			...(m[2] ? {via: ` from ${m[2]}`} : {}),
		}),
	},
	{
		kind: "rehash.signal",
		re: /^Got signal (SIGHUP|SIGUSR1), (reloading ircd conf\. file|reloading SSL certificates)$/,
		map: (m) => ({signal: m[1], message: m[0]}),
	},
	{
		kind: "restart",
		re: /^Restarting server: (.*)$/,
		map: (m) => ({reason: m[1]}),
	},
	{
		kind: "clock",
		re: /^(?:SETTIME from (\S+), clock is set (\d+) seconds (forwards|backwards)|clock adjusted by adding (-?\d+)|got earlier start time: (\d+) < (\d+)|Connected to a net with a timestamp-clock difference of (-?\d+) seconds! Used SETTIME to correct this\.)$/,
		map: (m) => ({
			...(m[1] ? {server: m[1]} : {}),
			...(m[2] ? {seconds: m[2], direction: m[3]} : {}),
			...(m[4] ? {seconds: m[4]} : {}),
			...(m[7] ? {seconds: m[7]} : {}),
			message: m[0],
		}),
	},
	{
		kind: "store.defrag",
		re: /^(\S+) is running STORE DEFRAG on (\S+)$/,
		map: (m) => ({oper: m[1], target: m[2]}),
	},
	{
		kind: "gitsync.fail",
		re: /^GitSync: (WARNING! Host key for .*|Expected: .*|Got: .*|Rejecting connection - possible MITM attack!|Rejected .*|Config parse error.*|Certificate from .* failed PEM validation)$/,
		map: (m) => ({message: m[1]}),
	},
	{
		kind: "gitsync",
		re: /^GitSync(?::| triggered by) (.*)$/,
		map: (m) => ({
			message: m[0].startsWith("GitSync triggered") ? `triggered by ${m[1]}` : m[1],
		}),
	},
	{
		kind: "tls.loaded",
		re: /^SNI: Certificate loaded for '(.*)'$/,
		map: (m) => ({host: m[1]}),
	},
	{
		kind: "tls.fail",
		re: /^SNI: Failed to load certificate for '(.*)'$/,
		map: (m) => ({host: m[1]}),
	},
	{
		kind: "webpush.key",
		re: /^WEBPUSH: current VAPID key (now (\S+?)\.\.\.|cleared) \((.*)\)$/,
		map: (m) => ({key: m[2] ? `${m[2]}…` : "cleared", reason: m[3]}),
	},
	{
		kind: "webpush.error",
		re: /^WEBPUSH: (.*)$/,
		map: (m) => ({message: m[1]}),
	},
	{
		kind: "nick.collision",
		re: /^(?:Nick collision on (\S+) \(.*\)|Nick change collision from (\S+) to (\S+) \(.*\)|Bad Nick: (\S+) From: .*|bad NICK param count for (\S+) from \S+)$/,
		map: (m) => ({
			nick: m[1] ?? m[2] ?? m[4] ?? m[5],
			...(m[3] ? {newNick: m[3]} : {}),
			message: m[0],
		}),
	},
	{
		kind: "bouncer.event",
		re: /^(?:Bouncer[: ].*|Account-asymmetry override: .*|Same-account override: .*|BX C convert-in-place .*)$/,
		map: (m) => ({message: m[0]}),
	},
	{
		kind: "server.internal",
		re: /^(?:ERROR: tried to exit me! : .*|setsnomask called with -?\d+ \?!|UserStats\.unknowns underflow: .*|Unable to write tunefile\.\.|CHATHISTORY_STRICT_PRESENCE refused: .*|RELOCATE .* NOT applied locally: .*|Relocation tombstone .*)$/,
		map: (m) => ({message: m[0]}),
	},

	// --- modes and kicks
	{
		kind: "hack.mode",
		re: /^(?:BOUNCE or )?HACK\((\d)\): (\S+) MODE (\S+) (.*) \[(\d+)\]$/,
		map: (m) => ({level: m[1], ...actor(m[2]), channel: m[3], modes: m[4], ts: m[5]}),
		category: (m) => `HACK${m[1]}`,
	},
	{
		// HACK4 (a server kick) and HACK2 (a non-op's) share the text.
		kind: "hack.kick",
		re: /^HACK: (\S+) KICK (\S+) (\S+) (.*)$/,
		map: (m) => ({...actor(m[1]), channel: m[2], target: m[3], reason: m[4]}),
	},
	{
		kind: "oper.join",
		re: /^OPER JOIN: (\S+) JOIN (\S+) \(overriding \+(\S)\)$/,
		map: (m) => ({nick: m[1], channel: m[2], mode: m[3]}),
	},
	{
		kind: "deop.service",
		re: /^Deop of \+k user on (\S+) by (\S+)$/,
		map: (m) => ({channel: m[1], server: m[2]}),
	},

	// --- connection noise
	{
		kind: "conn.unauth",
		re: /^(?:Unauthorized connection from (\S+)\.|Connection from (\S+) rejected: class (\S+) requires SASL but services unavailable\.)$/,
		map: (m) => ({...client(m[1] ?? m[2]), ...(m[3] ? {class: m[3]} : {}), message: m[0]}),
	},
	{
		kind: "conn.toomany",
		re: /^Too many connections (?:in class (\S+)|from same IP) for (\S+)\.$/,
		map: (m) => ({...client(m[2]), ...(m[1] ? {class: m[1]} : {}), message: m[0]}),
	},
	{
		kind: "conn.ipmismatch",
		re: /^IP# Mismatch: (\S+) != (\S+)\[([^\]]*)\]$/,
		map: (m) => ({ip: m[1], host: m[2], resolved: m[3]}),
	},
	{
		kind: "conn.tlserror",
		re: /^(?:Unable to accept connection: .*|SSL Error for (?:client (\S+)|unknown client|connection attempt): .*|Unknown SSL error for connection attempt \(-?\d+\))$/,
		map: (m) => ({...(m[1] ? {nick: m[1]} : {}), message: m[0]}),
	},
	{
		kind: "iauth",
		re: /^(?:IAuth .*|iauth .*|ia_dbg = \d+|New iauth (?:configuration|statistics)\.|Unable to allocate ConfItem for class .*|Parsing: ".*")$/,
		map: (m) => ({message: m[0]}),
	},
];

const kindIndex = new Map(NOTICE_KINDS.map((k) => [k.kind, k]));

/** Classify a server notice's text (without `*** Notice -- `). */
export function classifyNotice(text: string): SnoticeEvent | undefined {
	for (const rule of RULES) {
		const m = rule.re.exec(text);

		if (!m) {
			continue;
		}

		const fields = rule.map(m);
		const info = kindIndex.get(rule.kind);

		return {
			kind: rule.kind,
			category: rule.category ? rule.category(m, fields) : info?.category ?? "OLDSNO",
			fields,
		};
	}

	return undefined;
}

/** The rules' kinds, in order (tests check every one is in {@link NOTICE_KINDS}). */
export const RULE_KINDS: readonly string[] = RULES.map((r) => r.kind);
