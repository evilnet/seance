/**
 * The push payload as draft/webpush shapes it: one IRC line, no CRLF
 * (docs/projects/push-payload-multiline.md §3). Parsing only — no DOM, no
 * store — so mocha loads it and the service worker gets it through the
 * js/push.js chunk (worker-entry.ts).
 */

export type PushTags = Record<string, string | true>;

export type PushLine = {
	tags: PushTags;
	/** The prefix's nick (`nick!user@host`) or, for a server line, the server name. */
	nick: string;
	/** The prefix's user and host, when it has them (the ignore list matches them). */
	user?: string;
	host?: string;
	/** Upper-cased. */
	command: string;
	/** First parameter: the message target, or MARKREAD's target. */
	target: string;
	/** Trailing parameter; "" when there is none. */
	text: string;
	/** MARKREAD's `timestamp=` parameter, when it has one. */
	timestamp?: string;
};

/** The server's ordering tag on a multiline line: 1-based index, lines pushed, lines in the message. */
export type LineIndex = {index: number; sent: number; total: number};

export const LINE_TAG = "evilnet.github.io/line";
export const CONCAT_TAG = "draft/multiline-concat";

const ESCAPES: Record<string, string> = {":": ";", s: " ", "\\": "\\", r: "\r", n: "\n"};

/** The message-tags value escapes undone; a trailing lone backslash is dropped. */
export function unescapeTagValue(value: string): string {
	let out = "";

	for (let i = 0; i < value.length; i++) {
		const ch = value[i];

		if (ch !== "\\") {
			out += ch;
			continue;
		}

		if (i + 1 >= value.length) {
			break;
		}

		const next = value[++i];
		out += ESCAPES[next] ?? next;
	}

	return out;
}

/** `a=1;flag;b=x` → `{a: "1", flag: true, b: "x"}`. */
export function parseTags(raw: string): PushTags {
	const tags: PushTags = {};

	for (const pair of raw.split(";")) {
		if (!pair) {
			continue;
		}

		const eq = pair.indexOf("=");

		if (eq === -1) {
			tags[pair] = true;
		} else {
			tags[pair.slice(0, eq)] = unescapeTagValue(pair.slice(eq + 1));
		}
	}

	return tags;
}

/** `[@tags] :prefix COMMAND target [...] [:trailing]`; null when it is not that. */
export function parsePushLine(line: string): PushLine | null {
	let rest = line;
	let tags: PushTags = {};

	if (rest.startsWith("@")) {
		const space = rest.indexOf(" ");

		if (space === -1) {
			return null;
		}

		tags = parseTags(rest.slice(1, space));
		rest = rest.slice(space + 1).trimStart();
	}

	if (!rest.startsWith(":")) {
		return null;
	}

	const first = rest.indexOf(" ");

	if (first === -1) {
		return null;
	}

	const prefix = rest.slice(1, first);
	const at = prefix.indexOf("@");
	const userhost = at === -1 ? prefix : prefix.slice(0, at);
	const bang = userhost.indexOf("!");
	const nick = bang === -1 ? userhost : userhost.slice(0, bang);
	const tail = rest.slice(first + 1).trimStart();
	const second = tail.indexOf(" ");
	const command = (second === -1 ? tail : tail.slice(0, second)).toUpperCase();

	if (!command) {
		return null;
	}

	const params = second === -1 ? "" : tail.slice(second + 1);
	let middle = params;
	let text = "";

	if (params.startsWith(":")) {
		middle = "";
		text = params.slice(1);
	} else {
		const colon = params.indexOf(" :");

		if (colon !== -1) {
			middle = params.slice(0, colon);
			text = params.slice(colon + 2);
		}
	}

	const words = middle.split(" ").filter(Boolean);
	const result: PushLine = {tags, nick, command, target: words[0] ?? "", text};

	if (bang !== -1) {
		result.user = userhost.slice(bang + 1);
	}

	if (at !== -1) {
		result.host = prefix.slice(at + 1);
	}

	if (command === "MARKREAD") {
		const ts = words.find((word) => word.startsWith("timestamp="));

		if (ts) {
			result.timestamp = ts.slice("timestamp=".length);
		}
	}

	return result;
}

/** The `evilnet.github.io/line` tag, or null when absent or inconsistent. */
export function lineIndexOf(tags: PushTags): LineIndex | null {
	const value = tags[LINE_TAG];

	if (typeof value !== "string") {
		return null;
	}

	const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(value);

	if (!match) {
		return null;
	}

	const index = Number(match[1]);
	const sent = Number(match[2]);
	const total = Number(match[3]);

	if (index < 1 || sent < 1 || total < 1 || index > sent || sent > total) {
		return null;
	}

	return {index, sent, total};
}
