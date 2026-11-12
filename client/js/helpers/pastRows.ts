// The rows of a past view (docs/projects/inbox.md § Going to a message): lines
// around an old message, held beside the channel's buffer. Vue-free and store-free.
import type {SharedMsg} from "../../../shared/types/msg";
import {applyEdit} from "./messageUpdates";
import {authorOf, isEditAuthor} from "../irc/channel";

/** `fresh` added before or after `rows`, without what is already there. */
export function mergePage<T extends SharedMsg>(
	rows: T[],
	fresh: T[],
	where: "BEFORE" | "AFTER"
): {rows: T[]; added: number} {
	const seen = new Set(rows.map((row) => row.msgid).filter(Boolean));
	const added = fresh.filter((row) => !row.msgid || !seen.has(row.msgid));
	return {
		rows: where === "BEFORE" ? [...added, ...rows] : [...rows, ...added],
		added: added.length,
	};
}

/** The msgid a page in this direction is asked from: rows with none cannot be. */
export function pageEdge<T extends SharedMsg>(
	rows: T[],
	where: "BEFORE" | "AFTER"
): string | undefined {
	const anchored = rows.filter((row) => row.msgid);
	return (where === "BEFORE" ? anchored[0] : anchored[anchored.length - 1])?.msgid;
}

/** Whether `edit` may replace `original`: the timeline's rule (irc/channel.ts `isEditAuthor`). */
export function sameAuthor(original: SharedMsg, edit: SharedMsg): boolean {
	return isEditAuthor(authorOf(original), authorOf(edit));
}

/**
 * Edits whose original is in `rows` but on another page: placed as on one
 * page. An AFTER page can bring the edit of a line already shown, and a
 * BEFORE page the original of an edit already shown.
 */
export function linkEdits<T extends SharedMsg>(rows: T[]): void {
	for (const row of [...rows]) {
		const original = row.editOf ? rows.find((m) => m.msgid === row.editOf) : undefined;

		if (original && original.supersededBy === undefined && sameAuthor(original, row)) {
			applyEdit(rows, original.id, row.id);
		}
	}
}

/** A live edit of a line in `rows`, from its author, takes the line's place. */
export function editRow<T extends SharedMsg>(rows: T[], edit: T): boolean {
	const original = rows.find((row) => row.msgid === edit.editOf);

	if (
		!original ||
		!sameAuthor(original, edit) ||
		rows.some((row) => row.msgid === edit.msgid) // an AFTER page brought it, a catch-up again
	) {
		return false;
	}

	// Its own copy: placing an edit dates it as its original, and the buffer has this one too.
	rows.push({...edit});
	applyEdit(rows, original.id, edit.id);
	return true;
}
