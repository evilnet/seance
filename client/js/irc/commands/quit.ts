/**
 * `/quit [reason]`: removes the network from the UI and closes the connection.
 */

import type {Command} from "../types";
import {textAfter} from "./words";

const quit: Command = {
	commands: ["quit"],
	allowDisconnected: true,
	input({client, rest}) {
		const reason = textAfter(rest, 0);
		client.quit(reason.length > 0 ? reason : undefined);
	},
};

export default quit;
