/**
 * An investigation: everything the channel card and the user card show
 * (docs/projects/oper-tools.md, "The channel card", "The user card"),
 * gathered from the server and the network's services into one plain
 * model the card renders as it fills in. One {@link Investigation} per
 * card: `start()` asks, `onChange` fires after every answer, `refresh()`
 * asks everything again, `stop()` drops what is still in flight.
 *
 * Sources, in the order they are asked:
 *
 * - **channel**: `CHECK #chan` (modes, topic, members with host and
 *   realname), `WHO #chan` with WHOX fields (real IP for opers, server,
 *   account, flags, idle), `USERIP` five nicks at a time for anyone still
 *   without an IP; with services, O3 `chaninfo` (created, bans), ChanServ
 *   `info` (registered), then O3 `whois` per user (country, version) — up
 *   to {@link LOOKUP_CAP} users, the rest when their block is opened.
 * - **user**: `CHECK nick`, `WHOIS nick nick` (the remote form: idle and
 *   sign-on time), `USERIP nick`, `STATS g` / `S` / `Z` for the live bans
 *   (opers only); with services, O3 `whois` (country, city, version, nick
 *   age), AuthServ `accountinfo` when authed, and O3 `gtrace` for the
 *   bans covering the host only when the server listed none — X3's bans
 *   are the server's, so `gtrace` adds nothing to a list that was read.
 *
 * The kept feed (noticelog.ts, the services feed included) gives the rest
 * without asking: when each user connected and joined, the last hour in
 * the channel, who was seen before with the same IP, host, realname or
 * account, and the bans the feed saw being set (helpers/commonality.ts,
 * helpers/verdict.ts).
 *
 * **Pacing.** Every command costs about 2 s of fake lag on an ircu-family
 * server and the socket is ignored past 10 s (CLAUDE.md), so the first
 * {@link BURST} commands go out at once and the rest one every
 * {@link PACE_MS}; the bots' queries are also sent one at a time, since
 * nothing but the order correlates a bot's NOTICE with its question.
 *
 * Every server command goes out labeled (request.ts) and every bot query
 * is collected by `collectServiceReply` (services.ts). Kept free of
 * store/DOM imports (mocha, test/irc/investigate.ts).
 */

import {ChanState} from "../../../shared/types/chan";
import {
	commonality,
	type Commonality,
	connectTimes,
	joinTimes,
	lastHourHere,
	type ChannelEvent,
	type CommonUser,
} from "../helpers/commonality";
import {
	bansNear,
	type BanNear,
	type Identity,
	seenBefore,
	type SeenEntry,
	verdict,
} from "../helpers/verdict";
import type {IrcClient} from "./client";
import {formatLine, type IrcMessage} from "./message";
import type {LoggedNotice} from "./noticelog";
import {getNote} from "./operprefs";
import {parseCheck} from "./profiles/nefarious/check";
import {type LiveBan, parseBanRow} from "./profiles/nefarious/stats";
import {isIp, parseCtime} from "./profiles/report";
import {sendQuiet} from "./quiet";
import {canRequest, request, type ReplyUnit} from "./request";
import {collectServiceReply, type ServiceAnswer} from "./services";
import {servicesProfileFor} from "./services/index";
import type {ServiceBan, ServiceLookup, ServicesLookups} from "./services/types";

/** Commands sent without waiting at the start of an investigation. */
export const BURST = 3;
/** The gap between commands after the burst, and between bot queries. */
export const PACE_MS = 2000;
/** How many users' services lookups a channel card asks for by itself. */
export const LOOKUP_CAP = 20;
/** Nicks per USERIP. */
export const USERIP_BATCH = 5;

export type InvestigationKind = "channel" | "user";

export type SourceId =
	| "check"
	| "who"
	| "userip"
	| "whois"
	| "stats"
	| "chaninfo"
	| "registration"
	| "lookups"
	| "account"
	| "gtrace";

/** `off`: not applicable here (no services, not opered, no labels). */
export type SourceState = "asking" | "done" | "failed" | "off";

export interface InvestigatedUser {
	nick: string;
	ident?: string;
	/** The real host when an oper asked, else the visible one. */
	host?: string;
	ip?: string;
	realname?: string;
	account?: string;
	server?: string;
	op?: boolean;
	voice?: boolean;
	oper?: boolean;
	away?: boolean;
	/** Known once any source said so either way. */
	authed?: boolean;
	/** Epoch ms the connection was made. */
	connectedAt?: number;
	/** Epoch ms they joined the channel (the feed). */
	joinedAt?: number;
	/** Seconds idle. */
	idle?: number;
	country?: string;
	city?: string;
	version?: string;
	/** User modes, letters with the sign (`+ix`). */
	modes?: string;
	/** Channels with their status prefixes (`@#a`, `#b`). */
	channels?: string[];
	nickAge?: string;
	marks?: string[];
	/** The services lookup for this user: beyond the cap until asked for, or in flight, or done. */
	lookup?: "pending" | "asking" | "done" | "failed";
}

