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
import {
	formatLine,
	formatTags,
	MAX_LINE_BYTES,
	parseTags,
	utf8ByteLength,
	type IrcMessage,
} from "./message";
import {canRequest, request} from "./request";

export const BOUNCER_NETWORKS_CAP = "soju.im/bouncer-networks";
export const BOUNCER_NOTIFY_CAP = "soju.im/bouncer-networks-notify";
export const BOUNCER_NETWORKS_BATCH = "soju.im/bouncer-networks";

/**
 * The most networks of one bouncer account saved here at once, each its own
 * socket: a bouncer that lists hundreds must not open hundreds. A network
 * the user removes frees its place; one left out for want of room is not
 * marked seen, so a later list adds it once there is room.
 */
export const BOUNCER_NETWORKS_MAX = 50;
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

/** A network's attributes as the bouncer gave them (`name`, `state`, `host`, `port`, `tls`, …). */
export type BouncerAttrs = Record<string, string>;

/** What one `BOUNCER NETWORK` line changed ({@link takeNetworkLine}). */
export type NetworkChange =
	| {removed: string}
	| {
			network: BouncerNetwork;
			/** The `name` this line gave, for a rename to be followed ({@link followRename}). */
			named?: string;
	  }
	| undefined;

/**
 * Every `BOUNCER NETWORK` line on the control connection goes through here,
 * whichever way it came (the list's batch, a `-notify` line, or a labeled
 * reply to the panel's own request): it keeps the network's attributes in
 * {@link IrcClient.bouncerNetworks} for the bouncer panel, merging a change
 * into what was known (an attribute without a value is one removed), and
 * says what changed. A line naming an id that could not be sent back
 * safely changes nothing.
 */
export function takeNetworkLine(client: IrcClient, msg: IrcMessage): NetworkChange {
	const [sub, id, raw] = msg.params;

	if (sub?.toUpperCase() !== "NETWORK" || !isNetworkId(id) || !raw) {
		return undefined;
	}

	if (raw === "*") {
		client.bouncerNetworks.delete(id);
		return {removed: id};
	}

	const given = parseTags(raw);
	const known = client.bouncerNetworks.get(id);

	// A change for a network we never heard of that does not say what it is
	// (`state=connected` alone) is not a network to add, named by its id.
	if (!known && !given.get("name") && !given.get("host")) {
		return undefined;
	}

	const attrs: BouncerAttrs = {...known};

	for (const [key, value] of given) {
		if (value === "") {
			delete attrs[key];
		} else {
			attrs[key] = value;
		}
	}

	client.bouncerNetworks.set(id, attrs);
	return {
		network: {id, name: attrs.name || attrs.host || id},
		named: given.get("name") || undefined,
	};
}

/**
 * The name a bound entry should take now that the bouncer calls its network
 * `bouncerName`: the new name while the entry still has the bouncer's
 * (`entry.bouncerName`, or no record of it, as on an entry saved before it
 * was kept), undefined when the user renamed it here or nothing changed.
 */
export function followRename(
	entry: {name: string; bouncerName?: string},
	bouncerName: string
): string | undefined {
	if (entry.name === bouncerName) {
		return undefined;
	}

	return entry.bouncerName === undefined || entry.name === entry.bouncerName
		? bouncerName
		: undefined;
}

/** Pass on the names the bouncer gave, so a rename there is followed here. */
function passRenames(client: IrcClient, changes: NetworkChange[]): void {
	for (const change of changes) {
		if (change && "named" in change && change.named) {
			client.options.onBouncerNetworkRenamed?.(change.network.id, change.named);
		}
	}
}

