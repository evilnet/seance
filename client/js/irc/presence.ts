/**
 * Attention: is a person looking at this client?
 *
 * The server pushes a notification only when nobody is attending the
 * account, and it judges that from each connection's away state and how
 * recently it spoke. "Spoke recently" is the wrong proxy for a phone: say
 * something, switch apps, and the reply goes unpushed for the whole idle
 * window while the frozen tab shows nothing either. The client knows
 * better, and `draft/pre-away` gives it the words: `AWAY *` means "not
 * present for an unspecified reason", per connection, and never overrides
 * a human away message set elsewhere. So a hidden page says `AWAY *`, a
 * page that comes back says `AWAY`, and the server's attention rule (and
 * its away aggregation) does the rest.
 *
 * Two things this must not do: clobber an away the user set with `/away`
 * (that is theirs until `/back`), and mark messages read while nobody is
 * there — `IrcClient.pushMessage` only schedules a MARKREAD for the open
 * channel while attended, and the return of attention marks it then.
 *
 * Presence modes and do not disturb (docs/projects/do-not-disturb.md):
 * each network has a mode (`auto`, `online`, `away`, `dnd`), and do not
 * disturb is in force when the page's global switch, the network's mode or
 * another device's push mute (`remoteDnd`) says so. `syncPresence` is the
 * one place that turns all of that, and attention, into `AWAY *` or `AWAY`
 * (`wantsStar`), reports the snapshot to the store and keeps the push mute
 * in step (pushMute.ts).
 *
 * The global mode (client/js/dnd.ts, `IrcClient.globalMode`) is the default
 * of every network on Same as global; a network's own mode overrides it
 * (`effectiveMode`).
 *
 * The away state is declared before `CAP END` (`registrationAwayLine`,
 * `draft/pre-away`), so a held bouncer session is never counted present
 * while a reload or a reconnect registers. A connection that resumes such
 * a session says `AWAY` once it knows it is present (`armResumeCheck`), and
 * a page that closes leaves its networks' `AWAY *` to the service worker
 * (`leavesAwayToWorker`).
 *
 * Vue-free and DOM-free: foreground.ts translates visibility and focus
 * into `setAttended`, tests call it directly.
 */

import type {IrcClient} from "./client";
import {formatLine} from "./message";
import {trailingLine} from "./wire";
import {forgetUserAway, setUserAway} from "./userAwayStore";
import {readNow} from "./handlers/markread";
import {MUTE_KEY, MUTE_READ_DELAY_MS, syncPushMute} from "./pushMute";
import {PERSISTENCE_CAP} from "./persistence";
import type {SharedNetworkPresence} from "../../../shared/types/network";

/** `draft/pre-away`: away for an unspecified reason. */
export const AWAY_STAR = "*";

/** The cap that lets `AWAY` be sent before registration completes. */
export const PRE_AWAY_CAP = "draft/pre-away";

/**
 * How long a visible-but-unfocused page waits before saying `AWAY *`. A
 * hidden page says it at once (that is the phone case); an alt-tab on a
 * desktop should not flap the state.
 */
export const UNFOCUSED_AWAY_MS = 60_000;

export interface PresenceState {
	/** A person is (probably) looking: page visible and focused. */
	attended: boolean;
	/** `/away` is in force; automatic `AWAY *` keeps its hands off. */
	userAway: boolean;
	/**
	 * The text that `/away` sent (`" "` for a bare one), declared again at
	 * every registration; null while `userAway` is false. Kept across
	 * reloads by userAwayStore.ts.
	 */
	userAwayText: string | null;
	/** This client sent `AWAY *` and has not cleared it. */
	starSent: boolean;
	/** A held session's away state is still to be confirmed (armResumeCheck). */
	resumeUnsure: boolean;
	/** The mute read did not land in time: go on as if no other device were in DND. */
	muteReadTimedOut: boolean;
	/**
	 * This device may have missed a change to the shared state since it was
	 * last in sync on this network (irc/presenceSync.ts), judged as the
	 * connection subscribes: only then does {@link shareUnread} hold it away.
	 */
	syncStale: boolean;
	/** The registration burst closed (handlers/metadata.ts): the hold is over. */
	burstRead: boolean;
	/** The shared state's read did not land in time: {@link shareUnread} gives up. */
	shareReadTimedOut: boolean;
	/** Arms {@link shareReadTimedOut}. */
	shareTimer: ReturnType<typeof setTimeout> | null;
	/** Arms {@link muteReadTimedOut}. */
	resumeTimer: ReturnType<typeof setTimeout> | null;
	/**
	 * Automatic AWAY commands whose replies (RPL_NOWAWAY / RPL_UNAWAY) are
	 * still to come and should not be shown: switching apps is not news.
	 * Replies arrive in send order, so a count is enough; a user's own
	 * `/away` sent after ours is still acknowledged.
	 */
	quietReplies: number;
	/** The last `network:presence` payload dispatched, as JSON. */
	lastReported: string;
}

