/**
 * A network's channel list as the client holds it (`IrcClient.channelList`):
 * fed by `handlers/list.ts` (321/322/323/334 and nefarious2's "wait N
 * seconds" notice), read by the channel browser through the `channel:list`
 * bus event. One LIST is the whole answer, so the rows are kept and filtered
 * on the device; the UI asks again only when they are stale.
 *
 * Also the MOTD's featured channels: a line of exactly two spaces, a channel
 * name and, after a gap, a blurb — `  #help  Questions about the network` —
 * which a network writes to put a channel forward to newcomers.
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

export class ChannelList {
	status: ChannelListStatus = "idle";
	rows: ChannelListEntry[] = [];
	at = 0;
	waitSeconds = 0;
	/** When the delay the server named is over (ms since the epoch). */
	delayedUntil = 0;
	note = "";
	featured: FeaturedChannel[] = [];
	private incoming: ChannelListEntry[] = [];

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
