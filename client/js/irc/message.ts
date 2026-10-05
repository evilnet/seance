/**
 * IRC line parser / serialiser for the browser.
 *
 * Pure functions, no I/O, no Node built-ins. Implements RFC 1459 §2.3.1
 * message framing plus the IRCv3 `message-tags` extension (tag prefix and
 * the escape table). See docs/resources/browser-irc-parser.md.
 */

/** Origin of a message: a server name, or a nick with optional user@host. */
export interface IrcSource {
	/** Nick or server name. */
	name: string;
	user?: string;
	host?: string;
}

export interface IrcMessage {
	/** Unescaped tag values. A tag without a value maps to "". */
	tags: Map<string, string>;
	source?: IrcSource;
	/** Uppercased verb; numerics stay as their 3-digit string. */
	command: string;
	params: string[];
	/** The line as received, with CR/LF stripped. */
	raw: string;
}

/**
 * `{msgid}` when the line carries one. Spread into every message a channel
 * event pushes, live or replayed, so a replay of a line already shown is
 * deduplicated (history.ts `replay`) instead of shown twice. Only for events
 * nefarious2 stores in history: CHGHOST and AWAY are not stored, so their
 * msgid must not become the catch-up cursor (`IrcClient.noteCursor`).
 */
export function msgidOf(msg: IrcMessage): {msgid?: string} {
	const msgid = msg.tags.get("msgid");
	return msgid ? {msgid} : {};
}

/** Input accepted by {@link formatLine}. */
export interface IrcMessageInput {
	tags?: Map<string, string> | Record<string, string>;
	source?: IrcSource;
	command: string;
	params: string[];
}

/**
 * Maximum number of UTF-8 bytes Seance will put on one outbound line,
 * tags included.
 *
 * Classic IRC allows 512 bytes including CRLF (plus up to 8191 bytes of
 * tags with `message-tags`). nefarious2 used to drop the connection with
 * "WebSocket frame error" for any inbound frame of >= 528 bytes (upstream
 * issue evilnet/nefarious2#98, fixed 2026-08-28); the cap stays because the
 * server still rejects a message body over 512 bytes as excess flood, and
 * browsers cannot control fragmentation. See
 * docs/resources/nefarious2-websocket.md §"Framing rules".
 */
export const MAX_LINE_BYTES = 500;

/** Number of bytes `s` occupies when encoded as UTF-8. */
export function utf8ByteLength(s: string): number {
	let bytes = 0;

	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);

		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
			const next = s.charCodeAt(i + 1);

			if (next >= 0xdc00 && next <= 0xdfff) {
				// Surrogate pair: one 4-byte sequence.
				bytes += 4;
				i++;
				continue;
			}

			bytes += 3;
		} else {
			// BMP character or lone surrogate (encoders emit U+FFFD, 3 bytes).
			bytes += 3;
		}
	}

	return bytes;
}

/** Unescape a raw tag value per the IRCv3 message-tags escape table. */
export function unescapeTagValue(value: string): string {
	if (!value.includes("\\")) {
		return value;
	}

	let out = "";

	for (let i = 0; i < value.length; i++) {
		const ch = value[i];

		if (ch !== "\\") {
			out += ch;
			continue;
		}

		i++;

		if (i >= value.length) {
			// A lone trailing backslash is dropped.
			break;
		}

		const next = value[i];

		switch (next) {
			case ":":
				out += ";";
				break;
			case "s":
				out += " ";
				break;
			case "\\":
				out += "\\";
				break;
			case "r":
				out += "\r";
				break;
			case "n":
				out += "\n";
				break;
			default:
				// Unknown escape: the backslash is dropped, the character kept.
				out += next;
		}
	}

	return out;
}

/** Escape a tag value for the wire per the IRCv3 message-tags escape table. */
export function escapeTagValue(value: string): string {
	let out = "";

	for (let i = 0; i < value.length; i++) {
		const ch = value[i];

		switch (ch) {
			case ";":
				out += "\\:";
				break;
			case " ":
				out += "\\s";
				break;
			case "\\":
				out += "\\\\";
				break;
			case "\r":
				out += "\\r";
				break;
			case "\n":
				out += "\\n";
				break;
			default:
				out += ch;
		}
	}

	return out;
}

