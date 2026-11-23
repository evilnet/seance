/**
 * The reader's avatar choices that outlive the page, in
 * `thelounge.avatars`: the networks avatars are switched off on (they are
 * on by default), and the people whose avatar is always loaded. A person
 * is a services account on a network *and* the host their avatar was on
 * when trusted: if alice's avatar moves from the network's image host to
 * some other site, it is asked about again, so trusting a person is never
 * a standing permission for whatever tracking URL they set next. Nicks are
 * never trusted (anyone can take one).
 *
 * Also the page's own, unsaved state: avatars loaded once from the user
 * menu, and URLs that failed to load. Reactive and kept free of store and
 * DOM imports so it runs under mocha; tests swap the storage backend with
 * {@link useStorageBackend}.
 */

import {reactive} from "vue";
import storage from "../localStorage";
import {normalizeHost} from "../helpers/urlHost";

export const STORAGE_KEY = "thelounge.avatars";

type StorageBackend = {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
};

let backend: StorageBackend = storage;

const state = reactive({
	loaded: false,
	off: [] as string[],
	people: [] as string[],
	once: new Set<string>(),
	failed: new Set<string>(),
});

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
	state.loaded = false;
	state.off = [];
	state.people = [];
	state.once.clear();
	state.failed.clear();
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string" && v !== "")
		: [];
}

function ensureLoaded(): void {
	if (state.loaded) {
		return;
	}

	state.loaded = true;

	try {
		const raw = backend.get(STORAGE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;

		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;
			state.off = [...new Set(strings(record.off))];
			state.people = [...new Set(strings(record.people))];
		}
	} catch {
		backend.remove(STORAGE_KEY);
	}
}

function persist(): void {
	if (state.off.length === 0 && state.people.length === 0) {
		backend.remove(STORAGE_KEY);
		return;
	}

	backend.set(STORAGE_KEY, JSON.stringify({off: state.off, people: state.people}));
}

/** Whether avatars are shown (and the key subscribed) on this network. On by default. */
export function avatarsEnabled(uuid: string): boolean {
	ensureLoaded();
	return !state.off.includes(uuid);
}

export function setAvatarsEnabled(uuid: string, on: boolean): void {
	ensureLoaded();
	const index = state.off.indexOf(uuid);

	if (on && index !== -1) {
		state.off.splice(index, 1);
	} else if (!on && index === -1) {
		state.off.push(uuid);
	} else {
		return;
	}

	persist();
}

/** The key a trusted person is stored under: `<network uuid>/<account>@<host>`. */
export function personKey(uuid: string, account: string, host: string): string {
	return `${uuid}/${account.toLowerCase()}@${normalizeHost(host)}`;
}

/** Take a person key apart for display. */
export function splitPersonKey(key: string): {network: string; account: string; host: string} {
	const slash = key.indexOf("/");
	const at = key.lastIndexOf("@");

	if (slash === -1 || at < slash) {
		return {network: "", account: key, host: ""};
	}

	return {
		network: key.slice(0, slash),
		account: key.slice(slash + 1, at),
		host: key.slice(at + 1),
	};
}

export function isPersonTrusted(
	uuid: string,
	account: string | null | undefined,
	host: string
): boolean {
	if (!account) {
		return false;
	}

	ensureLoaded();
	return state.people.includes(personKey(uuid, account, host));
}

export function trustPerson(uuid: string, account: string, host: string): void {
	ensureLoaded();
	const key = personKey(uuid, account, host);

	if (!state.people.includes(key)) {
		state.people.push(key);
		persist();
	}
}

export function untrustPerson(key: string): void {
	ensureLoaded();
	const index = state.people.indexOf(key);

	if (index !== -1) {
		state.people.splice(index, 1);
		persist();
	}
}

/** Trusted people, in the order they were added. Reactive; do not mutate. */
export function trustedPeople(): readonly string[] {
	ensureLoaded();
	return state.people;
}

/** "Show avatar": this picture, on this page only. */
export function loadOnce(href: string): void {
	state.once.add(href);
}

export function isLoadedOnce(href: string): boolean {
	return state.once.has(href);
}

/** The picture did not load (or was too large): drawn as the initial for the rest of the page. */
export function markFailed(href: string): void {
	state.failed.add(href);
}

export function hasFailed(href: string): boolean {
	return state.failed.has(href);
}

/** Forget the failure, so a picture uploaded again under the same URL is retried. */
export function clearFailed(href: string): void {
	state.failed.delete(href);
}

/** The network was removed: its switch and its trusted people go. */
export function forgetNetworkAvatarPrefs(uuid: string): void {
	ensureLoaded();
	const off = state.off.filter((u) => u !== uuid);
	const people = state.people.filter((key) => !key.startsWith(`${uuid}/`));

	if (off.length !== state.off.length || people.length !== state.people.length) {
		state.off = off;
		state.people = people;
		persist();
	}
}
