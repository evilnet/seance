/**
 * Pending outgoing messages (docs/resources/bus-contract.md §1.9).
 *
 * With `echo-message` it is the server, not the client, that produces the
 * copy of a sent message that goes into the timeline — so until the echo
 * arrives the user would see nothing of what they just typed. This module
 * shows a *pending copy* the moment the line is on the wire (an ordinary
 * `msg` event whose message has `pending: true`) and takes it down again
 * (`msg:settled`) when the server answers: with the echo itself, with a
 * numeric rejecting the line, with a labelled `ACK`, with a `FAIL` for a
 * multiline batch, when the connection closes, or after
 * {@link PENDING_TIMEOUT_MS} of silence.
 *
 * The echo is matched to its copy by `labeled-response` label when the
 * server relays it: every line goes out as `@label=s<n>`, and nefarious2
 * puts the label on the echo (on the batch opener for a multiline one) and
 * on the numeric that rejects it (probed 2026-09-04). But the spec does not
 * require the label on a propagated echo-message copy, so it is a fast path,
 * not the only one: failing it (or without the cap at all) the copy is found
 * by content — the oldest unsettled copy of the same kind in the channel,
 * exact text preferred — since echoes come back in the order the lines went
 * out. See {@link settleEcho}.
 *
 * Copies bypass `IrcClient.pushMessage` on purpose: a line the server has
 * not taken must not move the read marker, count towards the history
 * total, or hold an id the catch-up cursor could refer to.
 */

import {t} from "../i18n/core";
import {MessageType, SharedMsg} from "../../../shared/types/msg";
import type {Channel} from "./channel";
import type {IrcClient} from "./client";
import type {IrcMessage} from "./message";

/** How long a copy waits for the server before it is reported as not sent. */
export const PENDING_TIMEOUT_MS = 60000;

/** Bytes a line keeps free for its `@label=s<n> ` (see `IrcClient.sendMessage`). */
export const LABEL_TAG_BYTES = "@label=s99999999 ".length;

export interface PendingMessage {
	/** Store id of the copy (the id of the `msg` it was delivered as). */
	id: number;
	chan: Channel;
	/** The `labeled-response` label the line went out with, when the cap is on. */
	label?: string;
	type: MessageType;
	text: string;
	/** Reports the copy as not sent {@link PENDING_TIMEOUT_MS} after it was armed. */
	timer?: ReturnType<typeof setTimeout>;
}

/** What a copy shows (the fields of the message the echo will carry). */
export interface PendingFields {
	type: MessageType;
	text: string;
	label?: string;
	replyTo?: string;
	editOf?: string;
	statusmsgGroup?: string;
}

interface Registry {
	/** Copies waiting for the server, oldest first. */
	entries: PendingMessage[];
	/** Counter behind {@link pendingLabel}. */
	labels: number;
}

const registries = new WeakMap<IrcClient, Registry>();

function registryOf(client: IrcClient): Registry {
	let registry = registries.get(client);

	if (!registry) {
		registry = {entries: [], labels: 0};
		registries.set(client, registry);
	}

	return registry;
}

/** A fresh label for an outgoing line, or undefined when the server would not relay one. */
export function pendingLabel(client: IrcClient): string | undefined {
	if (!client.caps.hasCapability("labeled-response")) {
		return undefined;
	}

	return `s${++registryOf(client).labels}`;
}

/**
 * Show a pending copy of `fields` in `chan`. With `arm` (the default) the
 * timeout starts now; a multiline batch queued behind another one arms it
 * when it actually goes out ({@link armPending}).
 */
export function showPending(
	client: IrcClient,
	chan: Channel,
	fields: PendingFields,
	{arm = true}: {arm?: boolean} = {}
): PendingMessage {
	const msg: SharedMsg = {
		id: client.nextMsgId(),
		type: fields.type,
		time: new Date(),
		text: fields.text,
		self: true,
		from: chan.userRef(client.nick),
		pending: true,
		users: [],
		...(fields.replyTo ? {replyTo: fields.replyTo} : {}),
		...(fields.editOf ? {editOf: fields.editOf} : {}),
		...(fields.statusmsgGroup ? {statusmsgGroup: fields.statusmsgGroup} : {}),
	};
	const entry: PendingMessage = {
		id: msg.id,
		chan,
		label: fields.label,
		type: fields.type,
		text: fields.text,
	};

	registryOf(client).entries.push(entry);
	client.dispatch("msg", {chan: chan.id, msg});

	// The copy of an edit stands in the original's place, as the echo will
	// (bus-contract §1.4): the same `msg:edit`, for a copy.
	const replaces = fields.editOf ? chan.idOf(fields.editOf) : undefined;

	if (replaces !== undefined) {
		client.dispatch("msg:edit", {chan: chan.id, id: msg.id, replaces});
	}

	if (arm) {
		armPending(client, entry);
	}

	return entry;
}

