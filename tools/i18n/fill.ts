/* eslint-disable no-console */
// Fill the empty msgstr entries of client/locales/<tag>.po using the engine
// the route table places best for each language (Step 3 of the localization/
// translation phase). The model selection follows
// client/js/translate/routes.default.ts exactly as the app routes: NLLB-first
// and NLLB-tied languages go to NLLB, OPUS-tied ones to their OPUS-MT pair
// (both CPU seq2seq, fast), and the rest to the GPU LLM (which needs a
// converted, CUDA-safe model dir — tools/translate-eval/norm-fp32.py).
//
//   npx tsx tools/i18n/fill.ts [--langs de,fr,...] [--keys a.b,c.d]
//       [--engine llm|nllb|opus]
//       [--force-engine llm|nllb|opus] [--repo <converted model dir>]
//       [--model-id Qwen3-4B-q4f16_1-MLC] [--device cuda|cpu] [--batch 20]
//       [--limit N] [--dry]
//
// `--engine` SCOPES the run to the languages the route table already places
// on that engine; `--force-engine` puts every language in the run ON it,
// whatever the table says. The table is the app's measured runtime routing,
// where a request is one chat line under a latency budget; a catalog is
// filled once, offline, and the better engine wins — the 4B LLM writes
// Russian the OPUS-MT pair answers degenerately.
//
// The unit of work is a msgstr SLOT: a singular entry has one, a plural
// entry one per gettext form — only a slot n = 1 alone reads (by CLDR) translates msgid, the
// rest translate msgid_plural, and a one-form language's single slot takes
// the plural text (tools/i18n/plural.ts planPluralSlots). Each
// slot's source text is protected (spans.ts, the marker form the engine's
// route asks for) before the request and restored after; a translation that
// does not keep all of the original's placeholders is left empty. The .po is
// rewritten after every batch, so a run can be interrupted and resumed —
// filled slots are skipped on the next pass.

import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {emptyContext, TranslateRequest} from "../../client/js/translate/engine";
import {QWEN3_4B_ID} from "../../client/js/translate/models";
import {languageName, nllbCode} from "../../client/js/translate/languages";
import {promptProfileFor} from "../../client/js/translate/prompts";
import {placementFor} from "../../client/js/translate/routes.default";
import {placeholdersIn, protect, restoreAll} from "../../client/js/translate/spans";
import {parseBatchedOutput} from "../../client/js/translate/prompt";
import {WebLlmEngine} from "../../client/js/translate/engines/webllm";
import {parsePo, PoEntry, serializePo} from "./po";
import {PLURAL_RULES, parsePluralForms, planPluralSlots} from "./plural";
import {repad, slotVerdict} from "./quality";
import {NAME_TO_TAG, TARGETS_SOURCE} from "./targets";

type EngineName = "llm" | "nllb" | "opus";

/** One msgstr slot to fill and the English text that fills it. */
interface Unit {
	entry: PoEntry;
	/** The msgstr[N] index this translation is written to. */
	slot: number;
	/** msgid for a singular entry and for a plural's n = 1 slot; msgid_plural otherwise. */
	text: string;
}

const LOCALES = resolve("client/locales");
const NLLB_MODEL = "Xenova/nllb-200-distilled-600M";
const SRC_NLLB = "eng_Latn";
const BATCH_NLLB = 16;
const BATCH_LLM = 20;

// What a catalog string carries that is not prose, and that spans.ts does
// not recognise on its own because none of it is chat syntax:
//
//   a {placeholder}  an engine handed a bare `{network}` translates the word
//                    inside it ("{тип}"), which the placeholder gate then
//                    refuses, so the slot stays empty
//   a "quoted label" the words the user has to find on screen: ru answered
//                    `or pick "No authentication" there` with `"No trible"`,
//                    which sends the reader looking for a button that is not
//                    there — unless the label has a key of its own, in which
//                    case the button IS translated and the sentence has to
//                    follow it (fenceSpans's `ownKeyLabels`)
//   a protocol token the wire words and product names a translator leaves
//                    alone: de turned "SASL PLAIN" into "SASL-PLATZ"
//
// Each is fenced as a code span before the protection, which hands it to the
// same machinery every URL and nick goes through: the engine only ever sees
// a numbered marker, the marker gate refuses an answer that lost one, and
// the restore brings the text back character for character. No msgid carries
// a backtick of its own (checked: the pot has none).
const BRACE_RX = /\{[^{}\s]*\}/g;

