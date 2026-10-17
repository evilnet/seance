/**
 * The user card's judgement (docs/projects/oper-tools.md, "The user
 * card"): which bans cover a user — the live list from STATS, and the
 * recent ones the kept feed saw — what else in the feed shares their IP,
 * host, realname or account ("seen before"), and the one sentence that
 * names what matched and never more than the data shows. Pure functions
 * over `LoggedNotice[]` and plain models, so mocha covers them
 * (test/helpers/verdict.ts).
 */

import type {LoggedNotice} from "../irc/noticelog";
import {expandV6} from "./commonality";
import {compareWithWildcard} from "../irc/hostmask";
import type {LiveBan} from "../irc/profiles/nefarious/stats";

/** Who the card is about, as far as it knows. */
export interface Identity {
	nick: string;
	ident?: string;
	host?: string;
	ip?: string;
	realname?: string;
	account?: string;
	version?: string;
}

// ------------------------------------------------------------ masks

function ipv4(ip: string): number | undefined {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);

	if (!m) {
		return undefined;
	}

	const parts = m.slice(1).map(Number);
	return parts.some((p) => p > 255)
		? undefined
		: ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** An IPv4 or IPv6 address as a number and its width in bits. */
function ipBits(ip: string): {value: bigint; width: number} | undefined {
	const v4 = ipv4(ip);

	if (v4 !== undefined) {
		return {value: BigInt(v4), width: 32};
	}

	const groups = expandV6(ip);
	return groups
		? {value: BigInt(`0x${groups.map((g) => g.padStart(4, "0")).join("")}`), width: 128}
		: undefined;
}

/** Whether `ip` is inside `cidr` (`a.b.c.d/n` or `v6::/n`), the same family only. */
export function ipInCidr(ip: string, cidr: string): boolean {
	const m = /^(.+)\/(\d{1,3})$/.exec(cidr);

	if (!m) {
		return false;
	}

	const bits = Number(m[2]);
	const a = ipBits(ip);
	const b = ipBits(m[1]);

	if (!a || !b || a.width !== b.width || bits > a.width) {
		return false;
	}

	const shift = BigInt(a.width - bits);
	return a.value >> shift === b.value >> shift;
}

/**
 * Whether a ban mask (`user@host`, `*@ip`, `*@1.2.3.0/24`, `$Rrealname`,
 * `$Vversion`; a bare host means `*@host`) covers `user`. A part the user
 * is not known by cannot match unless the mask leaves it open.
 */
