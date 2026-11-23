/**
 * Whether an avatar is drawn as its picture, and from where. Loading
 * someone's avatar tells the site it is stored on the reader's IP address
 * and that they are looking at the chat, and the owner of the avatar picks
 * that site; so by default (`avatarLoad: "trusted"`) a picture loads by
 * itself only from:
 *
 *   - the network's own image host (`draft/FILEHOST`), where Seance uploads avatars,
 *   - the hosts the deploy lists in `config.json` (`avatars.trustedHosts`),
 *   - the hosts the reader trusts for media previews (helpers/mediaTrust.ts),
 *   - the people the reader trusts (prefs.ts: account plus host),
 *   - a picture the reader asked to see once on this page,
 *
 * and through the deploy's image proxy, when it has one (`avatars.proxy`),
 * from anywhere. Everything else is drawn as the initial with a mark that
 * there is a picture to show. Our own avatar always loads: we chose it.
 * Pure: the caller passes every input, so it runs under mocha.
 */

import {parseAvatarUrl} from "./url";

export type AvatarLoadSetting = "trusted" | "any" | "none";

export const AVATAR_LOAD_SETTINGS: readonly AvatarLoadSetting[] = ["trusted", "any", "none"];

export function normalizeAvatarLoad(value: unknown): AvatarLoadSetting {
	return AVATAR_LOAD_SETTINGS.includes(value as AvatarLoadSetting)
		? (value as AvatarLoadSetting)
		: "trusted";
}

export type AvatarInputs = {
	/** The `avatar` value; empty or missing = none. */
	value: string | undefined;
	/** Our own avatar. */
	self: boolean;
	/** Avatars on for this network (prefs.ts). */
	enabled: boolean;
	setting: AvatarLoadSetting;
	/** The network's FILEHOST host, normalized, when it advertises one. */
	filehostHost?: string | null;
	/** Hosts the deploy trusts (`avatars.trustedHosts`), normalized. */
	deployHosts?: readonly string[];
	/** The deploy's image proxy, `https://…{url}…`. */
	proxy?: string;
	/** The reader trusts this host (media previews). */
	hostTrusted: (host: string) => boolean;
	/** The reader trusts this person at this host. */
	personTrusted: (host: string) => boolean;
	/** The reader asked to see this picture on this page. */
	loadedOnce: (href: string) => boolean;
	/** The picture failed to load on this page. */
	failed: (href: string) => boolean;
};

export type AvatarView =
	/** No picture: the initial alone. */
	| {kind: "none"}
	/** Load `src` (the picture, or its proxied form). */
	| {kind: "image"; src: string; href: string; host: string}
	/** There is a picture, not loaded: the initial with a mark. */
	| {kind: "veiled"; href: string; host: string};

/** The proxied form of `href`, or undefined when the template is unusable. */
export function proxiedSrc(template: string | undefined, href: string): string | undefined {
	if (!template || !template.includes("{url}") || !template.startsWith("https://")) {
		return undefined;
	}

	return template.split("{url}").join(encodeURIComponent(href));
}

export function avatarView(inputs: AvatarInputs): AvatarView {
	if (!inputs.enabled || inputs.setting === "none") {
		return {kind: "none"};
	}

	const parsed = parseAvatarUrl(inputs.value);

	if (!parsed || inputs.failed(parsed.href)) {
		return {kind: "none"};
	}

	const {href, host} = parsed;
	const proxied = proxiedSrc(inputs.proxy, href);

	if (proxied) {
		return {kind: "image", src: proxied, href, host};
	}

	const trusted =
		inputs.self ||
		inputs.setting === "any" ||
		host === inputs.filehostHost ||
		(inputs.deployHosts ?? []).includes(host) ||
		inputs.hostTrusted(host) ||
		inputs.personTrusted(host) ||
		inputs.loadedOnce(href);

	return trusted ? {kind: "image", src: href, href, host} : {kind: "veiled", href, host};
}
