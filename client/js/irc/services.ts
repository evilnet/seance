/**
 * Talking to a network's services bots (docs/projects/oper-tools.md,
 * "Services support"): the liveness check the edit form runs on the
 * configured bots, and waiting for a bot's NOTICE in answer to a command
 * sent to it — a services package answers a PRIVMSG with a NOTICE, which
 * no label correlates, so the answer is recognised by who sent it and what
 * it says. The package's formats are its profile (`./services/`).
 *
 * Kept free of store/DOM imports (mocha, test/irc/services.ts).
 */

import type {ServicesConfig} from "../../../shared/types/network";
import type {IrcClient} from "./client";
import type {IrcMessage} from "./message";
import {sendQuiet} from "./quiet";
import {request} from "./request";
import {servicesProfileFor} from "./services/index";
import {X3_REALNAMES} from "./services/x3";
import {cleanIrcMessage as stripFormatting} from "../../../shared/irc";
import {t, tCount} from "../i18n/core";
import {andList} from "../helpers/operList";

export type ServiceRole = "oper" | "account" | "channel";

/** A bot's role in words (`Oper service`). */
export function serviceRoleLabel(role: ServiceRole): string {
	switch (role) {
		case "oper":
			return t("oper.services.role.oper");
		case "account":
			return t("oper.services.role.account");
		default:
			return t("oper.services.role.channel");
	}
}

/** One bot's answer to the liveness check. */
export interface ServiceCheck {
	role: ServiceRole;
	bot: string;
	online: boolean;
	/** It carries the package's usual realname, or the server calls it a service. */
	looksLikeX3: boolean;
}

/** The check as a whole: the bots, or why none could be asked. */
export interface ServicesCheckResult {
	results: ServiceCheck[];
	/** `closed` when the network is down, `timeout` when the server never answered. */
	failure?: "closed" | "timeout";
}

/** How long one WHOIS may take before the check gives up on it. */
export const SERVICE_CHECK_TIMEOUT_MS = 15_000;

/**
 * WHOIS each configured bot (one labeled request per bot, in parallel —
 * three commands are well under the server's fake-lag budget) and say
 * which are online and which look like the package: a 311 means online; a
 * realname among the package's defaults, or a 310/313 that calls the user a
 * service, means it looks the part.
 */
export async function checkServices(
	client: IrcClient,
	services: ServicesConfig
): Promise<ServicesCheckResult> {
	const roles: ServiceRole[] = ["oper", "account", "channel"];
	const bots = roles
		.map((role) => ({role, bot: services.bots[role].trim()}))
		.filter((b) => b.bot !== "");

	const replies = await Promise.all(
		bots.map((b) =>
			request(client, `WHOIS ${b.bot}`, {
				end: ["318", "401"],
				timeoutMs: SERVICE_CHECK_TIMEOUT_MS,
			})
		)
	);

	const results: ServiceCheck[] = bots.map((b, i) => {
		const lines = replies[i].lines;
		const user = lines.find((msg) => msg.command === "311");
		const realname = user?.params[user.params.length - 1] ?? "";
		const service = lines.some(
			(msg) =>
				(msg.command === "310" || msg.command === "313") &&
				/service/i.test(msg.params[msg.params.length - 1] ?? "")
		);
		const online = user !== undefined;

		return {
			role: b.role,
			bot: b.bot,
			online,
			looksLikeX3: online && (service || X3_REALNAMES.includes(realname.trim())),
		};
	});

	const outcomes = replies.map((r) => r.outcome);
	const result: ServicesCheckResult = {results};

	if (bots.length > 0 && outcomes.every((o) => o === "closed")) {
		result.failure = "closed";
	} else if (outcomes.some((o) => o === "timeout")) {
		result.failure = "timeout";
	}

	return result;
}

/** The check in plain words for the form's status line. */
export function describeServiceCheck(check: ServicesCheckResult, packageName = "X3"): string {
	if (check.failure === "closed") {
		return t("oper.services.check.closed");
	}

	if (check.failure === "timeout") {
		return t("oper.services.check.timeout");
	}

	const {results} = check;

	if (results.length === 0) {
		return t("oper.services.check.noBots");
	}

	const offline = results.filter((r) => !r.online).map((r) => r.bot);
	const online = results.filter((r) => r.online);
	const parts: string[] = [];

	if (offline.length > 0) {
		parts.push(tCount("oper.services.check.offline", offline.length, {bots: andList(offline)}));
	}

	if (online.length > 0) {
		const bots = andList(online.map((r) => r.bot));
		const odd = online.filter((r) => !r.looksLikeX3).map((r) => r.bot);
		const vars = {bots, package: packageName};
		let sentence =
			odd.length === 0
				? tCount("oper.services.check.onlineLooks", online.length, vars)
				: tCount("oper.services.check.online", online.length, vars);

		if (offline.length === 0) {
			sentence = t("oper.services.check.allGood", {sentence});
		}

		if (odd.length > 0) {
			sentence = t("oper.services.check.sentences", {
				first: sentence,
				second: tCount("oper.services.check.notLike", odd.length, {
					bots: andList(odd),
					package: packageName,
				}),
			});
		}

		parts.push(sentence);
	}

	return parts.length === 2
		? t("oper.services.check.sentences", {first: parts[0], second: parts[1]})
		: parts.join("");
}

