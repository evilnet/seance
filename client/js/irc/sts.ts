/**
 * IRCv3 STS (strict transport security), https://ircv3.net/specs/extensions/sts
 *
 * The server advertises `sts=port=N,duration=S[,preload]` in `CAP LS`. On a
 * plain (`ws://`) connection the client must drop the connection and come
 * back over TLS on `port`; on a secure connection it caches a policy for the
 * host for `duration` seconds (0 = forget it). While a policy is cached every
 * later connect to that host is upgraded to `wss://` on the policy's port —
 * which is the secure port the policy was learned on, since `port=` is
 * ignored over a secure connection.
 *
 * Policies live in localStorage under `thelounge.sts` as a map keyed by the
 * lower-cased host name. No DOM access beyond the localStorage wrapper, so
 * this runs under mocha (tests stub the wrapper).
 */

import storage from "../localStorage";
import {hostnameOf} from "./saved-networks";
import type {ConnectOptions} from "./types";

export const STORAGE_KEY = "thelounge.sts";
/**
 * localStorage key: host → how many times a `duration=0` removed its policy.
 * A connection's own copy of the policy ({@link HeldPolicy}) is good for the
 * close's reschedule only while this count is what it was when the copy was
 * taken: a removal since, by any connection or tab, retires every copy taken
 * before it, whatever was learned for the host after.
 */
export const REMOVED_KEY = "thelounge.stsRemovals";

/** A cached persistence policy for one host. */
export interface StsPolicy {
	/** The wss:// port to connect to. */
	port: number;
	/** Epoch ms after which the policy no longer applies. */
	expiresAt: number;
	/** The server opted into STS preload lists. */
	preload: boolean;
	/** Policy lifetime in seconds, kept so the expiry can be rescheduled on disconnect. */
	duration?: number;
}

/** The parsed `sts` CAP value. */
export interface StsValue {
	port?: number;
	duration?: number;
	preload: boolean;
}

/** What {@link upgradeOptions} changed, for the caller's log line. */
export interface StsUpgrade {
	port: number;
	tls: true;
}

/** Storage key for `host`: bare host name, lower-cased. */
export function policyHost(host: string): string {
	return hostnameOf(host).toLowerCase();
}

/**
 * The host name STS policies are stored under for a connection: the host for
 * WebSocket, `tcp:host` for IRC over TCP — the two reach one server on
 * different secure ports, so a policy learned on one says nothing about the
 * other's port.
 */
export function stsHost(opts: Pick<ConnectOptions, "host" | "transport">): string {
	return opts.transport === "tcp" ? `tcp:${hostnameOf(opts.host)}` : opts.host;
}

/** Parse `port=6697,duration=300,preload`; unknown keys ignored, bad numbers dropped. */
export function parseStsValue(value: string): StsValue {
	const result: StsValue = {preload: false};

	for (const token of value.split(",")) {
		const eq = token.indexOf("=");
		const key = (eq === -1 ? token : token.slice(0, eq)).trim().toLowerCase();
		const val = eq === -1 ? "" : token.slice(eq + 1).trim();

		switch (key) {
			case "port": {
				const port = /^\d+$/.test(val) ? parseInt(val, 10) : NaN;

				if (port > 0 && port <= 65535) {
					result.port = port;
				}

				break;
			}

			case "duration": {
				const duration = /^\d+$/.test(val) ? parseInt(val, 10) : NaN;

				if (Number.isFinite(duration)) {
					result.duration = duration;
				}

				break;
			}

			case "preload":
				result.preload = true;
				break;
			default:
				break;
		}
	}

	return result;
}

// --------------------------------------------------------------- storage

type PolicyMap = Record<string, StsPolicy>;

function isPolicy(value: unknown): value is StsPolicy {
	if (!value || typeof value !== "object") {
		return false;
	}

	const p = value as Record<string, unknown>;
	return (
		typeof p.port === "number" &&
		Number.isInteger(p.port) &&
		p.port > 0 &&
		p.port <= 65535 &&
		typeof p.expiresAt === "number" &&
		Number.isFinite(p.expiresAt)
	);
}

function read(): PolicyMap {
	let parsed: unknown;

	try {
		const raw = storage.get(STORAGE_KEY);
		parsed = raw ? JSON.parse(raw) : {};
	} catch (e) {
		storage.remove(STORAGE_KEY);
		return {};
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}

	const result: PolicyMap = {};

	for (const [host, entry] of Object.entries(parsed as Record<string, unknown>)) {
		if (isPolicy(entry)) {
			result[host] = {
				port: entry.port,
				expiresAt: entry.expiresAt,
				preload: entry.preload === true,
				...(typeof entry.duration === "number" ? {duration: entry.duration} : {}),
			};
		}
	}

	return result;
}

