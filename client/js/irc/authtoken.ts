/**
 * IRCv3 `draft/authtoken` (ircv3-specifications PR #602) and the
 * `draft/FILEHOST` ISUPPORT token (PR #562).
 *
 * The network runs an upload host; the ircd advertises its URL in ISUPPORT
 * and hands out short-lived, single-use tokens for it on request
 * (`TOKEN GENERATE FILEHOST [#channel]` → `TOKEN GENERATE FILEHOST :<token>`).
 * The client POSTs the file to that URL with the token as
 * `Authorization: Bearer` and the host answers `201 Created` + `Location`.
 * No password ever leaves the IRC connection.
 *
 * This file is Vue-free: the request queue and the ISUPPORT reading are
 * tested under mocha (`test/irc/authtoken.ts`). The TOKEN handler
 * (`handlers/token.ts`) and `FAIL TOKEN` (`handlers/standard-replies.ts`)
 * feed the queue; `upload.ts` consumes it through `IrcClient.generateToken`.
 */

import type {ISupport} from "./isupport";

export const AUTHTOKEN_CAP = "draft/authtoken";
export const AUTHTOKEN_BATCH = "draft/authtoken";
/** The spec-defined service key for the upload host. */
export const FILEHOST_SERVICE = "FILEHOST";
/** ISUPPORT tokens naming the upload host: the draft's, then soju's spelling. */
export const FILEHOST_ISUPPORT = ["draft/FILEHOST", "soju.im/FILEHOST"];

/** How long a `TOKEN GENERATE` may take before the upload gives up. */
export const TOKEN_TIMEOUT_MS = 15_000;

/**
 * The upload URL the server advertises, or undefined when there is none or
 * it cannot be used: only `http(s)` schemes, and — as the draft requires —
 * no plain `http` when the IRC connection itself is encrypted.
 */
export function filehostUrlOf(isupport: ISupport, secure: boolean): string | undefined {
	for (const token of FILEHOST_ISUPPORT) {
		const value = isupport.get(token);

		if (!value) {
			continue;
		}

		let url: URL;

		try {
			url = new URL(value);
		} catch (e) {
			continue;
		}

		if (url.protocol === "https:" || (url.protocol === "http:" && !secure)) {
			return url.toString();
		}
	}

	return undefined;
}

export class TokenError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = "TokenError";
	}
}

interface PendingToken {
	service: string;
	resolve: (token: string) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Outstanding `TOKEN GENERATE` requests, answered in order per service: the
 * server has no label on the reply, so the oldest request for that service
 * takes the next `TOKEN GENERATE <service> :<token>` (or the joined chunks
 * of a `draft/authtoken` batch) and the next `FAIL TOKEN …`.
 */
export class TokenRequests {
	private pending: PendingToken[] = [];
	private readonly timeoutMs: number;

	constructor(timeoutMs = TOKEN_TIMEOUT_MS) {
		this.timeoutMs = timeoutMs;
	}

	get size(): number {
		return this.pending.length;
	}

	/** Enqueue a request; `send` puts the line on the wire. */
	request(service: string, send: () => void): Promise<string> {
		return new Promise((resolve, reject) => {
			const entry: PendingToken = {
				service: service.toLowerCase(),
				resolve,
				reject,
				timer: setTimeout(() => {
					this.remove(entry);
					reject(
						new TokenError("The server did not answer the token request", "TIMEOUT")
					);
				}, this.timeoutMs),
			};
			this.pending.push(entry);
			send();
		});
	}

	/** A `TOKEN GENERATE <service> :<token>` reply (already joined when batched). */
	deliver(service: string, token: string): boolean {
		const entry = this.take(service);

		if (!entry) {
			return false;
		}

		entry.resolve(token);
		return true;
	}

	/**
	 * A `FAIL TOKEN <code> [context] :text`. The FAIL does not name the
	 * service for most codes, so it answers the oldest request of any
	 * service — the server answers in order, so that is the right one.
	 * Returns whether a request was waiting.
	 */
	fail(code: string, description: string): boolean {
		const entry = this.pending.shift();

		if (!entry) {
			return false;
		}

		clearTimeout(entry.timer);
		entry.reject(new TokenError(description || `Token request failed (${code})`, code));
		return true;
	}

	/** Reject everything (connection closed). */
	clear(reason = "Disconnected"): void {
		for (const entry of this.pending.splice(0)) {
			clearTimeout(entry.timer);
			entry.reject(new TokenError(reason, "DISCONNECTED"));
		}
	}

	private take(service: string): PendingToken | undefined {
		const key = service.toLowerCase();
		const index = this.pending.findIndex((entry) => entry.service === key);

		if (index === -1) {
			return undefined;
		}

		const [entry] = this.pending.splice(index, 1);
		clearTimeout(entry.timer);
		return entry;
	}

	private remove(entry: PendingToken): void {
		const index = this.pending.indexOf(entry);

		if (index !== -1) {
			this.pending.splice(index, 1);
		}
	}
}
