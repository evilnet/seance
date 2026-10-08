import socket from "../socket";
import {notificationText} from "../push/strip";
import {store} from "../store";
import {switchToChannel} from "../router";
import {ClientChan, NetChan, ClientMessage} from "../types";
import {SharedMsg, MessageType} from "../../../shared/types/msg";
import {ChanType} from "../../../shared/types/chan";
import {addMention} from "../mentions";
import {recordSeenMsgid} from "../push-seen";
import webpush from "../webpush";
import {attachMediaPreviews} from "../helpers/messagePreviews";
import * as saved from "../irc/saved-networks";
import {insertMessage} from "../helpers/messageUpdates";

let pop;

try {
	pop = new Audio();
	pop.src = "audio/pop.wav";
} catch (e) {
	pop = {
		play() {},
	};
}

socket.on("msg", function (data) {
	const receivingChannel = store.getters.findChannel(data.chan);

	if (!receivingChannel) {
		return;
	}

	let channel = receivingChannel.channel;
	let isActiveChannel =
		store.state.activeChannel && store.state.activeChannel.channel === channel;

	// Display received notices and errors in currently active channel.
	// Reloading the page will put them back into the lobby window.
	if (data.msg.showInActive) {
		// We only want to put errors/notices in active channel if they arrive on the same network
		if (
			store.state.activeChannel &&
			store.state.activeChannel.network === receivingChannel.network
		) {
			channel = store.state.activeChannel.channel;

			// Do not update unread/highlight counters for this channel
			// as we are putting this message in the active channel
			isActiveChannel = true;

			if (data.chan === channel.id) {
				// If active channel is the intended channel for this message,
				// remove the showInActive flag
				delete data.msg.showInActive;
			} else {
				data.chan = channel.id;
			}
		} else {
			delete data.msg.showInActive;
		}
	}

	// Do not set unread counter for channel if it is currently active on this client
	// It may increase on the server before it processes channel open event from this client
	if (!isActiveChannel) {
		if (typeof data.highlight !== "undefined") {
			channel.highlight = data.highlight;
		}

		if (typeof data.unread !== "undefined") {
			channel.unread = data.unread;
		}
	}

	// Previews used to arrive from the server (`msg:preview`); they are now
	// derived locally from the text for direct media URLs only.
	attachMediaPreviews(data.msg, receivingChannel.network, channel);

	// Pending copies of our own messages (bus-contract §1.9) stay at the
	// bottom until their echo settles them, so everything else goes in
	// ahead of them.
	insertMessage(channel.messages, data.msg);

	// Highlights used to be collected server-side; keep the recent-mentions
	// list locally instead. Replayed history renders its highlights but is
	// not news: no mention entry, no notification.
	if (data.msg.highlight && !data.msg.self && !data.replay && data.msg.from) {
		addMention({
			chanId: data.chan,
			msgId: data.msg.id,
			type: data.msg.type ?? MessageType.MESSAGE,
			time: data.msg.time,
			text: data.msg.text ?? "",
			from: data.msg.from,
		});
	}

	if (data.msg.self) {
		channel.firstUnread = data.msg.id;
	} else if (!data.replay && (!data.msg.editOf || data.msg.highlight)) {
		// An edit is not news (it replaces a message in place) unless it
		// brings a highlight with it.
		notifyMessage(data.chan, channel, store.state.activeChannel, data.msg);
	}

	// Mark pushable messages as taken by this live page, so the service
	// worker drops the FCM duplicate the ircd may emit for the same
	// message while this session is attached-but-idle (FEAT_WEBPUSH_IDLE).
	// The subset is what the server pushes: PMs and channel mentions.
	if (
		!data.msg.self &&
		data.msg.msgid &&
		(data.msg.highlight || channel.type === ChanType.QUERY)
	) {
		recordSeenMsgid(data.msg.msgid);
	}

	let messageLimit = 0;

	if (!isActiveChannel) {
		// If message arrives in non active channel, keep only 100 messages
		messageLimit = 100;
	} else if (channel.scrolledToBottom) {
		// If message arrives in active channel, keep 1500 messages if scroll is currently at the bottom
		// One history load may load up to 1000 messages at once if condendesed or hidden events are enabled
		messageLimit = 1500;
	}

	if (messageLimit > 0 && channel.messages.length > messageLimit) {
		const dropped = channel.messages.splice(0, channel.messages.length - messageLimit);
		channel.moreHistoryAvailable = true;
		// The IRC layer must stop counting them as shown (bus-contract § 2).
		socket.emit("history:trim", {target: channel.id, ids: dropped.map((m) => m.id)});
	}

	if (channel.type === ChanType.CHANNEL) {
		updateUserList(channel, data.msg);
	}
});

declare global {
	// this extends the interface from lib.dom with additional stuff which is not
	// exactly standard but implemented in some browsers
	interface NotificationOptions {
		timestamp?: number; // chrome has it, other browsers ignore it
	}
}

