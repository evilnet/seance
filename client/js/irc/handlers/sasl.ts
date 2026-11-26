/**
 * AUTHENTICATE and the SASL numerics (900-908): fed to the active
 * {@link SaslAuth} exchange, whose lines/outcome the client applies via
 * `saslProgress()`. 900/901 also track the services account we are logged
 * in as, whether or not SASL was involved.
 */

import {MessageType} from "../../../../shared/types/msg";
import {
	ERR_NICKLOCKED,
	ERR_SASLABORTED,
	ERR_SASLALREADY,
	ERR_SASLFAIL,
	ERR_SASLTOOLONG,
	RPL_LOGGEDIN,
	RPL_LOGGEDOUT,
	RPL_SASLMECHS,
	RPL_SASLSUCCESS,
} from "../sasl";
import type {Handler} from "../types";

function text(params: string[]): string {
	return params[params.length - 1] ?? "";
}

/** Route to the running exchange; true if there was one. */
function feed(client: Parameters<Handler>[0], msg: Parameters<Handler>[1]): boolean {
	if (!client.sasl) {
		return false;
	}

	client.saslProgress(client.sasl.handle(msg));
	return true;
}

const authenticate: Handler = (client, msg) => {
	feed(client, msg);
};

const loggedIn: Handler = (client, msg) => {
	// <nick> <nick!user@host> <account> :You are now logged in as <account>
	const account = msg.params[2] ?? "";

	if (client.account !== account) {
		client.account = account;
		client.syncAccountChanged();
	}

	if (!feed(client, msg)) {
		client.pushMessage(client.lobby, {time: client.timeOf(msg), text: text(msg.params)});
	}
};

const loggedOut: Handler = (client, msg) => {
	client.account = "";
	client.syncAccountChanged();
	client.pushMessage(client.lobby, {time: client.timeOf(msg), text: text(msg.params)});
};

const outcome: Handler = (client, msg) => {
	if (feed(client, msg)) {
		return;
	}

	// No exchange running (e.g. the 906 that answers our own `AUTHENTICATE *`).
	const failed = msg.command !== RPL_SASLSUCCESS;
	client.pushMessage(
		client.lobby,
		{
			type: failed ? MessageType.ERROR : undefined,
			time: client.timeOf(msg),
			text: failed ? `SASL: ${text(msg.params)}` : text(msg.params),
		},
		failed
	);
};

const mechanisms: Handler = (client, msg) => {
	if (!feed(client, msg)) {
		client.pushMessage(client.lobby, {
			time: client.timeOf(msg),
			text: `Available SASL mechanisms: ${msg.params[1] ?? ""}`,
		});
	}
};

export default {
	AUTHENTICATE: authenticate,
	[RPL_LOGGEDIN]: loggedIn,
	[RPL_LOGGEDOUT]: loggedOut,
	[ERR_NICKLOCKED]: outcome,
	[RPL_SASLSUCCESS]: outcome,
	[ERR_SASLFAIL]: outcome,
	[ERR_SASLTOOLONG]: outcome,
	[ERR_SASLABORTED]: outcome,
	[ERR_SASLALREADY]: outcome,
	[RPL_SASLMECHS]: mechanisms,
};
