/**
 * The dial ledger: this device's own record of when it dialled each server
 * and when its connections dropped, so the transport does not dial into
 * nefarious2's connection throttle (as far as this device can know: other
 * devices behind the same address count on the server too and are not seen).
 *
 * IPcheck (`ircd/IPcheck.c` `ip_registry_check_local`, at accept time, before
 * TLS or the WebSocket upgrade) counts the connections from an address: the
 * count restarts after a gap of more than `IPCHECK_CLONE_PERIOD` (40 s) since
 * `last_connect`, and the connection that brings it to `IPCHECK_CLONE_LIMIT`
 * (4) is refused — and a refused one still counts as the last connection, so
 * dialling into a refusal renews it. `last_connect` also moves when the
 * address's last connection closes (`ip_registry_disconnect`), which resets
 * the count only when that is more than four windows after it — but not when
 * the bouncer holds the session (`bounce_hold_client` never calls
 * `IPcheck_disconnect`), so the client records a drop only for a session that
 * is not held (`IrcClient.createTransport`, `noteUnload` for the unload the
 * transport never sees). Counted at the accept, a dial that never opened
 * drops too: the transport records the end of every dial. The server counts whole seconds (`CurrentTime`) on
 * a clock a fraction of a second from this one, so the replay works in
 * milliseconds with a whole second and a margin to spare (`throttleWaitMs`).
 * Over a WebSocket a refusal looks like any lost connection (1006). A phone
 * whose OS drops the socket on every app switch makes a new connection on
 * every return; the fourth return inside the chain was refused, and the
 * reconnect schedule's quick retries (0, 1, 2, 4 s …) each renewed it, a
 * lockout of a minute or more. With the ledger the transport waits out the
 * gap instead: one wait of at most 42 s (docs/projects/reconnect-throttle.md).
 *
 * A server with nefarious2's `IPCHECK_SASL_REFUND` gives a connection that
 * logged in with SASL its attempt back when it registers (`attempts` down by
 * one, never below one, the window untouched), at most `limit` times per
 * account in a period — and only when it lowers the count: a connection
 * the chain already counts as its first gives nothing back and spends none
 * of the budget. The deploy says so for its own server
 * (`defaultNetwork.ipcheckRefund`, `ThrottleRule.refund`), and the client
 * records a refund at 001 when this connection's SASL succeeded
 * (`DialLedger.refunded`); the replay mirrors the cap over this device's own
 * refunds, more strictly than the server keeps it (`replay`), and another
 * device's draw on the account's budget is not seen. Under a rule without
 * `refund` a refund is neither kept nor counted.
 *
 * Kept in `thelounge.state.dials` (`{host: {d: [dial ms…], c: [drop ms…],
 * r: [refund ms…]}}`), so a reloaded or reopened app and another tab see the
 * same record. Vue-free and DOM-free; tests: test/irc/dialLedger.ts.
 */

import storage from "../localStorage";
import {recordReader} from "../helpers/jsonRecord";

/** nefarious2's `IPCHECK_SASL_REFUND` and `_PERIOD`: refunds per account per period. */
export interface RefundRule {
	limit: number;
	periodMs: number;
}

export interface ThrottleRule {
	/** The connection that brings the count to this is refused. */
	limit: number;
	/** A gap longer than this restarts the count. */
	periodMs: number;
	/** Added to a wait: the dial takes a while to reach the server. */
	marginMs: number;
	/**
	 * The server gives a SASL login its attempt back (`IPCHECK_SASL_REFUND`):
	 * at most `limit` refunds per account in `periodMs`. Absent: it does not.
	 */
	refund?: RefundRule;
}

/** nefarious2's defaults (`ircd_features.c`); refunds are off there. */
export const NEFARIOUS_RULE: ThrottleRule = {limit: 4, periodMs: 40_000, marginMs: 1_000};

export interface DialGate {
	/** How long to wait before a dial at `now` would be accepted; 0 = dial now. */
	waitMs(now: number): number;
	/** A dial was made at `at`. */
	record(at: number): void;
	/** A socket that had opened closed at `at`. */
	closed(at: number): void;
}

/** The gate, and what only the client above the transport knows. */
export interface DialLedger extends DialGate {
	/**
	 * The connection registered at `at` after a SASL login: the server gave
	 * the dial's attempt back. Kept only under a rule with `refund`.
	 */
	refunded(at: number): void;
}

export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

interface HostRecord {
	d: number[];
	c: number[];
	r: number[];
}

const STORAGE_KEY = "thelounge.state.dials";
let backend: StorageBackend = storage;
const readRecord = recordReader<unknown>();

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

interface Replay {
	attempts: number;
	/** The newest dial or close the replay saw. */
	last: number | undefined;
	/** The dial or close at which the count last started over (the chain's first event). */
	start: number | undefined;
}

