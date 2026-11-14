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
import {parsePo, PoEntry, serializePo} from "./po";
import {LOCALES_DIR, POT_PATH} from "./paths";
import {slotVerdict} from "./quality";
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
 * The English folded for a near match: case, surrounding space, and one
 * trailing period, colon or ellipsis ("Edit…", "Saved.", "Nick:") do not
 * make a new phrase. A question mark or an exclamation does, and so does
 * anything inside the string.
 */
export function foldEnglish(text: string): string {
	return text
		.normalize("NFC")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/(?:\.\.\.|…|[.:])$/u, "")
		.trim()
		.toLocaleLowerCase("en");
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
 * A singular copy must also pass the sweep's verdict for its own English,
 * so the fill never writes what sweep.ts would empty.
 */
export function planReuse(pot: PoEntry[], po: PoEntry[], tag: string): ReusePlan {
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
			!translated(entry)
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

		if (msgstr.length !== entry.msgstr.length) {
			continue; // a plural shaped for another rule; merge.ts reshapes it
		}

		if (potEntry.msgidPlural === undefined && slotVerdict(tag, potEntry.msgid, msgstr[0])) {
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
	/** The other keys, `common.*` first. */
	others: string[];
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
			findings.push({
				key: entry.msgctxt,
				english,
				kind: "duplicate",
				others: same.sort(commonFirst),
			});
			continue;
		}

		const close = (near.get(foldedSourceOf(entry)) ?? []).filter(
			(key) => key !== entry.msgctxt
		);

		if (close.length > 0) {
			findings.push({
				key: entry.msgctxt,
				english,
				kind: "near",
				others: close.sort(commonFirst),
			});
		}
	}

	return findings;
}

/** The 1-based line of `msgctxt "<key>"` in a po/pot text, for annotations. */
export function lineOfKey(text: string, key: string): number {
	const needle = `msgctxt ${JSON.stringify(key)}`;
	const index = text.split("\n").findIndex((line) => line === needle);
	return index + 1;
}

/** GitHub's workflow-command escaping for a message and a property value. */
function escapeData(text: string): string {
	return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(text: string): string {
	return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

export function describeFinding(finding: NewKeyFinding, others: PoEntry[]): string {
	const shown = finding.others.slice(0, 5);
	const more = finding.others.length - shown.length;
	const list = shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
	const english = JSON.stringify(finding.english);
	const theirs =
		finding.kind === "near"
			? ` (${[
					...new Set(
						shown.map((key) =>
							JSON.stringify(others.find((e) => e.msgctxt === key)?.msgid ?? "")
						)
					),
			  ].join(", ")})`
			: "";
	const verb = finding.kind === "duplicate" ? "is already" : "nearly matches";
	return (
		`${finding.key}: ${english} ${verb} ${list}${theirs}. Reuse one of those keys, ` +
		`or mark this entry "#, ${DISTINCT_FLAG}" (add.ts --distinct) if it needs its own translation.`
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

function gitShow(ref: string, path: string): string | null {
	try {
		return execFileSync("git", ["show", `${ref}:${relative(process.cwd(), path)}`], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

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

		const baseText = gitShow(ref, POT_PATH);

		if (baseText === null) {
			console.error(`reuse: cannot read ${relative(process.cwd(), POT_PATH)} at ${ref}`);
			process.exit(2);
		}

		const findings = newKeyFindings(parsePo(baseText).entries, pot);
		const file = relative(process.cwd(), POT_PATH);
		const actions = process.env.GITHUB_ACTIONS === "true";

		for (const finding of findings) {
			const message = describeFinding(finding, pot);
			const line = lineOfKey(potText, finding.key);

			if (actions) {
				const title =
					finding.kind === "duplicate" ? "Duplicate English" : "Near-duplicate English";
				console.log(
					`::warning file=${escapeProperty(file)},line=${line},title=${escapeProperty(
						title
					)}::${escapeData(message)}`
				);
			} else {
				console.log(`${file}:${line}: ${message}`);
			}
		}

		// Actions shows only the first ten warnings of a step on the run and
		// the diff; the job summary carries every one.
		const summary = process.env.GITHUB_STEP_SUMMARY;

		if (summary && findings.length > 0) {
			const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
			const rows = findings.map((f) => {
				const others = f.others.map((key) => "`" + key + "`").join(", ");
				const match = f.kind === "duplicate" ? "same" : "near";
				return `| \`${f.key}\` | ${cell(f.english)} | ${match} | ${others} |`;
			});
			appendFileSync(
				summary,
				[
					"### New translation keys that repeat existing English",
					"",
					`Reuse one of the existing keys, or mark the new entry \`#, ${DISTINCT_FLAG}\` ` +
						"(`add.ts --distinct`) when it needs its own translation.",
					"",
					"| New key | English | Match | Existing keys |",
					"| --- | --- | --- | --- |",
					...rows,
					"",
				].join("\n")
			);
		}

		console.log(
			`reuse: ${
				changedKeys(parsePo(baseText).entries, pot).length
			} new or reworded keys since ${ref}, ` +
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

		const plan = planReuse(pot, po.entries, tag);

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
