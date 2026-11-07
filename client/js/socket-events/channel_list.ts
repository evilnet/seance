import socket from "../socket";
import {store} from "../store";

// A network's channel list, for the channel browser (Windows/ChannelBrowser.vue).
socket.on("channel:list", function (data) {
	store.commit("channelList", data);
});
