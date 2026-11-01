/**
 * Do not disturb: is it on now, and until when? The global state is a
 * manual switch (off, until a time, indefinite) and one daily window
 * (wall-clock start and end, a set of weekdays; a window that ends at or
 * before its start crosses midnight and belongs to the day it starts on).
 * Turning DND off inside a scheduled window skips the rest of that window.
 *
 * Vue-free, DOM-free, store-free: client/js/dnd.ts holds it, mocha tests it.
 * See docs/projects/do-not-disturb.md.
 */

import type {SharedNetworkMode, SharedPresenceMode} from "../../../shared/types/network";
import {activeLocale, t as coreT} from "../i18n/core";

export type PresenceMode = SharedPresenceMode;
export const PRESENCE_MODES: readonly PresenceMode[] = ["online", "auto", "away", "dnd"];

export type NetworkMode = SharedNetworkMode;
export const NETWORK_MODES: readonly NetworkMode[] = ["global", ...PRESENCE_MODES];

/** The pill's global mode (shared-presence-modes.md §2): every network's default. */
export type GlobalMode = "online" | "auto" | "away";
export const GLOBAL_MODES: readonly GlobalMode[] = ["online", "auto", "away"];

/** A network's own mode wins; Same as global follows the pill. */
export function effectiveMode(network: NetworkMode, global: GlobalMode): PresenceMode {
	return network === "global" ? global : network;
}

export interface DndSchedule {
	enabled: boolean;
	/** "HH:MM", local time. */
	start: string;
	/** "HH:MM"; at or before `start` means the window crosses midnight. */
	end: string;
	/** 0 = Sunday … 6 = Saturday: the day a window starts on. */
	days: number[];
}

export type DndManual =
	| {kind: "off"}
	/** `span`: the length picked (ms, "For 1 hour"), so the menu can tick it. */
	| {kind: "until"; until: number; span?: number}
	| {kind: "indefinite"};

/**
 * The global mode (docs/projects/shared-presence-modes.md § 2): every
 * network on Same as global follows it. `at` is the Unix ms of the user's
 * last choice (null if never chosen); shared between devices, the most
 * recent choice winning.
 */
export interface GlobalModeState {
	value: GlobalMode;
	at: number | null;
}

export interface DndState {
	manual: DndManual;
	schedule: DndSchedule;
	/** Off pressed inside a window: that window's end (ms); ignored before it. */
	scheduleSkippedUntil: number | null;
	mode: GlobalModeState;
}

export interface DndVerdict {
	active: boolean;
	/** Epoch ms DND ends; null while off or when indefinite. */
	until: number | null;
	source: "manual" | "schedule" | null;
}

const OFF: DndVerdict = {active: false, until: null, source: null};
/** A schedule time as stored: "HH:MM", 24-hour. */
export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function defaultDndState(): DndState {
	return {
		manual: {kind: "off"},
		schedule: {enabled: false, start: "23:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6]},
		scheduleSkippedUntil: null,
		mode: {value: "auto", at: null},
	};
}

function minutesOf(hhmm: string): number {
	const m = HHMM.exec(hhmm);
	return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/** The window that starts on the local day of `day` (any time that day). */
function windowStartingOn(schedule: DndSchedule, day: Date): {start: number; end: number} {
	const s = minutesOf(schedule.start);
	const e = minutesOf(schedule.end);
	const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, s);
	const endDay = e <= s ? day.getDate() + 1 : day.getDate();
	const end = new Date(day.getFullYear(), day.getMonth(), endDay, 0, e);
	return {start: start.getTime(), end: end.getTime()};
}

function scheduleOn(schedule: DndSchedule): boolean {
	return schedule.enabled && schedule.days.length > 0;
}

export function windowAt(schedule: DndSchedule, now: Date): {start: number; end: number} | null {
	if (!scheduleOn(schedule)) {
		return null;
	}

	const t = now.getTime();

	// Today's window, or yesterday's that crosses midnight.
	for (const offset of [0, -1]) {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);

		if (!schedule.days.includes(day.getDay())) {
			continue;
		}

		const w = windowStartingOn(schedule, day);

		if (t >= w.start && t < w.end) {
			return w;
		}
	}

	return null;
}

export function nextWindow(schedule: DndSchedule, now: Date): {start: number; end: number} | null {
	if (!scheduleOn(schedule)) {
		return null;
	}

	for (let offset = 0; offset <= 7; offset++) {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);

		if (!schedule.days.includes(day.getDay())) {
			continue;
		}

		const w = windowStartingOn(schedule, day);

		if (w.start > now.getTime()) {
			return w;
		}
	}

	return null;
}

