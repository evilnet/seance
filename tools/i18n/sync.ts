/* eslint-disable no-console */
// Keep client/locales in step with translation-languages.txt (the language
// list): scaffold a .po for every target language that does not have one
// yet, and move .po files whose tag is no longer a target into attic/, so a
// stray catalog never reaches the compile. compile.ts runs this before it
// lists the directory, so the build itself tracks the language list — the
// attic subdirectory is invisible to compile's non-recursive listing.
//
//   npx tsx tools/i18n/sync.ts
//
// Nothing is ever deleted: an archived file is moved whole, and when attic/
// already holds a file for the tag the stray is left in place with a
// warning (the archived copy is the older one and wins). A run with
// nothing to do prints nothing.
//
// This module is imported by compile.ts, so importing it must have zero
// side effects — the CLI body runs only under the import.meta guard.

import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {join, resolve} from "node:path";
import {LOCALES_DIR} from "./paths";
import {scaffoldTag} from "./scaffold";
import {NAME_TO_TAG, TARGETS_SOURCE} from "./targets";

/** What runSync did. */
export interface SyncResult {
	/** Target tags whose .po was scaffolded this run. */
	scaffolded: string[];
	/** Tags whose .po was moved into <localesDir>/attic/ this run. */
	archived: string[];
}

/** The target tags from translation-languages.txt, in file order. English
 * is excluded — it is compiled from the pot, never a .po of its own. */
function targetTags(): string[] {
	const names = readFileSync(TARGETS_SOURCE, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));

	const tags: string[] = [];

	for (const name of names) {
		const tag = NAME_TO_TAG[name];

		if (!tag) {
			// generateTargets() fails the build for this a moment later; the
			// warning keeps the sync itself running so that error stays the
			// loud one.
			console.warn(`sync: no tag for "${name}" — skipped (add it to NAME_TO_TAG)`);
			continue;
		}

		if (tag !== "en" && !tags.includes(tag)) {
			tags.push(tag);
		}
	}

	return tags;
}

/** Bring <localesDir> in step with translation-languages.txt: scaffold the
 * targets the directory lacks, move strays into attic/. Returns the tags
 * touched, each list in the order the actions ran. */
export function runSync(localesDir: string = LOCALES_DIR): SyncResult {
	const dir = resolve(localesDir);
	const targets = new Set(targetTags());
	const result: SyncResult = {scaffolded: [], archived: []};

	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".po"))
		.sort();

	// Missing targets first: scaffoldTag writes only when the file is
	// absent, so whatever the directory already holds is never touched.
	for (const tag of targets) {
		if (scaffoldTag(tag, dir)) {
			console.log(`sync: scaffolded ${tag}.po (new target)`);
			result.scaffolded.push(tag);
		}
	}

	// Strays: a .po whose tag is not a target moves into attic/ (a
	// subdirectory, so the compile's non-recursive listing never sees it).
	const attic = join(dir, "attic");

	for (const file of files) {
		const tag = file.slice(0, -".po".length);

		if (targets.has(tag)) {
			continue;
		}

		const destination = join(attic, file);

		if (existsSync(destination)) {
			console.warn(`sync: attic/${tag}.po already exists — left in place`);
			continue;
		}

		mkdirSync(attic, {recursive: true});
		renameSync(join(dir, file), destination);
		console.log(`sync: archived ${tag}.po`);
		result.archived.push(tag);
	}

	return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	runSync();
}
