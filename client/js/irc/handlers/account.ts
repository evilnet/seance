/**
 * ACCOUNT (`account-notify`) and SETNAME: the user model has no field for
 * either yet, so they are acknowledged silently rather than shown as
 * unhandled noise. The account is noted for the avatar trust
 * (irc/avatars.ts), which is keyed on it.
 */

import type {Handler} from "../types";
import {onAvatarAccount} from "../avatars";

const ignore: Handler = () => undefined;

const account: Handler = (client, msg) => {
	const nick = msg.source?.name ?? "";

	if (!client.replaying && nick && !client.isSelf(nick)) {
		onAvatarAccount(client, nick, msg.params[0] ?? "*");
	}
};

export default {ACCOUNT: account, SETNAME: ignore};
