/**
 * Standard replies (`standard-replies` cap): `FAIL|WARN|NOTE <command> <code> [context...] :<description>`.
 *
 * `FAIL REDACT <code> [<target> [<msgid>]] :text` gets a friendly message in
 * the channel the context names (or the active window) and aborts an edit
 * waiting on that msgid (bus-contract §1.4). `FAIL BATCH MULTILINE_* …` says
 * a multi-line message was dropped whole (../multiline.ts) — except
 * `MULTILINE_COOLDOWN`, which is the server pacing us: the batch goes out
 * again when the cooldown is over, and nothing is said. `WARN BATCH
 * MULTILINE_FALLBACK` — one per multi-line message — is silent, and so is
 * `FAIL PERSISTENCE` about the catch-up cursor (../persistence.ts).
 * `FAIL WEBPUSH <code> <command> [<endpoint>] :text` becomes `webpush:state`
 * (../webpush.ts); everything else is shown raw.
 */

import {MessageType} from "../../../../shared/types/msg";
import {chatHistoryFailed} from "../history";
import {multilineCooldown, multilineRejected} from "../multiline";
import {inRestorationWindow, noteRestorationActivity, persistenceFailed} from "../persistence";
import type {Handler} from "../types";
import type {IrcClient} from "../client";
import type {IrcMessage} from "../message";

/** nefarious2 `m_redact.c` codes → what to tell the user. */
const REDACT_ERRORS: Record<string, string> = {
	DISABLED: "Deleting messages is disabled on this server.",
	INVALID_TARGET: "Messages can only be deleted in channels.",
	REDACT_FORBIDDEN: "You are not allowed to delete that message.",
	UNKNOWN_MSGID: "The server no longer has that message.",
	REDACT_WINDOW_EXPIRED: "That message is too old to delete.",
};

function redactFailed(client: IrcClient, msg: IrcMessage): void {
	const [, code = "", ...rest] = msg.params;
	const description = rest.length > 0 ? rest[rest.length - 1] : "";
	const [target, msgid] = rest.slice(0, -1);
	const why = REDACT_ERRORS[code.toUpperCase()] ?? description ?? code;
	const edit = msgid ? client.rejectEdit(msgid) : undefined;
	const chan = edit ?? (target ? client.findChannel(target) : undefined) ?? client.lobby;

	client.pushMessage(
		chan,
		{
			type: MessageType.ERROR,
			time: client.timeOf(msg),
			text: `${edit ? "Edit not sent" : "Could not delete message"}: ${why}`,
			showInActive: chan === client.lobby,
		},
		true
	);
}

/**
 * `FAIL BATCH MULTILINE_… :text` (the draft's § Errors): the server threw the
 * whole `draft/multiline` batch away, so the message was not sent at all.
 * `MULTILINE_MAX_BYTES`/`MULTILINE_MAX_LINES` carry the limit as their
 * context, `MULTILINE_INVALID_TARGET` carries `<batch-target>
 * <provided-target>`, `MULTILINE_INVALID` carries nothing. Seance plans its
 * batches under the limits the capability advertised, so none of these should
 * ever arrive — but a dropped message the user watched themselves type has to
 * be reported where they typed it: the channel a context names, else the
 * active window.
 */