/** Parse the body of a `@tags` prefix (without the leading `@`). */
export function parseTags(str: string): Map<string, string> {
	const tags = new Map<string, string>();

	if (str.length === 0) {
		return tags;
	}

	for (const part of str.split(";")) {
		if (part.length === 0) {
			continue;
		}

		const eq = part.indexOf("=");

		if (eq === -1) {
			tags.set(part, "");
		} else {
			tags.set(part.slice(0, eq), unescapeTagValue(part.slice(eq + 1)));
		}
	}

	return tags;
}

/** Serialise tags to the body of a `@tags` prefix (without the `@`). */
export function formatTags(tags: Map<string, string> | Record<string, string>): string {
	const entries: [string, string][] =
		tags instanceof Map ? Array.from(tags.entries()) : Object.entries(tags);

	return entries
		.map(([key, value]) => {
			if (!isValidTagKey(key)) {
				throw new Error(`Invalid tag key: ${JSON.stringify(key)}`);
			}

			return value === "" ? key : `${key}=${escapeTagValue(value)}`;
		})
		.join(";");
}

function isValidTagKey(key: string): boolean {
	return key.length > 0 && !/[\s;=\r\n\0]/.test(key);
}

/** Parse a message source (`nick!user@host`, `nick@host`, `nick` or `server.name`). */
export function parseSource(str: string): IrcSource {
	const bang = str.indexOf("!");

	if (bang !== -1) {
		const name = str.slice(0, bang);
		const rest = str.slice(bang + 1);
		const at = rest.indexOf("@");

		if (at === -1) {
			return {name, user: rest};
		}

		return {name, user: rest.slice(0, at), host: rest.slice(at + 1)};
	}

	const at = str.indexOf("@");

	if (at !== -1) {
		return {name: str.slice(0, at), host: str.slice(at + 1)};
	}

	return {name: str};
}

/** Serialise an {@link IrcSource} back to `nick!user@host` form. */
export function formatSource(source: IrcSource): string {
	let out = source.name;

	if (source.user !== undefined) {
		out += `!${source.user}`;
	}

	if (source.host !== undefined) {
		out += `@${source.host}`;
	}

	return out;
}

/**
 * Parse one IRC line. Returns null for lines that are empty, whitespace-only
 * or have no command (e.g. a tags-only line).
 */
export function parseLine(line: string): IrcMessage | null {
	// Strip trailing CR/LF (any combination, defensively).
	let end = line.length;

	while (end > 0 && (line[end - 1] === "\r" || line[end - 1] === "\n")) {
		end--;
	}

	const raw = end === line.length ? line : line.slice(0, end);
	const len = raw.length;
	let pos = 0;

	const skipSpaces = (): void => {
		while (pos < len && raw[pos] === " ") {
			pos++;
		}
	};

	const readWord = (): string => {
		const start = pos;

		while (pos < len && raw[pos] !== " ") {
			pos++;
		}

		return raw.slice(start, pos);
	};

	skipSpaces();

	let tags: Map<string, string>;

	if (pos < len && raw[pos] === "@") {
		pos++;
		tags = parseTags(readWord());
		skipSpaces();
	} else {
		tags = new Map();
	}

	let source: IrcSource | undefined;

	if (pos < len && raw[pos] === ":") {
		pos++;
		source = parseSource(readWord());
		skipSpaces();
	}

	const command = readWord();

	if (command.length === 0) {
		return null;
	}

	const params: string[] = [];

	for (;;) {
		skipSpaces();

		if (pos >= len) {
			break;
		}

		if (raw[pos] === ":") {
			params.push(raw.slice(pos + 1));
			break;
		}

		params.push(readWord());
	}

	const message: IrcMessage = {
		tags,
		command: command.toUpperCase(),
		params,
		raw,
	};

	if (source) {
		message.source = source;
	}

	return message;
}

