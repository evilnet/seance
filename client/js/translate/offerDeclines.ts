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
 * asking) or "no" ("Not now", so that language is not offered here again).
 * Device state, as the declines are. Only a tap answers: a draft sent past
 * the offer is `ignoreOffer`.
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

/**
 * How many more replies in a language an offer sent past unanswered waits
 * before it is made again. Sending past is "not this time", never a no: it
 * may be a draft typed before the offer was noticed. Kept in memory only,
 * so the next session offers again whatever the count.
 */
export const OFFER_IGNORE_REPLIES = 3;

const ignored = ref<Map<string, number>>(new Map());

/** The offer for `code` here was sent past unanswered: wait before making it again. */
export function ignoreOffer(networkUuid: string, channelName: string, code: string): void {
	ignored.value = new Map(ignored.value).set(
		answerKey(networkUuid, channelName, code),
		OFFER_IGNORE_REPLIES
	);
}

/** Whether the offer for `code` here is waiting after being sent past. Reactive. */
export function offerIgnored(networkUuid: string, channelName: string, code: string): boolean {
	return (ignored.value.get(answerKey(networkUuid, channelName, code)) ?? 0) > 0;
}

/** A reply in `code` went out while its offer was waiting: one fewer to wait. */
export function noteReplyIn(networkUuid: string, channelName: string, code: string): void {
	const key = answerKey(networkUuid, channelName, code);
	const left = ignored.value.get(key) ?? 0;

	if (left > 0) {
		const next = new Map(ignored.value);

		if (left === 1) {
			next.delete(key);
		} else {
			next.set(key, left - 1);
		}

		ignored.value = next;
	}
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

	if ([...ignored.value.keys()].some((key) => key.startsWith(prefix))) {
		ignored.value = new Map([...ignored.value].filter(([key]) => !key.startsWith(prefix)));
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
