import socket from "../socket";
import {navigate} from "../router";
import {store} from "../store";

// A channel's bans, for the Bans window (Windows/BanList.vue). `open` is
// `/banlist` or a typed `/mode #chan b`: the window comes up to show them.
socket.on("channel:bans", function ({network, list, open}) {
	store.commit("banList", {network, list});

	if (open) {
		void navigate("BanList", {uuid: network, channel: list.channel});
	}
});
