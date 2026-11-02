// The "seen" ring for a multiline message, in a real browser
// (docs/projects/push-payload-multiline.md §3.2 and §5.3, client/js/push-seen.ts).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/push-seen-multiline.mjs
//
// Against another rig, point both ends elsewhere:
//   SEANCE_IRC_WS=ws://127.0.0.1:8067/ node tools/browser-drive.mjs \
//     tools/scenarios/push-seen-multiline.mjs \
//     --url='http://127.0.0.1:8002/?host=127.0.0.1&port=8067&tls=false&nick=seenpage&autoconnect=1'
//
// What `pnpm test` cannot see: a live page that receives a multiline
// message over its own WebSocket writes the msgid from the BATCH opener
// into the IndexedDB `seen` ring the service worker reads. The ircd puts
// that same msgid as the `batch` reference on every pushed line of the
// message (only the first line carries it as `msgid`), so the worker can
// drop every line of a message the page already has. A Node bot sends a
// multiline PM and a plain PM to the page (a query is always pushable) and
// reads the msgids off its own echoes, the values the ircd puts on the
// pushes.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const RUN = Date.now().toString(36);
const BOT = `mlbot${RUN.slice(-5)}`;

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=seenpage&autoconnect=1";

/** `@a=1;b=x :prefix …` → {a: "1", b: "x"} (values unescaped enough for a msgid). */
function tagsOf(line) {
	if (!line.startsWith("@")) {
		return {};
	}

	const out = {};

	for (const pair of line.slice(1, line.indexOf(" ")).split(";")) {
		const eq = pair.indexOf("=");
		out[eq === -1 ? pair : pair.slice(0, eq)] = eq === -1 ? true : pair.slice(eq + 1);
	}

	return out;
}

/**
 * Connect as the bot, send one multiline PM and one plain PM to `target`,
 * and resolve with the msgid the server put on each echo.
 */
function sendMessages(target) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
		const result = {batch: null, plain: null};
		const send = (line) => ws.send(line);
		const fail = (why) => {
			reject(new Error(why));
			ws.close();
		};

		ws.onopen = () => {
			send("CAP LS 302");
			send(`NICK ${BOT}`);
			send(`USER ${BOT} 0 * :seance seen check`);
		};

		ws.onmessage = (ev) => {
			const line = String(ev.data);

			if (line.startsWith("PING")) {
				ws.send(`PONG${line.slice(4)}`);
				return;
			}

			const tags = tagsOf(line);
			const rest = line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line;
			const params = rest.split(" ");
			const ours = params[0].startsWith(`:${BOT}!`);

			if (params[1] === "CAP" && params[3] === "LS") {
				if (params[4] !== "*") {
					send("CAP REQ :batch draft/multiline message-tags server-time echo-message");
				}
			} else if (params[1] === "CAP" && params[3] === "ACK") {
				send("CAP END");
			} else if (params[1] === "CAP" && params[3] === "NAK") {
				fail(`the ircd refused the caps: ${line}`);
			} else if (params[1] === "001") {
				send(`BATCH +${RUN} draft/multiline ${target}`);
				send(`@batch=${RUN} PRIVMSG ${target} :seen ${RUN} line one `);
				send(`@batch=${RUN};draft/multiline-concat PRIVMSG ${target} :continued`);
				send(`@batch=${RUN} PRIVMSG ${target} :seen ${RUN} line two`);
				send(`BATCH -${RUN}`);
			} else if (ours && params[1] === "BATCH" && params[3] === "draft/multiline") {
				// The echo of our batch: its opener carries the message's msgid.
				result.batch = {msgid: tags.msgid};
				send(`PRIVMSG ${target} :seen ${RUN} plain`);
			} else if (ours && params[1] === "PRIVMSG" && rest.endsWith(`:seen ${RUN} plain`)) {
				result.plain = {msgid: tags.msgid};
				send("QUIT :seen check done");
				setTimeout(() => {
					ws.close();
					resolve(result);
				}, 200);
			} else if (params[1] === "433") {
				fail(`nick ${BOT} is taken`);
			} else if (
				params[1] === "FAIL" ||
				(/^4\d\d$/.test(params[1] ?? "") && params[1] !== "422") // 422: no MOTD, harmless
			) {
				fail(`the ircd answered ${line}`);
			}
		};

		ws.onerror = (e) => fail(`websocket error: ${e.message ?? e}`);
		setTimeout(() => fail("the bot timed out"), 20000);
	});
}