export function dndAt(state: DndState, now: Date): DndVerdict {
	const t = now.getTime();
	const m = state.manual;

	if (m.kind === "indefinite") {
		return {active: true, until: null, source: "manual"};
	}

	if (m.kind === "until" && m.until > t) {
		return {active: true, until: m.until, source: "manual"};
	}

	const w = windowAt(state.schedule, now);

	if (w && !(state.scheduleSkippedUntil !== null && state.scheduleSkippedUntil >= w.end)) {
		return {active: true, until: w.end, source: "schedule"};
	}

	return OFF;
}

export function turnOff(state: DndState, now: Date): DndState {
	const w = windowAt(state.schedule, now);
	return {
		...state,
		manual: {kind: "off"},
		scheduleSkippedUntil: w ? w.end : state.scheduleSkippedUntil,
	};
}

function asManual(raw: unknown): DndManual | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const r = raw as Record<string, unknown>;

	if (r.kind === "off" || r.kind === "indefinite") {
		return {kind: r.kind};
	}

	if (r.kind === "until" && typeof r.until === "number" && Number.isFinite(r.until)) {
		return typeof r.span === "number" && Number.isFinite(r.span) && r.span > 0
			? {kind: "until", until: r.until, span: r.span}
			: {kind: "until", until: r.until};
	}

	return undefined;
}

function asSchedule(raw: unknown): DndSchedule | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	const r = raw as Record<string, unknown>;

	if (
		typeof r.enabled !== "boolean" ||
		typeof r.start !== "string" ||
		!HHMM.test(r.start) ||
		typeof r.end !== "string" ||
		!HHMM.test(r.end) ||
		!Array.isArray(r.days)
	) {
		return undefined;
	}

	const days = [...new Set(r.days)]
		.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
		.sort((a, b) => a - b);
	return {enabled: r.enabled, start: r.start, end: r.end, days};
}

const asAt = (at: unknown): number | null | undefined =>
	at === null
		? null
		: typeof at === "number" && Number.isSafeInteger(at) && at > 0
		? at
		: undefined;

function asMode(raw: unknown, legacyAway: unknown): GlobalModeState | undefined {
	if (raw !== undefined) {
		if (!raw || typeof raw !== "object") {
			return undefined;
		}

		const r = raw as Record<string, unknown>;
		const at = asAt(r.at);
		return GLOBAL_MODES.includes(r.value as GlobalMode) && at !== undefined
			? {value: r.value as GlobalMode, at}
			: undefined;
	}

	// 2026-10-15's global away switch, on this branch only.
	if (legacyAway && typeof legacyAway === "object") {
		const r = legacyAway as Record<string, unknown>;
		const at = asAt(r.at);
		return typeof r.on === "boolean" && at !== undefined
			? {value: r.on ? "away" : "auto", at}
			: undefined;
	}

	return undefined;
}

export function parseDndState(raw: string | null): DndState {
	if (!raw) {
		return defaultDndState();
	}

	try {
		const v = JSON.parse(raw) as Record<string, unknown> | null;

		if (!v || typeof v !== "object") {
			return defaultDndState();
		}

		const def = defaultDndState();
		// One bad half resets only itself.
		const manual = asManual(v.manual) ?? def.manual;
		const schedule = asSchedule(v.schedule) ?? def.schedule;
		const skipped =
			typeof v.scheduleSkippedUntil === "number" && Number.isFinite(v.scheduleSkippedUntil)
				? v.scheduleSkippedUntil
				: null;
		const mode = asMode(v.mode, v.away) ?? def.mode;
		return {manual, schedule, scheduleSkippedUntil: skipped, mode};
	} catch {
		return defaultDndState();
	}
}

export function serializeDndState(state: DndState): string {
	return JSON.stringify(state);
}

/**
 * A schedule edit. Off pressed inside a window skips the rest of it; the skip
 * survives an edit that leaves the window current now as it was (another
 * weekday, a time outside it) and is dropped by one that changes it: the
 * user moved tonight's window, so it holds afresh.
 */
export function editSchedule(state: DndState, schedule: DndSchedule, now: Date): DndState {
	const before = windowAt(state.schedule, now);
	const after = windowAt(schedule, now);
	const same =
		before === after ||
		(before !== null &&
			after !== null &&
			before.start === after.start &&
			before.end === after.end);
	return {...state, schedule, scheduleSkippedUntil: same ? state.scheduleSkippedUntil : null};
}

