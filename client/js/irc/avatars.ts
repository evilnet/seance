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
 * A channel has an avatar too (the IRCv3 registry's channel `avatar` key),
 * which its half-ops and ops set and every member subscribed to the key
 * hears. nefarious2 sends it to the one joining, after the JOIN (and, for
 * a logged-in user, after the NAMES); a held session's replayed join burst
 * carries none. So a channel's value is taken whenever it comes, and
 * asked for (background, once per channel per connection) only where it
 * matters: a picture known from before that the burst did not say again
 * (it may be gone), and a channel opened without one known.
 *
 * Our own avatar is written public (everyone sharing a channel sees it):
 * `METADATA * SET avatar :<url>`, and `METADATA * SET avatar` clears it; a
 * channel's is `METADATA <channel> SET avatar …`. The server answers 761
 * (or 766 for a clear) or a FAIL, which settles {@link setOwnAvatar}'s or
 * {@link setChannelAvatar}'s promise.
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
import type {IrcClient} from "./client";
import {isOpered} from "./oper";
import type {IrcMessage} from "./message";

export const AVATAR_KEY = "avatar";

/** A SET waiting for the server's answer. */
type PendingSet = {
	/** The channel whose avatar it sets; absent for our own. */
	channel?: string;
	value: string;
	resolve: () => void;
	reject: (reason: string) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** Per-connection state, kept off IrcClient's own fields. */
type State = {
	/** Folded nicks (and channels) asked with a GET on this connection. */
	asked: Set<string>;
	/** Folded nicks (and channels) whose GET is still unanswered (their replies are ours to keep quiet). */
	waiting: Set<string>;
	pending: PendingSet | null;
};

const states = new WeakMap<IrcClient, State>();

function stateOf(client: IrcClient): State {
	let state = states.get(client);

	if (!state) {
		state = {asked: new Set(), waiting: new Set(), pending: null};
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
}

/** Whether `target` (a nick or a channel, as a reply names it) is what `pending` sets. */
function pendingFor(client: IrcClient, pending: PendingSet, target: string): boolean {
	return pending.channel === undefined
		? client.isSelf(target)
		: client.casefold(pending.channel) === client.casefold(target);
}

/** A METADATA line or reply naming the avatar key: `value` "" = none. */
export function onAvatarValue(client: IrcClient, target: string, value: string): void {
	if (!target || target === "*") {
		return;
	}

	setAvatarValue(client.uuid, target, value);
	const key = client.casefold(target);
	stateOf(client).waiting.delete(key);
	const pending = stateOf(client).pending;

	if (pending && pendingFor(client, pending, target) && pending.value === value) {
		settle(client);
	}
}

/**
 * A 761/766 for the avatar key that answers our own GET, or our SET: kept
 * quiet. A user's own `/metadata … get avatar` is shown as any reply is.
 */
export function isQuietAvatarReply(client: IrcClient, target: string): boolean {
	const pending = stateOf(client).pending;

	if (pending && pendingFor(client, pending, target)) {
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
	// INVALID_TARGET <channel>: the channel our SET names is not one we can see.
	const aboutPending =
		state.pending !== null &&
		code === "INVALID_TARGET" &&
		!!context[0] &&
		pendingFor(client, state.pending, context[0]);

	if (
		state.pending &&
		(aboutAvatar || aboutPending || code === "VALUE_INVALID" || code === "RATE_LIMITED")
	) {
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

/** Write `value` to the avatar key of `channel`, or our own (undefined). One SET at a time. */
function setAvatar(client: IrcClient, channel: string | undefined, value: string): Promise<void> {
	if (!client.isWelcomed || !client.caps.hasCapability("draft/metadata-2")) {
		return Promise.reject(new Error("unavailable"));
	}

	settle(client, "superseded");
	const target = channel ?? "*";

	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => settle(client, "timeout"), SET_TIMEOUT_MS);
		(timer as {unref?: () => void}).unref?.();
		stateOf(client).pending = {
			channel,
			value,
			resolve,
			reject: (reason) => reject(new Error(reason)),
			timer,
		};
		client.send(
			value === ""
				? `METADATA ${target} SET ${AVATAR_KEY}`
				: `METADATA ${target} SET ${AVATAR_KEY} :${value}`
		);
	});
}

/**
 * Write our own avatar (`""` clears it). Resolves when the server confirms,
 * rejects with its reason (or "closed"/"timeout"/"unavailable").
 */
export function setOwnAvatar(client: IrcClient, value: string): Promise<void> {
	return setAvatar(client, undefined, value);
}

/**
 * Write `channel`'s avatar (`""` clears it): the server takes it from a
 * half-op, an op or an IRC operator and refuses anyone else
 * (KEY_NO_PERMISSION). Settles as {@link setOwnAvatar} does.
 */
export function setChannelAvatar(client: IrcClient, channel: string, value: string): Promise<void> {
	return setAvatar(client, channel, value);
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
 * Queue a GET for the avatar of `nick` (or a channel) unless it is known or
 * already asked. The queue may run it after the burst has said it after
 * all: it checks again then.
 */
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

/**
 * The end of a channel's join burst (366). A picture known from before
 * that the burst has not said again may be gone: ask. So is the channel
 * open on screen without one known. Anything else waits for the server to
 * say it (a logged-in user hears it after the NAMES) or for the channel to
 * be opened.
 */
export function onChannelBurstEnd(client: IrcClient, channel: string, open: boolean): void {
	if (avatarKnown(client.uuid, channel)) {
		return;
	}

	if (open || avatarOf(client.uuid, channel)?.value) {
		askAvatar(client, channel);
	}
}

/**
 * Whether we may set `channel`'s avatar, as nefarious2 decides it: a member
 * who is half-op and up (op and up where the network has no half-ops), or
 * an IRC operator.
 */
export function canSetChannelAvatar(client: IrcClient, channel: string): boolean {
	if (!client.isWelcomed || !client.caps.hasCapability("draft/metadata-2")) {
		return false;
	}

	if (isOpered(client)) {
		return true;
	}

	const chan = client.findChannel(channel);
	const mine = chan?.findUser(client.nick)?.modes[0];
	const symbols = client.isupport.prefix.symbols;
	const floor = symbols.includes("%") ? symbols.indexOf("%") : symbols.indexOf("@");

	return mine !== undefined && floor !== -1 && client.prefixRank(mine) <= floor;
}

/** The channel was opened: ask for its avatar unless it is known. */
export function onChannelOpened(client: IrcClient, channel: string): void {
	askAvatar(client, channel);
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

/**
 * QUIT, or a PART/KICK after which no channel is shared: forget the nick.
 * Also our own PART of a channel, whose avatar goes with its window.
 */
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
