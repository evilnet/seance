/**
 * CAP: delegated to the CapNegotiator (LS/ACK/NAK during registration,
 * NEW/DEL afterwards via `cap-notify`); we only send what it tells us to.
 */

import {t} from "../../i18n/core";
import {MessageType} from "../../../../shared/types/msg";
import type {Handler} from "../types";

const cap: Handler = (client, msg) => {
	const result = client.caps.handle(msg);

	for (const line of result.send) {
		if (client.isQuitting) {
			// A required SASL login failed while the negotiator ran its
			// `beforeEnd` hook (client.ts): the `CAP END` it queued behind
			// that would only go out after our QUIT.
			break;
		}

		client.send(line);
	}

	if (result.naked.includes("sasl")) {
		// The AUTHENTICATE opener was pipelined behind the REQ (caps.ts);
		// without the cap it goes nowhere, so end negotiation ourselves.
		client.abortSasl(t("connect.saslReason.capRefused"));
	}

	if (result.errorCode === "MISSING_CAPS") {
		// The cap names are the server's own words: a verbatim value inside
		// the translated frame.
		client.pushMessage(
			client.lobby,
			{
				type: MessageType.ERROR,
				text: t("error.missingCaps", {caps: result.missingRequired.join(" ")}),
			},
			true
		);
	}
};

export default {CAP: cap};
