// Settings that follow the account, on TWO devices
// (docs/projects/settings-sync.md). Device A is browser-drive's page, device
// B a second Chromium with its own profile (lib/device.mjs).
//
//   pnpm build && python3 -m http.server -d public 8020 &
//   SEANCE_PORT=8020 node tools/browser-drive.mjs tools/scenarios/settings-sync.mjs
//
// No ircd and no file host needed: lib/tiny-ircd.mjs is scripted to log both
// devices in to one account (separate logins, so two nicks), keep its
// metadata, notify the other device of a SET as nefarious2 does (under the
// setter's nick, visibility `private`) and hand out file host tokens, and a
// small HTTP server here stands in for `draft/FILEHOST`.
//
// Claims:
//   1. the switch on a network's details (Settings → Networks → Edit) makes the network the sync home,
//      and the first device uploads what it holds: one encrypted file, and a
//      private pointer of four words;
//   2. a second device that sees the pointer asks, and on "Use them" takes
//      the account's settings and aliases (each alias said in the network's
//      window) and keeps what only it had;
//   3. a mute roams although the two devices know the network by different
//      uuids;
//   4. a change on the second device reaches the first live, which uploads
//      nothing back;
//   5. no console errors on either device.

import http from "node:http";
import {startDevice} from "./lib/device.mjs";
import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const BASE = `http://localhost:${PORT}/`;
// Outside browser-drive.mjs's DevTools ports (9222–10221), which are picked at random.
const IRCD_PORT = 9176;
const FILE_PORT = 9177;
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

/** The stand-in for the network's file host: CORS as PASTE's filehost.php answers it. */
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
				const body = Buffer.concat(chunks);
				const path = `/f/${posts.length + 1}`;
				files.set(path, body);
				posts.push({
					body,
					type: req.headers["content-type"],
					authorization: req.headers.authorization,
				});
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

