/**
 * REDACT (`draft/message-redaction`): `:nick!u@h REDACT <channel> <msgid> [:reason]`.
 *
 * nefarious2 sends the live line with no tags at all (so the time is "now")
 * and only to clients that negotiated the cap; inside chathistory batches
 * the same line carries `time`/`msgid` tags and the deleted message itself
 * is no longer replayed. The redaction becomes `msg:redact {chan, id, by,
 * reason?, time}` for a loaded message; for one we never showed it is a
 * plain "<nick> deleted a message" line (live) or dropped (replay). A
 * REDACT of our own that an edit is waiting on releases that edit
 * (`IrcClient.settleEdit`). Loaded or not, the msgid goes to the inbox
 * (`inbox:drop`), which keeps mentions across reloads.
 */

import type {Channel} from "../channel";
import type {Handler} from "../types";

const redact: Handler = (client, msg) => {
	const nick = msg.source?.name ?? "";
	const [target = "", msgid = "", reason] = msg.params;
	const time = client.timeOf(msg);
	const replaying = client.replaying;
	const chan: Channel | undefined = replaying ? client.replayTarget : client.findChannel(target);

	if (!msgid) {
		return;
	}

	// Scoped to the conversation: a REDACT names one message in one target.
	// In a private conversation the target is us and the conversation the sender.
	const conversation = chan?.name ?? (client.isSelf(target) ? nick : target);
	client.dispatch("inbox:drop", {network: client.uuid, target: conversation, msgid});

	if (chan) {
		client.afterReplay(() => {
			const id = chan.idOf(msgid);

			if (id !== undefined) {
				const payload: {chan: number; id: number; by: string; reason?: string; time: Date} =
					{chan: chan.id, id, by: nick, time};

				if (reason) {
					payload.reason = reason;
				}

				client.dispatch("msg:redact", payload);
			} else if (!replaying) {
				client.pushMessage(chan, {
					time,
					text: `${nick} deleted a message${reason ? ` (${reason})` : ""}`,
				});
			}
		});
	}

	if (!replaying && nick && client.isSelf(nick)) {
		client.settleEdit(msgid);
	}
};

export default {REDACT: redact};
