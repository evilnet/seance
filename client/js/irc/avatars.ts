/**
 * Avatars on the IRC side (draft/metadata-2's `avatar` key, a URL). The
 * key is subscribed with the shared keys where the network has avatars on
 * (avatars/prefs.ts), so the join burst carries the avatar of everyone in
 * the channel and a change reaches us as it happens. nefarious2 sends a
 * channel's members' values to the one who joins, not the joiner's value
 * to the members, so a user we have heard nothing about is asked for
 * (`METADATA <nick> GET avatar`) when a line of theirs arrives: through
 * the background queue, once per nick per connection. A held session's
 * replayed join burst carries no values at all, and nobody's avatar showed
 * until someone spoke live: there each restored channel is asked for all of
 * its members' at once (`METADATA <channel> SYNC`), and a line from history
 * (a replay, or one the device kept) elsewhere asks for its sender, where
 * they are still here.
 *
 * Our own avatar is written public (everyone sharing a channel sees it):
 * `METADATA * SET avatar :<url>`, and `METADATA * SET avatar` clears it.
 * The server answers 761 (or 766 for a clear) or a FAIL, which settles
 * {@link setOwnAvatar}'s promise.
 */

import {
	avatarKnown,
	avatarOf,
	clearAvatars,
	forgetAvatar,
	markAvatarsStale,
	noteAccount,
	renameAvatar,
	setAvatarValue,
} from "../avatars/registry";
import {avatarsEnabled} from "../avatars/prefs";
import {ChanState, ChanType} from "../../../shared/types/chan";
import type {Channel} from "./channel";
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
	/** Folded channels asked with a SYNC on this connection: their members are covered. */
	synced: Set<string>;
	pending: PendingSet | null;
};

const states = new WeakMap<IrcClient, State>();

function stateOf(client: IrcClient): State {
	let state = states.get(client);

	if (!state) {
		state = {asked: new Set(), waiting: new Set(), synced: new Set(), pending: null};
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
	state.synced.clear();
}

/** The connection closed: an unanswered SET fails. */
export function avatarsClosed(client: IrcClient): void {
	const state = stateOf(client);
	state.asked.clear();
	state.waiting.clear();
	state.synced.clear();
	settle(client, "closed");
}

/** A METADATA line or reply naming the avatar key: `value` "" = none. */
export function onAvatarValue(client: IrcClient, target: string, value: string): void {
	if (!target || target === "*" || client.isChannelName(target)) {
		return;
	}

	setAvatarValue(client.uuid, target, value);
	const key = client.casefold(target);
	stateOf(client).waiting.delete(key);

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

/**
 * A line from history in `chan` (a replay, or one the device kept): ask
 * for its sender's avatar too, where they are still here (a member of the
 * channel, or the private conversation's peer), so a conversation filled
 * from history gets its pictures without anyone having to speak first. A
 * held session's replayed join burst says no one's value. Someone who has
 * left is not asked: the server has no avatar for a nick that is gone. The
 * account an old line names may be stale, so it is not noted.
 */
export function onHistoryLineFrom(client: IrcClient, chan: Channel, nick: string): void {
	if (!nick || nick.includes(".") || !avatarsEnabled(client.uuid)) {
		return;
	}

	// A channel asked with a SYNC: its members' values come with that.
	if (chan.type === ChanType.CHANNEL && stateOf(client).synced.has(client.casefold(chan.name))) {
		return;
	}

	const here =
		chan.type === ChanType.CHANNEL
			? !!chan.findUser(nick)
			: chan.type === ChanType.QUERY && client.casefold(chan.name) === client.casefold(nick);

	if (here) {
		askAvatar(client, nick);
	}
}

/**
 * The end of a channel's NAMES in a held session's restoration batch, which
 * carries no metadata: no one in it has a value. One `METADATA <channel>
 * SYNC` asks for them all (nefarious2 answers a `metadata` batch of the
 * channel's and every member's subscribed keys, unwrapped by
 * handlers/metadata.ts), instead of a GET per member: once per channel per
 * connection, through the background queue, the channel on screen at its
 * front. A member with no avatar is simply not in the answer.
 */
export function syncChannelAvatars(client: IrcClient, chan: Channel): void {
	if (!avatarsWanted(client) || chan.type !== ChanType.CHANNEL) {
		return;
	}

	const state = stateOf(client);
	const key = client.casefold(chan.name);

	if (state.synced.has(key)) {
		return;
	}

	state.synced.add(key);
	const line = `METADATA ${chan.name} SYNC`;
	client.background.add(
		{
			key: `avatar-sync:${key}`,
			cost: client.fakeLag.cost(line),
			run() {
				client.send(line);
			},
		},
		{front: chan.id === client.activeChannelId}
	);
}

/**
 * The avatar key was subscribed after our channels were joined: a
 * connection without an account (or a server that takes no SUB before
 * registration) subscribes it 10 s after 001 (client.ts), after the
 * autojoin, and switching avatars on subscribes it mid-session. nefarious2
 * sends members' values to a joiner only for keys already subscribed, so
 * those join bursts said no one's: each joined channel is asked once with a
 * SYNC instead. A channel joined after this has its values in its burst.
 */
export function syncAvatarsOfJoinedChannels(client: IrcClient): void {
	for (const chan of client.channels) {
		if (chan.type === ChanType.CHANNEL && chan.state === ChanState.JOINED) {
			syncChannelAvatars(client, chan);
		}
	}
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
		// Our own at once; those in our channels with a SYNC per channel.
		expectOwnAvatar(client);
		client.send(`METADATA * GET ${AVATAR_KEY}`);
		syncAvatarsOfJoinedChannels(client);
	}
}
