/**
 * nefarious2 STATS: the selector catalogue and per-selector parsers that
 * turn the reply into a report (docs/resources/nefarious2-oper.md §9).
 *
 * A reply is every line of the labeled response in order: the numerics,
 * the untagged NOTICEs some selectors answer with (the help list, `w`) and
 * the closing 219. Each selector with a known row format becomes a typed
 * table; the free-text 249 ones become monospaced lines; the nefarious
 * subsystems (`chathistory`, `webpush`, …) become label/value lists. A row
 * that does not parse is kept as a line under the table: nothing the server
 * said is ever dropped, and nothing here throws.
 */

import type {
	OperReport,
	ReportColumn,
	ReportEntry,
	ReportSection,
	ReportValue,
} from "../../../../../shared/types/oper";
import type {IrcMessage} from "../../message";
import {
	bytes,
	channel,
	chips,
	duration,
	errorOf,
	errorReport,
	expiry,
	fromUnix,
	host,
	ip,
	lineText,
	mask,
	mono,
	number,
	rawLines,
	server,
	state,
	text,
	time,
	trailingOf,
} from "../report";
import type {StatsEntry} from "../types";

/**
 * Every selector, as the server's own help list names them (live capture,
 * 2026-10-09), sorted by long name like the server sorts it. `webhook` is
 * newer than that capture (upstream `2e921c6`). `gitsync` exists only in
 * libgit2 builds and `usage` only in DEBUGMODE ones; a server without them
 * answers with the help list.
 */
export const STATS_ENTRIES: StatsEntry[] = [
	{letter: "i", name: "access", description: "Connection authorization lines."},
	{
		letter: "",
		name: "authtoken",
		description: "AUTHTOKEN services, token counts and JWT public keys.",
	},
	{letter: "", name: "chathistory", description: "CHATHISTORY storage statistics."},
	{letter: "A", name: "chathistoryads", description: "Chathistory federation advertisements."},
	{letter: "y", name: "classes", description: "Connection classes."},
	{letter: "m", name: "commands", description: "Message usage information."},
	{letter: "c", name: "connect", description: "Remote server connection lines."},
	{letter: "D", name: "crules", description: "Dynamic routing configuration."},
	{letter: "", name: "dnsbl", description: "DNSBL statistics and configuration."},
	{letter: "e", name: "engine", description: "Report server event loop engine."},
	{letter: "E", name: "excepts", description: "Exception list."},
	{letter: "f", name: "features", description: "Feature settings."},
	{
		letter: "F",
		name: "featuresall",
		description: "All feature settings, including defaulted values.",
	},
	{letter: "", name: "gitsync", description: "GitSync statistics and configuration."},
	{letter: "g", name: "glines", description: "Global bans (G-lines)."},
	{letter: "j", name: "histogram", description: "Message length histogram."},
	{letter: "", name: "iauth", description: "IAuth statistics."},
	{letter: "", name: "iauthconf", description: "IAuth configuration."},
	{letter: "J", name: "jupes", description: "Nickname jupes."},
	{letter: "k", name: "klines", description: "Local bans (K-Lines)."},
	{letter: "l", name: "links", description: "Current connections information."},
	{
		letter: "t",
		name: "locals",
		description: "Local connection statistics (Total SND/RCV, etc).",
	},
	{letter: "R", name: "mappings", description: "Service mappings."},
	{letter: "d", name: "maskrules", description: "Dynamic routing configuration."},
	{letter: "z", name: "memory", description: "Memory/Structure allocation information."},
	{letter: "x", name: "memusage", description: "List usage information."},
	{letter: "", name: "metadata", description: "METADATA storage and queue statistics."},
	{letter: "L", name: "modules", description: "Dynamically loaded modules."},
	{letter: "T", name: "motds", description: "Configured Message Of The Day files."},
	{letter: "a", name: "nameservers", description: "DNS servers."},
	{letter: "o", name: "operators", description: "Operator information."},
	{letter: "p", name: "ports", description: "Listening ports."},
	{letter: "q", name: "quarantines", description: "Quarantined channels list."},
	{letter: "S", name: "shuns", description: "Global Shuns."},
	{letter: "s", name: "spoofhosts", description: "Spoofed hosts information."},
	{letter: "u", name: "uptime", description: "Current uptime & highest connection count."},
	{letter: "r", name: "usage", description: "System resource usage (Debug only)."},
	{letter: "w", name: "userload", description: "Userload statistics."},
	{letter: "U", name: "uworld", description: "Service server information."},
	{letter: "v", name: "vservers", description: "Verbose server information."},
	{letter: "V", name: "vserversmach", description: "Verbose server information."},
	{
		letter: "",
		name: "webhook",
		description: "Keycloak webhook listener: transport, refusals, handler counters.",
	},
	{letter: "W", name: "webirc", description: "WEBIRC configuration."},
	{
		letter: "",
		name: "webpush",
		description: "WEBPUSH VAPID key ring and subscription statistics.",
	},
	{letter: "Z", name: "zlines", description: "Global IP bans (Z-lines)."},
];

