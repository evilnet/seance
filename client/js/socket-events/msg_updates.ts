// Consumers for the message-update events of docs/resources/bus-contract.md
// §1.4 and the pending-copy settlement of §1.9. The IRC layer only
// dispatches these after the `msg` they refer to, with the target already
// resolved to a store id, so a miss here means the message was trimmed from
// the buffer and there is nothing to update.
import socket from "../socket";
import {store} from "../store";
import {
	applyEdit,
	applyReaction,
	applyRedaction,
	findMessageById,
	removePending,
} from "../helpers/messageUpdates";
import {forgetTranslations} from "../translate/reader";
import {afterHeldPage} from "../helpers/heldPages";

function lookup(chan: number, id: number) {
	const target = store.getters.findChannel(chan);

	if (!target) {
		return undefined;
	}

	return findMessageById(target.channel.messages, id);
}

socket.on("reply:parent", function ({chan, msgid, nick, text}) {
	const target = store.getters.findChannel(chan);

	if (target) {
		target.channel.replyParents = {...target.channel.replyParents, [msgid]: {nick, text}};
	}
});

// An update to a message of a page the store is still holding back waits
// for that page (helpers/heldPages.ts).
socket.on("msg:react", function (data) {
	afterHeldPage(data.chan, () => {
		const message = lookup(data.chan, data.id);

		if (message) {
			applyReaction(message, data.text, data.nick, data.remove);
		}
	});
});

socket.on("msg:redact", function (data) {
	afterHeldPage(data.chan, () => {
		const message = lookup(data.chan, data.id);

		if (message) {
			applyRedaction(message, {by: data.by, reason: data.reason, time: data.time});
		}

		// A deleted message keeps its text for click-to-reveal, but its
		// translation is a second, unhidden copy of that text: drop it, so a
		// reveal shows the original alone (Message.vue gates the line too).
		store.commit("translationRemove", data.id);
		forgetTranslations([data.id]);
	});
});

// Rows restored from the device's cache that the server's first history
// page did not meet (irc/history.ts reconcileCached): shown side by side
// with it they would hide a gap, so they leave the buffer.
socket.on("msg:drop", function (data) {
	afterHeldPage(data.chan, () => {
		const target = store.getters.findChannel(data.chan);

		if (!target) {
			return;
		}

		const ids = new Set(data.ids);
		target.channel.messages = target.channel.messages.filter((m) => !ids.has(m.id));
		store.commit("translationRemoveMany", data.ids);
		forgetTranslations(data.ids);
	});
});

socket.on("msg:edit", function (data) {
	afterHeldPage(data.chan, () => {
		const target = store.getters.findChannel(data.chan);

		if (!target) {
			return;
		}

		// The edit takes the original's place in the list; the original is hidden.
		const placed = applyEdit(target.channel.messages, data.replaces, data.id);

		// The original's translation (if any) belongs to text that no longer
		// exists; the edit arrives as its own `msg` and is read/translated on
		// its own terms.
		store.commit("translationRemove", data.replaces);
		forgetTranslations([data.replaces]);

		// A pending copy only stands in until its echo does (`msg:settled` shows
		// the original again), so the compose bar follows the real replacement
		// alone. Replying to or editing the replaced message follows the edit,
		// so the bar does not point at a hidden message.
		if (!placed || placed.replacement?.pending) {
			return;
		}

		const {original, replacement} = placed;

		if (target.channel.replyTo === original) {
			target.channel.replyTo = replacement ?? null;
		}

		if (target.channel.editing === original) {
			target.channel.editing = replacement ?? null;
		}
	});
});

socket.on("msg:settled", function (data) {
	const target = store.getters.findChannel(data.chan);

	if (target) {
		removePending(target.channel.messages, data.id);
	}
});
