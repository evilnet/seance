/**
 * A conversation on a network by its name, as the network compares names.
 *
 * Vue-free so mocha covers it (test/helpers/channelByName.ts).
 */

import {casefold} from "../irc/casemap";
import type {ClientChan, ClientNetwork} from "../types";

/**
 * The channel or query `name` on `network`, compared under the network's
 * ISUPPORT `CASEMAPPING` (rfc1459 until its 005 says otherwise): there
 * `#foo[bar]` and `#foo{bar}` are one channel, which a lowercase comparison
 * misses.
 */
export function channelByName(
	network: Pick<ClientNetwork, "channels" | "serverOptions">,
	name: string
): ClientChan | undefined {
	const mapping = network.serverOptions.CASEMAPPING;
	const folded = casefold(name, mapping);

	return network.channels.find((c) => casefold(c.name, mapping) === folded);
}
