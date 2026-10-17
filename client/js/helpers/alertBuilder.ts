/**
 * The alert builder's form logic (docs/projects/oper-tools.md, "The alert
 * builder"): O3's `addalert` as a form — the reactions and the level each
 * needs, the expiry options in X3's duration units, the criteria as rows
 * (one keyword, its value, a switch), which rows are **wide** (would catch
 * bystanders on their own) and so arrive switched off, the command
 * assembled live with the reason last as X3 requires, and a stored
 * criteria string parsed back into rows for editing. Pure functions over
 * plain data, so mocha covers them (test/helpers/alertBuilder.ts); the
 * component is Oper/AlertBuilder.vue, the wire side irc/alerts.ts. The
 * wire facts are docs/resources/x3-services.md §7.
 */

import type {ServiceAlert} from "../irc/services/types";

// -------------------------------------------------------------- reactions

export interface ReactionDef {
	id: string;
	label: string;
	/** The O3 level the reaction needs (x3-services.md §7 Alerts). */
	level: number;
	/** A criterion the reaction cannot do without. */
	needs?: string;
}

/** ADDALERT itself is level 800, so that is the base. */
export const ALERT_BASE_LEVEL = 800;

export const REACTIONS: ReactionDef[] = [
	{id: "notice", label: "Notice the opers", level: ALERT_BASE_LEVEL},
	{id: "noticeuser", label: "Notice the user", level: ALERT_BASE_LEVEL},
	{id: "msguser", label: "Message the user", level: ALERT_BASE_LEVEL},
	{id: "gline", label: "G-line", level: 900},
	{id: "shun", label: "Shun", level: 900},
	{id: "tempshun", label: "Temporary shun", level: 900},
	{id: "track", label: "Track", level: 900},
	{id: "kill", label: "Kill", level: 900},
	{id: "mark", label: "Mark", level: 999},
	{id: "version", label: "Ask for the version", level: 999},
	{id: "svsjoin", label: "Force-join a channel", level: 999, needs: "chantarget"},
	{id: "svspart", label: "Force-part a channel", level: 999, needs: "chantarget"},
];

export function reactionDef(id: string): ReactionDef | undefined {
	return REACTIONS.find((r) => r.id === id);
}

/** Whether the oper's level, when known, is short of what the reaction needs. */
export function reactionTooLow(reaction: ReactionDef, level: number | undefined): boolean {
	return level !== undefined && level < reaction.level;
}

// ---------------------------------------------------------------- expiry

export type ExpiryId = "1d" | "3d" | "1w" | "1M" | "never";

export interface ExpiryDef {
	id: ExpiryId;
	label: string;
	/** Seconds, 0 for never. */
	seconds: number;
}

const DAY = 86400;

/** In X3's units (`1d 3d 1w 1M`, case-sensitive: `M` is a month). */
export const EXPIRIES: ExpiryDef[] = [
	{id: "1d", label: "today", seconds: DAY},
	{id: "3d", label: "3 days", seconds: 3 * DAY},
	{id: "1w", label: "1 week", seconds: 7 * DAY},
	{id: "1M", label: "1 month", seconds: 30 * DAY},
	{id: "never", label: "never", seconds: 0},
];

export const DEFAULT_EXPIRY: ExpiryId = "1w";

/**
 * The option an existing alert's expiry date falls under, for editing: the
 * shortest that still reaches it, `never` without a date, `1M` past a
 * month.
 */
export function expiryFor(expires: string | undefined, now = Date.now()): ExpiryId {
	if (!expires) {
		return "never";
	}

	const at = Date.parse(expires.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (\S+)$/, "$1T$2$3"));

	if (!Number.isFinite(at)) {
		return DEFAULT_EXPIRY;
	}

	const left = Math.max(0, (at - now) / 1000);

	for (const e of EXPIRIES) {
		if (e.seconds > 0 && left <= e.seconds) {
			return e.id;
		}
	}

	return "1M";
}

// -------------------------------------------------------------- criteria

export interface CriterionDef {
	/** O3's keyword (`info`, `nickage`). */
	key: string;
	/** In plain words (`realname`, `nick age`). */
	label: string;
	placeholder: string;
}

