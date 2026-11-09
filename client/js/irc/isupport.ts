/**
 * ISUPPORT (numeric 005) token registry with typed accessors.
 *
 * Feed it the params of every 005 message with {@link ISupport.apply}. Token
 * names are case-insensitive and stored uppercased.
 */

import {CaseMapping, parseCaseMapping} from "./casemap";

export interface PrefixInfo {
	/** Channel membership modes, most privileged first (e.g. "ov"). */
	modes: string;
	/** Matching status symbols (e.g. "@+"). */
	symbols: string;
}

export interface ChanModes {
	/** Type A: list modes (always take a parameter). */
	a: string;
	/** Type B: always take a parameter. */
	b: string;
	/** Type C: take a parameter only when set. */
	c: string;
	/** Type D: never take a parameter. */
	d: string;
}

export interface ExtBanInfo {
	/** Prefix character (may be "" if the server has none). */
	prefix: string;
	/** Supported extban type letters. */
	types: string;
}

const DEFAULT_PREFIX: PrefixInfo = {modes: "ov", symbols: "@+"};
const DEFAULT_CHANTYPES = "#&";
const DEFAULT_CASEMAPPING: CaseMapping = "rfc1459";
// ircu / nefarious2 defaults; see docs/resources/nefarious2-websocket.md §ISUPPORT.
const DEFAULT_CHANMODES: ChanModes = {
	a: "b",
	b: "k",
	c: "Ll",
	d: "aCcDdHiMmNnOPpQRrSsTtZz",
};

const utf8 = new TextDecoder("utf-8", {fatal: true});

/** `bytes` as UTF-8, else one character per byte (a server from before UTF-8). */
function decodeRun(bytes: Uint8Array): string {
	try {
		return utf8.decode(bytes);
	} catch {
		return String.fromCharCode(...bytes);
	}
}

/** Unescape `\xHH` sequences in an ISUPPORT value. */
function unescapeValue(value: string): string {
	if (!value.includes("\\x")) {
		return value;
	}

	// Each run of escapes is the UTF-8 encoding of what it stands for
	// (`Caf\xC3\xA9` is "Café"), so a run is decoded as one byte string.
	return value.replace(/(?:\\x[0-9a-fA-F]{2})+/g, (run) =>
		decodeRun(Uint8Array.from(run.split("\\x").slice(1), (hex) => parseInt(hex, 16)))
	);
}

export class ISupport {
	private readonly map = new Map<string, string>();

	/** All known tokens, uppercased, with their (unescaped) values. */
	get tokens(): ReadonlyMap<string, string> {
		return this.map;
	}

	/** Forget every token (call on reconnect). */
	reset(): void {
		this.map.clear();
	}

	/**
	 * Apply the params of a 005 message. The first param (our nick) and the
	 * last (the ":are supported by this server" trailer) are skipped.
	 */
	apply(params: string[]): void {
		for (const param of params.slice(1, -1)) {
			if (param.length === 0) {
				continue;
			}

			if (param.startsWith("-")) {
				this.map.delete(param.slice(1).toUpperCase());
				continue;
			}

			const eq = param.indexOf("=");

			if (eq === -1) {
				this.map.set(param.toUpperCase(), "");
			} else {
				this.map.set(param.slice(0, eq).toUpperCase(), unescapeValue(param.slice(eq + 1)));
			}
		}
	}

	get(token: string): string | undefined {
		return this.map.get(token.toUpperCase());
	}

	has(token: string): boolean {
		return this.map.has(token.toUpperCase());
	}

	private getInt(token: string): number | undefined {
		const value = this.get(token);

		if (value === undefined || !/^\d+$/.test(value)) {
			return undefined;
		}

		return parseInt(value, 10);
	}

	/** `PREFIX=(modes)symbols`; defaults to `(ov)@+`. An empty value means no prefixes. */
	get prefix(): PrefixInfo {
		const value = this.get("PREFIX");

		if (value === undefined) {
			return DEFAULT_PREFIX;
		}

		if (value === "") {
			return {modes: "", symbols: ""};
		}

		const match = /^\(([^)]*)\)(.*)$/.exec(value);

		if (!match || match[1].length !== match[2].length) {
			return DEFAULT_PREFIX;
		}

