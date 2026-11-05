// A past view (docs/projects/inbox.md § Going to a message): the lines around an
// old message, shown by MessageList.vue in place of the channel's buffer, which
// stays what it was and goes on taking live lines. Nothing here is kept: leaving
// the channel closes it.
import socket from "./socket";
import {store} from "./store";
import {pageEdge} from "./helpers/pastRows";
import type {ClientChan, ClientNetwork} from "./types";

/** The most one command brings (irc/historysearch.ts clamps it to the server's). */
const PAGE_SIZE = 100;

type Pending = {
	requestId: number;
	channel: ClientChan;
	direction: "AROUND" | "BEFORE" | "AFTER";
	msgid: string;
};

let nextRequestId = 1;
const pending = new Map<number, Pending>();

function ask(
	network: ClientNetwork,
	channel: ClientChan,
	request: Omit<Pending, "requestId" | "channel">
) {
	const requestId = nextRequestId++;
	pending.set(requestId, {requestId, channel, ...request});
	socket.emit("search:context", {
		network: network.uuid,
		requestId,
		target: channel.name,
		direction: request.direction,
		msgid: request.msgid,
		limit: PAGE_SIZE,
	});
	return requestId;
}

/** What was asked by this answer's request, once: a closed view's answer finds nothing. */
export function takePending(requestId: number): Pending | undefined {
	const request = pending.get(requestId);
	pending.delete(requestId);
	return request;
}

/** Forget what was asked, so no answer can land. A page's view stops waiting for it. */
export function cancelPastRequests(channel: ClientChan): boolean {
	let opening = false;

	for (const request of pending.values()) {
		if (request.channel === channel) {
			opening ||= request.direction === "AROUND";
			pending.delete(request.requestId);
		}
	}

	if (channel.past) {
		channel.past.loading = null;
		channel.past.requestId = 0;
	}

	channel.pastOpening = false;
	return opening;
}

/** Ask for the lines around `msgid`; the view opens when they land (socket-events/past.ts). */
export function openPast(network: ClientNetwork, channel: ClientChan, msgid: string): void {
	cancelPastRequests(channel);
	channel.pastOpening = true;
	ask(network, channel, {direction: "AROUND", msgid});
}

/** The next page on one side, unless one is on its way or that side has ended. */
export function pastPage(
	network: ClientNetwork,
	channel: ClientChan,
	where: "BEFORE" | "AFTER"
): void {
	const past = channel.past;
	const more = where === "BEFORE" ? past?.canEarlier : past?.canLater;
	const msgid = past && pageEdge(past.rows, where);

	if (!past || !more || past.loading || !msgid) {
		return;
	}

	past.loading = where;
	past.requestId = ask(network, channel, {direction: where, msgid});
}

/** Back to the channel's own lines. A jump still waiting for its view ends here too. */
export function closePast(channel: ClientChan): void {
	if (cancelPastRequests(channel) && store.state.jumpTarget?.chanId === channel.id) {
		store.commit("jumpTarget", null);
	}

	channel.past = null;
}
