/**
 * `/alias` — the command-line face of Settings → Aliases (the same
 * `thelounge.aliases` list): bare, it prints every alias; `/alias <name>`
 * prints one; `/alias <name> <commands>` creates it or overwrites the body
 * in place. Deleting stays in Settings. Listings render verbatim
 * (MONOSPACE_BLOCK), because alias bodies are full of `/`, `$` and `#`
 * that Markdown would mangle.
 *
 * `/alias` reaches this file at all because expansion in ChatInput only
 * replaces names that are aliases — and a user who defines an alias *named*
 * `alias` shadows this command on purpose, exactly like any other shadow.
 */

import {MessageType} from "../../../../shared/types/msg";
import {
	MAX_ALIASES,
	MAX_BODY_LENGTH,
	MAX_NAME_LENGTH,
	isValidAliasName,
	loadAliases,
	saveAliases,
	type Alias,
} from "../../helpers/aliases";
import type {Command} from "../types";

/** One alias per entry, continuation lines of a multi-line body indented. */
function listing(list: Alias[]): string {
	return list
		.flatMap((entry) => {
			const lines = entry.body.split("\n");
			const indent = " ".repeat(entry.name.length + 2);

			return [`/${entry.name} ${lines[0]}`, ...lines.slice(1).map((line) => indent + line)];
		})
		.join("\n");
}

const alias: Command = {
	commands: ["alias"],
	allowDisconnected: true,
	input({client, chan, rest}) {
		const trimmed = rest.trim();

		if (trimmed.length === 0) {
			const list = loadAliases();

			if (list.length === 0) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: "No aliases defined. /alias <name> <commands> creates one.",
				});
				return;
			}

			client.pushMessage(chan, {
				type: MessageType.MONOSPACE_BLOCK,
				text: listing(list),
			});
			return;
		}

		// The name may be typed with its slash (`/alias /greet …`).
		const boundary = trimmed.search(/[ \n]/);
		const name = (boundary === -1 ? trimmed : trimmed.slice(0, boundary)).replace(/^\//, "");
		const body = boundary === -1 ? "" : trimmed.slice(boundary + 1).trim();

		if (!isValidAliasName(name)) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: `Alias names are letters, digits, _ and - (up to ${MAX_NAME_LENGTH} characters).`,
			});
			return;
		}

		const list = loadAliases();
		const at = list.findIndex((entry) => entry.name.toLowerCase() === name.toLowerCase());

		if (body.length === 0) {
			if (at === -1) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: `No alias /${name}. /alias ${name} <commands> creates it.`,
				});
				return;
			}

			client.pushMessage(chan, {
				type: MessageType.MONOSPACE_BLOCK,
				text: listing([list[at]]),
			});
			return;
		}

		if (body.length > MAX_BODY_LENGTH) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: `That alias is too long (${body.length} of at most ${MAX_BODY_LENGTH} characters).`,
			});
			return;
		}

		if (at === -1 && list.length >= MAX_ALIASES) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: `You already have ${MAX_ALIASES} aliases; delete one in Settings → Aliases first.`,
			});
			return;
		}

		if (at === -1) {
			list.push({name, body});
		} else {
			list[at] = {name, body};
		}

		saveAliases(list);
		client.pushMessage(chan, {
			text: `Alias /${name} ${at === -1 ? "added" : "updated"}.`,
		});
	},
};

export default alias;