/** Tell the bouncer panel the control connection's networks as they are now. */
export function announceNetworks(client: IrcClient): void {
	client.dispatch("bouncer:networks", {
		network: client.uuid,
		networks: Array.from(client.bouncerNetworks, ([netid, attrs]) => ({netid, attrs})),
		editable: canRequest(client),
	});
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
 * A bouncer panel field's value to send: trimmed, except the upstream
 * server password (`pass`), whose spaces are part of it.
 */
export function panelValue(key: string, typed: string): string {
	return key === "pass" ? typed : typed.trim();
}

/** Where an entry connects and as whom: what makes it one bouncer account. */
export interface BouncerLogin {
	host: string;
	port: number;
	tls: boolean;
	saslAccount?: string;
}

/**
 * Two entries (or an entry and a live connection's options) are the same
 * bouncer account. The manager's bound entries are the ones of the control
 * connection's account; an edit saved while the old connection is still up
 * makes the saved entry another account until the reconnect applies it.
 */
export function sameBouncerAccount(a: BouncerLogin, b: BouncerLogin): boolean {
	return (
		a.host === b.host &&
		a.port === b.port &&
		a.tls === b.tls &&
		(a.saslAccount ?? "") === (b.saslAccount ?? "")
	);
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
	if (networks.length === 0) {
		return;
	}

	if (!client.saslOk) {
		// Said once per connection, so a login that works otherwise is not
		// left wondering where the networks went.
		if (!client.bouncerSaslNoted) {
			client.bouncerSaslNoted = true;
			client.pushMessage(client.lobby, {text: t("bouncer.saslNeeded")}, true);
		}

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
	const listed = new Set<string>();
	const changes: NetworkChange[] = [];

	for (const line of batch.messages) {
		if (line.command !== "BOUNCER") {
			client.handleMessage(line);
			continue;
		}

		const change = takeNetworkLine(client, line);
		changes.push(change);

		if (change && "network" in change) {
			networks.push(change.network);
			listed.add(change.network.id);
		}
	}

	// The whole list: what it leaves out is not on the bouncer any more.
	for (const id of Array.from(client.bouncerNetworks.keys())) {
		if (!listed.has(id)) {
			client.bouncerNetworks.delete(id);
		}
	}

	announceNetworks(client);
	offer(client, networks);
	passRenames(client, changes);
};

/**
 * A single `BOUNCER NETWORK` (`-notify`): a network added or changed
 * elsewhere, or deleted (`*`), which stops the entry bound to it connecting
 * by itself. Its own connection is closed by the bouncer, and the reconnect's
 * refused `BIND` says so there ({@link bindFailed}).
 */
export function bouncerLine(client: IrcClient, msg: IrcMessage): void {
	if (!isBouncerControl(client)) {
		return;
	}

	const change = takeNetworkLine(client, msg);

	if (!change) {
		return;
	}

	announceNetworks(client);

	if ("removed" in change) {
		client.options.onBouncerNetworkRemoved?.(change.removed);
	} else {
		offer(client, [change.network]);
		passRenames(client, [change]);
	}
}

/**
 * `FAIL BOUNCER INVALID_NETID [BIND] <id> :text` naming this connection's own
 * network: it was deleted on the bouncer. The spec puts the subcommand before
 * the id, so the id is looked for anywhere in the context. True when handled.
 */
export function bindFailed(client: IrcClient, msg: IrcMessage): boolean {
	const [command, code, ...rest] = msg.params;
	const own = client.options.bouncerNetId;

	if (
		!own ||
		command?.toUpperCase() !== "BOUNCER" ||
		code?.toUpperCase() !== "INVALID_NETID" ||
		!rest.slice(0, -1).includes(own)
	) {
		return false;
	}

	client.bouncerNetworkGone();
	return true;
}

/** A change the bouncer panel asks of the bouncer. */
export type BouncerSubcommand = "ADDNETWORK" | "CHANGENETWORK" | "DELNETWORK";

/** The bouncer's answer to a {@link bouncerRequest}. */
export interface BouncerReply {
	ok: boolean;
	/** The id the bouncer named (the new network's, for ADDNETWORK). */
	netid?: string;
	/** The bouncer's own words (`FAIL BOUNCER …`), or why nothing was asked. */
	error?: string;
}

/** Room left for the label a request adds (`@label=r123 `). */
const LABEL_ROOM = 24;

/**
 * Ask the bouncer to add, change or delete one of its networks
 * (`BOUNCER ADDNETWORK|CHANGENETWORK|DELNETWORK`), labeled, from the
 * control connection; resolves with its verdict. Only where the connection
 * can send labeled requests ({@link announceNetworks} `editable`): without
 * labeled-response nothing would tie the answer to the question.
 *
 * soju puts the change's own `BOUNCER NETWORK` inside the labeled batch,
 * where nothing else sees it, so those lines go through {@link bouncerLine}
 * here: the panel's list follows, and a network added is offered like one
 * added from another client (the SASL gate, the cap and the seen-list).
 */
export async function bouncerRequest(
	client: IrcClient,
	subcommand: BouncerSubcommand,
	netid: string | undefined,
	attrs: BouncerAttrs = {}
): Promise<BouncerReply> {
	if (!isBouncerControl(client) || !canRequest(client)) {
		return {ok: false, error: t("bouncer.cannotChange")};
	}

	const params: string[] = [subcommand];

	if (subcommand !== "ADDNETWORK") {
		if (!isNetworkId(netid)) {
			return {ok: false, error: t("bouncer.cannotChange")};
		}

		params.push(netid);
	}

	if (subcommand !== "DELNETWORK") {
		params.push(formatTags(attrs));
	}

	const line = formatLine({command: "BOUNCER", params});

	if (utf8ByteLength(line) + LABEL_ROOM > MAX_LINE_BYTES) {
		return {ok: false, error: t("bouncer.tooLong")};
	}

	const unit = await request(client, line);

	for (const reply of unit.lines) {
		if (reply.command === "BOUNCER" && reply.params[0]?.toUpperCase() === "NETWORK") {
			bouncerLine(client, reply);
		}
	}

	for (const reply of unit.lines) {
		if (reply.command === "FAIL") {
			return {ok: false, error: reply.params[reply.params.length - 1]};
		}

		if (reply.command === "BOUNCER" && reply.params[0]?.toUpperCase() === subcommand) {
			return {ok: true, netid: reply.params[1]};
		}
	}

	return {
		ok: false,
		error: unit.outcome === "timeout" ? t("bouncer.timeout") : t("bouncer.noAnswer"),
	};
}
