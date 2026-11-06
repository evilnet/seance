/**
 * `/list [args]`: ask the server for its channel list, for the channel
 * browser (`client/js/commands/list.ts` opens it; `handlers/list.ts` fills
 * it). The arguments are the server's own (`>10`, `#a*`, nefarious2's
 * `C<10`, `T>0`), passed as they are.
 */

import type {Command} from "../types";

const list: Command = {
	commands: ["list"],
	input({client, args}) {
		client.requestChannelList(args);
	},
};

export default list;