function notifyMessage(
	targetId: number,
	channel: ClientChan,
	activeChannel: NetChan | undefined,
	msg: ClientMessage
) {
	if (channel.muted) {
		return;
	}

	// Browser notifications enroll per network (the editor's checkbox,
	// default on): find the channel's network and honor its saved flag.
	const network = store.state.networks.find((net) => net.channels.some((c) => c === channel));

	if (!network || !saved.notifyEnabledOf(saved.get(network.uuid))) {
		return;
	}

	if (
		msg.highlight ||
		(store.state.settings.notifyAllMessages && msg.type === MessageType.MESSAGE)
	) {
		if (!document.hasFocus() || !activeChannel || activeChannel.channel !== channel) {
			if (store.state.settings.notification) {
				try {
					void Promise.resolve(pop.play()).catch(() => undefined); // autoplay may be blocked
				} catch (exception) {
					// On mobile, sounds can not be played without user interaction.
				}
			}

			if ("Notification" in window && Notification.permission === "granted") {
				let title: string;
				let body: string;
				// TODO: fix msg type and get rid of that conditional
				const nick = msg.from && msg.from.nick ? msg.from.nick : "unkonown";

				if (msg.type === MessageType.INVITE) {
					title = "New channel invite:";
					body = nick + " invited you to " + msg.channel;
				} else {
					title = nick;

					if (channel.type !== ChanType.QUERY) {
						title += ` (${channel.name})`;
					}

					if (msg.type === MessageType.MESSAGE) {
						title += " says:";
					}

					// TODO: fix msg type and get rid of that conditional
					// The same stripping as the service worker's push path, so a
					// live page and a push show the same body.
					body = notificationText(msg.text ? msg.text : "", {
						markdown: store.state.settings.markdown,
					});
				}

				const timestamp = Date.parse(String(msg.time));

				try {
					if (store.state.hasServiceWorker) {
						// network + target let a click find the conversation
						// after this page (and its channel ids) is gone.
						const payload = {
							type: "notification",
							chanId: targetId,
							network: network.uuid,
							target: channel.name,
							timestamp: timestamp,
							title: title,
							body: body,
						};

						// A message the server may also push to this device goes
						// to the network's push worker with the message itself,
						// and is shown there as that push would be (same tag,
						// merged by msgid): the push then finds a notification on
						// its own registration instead of counting as silent
						// (webpush.ts pushWorkerFor). Anything else, or a network
						// this device is not subscribed on, takes the root worker.
						const message =
							msg.msgid && msg.type !== MessageType.INVITE && msg.from?.nick
								? {
										msgid: msg.msgid,
										from: msg.from.nick,
										// the wire form, which the worker renders as `* nick …`
										text:
											msg.type === MessageType.ACTION
												? `\x01ACTION ${msg.text ?? ""}\x01`
												: msg.text ?? "",
										time: Number.isFinite(timestamp)
											? new Date(timestamp).toISOString()
											: undefined,
										notice: msg.type === MessageType.NOTICE,
								  }
								: undefined;

						void (async () => {
							const pushWorker = message
								? await webpush.pushWorkerFor(network.uuid)
								: undefined;

							if (pushWorker) {
								pushWorker.postMessage({...payload, message});
								return;
							}

							const registration = await navigator.serviceWorker.ready;
							registration.active?.postMessage(payload);
						})().catch(() => {
							// no-op
						});
					} else {
						const notify = new Notification(title, {
							tag: `chan-${targetId}`,
							icon: "img/icon-192.png",
							body: body,
							timestamp: timestamp,
						});
						notify.addEventListener("click", function () {
							this.close();
							window.focus();

							const channelTarget = store.getters.findChannel(targetId);

							if (channelTarget) {
								switchToChannel(channelTarget.channel);
							}
						});
					}
				} catch (exception) {
					// `new Notification(...)` is not supported and should be silenced.
				}
			}
		}
	}
}

function updateUserList(channel: ClientChan, msg: SharedMsg) {
	switch (msg.type) {
		case MessageType.MESSAGE: // fallthrough

		case MessageType.ACTION: {
			const user = channel.users.find((u) => u.nick === msg.from?.nick);

			if (user) {
				user.lastMessage = new Date(msg.time).getTime() || Date.now();
			}

			break;
		}

		case MessageType.QUIT: // fallthrough

		case MessageType.PART: {
			const idx = channel.users.findIndex((u) => u.nick === msg.from?.nick);

			if (idx > -1) {
				channel.users.splice(idx, 1);
			}

			break;
		}

		case MessageType.KICK: {
			const idx = channel.users.findIndex((u) => u.nick === msg.target?.nick);

			if (idx > -1) {
				channel.users.splice(idx, 1);
			}

			break;
		}
	}
}
