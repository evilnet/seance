/**
 * Live integration test for WsTransport against a real nefarious2 (ircv3.2-upgrade).
 *
 * Skipped unless SEANCE_IRC_URL is set, e.g.
 *   SEANCE_IRC_URL=wss://localhost:8443/ NODE_ENV=test \
 *     pnpm exec mocha --config=test/.mocharc.yml \
 *     test/irc/transport.live.ts
 *
 * See docs/resources/nefarious2-dev.md for starting the dev server (docker
 * container `nefarious-dev`, wss on 8443; the plain ws port is broken upstream).
 */
import {expect} from "chai";
import {createRequire} from "node:module";
import {WsTransport, TransportEvent} from "../../client/js/irc/transport";

const url = process.env.SEANCE_IRC_URL;
const describeLive = url ? describe : describe.skip;

/**
 * The dev server uses a self-signed certificate. Node's global WebSocket
 * (undici) offers no per-connection TLS options, but it does honour
 * NODE_TLS_REJECT_UNAUTHORIZED read at connect time, so we set it in-process for
 * localhost targets only. Never do this for a real network address.
 */
function allowSelfSignedForLocalhost(target: string): void {
	const host = new URL(target).hostname;

	if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	}
}

/** Prefer the global WebSocket (Node >= 22); fall back to `ws` from node_modules. */
function pickWebSocketImpl(): typeof WebSocket | undefined {
	if (typeof globalThis.WebSocket === "function") {
		return undefined; // let the transport use the global
	}

	// `ws` is only a transitive dependency of this repo, hence the dynamic require.
	return createRequire(__filename)("ws") as typeof WebSocket;
}

function command(line: string): string {
	const words = line.split(" ");
	let i = 0;

	if (words[i]?.startsWith("@")) {
		i++;
	}

	if (words[i]?.startsWith(":")) {
		i++;
	}

	return (words[i] ?? "").toUpperCase();
}

describeLive("WsTransport (live nefarious2)", function () {
	this.timeout(20_000);

	it("registers, joins #seance and quits", async function () {
		allowSelfSignedForLocalhost(url as string);
		const nick = `seancet${Math.floor(1000 + Math.random() * 9000)}`;
		const transport = new WsTransport({
			url: url as string,
			subprotocols: ["text.ircv3.net", "binary.ircv3.net"],
			reconnect: {enabled: false, initialDelayMs: 1, maxDelayMs: 1, factor: 1, jitter: false},
			WebSocketImpl: pickWebSocketImpl(),
		});

		const events: TransportEvent[] = [];
		const seen: string[] = []; // e.g. "open", "<< 001", ">> JOIN"
		const transcript: string[] = [];

		const send = (line: string): void => {
			transcript.push(`>> ${line}`);
			seen.push(`>> ${command(line)}`);
			transport.send(line);
		};

		let joined = false;

		const done = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out\n" + transcript.join("\n"))),
				15_000
			);
			transport.on((ev) => {
				events.push(ev);

				switch (ev.type) {
					case "open":
						seen.push("open");
						transcript.push(`-- open (${ev.subprotocol})`);
						send("CAP LS 302");
						send(`NICK ${nick}`);
						send("USER seance 0 * :Seance test");
						send("CAP END");
						break;

					case "line": {
						transcript.push(`<< ${ev.line}`);
						const cmd = command(ev.line);
						seen.push(`<< ${cmd}`);

						if (cmd === "001") {
							send("JOIN #seance");
						} else if (cmd === "JOIN" && ev.line.startsWith(`:${nick}!`) && !joined) {
							joined = true;
							send("QUIT :Seance test done");
						} else if (cmd === "ERROR") {
							transport.close(); // server drops TCP after QUIT without a WS Close frame
						}

						break;
					}

					case "close":
						seen.push("close");
						transcript.push(
							`-- close (${ev.code} ${ev.reason}) willReconnect=${ev.willReconnect}`
						);
						clearTimeout(timer);
						resolve();
						break;
					case "error":
						transcript.push(`-- error ${ev.message}`);
						break;
					case "reconnecting":
						transcript.push(`-- reconnecting attempt ${ev.attempt}`);
						break;
				}
			});
		});

		transport.connect();
		await done;

		if (process.env.SEANCE_IRC_VERBOSE) {
			process.stderr.write(transcript.join("\n") + "\n");
		}

		expect(events[0]).to.deep.equal({type: "open", subprotocol: "text.ircv3.net"});
		expect(seen.indexOf("<< CAP")).to.be.greaterThan(seen.indexOf(">> CAP"));
		expect(seen).to.include("<< 001");
		expect(seen.indexOf("<< 001")).to.be.greaterThan(seen.indexOf(">> CAP END"));
		expect(seen.indexOf(">> JOIN")).to.be.greaterThan(seen.indexOf("<< 001"));
		expect(seen.indexOf("<< JOIN")).to.be.greaterThan(seen.indexOf(">> JOIN"));
		expect(seen.indexOf(">> QUIT")).to.be.greaterThan(seen.indexOf("<< JOIN"));
		expect(seen.indexOf("<< ERROR")).to.be.greaterThan(seen.indexOf(">> QUIT"));
		expect(seen[seen.length - 1]).to.equal("close");
		expect(events.some((e) => e.type === "reconnecting")).to.equal(false);
		expect(events[events.length - 1]).to.include({type: "close", willReconnect: false});
		expect(transport.state).to.equal("closed");
		expect(transcript.some((l) => l.startsWith(`<< :irc.`) && l.includes(" 005 "))).to.equal(
			true
		);
	});
});
