/**
 * `/disconnect [reason]`: QUIT and close without reconnecting; the network
 * stays in the sidebar (`/connect` brings it back).
 */

import type {Command} from "../types";
import {textAfter} from "./words";

const disconnect: Command = {
	commands: ["disconnect"],
	allowDisconnected: true,
	input({client, rest}) {
		const reason = textAfter(rest, 0);
		client.disconnect(reason.length > 0 ? reason : undefined);
	},
};

export default disconnect;