export function maskCovers(mask: string, user: Identity): boolean {
	if (mask.startsWith("$R")) {
		return user.realname !== undefined && compareWithWildcard(mask.slice(2), user.realname);
	}

	if (mask.startsWith("$V")) {
		return user.version !== undefined && compareWithWildcard(mask.slice(2), user.version);
	}

	if (/^[#&]/.test(mask)) {
		return false;
	}

	const at = mask.lastIndexOf("@");
	const userPart = at === -1 ? "*" : mask.slice(0, at);
	const hostPart = at === -1 ? mask : mask.slice(at + 1);

	if (userPart !== "*") {
		if (user.ident === undefined || !compareWithWildcard(userPart, user.ident)) {
			return false;
		}
	}

	if (hostPart === "*") {
		return true;
	}

	if (user.ip && (compareWithWildcard(hostPart, user.ip) || ipInCidr(user.ip, hostPart))) {
		return true;
	}

	// A host that is a bare IP (no reverse DNS; snoop quit/kill lines carry no IP field)
	return (
		user.host !== undefined &&
		(compareWithWildcard(hostPart, user.host) || ipInCidr(user.host, hostPart))
	);
}

// ------------------------------------------------------------- bans

export interface BanNear {
	type: string;
	mask: string;
	/** The oper who set it, when the feed saw it happen. */
	by?: string;
	/** Epoch ms it was set (the feed's notice, or the server's last change). */
	setAt?: number;
	/** Epoch ms; 0 for never; undefined when unknown. */
	expiresAt?: number;
	reason: string;
	live: boolean;
}

/** The `ban.*` notices about `mask` (exact, case-insensitive), newest first. */
function banNotices(feed: LoggedNotice[], mask: string): LoggedNotice[] {
	const wanted = mask.toLowerCase();
	return feed
		.filter(
			(e) =>
				e.type === "snotice" &&
				e.snotice.kind.startsWith("ban.") &&
				e.snotice.kind !== "ban.hit" &&
				(e.snotice.fields.mask ?? "").toLowerCase() === wanted
		)
		.reverse();
}

/**
 * The bans near a user: the live G-lines, shuns and Z-lines whose mask
 * covers them, then the recently changed ones the feed saw (added,
 * removed, lapsed) that cover them and are not live any more. The setter
 * comes from the feed when it saw the ban being set.
 */
export function bansNear(
	live: LiveBan[],
	feed: LoggedNotice[],
	user: Identity,
	now = Date.now()
): {live: BanNear[]; recent: BanNear[]} {
	const out = {live: [] as BanNear[], recent: [] as BanNear[]};
	const seen = new Set<string>();

	for (const ban of live) {
		if (!maskCovers(ban.mask, user)) {
			continue;
		}

		const key = ban.mask.toLowerCase();
		seen.add(key);
		const notice = banNotices(feed, ban.mask).find((e) => e.snotice.kind === "ban.add");
		const entry: BanNear = {
			type: ban.type,
			mask: ban.mask,
			reason: ban.reason,
			live: ban.active && (ban.expiresAt === 0 || ban.expiresAt > now),
			expiresAt: ban.expiresAt,
		};

		if (notice) {
			entry.by = notice.snotice.fields.oper ?? notice.snotice.fields.server;
			entry.setAt = notice.time;
		} else if (ban.lastModAt !== undefined) {
			entry.setAt = ban.lastModAt;
		}

		(entry.live ? out.live : out.recent).push(entry);
	}

	for (const e of [...feed].reverse()) {
		if (
			e.type !== "snotice" ||
			!e.snotice.kind.startsWith("ban.") ||
			e.snotice.kind === "ban.hit"
		) {
			continue;
		}

		const f = e.snotice.fields;
		const mask = f.mask ?? "";
		const key = mask.toLowerCase();

		if (!mask || seen.has(key) || !maskCovers(mask, user)) {
			continue;
		}

		seen.add(key);
		const expires = f.expires ? Number(f.expires) * 1000 : undefined;
		const entry: BanNear = {
			type: f.type ?? "G-line",
			mask,
			reason: f.reason ?? "",
			live: false,
			setAt: e.time,
		};

		if (f.oper ?? f.server) {
			entry.by = f.oper ?? f.server;
		}

		if (expires !== undefined && Number.isFinite(expires)) {
			entry.expiresAt = expires;
		}

		out.recent.push(entry);
	}

	return out;
}

// ------------------------------------------------------ seen before

export type Matched = "ip" | "host" | "realname" | "account";

export interface SeenEntry {
	nick: string;
	/** The newest sighting, epoch ms. */
	time: number;
	matched: Matched[];
	ip?: string;
	host?: string;
	ident?: string;
	realname?: string;
	account?: string;
	/** What happened to them, when the feed says: `G-lined by rubin`, `killed by X`. */
	fate?: string;
}

/** The identity a feed entry describes, when it describes one. */
function identityOf(entry: LoggedNotice): Identity | undefined {
	const f = entry.snotice.fields;
	const kind = entry.snotice.kind;

	if (entry.type === "snoop") {
		const keyword = kind.split(".").pop();

		if (!["connect", "quit", "kill", "oper", "auth"].includes(keyword ?? "") || !f.nick) {
			return undefined;
		}

		const id: Identity = {nick: f.nick};

		if (f.ident) {
			id.ident = f.ident;
		}

		if (f.host) {
			id.host = f.host;
		}

		if (f.ip) {
			id.ip = f.ip;
		}

		if (f.account) {
			id.account = f.account;
		}

		return id;
	}

	if (entry.type !== "snotice" || !f.nick) {
		return undefined;
	}

	if (
		![
			"client.connect",
			"client.exit",
			"nick.change",
			"ban.hit",
			"kill.oper",
			"kill.server",
			"oper.up",
		].includes(kind)
	) {
		return undefined;
	}

	const id: Identity = {nick: f.nick};

	if (f.user) {
		id.ident = f.user;
	}

	if (f.host) {
		id.host = f.host.includes("@") ? f.host.slice(f.host.indexOf("@") + 1) : f.host;
	}

	if (f.ip) {
		id.ip = f.ip;
	}

	if (f.realname) {
		id.realname = f.realname;
	}

	return id;
}

function same(a: string | undefined, b: string | undefined): boolean {
	return a !== undefined && b !== undefined && a !== "" && a.toLowerCase() === b.toLowerCase();
}

/** The fate of a nick the feed records: banned, killed. */
function fateOf(feed: LoggedNotice[], who: Identity): string | undefined {
	for (const e of [...feed].reverse()) {
		const f = e.snotice.fields;
		const kind = e.snotice.kind;

		if (e.type === "snotice") {
			if (kind === "ban.add" && f.mask && maskCovers(f.mask, who)) {
				const verb = f.type === "shun" ? "shunned" : `${f.type ?? "G-line"}d`;
				const reason = f.reason ? ` for '${f.reason}'` : "";
				return `${verb} by ${f.oper ?? f.server ?? "a server"}${reason}`;
			}

			if (kind === "kill.oper" && same(f.nick, who.nick)) {
				return `killed by ${f.killer}`;
			}

			if (kind === "ban.hit" && same(f.nick, who.nick)) {
				return `hit a ${f.type ?? "G-line"}`;
			}
		} else if (e.type === "snoop" && kind.endsWith(".snoop.kill") && same(f.nick, who.nick)) {
			return `killed by ${f.killer}`;
		} else if (e.type === "audit" && kind.endsWith(".audit.glines") && e.from) {
			const mask = (f.args ?? "").split(/\s+/)[0] ?? "";

			if (mask && (f.command === "gline" || f.command === "shun") && maskCovers(mask, who)) {
				return `${f.command === "shun" ? "shunned" : "G-lined"} by ${e.from}`;
			}
		}
	}

	return undefined;
}

/**
 * Whether a feed entry under the user's own nick is the user themself —
 * their own connect, quit or auth line — rather than an earlier session of
 * the nick from somewhere else: it is them unless the entry's IP (or,
 * without one, its host) is known and differs.
 */
function isThemself(id: Identity, user: Identity): boolean {
	if (id.ip && user.ip) {
		return same(id.ip, user.ip);
	}

	if (id.host && user.host) {
		return same(id.host, user.host);
	}

	return true;
}

/**
 * Everyone in the kept feed sharing `user`'s IP, host, realname or
 * account, grouped by nick, newest first, each with what matched and what
 * became of them. The user's own lines — their nick (by the network's
 * casemapping when `sameNick` is given) from their own IP or host — are
 * not sightings: a previous session of the same nick from elsewhere is.
 */
export function seenBefore(
	feed: LoggedNotice[],
	user: Identity,
	sameNick: (a: string, b: string) => boolean = (a, b) => a.toLowerCase() === b.toLowerCase()
): SeenEntry[] {
	const groups = new Map<string, SeenEntry>();

	for (const entry of feed) {
		const id = identityOf(entry);

		if (!id || (sameNick(id.nick, user.nick) && isThemself(id, user))) {
			continue;
		}

		const matched: Matched[] = [];

		if (same(id.ip, user.ip)) {
			matched.push("ip");
		}

		if (same(id.host, user.host)) {
			matched.push("host");
		}

		if (same(id.realname, user.realname)) {
			matched.push("realname");
		}

		if (same(id.account, user.account)) {
			matched.push("account");
		}

		if (matched.length === 0) {
			continue;
		}

		const key = id.nick.toLowerCase();
		const existing = groups.get(key);

		if (existing) {
			existing.time = Math.max(existing.time, entry.time);

			for (const m of matched) {
				if (!existing.matched.includes(m)) {
					existing.matched.push(m);
				}
			}

			existing.ip ??= id.ip;
			existing.host ??= id.host;
			existing.ident ??= id.ident;
			existing.realname ??= id.realname;
			existing.account ??= id.account;
			continue;
		}

		const seen: SeenEntry = {nick: id.nick, time: entry.time, matched};

		if (id.ip) {
			seen.ip = id.ip;
		}

		if (id.host) {
			seen.host = id.host;
		}

		if (id.ident) {
			seen.ident = id.ident;
		}

		if (id.realname) {
			seen.realname = id.realname;
		}

		if (id.account) {
			seen.account = id.account;
		}

		groups.set(key, seen);
	}

	const out = [...groups.values()];

	for (const seen of out) {
		const fate = fateOf(feed, seen);

		if (fate) {
			seen.fate = fate;
		}
	}

	return out.sort((a, b) => b.time - a.time);
}

// ---------------------------------------------------------- verdict

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `21:14` today, else the bare day (`Tue`), else the date for anything a week old. */
export function whenText(time: number, now = Date.now()): string {
	const d = new Date(time);
	const today = new Date(now);
	const sameDay =
		d.getFullYear() === today.getFullYear() &&
		d.getMonth() === today.getMonth() &&
		d.getDate() === today.getDate();

	if (sameDay) {
		return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
			2,
			"0"
		)}`;
	}

	if (now - time < 6 * 24 * 60 * 60_000) {
		return DAYS[d.getDay()];
	}

	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
		d.getDate()
	).padStart(2, "0")}`;
}

