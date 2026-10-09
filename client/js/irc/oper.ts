/**
 * Being an IRC operator on one network: the level (from our own user
 * modes), the privileges (PRIVS), the server notice mask (008) and the
 * server features the oper tools need to know (GET). Announced to the UI as
 * `oper:state` (bus-contract §1.11); docs/projects/oper-tools.md.
 *
 * The mode is the signal, not 381. On AfterNET opers are granted by
 * services on SASL login, so there may be no OPER and no 381, and a bouncer
 * resume reapplies oper silently. Whoever sets `+o`/`+O` on us, the moment
 * it lands the tools ask what they need: PRIVS, the snomask (when +s), and
 * the profile's features; then the snomask the oper chose last time is put
 * back. A network that was opered when the last connection ended asks for
 * its modes on registration, since a resumed session may not repeat them.
 *
 * Kept free of store/DOM imports (mocha).
 */

import type {OperLevel, SharedOperState} from "../../../shared/types/oper";
import type {IrcClient} from "./client";
import type {IrcMessage} from "./message";
import {getOperPrefs, setSnomaskPref, setWasOper} from "./operprefs";
import {canRequest, request} from "./request";

export interface OperState {
	umodes: Set<string>;
	level: OperLevel;
	privs: string[];
	privsKnown: boolean;
	snomask?: number;
	features: Record<string, string>;
	/** The follow-up queries for this oper-up have gone out. */
	queried: boolean;
}

export function initialOper(): OperState {
	return {
		umodes: new Set(),
		level: "none",
		privs: [],
		privsKnown: false,
		features: {},
		queried: false,
	};
}

/** The level our user modes amount to. */
export function levelOf(umodes: Set<string>): OperLevel {
	if (umodes.has("k")) {
		return "service";
	}

	if (umodes.has("o")) {
		return umodes.has("a") ? "admin" : "global";
	}

	if (umodes.has("O")) {
		return "local";
	}

	return "none";
}

export function isOpered(client: IrcClient): boolean {
	return client.oper.level !== "none" && client.oper.level !== "service";
}

/** The snapshot the UI is given. */
export function operSnapshot(client: IrcClient): SharedOperState {
	const oper = client.oper;

	return {
		level: oper.level,
		privs: [...oper.privs],
		privsKnown: oper.privsKnown,
		...(oper.snomask !== undefined ? {snomask: oper.snomask} : {}),
		umodes: Array.from(oper.umodes).sort().join(""),
		profile: client.profile.id,
		features: {...oper.features},
	};
}

export function announceOper(client: IrcClient): void {
	client.dispatch("oper:state", {network: client.uuid, state: operSnapshot(client)});
}

/** Apply `+owsg-x` style changes to a set of mode letters. */
export function applyModeString(umodes: Set<string>, changes: string): void {
	let add = true;

	for (const ch of changes) {
		if (ch === "+" || ch === "-") {
			add = ch === "+";
		} else if (add) {
			umodes.add(ch);
		} else {
			umodes.delete(ch);
		}
	}
}

/** Our own MODE line (`:me MODE me +owsg`). */
export function noteUserModes(client: IrcClient, changes: string): void {
	applyModeString(client.oper.umodes, changes);
	modesChanged(client);
}

/** 221 RPL_UMODEIS: the whole set. */
export function setUserModes(client: IrcClient, modes: string): void {
	client.oper.umodes = new Set(modes.replace(/[+-]/g, "").split("").filter(Boolean));
	modesChanged(client);
}

function modesChanged(client: IrcClient): void {
	const oper = client.oper;
	const before = oper.level;
	oper.level = levelOf(oper.umodes);

	if (!oper.umodes.has("s")) {
		oper.snomask = undefined;
	}

	if (oper.level !== before) {
		if (isOpered(client)) {
			setWasOper(client.uuid, true);
			operUp(client);
		} else {
			oper.privs = [];
			oper.privsKnown = false;
			oper.queried = false;

			if (before !== "none" && before !== "service") {
				setWasOper(client.uuid, false);
			}
		}
	}

	announceOper(client);
}

/**
 * We just became an oper: ask for the privileges, the snomask and the
 * features the tools show, then put back the snomask chosen last time. Each
 * is a labeled request, so the replies are taken here and never shown as
 * raw lines. Once per oper-up.
 */
function operUp(client: IrcClient): void {
	const oper = client.oper;

	if (oper.queried || !canRequest(client)) {
		return;
	}

	oper.queried = true;
	void refreshOper(client).then(() => restoreSnomask(client));
}

