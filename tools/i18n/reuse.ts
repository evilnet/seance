/* eslint-disable no-console */
// Reuse what the catalogs already say.
//
//   npx tsx tools/i18n/reuse.ts --fill [--tags de,fr] [--dry]
//   npx tsx tools/i18n/reuse.ts --drift [--tags de,fr]
//   npx tsx tools/i18n/reuse.ts --new-keys <git-ref>
//
// --fill: an empty slot whose English the same catalog already translates
// under another key takes that translation, when the catalog translates it
// one way only. The entry gets a `# reused-from: <key>` note so a reviewer
// can find it; two keys with the same English that translate it two ways
// are left for a person (`--drift` lists them).
//
// --drift: the English strings a catalog translates more than one way.
// Some are right (a verb and a menu name, a different gender), most are
// one concept with two terms; the list is for a person to sort.
//
// --new-keys: the pot entries added (or reworded) since <git-ref> whose
// English another key already has, exactly or nearly (case, a trailing
// period, colon or ellipsis). Printed as GitHub annotations under Actions.
// It never fails: a second key with the same English is sometimes right,
// and `#, distinct` on the pot entry says so (add.ts --distinct) and
// silences it.

import {execFileSync} from "node:child_process";
import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
import {relative, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {parsePo, PoEntry, serializePo, unquote} from "./po";
import {LOCALES_DIR, POT_PATH} from "./paths";
import {PLURAL_RULES, parsePluralForms, PluralRule} from "./plural";
import {slotsToEmpty} from "./sweep";
import {NAME_TO_TAG, TARGETS_SOURCE} from "./targets";

/** The pot flag that marks a key as deliberately separate from the other
 * keys with its English: --fill does not copy into it, --new-keys does not
 * flag it. */
export const DISTINCT_FLAG = "distinct";

/** The translator note --fill leaves on what it copied. */
export const REUSED_FROM = "reused-from:";

/** Prefix of the shared keys new code should prefer over a fresh duplicate. */
export const COMMON_PREFIX = "common.";

/** What a key's English is, exactly: the singular, plus the plural when
 * there is one. Two entries share a translation only when both match. */
export function sourceOf(entry: PoEntry): string {
	return entry.msgidPlural === undefined
		? entry.msgid
		: `${entry.msgid}\u0000${entry.msgidPlural}`;
}

/**
 * The English folded for a near match: letter case outside `{placeholders}`,
 * runs of white space, and one trailing period, colon or ellipsis ("Edit…",
 * "Saved.", "Nick:") do not make a new phrase. A placeholder keeps its
 * exact name ({channel} is not {Channel}); a question mark, an exclamation
 * and any other character stay as they are. Only suggestions use this:
 * --fill matches the English exactly.
 */
export function foldEnglish(text: string): string {
	return text
		.normalize("NFC")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/(?:\.\.\.|…|[.:])$/u, "")
		.trim()
		.split(/(\{[^{}]*\})/)
		.map((part, index) => (index % 2 === 1 ? part : part.toLocaleLowerCase("en")))
		.join("");
}

function foldedSourceOf(entry: PoEntry): string {
	const singular = foldEnglish(entry.msgid);
	return entry.msgidPlural === undefined
		? singular
		: `${singular}\u0000${foldEnglish(entry.msgidPlural)}`;
}

/** A slot set is usable as a source when every slot holds text and the entry
 * is not stale. */
function translated(entry: PoEntry | undefined): entry is PoEntry {
	return (
		entry !== undefined &&
		!entry.flags.includes("fuzzy") &&
		entry.msgstr.length > 0 &&
		entry.msgstr.every((text) => text !== "")
	);
}

function untranslated(entry: PoEntry): boolean {
	return !entry.flags.includes("fuzzy") && entry.msgstr.every((text) => text === "");
}

/** The translation's identity: every slot, in order. */
function textOf(entry: PoEntry): string {
	return entry.msgstr.join("\u0000");
}

export interface ReuseFill {
	key: string;
	/** The keys whose (one) translation was copied. */
	from: string[];
	msgstr: string[];
}

export interface ReusePlan {
	fills: ReuseFill[];
	/** Empty keys left alone because the catalog translates their English
	 * more than one way: key -> the competing texts. */
	ambiguous: Array<{key: string; texts: string[]}>;
}

