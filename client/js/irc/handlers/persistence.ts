/**
 * `PERSISTENCE` replies (draft/persistence, see ../persistence.ts):
 *
 *   :server PERSISTENCE STATUS <client-setting> <effective>
 *        — `ON|OFF|DEFAULT` (what the user asked for) then `ON|OFF` (what
 *          the server will actually do). Sent unsolicited between 005 and
 *          the MOTD end, after a SET, and for `/persistence status`.
 *          nefarious2 sent the effective state alone before 7a47da1, so
 *          the effective state is read as the *last* parameter.
 *   :server PERSISTENCE SET ON|OFF|DEFAULT      (the ack; a STATUS follows)
 *   :server PERSISTENCE REPLAY STATUS <client-setting> <effective>
 *   :server PERSISTENCE ATTACH <profile>        (the ack of our ATTACH)
 *   :server PERSISTENCE DETACH|PROFILE …
 *
 *   :server PERSISTENCE SESSION <sessid> <state> <nick> <channels> :<info>
 *   :server PERSISTENCE ENDOFLIST              (the close of a LIST)
 *   :server PERSISTENCE DETACH OK|NOSESSION    (the ack of our force-logout)
 *
 * Only the effective state matters to us ({@link IrcClient.persistenceHold},
 * read at the end of registration by ../persistence.ts). The registration
 * line is not shown; anything the user asked for is. The `ATTACH` ack of the
 * catch-up cursor we offered before `CAP END` is silent too — it only says
 * the server will replay the gap itself.
 */

import {t} from "../../i18n/core";
import type {Handler} from "../types";

const persistence: Handler = (client, msg) => {
	const [sub = "", ...rest] = msg.params;
	const what = sub.toUpperCase();

	// `PERSISTENCE LIST` body: SESSION lines accumulate on the client until
	// ENDOFLIST closes the batch, then the whole list goes out as one
	// `persistence:sessions` dispatch (Settings → session panel). These
	// lines never print to the lobby.
	if (what === "SESSION") {
		if (!client.persistenceListBuf) {
			client.persistenceListBuf = [];
		}

		{
			const [sessid = "", state = "", nick = "", channels = ""] = rest;
			const info = rest[rest.length - 1] ?? "";

			client.persistenceListBuf.push({
				sessid,
				state: state.toUpperCase(),
				nick,
				channels: channels === "*" ? [] : channels.split(/[\s,]+/).filter(Boolean),
				info,
			});
		}

		return;
	}

	if (what === "ENDOFLIST") {
		const sessions = client.persistenceListBuf ?? [];

		client.persistenceListBuf = undefined;
		client.dispatch("persistence:sessions", {sessions});
		return;
	}

	if (what === "DETACH") {
		// The ack of the Settings panel's force-logout: the session is gone
		// (STATUS follows and prints the effective OFF there). Report an
		// empty list so the panel refreshes.
		client.persistenceListBuf = undefined;
		client.dispatch("persistence:sessions", {sessions: []});
		return;
	}

	if (what === "STATUS") {
		const effective = (rest[rest.length - 1] ?? "").toUpperCase();
		const setting = rest.length > 1 ? rest[0].toUpperCase() : "";
		client.persistenceHold = effective === "ON";
		client.persistenceSetting = setting || undefined;

		if (client.state === "registering" || client.persistenceAutoSetPending) {
			// The unsolicited line, or the echo of our registration-time
			// SET ON: the user did not ask for either.
			client.persistenceAutoSetPending = false;
			return;
		}

		client.pushMessage(client.lobby, {
			// Two whole sentences, never an appended fragment: the
			// client-setting-differs variant is its own key.
			text:
				setting && setting !== effective
					? t("persistence.statusClientSetting", {state: effective, setting})
					: t("persistence.status", {state: effective}),
		});
		return;
	}

	if (what === "ATTACH" && client.attachCursor !== undefined && client.state === "registering") {
		// Our cursor was taken: the server drives the catch-up from it, so
		// catchup.ts stands down for the channels it restores.
		client.serverReplay = true;
		return;
	}

	if (what === "SET") {
		if (client.state === "registering" || client.persistenceAutoSetPending) {
			return; // our own registration-time auto-enable
		}

		client.pushMessage(client.lobby, {
			text: t("persistence.set", {state: (rest[0] ?? "").toUpperCase()}),
		});
		return;
	}

	client.pushMessage(client.lobby, {text: t("persistence.echo", {params: msg.params.join(" ")})});
};

export default {PERSISTENCE: persistence};
