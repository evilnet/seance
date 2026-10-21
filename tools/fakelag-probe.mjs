#!/usr/bin/env node
/* eslint-disable no-console */
// How much fake lag does a server charge this connection? Registers over
// WebSocket, fires a burst of PINGs right after 001 and prints when each
// PONG comes back: an answer at once means the server parsed it at once,
// one every 2 s means the ircu clock is at its 10 s ceiling.
//
//   node tools/fakelag-probe.mjs wss://host:port/path [nick] [--count=20]
//        [--bursts=1] [--gap=5000] [--hold=70000] [--insecure]
//
// With SEANCE_SASL_ACCOUNT and SEANCE_SASL_PASSWORD set it logs in with
// SASL PLAIN first (the password only ever comes from the environment, and
// the AUTHENTICATE line is never printed). --count=0 sends nothing and
// holds the connection open for --hold ms: run that in another shell
// first to make the next login of the same account an alias attach
// instead of a held session's revive (nefarious2's draft/persistence).
// It leaves without QUIT, so a held session stays held.
//
// Measured on nefarious2 (2026-10-21): a guest gets 5 at once, then one
// every 2 s; a SASL alias attach 15 (10 s plus the 20 s POSTREG_GRACE
// credit); see docs/projects/connect-burst.md.

import {createRequire} from "node:module";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const option = (name, fallback) => {
	const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
	return flag ? Number(flag.slice(name.length + 3)) : fallback;
};
const url = positional[0];
const account = process.env.SEANCE_SASL_ACCOUNT;
const password = process.env.SEANCE_SASL_PASSWORD;
const sasl = Boolean(account && password);
const nick = positional[1] ?? account ?? `lagprobe${Math.floor(Math.random() * 1e5)}`;
const count = option("count", 20);
let bursts = option("bursts", 1);
const gap = option("gap", 5000);
const hold = option("hold", 70000);

if (!url) {
	console.error(
		"usage: node tools/fakelag-probe.mjs wss://host:port/path [nick] [--count=N] [--bursts=N] [--gap=ms] [--hold=ms] [--insecure]"
	);
	process.exit(1);
}

let Socket = globalThis.WebSocket;
let socketOptions;

if (process.argv.includes("--insecure")) {
	try {
		Socket = createRequire(import.meta.url)("ws");
		socketOptions = {rejectUnauthorized: false};
	} catch {
		console.error("--insecure needs `ws` from node_modules");
		process.exit(1);
	}
}

const ws = new Socket(url, ["text.ircv3.net"], socketOptions);
const sent = new Map();
let t001 = 0;
const send = (line) => ws.send(line);
const since = (t) => `+${((t - t001) / 1000).toFixed(2)} s`;

function burst(prefix) {
	const now = performance.now();

	for (let i = 0; i < count; i++) {
		sent.set(`${prefix}${i}`, now);
		send(`PING ${prefix}${i}`);
	}
}

ws.onopen = () => {
	send("CAP LS 302");
	send(`NICK ${nick}`);
	send(`USER ${nick} 0 * :${nick}`);
};

ws.onmessage = (event) => {
	for (const line of String(event.data).split(/\r?\n/)) {
		if (!line) {
			continue;
		}

		const now = performance.now();

		if (/ CAP \S+ LS (?!\*)/.test(line)) {
			if (sasl) {
				send("CAP REQ :sasl server-time");
				send("AUTHENTICATE PLAIN");
			} else {
				send("CAP REQ :server-time");
				send("CAP END");
			}
		} else if (/^AUTHENTICATE \+/.test(line)) {
			send(
				"AUTHENTICATE " +
					Buffer.from(`${account}\0${account}\0${password}`).toString("base64")
			);
		} else if (/ 90[2-7] /.test(line)) {
			console.log(/ 903 /.test(line) ? "sasl: ok" : `sasl: FAILED ${line.slice(0, 120)}`);
			send("CAP END");
		} else if (/ 001 /.test(line) && !t001) {
			t001 = now;
			console.log(count > 0 ? `001; ${count} PINGs` : `001; holding for ${hold} ms`);
			burst("p");
		} else if (/ PONG /.test(line)) {
			const m = / :?([pq]\d+_?\d*)$/.exec(line);

			if (!m || !sent.has(m[1])) {
				continue;
			}

			console.log(`${m[1].padEnd(6)} ${since(now)}`);
			sent.delete(m[1]);

			if (sent.size === 0 && --bursts > 0) {
				setTimeout(() => {
					console.log(`burst at ${since(performance.now())}`);
					burst(`q${bursts}_`);
				}, gap);
			} else if (sent.size === 0) {
				ws.close();
			}
		} else if (/^PING /.test(line)) {
			send(line.replace(/^PING/, "PONG"));
		} else if (/^ERROR| FAIL | 4(?!22 )\d\d /.test(line)) {
			console.log("<<", line.slice(0, 160));
		}
	}
};

ws.onclose = (event) => {
	console.log("close", event.code, event.reason ?? "");
	process.exit(0);
};

setTimeout(() => {
	console.log(sent.size > 0 ? `timeout; unanswered ${[...sent.keys()].join(",")}` : "done");
	process.exit(sent.size > 0 ? 1 : 0);
}, hold);
