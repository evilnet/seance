/**
 * Helpers for building {@link OperReport}s from reply lines: the typed
 * values, the text of a line, the error a reply may consist of, and the
 * server's `ctime()` timestamps. Shared by every profile.
 */

import type {OperReport, ReportValue} from "../../../../shared/types/oper";
import {isErrorNumeric} from "../errors";
import type {IrcMessage} from "../message";

export const text = (v: string): ReportValue => ({t: "text", v});
export const mono = (v: string): ReportValue => ({t: "mono", v});
export const nick = (v: string): ReportValue => ({t: "nick", v});
export const ip = (v: string): ReportValue => ({t: "ip", v});
export const host = (v: string): ReportValue => ({t: "host", v});
export const mask = (v: string): ReportValue => ({t: "mask", v});
export const server = (v: string): ReportValue => ({t: "server", v});
export const channel = (v: string, prefix?: string): ReportValue =>
	prefix ? {t: "channel", v, prefix} : {t: "channel", v};
export const time = (v: number, printed?: string): ReportValue =>
	printed ? {t: "time", v, text: printed} : {t: "time", v};
export const expiry = (v: number): ReportValue => ({t: "expiry", v});
export const duration = (v: number): ReportValue => ({t: "duration", v});
export const bytes = (v: number): ReportValue => ({t: "bytes", v});
export const number = (v: number): ReportValue => ({t: "number", v});
export const chips = (v: string[]): ReportValue => ({t: "chips", v});
export const state = (v: string, ok: boolean): ReportValue => ({t: "state", v, ok});

/** A numeric reply (three digits). */
export function isNumeric(msg: IrcMessage): boolean {
	return /^\d{3}$/.test(msg.command);
}

/**
 * The text of a reply line as a person reads it: a numeric's parameters
 * after our own nick, space-joined; a NOTICE's text; anything else as the
 * command and its parameters.
 */
export function lineText(msg: IrcMessage): string {
	if (isNumeric(msg)) {
		return msg.params.slice(1).join(" ");
	}

	if (msg.command === "NOTICE" || msg.command === "PRIVMSG") {
		return msg.params[msg.params.length - 1] ?? "";
	}

	return [msg.command, ...msg.params].join(" ");
}

/** {@link lineText} for every line. */
export function rawLines(lines: IrcMessage[]): string[] {
	return lines.map(lineText);
}

/** The last parameter (the trailing one, when there is one). */
export function trailingOf(msg: IrcMessage): string {
	return msg.params[msg.params.length - 1] ?? "";
}

/**
 * The error a reply consists of: the first error numeric (or FAIL) and its
 * text, e.g. `Permission Denied: Insufficient privileges` or
 * `CHECK: Command disabled.`. Undefined when the reply has none.
 */
export function errorOf(lines: IrcMessage[]): string | undefined {
	for (const msg of lines) {
		if (msg.command === "FAIL") {
			return trailingOf(msg);
		}

		if (!isErrorNumeric(msg.command)) {
			continue;
		}

		const params = msg.params.slice(1);
		const reason = params.pop() ?? "";
		return params.length > 0 ? `${params.join(" ")}: ${reason}` : reason;
	}

	return undefined;
}

/** A report that is only an error (481, 517, …), keeping the raw lines. */
export function errorReport(
	kind: string,
	title: string,
	command: string,
	lines: IrcMessage[],
	error: string
): OperReport {
	return {kind, title, command, sections: [], raw: rawLines(lines), error};
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A `ctime()` timestamp as ircu prints it (`Fri Oct  9 16:45:37 2026`, day
 * of month space-padded) → epoch ms. The server prints its local time and
 * says nothing of its zone; servers are run on UTC as a rule, so it is read
 * as UTC. Undefined when the text is not one.
 */
export function parseCtime(value: string): number | undefined {
	const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(
		value
	);

	if (!m) {
		return undefined;
	}

	const month = MONTHS.indexOf(m[1]);

	if (month === -1) {
		return undefined;
	}

	return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Unix seconds (as the server sends them) → epoch ms; NaN-safe. */
export function fromUnix(seconds: string | number): number {
	const n = typeof seconds === "number" ? seconds : Number(seconds);
	return Number.isFinite(n) ? n * 1000 : 0;
}

/** Whether `value` looks like an IPv4 or IPv6 address (optionally with /bits). */
export function isIp(value: string): boolean {
	return (
		/^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(value) ||
		/^[0-9a-f:]*:[0-9a-f:.]*(?:\/\d{1,3})?$/i.test(value)
	);
}
