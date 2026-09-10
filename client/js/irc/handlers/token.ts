/**
 * TOKEN (IRCv3 draft/authtoken — client/js/irc/authtoken.ts).
 *
 * `TOKEN GENERATE <service> :<token>` answers our `TOKEN GENERATE`; a token
 * too long for one line comes as a `draft/authtoken <service>` batch of
 * `TOKEN GENERATE * :<chunk>` lines, concatenated here. `TOKEN SERVICE`
 * (the registration-burst service list), `TOKEN NEW` / `TOKEN DEL` and
 * `TOKEN CLAIM` are the server talking to services or to itself; nothing
 * of it belongs in the timeline. Failures are `FAIL TOKEN …`
 * (handlers/standard-replies.ts).
 *
 * Spec: https://github.com/ircv3/ircv3-specifications/pull/602
 */

import type {Handler} from "../types";
import type {BatchHandler} from "./batch";

const token: Handler = (client, msg) => {
	const [sub = "", service = "", value = ""] = msg.params;

	if (sub.toUpperCase() !== "GENERATE" || service === "" || service === "*") {
		return;
	}

	client.authtoken.deliver(service, value);
};

/** A batched `TOKEN GENERATE`: the service is the batch parameter. */
export const authtokenBatch: BatchHandler = (client, batch) => {
	const service = batch.params[0] ?? "";
	const chunks = batch.messages
		.filter(
			(line) =>
				line.command === "TOKEN" && (line.params[0] ?? "").toUpperCase() === "GENERATE"
		)
		.map((line) => line.params[2] ?? "");

	if (service === "" || service === "*" || chunks.length === 0) {
		return; // a service list or a claims batch, not ours to answer
	}

	client.authtoken.deliver(service, chunks.join(""));
};

export default {TOKEN: token};
