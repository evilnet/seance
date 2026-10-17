/**
 * The alert builder's wire side (docs/projects/oper-tools.md, "The alert
 * builder"): the oper service's alerts listed, a `trace print` of the
 * criteria being edited, an alert added or removed, and which of the
 * matched nicks are opers. Each is one quiet lookup to the oper service
 * (services.ts `collectServiceReply`, quiet.ts) in the package's words
 * (`ServicesLookups`, X3's in services/x3/alerts.ts); the opers come from
 * one `WHO` on the server. Nothing here paces: the builder sends one
 * thing at a time on the user's own cadence. Kept free of store/DOM
 * imports (mocha, test/irc/alerts.ts).
 */

import type {IrcClient} from "./client";
import {formatLine} from "./message";
import {fitsQuiet, sendQuiet} from "./quiet";
import {canRequest, request} from "./request";
import {collectServiceReply, type ServiceAnswer} from "./services";
import {servicesProfileFor} from "./services/index";
import type {
	CommandReply,
	ServiceAlert,
	ServiceLookup,
	ServicesLookups,
	TraceResult,
} from "./services/types";

/** What a lookup came to: the parsed value (undefined when the bot said "no such thing") or why there is none. */
export type LookupResult<T> =
	| {kind: "reply"; value: T | undefined; lines: string[]}
	| {kind: "missing" | "timeout" | "closed" | "toolong" | "unavailable"};

/** The lookups and the oper bot of a network with a package set up, or undefined. */
function lookupsOf(client: IrcClient): {lookups: ServicesLookups; bot: string} | undefined {
	const lookups = servicesProfileFor(client.services)?.lookups;
	const bot = client.services?.bots.oper.trim() ?? "";
	return lookups && bot ? {lookups, bot} : undefined;
}

/** Whether the network can be asked (a package with lookups and an oper service named). */
export function canAsk(client: IrcClient): boolean {
	return lookupsOf(client) !== undefined;
}

/** The oper service's nick, for the messages ("O3 did not answer."). */
export function operBot(client: IrcClient): string {
	return client.services?.bots.oper.trim() || "the oper service";
}

async function ask<T>(client: IrcClient, lookup: ServiceLookup<T>): Promise<LookupResult<T>> {
	const bot = client.services?.bots[lookup.role].trim() ?? "";

	if (!bot) {
		return {kind: "unavailable"};
	}

	const line = lookup.command(bot);

	if (!fitsQuiet(line)) {
		return {kind: "toolong"};
	}

	const reply = collectServiceReply(client, bot, {accept: (text) => lookup.accept(text)});

	if (!sendQuiet(client, line)) {
		return {kind: "closed"};
	}

	const answer: ServiceAnswer<string[]> = await reply;

	if (answer.kind !== "reply") {
		return {kind: answer.kind};
	}

	return {kind: "reply", value: lookup.parse(answer.value), lines: answer.value};
}

/** The oper's alerts (`stats alerts`). */
export function listAlerts(client: IrcClient): Promise<LookupResult<ServiceAlert[]>> {
	const l = lookupsOf(client);
	return l ? ask(client, l.lookups.alerts()) : Promise.resolve({kind: "unavailable"});
}

/** Who matches `criteria` right now (`trace print`). */
export function tracePrint(
	client: IrcClient,
	criteria: string
): Promise<LookupResult<TraceResult>> {
	const l = lookupsOf(client);
	return l ? ask(client, l.lookups.tracePrint(criteria)) : Promise.resolve({kind: "unavailable"});
}

/** Send the assembled `addalert …` and wait for the verdict. */
export function addAlert(client: IrcClient, command: string): Promise<LookupResult<CommandReply>> {
	const l = lookupsOf(client);
	return l ? ask(client, l.lookups.addAlert(command)) : Promise.resolve({kind: "unavailable"});
}

/** Remove the alert called `name`. */
export function delAlert(client: IrcClient, name: string): Promise<LookupResult<CommandReply>> {
	const l = lookupsOf(client);
	return l ? ask(client, l.lookups.delAlert(name)) : Promise.resolve({kind: "unavailable"});
}

