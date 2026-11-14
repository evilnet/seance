/* eslint-disable no-console */
// The words each catalog uses for the interface's recurring terms
// (channel, nick, server, notice, …), and a check that the catalog keeps to
// them.
//
//   npx tsx tools/i18n/terms.ts [--tags de,fr] [--verbose]
//
// tools/i18n/terms/index.json names the terms: their English forms and a
// note on what they mean here. tools/i18n/terms/<tag>.json gives one
// catalog's word for each: `term` (what the machine translation prompt is
// told, fill.ts), `match` (the stems the check accepts, lowercase
// substrings; `term` alone when absent) and `avoid` (stems that are wrong
// for this term in this language).
//
// The check reads every translated entry whose English mentions a term and
// reports:
//   avoid      the translation has a stem the term file says to avoid
//   missing    it has none of the term's stems: another word, a paraphrase,
//              or an inflection `match` does not list yet
//   collision  two terms of one catalog share a stem (a server NOTICE and a
//              push notification under one word), whatever the entries say
// It never fails: a missing term is often right (a pronoun, a rephrased
// sentence); the list is for a person, and for the next machine pass.

import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {parsePo, PoEntry} from "./po";
import {LOCALES_DIR, POT_PATH} from "./paths";
import {NAME_TO_TAG, TARGETS_SOURCE} from "./targets";

/** Run from the repository root, like every script here (paths.ts). */
export const TERMS_DIR = resolve("tools/i18n/terms");

/** One term, in English (terms/index.json). */
export interface TermSource {
	/** The English forms, lowercase, matched as whole words. */
	en: string[];
	/** What the term means in this interface, for translators. */
	note?: string;
	/** English phrases where the word means something else ("going away",
	 * "private message"); taken out before matching. */
	except?: string[];
}

/** One catalog's word for a term (terms/<tag>.json). */
export interface TermTarget {
	/** The word to use, as the machine translation prompt is given it. */
	term: string;
	/** Lowercase stems that count as using it; `[term]` when absent. */
	match?: string[];
	/** Lowercase stems that are wrong for this term in this language. */
	avoid?: string[];
	note?: string;
}

export type TermIndex = Record<string, TermSource>;
export type LocaleTerms = Record<string, TermTarget>;

export interface TermFinding {
	key: string;
	term: string;
	kind: "avoid" | "missing";
	english: string;
	translation: string;
	/** The avoided stem found, for kind "avoid". */
	found?: string;
}

export interface TermCollision {
	terms: [string, string];
	stem: string;
}

export function loadTermIndex(dir = TERMS_DIR): TermIndex {
	return JSON.parse(readFileSync(resolve(dir, "index.json"), "utf8")) as TermIndex;
}

/** A catalog's term file, or an empty one when it has none. */
export function loadLocaleTerms(tag: string, dir = TERMS_DIR): LocaleTerms {
	const path = resolve(dir, `${tag}.json`);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as LocaleTerms) : {};
}

function stemsOf(target: TermTarget): string[] {
	return (target.match ?? [target.term]).map((s) => s.toLowerCase());
}

/**
 * The English with what no translator renders as a word taken out:
 * `{placeholders}`, `<syntax>`, `/commands`, `code`, `#channel` names and
 * `user@host` masks.
 */
export function proseOf(english: string): string {
	return english
		.replace(/\S*@\S*/g, " ")
		.replace(/(^|\s)#\S*/g, " ")
		.replace(/\{[^}]*\}/g, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/(^|\s)\/\w+/g, " ");
}

/**
 * The terms the English mentions. An all-capitals occurrence is a protocol
 * token (OPER, NOTICE, BAN), left as it is in every language, so it does
 * not count.
 */
export function termsIn(english: string, index: TermIndex): string[] {
	const prose = proseOf(english);
	const found: string[] = [];

	for (const [id, source] of Object.entries(index)) {
		let text = prose;

		for (const phrase of source.except ?? []) {
			text = text.replace(
				new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
				" "
			);
		}

		const forms = source.en.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		const re = new RegExp(
			`(?<![\\p{L}\\p{N}_-])(?:${forms.join("|")})(?![\\p{L}\\p{N}_-])`,
			"giu"
		);

		for (const m of text.matchAll(re)) {
			if (m[0] !== m[0].toUpperCase() || m[0].length === 1) {
				found.push(id);
				break;
			}
		}
	}

	return found;
}

