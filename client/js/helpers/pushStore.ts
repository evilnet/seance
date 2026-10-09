/**
 * The stored push subscriptions (`thelounge.push`), one per network:
 * `{[network uuid]: {vapid, endpoint, keys}}` — the key the subscription
 * was created against travels with it, so a server that rotated its key is
 * recognised per network (docs/projects/push-per-network.md). The shape
 * before per-network subscriptions was `{[vapid]: {endpoint, keys}}`; it is
 * read as `legacy` so the migration can unregister those endpoints. Vue-free:
 * `test/helpers/pushStore.ts`.
 */

export interface PushKeys {
	p256dh: string;
	auth: string;
}

export interface PushEntry {
	/** The server's VAPID key this subscription was created against. */
	vapid: string;
	endpoint: string;
	keys: PushKeys;
}

/** An entry of the old per-key map: what is needed to unregister it. */
export interface LegacyEntry {
	vapid: string;
	endpoint: string;
	/** Set when the network is known (an endpoint the Android shell's
	 * distributor replaced): unregistered there, whatever key it announces. */
	network?: string;
}

function isKeys(value: unknown): value is PushKeys {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PushKeys).p256dh === "string" &&
		typeof (value as PushKeys).auth === "string"
	);
}

function isMaterial(value: unknown): value is {endpoint: string; keys: PushKeys} {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PushEntry).endpoint === "string" &&
		isKeys((value as PushEntry).keys)
	);
}

/** Parse what `thelounge.push` holds: per-network entries, plus the old
 * per-key entries as `legacy`. Garbage is dropped, never thrown on. */
export function parseStoredSubscriptions(raw: string | null): {
	entries: Record<string, PushEntry>;
	legacy: LegacyEntry[];
} {
	const entries: Record<string, PushEntry> = {};
	const legacy: LegacyEntry[] = [];
	let parsed: unknown;

	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		parsed = null;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {entries, legacy};
	}

	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!isMaterial(value)) {
			continue;
		}

		if (typeof (value as PushEntry).vapid === "string") {
			entries[key] = {
				vapid: (value as PushEntry).vapid,
				endpoint: value.endpoint,
				keys: {p256dh: value.keys.p256dh, auth: value.keys.auth},
			};
		} else {
			legacy.push({vapid: key, endpoint: value.endpoint});
		}
	}

	return {entries, legacy};
}

/** A network's entry was made against another key than the one its server
 * now announces — the server rotated its push identity. False with nothing
 * stored, or nothing announced yet (nothing to compare against). */
export function entryStale(entry: PushEntry | undefined, announced: string | undefined): boolean {
	return entry !== undefined && announced !== undefined && entry.vapid !== announced;
}

/** Whether any connected network's entry is stale (the coarse Settings
 * state); `announced` maps network uuid → the key it announced. */
export function anyStale(
	entries: Record<string, PushEntry>,
	announced: Iterable<[string, string | undefined]>
): boolean {
	for (const [uuid, vapid] of announced) {
		if (entryStale(entries[uuid], vapid)) {
			return true;
		}
	}

	return false;
}
