/**
 * Saved network configs, persisted in localStorage under `thelounge.networks`.
 *
 * TheLounge kept the user's networks in the server-side user file; here the
 * connect form's values are remembered locally so Settings → Networks can
 * manage them. Each entry carries a stable `uuid` (random, generated once)
 * because network settings and sort, mute and collapse preferences are keyed
 * by it (see docs/resources/bus-contract.md §"Store expectations").
 *
 * The SASL and server passwords are only written to disk when
 * `rememberPassword` is set; otherwise `saslPassword` and `serverPassword`
 * are stripped on save and the user is asked again (`hasServerPassword`
 * remembers that there was one to ask for).
 *
 * Kept free of store imports so it runs under mocha; tests swap the storage
 * backend with {@link useStorageBackend}.
 */

import storage from "../localStorage";
import {collator} from "../i18n/collation";
import {forgetNetworkLog} from "./querylog";
import {forgetClosedQueries} from "./closedQueries";
import {forgetNoticeLog} from "./noticelog";
import {forgetOperPrefs} from "./operprefs";
import {forgetMuteMemory} from "./muteMemory";
import {forgetPresenceSync} from "./presenceSync";
import {forgetUserAway} from "./userAwayStore";
import {forgetLogin} from "./saslTrust";
import type {ConnectOptions} from "./types";
import {accountRequired} from "../branding";
import {PRESENCE_MODES, type NetworkMode, type PresenceMode} from "../helpers/dnd";
import type {ServicesConfig} from "../../../shared/types/network";

export const STORAGE_KEY = "thelounge.networks";

/** Channel names per network uuid, in the order the sidebar shows them. */
export const CHANNEL_ORDER_KEY = "thelounge.sort.channels";

/**
 * The newest message the client has shown on a network: the catch-up
 * cursor offered to nefarious2 as `PERSISTENCE ATTACH <profile> <msgid>`
 * (see irc/persistence.ts). It has to survive the page being killed, which
 * is why it lives next to the network rather than in memory.
 */
export interface NetworkCursor {
	msgid: string;
	/** Epoch ms of that message; the newest one wins, whatever order they arrive in. */
	time: number;
}

export type SavedNetwork = ConnectOptions & {
	uuid: string;
	/** Display name; empty means "use the host name / ISUPPORT NETWORK". */
	name: string;
	/** Connect at startup without visiting the connect form. */
	autoconnect?: boolean;
	/** Persist `saslPassword` and `serverPassword`. Off by default so no password hits disk. */
	rememberPassword?: boolean;
	/** A server password is configured, even when it was not kept on disk:
	 * the connect form asks for it again (see {@link needsPassword}). */
	hasServerPassword?: boolean;
	/** Register this device's Web Push subscription with this network
	 * (`draft/webpush`). Entries stored before the flag existed read as
	 * enabled — push was unconditional then. */
	pushEnabled?: boolean;
	/** Show browser notifications (highlights/queries) for this network.
	 * Entries stored before the flag existed read as enabled — browser
	 * notifications were global-on then. Not gated on authentication. */
	notifyEnabled?: boolean;
	/** Slash commands run in the lobby after every registration, one per entry. */
	commands?: string[];
	/** Epoch ms of the last connect; the picker lists most recent first. */
	lastUsed?: number;
	/** Newest message seen on this network (see {@link NetworkCursor}). */
	cursor?: NetworkCursor;
	/**
	 * Services support (docs/projects/oper-tools.md): the package and its
	 * bots by role, set in the edit form once opered. Absent means none.
	 */
	services?: ServicesConfig;
	/** Online / Auto / Away / Do not disturb; absent = Same as global (docs/projects/shared-presence-modes.md §2). */
	presenceMode?: PresenceMode;
	/**
	 * When the user chose `presenceMode` (Unix ms, on the device that chose
	 * it); absent for a mode never chosen. Shared between devices, the most
	 * recent choice winning (docs/projects/shared-presence-modes.md).
	 */
	presenceAt?: number;
};

