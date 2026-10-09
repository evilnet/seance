/**
 * nefarious2 CHECK replies (286/287/290/291/292) as structured reports.
 * STUB — filled in by the CHECK parser work (docs/resources/nefarious2-oper.md §7).
 */

import type {OperReport} from "../../../../../shared/types/oper";
import type {IrcMessage} from "../../message";

/** The report for a CHECK reply; undefined when the lines are not one. */
export function checkReport(lines: IrcMessage[], command: string): OperReport | undefined {
	void lines;
	void command;
	return undefined;
}
