/**
 * `/redact <msgid> [reason]` (alias `/delete`): `REDACT <channel> <msgid> [:reason]`.
 * Channels only; the server decides whether we may (author, chanop within
 * the redact window, oper) and answers `FAIL REDACT` otherwise.
 */

import {MessageType} from "../../../../shared/types/msg";
import {t} from "../../i18n/core";
import type {Command} from "../types";
import {textAfter} from "./words";

const redact: Command = {
	commands: ["redact", "delete"],
	input({client, chan, cmd, args, rest}) {
		const msgid = args[0] ?? "";

		if (msgid.length === 0) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.usageRedact", {cmd}),
			});
			return;
		}

		const reason = textAfter(rest, 1);
		client.redact(chan, msgid, reason.length > 0 ? reason : undefined);
	},
};

export default redact;
