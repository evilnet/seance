/**
 * A client's channel bans (`IrcClient.bans`): the answer to `MODE #chan b`
 * (handlers/lists.ts), kept current from the MODE lines that follow
 * (handlers/mode.ts) and read by the Bans window through the `channel:bans`
 * bus event. {@link changeBans} is every change the window and the ban dialog
 * make.
 *
 * nefarious2 answers `MODE #chan +b mask` with the channel's own MODE line,
 * unlabeled, then an `ACK`; a ban an existing one covers, a kind of ban the
 * server has switched off and a `-b` for a ban that is not there get the
 * `ACK` alone. So {@link BanLists.changes} counts the MODE lines, and an ACK
 * with no new one means the server changed nothing, which nothing else would
 * ever say.
 *
 * Vue-free (mocha).
 */

import type {
	BanChange,
	BanChangeOutcome,
	BanEntry,
	SharedBanList,
} from "../../../shared/types/ban-list";
import {t} from "../i18n/core";
import type {IrcClient} from "./client";
import {formatLine, MAX_LINE_BYTES, utf8ByteLength} from "./message";
import {errorOf} from "./profiles/report";
import {canRequest, request, type ReplyUnit} from "./request";
import {tagPrefix, trailingLine} from "./wire";

/** After this long the Bans window asks again on opening. */
export const BANS_STALE_AFTER_MS = 5 * 60 * 1000;

/** A plain server allows three changes a line when it does not say (RFC 2812). */
const DEFAULT_MODES = 3;

/** Room for the label `request()` puts in front of a line. */
const LABEL_ROOM = utf8ByteLength(tagPrefix({label: "r9999999"}));

interface ChannelBans {
	list: SharedBanList;
	/** The rows of the answer under way. */
	incoming: BanEntry[] | null;
	/** That answer was asked for, not a typed `/mode #chan b`. */
	asked: boolean;
	/** MODE lines seen that changed a ban. */
	changes: number;
}

