/**
 * `/lua` — execute Lua code dynamically in the active channel/query.
 */

import {MessageType} from "../../../../shared/types/msg";
import type {Command} from "../types";
import {scriptManager} from "../scripting/manager";

const lua: Command = {
	commands: ["lua"],
	allowDisconnected: true,
	input({client, chan, rest}) {
		const code = rest.trim();

		if (code.length === 0) {
			client.pushMessage(chan, {
				type: MessageType.ERROR,
				text: 'Usage: /lua <code> (e.g. /lua return 2 + 2 or /lua seance.print("hello"))',
			});
			return;
		}

		void (async () => {
			try {
				const res = await scriptManager.evalSnippet(code, {chan, client});

				if (!res.success) {
					client.pushMessage(chan, {
						type: MessageType.ERROR,
						text: `Lua error: ${res.error ?? "unknown error"}`,
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
						text: "Lua execution completed.",
						from: {
							nick: "lua",
							mode: "",
						},
					});
				}
			} catch (err: any) {
				client.pushMessage(chan, {
					type: MessageType.ERROR,
					text: `Lua execution failed: ${err?.message ?? String(err)}`,
				});
			}
		})();
	},
};

export default lua;
