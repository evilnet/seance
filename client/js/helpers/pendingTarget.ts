/**
 * A conversation the app should land on once it exists: the target of a
 * notification deep link (`#/net/<uuid>/<target>`) opened before the
 * network has joined its channels — or at all. Channel ids are session
 * local, so a notification that outlives the page can only name the
 * network (its saved uuid) and the target (channel or nick); the app keeps
 * that pair here until the `join` for it arrives, then switches to it.
 *
 * Vue-free so mocha covers it (test/helpers/pendingTarget.ts).
 */

export interface PendingTarget {
	network: string;
	target: string;
	/** When the deep link was followed (ms epoch). */
	at: number;
}

/** A pending target older than this is stale: the join never came. */
export const PENDING_TARGET_TTL_MS = 60_000;

let pending: PendingTarget | null = null;

/**
 * Whether `target` can be one nick or channel name, and so is safe to put on
 * a command line (`/query <target>`, router.ts `openQuery`). A deep link's
 * target comes from a URL anyone can write: decoded, `NickServ%20<cmd>` is a
 * message to NickServ and a `%0A` starts a second command. No whitespace, no
 * control characters, no comma (a list of targets) and no leading `/` (a
 * command) or `:` (IRC's trailing parameter).
 */
export function isValidTarget(target: string): boolean {
	return (
		target.length > 0 &&
		!/[\s,\u0000-\u001f\u007f-\u009f]/.test(target) &&
		target[0] !== "/" &&
		target[0] !== ":"
	);
}

/** Remember where to go once `target` on `network` exists. A target that
 * cannot be a nick or channel ({@link isValidTarget}) is dropped, and with it
 * any target still pending: the link that named it goes nowhere. */
export function setPendingTarget(network: string, target: string, now = Date.now()): void {
	pending = isValidTarget(target) ? {network, target, at: now} : null;
}

/** The pending target, if any and not expired (an expired one is dropped). */
export function getPendingTarget(now = Date.now()): PendingTarget | null {
	if (pending && now - pending.at > PENDING_TARGET_TTL_MS) {
		pending = null;
	}

	return pending;
}

/** Whether a channel named `name` on `network` is what we are waiting for;
 * IRC names compare case-insensitively (a `#Chan` push, a `#chan` join). */
export function matchesPendingTarget(network: string, name: string, now = Date.now()): boolean {
	const p = getPendingTarget(now);

	return p !== null && p.network === network && p.target.toLowerCase() === name.toLowerCase();
}

/** Consume the pending target: returns it once and forgets it. */
export function takePendingTarget(now = Date.now()): PendingTarget | null {
	const p = getPendingTarget(now);

	pending = null;

	return p;
}

export function clearPendingTarget(): void {
	pending = null;
}

/** Channel targets start with a channel prefix; anything else is a nick. */
export function isChannelTarget(target: string): boolean {
	return /^[#&!+]/.test(target);
}
