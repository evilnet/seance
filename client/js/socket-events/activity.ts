// Consumer that drives the sidebar activity pulse: somebody spoke in a channel,
// so its icon breathes for a few seconds (helpers/activityPulse.ts explains the
// filter and the deadline; ChannelWrapper.vue and `.has-activity::before` in
// style.css do the showing). A live mention there also holds the row's
// `data-mentioned` for a theme (docs/resources/themes.md § Live rows), with a
// deadline of its own on the same sweep; style.css shows nothing for it.
//
// Runs after socket-events/msg.ts pushed the message, so a `showInActive`
// notice has already been re-routed to the active channel — hence the lookup by
// `data.chan` rather than the channel the IRC layer originally named.
import socket from "../socket";
import {store} from "../store";
import {ActivityExpiry, isActivity, noteActivity, noteMention} from "../helpers/activityPulse";
import {liveKindOf} from "../liveRows";

// One ticker clears lapsed deadlines in every channel, not just the one on
// screen. It runs only while some channel is still pulsing or mentioned and
// stops itself when none is.
const expiry = new ActivityExpiry(() =>
	store.state.networks.flatMap((network) => network.channels)
);

// A mention elsewhere is for the conversation you are not in: opening it ends
// the hold, so leaving it again at once does not show the hold's remainder.
store.watch(
	(state) => state.activeChannel?.channel,
	(channel) => {
		if (channel) {
			channel.mentionUntil = 0;
		}
	}
);

socket.on("msg", function (data) {
	// A live mention, as a row in the open conversation would mark it
	// (liveRows.ts): never history, catch-up or a placed line, never an edit,
	// nor while the page is hidden.
	const mention =
		!data.replay &&
		!data.placed &&
		document.visibilityState === "visible" &&
		liveKindOf(data.msg) === "mention";

	if (!mention && !isActivity(data.msg)) {
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

	if (mention) {
		noteMention(channel, Date.now());
		expiry.schedule();
	}

	if (isActivity(data.msg)) {
		noteActivity(channel, Date.now());
		expiry.schedule();
	}
});
