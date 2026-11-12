// The inbox's store glue (docs/projects/inbox.md): mentions kept in
// the Vuex store and persisted in localStorage, and the dismissals that keep
// the catch-up from bringing a dismissed one back. The IRC layer says what
// goes in (`inbox:add`) and what has been read (`inbox:read`); the rules are
// in helpers/inbox.ts.

import {shallowRef} from "vue";
import storage from "./localStorage";
import {store} from "./store";
import type {InboxEntry} from "../../shared/types/mention";
import {
	MAX_DISMISSED,
	addEntries,
	conversationEntries,
	conversationKey,
	dismissalOf,
	dropExpired,
	dropMessage,
	entryKey,
	markRead,
	parseDismissed,
	parseStored,
	pruneRead,
	withoutDismissalsOf,
	type Dismissal,
} from "./helpers/inbox";

const KEY = "thelounge.mentions";
const DISMISSED_KEY = "thelounge.mentions.dismissed";

/**
 * What Dismiss all took, while it can be undone. Whatever takes an entry off
 * the list for good (read, deleted, the conversation left) takes it off here.
 */
export const undoableMentions = shallowRef<InboxEntry[]>([]);

let watching = false;
let dismissed: Dismissal[] = [];

function persist(): void {
	storage.set(KEY, JSON.stringify(store.state.mentions));
}

function setDismissed(next: Dismissal[]): void {
	dismissed = next.slice(-MAX_DISMISSED);
	storage.set(DISMISSED_KEY, JSON.stringify(dismissed));
}

function commitIfChanged(next: InboxEntry[]): void {
	const current = store.state.mentions;

	if (next.length !== current.length || next.some((e, i) => e !== current[i])) {
		store.commit("mentions", next);
	}
}

/** Load stored mentions into the store and start mirroring changes back. */
export function loadMentions(): void {
	dismissed = parseDismissed(storage.get(DISMISSED_KEY));
	store.commit("mentions", dropExpired(parseStored(storage.get(KEY)), Date.now()));

	if (!watching) {
		watching = true;
		store.watch((state) => state.mentions, persist, {deep: true});
	}
}

export function addMentions(entries: InboxEntry[]): void {
	if (entries.length > 0) {
		// A page of older history can bring mentions read long ago: past
		// their keep, they never go in.
		commitIfChanged(
			dropExpired(addEntries(store.state.mentions, entries, dismissed), Date.now())
		);
	}
}

export function markMentionsRead(network: string, target: string, time: Date): void {
	commitIfChanged(markRead(store.state.mentions, network, target, time));
	undoableMentions.value = markRead(undoableMentions.value, network, target, time);

	const left = pruneRead(dismissed, network, target, time);

	if (left.length !== dismissed.length) {
		setDismissed(left);
	}
}

/** This one was opened: dimmed, while the conversation stays unread. */
export function markMentionOpened(entry: InboxEntry): void {
	const key = entryKey(entry);
	commitIfChanged(
		store.state.mentions.map((e) =>
			!e.read && entryKey(e) === key ? {...e, read: true as const} : e
		)
	);
}

/** Drop the entry of a message that is gone (deleted, or replaced by `by`'s edit). */
export function dropMentionOf(network: string, target: string, msgid: string, by?: string): void {
	commitIfChanged(dropMessage(store.state.mentions, network, target, msgid, by));
	undoableMentions.value = dropMessage(undoableMentions.value, network, target, msgid, by);
}

/** On this device only, remembered until they could no longer come back (pruneRead). */
export function dismissMentions(entries: InboxEntry[]): void {
	const keys = new Set(entries.map(entryKey));
	setDismissed([...dismissed, ...entries.map(dismissalOf)]);
	commitIfChanged(store.state.mentions.filter((e) => !keys.has(entryKey(e))));
}

export function dismissAllMentions(entries: InboxEntry[]): void {
	undoableMentions.value = [...undoableMentions.value, ...entries];
	dismissMentions(entries);
}

export function undoDismissAll(): void {
	setDismissed(withoutDismissalsOf(dismissed, undoableMentions.value));
	addMentions(undoableMentions.value);
	undoableMentions.value = [];
}

/** Every entry of a conversation left (a part, a closed query), dismissed. */
export function dismissConversation(network: string, target: string): void {
	dismissMentions(conversationEntries(store.state.mentions, network, target));
	const key = conversationKey(network, target);
	undoableMentions.value = undoableMentions.value.filter(
		(e) => conversationKey(e.network, e.target) !== key
	);
}
