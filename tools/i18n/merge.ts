/* eslint-disable no-console */
// npx tsx tools/i18n/merge.ts [tag...]
//
// msgmerge-lite: syncs client/locales/<tag>.po (default: every .po next to
// the pot) against client/locales/messages.pot. Entries are keyed by
// msgctxt: a translation survives an exact msgid match, a drifted msgid is
// re-adopted from the pot and the entry is marked `#, fuzzy` for review
// (an existing fuzzy mark survives an exact match — unfuzzying is the
// translator's call), keys new to the po are appended with empty msgstr
// slots, and keys the pot no longer carries are dropped. The Language and
// Plural-Forms headers are rewritten from plural-rules.json. Never invents
// translations.

import {existsSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {parsePo, PoEntry, serializePo} from "./po";
import {LOCALES_DIR, POT_PATH} from "./paths";
import {formatPluralForms, PLURAL_RULES, PluralRule} from "./plural";

export interface MergeOptions {
	potPath: string;
	poPath: string;
	tag: string;
}

export interface MergeOutcome {
	text: string;
	/** Keys appended from the pot with empty translations. */
	added: string[];
	/** Keys whose msgid drifted: translation kept, #, fuzzy set. */
	fuzzied: string[];
	/** Keys the po carried that the pot no longer has. */
	dropped: string[];
}

/** Empty msgstr slots: none for singular entries, nplurals for plurals. */
function emptyMsgstr(rule: PluralRule, plural: boolean): string[] {
	return Array.from({length: plural ? rule.nplurals : 0}, () => "");
}

export function mergePo(options: MergeOptions): MergeOutcome {
	const pot = parsePo(readFileSync(options.potPath, "utf8"));
	const po = parsePo(readFileSync(options.poPath, "utf8"));
	const rule = PLURAL_RULES[options.tag];

	if (!rule) {
		throw new Error(
			`merge: no plural rule for ${options.tag} — add it to tools/i18n/plural-rules.json`
		);
	}

	const byKey = new Map<string, PoEntry>();

	for (const entry of po.entries) {
		if (entry.msgctxt) {
			byKey.set(entry.msgctxt, entry);
		}
	}

	const added: string[] = [];
	const fuzzied: string[] = [];
	const dropped: string[] = [];
	const entries: PoEntry[] = [];

	// The pot is the source of truth, so its entries — with their loc and
	// context comments — are the frame; the po only contributes translations.
	for (const potEntry of pot.entries) {
		if (!potEntry.msgctxt) {
			continue;
		}

		const key = potEntry.msgctxt;
		const existing = byKey.get(key);
		byKey.delete(key);

		if (!existing) {
			entries.push({
				...potEntry,
				msgstr: emptyMsgstr(rule, potEntry.msgidPlural !== undefined),
			});
			added.push(key);
			continue;
		}

		const drifted =
			existing.msgid !== potEntry.msgid || existing.msgidPlural !== potEntry.msgidPlural;
		entries.push({
			...potEntry,
			// The pot owns the "#." context and the "#:" locations; a
			// translator's own "# " notes and the "#|" previous lines belong
			// to the catalog and a merge must not spread them away.
			translatorComments: existing.translatorComments,
			previous: existing.previous,
			msgstr: existing.msgstr,
			// The drift mark joins the flags the entry already carries
			// (c-format, no-wrap, …) instead of replacing them; a second
			// drift on an already-fuzzy entry adds nothing.
			flags: drifted ? [...new Set([...existing.flags, "fuzzy"])] : existing.flags,
		});

		if (drifted) {
			fuzzied.push(key);
		}
	}

	for (const key of byKey.keys()) {
		dropped.push(key);
	}

	const headers: Record<string, string> = {...po.headers};
	headers.language = options.tag;
	headers["plural-forms"] = formatPluralForms(rule);

	return {text: serializePo(headers, entries, po.headerOrder), added, fuzzied, dropped};
}

function main(): void {
	const args = process.argv.slice(2);
	const tags =
		args.length > 0
			? args
			: readdirSync(LOCALES_DIR)
					.filter((file) => file.endsWith(".po"))
					.map((file) => file.slice(0, -".po".length))
					.sort();

	for (const tag of tags) {
		const poPath = resolve(LOCALES_DIR, `${tag}.po`);

		if (!existsSync(poPath)) {
			console.error(
				`merge: client/locales/${tag}.po does not exist — copy messages.pot there first`
			);
			process.exitCode = 1;
			continue;
		}

		const outcome = mergePo({potPath: POT_PATH, poPath, tag});
		writeFileSync(poPath, outcome.text);
		console.log(
			`merge: ${tag}.po — ${outcome.added.length} added, ` +
				`${outcome.fuzzied.length} fuzzy, ${outcome.dropped.length} dropped`
		);

		for (const key of outcome.added) {
			console.log(`  + ${key}`);
		}

		for (const key of outcome.fuzzied) {
			console.log(`  ~ ${key}`);
		}

		for (const key of outcome.dropped) {
			console.log(`  - ${key}`);
		}
	}
}

if (require.main === module) {
	main();
}
