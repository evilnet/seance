/**
 * Formatting for the oper tools' typed values (shared/types/oper.ts
 * `ReportValue`) and server notice badges: what the report and notice
 * components show, and the plain text a copy gets. Vue-free so mocha
 * covers it (test/helpers/operFormat.ts).
 */

import type {OperReport, ReportValue} from "../../../shared/types/oper";
import {t} from "../i18n/core";
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
		return t("oper.time.now");
	}

	const span = formatDuration(Math.abs(diff));
	return diff > 0 ? t("oper.time.in", {span}) : t("oper.time.ago", {span});
}

/** An expiry: `never`, `expired`, or `in 6h`. */
export function formatExpiry(epochMs: number, now = Date.now()): string {
	if (!epochMs) {
		return t("oper.time.never");
	}

	return epochMs <= now ? t("oper.time.expired") : relativeTime(epochMs, now);
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

/** Colour family per server notice category; its words are {@link categoryLabel}'s. */
const FAMILIES: Record<string, string> = {
	OLDSNO: "server",
	SERVKILL: "kill",
	OPERKILL: "kill",
	HACK2: "mode",
	HACK3: "mode",
	HACK4: "mode",
	UNAUTH: "conn",
	TCPCOMMON: "conn",
	TOOMANY: "conn",
	GLINE: "ban",
	AUTO: "ban",
	NETWORK: "net",
	IPMISMATCH: "conn",
	OLDREALOP: "oper",
	CONNEXIT: "conn",
	NICKCHG: "conn",
	AUTH: "server",
	DEBUG: "server",
	WEBIRC: "conn",
	WHOIS: "oper",
	WALLOPS: "wallops",
	OTHER: "server",
	/** The services feed (irc/servicesfeed.ts): snoop and audit lines. */
	SERVICES: "oper",
};

/**
 * The badge's short word for a category, in the reader's language; jargon
 * the oper reads as is (tls, iauth, webirc, whois, wallops, dns, oper)
 * stays. Undefined for a category nobody lists.
 */
function categoryLabel(category: string): string | undefined {
	switch (category) {
		case "OLDSNO":
			return t("oper.badge.server");
		case "SERVKILL":
		case "OPERKILL":
			return t("oper.badge.kill");
		case "HACK2":
			return t("oper.badge.desync");
		case "HACK3":
		case "HACK4":
			return t("oper.badge.mode");
		case "UNAUTH":
			return t("oper.badge.refused");
		case "TCPCOMMON":
			return "tls";
		case "TOOMANY":
			return t("oper.badge.limit");
		case "GLINE":
			return t("oper.badge.ban");
		case "AUTO":
			return t("oper.badge.autoBan");
		case "NETWORK":
			return t("oper.badge.net");
		case "IPMISMATCH":
			return "dns";
		case "OLDREALOP":
			return "oper";
		case "CONNEXIT":
			return t("oper.badge.conn");
		case "NICKCHG":
			return t("oper.badge.nick");
		case "AUTH":
			return "iauth";
		case "DEBUG":
			return t("oper.badge.debug");
		case "WEBIRC":
			return "webirc";
		case "WHOIS":
			return "whois";
		case "WALLOPS":
			return "wallops";
		case "OTHER":
			return t("oper.badge.notice");
		case "SERVICES":
			return t("oper.badge.services");
		default:
			return undefined;
	}
}

/** Short badge text and colour family per server notice category. */
export function categoryBadge(category: string): {label: string; family: string} {
	const label = categoryLabel(category);
	return label !== undefined
		? {label, family: FAMILIES[category] ?? "server"}
		: {label: category.toLowerCase(), family: "server"};
}

/** The WALLOPS family's badge per kind. */
export function wallopsBadge(kind: string): string {
	switch (kind) {
		case "wallusers":
			return "wallusers";
		case "desynch":
			return t("oper.badge.desync");
		case "wallops.server":
			return t("oper.badge.server");
		default:
			return "wallops";
	}
}
