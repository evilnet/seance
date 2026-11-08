/**
 * BOUNCER (`soju.im/bouncer-networks`): the networks of a bouncer account,
 * outside the `LISTNETWORKS` batch (see ../bouncer.ts). The `BIND` and
 * `LISTNETWORKS` replies need nothing more; a `FAIL BOUNCER` shows in the lobby
 * as any standard reply does.
 */

import {bouncerLine} from "../bouncer";
import type {Handler} from "../types";

const bouncer: Handler = (client, msg) => {
	bouncerLine(client, msg);
};

export default {BOUNCER: bouncer};
