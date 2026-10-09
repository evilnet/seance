/**
 * nefarious2 STATS: the selector catalogue and per-selector parsers that
 * turn the reply into a report. STUB — filled in by the STATS parser work
 * (docs/resources/nefarious2-oper.md §9).
 */

import type {OperReport} from "../../../../../shared/types/oper";
import type {IrcMessage} from "../../message";
import {rawLines} from "../report";
import type {StatsEntry} from "../types";

export const STATS_ENTRIES: StatsEntry[] = [];

/** The selectors in a `STATS` help reply (NOTICE `<c> (<name>) - <description>`). */
export function parseStatsHelp(lines: IrcMessage[]): StatsEntry[] {
	void lines;
	return [];
}

export function statsReport(selector: string, lines: IrcMessage[], command: string): OperReport {
	return {
		kind: "stats",
		title: `STATS ${selector}`,
		command,
		sections: [{lines: rawLines(lines)}],
		raw: rawLines(lines),
	};
}
