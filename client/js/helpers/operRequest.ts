/**
 * Ask a network's server something from the UI and get the whole answer
 * back, parsed: a promise over the `oper:request` emit and its `oper:reply`
 * dispatch (irc/request.ts does the labeled-response correlation). The oper
 * panel and the oper dialogs use it; typed commands go through the IRC
 * layer's own commands instead.
 */

import socket from "../socket";
import {parseLine, type IrcMessage} from "../irc/message";
import type {ServicesConfig} from "../../../shared/types/network";

export interface OperReply {
	lines: IrcMessage[];
	/** `batch`, `lines`, `ack`, `timeout` or `closed` (irc/request.ts). */
	outcome: string;
}

let next = 0;
const waiting = new Map<string, (reply: OperReply) => void>();

socket.on("oper:reply", ({id, lines, outcome}) => {
	const resolve = waiting.get(id);

	if (!resolve) {
		return;
	}

	waiting.delete(id);
	resolve({
		lines: lines.map((line) => parseLine(line)).filter((msg): msg is IrcMessage => !!msg),
		outcome,
	});
});

export function operRequest(
	network: string,
	line: string,
	opts: {untagged?: string[]; end?: string[]} = {}
): Promise<OperReply> {
	const id = `ui${++next}`;

	return new Promise((resolve) => {
		waiting.set(id, resolve);
		socket.emit("oper:request", {network, id, line, ...opts});
	});
}

// --- Services support (irc/services.ts): the same promise shape over the
// `services:check` / `services:checked` and `services:ban` / `services:banned`
// pairs, for the edit form's liveness line and the ban dialog's O3 path.

export interface ServicesCheckReply {
	results: {role: string; bot: string; online: boolean; looksLikeX3: boolean}[];
	failure?: "closed" | "timeout";
}

export interface ServicesBanReply {
	outcome: "ok" | "refused" | "timeout" | "closed";
	text?: string;
}

const waitingChecks = new Map<string, (reply: ServicesCheckReply) => void>();
const waitingBans = new Map<string, (reply: ServicesBanReply) => void>();

socket.on("services:checked", ({id, results, failure}) => {
	const resolve = waitingChecks.get(id);

	if (resolve) {
		waitingChecks.delete(id);
		resolve(failure ? {results, failure} : {results});
	}
});

socket.on("services:banned", ({id, outcome, text}) => {
	const resolve = waitingBans.get(id);

	if (resolve) {
		waitingBans.delete(id);
		resolve(text === undefined ? {outcome} : {outcome, text});
	}
});

export function servicesCheck(
	network: string,
	services: ServicesConfig
): Promise<ServicesCheckReply> {
	const id = `sc${++next}`;

	return new Promise((resolve) => {
		waitingChecks.set(id, resolve);
		socket.emit("services:check", {network, id, services});
	});
}

export function servicesBan(
	network: string,
	ban: {type: "gline" | "shun"; mask: string; seconds: number; reason: string}
): Promise<ServicesBanReply> {
	const id = `sb${++next}`;

	return new Promise((resolve) => {
		waitingBans.set(id, resolve);
		socket.emit("services:ban", {network, id, ...ban});
	});
}