export interface ChannelModel {
	kind: "channel";
	target: string;
	createdAt?: number;
	modes?: string;
	topic?: string;
	topicBy?: string;
	registered?: boolean;
	/** The bot's own interval text since registration. */
	registeredSince?: string;
	owner?: string;
	bans: {mask: string; by: string; at?: number}[];
	users: InvestigatedUser[];
	commonality?: Commonality;
	/** The last hour in the channel, from the feed, oldest first. */
	recent: ChannelEvent[];
	/** The snoop channel the feed would need, when one is configured and not joined. */
	snoopMissing?: string;
	traceCount?: {state: "asking" | "done" | "failed"; count?: number; criteria: string};
}

export interface UserModel {
	kind: "user";
	target: string;
	user: InvestigatedUser;
	liveBans: BanNear[];
	recentBans: BanNear[];
	/** The bans the oper service listed for the host, when it was asked. */
	serviceBans: ServiceBan[];
	seen: SeenEntry[];
	verdict: string;
	lastQuitHostmask?: string;
	hostmasks?: string[];
	/** The snoop channel "seen before" would draw on, when one is configured and not joined. */
	snoopMissing?: string;
}

export type InvestigationModel = ChannelModel | UserModel;

interface Task {
	/** The investigation that queued it; `stop()` drops its tasks. */
	owner: object;
	lane: "server" | "services";
	run: () => Promise<void>;
}

/**
 * One queue per connection, shared by every card open on it: the
 * server's fake lag is charged per connection, so two cards at once must
 * not each burst. A token bucket — {@link BURST} tokens, one back every
 * {@link PACE_MS} — and the services lane one query at a time.
 */
class Pacer {
	private queue: Task[] = [];
	private tokens = BURST;
	private last = Date.now();
	private servicesBusy = false;
	private timer: ReturnType<typeof setTimeout> | undefined;

	enqueue(task: Task): void {
		this.queue.push(task);
		this.pump();
	}

	drop(owner: object): void {
		this.queue = this.queue.filter((t) => t.owner !== owner);
	}

	private refill(): void {
		const now = Date.now();
		this.tokens = Math.min(BURST, this.tokens + (now - this.last) / PACE_MS);
		this.last = now;
	}

	private pump(): void {
		if (this.timer !== undefined) {
			return;
		}

		const index = this.queue.findIndex((t) => t.lane === "server" || !this.servicesBusy);

		if (index === -1) {
			return;
		}

		this.refill();

		if (this.tokens < 1) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.pump();
			}, Math.ceil((1 - this.tokens) * PACE_MS));
			return;
		}

		const [task] = this.queue.splice(index, 1);
		this.tokens -= 1;

		if (task.lane === "services") {
			this.servicesBusy = true;
		}

		void task.run().finally(() => {
			if (task.lane === "services") {
				this.servicesBusy = false;
			}

			this.pump();
		});
		this.pump();
	}
}

const pacers = new WeakMap<IrcClient, Pacer>();

function pacerOf(client: IrcClient): Pacer {
	let pacer = pacers.get(client);

	if (!pacer) {
		pacer = new Pacer();
		pacers.set(client, pacer);
	}

	return pacer;
}

/** The WHOX fields the channel card asks for, in the server's fixed order. */
export const WHOX_FIELDS = "tcuihsnfdlar";

let whoxTokens = 0;

function nextToken(): string {
	whoxTokens = (whoxTokens % 999) + 1;
	return String(whoxTokens);
}

const BAD_IP = new Set(["", "0", "255.255.255.255", "0::0", "::"]);

function goodIp(value: string | undefined): string | undefined {
	return value !== undefined && !BAD_IP.has(value) && isIp(value) ? value : undefined;
}

/** `D days, HH:MM:SS` → seconds. */
function parseIdle(value: string): number | undefined {
	const m = /^(\d+) days?, (\d+):(\d{2}):(\d{2})$/.exec(value.trim());
	return m
		? Number(m[1]) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
		: undefined;
}

function last(msg: IrcMessage): string {
	return msg.params[msg.params.length - 1] ?? "";
}

function isError(msg: IrcMessage): boolean {
	return /^[45]\d\d$/.test(msg.command) || msg.command === "FAIL";
}

