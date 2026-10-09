/**
 * nefarious2 server notices: every kind the classifier recognises, with its
 * default route, and the classifier itself. STUB — filled in by the
 * classifier work (docs/resources/nefarious2-oper.md §5 is the catalogue).
 */

import type {NoticeKind, SnoticeEvent} from "../types";

export const NOTICE_KINDS: NoticeKind[] = [];

/** Classify a server notice's text (without `*** Notice -- `). */
export function classifyNotice(text: string): SnoticeEvent | undefined {
	void text;
	return undefined;
}
