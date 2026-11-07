/**
 * Shared presence (docs/projects/shared-presence-modes.md): each network's
 * mode and the device-wide global away switch are the same on every device
 * of the account. They live in the account's private metadata as
 * `seance/presence` = `<mode> <changedAt>` (a network's own mode, `global`
 * included) and `seance/mode` = `<online|auto|away> <changedAt>` (the
 * global mode) (Unix ms of the user's choice, on the device that
 * made it), and the most recent choice wins — an equal time goes to the
 * later word, so every device picks the same one.
 *
 * Read in the login read with the push mute (client.ts scheduleMuteRead)
 * and live through the subscription. One rule for both keys: adopt the
 * server's value when it is newer than the device's choice, write the
 * device's when it is newer than the server's last value (a choice made
 * here, online or offline, or a newer value an older late write replaced),
 * and otherwise do nothing. A key is written only after this connection's
 * read of it answered.
 *
 * Vue-free and DOM-free; bus.ts saves an adopted mode
 * (`network:presence-shared`), client/js/dnd.ts an adopted switch
 * (`mode:shared`).
 */

import type {IrcClient} from "./client";
import {syncPresence} from "./presence";
import {
	GLOBAL_MODES,
	NETWORK_MODES,
	type GlobalMode,
	type GlobalModeState,
	type NetworkMode,
} from "../helpers/dnd";

export const PRESENCE_KEY = "seance/presence";
export const MODE_KEY = "seance/mode";

export interface Stamped {
	value: string;
	/** Unix ms of the user's choice. */
	at: number;
	/**
	 * A value we cannot read (a later client's format, spec § 3): not ours
	 * to answer. `at` is then the device's choice when it was read; only a
	 * choice made after it is written over it.
	 */
	opaque?: true;
}

/** A value read: parsed, absent (null), or opaque against the device's `mine`. */
function readValue(text: string, words: readonly string[], mine: Stamped | null): Stamped | null {
	const parsed = parseStamped(text, words);

	if (parsed || text === "") {
		return parsed;
	}

	return {value: "", at: mine?.at ?? 0, opaque: true};
}

/** `<word> <ms>` with a word from `words`; anything else is null. */
export function parseStamped(text: string, words: readonly string[]): Stamped | null {
	const m = /^([a-z]+) ([1-9]\d{0,15})$/.exec(text);

	if (!m || !words.includes(m[1])) {
		return null;
	}

	const at = Number(m[2]);
	return Number.isSafeInteger(at) ? {value: m[1], at} : null;
}

export function formatStamped(s: Stamped): string {
	return `${s.value} ${s.at}`;
}

/** Whether `a` is a strictly more recent choice than `b`. */
export function newer(a: Stamped, b: Stamped): boolean {
	return a.at !== b.at ? a.at > b.at : a.value > b.value;
}

function canShare(client: IrcClient): boolean {
	return (
		client.isWelcomed &&
		client.transport.state === "open" &&
		client.caps.hasCapability("draft/metadata-2") &&
		client.account !== ""
	);
}

function localMode(client: IrcClient): Stamped | null {
	return client.presenceAt === undefined
		? null
		: {value: client.presenceMode, at: client.presenceAt};
}

function localGlobal(client: IrcClient): Stamped | null {
	const g = client.globalMode;
	return g.at === null ? null : {value: g.value, at: g.at};
}

/** Write `mine` when it is newer than what the server holds; remember it as held. */
function writeIfNewer(
	client: IrcClient,
	key: string,
	known: boolean,
	server: Stamped | null,
	mine: Stamped | null
): Stamped | null {
	if (
		!known ||
		!mine ||
		!canShare(client) ||
		(server && (server.opaque ? mine.at <= server.at : !newer(mine, server)))
	) {
		return server;
	}

	const line = client.metadataSetLine(key, formatStamped(mine));

	if (line) {
		client.send(line);
	}
	return mine;
}

/** Write whatever this device knows newer than its server, for both keys. */
export function syncShared(client: IrcClient): void {
	client.presenceServer = writeIfNewer(
		client,
		PRESENCE_KEY,
		client.presenceKnown,
		client.presenceServer,
		localMode(client)
	);
	client.globalServer = writeIfNewer(
		client,
		MODE_KEY,
		client.globalKnown,
		client.globalServer,
		localGlobal(client)
	);
}

/** A `seance/presence` value read (761, 766 as "", or the subscription's line). */
export function onPresenceValue(client: IrcClient, value: string): void {
	const mine = localMode(client);
	const server = readValue(value, NETWORK_MODES, mine);
	client.presenceKnown = true;
	client.presenceServer = server;

	if (server && !server.opaque && (!mine || newer(server, mine))) {
		client.setPresenceMode(server.value as NetworkMode, server.at);
		client.dispatchBus("network:presence-shared", {
			network: client.uuid,
			mode: server.value as NetworkMode,
			at: server.at,
		});
		return;
	}

	syncShared(client);
	// The read may end presence.ts's shareUnread hold.
	syncPresence(client);
}

/** A `seance/mode` value read: adopt it here (the page fans it out) or write ours. */
export function onGlobalModeValue(client: IrcClient, value: string): void {
	const mine = localGlobal(client);
	const server = readValue(value, GLOBAL_MODES, mine);
	client.globalKnown = true;
	client.globalServer = server;

	if (server && !server.opaque && (!mine || newer(server, mine))) {
		const mode: GlobalModeState = {value: server.value as GlobalMode, at: server.at};
		client.setGlobalMode(mode);
		client.dispatchBus("mode:shared", {network: client.uuid, mode: mode.value, at: server.at});
		return;
	}

	syncShared(client);
	// The read may end presence.ts's shareUnread hold.
	syncPresence(client);
}
