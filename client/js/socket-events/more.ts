import {nextTick} from "vue";

import socket from "../socket";
import {store} from "../store";
import {extractInputHistory} from "../helpers/inputHistory";
import {attachMediaPreviews} from "../helpers/messagePreviews";
import {settled} from "../helpers/scrollSettle";

socket.on("more", async (data) => {
	const found = store.getters.findChannel(data.chan);

	if (!found) {
		return;
	}

	const {network, channel} = found;

	// A page landing in the channel on screen while it is still moving (a
	// fling, a finger down) cannot be placed: WebKit drops the position
	// write and the list has to kill the momentum to restore it, a jolt.
	// Hold the rows until the list settles (helpers/scrollSettle.ts); the
	// button keeps showing "Loading…" meanwhile.
	if (
		data.messages.length > 0 &&
		store.state.activeChannel?.channel === channel &&
		!channel.scrolledToBottom
	) {
		await settled();
	}

	// History arrives as a batch rather than through `msg`, so it needs the
	// same client-side previews the live path gets.
	data.messages.forEach((msg) => attachMediaPreviews(msg, network, channel));

	channel.inputHistory = channel.inputHistory.concat(
		extractInputHistory(data.messages, 100 - channel.inputHistory.length)
	);
	// Prefer the explicit decision; the arithmetic is the pre-2026-09 fallback
	// (it counts live rows against the history total, see irc/history.ts).
	channel.moreHistoryAvailable =
		data.moreAvailable ?? data.totalMessages > channel.messages.length + data.messages.length;
	channel.messages = data.messages.concat(channel.messages);

	await nextTick();
	channel.historyLoading = false;
});