export function initialPresence(): PresenceState {
	return {
		attended: true,
		userAway: false,
		userAwayText: null,
		starSent: false,
		resumeUnsure: false,
		muteReadTimedOut: false,
		syncStale: false,
		burstRead: false,
		shareReadTimedOut: false,
		shareTimer: null,
		resumeTimer: null,
		quietReplies: 0,
		lastReported: "",
	};
}

/** Registration is over (end of MOTD): before it, only registrationAwayLine speaks. */
function canSend(client: IrcClient): boolean {
	return client.transport.state === "open" && client.isConnected;
}

/** Do not disturb in force on this network. */
export function effectiveDnd(client: IrcClient): boolean {
	return client.globalDnd.active || client.presenceMode === "dnd" || client.remoteDnd;
}

/** The away message without `draft/pre-away`, where `AWAY *` would be a literal "*". */
export const AWAY_PLAIN = "Away";

/**
 * The server knows `AWAY *` (`draft/pre-away`, negotiated or requested in
 * this registration). Elsewhere `AWAY *` is an away message of "*", and the
 * attention-driven away of Auto would tell the whole channel about every
 * tab switch, so Auto then sends nothing and an away is a real message.
 */
function speaksPreAway(client: IrcClient): boolean {
	return client.caps.hasCapability(PRE_AWAY_CAP) || client.caps.isRequesting(PRE_AWAY_CAP);
}

/** The line that marks this connection away for no given reason. */
function awayLine(client: IrcClient): string {
	return speaksPreAway(client)
		? formatLine({command: "AWAY", params: [AWAY_STAR]})
		: trailingLine("AWAY", [AWAY_PLAIN]);
}

/**
 * What the account shares across devices is still to be read on this
 * connection — the mode, the global mode (irc/presenceShare.ts) and the
 * push mute's do not disturb (irc/pushMute.ts) — on a connection that
 * subscribed to them before `CAP END` (so the server sends them at
 * registration), speaks `AWAY *`, and belongs to a device that may have
 * missed a change (out of sync for longer than a reload,
 * irc/presenceSync.ts). Until then the
 * device's own state may be stale — the global Away set on another device
 * while this one was off — and declaring it present showed the account
 * back to everyone for the moments before the read (measured live). So it
 * says away until then, and back once the read says so: at the
 * registration burst (handlers/metadata.ts metadataBatch), else at the
 * 10 s read, never past its fallback. A reload or a quick reconnect holds
 * nothing, so a present device's reload is no away blip.
 */
export function shareUnread(client: IrcClient): boolean {
	const p = client.presence;

	return (
		client.metadataBeforeConnect &&
		p.syncStale &&
		!p.burstRead &&
		!(client.presenceKnown && client.globalKnown && client.muteKnown) &&
		!p.shareReadTimedOut &&
		speaksPreAway(client)
	);
}

/** The registration burst was read (handlers/metadata.ts): the hold is over. */
export function sharedBurstRead(client: IrcClient): void {
	client.presence.burstRead = true;
	syncPresence(client);
}

/** Whether this connection should be away (ignoring `/away`): `AWAY *`, or `AWAY :Away`. */
export function wantsStar(client: IrcClient): boolean {
	const mode = client.effectiveMode;

	return (
		effectiveDnd(client) ||
		shareUnread(client) ||
		mode === "away" ||
		(mode === "auto" && !client.presence.attended && speaksPreAway(client))
	);
}

export function presenceSnapshot(client: IrcClient): SharedNetworkPresence {
	const p = client.presence;

	return {
		mode: client.presenceMode,
		effective: client.effectiveMode,
		dnd: effectiveDnd(client),
		away: p.userAway || p.starSent,
	};
}

