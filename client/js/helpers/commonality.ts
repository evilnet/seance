/**
 * The channel card's "what most users have in common" (docs/projects/
 * oper-tools.md, "The channel card"): every user compared to every other
 * on the fields X3 can alert on — authed, connect age, realname, ident
 * shape, IP range, server, version — and a fact called common when at
 * least max(3, two thirds of the users) share it. Also the fold of the
 * kept feed into "last hour here". Pure functions over plain models, so
 * mocha covers them (test/helpers/commonality.ts).
 */

import type {LoggedNotice} from "../irc/noticelog";
import {t, tCount} from "../i18n/core";
import {andList} from "./operList";

export type FactKey =
	| "authed"
	| "connectAge"
	| "realname"
	| "identShape"
	| "ipRange"
	| "server"
	| "version";

/** What is known about one user, for the comparison. Unknown fields are left out. */
export interface CommonUser {
	nick: string;
	authed?: boolean;
	/** Epoch ms the connection was made. */
	connectedAt?: number;
	realname?: string;
	ident?: string;
	ip?: string;
	server?: string;
	version?: string;
}

export interface CommonFact {
	key: FactKey;
	/**
	 * The shared value as the alert builder wants it: `no`, `irc client`,
	 * the ident glob `r????`, `203.0.113.0/24`, the server, the version.
	 */
	value: string;
	/** In words: `not authed`, `connected < 15 min`, `ident r + 4 digits`, `203.0.113.*`. */
	label: string;
	count: number;
	nicks: string[];
}

export interface Commonality {
	total: number;
	/** How many must share a fact for it to count. */
	threshold: number;
	facts: CommonFact[];
	/** Users sharing every common fact. */
	sharingAll: string[];
	/** Users sharing none of them: the odd ones out. */
	sharingNone: string[];
}

/** Every digit becomes `#`, every letter `a`; anything else stays: `r8821` → `a####`. */
export function identShape(ident: string): string {
	return ident.replace(/[0-9]/g, "#").replace(/[A-Za-z]/g, "a");
}

/**
 * The literal glob for a group of idents of one shape: a character every
 * ident has in the same place is kept, the rest is `?`. `r8821`, `r1234`
 * → `r????`.
 */
export function identGlob(idents: string[]): string {
	const first = idents[0] ?? "";
	let out = "";

	for (let i = 0; i < first.length; i++) {
		const c = first[i];
		out += idents.every((id) => id[i] === c) ? c : "?";
	}

	return out;
}

/**
 * The shape in words, from one ident of the group and the group's glob:
 * `r8821` with `r????` → `r + 4 digits`; `ab12` with `??12` → `2 letters
 * + 12`; a run the glob only partly fixes is said with its glob.
 */
export function identShapeLabel(ident: string, glob: string): string {
	const parts: string[] = [];
	let i = 0;

	const classOf = (c: string) => (/[0-9]/.test(c) ? "digit" : /[A-Za-z]/.test(c) ? "letter" : "");

	while (i < ident.length) {
		const cls = classOf(ident[i]);

		if (cls === "") {
			parts.push(glob[i] ?? ident[i]);
			i++;
			continue;
		}

		let j = i;

		while (j < ident.length && classOf(ident[j]) === cls) {
			j++;
		}

		const run = glob.slice(i, j);
		const fixed = run.replace(/\?/g, "");

		if (fixed.length === run.length) {
			parts.push(run);
		} else if (fixed.length > 0) {
			parts.push(
				cls === "digit"
					? tCount("oper.investigate.identDigitsGlob", run.length, {glob: run})
					: tCount("oper.investigate.identLettersGlob", run.length, {glob: run})
			);
		} else {
			parts.push(
				cls === "digit"
					? tCount("oper.investigate.identDigits", run.length)
					: tCount("oper.investigate.identLetters", run.length)
			);
		}

		i = j;
	}

	return parts.join(" + ");
}

export type AgeBucket = "< 15 min" | "< 1 h" | "< 1 d" | "> 1 d";

/** How long ago a connection was made, in four buckets. */
export function connectAgeBucket(connectedAt: number, now: number): AgeBucket {
	const age = now - connectedAt;

	if (age < 15 * 60_000) {
		return "< 15 min";
	}

	if (age < 60 * 60_000) {
		return "< 1 h";
	}

	if (age < 24 * 60 * 60_000) {
		return "< 1 d";
	}

	return "> 1 d";
}

/** `connected < 15 min`: a connect-age bucket as the channel card's chip says it. */
function connectedLabel(bucket: AgeBucket): string {
	switch (bucket) {
		case "< 15 min":
			return t("oper.investigate.fact.connectedUnder15m");
		case "< 1 h":
			return t("oper.investigate.fact.connectedUnder1h");
		case "< 1 d":
			return t("oper.investigate.fact.connectedUnder1d");
		default:
			return t("oper.investigate.fact.connectedOver1d");
	}
}