/**
 * O3 has no edit: replacing an alert is `delalert` then `addalert`, one
 * after the other, both verdicts reported. Nothing is deleted when the add
 * could not be sent (too long), and the add is skipped when the delete
 * could not be asked at all (the bot missing, the network down). When the
 * delete went through and O3 refused the add, `restore` — the old alert's
 * own `addalert` — puts it back; an add that went unanswered may still have
 * landed, so nothing is resent then.
 */
export async function replaceAlert(
	client: IrcClient,
	name: string,
	command: string,
	restore: string
): Promise<{
	deleted: LookupResult<CommandReply>;
	added?: LookupResult<CommandReply>;
	restored?: LookupResult<CommandReply>;
}> {
	const l = lookupsOf(client);

	if (l && !fitsQuiet(l.lookups.addAlert(command).command(l.bot))) {
		return {deleted: {kind: "toolong"}};
	}

	const deleted = await delAlert(client, name);

	if (deleted.kind !== "reply") {
		return {deleted};
	}

	const added = await addAlert(client, command);

	if (deleted.value?.ok && added.kind === "reply" && !added.value?.ok) {
		return {deleted, added, restored: await addAlert(client, restore)};
	}

	return {deleted, added};
}

/** How many nicks one WHO asks about (the line must stay under the server's 500 bytes). */
export const WHO_NICKS = 20;

let tokens = 0;

/**
 * Which of `nicks` are opers, from one `WHO a,b,c %nf,<token>` (the first
 * {@link WHO_NICKS}); undefined when the server cannot be asked — no
 * labels, no WHOX — or did not answer. An oper's flags carry `*`.
 */
export async function opersAmong(
	client: IrcClient,
	nicks: string[]
): Promise<string[] | undefined> {
	if (nicks.length === 0) {
		return [];
	}

	if (!canRequest(client) || !client.isupport.has("WHOX")) {
		return undefined;
	}

	tokens = (tokens % 999) + 1;
	const token = String(tokens);
	const line = formatLine({
		command: "WHO",
		params: [nicks.slice(0, WHO_NICKS).join(","), `%nf,${token}`],
	});
	const reply = await request(client, line, {end: ["315"]});

	if (reply.outcome === "closed" || reply.outcome === "timeout") {
		return undefined;
	}

	const opers: string[] = [];

	for (const msg of reply.lines) {
		// <me> <token> <nick> <flags>
		if (msg.command === "354" && msg.params[1] === token && msg.params.length >= 4) {
			const [, , nick, flags] = msg.params;

			if (flags.includes("*")) {
				opers.push(nick);
			}
		}
	}

	return opers;
}

const levels = new WeakMap<IrcClient, Promise<number | undefined>>();

/**
 * The oper's own level with the oper service, from the account service's
 * `accountinfo` on the account this connection is logged in as (`Opserv
 * level: 900` is printed for staff); undefined when not logged in, not
 * asked, or not told. Asked once per connection and remembered.
 */
export function operLevel(client: IrcClient): Promise<number | undefined> {
	const cached = levels.get(client);

	if (cached) {
		return cached;
	}

	const lookups = servicesProfileFor(client.services)?.lookups;
	const account = client.account;

	if (!lookups || !account) {
		return Promise.resolve(undefined);
	}

	const promise = ask(client, lookups.account(account)).then((result) => {
		if (result.kind === "reply") {
			return result.value?.opservLevel;
		}

		levels.delete(client); // nothing learnt: ask again next time
		return undefined;
	});
	levels.set(client, promise);
	return promise;
}

/** Why a lookup brought nothing, in words (`O3 is not online (no such nick).`). */
export function describeFailure(client: IrcClient, result: LookupResult<unknown>): string {
	const bot = operBot(client);

	switch (result.kind) {
		case "missing":
			return `${bot} is not online (no such nick).`;
		case "timeout":
			return `${bot} did not answer.`;
		case "closed":
			return "The connection is down.";
		case "toolong":
			return `That is too long to send to ${bot}: shorten the reason or the criteria.`;
		case "unavailable":
			return "No oper service is set up for this network.";
		default:
			return "";
	}
}
