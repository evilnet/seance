/**
 * `draft/persistence` — nefarious2's built-in bouncer, from the client's
 * side. While a logged-in user's session is "held", a dropped connection
 * leaves no channel: the next connection with the same account resumes the
 * session and, right behind the MOTD, the server replays the membership it
 * kept as a `BATCH +ref draft/persistence` of JOIN (with the original
 * `@time`/`msgid`), 332/333, MARKREAD and NAMES per channel
 * (`bouncer_session.c` `bounce_send_channel_state`). A client that
 * requested the cap is also told between 005 and the MOTD end whether it is
 * held at all: `:server PERSISTENCE STATUS ON|OFF`.
 *
 * Seance uses this to make a reconnect look like nothing happened:
 *
 * - the replayed JOIN / topic / NAMES update the model without producing
 *   lines (`IrcClient.restoring`, honoured by join.ts and topic.ts) and each
 *   restored JOIN starts the usual paced catch-up (`CHATHISTORY LATEST`, then
 *   `BEFORE` back to the newest line we held; history.ts)
 *   (catchup.ts), which is what actually fills the gap — unless the server
 *   is filling it itself, see {@link serverReplayCovers};
 * - after `STATUS ON` (or a setting of ON not in force, `ON OFF`: an alias
 *   of another device's session reads so, and only learns it is one from
 *   the NOTE after the MOTD) the autojoin `JOIN` waits for that batch (or
 *   {@link RESTORE_WAIT_MS}, whichever is first) and then covers only the
 *   channels the server did not restore. JOINing a channel the server is
 *   restoring anyway is ignored at best and, while another client of the
 *   account is attached, answered with a second topic + NAMES burst.
 *
 * On a server that offers the `attach-cursor` token the whole per-channel
 * dance is replaced by one line: `PERSISTENCE ATTACH default <msgid>` in the
 * flush that carries `CAP END` hands the server the newest msgid we hold, and
 * it replays the gap itself (see {@link attachCursorLine} and
 * {@link bouncerReplayBatch}).
 *
 * Without the cap (another ircd, hold off, not logged in) nothing here runs
 * and a re-JOIN is quiet by `Channel.rejoining` alone.
 */

import type {CapNegotiator} from "./caps";
import type {Channel, MsgRef} from "./channel";
import type {IrcClient} from "./client";
import type {BatchHandler, OpenBatch} from "./handlers/batch";
import {formatLine, IrcMessage, utf8ByteLength} from "./message";
import {presenceResumed} from "./presence";

/** The persistence cap, and the profile every account has implicitly. */
export const PERSISTENCE_CAP = "draft/persistence";
export const PERSISTENCE_PROFILE = "default";
/** CAP 302 token that says `PERSISTENCE ATTACH` takes a catch-up cursor. */
export const ATTACH_CURSOR_TOKEN = "attach-cursor";
/** nefarious2 stores the cursor in `con_attach_cursor[64]`, so 63 bytes fit. */
export const MAX_CURSOR_BYTES = 63;
/** Outer batch type wrapping the server-driven catch-up (`ircd/replay.c`). */
export const BOUNCER_REPLAY_BATCH = "evilnet.github.io/bouncer-replay";
/** The NOTICE `replay_send_summary` closes that replay with. */
const REPLAY_SUMMARY = /^Session resumed\. (?:Replayed \d+ message|You are in \d+ channel)/;

/** How long after the MOTD end a held session's restoration is waited for. */
export const RESTORE_WAIT_MS = 2000;
/** …and how long after the last sign of one (an unbatched burst arriving line by line). */
export const RESTORE_QUIET_MS = 750;
/** Hard ceiling: the autojoin is never held longer than this. */
export const RESTORE_MAX_WAIT_MS = 8000;

interface RestoreState {
	timer: ReturnType<typeof setTimeout> | null;
	/** No extension past this point, whatever keeps arriving. */
	deadline: number;
}

const states = new WeakMap<IrcClient, RestoreState>();

function stateOf(client: IrcClient): RestoreState {
	let state = states.get(client);

	if (!state) {
		state = {timer: null, deadline: 0};
		states.set(client, state);
	}

	return state;
}

/** True while the autojoin is held back for a restoration batch (tests). */
export function awaitingRestoration(client: IrcClient): boolean {
	return stateOf(client).timer !== null;
}

/**
 * True while the connection is still settling into its session: from the end
 * of registration until RESTORE_MAX_WAIT_MS later, whether or not the
 * autojoin is still waiting. What the bouncer says in that window is setup
 * chatter, not news for the user.
 */
export function inRestorationWindow(client: IrcClient): boolean {
	return Date.now() < stateOf(client).deadline;
}

