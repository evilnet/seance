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
import type {IrcMessage} from "./message";
import {tagPrefix} from "./wire";

interface Registry {
	next: number;
	labels: Set<string>;
}

/** Labels kept per client; a line never answered would leak one, so the set is capped. */
const MAX_LABELS = 64;

const registries = new WeakMap<IrcClient, Registry>();

function registryOf(client: IrcClient): Registry {
	let registry = registries.get(client);

	if (!registry) {
		registry = {next: 0, labels: new Set()};
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

/** Send `line` so that its echo is dropped; returns what `client.send` does. */
export function sendQuiet(client: IrcClient, line: string): boolean {
	const label = quietLabel(client);
	return client.send(label ? `${tagPrefix({label})}${line}` : line);
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
 * forgets the label but is still shown: the oper should see it.
 */
export function dropQuietLine(client: IrcClient, msg: IrcMessage): boolean {
	const label = msg.tags.get("label");

	// A labeled batch opener keeps its label for the close (request.ts
	// `labeledBatch` drops the batch whole).
	if (!label || msg.command === "BATCH" || !takeQuietLabel(client, label)) {
		return false;
	}

	if (msg.command === "ACK") {
		return true;
	}

	return (
		(msg.command === "PRIVMSG" || msg.command === "NOTICE") &&
		msg.source !== undefined &&
		client.isSelf(msg.source.name)
	);
}
