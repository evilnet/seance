/**
 * The Alerts tab's model (docs/projects/oper-tools.md, "The panel,
 * redrawn"): the profile's alert lines plus one line per kind it left out,
 * what position a line's control shows, how long a temporary route has
 * left, and the snomask arithmetic behind Off — when every kind on a
 * server bit is off the bit is cleared, so Off is quiet on the wire too,
 * and the bit comes back when a kind of it is switched on. Vue-free so
 * mocha covers it (test/helpers/operAlerts.ts).
 */

import type {Route} from "../../../shared/types/oper";
import {t, tCount} from "../i18n/core";
import type {AlertLine, NoticeKind, ServerProfile, SnomaskModel} from "../irc/profiles/types";
import {alertLineHint, alertLineLabel} from "../irc/profiles/nefarious/alerts";
import {kindLabel} from "../irc/profiles/noticeText";
import {allNoticeKinds} from "../irc/snotice";

/** A line of the folded "Everything else" row: one kind on its own. */
export interface RestLine extends Omit<AlertLine, "section"> {
	section: "else";
}

export interface AlertLines {
	/** The profile's lines, those whose kinds the profile has. */
	lines: AlertLine[];
	/** One per kind the profile's lines left out, in the profile's order. */
	rest: RestLine[];
}

/**
 * The lines for a profile, labelled in the reader's language. A profile
 * without any gets everything under "Everything else", one kind per line,
 * so the tab is never empty.
 */
export function alertLinesFor(profile: ServerProfile): AlertLines {
	const kinds = allNoticeKinds(profile);
	const known = new Set(kinds.map((k) => k.kind));
	const covered = new Set<string>();
	const lines: AlertLine[] = [];

	for (const line of profile.alertLines ?? []) {
		const own = line.kinds.filter((k) => known.has(k) && !covered.has(k));

		if (own.length > 0) {
			own.forEach((k) => covered.add(k));
			const hint = alertLineHint(line);
			lines.push({
				...line,
				label: alertLineLabel(line),
				...(hint !== undefined ? {hint} : {}),
				kinds: own,
			});
		}
	}

	const rest: RestLine[] = kinds
		.filter((k) => !covered.has(k.kind))
		.map((k) => ({
			id: `kind:${k.kind}`,
			label: kindLabel(k),
			section: "else",
			kinds: [k.kind],
		}));

	return {lines, rest};
}

/** The position a line's control shows: its first kind's route (they are kept in step). */
export function lineRoute(line: {kinds: string[]}, routeOf: (kind: string) => Route): Route {
	return routeOf(line.kinds[0]);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight at the end of the day `now` is in. */
export function endOfToday(now = Date.now()): number {
	const d = new Date(now);
	d.setHours(24, 0, 0, 0);
	return d.getTime();
}

/**
 * The choices "Here" offers, with when each one lapses. `label` is the
 * English data the tests read; the menu says each one as a whole phrase
 * of its own (helpers/operMenu.ts `hereItems`, by `id`).
 */
export const HERE_DURATIONS: {
	id: "today" | "days3" | "week" | "forGood";
	label: string;
	until: (now: number) => number | undefined;
}[] = [
	{id: "today", label: "for today", until: (now) => endOfToday(now)},
	{id: "days3", label: "for 3 days", until: (now) => now + 3 * DAY_MS},
	{id: "week", label: "for a week", until: (now) => now + 7 * DAY_MS},
	{id: "forGood", label: "until I change it", until: () => undefined},
];

/** `until tonight`, `until tomorrow`, `2 more days`: what a temporary route has left. */
export function untilText(until: number, now = Date.now()): string {
	const tonight = endOfToday(now);

	if (until <= tonight) {
		return t("oper.alerts.until.tonight");
	}

	const days = Math.ceil((until - tonight) / DAY_MS);
	return days <= 1 ? t("oper.alerts.until.tomorrow") : tCount("oper.alerts.until.days", days);
}

/**
 * The mask after routing changed for `changedKinds`: a bit whose kinds
 * are now all off is cleared; a bit with a kind back on is set. Only the
 * bits those kinds travel on are touched — a line about bans never turns
 * on CONNEXIT — and never a dead or debug-only bit.
 */
export function reconcileMask(
	mask: number,
	model: SnomaskModel,
	kinds: NoticeKind[],
	isOff: (kind: string) => boolean,
	changedKinds: string[]
): number {
	const changed = new Set(changedKinds);
	const categories = new Set(kinds.filter((k) => changed.has(k.kind)).map((k) => k.category));
	let next = mask;

	for (const bit of model.bits) {
		if (!categories.has(bit.name) || bit.dead || bit.debugOnly) {
			continue;
		}

		const onBit = kinds.filter((k) => k.category === bit.name);

		if (onBit.length === 0) {
			continue;
		}

		if (onBit.every((k) => isOff(k.kind))) {
			next &= ~bit.bit;
		} else {
			next |= bit.bit;
		}
	}

	return next;
}