/** Another device turned the shared DND off: do the same here, if it is on. */
export function reconcileRemote(state: DndState, now: Date): DndState {
	return dndAt(state, now).active ? turnOff(state, now) : state;
}

/** The days of a schedule, Sunday = 0 (DndSchedule.days). */
export const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const weekdayFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * A weekday's name in the active language, Sunday = 0: `short` ("Sat") for
 * the day checkboxes and the pill, `long` ("Saturday") for accessible names.
 * Intl's, not the catalog's (i18n/dates.ts): 2023-01-01 was a Sunday.
 */
export function weekdayName(day: number, width: "short" | "long" = "short"): string {
	const tag = activeLocale();
	const key = `${tag}-${width}`;
	let format = weekdayFormats.get(key);

	if (!format) {
		format = new Intl.DateTimeFormat(tag, {weekday: width, timeZone: "UTC"});
		weekdayFormats.set(key, format);
	}

	return format.format(Date.UTC(2023, 0, 1 + day));
}

/**
 * A presence mode's name, as the lobby dot's menu, the network form and the
 * pill say it. `t` is the caller's (a component passes its own, so a locale
 * change re-renders); the core resolver by default.
 */
export function modeLabel(mode: NetworkMode, t: (key: string) => string = coreT): string {
	switch (mode) {
		case "global":
			return t("presence.mode.global");
		case "online":
			return t("presence.mode.online");
		case "auto":
			return t("presence.mode.auto");
		case "away":
			return t("presence.mode.away");
		case "dnd":
			return t("presence.mode.dnd");
	}
}

/** A wall-clock time as the clock setting writes it: "07:05" or "7:05 AM". */
export function clockText(h: number, m: number, hour12: boolean): string {
	const mm = String(m).padStart(2, "0");
	return hour12
		? `${h % 12 || 12}:${mm} ${h < 12 ? "AM" : "PM"}`
		: `${String(h).padStart(2, "0")}:${mm}`;
}

/** A schedule's "HH:MM" by the clock setting; anything else as it is. */
export function scheduleTimeText(hhmm: string, hour12: boolean): string {
	const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
	return match ? clockText(Number(match[1]), Number(match[2]), hour12) : hhmm;
}

/**
 * The pill's words while DND is on, from the verdict: "Do not disturb", and
 * its end as a second part ("until 23:00", "until Sat 07:00"). The parts are
 * separate phrases; the pill shows them joined by " · " and may break the
 * line between them.
 */
export function describeDndParts(verdict: DndVerdict, now: Date, hour12: boolean): string[] {
	const t = coreT;
	const label = t("dnd.label");

	if (verdict.until === null) {
		return [label];
	}

	const end = new Date(verdict.until);
	const time = clockText(end.getHours(), end.getMinutes(), hour12);
	const sameDay = end.toDateString() === now.toDateString();
	return [
		label,
		sameDay
			? t("dnd.until", {time})
			: t("dnd.untilDay", {day: weekdayName(end.getDay()), time}),
	];
}

/** describeDndParts as one line, its parts joined by " · ". */
export function describeDnd(verdict: DndVerdict, now: Date, hour12: boolean): string {
	return describeDndParts(verdict, now, hour12).join(" · ");
}

/**
 * When the verdict can next change on its own: the end of the DND in force,
 * the next window's start, or at the latest the next minute boundary (a
 * window's edges are whole minutes, the pill's clock too). Epoch ms.
 */
export function nextChangeAt(state: DndState, now: Date): number {
	const t = now.getTime();
	const minute = Math.floor(t / 60_000) * 60_000 + 60_000;
	const candidates = [minute];
	const verdict = dndAt(state, now);

	if (verdict.until !== null && verdict.until > t) {
		candidates.push(verdict.until);
	}

	if (state.manual.kind === "until" && state.manual.until > t) {
		candidates.push(state.manual.until);
	}

	const next = nextWindow(state.schedule, now);

	if (next) {
		candidates.push(next.start);
	}

	return Math.min(...candidates);
}

/** What the pill says and ticks: do not disturb outranks the global mode. */
export type PillStatus = GlobalMode | "dnd";

export function pillStatus(state: DndState, now: Date): PillStatus {
	return dndAt(state, now).active ? "dnd" : state.mode.value;
}
