/**
 * X3 (AfterNET's services; srvx 1.3 lineage): the snoop feed, the audit
 * log and the module log lines it writes into channels, and O3's ban
 * commands with their replies. Every format is docs/resources/x3-services.md
 * (§3 snoop, §4 audit, §7 bans), and the fixtures in test/irc/services/x3.ts
 * are copied from there verbatim.
 *
 * The text comes formatting-stripped (`$b` bold and friends removed) but
 * otherwise as sent. Kept free of store/DOM imports (mocha).
 */

import type {ServicesConfig} from "../../../../../shared/types/network";
import type {CoarseKind} from "../../../helpers/operActivity";
import type {
	AuditEvent,
	BanReply,
	ModuleLogEvent,
	ServicesBanRequest,
	ServicesProfile,
	SnoopEvent,
} from "../types";
import {x3Lookups} from "./lookups";

type Fields = Record<string, string>;

/** The role nicks and channels in X3's example config and on AfterNET. */
export const X3_DEFAULTS: ServicesConfig["bots"] = {
	oper: "O3",
	account: "AuthServ",
	channel: "ChanServ",
	report: "#operserv",
	snoop: "#mrsnoopy",
};

/**
 * The realnames X3 gives its bots unless the network set its own
 * (`services/<svc>/description`), x3-services.md §2: what a WHOIS reply
 * is matched against to say a bot "looks like X3".
 */
export const X3_REALNAMES = [
	"Oper Services",
	"Nick Services",
	"Channel Services",
	"Global Services",
	"Anti Spam Services",
];

// ----------------------------------------------------------------- snoop

/** `[HH:MM:SS] KEYWORD rest` (mod-snoop.c), the bold already stripped. */
const SNOOP_LINE =
	/^\[\d\d:\d\d:\d\d\] (NICK|CREATE|JOIN|PART|KICK|QUIT|KILL|AUTH|UMODE|OPER|MODE) (.*)$/;

interface SnoopRule {
	keyword: string;
	re: RegExp;
	map: (m: RegExpExecArray) => Fields;
}

/** `(ident@host, on server)` as the QUIT and KILL lines carry it. */
const WHERE = String.raw`\(([^@\s]+)@(\S+), on (\S+)\)`;

const SNOOP_RULES: Record<string, SnoopRule[]> = {
	NICK: [
		{
			keyword: "nick",
			re: /^change (\S+) -> (\S+)$/,
			map: (m) => ({nick: m[1], newNick: m[2]}),
		},
		{
			keyword: "connect",
			re: /^(\S+) ([^@\s]+)@(\S+) \((.*?)\) \[([^\]]*)\] on (\S+)$/,
			map: (m) => ({
				nick: m[1],
				ident: m[2],
				host: m[3],
				account: m[4],
				ip: m[5],
				server: m[6],
			}),
		},
	],
	CREATE: [
		{keyword: "create", re: /^(\S+) by (\S+)$/, map: (m) => ({channel: m[1], nick: m[2]})},
	],
	JOIN: [{keyword: "join", re: /^(\S+) by (\S+)$/, map: (m) => ({channel: m[1], nick: m[2]})}],
	PART: [
		{
			keyword: "part",
			re: /^(\S+) by (\S+) \((.*)\)$/,
			map: (m) => ({channel: m[1], nick: m[2], reason: m[3]}),
		},
	],
	KICK: [
		{
			keyword: "kick",
			re: /^(\S+) from (\S+) by (\S+)$/,
			map: (m) => ({nick: m[1], channel: m[2], kicker: m[3]}),
		},
	],
	QUIT: [
		{
			keyword: "quit",
			re: new RegExp(String.raw`^(\S+) ${WHERE} \((.*)\)$`),
			map: (m) => ({nick: m[1], ident: m[2], host: m[3], server: m[4], reason: m[5]}),
		},
	],
	KILL: [
		{
			keyword: "kill",
			re: new RegExp(String.raw`^(\S+) ${WHERE} by (\S+) \((.*)\)$`),
			map: (m) => ({
				nick: m[1],
				ident: m[2],
				host: m[3],
				server: m[4],
				killer: m[5],
				reason: m[6],
			}),
		},
	],
	AUTH: [{keyword: "auth", re: /^(\S+) as (\S+)$/, map: (m) => ({nick: m[1], account: m[2]})}],
	UMODE: [
		{
			// AfterNET's X3 appends the cloaked host and the cloaked IP after
			// the modes when `+x` is among them (x3-services.md §3). Kept as
			// `cloak` / `cloakIp`, never `host` / `ip`: a cloak is not a place.
			keyword: "umode",
			re: /^(\S+) (\S+)(?: (\S+) (\S+))?$/,
			map(m) {
				const fields: Fields = {nick: m[1], modes: m[2]};

				if (m[3] !== undefined) {
					fields.cloak = m[3];
					fields.cloakIp = m[4];
				}

				return fields;
			},
		},
	],
	OPER: [
		{
			keyword: "oper",
			re: /^([^!\s]+)!([^@\s]+)@(\S+) \[([^\]]*)\] on (\S+)$/,
			map: (m) => ({nick: m[1], ident: m[2], host: m[3], ip: m[4], server: m[5]}),
		},
	],
	MODE: [
		{
			keyword: "mode",
			re: /^(\S+) (.+) by (\S+)$/,
			map: (m) => ({channel: m[1], modes: m[2], setter: m[3]}),
		},
	],
};

