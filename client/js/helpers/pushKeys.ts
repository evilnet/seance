/**
 * VAPID application-server keys, as the Push API and the stored
 * subscriptions handle them. Vue-free (mocha: `test/helpers/pushKeys.ts`).
 *
 * A browser holds at most ONE push subscription per service-worker
 * registration, bound to the `applicationServerKey` it was created with;
 * `PushManager.subscribe()` with a different key is refused
 * (`InvalidStateError`, "unsubscribe then resubscribe"). The ircd announces
 * its key in `draft/webpush=vapid=<key>`, so a server-side rotation shows up
 * as a stored subscription that no connected server's key matches.
 */

/** URL-safe base64 (no padding), as `vapid=` carries it → the bytes
 * `PushManager.subscribe()` expects. */
export function decodeApplicationServerKey(b64: string): Uint8Array {
	const padding = "=".repeat((4 - (b64.length % 4)) % 4);
	const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const out = new Uint8Array(raw.length);

	for (let i = 0; i < raw.length; i++) {
		out[i] = raw.charCodeAt(i);
	}

	return out;
}

/** Whether `b64` (URL-safe or standard base64, padded or not) is an
 * uncompressed P-256 public key — 65 bytes, 0x04 first — the only VAPID
 * key the Android shell's UnifiedPush connector accepts. caps.ts takes any
 * URL-safe key of 32 characters or more and the ISUPPORT fallback anything,
 * so a browser finds out in `PushManager.subscribe()`; the shell must not. */
export function usableApplicationServerKey(b64: string): boolean {
	let bytes: Uint8Array;

	try {
		bytes = decodeApplicationServerKey(b64.replace(/=+$/, ""));
	} catch {
		return false;
	}

	return bytes.length === 65 && bytes[0] === 0x04;
}

/** Whether the key an existing browser subscription was created with
 * (`PushSubscription.options.applicationServerKey`) is `wanted`. */
export function sameApplicationServerKey(
	existing: ArrayBuffer | ArrayBufferView | null | undefined,
	wanted: Uint8Array
): boolean {
	if (!existing) {
		return false;
	}

	const bytes =
		existing instanceof ArrayBuffer
			? new Uint8Array(existing)
			: new Uint8Array(existing.buffer, existing.byteOffset, existing.byteLength);

	if (bytes.length !== wanted.length) {
		return false;
	}

	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== wanted[i]) {
			return false;
		}
	}

	return true;
}

/** What to do when a server's push identity (its VAPID key) changed and
 * the stored subscription no longer matches it — the `pushKeyChange`
 * setting: `ask` (the renew prompt), `trust` (renew on the spot, no
 * question), `ignore` (leave it; Settings keeps offering Renew). */
export type KeyChangePolicy = "ask" | "trust" | "ignore";

/** The setting's value, normalised: anything but the three known policies
 * reads as `ask` — an unknown value must never silence the prompt. */
export function keyChangePolicy(value: unknown): KeyChangePolicy {
	return value === "trust" || value === "ignore" ? value : "ask";
}
