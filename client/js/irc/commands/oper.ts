/**
 * `/stats`, `/check` and `/privs` as structured reports: the command goes
 * out labeled (../request.ts), the whole answer comes back as one unit, the
 * server profile turns it into an {@link OperReport} and it lands as one
 * `report` message in the window it was typed in. Without
 * `labeled-response` the command is sent plainly and the replies render
 * raw, as before. docs/projects/oper-tools.md, features 4 and 5.
 */

import {MessageType} from "../../../../shared/types/msg";
import type {OperReport} from "../../../../shared/types/oper";
import type {Channel} from "../channel";
import type {IrcClient} from "../client";
import {formatLine, IrcMessage} from "../message";
import {parsePrivs} from "../oper";
import {rawReport} from "../profiles/generic";
import {chips, errorOf, errorReport, rawLines} from "../profiles/report";
import {canRequest, request} from "../request";
import type {Command} from "../types";

/** Show `report` where the command was typed (no unread: it answers us). */
export function pushReport(client: IrcClient, chan: Channel, report: OperReport): void {
	client.pushMessage(chan, {type: MessageType.REPORT, report, text: report.title}, false);
}

/** The reply's raw lines when the server stayed silent or the socket went. */
function emptyNote(lines: IrcMessage[], outcome: string): string | undefined {
	if (lines.length > 0) {
		return undefined;
	}

	return outcome === "timeout"
		? "The server did not answer."
		: outcome === "closed"
		? "Not sent: the connection is down."
		: undefined;
}

/** `STATS <selector> [server]` → the profile's table for that selector. */
export async function runStats(client: IrcClient, chan: Channel, args: string[]): Promise<void> {
	const selector = args[0] ?? "";
	const line = formatLine({command: "STATS", params: args.filter(Boolean)});
	const reply = await request(client, line, {end: ["219"]});
	const report = client.profile.statsReport(selector || "*", reply.lines, line);
	const note = emptyNote(reply.lines, reply.outcome);

	pushReport(client, chan, note ? {...report, error: note} : report);
}

/** `CHECK …` → the profile's card, else the raw lines. */
export async function runCheck(client: IrcClient, chan: Channel, args: string[]): Promise<void> {
	const line = formatLine({command: "CHECK", params: args.filter(Boolean)});
	const reply = await request(client, line, {end: ["291", "292"]});
	const note = emptyNote(reply.lines, reply.outcome);
	const report =
		client.profile.checkReport(reply.lines, line) ??
		rawReport("raw", `CHECK ${args.join(" ")}`, reply.lines, line);

	pushReport(client, chan, note ? {...report, error: note} : report);
}

/** `PRIVS [nick]` → the privileges as chips (270 arrives untagged, #120). */
export async function runPrivs(client: IrcClient, chan: Channel, args: string[]): Promise<void> {
	const line = formatLine({command: "PRIVS", params: args.filter(Boolean)});
	const reply = await request(client, line, {untagged: ["270"]});
	const replies = reply.lines.filter((msg) => msg.command === "270");
	const error = errorOf(reply.lines) ?? emptyNote(reply.lines, reply.outcome);

	if (replies.length === 0) {
		pushReport(
			client,
			chan,
			errorReport("privs", "PRIVS", line, reply.lines, error ?? "No privileges reported.")
		);
		return;
	}

	for (const msg of replies) {
		const target = msg.params[1] ?? client.nick;
		const privs = parsePrivs(msg);

		if (client.isSelf(target)) {
			client.oper.privs = privs;
			client.oper.privsKnown = true;
		}

		pushReport(client, chan, {
			kind: "privs",
			title: `Privileges of ${target}`,
			subtitle: `${privs.length} privileges`,
			command: line,
			sections: [{entries: [{label: "Privileges", value: chips(privs)}]}],
			raw: rawLines([msg]),
		});
	}
}

function usage(client: IrcClient, chan: Channel, text: string): void {
	client.pushMessage(chan, {type: MessageType.ERROR, text});
}

/** Send plainly (no labels on this server): the replies render raw. */
function sendPlain(client: IrcClient, command: string, args: string[]): void {
	client.send(formatLine({command, params: args.filter(Boolean)}));
}

const oper: Command = {
	commands: ["stats", "check", "privs"],
	input({client, chan, cmd, args}) {
		const params = args.filter((arg) => arg.length > 0);

		if (cmd === "check" && params.length === 0) {
			usage(client, chan, "Usage: /check <nick|#channel|server|hostmask> [-flags]");
			return;
		}

		if (!canRequest(client)) {
			sendPlain(client, cmd.toUpperCase(), params);
			return;
		}

		const run = cmd === "stats" ? runStats : cmd === "check" ? runCheck : runPrivs;
		void run(client, chan, params);
	},
};

export default oper;
