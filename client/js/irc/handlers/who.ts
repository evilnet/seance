/**
 * WHO replies (352, WHOX 354, 315), accumulated per query and shown as one
 * `who` message — a table rendered by `client/components/MessageTypes/who.vue`
 * — in the channel the query is about, or where it was typed.
 *
 * `commands/who.ts` registers each query with {@link beginWho} before the
 * WHO goes out; replies are matched to queries in order (the server answers
 * them in order, and every one ends in a 315). A WHOX query carries a
 * three-digit token in its `t` field, checked against the head query so a
 * stray reply is not mistaken for one of ours. Rows of a query we did not
 * make (a script, a `/quote WHO`, a WHOX field spec of the user's own that
 * we cannot lay out) are shown as plain text, one line per row, where the
 * old unhandled path would have put them.
 *
 * Wire shapes (nefarious2 `ircd/whocmds.c` `do_who`):
 *   352  <me> <chan|*> <user> <host> <server> <nick> <flags> :<hops> <realname>
 *   354  <me> [<token>] [<chan>] [<user>] [<ip>] [<host>] [<server>] [<nick>]
 *        [<flags>] [<hops>] [<idle>] [<account>] [<oplevel>] [:<realname>]
 *        — only the fields asked for, always in that order.
 *   315  <me> <mask> :End of /WHO list.
 * Flags: `H`/`G` (here/gone; a held session is `G`), `*` oper, then channel
 * status (`@`, `%`, `+`, `!` zombie, `<` delayed join), `d` deaf, `x` hidden
 * host, `z` TLS, `B` bot (`i`/`w`/`g` are shown to opers only).
 */

import {MessageType, WhoEntry, WhoList} from "../../../../shared/types/msg";
import type {Channel} from "../channel";
import type {IrcClient} from "../client";
import type {IrcMessage} from "../message";
import type {Handler} from "../types";

/**
 * The WHOX field spec `commands/who.ts` asks for: token, channel, user,
 * host, server, nick, flags, hops, account, realname. The 354 then has
 * exactly {@link WHOX_PARAMS} parameters after our nick.
 */
export const WHOX_FIELDS = "tcuhsnfdar";
const WHOX_PARAMS = WHOX_FIELDS.length;

export interface WhoQuery {
	/** What the user asked for, as typed (`#chan`, `*!*@*.example.org`). */
	target: string;
	/** Where the result is shown. */
	chan: Channel;
	/** The WHOX token sent with the query; undefined for a plain WHO. */
	token?: string;
	/** The user wrote their own `%fields`: rows cannot be laid out. */
	custom?: boolean;
	entries: WhoEntry[];
}

const queues = new WeakMap<IrcClient, WhoQuery[]>();

function queue(client: IrcClient): WhoQuery[] {
	let list = queues.get(client);

	if (!list) {
		list = [];
		queues.set(client, list);
	}

	return list;
}

/** Register a query about to go out; its replies are the next ones in. */
export function beginWho(client: IrcClient, query: Omit<WhoQuery, "entries">): void {
	queue(client).push({...query, entries: []});
}

/** The query the next reply belongs to, if it is one of ours. */
function current(client: IrcClient, msg: IrcMessage): WhoQuery | undefined {
	const head = queue(client)[0];

	if (!head) {
		return undefined;
	}

	// The user's own field spec: whatever comes back is theirs, shown as text.
	if (head.custom) {
		return head;
	}

	// A WHOX reply names its query; a plain 352 could only be ours if we asked plainly.
	if (msg.command === "354") {
		return head.token !== undefined && head.token === msg.params[1] ? head : undefined;
	}

	return head.token === undefined ? head : undefined;
}

export function parseWhoFlags(
	flags: string
): Pick<WhoEntry, "flags" | "away" | "oper" | "prefixes" | "secure" | "bot"> {
	let prefixes = "";

	for (const ch of flags.slice(1)) {
		if ("@%+!<".includes(ch)) {
			prefixes += ch;
		}
	}

	return {
		flags,
		away: flags.charAt(0) === "G",
		oper: flags.includes("*"),
		prefixes,
		secure: flags.includes("z"),
		bot: flags.includes("B"),
	};
}

function channelOf(param: string | undefined): string | undefined {
	return param && param !== "*" ? param : undefined;
}

// 352: <me> <chan|*> <user> <host> <server> <nick> <flags> :<hops> <realname>
function parseWhoReply(msg: IrcMessage): WhoEntry | undefined {
	const [, chan, ident, hostname, server, nick, flags = "", trailing = ""] = msg.params;

	if (!nick || ident === undefined || hostname === undefined) {
		return undefined;
	}

	const space = trailing.indexOf(" ");
	const hops = parseInt(space === -1 ? trailing : trailing.slice(0, space), 10);
	const realname = space === -1 ? "" : trailing.slice(space + 1);

	return {
		nick,
		ident,
		hostname,
		server: server ?? "",
		channel: channelOf(chan),
		...parseWhoFlags(flags),
		hops: Number.isNaN(hops) ? undefined : hops,
		realname,
	};
}

// 354 for WHOX_FIELDS: <me> <token> <chan|*> <user> <host> <server> <nick> <flags> <hops> <account|0> :<realname>
function parseWhoxReply(msg: IrcMessage): WhoEntry | undefined {
	if (msg.params.length !== WHOX_PARAMS + 1) {
		return undefined;
	}

	const [, , chan, ident, hostname, server, nick, flags, hopsParam, account, realname] =
		msg.params;
	const hops = parseInt(hopsParam, 10);

	return {
		nick,
		ident,
		hostname,
		server,
		channel: channelOf(chan),
		...parseWhoFlags(flags),
		account: account === "0" ? undefined : account,
		hops: Number.isNaN(hops) ? undefined : hops,
		realname,
	};
}

/** A reply that is not one of ours (or one we cannot lay out): plain text. */
function showRaw(client: IrcClient, msg: IrcMessage, query?: WhoQuery): void {
	const params = msg.params.slice(1);

	client.pushMessage(
		query?.chan ?? client.lobby,
		{
			time: client.timeOf(msg),
			text: params.join(" "),
			showInActive: query === undefined,
		},
		query === undefined
	);
}

const whoReply: Handler = (client, msg) => {
	const query = current(client, msg);

	if (!query || query.custom) {
		showRaw(client, msg, query);
		return;
	}

	const entry = msg.command === "354" ? parseWhoxReply(msg) : parseWhoReply(msg);

	if (!entry) {
		showRaw(client, msg, query);
		return;
	}

	query.entries.push(entry);
};

// 315: <me> <mask> :End of /WHO list.
const endOfWho: Handler = (client, msg) => {
	const query = queue(client).shift();
	const mask = msg.params[1] ?? "*";

	if (!query) {
		showRaw(client, msg);
		return;
	}

	if (query.custom) {
		return;
	}

	if (query.entries.length === 0) {
		client.pushMessage(query.chan, {
			type: MessageType.ERROR,
			time: client.timeOf(msg),
			text: `No one matched WHO ${query.target || mask}`,
		});
		return;
	}

	const who: WhoList = {target: query.target || mask, entries: query.entries};
	client.pushMessage(query.chan, {type: MessageType.WHO, time: client.timeOf(msg), who});
};

export default {
	"352": whoReply,
	"354": whoReply,
	"315": endOfWho,
};
