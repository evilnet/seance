// A bouncer's networks on its control connection (irc/bouncer.ts): what the
// bouncer panel lists, and whether it may change them.
import socket from "../socket";
import {store} from "../store";

socket.on("bouncer:networks", function (data) {
	const network = store.getters.findNetwork(data.network);

	if (network) {
		network.bouncer = data.networks;
		network.bouncerEditable = data.editable;
	}
});