/** The human text of an error numeric, for the source's note. */
function errorText(lines: IrcMessage[]): string | undefined {
	const err = lines.find(isError);

	if (!err) {
		return undefined;
	}

	switch (err.command) {
		case "481":
			return "not an IRC operator here";
		case "517":
			return "no CHECK privilege";
		case "401":
			return "no such nick";
		case "403":
			return "no such channel";
		default:
			return last(err);
	}
}

export class Investigation {
	readonly client: IrcClient;
	readonly kind: InvestigationKind;
	readonly target: string;
	model: InvestigationModel;
	sources: Partial<Record<SourceId, SourceState>> = {};
	/** Why a source failed, by source. */
	notes: Partial<Record<SourceId, string>> = {};
	/** Every line received for this card, as it came. */
	raw: string[] = [];
	onChange: (() => void) | undefined;

	private generation = 0;
	private stopped = false;
	/** Every ban the server listed (STATS g/S/Z), for the feed to match. */
	private liveBans: LiveBan[] = [];
	private accountAsked = "";
	private gtraceAsked = false;

	constructor(client: IrcClient, kind: InvestigationKind, target: string) {
		this.client = client;
		this.kind = kind;
		this.target = target;
		this.model = this.freshModel();
	}

	private freshModel(): InvestigationModel {
		if (this.kind === "channel") {
			return {kind: "channel", target: this.target, bans: [], users: [], recent: []};
		}

		return {
			kind: "user",
			target: this.target,
			user: {nick: this.target},
			liveBans: [],
			recentBans: [],
			serviceBans: [],
			seen: [],
			verdict: "",
		};
	}

	/** What the oper noted about this channel, IP or account (operprefs.ts). */
	get noteKey(): string {
		if (this.model.kind === "channel") {
			return this.model.target;
		}

		return this.model.user.ip ?? this.model.user.account ?? this.model.user.nick;
	}

	get note(): string {
		return getNote(this.client.uuid, this.noteKey);
	}

	/** The services lookups this network's package offers, when it is set up. */
	private get lookups(): ServicesLookups | undefined {
		return servicesProfileFor(this.client.services)?.lookups;
	}

	private bot(role: "oper" | "account" | "channel"): string {
		return this.client.services?.bots[role].trim() ?? "";
	}

	private get feed(): LoggedNotice[] {
		return this.client.noticeLog.all();
	}

	start(): void {
		this.stopped = false;

		if (this.kind === "channel") {
			this.startChannel();
		} else {
			this.startUser();
		}

		this.derive();
	}

	/** Ask everything again, from a blank model. */
	refresh(): void {
		this.stop();
		this.model = this.freshModel();
		this.sources = {};
		this.notes = {};
		this.raw = [];
		this.liveBans = [];
		this.accountAsked = "";
		this.gtraceAsked = false;
		this.start();
	}

	stop(): void {
		this.stopped = true;
		this.generation++;
		pacerOf(this.client).drop(this);
	}

	private changed(): void {
		this.onChange?.();
	}

	// ------------------------------------------------------------ pacing

	/** Queue a command on the connection's shared pacer (see {@link Pacer}). */
	private enqueue(task: Omit<Task, "owner">): void {
		if (!this.stopped) {
			pacerOf(this.client).enqueue({...task, owner: this});
		}
	}

	/** A labeled server request as a task; `apply` runs only while this run is current. */
	private serverTask(
		source: SourceId,
		line: string,
		opts: {end?: string[]; untagged?: string[]},
		apply: (reply: ReplyUnit) => void
	): void {
		if (!canRequest(this.client)) {
			this.sources[source] = "off";
			this.notes[source] = "the server does not label replies";
			return;
		}

		this.sources[source] = "asking";
		const generation = this.generation;

		this.enqueue({
			lane: "server",
			run: async () => {
				const reply = await request(this.client, line, opts);

				if (generation !== this.generation) {
					return;
				}

				this.raw.push(...reply.lines.map((msg) => msg.raw));

				if (reply.outcome === "closed" || reply.outcome === "timeout") {
					this.sources[source] = "failed";
					this.notes[source] =
						reply.outcome === "closed" ? "the connection is down" : "no answer";
				} else {
					const error = errorText(reply.lines);

					if (error && !reply.lines.some((m) => !isError(m) && m.command !== "ACK")) {
						this.sources[source] = "failed";
						this.notes[source] = error;
					} else {
						this.sources[source] = "done";
					}
				}

				apply(reply);
				this.derive();
			},
		});
	}