/**
 * Bring the server in line with what this client wants: `AWAY *` or `AWAY`,
 * unless the user's own `/away` is in force; then report the presence to the
 * store and keep the push mute in step.
 */
export function syncPresence(client: IrcClient): void {
	const p = client.presence;
	confirmResumed(client);

	if (!p.userAway && canSend(client)) {
		const want = wantsStar(client);

		if (want && !p.starSent) {
			p.starSent = true;
			p.quietReplies++;
			client.send(awayLine(client));
		} else if (!want && p.starSent) {
			p.starSent = false;
			p.quietReplies++;
			client.send(formatLine({command: "AWAY", params: []}));
		}
	}

	reportPresence(client);
}

/** Tell the store the presence if it changed, and keep the push mute in step. */
export function reportPresence(client: IrcClient): void {
	const p = client.presence;
	const snapshot = presenceSnapshot(client);
	const json = JSON.stringify(snapshot);

	if (json !== p.lastReported) {
		p.lastReported = json;
		client.dispatchBus("network:presence", {network: client.uuid, presence: snapshot});
	}

	syncPushMute(client);
}

/**
 * The page's attention changed. Tell the server (`AWAY *` / `AWAY`) unless
 * the user set an away of their own, and when attention returns, mark the
 * open channel read as the user would by looking at it.
 */
export function setAttended(client: IrcClient, attended: boolean): void {
	const p = client.presence;

	if (p.attended === attended) {
		return;
	}

	p.attended = attended;
	syncPresence(client);

	if (attended) {
		const chan = client.activeChannel();

		if (chan && client.isReading(chan)) {
			// Looking at it reads it, as opening it does (IrcClient.open):
			// what counted while nobody looked must not resurface as a badge
			// once the user moves to another channel.
			readNow(client, chan);
		}
	}
}

/**
 * Called for each RPL_NOWAWAY / RPL_UNAWAY: true when it answers one of our
 * automatic AWAY commands and should stay silent.
 */
export function takeQuietAwayReply(client: IrcClient): boolean {
	const p = client.presence;

	if (p.quietReplies > 0) {
		p.quietReplies--;
		return true;
	}

	return false;
}

/**
 * The user ran `/away <text>` (`away` true) or `/back`. State only: the
 * command sends its own line (`/away` its message, `/back` through
 * `sendBack`). The text is remembered for the network across reloads.
 */
export function userAwayChanged(client: IrcClient, away: boolean, text: string | null): void {
	const p = client.presence;
	p.userAway = away;
	p.userAwayText = away ? text ?? " " : null;

	if (away) {
		setUserAway(client.uuid, p.userAwayText as string);
	} else {
		forgetUserAway(client.uuid);
	}

	// Whatever the user said replaces ours.
	p.starSent = false;
	reportPresence(client);
}

/**
 * `/back`: one line, whichever state the client wants — `AWAY *` while a
 * mode, do not disturb or a hidden page calls for it, else `AWAY`. Its reply
 * is the user's acknowledgement, so it is not counted as quiet.
 */
export function sendBack(client: IrcClient): void {
	const p = client.presence;
	const star = wantsStar(client);
	p.starSent = star;
	client.send(star ? awayLine(client) : formatLine({command: "AWAY", params: []}));
	reportPresence(client);
}

/** The connection closed: whatever we told that server is gone with it. */
export function presenceClosed(client: IrcClient): void {
	client.presence.starSent = false;
	client.presence.resumeUnsure = false;
	client.presence.muteReadTimedOut = false;
	client.presence.shareReadTimedOut = false;
	client.presence.syncStale = false;
	client.presence.burstRead = false;
	clearResumeTimer(client);
	clearShareTimer(client);
	client.presence.quietReplies = 0;
	reportPresence(client);
}

/**
 * The away state to declare during registration, sent immediately before
 * `CAP END` in the same flush (caps.ts `finalLines`; the plain path and the
 * SASL path alike). With `draft/pre-away` nefarious2 stores it and applies
 * it at registration, so a held bouncer session that this connection
 * attaches to is never counted present, and nobody sees the user come back
 * and leave again. No 305/306 answers it, so nothing is counted quiet.
 *
 * When the pipelined `CAP END` goes out the cap is only requested, not yet
 * ACKed; the server reads the REQ first, so being requested is enough.
 * Either way {@link presenceRegistered} says it again after registration.
 *
 * Nothing when the client is quitting or its socket is gone: handlers/cap.ts
 * then drops the `CAP END` flush (a required SASL login failed inside
 * `beforeEnd`, which runs first — QUIT, or the socket abandoned for a
 * retry), so the state is only changed for a line that goes out.
 */