/** Ask again for everything {@link OperState} holds (the panel's Refresh, oper-up). */
export async function refreshOper(client: IrcClient): Promise<void> {
	if (!canRequest(client)) {
		return;
	}

	const queries: Promise<void>[] = [fetchPrivs(client)];

	if (client.oper.umodes.has("s")) {
		queries.push(readSnomask(client));
	}

	for (const name of client.profile.operFeatures) {
		queries.push(fetchFeature(client, name));
	}

	await Promise.all(queries);
	announceOper(client);
}

/** `PRIVS`: 270, sent untagged and followed by an ACK (evilnet/nefarious2#120). */
async function fetchPrivs(client: IrcClient): Promise<void> {
	const reply = await request(client, "PRIVS", {untagged: ["270"]});
	const line = reply.lines.find((msg) => msg.command === "270");

	if (line) {
		client.oper.privs = parsePrivs(line);
		client.oper.privsKnown = true;
	}
}

/** 270 RPL_PRIVS: `<me> <target> :<PRIV PRIV …>` (truncated near 510 bytes). */
export function parsePrivs(msg: IrcMessage): string[] {
	const list = msg.params[msg.params.length - 1] ?? "";
	return list.split(" ").filter((p) => /^[A-Z_]+$/.test(p));
}

/** 008 RPL_SNOMASK: `<me> <decimal> :: Server notice mask (<hex>)`. */
export function parseSnomask(msg: IrcMessage): number | undefined {
	const value = Number(msg.params[1]);
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A snomask the server reported (008, ours or the user's own `/mode +s`). */
export function noteSnomask(client: IrcClient, value: number | undefined): void {
	if (value === undefined || value === client.oper.snomask) {
		return;
	}

	client.oper.snomask = value;
	announceOper(client);
}

/** `MODE <me> +s +0` changes nothing and answers with the mask (008). */
async function readSnomask(client: IrcClient): Promise<void> {
	const reply = await request(client, `MODE ${client.nick} +s +0`);
	const line = reply.lines.find((msg) => msg.command === "008");

	if (line) {
		client.oper.snomask = parseSnomask(line);
	}
}

/** 284 RPL_FEATURE: `:Boolean value of X: TRUE`, `:Integer value of X: 5`, … */
export function parseFeature(msg: IrcMessage): {name: string; value: string} | undefined {
	const text = msg.params[msg.params.length - 1] ?? "";
	const m = /^(?:Boolean|Integer|String) value (?:of|for) (\S+?):? (.*)$/.exec(text);

	if (!m) {
		return undefined;
	}

	return {name: m[1], value: m[2] === "not set" ? "" : m[2]};
}

async function fetchFeature(client: IrcClient, name: string): Promise<void> {
	const reply = await request(client, `GET ${name}`);
	const line = reply.lines.find((msg) => msg.command === "284");
	const feature = line ? parseFeature(line) : undefined;

	if (feature) {
		client.oper.features[feature.name] = feature.value;
	}
}

/**
 * Set the server notice mask (decimal; nefarious2 reads it with `atoi`, so
 * hex would be 0). 0 turns +s off. The server strips bits we may not hold;
 * the 008 it answers with is what we keep. Remembered for the next oper-up.
 */
export async function setSnomask(client: IrcClient, mask: number, remember = true): Promise<void> {
	if (remember) {
		setSnomaskPref(client.uuid, mask);
	}

	if (!canRequest(client)) {
		return;
	}

	if (mask === 0) {
		await request(client, `MODE ${client.nick} -s`);
		return;
	}

	const reply = await request(client, `MODE ${client.nick} +s ${mask}`);
	const line = reply.lines.find((msg) => msg.command === "008");

	if (line) {
		noteSnomask(client, parseSnomask(line));
	}
}

/** Put back the snomask the oper chose, when the server gave us another. */
function restoreSnomask(client: IrcClient): void {
	const wanted = getOperPrefs(client.uuid).snomask;

	if (wanted !== undefined && wanted !== client.oper.snomask && isOpered(client)) {
		void setSnomask(client, wanted, false);
	}
}

/**
 * Registration finished. A network that was opered last time asks for its
 * modes: a resumed bouncer session keeps oper without repeating the MODE.
 */
export function operRegistered(client: IrcClient): void {
	// Services may set +o before 001, when nothing could be asked yet.
	if (isOpered(client) && !client.oper.queried) {
		operUp(client);
	}

	if (!getOperPrefs(client.uuid).wasOper || !canRequest(client)) {
		return;
	}

	void request(client, `MODE ${client.nick}`).then((reply) => {
		const line = reply.lines.find((msg) => msg.command === "221");

		if (line) {
			setUserModes(client, line.params[1] ?? "");
		} else if (!isOpered(client)) {
			setWasOper(client.uuid, false);
		}
	});
}

/** The socket closed: nothing of this holds on the next connection. */
export function resetOper(client: IrcClient): void {
	const wasOpered = isOpered(client);
	client.oper = initialOper();

	if (wasOpered) {
		announceOper(client);
	}
}
