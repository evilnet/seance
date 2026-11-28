// A deploy that syncs every account (`features.alwaysSync`,
// docs/projects/settings-sync.md § A deploy that syncs every account), on
// TWO devices. settings-sync.mjs covers sync with its switch and its
// question; this one covers the deploy that has neither.
//
// The config is read at boot, so a copy of the built tree with its own
// config.json is enough (public/ itself stays as it is):
//
//   pnpm build
//   rm -rf /tmp/always-sync && cp -r public /tmp/always-sync
//   cat > /tmp/always-sync/config.json <<'JSON'
//   {
//     "appName": "Tiny Chat",
//     "defaultNetwork": {"name": "Tiny", "host": "127.0.0.1", "port": 9186, "tls": false},
//     "features": {"signIn": true, "editNetworks": false, "alwaysSync": true}
//   }
//   JSON
//   python3 -m http.server -d /tmp/always-sync 8032 &
//   SEANCE_PORT=8032 node tools/browser-drive.mjs tools/scenarios/settings-sync-always.mjs
//
// No ircd and no file host needed: the stand-ins are settings-sync.mjs's
// (lib/tiny-ircd.mjs scripted to log every connection in to one account and
// keep its metadata, and an HTTP server for `draft/FILEHOST`), on ports of
// their own so both scenarios can run at once.
//
// Claims:
//   1. the first device, logged in, becomes the sync home and uploads with
//      nothing clicked and nothing asked;
//   2. the Account page has no switch: the status and "Sync now" only;
//   3. a second device joins without a question, takes the account's
//      settings and aliases and keeps what only it had;
//   4. no console errors on either device.

import http from "node:http";
import {startDevice} from "./lib/device.mjs";
import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const BASE = `http://localhost:${PORT}/`;
// Outside browser-drive.mjs's DevTools ports (9222–10221) and settings-sync.mjs's own.
const IRCD_PORT = 9186;
const FILE_PORT = 9187;
const FILEHOST = `http://127.0.0.1:${FILE_PORT}`;
const SYNC_KEY = "seance/sync";
const ACCOUNT = "syncer";

export const url = BASE;
// The stand-in ircd goes away at the end while the page is still open, and
// the page's redial is refused.
export const allowWsFrameErrors = /ERR_CONNECTION_REFUSED/;

const net = (uuid, nick) => ({
	uuid,
	name: "Tiny",
	host: "127.0.0.1",
	port: IRCD_PORT,
	tls: false,
	nick,
	join: "#tiny",
	sasl: "",
	saslAccount: "",
	saslPassword: "",
	autoconnect: true,
});

function startFilehost() {
	const files = new Map();
	const posts = [];
	const cors = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Expose-Headers": "Location",
	};
	const server = http.createServer((req, res) => {
		if (req.method === "OPTIONS") {
			res.writeHead(204, cors).end();
			return;
		}

		if (req.method === "POST" && req.url === "/filehost") {
			const chunks = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => {
				const path = `/f/${posts.length + 1}`;
				files.set(path, Buffer.concat(chunks));
				posts.push(path);
				res.writeHead(201, {...cors, Location: `${FILEHOST}${path}`}).end();
			});
			return;
		}

		const file = files.get(req.url);

		if (!file) {
			res.writeHead(404, cors).end();
			return;
		}

		res.writeHead(200, {...cors, "Content-Type": "application/octet-stream"}).end(file);
	});
	server.listen(FILE_PORT, "127.0.0.1");
	return {posts, close: () => new Promise((resolve) => server.close(resolve))};
}

function startIrcd() {
	const metadata = new Map();
	const sets = [];
	const conns = new Set();
	let tokens = 0;

	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "batch draft/metadata-2 draft/authtoken",
		isupport: `draft/FILEHOST=${FILEHOST}/filehost`,
		onLine(line, {send, nick}) {
			conns.add(send);
			const words = line.split(" ");
			const command = words[0].toUpperCase();

			if (command === "CAP" && words[1] === "END") {
				send(
					`:tiny.test 900 ${nick} ${nick}!u@tiny ${ACCOUNT} :You are now logged in as ${ACCOUNT}`
				);
				// nefarious2: the one family that keeps a metadata key private.
				send(
					`:tiny.test 004 ${nick} tiny.test u2.10.12.14+Nefarious(2.0.0) iow bklmnopstv bklov`
				);
				return false;
			}

			if (command === "TOKEN") {
				send(`:tiny.test TOKEN GENERATE FILEHOST :token-${++tokens}`);
				return true;
			}

			if (command !== "METADATA") {
				return false;
			}

			if (words[2] === "SUB") {
				send(`:tiny.test 770 ${nick} ${words.slice(3).join(" ")}`);
			} else if (words[2] === "GET") {
				for (const key of words.slice(3)) {
					send(
						metadata.has(key)
							? `:tiny.test 761 ${nick} ${nick} ${key} private :${metadata.get(key)}`
							: `:tiny.test 766 ${nick} ${nick} ${key} :key not set`
					);
				}

				send(`:tiny.test 762 ${nick} :end of metadata`);
			} else if (words[2] === "SET") {
				const key = words[3];
				const value = line.includes(" :") ? line.slice(line.indexOf(" :") + 2) : "";
				sets.push({key, value});

				if (value) {
					metadata.set(key, value);
				} else {
					metadata.delete(key);
				}

				send(
					value
						? `:tiny.test 761 ${nick} ${nick} ${key} private :${value}`
						: `:tiny.test 766 ${nick} ${nick} ${key} :key not set`
				);

				for (const other of conns) {
					if (other !== send) {
						other(
							`:tiny.test METADATA ${nick} ${key} private${value ? ` :${value}` : ""}`
						);
					}
				}
			}

			return true;
		},
	});

	return {sets, close: () => ircd.close()};
}