/** The criteria the builder offers, in the order the "add" list shows them. */
export const CRITERIA: CriterionDef[] = [
	{key: "channel", label: "in channel", placeholder: "#chan"},
	{key: "authed", label: "authed", placeholder: "yes or no"},
	{key: "info", label: "realname", placeholder: "a glob, * and ?"},
	{key: "ident", label: "ident", placeholder: "r???? (a glob)"},
	{key: "ip", label: "IP", placeholder: "1.2.3.4, 1.2.*, 1.2.3.0/24"},
	{key: "nickage", label: "nick age", placeholder: "<300 (seconds)"},
	{key: "last", label: "nick seen within", placeholder: "1h"},
	{key: "server", label: "server", placeholder: "a glob on the uplink"},
	{key: "nick", label: "nick", placeholder: "a glob"},
	{key: "host", label: "host", placeholder: "a glob on the hostname"},
	{key: "version", label: "version", placeholder: "a glob on the CTCP VERSION reply"},
	{key: "account", label: "account", placeholder: "a glob; implies authed"},
	{key: "clones", label: "clones from the IP", placeholder: "at least N"},
	{key: "numchannels", label: "channels", placeholder: "exactly N"},
	{key: "modes", label: "user modes", placeholder: "+o-i"},
	{key: "marked", label: "marked", placeholder: "a glob on the marks"},
	{key: "regex", label: "values are regexes", placeholder: "yes"},
	{key: "chantarget", label: "target channel", placeholder: "#chan (svsjoin, svspart)"},
];

export function criterionDef(key: string): CriterionDef | undefined {
	return CRITERIA.find((c) => c.key === key);
}

export interface CriterionRow {
	id: number;
	/** O3's keyword; one not in {@link CRITERIA} is kept as typed (an edited alert). */
	key: string;
	value: string;
	on: boolean;
}

let nextId = 0;

export function newRow(key: string, value: string, on = true): CriterionRow {
	return {id: ++nextId, key, value, on};
}

/**
 * Why a criterion is **wide** — would catch bystanders on its own — or
 * undefined when it is not: an IP range, a nick age or last-seen window, a
 * server, two clones or fewer, and `authed no` when it stands alone among
 * the rows that are on.
 */
export function wideReason(row: CriterionRow, rows: CriterionRow[]): string | undefined {
	const value = row.value.trim();

	switch (row.key) {
		case "ip":
			return /[*?/]/.test(value) ? "an IP range" : undefined;
		case "nickage":
			return "a nick age";
		case "last":
			return "a time window";
		case "server":
			return "a whole server";
		case "clones":
			return Number(value) <= 2 || !/^\d+$/.test(value) ? "2 clones or fewer" : undefined;

		case "authed": {
			if (/^(no|false|0)$/i.test(value)) {
				const others = rows.filter((r) => r !== row && r.on && r.value.trim() !== "");
				return others.length === 0 ? "every unauthed user" : undefined;
			}

			return undefined;
		}

		default:
			return undefined;
	}
}

/** A fact as the cards compute it (helpers/commonality.ts `FactKey` and its value). */
export interface Fact {
	key: string;
	value: string;
}

/**
 * A shared fact as a criterion: `authed` as is, the realname as `info`,
 * the ident glob as `ident`, the /24 or an exact IP as `ip`, the server,
 * the version. The connect age has none — X3's `nickage` is the nick's
 * timestamp, not the connection's.
 */
export function factCriterion(fact: Fact): {key: string; value: string} | undefined {
	const value = fact.value.trim();

	switch (fact.key) {
		case "authed":
			return {key: "authed", value: /^(yes|true|1)$/i.test(value) ? "yes" : "no"};
		case "realname":
			return {key: "info", value};
		case "identShape":
			return {key: "ident", value};
		case "ipRange":
			return {key: "ip", value};
		case "server":
			return {key: "server", value};
		case "version":
			return {key: "version", value};
		default:
			return undefined;
	}
}

/**
 * The rows a card's facts become: every fact with a criterion, in the
 * facts' order, the wide ones switched off (judged with every row on, so a
 * lone `authed no` arrives off too).
 */
export function rowsFromFacts(facts: Fact[]): CriterionRow[] {
	const rows: CriterionRow[] = [];

	for (const fact of facts) {
		const c = factCriterion(fact);

		if (c && c.value !== "" && !rows.some((r) => r.key === c.key)) {
			rows.push(newRow(c.key, c.value));
		}
	}

	for (const row of rows) {
		if (wideReason(row, rows) !== undefined) {
			row.on = false;
		}
	}

	return rows;
}

// ------------------------------------------------------ the command

/** Letters, digits and dashes, as a name O3 will take and the oper can type. */
export function isValidName(name: string): boolean {
	return /^[A-Za-z0-9-]+$/.test(name);
}

