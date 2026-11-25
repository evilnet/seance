/**
 * Avatars on the IRC side (draft/metadata-2's `avatar` key, a URL). The
 * key is subscribed with the shared keys where the network has avatars on
 * (avatars/prefs.ts), so the join burst carries the avatar of everyone in
 * the channel and a change reaches us as it happens. nefarious2 sends a
 * channel's members' values to the one who joins, not the joiner's value
 * to the members, so a user we have heard nothing about is asked for
 * (`METADATA <nick> GET avatar`) when a line of theirs arrives: through
 * the background queue, once per nick per connection.
 *
 * Our own avatar is written public (everyone sharing a channel sees it):
 * `METADATA * SET avatar :<url>`, and `METADATA * SET avatar` clears it.
 * The server answers 761 (or 766 for a clear) or a FAIL, which settles
 * {@link setOwnAvatar}'s promise.
 *
 * A channel has one too, the same key on the channel's name: nefarious2
 * lets its half-ops and ops (and opers) write it ({@link setChannelAvatar},
 * `METADATA #chan SET avatar :<url>`), sends it with the members' values
 * when we join, and sends a change to the members who subscribe. It goes
 * into the same registry under the channel's name, which no nick can be.
 * The burst only carries a key that is set, so a channel whose avatar we
 * remember from before is asked again when we join it, in case it was
 * removed while we were away ({@link onChannelJoined}).
 */

import {
	avatarKnown,
	avatarOf,
	clearAvatars,
	forgetAvatar,
	markAvatarStale,
	markAvatarsStale,
	noteAccount,
	renameAvatar,
	setAvatarValue,
} from "../avatars/registry";
import {avatarsEnabled} from "../avatars/prefs";
import type {IrcClient} from "./client";
import type {IrcMessage} from "./message";

export const AVATAR_KEY = "avatar";

