/**
 * A network's channel list as the client holds it (`IrcClient.channelList`):
 * fed by `handlers/list.ts` (321/322/323/334 and nefarious2's "wait N
 * seconds" notice), read by the channel browser through the `channel:list`
 * bus event. One LIST is the whole answer, so the rows are kept and filtered
 * on the device; the UI asks again only when they are stale.
 *
 * Also the featured channels, which a network puts forward to newcomers by
 * either or both of two routes: an ISUPPORT token, `FEATURED=#help,#lounge`
 * (names only; it arrives with 005, before the MOTD and at no cost), and the
 * MOTD, where a line of exactly two spaces, a channel name and, after a gap,
 * a blurb — `  #help  Questions about the network` — names one and says why.
 * The token orders the cards; the MOTD adds its blurbs and any channel the
 * token left out.
 */

import type {
	ChannelListEntry,
	ChannelListStatus,
	FeaturedChannel,
	SharedChannelList,
} from "../../../shared/types/channel-list";

/** How often a list under way reports its count (every N rows). */
export const PROGRESS_EVERY = 50;

/** Below this many users a row never counts as "busy" in the browser. */
export const BUSY_USERS = 10;

/** After this long the browser asks again on opening. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** A refresh by hand waits this long after the last answer. */
export const REFRESH_AFTER_MS = 30 * 1000;

const DELAY_NOTICE = /not been connected long enough to use \/list\. You must wait (\d+) seconds?/i;

/** nefarious2's LISTDELAY notice: the seconds it names, or nothing. */
export function listDelayOf(notice: string): number | undefined {
	const m = DELAY_NOTICE.exec(notice);
	return m ? parseInt(m[1], 10) : undefined;
}

/**
 * The featured channels of a MOTD: every line that is exactly two spaces,
 * a channel name (a CHANTYPES prefix, no comma) and optionally a gap of two
 * spaces or more, or ` - `, `–`, `—` or `:` set off by spaces, and a blurb.
 * One space, three or none is not a marker, so an indented paragraph or a
 * banner's art is left alone. A channel named twice keeps its first line.
 */
export function parseFeaturedChannels(lines: string[], chantypes: string): FeaturedChannel[] {
	const types = chantypes
		.split("")
		.map((c) => c.replace(/[\\\]^-]/g, "\\$&"))
		.join("");
	const marker = new RegExp(
		`^ {2}([${types}][^\\s,]*[^\\s,:])(?:(?: {2,}| +[-–—:] +|: +)(.*))?\\s*$`
	);
	const seen = new Set<string>();
	const out: FeaturedChannel[] = [];

	for (const raw of lines) {
		// ircu-family servers may prefix every MOTD line with "- ".
		const m = marker.exec(raw.startsWith("- ") ? raw.slice(2) : raw);

		if (!m) {
			continue;
		}

		const key = m[1].toLowerCase();

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		out.push({name: m[1], blurb: (m[2] ?? "").trim()});
	}

	return out;
}

/**
 * The featured channels of the ISUPPORT token: channel names (a CHANTYPES
 * prefix, no space) separated by commas, in the server's order, each kept
 * once. Anything else in the list is skipped. No blurbs: a 005 line has no
 * room for them, and the list's topic or the MOTD's line supplies one.
 */
export function parseFeaturedToken(value: string, chantypes: string): FeaturedChannel[] {
	const seen = new Set<string>();
	const out: FeaturedChannel[] = [];

	for (const raw of value.split(",")) {
		const name = raw.trim();
		const key = name.toLowerCase();

		if (name.length < 2 || !chantypes.includes(name[0]) || /\s/.test(name) || seen.has(key)) {
			continue;
		}

		seen.add(key);
		out.push({name, blurb: ""});
	}

	return out;
}

/**
 * The two routes as one list: the token's channels first, in its order, each
 * with the MOTD's blurb when the MOTD names it too, then the MOTD's other
 * channels. A name is matched case-insensitively and keeps the token's spelling.
 */