/**
 * Letters the server matches without regard to case (their table entries
 * lack STAT_FLAG_CASESENS, `s_stats.c:623-765`); every other letter is
 * case-sensitive (`s` spoofhosts is not `S` shuns).
 */
const CASE_INSENSITIVE = new Set(["c", "g", "i", "k", "o", "p", "q", "x", "y"]);

/**
 * The catalogue entry a selector names, resolved the way the server does:
 * a single character by letter (case-folded only for the case-insensitive
 * letters), anything longer by long name, case-insensitively. Undefined for
 * `*`, an empty selector and anything unknown (the server answers those
 * with its help list).
 */
export function statsEntry(selector: string): StatsEntry | undefined {
	const sel = selector.trim();

	if (sel.length === 0 || sel === "*") {
		return undefined;
	}

	if (sel.length === 1) {
		const exact = STATS_ENTRIES.find((e) => e.letter === sel);

		if (exact) {
			return exact;
		}

		const lower = sel.toLowerCase();
		return CASE_INSENSITIVE.has(lower)
			? STATS_ENTRIES.find((e) => e.letter === lower)
			: undefined;
	}

	const name = sel.toLowerCase();
	return STATS_ENTRIES.find((e) => e.name === name);
}

const TITLES: Record<string, string> = {
	access: "Client blocks",
	authtoken: "Auth tokens",
	chathistory: "Chathistory storage",
	chathistoryads: "Chathistory federation",
	classes: "Connection classes",
	commands: "Command usage",
	connect: "Connect blocks",
	crules: "Routing rules",
	dnsbl: "DNSBL",
	engine: "Event engine",
	excepts: "Exceptions",
	features: "Features (changed)",
	featuresall: "Features (all)",
	gitsync: "GitSync",
	glines: "G-lines",
	histogram: "Message length histogram",
	iauth: "IAuth statistics",
	iauthconf: "IAuth configuration",
	jupes: "Nick jupes",
	klines: "K-lines",
	links: "Connections",
	locals: "Local traffic",
	mappings: "Service mappings",
	maskrules: "Routing rules (masks)",
	memory: "Memory",
	memusage: "List usage",
	metadata: "Metadata storage",
	modules: "Modules",
	motds: "MOTD files",
	nameservers: "Nameservers",
	operators: "Operator blocks",
	ports: "Listening ports",
	quarantines: "Quarantined channels",
	shuns: "Shuns",
	spoofhosts: "Spoofed hosts",
	uptime: "Uptime",
	usage: "Resource usage",
	userload: "User load",
	uworld: "Service servers",
	vservers: "Servers",
	vserversmach: "Servers",
	webhook: "Keycloak webhook",
	webirc: "WebIRC blocks",
	webpush: "Web push",
	zlines: "Z-lines",
};

const HELP_TITLE = "STATS selectors";

/** `<c> (<name>) - <description>`, the letter a space for long-name-only entries. */
const HELP_LINE = /^(\S| ) \(([^)\s]+)\) - (.*)$/;

/** The selectors in a `STATS` help reply (NOTICE `<c> (<name>) - <description>`). */
export function parseStatsHelp(lines: IrcMessage[]): StatsEntry[] {
	const entries: StatsEntry[] = [];

	for (const msg of lines) {
		if (msg.command !== "NOTICE") {
			continue;
		}

		const m = HELP_LINE.exec(trailingOf(msg));

		if (m) {
			entries.push({letter: m[1].trim(), name: m[2], description: m[3]});
		}
	}

	return entries;
}

// ------------------------------------------------------------------ values

/** A number column value; text when the server sent something else. */
/** A port: an identifier, so no thousands separators (`8444`, not `8,444`). */
function portOf(value: string | undefined): ReportValue | undefined {
	return value !== undefined && /^\d+$/.test(value) ? mono(value) : value ? text(value) : undefined;
}

function num(value: string | undefined): ReportValue | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}

	const n = Number(value);
	return Number.isFinite(n) ? number(n) : text(value);
}

function bytesOf(value: string | undefined, scale = 1): ReportValue | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}

	const n = Number(value);
	return Number.isFinite(n) ? bytes(n * scale) : text(value);
}

