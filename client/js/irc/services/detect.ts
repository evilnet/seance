/**
 * Finding a network's services out at oper-up, for a network the oper set
 * nothing for and the list (`../known-networks.ts`) does not know: the
 * server's own table of service commands (the profile's `serviceMappings`,
 * nefarious2's `STATS R`) names the bots, the command names say which is
 * which, and a WHOIS of each — the one the trust check needs anyway
 * (`../bottrust.ts`) — says they are network services and whose package
 * they are. One command more than a configured network costs, on the
 * background lane; a second (`VERSION <services server>`) only when no
 * bot carries a realname a package ships with.
 *
 * Nothing is adopted on a guess: a named bot that is offline or not a
 * network service, or a package no profile recognises, leaves the network
 * as it was, to be asked again at the next oper-up.
 *
 * Kept free of store/DOM imports (mocha, test/irc/services/detect.ts).
 */

import type {ServicesConfig} from "../../../../shared/types/network";
import type {IrcClient} from "../client";
import {whoisBot, type BotWhois} from "../bottrust";
import type {ServiceMapping} from "../profiles/types";
import {canRequest, request} from "../request";
import {get as getSavedNetwork} from "../saved-networks";
import {SERVICES_PROFILES, type ServicesProfile} from "./index";

export type DetectRole = "oper" | "account" | "channel";

const ROLES: DetectRole[] = ["oper", "account", "channel"];

/** The command names networks give each role's bot. */
const ROLE_COMMANDS: Record<DetectRole, string[]> = {
	oper: ["OPERSERV"],
	account: ["AUTHSERV", "NICKSERV"],
	channel: ["CHANSERV"],
};

/** Commands of bots that fill none of the three roles. */
const OTHER_COMMANDS = [
	"GLOBAL",
	"MEMOSERV",
	"HELPSERV",
	"SPAMSERV",
	"HOSTSERV",
	"BOTSERV",
	"STATSERV",
];

/** How many bots nobody could place are asked about; each is a WHOIS. */
const MAX_OPEN = 3;

export interface MappingRoles {
	/** The bots a command name places. */
	roles: Partial<Record<DetectRole, string>>;
	/** Bots no command name places, or rules out: one of them may fill a role still open. */
	open: string[];
	/** The server each bot's commands go to, by lowercased nick. */
	servers: Map<string, string>;
}

/** Read the server's table: which bot each role's command goes to. */
export function rolesFromMappings(rows: ServiceMapping[]): MappingRoles {
	const roles: Partial<Record<DetectRole, string>> = {};
	const servers = new Map<string, string>();
	const nicks = new Map<string, string>();
	const other = new Set<string>();

	for (const row of rows) {
		const key = row.nick.toLowerCase();
		nicks.set(key, nicks.get(key) ?? row.nick);
		servers.set(key, servers.get(key) ?? row.server);

		if (OTHER_COMMANDS.includes(row.command)) {
			other.add(key);
		}

		for (const role of ROLES) {
			if (roles[role] === undefined && ROLE_COMMANDS[role].includes(row.command)) {
				roles[role] = row.nick;
			}
		}
	}

	const placed = new Set(ROLES.map((role) => roles[role]?.toLowerCase()));
	const open = [...nicks.keys()]
		.filter((key) => !placed.has(key) && !other.has(key))
		.map((key) => nicks.get(key) as string);

	return {roles, open, servers};
}

/**
 * Settle the roles with what WHOIS said of each bot, for `profile`:
 * undefined when a bot a command named is not there to be trusted. A bot
 * nobody placed takes the role its realname names, or — the only one left,
 * for the only role left — that role, unless its realname says otherwise.
 */