/** The pairs the machine translation prompt is given for these lines. */
export function promptTerms(
	lines: string[],
	index: TermIndex,
	locale: LocaleTerms
): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	const seen = new Set<string>();

	for (const line of lines) {
		for (const id of termsIn(line, index)) {
			const target = locale[id];

			if (!target || seen.has(id)) {
				continue;
			}

			seen.add(id);
			out.push([index[id].en[0], target.term]);
		}
	}

	return out;
}

/**
 * Two terms that share a stem: one word for two things. Only an equal stem
 * counts; one stem inside another is how languages build words
 * (Nachricht, Benachrichtigung).
 */
export function termCollisions(locale: LocaleTerms): TermCollision[] {
	const ids = Object.keys(locale).sort();
	const out: TermCollision[] = [];

	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) {
			const a = stemsOf(locale[ids[i]]);
			const b = stemsOf(locale[ids[j]]);
			const stem = a.find((x) => b.includes(x));

			if (stem !== undefined) {
				out.push({terms: [ids[i], ids[j]], stem});
			}
		}
	}

	return out;
}

/** Every translated, non-fuzzy entry checked against the catalog's terms. */
export function termFindings(
	pot: PoEntry[],
	po: PoEntry[],
	index: TermIndex,
	locale: LocaleTerms
): TermFinding[] {
	const english = new Map(pot.map((e) => [e.msgctxt, e]));
	const out: TermFinding[] = [];

	for (const entry of po) {
		const source = english.get(entry.msgctxt);

		if (!source || !entry.msgctxt || entry.flags.includes("fuzzy")) {
			continue;
		}

		const slots = entry.msgstr.filter((s) => s !== "");

		if (slots.length === 0) {
			continue;
		}

		const text = [source.msgid, source.msgidPlural ?? ""].join("\n");

		for (const id of termsIn(text, index)) {
			const target = locale[id];

			if (!target) {
				continue;
			}

			for (const slot of slots) {
				const lower = slot.toLowerCase();
				const found = (target.avoid ?? []).find((s) => lower.includes(s.toLowerCase()));

				if (found !== undefined) {
					out.push({
						key: entry.msgctxt,
						term: id,
						kind: "avoid",
						english: source.msgid,
						translation: slot,
						found,
					});
					break;
				}

				if (!stemsOf(target).some((s) => lower.includes(s))) {
					out.push({
						key: entry.msgctxt,
						term: id,
						kind: "missing",
						english: source.msgid,
						translation: slot,
					});
					break;
				}
			}
		}
	}

	return out;
}

function readTags(only: string[] | null): string[] {
	return readFileSync(TARGETS_SOURCE, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"))
		.map((name) => NAME_TO_TAG[name])
		.filter((tag) => tag && tag !== "en" && (!only || only.includes(tag)))
		.filter((tag) => existsSync(resolve(LOCALES_DIR, `${tag}.po`)));
}

function main(argv: string[]): void {
	const tagsAt = argv.indexOf("--tags");
	const verbose = argv.includes("--verbose");
	const tags = readTags(tagsAt >= 0 ? (argv[tagsAt + 1] ?? "").split(",") : null);
	const index = loadTermIndex();
	const pot = parsePo(readFileSync(POT_PATH, "utf8")).entries;

	console.log(`${Object.keys(index).length} terms (tools/i18n/terms/index.json)`);

	for (const tag of tags) {
		const locale = loadLocaleTerms(tag);
		const po = parsePo(readFileSync(resolve(LOCALES_DIR, `${tag}.po`), "utf8")).entries;
		const findings = termFindings(pot, po, index, locale);
		const collisions = termCollisions(locale);
		const avoid = findings.filter((f) => f.kind === "avoid").length;
		const missing = findings.length - avoid;

		console.log(
			`${tag}: ${Object.keys(locale).length} terms, ${avoid} avoid, ${missing} missing, ${
				collisions.length
			} collision${collisions.length === 1 ? "" : "s"}`
		);

		for (const c of collisions) {
			console.log(`  collision: ${c.terms[0]} / ${c.terms[1]} share "${c.stem}"`);
		}

		if (verbose) {
			for (const f of findings) {
				const why = f.kind === "avoid" ? `avoid "${f.found}"` : `no ${locale[f.term].term}`;
				console.log(`  ${f.kind} ${f.term} ${f.key} (${why}): ${f.translation}`);
			}
		}
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2));
}
