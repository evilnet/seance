/**
 * Command aliases: user-defined slash commands, expanded before dispatch.
 *
 * An alias is a name and a body. Typing `/name args…` replaces the line with
 * the body, one command per body line, with the arguments substituted:
 *
 *   $1 … $9   one argument (empty when missing; $10 and up work too)
 *   $2-       arguments from the 2nd to the last
 *   $*        everything after the alias name, verbatim
 *   $chan     the name of the current channel or query
 *   $me       your nick on the current network
 *   $$        a literal dollar sign
 *
 * A body line may invoke another alias; expansion nests up to
 * {@link MAX_DEPTH} and a name already being expanded is left alone, so an
 * alias can wrap the built-in it shadows (`/join` → `/join #lobby $*`)
 * without looping. Expansion happens in `ChatInput.onSubmit`, before the
 * UI-only command check, so an alias can reach both UI commands (`/search`)
 * and everything the IRC layer handles.
 *
 * Storage is one localStorage key. Nothing here touches Vue, the store or
 * the DOM, so mocha covers it (`test/helpers/aliases.ts`).
 */

import storage from "../localStorage";

export const STORAGE_KEY = "thelounge.aliases";

/** Sanity caps: a screenful of aliases, not a scripting runtime. */
export const MAX_ALIASES = 200;
export const MAX_NAME_LENGTH = 32;
export const MAX_BODY_LENGTH = 2000;

/** How deep alias-in-alias expansion may nest. */
export const MAX_DEPTH = 8;

/** How many lines one invocation may expand to. Depth alone does not bound
 * it: three aliases of 666 `/next` lines each made 89 million. */
export const MAX_LINES = 50;

/** How many lines one invocation may look at, kept or not. The line cap
 * alone does not bound the work: lines that expand to nothing (`$1` with no
 * arguments) are never counted, and four aliases of 666 such lines took 80 s. */
export const MAX_EXPANSIONS = 1000;

/** Alias names look like command names: letters, digits, `_` and `-`. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export interface Alias {
	/** Without the leading slash; matched case-insensitively. */
	name: string;
	/** One command (or message line) per line. */
	body: string;
}

/** What the expansion can substitute besides the arguments. */
export interface AliasVars {
	/** The current channel or query name (`$chan`). */
	chan?: string;
	/** Own nick on the current network (`$me`). */
	me?: string;
}

/** The subset of the localStorage wrapper this module needs. */
export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

export function isValidAliasName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name);
}

function isValidAlias(entry: unknown): entry is Alias {
	if (typeof entry !== "object" || entry === null) {
		return false;
	}

	const {name, body} = entry as {name?: unknown; body?: unknown};

	return (
		typeof name === "string" &&
		isValidAliasName(name) &&
		typeof body === "string" &&
		body.trim().length > 0 &&
		body.length <= MAX_BODY_LENGTH
	);
}

/**
 * The stored list, in the user's order, invalid entries and later duplicates
 * dropped. Anything unreadable is treated as empty.
 */
export function loadAliases(): Alias[] {
	const raw = backend.get(STORAGE_KEY);

	if (!raw) {
		return [];
	}

	try {
		const parsed: unknown = JSON.parse(raw);

		if (!Array.isArray(parsed)) {
			throw new Error("not a list");
		}

		const seen = new Set<string>();
		const list: Alias[] = [];

		for (const entry of parsed) {
			if (!isValidAlias(entry) || seen.has(entry.name.toLowerCase())) {
				continue;
			}

			seen.add(entry.name.toLowerCase());
			list.push({name: entry.name, body: entry.body});

			if (list.length >= MAX_ALIASES) {
				break;
			}
		}

		return list;
	} catch {
		// A list we cannot read is one we will never write again: drop it.
		backend.remove(STORAGE_KEY);
		return [];
	}
}

/** Persist `list` as-is (the caller keeps it valid; the loader re-checks). */
export function saveAliases(list: Alias[]): void {
	if (list.length === 0) {
		backend.remove(STORAGE_KEY);
		return;
	}

	backend.set(STORAGE_KEY, JSON.stringify(list));
}

/** The stored names, without slashes, for autocompletion. */
export function aliasNames(): string[] {
	return loadAliases().map((alias) => alias.name);
}

/** `/name rest` → `{name, rest}`, or null for text and `//`-escaped lines. */
function splitInvocation(line: string): {name: string; rest: string} | null {
	if (line.charAt(0) !== "/" || line.charAt(1) === "/") {
		return null;
	}

	const body = line.slice(1);
	const space = body.indexOf(" ");
	const name = space === -1 ? body : body.slice(0, space);
	const rest = space === -1 ? "" : body.slice(space + 1);

	return name.length > 0 ? {name, rest} : null;
}

/** The alias body with `$…` substituted, split into non-empty lines. */
function substitute(template: string, rest: string, vars: AliasVars): string[] {
	const args = rest.length > 0 ? rest.split(/ +/).filter((arg) => arg.length > 0) : [];

	const expanded = template.replace(
		/\$(\$|\*|chan\b|me\b|(\d+)(-?))/gi,
		(whole: string, token: string, index: string | undefined, range: string | undefined) => {
			if (token === "$") {
				return "$";
			}

			if (token === "*") {
				return rest;
			}

			if (index !== undefined) {
				const from = parseInt(index, 10) - 1;

				if (from < 0) {
					// `$0` is nothing we define; leave it visible.
					return whole;
				}

				return range === "-" ? args.slice(from).join(" ") : args[from] ?? "";
			}

			if (token.toLowerCase() === "chan") {
				return vars.chan ?? "";
			}

			return vars.me ?? "";
		}
	);

	return expanded
		.split("\n")
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line.length > 0);
}

/** Expand `line` into `out`, stopping once it holds `MAX_LINES` or `budget` is spent. */
function expandLine(
	line: string,
	vars: AliasVars,
	map: Map<string, Alias>,
	chain: string[],
	out: string[],
	budget: {left: number}
): void {
	if (--budget.left < 0) {
		return;
	}

	const invocation = splitInvocation(line);

	if (!invocation || chain.length >= MAX_DEPTH) {
		out.push(line);
		return;
	}

	const key = invocation.name.toLowerCase();
	const alias = map.get(key);

	// A name already being expanded falls through to the built-in (or the
	// server), so `/join` aliased to `/join #lobby` terminates.
	if (!alias || chain.includes(key)) {
		out.push(line);
		return;
	}

	const next = [...chain, key];

	for (const expanded of substitute(alias.body, invocation.rest, vars)) {
		if (out.length >= MAX_LINES || budget.left <= 0) {
			return;
		}

		expandLine(expanded, vars, map, next, out, budget);
	}
}

/**
 * Expand `text` if it invokes an alias; `null` when it does not (plain text,
 * `//`-escaped, or no alias by that name), so the caller sends it unchanged.
 * `aliases` overrides the stored list (the settings preview passes its
 * unsaved rows).
 */
export function expandAlias(
	text: string,
	vars: AliasVars = {},
	aliases?: Alias[]
): string[] | null {
	const invocation = splitInvocation(text);

	if (!invocation) {
		return null;
	}

	const list = aliases ?? loadAliases();
	const map = new Map<string, Alias>();

	for (const alias of list) {
		if (!map.has(alias.name.toLowerCase())) {
			map.set(alias.name.toLowerCase(), alias);
		}
	}

	if (!map.has(invocation.name.toLowerCase())) {
		return null;
	}

	const out: string[] = [];
	expandLine(text, vars, map, [], out, {left: MAX_EXPANSIONS});
	return out;
}