/** A SET waiting for the server's answer. */
type PendingSet = {
	value: string;
	resolve: () => void;
	reject: (reason: string) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** Per-connection state, kept off IrcClient's own fields. */
type State = {
	/** Folded nicks asked with a GET on this connection. */
	asked: Set<string>;
	/** Folded nicks whose GET is still unanswered (their replies are ours to keep quiet). */
	waiting: Set<string>;
	pending: PendingSet | null;
	/** Our SETs on channels' avatars, by folded channel name. */
	channelPending: Map<string, PendingSet>;
};

const states = new WeakMap<IrcClient, State>();

function stateOf(client: IrcClient): State {
	let state = states.get(client);

	if (!state) {
		state = {asked: new Set(), waiting: new Set(), pending: null, channelPending: new Map()};
		states.set(client, state);
	}

	return state;
}

/** How long a SET may go unanswered before it counts as failed. */
export const SET_TIMEOUT_MS = 15_000;

/** Whether this connection shows avatars and can hear them. */
export function avatarsWanted(client: IrcClient): boolean {
	return avatarsEnabled(client.uuid) && client.caps.hasCapability("draft/metadata-2");
}

/** The keys to add to a `METADATA * SUB` this client sends. */
export function avatarSubKeys(client: IrcClient): string[] {
	return avatarsEnabled(client.uuid) ? [AVATAR_KEY] : [];
}

/**
 * 001: the burst that follows says it all again. Until it does, what we
 * knew stays drawn, so a reconnect does not flash every picture to its
 * initial and back.
 */
export function avatarsWelcomed(client: IrcClient): void {
	markAvatarsStale(client.uuid);
	const state = stateOf(client);
	state.asked.clear();
	state.waiting.clear();
}

/** The connection closed: an unanswered SET fails. */
export function avatarsClosed(client: IrcClient): void {
	const state = stateOf(client);
	state.asked.clear();
	state.waiting.clear();
	settle(client, "closed");

	for (const key of [...state.channelPending.keys()]) {
		settleChannel(client, key, "closed");
	}
}

/**
 * A METADATA line or reply naming the avatar key: `value` "" = none.
 * `reply`: a 761/766 (a channel SET of ours settles only on one, so a
 * change notification that reaches us first does not leave its reply to
 * be shown).
 */
export function onAvatarValue(
	client: IrcClient,
	target: string,
	value: string,
	reply = true
): void {
	if (!target || target === "*") {
		return;
	}

	setAvatarValue(client.uuid, target, value);
	const key = client.casefold(target);
	stateOf(client).waiting.delete(key);

	if (client.isChannelName(target)) {
		if (reply && stateOf(client).channelPending.get(key)?.value === value) {
			settleChannel(client, key);
		}

		return;
	}

	if (client.isSelf(target)) {
		const pending = stateOf(client).pending;

		if (pending && pending.value === value) {
			settle(client);
		}
	}
}

/**
 * A 761/766 for the avatar key that answers our own GET, or our SET: kept
 * quiet. A user's own `/metadata … get avatar` is shown as any reply is.
 */
export function isQuietAvatarReply(client: IrcClient, target: string): boolean {
	if (client.isSelf(target) && stateOf(client).pending) {
		return true;
	}

	if (stateOf(client).channelPending.has(client.casefold(target))) {
		return true;
	}

	return stateOf(client).waiting.has(client.casefold(target));
}

/**
 * A FAIL METADATA that concerns the avatar: refuses our pending SET (its
 * description goes to the settings), or answers a GET for a user that is
 * gone. True when it was ours and should not be shown.
 */
export function onAvatarFail(client: IrcClient, msg: IrcMessage): boolean {
	const state = stateOf(client);
	const params = msg.params;
	const code = params[1] ?? "";
	const context = params.slice(2, -1);
	const description = params[params.length - 1] ?? code;

	// INVALID_TARGET <target>: the user left before our GET arrived.
	if (
		code === "INVALID_TARGET" &&
		context[0] &&
		state.waiting.delete(client.casefold(context[0]))
	) {
		return true;
	}

	const aboutAvatar = context.includes(AVATAR_KEY);

	const aboutSet = aboutAvatar || code === "VALUE_INVALID" || code === "RATE_LIMITED";

	// A refusal naming a channel we are writing (KEY_NO_PERMISSION #chan avatar).
	const channelKey = context[0] ? client.casefold(context[0]) : "";

	if (aboutSet && state.channelPending.has(channelKey)) {
		settleChannel(client, channelKey, description || code);
		return true;
	}

	// One that names no target, while only a channel SET of ours is out.
	const namesNoTarget = !context[0] || context[0] === "*" || context[0] === AVATAR_KEY;

	if (!state.pending && state.channelPending.size === 1 && aboutSet && namesNoTarget) {
		settleChannel(client, [...state.channelPending.keys()][0], description || code);
		return true;
	}

	if (state.pending && (aboutAvatar || code === "VALUE_INVALID" || code === "RATE_LIMITED")) {
		settle(client, description || code);
		return true;
	}

	return aboutAvatar && state.waiting.size > 0;
}

function settle(client: IrcClient, failure?: string): void {
	const state = stateOf(client);
	const pending = state.pending;

	if (!pending) {
		return;
	}

	state.pending = null;
	clearTimeout(pending.timer);

	if (failure === undefined) {
		pending.resolve();
	} else {
		pending.reject(failure);
	}
}

function settleChannel(client: IrcClient, key: string, failure?: string): void {
	const state = stateOf(client);
	const pending = state.channelPending.get(key);

	if (!pending) {
		return;
	}

	state.channelPending.delete(key);
	clearTimeout(pending.timer);

	if (failure === undefined) {
		pending.resolve();
	} else {
		pending.reject(failure);
	}
}

/**
 * Write `channel`'s avatar (`""` clears it): the server lets a half-op or
 * op of the channel do it. Resolves when the server confirms, rejects with
 * its reason (or "closed"/"timeout"/"unavailable").
 */
export function setChannelAvatar(client: IrcClient, channel: string, value: string): Promise<void> {
	if (
		!client.isWelcomed ||
		!client.caps.hasCapability("draft/metadata-2") ||
		!client.isChannelName(channel)
	) {
		return Promise.reject(new Error("unavailable"));
	}

	const key = client.casefold(channel);
	settleChannel(client, key, "superseded");

	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => settleChannel(client, key, "timeout"), SET_TIMEOUT_MS);
		(timer as {unref?: () => void}).unref?.();
		stateOf(client).channelPending.set(key, {
			value,
			resolve,
			reject: (reason) => reject(new Error(reason)),
			timer,
		});
		client.send(
			value === ""
				? `METADATA ${channel} SET ${AVATAR_KEY}`
				: `METADATA ${channel} SET ${AVATAR_KEY} :${value}`
		);
	});
}

/**
 * We joined `channel`. The burst that follows names its avatar only when
 * it has one, so one we remember from before (kept between launches, or
 * from before a reconnect) is asked again: it may have been removed while
 * we were away. The ask waits in the background queue, by when the burst
 * has usually answered it already.
 */
export function onChannelJoined(client: IrcClient, channel: string): void {
	if (!avatarsWanted(client) || !avatarOf(client.uuid, channel)) {
		return;
	}

	// Known from an earlier stay on this connection is no better: while we
	// were parted, a removal never reached us. The burst, or the GET, says it.
	markAvatarStale(client.uuid, channel);
	const state = stateOf(client);
	const key = client.casefold(channel);
	const line = `METADATA ${channel} GET ${AVATAR_KEY}`;
	client.background.add({
		key: `avatar:${key}`,
		cost: client.fakeLag.cost(line),
		run() {
			if (avatarKnown(client.uuid, channel)) {
				return;
			}

			state.waiting.add(key);
			client.send(line);
		},
	});
}

