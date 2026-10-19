/**
 * The services feed (docs/projects/oper-tools.md, "Services support"):
 * what a network's services write into their channels, kept the way server
 * notices are. A snoop line in the snoop channel (a connect, a join, a
 * kill) and an audit line in the report channel (a command somebody made
 * services run) are parsed by the services profile and appended to the
 * notice log as `snoop` / `audit` entries. An audit line is for the Opers
 * rollup, credited to the person who typed the command rather than to the
 * bot; a snoop line is a quiet source for the investigation cards only
 * (the kept feed: who connected from where, who joined what) and counts
 * for nothing on the Opers tab — a connect is not an oper's action (rubin,
 * 2026-10-11). Nothing is routed and nothing is re-rendered: the channel
 * shows the lines as the ordinary channel messages they are, except that
 * the nicks a snoop line names render as nicks ({@link snoopNicks}), so
 * the oper can open a nick's menu — Investigate — straight from the feed.
 *
 * Only lines from the configured bots count, in the configured channels;
 * a user chatting in the snoop channel is chat. Kept free of store/DOM
 * imports (mocha, test/irc/services.ts).
 */

import {ChanType} from "../../../shared/types/chan";
import type {ServicesConfig} from "../../../shared/types/network";
import type {SnoticeInfo} from "../../../shared/types/oper";
import type {IrcClient} from "./client";
import type {IrcMessage} from "./message";
import type {LoggedNotice} from "./noticelog";
import {servicesProfileFor} from "./services/index";
import type {ServicesProfile} from "./services/types";
import {cleanIrcMessage as stripFormatting} from "../../../shared/irc";

/** The category every services entry carries (its badge reads "services"). */
export const SERVICES_CATEGORY = "SERVICES";

function fromConfiguredBot(
	client: IrcClient,
	msg: IrcMessage,
	bots: ServicesConfig["bots"]
): boolean {
	const from = msg.source?.name;

	if (!from || msg.source?.user === undefined) {
		return false;
	}

	return [bots.oper, bots.account, bots.channel].some(
		(bot) => bot !== "" && client.namesEqual(bot, from)
	);
}

function inChannel(client: IrcClient, target: string, wanted: string): boolean {
	return wanted !== "" && client.namesEqual(target, wanted);
}

/** The log entry a snoop or audit line becomes, or undefined when it is neither. */
export function servicesEntry(
	profile: ServicesProfile,
	where: {inSnoop: boolean; inReport: boolean},
	text: string,
	time: number
): LoggedNotice | undefined {
	if (where.inSnoop) {
		const snoop = profile.parseSnoop(text);

		if (snoop) {
			const info: SnoticeInfo = {
				kind: `${profile.id}.snoop.${snoop.keyword}`,
				category: SERVICES_CATEGORY,
				fields: snoop.fields,
				route: "network",
			};
			return {time, type: "snoop", text, snotice: info};
		}
	}

	if (where.inReport) {
		const audit = profile.parseAudit(text);

		if (audit) {
			const fields: Record<string, string> = {
				nick: audit.nick,
				ident: audit.ident,
				host: audit.host,
				command: audit.command,
				args: audit.args,
			};

			if (audit.channel) {
				fields.channel = audit.channel;
			}

			if (audit.account) {
				fields.account = audit.account;
			}

			return {
				time,
				type: "audit",
				text,
				from: audit.nick,
				snotice: {
					kind: `${profile.id}.audit.${audit.coarse}`,
					category: SERVICES_CATEGORY,
					fields,
					route: "network",
				},
			};
		}

		const log = profile.parseModuleLog(text);

		if (log) {
			return {
				time,
				type: "audit",
				text,
				snotice: {
					kind: `${profile.id}.log.${log.severity}`,
					category: SERVICES_CATEGORY,
					fields: {facility: log.facility, severity: log.severity, message: log.message},
					route: "network",
				},
			};
		}
	}

	return undefined;
}

/**
 * The fields of a snoop line that name a nick: the user a connect, quit,
 * nick change (both names), join, part, auth, umode or oper-up is about,
 * the kicked and the kicker, the killed and the killer, a channel mode's
 * setter. A server in one of those places (`by irc.example.org`) has a
 * dot in it, which no nick can.
 */
const SNOOP_NICK_FIELDS = ["nick", "newNick", "kicker", "killer", "setter"];

/** The nicks a snoop entry names, each once, in the line's order; none for any other entry. */
export function snoopNicks(entry: LoggedNotice | undefined): string[] {
	const nicks: string[] = [];

	if (entry?.type !== "snoop") {
		return nicks;
	}

	for (const field of SNOOP_NICK_FIELDS) {
		const value = entry.snotice.fields[field] ?? "";

		if (value !== "" && !value.includes(".") && !nicks.includes(value)) {
			nicks.push(value);
		}
	}

	return nicks;
}

/**
 * Called from the PRIVMSG handler for every channel message, before it is
 * shown: recognises a services line in a configured channel and hands the
 * entry back so the handler can mark the nicks a snoop line names. A live
 * line is also kept in the notice log; a replayed one (a chathistory page
 * after a reload, a reconnect's catch-up) is not — the log has those
 * lines — but its nicks are clickable all the same, since the scrollback
 * is exactly where an oper looks them up. Never changes the message
 * itself.
 */
export function noteServicesLine(client: IrcClient, msg: IrcMessage): LoggedNotice | undefined {
	const services = client.services;
	const profile = servicesProfileFor(services);

	if (!services || !profile || msg.command !== "PRIVMSG") {
		return undefined;
	}

	const target = msg.params[0] ?? "";
	const where = {
		inSnoop: inChannel(client, target, services.bots.snoop),
		inReport: inChannel(client, target, services.bots.report),
	};

	if (!where.inSnoop && !where.inReport) {
		return undefined;
	}

	const chan = client.findChannel(target);

	if (!chan || chan.type !== ChanType.CHANNEL || !fromConfiguredBot(client, msg, services.bots)) {
		return undefined;
	}

	const text = stripFormatting(msg.params[msg.params.length - 1] ?? "");
	const entry = servicesEntry(profile, where, text, client.timeOf(msg).getTime());

	if (entry && !client.replaying) {
		client.noticeLog.append(entry);
	}

	return entry;
}
