/**
 * Channel ban masks as the Bans window and the ban dialog handle them: what a
 * typed mask becomes on the server, which masks to offer for a person, who a
 * mask catches, and how bans cover one another. docs/resources/client-features.md
 * § Channel bans.
 *
 * Vue-free (test/helpers/channelBans.ts).
 */

import {t} from "../i18n/core";
import {compareWithWildcard} from "../irc/hostmask";
import type {IrcMessage} from "../irc/message";
import type {BanEntry} from "../../../shared/types/ban-list";
import {maskCovers} from "./verdict";

/** What is known of someone a ban could catch. */
export interface BanTarget {
	nick?: string;
	ident?: string;
	/** The host others see, a cloak included. */
	host?: string;
	/** The real IP: an oper's WHO shows it, nobody else's does. */
	ip?: string;
	account?: string;
	realname?: string;
}

export interface MaskSuggestion {
	mask: string;
	label: string;
}

export type BanSort = "newest" | "oldest" | "mask" | "setter";

/** More people than this are not kicked from the dialog: each KICK is 2 s of fake lag. */
export const KICK_LIMIT = 8;

/** `~a:bob`, `~q:~a:bob`, `~!r:*bot*`: an ident may start with `~` too. */
export function isExtendedBan(mask: string): boolean {
	return /^~!?[a-zA-Z]:/.test(mask.trim());
}

/**
 * A typed mask as the server will store it (`pretty_mask`): `bob` is
 * `bob!*@*`, `host.name` is `*!*@host.name`, `user@host` is `*!user@host`.
 * An extended ban is left as it is.
 */
export function normaliseBanMask(raw: string): string {
	const mask = raw.trim();

	if (mask === "" || isExtendedBan(mask)) {
		return mask;
	}

	const bang = mask.indexOf("!");

	if (bang !== -1) {
		const rest = mask.slice(bang + 1);
		const at = rest.lastIndexOf("@");
		const nick = mask.slice(0, bang) || "*";
		return at === -1
			? `${nick}!${rest || "*"}@*`
			: `${nick}!${rest.slice(0, at) || "*"}@${rest.slice(at + 1) || "*"}`;
	}

	const at = mask.lastIndexOf("@");

	if (at !== -1) {
		return `*!${mask.slice(0, at) || "*"}@${mask.slice(at + 1) || "*"}`;
	}

	return /[.:]/.test(mask) ? `*!*@${mask}` : `${mask}!*@*`;
}