	/** A bot query as a task on the services lane; `apply` gets the parsed value. */
	private serviceTask<T>(
		source: SourceId,
		lookup: ServiceLookup<T>,
		apply: (value: T | undefined, answer: ServiceAnswer<string[]>) => void
	): boolean {
		const bot = this.bot(lookup.role);

		if (!bot) {
			this.sources[source] ??= "off";
			return false;
		}

		this.sources[source] = "asking";
		const generation = this.generation;

		this.enqueue({
			lane: "services",
			run: async () => {
				const reply = collectServiceReply(this.client, bot, {
					accept: (text) => lookup.accept(text),
				});

				// Quiet (quiet.ts): the PRIVMSG's echo opens no window for the bot.
				if (!sendQuiet(this.client, lookup.command(bot))) {
					apply(undefined, {kind: "closed"});
					return;
				}

				const answer = await reply;

				if (generation !== this.generation) {
					return;
				}

				if (answer.kind === "reply") {
					this.raw.push(...answer.value.map((text) => `-${bot}- ${text}`));
					this.sources[source] = "done";
					apply(lookup.parse(answer.value), answer);
				} else {
					this.sources[source] = "failed";
					this.notes[source] =
						answer.kind === "missing"
							? `${bot} is not online`
							: answer.kind === "timeout"
							? `${bot} did not answer`
							: "the connection is down";
					apply(undefined, answer);
				}

				this.derive();
			},
		});
		return true;
	}

	// ----------------------------------------------------------- channel

	private get channel(): ChannelModel {
		return this.model as ChannelModel;
	}

	private get userModel(): UserModel {
		return this.model as UserModel;
	}

	private upsertUser(nick: string): InvestigatedUser {
		const model = this.channel;
		const found = model.users.find((u) => this.client.namesEqual(u.nick, nick));

		if (found) {
			return found;
		}

		const user: InvestigatedUser = {nick};
		model.users.push(user);
		return user;
	}

	private startChannel(): void {
		const chan = this.target;
		const nefarious = this.client.profile.id === "nefarious2";

		if (nefarious) {
			this.serverTask("check", `CHECK ${chan}`, {end: ["291", "292"]}, (reply) =>
				this.applyChannelCheck(reply)
			);
		} else {
			this.sources.check = "off";
		}

		const whox = this.client.isupport.has("WHOX");
		const token = whox ? nextToken() : undefined;
		const line = whox
			? formatLine({command: "WHO", params: [chan, `%${WHOX_FIELDS},${token}`]})
			: formatLine({command: "WHO", params: [chan]});
		this.serverTask("who", line, {end: ["315"]}, (reply) => {
			this.applyWho(reply, token);
			this.askUserIps();
		});

		const lookups = this.lookups;

		if (lookups) {
			this.serviceTask("chaninfo", lookups.channel(chan), (info) => {
				if (!info) {
					return;
				}

				const model = this.channel;

				if (info.createdAt !== undefined) {
					model.createdAt = info.createdAt;
				}

				if (info.modes) {
					model.modes = info.modes;
				}

				if (info.topic !== undefined) {
					model.topic = info.topic;
				}

				if (info.topicBy) {
					model.topicBy = info.topicBy;
				}

				if (info.bans.length > 0) {
					model.bans = info.bans;
				}
			});
			this.serviceTask("registration", lookups.registration(chan), (reg) => {
				if (reg) {
					this.channel.registered = reg.registered;

					if (reg.since) {
						this.channel.registeredSince = reg.since;
					}

					if (reg.owner) {
						this.channel.owner = reg.owner;
					}
				}
			});
		} else {
			this.sources.chaninfo = "off";
			this.sources.registration = "off";
			this.sources.lookups = "off";
		}

		const snoop = this.client.services?.bots.snoop.trim() ?? "";

		if (snoop && this.client.findChannel(snoop)?.state !== ChanState.JOINED) {
			this.channel.snoopMissing = snoop;
		}
	}

	private applyChannelCheck(reply: ReplyUnit): void {
		const facts = parseCheck(reply.lines, `CHECK ${this.target}`);

		if (!facts || facts.error) {
			if (facts?.error) {
				this.sources.check = "failed";
				this.notes.check = facts.error;
			}

			return;
		}

		const model = this.channel;
		const f = facts.fields;

		if (f["Creation time"] && model.createdAt === undefined) {
			const at = parseCtime(f["Creation time"]);

			if (at !== undefined) {
				model.createdAt = at;
			}
		}

		if (f.Topic !== undefined && model.topic === undefined) {
			model.topic = f.Topic;
		}

		if (f["Set by"] && !model.topicBy) {
			model.topicBy = f["Set by"];
		}

		if (f["Channel mode(s)"] && !model.modes) {
			model.modes = f["Channel mode(s)"];
		}

		if (facts.bans.length > 0 && model.bans.length === 0) {
			model.bans = facts.bans;
		}

		for (const member of facts.members) {
			const user = this.upsertUser(member.nick);
			user.ident = member.ident;
			user.host = member.host;
			user.realname = member.realname;

			if (member.account) {
				user.account = member.account;
				user.authed = true;
			} else {
				user.authed = false;
			}

			if (member.status === "@") {
				user.op = true;
			} else if (member.status === "+") {
				user.voice = true;
			}
		}
	}

