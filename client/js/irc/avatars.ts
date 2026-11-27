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
 * A channel has an avatar too (the IRCv3 registry's channel `avatar` key),
 * which its half-ops and ops set and every member subscribed to the key
 * hears. nefarious2 sends it to the one joining, after the JOIN (and, for
 * a logged-in user, after the NAMES); a held session's replayed join burst
 * carries none. So a channel's value is taken whenever it comes, and asked
 * for (background, once per channel per connection) only where it matters:
 * a picture known from before that the burst did not say again (it may be
 * gone), and a channel opened without one known.
 *
 * Our own avatar is written public (everyone sharing a channel sees it):
 * `METADATA * SET avatar :<url>`, and `METADATA * SET avatar` clears it; a
 * channel's is `METADATA <channel> SET avatar …`. The server answers each
 * of our GETs and SETs in turn, with a 761 (766 for none) or a FAIL; a SET's
 * answer settles {@link setOwnAvatar}'s or {@link setChannelAvatar}'s
 * promise, and none of ours is shown.
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
import {ChanState, ChanType} from "../../../shared/types/chan";
import type {Channel} from "./channel";
import type {IrcClient} from "./client";
import type {IrcMessage} from "./message";

export const AVATAR_KEY = "avatar";

/**
 * Why a SET failed. `message` is the server's description where it gave
 * one; `code` is what to act on: the FAIL code (`KEY_NO_PERMISSION`,
 * `VALUE_INVALID`, …), or `closed`, `timeout`, `unsent` or `unavailable`
 * from this side.
 */
export class AvatarSetError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = "AvatarSetError";
	}
}

/** A SET waiting for the server's answer. */
type PendingSet = {
	kind: "set";
	/** The channel whose avatar it sets; absent for our own. */
	channel?: string;
	/** What it writes (`""` clears): its 761 says it again (a 766 for `""`). */
	value: string;
	/** Settled already (it timed out): its late answer is still ours to keep quiet. */
	done: boolean;
	/** When it went out, against the other SETs (a FAIL naming no target is the oldest's). */
	order: number;
	resolve: () => void;
	reject: (reason: string, code: string) => void;
	timer: ReturnType<typeof setTimeout>;
};

/**
 * A request for the avatar key the server has yet to answer: our GET, our
 * SET, or the user's own (`/metadata`, `/raw`), whose answer is theirs to see.
 */
type InFlight = {kind: "get"} | {kind: "user"} | PendingSet;

/** Per-connection state, kept off IrcClient's own fields. */
type State = {
	/** Folded nicks (and channels) asked with a GET on this connection. */
	asked: Set<string>;
	/**
	 * Our GETs and SETs not yet answered, by target ({@link targetKey}), in
	 * the order they went out. The server answers one target's in that
	 * order, each with a 761/766 or a FAIL naming the target, so the oldest
	 * is the one an answer is for; a METADATA notification answers nothing
	 * (another op's change can come before our own refusal). The user's own
	 * requests are filed here too, so theirs and ours are told apart; an
	 * answer with nothing waiting for it is shown, as theirs is.
	 */
	inFlight: Map<string, InFlight[]>;
	/** Folded channels asked with a SYNC on this connection: they and their members are covered. */
	synced: Set<string>;
};

const states = new WeakMap<IrcClient, State>();

