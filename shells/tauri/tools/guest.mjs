// A second user for the walk-through: joins #seance on the dev ircd, says good
// morning, greets ghost when ghost joins, and stays two minutes.
//   node guest.mjs [ws://localhost:8067/]
const ws = new WebSocket(process.argv[2] ?? "ws://localhost:8067/", "text.ircv3.net");
const send = (line) => ws.send(line);

ws.onopen = () => {
	send("NICK alice");
	send("USER alice 0 * :alice");
};

ws.onmessage = (event) => {
	const line = String(event.data);

	if (line.startsWith("PING")) {
		send("PONG" + line.slice(4));
	} else if (/ 001 /.test(line)) {
		send("JOIN #seance");
	} else if (/ 366 alice #seance /.test(line)) {
		setTimeout(() => send("PRIVMSG #seance :morning all"), 300);
	} else if (line.startsWith(":ghost") && /JOIN :?#seance/.test(line)) {
		setTimeout(() => send("PRIVMSG #seance :hey ghost, is that the new desktop app?"), 400);
	}
};

setTimeout(() => process.exit(0), 120000);
