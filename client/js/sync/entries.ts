/**
 * What roams, entry by entry (docs/projects/settings-sync.md § What roams):
 * each store that follows the account is read from the device's storage
 * into document entries (sync/document.ts) and written back from them.
 *
 * | id                     | value                          | stored in                  |
 * | ---------------------- | ------------------------------ | -------------------------- |
 * | `set:<name>`           | the setting's value            | `settings` (through a port)|
 * | `alias:<name>`         | `{name, body}`                 | `thelounge.aliases`        |
 * | `mute:<channel>`       | `true`                         | `thelounge.muted`          |
 * | `fav:<name>`           | `{name, type}`                 | `thelounge.favorites`      |
 * | `order:fav`            | the favorites' names in order  | `thelounge.favorites`      |
 * | `order:channels`       | the channels' names in order   | `thelounge.sort.channels`  |
 * | `ignore:<mask>`        | `{nick, ident, hostname, when}`| `thelounge.ignore.<uuid>`  |
 * | `trust:host:<host>`    | `true`                         | `thelounge.media.trusted`  |
 * | `trust:channel:<name>` | `true`                         | `thelounge.media.trusted`  |
 * | `trust:account:<name>` | `true`                         | `thelounge.media.trusted`  |
 * | `person:<acct>@<host>` | `true`                         | `thelounge.avatars`        |
 * | `dnd:schedule`         | the daily window               | `thelounge.dnd`            |
 * | `oper:route:<kind>`    | the route                      | `thelounge.oper`           |
 * | `oper:temp:<kind>`     | `{route, until, revert}`       | `thelounge.oper`           |
 * | `oper:snomask`         | the snomask                    | `thelounge.oper`           |
 * | `oper:note:<about>`    | the note                       | `thelounge.oper`           |
 * | `tr:<channel>`         | the channel's translation choices | `thelounge.translate`   |
 * | `net:name`             | the home's display name        | `thelounge.networks`       |
 * | `net:nick`             | the home's nick                | `thelounge.networks`       |
 * | `net:join`             | the home's autojoin channels   | `thelounge.networks`       |
 * | `net:commands`         | the home's commands on connect | `thelounge.networks`       |
 * | `net:services`         | the home's services support    | `thelounge.networks`       |
 *
 * Everything keyed by a network is the home network's alone (§ Open): the
 * home is the same network on every device, so its entries need no name,
 * and what belongs to another network stays on the device, untouched by a
 * write here. The order of the networks is left out for the same reason.
 *
 * A write validates: what arrives was written by whoever can set the
 * account's metadata. A value this build cannot hold is skipped, and
 * document.ts `reconcile` notes the difference.
 *
 * No store and no DOM (test/sync/entries.ts).
 */

import {dict} from "../helpers/dict";
import {asSchedule, defaultDndState, parseDndState, serializeDndState} from "../helpers/dnd";
import {isValidAlias, MAX_ALIASES, type Alias} from "../helpers/aliases";
import {normalizeHost} from "../helpers/urlHost";
import {casefold} from "../irc/casemap";
import {asServices} from "../irc/saved-networks";
import {isSupported} from "../translate/languages";
import {sameValue, type Entries, type Local} from "./document";

export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

/** The settings store, as far as sync reads and writes it. */
export interface SettingsPort {
	/** Every setting that roams and this build knows, with its value now. */
	values(): Record<string, unknown>;
	/** Their defaults on this device. */
	defaults(): Record<string, unknown>;
	/** Take a value; false when this build cannot (a theme it does not ship). */
	set(name: string, value: unknown): boolean;
}

export interface EntryContext {
	storage: StorageBackend;
	/** The home network's uuid on this device. */
	home: string;
	settings: SettingsPort;
}