/** The ircd's part: one account, its metadata, tokens. */
function startIrcd() {
	const metadata = new Map();
	const sets = [];
	const conns = new Map(); // send → nick
	let tokens = 0;

	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "batch draft/metadata-2 draft/authtoken",
		isupport: `draft/FILEHOST=${FILEHOST}/filehost`,
		onLine(line, {send, nick}) {
			conns.set(send, nick);
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
				sets.push({key, visibility: words[4], value});

				if (value) {
					metadata.set(key, value);
				} else {
					metadata.delete(key);
				}

				// nefarious2 m_metadata.c: the setter's 761, then a private key's
				// change to the account's other sessions, named by the setter's
				// nick (not theirs: these are separate logins).
				send(
					value
						? `:tiny.test 761 ${nick} ${nick} ${key} private :${value}`
						: `:tiny.test 766 ${nick} ${nick} ${key} :key not set`
				);

				for (const other of conns.keys()) {
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

const LOBBY_TEXT = `[...document.querySelectorAll("#chat .msg .content, #chat .msg .text")].map((el) => el.textContent).join("\\n")`;
const stored = (key) => `JSON.parse(localStorage.getItem(${JSON.stringify(key)}) ?? "null")`;

async function seed(dev, values) {
	await dev.goto(BASE, {waitForSelector: "#connect form"});

	for (const [key, value] of Object.entries(values)) {
		await dev.evaluate(
			`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(value))})`
		);
	}
}

/** Flip a setting's switch on Settings → Appearance or Notifications, by its name. */
async function flip(dev, tab, name) {
	await dev.goto(`${BASE}#/settings/${tab}`, {waitForSelector: `input[name="${name}"]`});
	await dev.evaluate(`document.querySelector('input[name="${name}"]').click()`);
	await dev.sleep(200);
}

export default async function run(page) {
	const ircd = startIrcd();
	const filehost = startFilehost();
	const b = await startDevice({name: "B"});

	try {
		// --- 1. the first device ---
		await seed(page, {
			"thelounge.networks": [net("aaaa-home", "deva")],
			"thelounge.aliases": [{name: "wave", body: "/me waves at $1"}],
			"thelounge.muted": ["aaaa-home/#tiny"],
		});
		await page.goto(BASE, {waitForSelector: "#network-aaaa-home"});
		await flip(page, "appearance", "showSeconds");
		await page.goto(`${BASE}#/settings/networks`, {waitForSelector: ".network-settings-item"});
		page.check(
			"the list of networks has no switch, and no mark yet",
			!(await page.evaluate(
				`!!document.querySelector(".network-settings-sync, .network-settings-synced")`
			))
		);
		await page.goto(`${BASE}#/settings/networks/aaaa-home`, {
			waitForSelector: ".network-settings-sync",
		});
		await page.waitFor(
			`document.querySelector(".network-settings-sync input")?.disabled === false`,
			{label: "the switch can be switched on", timeout: 15000}
		);
		await page.screenshot("settings-sync-off");
		await page.evaluate(`document.querySelector(".network-settings-sync input").click()`);
		await page.waitFor(`document.querySelector(".network-settings-sync input")?.checked`, {
			label: "the switch is on",
		});
		page.check(
			"the home is this network",
			(await page.evaluate(`${stored("thelounge.state.sync")}?.home`)) === "aaaa-home"
		);

		// The login read (10 s), then the quiet spell (10 s).
		const until = Date.now() + 40000;

		while (filehost.posts.length < 1 && Date.now() < until) {
			await page.sleep(500);
		}

		page.check("the first device uploaded one file", filehost.posts.length === 1);
		await page.screenshot("settings-sync-on");
		const first = filehost.posts[0];
		page.check("as application/octet-stream", first?.type === "application/octet-stream");
		page.check("with the token as the bearer", first?.authorization === "Bearer token-1");
		page.check(
			"encrypted: nothing of an alias or a setting's name shows",
			!!first && !/waves|showSeconds|alias|seance-sync/.test(first.body.toString("latin1"))
		);
		const until2 = Date.now() + 5000;

		while (!ircd.sets.some((s) => s.key === SYNC_KEY) && Date.now() < until2) {
			await page.sleep(200);
		}

		const pointer = ircd.sets.find((s) => s.key === SYNC_KEY);
		page.check("the pointer is written private", pointer?.visibility === "private");
		page.check(
			"the pointer is version, URL, key and time",
			new RegExp(`^1 ${FILEHOST}/f/1 [A-Za-z0-9_-]{43} \\d{13}$`).test(pointer?.value ?? "")
		);

		// --- 2. the second device ---
		await seed(b, {
			"thelounge.networks": [net("bbbb-home", "devb")],
			"thelounge.aliases": [{name: "mine", body: "/me is here"}],
		});
		await b.goto(BASE, {waitForSelector: "#network-bbbb-home"});
		await b.waitFor(`!!document.querySelector("#confirm-dialog")`, {
			label: "the second device asks",
			timeout: 20000,
		});
		const question = await b.evaluate(`document.querySelector("#confirm-dialog").textContent`);
		page.check("it names the account", question.includes(ACCOUNT));
		page.check(
			"it offers three answers",
			(await b.count(
				"#confirm-dialog .btn-confirm, #confirm-dialog .btn-alt, #confirm-dialog .btn-cancel"
			)) === 3
		);
		await b.sleep(700); // the question takes no answer in its first 450 ms
		await b.click("#confirm-dialog .btn-confirm");
		await b.waitFor(`${stored("thelounge.state.sync")}?.joined === true`, {
			label: "the second device joined",
			timeout: 15000,
		});
		const aliases = await b.evaluate(`${stored("thelounge.aliases")}.map((a) => a.name)`);
		page.check(
			"it holds the account's alias and its own",
			JSON.stringify(aliases) === JSON.stringify(["mine", "wave"])
		);
		page.check(
			"it took the account's setting",
			(await b.evaluate(`${stored("settings")}?.showSeconds`)) === true
		);
		// --- 3. the mute, under this device's own uuid for the network ---
		page.check(
			"the mute roamed to this device's uuid",
			JSON.stringify(await b.evaluate(stored("thelounge.muted"))) ===
				JSON.stringify(["bbbb-home/#tiny"])
		);
		page.check(
			"and the channel shows muted without a reload",
			await b.evaluate(
				`!!document.querySelector('.channel-list-item[data-name="#tiny"].is-muted')`
			)
		);
		await b.click('#network-bbbb-home .channel-list-item[data-type="lobby"]');
		await b.waitFor(`(${LOBBY_TEXT}).includes("/wave")`, {
			label: "the alias sync added is said in the network's window",
		});

		// --- 4. a change on the second device reaches the first, live ---
		// The account's five minutes between uploads, skipped: the last upload
		// is dated six minutes back on this device.
		await b.evaluate(
			`(() => { const s = ${stored("thelounge.state.sync")}; s.uploadedAt -= 360000; ` +
				`localStorage.setItem("thelounge.state.sync", JSON.stringify(s)); })()`
		);
		await flip(b, "appearance", "coloredNicks");
		const until3 = Date.now() + 30000;

		while (filehost.posts.length < 2 && Date.now() < until3) {
			await page.sleep(500);
		}

		page.check("the second device uploaded the merge", filehost.posts.length === 2);
		await page.waitFor(`${stored("settings")}?.coloredNicks === false`, {
			label: "the first device took the setting",
			timeout: 10000,
		});
		page.check(
			"the first device took the other's alias",
			JSON.stringify(
				await page.evaluate(`${stored("thelounge.aliases")}.map((a) => a.name)`)
			) === JSON.stringify(["wave", "mine"])
		);
		page.check(
			"and holds nothing the file does not",
			!(await page.evaluate(`!!${stored("thelounge.state.sync")}?.dirty`))
		);
		await page.sleep(3000);
		page.check("which uploads nothing back", filehost.posts.length === 2);
		page.check(
			"both devices hold the same pointer",
			(await page.evaluate(`${stored("thelounge.state.sync")}?.pointer`)) ===
				(await b.evaluate(`${stored("thelounge.state.sync")}?.pointer`))
		);
		await page.goto(`${BASE}#/settings/networks`, {
			waitForSelector: ".network-settings-synced",
		});
		page.check(
			"the list marks the network settings sync with",
			(await page.evaluate(
				`document.querySelector(".network-settings-synced")?.getAttribute("aria-label")`
			)) === "Settings sync with your account here"
		);
		page.check(
			"with a glyph that takes room",
			(await page.evaluate(
				`document.querySelector(".network-settings-synced").getBoundingClientRect().width`
			)) > 4
		);
		await page.screenshot("settings-sync-synced");
		await page.goto(`${BASE}#/settings/networks/aaaa-home`, {
			waitForSelector: ".network-settings-sync",
		});

		// --- 5. "Sync now": inside the five minutes, with nothing waited out ---
		const NOW_BUTTON = `document.querySelector(".network-settings-sync-now button")`;
		const NOW_TEXT = `(document.querySelector(".network-settings-sync-now [role=status]")?.textContent ?? "")`;
		await page.waitFor(`!!${NOW_BUTTON}`, {label: "the first device shows Sync now"});
		await page.evaluate(`${NOW_BUTTON}.click()`);
		await page.waitFor(`${NOW_TEXT}.includes("Nothing new")`, {
			label: "with nothing changed it says there is nothing to send",
			timeout: 15000,
		});
		page.check("and uploads nothing", filehost.posts.length === 2);
		await flip(page, "appearance", "showSeconds");
		await page.goto(`${BASE}#/settings/networks/aaaa-home`, {
			waitForSelector: ".network-settings-sync-now button",
		});
		await page.evaluate(`${NOW_BUTTON}.click()`);
		await page.waitFor(`${NOW_TEXT}.includes("were sent")`, {
			label: "after a change it says the settings were sent",
			timeout: 15000,
		});
		page.check("in one upload, at once", filehost.posts.length === 3);
		await page.evaluate(
			`document.querySelector(".network-settings-sync").scrollIntoView({block: "center"})`
		);
		await page.screenshot("settings-sync-now");
		const seconds = await page.evaluate(`${stored("settings")}?.showSeconds`);
		await b.waitFor(`${stored("settings")}?.showSeconds === ${seconds}`, {
			label: "the second device took the change",
			timeout: 10000,
		});

		// --- 6. ---
		page.check(
			`no console errors on B (${b.consoleErrors.join(" | ")})`,
			b.consoleErrors.length === 0
		);
	} finally {
		await b.close();
		await ircd.close();
		await filehost.close();
	}
}
