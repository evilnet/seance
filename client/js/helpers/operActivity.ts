/**
 * The Opers tab's rollup (docs/projects/oper-tools.md, "The panel,
 * redrawn"): what the opers have been doing, from the notice log. One row
 * per oper who did anything, busiest first, opening to the kinds of thing
 * they did and then to the notices themselves; or one row per kind,
 * opening straight to its timeline. Only what somebody did counts as an
 * action: the network running itself (connects, bursts, log lines) is
 * "everything else" in the by-kind view and never credited to an oper.
 *
 * The services feed (irc/servicesfeed.ts) joins in through the same
 * tables: an audit line is credited to the person who typed the command
 * (the bot is the messenger) — and which nicks are bots is the network's
 * setting, passed in as {@link ActivityOptions}, so a WALLOPS or an audit
 * line by one lands on the services row. The snoop channel's lines
 * (connects, joins, kills, oper-ups as X3 saw them) count for nothing
 * here: they are the investigation cards' source, not oper actions
 * (rubin, 2026-10-11). Vue-free so mocha covers it
 * (test/helpers/operActivity.ts).
 */

import type {LoggedNotice} from "../irc/noticelog";
import {t, tCount} from "../i18n/core";

export type Period = "today" | "24h" | "reload";

/** When this page loaded (the module is evaluated once, at boot). */
export const LOADED_AT = Date.now();

/** The start of a period: local midnight, a day ago, or the page load. */
export function periodStart(period: Period, now = Date.now(), loadedAt = LOADED_AT): number {
	switch (period) {
		case "today": {
			const d = new Date(now);
			d.setHours(0, 0, 0, 0);
			return d.getTime();
		}

		case "24h":
			return now - 24 * 60 * 60 * 1000;

		default:
			return loadedAt;
	}
}

export type CoarseKind =
	| "glines"
	| "kills"
	| "modes"
	| "opers"
	| "alerts"
	| "jupes"
	| "links"
	| "rehash"
	| "wallops"
	| "other";

/** The coarse kinds in display order: what an oper cares about most first. */
export const COARSE_KINDS: {id: CoarseKind}[] = [
	{id: "glines"},
	{id: "kills"},
	{id: "modes"},
	{id: "opers"},
	{id: "alerts"},
	{id: "jupes"},
	{id: "links"},
	{id: "rehash"},
	{id: "wallops"},
	{id: "other"},
];

/** The heading of a by-kind row (`G-lines`, `Everything else`). */
export function coarseLabel(coarse: CoarseKind): string {
	switch (coarse) {
		case "glines":
			return t("oper.activity.kind.glines");
		case "kills":
			return t("oper.activity.kind.kills");
		case "modes":
			return t("oper.activity.kind.modes");
		case "opers":
			return t("oper.activity.kind.opers");
		case "alerts":
			return t("oper.activity.kind.alerts");
		case "jupes":
			return t("oper.activity.kind.jupes");
		case "links":
			return t("oper.activity.kind.links");
		case "rehash":
			return t("oper.activity.kind.rehash");
		case "wallops":
			return t("oper.activity.kind.wallops");
		default:
			return t("oper.activity.kind.other");
	}
}

/** `1 G-line`, `12 G-lines`: a count with its kind, singular where it is one. */
export function countLabel(coarse: CoarseKind, count: number): string {
	switch (coarse) {
		case "glines":
			return tCount("oper.activity.count.glines", count);
		case "kills":
			return tCount("oper.activity.count.kills", count);
		case "modes":
			return tCount("oper.activity.count.modes", count);
		case "opers":
			return tCount("oper.activity.count.opers", count);
		case "alerts":
			return tCount("oper.activity.count.alerts", count);
		case "jupes":
			return tCount("oper.activity.count.jupes", count);
		case "links":
			return tCount("oper.activity.count.links", count);
		case "rehash":
			return tCount("oper.activity.count.rehash", count);
		case "wallops":
			return tCount("oper.activity.count.wallops", count);
		default:
			return tCount("oper.activity.count.other", count);
	}
}

/**
 * Notice kind → coarse kind. Anything missing is `other`; the audit
 * feed's kinds (`x3.audit.<coarse>`) carry their coarse kind in the name
 * and are decided in {@link coarseKindOf}.
 */
