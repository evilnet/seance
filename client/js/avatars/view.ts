/**
 * The page's side of avatars/policy.ts: the inputs come from the store
 * (the `avatarLoad` setting, the deploy's `avatars` config), the network's
 * live connection (its FILEHOST host) and the reader's trust lists. Used by
 * Avatar.vue and the user menu (helpers/contextMenu.ts).
 */

import {isTrustedHost} from "../helpers/mediaTrust";
import {urlHost} from "../helpers/urlHost";
import type {TypedStore} from "../store";
import {avatarView, normalizeAvatarLoad, type AvatarView} from "./policy";
import {avatarsEnabled, hasFailed, isLoadedOnce, isPersonTrusted} from "./prefs";
import {avatarOf} from "./registry";

export type AvatarSubject = {
	uuid: string;
	nick: string;
	/** The sender's account from the line's tag, when the caller has it. */
	account?: string;
	self?: boolean;
};

/**
 * The network's upload host (`draft/FILEHOST`), a source an avatar loads
 * from by itself: read from the store's copy of the network's server
 * options, which is reactive. The IrcClient's own copy is not, and a page
 * load draws the kept lines' avatars before the connection says the host:
 * a picture on it was drawn veiled and stayed so after a refresh, since
 * nothing told the avatar to look again once the host was known.
 */
export function filehostHost(store: TypedStore, uuid: string): string | null {
	const url = store.state.networks.find((network) => network.uuid === uuid)?.serverOptions
		?.FILEHOST;
	return url ? urlHost(url) : null;
}

/** The account a person's avatar trust is keyed on, when known. */
export function accountFor(subject: AvatarSubject): string | null {
	return subject.account || avatarOf(subject.uuid, subject.nick)?.account || null;
}

export function viewFor(store: TypedStore, subject: AvatarSubject): AvatarView {
	const entry = avatarOf(subject.uuid, subject.nick);
	const config = store.state.branding.avatars;
	const account = accountFor(subject);

	return avatarView({
		value: entry?.value,
		self: !!subject.self,
		enabled: avatarsEnabled(subject.uuid),
		setting: normalizeAvatarLoad(store.state.settings.avatarLoad),
		filehostHost: filehostHost(store, subject.uuid),
		deployHosts: config?.trustedHosts,
		proxy: config?.proxy,
		hostTrusted: isTrustedHost,
		personTrusted: (host) => isPersonTrusted(subject.uuid, account, host),
		loadedOnce: isLoadedOnce,
		failed: hasFailed,
	});
}