// Longest first, so "SASL PLAIN" is one token and "IRCv3" is not fenced as
// "IRC" with a "v3" left outside. The list is every capitalised protocol
// word and product name the pot uses (`grep` of messages.pot); "IRC" itself
// is in it because it is a proper noun, even though several catalogs
// legitimately transliterate it.
const PROTOCOL_TOKENS = [
	"SASL PLAIN",
	"SASL EXTERNAL",
	"WebSocket",
	"WebGPU",
	"NickServ",
	"ChanServ",
	"IRCv3",
	"EXTERNAL",
	"MARKREAD",
	"PRIVMSG",
	"NOTICE",
	"VAPID",
	"PLAIN",
	"WHOIS",
	"SASL",
	"CTCP",
	"IRC",
	"TLS",
	"CAP",
];

// The quotation marks a catalog writes. English quotes what it quotes with
// ASCII double quotes, but an answer comes back in the target's own
// typography, and the label rules below have to recognise a quoted segment in
// either text. Counted over the 23 shipped catalogs: “…” in 15 of them
// (cs, da, es, fil, it, pt, sv, th, vi, zh …), „…” in hu, pl and ro, „…“ in
// German, «…» in French and Russian, 「…」 in Japanese. A pair missing from
// this table is not a missing nicety — `substituteLabels` finds no quoted
// segment at all in that catalog and silently leaves the model's own label
// standing.
const QUOTE_PAIRS: [string, string][] = [
	['"', '"'],
	["«", "»"],
	["„", "“"],
	["„", "”"],
	["“", "”"],
	["「", "」"],
];

const QUOTED_SOURCE = QUOTE_PAIRS.map(([open, close]) => `${open}[^${close}\n]*${close}`).join("|");

/** The text inside a quoted segment, or null if `match` is not one. */
export function quotedText(match: string): string | null {
	for (const [open, close] of QUOTE_PAIRS) {
		if (match.length >= open.length + close.length) {
			if (match.startsWith(open) && match.endsWith(close)) {
				return match.slice(open.length, -close.length);
			}
		}
	}

	return null;
}

/** Every quoted segment of a text, in order. */
const QUOTED_RX = new RegExp(QUOTED_SOURCE, "g");

// One pass, leftmost-longest: an already-fenced span is left alone (so
// nothing nests), a quoted segment wins over the braces inside it (the two
// msgids that quote nothing but a {placeholder}), and a scheme is matched
// without a word boundary behind it because `//` has no word character to
// sit against.
const FENCE_RX = new RegExp(
	[
		"`[^`\n]*`",
		QUOTED_SOURCE,
		"wss?://",
		`\\b(?:${PROTOCOL_TOKENS.join("|")})\\b`,
		BRACE_RX.source,
	].join("|"),
	"g"
);

/** The same alternation, as the fence wrote it: what `unfenceSpans` undoes. */
const UNFENCE_RX = new RegExp(
	"`(" +
		[QUOTED_SOURCE, "wss?://", `\\b(?:${PROTOCOL_TOKENS.join("|")})\\b`, BRACE_RX.source].join(
			"|"
		) +
		")`",
	"g"
);

/**
 * How the prompt names the target language. The engine is handed this, not
 * the tag: "translate into uk" was answered in English (UK), and the whole
 * Ukrainian catalog came back English for it.
 */
export function targetName(code: string): string {
	return languageName(code, "en");
}

/**
 * Which engine each language of a run goes to. `--engine` SCOPES the run to
 * the languages the route table already places there; `--force-engine` puts
 * every language on one engine whatever the table says.
 */
export function planEngines(
	tags: string[],
	options: {engine?: EngineName | null; forceEngine?: EngineName | null} = {}
): {tag: string; engine: EngineName}[] {
	const plan: {tag: string; engine: EngineName}[] = [];

	for (const tag of tags) {
		const placed = engineFor(tag);

		if (options.forceEngine) {
			plan.push({tag, engine: options.forceEngine});
			continue;
		}

		if (!options.engine || options.engine === placed) {
			plan.push({tag, engine: placed});
		}
	}

	return plan;
}

