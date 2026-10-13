/**
 * The fallback for any server without a profile of its own: server notices
 * are recognised by their `*** ` shape but not classified (they all go to
 * the network window), STATS and CHECK replies render as their raw lines.
 * Never a broken table — the oper still gets the text.
 */

import type {OperReport} from "../../../../shared/types/oper";
import type {IrcMessage} from "../message";
import {errorOf, rawLines} from "./report";
import type {ServerProfile} from "./types";

/** A report that is the reply's lines, monospaced (or its error). */
export function rawReport(
	kind: string,
	title: string,
	lines: IrcMessage[],
	command: string
): OperReport {
	const raw = rawLines(lines);
	const error = errorOf(lines);

	return {
		kind,
		title,
		command,
		sections: error ? [] : [{lines: raw}],
		raw,
		...(error ? {error} : {}),
	};
}

export const generic: ServerProfile = {
	id: "generic",
	name: "IRC server",
	noticeKinds: [],
	classifyNotice: () => undefined,
	stats: [],
	statsReport: (selector, lines, command) =>
		rawReport("stats", `STATS ${selector}`, lines, command),
	checkReport: (lines, command) => rawReport("raw", "CHECK", lines, command),
	operFeatures: [],
};
