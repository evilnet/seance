/**
 * Ask a network's server something from the UI and get the whole answer
 * back, parsed: a promise over the `oper:request` emit and its `oper:reply`
 * dispatch (irc/request.ts does the labeled-response correlation). The oper
 * panel and the oper dialogs use it; typed commands go through the IRC
 * layer's own commands instead.
 */

import socket from "../socket";
import {parseLine, type IrcMessage} from "../irc/message";

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
