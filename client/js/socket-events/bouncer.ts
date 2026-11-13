// soju's networks on a bouncer connection (irc/bouncer.ts): what the bouncer
// panel lists.
import socket from "../socket";
import {store} from "../store";

socket.on("bouncer:networks", function (data) {
	const network = store.getters.findNetwork(data.network);

	if (network) {
		network.bouncer = data.networks;
	}
});