export function parseSnoop(text: string): SnoopEvent | undefined {
	const line = SNOOP_LINE.exec(text);

	if (!line) {
		return undefined;
	}

	for (const rule of SNOOP_RULES[line[1]] ?? []) {
		const m = rule.re.exec(line[2]);

		if (m) {
			return {keyword: rule.keyword, fields: rule.map(m)};
		}
	}

	return undefined;
}

// ----------------------------------------------------------------- audit

/** `(<#chan>) [<nick>!<ident>@<host>:<account>]: <command args>` (log.c:995-1004). */
const AUDIT_LINE = /^\((#\S*)?\) \[([^!\]]+)!([^@\]]+)@([^\]]+)\]: (.*)$/;

/**
 * `host:account` from an audit line's brackets, where the host may be an
 * IPv6 address: with two colons or more the last part is the account only
 * when it cannot be the address's last group (`2001:db8::1:rubin`; an
 * all-hex account such as `beef` reads as part of the address).
 */
function hostAndAccount(text: string): {host: string; account?: string} {
	const colon = text.lastIndexOf(":");

	if (colon === -1) {
		return {host: text};
	}

	const tail = text.slice(colon + 1);

	if (text.indexOf(":") !== colon && /^[0-9a-f]{0,4}$/i.test(tail)) {
		return {host: text};
	}

	return tail ? {host: text.slice(0, colon), account: tail} : {host: text.slice(0, colon)};
}

/** O3's ban commands, in both spellings. */
const BAN_COMMANDS = new Set([
	"gline",
	"ungline",
	"block",
	"refreshg",
	"gsync",
	"shun",
	"sblock",
	"unshun",
	"ssync",
	"refreshs",
]);

/** ChanServ's commands that change a channel's modes, ops or bans. */
const CHANNEL_COMMANDS = new Set([
	"clearbans",
	"clearmodes",
	"op",
	"deop",
	"voice",
	"devoice",
	"hop",
	"dehop",
	"owner",
	"deowner",
	"admin",
	"deadmin",
	"kick",
	"kickban",
	"ban",
	"unban",
	"unbanme",
	"unbanall",
	"mode",
	"invite",
	"inviteme",
	"topic",
	"set",
	"uset",
	"wipeinfo",
]);

/** What a TRACE's action amounts to. */
const TRACE_ACTIONS: Record<string, CoarseKind> = {
	gline: "glines",
	shun: "glines",
	tempshun: "glines",
	kill: "kills",
};

export function auditCoarse(command: string, args: string): CoarseKind {
	if (BAN_COMMANDS.has(command)) {
		return "glines";
	}

	if (command === "trace") {
		const action = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
		return TRACE_ACTIONS[action] ?? "other";
	}

	if (CHANNEL_COMMANDS.has(command)) {
		return "modes";
	}

	if (command === "god") {
		return "opers";
	}

	if (command === "addalert" || command === "delalert") {
		return "alerts";
	}

	if (command === "rehash" || command === "die" || command === "restart") {
		return "rehash";
	}

	return "other";
}

export function parseAudit(text: string): AuditEvent | undefined {
	const m = AUDIT_LINE.exec(text);

	if (!m) {
		return undefined;
	}

	const rest = m[5].trim();
	const space = rest.search(/\s/);
	const command = (space === -1 ? rest : rest.slice(0, space)).toLowerCase();
	const args = space === -1 ? "" : rest.slice(space + 1).trim();

	if (!command) {
		return undefined;
	}

	const {host, account} = hostAndAccount(m[4]);
	const event: AuditEvent = {
		channel: m[1] ?? "",
		nick: m[2],
		ident: m[3],
		host,
		command,
		args,
		coarse: auditCoarse(command, args),
	};

	if (account) {
		event.account = account;
	}

	return event;
}

// ------------------------------------------------------------ module log

const SEVERITIES = "replay|debug|command|info|override|staff|warning|error|fatal";
const MODULE_LOG = new RegExp(`^([A-Za-z0-9_-]+) (${SEVERITIES}): (.*)$`);

export function parseModuleLog(text: string): ModuleLogEvent | undefined {
	const m = MODULE_LOG.exec(text);
	return m ? {facility: m[1], severity: m[2], message: m[3]} : undefined;
}

// ------------------------------------------------------------------ bans

/** X3's units, largest first, each exact (x3-services.md §1: `y M w d h m s`). */
const DURATION_UNITS: [string, number][] = [
	["w", 7 * 86400],
	["d", 86400],
	["h", 3600],
	["m", 60],
	["s", 1],
];

/** A number of seconds in X3's duration syntax: `1d12h`, `90m`, `30s`. */
export function x3Duration(seconds: number): string {
	let rest = Math.max(0, Math.round(seconds));
	let out = "";

	for (const [unit, size] of DURATION_UNITS) {
		if (rest >= size) {
			out += `${Math.floor(rest / size)}${unit}`;
			rest %= size;
		}
	}

	return out || "0s";
}

/**
 * `PRIVMSG <bot> :gline <mask> <duration> <reason>` — O3's GLINE and SHUN
 * take the mask, the duration and the reason as the rest of the line
 * (x3-services.md §7 Bans). No CIDR: O3 rejects it.
 */
export function banCommand(bot: string, ban: ServicesBanRequest): string {
	return `PRIVMSG ${bot} :${ban.type} ${ban.mask} ${x3Duration(ban.seconds)} ${ban.reason}`;
}

const BAN_REPLIES: {re: RegExp; ok: boolean}[] = [
	{re: /^(?:G-line|Shun) issued for (\S+)\.$/, ok: true},
	{re: /^Invalid (?:G-line|Shun) '(.*)'\.$/, ok: false},
	{re: /^(?:Gline|Shun) (\S+)\?\s+Now that would be smooth\.$/, ok: false},
	{re: /^Invalid time span '(.*)'\.$/, ok: false},
	{re: /^Access denied\.$/, ok: false},
	{re: /^(?:G-line|Shun) (?:removed|not found) for (\S+)\.$/, ok: true},
];

export function parseBanReply(text: string): BanReply | undefined {
	const line = text.trim();

	for (const {re, ok} of BAN_REPLIES) {
		const m = re.exec(line);

		if (m) {
			const reply: BanReply = {ok, text: line};

			if (m[1]) {
				reply.mask = m[1];
			}

			return reply;
		}
	}

	return undefined;
}

export function isServiceNick(nick: string, bots: ServicesConfig["bots"]): boolean {
	const wanted = nick.toLowerCase();
	return [bots.oper, bots.account, bots.channel].some(
		(bot) => bot !== "" && bot.toLowerCase() === wanted
	);
}

export const x3: ServicesProfile = {
	id: "x3",
	name: "X3",
	defaults: X3_DEFAULTS,
	parseSnoop,
	parseAudit,
	parseModuleLog,
	banCommand,
	parseBanReply,
	isServiceNick,
	lookups: x3Lookups,
};