function nameWord(text: string): string {
	return text.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `<channel>-bots` from a channel, `<nick>-alert` from a user, else empty. */
export function defaultName(from: {channel?: string; nick?: string}): string {
	if (from.channel) {
		const chan = nameWord(from.channel.replace(/^[#&+!]+/, ""));
		return chan ? `${chan}-bots` : "";
	}

	if (from.nick) {
		const nick = nameWord(from.nick);
		return nick ? `${nick}-alert` : "";
	}

	return "";
}

/** `bot group in #chan, see <me>` from a channel, `see <me>` otherwise. */
export function defaultReason(from: {channel?: string; me: string}): string {
	return from.channel ? `bot group in ${from.channel}, see ${from.me}` : `see ${from.me}`;
}

/**
 * A value as one word, as X3 reads criteria: `info` and `version` values
 * with spaces take `?` for each run of them (the same rule the cards'
 * `criterion` uses); every other value goes as typed.
 */
export function criterionWord(key: string, value: string): string {
	const v = value.trim();
	return key === "info" || key === "version" ? v.replace(/\s+/g, "?") : v;
}

/** The criteria text: every row that is on and has a value, `key value` each (`log`, which takes no value, alone). */
export function buildCriteria(rows: CriterionRow[]): string {
	return rows
		.filter((r) => r.on && (r.key === "log" || r.value.trim() !== ""))
		.map((r) => (r.key === "log" ? r.key : `${r.key} ${criterionWord(r.key, r.value)}`))
		.join(" ");
}

export interface AlertForm {
	name: string;
	reaction: string;
	expires: ExpiryId;
	rows: CriterionRow[];
	reason: string;
}

/** `addalert <name> <reaction> expire <dur> <criteria…> reason <reason>` — reason last, as X3 requires. */
export function buildCommand(form: AlertForm): string {
	const parts = ["addalert", form.name.trim() || "<name>", form.reaction];

	if (form.expires !== "never") {
		parts.push("expire", form.expires);
	}

	const criteria = buildCriteria(form.rows);

	if (criteria) {
		parts.push(criteria);
	}

	const reason = form.reason.trim();

	if (reason) {
		parts.push("reason", reason);
	}

	return parts.join(" ");
}

/**
 * A stored criteria string (`stats alerts`' `Criteria:` line) back into
 * rows and the reason: keywords in pairs (`log` alone), `reason` taking the rest, a
 * keyword the builder does not list kept as typed, every row on.
 */
export function parseCriteria(text: string): {rows: CriterionRow[]; reason?: string} {
	const words = text.trim().split(/\s+/).filter(Boolean);
	const rows: CriterionRow[] = [];
	let reason: string | undefined;

	for (let i = 0; i < words.length; i++) {
		const key = words[i].toLowerCase();

		if (key === "reason") {
			reason = words.slice(i + 1).join(" ");
			break;
		}

		if (key === "log") {
			rows.push(newRow(key, ""));
			continue;
		}

		const value = words[i + 1];

		if (value === undefined) {
			break;
		}

		rows.push(newRow(key, value));
		i++;
	}

	return reason === undefined ? {rows} : {rows, reason};
}

/** The form an existing alert makes, for Replace. */
export function formFromAlert(alert: ServiceAlert, now = Date.now()): AlertForm {
	const {rows, reason} = parseCriteria(alert.criteria);

	return {
		name: alert.name,
		reaction: reactionDef(alert.reaction) ? alert.reaction : "notice",
		expires: expiryFor(alert.expires, now),
		rows,
		reason: reason ?? "",
	};
}

// --------------------------------------------------------- the count line

/** Above this many matches the count line turns amber. */
export const MANY_MATCHES = 25;

/** `Matches 3 users right now · none are opers`, or that nothing does. */
export function matchesText(
	count: number,
	opers: string[] | undefined
): {text: string; warn: boolean} {
	if (count === 0) {
		return {text: "Nothing matches right now.", warn: false};
	}

	const users = `Matches ${count} ${count === 1 ? "user" : "users"} right now`;
	const who =
		opers === undefined
			? ""
			: opers.length === 0
			? " · none are opers"
			: ` · ${
					opers.length === 1 ? "one is an oper" : `${opers.length} are opers`
			  }: ${opers.join(", ")}`;
	const warn = count > MANY_MATCHES;

	return {
		text: `${users}${who}${warn ? " — that's a lot; check the criteria" : ""}`,
		warn,
	};
}

/** The request the `oper:alert-builder` eventbus event carries. */
export interface AlertBuilderRequest {
	/** The network's uuid. */
	network: string;
	/** Opened from a channel card: the channel. */
	channel?: string;
	/** Opened from a user card: the nick. */
	nick?: string;
	/** The card's facts, to become rows. */
	facts?: Fact[];
	/** An existing alert to replace. */
	edit?: ServiceAlert;
}
