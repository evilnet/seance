/**
 * The sidebar's order, in one place: the favorites block first (favorites.ts),
 * then each network's lobby and the conversations not starred. The sidebar
 * draws it (NetworkList.vue) and the keyboard walks it (keybinds.ts: Alt+↑/↓
 * and the digit shortcuts), so the two cannot disagree.
 *
 * Vue-free and store-free so mocha covers it (test/helpers/sidebarOrder.ts).
 */

import {ChanType} from "../../../shared/types/chan";
import type {Favorite} from "../favorites";
import type {SavedNetwork} from "../irc/saved-networks";
import type {ClientChan, ClientNetwork} from "../types";
import {channelByName} from "./channelByName";
import {casefold} from "../irc/casemap";
import isChannelCollapsed from "./isChannelCollapsed";

/**
 * One row of the favorites block:
 * - `live`: the conversation has a window; the row is its channel row.
 * - `closed`: its network is on this page but the window is gone (closed,
 *   parted away); a tap joins or opens it again.
 * - `dormant`: its network is saved but has no client on this page
 *   (autoconnect off, a password to type, a /quit); a tap connects it.
 *   `dialling` when boot is about to dial it anyway: the row keeps its place
 *   (no block jumping as the networks arrive) and says it is on its way.
 * A favorite whose network is neither live nor saved has no row.
 */
export type FavoriteRow =
	| {kind: "live"; favorite: Favorite; network: ClientNetwork; channel: ClientChan}
	| {kind: "closed"; favorite: Favorite; network: ClientNetwork}
	| {kind: "dormant"; favorite: Favorite; saved: SavedNetwork; dialling: boolean};

/** The conversation a favorite names on `network`, if it has a window there. */
function windowFor(network: ClientNetwork, favorite: Favorite): ClientChan | undefined {
	const chan = channelByName(network, favorite.name);

	// A lobby or a list window that happens to share the name is not it.
	return chan && (chan.type === ChanType.CHANNEL || chan.type === ChanType.QUERY)
		? chan
		: undefined;
}

export function favoriteRows(
	favorites: readonly Favorite[],
	networks: readonly ClientNetwork[],
	saved: readonly Pick<SavedNetwork, "uuid">[],
	dialling: (entry: SavedNetwork) => boolean = () => false
): FavoriteRow[] {
	const rows: FavoriteRow[] = [];

	for (const favorite of favorites) {
		const network = networks.find((n) => n.uuid === favorite.network);

		if (network) {
			const channel = windowFor(network, favorite);
			rows.push(
				channel
					? {kind: "live", favorite, network, channel}
					: {kind: "closed", favorite, network}
			);
			continue;
		}

		const entry = saved.find((n) => n.uuid === favorite.network);

		if (entry) {
			const net = entry as SavedNetwork;
			rows.push({kind: "dormant", favorite, saved: net, dialling: dialling(net)});
		}
	}

	return rows;
}

/** The ids of the windows the favorites block shows: their networks' lists leave them out. */
export function favoriteChannelIds(rows: readonly FavoriteRow[]): Set<number> {
	const ids = new Set<number>();

	for (const row of rows) {
		if (row.kind === "live") {
			ids.add(row.channel.id);
		}
	}

	return ids;
}

/**
 * Names two or more rows share (folded as each row's network folds them):
 * those rows carry their network's name, the one way to tell them apart.
 */
export function clashingNames(rows: readonly FavoriteRow[]): Set<string> {
	const seen = new Map<string, number>();

	for (const row of rows) {
		const key = foldedName(row);
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}

	return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}

/** A row's name for {@link clashingNames}: folded rfc1459, which also folds
 * the ascii mappings' letters, so two networks folding differently still meet. */
export function foldedName(row: FavoriteRow): string {
	return casefold(row.favorite.name, "rfc1459");
}

/**
 * Every window in sidebar order: the favorites that have a window, then each
 * network's lobby and its conversations not among them. What a collapse
 * hides is left out — the favorites when `favoritesCollapsed`, a collapsed
 * network's conversations (its lobby stays) — unless `withCollapsed`: what
 * is drawn, or what is there.
 */
export function sidebarWindows(
	networks: readonly ClientNetwork[],
	rows: readonly FavoriteRow[],
	{withCollapsed = false, favoritesCollapsed = false} = {}
): ClientChan[] {
	const flat: ClientChan[] = [];
	const starred = favoriteChannelIds(rows);

	if (withCollapsed || !favoritesCollapsed) {
		for (const row of rows) {
			if (row.kind === "live") {
				flat.push(row.channel);
			}
		}
	}

	for (const network of networks) {
		for (const channel of network.channels) {
			if (
				!starred.has(channel.id) &&
				(withCollapsed || !isChannelCollapsed(network, channel))
			) {
				flat.push(channel);
			}
		}
	}

	return flat;
}
