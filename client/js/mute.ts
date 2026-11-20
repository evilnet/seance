// Channel mute state, kept on the client and persisted in localStorage.
//
// TheLounge sent `mute:change` to the server which flipped the flag and
// broadcast `mute:changed`. Here the flag lives on the channel object and the
// set of muted targets is remembered locally by network uuid + channel name.

import storage from "./localStorage";
import {mirrorPushPrefs} from "./push-prefs";
import {store} from "./store";
import {ClientChan, ClientNetwork} from "./types";
import {ChanType} from "../../shared/types/chan";

const KEY = "thelounge.muted";

function readMuted(): Set<string> {
	try {
		const raw = storage.get(KEY);
		return new Set(raw ? (JSON.parse(raw) as string[]) : []);
	} catch (e) {
		storage.remove(KEY);
		return new Set();
	}
}

function writeMuted(muted: Set<string>): void {
	storage.set(KEY, JSON.stringify(Array.from(muted)));
	void mirrorPushPrefs({muted: Array.from(muted)});
}

// The push worker cannot read localStorage: it shows a muted conversation's
// push quietly under WebKit from this copy (service-worker.js showMessage).
void mirrorPushPrefs({muted: Array.from(readMuted())});

function mutedKey(networkUuid: string, channelName: string): string {
	return `${networkUuid}/${channelName.toLowerCase()}`;
}

/**
 * Mute or unmute a channel by id. Muting a network's lobby mutes every
 * channel on that network, mirroring the old server behaviour.
 */
export function setMuteStatus(target: number, muted: boolean): void {
	const netChan = store.getters.findChannel(target);

	if (!netChan) {
		return;
	}

	const stored = readMuted();
	const {network, channel} = netChan;

	const apply = (chanName: string, chan: {muted: boolean}) => {
		chan.muted = muted;
		const key = mutedKey(network.uuid, chanName);

		if (muted) {
			stored.add(key);
		} else {
			stored.delete(key);
		}
	};

	if (channel.type === ChanType.LOBBY) {
		for (const chan of network.channels) {
			if (chan.type !== ChanType.SPECIAL) {
				apply(chan.name, chan);
			}
		}
	} else if (channel.type !== ChanType.SPECIAL) {
		apply(channel.name, channel);
	}

	writeMuted(stored);
}

/** Re-apply previously stored mute flags to a network's channels. */
export function applyStoredMuteStatus(network: ClientNetwork): void {
	const stored = readMuted();

	for (const chan of network.channels) {
		applyStoredMute(network.uuid, chan, stored);
	}
}

/**
 * Re-apply the stored mute flag to one conversation that arrived after its
 * network was announced (socket-events/join.ts): a channel joined again, a
 * query an incoming message reopened, a channel a held session restored.
 * The IRC layer hands each one over unmuted.
 */
export function applyStoredMute(networkUuid: string, chan: ClientChan, stored = readMuted()): void {
	if (stored.has(mutedKey(networkUuid, chan.name))) {
		chan.muted = true;
	}
}
