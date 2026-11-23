/**
 * Which `avatar` metadata values are pictures this client may fetch at all,
 * whoever set them (draft/metadata-2's `avatar` key is a URL). Only
 * https, on the default port, without credentials in the URL, and not an
 * SVG: an avatar loads without anyone posting anything, merely by sharing
 * a channel, so it gets a narrower door than a link preview. Vue-free and
 * DOM-free (runs under mocha).
 */

import {normalizeHost} from "../helpers/urlHost";

/** nefarious2's METADATA_MAX_VALUE_BYTES default; a longer value cannot be set there. */
export const AVATAR_MAX_BYTES = 300;

/** Extensions refused by path: SVG is a document, not a bitmap. */
const REFUSED_EXTENSION = /\.(svgz?)$/i;

export type AvatarUrl = {
	/** The URL as it will be loaded (`URL.href`). */
	href: string;
	/** Its host, normalized (helpers/urlHost.ts). */
	host: string;
};

/**
 * The URL an avatar value names, or `null` when this client will not load
 * it: not https, a port, a user or password, no host, an SVG path, or more
 * than {@link AVATAR_MAX_BYTES} bytes.
 */
export function parseAvatarUrl(value: string | null | undefined): AvatarUrl | null {
	const text = (value ?? "").trim();

	if (text === "" || new TextEncoder().encode(text).length > AVATAR_MAX_BYTES) {
		return null;
	}

	let url: URL;

	try {
		url = new URL(text);
	} catch {
		return null;
	}

	if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) {
		return null;
	}

	const host = normalizeHost(url.hostname);

	if (host === "" || REFUSED_EXTENSION.test(url.pathname)) {
		return null;
	}

	return {href: url.href, host};
}

/** Why a link typed in the avatar settings cannot be used, or `null` when it can. */
export type AvatarLinkProblem = "empty" | "notHttps" | "tooLong" | "svg" | "invalid";

export function avatarLinkProblem(value: string): AvatarLinkProblem | null {
	const text = value.trim();

	if (text === "") {
		return "empty";
	}

	if (new TextEncoder().encode(text).length > AVATAR_MAX_BYTES) {
		return "tooLong";
	}

	let url: URL;

	try {
		url = new URL(text);
	} catch {
		return "invalid";
	}

	if (url.protocol !== "https:") {
		return "notHttps";
	}

	if (REFUSED_EXTENSION.test(url.pathname)) {
		return "svg";
	}

	return parseAvatarUrl(text) ? null : "invalid";
}
