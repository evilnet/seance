// Fabricate a network in the running app, without an ircd: the snippet
// dispatches the same `init` bus event a registration dispatches
// (client/js/irc/client.ts onRegistered → bus.dispatch("init")), so the
// store, sidebar and chat window render exactly what a real connection
// would show. Rendering-only scenarios (i18n direction checks) use this to
// get sidebar rows, a channel window with messages and the composer without
// dialling anything.
//
// window.socket is dev-build-only (client/js/socket.ts), so scenarios that
// use this must run against a development build; the snippet reports false
// when the exposure is missing so the scenario can fail loudly instead of
// silently skipping its assertions.
//
// Each dispatch REPLACES the store's network list with the payload — the
// init handler commits the array wholesale, so a network absent from the
// payload vanishes. A second call that wants two networks must dispatch
// both, giving each its own uuid, nick, channel name and a baseId that
// keeps the channel ids clear of the other's (the store keys channels by
// id across networks). A disconnected network (connected:
// false) renders the connection bar on its channel window — the only way
// to that wave-A surface. The networks are memory-only: they live until
// the next navigation.

/**
 * JS source that evaluates to true when the dispatch ran, false when
 * `window.socket` is absent (production build).
 *
 * One network with a lobby, a channel (opened as the active window,
 * carrying a few messages) and a query row in the sidebar. The defaults
 * describe the connected "TestNet" rig the rtl-layout scenario loops over.
 */
export function fakeNetworkSnippet({
	uuid = "fake-0000-0000",
	name = "TestNet",
	nick = "seanobot",
	channel = "#seance",
	query = "moria",
	topic = "A room with mirrors on every wall",
	connected = true,
	baseId = 0,
} = {}) {
	const chanId = (n) => baseId + n;
	const status = JSON.stringify({connected, connecting: false, secure: false});

	return `(() => {
	if (typeof window.socket === "undefined") {
		return false;
	}

	const now = Date.now();
	const base = {mode: "", modes: [], away: "", lastMessage: now};
	const message = (id, from, text, minutesAgo) => ({
		id,
		type: "message",
		from: {...base, nick: from},
		text,
		self: from === ${JSON.stringify(nick)},
		time: new Date(now - minutesAgo * 60000),
		users: [],
	});
	const lobby = {
		id: ${chanId(1)},
		name: ${JSON.stringify(name)},
		key: "",
		topic: "",
		firstUnread: 0,
		unread: 0,
		highlight: 0,
		muted: false,
		type: "lobby",
		state: 1,
		messages: [],
		totalMessages: 0,
	};
	const chan = {
		id: ${chanId(2)},
		name: ${JSON.stringify(channel)},
		key: "",
		topic: ${JSON.stringify(topic)},
		firstUnread: 0,
		unread: 0,
		highlight: 0,
		muted: false,
		type: "channel",
		state: 1,
		messages: [
			message(${chanId(
				21
			)}, "moria", "the new channel theme renders mirrored under the pseudo locale", 24),
			message(${chanId(22)}, ${JSON.stringify(nick)}, "short one", 21),
			message(
				${chanId(23)},
				"moria",
				"a much longer line that has to wrap somewhere: the gutter keeps its columns while the text takes what width remains, exactly what the direction check wants to measure",
				18
			),
		],
		totalMessages: 3,
	};
	const query = {
		id: ${chanId(3)},
		name: ${JSON.stringify(query)},
		key: "",
		topic: "",
		firstUnread: 0,
		unread: 0,
		highlight: 0,
		muted: false,
		type: "query",
		state: 1,
		messages: [],
		totalMessages: 0,
	};
	const network = {
		uuid: ${JSON.stringify(uuid)},
		name: ${JSON.stringify(name)},
		nick: ${JSON.stringify(nick)},
		serverOptions: {
			CHANTYPES: ["#"],
			PREFIX: {prefix: [{symbol: "@", mode: "o"}], modeToSymbol: {o: "@"}, symbols: ["@"]},
			NETWORK: ${JSON.stringify(name)},
		},
		status: ${status},
		channels: [lobby, chan, query],
	};
	window.socket.dispatch("init", {active: chan.id, networks: [network]});
	return true;
})()`;
}

/** The default rig: one connected TestNet with #seance active. */
export const FAKE_NETWORK_SNIPPET = fakeNetworkSnippet();
