/**
 * Services profiles: what a network's services package (X3 today; others
 * by contribution, like the server profiles in `../profiles/`) writes into
 * its channels and answers to its commands, as data and pure functions
 * over text, so mocha covers them with fixtures taken from the wire
 * reference (docs/resources/x3-services.md). Which package a network runs,
 * and its bots' nicks, is the oper's setting (`ServicesConfig`), never
 * detected — nothing about a network's services is standard.
 *
 * Adding a package: implement {@link ServicesProfile} in a new directory
 * here and list it in `./index.ts`.
 */

import type {ServicesConfig} from "../../../../shared/types/network";
import type {CoarseKind} from "../../helpers/operActivity";

/** One line of the snoop feed (a connect, a join, a kill…), parsed. */
export interface SnoopEvent {
	/** The keyword, lowercased (`connect`, `nick`, `join`, `kill`, `oper`, `mode`…). */
	keyword: string;
	fields: Record<string, string>;
}

/** One audit line: a command somebody made services run. */
export interface AuditEvent {
	/** The channel the command was about, or "" (the usual case for O3). */
	channel: string;
	nick: string;
	ident: string;
	host: string;
	/** The services account, when the person was authed. */
	account?: string;
	/** The first word, lowercased. */
	command: string;
	/** The rest of the line as typed. */
	args: string;
	/** What kind of oper action it was, for the Opers rollup. */
	coarse: CoarseKind;
}

/** A module's own log line sent to a channel (`OpServ info: …`). */
export interface ModuleLogEvent {
	facility: string;
	severity: string;
	message: string;
}

/** The services' answer to a ban command, classified. */
export interface BanReply {
	ok: boolean;
	/** The mask the reply names, when it names one. */
	mask?: string;
	/** The reply in the services' own words, formatting stripped. */
	text: string;
}

export type ServicesBanType = "gline" | "shun";

export interface ServicesBanRequest {
	type: ServicesBanType;
	mask: string;
	seconds: number;
	reason: string;
}

/** One NOTICE answer, line by line: how it starts, ends, and what it says. */
export interface ServiceLookup<T> {
	/** Which configured bot answers it. */
	role: "oper" | "account" | "channel";
	/** The line to send (a PRIVMSG to the bot). */
	command(bot: string): string;
	/** The collector's verdict on a line from the bot (services.ts `collectServiceReply`). */
	accept(text: string): "start" | "take" | "end" | "skip";
	/** The collected lines as a value; undefined when they say "no such thing". */
	parse(lines: string[]): T | undefined;
}

/** A channel as the oper service knows it (O3 `chaninfo`). */
export interface ServiceChannelInfo {
	/** Epoch ms the channel was created, when the bot says. */
	createdAt?: number;
	modes?: string;
	topic?: string;
	topicBy?: string;
	bans: {mask: string; by: string; at?: number}[];
}

/** A channel's registration (ChanServ `info`). */
export interface ServiceRegistration {
	registered: boolean;
	/** `3w, 2d` — the bot's own interval text since registration. */
	since?: string;
	owner?: string;
}

/** A user as the oper service knows it (O3 `whois`). */
export interface ServiceUserInfo {
	nick: string;
	ident?: string;
	host?: string;
	ip?: string;
	country?: string;
	city?: string;
	version?: string;
	marks?: string[];
	modes?: string;
	realname?: string;
	server?: string;
	account?: string;
	/** `1h, 3m` — the bot's interval text for the nick's age. */
	nickAge?: string;
	channels?: string[];
}

/** An account as the account service knows it (AuthServ `accountinfo`). */
export interface ServiceAccountInfo {
	account: string;
	registeredOn?: string;
	lastSeen?: string;
	lastQuitHostmask?: string;
	hostmasks: string[];
	channels?: string;
	/** The account's level with the oper service (`Opserv level: 900`), for staff. */
	opservLevel?: number;
}

