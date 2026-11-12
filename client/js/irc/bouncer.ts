/**
 * soju's `soju.im/bouncer-networks` (codeberg.org/emersion/soju
 * doc/ext/bouncer-networks.md), modelled on soju's own weechat script: the
 * saved network that points at soju is the *bouncer connection* — it binds
 * to nothing, its lobby is where BouncerServ talks — and every upstream
 * network soju lists becomes a network of its own here, connected to the
 * same soju with the same login and `BOUNCER BIND <netid>` before `CAP END`
 * (manager.ts `bouncerNetwork` creates, renames and removes them).
 *
 * The bouncer connection also asks for `-notify`, so the list stays live
 * (another client or BouncerServ adding, changing or deleting a network)
 * and soju sends it unasked at registration. A bound connection never
 * lists: it would only list itself and its siblings again.
 *
 * Kept free of store and DOM imports (mocha).
 */

import type {IrcClient} from "./client";
import type {BatchHandler} from "./handlers/batch";
import {formatLine, formatTags, parseTags, type IrcMessage} from "./message";
import {canRequest, request} from "./request";
import type {Handler} from "./types";

export const BOUNCER_CAP = "soju.im/bouncer-networks";
export const BOUNCER_NOTIFY_CAP = "soju.im/bouncer-networks-notify";
/** The batch a whole list comes in (LISTNETWORKS, or -notify's initial one). */
export const BOUNCER_BATCH = "soju.im/bouncer-networks";

/** A soju network's attributes (`name`, `state`, `host`, `port`, `tls`, `nickname`, …). */
export type BouncerAttrs = Record<string, string>;

export interface BouncerNetwork {
	netid: string;
	attrs: BouncerAttrs;
}

/** What `BOUNCER ADDNETWORK|CHANGENETWORK|DELNETWORK` came back with. */
export interface BouncerReply {
	ok: boolean;
	/** The netid the server named (the new one, for ADDNETWORK). */
	netid?: string;
	/** The server's words (`FAIL BOUNCER …`), or why nothing was asked. */
	error?: string;
}

export type BouncerSubcommand = "ADDNETWORK" | "CHANGENETWORK" | "DELNETWORK";

/** The connection binds to one soju network (`options.bouncerNetid`). */
export function isBound(client: IrcClient): boolean {
	return Boolean(client.options.bouncerNetid);
}

/** This is the bouncer connection: soju enabled the cap and we bound to nothing. */
export function isBouncerRoot(client: IrcClient): boolean {
	return (
		client.caps.hasCapability(BOUNCER_CAP) &&
		!isBound(client) &&
		client.isupport.get("BOUNCER_NETID") === undefined
	);
}

/** The caps to ask for besides SEANCE_CAPS: a bound connection only needs the base one. */
export function bouncerCaps(client: IrcClient): string[] {
	return isBound(client) ? [BOUNCER_CAP] : [BOUNCER_CAP, BOUNCER_NOTIFY_CAP];
}

/**
 * `BOUNCER BIND <netid>`, for the flush that ends CAP after a successful
 * login (soju answers ACCOUNT_REQUIRED before one, REGISTRATION_IS_COMPLETED
 * after 001). Undefined when this connection binds to nothing or soju did
 * not take the cap.
 */
export function bindLine(client: IrcClient): string | undefined {
	const netid = client.options.bouncerNetid;

	if (
		!netid ||
		!(client.caps.hasCapability(BOUNCER_CAP) || client.caps.isRequesting(BOUNCER_CAP))
	) {
		return undefined;
	}

	return formatLine({command: "BOUNCER", params: ["BIND", netid]});
}

/** On registration: a bouncer connection without `-notify` asks for the list once. */
export function bouncerRegistered(client: IrcClient): void {
	client.bouncerNetworks.clear();

	if (isBouncerRoot(client) && !client.caps.hasCapability(BOUNCER_NOTIFY_CAP)) {
		client.send("BOUNCER LISTNETWORKS");
	}
}

/**
 * Attributes in message-tag form. A key without a value is a removed
 * attribute in a notification (`""` here, as parseTags gives it).
 */
export function parseAttrs(raw: string): BouncerAttrs {
	return Object.fromEntries(parseTags(raw));
}

/** Attributes for the wire; empty values go as bare keys (cleared). */
export function formatAttrs(attrs: BouncerAttrs): string {
	return formatTags(attrs);
}

