/**
 * Minimal gettext .po reader/writer for the files this toolchain generates
 * plus what a hand editor adds in the standard layout: comment lines
 * (#, #., #:, #,), msgctxt/msgid/msgid_plural/msgstr[N], multi-line strings,
 * standard escapes. Entries are blank-line separated (msgcat's layout);
 * anything unparseable throws with the offending line rather than guessing.
 */

export interface PoEntry {
	/** "# " translator comments, one entry per comment line (hand-added notes). */
	translatorComments: string[];
	/** "#." translator/MT context, one entry per comment line. */
	context: string[];
	/** "#: file:line" — where the label is rendered. */
	loc: string[];
	/** e.g. ["fuzzy"] — set by merge when a msgid drifted. */
	flags: string[];
	/** "#|" previous msgid/msgctxt, one entry per comment line, kept verbatim. */
	previous: string[];
	/** Semantic key in msgctxt position ("connect.submit"); "" when none. */
	msgctxt: string;
	msgid: string;
	msgidPlural?: string;
	/** msgstr (index 0) or msgstr[N] for plural entries. */
	msgstr: string[];
}

export interface PoFile {
	headers: Record<string, string>;
	/** Header keys in their original casing, in file order (known and unknown alike). */
	headerOrder: string[];
	entries: PoEntry[];
}

const ESCAPES: Record<string, string> = {n: "\n", t: "\t", '"': '"', "\\": "\\"};

export function unquote(text: string): string {
	return text.replace(/\\(.)/g, (match, c: string) => ESCAPES[c] ?? match);
}

