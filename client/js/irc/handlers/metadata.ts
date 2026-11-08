/**
 * METADATA lines and replies (draft/metadata-2). The account's push mute list
 * (`draft/webpush/mute`) and the shared presence values (`seance/presence`,
 * `seance/mode`, irc/presenceShare.ts) are read into the client
 * (irc/pushMute.ts: shared do not disturb). The replies for the keys this client writes itself — the
 * mute list and the webpush payload tier (webpush.ts) — stay silent; a reply
 * for any other key (a user's own `/metadata`) is shown as it always was,
 * through `unhandled`. METADATA lines for other keys stay silent.
 *
 * Only our own entry counts. We write the key private, which the server
 * shows only to the account's own sessions; a public value is someone's
 * own only under their nick, and a subscriber also hears the public keys
 * of users it shares a channel with. So a value is taken when it says
 * `private` or names our nick (our own legacy public value).
 */
import type {Handler} from "../types";
import type {BatchHandler} from "./batch";
import {sharedBurstRead} from "../presence";
import {MUTE_KEY, onMuteValue} from "../pushMute";
import {MODE_KEY, PRESENCE_KEY, onGlobalModeValue, onPresenceValue} from "../presenceShare";
import {CLOSED_KEY, onClosedValue} from "../closedQueries";
// index.ts imports this module too; `unhandled` is only called at run time.
import {unhandled} from "./index";

/** The webpush payload tier (webpush.ts writes it through `webpush:metadata`). */
export const PAYLOAD_KEY = "draft/webpush/payload";

const OWN_KEYS = new Set([MUTE_KEY, PAYLOAD_KEY, PRESENCE_KEY, MODE_KEY, CLOSED_KEY]);

/** The shared keys this client reads (irc/presenceShare.ts). A Map: the key
 * is the server's, and a plain object answers `constructor` or `__proto__`. */
const SHARED = new Map<string, (client: Parameters<Handler>[0], value: string) => void>([
	[PRESENCE_KEY, onPresenceValue],
	[MODE_KEY, onGlobalModeValue],
]);

const ownKey = (key: string | undefined) => key !== undefined && OWN_KEYS.has(key);

/** A key this client reads and writes itself (its FAILs are not news, standard-replies.ts). */
export const isOwnMetadataKey = ownKey;

const ours = (client: Parameters<Handler>[0], target: string, visibility: string) =>
	visibility === "private" || client.isSelf(target);

// METADATA <target> <key> <visibility> [:<value>]
const metadata: Handler = (client, msg) => {
	if (msg.params[1] === MUTE_KEY && ours(client, msg.params[0] ?? "", msg.params[2] ?? "")) {
		onMuteValue(client, msg.params[3] ?? "");
	}

	const onShared = SHARED.get(msg.params[1] ?? "");

	if (onShared && ours(client, msg.params[0] ?? "", msg.params[2] ?? "")) {
		onShared(client, msg.params[3] ?? "");
	}

	// The closed queries (irc/closedQueries.ts): a notification is adopted
	// but is not this connection's read.
	if (msg.params[1] === CLOSED_KEY && ours(client, msg.params[0] ?? "", msg.params[2] ?? "")) {
		onClosedValue(client, msg.params[3] ?? "", false);
	}
};

// 761 <me> <target> <key> <visibility> :<value>: our own GET (`*` expands to our
// nick) — never another user's value an oper asked for, private or not.
const keyValue: Handler = (client, msg) => {
	if (!ownKey(msg.params[2])) {
		unhandled(client, msg);
		return;
	}

	if (msg.params[2] === MUTE_KEY && client.isSelf(msg.params[1] ?? "")) {
		onMuteValue(client, msg.params[4] ?? "");
	}

	// Our own payload tier, still public from before it was written private:
	// a public key is in everyone's WHOIS of us. Same value, private.
	if (
		client.profile.privateMetadata &&
		msg.params[2] === PAYLOAD_KEY &&
		client.isSelf(msg.params[1] ?? "") &&
		msg.params[3] !== "private" &&
		msg.params[4]
	) {
		// Only where the server can say private: elsewhere the reply would
		// never say so, and this would write again on every read.
		client.send(`METADATA * SET ${PAYLOAD_KEY} private :${msg.params[4]}`);
	}

	const onShared = SHARED.get(msg.params[2] ?? "");

	if (onShared && client.isSelf(msg.params[1] ?? "")) {
		onShared(client, msg.params[4] ?? "");
	}

	if (msg.params[2] === CLOSED_KEY && client.isSelf(msg.params[1] ?? "")) {
		onClosedValue(client, msg.params[4] ?? "", true);
	}
};

// 766 <me> <target> <key> :key not set
const keyNotSet: Handler = (client, msg) => {
	if (!ownKey(msg.params[2])) {
		unhandled(client, msg);
		return;
	}

	if (msg.params[2] === MUTE_KEY && client.isSelf(msg.params[1] ?? "")) {
		onMuteValue(client, "");
	}

	const onShared = SHARED.get(msg.params[2] ?? "");

	if (onShared && client.isSelf(msg.params[1] ?? "")) {
		onShared(client, "");
	}

	if (msg.params[2] === CLOSED_KEY && client.isSelf(msg.params[1] ?? "")) {
		onClosedValue(client, "", true);
	}
};

// 770 <me> <key> [<key> ...]: silent when every key it names is ours.
const subOk: Handler = (client, msg) => {
	const keys = msg.params
		.slice(1)
		.flatMap((p) => p.split(" "))
		.filter(Boolean);

	if (keys.length === 0 || !keys.every(ownKey)) {
		unhandled(client, msg);
	}
};

// 762 <me> :end of metadata. It names no key, so it cannot tell whose GET
// it ends; it adds nothing to the 761/766 lines shown before it.
const endOfMetadata: Handler = () => undefined;

/**
 * `BATCH +ref metadata <me>` right after 001: the subscribed keys the
 * account has set, sent to a connection that subscribed before `CAP END`
 * (nefarious2, client.ts finalLines). Its lines go through the handlers
 * above; once it closes, presence.ts's shareUnread hold ends. A key it did
 * not carry is *not* read as unset: the burst can come from a stale copy
 * (measured: one without `draft/webpush/mute` while do not disturb was on),
 * so writing, and an entry gone, wait for the 10 s GET. Any other metadata
 * batch (the GET's answer names no target) is just unwrapped.
 */
export const metadataBatch: BatchHandler = (client, batch) => {
	for (const msg of batch.messages) {
		client.handleMessage(msg);
	}

	if (client.isSelf(batch.params[0] ?? "")) {
		sharedBurstRead(client);
	}
};

export default {
	METADATA: metadata,
	"761": keyValue,
	"762": endOfMetadata,
	"766": keyNotSet,
	"770": subOk,
};
