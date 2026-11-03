/**
 * Whether a line the oper dialogs build fits the transport's cap
 * (`MAX_LINE_BYTES`, tags included) once the IRC layer has put its label in
 * front: `@label=r<n> ` from irc/request.ts, `@label=svc<n> ` from
 * irc/quiet.ts. A line over the cap is never sent — `transport.send` throws
 * and the request comes back `closed` — so the dialog checks first and says
 * why, instead of blaming the connection. Vue-free for test/helpers/operLine.ts.
 */

import {MAX_LINE_BYTES, utf8ByteLength} from "../irc/message";
import {tagPrefix} from "../irc/wire";

/** Room kept for the label: a quiet label with a seven-digit counter. */
export const LABEL_ALLOWANCE = utf8ByteLength(tagPrefix({label: "svc9999999"}));

export interface LineBudget {
	/** UTF-8 bytes of the line with the label allowance. */
	bytes: number;
	/** Bytes over the cap; 0 when it fits. */
	over: number;
}

export function lineBudget(line: string): LineBudget {
	const bytes = utf8ByteLength(line) + LABEL_ALLOWANCE;
	return {bytes, over: Math.max(0, bytes - MAX_LINE_BYTES)};
}

/** The dialog's words for a line that does not fit, or "" when it does. */
export function lineTooLongText(budget: LineBudget): string {
	if (budget.over === 0) {
		return "";
	}

	return `Too long to send: shorten the reason by ${budget.over} ${
		budget.over === 1 ? "byte" : "bytes"
	} (accented letters, other scripts and emoji take 2–4 each).`;
}
