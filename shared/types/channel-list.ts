/**
 * The channel browser's model: what a network's LIST gave, and the channels
 * the network itself puts forward (`docs/resources/client-features.md`
 * § Channel browser).
 */

export interface ChannelListEntry {
	name: string;
	/** Visible users, as the server counts them. */
	users: number;
	topic: string;
}

/** A channel the MOTD marks out (`  #name  blurb`): shown first. */
export interface FeaturedChannel {
	name: string;
	blurb: string;
}

export type ChannelListStatus =
	/** Nothing asked yet on this connection. */
	| "idle"
	/** A LIST is under way; `rows` are the previous answer, if any. */
	| "loading"
	/** `rows` are the server's answer, complete, taken at `at`. */
	| "done"
	/** The server said to wait `waitSeconds` after connecting (nefarious2's LISTDELAY). */
	| "delayed"
	/** The server refused the arguments: `note` is what it said. */
	| "error";

export interface SharedChannelList {
	status: ChannelListStatus;
	rows: ChannelListEntry[];
	/** When `rows` were complete, ms since the epoch; 0 before any answer. */
	at: number;
	/** Rows received so far in the list under way. */
	loaded: number;
	waitSeconds: number;
	note: string;
	featured: FeaturedChannel[];
}