	private applyWho(reply: ReplyUnit, token: string | undefined): void {
		const model = this.channel;

		for (const msg of reply.lines) {
			if (msg.command === "354" && token !== undefined) {
				// <me> <token> <chan> <user> <ip> <host> <server> <nick> <flags> <hops> <idle> <account> :<realname>
				if (msg.params.length !== WHOX_FIELDS.length + 1 || msg.params[1] !== token) {
					continue;
				}

				const [, , , ident, ip, host, server, nick, flags, , idle, account, realname] =
					msg.params;
				const user = this.kind === "channel" ? this.upsertUser(nick) : this.userModel.user;
				this.applyWhoRow(user, {ident, ip, host, server, flags, idle, account, realname});
			} else if (msg.command === "352") {
				// <me> <chan> <user> <host> <server> <nick> <flags> :<hops> <realname>
				const [, , ident, host, server, nick, flags = "", trailing = ""] = msg.params;

				if (!nick) {
					continue;
				}

				const space = trailing.indexOf(" ");
				const user = this.upsertUser(nick);
				this.applyWhoRow(user, {
					ident,
					host,
					server,
					flags,
					realname: space === -1 ? "" : trailing.slice(space + 1),
				});
			}
		}

		if (model.users.length === 0 && reply.outcome !== "closed") {
			this.notes.who ??= "nobody answered to WHO";
		}
	}

	private applyWhoRow(
		user: InvestigatedUser,
		row: {
			ident?: string;
			ip?: string;
			host?: string;
			server?: string;
			flags: string;
			idle?: string;
			account?: string;
			realname?: string;
		}
	): void {
		if (row.ident) {
			user.ident = row.ident;
		}

		const ip = goodIp(row.ip);

		if (ip) {
			user.ip = ip;
		}

		if (row.host && !user.host) {
			user.host = row.host;
		}

		if (row.server) {
			user.server = row.server;
		}

		if (row.realname !== undefined && !user.realname) {
			user.realname = row.realname;
		}

		if (row.account !== undefined) {
			if (row.account !== "0") {
				user.account = row.account;
				user.authed = true;
			} else {
				user.authed ??= false;
			}
		}

		if (row.idle !== undefined) {
			const idle = Number(row.idle);

			if (Number.isFinite(idle)) {
				user.idle = idle;
			}
		}

		user.away = row.flags.charAt(0) === "G";

		if (row.flags.includes("*")) {
			user.oper = true;
		}

		if (row.flags.includes("@")) {
			user.op = true;
		}

		if (row.flags.includes("+")) {
			user.voice = true;
		}
	}

	/** `USERIP` for the channel's users still without an IP, five at a time. */
	private askUserIps(): void {
		const missing = this.channel.users.filter((u) => !u.ip).map((u) => u.nick);

		if (missing.length === 0) {
			this.sources.userip = "off";
			return;
		}

		for (let i = 0; i < missing.length; i += USERIP_BATCH) {
			const batch = missing.slice(i, i + USERIP_BATCH);
			this.serverTask("userip", `USERIP ${batch.join(" ")}`, {untagged: ["340"]}, (reply) =>
				this.applyUserIp(reply)
			);
		}
	}

	/** `340 <me> :nick[*]=[+-]user@ip …` → the IPs. */
	private applyUserIp(reply: ReplyUnit): void {
		for (const msg of reply.lines) {
			if (msg.command !== "340") {
				continue;
			}

			for (const item of last(msg).trim().split(/\s+/)) {
				const m = /^([^*=]+)\*?=[+-](.*)@(.*)$/.exec(item);

				if (!m) {
					continue;
				}

				const user =
					this.kind === "channel"
						? this.channel.users.find((u) => this.client.namesEqual(u.nick, m[1]))
						: this.userModel.user;
				const ip = goodIp(m[3]);

				if (user && ip) {
					user.ip = ip;
					user.ident ??= m[2];
				}
			}
		}
	}

	/** The per-user services lookups: the first {@link LOOKUP_CAP}, the rest on demand. */
	private askUserLookups(): void {
		const lookups = this.lookups;

		if (!lookups || this.kind !== "channel") {
			return;
		}

		let asked = this.channel.users.filter(
			(u) => u.lookup === "asking" || u.lookup === "done"
		).length;

		for (const user of this.channel.users) {
			if (user.lookup !== undefined) {
				continue;
			}

			if (asked >= LOOKUP_CAP) {
				user.lookup = "pending";
				continue;
			}

			asked++;
			this.lookupUser(user);
		}
	}