function stateOf(client: IrcClient): State {
	let state = states.get(client);

	if (!state) {
		state = {asked: new Set(), inFlight: new Map(), synced: new Set()};
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
	state.synced.clear();
}

/** The connection closed: nothing will be answered, and an unanswered SET fails. */
export function avatarsClosed(client: IrcClient): void {
	const state = stateOf(client);
	state.asked.clear();
	state.synced.clear();
	const open = [...state.inFlight.values()].flat();
	state.inFlight.clear();

	for (const entry of open) {
		if (entry.kind === "set") {
			fail(entry, "closed");
		}
	}
}

/** Our own requests are filed under their target: `*` and our nick are one. */
function targetKey(client: IrcClient, target: string): string {
	return target === "*" || client.isSelf(target) ? "*" : client.casefold(target);
}

function track(client: IrcClient, target: string, entry: InFlight): void {
	const inFlight = stateOf(client).inFlight;
	const key = targetKey(client, target);
	const list = inFlight.get(key);

	if (list) {
		list.push(entry);
	} else {
		inFlight.set(key, [entry]);
	}
}

/** Take `entry` (or, with none given, the oldest for `target`) off the list of what is in flight. */
function untrack(client: IrcClient, target: string, entry?: InFlight): InFlight | undefined {
	const inFlight = stateOf(client).inFlight;
	const key = targetKey(client, target);
	const list = inFlight.get(key);

	if (!list) {
		return undefined;
	}

	const index = entry === undefined ? 0 : list.indexOf(entry);
	const [found] = index === -1 ? [] : list.splice(index, 1);

	if (list.length === 0) {
		inFlight.delete(key);
	}

	return found;
}

function finish(set: PendingSet): void {
	clearTimeout(set.timer);

	if (!set.done) {
		set.done = true;
		set.resolve();
	}
}

function fail(set: PendingSet, reason: string, code = reason): void {
	clearTimeout(set.timer);

	if (!set.done) {
		set.done = true;
		set.reject(reason, code);
	}
}

/** A METADATA line naming the avatar key (a burst or someone's change): `value` "" = none. */
export function onAvatarValue(client: IrcClient, target: string, value: string): void {
	if (!target || target === "*") {
		return;
	}

	setAvatarValue(client.uuid, target, value);
}

/**
 * A 761/766 for the avatar key: the value (`undefined` for a private one,
 * which is not anyone's avatar), and the answer to our oldest GET or SET
 * for its target, if one is in flight. True when it was ours, so is not
 * shown; a user's own `/metadata … get avatar` is shown as any reply is.
 */
export function onAvatarReply(
	client: IrcClient,
	target: string,
	value: string | undefined
): boolean {
	if (value !== undefined) {
		onAvatarValue(client, target, value);
	}

	const oldest = stateOf(client).inFlight.get(targetKey(client, target))?.[0];

	// Our SET's answer says the value it wrote: another, the server's answer
	// to another of the account's devices (a shared session hears those).
	if (oldest?.kind === "set" && oldest.value !== (value ?? oldest.value)) {
		return false;
	}

	const answered = untrack(client, target);

	if (answered?.kind === "set") {
		finish(answered);
	}

	return answered !== undefined && answered.kind !== "user";
}

/**
 * A line the user sent as it was typed (`/metadata …`, `/raw …`). A GET or
 * SET that names the avatar key gets its answer in turn with ours, so it is
 * filed with ours: their answer is shown, and is not taken for ours.
 */
export function noteTypedLine(client: IrcClient, line: string): void {
	const [command = "", target, verb = "", ...rest] = line.trim().split(/\s+/);

	if (command.toUpperCase() !== "METADATA" || !target) {
		return;
	}

	const keys =
		verb.toUpperCase() === "GET" ? rest : verb.toUpperCase() === "SET" ? rest.slice(0, 1) : [];

	if (keys.includes(AVATAR_KEY)) {
		track(client, target, {kind: "user"});
	}
}

/**
 * A FAIL METADATA that concerns the avatar. One that names its target
 * (`INVALID_TARGET <target>`, `KEY_NO_PERMISSION <target> avatar`) answers
 * our oldest request for that target; one that names none (VALUE_INVALID,
 * RATE_LIMITED, or the key alone) our oldest SET. A refused SET's
 * description goes to the settings that asked. True when it was ours and
 * should not be shown.
 */
export function onAvatarFail(client: IrcClient, msg: IrcMessage): boolean {
	const params = msg.params;
	const code = params[1] ?? "";
	const context = params.slice(2, -1);
	const description = params[params.length - 1] || code;
	const target = context[0];

	if (target && target !== AVATAR_KEY) {
		if (code !== "INVALID_TARGET" && !context.includes(AVATAR_KEY)) {
			return false;
		}

		const answered = untrack(client, target);

		if (answered?.kind === "set") {
			fail(answered, description, code);
		}

		return answered !== undefined && answered.kind !== "user";
	}

	if (target !== AVATAR_KEY && code !== "VALUE_INVALID" && code !== "RATE_LIMITED") {
		return false;
	}

	const oldest = oldestSet(client);

	if (!oldest) {
		return false;
	}

	untrack(client, oldest.target, oldest.set);
	fail(oldest.set, description, code);
	return true;
}

function oldestSet(client: IrcClient): {target: string; set: PendingSet} | undefined {
	let oldest: {target: string; set: PendingSet} | undefined;

	for (const [target, list] of stateOf(client).inFlight) {
		for (const entry of list) {
			if (entry.kind === "set" && (!oldest || entry.order < oldest.set.order)) {
				oldest = {target, set: entry};
			}
		}
	}

	return oldest;
}

let nextOrder = 0;

/** Write `value` to the avatar key of `channel`, or our own (undefined). */
function setAvatar(client: IrcClient, channel: string | undefined, value: string): Promise<void> {
	if (!client.isWelcomed || !client.caps.hasCapability("draft/metadata-2")) {
		return Promise.reject(new AvatarSetError("unavailable", "unavailable"));
	}

	const target = channel ?? "*";

	return new Promise<void>((resolve, reject) => {
		const set: PendingSet = {
			kind: "set",
			channel,
			value,
			done: false,
			order: nextOrder++,
			resolve,
			reject: (reason, code) => reject(new AvatarSetError(reason, code)),
			// It stays in flight: an answer that comes late is still its own.
			timer: setTimeout(() => fail(set, "timeout"), SET_TIMEOUT_MS),
		};
		(set.timer as {unref?: () => void}).unref?.();
		track(client, target, set);
		const sent = client.send(
			value === ""
				? `METADATA ${target} SET ${AVATAR_KEY}`
				: `METADATA ${target} SET ${AVATAR_KEY} :${value}`
		);

		// Not sent, so no answer is coming: fail now rather than at the
		// timeout. A line over the limit (a long link on a long channel
		// name) is refused while the socket is open; otherwise it closed.
		if (!sent) {
			untrack(client, target, set);
			fail(set, client.transport.state === "open" ? "unsent" : "closed");
		}
	});
}

/**
 * Write our own avatar (`""` clears it). Resolves when the server confirms,
 * rejects with its reason (or "closed"/"timeout"/"unavailable"/"unsent").
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

			const get: InFlight = {kind: "get"};
			track(client, nick, get);

			if (!client.send(line)) {
				untrack(client, nick, get);
			}
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
 * Whether we may set `channel`'s avatar, as nefarious2 decides it
 * (`can_modify_target`): a member who is half-op and up (op and up where
 * the network has no half-ops), or a member who is a global IRC operator
 * (a local one, +O, is refused).
 */
export function canSetChannelAvatar(client: IrcClient, channel: string): boolean {
	if (!client.isWelcomed || !client.caps.hasCapability("draft/metadata-2")) {
		return false;
	}

	const chan = client.findChannel(channel);
	const me = chan?.state === ChanState.JOINED ? chan.findUser(client.nick) : undefined;

	if (!me) {
		return false;
	}

	if (client.oper.level === "global" || client.oper.level === "admin") {
		return true;
	}

	const mine = me.modes[0];
	const symbols = client.isupport.prefix.symbols;
	const floor = symbols.includes("%") ? symbols.indexOf("%") : symbols.indexOf("@");

	return mine !== undefined && floor !== -1 && client.prefixRank(mine) <= floor;
}

/** The channel was opened: ask for its avatar unless it is known. */
export function onChannelOpened(client: IrcClient, channel: string): void {
	askAvatar(client, channel);
}

/**
 * NICK: the avatar follows the user. A GET in flight stays filed under the
 * nick it named, which is the one its answer names.
 */
export function onAvatarNick(client: IrcClient, from: string, to: string): void {
	renameAvatar(client.uuid, from, to);
	const asked = stateOf(client).asked;

	if (asked.delete(client.casefold(from))) {
		asked.add(client.casefold(to));
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
	stateOf(client).synced.delete(key);
}

/**
 * We were kicked from `channel`: its window stays, and so does its picture,
 * but a change made while we are out never reaches us, so a rejoin asks
 * again (as a reconnect does).
 */
export function onChannelKicked(client: IrcClient, channel: string): void {
	markAvatarStale(client.uuid, channel);
	const key = client.casefold(channel);
	stateOf(client).asked.delete(key);
	stateOf(client).synced.delete(key);
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
	track(client, "*", {kind: "get"});
}

/** The reader switched avatars on or off for this network (Settings → Account). */
export function applyAvatarsEnabled(client: IrcClient, on: boolean): void {
	if (!on) {
		clearAvatars(client.uuid);
		// The answers are gone with the registry: ask again once back on.
		const state = stateOf(client);
		state.asked.clear();
		state.synced.clear();
	}

	if (!client.isWelcomed || !client.caps.hasCapability("draft/metadata-2")) {
		return;
	}

	client.send(`METADATA * ${on ? "SUB" : "UNSUB"} ${AVATAR_KEY}`);

	if (on) {
		// A SUB brings no values. Our own is asked at once; each channel's,
		// and its members', with a SYNC per channel.
		expectOwnAvatar(client);
		client.send(`METADATA * GET ${AVATAR_KEY}`);
		syncAvatarsOfJoinedChannels(client);
	}
}
