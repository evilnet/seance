/**
 * PRIVMSG / NOTICE, including CTCP (ACTION, requests and replies).
 * Ported from attic/server/plugins/irc-events/message.ts and ctcp.ts.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType, SharedMsg} from "../../../../shared/types/msg";
import type {IrcClient} from "../client";
import {authorOf, type Author, type Channel} from "../channel";
import type {IrcMessage} from "../message";
import {settleEcho} from "../pending";
import {inRestorationWindow, isRoutineReplayNotice} from "../persistence";
import {privilegesModified} from "../oper";
import {noteServicesLine, snoopNicks} from "../servicesfeed";
import {handleServerNotice, handleWallops} from "../snotice";
import {DRAFT_REPLY_TAG, EDIT_TAG, REPLY_TAG, trailingLine} from "../wire";
import {languageFieldsOf} from "../langtag";
import {noteListDelay} from "./list";
import type {Handler} from "../types";
import {ignoreListFor} from "../../ignore";
import {scriptManager} from "../scripting/manager";

const nickRegExp = /(?:\x03[0-9]{1,2}(?:,[0-9]{1,2})?)?([\w[\]\\`^{|}-]+)/g;

/** Longest `PING` argument echoed back, in bytes: see CTCP_REPLY_INTERVAL_MS. */
const CTCP_PING_ARG_MAX = 32;

