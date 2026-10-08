/**
 * TOPIC and the 331/332/333 replies.
 */

import {MessageType} from "../../../../shared/types/msg";
import {msgidOf} from "../message";
import type {Handler} from "../types";

const topicChange: Handler = (client, msg) => {
	const [name, topic = ""] = msg.params;
	const chan = name ? client.findChannel(name) : undefined;
	const nick = msg.source?.name ?? "";

	if (!chan) {
		return;
	}

	client.pushMessage(chan, {
		type: MessageType.TOPIC,
		time: client.timeOf(msg),
		from: chan.userRef(nick),
		text: topic,
		self: client.isSelf(nick),
		...msgidOf(msg),
	});

	if (client.replaying) {
		return; // history: the current topic came from 332
	}

	chan.shared.topic = topic;
	client.dispatch("topic", {chan: chan.id, topic});
};

// RPL_TOPIC: <me> <channel> :<topic>
const rplTopic: Handler = (client, msg) => {
	const [, name, topic = ""] = msg.params;
	const chan = name ? client.findChannel(name) : undefined;

	if (!chan) {
		// Only the reply to a `/topic #chan` we are not in; otherwise state
		// for a channel we do not show, which has nowhere to go.
		if (name && client.takeInfoAsked(name)) {
			client.pushMessage(client.lobby, {
				time: client.timeOf(msg),
				text: `Topic for ${name}: ${topic}`,
				showInActive: true,
			});
		}

		return;
	}

	// Every join burst repeats the topic, and one reconnect can bring
	// several: the server restoring a held session, our own re-JOIN, and —
	// while another client of the account holds the session and we are
	// attached as an alias — nefarious2's answer to that JOIN (m_join.c,
	// "already a member"). Say it when it is news, or when asked (/topic).
	const asked = chan.topicAsked;
	chan.topicQuiet = topic === chan.shared.topic && !asked;
	chan.topicAsked = false;
	chan.topicAskedActive = asked;

	if (chan.topicQuiet) {
		return;
	}

	client.pushMessage(chan, {
		type: MessageType.TOPIC,
		time: client.timeOf(msg),
		text: topic,
		showInActive: asked || undefined,
	});
	chan.shared.topic = topic;
	client.dispatch("topic", {chan: chan.id, topic});
};

// RPL_NOTOPIC: <me> <channel> :No topic is set
const rplNoTopic: Handler = (client, msg) => {
	const name = msg.params[1];
	const chan = name ? client.findChannel(name) : undefined;

	if (!chan) {
		if (name && client.takeInfoAsked(name)) {
			client.pushMessage(client.lobby, {
				time: client.timeOf(msg),
				text: `No topic is set for ${name}.`,
				showInActive: true,
			});
		}

		return;
	}

	chan.topicQuiet = false;

	if (chan.topicAsked) {
		chan.topicAsked = false;
		client.pushMessage(chan, {
			time: client.timeOf(msg),
			text: "No topic is set.",
			showInActive: true,
		});
	}

	chan.shared.topic = "";
	client.dispatch("topic", {chan: chan.id, topic: ""});
};

// RPL_TOPICWHOTIME: <me> <channel> <setter> <unix time>
const rplTopicWhoTime: Handler = (client, msg) => {
	const [, name, setter = "", when = ""] = msg.params;
	const chan = name ? client.findChannel(name) : undefined;

	if (!chan) {
		return;
	}

	if (chan.topicQuiet) {
		chan.topicQuiet = false;
		return;
	}

	const asked = chan.topicAskedActive;
	chan.topicAskedActive = false;

	const nick = setter.split("!")[0];
	const seconds = parseInt(when, 10);

	client.pushMessage(chan, {
		type: MessageType.TOPIC_SET_BY,
		time: client.timeOf(msg),
		from: chan.userRef(nick),
		when: Number.isNaN(seconds) ? new Date() : new Date(seconds * 1000),
		self: client.isSelf(nick),
		showInActive: asked || undefined,
	});
};

export default {TOPIC: topicChange, "331": rplNoTopic, "332": rplTopic, "333": rplTopicWhoTime};
