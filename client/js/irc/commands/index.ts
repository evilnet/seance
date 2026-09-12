/**
 * Outbound command registry and the `input` dispatcher.
 *
 * Mirrors attic/server/client.ts `inputLine` + attic/server/plugins/inputs/index.ts:
 * every line of input is one message; text not starting with `/` (or
 * starting with `//`) is said to the current channel; `/cmd args` runs the
 * registered {@link Command}; unknown commands go to the server raw.
 *
 * To add a command, create a file exporting a {@link Command} and list it in
 * `modules`. UI-only commands (`/collapse`, `/expand`, `/search`, and `/join`
 * for channels already in the list) are intercepted in `client/js/commands/`
 * before the bus ever sees them.
 */

import {ChanType} from "../../../../shared/types/chan";
import {MessageType} from "../../../../shared/types/msg";
import type {Channel} from "../channel";
import type {IrcClient} from "../client";
import type {Command, InputOptions} from "../types";
import alias from "./alias";
import away from "./away";
import ban from "./ban";
import connect from "./connect";
import ctcp from "./ctcp";
import disconnect from "./disconnect";
import ignore from "./ignore";
import ignorelist from "./ignorelist";
import invite from "./invite";
import join from "./join";
import kick from "./kick";
import kill from "./kill";
import list from "./list";
import me from "./me";
import mode from "./mode";
import msg from "./msg";
import mute from "./mute";
import nick from "./nick";
import notice from "./notice";
import part from "./part";
import quit from "./quit";
import raw from "./raw";
import react from "./react";
import redact from "./redact";
import rejoin from "./rejoin";
import topic from "./topic";
import whois from "./whois";

const modules: Command[] = [
	alias,
	away,
	ban,
	connect,
	ctcp,
	disconnect,
	ignore,
	ignorelist,
	invite,
	join,
	kick,
	kill,
	list,
	me,
	mode,
	msg,
	mute,
	nick,
	notice,
	part,
	quit,
	raw,
	react,
	redact,
	rejoin,
	topic,
	whois,
];

export const commands = new Map<string, Command>();

for (const command of modules) {
	for (const name of command.commands) {
		commands.set(name, command);
	}
}

/** Handled in `client/js/commands/` before reaching the bus. */
const clientSideCommands = ["/collapse", "/expand", "/search"];

/** Sent raw; listed so autocompletion knows them. */
const passThroughCommands = ["/as", "/bs", "/cs", "/ho", "/hs", "/ms", "/ns", "/os", "/rs"];

/** `/name` list for the `commands` event (autocompletion). */
export function commandNames(): string[] {
	return Array.from(commands.keys())
		.map((name) => `/${name}`)
		.concat(clientSideCommands, passThroughCommands)
		.sort();
}

export const NOT_CONNECTED =
	"You are not connected to the IRC network, unable to send your command.";

/**
 * Commands whose argument *is* the message, so multi-line input stays one
 * message instead of one command per line (see {@link dispatchInput}).
 * `alias` is here for the same reason with a different noun: its argument is
 * the alias body, and a body typed with Shift+Enter is one definition, not a
 * definition followed by stray input.
 */
const multilineCommands = new Set(["alias", "me", "notice", "msg", "query", "say"]);

/**
 * Handle everything the user typed into `chan` (may span several lines).
 *
 * `opts.reply` applies to every line. `opts.edit` replaces one message, so
 * the whole text is one logical message: it is always said (never parsed
 * as a command — it is the replacement body of a message, and the message
 * being edited is plain text by construction), and `sendMessage` may still
 * chunk it, putting the edit tag on the first chunk only and the reply tag
 * on all of them.
 *
 * With `draft/multiline` negotiated, multi-line input is one message
 * whenever it can be: plain text, and the commands in
 * {@link multilineCommands}, take the whole text (line breaks and all);
 * anything else is still one command per line, as it always was. Without
 * the capability nothing changes — every line is its own input, and an edit
 * collapses its line breaks to spaces.
 *
 * A CR is a line separator, never message content: under the capability
 * `\r\n` and a lone `\r` (a paste of classic-Mac line endings) both become
 * `\n` before anything looks at the text, because everything below splits on
 * `\n` alone — {@link isOneMessage}, the command-name search in
 * {@link inputLine} and `splitTarget`, whose target must not swallow one.
 * `planMultiline` still turns any CR that reaches it into a space; that is
 * the guard for text arriving from elsewhere. Without the capability the
 * text is untouched, so that path stays byte for byte what it was.
 */
export function dispatchInput(
	client: IrcClient,
	chan: Channel,
	text: string,
	opts: InputOptions = {}
): void {
	const multiline = client.multilineLimits() !== undefined;
	const input = multiline ? text.replace(/\r\n?/g, "\n") : text;

	if (opts.edit) {
		const body = multiline ? input : input.replace(/\r?\n/g, " ");
		inputLine(client, chan, body.trim(), opts, true);
		return;
	}

	if (multiline && input.includes("\n") && isOneMessage(input)) {
		inputLine(client, chan, input, opts);
		return;
	}

	for (const line of input.split("\n")) {
		inputLine(client, chan, line.replace(/\r$/, ""), opts);
	}
}

/** Whether multi-line `text` is one message rather than one command per line. */
function isOneMessage(text: string): boolean {
	const first = text.slice(0, text.indexOf("\n")).replace(/\r$/, "");

	if (first.charAt(0) !== "/" || first.charAt(1) === "/") {
		return true;
	}

	const body = first.slice(1);
	const space = body.indexOf(" ");

	return multilineCommands.has((space === -1 ? body : body.slice(0, space)).toLowerCase());
}

function inputLine(
	client: IrcClient,
	chan: Channel,
	line: string,
	opts: InputOptions,
	forceSay = false
): void {
	if (line.length === 0) {
		return;
	}

	let cmd: string;
	let rest: string;

	if (forceSay || line.charAt(0) !== "/" || line.charAt(1) === "/") {
		if (chan.type === ChanType.LOBBY) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: "Messages can not be sent to lobbies.",
			});
			return;
		}

		cmd = "say";
		rest = forceSay ? line : line.replace(/^\//, "");
	} else {
		const body = line.slice(1);
		// A line feed ends the command name exactly as a space does: `line`
		// spans several lines only for the commands that take the whole text
		// (`/me\nwaves`), and `me\nwaves` is not a command name.
		const space = body.search(/[ \n]/);
		cmd = (space === -1 ? body : body.slice(0, space)).toLowerCase();
		rest = space === -1 ? "" : body.slice(space + 1);
	}

	const args = rest.length > 0 ? rest.split(" ") : [];
	const command = commands.get(cmd);

	if (command) {
		if (!client.isConnected && !command.allowDisconnected) {
			client.pushMessage(chan, {type: MessageType.ERROR, text: NOT_CONNECTED});
			return;
		}

		command.input({client, chan, cmd, args, rest, opts});
		return;
	}

	if (!client.isConnected) {
		client.pushMessage(chan, {type: MessageType.ERROR, text: NOT_CONNECTED});
		return;
	}

	client.send(line.slice(1));
}