function sameMask(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

export class BanLists {
	private channels = new Map<string, ChannelBans>();

	constructor(private readonly casefold: (name: string) => string) {}

	private entry(channel: string): ChannelBans {
		const key = this.casefold(channel);
		let found = this.channels.get(key);

		if (!found) {
			found = {
				list: {channel, status: "idle", rows: [], at: 0, note: ""},
				incoming: null,
				asked: false,
				changes: 0,
			};
			this.channels.set(key, found);
		}

		return found;
	}

	/** A `MODE #chan b` went out for the Bans window. */
	start(channel: string): void {
		const entry = this.entry(channel);
		entry.list.status = "loading";
		entry.list.note = "";
		entry.incoming = [];
		entry.asked = true;
	}

	/** One 367. A list nobody asked for is a typed `/mode #chan b`. */
	addRow(channel: string, row: BanEntry): void {
		const entry = this.entry(channel);

		if (!entry.incoming) {
			entry.incoming = [];
			entry.asked = false;
		}

		entry.incoming.push(row);
	}

	/** The 368: the list is whole. Returns whether it was asked for. */
	finish(channel: string, now: number): boolean {
		const entry = this.entry(channel);
		const asked = entry.asked;
		entry.list.rows = entry.incoming ?? [];
		entry.list.status = "done";
		entry.list.at = now;
		entry.list.note = "";
		entry.incoming = null;
		entry.asked = false;
		return asked;
	}

	/** The server would not give the list. */
	refuse(channel: string, note: string): void {
		const entry = this.entry(channel);
		entry.list.status = "error";
		entry.list.note = note;
		entry.incoming = null;
		entry.asked = false;
	}

	/** A MODE line's ban changes, whoever made them. */
	applyChanges(
		channel: string,
		changes: {add: boolean; mask: string}[],
		by: string,
		at: number
	): void {
		const entry = this.entry(channel);
		entry.changes++;

		// Nothing to keep current before the first answer: it will have these.
		if (entry.list.status === "idle" || entry.list.status === "error") {
			return;
		}

		for (const {add, mask} of changes) {
			const rows = entry.list.rows.filter((row) => !sameMask(row.mask, mask));
			entry.list.rows = add ? [...rows, {mask, by, at}] : rows;
		}
	}

	/** How many ban-changing MODE lines this channel has seen. */
	changes(channel: string): number {
		return this.entry(channel).changes;
	}

	snapshot(channel: string, limit?: number): SharedBanList {
		const {list} = this.entry(channel);
		return {...list, rows: [...list.rows], limit};
	}

	reset(): void {
		this.channels.clear();
	}
}

/**
 * `MODE` lines for a change: removals first, as many masks to a line as the
 * server's `MODES` allows and {@link MAX_LINE_BYTES} has room for. The first
 * line of an edit is the swap, so the channel is never left without the ban.
 */
export function banModeLines(
	channel: string,
	remove: string[],
	add: string[],
	limit = DEFAULT_MODES
): string[] {
	const changes = [
		...remove.map((mask) => ({sign: "-", mask})),
		...add.map((mask) => ({sign: "+", mask})),
	];
	const lines: string[] = [];
	let chunk: typeof changes = [];

	const lineOf = (part: typeof changes): string => {
		let letters = "";
		let sign = "";

		for (const change of part) {
			letters += change.sign === sign ? "b" : `${change.sign}b`;
			sign = change.sign;
		}

		return formatLine({
			command: "MODE",
			params: [channel, letters, ...part.map((change) => change.mask)],
		});
	};

	for (const change of changes) {
		const next = [...chunk, change];
		const fits = utf8ByteLength(lineOf(next)) + LABEL_ROOM <= MAX_LINE_BYTES;

		if (chunk.length > 0 && (next.length > limit || !fits)) {
			lines.push(lineOf(chunk));
			chunk = [change];
		} else {
			chunk = next;
		}
	}

	if (chunk.length > 0) {
		lines.push(lineOf(chunk));
	}

	return lines;
}

/**
 * The answer to a labeled `MODE #chan b`: the 367s and the 368 go on to
 * handlers/lists.ts as they would have, a refusal or silence ends the wait.
 */
export function takeBanList(client: IrcClient, channel: string, reply: ReplyUnit): void {
	const error = errorOf(reply.lines);

	if (error || reply.outcome === "timeout" || reply.outcome === "closed") {
		client.bans.refuse(channel, error ?? t("bans.noAnswer"));
		client.dispatchBans(channel);
		return;
	}

	for (const msg of reply.lines) {
		client.handleMessage(msg);
	}
}

/** One `KICK`; the server fills in a reason left empty. */
export function kickLine(channel: string, nick: string, reason: string): string {
	return reason
		? trailingLine("KICK", [channel, nick, reason])
		: formatLine({command: "KICK", params: [channel, nick]});
}

/** Lines a server charges for: one at a time, as the last one is answered. */
async function sendLine(
	client: IrcClient,
	line: string
): Promise<{outcome: "ok" | "refused" | "timeout" | "closed"; text?: string}> {
	const reply = await request(client, line);
	const error = errorOf(reply.lines);

	if (error) {
		return {outcome: "refused", text: error};
	}

	// A server that labels the MODE or KICK itself (the spec's single-line
	// answer; nefarious2 does not) still has to show it in the channel.
	for (const msg of reply.lines) {
		client.handleMessage(msg);
	}

	return {
		outcome: reply.outcome === "timeout" || reply.outcome === "closed" ? reply.outcome : "ok",
	};
}

/**
 * Make `change`. Each line waits for the answer to the one before, so a long
 * unban costs its fake lag without ever piling up in the server's receive
 * queue, and a refusal stops the rest. Without `labeled-response` nothing can
 * be waited for: the lines go through the background queue and the window
 * follows the MODE lines that come back.
 */
export async function changeBans(
	client: IrcClient,
	change: BanChange
): Promise<{outcome: BanChangeOutcome; text?: string}> {
	const modes = parseInt(client.isupport.get("MODES") ?? "", 10) || DEFAULT_MODES;
	const lines = banModeLines(change.channel, change.remove, change.add, modes);
	const kicks = (change.kick?.nicks ?? []).map((nick) =>
		kickLine(change.channel, nick, change.kick?.reason ?? "")
	);

	if (!canRequest(client)) {
		if (!client.isWelcomed) {
			return {outcome: "closed"};
		}

		lines.concat(kicks).forEach((line, index) => {
			client.background.add({
				key: `bans:${Date.now()}:${index}`,
				cost: client.fakeLag.cost(line),
				run: () => void client.send(line),
			});
		});

		return {outcome: "ok"};
	}

	const before = client.bans.changes(change.channel);

	for (const line of lines) {
		const sent = await sendLine(client, line);

		if (sent.outcome !== "ok") {
			return sent;
		}
	}

	if (lines.length > 0 && client.bans.changes(change.channel) === before) {
		// Nothing the server did: no point kicking on the strength of it.
		return {outcome: "unchanged"};
	}

	for (const line of kicks) {
		const sent = await sendLine(client, line);

		if (sent.outcome !== "ok") {
			return sent;
		}
	}

	return {outcome: "ok"};
}