/**
 * Serialise a message to a single line, without CRLF (nefarious2's WebSocket
 * binding wants one bare line per frame). Throws if any parameter cannot be
 * represented on the wire.
 */
export function formatLine(msg: IrcMessageInput): string {
	if (msg.command.length === 0 || /[\s\r\n\0]/.test(msg.command)) {
		throw new Error(`Invalid command: ${JSON.stringify(msg.command)}`);
	}

	let out = "";

	if (msg.tags) {
		const tagStr = formatTags(msg.tags);

		if (tagStr.length > 0) {
			out += `@${tagStr} `;
		}
	}

	if (msg.source) {
		const src = formatSource(msg.source);

		if (src.length === 0 || /[\s\r\n\0]/.test(src)) {
			throw new Error(`Invalid source: ${JSON.stringify(src)}`);
		}

		out += `:${src} `;
	}

	out += msg.command.toUpperCase();

	const last = msg.params.length - 1;

	for (let i = 0; i <= last; i++) {
		const param = msg.params[i];

		if (/[\r\n\0]/.test(param)) {
			throw new Error(`Parameter ${i} contains CR, LF or NUL`);
		}

		const needsTrailing = param.length === 0 || param.includes(" ") || param.startsWith(":");

		if (needsTrailing) {
			if (i !== last) {
				throw new Error(
					`Parameter ${i} must be last: it is empty, contains a space or starts with ':'`
				);
			}

			out += ` :${param}`;
		} else {
			out += ` ${param}`;
		}
	}

	return out;
}

/**
 * Split `text` into chunks such that `prefixBytes + utf8ByteLength(chunk)`
 * never exceeds `maxBytes`. `prefixBytes` is the encoded size of everything
 * else on the line (e.g. `@tags :nick!u@h PRIVMSG #chan :`).
 *
 * Breaks preferentially at spaces/tabs (which are consumed), never inside a
 * UTF-8 multi-byte sequence or a UTF-16 surrogate pair. Returns [] for empty
 * text. Throws RangeError if not even one character fits.
 */
export function splitMessage(
	prefixBytes: number,
	text: string,
	maxBytes: number = MAX_LINE_BYTES
): string[] {
	const budget = maxBytes - prefixBytes;
	const chunks: string[] = [];

	if (text.length === 0) {
		return chunks;
	}

	if (budget <= 0) {
		throw new RangeError(
			`No room for message text: prefix is ${prefixBytes} of ${maxBytes} bytes`
		);
	}

	let start = 0;

	while (start < text.length) {
		let pos = start;
		let bytes = 0;
		let lastSpace = -1;

		while (pos < text.length) {
			const cp = text.codePointAt(pos) as number;
			const units = cp > 0xffff ? 2 : 1;
			const size = codePointBytes(cp);

			if (bytes + size > budget) {
				break;
			}

			if (cp === 0x20 || cp === 0x09) {
				lastSpace = pos;
			}

			bytes += size;
			pos += units;
		}

		if (pos >= text.length) {
			chunks.push(text.slice(start));
			break;
		}

		if (pos === start) {
			throw new RangeError(`Character at ${pos} does not fit in ${budget} bytes`);
		}

		let end = pos;
		let next = pos;

		if (lastSpace > start) {
			end = lastSpace;
			next = lastSpace;

			// Drop the whole whitespace run around the break point.
			while (end > start && (text[end - 1] === " " || text[end - 1] === "\t")) {
				end--;
			}

			while (next < text.length && (text[next] === " " || text[next] === "\t")) {
				next++;
			}
		}

		chunks.push(text.slice(start, end));
		start = next;
	}

	return chunks;
}

function codePointBytes(cp: number): number {
	if (cp < 0x80) {
		return 1;
	}

	if (cp < 0x800) {
		return 2;
	}

	if (cp < 0x10000) {
		return 3;
	}

	return 4;
}
