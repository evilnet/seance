/**
 * What a tap on a favorites-block row does (FavoriteList.vue), and dialling a
 * saved network not on this page, shared with its own sidebar row
 * (DormantNetwork.vue).
 */

import {router, switchToChannel} from "./router";
import socket from "./socket";
import * as saved from "./irc/saved-networks";
import type {SavedNetwork} from "./irc/saved-networks";
import {createNetwork} from "./irc/manager";
import {parseJoinList} from "./irc/client";
import {namesEqual} from "./irc/casemap";
import {accountRequired} from "./branding";
import {isCommandWord, setPendingTarget} from "./helpers/pendingTarget";
import type {FavoriteRow} from "./helpers/sidebarOrder";

/** A login whose password was not kept cannot dial by itself, nor can an
 * entry with no login on a deploy that lets only accounts in. */
export function needsLogin(net: SavedNetwork): boolean {
	return (net.sasl === "plain" && !net.saslPassword) || (accountRequired() && !net.sasl);
}

/**
 * Dial the saved network `uuid`, which has no client on this page: it
 * announces itself and takes its sidebar row's place. One that needs a
 * password opens the connect form, filled from the entry, which asks for it
 * (on a sign-in deploy, the panel). True when it dials.
 */
export function connectSaved(uuid: string): boolean {
	// The entry as stored now: a row's copy is only as new as what it shows,
	// and createNetwork writes what it is given back.
	const entry = saved.get(uuid);

	if (!entry) {
		return false;
	}

	if (needsLogin(entry)) {
		void router.push({name: "Connect", query: {savedLink: entry.uuid}});
		return false;
	}

	createNetwork(entry);
	return true;
}

/** The key the saved network's autojoin list keeps for `name`, if any. */
function savedKey(uuid: string, name: string, row: Extract<FavoriteRow, {kind: "closed"}>) {
	const join = saved.get(uuid)?.join ?? "";
	const mapping = row.network.serverOptions.CASEMAPPING;
	return parseJoinList(join).find((entry) => namesEqual(entry.name, name, mapping))?.key ?? "";
}

/**
 * Open a favorite: its window when it has one. A placeholder joins the
 * channel or opens the private conversation again (the user asked, so its
 * window opens: socket-events/join.ts `shouldOpen`) where the network is
 * connected; shows the network's lobby, where its state is, where it is not;
 * and connects a network not on this page, landing on the favorite once it
 * is there (helpers/pendingTarget.ts; a channel not in its autojoin list is
 * not joined by the connect, and stays a placeholder for a second tap).
 * True when something is on its way that will bring the window: the row
 * shows it is opening.
 */
export function openFavorite(row: FavoriteRow): boolean {
	const {network: uuid, name, type} = row.favorite;

	if (row.kind === "live") {
		switchToChannel(row.channel);
		return false;
	}

	// The name came from storage, which a settings file can fill: it goes on
	// a command line only as one name.
	if (!isCommandWord(name)) {
		return false;
	}

	if (row.kind === "dormant") {
		setPendingTarget(uuid, name);
		// Boot is about to dial it: it lands there when it does.
		return row.dialling || connectSaved(uuid);
	}

	const lobby = row.network.channels[0];

	if (!lobby) {
		return false;
	}

	if (!row.network.status.connected) {
		switchToChannel(lobby);
		return false;
	}

	if (type === "query") {
		socket.emit("input", {target: lobby.id, text: `/query ${name}`});
		return true;
	}

	const key = savedKey(uuid, name, row);
	socket.emit("input", {target: lobby.id, text: key ? `/join ${name} ${key}` : `/join ${name}`});
	return true;
}
