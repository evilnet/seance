/**
 * Oper actions in menus: the entries a nick's menu gains when the network
 * is opered, and the menu an IP, host or mask opens when clicked in a
 * server notice or a report. Gated by the privileges the server reported
 * (PRIVS); while those are not in yet, everything is offered and the server
 * has the last word. docs/projects/oper-tools.md, feature 6.
 */

import socket from "../socket";
import eventbus from "../eventbus";
import {operRequest} from "./operRequest";
import type {ContextMenuItem} from "./contextMenu";
import type {ClientNetwork} from "../types";
import type {Route, SnoticeInfo} from "../../../shared/types/oper";
import type {BanType} from "../irc/profiles/nefarious/bans";
import type {NoticeKind} from "../irc/profiles/types";
import {profileById} from "../irc/profiles";
import {allNoticeKinds, findNoticeKind} from "../irc/snotice";
import {routeFor, setRoute, setTemporaryRoute, temporaryRouteFor} from "../irc/operprefs";
import {categoryBadge, wallopsBadge} from "./operFormat";
import {HERE_DURATIONS, reconcileMask, untilText} from "./operAlerts";

/** What the kill/ban dialog (components/Oper/ActionDialog.vue) is opened with. */
export interface OperActionRequest {
	network: string;
	/** Where results and typed commands go (the active window). */
	chan: number;
	action: "kill" | BanType;
	nick?: string;
	mask?: string;
}

export function openOperAction(request: OperActionRequest): void {
	eventbus.emit("oper:action", request);
}

/** What the investigation card (components/Oper/InvestigateCard.vue) is opened with. */
export interface InvestigateRequest {
	network: string;
	kind: "channel" | "user";
	/** The channel name or the nick. */
	target: string;
}

export function openInvestigation(request: InvestigateRequest): void {
	eventbus.emit("oper:investigate", request);
}

/** The entry an opered network adds to a channel's menu (the sidebar row, an inline `#chan`). */
export function operChannelItems(network: ClientNetwork, channel: string): ContextMenuItem[] {
	if (!isOperOn(network)) {
		return [];
	}

	return [
		{
			label: "Investigate",
			type: "item",
			class: "oper-investigate",
			action: () =>
				openInvestigation({network: network.uuid, kind: "channel", target: channel}),
		},
	];
}

/** Opered (local, global or admin) on this network. */
export function isOperOn(network: Pick<ClientNetwork, "oper"> | undefined): boolean {
	const level = network?.oper?.level;
	return level === "local" || level === "global" || level === "admin";
}

/** Holds any of `privs` — or the list is not known yet. */
export function hasPriv(network: ClientNetwork, ...privs: string[]): boolean {
	const oper = network.oper;

	if (!oper?.privsKnown) {
		return true;
	}

	return privs.some((p) => oper.privs.includes(p));
}

/** Whether the ban tools speak this server's dialect. */
function bansSupported(network: ClientNetwork): boolean {
	return network.oper?.profile === "nefarious2";
}

/** The oper service a G-line or shun can go through (X3's O3), if any. */
export function banServiceBot(network: Pick<ClientNetwork, "services">): string {
	const services = network.services;
	return services?.package === "x3" ? services.bots.oper.trim() : "";
}

/**
 * Whether to offer `action` on this network. The server's privilege
 * (`GLINE`, or `LOCAL_GLINE`) is one way; an oper service that takes the
 * ban is the other, and on AfterNET it is the only one: a services-opered
 * user starts with no privileges at all and gets X3's `auto_oper_privs`,
 * which has `WIDE_GLINE` but neither `GLINE` nor `SHUN`, so PRIVS says no
 * while O3 says yes (components/Oper/ActionDialog.vue sends it there).
 * Z-lines have no services route.
 */
export function canBan(network: ClientNetwork, action: BanType): boolean {
	if (!bansSupported(network) || !isOperOn(network)) {
		return false;
	}

	if (action !== "zline" && banServiceBot(network) !== "") {
		return true;
	}

	const priv = action.toUpperCase();
	return hasPriv(network, priv, `LOCAL_${priv}`);
}

function input(chan: number, text: string): void {
	socket.emit("input", {target: chan, text});
}

/** `USERIP <nick>` → the real IP (opers see it; 340 is untagged, #120). */
export async function userIp(
	network: string,
	nick: string
): Promise<{ident?: string; ip?: string}> {
	const reply = await operRequest(network, `USERIP ${nick}`, {untagged: ["340"]});
	const line = reply.lines.find((msg) => msg.command === "340");
	const item = line?.params[line.params.length - 1]?.trim().split(" ")[0];
	const m = item ? /^[^=]+=[+-](.*)@(.*)$/.exec(item) : null;
	return m ? {ident: m[1], ip: m[2]} : {};
}

