// Per-channel translation state (spec § Settings, persistence): the reading
// and writing targets, formality and variant, the languages people write in
// the channel, and the channel's term memory. One JSON blob under
// `thelounge.translate`, keyed by network uuid and lower-cased channel name
// like helpers/mediaTrust.ts. Vue-free; the store slice in store.ts mirrors
// it for reactivity (reader.ts keeps the two in step).

import storage from "../localStorage";
import {isSupported} from "./languages";

export const STORAGE_KEY = "thelounge.translate";
export const TERM_CAP = 300;

export type Formality = "auto" | "formal" | "casual";

/**
 * One remembered term: a short line the user sent translated and what it
 * went out as. The languages travel with it, so a prompt only carries the
 * terms of its own pair (`termsFor`): without them a German session's
 * "thanks -> danke" was quoted into every later French write.
 */
export interface TermEntry {
	source: string;
	target: string;
	/** The language `source` is in; null when the write left the source to the model. */
	from: string | null;
	/** The language `target` is in: the write target it was sent to. */
	to: string;
}

export interface ChannelTranslation {
	/**
	 * Reading on or off. The language is not per channel: it is the
	 * interface's (the one `locale` setting), so a stored record only
	 * remembers the switch. A record
	 * from before the unification carries the language a per-channel
	 * picker once set ("de"); anything truthy loads as on.
	 */
	read: boolean;
	/** Outgoing target (plan 3) or null. */
	write: string | null;
	formality: Formality;
	/** Free text for the prompt, e.g. "Brazilian Portuguese". */
	variant: string;
	/**
	 * The languages people write in this channel (ISO 639-1, supported
	 * codes only, deduplicated). Detection favours them: see detect.ts
	 * `DECLARED_MARGIN`. Empty when nothing was declared.
	 */
	languages: string[];
	/** Term memory, oldest first, one entry per source term and target language. */
	terms: TermEntry[];
	/**
	 * The language the composer's translate button last translated a
	 * message into here (writer.ts `translateOnce`), preselected by its
	 * dialog next time; null until it has been used.
	 */
	once: string | null;
}

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

export function channelKey(networkUuid: string, channelName: string): string {
	return `${networkUuid}/${channelName.toLowerCase()}`;
}

export function splitKey(key: string): {network: string; name: string} {
	const slash = key.indexOf("/");

	return {network: key.slice(0, slash), name: key.slice(slash + 1)};
}

export function defaultChannelTranslation(): ChannelTranslation {
	return {
		read: false,
		write: null,
		formality: "auto",
		variant: "",
		languages: [],
		terms: [],
		once: null,
	};
}

function isFormality(value: unknown): value is Formality {
	return value === "auto" || value === "formal" || value === "casual";
}

/** A stored or settings value as a register; anything else is "auto". */
export function asFormality(value: unknown): Formality {
	return isFormality(value) ? value : "auto";
}

/**
 * The register a request in a channel uses: the channel's own choice, or
 * the global setting (`translateFormality`, typed as a string by
 * settings.ts) where the channel says "auto". The composer's translation,
 * its read-back and every incoming line in the channel take the same one.
 */
export function effectiveFormality(channel: Formality, global: unknown): Formality {
	return channel !== "auto" ? channel : asFormality(global);
}

/**
 * The declared languages as the record keeps them: supported codes only,
 * in the order they were added, no duplicates. A code this build cannot
 * route is dropped rather than kept as a dead weight on detection.
 */
function languagesOf(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const out: string[] = [];

	for (const code of value) {
		if (typeof code === "string" && isSupported(code) && !out.includes(code)) {
			out.push(code);
		}
	}

	return out;
}

/**
 * A stored term this build can place: both sides text, a supported target
 * and a supported (or unknown) source. A legacy `[source, target]` pair
 * carries no language, so it is dropped: the memory starts over once.
 */
function isTermEntry(value: unknown): value is TermEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const raw = value as Record<string, unknown>;

	return (
		typeof raw.source === "string" &&
		typeof raw.target === "string" &&
		typeof raw.to === "string" &&
		isSupported(raw.to) &&
		(raw.from === null || (typeof raw.from === "string" && isSupported(raw.from)))
	);
}

function sanitize(value: unknown): ChannelTranslation | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}

	const raw = value as Record<string, unknown>;
	// Only the fields above survive: a record written by a later version
	// loses its extra keys the next time this one writes the blob.
	const out = defaultChannelTranslation();

	// A stored read is a switch: whatever language a per-channel picker
	// once held, truthy means reading was on. The write target this build
	// cannot route (hand-edited, or dropped from SUPPORTED_LANGUAGES by a
	// later version) is no target at all: it would leave every outgoing
	// line failing to route.
	out.read = Boolean(raw.read);
	out.write = typeof raw.write === "string" && isSupported(raw.write) ? raw.write : null;
	out.once = typeof raw.once === "string" && isSupported(raw.once) ? raw.once : null;
	out.formality = isFormality(raw.formality) ? raw.formality : "auto";
	out.variant = typeof raw.variant === "string" ? raw.variant : "";
	out.languages = languagesOf(raw.languages);
	out.terms = Array.isArray(raw.terms)
		? raw.terms
				.filter(isTermEntry)
				.map(({source, target, from, to}) => ({source, target, from, to}))
				.slice(-TERM_CAP)
		: [];

	return out;
}

