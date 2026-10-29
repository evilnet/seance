import {t} from "../i18n/core";
import socket from "../socket";
import {notificationText} from "../push/strip";
import {store} from "../store";
import {switchToChannel} from "../router";
import {ClientChan, NetChan, ClientMessage} from "../types";
import {SharedMsg, MessageType} from "../../../shared/types/msg";
import {ChanType} from "../../../shared/types/chan";
import {recordSeenMsgid} from "../push-seen";
import webpush from "../webpush";
import {attachMediaPreviews} from "../helpers/messagePreviews";
import * as saved from "../irc/saved-networks";
import {SAID_TYPES} from "../irc/channel";
import {insertMessage} from "../helpers/messageUpdates";
import {forgetTranslations} from "../translate/reader";
import {nativeAlertsAvailable, showNativeAlert} from "../helpers/nativeAlerts";
import {alertSound, playNotificationSound} from "../helpers/notificationSound";
import {hasVirtualKeyboard} from "../helpers/device";

socket.on("msg", function (data) {
	const receivingChannel = store.getters.findChannel(data.chan);

	if (!receivingChannel) {
		return;
	}

	let channel = receivingChannel.channel;
	let rerouted = false;
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
			rerouted = true;

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

	// The counters are the IRC layer's (IrcClient.pushMessage), in process:
	// they stay 0 for the open conversation while someone looks at it and
	// count while nobody does (a phone in a pocket), which is what the app
	// badge should show. Only a notice rerouted here carries another
	// channel's counters.
	if (!rerouted) {
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

	let shellAlerted = false;

	if (data.msg.self) {
		// Our own JOIN in a catch-up is not reading the channel (IrcClient.pushMessage).
		if (!data.replay || SAID_TYPES.has(data.msg.type ?? MessageType.MESSAGE)) {
			channel.firstUnread = data.msg.id;
		}
	} else if (!data.replay && (!data.msg.editOf || data.msg.highlight)) {
		// An edit is not news (it replaces a message in place) unless it
		// brings a highlight with it.
		shellAlerted = notifyMessage(data.chan, channel, store.state.activeChannel, data.msg);
	}

	// Mark pushable messages as taken by this live page, so the service
	// worker drops the FCM duplicate the ircd may emit for the same
	// message while this session is attached-but-idle (FEAT_WEBPUSH_IDLE).
	// The subset is what the server pushes: PMs and channel mentions. The
	// Android shell's push service keeps its own ring, fed only for a network
	// it is subscribed on, and not for a message the page alerted about: that
	// alert went through the service, which records it as it shows it.
	if (
		!data.msg.self &&
		data.msg.msgid &&
		(data.msg.highlight || channel.type === ChanType.QUERY)
	) {
		recordSeenMsgid(data.msg.msgid);

		if (!shellAlerted) {
			webpush.recordSeenOnShell(receivingChannel.network.uuid, data.msg.msgid);
		}

		// Its push still shows under WebKit, quietly, beside what is up.
		webpush.tidySoon(receivingChannel.network.uuid);
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

		// Their translations (client/js/translate/reader.ts) are keyed by
		// message id and can never be reached again: they leave with them,
		// and so does the pipeline's memory of the work behind them.
		const droppedIds = dropped.map((m) => m.id);

		store.commit("translationRemoveMany", droppedIds);
		forgetTranslations(droppedIds);
		channel.moreHistoryAvailable = true;
		// The IRC layer must stop counting them as shown (bus-contract § 2).
		socket.emit("history:trim", {target: channel.id, ids: droppedIds});
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

/** Alert the user to `msg`; true when the alert went to a native shell. */
function notifyMessage(
	targetId: number,
	channel: ClientChan,
	activeChannel: NetChan | undefined,
	msg: ClientMessage
): boolean {
	if (channel.muted) {
		return false;
	}

	// Browser notifications enroll per network (the editor's checkbox,
	// default on): find the channel's network and honor its saved flag.
	const network = store.state.networks.find((net) => net.channels.some((c) => c === channel));

	if (!network || !saved.notifyEnabledOf(saved.get(network.uuid))) {
		return false;
	}

	// Do not disturb (global, this network's mode, or another device's):
	// nothing pops and nothing plays; unread counts and mentions are untouched.
	// This also covers the push worker's page-notification path below.
	if (network.presence?.dnd) {
		return false;
	}

	if (
		msg.highlight ||
		(store.state.settings.notifyAllMessages && msg.type === MessageType.MESSAGE)
	) {
		if (!document.hasFocus() || !activeChannel || activeChannel.channel !== channel) {
			const native = nativeAlertsAvailable();
			const ua = navigator.userAgent;
			const notifying =
				native || ("Notification" in window && Notification.permission === "granted");
			const sound = alertSound({
				soundOn: store.state.settings.notification,
				native,
				notifying,
				ios: "audioSession" in navigator && hasVirtualKeyboard(),
				// Linux and ChromeOS notifications are usually silent.
				osSound: !/Linux|CrOS/.test(ua) || /Android/.test(ua),
				visible: document.visibilityState === "visible",
			});

			if (sound.inPage) {
				// Autoplay may be blocked: on mobile, without user interaction.
				void playNotificationSound().catch(() => undefined);
			}

			if (notifying) {
				let title: string;
				let body: string;
				// TODO: fix msg type and get rid of that conditional
				const nick = msg.from && msg.from.nick ? msg.from.nick : "unkonown";

				if (msg.type === MessageType.INVITE) {
					title = t("notify.channelInvite");
					body = t("notify.inviteBody", {nick, channel: msg.channel ?? ""});
				} else {
					// Titles of "someone says" notifications, one per shape: the
					// whole sentence is the translator's, the nick and channel
					// inside it verbatim.
					if (msg.type === MessageType.MESSAGE) {
						title =
							channel.type !== ChanType.QUERY
								? t("notify.titleChannelSays", {nick, channel: channel.name})
								: t("notify.titleSays", {nick});
					} else {
						title =
							channel.type !== ChanType.QUERY
								? t("notify.titleChannel", {nick, channel: channel.name})
								: nick;
					}

					// TODO: fix msg type and get rid of that conditional
					// The same stripping as the service worker's push path, so a
					// live page and a push show the same body.
					body = notificationText(msg.text ? msg.text : "", {
						markdown: store.state.settings.markdown,
					});
				}

				const timestamp = Date.parse(String(msg.time));
				// The message in a push's terms, the wire text: the push
				// worker and the Android shell render an action as `* nick …`.
				const wire = {
					from: nick,
					text:
						msg.type === MessageType.INVITE
							? t("notify.inviteText", {channel: msg.channel ?? ""})
							: msg.type === MessageType.ACTION
							? `\x01ACTION ${msg.text ?? ""}\x01`
							: msg.text ?? "",
					msgid: msg.msgid,
					time: Number.isFinite(timestamp)
						? new Date(timestamp).toISOString()
						: undefined,
					notice: msg.type === MessageType.NOTICE,
				};

				if (native) {
					void showNativeAlert({
						network: network.uuid,
						target: channel.name,
						title,
						body,
						sound: !sound.silentNotification,
						message: wire,
					})
						.catch(() => false)
						.then((shown) => {
							// Notifications refused: the page's ping, as before the OS took it.
							if (!shown && store.state.settings.notification) {
								void playNotificationSound().catch(() => undefined);
							}
						});
					return true;
				}

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
							silent: sound.silentNotification,
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
								? wire
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
							silent: sound.silentNotification,
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

	return false;
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