	/** Ask the oper service about one user (a channel card's block being opened). */
	lookup(nick: string): void {
		const user =
			this.kind === "channel"
				? this.channel.users.find((u) => this.client.namesEqual(u.nick, nick))
				: undefined;

		if (user && user.lookup !== "asking" && user.lookup !== "done") {
			this.lookupUser(user);
			this.derive();
		}
	}

	private lookupUser(user: InvestigatedUser): void {
		const lookups = this.lookups;

		if (!lookups) {
			return;
		}

		user.lookup = "asking";
		const sent = this.serviceTask("lookups", lookups.user(user.nick), (info) => {
			user.lookup = info ? "done" : "failed";

			if (!info) {
				return;
			}

			if (info.country) {
				user.country = info.country;
			}

			if (info.city) {
				user.city = info.city;
			}

			if (info.version) {
				user.version = info.version;
			}

			if (info.marks?.length) {
				user.marks = info.marks;
			}

			if (info.nickAge) {
				user.nickAge = info.nickAge;
			}

			if (info.channels?.length) {
				user.channels = info.channels;
			}

			if (info.ip && !user.ip) {
				user.ip = goodIp(info.ip);
			}

			if (info.host && !user.host) {
				user.host = info.host;
			}

			if (info.ident && !user.ident) {
				user.ident = info.ident;
			}

			if (info.realname && !user.realname) {
				user.realname = info.realname;
			}

			if (info.account) {
				user.account = info.account;
				user.authed = true;
			}

			if (info.modes && !user.modes) {
				user.modes = info.modes;
			}

			if (this.kind === "user" && user.account) {
				this.askAccount(user.account);
			}
		});

		if (!sent) {
			user.lookup = undefined;
		}
	}

	/** `trace count` with the criteria of the shared facts (X3 only). */
	traceCount(): void {
		const lookups = this.lookups;
		const model = this.channel;

		if (!lookups || this.kind !== "channel") {
			return;
		}

		const criteria = (model.commonality?.facts ?? [])
			.map((fact) => lookups.criterion({key: fact.key, value: fact.value}))
			.filter((c): c is string => c !== undefined)
			.join(" ");

		if (!criteria) {
			model.traceCount = {state: "failed", criteria: ""};
			this.derive();
			return;
		}

		model.traceCount = {state: "asking", criteria};
		this.serviceTask("lookups", lookups.traceCount(criteria), (count) => {
			model.traceCount =
				count === undefined
					? {state: "failed", criteria}
					: {state: "done", count, criteria};
		});
		this.derive();
	}

	/** The criteria the alert builder gets: the shared facts in the package's words. */
	criteria(): string[] {
		const lookups = this.lookups;

		if (!lookups || this.kind !== "channel") {
			return [];
		}

		return (this.channel.commonality?.facts ?? [])
			.map((fact) => lookups.criterion({key: fact.key, value: fact.value}))
			.filter((c): c is string => c !== undefined);
	}

	// -------------------------------------------------------------- user

	private startUser(): void {
		const nick = this.target;
		const nefarious = this.client.profile.id === "nefarious2";
		const opered = this.client.oper.level !== "none" && this.client.oper.level !== "service";
		const snoop = this.client.services?.bots.snoop.trim() ?? "";

		if (snoop && this.client.findChannel(snoop)?.state !== ChanState.JOINED) {
			this.userModel.snoopMissing = snoop;
		}

		if (nefarious) {
			this.serverTask("check", `CHECK ${nick}`, {end: ["291", "292"]}, (reply) =>
				this.applyUserCheck(reply)
			);
		} else {
			this.sources.check = "off";
		}

		this.serverTask("whois", `WHOIS ${nick} ${nick}`, {end: ["318", "401", "402"]}, (reply) =>
			this.applyWhois(reply)
		);
		this.serverTask("userip", `USERIP ${nick}`, {untagged: ["340"]}, (reply) =>
			this.applyUserIp(reply)
		);

		if (opered && nefarious) {
			const bans: LiveBan[] = [];
			let pending = 3;

			const done = (reply: ReplyUnit) => {
				for (const msg of reply.lines) {
					const ban = parseBanRow(msg);

					if (ban) {
						bans.push(ban);
					}
				}

				this.liveBans = bans;

				if (--pending === 0) {
					this.askGtrace(bans.length);
				}
			};

			for (const letter of ["g", "S", "Z"]) {
				this.serverTask("stats", `STATS ${letter}`, {end: ["219"]}, done);
			}
		} else {
			this.sources.stats = "off";
			this.notes.stats = nefarious ? "not opered" : "no ban list on this server";
			this.askGtrace(0);
		}

		const lookups = this.lookups;

		if (lookups) {
			this.lookupUser(this.userModel.user);
		} else {
			this.sources.lookups = "off";
			this.sources.account = "off";
			this.sources.gtrace = "off";
		}
	}