const stored = (key) => `JSON.parse(localStorage.getItem(${JSON.stringify(key)}) ?? "null")`;
const SYNC = stored("thelounge.state.sync");

async function seed(dev, values) {
	await dev.goto(BASE, {waitForSelector: "#connect, #sign-in, form"});

	for (const [key, value] of Object.entries(values)) {
		await dev.evaluate(
			`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(value))})`
		);
	}
}

export default async function run(page) {
	const config = await (await fetch(`${BASE}config.json`)).json();

	if (config.features?.alwaysSync !== true || config.defaultNetwork?.port !== IRCD_PORT) {
		throw new Error("serve the config.json this scenario's header gives");
	}

	const ircd = startIrcd();
	const filehost = startFilehost();
	const b = await startDevice({name: "B"});
	let asked = false;

	try {
		// --- 1. the first device ---
		await seed(page, {
			"thelounge.networks": [net("aaaa-home", "deva")],
			"thelounge.aliases": [{name: "wave", body: "/me waves at $1"}],
			settings: {showSeconds: true},
		});
		await page.goto(BASE, {waitForSelector: "#network-aaaa-home"});
		await page.waitFor(`${SYNC}?.home === "aaaa-home"`, {
			label: "the network is the sync home with nothing clicked",
			timeout: 20000,
		});
		page.check(
			"for the account logged in",
			(await page.evaluate(`${SYNC}?.account`)) === ACCOUNT
		);

		// The login read (10 s), then the quiet spell (10 s).
		const until = Date.now() + 40000;

		while (
			!(filehost.posts.length && ircd.sets.some((s) => s.key === SYNC_KEY)) &&
			Date.now() < until
		) {
			asked ||= await page.evaluate(`!!document.querySelector("#confirm-dialog")`);
			await page.sleep(500);
		}

		page.check("the first device uploaded one file", filehost.posts.length === 1);
		page.check(
			"and set the pointer",
			ircd.sets.some((s) => s.key === SYNC_KEY && s.value.includes(`${FILEHOST}/f/1`))
		);
		page.check("nothing was asked", !asked);

		// --- 2. the Account page ---
		await page.goto(`${BASE}#/settings/networks`, {waitForSelector: ".network-settings-sync"});
		page.check(
			"the Account page has no sync switch",
			(await page.count(".network-settings-sync input")) === 0
		);
		page.check(
			"it says who settings sync with",
			(
				await page.evaluate(
					`document.querySelector(".network-settings-sync-note").textContent`
				)
			).includes(ACCOUNT)
		);
		page.check(
			"and offers Sync now",
			(await page.count(".network-settings-sync-now button")) === 1
		);
		await page.evaluate(
			`document.querySelector(".network-settings-sync").scrollIntoView({block: "center"})`
		);
		await page.screenshot("settings-sync-always");

		// --- 3. the second device ---
		await seed(b, {
			"thelounge.networks": [net("bbbb-home", "devb")],
			"thelounge.aliases": [{name: "mine", body: "/me is here"}],
		});
		await b.goto(BASE, {waitForSelector: "#network-bbbb-home"});
		await b.waitFor(`${SYNC}?.joined === true`, {
			label: "the second device joined",
			timeout: 30000,
		});
		page.check(
			"without a question",
			!(await b.evaluate(`!!document.querySelector("#confirm-dialog")`))
		);
		page.check(
			"its home is its own entry for the network",
			(await b.evaluate(`${SYNC}?.home`)) === "bbbb-home"
		);
		page.check(
			"it holds the account's alias and its own",
			JSON.stringify(
				await b.evaluate(`${stored("thelounge.aliases")}.map((a) => a.name)`)
			) === JSON.stringify(["mine", "wave"])
		);
		page.check(
			"it took the account's setting",
			(await b.evaluate(`${stored("settings")}?.showSeconds`)) === true
		);

		// --- 4. ---
		page.check(
			`no console errors on the second device (${b.consoleErrors.join(" | ")})`,
			b.consoleErrors.length === 0
		);
	} finally {
		await b.close();
		await ircd.close();
		await filehost.close();
	}
}
