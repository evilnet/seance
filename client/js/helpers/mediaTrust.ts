// Click-to-reveal media previews: what the reader trusts and whether a
// given preview may load.
//
// Loading a preview discloses the reader's IP and user agent to the media
// host, and nobody wants a surprise picture in a channel they did not choose
// it for. So by default a preview shows a placeholder ("veil") and the media
// is only fetched once the reader asks for it — once, for that preview, or
// permanently for a *scope*:
//
//   - a host   ("always show from i.imgur.com"),
//   - a channel ("always show in #pics"), keyed by network uuid + name,
//   - an account ("always show from alice"), keyed by network uuid + the
//     sender's services account from the `account-tag` on the message.
//     Accounts, never nicks: a nick can be taken by anyone the moment its
//     owner quits, so nick trust would be a grief vector.
//
// Everything lives here and is reactive, so trusting a scope reveals every
// visible preview in it at once. Kept free of store/DOM imports so it runs
// under mocha; tests swap the storage backend with {@link useStorageBackend}.

import {reactive} from "vue";
import storage from "../localStorage";
import {normalizeHost, urlHost} from "./urlHost";

export const STORAGE_KEY = "thelounge.media.trusted";

export type TrustKind = "host" | "channel" | "account";

export const TRUST_KINDS: readonly TrustKind[] = ["host", "channel", "account"];

/** Where a preview was posted, as trust keys plus what to call them. */
export type MediaScope = {
	/** `channelKey(...)`; unset for queries and the lobby. */
	channel?: string;
	channelName?: string;
	/** `accountKey(...)`; unset when the sender was not logged in. */
	account?: string;
	accountName?: string;
};

/** A preview as far as this module cares: its URL, scope and the reader's choice. */
export type RevealablePreview = {
	link: string;
	scope?: MediaScope;
	/**
	 * `true`: the reader revealed this preview (or posted it themselves);
	 * `false`: the reader hid it; `undefined`: follow the policy — the
	 * `mediaReveal` setting and the trusted scopes.
	 */
	revealed?: boolean;
};

type StorageBackend = {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
};

type TrustLists = Record<TrustKind, string[]>;

let backend: StorageBackend = storage;

const state = reactive({
	host: [] as string[],
	channel: [] as string[],
	account: [] as string[],
	loaded: false,
});

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;

	for (const kind of TRUST_KINDS) {
		state[kind] = [];
	}

	state.loaded = false;
}

function cleanList(value: unknown, normalize: (s: string) => string): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const out: string[] = [];

	for (const item of value) {
		if (typeof item !== "string") {
			continue;
		}

		const normalized = normalize(item);

		if (normalized && !out.includes(normalized)) {
			out.push(normalized);
		}
	}

	return out;
}

