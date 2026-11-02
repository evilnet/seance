/**
 * `/list [args]`: request the channel list; `handlers/list.ts` collects
 * 321/322/323 into the "Channel List" special window.
 */

import {resetChannelList} from "../handlers/list";
import {formatLine} from "../message";
import type {Command} from "../types";

const list: Command = {
	commands: ["list"],
	input({client, args}) {
		resetChannelList(client);
		client.send(formatLine({command: "LIST", params: args}));
	},
};

export default list;
