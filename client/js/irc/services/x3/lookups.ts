/**
 * What the investigation cards ask X3 (docs/resources/x3-services.md §7
 * WHOIS and CHANINFO, §7 TRACE and GTRACE, §8 ACCOUNTINFO, §9 ChanServ
 * INFO), as {@link ServiceLookup}s: the command, how the NOTICE answer
 * starts and ends, and what its lines say. Formatting is already stripped
 * when the text reaches these. Kept free of store/DOM imports (mocha,
 * test/irc/services/x3.ts).
 */

import type {
	ServiceAccountInfo,
	ServiceBan,
	ServiceChannelInfo,
	ServiceLookup,
	ServiceRegistration,
	ServicesLookups,
	ServiceUserInfo,
} from "../types";
import {parseCtime} from "../../profiles/report";
import {x3Alerts} from "./alerts";

/** `Label      : value` (O3 pads labels to 13) or `Label: value`. */
const LABELLED = /^([A-Za-z][A-Za-z/() ]*?)\s*:\s?(.*)$/;

function labelOf(line: string): [string, string] | undefined {
	const m = LABELLED.exec(line);
	return m ? [m[1].trim(), m[2].trim()] : undefined;
}

function sameName(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** `<ctime> (<unix>)` → epoch ms from the unix part, else from the ctime. */
function timeOf(value: string): number | undefined {
	const unix = /\((\d{9,})\)\s*$/.exec(value);

	if (unix) {
		return Number(unix[1]) * 1000;
	}

	return parseCtime(value);
}

// --------------------------------------------------------------- chaninfo

function channel(chan: string): ServiceLookup<ServiceChannelInfo> {
	return {
		role: "oper",
		command: (bot) => `PRIVMSG ${bot} :chaninfo ${chan}`,
		accept(text) {
			if (/^The channel name you specified does not exist\.$/.test(text)) {
				return "end";
			}

			const head = /^(\S+) Information$/.exec(text);

			if (head) {
				return sameName(head[1], chan) ? "start" : "skip";
			}

			// The member list (with `users`) or its count line is the last thing.
			if (/^Users \(\d+\):$/.test(text) || /^\d+ users \(/.test(text)) {
				return "end";
			}

			return "take";
		},
		parse(lines) {
			if (lines.length === 0 || /does not exist\.$/.test(lines[0])) {
				return undefined;
			}

			const info: ServiceChannelInfo = {bans: []};
			let section: "bans" | "exempts" | "" = "";

			for (const line of lines.slice(1)) {
				if (/^Bans \(\d+\):$/.test(line)) {
					section = "bans";
					continue;
				}

				if (/^Exempts \(\d+\):$/.test(line)) {
					section = "exempts";
					continue;
				}

				const ban = /^(\S+) by (\S+) \((.*)\)$/.exec(line);

				if (ban && section) {
					if (section === "bans") {
						const at = parseCtime(ban[3]);
						info.bans.push(
							at === undefined
								? {mask: ban[1], by: ban[2]}
								: {mask: ban[1], by: ban[2], at}
						);
					}

					continue;
				}

				const topic = /^Topic \(set by (\S+), (.*)\): (.*)$/.exec(line);

				if (topic) {
					info.topicBy = topic[1];
					info.topic = topic[3];
					continue;
				}

				const pair = labelOf(line);

				if (!pair) {
					continue;
				}

				const [label, value] = pair;

				switch (label) {
					case "Created on": {
						const at = timeOf(value);

						if (at !== undefined) {
							info.createdAt = at;
						}

						break;
					}

					case "Modes":
						info.modes = value.replace(/; bad-word channel$/, "");
						break;
					case "Topic":
						// `(none / not gathered)`: no topic.
						if (!/^\(none/.test(value)) {
							info.topic = value;
						}

						break;
					default:
						break;
				}
			}

			return info;
		},
	};
}

// --------------------------------------------------------- chanserv info

function registration(chan: string): ServiceLookup<ServiceRegistration> {
	return {
		role: "channel",
		command: (bot) => `PRIVMSG ${bot} :info ${chan}`,
		accept(text) {
			const head = /^Information About (\S+)$/.exec(text);

			if (head) {
				return sameName(head[1], chan) ? "start" : "skip";
			}

			if (
				/not (?:been )?registered/i.test(text) &&
				text.toLowerCase().includes(chan.toLowerCase())
			) {
				return "end";
			}

			if (/^-+End of Info-+$/.test(text)) {
				return "end";
			}

			return "take";
		},
		parse(lines) {
			if (lines.length === 0) {
				return undefined;
			}

			if (/not (?:been )?registered/i.test(lines[0])) {
				return {registered: false};
			}

			const out: ServiceRegistration = {registered: false};

			for (const line of lines) {
				const pair = labelOf(line);

				if (!pair) {
					continue;
				}

				const [label, value] = pair;

				if (label === "Registered") {
					out.registered = true;
					out.since = value.replace(/\s*ago\.?$/, "");
				} else if (label === "Owner" && !out.owner) {
					out.owner = value;
				}
			}

			return out;
		},
	};
}

// ------------------------------------------------------------- o3 whois

function user(nick: string): ServiceLookup<ServiceUserInfo> {
	return {
		role: "oper",
		command: (bot) => `PRIVMSG ${bot} :whois ${nick}`,
		accept(text) {
			const missing = /^User with nick (\S+) does not exist\.$/.exec(text);

			if (missing) {
				return sameName(missing[1], nick) ? "end" : "skip";
			}

			const pair = labelOf(text);

			if (pair && pair[0] === "Nick") {
				return sameName(pair[1], nick) ? "start" : "skip";
			}

			if (pair || /^Channel list omitted/.test(text)) {
				return "take";
			}

			return "skip";
		},
		parse(lines) {
			if (lines.length === 0 || /does not exist\.$/.test(lines[0])) {
				return undefined;
			}

			const info: ServiceUserInfo = {nick};

			for (const line of lines) {
				const pair = labelOf(line);

				if (!pair) {
					continue;
				}

				const [label, value] = pair;

				switch (label) {
					case "Nick":
						info.nick = value;
						break;

					case "Host": {
						const at = value.indexOf("@");

						if (at !== -1) {
							info.ident = value.slice(0, at);
							info.host = value.slice(at + 1);
						} else {
							info.host = value;
						}

						break;
					}

					case "Real IP":
						info.ip = value;
						break;
					case "Country":
						info.country = value;
						break;
					case "City":
						info.city = value;
						break;
					case "Version":
						info.version = value;
						break;
					case "Mark":
						info.marks = [...(info.marks ?? []), value];
						break;
					case "Modes":
						info.modes = value.split(" ")[0];
						break;
					case "Info":
						info.realname = value;
						break;
					case "Server":
						info.server = value;
						break;
					case "Account":
						if (value !== "Not authenticated") {
							info.account = value;
						}

						break;
					case "Nick Age":
						info.nickAge = value;
						break;
					case "Channels":
						info.channels = [
							...(info.channels ?? []),
							...value.split(/\s+/).filter(Boolean),
						];
						break;
					default:
						break;
				}
			}

			return info;
		},
	};
}

// ---------------------------------------------------------- accountinfo

function account(name: string): ServiceLookup<ServiceAccountInfo> {
	return {
		role: "account",
		command: (bot) => `PRIVMSG ${bot} :accountinfo ${name}`,
		accept(text) {
			const head = /^Account Information for (\S+)$/.exec(text);

			if (head) {
				return sameName(head[1], name) ? "start" : "skip";
			}

			if (/^-+End of Account Info-+$/.test(text)) {
				return "end";
			}

			if (
				/(?:not (?:been )?registered|does not exist|could not find|outranks you)/i.test(
					text
				) &&
				text.toLowerCase().includes(name.toLowerCase())
			) {
				return "end";
			}

			return "take";
		},
		parse(lines) {
			if (lines.length === 0 || !/^Account Information for/.test(lines[0])) {
				return undefined;
			}

			const info: ServiceAccountInfo = {account: name, hostmasks: []};

			for (const line of lines) {
				const pair = labelOf(line);

				if (!pair) {
					continue;
				}

				const [label, value] = pair;

				switch (label) {
					case "Registered on":
						info.registeredOn = value;
						break;
					case "Last seen":
						info.lastSeen = value;
						break;
					case "Last quit hostmask":
						if (value !== "Unknown") {
							info.lastQuitHostmask = value;
						}

						break;
					case "Hostmask(s)":
						info.hostmasks.push(...value.split(/\s+/).filter(Boolean));
						break;
					case "Channel(s)":
						info.channels = info.channels ? `${info.channels} ${value}` : value;
						break;

					case "Opserv level": {
						const level = Number.parseInt(value, 10);

						if (Number.isFinite(level)) {
							info.opservLevel = level;
						}

						break;
					}

					default:
						break;
				}
			}

			return info;
		},
	};
}

// --------------------------------------------------------------- gtrace

/** `<mask> (issued <interval> by <issuer>, expires <interval|never>): <reason>` */
const BAN_LINE = /^(\S+) \(issued (.+?) by (\S+), expires (.+?)\): (.*)$/;

function bansCovering(host: string): ServiceLookup<ServiceBan[]> {
	return {
		role: "oper",
		// `superset`: every G-line whose mask takes this host in, not only the exact one.
		command: (bot) => `PRIVMSG ${bot} :gtrace print host superset ${host}`,
		accept(text) {
			if (/^The following glines were found:$/.test(text)) {
				return "start";
			}

			if (/^Nothing matched the criteria of your search\.$/.test(text)) {
				return "end";
			}

			if (/^-+Found\s+\d+ Matches?-+$/.test(text)) {
				return "end";
			}

			return BAN_LINE.test(text) ? "take" : "skip";
		},
		parse(lines) {
			const bans: ServiceBan[] = [];

			for (const line of lines) {
				const m = BAN_LINE.exec(line);

				if (m) {
					bans.push({
						mask: m[1],
						issuedAgo: m[2],
						issuedBy: m[3],
						expiresIn: m[4],
						reason: m[5],
					});
				}
			}

			return bans;
		},
	};
}

// ---------------------------------------------------------- trace count

function traceCount(criteria: string): ServiceLookup<number> {
	return {
		role: "oper",
		command: (bot) => `PRIVMSG ${bot} :trace count ${criteria}`,
		accept(text) {
			if (/^There were\s+\d+ matches$/.test(text)) {
				return "end";
			}

			if (/^Nothing matched the criteria of your search\.$/.test(text)) {
				return "end";
			}

			if (/is an invalid|requires more parameters|is not a valid|Invalid regex/.test(text)) {
				return "end";
			}

			return "skip";
		},
		parse(lines) {
			const first = lines[0] ?? "";
			const m = /^There were\s+(\d+) matches$/.exec(first);

			if (m) {
				return Number(m[1]);
			}

			return /^Nothing matched/.test(first) ? 0 : undefined;
		},
	};
}

/** A value as one glob word: X3 reads criteria one word at a time. */
function glob(value: string): string {
	return value.replace(/\s+/g, "?");
}

/**
 * The `ADDALERT`/`TRACE` criterion for a fact the channel card found in
 * common (helpers/commonality.ts): `authed no`, `info irc?client`,
 * `ident r????`, `ip 203.0.113.0/24`, `server leaf2`, `version …`. The
 * connect age has none — X3's `nickage` is the nick's timestamp, not the
 * connection's.
 */
function criterion(fact: {key: string; value: string}): string | undefined {
	switch (fact.key) {
		case "authed":
			return `authed ${fact.value === "yes" ? "yes" : "no"}`;
		case "realname":
			return `info ${glob(fact.value)}`;
		case "identShape":
			return `ident ${fact.value}`;
		case "ipRange":
			return `ip ${fact.value}`;
		case "server":
			return `server ${fact.value}`;
		case "version":
			return `version ${glob(fact.value)}`;
		default:
			return undefined;
	}
}

export const x3Lookups: ServicesLookups = {
	channel,
	registration,
	user,
	account,
	bansCovering,
	traceCount,
	criterion,
	...x3Alerts,
};