/**
 * Write our own avatar (`""` clears it). Resolves when the server confirms,
 * rejects with its reason (or "closed"/"timeout"/"unavailable").
 */
export function setOwnAvatar(client: IrcClient, value: string): Promise<void> {
	if (!client.isWelcomed || !client.caps.hasCapability("draft/metadata-2")) {
		return Promise.reject(new Error("unavailable"));
	}

	settle(client, "superseded");

	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => settle(client, "timeout"), SET_TIMEOUT_MS);
		(timer as {unref?: () => void}).unref?.();
		stateOf(client).pending = {
			value,
			resolve,
			reject: (reason) => reject(new Error(reason)),
			timer,
		};
		client.send(
			value === "" ? `METADATA * SET ${AVATAR_KEY}` : `METADATA * SET ${AVATAR_KEY} :${value}`
		);
	});
}

/**
 * A line from `nick` arrived: note the account its tag names, and ask for
 * the avatar of a user we have heard nothing about.
 */
export function onLineFrom(client: IrcClient, nick: string, account: string | undefined): void {
	if (!nick || nick.includes(".") || !avatarsEnabled(client.uuid)) {
		return;
	}

	if (account !== undefined) {
		noteAccount(client.uuid, nick, account || null);
	}

	askAvatar(client, nick);
}

/** Queue a GET for `nick`'s avatar unless it is known or already asked. */
export function askAvatar(client: IrcClient, nick: string): void {
	if (!avatarsWanted(client) || client.isSelf(nick) || avatarKnown(client.uuid, nick)) {
		return;
	}

	const state = stateOf(client);
	const key = client.casefold(nick);

	if (state.asked.has(key)) {
		return;
	}

	state.asked.add(key);
	const line = `METADATA ${nick} GET ${AVATAR_KEY}`;
	client.background.add({
		key: `avatar:${key}`,
		cost: client.fakeLag.cost(line),
		run() {
			if (avatarKnown(client.uuid, nick)) {
				return;
			}

			state.waiting.add(key);
			client.send(line);
		},
	});
}

/** NICK: the avatar follows the user. */
export function onAvatarNick(client: IrcClient, from: string, to: string): void {
	renameAvatar(client.uuid, from, to);
	const state = stateOf(client);

	for (const set of [state.asked, state.waiting]) {
		if (set.delete(client.casefold(from))) {
			set.add(client.casefold(to));
		}
	}
}

/** QUIT, or a PART/KICK after which no channel is shared: forget the nick. */
export function onAvatarGone(client: IrcClient, nick: string): void {
	if (client.isSelf(nick)) {
		return;
	}

	forgetAvatar(client.uuid, nick);
	const key = client.casefold(nick);
	stateOf(client).asked.delete(key);
	stateOf(client).waiting.delete(key);
}

/** After a PART or KICK: forget the nick when no channel we are in still has them. */
export function onAvatarLeft(client: IrcClient, nick: string): void {
	if (!client.channels.some((chan) => chan.findUser(nick))) {
		onAvatarGone(client, nick);
	}
}

/** extended-join / account-notify: `*` = not logged in. */
export function onAvatarAccount(client: IrcClient, nick: string, account: string): void {
	if (!nick || !avatarsEnabled(client.uuid)) {
		return;
	}

	noteAccount(client.uuid, nick, account === "*" || account === "" ? null : account);
}

/** Our own avatar's value as last heard from the server, or undefined. */
export function ownAvatarValue(client: IrcClient): string | undefined {
	return avatarKnown(client.uuid, client.nick)
		? avatarOf(client.uuid, client.nick)?.value
		: undefined;
}

/** Our own GET of the avatar key is going out: its reply is state, not news. */
export function expectOwnAvatar(client: IrcClient): void {
	stateOf(client).waiting.add(client.casefold(client.nick));
}

/** The reader switched avatars on or off for this network (Settings → Account). */
export function applyAvatarsEnabled(client: IrcClient, on: boolean): void {
	if (!on) {
		clearAvatars(client.uuid);
	}

	if (!client.isWelcomed || !client.caps.hasCapability("draft/metadata-2")) {
		return;
	}

	client.send(`METADATA * ${on ? "SUB" : "UNSUB"} ${AVATAR_KEY}`);

	if (on) {
		// Those in our channels now are asked as they speak; our own at once.
		expectOwnAvatar(client);
		client.send(`METADATA * GET ${AVATAR_KEY}`);
	}
}