/**
 * Registration completed: open the settling window. Every connection gets
 * one, not only the ones we know are held — the unsolicited `PERSISTENCE
 * STATUS` is not sent on every build's alias-attach path, and without it the
 * routine reattach chatter (`NOTE BOUNCER ALIAS_ATTACHED`, the replay
 * summary) would be reported on every switch back to the app.
 */
export function beginSettling(client: IrcClient): void {
	stateOf(client).deadline = Date.now() + RESTORE_MAX_WAIT_MS;
}

/**
 * Registration completed and a session is being restored (`PERSISTENCE
 * STATUS ON`, or a cursor the server took): hold the autojoin until the
 * server's restoration has been applied, or until `wait` (RESTORE_WAIT_MS)
 * passes without a sign of one (nothing was held after all).
 */
export function awaitRestoration(client: IrcClient, wait = RESTORE_WAIT_MS): void {
	const state = stateOf(client);

	if (state.timer !== null) {
		return;
	}

	beginSettling(client);
	arm(client, state, wait);
}

/**
 * A sign that the server is restoring our session right now: one of its
 * JOINs, or a bouncer NOTE. The batch is delivered as a unit, but an
 * unbatched burst (no `batch` cap, or a second burst after an alias attach)
 * arrives line by line, so the wait is extended to a quiet period instead —
 * JOINing a channel the server is about to give back is what makes it
 * answer with a second topic + NAMES burst.
 */
export function noteRestorationActivity(client: IrcClient): void {
	const state = stateOf(client);

	if (state.timer === null) {
		return; // not waiting: a live join, or the autojoin already went out
	}

	arm(client, state, RESTORE_QUIET_MS);
}

function arm(client: IrcClient, state: RestoreState, delay: number): void {
	if (state.timer !== null) {
		clearTimeout(state.timer);
	}

	const wait = Math.max(0, Math.min(delay, state.deadline - Date.now()));
	state.timer = setTimeout(() => {
		state.timer = null;
		client.restorationSettled();
	}, wait);
}

/** Transport closed: a pending autojoin dies with the connection. */
export function cancelRestoration(client: IrcClient): void {
	const state = stateOf(client);
	state.deadline = 0;
	clearWait(state);
}

/** Stop waiting, but stay in the settling window (see {@link inRestorationWindow}). */
function clearWait(state: RestoreState): void {
	if (state.timer !== null) {
		clearTimeout(state.timer);
		state.timer = null;
	}
}

/**
 * The `draft/persistence` batch: run its lines through the normal handlers
 * in restoring mode (state only, no lines), then JOIN whatever the server
 * did not give back — if the autojoin was waiting for this.
 */
export const persistenceBatch: BatchHandler = (client, batch) => {
	const state = stateOf(client);
	const waiting = state.timer !== null;
	clearWait(state);
	client.restoring = true;

	try {
		for (const msg of batch.messages) {
			client.handleMessage(msg);
		}
	} finally {
		client.restoring = false;
	}

	if (waiting) {
		client.restorationSettled();
	}

	presenceResumed(client);
};

// ------------------------------------------------------- the ATTACH cursor

/**
 * True when the server takes a catch-up cursor on `PERSISTENCE ATTACH`
 * (`draft/persistence=attach,detach,list,attach-cursor`, `ircd.c`). The
 * value is a comma-separated token list and unknown tokens are expected, so
 * only the exact token counts.
 */
export function supportsAttachCursor(caps: CapNegotiator): boolean {
	const value = caps.value(PERSISTENCE_CAP);

	if (value === undefined) {
		return false;
	}

	return value.split(",").some((token) => token.trim() === ATTACH_CURSOR_TOKEN);
}

/**
 * The `PERSISTENCE ATTACH <profile> <msgid>` line to send in the flush that
 * carries `CAP END`, or undefined when there is nothing to offer.
 *
 * The window is exactly "SASL succeeded → `CAP END`": the server refuses the
 * command once the client is registered (`IsUser`) and without an account
 * (`FAIL PERSISTENCE ACCOUNT_REQUIRED`), so it is never sent on the
 * no-SASL path. The msgid must fit `con_attach_cursor[64]`.
 */
export function attachCursorLine(client: IrcClient): string | undefined {
	const cursor = client.cursor;

	if (!cursor || !supportsAttachCursor(client.caps)) {
		return undefined;
	}

	if (utf8ByteLength(cursor.msgid) > MAX_CURSOR_BYTES) {
		return undefined; // the server would answer FAIL … "Cursor msgid too long"
	}

	return formatLine({
		command: "PERSISTENCE",
		params: ["ATTACH", PERSISTENCE_PROFILE, cursor.msgid],
	});
}

