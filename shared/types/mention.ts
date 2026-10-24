import {MessageType, UserInMessage} from "./msg";

/**
 * One unread mention (docs/projects/inbox.md): a reference to a message by
 * what survives a page load, never by session-local ids.
 */
export type InboxEntry = {
	/** The network's uuid. */
	network: string;
	/** The channel or query name. */
	target: string;
	/** The IRCv3 msgid, when the server sent one. */
	msgid?: string;
	/** A private conversation: one entry for all of it, showing its newest line. */
	query?: true;
	/** ISO 8601 server time. */
	time: string;
	type: MessageType;
	/** Kept to display the entry only; a long line's is cut to its mention. */
	text: string;
	from: UserInMessage;
};