/**
 * Plan the fills for one catalog. `pot` decides what a key's English is and
 * whether it is marked distinct; `po` holds the translations. A target is
 * an entry with every slot empty and no fuzzy mark (a fuzzy entry is stale
 * and wants a person); a source is a different key with the same English,
 * translated in full and not fuzzy, that is not itself marked distinct.
 * Donor and copy alike must pass sweep.ts's own judgement (slotsToEmpty,
 * every slot against the English that slot translates), so the fill never
 * writes what the sweep would empty, and a donor the sweep would empty
 * neither donates nor makes a group look ambiguous. A plural copy must
 * have the catalog's number of forms.
 */
export function planReuse(
	pot: PoEntry[],
	po: PoEntry[],
	tag: string,
	rule: PluralRule | undefined = PLURAL_RULES[tag]
): ReusePlan {
	if (!rule) {
		throw new Error(`reuse: no plural rule for ${tag}`);
	}

	const sound = (entry: PoEntry, msgstr: string[]) =>
		slotsToEmpty({...entry, msgstr}, rule, tag).length === 0;
	const distinct = new Set(
		pot.filter((entry) => entry.flags.includes(DISTINCT_FLAG)).map((entry) => entry.msgctxt)
	);
	const potByKey = new Map(pot.map((entry) => [entry.msgctxt, entry]));
	const poByKey = new Map(po.map((entry) => [entry.msgctxt, entry]));

	// Sources by English: key -> its translation.
	const bySource = new Map<string, Map<string, string>>();

	for (const entry of po) {
		const potEntry = potByKey.get(entry.msgctxt);

		if (
			!entry.msgctxt ||
			!potEntry ||
			sourceOf(potEntry) !== sourceOf(entry) ||
			distinct.has(entry.msgctxt) ||
			!translated(entry) ||
			(!entry.msgid && entry.msgidPlural === undefined) ||
			!sound(potEntry, entry.msgstr)
		) {
			continue;
		}

		const group = bySource.get(sourceOf(entry)) ?? new Map<string, string>();
		group.set(entry.msgctxt, textOf(entry));
		bySource.set(sourceOf(entry), group);
	}

	const fills: ReuseFill[] = [];
	const ambiguous: ReusePlan["ambiguous"] = [];

	for (const potEntry of pot) {
		const key = potEntry.msgctxt;
		const entry = poByKey.get(key);

		if (!key || !entry || distinct.has(key) || !untranslated(entry)) {
			continue;
		}

		// An empty msgid is a slot left blank on purpose (a deploy fills
		// it); sweep.ts empties any text in one.
		if (!potEntry.msgid && potEntry.msgidPlural === undefined) {
			continue;
		}

		if (sourceOf(entry) !== sourceOf(potEntry)) {
			continue; // not merged yet: merge.ts first
		}

		const group = bySource.get(sourceOf(potEntry));

		if (!group || group.size === 0) {
			continue;
		}

		const texts = [...new Set(group.values())];

		if (texts.length > 1) {
			ambiguous.push({key, texts: texts.map((text) => text.split("\u0000").join(" | "))});
			continue;
		}

		const msgstr = texts[0].split("\u0000");

		// A copy has the target's shape: one slot, or the catalog's number of
		// plural forms (a donor or target shaped for another rule is left
		// for a person; merge.ts keeps whatever slots an entry already has).
		const forms = potEntry.msgidPlural === undefined ? 1 : rule.nplurals;

		if (msgstr.length !== forms || entry.msgstr.length !== forms) {
			continue;
		}

		if (!sound(potEntry, msgstr)) {
			continue;
		}

		fills.push({key, from: [...group.keys()].sort(), msgstr});
	}

	return {fills, ambiguous};
}

/** Apply a plan in place: copy the text and leave the `reused-from` note. */
export function applyReuse(po: PoEntry[], plan: ReusePlan): void {
	const byKey = new Map(po.map((entry) => [entry.msgctxt, entry]));

	for (const fill of plan.fills) {
		const entry = byKey.get(fill.key);

		if (!entry) {
			continue;
		}

		entry.msgstr = [...fill.msgstr];
		entry.translatorComments = [
			...entry.translatorComments.filter((line) => !line.startsWith(REUSED_FROM)),
			`${REUSED_FROM} ${fill.from.join(" ")}`,
		];
	}
}

export interface Drift {
	english: string;
	variants: Array<{text: string; keys: string[]}>;
}

