import type {SharedMsg} from "./msg";

/**
 * What a `SEARCH` may ask (soju.im/search). `in` absent means every channel
 * the user is in. On the wire: one `;`-joined parameter (`specSearchParams`).
 */
export interface SearchAttrs {
	in?: string;
	from?: string;
	text?: string;
	/** ISO 8601. */
	after?: string;
	/** ISO 8601. */
	before?: string;
	limit?: number;
}

/**
 * How a search or context request ended.
 * - `unsupported`: the server has no such thing; search what is loaded instead.
 * - `offline`: nothing was sent, there is no connection.
 * - `invalid`: nothing was sent, the request cannot be put on the wire.
 */
export type SearchStatus = "ok" | "unsupported" | "offline" | "invalid" | "fail" | "timeout";

export interface SearchHit {
	/** The conversation: a channel, or the other side of a private one. */
	target: string;
	msg: SharedMsg;
	/** From this device's loaded lines, beside a server's answer. */
	loaded?: boolean;
}

export type SearchContextDirection = "AROUND" | "BEFORE" | "AFTER";

/** A reaction or deletion of one line, for rows no id of the channel's can name. */
export type LineChange = {
	msgid: string;
	react?: {text: string; nick: string; remove: boolean};
	redact?: {by: string; reason?: string; time: Date};
};
