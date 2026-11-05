// Answers for a past view (client/js/pastView.ts), and what changes in its rows
// while it is open: they are no rows of the channel, so `msg:redact` and
// `msg:react` cannot name them.
import socket from "../socket";
import {store} from "../store";
import {attachMediaPreviews} from "../helpers/messagePreviews";
import {applyReaction, applyRedaction} from "../helpers/messageUpdates";
import {mergePage} from "../helpers/pastRows";
import {settled} from "../helpers/scrollSettle";
import {takePending} from "../pastView";
import type {LineChange} from "../../../shared/types/search";
import type {SharedMsg} from "../../../shared/types/msg";

/** How long after a failed page a scroll may ask for it again. */
const RETRY_AFTER_MS = 5000;

function applyChange(rows: SharedMsg[], change: LineChange): void {
	const row = rows.find((m) => m.msgid === change.msgid);

	if (row && change.react) {
		applyReaction(row, change.react.text, change.react.nick, change.react.remove);
	}

	if (row && change.redact) {
		applyRedaction(row, change.redact);
	}
}

socket.on("search:context", async (data) => {
	const request = takePending(data.requestId);
	const found = request && store.getters.findChannel(request.channel.id);

	if (!request || !found) {
		return;
	}

	const {network, channel} = found;
	const past = channel.past;
	data.messages.forEach((msg) => attachMediaPreviews(msg, network, channel));

	if (request.direction === "AROUND") {
		// Lands or not, the jump that asked is over.
		store.commit("jumpTarget", null);
		channel.pastOpening = false;

		// The server need not hold the line, and a server without
		// labeled-response cannot be asked: the conversation just stays open.
		if (data.status === "ok" && data.messages.some((m) => m.msgid === request.msgid)) {
			channel.scrolledToBottom = false;
			channel.past = {
				rows: data.messages,
				reveal: request.msgid,
				loading: null,
				requestId: 0,
				canEarlier: true,
				canLater: true,
				failed: false,
				retryAt: 0,
			};
		} else {
			store.commit(
				"currentUserVisibleError",
				data.status === "ok"
					? "That message is no longer available."
					: data.status === "unsupported"
					? "This server cannot fetch older messages."
					: "That message could not be loaded."
			);
		}

		return;
	}

	if (!past) {
		return;
	}

	// As a channel's page does (socket-events/more.ts): one landing on a list
	// still moving cannot be placed.
	if (store.state.activeChannel?.channel === channel) {
		await settled();
	}

	if (channel.past !== past || past.requestId !== data.requestId) {
		return; // closed or moved on meanwhile
	}

	past.loading = null;
	past.requestId = 0;

	if (data.status !== "ok") {
		past.failed = true;
		past.retryAt = Date.now() + RETRY_AFTER_MS;
		return;
	}

	past.failed = false;
	const {rows, added} = mergePage(past.rows, data.messages, request.direction);
	data.changes?.forEach((change) => applyChange(rows, change));
	past.rows = rows;

	// Nothing new, or the server says so: that side has ended.
	if (added === 0 || data.end) {
		if (request.direction === "BEFORE") {
			past.canEarlier = false;
		} else {
			past.canLater = false;
		}
	}
});

socket.on("msg:changed", (data) => {
	const past = store.getters.findChannel(data.chan)?.channel.past;

	if (past) {
		applyChange(past.rows, data);
	}
});