/** The English one catalog translates more than one way (distinct keys
 * included: whether the difference is wanted is the reader's call). */
export function driftReport(pot: PoEntry[], po: PoEntry[]): Drift[] {
	const potByKey = new Map(pot.map((entry) => [entry.msgctxt, entry]));
	const groups = new Map<string, Map<string, string[]>>();

	for (const entry of po) {
		const potEntry = potByKey.get(entry.msgctxt);

		if (
			!entry.msgctxt ||
			!potEntry ||
			sourceOf(potEntry) !== sourceOf(entry) ||
			!translated(entry)
		) {
			continue;
		}

		const variants = groups.get(sourceOf(entry)) ?? new Map<string, string[]>();
		variants.set(textOf(entry), [...(variants.get(textOf(entry)) ?? []), entry.msgctxt]);
		groups.set(sourceOf(entry), variants);
	}

	const drifts: Drift[] = [];

	for (const [source, variants] of groups) {
		if (variants.size > 1) {
			drifts.push({
				english: source.split("\u0000").join(" | "),
				variants: [...variants].map(([text, keys]) => ({
					text: text.split("\u0000").join(" | "),
					keys: keys.sort(),
				})),
			});
		}
	}

	return drifts.sort((a, b) => (a.english < b.english ? -1 : a.english > b.english ? 1 : 0));
}

export interface NewKeyFinding {
	key: string;
	english: string;
	/** "duplicate": another key has this exact English; "near": the same
	 * English but for case or a trailing period, colon or ellipsis. */
	kind: "duplicate" | "near";
	/** The other keys to reuse, `common.*` first. */
	others: string[];
	/** Keys with the same English that are marked distinct: they keep a
	 * translation of their own, so they are context, not a key to reuse. */
	distinct: string[];
}

/** Keys in `head` that are new since `base`, or whose English changed. */
export function changedKeys(base: PoEntry[], head: PoEntry[]): PoEntry[] {
	const before = new Map(base.map((entry) => [entry.msgctxt, sourceOf(entry)]));
	return head.filter((entry) => entry.msgctxt && before.get(entry.msgctxt) !== sourceOf(entry));
}

const commonFirst = (a: string, b: string) => {
	const ca = a.startsWith(COMMON_PREFIX);
	const cb = b.startsWith(COMMON_PREFIX);
	return ca !== cb ? (ca ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0;
};

/**
 * The new or reworded keys whose English is already in the pot under
 * another key. Exact matches win over near ones; an entry marked distinct
 * is not reported. Every other key in `head` counts, the new ones too, so
 * two new keys with one English are reported both ways.
 */
export function newKeyFindings(base: PoEntry[], head: PoEntry[]): NewKeyFinding[] {
	const marked = new Set(
		head.filter((entry) => entry.flags.includes(DISTINCT_FLAG)).map((entry) => entry.msgctxt)
	);
	const split = (keys: string[]) => ({
		others: keys.filter((key) => !marked.has(key)).sort(commonFirst),
		distinct: keys.filter((key) => marked.has(key)).sort(commonFirst),
	});
	const exact = new Map<string, string[]>();
	const near = new Map<string, string[]>();

	for (const entry of head) {
		if (!entry.msgctxt || (!entry.msgid && entry.msgidPlural === undefined)) {
			continue;
		}

		exact.set(sourceOf(entry), [...(exact.get(sourceOf(entry)) ?? []), entry.msgctxt]);
		near.set(foldedSourceOf(entry), [
			...(near.get(foldedSourceOf(entry)) ?? []),
			entry.msgctxt,
		]);
	}

	const findings: NewKeyFinding[] = [];

	for (const entry of changedKeys(base, head)) {
		if (
			entry.flags.includes(DISTINCT_FLAG) ||
			(!entry.msgid && entry.msgidPlural === undefined)
		) {
			continue;
		}

		const english =
			entry.msgidPlural === undefined ? entry.msgid : `${entry.msgid} | ${entry.msgidPlural}`;
		const same = (exact.get(sourceOf(entry)) ?? []).filter((key) => key !== entry.msgctxt);

		if (same.length > 0) {
			findings.push({key: entry.msgctxt, english, kind: "duplicate", ...split(same)});
			continue;
		}

		const close = (near.get(foldedSourceOf(entry)) ?? []).filter(
			(key) => key !== entry.msgctxt
		);

		if (close.length > 0) {
			findings.push({key: entry.msgctxt, english, kind: "near", ...split(close)});
		}
	}

	return findings;
}

/**
 * The 1-based line where `key`'s msgctxt starts in a po/pot text, for an
 * annotation; 0 when it is not found (the caller then names no line). A
 * msgctxt continued over several string lines and CRLF line ends count.
 */
export function lineOfKey(text: string, key: string): number {
	const lines = text.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const match = /^msgctxt\s+"(.*)"\s*$/.exec(lines[i]);

		if (!match) {
			continue;
		}

		let value = unquote(match[1]);

		for (let j = i + 1; j < lines.length; j++) {
			const more = /^\s*"(.*)"\s*$/.exec(lines[j]);

			if (!more) {
				break;
			}

			value += unquote(more[1]);
		}

		if (value === key) {
			return i + 1;
		}
	}

	return 0;
}

