/* eslint-disable no-console */
// Empty every filled entry whose {placeholder} braces no longer match its
// msgid (or msgid_plural, for plural entries) — the dynamic-tag casualties
// the model fill produces. The compile refuses a whole catalog for one
// mismatch, so this runs before every compile while the fills are landing.
//
//   npx tsx tools/i18n/sweep.ts [--tags de,fr,...] [--dry] [--plurals]

import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {parsePo, PoEntry, serializePo} from "./po";
import {NAME_TO_TAG, TARGETS_SOURCE} from "./targets";
import {
	countsReadingSlot,
	PLURAL_RULES,
	parsePluralForms,
	planPluralSlots,
	PluralRule,
} from "./plural";
import {slotVerdict, SlotVerdict} from "./quality";

export type SweepReason = SlotVerdict | "empty-source";

/** What the sweep emptied, and why. */
export interface SweepReport {
	key: string;
	reason: SweepReason;
}

/**
 * Empty every filled msgstr slot the fill cannot be trusted to have got
 * right: one whose {placeholder} braces no longer match the English text
 * THAT slot translates, and one `isSuspectCatalogEntry` judges degenerate,
 * runaway-long or written in the wrong script.
 *
 * Which English text a slot translates comes from planPluralSlots, the same
 * plan fill.ts fills by: the slot n = 1 reads holds the singular, every
 * other slot the plural -- and a one-form language's only slot holds the
 * plural too. Checking slot 0 against msgid regardless emptied every
 * one-form plural whose singular has no {count}, which the next fill wrote
 * back: a silent fill/sweep loop. Slots are judged one by one for the same
 * reason, so a sound singular is not thrown away with a bad plural.
 *
 * Returns what was emptied; the entries are mutated in place.
 */
export function sweepEntries(
	entries: PoEntry[],
	rule: PluralRule,
	tag: string
): {emptied: number; reports: SweepReport[]} {
	let emptied = 0;
	const reports: SweepReport[] = [];

	const empty = (entry: PoEntry, index: number, reason: SweepReason) => {
		entry.msgstr[index] = "";
		emptied += 1;
		reports.push({key: entry.msgctxt ?? entry.msgid, reason});
	};

	for (const entry of entries) {
		if (!entry.msgstr.some((text) => text)) {
			continue;
		}

		// An empty msgid is a deliberately blank slot (the deploy fills it);
		// a model asked to translate "" only invents text.
		if (!entry.msgid && !entry.msgidPlural) {
			empty(entry, 0, "empty-source");
			continue;
		}

		const slots =
			entry.msgidPlural === undefined
				? [{index: 0, english: entry.msgid}]
				: planPluralSlots(entry, rule.nplurals, rule.expr, tag).map(({index, source}) => ({
						index,
						english: source === "msgid" ? entry.msgid : (entry.msgidPlural as string),
				  }));

		// A plural form can be the English word again ("{count} Byte" in
		// German, "{count} G-line" anywhere) while its sibling is plainly
		// translated; the entry as a whole is no echo then, and emptying
		// that one slot would send the whole key back to English.
		const translatedSibling = (index: number) =>
			slots.some(
				(other) =>
					other.index !== index &&
					entry.msgstr[other.index] &&
					!slotVerdict(tag, other.english, entry.msgstr[other.index])
			);

		for (const {index, english} of slots) {
			const text = entry.msgstr[index];

			if (!text) {
				continue;
			}

			const reason = slotVerdict(tag, english, text);

			if (
				reason === "unchanged" &&
				entry.msgidPlural !== undefined &&
				translatedSibling(index)
			) {
				continue;
			}

			if (reason) {
				empty(entry, index, reason);
			}
		}
	}

	return {emptied, reports};
}

/**
 * Plural entries whose forms for different counts are one and the same text,
 * in a language with three or more forms: the review list for a slot filled
 * from the one English plural where the grammar wants another word form (ru
 * "2 пользователей" for "пользователя", "5 непрочитанные сообщения"). Not an
 * error -- a label frame ("непрочитанных: {count}") is the same for every
 * count on purpose -- so the sweep reports these and empties nothing. Each
 * hit names the slots and a count each one serves.
 */
export function pluralEchoes(
	entries: PoEntry[],
	rule: PluralRule,
	tag: string
): Array<{key: string; slots: number[]; counts: number[]}> {
	if (rule.nplurals < 3) {
		return [];
	}

	const hits: Array<{key: string; slots: number[]; counts: number[]}> = [];

	for (const entry of entries) {
		if (entry.msgidPlural === undefined || entry.flags.includes("fuzzy")) {
			continue;
		}

		const byText = new Map<string, number[]>();

		for (let index = 0; index < rule.nplurals; index++) {
			const text = entry.msgstr[index];

			if (text && countsReadingSlot(tag, rule.expr, index).length > 0) {
				byText.set(text, [...(byText.get(text) ?? []), index]);
			}
		}

		for (const slots of byText.values()) {
			if (slots.length > 1) {
				hits.push({
					key: entry.msgctxt ?? entry.msgid,
					slots,
					counts: slots.map((index) => countsReadingSlot(tag, rule.expr, index)[0]),
				});
			}
		}
	}

	return hits;
}

function main(): void {
	const args = process.argv.slice(2);
	const dry = args.includes("--dry");
	// --plurals: list (never empty) the plural entries whose forms for
	// different counts are the same text, for a reviewer to check.
	const plurals = args.includes("--plurals");
	const only = args.includes("--tags")
		? args[args.indexOf("--tags") + 1]?.split(",").map((s) => s.trim())
		: null;

	const names = readFileSync(TARGETS_SOURCE, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	const tags = names
		.map((name) => NAME_TO_TAG[name])
		.filter((tag) => tag && tag !== "en" && (!only || only.includes(tag)));

	let swept = 0;

	for (const tag of tags) {
		const path = resolve("client/locales", `${tag}.po`);

		if (!existsSync(path)) {
			continue;
		}

		const po = parsePo(readFileSync(path, "utf8"));
		const rule = PLURAL_RULES[tag] ?? parsePluralForms(po.headers["plural-forms"] ?? "");

		if (!rule) {
			console.warn(`sweep: no plural rule for ${tag} — skipped`);
			continue;
		}

		if (plurals) {
			for (const {key, slots, counts} of pluralEchoes(po.entries, rule, tag)) {
				console.log(
					`${tag} ${key}: forms ${slots.join("/")} (counts ${counts.join(
						", "
					)}) are one text`
				);
			}

			continue;
		}

		const {emptied, reports} = sweepEntries(po.entries, rule, tag);

		if (emptied) {
			for (const {key, reason} of reports) {
				console.log(`${tag} ${key} ${reason}`);
			}

			if (!dry) {
				writeFileSync(path, serializePo(po.headers, po.entries, po.headerOrder));
			}

			console.log(`${tag}: emptied ${emptied} slots`);
			swept += emptied;
		}
	}

	console.log(`sweep: ${swept} slots emptied overall${dry ? " (--dry: nothing written)" : ""}`);
}

// Importing this module must not sweep the real catalogs (the toolchain
// test imports sweepEntries).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
