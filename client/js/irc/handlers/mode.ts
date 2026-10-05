/**
 * MODE (channel and user), 324 (RPL_CHANNELMODEIS), 221 (RPL_UMODEIS).
 * Ported from attic/server/plugins/irc-events/mode.ts. Which modes take a
 * parameter comes from ISUPPORT CHANMODES/PREFIX. An unchanged 324 is state,
 * not news, and is not shown (`Channel.modeText`, like topic.ts).
 */

import {MessageType} from "../../../../shared/types/msg";
import {Channel, setUserModes} from "../channel";
import type {IrcClient} from "../client";
import {msgidOf} from "../message";
import type {Handler} from "../types";

interface ModeChange {
	add: boolean;
	mode: string;
	param?: string;
}

/** Split `+ov-b nick1 nick2 mask` into individual changes. */
export function parseChannelModes(
	client: IrcClient,
	modes: string,
	params: string[]
): ModeChange[] {
	const cm = client.isupport.chanmodes;
	const prefixModes = client.isupport.prefix.modes;
	const changes: ModeChange[] = [];
	let add = true;
	let next = 0;

	for (const ch of modes) {
		if (ch === "+" || ch === "-") {
			add = ch === "+";
			continue;
		}

		const takesParam =
			prefixModes.includes(ch) ||
			cm.a.includes(ch) ||
			cm.b.includes(ch) ||
			(add && cm.c.includes(ch));

		changes.push({add, mode: ch, param: takesParam ? params[next++] : undefined});
	}

	return changes;
}

/** Apply prefix/key changes to the channel; true if the user list changed. */
function applyChanges(client: IrcClient, chan: Channel, changes: ModeChange[]): boolean {
	const prefixModes = client.isupport.prefix.modes;
	const rank = (symbol: string) => client.prefixRank(symbol);
	let usersUpdated = false;

	for (const change of changes) {
		if (change.mode === "k") {
			chan.shared.key = change.add ? change.param ?? "" : "";
		}

		if (!change.param || !prefixModes.includes(change.mode)) {
			continue;
		}

		const user = chan.findUser(change.param);
		const symbol = client.isupport.prefixForMode(change.mode);

		if (!user || symbol === undefined) {
			continue;
		}

		const modes = user.modes.filter((m) => m !== symbol);

		if (change.add) {
			modes.push(symbol);
		}

		setUserModes(user, modes, rank);
		usersUpdated = true;
	}

	return usersUpdated;
}

const mode: Handler = (client, msg) => {
	const [target, modes = "", ...params] = msg.params;
	const nick = msg.source?.name ?? client.options.host;
	const self = client.isSelf(nick);
	const text = `${modes} ${params.join(" ")}`.trim();

	if (!target) {
		return;
	}

	if (client.isSelf(target)) {
		client.pushMessage(client.lobby, {
			type: MessageType.MODE,
			time: client.timeOf(msg),
			from: {nick, mode: ""},
			text,
			self,
		});
		return;
	}

	const chan = client.findChannel(target);

	if (!chan) {
		return;
	}

	client.pushMessage(chan, {
		type: MessageType.MODE,
		time: client.timeOf(msg),
		from: chan.userRef(nick),
		text,
		users: params.filter((param) => chan.findUser(param) !== undefined),
		self,
		...msgidOf(msg),
	});

	if (client.replaying) {
		return; // history: current modes came from 324 / NAMES
	}

	if (applyChanges(client, chan, parseChannelModes(client, modes, params))) {
		client.usersChanged(chan);
	}
};

// RPL_CHANNELMODEIS: <me> <channel> <modes> [params]
const channelModeIs: Handler = (client, msg) => {
	const [, name, modes = "", ...params] = msg.params;
	const chan = name ? client.findChannel(name) : undefined;

	if (!chan) {
		// Only the reply to a `/mode #chan` we are not in; otherwise state
		// for a channel we do not show, which has nowhere to go.
		if (name && client.takeInfoAsked(name)) {
			client.pushMessage(client.lobby, {
				type: MessageType.MODE_CHANNEL,
				time: client.timeOf(msg),
				text: `${name} ${modes} ${params.join(" ")}`.trim(),
				showInActive: true,
			});
		}

		return;
	}

	applyChanges(client, chan, parseChannelModes(client, modes, params));

	// The modes are asked for after every (re)JOIN — lazily on first open,
	// or with the active channel's catch-up (catchup.ts) — so a reconnect
	// brings the same line back each time. Say it when it is news, or when
	// asked (/mode #chan) — an asked-for answer follows the user's tab.
	const asked = chan.modesAsked;
	const text = `${modes} ${params.join(" ")}`.trim();
	const quiet = text === chan.modeText && !asked;
	chan.modesAsked = false;
	chan.modeText = text;

	if (quiet) {
		return;
	}

	client.pushMessage(chan, {
		type: MessageType.MODE_CHANNEL,
		time: client.timeOf(msg),
		text,
		showInActive: asked || undefined,
	});
};

// RPL_UMODEIS: <me> <modes>
const umodeIs: Handler = (client, msg) => {
	client.pushMessage(client.lobby, {
		type: MessageType.MODE_USER,
		time: client.timeOf(msg),
		raw_modes: msg.params[1] ?? "",
		self: false,
		showInActive: true,
	});
};

// RPL_CREATIONTIME: nothing the UI shows.
const creationTime: Handler = () => undefined;

export default {MODE: mode, "324": channelModeIs, "329": creationTime, "221": umodeIs};
