// The inbox's store glue (docs/projects/inbox.md): unread mentions kept in
// the Vuex store and persisted in localStorage, and the dismissals that keep
// the catch-up from bringing a dismissed one back. The IRC layer says what
// goes in (`inbox:add`) and what has been read (`inbox:read`); the rules are
// in helpers/inbox.ts.

import storage from "./localStorage";
import {store} from "./store";
import type {InboxEntry} from "../../shared/types/mention";
import {
	MAX_DISMISSED,
	addEntries,
	dropMessage,
	entryKey,
	parseDismissed,
	parseStored,
	pruneRead,
	type Dismissal,
} from "./helpers/inbox";

const KEY = "thelounge.mentions";
const DISMISSED_KEY = "thelounge.mentions.dismissed";

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
	store.commit("mentions", parseStored(storage.get(KEY)));

	if (!watching) {
		watching = true;
		store.watch((state) => state.mentions, persist, {deep: true});
	}
}

export function addMentions(entries: InboxEntry[]): void {
	if (entries.length > 0) {
		commitIfChanged(addEntries(store.state.mentions, entries, dismissed));
	}
}

export function markMentionsRead(network: string, target: string, time: Date): void {
	commitIfChanged(pruneRead(store.state.mentions, network, target, time));

	const left = pruneRead(dismissed, network, target, time);

	if (left.length !== dismissed.length) {
		setDismissed(left);
	}
}

/** Drop the entry of a message that is gone (deleted, or replaced by `by`'s edit). */
export function dropMentionOf(network: string, target: string, msgid: string, by?: string): void {
	commitIfChanged(dropMessage(store.state.mentions, network, target, msgid, by));
}

/** On this device only, remembered until the conversation is read past them. */
export function dismissMentions(entries: InboxEntry[]): void {
	const keys = new Set(entries.map(entryKey));
	setDismissed([
		...dismissed,
		...entries.map((e) => ({
			key: entryKey(e),
			network: e.network,
			target: e.target,
			time: e.time,
		})),
	]);
	commitIfChanged(store.state.mentions.filter((e) => !keys.has(entryKey(e))));
}