export const KIND_COARSE: Record<string, CoarseKind> = {
	"ban.add": "glines",
	"ban.activate": "glines",
	"ban.deactivate": "glines",
	"ban.modify": "glines",
	"ban.remove": "glines",
	"ban.forceremove": "glines",
	"ban.hit": "glines",
	"dnsbl.block": "glines",
	"shun.match": "glines",
	"tempshun.apply": "glines",
	"tempshun.remove": "glines",
	"kill.oper": "kills",
	"kill.server": "kills",
	"hack.mode": "modes",
	"hack.kick": "modes",
	"oper.join": "modes",
	"deop.service": "modes",
	"oper.up": "opers",
	"oper.fail": "opers",
	"jupe.add": "jupes",
	"jupe.activate": "jupes",
	"jupe.deactivate": "jupes",
	"net.junction": "links",
	"net.break": "links",
	squit: "links",
	"squit.received": "links",
	"link.established": "links",
	"link.cancelled": "links",
	"link.failed": "links",
	"link.timeout": "links",
	"link.refused": "links",
	"server.error": "links",
	"sendq.exceeded": "links",
	rehash: "rehash",
	"rehash.signal": "rehash",
	restart: "rehash",
	wallops: "wallops",
	wallusers: "wallops",
	"wallops.server": "wallops",
	desynch: "wallops",
};

/** What the rollup needs to know about the network. */
export interface ActivityOptions {
	/** The services bots' nicks (the network's setting); nobody is a service without it. */
	serviceNicks?: string[];
}

const NONE: ActivityOptions = {};

/** Whether `nick` is one of the network's services bots (O3, ChanServ…). */
export function isServiceActor(nick: string, serviceNicks: string[] = []): boolean {
	const wanted = nick.toLowerCase();
	return serviceNicks.some((bot) => bot.toLowerCase() === wanted);
}

const COARSE_IDS = new Set<string>(COARSE_KINDS.map((k) => k.id));

/** `x3.audit.glines` → `glines`; a module log line (`x3.log.info`) and anything else undefined. */
function auditKind(kind: string): CoarseKind | undefined {
	const m = /^[a-z0-9]+\.audit\.(.+)$/.exec(kind);
	return m && COARSE_IDS.has(m[1]) ? (m[1] as CoarseKind) : undefined;
}

/**
 * Whether the rollup sees the entry at all: a snoop line is the cards'
 * source and no oper's action, so it is in no row and no timeline.
 */
export function isCounted(entry: LoggedNotice): boolean {
	return entry.type !== "snoop";
}

export function coarseKindOf(entry: LoggedNotice): CoarseKind {
	if (entry.type === "wallops") {
		return "wallops";
	}

	if (entry.type === "audit") {
		return auditKind(entry.snotice.kind) ?? "other";
	}

	if (entry.type === "snoop") {
		return "other";
	}

	return KIND_COARSE[entry.snotice.kind] ?? "other";
}

/**
 * The kinds that are somebody's doing, and which field names them. An
 * empty list is an action with no human behind it (the server's own, or
 * one the notice does not attribute): it goes to the "servers" row.
 */
const ACTION_FIELDS: Record<string, string[]> = {
	"oper.up": ["nick"],
	"oper.fail": ["nick"],
	"hack.mode": ["nick"],
	"hack.kick": ["nick"],
	"oper.join": ["nick"],
	"deop.service": [],
	rehash: ["oper"],
	"rehash.signal": [],
	restart: [],
	squit: ["oper"],
	"squit.received": [],
	"store.defrag": ["oper"],
	"bouncer.oreset": ["oper"],
	"ban.add": ["oper"],
	"ban.activate": ["oper"],
	"ban.deactivate": ["oper"],
	"ban.modify": ["oper"],
	"ban.remove": ["oper"],
	"ban.forceremove": ["oper"],
	"ban.hit": [],
	"shun.match": [],
	"dnsbl.block": [],
	"tempshun.apply": [],
	"tempshun.remove": [],
	"jupe.add": ["oper"],
	"jupe.activate": ["oper"],
	"jupe.deactivate": ["oper"],
	"kill.oper": ["killer"],
	"kill.server": [],
};

export type Actor =
	| {type: "nick"; name: string}
	| {type: "service"; name: string}
	| {type: "server"; name: string};

function named(name: string, serviceNicks: string[] | undefined): Actor {
	return isServiceActor(name, serviceNicks) ? {type: "service", name} : {type: "nick", name};
}

