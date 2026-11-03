import type {UserModel} from "../irc/investigate";
import type {SeenEntry} from "./verdict";

/** The facts Compare can call the same, in the order the card shows them. */
export const COMPARED = [
	["host", "host"],
	["ip", "IP"],
	["server", "server"],
	["account", "account"],
	["realname", "realname"],
	["version", "version"],
	["lastQuitHostmask", "last quit"],
] as const;

export type ComparedKey = typeof COMPARED[number][0];

/** A user's value for a compared fact, lower-cased; undefined when unknown. */
export function factOf(model: UserModel, key: ComparedKey): string | undefined {
	const value = key === "lastQuitHostmask" ? model.lastQuitHostmask : model.user[key];
	return typeof value === "string" && value !== "" ? value.toLowerCase() : undefined;
}

/** Both users have this fact, and it is the same. */
export function sameFact(a: UserModel, b: UserModel, key: ComparedKey): boolean {
	const va = factOf(a, key);
	return va !== undefined && va === factOf(b, key);
}

export interface CompareSummary {
	/** The facts both users have. */
	known: number;
	/** The labels of the ones that match, in card order. */
	same: string[];
	tone: "warn" | "plain";
	lead: string;
}

/**
 * What the comparison comes to, for the line over the facts: how many of
 * the facts both users have are the same, and which. The same address
 * and two more facts read as one person, anything less as overlap.
 */
export function compareSummary(a: UserModel, b: UserModel): CompareSummary {
	const known = COMPARED.filter(
		([key]) => factOf(a, key) !== undefined && factOf(b, key) !== undefined
	);
	const same = known.filter(([key]) => sameFact(a, b, key));
	const address = same.some(([key]) => key === "ip" || key === "host");
	const likely = address && same.length >= 3;
	return {
		known: known.length,
		same: same.map(([, label]) => label),
		tone: likely ? "warn" : "plain",
		lead: likely ? "Likely same person" : same.length ? "Some in common" : "Nothing in common",
	};
}

/** A "seen before" sighting, and which of the two users it is like. */
export interface SharedSighting {
	entry: SeenEntry;
	a: boolean;
	b: boolean;
}

/**
 * Both users' "seen before" as one list, newest first: a sighting either
 * one matched appears once, marked with whose it is. The two users
 * themselves are left out; that they match each other is the table's job.
 */
export function mergeSeen(a: UserModel, b: UserModel): SharedSighting[] {
	const self = new Set([a.target.toLowerCase(), b.target.toLowerCase()]);
	const out = new Map<string, SharedSighting>();

	const add = (list: SeenEntry[], side: "a" | "b") => {
		for (const entry of list) {
			const nick = entry.nick.toLowerCase();

			if (self.has(nick)) {
				continue;
			}

			const have = out.get(nick);

			if (have) {
				have[side] = true;

				if (entry.time > have.entry.time) {
					have.entry = entry;
				}
			} else {
				out.set(nick, {entry, a: side === "a", b: side === "b"});
			}
		}
	};

	add(a.seen, "a");
	add(b.seen, "b");
	return [...out.values()].sort((x, y) => y.entry.time - x.entry.time);
}