// ------------------------------------------------ a bot's NOTICE in answer

export const SERVICE_REPLY_TIMEOUT_MS = 10_000;

/**
 * What waiting for a bot came to: its reply, the server saying there is no
 * such nick (`401`), silence, or the network going down.
 */
export type ServiceAnswer<T> =
	| {kind: "reply"; value: T}
	| {kind: "missing"}
	| {kind: "timeout"}
	| {kind: "closed"};

interface ReplyWatcher<T> {
	bot: string;
	matcher: (text: string, msg: IrcMessage) => T | undefined;
	resolve: (answer: ServiceAnswer<T>) => void;
	timer: ReturnType<typeof setTimeout>;
	/** A line this watcher accepts is consumed: shown in no window. */
	quiet: boolean;
	/** Set by a collector's matcher when it kept the line without settling. */
	took?: boolean;
}

export interface AwaitOptions {
	timeoutMs?: number;
	/**
	 * Consume the accepted NOTICE rather than show it. The ban path leaves
	 * it shown (O3's words are the confirmation); a lookup whose answer a
	 * card or form renders itself takes it quietly.
	 */
	quiet?: boolean;
}

const watchers = new WeakMap<IrcClient, ReplyWatcher<unknown>[]>();

function watchersOf(client: IrcClient): ReplyWatcher<unknown>[] {
	let list = watchers.get(client);

	if (!list) {
		list = [];
		watchers.set(client, list);
	}

	return list;
}

function settle<T>(
	list: ReplyWatcher<unknown>[],
	watcher: ReplyWatcher<T>,
	answer: ServiceAnswer<T>
): void {
	const i = list.indexOf(watcher as ReplyWatcher<unknown>);

	if (i !== -1) {
		list.splice(i, 1);
	}

	clearTimeout(watcher.timer);
	watcher.resolve(answer);
}

/**
 * Resolve with what `matcher` makes of the next NOTICE from `bot` to us
 * that it accepts (formatting stripped); with `missing` when the server
 * answers `401` for that nick instead (the bot is not online); with
 * `timeout` after `timeoutMs`; with `closed` at once when the network is
 * down. The notice is still shown where it would have been unless
 * `quiet`: the oper sees the bot's words too.
 */
export function awaitServiceReply<T>(
	client: IrcClient,
	bot: string,
	matcher: (text: string, msg: IrcMessage) => T | undefined,
	options: number | AwaitOptions = {}
): Promise<ServiceAnswer<T>> {
	const opts: AwaitOptions = typeof options === "number" ? {timeoutMs: options} : options;
	const timeoutMs = opts.timeoutMs ?? SERVICE_REPLY_TIMEOUT_MS;

	return new Promise((resolve) => {
		if (!client.isWelcomed) {
			resolve({kind: "closed"});
			return;
		}

		const list = watchersOf(client);
		const watcher: ReplyWatcher<T> = {
			bot,
			matcher,
			resolve,
			timer: setTimeout(() => settle(list, watcher, {kind: "timeout"}), timeoutMs),
			quiet: opts.quiet ?? false,
		};
		list.push(watcher as ReplyWatcher<unknown>);
	});
}

/**
 * Called from `IrcClient.handleMessage` for every live line: hands a bot's
 * NOTICE, or the server's `401` about it, to the watcher waiting for it.
 * Returns true when a quiet watcher consumed the line — the handlers then
 * never see it, so it shows in no window; the card or form that asked
 * renders the answer (its Raw replies keep the words). A line nobody is
 * waiting for, or that a watcher accepted without `quiet`, is shown as
 * usual; the `401` is always shown.
 */
export function noteServiceReply(client: IrcClient, msg: IrcMessage): boolean {
	const list = watchers.get(client);

	if (!list || list.length === 0 || client.replaying) {
		return false;
	}

	const fromServer = !msg.source || msg.source.user === undefined;

	if (msg.command === "401" && fromServer) {
		const nick = msg.params[1] ?? "";

		for (const watcher of [...list]) {
			if (client.namesEqual(watcher.bot, nick)) {
				settle(list, watcher, {kind: "missing"});
			}
		}

		return false;
	}

	if (msg.command !== "NOTICE" || fromServer) {
		return false;
	}

	const from = msg.source?.name ?? "";

	if (!from || !client.isSelf(msg.params[0] ?? "")) {
		return false;
	}

	const text = stripFormatting(msg.params[msg.params.length - 1] ?? "");
	let consumed = false;

	for (const watcher of [...list]) {
		if (!client.namesEqual(watcher.bot, from)) {
			continue;
		}

		watcher.took = false;
		const value = watcher.matcher(text, msg);

		if (value !== undefined) {
			settle(list, watcher, {kind: "reply", value});
			consumed ||= watcher.quiet;
		} else if (watcher.took) {
			consumed ||= watcher.quiet;
		}
	}

	return consumed;
}