/** The page's own copy of the ring, read the way push-seen.ts opens the DB
 * (same version and store, so an early read cannot leave the page without
 * its store). Resolves to the array, or to a string describing the failure. */
const READ_SEEN = `new Promise((resolve) => {
	let req;
	try {
		req = indexedDB.open("seance-push", 1);
	} catch (e) {
		resolve("open threw: " + e);
		return;
	}
	req.onupgradeneeded = () => {
		if (!req.result.objectStoreNames.contains("kv")) {
			req.result.createObjectStore("kv");
		}
	};
	req.onerror = () => resolve("open failed: " + req.error);
	req.onsuccess = () => {
		const db = req.result;
		const get = db.transaction("kv", "readonly").objectStore("kv").get("seen");
		get.onsuccess = () => {
			db.close();
			resolve(Array.isArray(get.result) ? get.result : []);
		};
		get.onerror = () => {
			db.close();
			resolve("get failed: " + get.error);
		};
	};
})`;

/** Poll until a WebSocket frame of the page matches `re`. */
async function frameMatching(page, re, label, timeout = 15000) {
	const start = Date.now();

	while (Date.now() - start < timeout) {
		const hit = page.wsFrames.find((frame) => re.test(String(frame.payloadData)));

		if (hit) {
			return re.exec(String(hit.payloadData));
		}

		await page.sleep(150);
	}

	throw new Error(`timed out waiting for ${label}`);
}

/** Poll the ring until `pred` holds or the time is up; returns the last read. */
async function seenUntil(page, pred, timeout = 8000) {
	const start = Date.now();
	let seen = [];

	while (Date.now() - start < timeout) {
		seen = await page.evaluate(READ_SEEN);

		if (Array.isArray(seen) && pred(seen)) {
			return seen;
		}

		await page.sleep(200);
	}

	return seen;
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#sidebar"});

	// The nick the page ended up with is on the server's welcome.
	const welcome = await frameMatching(page, /^(?:@\S+ )?:\S+ 001 (\S+) /, "the page's 001");
	const pageNick = welcome[1];
	page.check("the page registered", Boolean(pageNick));

	const {batch, plain} = await sendMessages(pageNick);
	page.check("the batch echo carried a msgid", Boolean(batch?.msgid));
	page.check("the plain echo carried a msgid", Boolean(plain?.msgid));

	const seen = await seenUntil(
		page,
		(list) => list.includes(batch.msgid) && list.includes(plain.msgid)
	);
	page.check(
		`the ring is readable (${Array.isArray(seen) ? seen.length + " entries" : seen})`,
		Array.isArray(seen)
	);

	if (Array.isArray(seen)) {
		page.check(
			"the multiline message's msgid — the pushes' batch reference — is in the ring",
			seen.includes(batch.msgid)
		);
		page.check("the plain message's msgid is in the ring", seen.includes(plain.msgid));
		page.check("the ring holds exactly those two entries", seen.length === 2);
	}

	// The message itself reads as one, joined the way the worker joins pushes.
	await page.click(`.channel-list-item[data-name="${BOT}"]`);
	await page.waitFor(
		`document.querySelector("#chat")?.textContent.includes("seen ${RUN} line one continued")`,
		{timeout: 5000, label: "the joined message in the query"}
	);
	page.check(
		"the query shows the joined message",
		await page.evaluate(
			`document.querySelector("#chat").textContent.includes("seen ${RUN} line one continued") && document.querySelector("#chat").textContent.includes("seen ${RUN} line two")`
		)
	);
	await page.screenshot("query-multiline");

	page.check("no console errors", page.consoleErrors.length === 0);
}