/**
 * Fence every span the engine must not touch: a {placeholder}, a scheme, a
 * protocol token, a quoted segment.
 *
 * `ownKeyLabels` is the one carve-out, and it is the msgids of the catalog
 * being filled: a quoted segment whose text IS another entry's msgid is a UI
 * label with a key of its own, so the button the sentence tells the user to
 * find is rendered from that key in the user's language. Fencing it shipped
 * `wähle "No authentication" dort aus` in 21 catalogs while the button read
 * `Keine Authentifizierung`. Unfenced, the model translates it like the rest
 * of the sentence (the existing gates still judge the answer); a quoted
 * segment that matches no msgid is not a label and stays fenced.
 */
export function fenceSpans(text: string, ownKeyLabels?: {has(label: string): boolean}): string {
	return text.replace(FENCE_RX, (match) => {
		if (match.startsWith("`")) {
			return match;
		}

		const quoted = quotedText(match);

		if (quoted !== null && ownKeyLabels?.has(quoted)) {
			return match;
		}

		return "`" + match + "`";
	});
}

/**
 * Put the deploy's own translation of a quoted UI label into the answer.
 *
 * The fence carve-out lets the model translate a label that has a key of its
 * own, which is right — but what the user has to find on screen is the string
 * THAT key renders, and the model has no idea what that is: asked twice it
 * writes two different buttons. So after the restore, a quoted segment of the
 * source that is another entry's msgid is replaced, in the answer, by that
 * entry's own msgstr in the same catalog. A label the catalog has not
 * translated yet keeps whatever the model wrote (English serves both).
 *
 * The answer's own quotation marks are kept — a German answer quotes with
 * „…“ — and the substitution only runs when the answer came back with exactly
 * as many quoted segments as the source had, because nothing else says which
 * segment is which.
 */
export function substituteLabels(
	source: string,
	answer: string,
	labels: ReadonlyMap<string, string>
): string {
	const sourceQuotes = source.match(QUOTED_RX) ?? [];
	const answerQuotes = answer.match(QUOTED_RX) ?? [];

	if (sourceQuotes.length === 0 || sourceQuotes.length !== answerQuotes.length) {
		return answer;
	}

	let index = -1;

	return answer.replace(QUOTED_RX, (match) => {
		index += 1;

		const label = quotedText(sourceQuotes[index] ?? "");
		const translated = label === null ? undefined : labels.get(label);

		if (translated === undefined || translated === "") {
			return match;
		}

		const pair = QUOTE_PAIRS.find(
			([open, close]) => match.startsWith(open) && match.endsWith(close)
		);

		return pair ? `${pair[0]}${translated}${pair[1]}` : match;
	});
}

export function unfenceSpans(text: string): string {
	return text.replace(UNFENCE_RX, "$1");
}

// The seq2seq models do not carry ⟦n⟧: measured on Xenova/opus-mt-en-de,
// "Connecting to ⟦1⟧" comes back "Verbindung zu ,1," — the brackets are not
// in the Marian vocabulary and the restore then has nothing to put the span
// back into, so every protected slot failed. `<n>` survives every engine
// tested, so the seq2seq routes see that form and the answer is mapped back
// before the marker gate and the restore, which both speak ⟦n⟧.
export function toTags(text: string): string {
	return text.replace(/⟦\s*(\d+)\s*⟧/g, "<$1>");
}

export function fromTags(text: string): string {
	return text.replace(/<\s*(\d+)\s*>/g, "⟦$1⟧");
}

function engineFor(tag: string): EngineName {
	const placement = placementFor(QWEN3_4B_ID);

	if (placement.nllbFirst.includes(tag) || placement.nllbTied.includes(tag)) {
		return "nllb";
	}

	if (placement.opusTied.includes(tag)) {
		return "opus";
	}

	return "llm";
}

