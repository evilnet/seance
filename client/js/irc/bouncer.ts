/**
 * A bouncer's networks (`soju.im/bouncer-networks`,
 * https://codeberg.org/emersion/soju/src/branch/master/doc/ext/bouncer-networks.md).
 *
 * A soju login without a network (`alice`, not `alice/libera`) is the
 * bouncer's control connection: it has no channels (`CHANTYPES=` empty, and a
 * JOIN is answered `400 … bouncer connection`). There Seance asks for the
 * account's networks (`BOUNCER LISTNETWORKS`) and hands them to the manager
 * (`IrcClientOptions.onBouncerNetworks`), which adds each new one as a network
 * of its own: the same server and login, bound to it with `BOUNCER BIND <id>`
 * before `CAP END` (client.ts `finalLines`). That is how gamja and senpai work
 * too: one connection per bound network. With `-notify`, networks added on
 * the bouncer later (from another client) arrive as single `BOUNCER NETWORK`
 * lines and are added the same way.
 *
 * Kept free of store and DOM imports: it runs under mocha.
 */

import {t, tCount} from "../i18n/core";
import {commaList} from "../helpers/operList";
import type {IrcClient} from "./client";
import type {BatchHandler} from "./handlers/batch";
import {parseTags, type IrcMessage} from "./message";

export const BOUNCER_NETWORKS_CAP = "soju.im/bouncer-networks";
export const BOUNCER_NOTIFY_CAP = "soju.im/bouncer-networks-notify";
export const BOUNCER_NETWORKS_BATCH = "soju.im/bouncer-networks";

/**
 * The most networks of one bouncer account saved here at once, each its own
 * socket: a bouncer that lists hundreds must not open hundreds. A network
 * the user removes frees its place; one left out for want of room is not
 * marked seen, so a later list adds it once there is room.
 */
export const BOUNCER_NETWORKS_MAX = 20;
/** How many offered ids `SavedNetwork.bouncerSeen` remembers (the newest). */
export const BOUNCER_SEEN_MAX = 200;

/**
 * A network id Seance will store and send back in `BOUNCER BIND`. soju's
 * are numbers; anything else that could break the line (a space, a `:`,
 * a control character) is refused rather than sent.
 */
export function isNetworkId(id: unknown): id is string {
	return typeof id === "string" && /^[A-Za-z0-9._~-]{1,64}$/.test(id);
}

/** One of a bouncer's networks, as `BOUNCER NETWORK <id> <attributes>` gives it. */
export interface BouncerNetwork {
	id: string;
	/** The `name` attribute, else the `host`, else the id. */
	name: string;
}

/** The bouncer's control connection: it offers the networks and is bound to none. */
export function isBouncerControl(client: IrcClient): boolean {
	return (
		!client.options.bouncerNetId &&
		client.caps.hasCapability(BOUNCER_NETWORKS_CAP) &&
		!client.isupport.tokens.has("BOUNCER_NETID")
	);
}

/** `BOUNCER BIND <id>`, for the registration flush, when this connection is bound to one. */
export function bindLine(client: IrcClient): string | undefined {
	const id = client.options.bouncerNetId;
	return isNetworkId(id) && client.caps.available.has(BOUNCER_NETWORKS_CAP)
		? `BOUNCER BIND ${id}`
		: undefined;
}

/**
 * Ask the control connection for the account's networks (after 001). With
 * `-notify` on, soju sends the list by itself at registration, so asking
 * again would only cost fake lag.
 */
export function listNetworks(client: IrcClient): void {
	if (!isBouncerControl(client) || client.caps.hasCapability(BOUNCER_NOTIFY_CAP)) {
		return;
	}

	client.background.add({
		key: "bouncer:listnetworks",
		cost: client.fakeLag.cost("BOUNCER LISTNETWORKS"),
		run: () => void client.send("BOUNCER LISTNETWORKS"),
	});
}

/**
 * `BOUNCER NETWORK <id> <attributes>`; undefined for any other `BOUNCER`
 * line, a removal (`*`), or an id that could not be sent back safely.
 */
export function parseNetwork(msg: IrcMessage): BouncerNetwork | undefined {
	const [sub, id, attrs] = msg.params;

	if (sub?.toUpperCase() !== "NETWORK" || !isNetworkId(id) || !attrs || attrs === "*") {
		return undefined;
	}

	const tags = parseTags(attrs);
	return {id, name: tags.get("name") || tags.get("host") || id};
}

/** What to do with a bouncer's list ({@link networksToAdd}). */
export interface NetworksPlan {
	/** Networks to add as networks of their own. */
	add: BouncerNetwork[];
	/** Ids to remember as offered: the ones added and the ones already saved here. */
	seen: string[];
	/** Networks left out because {@link BOUNCER_NETWORKS_MAX} are saved already. */
	over: BouncerNetwork[];
}

/**
 * Which of the listed networks to add: each one not offered before
 * (`seen`) and not already a saved network (`have`), while fewer than
 * {@link BOUNCER_NETWORKS_MAX} of the account's networks are saved
 * (`saved`). Pure, so the manager's rule is tested here.
 */
export function networksToAdd(
	listed: BouncerNetwork[],
	seen: ReadonlySet<string>,
	have: (net: BouncerNetwork) => boolean,
	saved: number
): NetworksPlan {
	const plan: NetworksPlan = {add: [], seen: [], over: []};
	const ids = new Set<string>();

	for (const net of listed) {
		if (seen.has(net.id) || ids.has(net.id)) {
			continue;
		}

		ids.add(net.id);

		if (have(net)) {
			// Saved by hand already: offered, so removing it later is final.
			plan.seen.push(net.id);
		} else if (saved + plan.add.length < BOUNCER_NETWORKS_MAX) {
			plan.add.push(net);
			plan.seen.push(net.id);
		} else {
			plan.over.push(net);
		}
	}

	return plan;
}

/** Give the manager what the bouncer listed, and say in the lobby what was added. */
function offer(client: IrcClient, networks: BouncerNetwork[]): void {
	// A bound network logs in the way the control connection did. soju
	// binds only an account it authenticated with SASL (a PASS login is
	// answered ACCOUNT_REQUIRED), so without SASL nothing is added.
	if (networks.length === 0 || !client.saslOk) {
		return;
	}

	const {added, over} = client.options.onBouncerNetworks?.(networks) ?? {added: [], over: []};

	if (added.length > 0) {
		client.pushMessage(
			client.lobby,
			{text: t("bouncer.networksAdded", {names: commaList(added)})},
			true
		);
	}

	if (over.length > 0) {
		client.pushMessage(
			client.lobby,
			{
				text: tCount("bouncer.networksOver", BOUNCER_NETWORKS_MAX, {
					names: commaList(over),
				}),
			},
			true
		);
	}
}

/** The answer to `BOUNCER LISTNETWORKS`: every network of the account. */
export const bouncerNetworksBatch: BatchHandler = (client, batch) => {
	if (!isBouncerControl(client)) {
		return;
	}

	const networks: BouncerNetwork[] = [];

	for (const line of batch.messages) {
		const net = line.command === "BOUNCER" ? parseNetwork(line) : undefined;

		if (net) {
			networks.push(net);
		} else if (line.command !== "BOUNCER") {
			client.handleMessage(line);
		}
	}

	offer(client, networks);
};

/** A single `BOUNCER NETWORK` (`-notify`: a network added or changed elsewhere). */
export function bouncerLine(client: IrcClient, msg: IrcMessage): void {
	const net = parseNetwork(msg);

	if (net && isBouncerControl(client)) {
		offer(client, [net]);
	}
}
