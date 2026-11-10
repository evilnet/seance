// Where the user said "Not now" to an offer, per conversation, on this device
// only (spec § Existing users: offer declines are device state, not part of
// the settings backup). Two of them, each its own key:
//
// - the composer's writing offers (offer.ts);
// - the offer to switch translation on, made in place while it is off
//   (discover.ts).
//
// The channel write card keeps its own decline (`noSuggest`).

import {ref} from "vue";
import storage from "../localStorage";
import {channelKey} from "./channelStore";

interface Declines {
	has: (networkUuid: string, channelName: string) => boolean;
	add: (networkUuid: string, channelName: string) => void;
	forget: (networkUuid: string, channelName: string) => void;
}

function declines(storageKey: string): Declines {
	const load = (): Set<string> => {
		try {
			const parsed: unknown = JSON.parse(storage.get(storageKey) || "[]");

			return new Set(
				Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : []
			);
		} catch {
			return new Set();
		}
	};

	const declined = ref<Set<string>>(load());
	const save = (next: Set<string>) => {
		declined.value = next;
		storage.set(storageKey, JSON.stringify([...next]));
	};

	return {
		has: (networkUuid, channelName) => declined.value.has(channelKey(networkUuid, channelName)),
		add: (networkUuid, channelName) =>
			save(new Set(declined.value).add(channelKey(networkUuid, channelName))),
		forget(networkUuid, channelName) {
			const key = channelKey(networkUuid, channelName);

			if (declined.value.has(key)) {
				const next = new Set(declined.value);

				next.delete(key);
				save(next);
			}
		},
	};
}

const offers = declines("thelounge.translateOffersDeclined");
const discovery = declines("thelounge.translateDiscoveryDeclined");

/** Whether writing offers are declined in this conversation. Reactive. */
export function offersDeclined(networkUuid: string, channelName: string): boolean {
	return offers.has(networkUuid, channelName);
}

/** "Not now": no more writing offers in this conversation, on this device. */
export function declineOffers(networkUuid: string, channelName: string): void {
	offers.add(networkUuid, channelName);
}

/**
 * "Reset choices for this conversation" lifts both declines: the writing
 * offers and the offer to switch translation on.
 */
export function forgetOfferDecline(networkUuid: string, channelName: string): void {
	offers.forget(networkUuid, channelName);
	discovery.forget(networkUuid, channelName);
}

/** Whether the offer to switch translation on is declined here. Reactive. */
export function discoveryDeclined(networkUuid: string, channelName: string): boolean {
	return discovery.has(networkUuid, channelName);
}

/** "Not now" to switching translation on, in this conversation, on this device. */
export function declineDiscovery(networkUuid: string, channelName: string): void {
	discovery.add(networkUuid, channelName);
}
