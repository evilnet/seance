// Pure store mutations for the `msg:react` / `msg:redact` / `msg:edit` bus
// events (docs/resources/bus-contract.md §1.4). Kept free of store/DOM
// imports so they can be unit-tested under mocha; the bus consumer in
// socket-events/msg_updates.ts only looks the message up and calls these.
import type {MsgReaction, MsgRedaction, SharedMsg} from "../../../shared/types/msg";

/** Newest-first lookup: updates almost always target recent messages. */
export function findMessageById<T extends SharedMsg>(messages: T[], id: number): T | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].id === id) {
			return messages[i];
		}
	}

	return undefined;
}

/**
 * Add or remove `nick`'s reaction `text`. A nick appears at most once per
 * text; entries keep first-seen order and disappear when nobody is left.
 * Arrays are replaced rather than mutated so watchers see one change.
 */
export function applyReaction(message: SharedMsg, text: string, nick: string, remove: boolean) {
	const reactions: MsgReaction[] = message.reactions ?? [];
	const index = reactions.findIndex((r) => r.text === text);
	const lower = nick.toLowerCase();

	if (remove) {
		if (index === -1) {
			return;
		}

		const nicks = reactions[index].nicks.filter((n) => n.toLowerCase() !== lower);

		if (nicks.length === reactions[index].nicks.length) {
			return;
		}

		const next = reactions.slice();

		if (nicks.length === 0) {
			next.splice(index, 1);
		} else {
			next[index] = {text, nicks};
		}

		message.reactions = next.length ? next : undefined;
		return;
	}

	if (index === -1) {
		message.reactions = reactions.concat([{text, nicks: [nick]}]);
		return;
	}

	if (reactions[index].nicks.some((n) => n.toLowerCase() === lower)) {
		return;
	}

	const next = reactions.slice();
	next[index] = {text, nicks: reactions[index].nicks.concat([nick])};
	message.reactions = next;
}

/** Mark a message deleted; `text` is kept so the UI can offer click-to-reveal. */
export function applyRedaction(message: SharedMsg, redaction: MsgRedaction) {
	message.redacted = {
		by: redaction.by,
		reason: redaction.reason,
		time: redaction.time,
	};
}

function indexOfId<T extends SharedMsg>(messages: T[], id: number): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].id === id) {
			return i;
		}
	}

	return -1;
}

/**
 * An edit takes its original's place (`msg:edit`). The replacement `id`
 * arrived as an ordinary `msg`, so it sits at the bottom of the list: it
 * moves to right behind the original `replaces`, which is hidden behind it,
 * and it keeps the original's `time` (when the edit was made becomes
 * `editedAt`), so the message reads as updated where it was — for our own
 * edits exactly as for anyone else's. The pending copy of an own edit
 * (bus-contract §1.9) stands in the same way until its echo does.
 *
 * Returns what was placed, or undefined when the original is not loaded
 * (the replacement then stays where its time put it). A replacement that
 * is not loaded still hides the original.
 */
export function applyEdit<T extends SharedMsg>(
	messages: T[],
	replaces: number,
	id: number
): {original: T; replacement?: T} | undefined {
	const originalAt = indexOfId(messages, replaces);

	if (originalAt === -1) {
		return undefined;
	}

	const original = messages[originalAt];
	original.supersededBy = id;

	const at = indexOfId(messages, id);

	if (at === -1) {
		return {original};
	}

	// The edit may have been edited in turn before its original arrived (an
	// older page brought it): then the whole chain goes behind the
	// original, and the newest edit, the one shown, is the replacement.
	const chain: T[] = [messages[at]];
	const seen = new Set<number>([id]);

	for (let next = chain[0].supersededBy; next !== undefined && !seen.has(next); ) {
		const nextAt = indexOfId(messages, next);

		if (nextAt === -1) {
			break;
		}

		seen.add(next);
		chain.push(messages[nextAt]);
		next = messages[nextAt].supersededBy;
	}

	// Each takes the original's time; when it was made is kept once, as
	// `editedAt`, so a repeated dispatch changes nothing.
	for (const message of chain) {
		if (message.editedAt === undefined) {
			message.editedAt = message.time;
		}

		message.time = original.time;
	}

	const inPlace = chain.every((message, k) => messages[originalAt + 1 + k] === message);

	if (!inPlace) {
		for (const message of chain) {
			messages.splice(messages.indexOf(message), 1);
		}

		messages.splice(messages.indexOf(original) + 1, 0, ...chain);
	}

	return {original, replacement: chain[chain.length - 1]};
}

/**
 * Nick and raw text for a reply quote, from the parent message; the quote
 * renders it through `QuotePreview.vue` (`quoteLayout`), which does the
 * styling and the cut. Returns `undefined` when the parent is not loaded
 * (the UI shows "(unknown message)").
 */
export function replyQuote(
	messages: SharedMsg[],
	msgid: string
): {nick: string; text: string; id: number} | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];

		if (m.msgid === msgid && m.supersededBy === undefined) {
			return {id: m.id, nick: m.from?.nick ?? "", text: m.text ?? ""};
		}
	}

	return undefined;
}

/**
 * The reactions `nick` has on `message`, in the order they are shown. The
 * picker marks these as selected and clicking one takes it back off, which is
 * the same toggle the badges under a message do.
 */
export function myReactions(message: SharedMsg, nick: string): string[] {
	const me = nick.toLowerCase();

	return (message.reactions ?? [])
		.filter((reaction) => reaction.nicks.some((n) => n.toLowerCase() === me))
		.map((reaction) => reaction.text);
}

/** Whether the message at `index` is an edit standing in its original's place. */
function standsIn<T extends SharedMsg>(messages: T[], index: number): boolean {
	return index > 0 && messages[index - 1].supersededBy === messages[index].id;
}

/** The id that places the row at `index`: an edit standing in counts as its original. */
function placeId<T extends SharedMsg>(messages: T[], index: number): number {
	while (standsIn(messages, index)) {
		index--;
	}

	return messages[index].id;
}

/**
 * Add a delivered message to a channel's list. Pending copies of our own
 * outgoing messages (bus-contract §1.9) stay a trailing block — the slot
 * their echo will land in — so anything else goes in ahead of that block
 * and a new copy goes after it. A copy that stands in an edited message's
 * place ({@link applyEdit}) is not part of the block: it stays put.
 *
 * Rows keep rising ids, which the unread marker relies on: a message with
 * an older id than the rows at the bottom (a reconnect's catch-up gap,
 * which the IRC layer numbers below the lines relayed while it was being
 * fetched) goes in above them, never between an edit and its original.
 */
export function insertMessage<T extends SharedMsg>(messages: T[], msg: T): void {
	if (msg.pending) {
		messages.push(msg);
		return;
	}

	let at = messages.length;

	while (at > 0 && messages[at - 1].pending && !standsIn(messages, at - 1)) {
		at--;
	}

	while (at > 0 && placeId(messages, at - 1) > msg.id) {
		at--;
	}

	messages.splice(at, 0, msg);
}

/**
 * Take the pending copy `id` out of the list (`msg:settled`). An original
 * the copy stood in for shows again — its echo's `msg:edit`, in the same
 * tick, hides it behind the real replacement.
 */
export function removePending<T extends SharedMsg>(messages: T[], id: number): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].id === id) {
			if (!messages[i].pending) {
				return false;
			}

			messages.splice(i, 1);

			for (let j = i - 1; j >= 0; j--) {
				if (messages[j].supersededBy === id) {
					messages[j].supersededBy = undefined;
					break;
				}
			}

			return true;
		}
	}

	return false;
}
