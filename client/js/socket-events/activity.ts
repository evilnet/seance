// Consumer that drives the sidebar activity pulse: somebody spoke in a channel,
// so its icon breathes for a few seconds (helpers/activityPulse.ts explains the
// filter and the deadline; ChannelWrapper.vue and `.has-activity::before` in
// style.css do the showing).
//
// Runs after socket-events/msg.ts pushed the message, so a `showInActive`
// notice has already been re-routed to the active channel — hence the lookup by
// `data.chan` rather than the channel the IRC layer originally named.
import socket from "../socket";
import {store} from "../store";
import {ActivityExpiry, isActivity, noteActivity} from "../helpers/activityPulse";

// One ticker clears lapsed deadlines in every channel, not just the one on
// screen. It runs only while some channel is still pulsing and stops itself
// when none is.
const expiry = new ActivityExpiry(() =>
	store.state.networks.flatMap((network) => network.channels)
);

socket.on("msg", function (data) {
	if (!isActivity(data.msg)) {
		return;
	}

	const target = store.getters.findChannel(data.chan);

	if (!target) {
		return;
	}

	const {channel} = target;

	// Nothing to point at in the channel you are already reading, and a muted
	// channel is one you asked not to be shown — the same rule the typing
	// pulse, the unread counters and notifications all follow.
	if (channel.muted || store.state.activeChannel?.channel === channel) {
		return;
	}

	noteActivity(channel, Date.now());
	expiry.schedule();
});
