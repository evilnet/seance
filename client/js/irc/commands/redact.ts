/**
 * `/redact <msgid> [reason]` (alias `/delete`): `REDACT <channel> <msgid> [:reason]`.
 * Channels only; the server decides whether we may (author, chanop within
 * the redact window, oper) and answers `FAIL REDACT` otherwise.
 */

import {MessageType} from "../../../../shared/types/msg";
import {t} from "../../i18n/core";
import type {Command} from "../types";

const redact: Command = {
	commands: ["redact", "delete"],
	input({client, chan, cmd, args}) {
		const [msgid = "", ...reason] = args.filter((arg) => arg.length > 0);

		if (msgid.length === 0) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.usageRedact", {cmd}),
			});
			return;
		}

		client.redact(chan, msgid, reason.length > 0 ? reason.join(" ") : undefined);
	},
};

export default redact;