function multilineFailed(client: IrcClient, msg: IrcMessage): void {
	const [, code = "", ...rest] = msg.params;
	const description = rest.length > 0 ? rest[rest.length - 1] : "";
	const context = rest.slice(0, -1);
	// A limit is all digits, so it is never mistaken for a target.
	const limit = context.find((param) => /^\d+$/.test(param));
	const chan =
		context
			.filter((param) => !/^\d+$/.test(param))
			.map((param) => client.findChannel(param))
			.find((found) => found !== undefined) ?? client.lobby;
	let why: string;

	switch (code.toUpperCase()) {
		case "MULTILINE_MAX_BYTES":
			why = `it was too long for one multi-line message${
				limit ? ` (the server's limit is ${limit} bytes)` : ""
			}.`;
			break;

		case "MULTILINE_MAX_LINES":
			why = `it had too many lines for one multi-line message${
				limit ? ` (the server's limit is ${limit})` : ""
			}.`;
			break;

		case "MULTILINE_INVALID_TARGET":
			why = "its lines did not all go to the same target.";
			break;

		default:
			why = description || "the server rejected the multi-line batch.";
	}

	client.pushMessage(
		chan,
		{
			type: MessageType.ERROR,
			time: client.timeOf(msg),
			text: `Message not sent: ${why}`,
			showInActive: chan === client.lobby,
		},
		true
	);
}

/**
 * `FAIL WEBPUSH <code> <command> [<endpoint>] :<text>` (draft/webpush § Errors,
 * plus nefarious2's non-spec `ACCOUNT_REQUIRED` which omits the endpoint).
 * Reported as `webpush:state` with `ok: false`; the subscription UI owns the
 * message, so nothing lands in the timeline.
 */
function webpushFailed(client: IrcClient, msg: IrcMessage): void {
	const [, code = "", context = "", ...rest] = msg.params;
	const description = rest.length > 0 ? rest[rest.length - 1] : "";
	// The spec shape carries the endpoint between the subcommand and the
	// text; nefarious2's ACCOUNT_REQUIRED drops it and the text comes first.
	const endpoint = rest.length > 1 ? rest[0] : "";

	client.dispatch("webpush:state", {
		network: client.uuid,
		action: context.toUpperCase(),
		endpoint,
		ok: false,
		code: code.toUpperCase(),
		reason: description,
	});
}

/**
 * (`ircd/m_batch.c` counts them down in whole seconds). Zero when the server
 * named none, which only costs one round trip to find out.
 */
function cooldownSeconds(rest: string[]): number {
	const seconds = rest.slice(0, -1).find((param) => /^\d+$/.test(param));

	return seconds === undefined ? 0 : Number(seconds);
}

function reply(kind: "FAIL" | "WARN" | "NOTE"): Handler {
	return (client, msg) => {
		const [command = "*", code = "", ...rest] = msg.params;

		if (kind === "FAIL" && command.toUpperCase() === "CHATHISTORY") {
			chatHistoryFailed(client, msg); // answers the pending `more`; still shown below
		}

		if (kind === "FAIL" && command.toUpperCase() === "REDACT") {
			redactFailed(client, msg);
			return;
		}

		if (kind === "FAIL" && command.toUpperCase() === "WEBPUSH") {
			webpushFailed(client, msg);
			return;
		}

		if (kind === "FAIL" && command.toUpperCase() === "TOKEN") {
			// draft/authtoken: an upload waiting on `TOKEN GENERATE` reports
			// the failure itself (the uploader's error line); a FAIL nobody
			// asked for is shown like any other.
			const description = rest.length > 0 ? rest[rest.length - 1] : "";

			if (client.authtoken.fail(code.toUpperCase(), description)) {
				return;
			}
		}

		if (
			kind === "FAIL" &&
			command.toUpperCase() === "BATCH" &&
			code.toUpperCase().startsWith("MULTILINE_")
		) {
			// A cooldown is the server pacing us, not something the user can
			// act on: the batch is re-sent when it expires and the message
			// arrives late rather than not at all. Only when it cannot be
			// re-sent does this become a failure worth reporting.
			if (
				code.toUpperCase() === "MULTILINE_COOLDOWN" &&
				multilineCooldown(client, cooldownSeconds(rest))
			) {
				return;
			}

			multilineRejected(client);
			multilineFailed(client, msg);
			return;
		}

		if (
			kind === "WARN" &&
			command.toUpperCase() === "BATCH" &&
			code.toUpperCase() === "MULTILINE_FALLBACK"
		) {
			// nefarious2 warns once per multi-line message that some
			// recipient without the capability got a truncated copy. It is
			// not in the draft, it names nothing the sender can do about it,
			// and on a busy channel it is every message — so it is swallowed
			// (docs/projects/multiline-messages.md). Any *other* BATCH
			// warning, seen or unseen, is still shown.
			return;
		}

		if (
			kind === "FAIL" &&
			command.toUpperCase() === "PERSISTENCE" &&
			persistenceFailed(client, msg)
		) {
			return; // a refused / unknown catch-up cursor: nothing for the user
		}

		if (kind === "NOTE" && command.toUpperCase() === "BOUNCER") {
			// The bouncer talks to us while it reattaches us to a held
			// session; its channel-state burst follows. Keep the autojoin
			// waiting for that, and do not report the routine attach — on a
			// phone it would arrive on every switch back to the app.
			const routine = inRestorationWindow(client);
			noteRestorationActivity(client);

			if (routine && code.toUpperCase() === "ALIAS_ATTACHED") {
				return;
			}
		}

		const description = rest.length > 0 ? rest[rest.length - 1] : "";
		const context = rest.slice(0, -1);
		const text = `${command === "*" ? "" : `${command}: `}${description}${
			context.length > 0 ? ` (${context.join(" ")})` : ""
		} [${kind} ${code}]`;

		client.pushMessage(
			client.lobby,
			{
				type: kind === "NOTE" ? undefined : MessageType.ERROR,
				time: client.timeOf(msg),
				text,
				showInActive: true,
			},
			true
		);
	};
}

export default {FAIL: reply("FAIL"), WARN: reply("WARN"), NOTE: reply("NOTE")};
