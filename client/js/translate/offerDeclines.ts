// Where the user said "Not now" to the composer's writing offers
// (offer.ts): per conversation, on this device only (spec § Existing
// users: offer declines are device state, not part of the settings
// backup). The channel write card keeps its own decline (`noSuggest`).

import {ref} from "vue";
import storage from "../localStorage";
import {channelKey} from "./channelStore";

const KEY = "thelounge.translateOffersDeclined";

function load(): Set<string> {
	try {
		const parsed: unknown = JSON.parse(storage.get(KEY) || "[]");

		return new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : []);
	} catch {
		return new Set();
	}
}

const declined = ref<Set<string>>(load());

function save(next: Set<string>): void {
	declined.value = next;
	storage.set(KEY, JSON.stringify([...next]));
}

/** Whether offers are declined in this conversation. Reactive. */
export function offersDeclined(networkUuid: string, channelName: string): boolean {
	return declined.value.has(channelKey(networkUuid, channelName));
}

/** "Not now": no more writing offers in this conversation, on this device. */
export function declineOffers(networkUuid: string, channelName: string): void {
	save(new Set(declined.value).add(channelKey(networkUuid, channelName)));
}

/** "Reset choices for this conversation" lifts the decline too. */
export function forgetOfferDecline(networkUuid: string, channelName: string): void {
	const key = channelKey(networkUuid, channelName);

	if (declined.value.has(key)) {
		const next = new Set(declined.value);

		next.delete(key);
		save(next);
	}
}