function secondsOf(value: string | undefined): ReportValue | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}

	const n = Number(value);
	return Number.isFinite(n) ? duration(n) : text(value);
}

/** An absolute unix time as an expiry (0 → never). */
function expiryOf(value: string | undefined): ReportValue | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}

	const n = Number(value);
	return Number.isFinite(n) ? expiry(n > 0 ? fromUnix(n) : 0) : text(value);
}

/** An absolute unix time (0 → nothing to show). */
function timeOf(value: string | undefined): ReportValue | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}

	const n = Number(value);

	if (!Number.isFinite(n)) {
		return text(value);
	}

	return n > 0 ? time(fromUnix(n)) : undefined;
}

/**
 * A ban's state token (`+`, `-`, `>+`, `>-`, `<+`, `<-`): the global active
 * flag, optionally preceded by this server's local override. Effectively
 * active when globally active and not locally deactivated, or locally
 * activated (`gline.h:100-102`).
 */
export function banState(token: string): ReportValue {
	const local = token.length > 1 ? token[0] : "";
	const global = token.endsWith("+");
	const active = local === ">" || (global && local !== "<");

	if (local === ">") {
		return state("active (locally activated)", true);
	}

	if (local === "<") {
		return state("inactive (locally deactivated)", false);
	}

	return state(active ? "active" : "inactive", active);
}

/** A `user@host` mask; `*` and empty stay as they are. */
function hostOf(value: string | undefined): ReportValue | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}

	return host(value);
}

/** A `[0]<ipmask>`: the server prefixes `0` to a mask starting with `:`. */
function ipMaskOf(value: string | undefined): ReportValue | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}

	const v = value.startsWith("0:") ? value.slice(1) : value;
	return v === "*" ? mono(v) : ip(v);
}

// ------------------------------------------------------------------ tables

type Row = Record<string, ReportValue | undefined>;

interface TableSpec {
	numerics: string[];
	columns: ReportColumn[];
	/**
	 * A row from the params after our own nick: a Row, `null` to skip the
	 * line silently (a header row), undefined when it does not parse (kept
	 * as a line).
	 */
	row: (this: void, params: string[], msg: IrcMessage) => Row | null | undefined;
	sort?: (this: void, a: Row, b: Row) => number;
}

const right = (key: string, label: string): ReportColumn => ({key, label, align: "right"});
const left = (key: string, label: string): ReportColumn => ({key, label});

/** Table sections from `data`, with the lines that did not parse after them. */
function tableSections(spec: TableSpec, data: IrcMessage[]): ReportSection[] {
	const rows: Row[] = [];
	const leftover: string[] = [];

	for (const msg of data) {
		if (!spec.numerics.includes(msg.command)) {
			leftover.push(lineText(msg));
			continue;
		}

		let row: Row | null | undefined;

		try {
			row = spec.row(msg.params.slice(1), msg);
		} catch {
			row = undefined;
		}

		if (row === null) {
			continue;
		}

		if (row === undefined) {
			leftover.push(lineText(msg));
			continue;
		}

		rows.push(row);
	}

	if (spec.sort) {
		rows.sort(spec.sort);
	}

	const sections: ReportSection[] = [];

	if (rows.length > 0) {
		sections.push({table: {columns: spec.columns, rows}});
	}

	if (leftover.length > 0) {
		sections.push({lines: leftover});
	}

	return sections;
}

function banTable(numeric: string): TableSpec {
	return {
		numerics: [numeric],
		columns: [
			left("mask", "Mask"),
			left("expires", "Expires"),
			left("lastmod", "Last changed"),
			left("lifetime", "Kept until"),
			left("state", "State"),
			left("reason", "Reason"),
		],
		// <G|S|Z> <mask> <expire> <lastmod> <lifetime> <state><+|-> <reason>
		row(p) {
			if (p.length < 7) {
				return undefined;
			}

			return {
				mask: mask(p[1]),
				expires: expiryOf(p[2]),
				lastmod: timeOf(p[3]),
				lifetime: expiryOf(p[4]),
				state: banState(p[5]),
				reason: text(p.slice(6).join(" ")),
			};
		},
	};
}

/** `P` port flag letters (`listener.c:131-188`); `C`/`S` become the kind column. */
const PORT_FLAGS: Record<string, string> = {
	E: "TLS",
	W: "WebSocket",
	A: "autodetect",
	"4": "IPv4",
	"6": "IPv6",
	H: "hidden",
	P: "paste",
};

