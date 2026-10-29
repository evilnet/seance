/**
 * Turns a transport close into user-readable feedback. Browsers deliberately
 * hide *why* a WebSocket failed (no error text, close code 1006 for refused,
 * unreachable, TLS and mixed-content failures alike, so pages cannot probe the
 * local network) — but the client knows how far the attempt got and what kind
 * of URL it was dialling, which is enough to say something useful.
 *
 * Store/DOM-free (runs under mocha); the caller passes the page protocol in.
 */

import {t} from "../i18n/core";

/** How far the connection got before it closed. */
export type ClosePhase = "connecting" | "registering" | "registered";

export interface CloseContext {
	/** The WebSocket URL that was dialled, e.g. `wss://irc.example.org:8443/`. */
	url: string;
	/** Host as the user typed it, for the headline. */
	host: string;
	phase: ClosePhase;
	code: number;
	/** Server-supplied close reason, usually empty. */
	reason: string;
	/** Last transport error text; browsers only ever say "WebSocket error". */
	errorMessage?: string;
	/** `location.protocol` when running in a browser (`"https:"`, `"http:"`). */
	pageProtocol?: string;
	willReconnect: boolean;
}

export interface CloseReport {
	/** The headline, pushed as an error message. */
	text: string;
	/** Optional follow-up line explaining likely causes / what to try. */
	hint?: string;
}

/** RFC 6455 close codes worth spelling out instead of "(code N)". Resolvers
 * keep every t() call a plain literal (the pot ↔ call-site scanner only sees
 * direct calls). */
const CLOSE_CODES: Record<number, () => string> = {
	1001: () => t("disconnect.code1001"),
	1002: () => t("disconnect.code1002"),
	1006: () => t("disconnect.code1006"),
	1008: () => t("disconnect.code1008"),
	1009: () => t("disconnect.code1009"),
	1011: () => t("disconnect.code1011"),
	1012: () => t("disconnect.code1012"),
	1013: () => t("disconnect.code1013"),
	1015: () => t("disconnect.code1015"),
};

/** `(reason)` / `(connection lost)` / `(code 4000)` — or "" for a clean 1000. */
function closeDetail(code: number, reason: string): string {
	if (reason) {
		return ` (${reason})`;
	}

	if (code === 1000) {
		return "";
	}

	const name = CLOSE_CODES[code]?.();
	return name ? ` (${name})` : ` (${t("disconnect.codeUnknown", {code})})`;
}

/** True when the transport error text says more than the browser's stock event. */
function informative(message: string | undefined): message is string {
	return message !== undefined && message.length > 0 && message !== "WebSocket error";
}

export function describeClose(ctx: CloseContext): CloseReport {
	// The "not reconnecting" clause is part of the sentence, not an appended
	// fragment: each base phrase carries a whole-sentence variant, so word
	// order stays the translator's.
	const retrying = ctx.willReconnect;

	if (ctx.phase === "connecting") {
		// The socket never opened: the browser knows why but will not tell us.
		const error = informative(ctx.errorMessage) ? ` (${ctx.errorMessage})` : "";
		const vars = {url: ctx.url, error};
		const text = retrying
			? t("disconnect.couldNotConnect", vars)
			: t("disconnect.couldNotConnectNotReconnecting", vars);
		const secure = ctx.url.startsWith("wss:");

		if (!secure && ctx.pageProtocol === "https:") {
			return {
				text,
				hint: t("disconnect.hint.httpsBlocked"),
			};
		}

		if (secure) {
			return {
				text,
				hint: t("disconnect.hint.wssCauses", {
					url: ctx.url.replace(/^wss:/, "https:"),
				}),
			};
		}

		return {
			text,
			hint: t("disconnect.hint.plainCauses"),
		};
	}

	if (ctx.phase === "registering") {
		// The server refuses a second connection for an account that already
		// has one: its close reason says so, and retrying alone cannot fix it
		// - the other client has to go (or die and be reclaimed, ~1 minute
		// with the proxy's keepalive). Say that instead of the generic hint.
		const sessionConflict = /active session/i.test(ctx.reason);
		const vars = {host: ctx.host, detail: closeDetail(ctx.code, ctx.reason)};

		return {
			text: retrying
				? t("disconnect.registeringClosed", vars)
				: t("disconnect.registeringClosedNotReconnecting", vars),
			hint: sessionConflict
				? t("disconnect.hint.sessionConflict")
				: t("disconnect.hint.registration"),
		};
	}

	return {
		text: retrying
			? t("disconnect.disconnected", {
					host: ctx.host,
					detail: closeDetail(ctx.code, ctx.reason),
			  })
			: t("disconnect.disconnectedNotReconnecting", {
					host: ctx.host,
					detail: closeDetail(ctx.code, ctx.reason),
			  }),
	};
}
