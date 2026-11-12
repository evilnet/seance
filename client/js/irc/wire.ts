/**
 * Outbound line helpers on top of `formatLine`.
 */

import type {TypingState} from "../../../shared/types/msg";
import {formatLine, formatTags} from "./message";
import {languageTags} from "./langtag";

/** Client tags (`+name` keys) to put on an outbound line; values unescaped. */
export type ClientTags = Record<string, string>;

/** The reply tag (https://ircv3.net/specs/client-tags/reply), which reactions need too. */
export const REPLY_TAG = "+reply";
/** The draft form of {@link REPLY_TAG}: what poxchat reads, sent alongside it until it reads `+reply`. */
export const DRAFT_REPLY_TAG = "+draft/reply";
/**
 * Tag marking a resend that replaces one of our own messages, in the
 * vendor form the other Seance tags use (nefarious2 strips no client tag
 * of that prefix since a428911b).
 */
export const EDIT_TAG = "+evilnet.github.io/edit";
/**
 * The tag Seance used before {@link EDIT_TAG}: read, and sent alongside it,
 * until no build in use reads only this one (docs/projects/message-edit-delete.md).
 */
export const LEGACY_EDIT_TAG = "+seance/edit";

/** The tags that mark a resend as replacing `msgid`: both forms, so every Seance build sees it. */
export function editTags(msgid: string): ClientTags {
	return {[EDIT_TAG]: msgid, [LEGACY_EDIT_TAG]: msgid};
}

/** `tags` without {@link LEGACY_EDIT_TAG}: where only one edit tag fits. */
export function withoutLegacyEdit(tags: ClientTags): ClientTags {
	const {[LEGACY_EDIT_TAG]: _legacy, ...rest} = tags;
	return rest;
}

/** The msgid a line's edit tag names, in either form. */
export function editTagOf(tag: (name: string) => string | undefined): string | undefined {
	return tag(EDIT_TAG) || tag(LEGACY_EDIT_TAG) || undefined;
}
/** Reaction / reaction removal tags (poxchat / nefarious2 convention). */
export const REACT_TAG = "+draft/react";
export const UNREACT_TAG = "+draft/unreact";
/** The cap that gates REDACT in both directions. */
export const REDACTION_CAP = "draft/message-redaction";
/** The tags that mark a message as a reply to `msgid`: both forms, so every client sees it. */
export function replyTags(msgid: string): ClientTags {
	return {[REPLY_TAG]: msgid, [DRAFT_REPLY_TAG]: msgid};
}

/**
 * The client tags a line of input carries (`InputOptions`): the reply
 * tags and the language tags (`langtag.ts`). Undefined when there are none.
 */
export function inputTags(opts: {
	reply?: string;
	language?: string;
	machineTranslated?: boolean;
}): ClientTags | undefined {
	const tags: ClientTags = {
		...(opts.reply ? replyTags(opts.reply) : {}),
		...languageTags(opts.language, opts.machineTranslated === true),
	};

	return Object.keys(tags).length > 0 ? tags : undefined;
}

/** Typing notification tag (https://ircv3.net/specs/client-tags/typing), on TAGMSG. */
export const TYPING_TAG = "+typing";
/** Minimum spacing between two `+typing` TAGMSGs to one target (the spec's 3 s). */
export const TYPING_INTERVAL_MS = 3000;

/** The `TypingState` a `+typing` tag value names, or undefined for anything else. */
export function typingStateOf(value: string | undefined): TypingState | undefined {
	return value === "active" || value === "paused" || value === "done" ? value : undefined;
}

/**
 * The `@tags ` block (trailing space included) an outbound line starts with,
 * or "" for no tags. Exposed so senders can count it against
 * `MAX_LINE_BYTES` before splitting a message body.
 */
export function tagPrefix(tags: ClientTags | undefined): string {
	if (!tags) {
		return "";
	}

	const body = formatTags(tags);
	return body.length > 0 ? `@${body} ` : "";
}

/**
 * Serialise `command` with `params`, always writing the last parameter as a
 * trailing (`:`-prefixed) one. `formatLine` only adds the colon when the
 * text needs it; for free-text parameters (realname, reasons, message
 * bodies) the explicit form is what every other client sends and what
 * humans reading a transcript expect. `tags` (client tags such as
 * `+reply`) are escaped and prepended as `@a=b;c=d `.
 */
export function trailingLine(command: string, params: string[], tags?: ClientTags): string {
	if (params.length === 0) {
		return formatLine({command, params, tags});
	}

	const last = params[params.length - 1];

	if (/[\r\n\0]/.test(last)) {
		throw new Error("Trailing parameter contains CR, LF or NUL");
	}

	return `${formatLine({command, params: params.slice(0, -1), tags})} :${last}`;
}