export function registrationAwayLine(client: IrcClient): string | null {
	const p = client.presence;
	const caps = client.caps;

	if (client.isQuitting || !client.socketOpen) {
		return null;
	}

	if (!caps.hasCapability(PRE_AWAY_CAP) && !caps.isRequesting(PRE_AWAY_CAP)) {
		return null;
	}

	if (p.userAway) {
		return trailingLine("AWAY", [p.userAwayText ?? " "]);
	}

	if (wantsStar(client)) {
		p.starSent = true;
		return formatLine({command: "AWAY", params: [AWAY_STAR]});
	}

	return null;
}

/**
 * Registration done: say the away state again, whatever was declared
 * before `CAP END` — the user's `/away` here, its 306 kept quiet, and
 * `AWAY *` through syncPresence for a hidden page, a mode or do not
 * disturb. nefarious2 applies a declared state at registration and then
 * resets the connection's own record of it to present (s_user.c, "Clear
 * pre-away state"), and that record is what the session's away aggregation
 * across devices (bounce_compute_effective_away) and the push attention
 * rule read: a device on Away that resumed a session another device had
 * left present showed the account present, and was never pushed while it
 * had spoken recently. The declaration still keeps the attach itself from
 * counting as present; this repeats it where it lasts.
 */
export function presenceRegistered(client: IrcClient): void {
	const p = client.presence;
	p.starSent = false;

	if (p.userAway && canSend(client)) {
		p.quietReplies++;
		client.send(trailingLine("AWAY", [p.userAwayText ?? " "]));
	}

	armResumeCheck(client);
	armShareFallback(client);
	syncPresence(client);
}

/**
 * How long after registration the held session's `AWAY` waits for the mute
 * read before going ahead without it (a `FAIL METADATA` for our GET, a rate
 * limit, a lost reply); the read itself goes out at MUTE_READ_DELAY_MS.
 */
export const MUTE_READ_FALLBACK_MS = MUTE_READ_DELAY_MS + 10_000;

function clearShareTimer(client: IrcClient): void {
	const p = client.presence;

	if (p.shareTimer !== null) {
		clearTimeout(p.shareTimer);
		p.shareTimer = null;
	}
}

/**
 * {@link shareUnread}'s hold lasts until the read, and no longer than
 * {@link MUTE_READ_FALLBACK_MS}: a read refused or lost must not leave the
 * account away for the whole connection.
 */
function armShareFallback(client: IrcClient): void {
	const p = client.presence;
	clearShareTimer(client);
	p.shareReadTimedOut = false;

	if (!shareUnread(client)) {
		return;
	}

	const timer = setTimeout(() => {
		p.shareTimer = null;
		p.shareReadTimedOut = true;
		syncPresence(client);
	}, MUTE_READ_FALLBACK_MS);
	// Never what keeps a process (mocha) alive.
	(timer as {unref?: () => void}).unref?.();
	p.shareTimer = timer;
}

function clearResumeTimer(client: IrcClient): void {
	const p = client.presence;

	if (p.resumeTimer !== null) {
		clearTimeout(p.resumeTimer);
		p.resumeTimer = null;
	}
}

/**
 * Registration done. A bouncer session this connection holds as its
 * primary keeps the away state it was left with — the `AWAY *` the service
 * worker said for a closed page (`leavesAwayToWorker`), or a star a dying
 * socket got out — and a present client that declared nothing would
 * inherit it. A batch cannot tell a resume (nefarious2 sends no restoration
 * batch for a session with no channels, and no replay batch when nothing
 * was missed), so every such connection says `AWAY` once (a fresh session
 * just gets a quiet 305), but only when it knows it is present: after the
 * account's mute list was read (another device's do not disturb,
 * `remoteDnd`, comes from it 10 s after registration), at once where the
 * list cannot be read (no `draft/metadata-2`), or after
 * {@link MUTE_READ_FALLBACK_MS} without a read. Until then a reopen after a
 * worker's star stays away to others. Never on an alias of another
 * device's session, or a connection with no account.
 */
