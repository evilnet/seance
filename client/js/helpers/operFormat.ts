/**
 * Formatting for the oper tools' typed values (shared/types/oper.ts
 * `ReportValue`) and server notice badges: what the report and notice
 * components show, and the plain text a copy gets. Vue-free so mocha
 * covers it (test/helpers/operFormat.ts).
 */

import type {OperReport, ReportValue} from "../../../shared/types/oper";
import {formatDuration} from "../irc/profiles/nefarious/bans";

export {formatDuration};

/** `1.5 KiB`-style sizes (binary units, one decimal under 10). */
export function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}

	if (unit === 0) {
		return `${Math.round(value)} B`;
	}

	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `in 3h 20m`, `5m ago`, `now`. */
export function relativeTime(epochMs: number, now = Date.now()): string {
	const diff = Math.round((epochMs - now) / 1000);

	if (Math.abs(diff) < 5) {
		return "now";
	}

	const span = formatDuration(Math.abs(diff));
	return diff > 0 ? `in ${span}` : `${span} ago`;
}

/** An expiry: `never`, `expired`, or `in 6h`. */
export function formatExpiry(epochMs: number, now = Date.now()): string {
	if (!epochMs) {
		return "never";
	}

	return epochMs <= now ? "expired" : relativeTime(epochMs, now);
}

/** The plain text of a value: what a copy of a report gets. */
export function valueText(
	value: ReportValue | ReportValue[] | undefined,
	now = Date.now()
): string {
	if (value === undefined) {
		return "";
	}

	if (Array.isArray(value)) {
		return value.map((v) => valueText(v, now)).join(" ");
	}

	switch (value.t) {
		case "channel":
			return `${value.prefix ?? ""}${value.v}`;
		case "time":
			return value.text ?? new Date(value.v).toISOString();
		case "expiry":
			return formatExpiry(value.v, now);
		case "duration":
			return formatDuration(value.v);
		case "bytes":
			return formatBytes(value.v);
		case "number":
			return value.v.toLocaleString("en-US");
		case "chips":
			return value.v.join(", ");
		default:
			return value.v;
	}
}

/** A report as text: title, sections, tables as tab-separated rows. */
export function reportText(report: OperReport, now = Date.now()): string {
	const out: string[] = [report.title];

	if (report.error) {
		out.push(report.error);
	}

	for (const section of report.sections) {
		if (section.title) {
			out.push("", `[${section.title}]`);
		}

		for (const entry of section.entries ?? []) {
			out.push(`${entry.label}: ${valueText(entry.value, now)}`);
		}

		if (section.table) {
			out.push(section.table.columns.map((c) => c.label).join("\t"));

			for (const row of section.table.rows) {
				out.push(section.table.columns.map((c) => valueText(row[c.key], now)).join("\t"));
			}
		}

		out.push(...(section.lines ?? []));
	}

	return out.join("\n");
}

/** Short badge text and colour family per server notice category. */
const CATEGORIES: Record<string, {label: string; family: string}> = {
	OLDSNO: {label: "server", family: "server"},
	SERVKILL: {label: "kill", family: "kill"},
	OPERKILL: {label: "kill", family: "kill"},
	HACK2: {label: "desync", family: "mode"},
	HACK3: {label: "mode", family: "mode"},
	HACK4: {label: "mode", family: "mode"},
	UNAUTH: {label: "refused", family: "conn"},
	TCPCOMMON: {label: "tls", family: "conn"},
	TOOMANY: {label: "limit", family: "conn"},
	GLINE: {label: "ban", family: "ban"},
	AUTO: {label: "auto-ban", family: "ban"},
	NETWORK: {label: "net", family: "net"},
	IPMISMATCH: {label: "dns", family: "conn"},
	OLDREALOP: {label: "oper", family: "oper"},
	CONNEXIT: {label: "conn", family: "conn"},
	NICKCHG: {label: "nick", family: "conn"},
	AUTH: {label: "iauth", family: "server"},
	DEBUG: {label: "debug", family: "server"},
	WEBIRC: {label: "webirc", family: "conn"},
	WHOIS: {label: "whois", family: "oper"},
	WALLOPS: {label: "wallops", family: "wallops"},
	OTHER: {label: "notice", family: "server"},
};

export function categoryBadge(category: string): {label: string; family: string} {
	return CATEGORIES[category] ?? {label: category.toLowerCase(), family: "server"};
}

/** The WALLOPS family's badge per kind. */
export function wallopsBadge(kind: string): string {
	switch (kind) {
		case "wallusers":
			return "wallusers";
		case "desynch":
			return "desync";
		case "wallops.server":
			return "server";
		default:
			return "wallops";
	}
}
