/**
 * `/lua` — execute Lua code dynamically in the active channel/query.
 */

import {MessageType} from "../../../../shared/types/msg";
import type {Command} from "../types";
import {scriptManager} from "../scripting/manager";
import {t} from "../../i18n/core";

const lua: Command = {
	commands: ["lua"],
	allowDisconnected: true,
	input({client, chan, rest}) {
		const code = rest.trim();

		if (code.length === 0) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: t("cmd.usageLua", {
					first: "/lua return 2 + 2",
					second: '/lua seance.print("hello")',
				}),
			});
			return;
		}

		void (async () => {
			try {
				const res = await scriptManager.evalSnippet(code, {chan, client});

				if (!res.success) {
					client.pushMessage(chan, {
						type: MessageType.ERROR,
						text: res.error
							? t("cmd.lua.error", {error: res.error})
							: t("cmd.lua.errorUnknown"),
					});
					return;
				}

				if (res.result !== undefined && res.result.length > 0) {
					client.pushMessage(chan, {
						type: MessageType.MONOSPACE_BLOCK,
						text: res.result,
					});
				} else {
					client.pushMessage(chan, {
						type: MessageType.MESSAGE,
						text: t("cmd.lua.done"),
						from: {
							nick: "lua",
							mode: "",
						},
					});
				}
			} catch (err: any) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: t("cmd.lua.failed", {error: err?.message ?? String(err)}),
				});
			}
		})();
	},
};

export default lua;
