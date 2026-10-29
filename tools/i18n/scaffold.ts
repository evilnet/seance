/* eslint-disable no-console */
// Scaffold client/locales/<tag>.po for every language in
// translation-languages.txt that does not have one yet (Step 2 of the
// localization/translation phase). Each new file carries the full entry set
// of messages.pot with empty msgstr, the standard headers, and the
// language's Plural-Forms from plural-rules.json (the same table compile.ts
// and merge.ts read). Existing .po files are never touched.
//
//   npx tsx tools/i18n/scaffold.ts [--force]
//
// After scaffolding, run `yarn i18n:merge` so the new files are marked for
// translators (entries without a msgstr would compile as the English copy
// anyway), then fill them (tools/i18n/fill.ts).
//
// The per-tag writer is exported: tools/i18n/sync.ts reuses it to track the
// language list during the build, so importing this module must stay
// side-effect-free — the CLI body runs only under the import.meta guard.

import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {parsePo, serializePo} from "./po";
import {PLURAL_RULES, formatPluralForms} from "./plural";
import {NAME_TO_TAG, TARGETS_SOURCE} from "./targets";

const LOCALES = resolve("client/locales");

/** Write <localesDir>/<tag>.po from <localesDir>/messages.pot — only when
 * the file is absent (force overwrites). Returns whether it wrote; the
 * callers own the log lines. */
export function scaffoldTag(tag: string, localesDir: string, force = false): boolean {
	const out = resolve(localesDir, `${tag}.po`);

	if (!force && existsSync(out)) {
		return false;
	}

	const pot = parsePo(readFileSync(resolve(localesDir, "messages.pot"), "utf8"));
	const rule = PLURAL_RULES[tag];
	// po.ts's serializer reads header values by lowercase key and emits
	// the canonical spellings itself.
	const headers: Record<string, string> = {
		language: tag,
		"mime-version": "1.0",
		"content-type": "text/plain; charset=UTF-8",
		"content-transfer-encoding": "8bit",
		...(rule ? {"plural-forms": formatPluralForms(rule)} : {}),
	};

	// One empty slot per gettext form: a two-slot plural in a three-form
	// language has no slot for the third and the compile drops the key.
	const nplurals = rule?.nplurals ?? 2;
	const entries = pot.entries.map((entry) => ({
		...entry,
		msgstr: entry.msgidPlural ? Array.from({length: nplurals}, () => "") : [""],
	}));

	writeFileSync(out, serializePo(headers, entries));

	return true;
}

function main(): void {
	const force = process.argv.includes("--force");
	const names = readFileSync(TARGETS_SOURCE, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));

	// Parsed up front (as before) both for the entry count in the log line
	// and so a malformed pot fails the run even when nothing needs writing.
	const pot = parsePo(readFileSync(resolve(LOCALES, "messages.pot"), "utf8"));
	let created = 0;
	let skipped = 0;

	for (const name of names) {
		const tag = NAME_TO_TAG[name];

		if (!tag) {
			console.warn(`scaffold: no tag for "${name}" — skipped (add it to NAME_TO_TAG)`);
			continue;
		}

		// English is compiled from the pot itself — a hand-written en.po is
		// refused by the compile.
		if (tag === "en") {
			continue;
		}

		if (scaffoldTag(tag, LOCALES, force)) {
			console.log(`scaffold: ${tag}.po (${pot.entries.length} entries)`);
			created += 1;
		} else {
			skipped += 1;
		}
	}

	console.log(`scaffold: ${created} created, ${skipped} already present`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