/** Who did it, or undefined when the entry is not an action at all. */
export function actorOf(entry: LoggedNotice, opts: ActivityOptions = NONE): Actor | undefined {
	if (entry.type === "wallops") {
		const from = entry.from ?? "";
		const kind = entry.snotice.kind;

		if (!from || kind === "wallops.server" || kind === "desynch" || from.includes(".")) {
			return {type: "server", name: from || t("oper.activity.unknownServer")};
		}

		return named(from, opts.serviceNicks);
	}

	if (entry.type === "audit") {
		// The bot is the messenger; the person who typed the command did it.
		// A module log line (`x3.log.<severity>`) has nobody behind it.
		return entry.from ? named(entry.from, opts.serviceNicks) : undefined;
	}

	if (!isCounted(entry)) {
		return undefined;
	}

	const fields = ACTION_FIELDS[entry.snotice.kind];

	if (!fields) {
		return undefined;
	}

	for (const field of fields) {
		const value = entry.snotice.fields[field];

		if (value) {
			return named(value, opts.serviceNicks);
		}
	}

	const server =
		entry.snotice.fields.server ?? entry.snotice.origin ?? t("oper.activity.unknownServer");
	return {type: "server", name: server};
}

export function isOperAction(entry: LoggedNotice, opts: ActivityOptions = NONE): boolean {
	return actorOf(entry, opts) !== undefined;
}

/** The entries of one coarse kind, newest first. */
export interface KindGroup {
	coarse: CoarseKind;
	label: string;
	count: number;
	first: number;
	last: number;
	entries: LoggedNotice[];
}

/** One row of the by-oper view. */
export interface ActorRow {
	actor: Actor;
	/** `nick:alice`, `services`, `servers`: what the UI folds by. */
	key: string;
	count: number;
	last: number;
	/** Far above the others: more than three times their median, and at least five. */
	hot: boolean;
	groups: KindGroup[];
}

export function inPeriod(entries: LoggedNotice[], since: number): LoggedNotice[] {
	return entries.filter((e) => e.time >= since);
}

const ORDER = new Map(COARSE_KINDS.map((k, i) => [k.id, i]));

/** Group entries (any order) by coarse kind, in the display order, newest first inside. */
function groupByKind(entries: LoggedNotice[]): KindGroup[] {
	const groups = new Map<CoarseKind, KindGroup>();

	for (const entry of entries) {
		const coarse = coarseKindOf(entry);
		let group = groups.get(coarse);

		if (!group) {
			group = {
				coarse,
				label: coarseLabel(coarse),
				count: 0,
				first: entry.time,
				last: entry.time,
				entries: [],
			};
			groups.set(coarse, group);
		}

		group.count++;
		group.first = Math.min(group.first, entry.time);
		group.last = Math.max(group.last, entry.time);
		group.entries.push(entry);
	}

	for (const group of groups.values()) {
		group.entries.sort((a, b) => b.time - a.time);
	}

	return [...groups.values()].sort(
		(a, b) => (ORDER.get(a.coarse) ?? 99) - (ORDER.get(b.coarse) ?? 99)
	);
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * By oper: a row per actor with an action since `since`, busiest first
 * (then by name), the services and servers rows last.
 */
export function rollupByOper(
	entries: LoggedNotice[],
	since: number,
	opts: ActivityOptions = NONE
): ActorRow[] {
	const rows = new Map<string, {actor: Actor; entries: LoggedNotice[]}>();

	for (const entry of inPeriod(entries, since)) {
		const actor = actorOf(entry, opts);

		if (!actor) {
			continue;
		}

		const key =
			actor.type === "nick"
				? `nick:${actor.name.toLowerCase()}`
				: actor.type === "service"
				? "services"
				: "servers";
		let row = rows.get(key);

		if (!row) {
			row = {
				actor: actor.type === "nick" ? actor : {type: actor.type, name: actor.type + "s"},
				entries: [],
			};
			rows.set(key, row);
		}

		row.entries.push(entry);
	}

	const result: ActorRow[] = [...rows.entries()].map(([key, row]) => ({
		actor: row.actor,
		key,
		count: row.entries.length,
		last: Math.max(...row.entries.map((e) => e.time)),
		hot: false,
		groups: groupByKind(row.entries),
	}));

	const rank = (row: ActorRow) =>
		row.actor.type === "nick" ? 0 : row.actor.type === "service" ? 1 : 2;
	result.sort(
		(a, b) =>
			rank(a) - rank(b) ||
			b.count - a.count ||
			a.actor.name.localeCompare(b.actor.name, undefined, {sensitivity: "base"})
	);

	const humans = result.filter((r) => r.actor.type === "nick");

	for (const row of humans) {
		const others = humans.filter((r) => r !== row).map((r) => r.count);
		row.hot = others.length > 0 && row.count >= 5 && row.count > 3 * median(others);
	}

	return result;
}

/** By kind: a row per coarse kind with an entry since `since`, `other` last. */
export function rollupByKind(entries: LoggedNotice[], since: number): KindGroup[] {
	return groupByKind(inPeriod(entries, since).filter(isCounted));
}
