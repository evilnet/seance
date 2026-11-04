/**
 * Which lines really come from a services bot (docs/projects/oper-tools.md,
 * "Services support"). A bot is named by nick in the network's settings, and
 * a nick is anyone's to take while the bot is away: a user holding "O3"
 * during a services outage could answer the cards' lookups, confirm a ban
 * that was never set, or post snoop lines that fill the notice log. So a bot
 * is trusted only once WHOIS calls it a network service (310, the `+k` user
 * mode, which only services and opers with the SERVICE privilege can set),
 * and from then on only lines from the `user@host` that WHOIS gave count as
 * the bot's. A new connection forgets everything, and so does the bot's QUIT
 * or NICK; a line from the bot's nick but another address asks again (at
 * most once a minute), in case services came back somewhere else; a command
 * to the bot asks again when the last check is five minutes old.
 *
 * Kept free of store/DOM imports (mocha, test/irc/bottrust.ts).
 */

import type {IrcClient} from "./client";
import type {IrcMessage} from "./message";
import {request, type ReplyUnit} from "./request";

/** What one WHOIS said about a bot. */
export interface BotWhois {
	online: boolean;
	/** WHOIS called it a network service (310, or a 313 that says "service"). */
	service: boolean;
	user?: string;
	host?: string;
	server?: string;
	realname: string;
}

/** How long one WHOIS may take. */
export const BOT_WHOIS_TIMEOUT_MS = 15_000;
/** The least time between two checks of the same bot prompted by its lines. */
export const BOT_RECHECK_MS = 60_000;
/**
 * How long a check stands before a command is sent to the bot: past this,
 * WHOIS is asked again first, so a ban's mask and reason never go to
 * whoever took the nick since (a QUIT or NICK we see forgets it sooner,
 * but only in a channel we share).
 */
export const BOT_SEND_FRESH_MS = 5 * 60_000;

/** Where a bot stands: asked and trusted (at this address), asked and not, or not asked. */
export type BotTrust = "trusted" | "untrusted" | "unknown";

interface Entry {
	/** The connection it was learned on (`IrcClient.connectionSerial`). */
	serial: number;
	trusted: boolean;
	/** `user@host`, lower case; undefined when the bot was not online. */
	userhost?: string;
	checkedAt: number;
}

interface Store {
	entries: Map<string, Entry>;
	/** The check running per bot, and the connection it runs for. */
	inflight: Map<string, {serial: number; promise: Promise<BotTrust>}>;
	/** Bumped by every `forgetBot`: a WHOIS asked before it is not recorded. */
	forgets: Map<string, number>;
}

const stores = new WeakMap<IrcClient, Store>();

function storeOf(client: IrcClient): Store {
	let store = stores.get(client);

	if (!store) {
		store = {entries: new Map(), inflight: new Map(), forgets: new Map()};
		stores.set(client, store);
	}

	return store;
}

function entryOf(client: IrcClient, nick: string): Entry | undefined {
	const entry = storeOf(client).entries.get(client.casefold(nick));
	return entry && entry.serial === client.connectionSerial ? entry : undefined;
}

const userhostOf = (user: string | undefined, host: string | undefined) =>
	user && host ? `${user}@${host}`.toLowerCase() : undefined;

/** Read a WHOIS reply. */
export function parseBotWhois(lines: IrcMessage[]): BotWhois {
	const user = lines.find((msg) => msg.command === "311");
	const server = lines.find((msg) => msg.command === "312");
	const service = lines.some(
		(msg) =>
			(msg.command === "310" || msg.command === "313") &&
			/service/i.test(msg.params[msg.params.length - 1] ?? "")
	);
	const whois: BotWhois = {
		online: user !== undefined,
		service,
		realname: user?.params[user.params.length - 1] ?? "",
	};

	if (user) {
		whois.user = user.params[2];
		whois.host = user.params[3];
	}

	if (server) {
		whois.server = server.params[2];
	}

	return whois;
}

/** Remember what a WHOIS said about `nick` for this connection. */
export function recordBotWhois(client: IrcClient, nick: string, whois: BotWhois): BotTrust {
	const userhost = whois.online ? userhostOf(whois.user, whois.host) : undefined;
	const trusted = whois.online && whois.service && userhost !== undefined;
	storeOf(client).entries.set(client.casefold(nick), {
		serial: client.connectionSerial,
		trusted,
		userhost,
		checkedAt: Date.now(),
	});
	return trusted ? "trusted" : "untrusted";
}