export function quote(text: string): string {
	return (
		'"' +
		text.replace(/["\\\n\t]/g, (c) => (c === "\n" ? "\\n" : c === "\t" ? "\\t" : "\\" + c)) +
		'"'
	);
}

function newEntry(): PoEntry {
	return {
		translatorComments: [],
		context: [],
		loc: [],
		flags: [],
		previous: [],
		msgctxt: "",
		msgid: "",
		msgstr: [],
	};
}

export function parsePo(text: string): PoFile {
	const headers: Record<string, string> = {};
	const headerOrder: string[] = [];
	const entries: PoEntry[] = [];
	let entry: PoEntry | null = null;
	let lastKeyword = "";
	let sawString = false;
	/**
	 * Where continued string chunks land until the next keyword/comment.
	 * `startField` hands its setter back to the loop rather than assigning
	 * here: an assignment made inside a closure is invisible to TypeScript's
	 * flow analysis, which then narrows every later read to `null`.
	 */
	let append: ((chunk: string) => void) | null = null;

	const flush = () => {
		if (entry) {
			entries.push(entry);
		}

		entry = null;
		lastKeyword = "";
		sawString = false;
		append = null;
	};

	const ensure = (): PoEntry => {
		if (!entry) {
			entry = newEntry();
		}

		return entry;
	};

	const startField = (keyword: string, first: string): ((chunk: string) => void) => {
		// msgctxt always begins an entry; anything non-msgstr after msgstr does too.
		if (
			(sawString && keyword === "msgctxt") ||
			(lastKeyword.startsWith("msgstr") && !keyword.startsWith("msgstr"))
		) {
			flush();
		}

		const current = ensure();

		const set = (chunk: string) => {
			if (keyword === "msgctxt") {
				current.msgctxt += chunk;
			} else if (keyword === "msgid") {
				current.msgid += chunk;
			} else if (keyword === "msgid_plural") {
				current.msgidPlural = (current.msgidPlural ?? "") + chunk;
			} else {
				const m = /^msgstr\[(\d+)\]$/.exec(keyword);
				const index = m ? Number(m[1]) : 0;
				current.msgstr[index] = (current.msgstr[index] ?? "") + chunk;
			}
		};

		set(first);
		sawString = true;
		lastKeyword = keyword;
		return set;
	};

	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();

		if (line === "") {
			flush();
			continue;
		}

		if (line.startsWith("#")) {
			if (sawString) {
				flush();
			} // comments attach to the entry that follows

			const current = ensure();
			const rest = line.slice(1);

			if (rest.startsWith(":")) {
				current.loc.push(...rest.slice(1).trim().split(/\s+/).filter(Boolean));
			} else if (rest.startsWith(".")) {
				current.context.push(rest.slice(1).trim());
			} else if (rest.startsWith(",")) {
				current.flags.push(
					...rest
						.slice(1)
						.split(",")
						.map((f) => f.trim())
						.filter(Boolean)
				);
			} else if (rest.startsWith("|")) {
				current.previous.push(rest.slice(1).trim());
			} else {
				// Bare "#" or "# note" — a hand-added translator comment.
				current.translatorComments.push(rest.trim());
			}

			continue;
		}

		const keywordMatch = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+"(.*)"$/.exec(
			line
		);

		if (keywordMatch) {
			append = startField(keywordMatch[1], unquote(keywordMatch[2]));
			continue;
		}

		const stringMatch = /^"(.*)"$/.exec(line.trim());

		if (stringMatch) {
			if (!append) {
				throw new Error(`po: string outside any field: ${line}`);
			}

			append(unquote(stringMatch[1]));
			continue;
		}

		throw new Error(`po: cannot parse line: ${line}`);
	}

	flush();

	// The header entry is msgid "" — its msgstr holds "Key: value\n" lines.
	const headerEntryIndex = entries.findIndex((e) => e.msgctxt === "" && e.msgid === "");

	if (headerEntryIndex !== -1) {
		for (const line of (entries[headerEntryIndex].msgstr[0] ?? "").split("\n")) {
			const sep = line.indexOf(":");

			if (sep > 0) {
				const originalKey = line.slice(0, sep).trim();
				const lowerKey = originalKey.toLowerCase();
				headers[lowerKey] = line.slice(sep + 1).trim();

				if (!headerOrder.some((k) => k.toLowerCase() === lowerKey)) {
					headerOrder.push(originalKey);
				}
			}
		}

		entries.splice(headerEntryIndex, 1);
	}

	return {headers, headerOrder, entries};
}

const HEADER_KEYS = [
	"Project-Id-Version",
	"Language",
	"MIME-Version",
	"Content-Type",
	"Content-Transfer-Encoding",
	"Plural-Forms",
] as const;

const HEADER_KEYS_LOWER = new Set(HEADER_KEYS.map((k) => k.toLowerCase()));

export function serializePo(
	headers: Record<string, string>,
	entries: PoEntry[],
	headerOrder: string[] = []
): string {
	const out: string[] = [];
	const allHeaders: Record<string, string> = {};

	for (const key of HEADER_KEYS) {
		allHeaders[key] =
			headers[key.toLowerCase()] ??
			(key === "Content-Type"
				? "text/plain; charset=UTF-8"
				: key === "MIME-Version"
				? "1.0"
				: key === "Content-Transfer-Encoding"
				? "8bit"
				: "");
	}

	// Unknown headers (Last-Translator, PO-Revision-Date, X-Generator, ...)
	// survive after the known ones, in their original casing and input order.
	const extraKeys: string[] = [];
	const seenExtra = new Set<string>();

	for (const key of headerOrder) {
		const lowerKey = key.toLowerCase();

		if (!HEADER_KEYS_LOWER.has(lowerKey) && !seenExtra.has(lowerKey)) {
			seenExtra.add(lowerKey);
			extraKeys.push(key);
		}
	}

	for (const key of extraKeys) {
		allHeaders[key] = headers[key.toLowerCase()] ?? "";
	}

	out.push('msgid ""', 'msgstr ""');

	for (const [key, value] of Object.entries(allHeaders)) {
		// Language stays in the output even when empty: a template is
		// deliberately of no language yet, and parsePo reads the empty value
		// back, so the header round-trips.
		if (value || key === "Language") {
			out.push(quote(`${key}: ${value}\n`));
		}
	}

	for (const entry of entries) {
		out.push("");

		for (const c of entry.translatorComments) {
			out.push(c ? `# ${c}` : "#");
		}

		for (const ctx of entry.context) {
			out.push(`#. ${ctx}`);
		}

		for (const loc of entry.loc) {
			out.push(`#: ${loc}`);
		}

		if (entry.flags.length > 0) {
			out.push(`#, ${entry.flags.join(", ")}`);
		}

		for (const p of entry.previous) {
			out.push(`#| ${p}`);
		}

		if (entry.msgctxt) {
			out.push(`msgctxt ${quote(entry.msgctxt)}`);
		}

		out.push(`msgid ${quote(entry.msgid)}`);

		if (entry.msgidPlural !== undefined) {
			out.push(`msgid_plural ${quote(entry.msgidPlural)}`);
		}

		if (entry.msgidPlural !== undefined) {
			entry.msgstr.forEach((text, index) => out.push(`msgstr[${index}] ${quote(text)}`));
		} else {
			out.push(`msgstr ${quote(entry.msgstr[0] ?? "")}`);
		}
	}

	return out.join("\n") + "\n";
}
