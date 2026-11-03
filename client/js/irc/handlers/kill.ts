/**
 * KILL of our own connection (`:<killer> KILL <me> :<path> (<reason>)`):
 * nefarious2 never holds a killed session for the bouncer
 * (bounce_should_hold), so the session is gone whatever
 * `PERSISTENCE STATUS` said before. Shown as it always was.
 */

import type {Handler} from "../types";
// index.ts imports this module too; `unhandled` is only called at run time.
import {unhandled} from "./index";

const kill: Handler = (client, msg) => {
	if (client.isSelf(msg.params[0] ?? "")) {
		client.persistenceHold = false;
	}

	unhandled(client, msg);
};

export default {KILL: kill};