function write(policies: PolicyMap): void {
	if (Object.keys(policies).length === 0) {
		storage.remove(STORAGE_KEY);
	} else {
		storage.set(STORAGE_KEY, JSON.stringify(policies));
	}
}

function prune(policies: PolicyMap, now: number): PolicyMap {
	const kept: PolicyMap = {};

	for (const [host, policy] of Object.entries(policies)) {
		if (policy.expiresAt > now) {
			kept[host] = policy;
		}
	}

	return kept;
}

/** The unexpired policy for `host`, if any. */
export function getPolicy(host: string, now: number = Date.now()): StsPolicy | undefined {
	const policy = read()[policyHost(host)];
	return policy && policy.expiresAt > now ? policy : undefined;
}

/** Store (or replace) the policy for `host`; an already-expired one deletes it. */
export function setPolicy(host: string, policy: StsPolicy, now: number = Date.now()): void {
	const policies = prune(read(), now);
	const key = policyHost(host);

	if (policy.expiresAt > now) {
		policies[key] = {...policy};
	} else {
		delete policies[key];
	}

	write(policies);
}

/**
 * Remove the policy for `host`, counting the removal first: a close that
 * runs in between still finds the policy stored and reschedules that.
 */
export function deletePolicy(host: string): void {
	const key = policyHost(host);
	const removed = readRemoved();
	writeRemoved({...removed, [key]: (removed[key] ?? 0) + 1});

	const policies = read();
	delete policies[key];
	write(policies);
}

/** A connection's own copy of its host's policy, and the removals counted when it was taken. */
export interface HeldPolicy {
	policy: StsPolicy;
	removals: number;
}

/** Take a copy of `policy` for a connection to `host` (none without a policy). */
export function holdPolicy(host: string, policy: StsPolicy | undefined): HeldPolicy | undefined {
	return policy && {policy, removals: readRemoved()[policyHost(host)] ?? 0};
}

function readRemoved(): Record<string, number> {
	const result: Record<string, number> = {};

	try {
		const parsed: unknown = JSON.parse(storage.get(REMOVED_KEY) ?? "{}");

		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			for (const [host, count] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof count === "number" && Number.isFinite(count)) {
					result[host] = count;
				}
			}
		}
	} catch (e) {
		storage.remove(REMOVED_KEY);
	}

	return result;
}

function writeRemoved(removed: Record<string, number>): void {
	storage.set(REMOVED_KEY, JSON.stringify(removed));
}

/** Drop every expired policy. */
export function clearExpired(now: number = Date.now()): void {
	write(prune(read(), now));
}

/** Every stored, unexpired policy keyed by host (for diagnostics / tests). */
export function allPolicies(now: number = Date.now()): Record<string, StsPolicy> {
	return prune(read(), now);
}

/**
 * Apply a `duration` learned on a secure connection: `0` (or a policy that is
 * already expired) removes the policy. `port` is the secure port we are on.
 */
export function applyDuration(
	host: string,
	port: number,
	value: StsValue,
	now: number = Date.now()
): StsPolicy | undefined {
	if (value.duration === undefined) {
		return undefined;
	}

	if (value.duration === 0) {
		deletePolicy(host);
		return undefined;
	}

	const policy: StsPolicy = {
		port,
		expiresAt: now + value.duration * 1000,
		preload: value.preload,
		duration: value.duration,
	};
	setPolicy(host, policy, now);
	return policy;
}

/**
 * The spec asks clients to reschedule the expiry when a secure connection
 * closes (`now + duration`), so a long-lived connection does not outlive its
 * policy — also when the expiry passed during the connection, so the stored
 * policy is read whether or not it has expired (sts.md "Rescheduling expiry
 * on disconnect"). The caller makes sure a connection did open, and may
 * pass the policy as the connection knows it, for when the stored one was
 * pruned meanwhile — not when a `duration=0` removed it since the copy was
 * taken ({@link REMOVED_KEY}). No-op without a duration.
 */
export function refreshPolicy(host: string, held?: HeldPolicy, now: number = Date.now()): void {
	const key = policyHost(host);
	const policy =
		read()[key] ??
		(held && held.removals === (readRemoved()[key] ?? 0) ? held.policy : undefined);

	if (policy && policy.duration !== undefined && policy.duration > 0) {
		setPolicy(host, {...policy, expiresAt: now + policy.duration * 1000}, now);
	}
}

/**
 * Upgrade plain connect options to TLS when a valid policy exists for the
 * host. Returns the very same object when nothing changes, so callers can
 * test `upgraded !== opts` to know an upgrade was applied.
 */
export function upgradeOptions<T extends ConnectOptions>(opts: T, now: number = Date.now()): T {
	if (opts.tls) {
		return opts;
	}

	const policy = getPolicy(stsHost(opts), now);

	if (!policy) {
		return opts;
	}

	return {...opts, tls: true, port: policy.port};
}