/**
 * `PERSISTENCE SET ON`: the client-side opt-in that creates the server's
 * bouncer session for this account and turns its hold on. Without it the
 * session never exists — the hold metadata defaults and the advertised
 * `PERSISTENCE STATUS` notwithstanding — and the server has nothing to
 * push to (docs/projects/push-subscription.md). Idempotent: the server
 * answers with the ack + STATUS, and keeps any session we already own.
 */
export function persistenceEnableLine(): string {
	return formatLine({
		command: "PERSISTENCE",
		params: ["SET", "ON"],
	});
}

/**
 * `FAIL PERSISTENCE <code> [<context>…] :<text>` about our cursor. Both
 * outcomes are silent: a refused ATTACH just means the gap is filled the old
 * way (catchup.ts), and `CURSOR_UNKNOWN` is not a failure at all — the
 * server replays from its own derived point and tells us so. Returns true
 * when standard-replies.ts must not show the line.
 */
export function persistenceFailed(client: IrcClient, msg: IrcMessage): boolean {
	// `FAIL PERSISTENCE <code> [<context>…] :<description>`.
	const code = (msg.params[1] ?? "").toUpperCase();
	const context = (msg.params[2] ?? "").toUpperCase();

	if (code === "CURSOR_UNKNOWN") {
		// The msgid aged out of the server's index; the replay still happens.
		// eslint-disable-next-line no-console
		console.debug(`[irc] attach cursor unknown to the server: ${msg.params[2] ?? ""}`);
		return true;
	}

	if (context === "ATTACH" && client.attachCursor !== undefined) {
		client.attachCursor = undefined;
		client.serverReplay = false;
		// eslint-disable-next-line no-console
		console.debug(`[irc] PERSISTENCE ATTACH refused (${code}); catching up ourselves`);
		return true;
	}

	return false;
}

/** True when `batch` is, or is nested in, the server's bouncer-replay wrapper. */
export function inBouncerReplay(batch: OpenBatch): boolean {
	for (let b: OpenBatch | undefined = batch; b; b = b.parent) {
		if (b.type.toLowerCase() === BOUNCER_REPLAY_BATCH) {
			return true;
		}
	}

	return false;
}

/**
 * True while the server is running the catch-up our cursor asked for. Used
 * for a replay that arrives without the outer batch (an older build, or the
 * `batch` cap turned off), where nothing else identifies it.
 */
export function inServerCatchup(client: IrcClient): boolean {
	return client.serverReplay && inRestorationWindow(client);
}

/**
 * The outer `evilnet.github.io/bouncer-replay` batch closed. Its inner
 * `chathistory` batches have their own handler and were delivered when they
 * closed (handlers/batch.ts), so normally there is nothing left in the
 * wrapper; anything the server did put there directly is handled normally.
 * The replay is also a sign that the session is still being restored.
 */
export const bouncerReplayBatch: BatchHandler = (client, batch) => {
	noteRestorationActivity(client);

	for (const msg of batch.messages) {
		client.handleMessage(msg);
	}

	presenceResumed(client);
};

/**
 * The `Session resumed…` NOTICE that closes a server-driven replay
 * (`replay.c` `replay_send_summary`, sent just after the outer batch). Inside
 * the settling window it is setup chatter like `NOTE BOUNCER ALIAS_ATTACHED`
 * and is hidden; the same text later is shown as any other server notice.
 */
export function isRoutineReplayNotice(client: IrcClient, msg: IrcMessage): boolean {
	return (
		msg.source?.user === undefined &&
		REPLAY_SUMMARY.test(msg.params[1] ?? "") &&
		inRestorationWindow(client)
	);
}

/**
 * True when the server's cursor replay already covers this JOIN's gap, so
 * the per-channel catch-up walk (catchup.ts) would only ask for what
 * is already on its way. That is the point of the cursor: one server-driven
 * batch instead of `TARGETS` + N × `CHATHISTORY`.
 *
 * Only for the server's own restoration JOINs (inside the `draft/persistence`
 * batch, or while the autojoin is still held for an unbatched burst) and only
 * for a channel we already hold messages for. A channel the autojoin had to
 * JOIN itself was not in the session when the replay ran, and a channel we
 * have nothing for (a fresh page load) still needs its `CHATHISTORY LATEST`
 * fill — the replay only carries the gap since the cursor, which can be
 * empty.
 */
export function serverReplayCovers(
	client: IrcClient,
	chan: Channel,
	before: MsgRef | undefined
): boolean {
	return (
		client.serverReplay &&
		(client.restoring || awaitingRestoration(client)) &&
		chan.historyRequested &&
		before !== undefined
	);
}