/**
 * Replay the server's count over this device's dials (and the drops of its
 * sockets, and the refunds its logins earned) up to `now`. IPcheck compares
 * whole seconds, and the two clocks are a fraction of a second apart, so the
 * replay is conservative in milliseconds: a gap restarts the count only when
 * it is at least a whole second past the window plus the margin (42 s; 162 s
 * after a drop). Events dated after `now` (a clock that has since gone back)
 * say nothing about now.
 *
 * A refund lowers the count by one and moves nothing else, and only when the
 * count is above one — below that the server gives nothing back and spends
 * none of the account's budget (`IPcheck_login_refund`). The budget is
 * mirrored more strictly than the server keeps it: a refund is honoured only
 * when fewer than `refund.limit` refunds that would have lowered the count,
 * honoured or not, fall in the `refund.periodMs` before it (the server
 * counts the ones it granted in a fixed window from the first; this device's
 * count never runs below the server's, so every refund the server granted is
 * among those, and the replay never honours one the server refused). A
 * refund older than every dial and close in the record is counted as spent:
 * the record no longer says what it did.
 */
function replay(
	dials: readonly number[],
	now: number,
	rule: ThrottleRule,
	closes: readonly number[],
	refunds: readonly number[]
): Replay {
	const gap = rule.periodMs + 1000 + rule.marginMs;
	const dropGap = rule.limit * rule.periodMs + 1000 + rule.marginMs;
	// At one instant a close comes first, then the dial, then its refund.
	const events = [
		...closes.filter((at) => at <= now).map((at) => ({at, kind: 0})),
		...dials.filter((at) => at <= now).map((at) => ({at, kind: 1})),
		...(rule.refund ? refunds.filter((at) => at <= now).map((at) => ({at, kind: 2})) : []),
	].sort((a, b) => a.at - b.at || a.kind - b.kind);
	let attempts = 0;
	let last: number | undefined;
	let start: number | undefined;
	// The refunds that lowered the count or would have, newest last.
	const spent: number[] = [];

	for (const {at, kind} of events) {
		if (kind === 2) {
			const refund = rule.refund as RefundRule;

			if (last === undefined) {
				spent.push(at);
			} else if (attempts > 1) {
				const inWindow = spent.filter((t) => at - t < refund.periodMs).length;
				spent.push(at);

				if (inWindow < refund.limit) {
					attempts--;
				}
			}

			continue;
		}

		const since = last === undefined ? Infinity : at - last;

		if (kind === 1) {
			if (since >= gap) {
				attempts = 0;
				start = at;
			}

			attempts++;
		} else if (since >= dropGap) {
			attempts = 0;
			start = at;
		}

		last = at;
	}

	return {attempts, last, start};
}

/**
 * The wait before a dial at `now` would get in: the server refuses the
 * connection that brings the count to `rule.limit` unless the gap since the
 * last dial or close has passed (`replay`).
 */
export function throttleWaitMs(
	dials: readonly number[],
	now: number,
	rule: ThrottleRule,
	closes: readonly number[] = [],
	refunds: readonly number[] = []
): number {
	const gap = rule.periodMs + 1000 + rule.marginMs;
	const {attempts, last} = replay(dials, now, rule, closes, refunds);

	if (last === undefined || now - last >= gap || attempts + 1 < rule.limit) {
		return 0;
	}

	return last + gap - now;
}

/** At most this many of each kind of event are kept per host, newest first. */
const MAX_EVENTS = 200;

function hostRecord(value: unknown): HostRecord {
	const numbers = (list: unknown): number[] =>
		Array.isArray(list) ? list.filter((t): t is number => typeof t === "number") : [];
	const record = value as Partial<HostRecord> | null;
	return {d: numbers(record?.d), c: numbers(record?.c), r: numbers(record?.r)};
}

/** The ledger for one server host, over the shared record. */
export function dialGateFor(host: string, rule: ThrottleRule = NEFARIOUS_RULE): DialLedger {
	const key = host.toLowerCase();
	const read = () => hostRecord(readRecord(backend.get(STORAGE_KEY))[key]);

	const add = (at: number, field: keyof HostRecord) => {
		const record = read();
		record[field] = [...record[field], at];
		// What came before the chain's first event no longer counts — but a
		// chain can run long (a drop restarts nothing within 162 s, a refund
		// lets a dial in), so the horizon is where the replay last started
		// over, not a fixed age; the refunds are kept a refund period further
		// back, since a refund's honour depends on the ones before it.
		const {start} = replay(record.d, Infinity, rule, record.c, record.r);
		const horizon = start ?? at;
		const refundHorizon = horizon - (rule.refund?.periodMs ?? 0);
		const keep = (list: number[], from: number) =>
			list.filter((t) => t >= from).slice(-MAX_EVENTS);
		const all = {...readRecord(backend.get(STORAGE_KEY))};
		all[key] = {
			d: keep(record.d, horizon),
			c: keep(record.c, horizon),
			r: rule.refund ? keep(record.r, refundHorizon) : [],
		};
		backend.set(STORAGE_KEY, JSON.stringify(all));
	};

	return {
		waitMs(now) {
			const record = read();
			return throttleWaitMs(record.d, now, rule, record.c, record.r);
		},
		record: (at) => add(at, "d"),
		closed: (at) => add(at, "c"),
		refunded(at) {
			if (rule.refund) {
				add(at, "r");
			}
		},
	};
}