/** `E` except flags (`s_stats.c` stats_excepts). */
const EXCEPT_FLAGS: Record<string, string> = {
	s: "shun",
	k: "K-line",
	g: "G-line",
	z: "Z-line",
	i: "ident",
	r: "rDNS",
	I: "IPcheck",
	t: "target limit",
	l: "list delay",
};

/** `W` webirc flags (`s_stats.c` stats_webirc); `*` means none. */
const WEBIRC_FLAGS: Record<string, string> = {
	u: "user ident",
	i: "no ident",
	f: "strip TLS fingerprint",
	o: "options",
	a: "trust account",
};

/** `V` server flags: one letter or `-` per position. */
const SERVER_FLAGS: Record<string, string> = {
	B: "bursting",
	A: "burst ack",
	H: "hub",
	S: "service",
	"6": "IPv6",
	O: "oplevels",
};

function flagChips(letters: string, names: Record<string, string>, skip = ""): ReportValue {
	const out: string[] = [];

	for (const letter of letters) {
		if (letter === "-" || letter === "*" || skip.includes(letter)) {
			continue;
		}

		out.push(names[letter] ?? letter);
	}

	return chips(out);
}

const TABLES: Record<string, TableSpec> = {
	glines: banTable("247"),
	shuns: banTable("542"),
	zlines: banTable("546"),
	jupes: {
		numerics: ["222"],
		columns: [left("nick", "Nick")],
		row: (p) => (p[0] === "J" && p[1] ? {nick: mono(p[1])} : undefined),
	},
	klines: {
		numerics: ["216"],
		columns: [
			left("mask", "Mask"),
			left("type", "Type"),
			left("reason", "Reason"),
			left("realname", "Real name mask"),
			left("version", "Version mask"),
			left("country", "Country"),
			left("continent", "Continent"),
		],
		// <K|k> <user>@<host> "<reason>" "<realname>" "<version>" <cc> <continent> 0 0
		row(p) {
			const m = /^([Kk]) (\S+) "(.*?)" "(.*?)" "(.*?)" (\S+) (\S+) \S+ \S+$/.exec(
				p.join(" ")
			);

			if (!m) {
				return undefined;
			}

			return {
				mask: host(m[2]),
				type: text(m[1] === "k" ? "CIDR" : "host"),
				reason: text(m[3]),
				realname: mono(m[4]),
				version: mono(m[5]),
				country: mono(m[6]),
				continent: mono(m[7]),
			};
		},
	},
	operators: {
		numerics: ["243"],
		columns: [
			left("name", "Name"),
			left("mask", "Host"),
			left("kind", "Kind"),
			left("class", "Class"),
		],
		// <O|o> <user>@<host> * <name> <class>
		row(p) {
			if (p.length < 5 || (p[0] !== "O" && p[0] !== "o")) {
				return undefined;
			}

			return {
				name: text(p[3]),
				mask: host(p[1]),
				kind: text(p[0] === "O" ? "global" : "local"),
				class: text(p[4]),
			};
		},
	},
	ports: {
		numerics: ["217"],
		columns: [
			right("port", "Port"),
			right("conns", "Connections"),
			left("kind", "Kind"),
			left("flags", "Flags"),
			left("state", "State"),
			left("bind", "Bound to"),
		],
		// P <port> <conns> <flags> <active|disabled> [<bindip>]
		row(p) {
			if (p.length < 5 || p[0] !== "P") {
				return undefined;
			}

			return {
				port: portOf(p[1]),
				conns: num(p[2]),
				kind: text(p[3].includes("S") ? "server" : "client"),
				flags: flagChips(p[3], PORT_FLAGS, "CS"),
				state: state(p[4], p[4] === "active"),
				bind: p[5] ? mono(p[5]) : undefined,
			};
		},
	},
	classes: {
		numerics: ["218"],
		columns: [
			left("class", "Class"),
			right("ping", "Ping every"),
			right("connfreq", "Connect every"),
			right("maxlinks", "Max links"),
			right("sendq", "SendQ"),
			right("recvq", "RecvQ"),
			right("links", "Connected"),
		],
		// <Y|y> <class> <ping> <connfreq> <maxlinks> <sendq> <recvq> <links>
		row(p) {
			if (p.length < 8 || (p[0] !== "Y" && p[0] !== "y")) {
				return undefined;
			}

			return {
				class: text(p[0] === "y" ? `${p[1]} (invalid)` : p[1]),
				ping: secondsOf(p[2]),
				connfreq: secondsOf(p[3]),
				maxlinks: num(p[4]),
				sendq: bytesOf(p[5]),
				recvq: bytesOf(p[6]),
				links: num(p[7]),
			};
		},
	},
	links: {
		numerics: ["211"],
		columns: [
			left("name", "Connection"),
			right("sendq", "SendQ"),
			right("sentMsgs", "Sent"),
			right("sentBytes", "Sent bytes"),
			right("recvMsgs", "Received"),
			right("recvBytes", "Received bytes"),
			right("open", "Open for"),
		],
		// header: Connection SendQ SendM SendKBytes RcveM RcveKBytes :Open since
		// rows:   <name> <sendq> <sendM> <sendKB> <rcveM> <rcveKB> <secs>
		row(p) {
			if (p[0] === "Connection" && p[1] === "SendQ") {
				return null;
			}

			if (p.length < 7) {
				return undefined;
			}

			return {
				name: text(p[0]),
				sendq: bytesOf(p[1]),
				sentMsgs: num(p[2]),
				sentBytes: bytesOf(p[3], 1024),
				recvMsgs: num(p[4]),
				recvBytes: bytesOf(p[5], 1024),
				open: secondsOf(p[6]),
			};
		},
	},
	commands: {
		numerics: ["212"],
		columns: [left("command", "Command"), right("count", "Count"), right("bytes", "Bytes")],
		row(p) {
			if (p.length < 3) {
				return undefined;
			}

			return {command: mono(p[0]), count: num(p[1]), bytes: bytesOf(p[2])};
		},
		sort: (a, b) => numberOf(b.count) - numberOf(a.count),
	},
	connect: {
		numerics: ["213"],
		columns: [
			left("name", "Server"),
			left("host", "Host"),
			right("port", "Port"),
			right("max", "Maximum"),
			left("hub", "Hub limit"),
			left("class", "Class"),
		],
		// C <name> * <host> <port> <maximum> <hub_limit|<NULL>> <class>
		row(p) {
			if (p.length < 8 || p[0] !== "C") {
				return undefined;
			}

			return {
				name: server(p[1]),
				host: host(p[3]),
				port: portOf(p[4]),
				max: num(p[5]),
				hub: p[6] === "<NULL>" ? undefined : mono(p[6]),
				class: text(p[7]),
			};
		},
	},
	access: {
		numerics: ["215"],
		columns: [
			left("host", "Host"),
			right("max", "Maximum"),
			left("ip", "IP mask"),
			right("port", "Port"),
			left("class", "Class"),
		],
		// I <[user@]host> <max> <[0]ipmask|*> <port> <class>
		row(p) {
			if (p.length < 6 || p[0] !== "I") {
				return undefined;
			}

			return {
				host: hostOf(p[1]),
				max: num(p[2]),
				ip: ipMaskOf(p[3]),
				port: portOf(p[4]),
				class: text(p[5]),
			};
		},
	},
	excepts: {
		numerics: ["223"],
		columns: [left("mask", "Mask"), left("flags", "Exempt from")],
		// E <user>@<host> * <flags>
		row(p) {
			if (p.length < 2 || p[0] !== "E") {
				return undefined;
			}

			return {mask: host(p[1]), flags: flagChips(p[3] ?? "", EXCEPT_FLAGS)};
		},
	},
	features: featureTable(),
	featuresall: featureTable(),
	quarantines: {
		numerics: ["228"],
		columns: [left("channel", "Channel"), left("reason", "Reason")],
		// Q <chan> <reason>
		row(p) {
			if (p.length < 2 || p[0] !== "Q") {
				return undefined;
			}

			return {channel: channel(p[1]), reason: text(p.slice(2).join(" "))};
		},
	},
	spoofhosts: {
		numerics: ["245"],
		columns: [
			right("index", "#"),
			left("kind", "Kind"),
			left("spoof", "Spoofed host"),
			left("mask", "Applies to"),
		],
		// <index> <auto|oper|user> <spoofhost> <user>@<host>
		row(p) {
			if (p.length < 3) {
				return undefined;
			}

			const applies = p[3] && p[3] !== "@" ? host(p[3]) : undefined;
			return {index: num(p[0]), kind: text(p[1]), spoof: host(p[2]), mask: applies};
		},
	},
	webirc: {
		numerics: ["220"],
		columns: [
			left("mask", "Mask"),
			left("ident", "Ident"),
			left("flags", "Flags"),
			left("description", "Description"),
		],
		// W <user>@<host> * <ident|(none)> <flags> <description>
		row(p) {
			if (p.length < 5 || p[0] !== "W") {
				return undefined;
			}

			return {
				mask: host(p[1]),
				ident: p[3] === "(none)" ? undefined : mono(p[3]),
				flags: flagChips(p[4], WEBIRC_FLAGS),
				description: p.length > 5 ? text(p.slice(5).join(" ")) : undefined,
			};
		},
	},
	uworld: {
		numerics: ["248"],
		columns: [left("server", "Server")],
		row: (p) => (p[0] === "U" && p[1] ? {server: server(p[1])} : undefined),
	},
	vserversmach: {
		numerics: ["236"],
		columns: [
			left("server", "Server"),
			left("uplink", "Uplink"),
			left("flags", "Flags"),
			right("hops", "Hops"),
			left("numeric", "Numeric"),
			right("lag", "Lag"),
			right("rtt", "RTT (ms)"),
			right("up", "Up (ms)"),
			right("down", "Down (ms)"),
			right("clients", "Clients"),
			left("proto", "Protocol"),
			left("linkts", "Linked"),
			left("info", "Info"),
		],
		// <name> <uplink> <flags6> <hops> <numeric> <numint> <lag> <rtt> <up>
		// <down> <clients> <maxmask> P<proto> <linkts> <info>
		row(p) {
			if (p.length < 15 || !/^[-BAHS6O]{6}$/.test(p[2])) {
				return undefined;
			}

			return {
				server: server(p[0]),
				uplink: server(p[1]),
				flags: flagChips(p[2], SERVER_FLAGS),
				hops: num(p[3]),
				numeric: mono(p[4]),
				lag: num(p[6]),
				rtt: num(p[7]),
				up: num(p[8]),
				down: num(p[9]),
				clients: num(p[10]),
				proto: text(p[12]),
				linkts: timeOf(p[13]),
				info: text(p.slice(14).join(" ")),
			};
		},
	},
	motds: {
		numerics: ["246"],
		columns: [left("mask", "Host mask"), left("path", "File")],
		// T <hostmask> <path>
		row(p) {
			if (p.length < 3 || p[0] !== "T") {
				return undefined;
			}

			return {mask: host(p[1]), path: mono(p.slice(2).join(" "))};
		},
	},
	crules: ruleTable(),
	maskrules: ruleTable(),
	modules: {
		numerics: ["241"],
		columns: [
			left("module", "Module"),
			left("description", "Description"),
			left("entry", "Entry point"),
		],
		// header: Module  Description      Entry Point
		// rows:   <module>  <description…>     0x<entry>
		row(p) {
			if (p[0] === "Module" && p[1] === "Description") {
				return null;
			}

			if (p.length < 2) {
				return undefined;
			}

			const last = p[p.length - 1];
			const hasEntry = /^0x[0-9a-f]+$/i.test(last) && p.length >= 3;
			return {
				module: mono(p[0]),
				description: text(p.slice(1, hasEntry ? -1 : undefined).join(" ")),
				entry: hasEntry ? mono(last) : undefined,
			};
		},
	},
	nameservers: {
		numerics: ["226"],
		columns: [left("ip", "Address")],
		row: (p) => (p[0] ? {ip: ip(p[0])} : undefined),
	},
	mappings: {
		numerics: ["276"],
		columns: [
			left("command", "Command"),
			left("name", "Name"),
			left("prepend", "Prepend"),
			left("target", "Target"),
		],
		// header: Command   Name      Prepend    Target
		row(p) {
			if (p[0] === "Command" && p[1] === "Name") {
				return null;
			}

			if (p.length < 4) {
				return undefined;
			}

			return {
				command: mono(p[0]),
				name: mono(p[1]),
				prepend: p[2] === "*" ? undefined : mono(p[2]),
				target: text(p.slice(3).join(" ")),
			};
		},
	},
};