/** Why a typed mask cannot go on a MODE line, if it cannot. */
export function checkBanMask(raw: string): string | undefined {
	const mask = raw.trim();

	if (mask === "") {
		return t("ban.check.empty");
	}

	return /\s/.test(mask) || mask.startsWith(":") ? t("ban.check.invalid") : undefined;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/;

/**
 * The host with its first part open: the provider, for a cloak or a reverse
 * name, the /24 for an address. Nothing when that would be too much: an IPv6
 * address, a name of two labels, or `account.users.example.org`, where the
 * rest is everyone who has logged in.
 */
export function wideHost(host: string | undefined, account?: string): string | undefined {
	if (!host || host.includes(":")) {
		return undefined;
	}

	const v4 = IPV4.exec(host);

	if (v4) {
		return `${v4[1]}.${v4[2]}.${v4[3]}.*`;
	}

	const labels = host.split(".");

	if (labels.length < 3 || labels[0].toLowerCase() === account?.toLowerCase()) {
		return undefined;
	}

	return `*.${labels.slice(1).join(".")}`;
}

/** The masks worth offering for someone: the likeliest first, the widest last. */
export function banSuggestions(target: BanTarget, accountPrefix = ""): MaskSuggestion[] {
	const out: MaskSuggestion[] = [];
	const add = (mask: string, label: string) => {
		if (!out.some((s) => s.mask === mask)) {
			out.push({mask, label});
		}
	};
	const {nick, host, ip, account} = target;
	// `~bob` is an unverified `bob`: the server may put the `~` back or not.
	const ident = target.ident?.replace(/^~/, "*");

	if (host) {
		add(`*!*@${host}`, t("ban.suggest.host"));

		if (ident) {
			add(`*!${ident}@${host}`, t("ban.suggest.identHost"));
		}
	}

	if (ip) {
		add(`*!*@${ip}`, t("ban.suggest.ip"));
	}

	if (account && accountPrefix) {
		add(`${accountPrefix}${account}`, t("ban.suggest.account"));
	}

	if (nick) {
		add(`${nick}!*@*`, t("ban.suggest.nick"));
	}

	const wide = wideHost(host, account);

	if (wide) {
		add(`*!*@${wide}`, t("ban.suggest.wide"));
	}

	return out;
}

/** The prefix an account ban takes here (`~a:`), from `EXTBANS` or `EXTBAN`; "" for none. */
export function accountBanPrefix(token: string | undefined): string {
	const [prefix, types = ""] = (token ?? "").split(",");
	return prefix && types.includes("a") ? `${prefix}a:` : "";
}

/** Whether two masks are the same ban to the server. */
export function sameBan(a: string, b: string): boolean {
	return normaliseBanMask(a).toLowerCase() === normaliseBanMask(b).toLowerCase();
}

/**
 * Whether the server would take `narrow` as covered by `wide` (`bmatch`).
 * Extended bans are only ever compared whole.
 */
export function banCovers(wide: string, narrow: string): boolean {
	const a = normaliseBanMask(wide);
	const b = normaliseBanMask(narrow);

	return isExtendedBan(a) || isExtendedBan(b) ? sameBan(a, b) : compareWithWildcard(a, b);
}

/**
 * Whether a ban catches `target`; undefined when that cannot be told from
 * here (a channel or mark ban, one that turns its match around). The host part
 * sees what we see: the server also tries a cloaked user's real host.
 */
export function banMatches(mask: string, target: BanTarget): boolean | undefined {
	// `~q:` and `~n:` say what a match may not do; the match is what follows.
	const inner = normaliseBanMask(mask.trim().replace(/^~[qn]:/, ""));
	const extended = /^~(!?)([a-zA-Z]):(.*)$/.exec(inner);

	if (extended) {
		const [, negated, letter, value] = extended;

		if (negated) {
			return undefined;
		}

		if (letter === "a") {
			return !!target.account && compareWithWildcard(value, target.account);
		}

		return letter === "r"
			? !!target.realname && compareWithWildcard(value, target.realname)
			: undefined;
	}

	const bang = inner.indexOf("!");

	return (
		compareWithWildcard(inner.slice(0, bang), target.nick ?? "") &&
		maskCovers(inner.slice(bang + 1), {...target, nick: target.nick ?? ""})
	);
}

/** Fields of the dialog's WHO: `<token> <chan> <user> <ip> <host> <nick> <flags> <account> <realname>`. */
export const BAN_WHO_FIELDS = "tcuihnfar";

/** The people in a WHO reply (WHOX with {@link BAN_WHO_FIELDS}, or plain 352). */
export function parseMembers(lines: IrcMessage[], token: string): BanTarget[] {
	const out: BanTarget[] = [];

	for (const msg of lines) {
		if (msg.command === "354" && msg.params[1] === token) {
			const [, , , ident, ip, host, nick, , account, realname] = msg.params;

			if (nick) {
				out.push({
					nick,
					ident,
					host,
					ip: ip && ip !== "0" && ip !== "255.255.255.255" ? ip : undefined,
					account: account && account !== "0" ? account : undefined,
					realname,
				});
			}
		} else if (msg.command === "352") {
			// <me> <chan> <user> <host> <server> <nick> <flags> :<hops> <realname>
			const [, , ident, host, , nick, , trailing = ""] = msg.params;

			if (nick) {
				const space = trailing.indexOf(" ");
				const realname = space === -1 ? "" : trailing.slice(space + 1);
				out.push({nick, ident, host, realname});
			}
		}
	}

	return out;
}

/** `ident@host` from a chat line, split; nothing for an empty one. */
export function parseAddress(address: string | undefined): Pick<BanTarget, "ident" | "host"> {
	const at = address?.lastIndexOf("@") ?? -1;

	if (!address || at === -1) {
		return {};
	}

	return {
		ident: address.slice(0, at) || undefined,
		host: address.slice(at + 1) || undefined,
	};
}

/** Who set a ban, for reading: a nick from `nick!user@host`, "" for the server's `*`. */
export function banSetter(by: string): string {
	const nick = by.split("!")[0];
	return nick === "*" ? "" : nick;
}

/**
 * Whether a row answers a search: every word in its mask or setter, or the
 * search is an address (`bob@host`, `nick!user@host`, `some.host`) the ban
 * would catch, which answers "what is keeping this person out?".
 */
export function banAnswersQuery(row: BanEntry, query: string): boolean {
	const q = query.trim();

	if (q === "") {
		return true;
	}

	const hay = `${row.mask} ${row.by}`.toLowerCase();

	if (
		q
			.toLowerCase()
			.split(/\s+/)
			.every((word) => hay.includes(word))
	) {
		return true;
	}

	return /[@!.:]/.test(q) && !/\s/.test(q) && banCovers(row.mask, q);
}

/** A new array of `rows` in the order asked for; a row with no time sorts as oldest. */
export function sortBans(rows: BanEntry[], sort: BanSort): BanEntry[] {
	const at = (row: BanEntry) => row.at ?? 0;
	const byMask = (a: BanEntry, b: BanEntry) => a.mask.localeCompare(b.mask);

	return [...rows].sort((a, b) => {
		switch (sort) {
			case "oldest":
				return at(a) - at(b) || byMask(a, b);
			case "mask":
				return byMask(a, b);
			case "setter":
				return banSetter(a.by).localeCompare(banSetter(b.by)) || byMask(a, b);
			default:
				return at(b) - at(a) || byMask(a, b);
		}
	});
}
