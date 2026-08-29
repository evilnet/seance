/**
 * Inbound handler registry: command / numeric → {@link Handler}.
 *
 * To handle a new command, add a file exporting `{COMMAND: handler, ...}`
 * and list it in `modules` below. Numerics not registered here fall through
 * to {@link unhandled}, which shows them raw in the lobby (or in the channel
 * their first parameter names), like the old server's unhandled.ts. 4xx/5xx
 * numerics without a specific handler become ERROR messages instead.
 */

import {MessageType} from "../../../../shared/types/msg";
import history, {chathistoryBatch} from "../history";
import {MULTILINE_CAP, multilineBatch} from "../multiline";
import {BOUNCER_REPLAY_BATCH, bouncerReplayBatch, persistenceBatch} from "../persistence";
import type {Handler} from "../types";
import account from "./account";
import away from "./away";
import batch, {registerBatchHandler} from "./batch";
import cap from "./cap";
import chghost from "./chghost";
import error from "./error";
import invite from "./invite";
import join from "./join";
import kick from "./kick";
import list from "./list";
import lists from "./lists";
import markread from "./markread";
import mode from "./mode";
import names from "./names";
import nick from "./nick";
import numerics, {numericError} from "./numerics";
import part from "./part";
import persistence from "./persistence";
import privmsg from "./privmsg";
import quit from "./quit";
import redact from "./redact";
import sasl from "./sasl";
import standardReplies from "./standard-replies";
import tagmsg from "./tagmsg";
import topic from "./topic";
import whois from "./whois";

const modules: Record<string, Handler>[] = [
	account,
	away,
	batch,
	cap,
	chghost,
	error,
	history,
	invite,
	join,
	kick,
	list,
	lists,
	markread,
	mode,
	names,
	nick,
	numerics,
	part,
	persistence,
	privmsg,
	quit,
	redact,
	sasl,
	standardReplies,
	tagmsg,
	topic,
	whois,
];

export const handlers = new Map<string, Handler>();

// Batch types delivered as a unit (everything else is unwrapped in order).
registerBatchHandler("chathistory", chathistoryBatch);
registerBatchHandler(MULTILINE_CAP, multilineBatch);
registerBatchHandler("draft/persistence", persistenceBatch);
registerBatchHandler(BOUNCER_REPLAY_BATCH, bouncerReplayBatch);

for (const mod of modules) {
	for (const [command, handler] of Object.entries(mod)) {
		handlers.set(command.toUpperCase(), handler);
	}
}

/** Fallback for anything without a handler. */
export const unhandled: Handler = (client, msg) => {
	if (/^[45]\d\d$/.test(msg.command)) {
		numericError(client, msg);
		return;
	}

	const params = [...msg.params];

	// Do not display our own name (numerics start with it).
	if (params.length > 0 && client.isSelf(params[0])) {
		params.shift();
	}

	const chan = (params.length > 0 && client.findChannel(params[0])) || client.lobby;

	client.pushMessage(
		chan,
		{
			type: MessageType.UNHANDLED,
			time: client.timeOf(msg),
			command: msg.command,
			params,
			text: `${msg.command} ${params.join(" ")}`,
		},
		true
	);
};
