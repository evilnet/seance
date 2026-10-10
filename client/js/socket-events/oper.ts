// Oper state per network (irc/oper.ts): what the oper button, the oper
// panel and the oper context-menu entries read.
import socket from "../socket";
import {store} from "../store";

socket.on("oper:state", function (data) {
	const network = store.getters.findNetwork(data.network);

	if (network) {
		network.oper = data.state;
	}
});