export function settleRoles(
	found: MappingRoles,
	whois: Map<string, BotWhois>,
	profile: ServicesProfile
): Partial<Record<DetectRole, string>> | undefined {
	const real = (nick: string) => {
		const answer = whois.get(nick.toLowerCase());
		return answer?.online && answer.service ? answer : undefined;
	};
	const roles = {...found.roles};

	for (const role of ROLES) {
		if (roles[role] !== undefined && !real(roles[role])) {
			return undefined;
		}
	}

	const open = found.open.filter((nick) => real(nick));
	const said = (nick: string) => profile.roleOfRealname?.(real(nick)?.realname ?? "");
	const unplaced: string[] = [];

	for (const nick of open) {
		const role = said(nick);

		if (role === undefined) {
			unplaced.push(nick);
		} else if (role !== "other" && roles[role] === undefined) {
			roles[role] = nick;
		}
	}

	const missing = ROLES.filter((role) => roles[role] === undefined);

	if (missing.length === 1 && unplaced.length === 1) {
		roles[missing[0]] = unplaced[0];
	}

	return roles;
}

/** The package whose bots these are, by a realname it ships with. */
function profileByRealname(whois: Iterable<BotWhois>): ServicesProfile | undefined {
	const answers = [...whois].filter((answer) => answer.online && answer.service);

	return SERVICES_PROFILES.find((profile) =>
		answers.some((answer) => profile.roleOfRealname?.(answer.realname) !== undefined)
	);
}

/** The package the services server says it is (`VERSION <server>` → 351). */
async function profileByVersion(
	client: IrcClient,
	server: string
): Promise<ServicesProfile | undefined> {
	await client.whenRoom("services:version");

	const reply = await request(client, `VERSION ${server}`, {
		end: ["351", "402"],
		quiet: true,
		timeoutMs: 15_000,
	});
	const line = reply.lines.find((msg) => msg.command === "351");
	const text = line ? line.params.slice(1).join(" ") : "";

	return text === "" ? undefined : SERVICES_PROFILES.find((p) => p.isVersion?.(text));
}

/**
 * Ask the server which nicks are its services and adopt them
 * (`IrcClient.adoptServices`) when they check out. Resolves with what was
 * adopted, or undefined: services already set, the oper chose "None", a
 * server that cannot say, or bots that did not check out.
 */
export async function detectServices(client: IrcClient): Promise<ServicesConfig | undefined> {
	const mappings = client.profile.serviceMappings;
	const serial = client.connectionSerial;
	const moot = () =>
		client.services !== undefined ||
		getSavedNetwork(client.uuid)?.servicesChosen === true ||
		serial !== client.connectionSerial ||
		!canRequest(client);

	if (!mappings || moot()) {
		return undefined;
	}

	await client.whenRoom("services:mappings");

	if (moot()) {
		return undefined;
	}

	const reply = await request(client, mappings.command, {end: mappings.end, quiet: true});
	const found = rolesFromMappings(mappings.parse(reply.lines));
	const named = ROLES.map((role) => found.roles[role]).filter((n) => n !== undefined);
	const asked = [...new Set([...named, ...found.open.slice(0, MAX_OPEN)])];

	if (named.length === 0 || moot()) {
		return undefined;
	}

	const whois = new Map<string, BotWhois>();

	for (const nick of asked) {
		await client.whenRoom(`services:whois:${nick.toLowerCase()}`);

		if (moot()) {
			return undefined;
		}

		whois.set(nick.toLowerCase(), (await whoisBot(client, nick)).whois);
	}

	const first = named[0].toLowerCase();
	const server = whois.get(first)?.server ?? found.servers.get(first) ?? "";
	const profile =
		profileByRealname(whois.values()) ??
		(server === "" || moot() ? undefined : await profileByVersion(client, server));
	const roles = profile ? settleRoles(found, whois, profile) : undefined;

	if (!profile || !roles?.oper || moot()) {
		return undefined;
	}

	const services: ServicesConfig = {
		package: profile.id,
		bots: {
			oper: roles.oper,
			account: roles.account ?? "",
			channel: roles.channel ?? "",
			report: "",
			snoop: "",
		},
	};

	client.adoptServices(services);
	return services;
}
