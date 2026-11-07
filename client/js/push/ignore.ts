/**
 * The ignore list in the service worker. The page keeps each network's list
 * in localStorage (client/js/ignore.ts), which a worker cannot read, so the
 * page mirrors it into the worker's IndexedDB (push-prefs.ts `ignored`, by
 * network uuid) and a push from someone on it shows nothing new
 * (service-worker.js `showMessage`). The rule is the page's own:
 * `compareHostmask` of each entry against the sender's `nick!user@host`.
 * A push in the JSON tier carries the nick alone, so there only an entry
 * naming the nick (any ident and host) matches.
 */
import {compareHostmask, type Hostmask} from "../irc/hostmask";

function isMask(value: unknown): value is Hostmask {
	const mask = value as Hostmask;
	return (
		typeof mask === "object" &&
		mask !== null &&
		typeof mask.nick === "string" &&
		typeof mask.ident === "string" &&
		typeof mask.hostname === "string"
	);
}

/** Whether `masks` (what the page mirrored for the network) name this sender. */
export function ignoredSender(masks: unknown, nick: string, user = "", host = ""): boolean {
	if (!Array.isArray(masks) || !nick) {
		return false;
	}

	const sender: Hostmask = {nick, ident: user, hostname: host};

	return masks.some((mask) => isMask(mask) && compareHostmask(mask, sender));
}