interface Codec {
	owns(ctx: EntryContext, id: string): boolean;
	read(ctx: EntryContext): Record<string, unknown>;
	isDefault?(ctx: EntryContext, id: string, value: unknown): boolean;
	/** Make the device hold exactly `wanted` for the ids this codec owns. */
	write(ctx: EntryContext, wanted: Record<string, unknown>): void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(storage: StorageBackend, key: string): unknown {
	try {
		const raw = storage.get(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function writeJson(storage: StorageBackend, key: string, value: unknown, empty: boolean): void {
	if (empty) {
		storage.remove(key);
	} else {
		storage.set(key, JSON.stringify(value));
	}
}

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** The ids of `wanted` under `prefix`, without it, in order. */
function suffixes(wanted: Record<string, unknown>, prefix: string): string[] {
	return Object.keys(wanted)
		.filter((id) => id.startsWith(prefix))
		.map((id) => id.slice(prefix.length))
		.sort();
}

const byPrefix =
	(...prefixes: string[]) =>
	(_ctx: EntryContext, id: string): boolean =>
		prefixes.some((prefix) => id.startsWith(prefix));

/** `<uuid>/<name>` keys of the home network, as their names. */
function homeNames(keys: string[], home: string): string[] {
	const prefix = `${home}/`;
	return keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

/** `keys` with the home network's replaced by `names`. */
function withHomeNames(keys: string[], home: string, names: string[]): string[] {
	const prefix = `${home}/`;
	const kept = names.filter((name) => keys.includes(prefix + name));
	const added = names.filter((name) => !keys.includes(prefix + name));
	const out = keys.filter(
		(key) => !key.startsWith(prefix) || kept.includes(key.slice(prefix.length))
	);
	return [...out, ...added.map((name) => prefix + name)];
}

// --- settings ---

const settings: Codec = {
	owns: (ctx, id) => id.startsWith("set:") && Object.hasOwn(ctx.settings.values(), id.slice(4)),
	read(ctx) {
		const out = dict<unknown>();

		for (const [name, value] of Object.entries(ctx.settings.values())) {
			out[`set:${name}`] = value;
		}

		return out;
	},
	isDefault: (ctx, id, value) => sameValue(value, ctx.settings.defaults()[id.slice(4)]),
	write(ctx, wanted) {
		const defaults = ctx.settings.defaults();

		for (const [name, value] of Object.entries(ctx.settings.values())) {
			const id = `set:${name}`;
			const target = Object.hasOwn(wanted, id) ? wanted[id] : defaults[name];
			const fits =
				typeof target === typeof defaults[name] &&
				Array.isArray(target) === Array.isArray(defaults[name]);

			if (fits && !sameValue(target, value)) {
				ctx.settings.set(name, target);
			}
		}
	},
};

// --- aliases ---

const ALIASES_KEY = "thelounge.aliases";

function storedAliases(ctx: EntryContext): Alias[] {
	const parsed = readJson(ctx.storage, ALIASES_KEY);
	const seen = new Set<string>();
	const list: Alias[] = [];

	for (const entry of Array.isArray(parsed) ? parsed : []) {
		if (isValidAlias(entry) && !seen.has(entry.name.toLowerCase())) {
			seen.add(entry.name.toLowerCase());
			list.push({name: entry.name, body: entry.body});
		}
	}

	return list.slice(0, MAX_ALIASES);
}

const aliases: Codec = {
	owns: byPrefix("alias:"),
	read(ctx) {
		const out = dict<unknown>();

		for (const alias of storedAliases(ctx)) {
			out[`alias:${alias.name.toLowerCase()}`] = alias;
		}

		return out;
	},
	write(ctx, wanted) {
		const want = new Map<string, Alias>();
		const mine = new Map(storedAliases(ctx).map((alias) => [alias.name.toLowerCase(), alias]));

		for (const name of suffixes(wanted, "alias:")) {
			const value = wanted[`alias:${name}`];

			if (isValidAlias(value) && value.name.toLowerCase() === name) {
				want.set(name, {name: value.name, body: value.body});
			} else if (mine.has(name)) {
				// A value this build cannot hold is skipped: the device's own stays.
				want.set(name, mine.get(name)!);
			}
		}

		// The user's order for those kept, new ones after.
		const list: Alias[] = [];

		for (const alias of storedAliases(ctx)) {
			const next = want.get(alias.name.toLowerCase());

			if (next) {
				list.push(next);
				want.delete(alias.name.toLowerCase());
			}
		}

		list.push(...want.values());
		const kept = list.slice(0, MAX_ALIASES);
		writeJson(ctx.storage, ALIASES_KEY, kept, kept.length === 0);
	},
};

// --- mutes ---

const MUTED_KEY = "thelounge.muted";

const mutes: Codec = {
	owns: byPrefix("mute:"),
	read(ctx) {
		const out = dict<unknown>();

		for (const name of homeNames(strings(readJson(ctx.storage, MUTED_KEY)), ctx.home)) {
			out[`mute:${name}`] = true;
		}

		return out;
	},
	write(ctx, wanted) {
		const names = suffixes(wanted, "mute:").filter(
			(name) => wanted[`mute:${name}`] === true && name === name.toLowerCase()
		);
		const next = withHomeNames(strings(readJson(ctx.storage, MUTED_KEY)), ctx.home, names);
		ctx.storage.set(MUTED_KEY, JSON.stringify(next));
	},
};

// --- favorites ---

const FAVORITES_KEY = "thelounge.favorites";
const FAVORITE_ORDER = "order:fav";

interface StoredFavorite {
	network: string;
	name: string;
	type: "channel" | "query";
}

const fold = (name: string) => casefold(name, "ascii");

function storedFavorites(ctx: EntryContext): StoredFavorite[] {
	const parsed = readJson(ctx.storage, FAVORITES_KEY);
	const out: StoredFavorite[] = [];

	for (const entry of Array.isArray(parsed) ? parsed : []) {
		if (
			isObject(entry) &&
			typeof entry.network === "string" &&
			typeof entry.name === "string" &&
			entry.name !== "" &&
			(entry.type === "channel" || entry.type === "query")
		) {
			out.push({network: entry.network, name: entry.name, type: entry.type});
		}
	}

	return out;
}

const favorites: Codec = {
	owns: (_ctx, id) => id.startsWith("fav:") || id === FAVORITE_ORDER,
	read(ctx) {
		const out = dict<unknown>();
		const order: string[] = [];

		for (const favorite of storedFavorites(ctx)) {
			const key = fold(favorite.name);

			if (favorite.network === ctx.home && !order.includes(key)) {
				out[`fav:${key}`] = {name: favorite.name, type: favorite.type};
				order.push(key);
			}
		}

		out[FAVORITE_ORDER] = order;
		return out;
	},
	// One favorite has no order to speak of.
	isDefault: (_ctx, id, value) => id === FAVORITE_ORDER && strings(value).length < 2,
	write(ctx, wanted) {
		const want = new Map<string, StoredFavorite>();

		for (const key of suffixes(wanted, "fav:")) {
			const value = wanted[`fav:${key}`];

			if (
				isObject(value) &&
				typeof value.name === "string" &&
				fold(value.name) === key &&
				(value.type === "channel" || value.type === "query")
			) {
				want.set(key, {network: ctx.home, name: value.name, type: value.type});
			} else {
				// A value this build cannot hold is skipped: the device's own stays.
				const mine = storedFavorites(ctx).find(
					(f) => f.network === ctx.home && fold(f.name) === key
				);

				if (mine) {
					want.set(key, mine);
				}
			}
		}

		const stored = storedFavorites(ctx);
		const order = strings(wanted[FAVORITE_ORDER]);
		const before = stored.filter((f) => f.network === ctx.home).map((f) => fold(f.name));
		// Where the order names it; else where it stood here; else last.
		const rank = (key: string): [number, number] => [
			order.includes(key) ? order.indexOf(key) : Infinity,
			before.includes(key) ? before.indexOf(key) : Infinity,
		];
		const home = [...want.keys()].sort((a, b) => {
			const [orderA, hereA] = rank(a);
			const [orderB, hereB] = rank(b);
			return orderA - orderB || hereA - hereB || (a < b ? -1 : a > b ? 1 : 0);
		});

		// The home's favorites take the places the home's had in the block,
		// in their new order; any more go to the end.
		const next: StoredFavorite[] = [];

		for (const favorite of stored) {
			if (favorite.network !== ctx.home) {
				next.push(favorite);
				continue;
			}

			const key = home.shift();

			if (key !== undefined) {
				next.push(want.get(key)!);
			}
		}

		next.push(...home.map((key) => want.get(key)!));
		writeJson(ctx.storage, FAVORITES_KEY, next, next.length === 0);
	},
};

// --- the home network's channel order ---

const CHANNEL_ORDER_KEY = "thelounge.sort.channels";
const CHANNEL_ORDER = "order:channels";

const channelOrder: Codec = {
	owns: (_ctx, id) => id === CHANNEL_ORDER,
	read(ctx) {
		const orders = readJson(ctx.storage, CHANNEL_ORDER_KEY);
		const out = dict<unknown>();
		out[CHANNEL_ORDER] = isObject(orders) ? strings(orders[ctx.home]) : [];
		return out;
	},
	isDefault: (_ctx, _id, value) => strings(value).length === 0,
	write(ctx, wanted) {
		const parsed = readJson(ctx.storage, CHANNEL_ORDER_KEY);
		const orders = Object.assign(dict<unknown>(), isObject(parsed) ? parsed : {});
		const names = strings(wanted[CHANNEL_ORDER]);

		if (names.length > 0) {
			orders[ctx.home] = names;
		} else {
			delete orders[ctx.home];
		}

		ctx.storage.set(CHANNEL_ORDER_KEY, JSON.stringify(orders));
	},
};

// --- the home network's ignore list ---

interface StoredIgnore {
	nick: string;
	ident: string;
	hostname: string;
	when: number;
}

const ignoreKey = (home: string) => `thelounge.ignore.${home}`;
const isIgnore = (value: unknown): value is StoredIgnore =>
	isObject(value) &&
	typeof value.nick === "string" &&
	typeof value.ident === "string" &&
	typeof value.hostname === "string" &&
	typeof value.when === "number";
const maskOf = (e: StoredIgnore) => `${e.nick}!${e.ident}@${e.hostname}`.toLowerCase();

function storedIgnores(ctx: EntryContext): StoredIgnore[] {
	const parsed = readJson(ctx.storage, ignoreKey(ctx.home));
	return (Array.isArray(parsed) ? parsed : []).filter(isIgnore);
}

const ignores: Codec = {
	owns: byPrefix("ignore:"),
	read(ctx) {
		const out = dict<unknown>();

		for (const entry of storedIgnores(ctx)) {
			const {nick, ident, hostname, when} = entry;
			out[`ignore:${maskOf(entry)}`] ??= {nick, ident, hostname, when};
		}

		return out;
	},
	write(ctx, wanted) {
		const want = new Map<string, StoredIgnore>();
		// The first of a mask, as `read` takes it.
		const mine = new Map(
			storedIgnores(ctx)
				.reverse()
				.map((entry) => [maskOf(entry), entry])
		);

		for (const mask of suffixes(wanted, "ignore:")) {
			const value = wanted[`ignore:${mask}`];

			if (isIgnore(value) && maskOf(value) === mask) {
				const {nick, ident, hostname, when} = value;
				want.set(mask, {nick, ident, hostname, when});
			} else if (mine.has(mask)) {
				// A value this build cannot hold is skipped: the device's own stays.
				const {nick, ident, hostname, when} = mine.get(mask)!;
				want.set(mask, {nick, ident, hostname, when});
			}
		}

		const list: StoredIgnore[] = [];

		for (const entry of storedIgnores(ctx)) {
			const next = want.get(maskOf(entry));

			if (next) {
				list.push(next);
				want.delete(maskOf(entry));
			}
		}

		list.push(...[...want.values()].sort((a, b) => a.when - b.when));
		writeJson(ctx.storage, ignoreKey(ctx.home), list, list.length === 0);
	},
};

// --- trusted media: hosts (every network's), the home's channels and accounts ---

const MEDIA_KEY = "thelounge.media.trusted";

function storedTrust(ctx: EntryContext): {host: string[]; channel: string[]; account: string[]} {
	const parsed = readJson(ctx.storage, MEDIA_KEY);

	if (Array.isArray(parsed)) {
		return {host: strings(parsed), channel: [], account: []}; // the first format
	}

	const lists = isObject(parsed) ? parsed : {};
	return {
		host: strings(lists.host),
		channel: strings(lists.channel),
		account: strings(lists.account),
	};
}

const mediaTrust: Codec = {
	owns: byPrefix("trust:host:", "trust:channel:", "trust:account:"),
	read(ctx) {
		const out = dict<unknown>();
		const stored = storedTrust(ctx);

		for (const host of stored.host) {
			if (normalizeHost(host)) {
				out[`trust:host:${normalizeHost(host)}`] = true;
			}
		}

		for (const name of homeNames(stored.channel, ctx.home)) {
			out[`trust:channel:${name}`] = true;
		}

		for (const name of homeNames(stored.account, ctx.home)) {
			out[`trust:account:${name}`] = true;
		}

		return out;
	},
	write(ctx, wanted) {
		const stored = storedTrust(ctx);
		const on = (prefix: string) =>
			suffixes(wanted, prefix).filter((name) => wanted[prefix + name] === true);
		const hosts = on("trust:host:").filter(
			(host) => host !== "" && host === normalizeHost(host)
		);
		const kept = stored.host.map(normalizeHost).filter((host) => hosts.includes(host));
		const lists = {
			host: [...new Set([...kept, ...hosts])],
			channel: withHomeNames(stored.channel, ctx.home, on("trust:channel:")),
			account: withHomeNames(stored.account, ctx.home, on("trust:account:")),
		};
		ctx.storage.set(MEDIA_KEY, JSON.stringify(lists));
	},
};

// --- trusted avatar people on the home network ---

const AVATARS_KEY = "thelounge.avatars";

function storedAvatars(ctx: EntryContext): {off: string[]; people: string[]} {
	const parsed = readJson(ctx.storage, AVATARS_KEY);
	const record = isObject(parsed) ? parsed : {};
	return {off: strings(record.off), people: strings(record.people)};
}

const people: Codec = {
	owns: byPrefix("person:"),
	read(ctx) {
		const out = dict<unknown>();

		for (const name of homeNames(storedAvatars(ctx).people, ctx.home)) {
			out[`person:${name}`] = true;
		}

		return out;
	},
	write(ctx, wanted) {
		const stored = storedAvatars(ctx);
		const names = suffixes(wanted, "person:").filter(
			(name) => wanted[`person:${name}`] === true && name.includes("@")
		);
		const next = {off: stored.off, people: withHomeNames(stored.people, ctx.home, names)};
		writeJson(
			ctx.storage,
			AVATARS_KEY,
			next,
			next.off.length === 0 && next.people.length === 0
		);
	},
};

// --- the do-not-disturb schedule ---

const DND_KEY = "thelounge.dnd";
const DND_SCHEDULE = "dnd:schedule";

const dnd: Codec = {
	owns: (_ctx, id) => id === DND_SCHEDULE,
	read(ctx) {
		const out = dict<unknown>();
		out[DND_SCHEDULE] = parseDndState(ctx.storage.get(DND_KEY)).schedule;
		return out;
	},
	isDefault: (_ctx, _id, value) => sameValue(value, defaultDndState().schedule),
	write(ctx, wanted) {
		const state = parseDndState(ctx.storage.get(DND_KEY));
		const schedule = Object.hasOwn(wanted, DND_SCHEDULE)
			? asSchedule(wanted[DND_SCHEDULE])
			: defaultDndState().schedule;

		if (schedule && !sameValue(schedule, state.schedule)) {
			// Another window than the one a skip was pressed in.
			ctx.storage.set(
				DND_KEY,
				serializeDndState({...state, schedule, scheduleSkippedUntil: null})
			);
		}
	},
};

// --- oper preferences on the home network ---

const OPER_KEY = "thelounge.oper";
const isRoute = (value: unknown): value is string =>
	value === "active" || value === "network" || value === "off";
const isTemporary = (value: unknown): boolean =>
	isObject(value) &&
	isRoute(value.route) &&
	typeof value.until === "number" &&
	(value.revert === undefined || isRoute(value.revert));

/** A map of the home's oper prefs: its id prefix and what a value must be. */
const OPER_MAPS: Array<[field: string, prefix: string, valid: (value: unknown) => boolean]> = [
	["routes", "oper:route:", isRoute],
	["temporary", "oper:temp:", isTemporary],
	["notes", "oper:note:", (value) => typeof value === "string" && value !== ""],
];

const oper: Codec = {
	owns: (_ctx, id) => id === "oper:snomask" || OPER_MAPS.some(([, p]) => id.startsWith(p)),
	read(ctx) {
		const out = dict<unknown>();
		const all = readJson(ctx.storage, OPER_KEY);
		const prefs = isObject(all) && isObject(all[ctx.home]) ? all[ctx.home] : {};

		if (!isObject(prefs)) {
			return out;
		}

		for (const [field, prefix, valid] of OPER_MAPS) {
			for (const [name, value] of Object.entries(
				isObject(prefs[field]) ? prefs[field] : {}
			)) {
				if (valid(value)) {
					out[prefix + name] = value;
				}
			}
		}

		if (Number.isInteger(prefs.snomask)) {
			out["oper:snomask"] = prefs.snomask;
		}

		return out;
	},
	write(ctx, wanted) {
		const parsed = readJson(ctx.storage, OPER_KEY);
		const all = Object.assign(dict<unknown>(), isObject(parsed) ? parsed : {});
		const before = isObject(all[ctx.home]) ? all[ctx.home] : {};
		const prefs = dict<unknown>();

		// Whatever else a later build keeps there stays.
		for (const [field, value] of Object.entries(before as Record<string, unknown>)) {
			if (field !== "snomask" && !OPER_MAPS.some(([f]) => f === field)) {
				prefs[field] = value;
			}
		}

		for (const [field, prefix, valid] of OPER_MAPS) {
			const map = Object.fromEntries(
				suffixes(wanted, prefix)
					.filter((name) => valid(wanted[prefix + name]))
					.map((name) => [name, wanted[prefix + name]])
			);

			if (Object.keys(map).length > 0) {
				prefs[field] = map;
			}
		}

		if (Number.isInteger(wanted["oper:snomask"])) {
			prefs.snomask = wanted["oper:snomask"];
		}

		if (Object.keys(prefs).length > 0) {
			all[ctx.home] = prefs;
		} else {
			delete all[ctx.home];
		}

		ctx.storage.set(OPER_KEY, JSON.stringify(all));
	},
};

// --- per-channel translation choices on the home network ---

const TRANSLATE_KEY = "thelounge.translate";
/** The blob's schema this code reads (translate/channelStore.ts STORE_VERSION). */
const TRANSLATE_VERSION = 2;

interface TranslationChoices {
	exclude: boolean;
	write: string | null;
	writeFrom: string | null;
	formality: string;
	noSuggest: boolean;
}

const NO_CHOICES: TranslationChoices = {
	exclude: false,
	write: null,
	writeFrom: null,
	formality: "auto",
	noSuggest: false,
};

const language = (value: unknown): string | null =>
	typeof value === "string" && isSupported(value) ? value : null;

function choicesOf(value: unknown): TranslationChoices {
	const raw = isObject(value) ? value : {};
	return {
		exclude: raw.exclude === true,
		write: language(raw.write),
		writeFrom: language(raw.writeFrom),
		formality:
			raw.formality === "formal" || raw.formality === "casual" ? raw.formality : "auto",
		noSuggest: raw.noSuggest === true,
	};
}

/** The stored blob when it is this version's; an older one waits for its migration. */
function translateBlob(ctx: EntryContext): Record<string, unknown> | null {
	const blob = readJson(ctx.storage, TRANSLATE_KEY);
	return isObject(blob) && blob.version === TRANSLATE_VERSION ? blob : null;
}

const translation: Codec = {
	owns: (ctx, id) => id.startsWith("tr:") && translateBlob(ctx) !== null,
	read(ctx) {
		const out = dict<unknown>();
		const blob = translateBlob(ctx) ?? {};

		for (const name of homeNames(Object.keys(blob), ctx.home)) {
			out[`tr:${name}`] = choicesOf(blob[`${ctx.home}/${name}`]);
		}

		return out;
	},
	isDefault: (_ctx, _id, value) => sameValue(value, NO_CHOICES),
	write(ctx, wanted) {
		const blob = translateBlob(ctx);

		if (!blob) {
			return;
		}

		const next = Object.assign(dict<unknown>(), blob);
		const names = new Set([
			...homeNames(Object.keys(blob), ctx.home),
			...suffixes(wanted, "tr:").filter((name) => name === name.toLowerCase()),
		]);

		for (const name of names) {
			const key = `${ctx.home}/${name}`;
			const record = isObject(blob[key]) ? blob[key] : {};
			const choices = Object.hasOwn(wanted, `tr:${name}`)
				? choicesOf(wanted[`tr:${name}`])
				: NO_CHOICES;

			if (!sameValue(choicesOf(record), choices)) {
				// The terms learnt here and the last language picked stay the device's.
				next[key] = {terms: [], once: null, ...record, ...choices};
			}
		}

		ctx.storage.set(TRANSLATE_KEY, JSON.stringify(next));
	},
};

// --- the home network's saved network, but how to reach it and log in ---

const NETWORKS_KEY = "thelounge.networks";

const validNick = (value: unknown): value is string =>
	typeof value === "string" && value !== "" && !/[\s,:\0]/.test(value);
const validJoin = (value: unknown): value is string =>
	typeof value === "string" && !/[\r\n\0]/.test(value);
const validCommands = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.every((line) => typeof line === "string" && line.trim() === line && line !== "") &&
	!value.some((line: string) => /[\r\n\0]/.test(line));

/**
 * The fields of the home's saved network that roam, by entry id: what the
 * user chose about the network, not how this device reaches it. The server,
 * TLS, the login and its passwords, trusted certificates, the push and
 * notification switches, autoconnect and the bookkeeping stay on the device:
 * the home's connection is how a device reads the file at all, its
 * passwords must not reach a key the network's operators can read, and the
 * rest is each device's own.
 */
const NETWORK_FIELDS: Array<{
	id: string;
	field: string;
	/** What this build can hold. */
	valid: (value: unknown) => boolean;
	/** The value of a field nobody chose; absent: there is none (the nick). */
	none?: unknown;
	/** Not stored at all when it has no value (the services support). */
	optional?: true;
}> = [
	{id: "net:name", field: "name", valid: (v) => typeof v === "string", none: ""},
	{id: "net:nick", field: "nick", valid: validNick},
	{id: "net:join", field: "join", valid: validJoin, none: ""},
	{id: "net:commands", field: "commands", valid: validCommands, none: []},
	{
		id: "net:services",
		field: "services",
		valid: (v) => asServices(v) !== undefined,
		optional: true,
	},
];

/** The saved network list as stored: written back with only the home's roaming fields changed. */
function storedNetworks(ctx: EntryContext): unknown[] {
	const parsed = readJson(ctx.storage, NETWORKS_KEY);
	return Array.isArray(parsed) ? parsed : [];
}

function storedHome(ctx: EntryContext): Record<string, unknown> | undefined {
	return storedNetworks(ctx).find(
		(entry): entry is Record<string, unknown> => isObject(entry) && entry.uuid === ctx.home
	);
}

const fieldOf = (id: string) => NETWORK_FIELDS.find((f) => f.id === id);

/** A field as this build reads it, or undefined when it holds nothing it can. */
function fieldValue(home: Record<string, unknown>, field: (typeof NETWORK_FIELDS)[number]) {
	const value = home[field.field];

	if (field.optional) {
		return asServices(value);
	}

	if (field.field === "commands") {
		return Array.isArray(value) ? value.filter((line) => typeof line === "string") : [];
	}

	return field.valid(value) ? value : field.none;
}

const savedNetwork: Codec = {
	owns: (_ctx, id) => fieldOf(id) !== undefined,
	read(ctx) {
		const out = dict<unknown>();
		const home = storedHome(ctx);

		if (!home) {
			return out;
		}

		for (const field of NETWORK_FIELDS) {
			const value = fieldValue(home, field);

			if (value !== undefined) {
				out[field.id] = value;
			}
		}

		return out;
	},
	isDefault(_ctx, id, value) {
		const field = fieldOf(id);
		return !!field && Object.hasOwn(field, "none") && sameValue(value, field.none);
	},
	write(ctx, wanted) {
		const list = storedNetworks(ctx);
		const index = list.findIndex((entry) => isObject(entry) && entry.uuid === ctx.home);

		// A device that has not saved the home has nowhere to keep it.
		if (index === -1) {
			return;
		}

		const home = {...(list[index] as Record<string, unknown>)};
		let changed = false;

		for (const field of NETWORK_FIELDS) {
			const mine = fieldValue(home, field);
			let next: unknown;

			if (Object.hasOwn(wanted, field.id)) {
				// A value this build cannot hold is skipped: the device's own stays.
				next = field.valid(wanted[field.id]) ? wanted[field.id] : mine;
			} else {
				// Removed: what nobody chose; a nick stays as it is.
				next = Object.hasOwn(field, "none") || field.optional ? field.none : mine;
			}

			if (field.optional) {
				next = asServices(next);
			}

			if (sameValue(next, mine)) {
				continue;
			}

			if (next === undefined) {
				delete home[field.field];
			} else {
				home[field.field] = next;
			}

			changed = true;
		}

		if (changed) {
			list[index] = home;
			ctx.storage.set(NETWORKS_KEY, JSON.stringify(list));
		}
	},
};

/**
 * The storage keys a roaming store writes, for the home `home`: a write to
 * one may be a change to date. Not the saved networks: their history cursor
 * is written with every message, and would put the dating off for as long as
 * a channel is busy. An edit of a saved network is heard through
 * saved-networks.ts `onSavedNetworksChange` instead (sync/index.ts).
 */
export function isRoamingKey(key: string, home: string): boolean {
	return (
		[
			"settings",
			ALIASES_KEY,
			MUTED_KEY,
			FAVORITES_KEY,
			CHANNEL_ORDER_KEY,
			MEDIA_KEY,
			AVATARS_KEY,
			DND_KEY,
			OPER_KEY,
			TRANSLATE_KEY,
		].includes(key) || key === ignoreKey(home)
	);
}

const CODECS: readonly Codec[] = [
	settings,
	aliases,
	mutes,
	favorites,
	channelOrder,
	ignores,
	mediaTrust,
	people,
	dnd,
	oper,
	translation,
	savedNetwork,
];

const codecOf = (ctx: EntryContext, id: string): Codec | undefined =>
	CODECS.find((codec) => codec.owns(ctx, id));

/** Everything this device holds that roams, and how to read it (document.ts). */
export function collect(ctx: EntryContext): Local {
	const current = dict<unknown>();

	for (const codec of CODECS) {
		const read = codec.read(ctx);

		for (const id of Object.keys(read)) {
			// A codec reads only what it owns: a blob it cannot write is not read.
			if (codec.owns(ctx, id)) {
				current[id] = read[id];
			}
		}
	}

	return {
		current,
		owns: (id) => codecOf(ctx, id) !== undefined,
		isDefault: (id, value) => codecOf(ctx, id)?.isDefault?.(ctx, id, value) ?? false,
	};
}

/** One entry the device holds differently after an {@link apply}. */
export interface Change {
	id: string;
	/** Undefined: the device did not hold it. */
	before?: unknown;
	/** Undefined: the device no longer holds it. */
	after?: unknown;
}

/**
 * Make the device hold what `entries` says, for the ids in `ids` (all of
 * them when omitted): a value is set, a removal marker removes, and an id
 * the document does not have is left as the device has it. Returns what
 * changed on the device and the storage keys written.
 */
export function apply(
	ctx: EntryContext,
	entries: Entries,
	ids?: readonly string[]
): {changes: Change[]; keys: string[]} {
	const before = collect(ctx).current;
	const keys = new Set<string>();
	const recording: EntryContext = {
		...ctx,
		storage: {
			get: (key) => ctx.storage.get(key),
			set(key, value) {
				if (ctx.storage.get(key) !== value) {
					ctx.storage.set(key, value);
					keys.add(key);
				}
			},
			remove(key) {
				if (ctx.storage.get(key) !== null) {
					ctx.storage.remove(key);
					keys.add(key);
				}
			},
		},
	};
	const touched = new Set<Codec>();
	const wanted = dict<unknown>();

	for (const id of Object.keys(before)) {
		wanted[id] = before[id];
	}

	for (const id of ids ?? Object.keys(entries)) {
		const entry = entries[id];
		const codec = entry ? codecOf(ctx, id) : undefined;

		if (!entry || !codec) {
			continue;
		}

		if (Object.hasOwn(entry, "v")) {
			if (!Object.hasOwn(wanted, id) || !sameValue(wanted[id], entry.v)) {
				wanted[id] = entry.v;
				touched.add(codec);
			}
		} else if (Object.hasOwn(wanted, id)) {
			delete wanted[id];
			touched.add(codec);
		}
	}

	for (const codec of touched) {
		const own = dict<unknown>();

		for (const id of Object.keys(wanted)) {
			if (codec.owns(ctx, id)) {
				own[id] = wanted[id];
			}
		}

		codec.write(recording, own);
	}

	const after = touched.size > 0 ? collect(ctx).current : before;
	const changes: Change[] = [];

	for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const had = Object.hasOwn(before, id);
		const has = Object.hasOwn(after, id);

		if (had !== has || !sameValue(before[id], after[id])) {
			changes.push({
				id,
				...(had ? {before: before[id]} : {}),
				...(has ? {after: after[id]} : {}),
			});
		}
	}

	return {changes, keys: [...keys].sort()};
}