function armResumeCheck(client: IrcClient): void {
	const p = client.presence;
	clearResumeTimer(client);
	p.muteReadTimedOut = false;

	if (client.account === "") {
		return;
	}

	p.resumeUnsure = true;

	if (client.caps.hasCapability("draft/metadata-2")) {
		const timer = setTimeout(() => {
			p.resumeTimer = null;
			p.muteReadTimedOut = true;

			// The read was refused (a rate limit) or its reply lost: ask once
			// more, or this connection would never mute push for this
			// device's DND, nor show another device's.
			if (
				!client.muteKnown &&
				canSend(client) &&
				client.caps.hasCapability("draft/metadata-2")
			) {
				client.send(`METADATA * GET ${MUTE_KEY}`);
			}

			syncPresence(client);
		}, MUTE_READ_FALLBACK_MS);
		// Never what keeps a process (mocha) alive.
		(timer as {unref?: () => void}).unref?.();
		p.resumeTimer = timer;
	}
}

/** The restoration or replay batch closed: look again (armResumeCheck). */
export function presenceResumed(client: IrcClient): void {
	syncPresence(client);
}

/** {@link armResumeCheck}'s `AWAY`, once remote DND is known. */
function confirmResumed(client: IrcClient): void {
	const p = client.presence;

	if (!p.resumeUnsure || !canSend(client)) {
		return;
	}

	if (client.bouncerAlias || client.account === "" || !heldByBouncer(client)) {
		// Another device's live session, where this connection counts
		// present; no account, so no held session to inherit from; or a
		// session the bouncer does not hold.
		p.resumeUnsure = false;
		clearResumeTimer(client);
		return;
	}

	if (client.caps.hasCapability("draft/metadata-2") && !client.muteKnown && !p.muteReadTimedOut) {
		return;
	}

	p.resumeUnsure = false;
	clearResumeTimer(client);

	if (!p.userAway && !p.starSent && !wantsStar(client)) {
		// The server answers 305 even when the session was present: quiet.
		p.quietReplies++;
		client.send(formatLine({command: "AWAY", params: []}));
	}
}

/**
 * The account's session outlives this connection: `PERSISTENCE STATUS`
 * says ON as the effective state, or as the user's setting on a connection
 * attached as another device's alias (`NOTE BOUNCER ALIAS_ATTACHED`): it
 * reads `ON OFF` — the alias is not held, the session is, and closing the
 * last connection leaves it held — while a primary reading `ON OFF` was
 * told not to hold (`BOUNCER SET SESSION … HOLD off`). Before any STATUS
 * line, `draft/persistence` on a SASL login counts, since the client asks
 * for `PERSISTENCE SET ON` itself (client.ts). `OFF OFF` is believed.
 */
function heldByBouncer(client: IrcClient): boolean {
	return (
		client.persistenceHold ||
		(client.bouncerAlias && client.persistenceSetting === "ON") ||
		(client.persistenceSetting === undefined &&
			client.caps.hasCapability(PERSISTENCE_CAP) &&
			client.saslOk)
	);
}

/**
 * The page is unloading (`pagehide`, not into the back/forward cache):
 * whether this network's `AWAY *` should be left to the service worker
 * rather than sent now. A reload looks exactly like a close at that point,
 * and the star sent then makes a present user blink away and back to
 * everyone; the worker waits `AWAY_ON_CLOSE_DELAY_MS`, sends nothing if a
 * window of the app is open again, and otherwise logs in with the stashed
 * credentials and says `AWAY *` to the held session itself.
 *
 * Only a present connection on Auto qualifies (anything else is already
 * away, or never automatic), only while nefarious2's bouncer holds the
 * session ({@link heldByBouncer}; without it the close is a QUIT), and
 * only when the worker can log in for it (`stashed`, webpush.ts).
 */
export function leavesAwayToWorker(client: IrcClient, stashed: (uuid: string) => boolean): boolean {
	const p = client.presence;

	return (
		client.effectiveMode === "auto" &&
		client.isConnected &&
		client.transport.state === "open" &&
		heldByBouncer(client) &&
		!p.starSent &&
		!p.userAway &&
		!effectiveDnd(client) &&
		stashed(client.uuid)
	);
}