	private applyUserCheck(reply: ReplyUnit): void {
		const facts = parseCheck(reply.lines, `CHECK ${this.target}`);

		if (!facts || facts.error) {
			if (facts?.error) {
				this.sources.check = "failed";
				this.notes.check = facts.error;
			}

			return;
		}

		const user = this.userModel.user;
		const f = facts.fields;
		const nickField = /^(\S+)/.exec(f.Nick ?? "");

		if (nickField) {
			user.nick = nickField[1];
		}

		const real = /^(\S+?)@(\S+) \((.*)\)$/.exec(f["Real User/Host"] ?? "");

		if (real) {
			user.ident = real[1];
			user.host = real[2];
			user.ip = goodIp(real[3]) ?? user.ip;
		} else {
			const visible = /^(\S+?)@(\S+)$/.exec(f["User/Hostmask"] ?? "");

			if (visible) {
				user.ident ??= visible[1];
				user.host ??= visible[2];
			}
		}

		if (f["Real Name"]) {
			user.realname = f["Real Name"];
		}

		if (f["Connected to"]) {
			user.server = f["Connected to"];
		}

		if (f.Status && /Operator|Administrator/.test(f.Status)) {
			user.oper = true;
		}

		if (f["Umode(s)"]) {
			const [letters, ...rest] = f["Umode(s)"].split(/\s+/);
			user.modes = letters;

			if (letters.includes("r") && rest.length > 0) {
				user.account = rest[0].replace(/:\d+$/, "");
				user.authed = true;
			} else {
				user.authed ??= false;
			}
		}

		if (f["Channel(s)"] && !f["Channel(s)"].startsWith("- ")) {
			user.channels = f["Channel(s)"].split(/\s+/).filter(Boolean);
		}

		if (f["Signed on"]) {
			const at = parseCtime(f["Signed on"]);

			if (at !== undefined) {
				user.connectedAt = at;
			}
		}

		if (f["Idle for"]) {
			const idle = parseIdle(f["Idle for"]);

			if (idle !== undefined) {
				user.idle = idle;
			}
		}

		if (f.Country) {
			user.country = f.Country;
		}

		if (f["CTCP Version"]) {
			user.version = f["CTCP Version"];
		}

		if (f.Marks) {
			user.marks = f.Marks.split(",")
				.map((m) => m.trim())
				.filter(Boolean);
		}

		if (user.account) {
			this.askAccount(user.account);
		}
	}

	private applyWhois(reply: ReplyUnit): void {
		const user = this.userModel.user;

		for (const msg of reply.lines) {
			switch (msg.command) {
				case "311":
					user.nick = msg.params[1] ?? user.nick;
					user.ident ??= msg.params[2];
					user.host ??= msg.params[3];
					user.realname ??= last(msg);
					break;
				case "312":
					user.server ??= msg.params[2];
					break;
				case "313":
					user.oper = true;
					break;

				case "317": {
					const idle = Number(msg.params[2]);
					const signon = Number(msg.params[3]);

					if (Number.isFinite(idle) && user.idle === undefined) {
						user.idle = idle;
					}

					// Epoch seconds: surer than CHECK's ctime, which is in the
					// server's zone and read as UTC.
					if (msg.params.length > 4 && Number.isFinite(signon) && signon > 0) {
						user.connectedAt = signon * 1000;
					}

					break;
				}

				case "319":
					if (!user.channels?.length) {
						user.channels = last(msg).split(/\s+/).filter(Boolean);
					}

					break;
				case "330":
					if (msg.params[2]) {
						user.account = msg.params[2];
						user.authed = true;
						this.askAccount(user.account);
					}

					break;

				case "338": {
					// <nick> [<user>@]<host> <ip> :Actual user@host, Actual IP
					const userHost = msg.params[msg.params.length - 3] ?? "";
					const ip = goodIp(msg.params[msg.params.length - 2]);
					const at = userHost.indexOf("@");

					if (msg.params.length >= 4 && userHost) {
						user.host = userHost.slice(at + 1);

						if (at !== -1) {
							user.ident = userHost.slice(0, at);
						}
					}

					if (ip) {
						user.ip = ip;
					}

					break;
				}

				case "339":
					user.marks = [
						...(user.marks ?? []),
						...last(msg)
							.replace(/^is marked: /, "")
							.split(/,\s*/)
							.filter(Boolean),
					];
					break;
				case "301":
					user.away = true;
					break;
				default:
					break;
			}
		}

		// A 311 without a 330: the server would have said if they were logged in.
		if (reply.lines.some((m) => m.command === "311")) {
			user.authed ??= false;
		}
	}