interface Options {
	langs: string[] | null;
	engine: EngineName | null;
	/** Every language in the run goes to this engine, route table or not. */
	forceEngine: EngineName | null;
	/** Only these msgctxt keys, when given. */
	keys: Set<string> | null;
	repo: string | null;
	modelId: string;
	device: "cpu" | "cuda";
	batch: number;
	limit: number | null;
	dry: boolean;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		langs: null,
		engine: null,
		forceEngine: null,
		keys: null,
		repo: null,
		modelId: QWEN3_4B_ID,
		device: "cuda",
		batch: BATCH_LLM,
		limit: null,
		dry: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];

		if (arg === "--langs") {
			options.langs = (argv[++i] ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (arg === "--engine") {
			options.engine = argv[++i] as EngineName;
		} else if (arg === "--keys") {
			const value = argv[++i];

			if (!value) {
				throw new Error("fill: --keys needs a comma-separated list of msgctxt keys");
			}

			options.keys = new Set(value.split(",").map((key) => key.trim()));
		} else if (arg === "--force-engine") {
			options.forceEngine = argv[++i] as EngineName;
		} else if (arg === "--repo") {
			options.repo = resolve(argv[++i] ?? "");
		} else if (arg === "--model-id") {
			options.modelId = argv[++i] ?? options.modelId;
		} else if (arg === "--device") {
			options.device = (argv[++i] as Options["device"]) ?? options.device;
		} else if (arg === "--batch") {
			options.batch = Number(argv[++i] ?? options.batch);
		} else if (arg === "--limit") {
			options.limit = Number(argv[++i] ?? "");
		} else if (arg === "--dry") {
			options.dry = true;
		}
	}

	return options;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const names = readFileSync(TARGETS_SOURCE, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	const allTags = names.map((name) => NAME_TO_TAG[name]).filter(Boolean);
	const langs = (options.langs ?? allTags).map((lang) => NAME_TO_TAG[lang] ?? lang);

	// The route table's placement decides the engine unless --force-engine
	// overrides it; --engine only scopes the run (planEngines).
	const plan = planEngines(langs, options);

	if (options.dry) {
		for (const {tag, engine} of plan) {
			console.log(`${tag}: ${engine}`);
		}

		return;
	}

	const {pipeline} = await import("@huggingface/transformers");
	const {env} = await import("@huggingface/transformers");
	env.cacheDir = resolve("tmp", "models");

	let nllbPipe: Awaited<ReturnType<typeof pipeline>> | null = null;
	const opusPipes = new Map<string, Awaited<ReturnType<typeof pipeline>>>();

	let llmEngine: WebLlmEngine | null = null;

	if (plan.some(({engine}) => engine === "llm")) {
		if (!options.repo || !existsSync(options.repo)) {
			console.error(
				"fill: the LLM languages need a converted, CUDA-safe model dir " +
					"(tools/translate-eval/norm-fp32.py) — pass --repo. Skipping them."
			);
		} else {
			const {buildCatalog} = await import("../../client/js/translate/models");
			const {nodeDeps} = await import("../llm-node-backend");
			const catalog = buildCatalog({}, options.modelId);
			const {deps} = nodeDeps(options.modelId, {
				device: options.device,
				repo: options.repo,
				dtype: "q4f16",
				threads: null,
				log: (text) => console.log(text),
			});
			deps.promptProfileFor = () => promptProfileFor(options.modelId);
			// The prompt names the target language, and a bare tag is not a
			// name: asked to translate "into uk" the model answered in
			// English (UK), which the unchanged gate now catches but the
			// catalog wore for a whole round. The app passes a resolver
			// here; so does the fill.
			llmEngine = new WebLlmEngine(deps, targetName);
			llmEngine.configure(catalog);

			console.log("fill: loading the converted 4B weights…");
			let shown = -1;
			await llmEngine.load(catalog.llm, (progress) => {
				const percent = Math.floor(progress.fraction * 100);

				if (percent >= shown + 10 || percent === 100) {
					shown = percent;
					console.log(`  load ${percent}% ${progress.text ?? ""}`.trimEnd());
				}
			});
		}
	}

	let totalFilled = 0;
	let totalFailed = 0;

	for (const {tag, engine} of plan) {
		const poPath = resolve(LOCALES, `${tag}.po`);

		if (!existsSync(poPath)) {
			console.warn(`fill: ${tag}.po missing — run tools/i18n/scaffold.ts first`);
			continue;
		}

		if (engine === "llm" && !llmEngine) {
			console.log(`fill: ${tag} — skipped (no converted LLM model dir)`);
			continue;
		}

		const po = parsePo(readFileSync(poPath, "utf8"));
		const rule = PLURAL_RULES[tag] ?? parsePluralForms(po.headers["plural-forms"] ?? "");

		if (!rule) {
			console.warn(
				`fill: no plural rule for ${tag} — add it to tools/i18n/plural-rules.json`
			);
			continue;
		}

		// The unit of work is a msgstr SLOT, not an entry: a plural entry
		// carries one slot per gettext form, the slot n = 1 reads translates
		// msgid and every other one translates msgid_plural. Filling only the
		// first slot left the rest empty, and the compile then drops the whole
		// key (or, before that ruling, served the singular for every count).
		const todo: Unit[] = [];

		for (const entry of po.entries) {
			// An empty msgid is a deliberately blank slot (the deploy fills
			// it); translating "" only invents text, so it never enters the
			// todo.
			if (!entry.msgid) {
				continue;
			}

			// --keys narrows a run to the keys named: a round that adds or
			// rewords three msgids should not re-ask the model for every slot
			// an earlier sweep left empty (there are hundreds, and they were
			// left empty because the answers were refused).
			if (options.keys && !options.keys.has(entry.msgctxt ?? "")) {
				continue;
			}

			if (entry.msgidPlural === undefined) {
				if (!entry.msgstr[0]) {
					todo.push({entry, slot: 0, text: entry.msgid});
				}

				continue;
			}

			while (entry.msgstr.length < rule.nplurals) {
				entry.msgstr.push("");
			}

			for (const {index, source} of planPluralSlots(entry, rule.nplurals, rule.expr, tag)) {
				if (!entry.msgstr[index]) {
					todo.push({
						entry,
						slot: index,
						text: source === "msgid" ? entry.msgid : entry.msgidPlural,
					});
				}
			}
		}

		if (todo.length === 0) {
			console.log(`fill: ${tag} — already complete`);
			continue;
		}

		// Every UI label that has a key of its own, with this catalog's own
		// translation of it, built once per catalog: a .po's msgids are the
		// pot's English copy after the merge, so this is the pot's label set
		// without a second read. The keys carve a quoted segment out of the
		// fence (`fenceSpans`) and the values replace it in the answer
		// (`substituteLabels`), so the sentence names the button the user
		// actually sees. A plural entry's msgid_plural is a sentence about a
		// count, never a label, so only msgid enters the table.
		const ownKeyLabels = new Map<string, string>();

		for (const entry of po.entries) {
			if (entry.msgid && entry.msgidPlural === undefined) {
				ownKeyLabels.set(entry.msgid, entry.msgstr[0] ?? "");
			}
		}

		const limited = options.limit ? todo.slice(0, options.limit) : todo;
		const started = Date.now();
		let filled = 0;
		let failed = 0;

		const flush = () =>
			writeFileSync(poPath, serializePo(po.headers, po.entries, po.headerOrder));

		if (engine === "nllb" && !nllbPipe) {
			console.log("fill: loading NLLB-200 (600M)…");
			nllbPipe = (await (pipeline as any)("translation", NLLB_MODEL)) as any;
		}

		if (engine === "opus") {
			const modelId = `Xenova/opus-mt-en-${tag}`;

			if (!opusPipes.has(modelId)) {
				console.log(`fill: loading ${modelId}…`);
				opusPipes.set(modelId, (await (pipeline as any)("translation", modelId)) as any);
			}
		}

		const batches: typeof limited[] = [];

		for (let i = 0; i < limited.length; i += engine === "llm" ? options.batch : BATCH_NLLB) {
			batches.push(limited.slice(i, i + (engine === "llm" ? options.batch : BATCH_NLLB)));
		}

		for (const batch of batches) {
			// One protection per entry, in the marker form the engine's route
			// asks for (spans.ts): numbered tags for the seq2seq engines,
			// placeholders for the LLM.
			const markerForm = engine === "llm" ? "placeholder" : "tags";
			const protectedEntries = batch.map((unit) => ({
				unit,
				...protect(fenceSpans(unit.text, ownKeyLabels), {
					nicks: [],
					markers: markerForm,
				}),
			}));

			try {
				let outputs: (string | null)[] = [];

				if (engine === "nllb") {
					const tgt = nllbCode(tag) ?? tag;
					const results = await (nllbPipe as any)(
						protectedEntries.map((p) => toTags(p.text)),
						{src_lang: SRC_NLLB, tgt_lang: tgt}
					);
					outputs = (results as Array<{translation_text?: string} | null>).map((r) =>
						typeof r?.translation_text === "string"
							? fromTags(r.translation_text)
							: null
					);
				} else if (engine === "opus") {
					const pipe = opusPipes.get(`Xenova/opus-mt-en-${tag}`);
					const results = await (
						pipe as unknown as (
							texts: string[]
						) => Promise<Array<{translation_text?: string}>>
					)(protectedEntries.map((p) => toTags(p.text)));
					outputs = results.map((r) =>
						typeof r?.translation_text === "string"
							? fromTags(r.translation_text)
							: null
					);
				} else {
					const request: TranslateRequest = {
						id: 1,
						model: options.modelId,
						text: "",
						lines: protectedEntries.map((p) => p.text),
						from: "en",
						to: tag,
						purpose: "read",
						context: emptyContext(),
						markers: "placeholder",
					};

					let last = "";

					for await (const chunk of llmEngine!.translate(
						request,
						new AbortController().signal
					)) {
						last = chunk.text;
					}

					const parsed = parseBatchedOutput(last, batch.length);
					outputs = parsed ?? batch.map(() => null);
				}

				batch.forEach((unit, index) => {
					const info = protectedEntries[index];
					const raw = outputs[index];

					if (typeof raw !== "string") {
						failed += 1;
						return;
					}

					// Two gates: the model must carry every protection marker
					// it was given (⟦n⟧ / <n>), and after the restore the
					// {placeholder} braces of the original must survive — a
					// renamed one breaks the label at render time, and the
					// compile refuses the whole catalog for it.
					const markersGiven = placeholdersIn(info.text).join("|");
					const markersBack = placeholdersIn(raw).join("|");

					if (markersGiven !== markersBack) {
						failed += 1;
						console.warn(
							`fill: ${tag} "${unit.text}" lost a protection marker (${markersGiven} → ${markersBack})`
						);
						return;
					}

					const restored = substituteLabels(
						unit.text,
						unfenceSpans(restoreAll(raw, info)),
						ownKeyLabels
					);

					// Judged against the slot's OWN source (a plural form
					// legitimately carries {count} where the singular does
					// not) and by the verdict the sweep uses, so the fill
					// refuses exactly what the sweep would empty: a renamed
					// {placeholder}, a loop, an essay where a label was asked
					// for, an answer in the wrong writing system.
					// Whitespace at the ends belongs to the source, not to
					// the answer: every engine trims, so a msgid that carries
					// a space (a screen-reader prefix read before a nick) gets
					// it put back rather than refused.
					const padded = repad(unit.text, restored);
					const verdict = slotVerdict(tag, unit.text, padded);

					if (verdict) {
						failed += 1;
						console.warn(
							`fill: ${tag} "${unit.text}" ${verdict} (${padded.slice(0, 40)})`
						);
						return;
					}

					unit.entry.msgstr[unit.slot] = padded;
					filled += 1;
				});

				flush();
				console.log(
					`fill: ${tag} ${filled + failed}/${limited.length} ` +
						`(+${filled} filled this pass)`
				);
			} catch (error) {
				failed += batch.length;
				console.error(
					`fill: ${tag} batch failed:`,
					(error as Error).stack ?? (error as Error).message
				);
			}
		}

		totalFilled += filled;
		totalFailed += failed;
		console.log(
			`fill: ${tag} done in ${((Date.now() - started) / 1000).toFixed(0)}s — ` +
				`${filled} filled, ${failed} failed, ${limited.length - filled - failed} skipped`
		);
	}

	console.log(`fill: ${totalFilled} filled, ${totalFailed} failed overall`);
	process.exit(0);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
