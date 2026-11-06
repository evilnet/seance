// Taken to an older message (a mention, a search hit), a reader has not read the
// conversation: it stays unread until the list reaches the bottom (MessageList.vue).
// The IRC layer's half is Channel.readHeld and IrcClient.isReading.
import socket from "../socket";
import type {ClientChan} from "../types";

export function setReadHold(channel: ClientChan, held: boolean): void {
	if (channel.readHeld !== held) {
		channel.readHeld = held;
		socket.emit("read:hold", {chan: channel.id, held});
	}
}