function ago(time: number, now: number): string {
	const s = Math.max(0, Math.round((now - time) / 1000));

	if (s < 60) {
		return `${s} s ago`;
	}

	if (s < 3600) {
		return `${Math.round(s / 60)} min ago`;
	}

	if (s < 86400) {
		return `${Math.round(s / 3600)} h ago`;
	}

	return `${Math.round(s / 86400)} d ago`;
}

function sameIdentShape(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) {
		return false;
	}

	const shape = (s: string) => s.replace(/[0-9]/g, "#").replace(/[A-Za-z]/g, "a");
	return shape(a) === shape(b);
}

export interface VerdictInput {
	user: Identity;
	liveBans: BanNear[];
	seen: SeenEntry[];
	now?: number;
}

/**
 * One sentence from the bans and the sightings: a live ban covering them;
 * else a sighting under another nick sharing the IP, or the host and the
 * realname, with everything that matched named; else a weaker overlap
 * said as such; else that nothing in the kept feed shares anything.
 */
export function verdict(input: VerdictInput): string {
	const now = input.now ?? Date.now();
	const {user} = input;
	const live = input.liveBans[0];

	if (live) {
		const by = live.by ? live.by : undefined;
		const when = live.setAt !== undefined ? ago(live.setAt, now) : undefined;
		const detail = [by, when].filter(Boolean).join(", ");
		return `Covered by a live ${live.type}: ${live.mask}${detail ? ` (${detail})` : ""}.`;
	}

	const others = input.seen.filter((s) => s.nick.toLowerCase() !== user.nick.toLowerCase());
	const strong = others.find(
		(s) =>
			s.matched.includes("ip") ||
			(s.matched.includes("host") && s.matched.includes("realname"))
	);

	if (strong) {
		const what = strong.matched.map((m) => `same ${m === "ip" ? "IP" : m}`);

		if (sameIdentShape(strong.ident, user.ident)) {
			what.push("same ident shape");
		}

		// `G-lined by rubin for 'x'` → `G-lined then by rubin for 'x'`.
		const fate = strong.fate
			? `; ${strong.fate.replace(/^(\S+(?: a \S+)?) /, "$1 then ")}`
			: "";
		return `Likely the same as ${strong.nick} (${whenText(strong.time, now)}): ${what.join(
			", "
		)}${fate}.`;
	}

	const weak = others[0];

	if (weak) {
		const what = weak.matched.map((m) => `the ${m === "ip" ? "IP" : m}`);
		return `Nothing conclusive: ${weak.nick} (${whenText(weak.time, now)}) shares ${what.join(
			" and "
		)}${weak.fate ? `, and was ${weak.fate}` : ""}.`;
	}

	// The nick itself, seen from somewhere else (seenBefore keeps that; the
	// user's own lines it leaves out): said as such, never as "the same as".
	const elsewhere = input.seen[0];

	if (elsewhere) {
		const where = elsewhere.ip ?? elsewhere.host ?? "another address";
		return `Nothing conclusive: the nick was seen from ${where} (${whenText(
			elsewhere.time,
			now
		)})${elsewhere.fate ? `, and was ${elsewhere.fate}` : ""}.`;
	}

	return "No bans cover them and nothing in the kept feed shares their IP, host or realname.";
}
