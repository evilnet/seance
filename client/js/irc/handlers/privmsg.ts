/**
 * PRIVMSG / NOTICE, including CTCP (ACTION, requests and replies).
 * Ported from attic/server/plugins/irc-events/message.ts and ctcp.ts.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType, SharedMsg} from "../../../../shared/types/msg";
import type {IrcClient} from "../client";
import type {Channel} from "../channel";
import type {IrcMessage} from "../message";
import {settleEcho} from "../pending";
import {isRoutineReplayNotice} from "../persistence";
import {privilegesModified} from "../oper";
import {handleServerNotice, handleWallops} from "../snotice";
import {EDIT_TAG, REPLY_TAG, trailingLine} from "../wire";
import type {Handler} from "../types";
import {ignoreListFor} from "../../ignore";

const nickRegExp = /(?:\x03[0-9]{1,2}(?:,[0-9]{1,2})?)?([\w[\]\\`^{|}-]+)/g;

const ctcpResponses: Record<string, (arg: string) => string> = {
	CLIENTINFO: () => "CLIENTINFO PING VERSION",
	PING: (arg) => arg,
	VERSION: () => "Seance",
};

interface Ctcp {
	command: string;
	arg: string;
	body: string;
}

/** `\x01CMD arg\x01` → parts, or undefined if `text` is not a CTCP. */
function parseCtcp(text: string): Ctcp | undefined {
	if (!text.startsWith("\x01")) {
		return undefined;
	}

	const body = text.slice(1, text.endsWith("\x01") && text.length > 1 ? -1 : undefined);
	const space = body.indexOf(" ");
	const command = (space === -1 ? body : body.slice(0, space)).toUpperCase();
	const arg = space === -1 ? "" : body.slice(space + 1);
	return {command, arg, body};
}

/** Split a STATUSMSG target (`@#chan`) into the channel and its status prefix. */
export function splitStatusTarget(
	client: IrcClient,
	target: string
): {target: string; group?: string} {
	if (
		target.length > 1 &&
		!client.isChannelName(target) &&
		client.isupport.statusmsg.includes(target[0]) &&
		client.isChannelName(target.slice(1))
	) {
		return {target: target.slice(1), group: target[0]};
	}

	return {target};
}

function handleMessage(client: IrcClient, msg: IrcMessage, baseType: MessageType): void {
	const source = msg.source;
	let nick = source?.name ?? "";
	const fromServer = !source || source.user === undefined;
	const self = nick.length > 0 && client.isSelf(nick);
	const {target: rawTarget, group} = splitStatusTarget(client, msg.params[0] ?? "");
	let target = rawTarget;
	let text = msg.params[1] ?? "";
	let type = baseType;
	const time = client.timeOf(msg);
	const ctcp = parseCtcp(text);

	// --- ignore list (client/js/ignore.ts): drop anything from a matching user
	if (
		!fromServer &&
		!self &&
		ignoreListFor(client.uuid).matches(nick, source.user, source.host)
	) {
		return;
	}
	// --- end ignore list

	if (ctcp) {
		if (ctcp.command === "ACTION" && baseType === MessageType.MESSAGE) {
			type = MessageType.ACTION;
			text = ctcp.arg;
		} else if (client.replaying) {
			return; // a historical CTCP request/reply: nothing to answer or show
		} else if (baseType === MessageType.NOTICE) {
			handleCtcpResponse(client, nick, ctcp, time);
			return;
		} else {
			handleCtcpRequest(client, msg, nick, self, ctcp, time);
			return;
		}
	}

	let chan: Channel | undefined;
	let showInActive = false;

	if (client.replaying) {
		// History replay: everything in the batch belongs to its target.
		chan = client.replayTarget;

		if (!chan) {
			return;
		}
	} else if (fromServer) {
		nick = nick || client.options.host;
		chan = client.findChannel(target);

		if (!chan || chan.type !== ChanType.CHANNEL) {
			chan = client.lobby;
		}
	} else {
		// A message addressed to us belongs in the sender's query window.
		if (client.isSelf(target)) {
			target = nick;
		}

		chan = client.findChannel(target);

		if (!chan) {
			if (type === MessageType.NOTICE) {
				showInActive = true;
				chan = client.lobby;
			} else {
				chan = client.announceChannel(target, ChanType.QUERY);
			}
		}
	}

	let highlight = false;

	if (chan.type === ChanType.QUERY) {
		highlight = !self;
	} else if (chan.type === ChanType.CHANNEL) {
		const user = chan.findUser(nick);

		if (user && !client.replaying) {
			user.lastMessage = time.getTime();
		}
	}

	if (!highlight && !self) {
		highlight = client.isHighlight(text);
	} else if (highlight && client.isHighlightException(text)) {
		// The query auto-highlight is not derived from the text, so
		// isHighlight's folded-in exceptions never saw it; the old server
		// ran the exception regex over every highlight (attic message.ts).
		highlight = false;
	}

	const users: string[] = [];
	let match: RegExpExecArray | null;
	nickRegExp.lastIndex = 0;

	while ((match = nickRegExp.exec(text))) {
		if (chan.findUser(match[1])) {
			users.push(match[1]);
		}
	}

	const message: Partial<SharedMsg> = {
		type,
		time,
		text,
		self,
		from: chan.userRef(nick),
		highlight,
		users,
	};
	const msgid = msg.tags.get("msgid");

	if (msgid) {
		message.msgid = msgid;
	}

	// `account-tag`: the sender's services account, when logged in. Trusting
	// media "from alice" keys on this, never on the nick.
	const account = msg.tags.get("account");

	if (account) {
		message.fromAccount = account;
	}

	if (showInActive) {
		message.showInActive = true;
	}

	if (group) {
		message.statusmsgGroup = group;
	}

	// Replies (`+reply` ratified, `+draft/reply` what poxchat sends) and our
	// own edit marker, bus-contract §1.4. The parent may not be loaded; the
	// UI resolves it when rendering.
	const replyTo = replyTagOf(msg);
	const editOf = msg.tags.get(EDIT_TAG);

	if (replyTo) {
		message.replyTo = replyTo;
	}

	if (editOf) {
		message.editOf = editOf;
	}

	// A live message of ours is the echo of one we sent: its pending copy
	// comes down before the real one goes in (bus-contract §1.9).
	if (self && !client.replaying) {
		settleEcho(client, chan, msg, type, text);
	}

	// An edit of a loaded message takes that message's place in the list
	// (`msg:edit`), so it is not a new unread message; a highlight in it
	// still counts, as `pushMessage` counts every highlight.
	const pushed = client.pushMessage(chan, message, !self && !editOf);

	if (editOf) {
		// `msg:edit` must follow the `msg` and carry resolved ids; in a
		// history replay both only exist after the batch is delivered.
		const into = chan;
		client.afterReplay(() => {
			const id = pushed.id || (pushed.msgid ? into.idOf(pushed.msgid) : undefined);
			const replaces = into.idOf(editOf);

			if (id && replaces !== undefined && replaces !== id) {
				client.dispatch("msg:edit", {chan: into.id, id, replaces});
			}
		});
	}
}