function featureTable(): TableSpec {
	return {
		numerics: ["238"],
		columns: [left("name", "Feature"), left("value", "Value"), left("set", "Set")],
		// <F|f> <NAME> [<value…>]; also F LOG <subsys> <FILE|FACILITY|SNOMASK|LEVEL> <value>
		// and F LOG <facility>
		row(p) {
			if (p.length < 2 || (p[0] !== "F" && p[0] !== "f")) {
				return undefined;
			}

			let name = p[1];
			let value = p.slice(2).join(" ");

			if (p[1] === "LOG" && p.length >= 5) {
				name = `LOG ${p[2]} ${p[3]}`;
				value = p.slice(4).join(" ");
			}

			return {
				name: mono(name),
				value: value === "" ? text("not set") : mono(value),
				set: state(p[0] === "F" ? "set" : "default", p[0] === "F"),
			};
		},
	};
}

function ruleTable(): TableSpec {
	return {
		numerics: ["275"],
		columns: [left("kind", "Applies to"), left("mask", "Server mask"), left("rule", "Rule")],
		// <D|d> <servermask> <rule…>
		row(p) {
			if (p.length < 3 || (p[0] !== "D" && p[0] !== "d")) {
				return undefined;
			}

			return {
				kind: text(p[0] === "D" ? "all" : "masks"),
				mask: mask(p[1]),
				rule: mono(p.slice(2).join(" ")),
			};
		},
	};
}