/** The /24 of an IPv4 or the /64 of an IPv6, as a CIDR, and as people say it (`203.0.113.*`). */
export function ipRange(ip: string): {cidr: string; label: string} | undefined {
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);

	if (v4) {
		return {cidr: `${v4[1]}.${v4[2]}.${v4[3]}.0/24`, label: `${v4[1]}.${v4[2]}.${v4[3]}.*`};
	}

	if (ip.includes(":")) {
		const groups = expandV6(ip);

		if (groups) {
			const head = groups.slice(0, 4).join(":");
			return {cidr: `${head}::/64`, label: `${head}:*`};
		}
	}

	return undefined;
}

/** The eight groups of an IPv6 address, `::` expanded; undefined when it is not one. */
export function expandV6(ip: string): string[] | undefined {
	const halves = ip.split("::");

	if (halves.length > 2) {
		return undefined;
	}

	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - left.length - right.length;

	if (missing < 0 || (halves.length === 1 && missing !== 0)) {
		return undefined;
	}

	const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
	return groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))
		? groups.map((g) => g.toLowerCase())
		: undefined;
}

interface Candidate {
	key: FactKey;
	group: string;
	value: string;
	label: string;
}

/** The comparable facts of one user, one per key it is known for. */
function candidates(user: CommonUser, now: number): Candidate[] {
	const out: Candidate[] = [];

	if (user.authed !== undefined) {
		out.push({
			key: "authed",
			group: user.authed ? "yes" : "no",
			value: user.authed ? "yes" : "no",
			label: user.authed
				? t("oper.investigate.fact.authed")
				: t("oper.investigate.fact.notAuthed"),
		});
	}

	if (user.connectedAt !== undefined) {
		const bucket = connectAgeBucket(user.connectedAt, now);
		out.push({key: "connectAge", group: bucket, value: bucket, label: connectedLabel(bucket)});
	}

	if (user.realname !== undefined && user.realname !== "") {
		out.push({
			key: "realname",
			group: user.realname.toLowerCase(),
			value: user.realname,
			label: t("oper.investigate.fact.realname", {realname: user.realname}),
		});
	}

	if (user.ident) {
		const shape = identShape(user.ident);
		out.push({key: "identShape", group: shape, value: user.ident, label: shape});
	}

	if (user.ip) {
		const range = ipRange(user.ip);

		if (range) {
			out.push({key: "ipRange", group: range.cidr, value: range.cidr, label: range.label});
		}
	}

	if (user.server) {
		out.push({
			key: "server",
			group: user.server.toLowerCase(),
			value: user.server,
			label: t("oper.investigate.fact.server", {server: user.server}),
		});
	}

	if (user.version) {
		out.push({
			key: "version",
			group: user.version,
			value: user.version,
			label: t("oper.investigate.fact.version", {version: user.version}),
		});
	}

	return out;
}

const KEY_ORDER: FactKey[] = [
	"authed",
	"connectAge",
	"realname",
	"identShape",
	"ipRange",
	"server",
	"version",
];

/**
 * What most of `users` have in common: for each key, the largest group of
 * one value, when at least `threshold` users are in it. With fewer than
 * three users nothing is common.
 */
export function commonality(users: CommonUser[], now = Date.now(), min = 3): Commonality {
	const total = users.length;
	const threshold = Math.max(min, Math.ceil((total * 2) / 3));
	const facts: CommonFact[] = [];
	const perUser = new Map<string, Candidate[]>();

	for (const user of users) {
		perUser.set(user.nick, candidates(user, now));
	}

	for (const key of KEY_ORDER) {
		const groups = new Map<string, {nicks: string[]; values: string[]; label: string}>();

		for (const user of users) {
			const c = perUser.get(user.nick)?.find((x) => x.key === key);

			if (!c) {
				continue;
			}

			const g = groups.get(c.group) ?? {nicks: [], values: [], label: c.label};
			g.nicks.push(user.nick);
			g.values.push(c.value);
			groups.set(c.group, g);
		}

		let best: {group: string; nicks: string[]; values: string[]; label: string} | undefined;

		for (const [group, g] of groups) {
			if (!best || g.nicks.length > best.nicks.length) {
				best = {group, ...g};
			}
		}

		if (!best || best.nicks.length < threshold) {
			continue;
		}

		if (key === "identShape") {
			const glob = identGlob(best.values);
			facts.push({
				key,
				value: glob,
				label: t("oper.investigate.fact.ident", {
					shape: identShapeLabel(best.values[0], glob),
				}),
				count: best.nicks.length,
				nicks: best.nicks,
			});
			continue;
		}

		facts.push({
			key,
			value: best.values[0],
			label: best.label,
			count: best.nicks.length,
			nicks: best.nicks,
		});
	}

	const sharingAll: string[] = [];
	const sharingNone: string[] = [];

	if (facts.length > 0) {
		for (const user of users) {
			const shared = facts.filter((f) => f.nicks.includes(user.nick)).length;

			if (shared === facts.length) {
				sharingAll.push(user.nick);
			} else if (shared === 0) {
				sharingNone.push(user.nick);
			}
		}
	}

	return {total, threshold, facts, sharingAll, sharingNone};
}