/** WHOIS a bot and remember the answer (the liveness check uses it too). */
export async function whoisBot(
	client: IrcClient,
	nick: string,
	timeoutMs = BOT_WHOIS_TIMEOUT_MS
): Promise<{whois: BotWhois; outcome: ReplyUnit["outcome"]}> {
	const store = storeOf(client);
	const key = client.casefold(nick);
	const serial = client.connectionSerial;
	const forgets = store.forgets.get(key) ?? 0;
	const reply = await request(client, `WHOIS ${nick}`, {end: ["318", "401"], timeoutMs});
	const whois = parseBotWhois(reply.lines);
	// A QUIT or NICK since the question, or a new connection: the answer is
	// about someone who may hold the nick no more.
	const stale = serial !== client.connectionSerial || forgets !== (store.forgets.get(key) ?? 0);

	if (!stale && reply.outcome !== "timeout" && reply.outcome !== "closed") {
		recordBotWhois(client, nick, whois);
	}

	return {whois, outcome: reply.outcome};
}

/** Where `nick` stands on this connection, without asking. */
export function botTrust(client: IrcClient, nick: string): BotTrust {
	const entry = entryOf(client, nick);
	return entry ? (entry.trusted ? "trusted" : "untrusted") : "unknown";
}

/** Whether a command may go to `nick` without asking WHOIS first. */
export function botSendable(client: IrcClient, nick: string, now = Date.now()): boolean {
	const entry = entryOf(client, nick);
	return client.isWelcomed && !!entry?.trusted && now - entry.checkedAt < BOT_SEND_FRESH_MS;
}

/**
 * `nick` left or changed (QUIT, NICK, CHGHOST): whoever holds the nick next
 * is asked about afresh.
 */
export function forgetBot(client: IrcClient, nick: string): void {
	const store = storeOf(client);
	const key = client.casefold(nick);
	store.entries.delete(key);
	store.forgets.set(key, (store.forgets.get(key) ?? 0) + 1);
}

/** Whether the last WHOIS on this connection found `nick` online, real or not. */
export function botOnline(client: IrcClient, nick: string): boolean {
	return entryOf(client, nick)?.userhost !== undefined;
}

/**
 * Whether `msg` comes from the bot `nick` as WHOIS knows it: the nick, and
 * the trusted entry's `user@host`. False for anything not yet asked.
 */
export function fromTrustedBot(client: IrcClient, msg: IrcMessage, nick: string): boolean {
	const from = msg.source?.name;

	if (!from || msg.source?.user === undefined || !client.namesEqual(from, nick)) {
		return false;
	}

	const entry = entryOf(client, nick);
	return !!entry?.trusted && entry.userhost === userhostOf(msg.source.user, msg.source.host);
}

/**
 * Make sure `nick` has been asked on this connection, and say where it
 * stands. One WHOIS per bot at a time; `background` waits its turn behind
 * the fake lag (`IrcClient.whenRoom`) — for checks nobody is waiting on;
 * `maxAge` asks again when the last check is older.
 */
export function verifyBot(
	client: IrcClient,
	nick: string,
	opts: {background?: boolean; force?: boolean; maxAge?: number} = {}
): Promise<BotTrust> {
	const known = entryOf(client, nick);
	const fresh = opts.maxAge === undefined || Date.now() - (known?.checkedAt ?? 0) < opts.maxAge;

	if (known && fresh && !opts.force) {
		return Promise.resolve(known.trusted ? "trusted" : "untrusted");
	}

	const store = storeOf(client);
	const key = client.casefold(nick);
	const serial = client.connectionSerial;
	const running = store.inflight.get(key);

	// One from an earlier connection may wait forever on a queue cleared at
	// the close: never reuse it.
	if (running?.serial === serial) {
		return running.promise;
	}

	const run = async (): Promise<BotTrust> => {
		if (opts.background) {
			await client.whenRoom(`bottrust:${key}`);
		}

		if (serial !== client.connectionSerial || !client.isWelcomed) {
			return "unknown";
		}

		const {outcome} = await whoisBot(client, nick);
		return outcome === "timeout" || outcome === "closed" ? "unknown" : botTrust(client, nick);
	};

	const promise = run().finally(() => {
		if (store.inflight.get(key)?.promise === promise) {
			store.inflight.delete(key);
		}
	});
	store.inflight.set(key, {serial, promise});
	return promise;
}

/**
 * A line from a bot's nick that `fromTrustedBot` turned down: ask WHOIS
 * again in the background, in case it is the bot come back (or come back
 * elsewhere) rather than someone else. A trusted bot's nick at another
 * address means the bot holds it no more: its trust goes at once, so no
 * command follows it. A bot last seen offline is asked at once — someone
 * holds the nick now; one seen online at most once a minute. Returns the
 * answer to come, or undefined when it was not asked.
 */
export function recheckBot(
	client: IrcClient,
	nick: string,
	now = Date.now()
): Promise<BotTrust> | undefined {
	const entry = entryOf(client, nick);

	if (entry?.trusted) {
		forgetBot(client, nick);
		return verifyBot(client, nick, {background: true});
	}

	if (entry?.userhost !== undefined && now - entry.checkedAt < BOT_RECHECK_MS) {
		return undefined;
	}

	return verifyBot(client, nick, {background: true, force: entry !== undefined});
}
