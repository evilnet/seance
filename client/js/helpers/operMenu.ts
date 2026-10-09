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
import type {BanType} from "../irc/profiles/nefarious/bans";

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

/** Opered (local, global or admin) on this network. */
export function isOperOn(network: ClientNetwork | undefined): boolean {
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
	if (!bansSupported(network)) {
		return [];
	}

	const items: ContextMenuItem[] = [];

	const add = (action: BanType, label: string, cls: string) => {
		if (hasPriv(network, action.toUpperCase(), `LOCAL_${action.toUpperCase()}`)) {
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

	const items: ContextMenuItem[] = [];

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
