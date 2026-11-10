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

/**
 * The writing offer's answer, per conversation and language: "yes" (taken
 * once, so a later reply or query line in that language takes it without
 * asking) or "no" ("Not now", or the draft sent without taking it, so that
 * language is not offered here again). Device state, as the declines are.
 */
export type OfferAnswer = "yes" | "no";

const ANSWERS_KEY = "thelounge.translateOfferAnswers";
const answerKey = (networkUuid: string, channelName: string, code: string) =>
	`${channelKey(networkUuid, channelName)}\u0000${code}`;

function loadAnswers(): Record<string, OfferAnswer> {
	try {
		const parsed: unknown = JSON.parse(storage.get(ANSWERS_KEY) || "{}");
		const out: Record<string, OfferAnswer> = {};

		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const [key, value] of Object.entries(parsed)) {
				if (value === "yes" || value === "no") {
					out[key] = value;
				}
			}
		}

		return out;
	} catch {
		return {};
	}
}

const answers = ref<Record<string, OfferAnswer>>(loadAnswers());

function saveAnswers(next: Record<string, OfferAnswer>): void {
	answers.value = next;
	storage.set(ANSWERS_KEY, JSON.stringify(next));
}

/** The answer given to writing in `code` here, if any. Reactive. */
export function offerAnswer(
	networkUuid: string,
	channelName: string,
	code: string
): OfferAnswer | undefined {
	return answers.value[answerKey(networkUuid, channelName, code)];
}

/** Remember the answer to writing in `code` in this conversation. */
export function answerOffer(
	networkUuid: string,
	channelName: string,
	code: string,
	answer: OfferAnswer
): void {
	const key = answerKey(networkUuid, channelName, code);

	if (answers.value[key] !== answer) {
		saveAnswers({...answers.value, [key]: answer});
	}
}
const discovery = declines("thelounge.translateDiscoveryDeclined");

/**
 * Whether writing offers are declined in this conversation (the old
 * "Not now", before each language had its own answer). Reactive.
 */
export function offersDeclined(networkUuid: string, channelName: string): boolean {
	return offers.has(networkUuid, channelName);
}

/**
 * "Reset choices for this conversation" lifts both declines -- the writing
 * offers and the offer to switch translation on -- and the answers given to
 * each language's offer.
 */
export function forgetOfferDecline(networkUuid: string, channelName: string): void {
	offers.forget(networkUuid, channelName);
	discovery.forget(networkUuid, channelName);

	const prefix = `${channelKey(networkUuid, channelName)}\u0000`;
	const kept = Object.fromEntries(
		Object.entries(answers.value).filter(([key]) => !key.startsWith(prefix))
	);

	if (Object.keys(kept).length !== Object.keys(answers.value).length) {
		saveAnswers(kept);
	}
}

/** Whether the offer to switch translation on is declined here. Reactive. */
export function discoveryDeclined(networkUuid: string, channelName: string): boolean {
	return discovery.has(networkUuid, channelName);
}

/** "Not now" to switching translation on, in this conversation, on this device. */
export function declineDiscovery(networkUuid: string, channelName: string): void {
	discovery.add(networkUuid, channelName);
}