	/** AuthServ `accountinfo` once the account is known (once per account). */
	private askAccount(account: string): void {
		const lookups = this.lookups;

		if (!lookups || this.kind !== "user" || this.accountAsked === account) {
			return;
		}

		this.accountAsked = account;
		this.serviceTask("account", lookups.account(account), (info) => {
			if (!info) {
				return;
			}

			const model = this.userModel;

			if (info.lastQuitHostmask) {
				model.lastQuitHostmask = info.lastQuitHostmask;
			}

			if (info.hostmasks.length > 0) {
				model.hostmasks = info.hostmasks;
			}
		});
	}

	/**
	 * O3 `gtrace` for the bans covering the host, only when the server
	 * listed none (its list is X3's too; when it could be read, there is
	 * nothing more to learn). Waits for a host to ask about.
	 */
	private askGtrace(serverBans: number): void {
		const lookups = this.lookups;

		if (!lookups || this.kind !== "user" || this.gtraceAsked) {
			return;
		}

		if (serverBans > 0) {
			this.sources.gtrace = "off";
			this.gtraceAsked = true;
			return;
		}

		const host = this.userModel.user.host;

		if (!host) {
			return; // tried again from derive() once a host is known
		}

		this.gtraceAsked = true;
		this.serviceTask("gtrace", lookups.bansCovering(host), (bans) => {
			if (bans) {
				this.userModel.serviceBans = bans;
			}
		});
	}

	// ------------------------------------------------- derived, from the feed

	/** Recompute what follows from the model and the feed, then tell the card. */
	private derive(): void {
		if (this.model.kind === "channel") {
			this.deriveChannel();
		} else {
			this.deriveUser();
		}

		this.changed();
	}

	private deriveChannel(): void {
		const model = this.channel;
		const feed = this.feed;
		const now = Date.now();
		const connects = connectTimes(feed);
		const joins = joinTimes(feed, model.target);

		for (const user of model.users) {
			const key = user.nick.toLowerCase();
			const connected = connects.get(key);
			const joined = joins.get(key);

			if (connected !== undefined && user.connectedAt === undefined) {
				user.connectedAt = connected;
			}

			if (joined !== undefined) {
				user.joinedAt = joined;
			}
		}

		model.recent = lastHourHere(feed, model.target, now);

		const common: CommonUser[] = model.users.map((u) => {
			const c: CommonUser = {nick: u.nick};

			if (u.authed !== undefined) {
				c.authed = u.authed;
			}

			if (u.connectedAt !== undefined) {
				c.connectedAt = u.connectedAt;
			}

			if (u.realname !== undefined) {
				c.realname = u.realname;
			}

			if (u.ident) {
				c.ident = u.ident;
			}

			if (u.ip) {
				c.ip = u.ip;
			}

			if (u.server) {
				c.server = u.server;
			}

			if (u.version) {
				c.version = u.version;
			}

			return c;
		});
		model.commonality = commonality(common, now);

		// The services lookups wait for the member list to be in.
		if (this.sources.check !== "asking" && this.sources.who !== "asking") {
			this.askUserLookups();
		}
	}

	private deriveUser(): void {
		const model = this.userModel;
		const user = model.user;
		const feed = this.feed;
		const now = Date.now();
		const identity: Identity = {nick: user.nick};

		if (user.ident) {
			identity.ident = user.ident;
		}

		if (user.host) {
			identity.host = user.host;
		}

		if (user.ip) {
			identity.ip = user.ip;
		}

		if (user.realname) {
			identity.realname = user.realname;
		}

		if (user.account) {
			identity.account = user.account;
		}

		if (user.version) {
			identity.version = user.version;
		}

		if (user.connectedAt === undefined) {
			const connected = connectTimes(feed).get(user.nick.toLowerCase());

			if (connected !== undefined) {
				user.connectedAt = connected;
			}
		}

		const near = bansNear(this.liveBans, feed, identity, now);
		model.liveBans = near.live;
		model.recentBans = near.recent;
		model.seen = seenBefore(feed, identity, (a, b) => this.client.namesEqual(a, b));
		model.verdict = verdict({user: identity, liveBans: near.live, seen: model.seen, now});

		if (this.sources.stats !== "asking" && !this.gtraceAsked) {
			this.askGtrace(this.liveBans.length);
		}
	}
}
