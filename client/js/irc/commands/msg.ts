/**
 * `/msg <target> <text>`, `/query <nick> [text]`, `/say <text>` (and plain text).
 * Ported from attic/server/plugins/inputs/msg.ts.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import {inputTags} from "../wire";
import {t} from "../../i18n/core";
import type {Command, CommandContext} from "../types";
import {splitTarget} from "./target";

function openQuery({client, chan}: CommandContext, targetName: string): boolean {
	// `splitTarget` never produces one, but a query window is a lasting piece
	// of state: never open one for a name that cannot be a nick.
	if (/[\s\0]/.test(targetName)) {
		client.pushMessage(chan, {
			type: MessageType.ERROR,
			text: t("cmd.query.spaces"),
		});
		return false;
	}

	// Before the open-window lookup: an open channel is still no query, and
	// `/query #chan hi` must not quietly message it.
	if (client.isChannelName(targetName)) {
		client.pushMessage(chan, {
			type: MessageType.ERROR,
			text: t("cmd.query.channel"),
		});
		return false;
	}

	const existing = client.findChannel(targetName);

	if (existing) {
		// Already open: show it, as a list window run again is shown
		// (handlers/list.ts `showSpecial`); its data goes back unchanged.
		client.dispatch("msg:special", {chan: existing.id, data: existing.shared.data});
		return true;
	}

	if (client.isupport.prefix.symbols.includes(targetName[0])) {
		client.pushMessage(chan, {
			type: MessageType.ERROR,
			text: t("cmd.query.prefix"),
		});
		return false;
	}

	// The user asked for it back: a reopen, here and on the other devices
	// (before the login read, too: a close may still arrive with it).
	if (client.closed.reopen(targetName, client.closedReadAhead)) {
		client.writeClosed();
	}

	client.announceChannel(targetName, ChanType.QUERY, {shouldOpen: true});
	return true;
}

const msg: Command = {
	commands: ["query", "msg", "say"],
	input(ctx) {
		const {client, chan, cmd, rest} = ctx;

		// `/say` (and plain text) goes to the window's own name, which only a
		// channel or a query has: a lobby is named after the network and a
		// special window after its (translated) title. Plain text in a lobby
		// was refused before it got here (commands/index.ts).
		if (cmd === "say" && chan.type !== ChanType.CHANNEL && chan.type !== ChanType.QUERY) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text:
					chan.type === ChanType.LOBBY
						? t("cmd.lobbySend")
						: t("cmd.channelsAndQueriesOnly", {cmd}),
			});
			return;
		}

		// `/say` (and plain text) is all body; `/msg` and `/query` take the
		// target off the front — at a space or, under `draft/multiline`, at
		// the line feed that starts the message's second line.
		const {target: targetName, body} =
			cmd === "say" ? {target: chan.name, body: rest} : splitTarget(rest);

		if (cmd === "query") {
			if (!targetName) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: t("cmd.query.noArg"),
				});
				return;
			}

			if (!openQuery(ctx, targetName)) {
				return;
			}
		}

		if (!targetName || body.length === 0) {
			return;
		}

		// Only plain text into the current window carries the UI's reply /
		// edit references (bus-contract §1.4); `/msg` and `/query` do not.
		const opts = cmd === "say" ? ctx.opts ?? {} : {};

		if (opts.edit) {
			client.editMessage(chan, opts.edit, body, opts.reply);
			return;
		}

		const tags = inputTags(opts);

		client.sendMessage(targetName, body, tags ? {tags} : {});
	},
};

export default msg;
