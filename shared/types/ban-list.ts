/**
 * The Bans window's model: a channel's `+b` list, kept per channel and
 * network and followed live from MODE lines
 * (`docs/resources/client-features.md` § Channel bans).
 */

export interface BanEntry {
	mask: string;
	/** Who set it, as the server names them; "" when it did not say. */
	by: string;
	/** When it was set, ms since the epoch, when the server said. */
	at?: number;
}

export type BanListStatus =
	/** Nothing asked yet on this connection. */
	| "idle"
	/** The list is on its way; `rows` are the previous answer, if any. */
	| "loading"
	/** `rows` are the list, kept current from MODE lines since `at`. */
	| "done"
	/** The server refused: `note` is what it said. */
	| "error";

export interface SharedBanList {
	/** The channel as the server or the asker spelled it. */
	channel: string;
	status: BanListStatus;
	rows: BanEntry[];
	/** When `rows` last came whole from the server; 0 before any answer. */
	at: number;
	note: string;
	/** How many bans the server allows a channel (`MAXBANS`), when it says. */
	limit?: number;
}

/** What the Bans window and the ban dialog ask the IRC layer to do. */
export interface BanChange {
	channel: string;
	/** Taken off first, so one edit never collides with its replacement. */
	remove: string[];
	add: string[];
	/** Kicked once the ban is on, one line each. */
	kick?: {nicks: string[]; reason: string};
}

export type BanChangeOutcome =
	/** The server applied it (or, with no way to tell, it was sent). */
	| "ok"
	/** The server took the line and changed nothing. */
	| "unchanged"
	/** The server said no: `text` is what it said. */
	| "refused"
	/** No answer in time. */
	| "timeout"
	/** Not connected. */
	| "closed";
