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
 * Vue-free and DOM-free: foreground.ts translates visibility and focus
 * into `setAttended`, tests call it directly.
 */

import type {IrcClient} from "./client";
import {formatLine} from "./message";
import {scheduleMarkRead} from "./handlers/markread";

/** `draft/pre-away`: away for an unspecified reason. */
export const AWAY_STAR = "*";

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
	/** This client sent `AWAY *` and has not cleared it. */
	starSent: boolean;
}

export function initialPresence(): PresenceState {
	return {attended: true, userAway: false, starSent: false};
}

function canSend(client: IrcClient): boolean {
	return client.transport.state === "open" && client.isConnected;
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

	if (attended) {
		if (p.starSent) {
			p.starSent = false;

			if (canSend(client)) {
				client.send(formatLine({command: "AWAY", params: []}));
			}
		}

		const chan = client.activeChannel();

		if (chan) {
			scheduleMarkRead(client, chan);
		}

		return;
	}

	sendStar(client);
}

/** `AWAY *` now, if the state calls for it and nothing else owns away. */
export function sendStar(client: IrcClient): void {
	const p = client.presence;

	if (p.attended || p.userAway || p.starSent || !canSend(client)) {
		return;
	}

	p.starSent = true;
	client.send(formatLine({command: "AWAY", params: [AWAY_STAR]}));
}

/** The user ran `/away` (`away` true) or `/back`. */
export function userAwayChanged(client: IrcClient, away: boolean): void {
	const p = client.presence;
	p.userAway = away;
	// Whatever the user said replaces ours; a later `/back` while hidden
	// stays "present" until the next attention change, as they asked.
	p.starSent = false;
}

/** Registration done: a page that is hidden while it connects says so. */
export function presenceRegistered(client: IrcClient): void {
	client.presence.starSent = false;
	sendStar(client);
}