const ctcpResponses: Record<string, (arg: string) => string> = {
	CLIENTINFO: () => "CLIENTINFO PING VERSION",
	PING: (arg) => (new TextEncoder().encode(arg).length <= CTCP_PING_ARG_MAX ? arg : ""),
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

/** What the services feed knew about the line before it is shown (../servicesfeed.ts). */
interface FeedNote {
	/** The nicks a snoop line names: rendered as nicks whether or not they are in the channel. */
	nicks: string[];
}

function handleMessage(
	client: IrcClient,
	msg: IrcMessage,
	baseType: MessageType,
	feed?: FeedNote
): void {
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

	if (!client.replaying) {
		const rawTags: Record<string, string> = Object.fromEntries(msg.tags);

		scriptManager.dispatchMessage({
			network: client.name,
			networkUuid: client.uuid,
			target,
			from: nick,
			text,
			type:
				type === MessageType.ACTION
					? "action"
					: baseType === MessageType.NOTICE
					? "notice"
					: "message",
			self,
			tags: rawTags,
		});
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
		// nefarious2's "wait N seconds before /list": the channel browser shows it.
		if (type === MessageType.NOTICE && noteListDelay(client, text)) {
			return;
		}

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
				// A line from before the user closed this query (a replay,
				// batched or in the settling window) does not open it again
				// (irc/closedQueries.ts); a live one does, whatever its time.
				const opened = client.openAutoQuery(
					target,
					time,
					!msg.tags.has("batch") && !inRestorationWindow(client)
				);

				if (!opened) {
					return;
				}

				chan = opened;
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

	if (feed) {
		// A snoop line that names us (our own connect, say) is the bot's
		// report, not a word to us: no highlight, no mention.
		highlight = false;
	} else if (!highlight && !self) {
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

	for (const named of feed?.nicks ?? []) {
		if (!users.includes(named)) {
			users.push(named);
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

	// Replies (`+reply`, or the `+draft/reply` poxchat sends) and our
	// own edit marker, bus-contract §1.4. The parent may not be loaded; the
	// UI resolves it when rendering.
	const replyTo = replyTagOf(msg);
	const by: Author = {nick, account: account || undefined, self};
	let editOf = msg.tags.get(EDIT_TAG);

	// Someone else's edit of a line we show replaces nothing: it is a line
	// of its own, counted and shown as one (IrcClient.isAuthor). One whose
	// original is not loaded is judged when the original comes.
	if (editOf) {
		const shown = chan.idOf(editOf);
		const original =
			shown !== undefined
				? chan.msgRefs.get(shown)?.from
				: client.replaying
				? maybeAuthor(client.replayedMessage(chan, editOf))
				: undefined;

		if ((shown !== undefined || original) && !client.isAuthor(original, by)) {
			editOf = undefined;
		}
	}

	if (replyTo) {
		message.replyTo = replyTo;
	}

	if (editOf) {
		message.editOf = editOf;
	}

	// The language tags (`langtag.ts`): what the sender says the text is
	// in, and whether its client machine-translated it. An edit carries its
	// own, so a rewrite sent as typed loses the original's note.
	Object.assign(
		message,
		languageFieldsOf((name) => msg.tags.get(name))
	);

	// A live message of ours is the echo of one we sent: its pending copy
	// comes down before the real one goes in (bus-contract §1.9).
	if (self && !client.replaying) {
		settleEcho(client, chan, msg, type, text);
	}

	// A live msgid the channel already shows is the same message again: a
	// message to ourselves comes back as both the echo and the delivered
	// copy. (A replay has its own msgid dedupe in history.ts, and a search
	// must still hit a line the channel shows.)
	if (msgid && !client.replaying && chan.idOf(msgid) !== undefined) {
		return;
	}

	// The original leaves the inbox, loaded or not; the inbox checks that
	// the edit's sender wrote it (`by`). The edit brings its own entry if it
	// still mentions us.
	// In a replay it waits for the delivery: the original may be in the
	// same page, and its entry goes in only as the page is delivered.
	if (editOf && !self) {
		const where = chan.name;
		client.afterReplay(() =>
			client.dispatch("inbox:drop", {
				network: client.uuid,
				target: where,
				msgid: editOf,
				by: nick,
			})
		);
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
				// Only its author's edit takes a line's place; anyone else's
				// is a line of its own.
				if (client.isAuthor(into.msgRefs.get(replaces)?.from, by)) {
					client.dispatch("msg:edit", {chan: into.id, id, replaces});
				}
			} else if (id && replaces === undefined && pushed.msgid) {
				// The original may still arrive (an older page): it is put
				// behind this edit then, not shown beside it, if its author
				// sent this (IrcClient.settleLateOriginal).
				into.awaitOriginal(editOf, pushed.msgid, by);
			}
		});
	}
}

/** The sender of `msg`, if there is one. */
function maybeAuthor(msg: SharedMsg | undefined): Author | undefined {
	return msg ? authorOf(msg) : undefined;
}

/** The msgid a PRIVMSG / TAGMSG refers to (`+reply` preferred, `+draft/reply` accepted). */
export function replyTagOf(msg: IrcMessage): string | undefined {
	return msg.tags.get(REPLY_TAG) || msg.tags.get(DRAFT_REPLY_TAG) || undefined;
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

/** One automatic CTCP reply per network per this long: each reply costs
 * server-side fake lag, so answering a burst of requests would flood every
 * Seance user in it off the server. ircu-line servers charge `2 + len/120` s
 * (integer division), so a reply under 120 bytes costs exactly the 2 s this
 * gate allows; a `PING` argument longer than `CTCP_PING_ARG_MAX` bytes is not
 * echoed, or a stream of `PING <450 bytes>` would still outrun it. */
export const CTCP_REPLY_INTERVAL_MS = 2000;
const lastCtcpReply = new WeakMap<IrcClient, number>();

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

	const now = Date.now();

	if (
		respond &&
		nick &&
		now - (lastCtcpReply.get(client) ?? -Infinity) >= CTCP_REPLY_INTERVAL_MS
	) {
		lastCtcpReply.set(client, now);
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

const privmsg: Handler = (client, msg) => {
	// A services bot's line in its snoop or report channel is kept for the
	// oper tools (../servicesfeed.ts); the channel still shows it as is,
	// with the nicks a snoop line names clickable.
	const kept = noteServicesLine(client, msg);
	handleMessage(
		client,
		msg,
		MessageType.MESSAGE,
		kept?.type === "snoop" ? {nicks: snoopNicks(kept)} : undefined
	);
};

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