// ------------------------------------------------------- last hour here

export interface ChannelEvent {
	time: number;
	/** `a, b and c joined`, `d left (bye)`, `e kicked f`, `+m by g`. */
	text: string;
	/** `join`, `part`, `kick`, `mode`, `create`. */
	kind: string;
}

const FOLD_MS = 60_000;

/**
 * The kept feed's snoop lines about `channel` within the last hour, as
 * sentences, oldest first; consecutive joins within a minute are folded
 * into one ("a, b and c joined").
 */
export function lastHourHere(
	entries: LoggedNotice[],
	channel: string,
	now = Date.now()
): ChannelEvent[] {
	const wanted = channel.toLowerCase();
	const since = now - 60 * 60_000;
	const out: ChannelEvent[] = [];
	let joins: {time: number; nicks: string[]} | undefined;

	const flushJoins = () => {
		if (joins) {
			out.push({
				time: joins.time,
				kind: "join",
				text: tCount("oper.investigate.lastHour.joined", joins.nicks.length, {
					nicks: andList(joins.nicks),
				}),
			});
			joins = undefined;
		}
	};

	for (const entry of entries) {
		if (entry.type !== "snoop" || entry.time < since) {
			continue;
		}

		const f = entry.snotice.fields;

		if ((f.channel ?? "").toLowerCase() !== wanted) {
			continue;
		}

		const keyword = entry.snotice.kind.split(".").pop() ?? "";

		if (keyword === "join" || keyword === "create") {
			if (joins && entry.time - joins.time <= FOLD_MS) {
				joins.nicks.push(f.nick);
			} else {
				flushJoins();
				joins = {time: entry.time, nicks: [f.nick]};
			}

			if (keyword === "create") {
				flushJoins();
				out[out.length - 1].kind = "create";
				out[out.length - 1].text = t("oper.investigate.lastHour.created", {nick: f.nick});
			}

			continue;
		}

		flushJoins();

		switch (keyword) {
			case "part":
				out.push({
					time: entry.time,
					kind: "part",
					text: f.reason
						? t("oper.investigate.lastHour.leftReason", {
								nick: f.nick,
								reason: f.reason,
						  })
						: t("oper.investigate.lastHour.left", {nick: f.nick}),
				});
				break;
			case "kick":
				out.push({
					time: entry.time,
					kind: "kick",
					text: t("oper.investigate.lastHour.kicked", {kicker: f.kicker, nick: f.nick}),
				});
				break;
			case "mode":
				out.push({
					time: entry.time,
					kind: "mode",
					text: t("oper.investigate.lastHour.mode", {modes: f.modes, setter: f.setter}),
				});
				break;
			default:
				break;
		}
	}

	flushJoins();
	return out;
}

/**
 * When each nick connected, from the kept feed: the snoop connect line or
 * the server's connect notice, the newest per nick (lower-cased).
 */
export function connectTimes(entries: LoggedNotice[]): Map<string, number> {
	const out = new Map<string, number>();

	for (const entry of entries) {
		const kind = entry.snotice.kind;

		if (
			(entry.type === "snoop" && kind.endsWith(".snoop.connect")) ||
			(entry.type === "snotice" && kind === "client.connect")
		) {
			const nick = (entry.snotice.fields.nick ?? "").toLowerCase();

			if (nick) {
				out.set(nick, entry.time);
			}
		}
	}

	return out;
}

/** When each nick joined `channel`, from the kept feed (the newest join per nick). */
export function joinTimes(entries: LoggedNotice[], channel: string): Map<string, number> {
	const wanted = channel.toLowerCase();
	const out = new Map<string, number>();

	for (const entry of entries) {
		const kind = entry.snotice.kind;

		if (
			entry.type === "snoop" &&
			(kind.endsWith(".snoop.join") || kind.endsWith(".snoop.create")) &&
			(entry.snotice.fields.channel ?? "").toLowerCase() === wanted
		) {
			out.set((entry.snotice.fields.nick ?? "").toLowerCase(), entry.time);
		}
	}

	return out;
}