/** GitHub's workflow-command escaping for a message and a property value. */
function escapeData(text: string): string {
	return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text: string): string {
	return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function describeFinding(finding: NewKeyFinding, entries: PoEntry[]): string {
	const english = JSON.stringify(finding.english);
	const named = (keys: string[]) => {
		const shown = keys.slice(0, 5);
		const more = keys.length - shown.length;
		const texts =
			finding.kind === "near"
				? ` (${[
						...new Set(
							shown.map((key) =>
								JSON.stringify(entries.find((e) => e.msgctxt === key)?.msgid ?? "")
							)
						),
				  ].join(", ")})`
				: "";
		return shown.join(", ") + (more > 0 ? ` and ${more} more` : "") + texts;
	};
	const verb = finding.kind === "duplicate" ? "is already" : "nearly matches";
	const mark = `mark this entry "#, ${DISTINCT_FLAG}" (add.ts --distinct)`;

	if (finding.others.length === 0) {
		return (
			`${finding.key}: ${english} ${verb} ${named(finding.distinct)}, marked distinct ` +
			`(translated on its own). If this key needs its own translation too, ${mark}.`
		);
	}

	const aside =
		finding.distinct.length > 0
			? ` (${finding.distinct.join(", ")} also match${
					finding.distinct.length === 1 ? "es" : ""
			  } but ${finding.distinct.length === 1 ? "is" : "are"} marked distinct)`
			: "";
	return (
		`${finding.key}: ${english} ${verb} ${named(finding.others)}${aside}. ` +
		`Reuse one of those keys, or ${mark} if it needs its own translation.`
	);
}

function readTags(only: string[] | null): string[] {
	const names = readFileSync(TARGETS_SOURCE, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	return names
		.map((name) => NAME_TO_TAG[name])
		.filter((tag) => tag && tag !== "en" && (!only || only.includes(tag)))
		.filter((tag) => existsSync(resolve(LOCALES_DIR, `${tag}.po`)));
}

/** The pot at `ref`: its text, "" when the revision exists but has no
 * pot yet (every key is new then), null when the revision cannot be read. */
function potAt(ref: string, path: string): string | null {
	const git = (args: string[]) =>
		execFileSync("git", args, {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});

	try {
		git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	} catch {
		return null;
	}

	try {
		return git(["show", `${ref}:${relative(process.cwd(), path)}`]);
	} catch {
		return "";
	}
}

/** Annotations a step may show; the job summary lists the rest. */
const ANNOTATION_LIMIT = 10;

function main(): void {
	const args = process.argv.slice(2);
	const valueOf = (flag: string) =>
		args.includes(flag) ? args[args.indexOf(flag) + 1] ?? null : null;
	const only =
		valueOf("--tags")
			?.split(",")
			.map((s) => s.trim()) ?? null;
	const potText = readFileSync(POT_PATH, "utf8");
	const pot = parsePo(potText).entries.filter((entry) => entry.msgctxt);

	if (args.includes("--new-keys")) {
		const ref = valueOf("--new-keys");

		if (!ref) {
			console.error("usage: npx tsx tools/i18n/reuse.ts --new-keys <git-ref>");
			process.exit(2);
		}

		const baseText = potAt(ref, POT_PATH);

		if (baseText === null) {
			console.error(`reuse: cannot read revision ${ref}; the check did not run`);
			process.exit(2);
		}

		const base = parsePo(baseText).entries;
		const findings = newKeyFindings(base, pot);
		const file = relative(process.cwd(), POT_PATH);
		const actions = process.env.GITHUB_ACTIONS === "true";

		findings.forEach((finding, index) => {
			const message = describeFinding(finding, pot);
			const line = lineOfKey(potText, finding.key);

			if (!actions) {
				console.log(`${file}${line ? `:${line}` : ""}: ${message}`);
				return;
			}

			// GitHub shows ten warnings a step; past that they would vanish
			// silently, so the rest go to the log and the job summary.
			if (index >= ANNOTATION_LIMIT) {
				console.log(`${file}${line ? `:${line}` : ""}: ${message}`);
				return;
			}

			const title =
				finding.kind === "duplicate" ? "Duplicate English" : "Near-duplicate English";
			const where = `file=${escapeProperty(file)}${line ? `,line=${line}` : ""}`;
			console.log(
				`::warning ${where},title=${escapeProperty(title)}::${escapeData(message)}`
			);
		});

		if (actions && findings.length > ANNOTATION_LIMIT) {
			console.log(
				`::notice title=More repeated English::${
					findings.length - ANNOTATION_LIMIT
				} more ` + "findings are in the job summary and this step's log."
			);
		}

		const summary = process.env.GITHUB_STEP_SUMMARY;

		if (summary && findings.length > 0) {
			const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
			const code = (keys: string[]) => keys.map((key) => "`" + key + "`").join(", ");
			const rows = findings.map((f) => {
				const match = f.kind === "duplicate" ? "same" : "near";
				const distinct = f.distinct.length > 0 ? ` (distinct: ${code(f.distinct)})` : "";
				return `| \`${f.key}\` | ${cell(f.english)} | ${match} | ${code(
					f.others
				)}${distinct} |`;
			});
			appendFileSync(
				summary,
				[
					`### ${findings.length} new translation keys repeat existing English`,
					"",
					`Reuse one of the existing keys, or mark the new entry \`#, ${DISTINCT_FLAG}\` ` +
						"(`add.ts --distinct`) when it needs its own translation.",
					"",
					"| New key | English | Match | Keys to reuse |",
					"| --- | --- | --- | --- |",
					...rows,
					"",
				].join("\n")
			);
		}

		console.log(
			`reuse: ${changedKeys(base, pot).length} new or reworded keys since ${ref}, ` +
				`${findings.length} repeat English the pot already has`
		);
		return;
	}

	const drift = args.includes("--drift");
	const fill = args.includes("--fill");

	if (!drift && !fill) {
		console.error(
			"usage: npx tsx tools/i18n/reuse.ts --fill [--tags de,fr] [--dry] | --drift [--tags de,fr] | --new-keys <git-ref>"
		);
		process.exit(2);
	}

	const dry = args.includes("--dry");
	let filled = 0;

	for (const tag of readTags(only)) {
		const path = resolve(LOCALES_DIR, `${tag}.po`);
		const po = parsePo(readFileSync(path, "utf8"));

		if (drift) {
			for (const {english, variants} of driftReport(pot, po.entries)) {
				console.log(`${tag} ${JSON.stringify(english)}`);

				for (const {text, keys} of variants) {
					console.log(`    ${JSON.stringify(text)}  ${keys.join(" ")}`);
				}
			}

			continue;
		}

		const rule = PLURAL_RULES[tag] ?? parsePluralForms(po.headers["plural-forms"] ?? "");

		if (!rule) {
			console.warn(`reuse: no plural rule for ${tag}, skipped`);
			continue;
		}

		const plan = planReuse(pot, po.entries, tag, rule);

		for (const {key, from, msgstr} of plan.fills) {
			console.log(
				`${tag} ${key} <- ${from.join(" ")}: ${JSON.stringify(msgstr.join(" | "))}`
			);
		}

		for (const {key, texts} of plan.ambiguous) {
			console.log(
				`${tag} ${key} left empty, translated ${texts.length} ways: ${texts
					.map((t) => JSON.stringify(t))
					.join(", ")}`
			);
		}

		if (plan.fills.length > 0 && !dry) {
			applyReuse(po.entries, plan);
			writeFileSync(path, serializePo(po.headers, po.entries, po.headerOrder));
		}

		filled += plan.fills.length;
	}

	if (fill) {
		console.log(`reuse: ${filled} slots filled${dry ? " (--dry: nothing written)" : ""}`);
	}
}

// Importing this module must not touch the catalogs (the toolchain test
// imports it).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