/** Start (or restart, for a re-sent batch) the copy's wait for the server. */
export function armPending(client: IrcClient, entry: PendingMessage): void {
	if (entry.timer) {
		clearTimeout(entry.timer);
	}

	entry.timer = setTimeout(() => {
		entry.timer = undefined;
		failPending(client, entry, t("pending.noAcknowledgement"));
	}, PENDING_TIMEOUT_MS);
}

/** Take the copy down. Idempotent; returns whether it was still waiting. */
export function settlePending(client: IrcClient, entry: PendingMessage): boolean {
	const registry = registryOf(client);
	const index = registry.entries.indexOf(entry);

	if (index === -1) {
		return false;
	}

	registry.entries.splice(index, 1);

	if (entry.timer) {
		clearTimeout(entry.timer);
		entry.timer = undefined;
	}

	client.dispatch("msg:settled", {chan: entry.chan.id, id: entry.id});
	return true;
}

/** Take the copy down and say why, where the user typed it. */
export function failPending(client: IrcClient, entry: PendingMessage, reason: string): void {
	if (settlePending(client, entry)) {
		client.pushMessage(entry.chan, {
			type: MessageType.ERROR,
			text: t("pending.notSent", {reason, text: entry.text}),
		});
	}
}

/**
 * The copy a live message of ours answers, taken down; undefined when it
 * answers none (another session of the account speaking, say). `type` and
 * `text` are what the handler made of the line, so an ACTION only ever
 * settles an ACTION.
 */
export function settleEcho(
	client: IrcClient,
	chan: Channel,
	msg: IrcMessage,
	type: MessageType,
	text: string
): PendingMessage | undefined {
	const entries = registryOf(client).entries;
	const label = msg.tags.get("label");

	// The label is the exact match — but only when the server relays it on the
	// echo, which the spec does not require of a propagated echo-message copy
	// and not every server does. So it is a fast path, not the only one.
	let entry = label ? entries.find((e) => e.label === label) : undefined;

	if (!entry) {
		// No usable label. Our echoes carry the text we sent, so match a copy
		// of the same kind in this channel by exact text. That is what keeps a
		// self message we never sent — the same account on another device —
		// from settling anything: it matches none of our copies.
		const kind = entries.filter((e) => e.chan === chan && e.type === type);
		entry = kind.find((e) => e.text === text);

		// A server with no `labeled-response` at all can also alter the text
		// (stripping colours, say), so there the oldest copy of the kind is
		// the best guess. With the cap negotiated a missing label is the odd
		// case, not an altered message, so exact text is required.
		if (!entry && !client.caps.hasCapability("labeled-response")) {
			entry = kind[0];
		}
	}

	if (entry) {
		settlePending(client, entry);
	}

	return entry;
}

function byLabel(client: IrcClient, label: string): PendingMessage | undefined {
	return registryOf(client).entries.find((e) => e.label === label);
}

/** A labelled rejection (a 4xx numeric): report it with the text. Returns whether it was ours. */
export function failPendingLabel(client: IrcClient, label: string, reason: string): boolean {
	const entry = byLabel(client, label);

	if (!entry) {
		return false;
	}

	failPending(client, entry, reason);
	return true;
}

/** A labelled `ACK`: the server took the line and has nothing to echo. */
export function settlePendingLabel(client: IrcClient, label: string): boolean {
	const entry = byLabel(client, label);
	return entry ? settlePending(client, entry) : false;
}

/** Report everything still waiting as not sent (the connection closed). */
export function resetPending(client: IrcClient, reason: string): void {
	for (const entry of [...registryOf(client).entries]) {
		failPending(client, entry, reason);
	}
}

/** Whether any copy is waiting (tests / diagnostics). */
export function hasPending(client: IrcClient): boolean {
	return registryOf(client).entries.length > 0;
}