		return {modes: match[1], symbols: match[2]};
	}

	/** Status symbol for a membership mode letter (`o` → `@`). */
	prefixForMode(mode: string): string | undefined {
		const {modes, symbols} = this.prefix;
		const idx = modes.indexOf(mode);

		return idx === -1 ? undefined : symbols[idx];
	}

	/** Membership mode letter for a status symbol (`@` → `o`). */
	modeForPrefix(symbol: string): string | undefined {
		const {modes, symbols} = this.prefix;
		const idx = symbols.indexOf(symbol);

		return idx === -1 ? undefined : modes[idx];
	}

	/** Channel prefix characters; defaults to `#&`. */
	get chantypes(): string {
		return this.get("CHANTYPES") ?? DEFAULT_CHANTYPES;
	}

	/** Status prefixes usable as message targets (`@#chan`); "" if unsupported. */
	get statusmsg(): string {
		return this.get("STATUSMSG") ?? "";
	}

	/** Casemapping for nick/channel comparison; unknown values fall back to rfc1459. */
	get casemapping(): CaseMapping {
		const value = this.get("CASEMAPPING");

		if (value === undefined) {
			return DEFAULT_CASEMAPPING;
		}

		return parseCaseMapping(value) ?? DEFAULT_CASEMAPPING;
	}

	get network(): string | undefined {
		const value = this.get("NETWORK");

		return value === undefined || value === "" ? undefined : value;
	}

	/**
	 * The channels the network puts forward (`FEATURED=#help,#lounge`), with
	 * or without a vendor prefix (`nefarious/FEATURED`), the token's spelling
	 * not being settled; the value as sent, or nothing. Read by the channel
	 * browser (irc/channelList.ts).
	 */
	get featured(): string | undefined {
		for (const [token, value] of this.map) {
			if (token === "FEATURED" || token.endsWith("/FEATURED")) {
				return value;
			}
		}

		return undefined;
	}

	/** `CHANMODES=A,B,C,D`; defaults to the ircu set. */
	get chanmodes(): ChanModes {
		const value = this.get("CHANMODES");

		if (value === undefined) {
			return DEFAULT_CHANMODES;
		}

		const parts = value.split(",");

		return {
			a: parts[0] ?? "",
			b: parts[1] ?? "",
			c: parts[2] ?? "",
			d: parts[3] ?? "",
		};
	}

	get nicklen(): number | undefined {
		return this.getInt("NICKLEN");
	}

	/**
	 * `CHATHISTORY=<n>`: max messages per request. Undefined if the server does
	 * not advertise it; 0 means "no limit" per the draft spec.
	 */
	get chathistory(): number | undefined {
		return this.getInt("CHATHISTORY");
	}

	/**
	 * `EXTBAN=prefix,types`. nefarious2 spells the token `EXTBANS` on master
	 * and `EXTBAN` on the ircv3.2-upgrade branch; both are accepted.
	 */
	get extban(): ExtBanInfo | undefined {
		const value = this.get("EXTBAN") ?? this.get("EXTBANS");

		if (value === undefined) {
			return undefined;
		}

		const comma = value.indexOf(",");

		if (comma === -1) {
			return {prefix: "", types: value};
		}

		return {prefix: value.slice(0, comma), types: value.slice(comma + 1)};
	}

	/**
	 * `VAPID=<url-safe base64>`: the server's Web Push VAPID public key
	 * (draft/webpush). Advertised while the server has a key; the primary
	 * source is the cap's 302 value (see `webpushVapidOf`), this token is the
	 * spec's post-registration channel and arrives via 005.
	 */
	get vapid(): string | undefined {
		const value = this.get("VAPID");

		return value === undefined || value === "" ? undefined : value;
	}

	/** `BOT=<mode letter>`: the user mode marking bots. */
	get bot(): string | undefined {
		const value = this.get("BOT");

		return value === undefined || value === "" ? undefined : value;
	}

	/**
	 * `TARGMAX=CMD:n,...` as a map of uppercased command → limit; a command
	 * present with no number maps to undefined (unlimited).
	 */
	get targmax(): Map<string, number | undefined> {
		const result = new Map<string, number | undefined>();
		const value = this.get("TARGMAX");

		if (value === undefined || value === "") {
			return result;
		}

		for (const entry of value.split(",")) {
			if (entry.length === 0) {
				continue;
			}

			const colon = entry.indexOf(":");

			if (colon === -1) {
				result.set(entry.toUpperCase(), undefined);
				continue;
			}

			const limit = entry.slice(colon + 1);

			result.set(
				entry.slice(0, colon).toUpperCase(),
				/^\d+$/.test(limit) ? parseInt(limit, 10) : undefined
			);
		}

		return result;
	}

	/**
	 * Whether the server lets the client-only tag `tag` (`+name`) through,
	 * per `CLIENTTAGDENY` (message-tags § Client-only tags): a comma list of
	 * blocked names without their `+`, where a leading `*` blocks every one
	 * and `-name` then exempts one. A blocked tag is dropped by the server
	 * and the message still delivered, so senders leave it off instead.
	 */
	clientTagAllowed(tag: string): boolean {
		const value = this.get("CLIENTTAGDENY");

		if (!value) {
			return true;
		}

		const name = tag.startsWith("+") ? tag.slice(1) : tag;
		const entries = value.split(",").filter((entry) => entry.length > 0);

		if (entries[0] === "*") {
			return entries.includes(`-${name}`);
		}

		return !entries.includes(name);
	}
}