function numberOf(value: ReportValue | undefined): number {
	return value && value.t === "number" ? value.v : -Infinity;
}

// ------------------------------------------------------------------ special shapes

/** `u`: 242 uptime and 250 highest connection count, as label/values. */
function uptimeSections(data: IrcMessage[]): ReportSection[] {
	const entries: ReportEntry[] = [];
	const leftover: string[] = [];

	for (const msg of data) {
		const t = trailingOf(msg);
		const up = msg.command === "242" && /Server Up (\d+) days?, (\d+):(\d{2}):(\d{2})/.exec(t);
		const max =
			msg.command === "250" && /Highest connection count: (\d+) \((\d+) clients?\)/.exec(t);

		if (up) {
			const secs =
				Number(up[1]) * 86400 + Number(up[2]) * 3600 + Number(up[3]) * 60 + Number(up[4]);
			entries.push({label: "Up for", value: duration(secs)});
		} else if (max) {
			entries.push({label: "Highest connection count", value: number(Number(max[1]))});
			entries.push({label: "Highest client count", value: number(Number(max[2]))});
		} else {
			leftover.push(lineText(msg));
		}
	}

	return withLeftover(entries.length > 0 ? [{entries}] : [], leftover);
}

/** `e`: 237 `<engine> :Event loop engine`. */
function engineSections(data: IrcMessage[]): ReportSection[] {
	const entries: ReportEntry[] = [];
	const leftover: string[] = [];

	for (const msg of data) {
		if (msg.command === "237" && msg.params[1]) {
			entries.push({label: "Engine", value: mono(msg.params[1])});
		} else {
			leftover.push(lineText(msg));
		}
	}

	return withLeftover(entries.length > 0 ? [{entries}] : [], leftover);
}