export function loadAll(): Record<string, ChannelTranslation> {
	let parsed: unknown;

	try {
		const raw = backend.get(STORAGE_KEY);

		parsed = raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {};
	}

	const out: Record<string, ChannelTranslation> = {};

	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		const entry = sanitize(value);

		if (entry) {
			out[key] = entry;
		}
	}

	return out;
}

function saveAll(all: Record<string, ChannelTranslation>): void {
	backend.set(STORAGE_KEY, JSON.stringify(all));
}

export function getChannelTranslation(
	networkUuid: string,
	channelName: string
): ChannelTranslation {
	return loadAll()[channelKey(networkUuid, channelName)] ?? defaultChannelTranslation();
}

export function setChannelTranslation(
	networkUuid: string,
	channelName: string,
	patch: Partial<Omit<ChannelTranslation, "terms">>
): ChannelTranslation {
	const all = loadAll();
	const key = channelKey(networkUuid, channelName);
	const current = all[key] ?? defaultChannelTranslation();
	const rest = {...(patch as Partial<ChannelTranslation>)};

	delete rest.terms;
	const next: ChannelTranslation = {...current, ...rest};

	// The patch comes from the panel, so the codes are checked here as well
	// as on load: the committed record is what the store mirrors until the
	// next page, and an unroutable language must not sit in it weighting
	// detection.
	next.languages = languagesOf(next.languages);

	all[key] = next;
	saveAll(all);

	return next;
}

/**
 * Remember a term. An entry for the same source *and* the same target
 * language is replaced; the same phrase can keep a French and a German
 * rendering side by side.
 */
export function rememberTerm(networkUuid: string, channelName: string, entry: TermEntry): void {
	const all = loadAll();
	const key = channelKey(networkUuid, channelName);
	const current = all[key] ?? defaultChannelTranslation();
	const terms = current.terms.filter((t) => !(t.source === entry.source && t.to === entry.to));

	terms.push({source: entry.source, target: entry.target, from: entry.from, to: entry.to});
	all[key] = {...current, terms: terms.slice(-TERM_CAP)};
	saveAll(all);
}

/**
 * The channel's terms as the prompt's pairs for one request: an entry
 * written into `to` gives [source, target] (when both sides name a source,
 * they must agree); an entry written *from* `to` into `from` gives the
 * reverse, [target, source], so a line read back in the language a term was
 * sent in finds it. Everything else is left out.
 */
export function termsFor(
	entries: readonly TermEntry[],
	from: string | null,
	to: string
): [string, string][] {
	const out: [string, string][] = [];

	// Oldest first, as stored, so buildContext's newest TERM_LINES are still
	// the newest. One pair per entry: the forward reading wins.
	for (const entry of entries) {
		if (entry.to === to && (from === null || entry.from === null || entry.from === from)) {
			out.push([entry.source, entry.target]);
		} else if (entry.from === to && (from === null || entry.to === from)) {
			out.push([entry.target, entry.source]);
		}
	}

	return out;
}

/**
 * Whether a record's key names a private conversation: a query's key is the
 * nick. Decided on the name, because no network's CHANTYPES exist at boot
 * or in a backup file; a nick never starts with a channel prefix.
 */
export function isPrivateKey(key: string): boolean {
	return !/^[#&!+]/.test(splitKey(key).name);
}

/**
 * A copy of `all` without the terms of private conversations (the rest of
 * each record stays: its switches are settings, not anything said). A term
 * is a whole short line the user sent, so a query's are what was said in
 * private, kept and carried only where the query's own lines would be.
 */
export function withoutPrivateTerms<T extends {terms?: unknown}>(
	all: Record<string, T>
): Record<string, T> {
	const out: Record<string, T> = {};

	for (const [key, value] of Object.entries(all)) {
		out[key] =
			isPrivateKey(key) && Array.isArray(value?.terms) && value.terms.length > 0
				? {...value, terms: []}
				: value;
	}

	return out;
}

/**
 * Drop the terms of one conversation (a query closed: what was said in it
 * goes with it, as its log does). Returns the record left, or null when
 * there was nothing to drop.
 */
export function forgetTerms(networkUuid: string, channelName: string): ChannelTranslation | null {
	const all = loadAll();
	const key = channelKey(networkUuid, channelName);
	const current = all[key];

	if (!current || current.terms.length === 0) {
		return null;
	}

	all[key] = {...current, terms: []};
	saveAll(all);

	return all[key];
}

/**
 * Drop the terms of every private conversation, on every network
 * (`keepPrivateConversations` off). Returns whether anything was dropped.
 */
export function forgetPrivateTerms(): boolean {
	const all = loadAll();
	const next = withoutPrivateTerms(all);

	if (Object.keys(all).every((key) => all[key] === next[key])) {
		return false;
	}

	saveAll(next);
	return true;
}

export function forgetChannel(networkUuid: string, channelName: string): void {
	const all = loadAll();

	delete all[channelKey(networkUuid, channelName)];
	saveAll(all);
}

export function forgetNetwork(networkUuid: string): void {
	const all = loadAll();

	for (const key of Object.keys(all)) {
		if (splitKey(key).network === networkUuid) {
			delete all[key];
		}
	}

	saveAll(all);
}