/** The subset of the localStorage wrapper this module needs. */
export interface StorageBackend {
	get(key: string): string | null;
	set(key: string, value: string): void;
	remove(key: string): void;
}

let backend: StorageBackend = storage;

/** Swap the persistence backend (tests); `null` restores localStorage. */
export function useStorageBackend(next: StorageBackend | null): void {
	backend = next ?? storage;
}

/** The WebSocket ports we suggest: 9998 for wss://, 8067 for ws://. */
export function defaultPort(tls: boolean, transport?: ConnectOptions["transport"]): number {
	if (transport === "tcp") {
		return tls ? 6697 : 6667;
	}

	return tls ? 9998 : 8067;
}

/** `wss://host:port/path` / `host/path` → bare host name, for display. */
export function hostnameOf(host: string): string {
	const stripped = host.trim().replace(/^(?:wss?|https?|ircs?):\/\//i, "");
	const slash = stripped.indexOf("/");
	return slash === -1 ? stripped : stripped.slice(0, slash);
}

/** The name shown for an entry: the custom one, else the host. */
export function displayName(net: Pick<SavedNetwork, "name" | "host">): string {
	return net.name || hostnameOf(net.host) || "IRC";
}

/** A v4 uuid; falls back to `getRandomValues` / `Math.random` on old runtimes. */
export function newUuid(): string {
	const c = typeof globalThis.crypto === "object" ? globalThis.crypto : undefined;

	if (c && typeof c.randomUUID === "function") {
		return c.randomUUID();
	}

	const bytes = new Uint8Array(16);

	if (c && typeof c.getRandomValues === "function") {
		c.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}

	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
		16,
		20
	)}-${hex.slice(20)}`;
}

// ------------------------------------------------------------ normalising

function asString(value: unknown): string {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value).trim()
		: "";
}

/** A hand-edited backup may list its channels: `"join": ["#a", "#b"]`. */
function asJoin(value: unknown): string {
	return Array.isArray(value) ? value.map(asString).filter(Boolean).join(",") : asString(value);
}

/** FormData gives `"on"` for checked boxes and omits unchecked ones. */
function asBoolean(value: unknown): boolean {
	if (typeof value === "boolean") {
		return value;
	}

	const s = asString(value).toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "off";
}

function asPort(value: unknown, tls: boolean, transport?: ConnectOptions["transport"]): number {
	const port = typeof value === "number" ? value : parseInt(asString(value), 10);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultPort(tls, transport);
}

/** A stored / incoming cursor, or undefined when there is nothing usable in it. */
function asCursor(value: unknown): NetworkCursor | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const raw = value as {msgid?: unknown; time?: unknown};
	const msgid = asString(raw.msgid);

	if (!msgid) {
		return undefined;
	}

	const time = typeof raw.time === "number" && Number.isFinite(raw.time) ? raw.time : 0;
	return {msgid, time};
}

/** The services roles, in the order the form shows them. */
export const SERVICE_ROLES = ["oper", "account", "channel", "report", "snoop"] as const;

/** A stored / incoming services block, or undefined when it names no known package. */
export function asServices(value: unknown): ServicesConfig | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const raw = value as {package?: unknown; bots?: unknown};

	if (asString(raw.package).toLowerCase() !== "x3") {
		return undefined;
	}

	const bots =
		raw.bots && typeof raw.bots === "object" ? (raw.bots as Record<string, unknown>) : {};
	const out = {} as ServicesConfig["bots"];

	for (const role of SERVICE_ROLES) {
		out[role] = asString(bots[role]);
	}

	return {package: "x3", bots: out};
}

/** Accepts a newline-separated string (textarea) or an array. */
export function parseCommands(value: unknown): string[] {
	const lines: string[] = Array.isArray(value)
		? value.map((v) => asString(v))
		: asString(value).split(/\r\n|\r|\n/);

	return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * A uuid no network may have. The uuid keys a dozen per-network stores, most
 * of them plain objects — the push subscriptions are a Vue reactive one — and
 * a restored settings file can name any string: `__proto__` or `constructor`
 * there read Object.prototype's members back as the network's entry, and an
 * oper-up wrote `wasOper` onto Object.prototype itself. So nothing every
 * object already answers to, and nothing starting `__` (Vue's proxies answer
 * `__v_raw` and the like). What `newUuid` makes is never either.
 */
function reservedUuid(uuid: string): boolean {
	return uuid in Object.prototype || uuid.startsWith("__");
}

/**
 * Coerce anything shaped like a network (a stored entry, the connect form,
 * the edit form's FormData) into a well-typed {@link SavedNetwork}. Returns
 * `undefined` when there is no usable `uuid`.
 */
export function normalize(raw: Record<string, unknown>): SavedNetwork | undefined {
	const uuid = asString(raw.uuid);

	if (!uuid || reservedUuid(uuid)) {
		return undefined;
	}

	const tls = raw.tls === undefined ? true : asBoolean(raw.tls);
	const sasl = asString(raw.sasl) === "plain" ? "plain" : "";
	const rememberPassword = asBoolean(raw.rememberPassword);
	// Only `tcp` is stored; anything else (the form's `websocket`) is the default.
	const transport = raw.transport === "tcp" ? "tcp" : undefined;
	const net: SavedNetwork = {
		uuid,
		name: asString(raw.name),
		host: asString(raw.host),
		port: asPort(raw.port, tls, transport),
		tls,
		...(transport ? {transport} : {}),
		nick: asString(raw.nick),
		join: asJoin(raw.join),
		sasl,
		saslAccount: sasl ? asString(raw.saslAccount) : "",
		saslPassword: sasl ? asString(raw.saslPassword) : "",
		autoconnect: asBoolean(raw.autoconnect),
		rememberPassword,
		pushEnabled: raw.pushEnabled === undefined ? true : asBoolean(raw.pushEnabled),
		notifyEnabled: raw.notifyEnabled === undefined ? true : asBoolean(raw.notifyEnabled),
		commands: parseCommands(raw.commands),
	};

	// A line break or NUL would end the PASS line early (wire.ts refuses it).
	const serverPassword = asString(raw.serverPassword).replace(/[\r\n\0]/g, "");

	if (serverPassword) {
		net.serverPassword = serverPassword;
	}

	if (serverPassword || asBoolean(raw.hasServerPassword)) {
		net.hasServerPassword = true;
	}

	const trusted = asFingerprints(raw.trustedCertificates);

	if (trusted.length > 0) {
		net.trustedCertificates = trusted;
	}

	if (typeof raw.lastUsed === "number" && Number.isFinite(raw.lastUsed)) {
		net.lastUsed = raw.lastUsed;
	}

	const cursor = asCursor(raw.cursor);

	if (cursor) {
		net.cursor = cursor;
	}

	const services = asServices(raw.services);

	if (services) {
		net.services = services;
	}

	const mode = raw.presenceMode;

	if (typeof mode === "string" && PRESENCE_MODES.includes(mode as PresenceMode)) {
		net.presenceMode = mode as PresenceMode;
	}

	const at = raw.presenceAt;

	if (typeof at === "number" && Number.isSafeInteger(at) && at > 0) {
		net.presenceAt = at;
	}

	return net;
}

/** The network's own presence mode; absent or unknown is Same as global. */
export function presenceModeOf(net: Pick<SavedNetwork, "presenceMode"> | undefined): NetworkMode {
	return net?.presenceMode ?? "global";
}

/** Whether a network takes part in Web Push (`draft/webpush`): the saved
 * flag, defaulting to enabled — entries stored before the flag existed and
 * networks never saved (plain `/connect host`) are push-enabled; only an
 * explicit `false` opts a network out. */
export function pushEnabledOf(net: Pick<SavedNetwork, "pushEnabled"> | undefined): boolean {
	return net?.pushEnabled !== false;
}

/** Whether this network may show browser notifications (the `Notification`
 * API; no server support or login involved). Same rule as the push flag:
 * missing means enabled, only an explicit `false` opts a network out. */
export function notifyEnabledOf(net: Pick<SavedNetwork, "notifyEnabled"> | undefined): boolean {
	return net?.notifyEnabled !== false;
}

/** One-time migration for the removed global "Enable browser notifications"
 * checkbox: a user who had it off keeps notifications off, stamped onto every
 * saved network's {@link SavedNetwork.notifyEnabled}. Runs before the settings
 * store's first write can drop the old key; no-op when the switch was on,
 * absent or the stored blob is unusable. */
export function migrateGlobalNotify(): void {
	let raw: string | null;

	try {
		raw = backend.get("settings");
	} catch {
		return;
	}

	let stored: {desktopNotifications?: unknown};

	try {
		stored = raw ? (JSON.parse(raw) as {desktopNotifications?: unknown}) : {};
	} catch {
		return; // garbage settings blob: leave the networks alone
	}

	if (stored.desktopNotifications !== false) {
		return;
	}

	write(list().map((net) => ({...net, notifyEnabled: false})));
}

/**
 * Merge the edit form's payload (`network:edit`) over an existing entry.
 * Checkbox fields are absent from FormData when unchecked, so any missing
 * boolean is `false`; other missing fields keep their stored value.
 */
export function fromForm(data: Record<string, unknown>, existing?: SavedNetwork): SavedNetwork {
	const base: Record<string, unknown> = {...(existing ?? {})};

	for (const key of Object.keys(data)) {
		if (data[key] !== undefined) {
			base[key] = data[key];
		}
	}

	for (const flag of [
		"tls",
		"autoconnect",
		"rememberPassword",
		"pushEnabled",
		"notifyEnabled",
		"hasServerPassword",
	]) {
		if (!(flag in data)) {
			base[flag] = false;
		}
	}

	// A blank or missing password field in the edit form means "keep what I
	// had", for the same account only: a password belongs to its account.
	if (existing && asString(data.saslPassword) === "") {
		const sameAccount = asString(base.saslAccount) === asString(existing.saslAccount);
		base.saslPassword = sameAccount ? existing.saslPassword : "";
	}

	// The server password's switch off clears it; on with the field blank
	// keeps the stored one, as for SASL.
	if (!base.hasServerPassword) {
		delete base.serverPassword;
	} else if (asString(data.serverPassword) === "" && existing?.serverPassword) {
		base.serverPassword = existing.serverPassword;
	}

	if (existing && moved(existing, base.host, base.port)) {
		delete base.trustedCertificates;
	}

	// The services block travels whole: the key present with nothing in it
	// is "None" (the loop above keeps the stored one for a missing key).
	if ("services" in data) {
		base.services = data.services;
	}

	const net = normalize(base);

	if (!net) {
		throw new Error("network:edit without a uuid");
	}

	return net;
}

/** Just the connection fields, for `IrcClient`. */
export function toConnectOptions(net: SavedNetwork): ConnectOptions {
	return {
		host: net.host,
		port: net.port,
		tls: net.tls,
		...(net.transport ? {transport: net.transport} : {}),
		nick: net.nick,
		join: net.join,
		sasl: net.sasl,
		saslAccount: net.saslAccount,
		saslPassword: net.saslPassword,
		// Configured but not on disk: undefined, so a live client keeps the
		// one it was given (IrcClient.applySettings).
		serverPassword: net.serverPassword ?? (net.hasServerPassword ? undefined : ""),
		trustedCertificates: net.trustedCertificates ?? [],
	};
}

/** Whether two host names are the same server's, as typed or not. */
export function sameHost(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Whether `host` and `port` (either may be absent: unchanged) take `existing`
 * to another server. Certificates were trusted for the server they came
 * from, so a network that moved starts with none (fromForm, mergeOptions).
 */
function moved(existing: SavedNetwork, host: unknown, port: unknown): boolean {
	return (
		(host !== undefined && !sameHost(asString(host), existing.host)) ||
		(port !== undefined && Number(port) !== existing.port)
	);
}

/** How many certificates one network may trust (the shell refuses more). */
export const MAX_TRUSTED_CERTIFICATES = 8;

/** SHA-256 fingerprints, lowercase hex, deduplicated, the newest last; anything else dropped. */
function asFingerprints(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const out: string[] = [];

	for (const item of value) {
		const hex = asString(item).replace(/:/g, "").toLowerCase();

		if (/^[0-9a-f]{64}$/.test(hex) && !out.includes(hex)) {
			out.push(hex);
		}
	}

	return out.slice(-MAX_TRUSTED_CERTIFICATES);
}

/** `net` trusting `sha256` too; the oldest one goes past the cap. */
export function withTrustedCertificate(net: SavedNetwork, sha256: string): SavedNetwork {
	const trusted = asFingerprints([...(net.trustedCertificates ?? []), sha256]);
	return {...net, trustedCertificates: trusted};
}

/**
 * The entry cannot connect as saved, so it waits for the connect form: a
 * password it needs was not kept on disk (`rememberPassword` off), or it
 * logs in with nothing on a deploy that lets only accounts in
 * (`accountRequired`) — a guest's entry from before guests were turned
 * off, which the sign-in panel replaces with a login.
 */
export function needsPassword(
	net: SavedNetwork,
	loginRequired: boolean = accountRequired()
): boolean {
	return (
		(net.sasl === "plain" && !net.saslPassword) ||
		(!!net.hasServerPassword && !net.serverPassword) ||
		(loginRequired && !net.sasl)
	);
}

// --------------------------------------------------------------- storage

function read(): SavedNetwork[] {
	let parsed: unknown;

	try {
		const raw = backend.get(STORAGE_KEY);
		parsed = raw ? JSON.parse(raw) : [];
	} catch (e) {
		backend.remove(STORAGE_KEY);
		return [];
	}

	if (!Array.isArray(parsed)) {
		return [];
	}

	const result: SavedNetwork[] = [];

	for (const entry of parsed) {
		if (entry && typeof entry === "object") {
			const net = normalize(entry as Record<string, unknown>);

			if (net && net.host && !result.some((n) => n.uuid === net.uuid)) {
				result.push(net);
			}
		}
	}

	return result;
}

const changeListeners = new Set<() => void>();

/**
 * Hear every write of the list in this page (another tab's arrive as a
 * `storage` event) but the history cursor's, which moves on every message
 * and is shown nowhere. The sidebar's saved-but-not-connected rows follow
 * it. Returns the unsubscribe.
 */
export function onSavedNetworksChange(listener: () => void): () => void {
	changeListeners.add(listener);
	return () => changeListeners.delete(listener);
}

function write(entries: SavedNetwork[], notify = true): void {
	backend.set(STORAGE_KEY, JSON.stringify(entries));

	if (!notify) {
		return;
	}

	for (const listener of changeListeners) {
		listener();
	}
}

/** Never let a password reach disk unless the user asked for it. */
function forStorage(net: SavedNetwork): SavedNetwork {
	if (net.rememberPassword) {
		return {...net};
	}

	const {serverPassword: _dropped, ...rest} = net;
	void _dropped;
	return {...rest, saslPassword: ""};
}

function byRecency(a: SavedNetwork, b: SavedNetwork): number {
	const diff = (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
	// Recency ties break by the active locale's collation of the names.
	return diff !== 0 ? diff : collator().compare(displayName(a), displayName(b));
}

/** Every saved network, most recently used first. */
export function list(): SavedNetwork[] {
	return read().sort(byRecency);
}

export function get(uuid: string): SavedNetwork | undefined {
	return read().find((net) => net.uuid === uuid);
}

/**
 * Insert or update an entry (matched by `uuid`). Returns what was stored,
 * i.e. without the password unless `rememberPassword` is set.
 */
export function save(net: SavedNetwork): SavedNetwork {
	const normalized = normalize(net);

	if (!normalized || !normalized.host) {
		throw new Error("saved-networks: uuid and host are required");
	}

	const stored = forStorage(normalized);
	const all = read();
	const idx = all.findIndex((n) => n.uuid === stored.uuid);

	if (idx === -1) {
		all.push(stored);
	} else {
		stored.lastUsed = stored.lastUsed ?? all[idx].lastUsed;
		stored.cursor = stored.cursor ?? all[idx].cursor;
		all[idx] = stored;
	}

	write(all);
	return stored;
}

export function remove(uuid: string): void {
	const all = read();
	const remaining = all.filter((net) => net.uuid !== uuid);

	if (remaining.length !== all.length) {
		write(remaining);
	}

	forgetNetworkLog(uuid); // its private conversations go with it
	forgetClosedQueries(uuid); // and the ones it closed
	forgetNoticeLog(uuid); // and its server notices
	forgetOperPrefs(uuid);
	forgetMuteMemory(uuid); // and what this device wrote to its push mute list
	forgetPresenceSync(uuid); // and when it was last in sync with the shared presence
	forgetUserAway(uuid); // and the /away it would declare at the next registration
	forgetLogin(uuid); // and the SASL login that worked on it
}

/** Mark an entry as the most recently used one. */
export function touchLastUsed(uuid: string, now: number = Date.now()): void {
	const all = read();
	const net = all.find((n) => n.uuid === uuid);

	if (net) {
		net.lastUsed = now;
		write(all);
	}
}

/**
 * Record the newest message seen on a network (the `PERSISTENCE ATTACH`
 * cursor). Silently does nothing when the network was never saved — a
 * deployment with `features.saveNetworks` off simply gets no cursor.
 */
export function setCursor(uuid: string, cursor: NetworkCursor): void {
	const all = read();
	const net = all.find((n) => n.uuid === uuid);

	if (net) {
		net.cursor = cursor;
		write(all, false);
	}
}

/** The entry to pre-fill the connect form with, if any. */
/**
 * The order the user gave a network's channels (drag-and-drop in the
 * sidebar), by name. `IrcClient.createChannel` places a channel by it, so
 * the order holds across reloads whichever way the channel arrives —
 * autojoin placeholder, a held session's restore, `/join`.
 */
export function channelOrder(uuid: string): string[] {
	const order = readOrders()[uuid];
	return Array.isArray(order) ? order.filter((n): n is string => typeof n === "string") : [];
}

export function setChannelOrder(uuid: string, names: string[]): void {
	backend.set(CHANNEL_ORDER_KEY, JSON.stringify({...readOrders(), [uuid]: names}));
}

function readOrders(): Record<string, unknown> {
	try {
		const raw = backend.get(CHANNEL_ORDER_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch (e) {
		backend.remove(CHANNEL_ORDER_KEY);
		return {};
	}
}

export function lastUsed(): SavedNetwork | undefined {
	return list().find((net) => net.lastUsed !== undefined);
}

/**
 * An existing entry for the same server and nick, so re-typing a network
 * into the connect form keeps its uuid (and the preferences keyed by it).
 */
export function findMatching(
	host: string,
	port: number,
	nick: string,
	transport?: ConnectOptions["transport"]
): SavedNetwork | undefined {
	const h = hostnameOf(host).toLowerCase();
	const n = nick.trim().toLowerCase();

	return read().find(
		(net) =>
			hostnameOf(net.host).toLowerCase() === h &&
			net.port === port &&
			net.nick.toLowerCase() === n &&
			(net.transport === "tcp") === (transport === "tcp")
	);
}

/** The stored entry with the connect options laid over it (undefined options keep the stored value). */
export function mergeOptions(
	existing: SavedNetwork | undefined,
	uuid: string,
	options: Partial<ConnectOptions> & Record<string, unknown>
): Record<string, unknown> {
	const merged: Record<string, unknown> = {...(existing ?? {}), uuid};

	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined) {
			merged[key] = value;
		}
	}

	// The connect screen can point a saved network at another server too.
	if (existing && moved(existing, options.host, options.port)) {
		delete merged.trustedCertificates;
	}

	return merged;
}
