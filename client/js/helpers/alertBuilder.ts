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
import {t, tCount} from "../i18n/core";

// -------------------------------------------------------------- reactions

export interface ReactionDef {
	/** O3's keyword; its label is {@link reactionLabel}. */
	id: string;
	/** The O3 level the reaction needs (x3-services.md §7 Alerts). */
	level: number;
	/** A criterion the reaction cannot do without. */
	needs?: string;
}

/** ADDALERT itself is level 800, so that is the base. */
export const ALERT_BASE_LEVEL = 800;

export const REACTIONS: ReactionDef[] = [
	{id: "notice", level: ALERT_BASE_LEVEL},
	{id: "noticeuser", level: ALERT_BASE_LEVEL},
	{id: "msguser", level: ALERT_BASE_LEVEL},
	{id: "gline", level: 900},
	{id: "shun", level: 900},
	{id: "tempshun", level: 900},
	{id: "track", level: 900},
	{id: "kill", level: 900},
	{id: "mark", level: 999},
	{id: "version", level: 999},
	{id: "svsjoin", level: 999, needs: "chantarget"},
	{id: "svspart", level: 999, needs: "chantarget"},
];

/** A reaction in plain words (`Notice the opers`). */
export function reactionLabel(id: string): string {
	switch (id) {
		case "notice":
			return t("oper.alertBuilder.reaction.notice");
		case "noticeuser":
			return t("oper.alertBuilder.reaction.noticeuser");
		case "msguser":
			return t("oper.alertBuilder.reaction.msguser");
		case "gline":
			return t("oper.alertBuilder.reaction.gline");
		case "shun":
			return t("oper.alertBuilder.reaction.shun");
		case "tempshun":
			return t("oper.alertBuilder.reaction.tempshun");
		case "track":
			return t("oper.alertBuilder.reaction.track");
		case "kill":
			return t("oper.alertBuilder.reaction.kill");
		case "mark":
			return t("oper.alertBuilder.reaction.mark");
		case "version":
			return t("oper.alertBuilder.reaction.version");
		case "svsjoin":
			return t("oper.alertBuilder.reaction.svsjoin");
		case "svspart":
			return t("oper.alertBuilder.reaction.svspart");
		default:
			return id;
	}
}

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
	/** X3's duration; its label is {@link expiryLabel}. */
	id: ExpiryId;
	/** Seconds, 0 for never. */
	seconds: number;
}

const DAY = 86400;

/** In X3's units (`1d 3d 1w 1M`, case-sensitive: `M` is a month). */
export const EXPIRIES: ExpiryDef[] = [
	{id: "1d", seconds: DAY},
	{id: "3d", seconds: 3 * DAY},
	{id: "1w", seconds: 7 * DAY},
	{id: "1M", seconds: 30 * DAY},
	{id: "never", seconds: 0},
];

/** An expiry in plain words (`1 week`, `never`). */
export function expiryLabel(id: ExpiryId): string {
	switch (id) {
		case "1d":
			return t("oper.alertBuilder.expiry.1d");
		case "3d":
			return t("oper.alertBuilder.expiry.3d");
		case "1w":
			return t("oper.alertBuilder.expiry.1w");
		case "1M":
			return t("oper.alertBuilder.expiry.1M");
		default:
			return t("oper.alertBuilder.expiry.never");
	}
}

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
	/** O3's keyword (`info`, `nickage`); in words {@link criterionLabel}, its hint {@link criterionPlaceholder}. */
	key: string;
}

/** The criteria the builder offers, in the order the "add" list shows them. */
export const CRITERIA: CriterionDef[] = [
	{key: "channel"},
	{key: "authed"},
	{key: "info"},
	{key: "ident"},
	{key: "ip"},
	{key: "nickage"},
	{key: "last"},
	{key: "server"},
	{key: "nick"},
	{key: "host"},
	{key: "version"},
	{key: "account"},
	{key: "clones"},
	{key: "numchannels"},
	{key: "modes"},
	{key: "marked"},
	{key: "regex"},
	{key: "chantarget"},
];

