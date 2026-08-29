/**
 * BATCH (IRCv3 batch extension).
 *
 * `BATCH +ref type params…` opens a batch; every subsequent line tagged
 * `@batch=ref` is buffered (see {@link interceptBatchLine}, called from
 * `IrcClient.handleMessage` before the normal handlers) until `BATCH -ref`
 * closes it. On close the buffered lines are delivered as a unit to the
 * handler registered for the batch type ({@link registerBatchHandler};
 * `chathistory` lives in `../history.ts`). Types without a handler are
 * unwrapped: their lines go through the normal handlers in order, so
 * `netsplit`/`netjoin` and friends show up as ordinary messages.
 *
 * Nested batches (an opener tagged with the parent's ref) are supported:
 * a nested batch with a handler is delivered on its own close; one without
 * a handler is folded into its parent as a unit when it closes.
 */

import type {IrcClient} from "../client";
import type {IrcMessage} from "../message";
import type {Handler} from "../types";

export interface OpenBatch {
	ref: string;
	/** Batch type as sent (`chathistory`, `netsplit`, `labeled-response`…). */
	type: string;
	/** Parameters after the type (`#channel` for chathistory). */
	params: string[];
	/** Tags on the opening line (`label` when the batch answers a labeled request). */
	tags: Map<string, string>;
	/** The enclosing batch while it is still open. */
	parent?: OpenBatch;
	/** Buffered lines in arrival order. */
	messages: IrcMessage[];
}

export type BatchHandler = (client: IrcClient, batch: OpenBatch) => void;

const batchHandlers = new Map<string, BatchHandler>();

/** Register (or replace) the handler that receives closed batches of `type`. */
export function registerBatchHandler(type: string, handler: BatchHandler): void {
	batchHandlers.set(type.toLowerCase(), handler);
}

export function unregisterBatchHandler(type: string): void {
	batchHandlers.delete(type.toLowerCase());
}

/** Open batches per client (a client never outlives its batches). */
const openBatches = new WeakMap<IrcClient, Map<string, OpenBatch>>();

function batchesOf(client: IrcClient): Map<string, OpenBatch> {
	let map = openBatches.get(client);

	if (!map) {
		map = new Map();
		openBatches.set(client, map);
	}

	return map;
}

/** Open batches of `client` (tests / diagnostics). */
export function openBatchesOf(client: IrcClient): ReadonlyMap<string, OpenBatch> {
	return batchesOf(client);
}

/**
 * Buffer `msg` if it carries the `batch` tag of an open batch. Returns true
 * when the line was taken; `BATCH` lines themselves and lines tagged with
 * an unknown reference are left to the normal handlers.
 */
export function interceptBatchLine(client: IrcClient, msg: IrcMessage): boolean {
	if (msg.command === "BATCH") {
		return false;
	}

	const ref = msg.tags.get("batch");

	if (!ref) {
		return false;
	}

	const batch = openBatches.get(client)?.get(ref);

	if (!batch) {
		return false;
	}

	batch.messages.push(msg);
	return true;
}

/** Drop every open batch (transport closed). */
export function resetBatches(client: IrcClient): void {
	openBatches.get(client)?.clear();
}

/**
 * Deliver `messages` where `batch` stood: into the enclosing batch when one
 * is still open (it is unwrapped as a unit when the parent closes), else
 * through the normal handlers. A batch handler that rewrites its lines
 * (`draft/multiline` folds them into one message) emits through this so it
 * keeps its place inside a `chathistory` replay.
 */
export function emitBatched(client: IrcClient, batch: OpenBatch, messages: IrcMessage[]): void {
	if (batch.parent && batchesOf(client).get(batch.parent.ref) === batch.parent) {
		batch.parent.messages.push(...messages);
		return;
	}

	for (const msg of messages) {
		// The batch is closed, so the line is not intercepted again.
		client.handleMessage(msg);
	}
}

function deliver(client: IrcClient, batch: OpenBatch): void {
	const handler = batchHandlers.get(batch.type.toLowerCase());

	if (handler) {
		handler(client, batch);
		return;
	}

	emitBatched(client, batch, batch.messages);
}

const batch: Handler = (client, msg) => {
	const marker = msg.params[0] ?? "";
	const ref = marker.slice(1);

	if (!ref) {
		return;
	}

	const batches = batchesOf(client);

	if (marker[0] === "+") {
		const parentRef = msg.tags.get("batch");
		const parent = parentRef ? batches.get(parentRef) : undefined;

		batches.set(ref, {
			ref,
			type: msg.params[1] ?? "",
			params: msg.params.slice(2),
			tags: msg.tags,
			parent,
			messages: [],
		});
		return;
	}

	if (marker[0] !== "-") {
		return;
	}

	const open = batches.get(ref);

	if (!open) {
		return; // close for a batch we never saw: ignore
	}

	batches.delete(ref);
	deliver(client, open);
};

export default {BATCH: batch};