function banItems(
	network: ClientNetwork,
	chan: number,
	target: {nick?: string; mask?: string; ip?: boolean}
): ContextMenuItem[] {
	const items: ContextMenuItem[] = [];

	const add = (action: BanType, label: string, cls: string) => {
		if (canBan(network, action)) {
			items.push({
				label,
				type: "item",
				class: cls,
				action: () => openOperAction({network: network.uuid, chan, action, ...target}),
			});
		}
	};

	add("gline", "G-line…", "oper-gline");
	add("shun", "Shun…", "oper-shun");

	if (target.ip !== false) {
		add("zline", "Z-line…", "oper-zline");
	}

	return items;
}

/** The entries an opered network adds to a nick's menu. */
export function operUserItems(
	network: ClientNetwork,
	chan: number,
	nick: string
): ContextMenuItem[] {
	if (!isOperOn(network) || nick === network.nick) {
		return [];
	}

	const items: ContextMenuItem[] = [
		{
			label: "Investigate",
			type: "item",
			class: "oper-investigate",
			action: () => openInvestigation({network: network.uuid, kind: "user", target: nick}),
		},
	];

	if (hasPriv(network, "CHECK")) {
		items.push({
			label: "Check",
			type: "item",
			class: "oper-check",
			// Asked of our own server: the user's own (`CHECK nick nick`) would
			// add idle time, ports and traffic, but nefarious2 does not carry
			// the label back for a forwarded CHECK, so the card would never
			// know its answer had come.
			action: () => input(chan, `/check ${nick}`),
		});
	}

	if (hasPriv(network, "KILL", "LOCAL_KILL")) {
		items.push({
			label: "Kill…",
			type: "item",
			class: "oper-kill",
			action: () => openOperAction({network: network.uuid, chan, action: "kill", nick}),
		});
	}

	items.push(...banItems(network, chan, {nick}));

	if (hasPriv(network, "CHECK")) {
		items.push({
			label: "Find clones",
			type: "item",
			class: "oper-clones",
			action() {
				void userIp(network.uuid, nick).then(({ip}) => {
					if (ip) {
						input(chan, `/check *@${ip}`);
					}
				});
			},
		});
	}

	return items.length > 0 ? [{type: "divider"}, ...items] : [];
}

/** The menu an IP, host or mask in a notice or report opens. */
export function operTargetItems(
	network: ClientNetwork,
	chan: number,
	kind: "ip" | "host" | "mask",
	value: string
): ContextMenuItem[] {
	const items: ContextMenuItem[] = [
		{label: value, type: "item", class: "oper-target"},
		{type: "divider"},
	];
	const opered = isOperOn(network);
	const host = value.includes("@") ? value.slice(value.lastIndexOf("@") + 1) : value;

	if (opered && hasPriv(network, "CHECK")) {
		items.push({
			label: kind === "ip" ? "Check this IP" : "Check matching users",
			type: "item",
			class: "oper-check",
			action: () => input(chan, `/check ${kind === "mask" ? value : host}`),
		});
	}

	if (opered && kind !== "mask") {
		items.push({
			label: "Who is on it",
			type: "item",
			class: "oper-who",
			action: () => input(chan, `/who ${host} x${kind === "ip" ? "i" : "h"}`),
		});
	}

	if (opered) {
		const mask = kind === "mask" ? value : `*@${host}`;
		items.push(...banItems(network, chan, {mask, ip: kind === "ip"}));
	}

	items.push({
		label: "Copy",
		type: "item",
		class: "oper-copy",
		action: () => void navigator.clipboard?.writeText(value).catch(() => undefined),
	});

	return items;
}

/** Open {@link operTargetItems} at `event` (a click on a chip). */
export function openOperTargetMenu(
	event: MouseEvent,
	network: ClientNetwork,
	chan: number,
	kind: "ip" | "host" | "mask",
	value: string
): void {
	eventbus.emit("contextmenu:items", {event, items: operTargetItems(network, chan, kind, value)});
}

// --- Where a kind of notice shows (the Alerts tab and the badge on a notice).

/**
 * Clear or set the server bits the changed kinds travel on, so a family
 * routed Off is quiet on the wire too (helpers/operAlerts.ts
 * `reconcileMask`). Nothing happens without a known mask, or on a profile
 * without one. Returns the mask sent, if one was.
 */
export function reconcileSnomask(
	network: Pick<ClientNetwork, "uuid" | "oper">,
	changedKinds: string[],
	now = Date.now()
): number | undefined {
	const mask = network.oper?.snomask;
	const profile = profileById(network.oper?.profile);
	const model = profile.snomask;

	if (mask === undefined || !model || !isOperOn(network)) {
		return undefined;
	}

	const kinds = allNoticeKinds(profile);
	const isOff = (kind: string) =>
		routeFor(
			network.uuid,
			kind,
			kinds.find((k) => k.kind === kind)?.route ?? "network",
			now
		) === "off";
	const next = reconcileMask(mask, model, kinds, isOff, changedKinds);

	if (next === mask) {
		return undefined;
	}

	socket.emit("oper:snomask", {network: network.uuid, mask: next});
	return next;
}

/**
 * Route `kinds` to `route` — until `until` (epoch ms) when given, else
 * for good (stored only where it differs from the kind's default) — then
 * square the snomask with it and tell the Alerts tab (`oper:routes`).
 */