/**
 * `w`: untagged NOTICEs — a header (`Minute  Hour    Day   Yest. YYest.
 * Userload for:`) and three rows of loads, `%4d.%1d  %4d.%1d  %4d  %4d  %4d
 * <what>`.
 */
function userloadSections(data: IrcMessage[]): ReportSection[] {
	const rows: Row[] = [];
	const leftover: string[] = [];

	for (const msg of data) {
		const t = msg.command === "NOTICE" ? trailingOf(msg) : "";

		if (/Userload for:/.test(t)) {
			continue;
		}

		const m = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(
			t
		);

		if (!m) {
			leftover.push(lineText(msg));
			continue;
		}

		rows.push({
			what: text(m[6]),
			minute: number(Number(m[1])),
			hour: number(Number(m[2])),
			day: number(Number(m[3])),
			yesterday: number(Number(m[4])),
			before: number(Number(m[5])),
		});
	}

	const sections: ReportSection[] = [];

	if (rows.length > 0) {
		sections.push({
			table: {
				columns: [
					left("what", "Load of"),
					right("minute", "Minute"),
					right("hour", "Hour"),
					right("day", "Day"),
					right("yesterday", "Yesterday"),
					right("before", "Day before"),
				],
				rows,
			},
		});
	}

	return withLeftover(sections, leftover);
}

/** The free-text 249 selectors (j, r, t, x, z, iauth, iauthconf): monospaced lines. */
function freeTextSections(data: IrcMessage[]): ReportSection[] {
	return [{lines: data.map(lineText)}];
}

/** A 249 line's text without its subsystem tag letter (`W :  Store: …`). */
function subsystemText(msg: IrcMessage): string {
	if (msg.command === "249" && msg.params.length >= 3 && /^[A-Z]$/.test(msg.params[1])) {
		return msg.params.slice(2).join(" ");
	}

	return lineText(msg);
}

const KEY_VALUE = /^\s*([^:]{1,40}?):\s+(.+)$/;

/**
 * The nefarious subsystems (chathistory `H`, metadata `M`, webpush `W`,
 * webhook `W`, dnsbl `D`, authtoken / chathistoryads `A`, gitsync): the
 * first line is a title, `Key: value` lines are entries, an unindented line
 * without a colon starts a new block, anything else is kept as a line.
 */