/** One alert the oper service keeps (`stats alerts`). */
export interface ServiceAlert {
	name: string;
	/** The reaction, lowercased (`notice`, `gline`…). */
	reaction: string;
	owner: string;
	/** `2026-10-18 21:00:00 +0000` as the bot prints it; absent when it never expires. */
	expires?: string;
	/** The criteria text as stored, `reason …` included when there is one. */
	criteria: string;
	/** The bot's interval text since it last fired, or `Never`. */
	triggered?: string;
}

/** One user a `trace print` found. */
export interface TraceUser {
	nick: string;
	ident: string;
	host: string;
	account?: string;
	/** The bot's flags for the user, when its output has any (`*` an oper). */
	flags?: string;
}

/** What a `trace print` came to. */
export interface TraceResult {
	count: number;
	users: TraceUser[];
	/** The bot's complaint about the criteria, when it made one. */
	error?: string;
}

/** The oper service's answer to a command that adds or removes something. */
export interface CommandReply {
	ok: boolean;
	/** The bot's words, every line, formatting stripped. */
	text: string;
}

/** One ban the oper service lists (`stats glines`, `gtrace`). */
export interface ServiceBan {
	mask: string;
	issuedBy?: string;
	/** The bot's interval text (`3d, 2h`). */
	issuedAgo?: string;
	/** `never`, or the bot's interval text. */
	expiresIn?: string;
	reason: string;
}

export interface ServicesLookups {
	channel(chan: string): ServiceLookup<ServiceChannelInfo>;
	registration(chan: string): ServiceLookup<ServiceRegistration>;
	user(nick: string): ServiceLookup<ServiceUserInfo>;
	account(account: string): ServiceLookup<ServiceAccountInfo>;
	/** The bans whose mask covers `host` (a `*@host` or `ident@host` subset search). */
	bansCovering(host: string): ServiceLookup<ServiceBan[]>;
	/** How many users match the alert criteria right now. */
	traceCount(criteria: string): ServiceLookup<number>;
	/** The `ADDALERT`/`TRACE` criterion for a shared fact, when the package has one. */
	criterion(fact: {key: string; value: string}): string | undefined;
	/** Who matches the criteria right now, by nick (the alert builder's count line). */
	tracePrint(criteria: string): ServiceLookup<TraceResult>;
	/** The oper's own alerts. */
	alerts(): ServiceLookup<ServiceAlert[]>;
	/** Add an alert; `command` is the whole line as the builder assembled it (`addalert …`). */
	addAlert(command: string): ServiceLookup<CommandReply>;
	/** Remove the alert called `name`. */
	delAlert(name: string): ServiceLookup<CommandReply>;
}

export interface ServicesProfile {
	id: ServicesConfig["package"];
	/** Display name (`X3`). */
	name: string;
	/** The package's conventional bot nicks and channels, prefilled when picked. */
	defaults: ServicesConfig["bots"];
	/** A snoop channel line (formatting stripped), or undefined when it is not one. */
	parseSnoop(text: string): SnoopEvent | undefined;
	/** An audit line (formatting stripped), or undefined when it is not one. */
	parseAudit(text: string): AuditEvent | undefined;
	/** A module log line (formatting stripped), or undefined when it is not one. */
	parseModuleLog(text: string): ModuleLogEvent | undefined;
	/** The line that asks the oper service for a ban. */
	banCommand(bot: string, ban: ServicesBanRequest): string;
	/** The oper service's answer to a ban command; undefined when the notice is about something else. */
	parseBanReply(text: string): BanReply | undefined;
	/** Whether `nick` is one of the configured bots. */
	isServiceNick(nick: string, bots: ServicesConfig["bots"]): boolean;
	/**
	 * What the investigation cards ask the bots (irc/investigate.ts), when
	 * the package can answer: absent, the cards show the server's answers
	 * alone.
	 */
	lookups?: ServicesLookups;
}