export function mergeFeatured(
	fromToken: FeaturedChannel[],
	fromMotd: FeaturedChannel[]
): FeaturedChannel[] {
	const blurbs = new Map(fromMotd.map((f) => [f.name.toLowerCase(), f]));
	const out = fromToken.map((f) => ({
		name: f.name,
		blurb: blurbs.get(f.name.toLowerCase())?.blurb ?? f.blurb,
	}));
	const named = new Set(fromToken.map((f) => f.name.toLowerCase()));

	for (const f of fromMotd) {
		if (!named.has(f.name.toLowerCase())) {
			out.push({...f});
		}
	}

	return out;
}

export class ChannelList {
	status: ChannelListStatus = "idle";
	rows: ChannelListEntry[] = [];
	at = 0;
	waitSeconds = 0;
	/** When the delay the server named is over (ms since the epoch). */
	delayedUntil = 0;
	note = "";
	/** From the ISUPPORT token (005). */
	featuredFromToken: FeaturedChannel[] = [];
	/** From the MOTD's marker lines. */
	featuredFromMotd: FeaturedChannel[] = [];
	private incoming: ChannelListEntry[] = [];

	/** Both routes merged ({@link mergeFeatured}): what the browser shows. */
	get featured(): FeaturedChannel[] {
		return mergeFeatured(this.featuredFromToken, this.featuredFromMotd);
	}

	get loaded(): number {
		return this.incoming.length;
	}

	/** A new connection: the old rows stay as a cache, everything else starts over. */
	reset(): void {
		this.status = this.rows.length ? "done" : "idle";
		this.incoming = [];
		this.waitSeconds = 0;
		this.delayedUntil = 0;
		this.note = "";
	}

	/** Whether asking now would be refused or pointless. */
	get busy(): boolean {
		return (
			this.status === "loading" ||
			(this.status === "delayed" && Date.now() < this.delayedUntil)
		);
	}

	/** A LIST is being sent. */
	start(): void {
		this.status = "loading";
		this.incoming = [];
		this.note = "";
	}

	/** 321: the server begins its answer (to our LIST, or one a script sent). */
	begin(): void {
		if (this.status === "delayed") {
			return; // the empty 321/323 pair that follows the notice
		}

		this.start();
	}

	/** 322. Returns true when the count is worth reporting. */
	add(entry: ChannelListEntry): boolean {
		if (this.status !== "loading") {
			return false;
		}

		this.incoming.push(entry);
		return this.incoming.length % PROGRESS_EVERY === 0;
	}

	/** 323: the answer is complete. */
	end(now = Date.now()): void {
		if (this.status === "delayed") {
			return;
		}

		if (this.status !== "loading") {
			return; // the 323 that aborts a listing we did not start
		}

		this.rows = this.incoming.sort((a, b) => b.users - a.users || a.name.localeCompare(b.name));
		this.incoming = [];
		this.at = now;
		this.status = "done";
	}

	/** The server's "wait N seconds" notice. */
	delay(seconds: number, now = Date.now()): void {
		this.status = "delayed";
		this.waitSeconds = seconds;
		this.delayedUntil = now + seconds * 1000;
		this.incoming = [];
	}

	/** 334: the arguments were refused; the usage lines are the note. */
	fail(line: string): void {
		this.status = "error";
		this.incoming = [];
		this.note = this.note ? `${this.note}\n${line}` : line;
	}

	/** The connection dropped mid-list. */
	abort(): void {
		if (this.status === "loading") {
			this.status = this.rows.length ? "done" : "idle";
			this.incoming = [];
		}
	}

	snapshot(): SharedChannelList {
		return {
			status: this.status,
			rows: this.rows,
			at: this.at,
			loaded: this.loaded,
			waitSeconds: this.waitSeconds,
			note: this.note,
			featured: this.featured,
		};
	}
}