function announce(client: IrcClient): void {
	client.dispatch("bouncer:networks", {
		network: client.uuid,
		networks: Array.from(client.bouncerNetworks, ([netid, attrs]) => ({netid, attrs})),
	});
}

/** `BOUNCER NETWORK <netid> <attrs|*>`: the list (or a change to it), on the bouncer connection only. */
function networkLine(client: IrcClient, msg: IrcMessage): void {
	const [, netid, raw] = msg.params;

	if (!netid || raw === undefined || isBound(client)) {
		return;
	}

	if (raw === "*") {
		client.bouncerNetworks.delete(netid);
		client.options.onBouncerNetwork?.(netid, null);
		announce(client);
		return;
	}

	const attrs = {...(client.bouncerNetworks.get(netid) ?? {})};

	for (const [key, value] of Object.entries(parseAttrs(raw))) {
		if (value === "") {
			delete attrs[key];
		} else {
			attrs[key] = value;
		}
	}

	client.bouncerNetworks.set(netid, attrs);
	client.options.onBouncerNetwork?.(netid, attrs);
	announce(client);
}

/** A whole list: each line as it comes, then what is not in it is gone. */
export const bouncerBatch: BatchHandler = (client, batch) => {
	const netids: string[] = [];

	for (const msg of batch.messages) {
		if (msg.command === "BOUNCER" && msg.params[0]?.toUpperCase() === "NETWORK") {
			networkLine(client, msg);
			netids.push(msg.params[1]);
		}
	}

	if (isBound(client)) {
		return;
	}

	for (const netid of Array.from(client.bouncerNetworks.keys())) {
		if (!netids.includes(netid)) {
			client.bouncerNetworks.delete(netid);
		}
	}

	client.options.onBouncerList?.(netids);
	announce(client);
};

const bouncer: Handler = (client, msg) => {
	// The other replies (ADDNETWORK <netid>, …) are labeled and taken by
	// request.ts; one that arrives unlabeled says nothing the list does not.
	if ((msg.params[0] ?? "").toUpperCase() === "NETWORK") {
		networkLine(client, msg);
	}
};

/**
 * `FAIL BOUNCER <code> BIND …` at registration: the network this connection
 * was made for is not there (deleted while we were away) or the login is
 * wrong. Registering unbound would make it a second bouncer connection, so
 * it quits instead. Returns false for any other FAIL BOUNCER, which is shown
 * as usual.
 */
export function bouncerFailed(client: IrcClient, msg: IrcMessage): boolean {
	const [, code = "", subcommand = ""] = msg.params;

	if (subcommand.toUpperCase() !== "BIND" || !isBound(client)) {
		return false;
	}

	const text = msg.params[msg.params.length - 1];
	client.pushMessage(
		client.lobby,
		{text: `The bouncer refused this network (${code}): ${text}`},
		true
	);
	client.disconnect("BOUNCER BIND failed");
	return true;
}

/** Ask soju to add, change or delete a network; resolves with its verdict. */
export async function bouncerRequest(
	client: IrcClient,
	subcommand: BouncerSubcommand,
	netid: string | undefined,
	attrs: BouncerAttrs = {}
): Promise<BouncerReply> {
	if (!canRequest(client)) {
		return {ok: false, error: "Not connected to the bouncer."};
	}

	const params: string[] = [subcommand];

	if (subcommand !== "ADDNETWORK") {
		params.push(netid ?? "");
	}

	if (subcommand !== "DELNETWORK") {
		params.push(formatAttrs(attrs));
	}

	const unit = await request(client, formatLine({command: "BOUNCER", params}));

	// soju puts the change's own `BOUNCER NETWORK` inside the labeled
	// batch, where nothing else sees it.
	for (const line of unit.lines) {
		if (line.command === "BOUNCER" && line.params[0]?.toUpperCase() === "NETWORK") {
			networkLine(client, line);
		}
	}

	for (const line of unit.lines) {
		if (line.command === "FAIL") {
			return {ok: false, error: line.params[line.params.length - 1]};
		}

		if (line.command === "BOUNCER" && line.params[0]?.toUpperCase() === subcommand) {
			return {ok: true, netid: line.params[1]};
		}
	}

	return {
		ok: false,
		error: unit.outcome === "timeout" ? "The bouncer did not answer." : "No answer.",
	};
}

export default {BOUNCER: bouncer};