function ensureLoaded(): void {
	if (state.loaded) {
		return;
	}

	state.loaded = true;

	try {
		const raw = backend.get(STORAGE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;

		if (Array.isArray(parsed)) {
			// First format: a bare list of hosts.
			state.host = cleanList(parsed, normalizeHost);
		} else if (parsed && typeof parsed === "object") {
			const lists = parsed as Partial<TrustLists>;
			state.host = cleanList(lists.host, normalizeHost);
			state.channel = cleanList(lists.channel, normalizeKey);
			state.account = cleanList(lists.account, normalizeKey);
		}
	} catch {
		backend.remove(STORAGE_KEY);
	}
}

/** What is stored changed under this page (another tab, or settings sync): read it again. */
export function reloadTrustedMedia(): void {
	for (const kind of TRUST_KINDS) {
		state[kind] = [];
	}

	state.loaded = false;
	ensureLoaded();
}

function persist(): void {
	const lists: TrustLists = {host: state.host, channel: state.channel, account: state.account};
	backend.set(STORAGE_KEY, JSON.stringify(lists));
}

function normalizeKey(key: string): string {
	return key.trim();
}

const normalizers: Record<TrustKind, (s: string) => string> = {
	host: normalizeHost,
	channel: normalizeKey,
	account: normalizeKey,
};

/** Trust key for a channel on a network. Channel names compare case-insensitively. */
export function channelKey(networkUuid: string, channelName: string): string {
	return `${networkUuid}/${channelName.toLowerCase()}`;
}

/** Trust key for a services account on a network. */
export function accountKey(networkUuid: string, account: string): string {
	return `${networkUuid}/${account.toLowerCase()}`;
}

/** Take a channel/account key apart again for display. */
export function splitKey(key: string): {network: string; name: string} {
	const slash = key.indexOf("/");

	if (slash === -1) {
		return {network: "", name: key};
	}

	return {network: key.slice(0, slash), name: key.slice(slash + 1)};
}

/** The host a preview loads from (`i.imgur.com`), or `null` for a bad URL. */
export function mediaHost(link: string): string | null {
	return urlHost(link);
}

/** The file name part of a media URL, decoded, for the placeholder card. */
export function mediaFileName(link: string): string {
	try {
		const path = new URL(link).pathname;
		const name = path.slice(path.lastIndexOf("/") + 1);

		try {
			return decodeURIComponent(name);
		} catch {
			return name;
		}
	} catch {
		return "";
	}
}

/** Trusted keys of one kind, in the order they were added. Reactive; do not mutate. */
export function trustedMedia(kind: TrustKind): readonly string[] {
	ensureLoaded();
	return state[kind];
}

export function isTrusted(kind: TrustKind, key: string | null | undefined): boolean {
	if (!key) {
		return false;
	}

	ensureLoaded();
	return state[kind].includes(normalizers[kind](key));
}

export function trust(kind: TrustKind, key: string): void {
	const normalized = normalizers[kind](key);

	if (!normalized || isTrusted(kind, normalized)) {
		return;
	}

	state[kind].push(normalized);
	persist();
}

export function untrust(kind: TrustKind, key: string): void {
	ensureLoaded();

	const normalized = normalizers[kind](key);
	const index = state[kind].indexOf(normalized);

	if (index === -1) {
		return;
	}

	state[kind].splice(index, 1);
	persist();
}

/** Forget every trusted key of one kind, or of all kinds. */
export function clearTrusted(kind?: TrustKind): void {
	ensureLoaded();

	let changed = false;

	for (const k of kind ? [kind] : TRUST_KINDS) {
		if (state[k].length > 0) {
			state[k].splice(0);
			changed = true;
		}
	}

	if (changed) {
		persist();
	}
}

// Host conveniences, the most common case.
export const trustedMediaHosts = (): readonly string[] => trustedMedia("host");
export const isTrustedHost = (host: string | null | undefined): boolean => isTrusted("host", host);
export const trustHost = (host: string): void => trust("host", host);
export const untrustHost = (host: string): void => untrust("host", host);

/** The scopes that currently reveal a preview, in menu order. Empty when none. */
export function trustedScopesOf(preview: RevealablePreview): TrustKind[] {
	const kinds: TrustKind[] = [];

	if (isTrusted("host", mediaHost(preview.link))) {
		kinds.push("host");
	}

	if (isTrusted("channel", preview.scope?.channel)) {
		kinds.push("channel");
	}

	if (isTrusted("account", preview.scope?.account)) {
		kinds.push("account");
	}

	return kinds;
}

/**
 * Whether a preview's media may load right now. The reader's explicit choice
 * on the preview wins; otherwise `autoReveal` (the `mediaReveal: "always"`
 * setting) or any trusted scope — host, channel or sender account — reveals it.
 */
export function isPreviewRevealed(preview: RevealablePreview, autoReveal: boolean): boolean {
	if (preview.revealed === true) {
		return true;
	}

	if (preview.revealed === false) {
		return false;
	}

	return autoReveal || trustedScopesOf(preview).length > 0;
}
