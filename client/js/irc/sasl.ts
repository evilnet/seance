/**
 * SASL authentication (IRCv3 `sasl` cap): PLAIN, with an untested EXTERNAL
 * stub. Runs between `CAP ACK` and `CAP END` during registration.
 *
 * {@link SaslAuth} is a pure state machine like {@link CapNegotiator}: it does
 * no I/O and owns no timers. The intended sequence is
 *
 *   1. send `start()`                  -> `AUTHENTICATE PLAIN`
 *   2. feed every `AUTHENTICATE` line and 900-908 numeric to `handle()`,
 *      sending back `.send` (the base64 credentials in 400-byte chunks
 *      after the server's `AUTHENTICATE +`)
 *   3. once `.done` is set, `.ok` says whether 903 (success) or one of
 *      902/904-907 (failure) arrived; `.error` carries the server's text
 *   4. if nothing arrives in time call `abort()` and send its lines
 *      (`AUTHENTICATE *`)
 *
 * Base64 uses `btoa` over a UTF-8 binary string so it works in the browser
 * (no `Buffer`). EXTERNAL needs a client certificate on the TLS session, which
 * a browser WebSocket cannot present, so it is unusable in Seance for now.
 */

import {t} from "../i18n/core";
import type {IrcMessage} from "./message";

export type SaslMechanism = "PLAIN" | "EXTERNAL";

export interface SaslCredentials {
	account: string;
	password: string;
}

export interface SaslResult {
	/** Lines to send, in order. */
	send: string[];
	/** True once the exchange has ended (success, failure or abort). */
	done: boolean;
	/** Meaningful once `done`: whether the server reported success (903). */
	ok: boolean;
	/** The server's text on failure / abort (without the "SASL ... failed:" prefix). */
	error?: string;
	/** Informational text worth showing (900, 908). */
	info?: string;
}

/** Maximum payload per `AUTHENTICATE` line, per the IRCv3 SASL spec. */
export const SASL_CHUNK_BYTES = 400;

/**
 * How long to wait for the server before aborting with `AUTHENTICATE *`.
 * nefarious2 gives up on its own after 10s when services do not answer
 * (`904 :SASL authentication failed: request timed out`); this backstop is
 * a little longer so the server's more descriptive numeric wins.
 */
export const SASL_TIMEOUT_MS = 12_000;

export const RPL_LOGGEDIN = "900";
export const RPL_LOGGEDOUT = "901";
export const ERR_NICKLOCKED = "902";
export const RPL_SASLSUCCESS = "903";
export const ERR_SASLFAIL = "904";
export const ERR_SASLTOOLONG = "905";
export const ERR_SASLABORTED = "906";
export const ERR_SASLALREADY = "907";
export const RPL_SASLMECHS = "908";

/** Numerics that end the exchange unsuccessfully. */
const FAILURE_NUMERICS: ReadonlySet<string> = new Set([
	ERR_NICKLOCKED,
	ERR_SASLFAIL,
	ERR_SASLTOOLONG,
	ERR_SASLABORTED,
	ERR_SASLALREADY,
]);

/** Base64 of the UTF-8 encoding of `str`, using only browser globals. */
export function base64Encode(str: string): string {
	const bytes = new TextEncoder().encode(str);
	let binary = "";

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary);
}

/** The PLAIN response: base64(`authzid NUL authcid NUL password`). */
export function encodePlain(account: string, password: string, authzid = account): string {
	return base64Encode(`${authzid}\0${account}\0${password}`);
}

/**
 * Split a base64 payload into `AUTHENTICATE` lines of at most 400 bytes,
 * ending with `AUTHENTICATE +` when the last chunk is exactly 400 bytes
 * (or the payload is empty), so the server knows the response is complete.
 */
export function chunkAuthenticate(payload: string): string[] {
	const lines: string[] = [];

	for (let i = 0; i < payload.length; i += SASL_CHUNK_BYTES) {
		lines.push(`AUTHENTICATE ${payload.slice(i, i + SASL_CHUNK_BYTES)}`);
	}

	if (payload.length % SASL_CHUNK_BYTES === 0) {
		lines.push("AUTHENTICATE +");
	}

	return lines;
}

/** Whether `mechanism` may be used given a CAP 302 `sasl=` value (empty = no info). */
export function mechanismOffered(mechanism: SaslMechanism, capValue: string | undefined): boolean {
	if (capValue === undefined) {
		return false;
	}

	if (capValue === "") {
		return true;
	}

	return capValue.split(",").some((m) => m.toUpperCase() === mechanism);
}

type Phase = "idle" | "challenge" | "result" | "done";

export class SaslAuth {
	readonly mechanism: SaslMechanism;
	private readonly payload: string;
	private phase: Phase = "idle";

	constructor(
		mechanism: SaslMechanism,
		credentials: SaslCredentials = {account: "", password: ""}
	) {
		this.mechanism = mechanism;
		this.payload =
			mechanism === "PLAIN" ? encodePlain(credentials.account, credentials.password) : "";
	}

	get done(): boolean {
		return this.phase === "done";
	}

	/** Lines that open the exchange. */
	start(): string[] {
		this.phase = "challenge";
		return [`AUTHENTICATE ${this.mechanism}`];
	}

	/** Give up (timeout): tell the server and finish as a failure. */
	abort(reason = t("connect.saslReason.timeout")): SaslResult {
		if (this.phase === "done") {
			return this.result([], false);
		}

		const send = this.phase === "idle" ? [] : ["AUTHENTICATE *"];
		this.phase = "done";
		return {send, done: true, ok: false, error: reason};
	}

	/** Process one incoming message. Unrelated messages are ignored. */
	handle(msg: IrcMessage): SaslResult {
		if (this.phase === "done") {
			return this.result([], false);
		}

		if (msg.command === "AUTHENTICATE") {
			return this.onAuthenticate(msg);
		}

		const text = msg.params[msg.params.length - 1] ?? "";

		switch (msg.command) {
			case RPL_LOGGEDIN:
				return {send: [], done: false, ok: false, info: text};
			case RPL_SASLMECHS:
				return {
					send: [],
					done: false,
					ok: false,
					info: t("connect.saslMechanisms", {mechanisms: msg.params[1] ?? ""}),
				};
			case RPL_SASLSUCCESS:
				this.phase = "done";
				return {send: [], done: true, ok: true, info: text};
			default:
				break;
		}

		if (FAILURE_NUMERICS.has(msg.command)) {
			this.phase = "done";
			return {
				send: [],
				done: true,
				ok: false,
				error: text || t("connect.saslReason.numeric", {code: msg.command}),
			};
		}

		return this.result([], false);
	}

	private onAuthenticate(msg: IrcMessage): SaslResult {
		if (this.phase !== "challenge") {
			// Nothing more to say once our response is out; wait for the numeric.
			return this.result([], false);
		}

		// PLAIN and EXTERNAL both expect an empty challenge (`+`). Anything
		// else is a server we do not understand; abort rather than hang.
		if (msg.params[0] !== "+") {
			this.phase = "done";
			return {
				send: ["AUTHENTICATE *"],
				done: true,
				ok: false,
				error: t("connect.saslReason.badChallenge", {mechanism: this.mechanism}),
			};
		}

		this.phase = "result";
		return this.result(chunkAuthenticate(this.payload), false);
	}

	private result(send: string[], ok: boolean): SaslResult {
		return {send, done: this.phase === "done", ok};
	}
}