function subsystemSections(data: IrcMessage[]): ReportSection[] {
	const sections: ReportSection[] = [];
	let current: ReportSection | undefined;

	const open = (title: string): ReportSection => {
		const section: ReportSection = {title: title.replace(/:\s*$/, "").trim()};
		sections.push(section);
		return section;
	};

	for (const msg of data) {
		const t = subsystemText(msg);

		if (!current) {
			current = open(t);
			continue;
		}

		const kv = KEY_VALUE.exec(t);

		if (kv) {
			const value = kv[2].trim();
			(current.entries ??= []).push({
				label: kv[1].trim(),
				value: /^-?\d+$/.test(value) ? number(Number(value)) : text(value),
			});
			continue;
		}

		if (!/^\s/.test(t) && t.trim() !== "") {
			current = open(t);
			continue;
		}

		(current.lines ??= []).push(t.replace(/^\s{2}/, ""));
	}

	return sections;
}

function helpSections(entries: StatsEntry[]): ReportSection[] {
	return [
		{
			table: {
				columns: [
					left("letter", "Letter"),
					left("name", "Name"),
					left("description", "Description"),
				],
				rows: entries.map((e) => ({
					letter: e.letter ? mono(e.letter) : undefined,
					name: mono(e.name),
					description: text(e.description),
				})),
			},
		},
	];
}

function withLeftover(sections: ReportSection[], leftover: string[]): ReportSection[] {
	return leftover.length > 0 ? [...sections, {lines: leftover}] : sections;
}

const FREE_TEXT = new Set([
	"histogram",
	"usage",
	"locals",
	"memusage",
	"memory",
	"iauth",
	"iauthconf",
	"vservers",
]);

const SUBSYSTEMS = new Set([
	"chathistory",
	"chathistoryads",
	"metadata",
	"webpush",
	"webhook",
	"dnsbl",
	"authtoken",
	"gitsync",
]);

function sectionsFor(name: string, data: IrcMessage[]): ReportSection[] {
	const spec = TABLES[name];

	if (spec) {
		return tableSections(spec, data);
	}

	switch (name) {
		case "uptime":
			return uptimeSections(data);
		case "engine":
			return engineSections(data);
		case "userload":
			return userloadSections(data);
	}

	if (FREE_TEXT.has(name)) {
		return freeTextSections(data);
	}

	if (SUBSYSTEMS.has(name)) {
		return subsystemSections(data);
	}

	return [{lines: data.map(lineText)}];
}

// ------------------------------------------------------------------ the report

export function statsReport(selector: string, lines: IrcMessage[], command: string): OperReport {
	const sel = selector.trim();
	const entry = statsEntry(sel);
	const subtitle = `STATS ${sel || "*"}`;
	const raw = rawLines(lines);
	const title = entry ? TITLES[entry.name] ?? entry.description : HELP_TITLE;

	try {
		// 542 (shuns) and 546 (Z-lines) are rows in the 5xx range; errorOf
		// knows them (../../errors.ts isErrorNumeric).
		const error = errorOf(lines);

		if (error) {
			return {...errorReport("stats", title, command, lines, error), subtitle};
		}

		// The closing 219 (and any stray BATCH line) is framing, not content.
		const data = lines.filter((msg) => msg.command !== "219" && msg.command !== "BATCH");
		const report: OperReport = {kind: "stats", title, subtitle, command, sections: [], raw};

		if (data.length === 0) {
			report.notes = ["Nothing to show"];
			return report;
		}

		const help = parseStatsHelp(data);

		// The help list: asked for (`*`, nothing, an unknown selector), or
		// what a server sends for a selector it does not have (`webhook` on
		// an older build, `usage` without DEBUGMODE).
		if (!entry || (help.length > 0 && help.length === data.length)) {
			report.title = HELP_TITLE;

			if (help.length === 0) {
				report.sections = [{lines: data.map(lineText)}];
				return report;
			}

			report.sections = withLeftover(
				helpSections(help),
				data.filter((msg) => !isHelpLine(msg)).map(lineText)
			);

			if (sel && sel !== "*") {
				report.notes = [
					`The server does not know "${sel}"; this is its list of selectors.`,
				];
			}

			return report;
		}

		report.sections = sectionsFor(entry.name, data);

		if (report.sections.length === 0) {
			report.notes = ["Nothing to show"];
		}

		return report;
	} catch {
		// Never throw over a reply: show it as it came.
		return {kind: "stats", title, subtitle, command, sections: [{lines: raw}], raw};
	}
}

function isHelpLine(msg: IrcMessage): boolean {
	return msg.command === "NOTICE" && HELP_LINE.test(trailingOf(msg));
}