/** A criterion in plain words (`realname`, `nick age`); one the builder does not list, its keyword. */
export function criterionLabel(key: string): string {
	switch (key) {
		case "channel":
			return t("oper.alertBuilder.criterion.channel");
		case "authed":
			return t("oper.alertBuilder.criterion.authed");
		case "info":
			return t("oper.alertBuilder.criterion.info");
		case "ident":
			return t("oper.alertBuilder.criterion.ident");
		case "ip":
			return t("oper.alertBuilder.criterion.ip");
		case "nickage":
			return t("oper.alertBuilder.criterion.nickage");
		case "last":
			return t("oper.alertBuilder.criterion.last");
		case "server":
			return t("oper.alertBuilder.criterion.server");
		case "nick":
			return t("oper.alertBuilder.criterion.nick");
		case "host":
			return t("oper.alertBuilder.criterion.host");
		case "version":
			return t("oper.alertBuilder.criterion.version");
		case "account":
			return t("oper.alertBuilder.criterion.account");
		case "clones":
			return t("oper.alertBuilder.criterion.clones");
		case "numchannels":
			return t("oper.alertBuilder.criterion.numchannels");
		case "modes":
			return t("oper.alertBuilder.criterion.modes");
		case "marked":
			return t("oper.alertBuilder.criterion.marked");
		case "regex":
			return t("oper.alertBuilder.criterion.regex");
		case "chantarget":
			return t("oper.alertBuilder.criterion.chantarget");
		default:
			return key;
	}
}

/** The hint in a criterion's value field (`a glob, * and ?`). */
export function criterionPlaceholder(key: string): string {
	switch (key) {
		case "channel":
			return t("oper.alertBuilder.placeholder.channel");
		case "authed":
			return t("oper.alertBuilder.placeholder.authed");
		case "info":
			return t("oper.alertBuilder.placeholder.info");
		case "ident":
			return t("oper.alertBuilder.placeholder.ident");
		case "ip":
			return t("oper.alertBuilder.placeholder.ip");
		case "nickage":
			return t("oper.alertBuilder.placeholder.nickage");
		case "last":
			return t("oper.alertBuilder.placeholder.last");
		case "server":
			return t("oper.alertBuilder.placeholder.server");
		case "nick":
			return t("oper.alertBuilder.placeholder.nick");
		case "host":
			return t("oper.alertBuilder.placeholder.host");
		case "version":
			return t("oper.alertBuilder.placeholder.version");
		case "account":
			return t("oper.alertBuilder.placeholder.account");
		case "clones":
			return t("oper.alertBuilder.placeholder.clones");
		case "numchannels":
			return t("oper.alertBuilder.placeholder.numchannels");
		case "modes":
			return t("oper.alertBuilder.placeholder.modes");
		case "marked":
			return t("oper.alertBuilder.placeholder.marked");
		case "regex":
			return t("oper.alertBuilder.placeholder.regex");
		case "chantarget":
			return t("oper.alertBuilder.placeholder.chantarget");
		default:
			return "";
	}
}

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
			return /[*?/]/.test(value) ? t("oper.alertBuilder.wide.ipRange") : undefined;
		case "nickage":
			return t("oper.alertBuilder.wide.nickage");
		case "last":
			return t("oper.alertBuilder.wide.last");
		case "server":
			return t("oper.alertBuilder.wide.server");
		case "clones":
			return Number(value) <= 2 || !/^\d+$/.test(value)
				? t("oper.alertBuilder.wide.clones")
				: undefined;

		case "authed": {
			if (/^(no|false|0)$/i.test(value)) {
				const others = rows.filter((r) => r !== row && r.on && r.value.trim() !== "");
				return others.length === 0 ? t("oper.alertBuilder.wide.unauthed") : undefined;
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

/**
 * `Matches 3 users right now · none are opers`, or that nothing does. The
 * clauses are independent phrases: the count, then who of them are opers,
 * then the warning past {@link MANY_MATCHES}.
 */
export function matchesText(
	count: number,
	opers: string[] | undefined
): {text: string; warn: boolean} {
	if (count === 0) {
		return {text: t("oper.alertBuilder.matches.none"), warn: false};
	}

	let text = tCount("oper.alertBuilder.matches.users", count);

	if (opers !== undefined) {
		const who =
			opers.length === 0
				? t("oper.alertBuilder.matches.noOpers")
				: opers.length === 1
				? t("oper.alertBuilder.matches.oneOper", {opers: opers[0]})
				: tCount("oper.alertBuilder.matches.opers", opers.length, {
						opers: opers.join(t("oper.list.separator")),
				  });
		text = t("oper.alertBuilder.matches.clauses", {first: text, second: who});
	}

	const warn = count > MANY_MATCHES;

	if (warn) {
		text = t("oper.alertBuilder.matches.tooMany", {matches: text});
	}

	return {text, warn};
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