/** How long a multi-line bot reply may stay silent before it is taken as complete. */
export const SERVICE_QUIET_MS = 1500;

export interface CollectOptions {
	/**
	 * What to do with a line from the bot: `start` opens the collection
	 * (the first line of the answer), `take` keeps a line of an open one,
	 * `end` keeps it and completes, `skip` ignores it. Before the first
	 * `start`, `take` counts as `skip`.
	 */
	accept: (text: string) => "start" | "take" | "end" | "skip";
	/** Silence after the last taken line that completes the answer. */
	quietMs?: number;
	/** How long to wait for the first line. */
	timeoutMs?: number;
}

/**
 * Collect a multi-line NOTICE answer from `bot` (O3's `whois` and
 * `chaninfo`, AuthServ's `accountinfo`, ChanServ's `info`): the lines from
 * the one `accept` says starts it, until the one it says ends it or
 * {@link SERVICE_QUIET_MS} of silence — several of those replies have no
 * footer. Resolves like {@link awaitServiceReply}: `reply` with the lines
 * (formatting stripped), `missing` on a 401 for the bot, `timeout` when
 * nothing started, `closed` when the network is down. Always quiet: a
 * line taken shows in no window (the asker renders the answer), a line
 * skipped shows as usual.
 */
export function collectServiceReply(
	client: IrcClient,
	bot: string,
	opts: CollectOptions
): Promise<ServiceAnswer<string[]>> {
	return new Promise((resolve) => {
		if (!client.isWelcomed) {
			resolve({kind: "closed"});
			return;
		}

		const list = watchersOf(client);
		const lines: string[] = [];
		let quiet: ReturnType<typeof setTimeout> | undefined;
		const watcher: ReplyWatcher<string[]> = {
			bot,
			matcher(text) {
				const verdict = opts.accept(text);

				if (verdict === "skip" || (verdict === "take" && lines.length === 0)) {
					return undefined;
				}

				lines.push(text);
				clearTimeout(quiet);

				if (verdict === "end") {
					return lines; // the caller settles with it
				}

				watcher.took = true;
				quiet = setTimeout(
					() => settle(list, watcher, {kind: "reply", value: lines}),
					opts.quietMs ?? SERVICE_QUIET_MS
				);
				return undefined;
			},
			resolve(answer) {
				clearTimeout(quiet);
				resolve(answer);
			},
			timer: setTimeout(
				() =>
					settle(
						list,
						watcher,
						lines.length > 0 ? {kind: "reply", value: lines} : {kind: "timeout"}
					),
				opts.timeoutMs ?? SERVICE_REPLY_TIMEOUT_MS
			),
			quiet: true,
		};
		list.push(watcher as ReplyWatcher<unknown>);
	});
}

/** The socket closed: whoever was waiting for a bot gets `closed`. */
export function resetServiceReplies(client: IrcClient): void {
	const list = watchers.get(client);

	if (!list) {
		return;
	}

	for (const watcher of list.splice(0)) {
		clearTimeout(watcher.timer);
		watcher.resolve({kind: "closed"});
	}
}

/** How a ban asked of the oper service ended (the `services:banned` payload). */
export interface ServicesBanOutcome {
	outcome: "ok" | "refused" | "timeout" | "closed";
	/** The bot's words (ok, refused), or why it could not be asked. */
	text?: string;
}

/**
 * Ask the oper service for a G-line or shun and wait for its verdict in
 * its own words. Only for a package whose profile we have and a network
 * with an oper service named; the line goes out as a quiet PRIVMSG to the
 * bot (quiet.ts: its echo opens no query window), and the bot's reply is
 * shown where a notice lands — it is the confirmation. A `401` for the
 * bot is `refused` with "O3 is not online".
 */
export async function servicesBan(
	client: IrcClient,
	ban: {type: "gline" | "shun"; mask: string; seconds: number; reason: string}
): Promise<ServicesBanOutcome> {
	const services = client.services;
	const profile = servicesProfileFor(services);

	if (!services || !profile || !services.bots.oper) {
		return {outcome: "closed", text: t("oper.services.noOperService")};
	}

	const bot = services.bots.oper;
	const reply = awaitServiceReply(client, bot, (text) => profile.parseBanReply(text));

	if (!sendQuiet(client, profile.banCommand(bot, ban))) {
		resetServiceReplies(client);
		return {outcome: "closed"};
	}

	const answer = await reply;

	switch (answer.kind) {
		case "reply":
			return {outcome: answer.value.ok ? "ok" : "refused", text: answer.value.text};
		case "missing":
			return {outcome: "refused", text: t("oper.services.botOffline", {bot})};
		default:
			return {outcome: answer.kind};
	}
}
