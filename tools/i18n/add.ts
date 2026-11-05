/* eslint-disable no-console */
// npx tsx tools/i18n/add.ts <key> "<msgid>" [--plural "<msgid_plural>"]
//   --context "<text>" (repeatable) --loc "<file:line>" (repeatable)
//
// Migration helper for the pot: upserts the entry (idempotent by key),
// replacing the `#.` context lines with the given ones, merging the `#:`
// loc lines, and writing the file back sorted by msgctxt. Never invents
// translations — msgstr stays empty. An existing msgid that differs is
// overwritten with a reminder to run merge.ts, so dependent .po files get
// their `#, fuzzy` marks.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname} from "node:path";
import {parsePo, PoEntry, serializePo} from "./po";
import {POT_PATH} from "./paths";
import {formatPluralForms, PLURAL_RULES, parsePluralForms} from "./plural";

const USAGE =
	'usage: npx tsx tools/i18n/add.ts <key> "<msgid>" [--plural "<msgid_plural>"] ' +
	'--context "<text>" --loc "<file:line>"';

export interface AddArgs {
	/** Semantic key, in msgctxt position. */
	key: string;
	msgid: string;
	plural?: string;
	/** `#.` translator context lines; replaces the entry's when given. */
	context: string[];
	/** `#:` loc lines; merged into the entry's. */
	loc: string[];
}

export interface AddOutcome {
	created: boolean;
	/** The msgid text changed on an existing entry — .po files need a merge. */
	drifted: boolean;
	text: string;
}

/** Headers for a pot that does not exist yet: a template, of no language. */
const FRESH_HEADERS: Record<string, string> = {
	"project-id-version": "seance",
	language: "",
	"plural-forms": formatPluralForms(PLURAL_RULES.en),
};

/** nplurals of the pot itself (from its Plural-Forms header, default en's). */
function potNplurals(headers: Record<string, string>): number {
	return parsePluralForms(headers["plural-forms"] ?? "")?.nplurals ?? PLURAL_RULES.en.nplurals;
}

export function addToPot(potPath: string, args: AddArgs): AddOutcome {
	const file = existsSync(potPath)
		? parsePo(readFileSync(potPath, "utf8"))
		: {headers: {...FRESH_HEADERS}, headerOrder: [], entries: []};
	const nplurals = potNplurals(file.headers);
	const existing = file.entries.find((entry) => entry.msgctxt === args.key);

	let created = false;
	let drifted = false;
	let entry: PoEntry;

	if (!existing) {
		created = true;
		entry = {
			translatorComments: [],
			context: [],
			loc: [],
			flags: [],
			previous: [],
			msgctxt: args.key,
			msgid: args.msgid,
			msgstr: args.plural !== undefined ? Array.from({length: nplurals}, () => "") : [],
		};
		file.entries.push(entry);
	} else {
		entry = existing;
		drifted = entry.msgid !== args.msgid;
		entry.msgid = args.msgid;
	}

	if (args.plural !== undefined && entry.msgidPlural !== args.plural) {
		entry.msgidPlural = args.plural;
		drifted = true;
		// Reshape the slots for the plural form, keeping any text already
		// there (there is none a translation could have come from — the pot
		// never carries translations — but a hand edit is preserved).
		entry.msgstr = Array.from({length: nplurals}, (_, index) => entry.msgstr[index] ?? "");
	}

	if (args.context.length > 0) {
		entry.context = [...args.context];
	}

	for (const loc of args.loc) {
		if (!entry.loc.includes(loc)) {
			entry.loc.push(loc);
		}
	}

	file.entries.sort((a, b) => (a.msgctxt < b.msgctxt ? -1 : a.msgctxt > b.msgctxt ? 1 : 0));
	const text = serializePo(file.headers, file.entries, file.headerOrder);
	mkdirSync(dirname(potPath), {recursive: true});
	writeFileSync(potPath, text);

	return {created, drifted, text};
}

function parseArgs(argv: string[]): AddArgs {
	const positional: string[] = [];
	const context: string[] = [];
	const loc: string[] = [];
	let plural: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = argv[i + 1];

		if (arg === "--plural") {
			if (value === undefined) {
				throw new Error("add: --plural needs a value");
			}

			plural = value;
			i++;
		} else if (arg === "--context") {
			if (value === undefined) {
				throw new Error("add: --context needs a value");
			}

			context.push(value);
			i++;
		} else if (arg === "--loc") {
			if (value === undefined) {
				throw new Error("add: --loc needs a value");
			}

			loc.push(value);
			i++;
		} else if (arg.startsWith("--")) {
			throw new Error(`add: unknown option ${arg}`);
		} else {
			positional.push(arg);
		}
	}

	const [key, msgid] = positional;

	if (!key || msgid === undefined) {
		throw new Error(USAGE);
	}

	return {key, msgid, plural, context, loc};
}

function main(): void {
	try {
		const args = parseArgs(process.argv.slice(2));
		const outcome = addToPot(POT_PATH, args);
		const state = outcome.created ? "created" : "updated";
		const drift = outcome.drifted
			? " — msgid drifted; run merge.ts to mark .po files fuzzy"
			: "";
		console.log(`add: ${args.key} ${state}${drift}`);
	} catch (e: unknown) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	}
}

if (require.main === module) {
	main();
}
