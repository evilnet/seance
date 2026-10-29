// Network / channel ordering, persisted in localStorage.
//
// TheLounge sent `sort:networks` / `sort:channels` to the server which saved
// the order and echoed it back as `sync_sort:*`. Here the client is the only
// party, so the order is applied to the store directly and remembered locally
// so it can be re-applied when networks are (re)created.

import storage from "./localStorage";
import {store} from "./store";
import {ClientNetwork} from "./types";
import {ChanType} from "../../shared/types/chan";
import * as saved from "./irc/saved-networks";
import {parseJoinList} from "./irc/client";

const NETWORKS_KEY = "thelounge.sort.networks";

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = storage.get(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch (e) {
		storage.remove(key);
		return fallback;
	}
}

export function sortNetworks(order: string[]): void {
	store.commit("sortNetworks", (a, b) => order.indexOf(a.uuid) - order.indexOf(b.uuid));
	storage.set(NETWORKS_KEY, JSON.stringify(store.state.networks.map((n) => n.uuid)));
}

export function sortChannels(networkUuid: string, order: number[]): void {
	const network = store.getters.findNetwork(networkUuid);

	if (!network) {
		return;
	}

	network.channels.sort((a, b) => {
		// Always sort lobby to the top regardless of what the caller sent
		// because a lot of code presumes channels[0] is the lobby
		if (a.type === ChanType.LOBBY) {
			return -1;
		} else if (b.type === ChanType.LOBBY) {
			return 1;
		}

		return order.indexOf(a.id) - order.indexOf(b.id);
	});

	// Channel ids are per-session, so remember channel *names* instead
	const names = network.channels.map((c) => c.name);
	saved.setChannelOrder(networkUuid, names);
	reorderJoinList(networkUuid, names);
}

/**
 * The saved network's autojoin list follows the sidebar: the edit form
 * shows the channels in the order they are seen, and a settings restore
 * carries it. Entries not in the sidebar (never joined this session) keep
 * their place at the end; keys are kept.
 */
function reorderJoinList(networkUuid: string, names: string[]): void {
	const net = saved.get(networkUuid);

	if (!net) {
		return;
	}

	const lower = names.map((n) => n.toLowerCase());

	const rank = (name: string) => {
		const i = lower.indexOf(name.toLowerCase());
		return i === -1 ? Infinity : i;
	};

	const entries = parseJoinList(net.join)
		.map((entry, i) => ({entry, i}))
		.sort((a, b) => rank(a.entry.name) - rank(b.entry.name) || a.i - b.i)
		.map(({entry}) => (entry.key ? `${entry.name} ${entry.key}` : entry.name));
	const join = entries.join(",");

	if (join !== net.join) {
		saved.save({...net, join});
	}
}

/**
 * Re-apply a previously stored ordering to the networks currently in the
 * store. `collator` is optional: where given, networks the stored order
 * does not know (joined since the order was saved) sort among themselves
 * by the active locale's collation instead of keeping their arrival order.
 */
export function applyStoredNetworkOrder(collator?: Intl.Collator): void {
	const order = readJson<string[]>(NETWORKS_KEY, []);

	if (order.length === 0) {
		return;
	}

	store.commit("sortNetworks", (a, b) => {
		const ia = order.indexOf(a.uuid);
		const ib = order.indexOf(b.uuid);

		// Unknown networks keep their relative position after known ones —
		// collated by name when the caller passed a collator
		if (ia === -1 && ib === -1) {
			return collator ? collator.compare(a.name, b.name) : 0;
		} else if (ia === -1) {
			return 1;
		} else if (ib === -1) {
			return -1;
		}

		return ia - ib;
	});
}

/**
 * Re-apply a previously stored channel ordering to a network. `collator`
 * is optional: where given, channels the stored order does not know
 * (joined since the order was saved) sort among themselves by the active
 * locale's collation instead of keeping their arrival order.
 */
export function applyStoredChannelOrder(network: ClientNetwork, collator?: Intl.Collator): void {
	const order = saved.channelOrder(network.uuid);

	if (order.length === 0) {
		return;
	}

	network.channels.sort((a, b) => {
		if (a.type === ChanType.LOBBY) {
			return -1;
		} else if (b.type === ChanType.LOBBY) {
			return 1;
		}

		const ia = order.indexOf(a.name);
		const ib = order.indexOf(b.name);

		if (ia === -1 && ib === -1) {
			return collator ? collator.compare(a.name, b.name) : 0;
		} else if (ia === -1) {
			return 1;
		} else if (ib === -1) {
			return -1;
		}

		return ia - ib;
	});
}