/** The msgid a PRIVMSG / TAGMSG refers to (`+draft/reply` preferred, `+reply` accepted). */
export function replyTagOf(msg: IrcMessage): string | undefined {
	return msg.tags.get(REPLY_TAG) || msg.tags.get("+reply") || undefined;
}

function handleCtcpResponse(client: IrcClient, nick: string, ctcp: Ctcp, time: Date): void {
	const chan = client.findChannel(nick) ?? client.lobby;

	client.pushMessage(
		chan,
		{
			type: MessageType.CTCP,
			time,
			from: chan.userRef(nick),
			ctcpMessage: ctcp.body,
			showInActive: chan === client.lobby,
		},
		true
	);
}

function handleCtcpRequest(
	client: IrcClient,
	msg: IrcMessage,
	nick: string,
	self: boolean,
	ctcp: Ctcp,
	time: Date
): void {
	// Our own request echoed back (echo-message) is not for us.
	if (self && !client.isSelf(msg.params[0] ?? "")) {
		return;
	}

	const respond = ctcpResponses[ctcp.command];

	if (respond && nick) {
		const answer = respond(ctcp.arg);
		const reply = `\x01${ctcp.command}${answer ? ` ${answer}` : ""}\x01`;

		// `PING` echoes its argument, and a `draft/multiline` batch joins into
		// text with line feeds in it: `formatLine` throws on a parameter
		// carrying CR, LF or NUL, and that throw would escape into
		// `handleMessage`, which only logs it — losing the request line the
		// user should still see. Nothing to answer, then; show it and move on.
		if (!/[\r\n\0]/.test(reply)) {
			client.send(trailingLine("NOTICE", [nick, reply]));
		}
	}

	client.pushMessage(
		client.lobby,
		{
			type: MessageType.CTCP_REQUEST,
			time,
			from: {nick, mode: ""},
			hostmask: `${msg.source?.user ?? ""}@${msg.source?.host ?? ""}`,
			ctcpMessage: ctcp.body,
			showInActive: true,
		},
		true
	);
}

const privmsg: Handler = (client, msg) => handleMessage(client, msg, MessageType.MESSAGE);

const notice: Handler = (client, msg) => {
	// "Session resumed. Replayed N message(s)…" closes the server-driven
	// catch-up; inside the settling window that is setup chatter, like the
	// bouncer's attach note (../persistence.ts).
	if (isRoutineReplayNotice(client, msg)) {
		return;
	}

	// `*** Notice -- …` from a server: classified and routed by importance
	// (../snotice.ts), not shown as a NOTICE.
	if (handleServerNotice(client, msg)) {
		return;
	}

	// Services changed our privileges (X3 sends PRIVS on auto-oper): the
	// oper tools ask for the new list (../oper.ts). Still shown.
	if (
		msg.source?.user === undefined &&
		client.isSelf(msg.params[0] ?? "") &&
		msg.params[msg.params.length - 1] === "Your privileges were modified"
	) {
		privilegesModified(client);
	}

	handleMessage(client, msg, MessageType.NOTICE);
};

// WALLOPS, WALLUSERS and DESYNCH: one command, routed by kind (../snotice.ts).
const wallops: Handler = (client, msg) => handleWallops(client, msg);

export default {PRIVMSG: privmsg, NOTICE: notice, WALLOPS: wallops};
