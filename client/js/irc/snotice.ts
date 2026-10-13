/**
 * Server notices and WALLOPS, routed by importance: the important ones show
 * in the window the user is looking at, the routine ones stay in the
 * network's lobby without raising unread, and a kind the oper turned off is
 * dropped. No dedicated windows (docs/projects/oper-tools.md, feature 1).
 *
 * A server notice is a NOTICE from a server (no `user@host`) whose text
 * starts `*** Notice -- `, addressed to `*` (the snomask notices) or to us
 * (the `+W` "did a /whois on you"). The profile classifies the rest of the
 * text into a kind with fields; the kind's route is the oper's choice
 * (operprefs.ts) or the profile's default; unrecognised text goes to the
 * network window. Every routed line is kept in the notice log (noticelog.ts)
 * so a reload brings it back.
 *
 * Kept free of store/DOM imports (mocha).
 */

import {MessageType, SharedMsg} from "../../../shared/types/msg";
import type {Route, SnoticeInfo} from "../../../shared/types/oper";
import type {IrcClient} from "./client";
import type {IrcMessage} from "./message";
import type {LoggedNotice} from "./noticelog";
import {routeFor} from "./operprefs";
import {profileById} from "./profiles";
import type {NoticeKind, ServerProfile} from "./profiles/types";

export const NOTICE_PREFIX = "*** Notice -- ";

/** The WALLOPS family: the same command, told apart by a prefix (nefarious2/ircu). */
export const WALLOPS_KINDS: NoticeKind[] = [
	{kind: "wallops", label: "WALLOPS from opers", category: "WALLOPS", route: "active"},
	{
		kind: "wallusers",
		label: "WALLUSERS (to every +w user)",
		category: "WALLOPS",
		route: "active",
	},
	{kind: "wallops.server", label: "WALLOPS from servers", category: "WALLOPS", route: "active"},
	{kind: "desynch", label: "Desync reports (+g)", category: "WALLOPS", route: "network"},
];

export const UNKNOWN_KIND: NoticeKind = {
	kind: "unknown",
	label: "Unrecognised server notices",
	category: "OTHER",
	route: "network",
};

/** Every kind the routing UI lists for a profile: WALLOPS first, unknown last. */
export function allNoticeKinds(profile: ServerProfile): NoticeKind[] {
	return [...WALLOPS_KINDS, ...profile.noticeKinds, UNKNOWN_KIND];
}

/**
 * A kind's label, category, default route and template, from the profile
 * the UI knows the network by (`SharedOperState.profile`); without one, from
 * any profile that has it (notices restored before the network connected).
 */
export function findNoticeKind(kind: string, profileId?: string): NoticeKind | undefined {
	const own = allNoticeKinds(profileById(profileId)).find((k) => k.kind === kind);

	if (own || profileId) {
		return own;
	}

	return allNoticeKinds(profileById("nefarious2")).find((k) => k.kind === kind);
}

function defaultRoute(profile: ServerProfile, kind: string): Route {
	return allNoticeKinds(profile).find((k) => k.kind === kind)?.route ?? "network";
}

/** Whether `msg` is a server notice (as opposed to a NOTICE from a person or service). */
export function isServerNotice(client: IrcClient, msg: IrcMessage): boolean {
	if (msg.command !== "NOTICE" || !msg.source || msg.source.user !== undefined) {
		return false;
	}

	const target = msg.params[0] ?? "";
	const text = msg.params[msg.params.length - 1] ?? "";

	return (target === "*" || client.isSelf(target)) && text.startsWith(NOTICE_PREFIX);
}

/**
 * Route one server notice. Returns false when it is not one (the caller
 * shows it as an ordinary NOTICE).
 */
export function handleServerNotice(client: IrcClient, msg: IrcMessage): boolean {
	if (!isServerNotice(client, msg) || client.replaying) {
		return false;
	}

	const text = (msg.params[msg.params.length - 1] ?? "").slice(NOTICE_PREFIX.length);
	const profile = client.profile;
	const event = profile.classifyNotice(text);
	const kind = event?.kind ?? UNKNOWN_KIND.kind;
	const route = routeFor(client.uuid, kind, defaultRoute(profile, kind));

	if (route === "off") {
		return true;
	}

	const info: SnoticeInfo = {
		kind,
		category: event?.category ?? UNKNOWN_KIND.category,
		fields: event?.fields ?? {},
		route,
	};
	const origin = msg.source?.name;

	// A global notice relayed from another server carries that server.
	if (origin && client.serverName && !client.namesEqual(origin, client.serverName)) {
		info.origin = origin;
	}

	deliver(client, {type: "snotice", time: client.timeOf(msg).getTime(), text, snotice: info});
	return true;
}

/**
 * Route one WALLOPS. nefarious2 sends WALLOPS as `* text` and WALLUSERS as
 * `$ text` under the same command; a server's own WALLOPS (`* Remote
 * CONNECT …`) has a server source, and DESYNCH has a server source and no
 * prefix. Other servers' plain WALLOPS are `wallops`.
 */
export function handleWallops(client: IrcClient, msg: IrcMessage): void {
	const raw = msg.params[msg.params.length - 1] ?? "";
	const fromServer = !msg.source || msg.source.user === undefined;
	let kind: string;
	let text = raw;

	if (raw.startsWith("$ ")) {
		kind = "wallusers";
		text = raw.slice(2);
	} else if (raw.startsWith("* ")) {
		kind = fromServer ? "wallops.server" : "wallops";
		text = raw.slice(2);
	} else {
		kind = fromServer && msg.source?.name.includes(".") ? "desynch" : "wallops";
	}

	const route = routeFor(client.uuid, kind, defaultRoute(client.profile, kind));

	if (route === "off") {
		return;
	}

	deliver(client, {
		type: "wallops",
		time: client.timeOf(msg).getTime(),
		text,
		from: msg.source?.name ?? client.options.host,
		snotice: {kind, category: "WALLOPS", fields: {}, origin: msg.source?.name, route},
	});
}

/** The message a logged notice is shown as (live, or restored on reload). */
export function noticeMessage(entry: LoggedNotice, restored = false): Partial<SharedMsg> {
	const message: Partial<SharedMsg> = {
		type: entry.type === "wallops" ? MessageType.WALLOPS : MessageType.SNOTICE,
		time: new Date(entry.time),
		text: entry.text,
		snotice: entry.snotice,
	};

	if (entry.from) {
		message.from = {nick: entry.from, mode: ""};
	}

	if (!restored && entry.snotice.route === "active") {
		message.showInActive = true;
	}

	return message;
}

/**
 * Show a routed line and keep it. Both routes are stored in the lobby — an
 * `active` one is shown in the active window (`showInActive`, the path a
 * `/whois` reply takes) and comes back in the lobby on reload. Neither
 * raises unread: an active one was seen where it was shown, a routine one
 * must not keep lighting the network up.
 */
function deliver(client: IrcClient, entry: LoggedNotice): void {
	client.pushMessage(client.lobby, noticeMessage(entry), false);
	client.noticeLog.append(entry);
}