export function applyNoticeRoute(
	network: Pick<ClientNetwork, "uuid" | "oper">,
	kinds: NoticeKind[],
	route: Route,
	until?: number
): void {
	for (const kind of kinds) {
		if (until !== undefined) {
			setTemporaryRoute(network.uuid, kind.kind, route, until);
		} else {
			setRoute(network.uuid, kind.kind, route === kind.route ? undefined : route);
		}
	}

	reconcileSnomask(
		network,
		kinds.map((k) => k.kind)
	);
	eventbus.emit("oper:routes", {network: network.uuid});
}

/** The "Here" choices as menu items: for today, 3 days, a week, for good. */
export function hereItems(
	cls: string,
	pick: (until: number | undefined) => void,
	now = Date.now()
): ContextMenuItem[] {
	return HERE_DURATIONS.map((d) => ({
		label: `Show here ${d.label}`,
		type: "item",
		class: cls,
		action: () => pick(d.until(now)),
	}));
}

/** The kind a notice is, from the profile, or a stand-in for one nobody lists. */
function kindOf(network: Pick<ClientNetwork, "oper">, info: SnoticeInfo): NoticeKind {
	return (
		findNoticeKind(info.kind, network.oper?.profile) ?? {
			kind: info.kind,
			label: info.kind,
			category: info.category,
			route: info.route ?? "network",
		}
	);
}

/**
 * The menu a notice's badge opens: the kind by name, where it shows (the
 * current place marked; Here asks how long), and a way to stop the server
 * sending the family at all — the snomask bit, or `-w` for WALLOPS.
 */
export function noticeRouteItems(
	network: ClientNetwork,
	info: SnoticeInfo,
	now = Date.now()
): ContextMenuItem[] {
	const kind = kindOf(network, info);
	const current = routeFor(network.uuid, kind.kind, kind.route, now);
	const temporary = temporaryRouteFor(network.uuid, kind.kind, now);
	const mark = (route: Route, cls: string) =>
		`${cls}${current === route ? " oper-route-current" : ""}`;
	// A temporary Here is said in the header (the duration it was chosen
	// for is not kept); a permanent one marks "until I change it".
	const header = temporary
		? `${kind.label} — here ${untilText(temporary.until, now)}`
		: kind.label;
	const here = hereItems("oper-route-active", (until) =>
		applyNoticeRoute(network, [kind], "active", until)
	);
	const last = here[here.length - 1];

	if (current === "active" && !temporary && "class" in last) {
		last.class += " oper-route-current";
	}

	const items: ContextMenuItem[] = [
		{label: header, type: "item", class: "oper-route-kind"},
		{type: "divider"},
		...here,
		{
			label: "Show in the network window",
			type: "item",
			class: mark("network", "oper-route-network"),
			action: () => applyNoticeRoute(network, [kind], "network"),
		},
		{
			label: "Show nowhere",
			type: "item",
			class: mark("off", "oper-route-off"),
			action: () => applyNoticeRoute(network, [kind], "off"),
		},
	];

	const lobby = network.channels[0]?.id;
	const umodes = network.oper?.umodes ?? "";

	if (info.category === "WALLOPS") {
		const letter = info.kind === "desynch" ? "g" : "w";
		const label = info.kind === "desynch" ? "desync reports" : "WALLOPS";

		if (umodes.includes(letter) && lobby !== undefined) {
			items.push(
				{type: "divider"},
				{
					label: `Stop receiving ${label} (-${letter})`,
					type: "item",
					class: "oper-route-stop",
					action: () => input(lobby, `/umode -${letter}`),
				}
			);
		}

		return items;
	}

	const model = profileById(network.oper?.profile).snomask;
	const bit = model?.bits.find((b) => b.name === info.category);
	const mask = network.oper?.snomask;

	if (bit && mask !== undefined && (mask & bit.bit) !== 0 && isOperOn(network)) {
		items.push(
			{type: "divider"},
			{
				label: `Stop receiving ${bit.label.toLowerCase()} notices`,
				type: "item",
				class: "oper-route-stop",
				action: () =>
					socket.emit("oper:snomask", {network: network.uuid, mask: mask & ~bit.bit}),
			}
		);
	}

	return items;
}

/** Open {@link noticeRouteItems} at `event` (a click on a notice's badge). */
export function openNoticeRouteMenu(
	event: MouseEvent,
	network: ClientNetwork,
	info: SnoticeInfo
): void {
	eventbus.emit("contextmenu:items", {event, items: noticeRouteItems(network, info)});
}

/** The badge a logged notice or a message carries: its text and colour family. */
export function noticeBadge(
	info: SnoticeInfo,
	type: "snotice" | "wallops" | "snoop" | "audit"
): {label: string; family: string} {
	switch (type) {
		case "wallops":
			return {label: wallopsBadge(info.kind), family: "wallops"};
		case "snoop":
			return {label: "snoop", family: "oper"};
		case "audit":
			return {label: "services", family: "oper"};
		default:
			return categoryBadge(info.category);
	}
}
