// Per-channel reply/edit compose state (ClientChan.replyTo / .editing).
// Shared by the message action bar, ChatInput and the `msg:edit` consumer.
// Reply and edit are mutually exclusive: starting one clears the other.
import {nextTick} from "vue";
import {MessageType} from "../../../shared/types/msg";
import type {ClientChan, ClientMessage} from "../types";

export function focusInput() {
	const input = document.getElementById("input") as HTMLTextAreaElement | null;

	if (!input) {
		return;
	}

	input.focus();
	// Put the caret at the end (edit pre-fills the text). The textarea's
	// `:value` is patched on Vue's next tick, so the text an edit just put in
	// `pendingMessage` is not in the element yet: place the caret after it.
	const toEnd = () => {
		const end = input.value.length;
		input.setSelectionRange(end, end);
	};

	toEnd();
	void nextTick(toEnd);
}

export function startReply(channel: ClientChan, message: ClientMessage) {
	if (!message.msgid) {
		return;
	}

	channel.editing = null;
	channel.replyTo = message;
	focusInput();
}

/**
 * What the composer holds while `message` is being edited: its text, and
 * for an action (`/me`) the command in front, so it is still an action when
 * sent (the IRC layer reads `/me ` at the start of an edit as one: irc/
 * commands/index.ts `dispatchInput`). Taking the `/me ` off turns it into a
 * plain message; adding it to a plain one's edit, into an action.
 */
export function editText(message: ClientMessage): string {
	const text = message.text ?? "";
	return message.type === MessageType.ACTION ? `/me ${text}` : text;
}

export function startEdit(channel: ClientChan, message: ClientMessage) {
	if (!message.msgid || !message.self) {
		return;
	}

	channel.replyTo = null;
	channel.editing = message;
	channel.pendingMessage = editText(message);
	channel.inputHistoryPosition = 0;
	focusInput();
}

export function cancelCompose(channel: ClientChan) {
	if (channel.editing) {
		channel.editing = null;
		channel.pendingMessage = "";
	}

	channel.replyTo = null;
}

/** An own message or action with a msgid that can still be edited. */
export function isEditable(m: ClientMessage): boolean {
	return Boolean(
		m.self &&
			m.msgid &&
			(m.type === MessageType.MESSAGE || m.type === MessageType.ACTION) &&
			!m.redacted &&
			m.supersededBy === undefined
	);
}

function indexOfMessage(channel: ClientChan, message: ClientMessage): number {
	return channel.messages.findIndex((m) => m.id === message.id);
}

/** Newest own editable message in the channel (ArrowUp in an empty input). */
export function findLastEditable(channel: ClientChan): ClientMessage | undefined {
	for (let i = channel.messages.length - 1; i >= 0; i--) {
		if (isEditable(channel.messages[i])) {
			return channel.messages[i];
		}
	}

	return undefined;
}

/** Nearest own editable message older than `message` (ArrowUp while editing). */
export function findEditableBefore(
	channel: ClientChan,
	message: ClientMessage
): ClientMessage | undefined {
	for (let i = indexOfMessage(channel, message) - 1; i >= 0; i--) {
		if (isEditable(channel.messages[i])) {
			return channel.messages[i];
		}
	}

	return undefined;
}

/** Nearest own editable message newer than `message` (ArrowDown while editing). */
export function findEditableAfter(
	channel: ClientChan,
	message: ClientMessage
): ClientMessage | undefined {
	const at = indexOfMessage(channel, message);

	if (at === -1) {
		return undefined;
	}

	for (let i = at + 1; i < channel.messages.length; i++) {
		if (isEditable(channel.messages[i])) {
			return channel.messages[i];
		}
	}

	return undefined;
}
