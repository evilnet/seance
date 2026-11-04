/**
 * Quiet lines: a PRIVMSG the client sends for its own purposes — a lookup
 * to a services bot (services.ts, investigate.ts, alerts.ts) — whose echo
 * must not land in the timeline. With `echo-message` the server sends every
 * PRIVMSG back, and for one addressed to a bot the echo would open the
 * bot's query window as a `/msg` does. So each such line goes out with a
 * `@label=svc<n>` (`labeled-response`), the label is remembered here, and
 * `IrcClient.handleMessage` drops the echo (or the `ACK`) that carries it
 * before any handler sees it (`dropQuietLine`). A server without
 * `labeled-response` cannot be asked quietly: the line goes out plain and
 * its echo shows, as before.
 *
 * Kept free of store/DOM imports (mocha, test/irc/services.ts).
 */

import type {IrcClient} from "./client";
import {type IrcMessage, MAX_LINE_BYTES, utf8ByteLength} from "./message";
import {tagPrefix} from "./wire";

interface Registry {
	next: number;
	labels: Set<string>;
	/** A missing bot (lowercased) → when its 401 was last shown. */
	missing: Map<string, number>;
}

/** How long a missing bot's 401 stays shown once: a card's lookups would
 * otherwise print one per lookup, ten in a row. */
export const MISSING_BOT_QUIET_MS = 10 * 60_000;

/** Labels kept per client; a line never answered would leak one, so the set is capped. */
const MAX_LABELS = 64;

const registries = new WeakMap<IrcClient, Registry>();

function registryOf(client: IrcClient): Registry {
	let registry = registries.get(client);

	if (!registry) {
		registry = {next: 0, labels: new Set(), missing: new Map()};
		registries.set(client, registry);
	}

	return registry;
}

/** A fresh quiet label, or undefined when the server would not relay one. */
export function quietLabel(client: IrcClient): string | undefined {
	if (!client.caps.hasCapability("labeled-response")) {
		return undefined;
	}

	const registry = registryOf(client);
	const label = `svc${++registry.next}`;

	registry.labels.add(label);

	if (registry.labels.size > MAX_LABELS) {
		const oldest = registry.labels.values().next().value as string | undefined;

		if (oldest !== undefined) {
			registry.labels.delete(oldest);
		}
	}

	return label;
}

/** Whether `line` still fits under `MAX_LINE_BYTES` with a quiet label in front. */
export function fitsQuiet(line: string): boolean {
	return utf8ByteLength(`${tagPrefix({label: "svc99999"})}${line}`) <= MAX_LINE_BYTES;
}

/** Send `line` so that its echo is dropped; returns what `client.send` does. */
export function sendQuiet(client: IrcClient, line: string): boolean {
	const label = quietLabel(client);
	return client.send(label ? `${tagPrefix({label})}${line}` : line);
}

/** Labeled 401s for a bot whose 401 was shown a moment ago. */
const repeatedMissing = new WeakSet<IrcMessage>();

/**
 * A quiet line's 401 for a bot already reported missing in the last
 * `MISSING_BOT_QUIET_MS`: called after the services layer has seen it, so
 * it is dropped before it is shown a second time.
 */
export function isRepeatedMissingBot(msg: IrcMessage): boolean {
	return repeatedMissing.has(msg);
}

/**
 * A quiet line's 401: still handed on (the services layer learns from it
 * that the bot is missing, services.ts), but marked when that bot's 401 was
 * shown in the last `MISSING_BOT_QUIET_MS`, so it is not shown again.
 */
export function noteMissingBot(client: IrcClient, msg: IrcMessage, now: number = Date.now()): void {
	const missing = registryOf(client).missing;
	const bot = client.casefold(msg.params[1] ?? "");
	const shown = missing.get(bot);

	if (shown !== undefined && now - shown < MISSING_BOT_QUIET_MS) {
		repeatedMissing.add(msg);
	} else {
		missing.set(bot, now);
	}
}

/** Whether `label` is one of this client's quiet labels (and forget it). */
export function takeQuietLabel(client: IrcClient, label: string | undefined): boolean {
	const registry = registries.get(client);

	if (!registry || !label || !registry.labels.has(label)) {
		return false;
	}

	registry.labels.delete(label);
	return true;
}

/**
 * Called from `IrcClient.handleMessage` for every line after the labeled
 * requests have taken theirs: the echo of a quiet line (a PRIVMSG or
 * NOTICE of ours carrying the label) or its `ACK` is dropped — returns
 * true. A numeric with the label (a `401` for a bot that is not online)
 * forgets the label but is still shown: the oper should see it — once per
 * bot in `MISSING_BOT_QUIET_MS` ({@link isRepeatedMissingBot}).
 */
export function dropQuietLine(
	client: IrcClient,
	msg: IrcMessage,
	now: number = Date.now()
): boolean {
	const label = msg.tags.get("label");

	// A labeled batch opener keeps its label for the close (request.ts
	// `labeledBatch` drops the batch whole).
	if (!label || msg.command === "BATCH" || !takeQuietLabel(client, label)) {
		return false;
	}

	if (msg.command === "ACK") {
		return true;
	}

	if (msg.command === "401") {
		noteMissingBot(client, msg, now);
		return false;
	}

	return (
		(msg.command === "PRIVMSG" || msg.command === "NOTICE") &&
		msg.source !== undefined &&
		client.isSelf(msg.source.name)
	);
}
