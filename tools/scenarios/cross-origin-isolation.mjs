// The root service worker makes the app cross-origin isolated
// (docs/projects/translation-devices.md § Multithreading) while translation
// is on: it adds `Cross-Origin-Opener-Policy: same-origin` and
// `Cross-Origin-Embedder-Policy: credentialless` to the documents it serves
// while the page's flag says translation is on (client/js/isolationFlag.ts:
// IndexedDB seance-push/kv `isolate`, and an `isolation` message), and to
// the app's own worker scripts always, so a static host that sends no
// headers still gets multithreaded WebAssembly for the CPU translation
// models, from the load after the worker served the page with translation
// on. Translation ships switched off, and so does the isolation.
//
//   NODE_ENV=production pnpm build
//   python3 -c 'import http.server as h, mimetypes as m, functools; m.add_type("text/javascript", ".mjs"); m.add_type("application/wasm", ".wasm"); h.test(functools.partial(h.SimpleHTTPRequestHandler, directory="public"), h.ThreadingHTTPServer, port=8021)' &
//   tools/nefarious-dev/run.sh -d
//   SEANCE_PORT=8021 node tools/browser-drive.mjs tools/scenarios/cross-origin-isolation.mjs
//
// The page's server sends no isolation headers of its own (a production
// build matters: a development one precaches nothing, but the headers are
// added on both). The scenario serves its own PNG from a second origin,
// SEANCE_MEDIA_PORT (default 8034, a stand-in for a link-preview host), with
// no `Cross-Origin-Resource-Policy` header: `/raw.png` with no header at all
// (an `<img>` the scenario adds), `/preview.png` with
// `Access-Control-Allow-Origin: *` only, because a link preview of a PNG
// also reads the file through CORS to learn whether it animates. Needs a
// fresh profile (the default): a reused one already has the worker. It does
// NOT seed translation on (lib/translation.mjs): the default, off, is the
// first thing it checks, and it switches translation on with the switch.
//
// Claims under test:
//   1. the first load is not isolated, and the worker takes control of it;
//   2. translation off (the default): a reload served by the worker is still
//      not isolated, and the flag the page stored says off;
//   3. switched on in Settings → Translation: the flag says on at once, and
//      the CPU threads line says a reload brings threads;
//   4. after a reload the page is isolated, served by the worker, and the
//      threads line says how many it uses;
//   5. the translation worker's script is isolated too (SharedArrayBuffer
//      exists inside it: its status reply's `threads`);
//   6. a cross-origin image without CORP still loads (credentialless);
//   7. a link preview's image from that host renders;
//   8. switched off again, the next load is not isolated;
//   9. no console errors.

import http from "node:http";
import {readFileSync} from "node:fs";
import {crc32, deflateSync} from "node:zlib";

const IRCD = process.env.SEANCE_IRC_URL ?? "ws://127.0.0.1:8067/";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";
const MEDIA_PORT = Number(process.env.SEANCE_MEDIA_PORT ?? "8034");
const RUN = Date.now().toString(36).slice(-5);
const NICK = `coi${RUN}`;
const TALKER = `coitalk${RUN}`;

const ircd = new URL(IRCD);

if (ircd.hostname === "localhost" || ircd.hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export const url =
	`http://localhost:${PORT}/?host=${ircd.hostname}&port=${ircd.port}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

// ------------------------------------------------------------ the PNG

function chunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
}

/** A `size`×`size` RGB PNG, a diagonal two-colour split. */
function png(size = 96) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(size, 0);
	ihdr.writeUInt32BE(size, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const rows = [];

	for (let y = 0; y < size; y++) {
		const row = Buffer.alloc(1 + size * 3);

		for (let x = 0; x < size; x++) {
			const [r, g, b] = x > y ? [214, 120, 40] : [40, 110, 200];
			row.set([r, g, b], 1 + x * 3);
		}

		rows.push(row);
	}

	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function serveMedia() {
	const body = png();
	const server = http.createServer((req, res) => {
		const path = new URL(req.url, "http://x").pathname;
		const headers = {"Content-Type": "image/png", "Cache-Control": "max-age=300"};

		if (path === "/preview.png") {
			headers["Access-Control-Allow-Origin"] = "*";
		} else if (path !== "/raw.png") {
			res.writeHead(404).end();
			return;
		}

		res.writeHead(200, headers).end(body);
	});

	return new Promise((resolve) => server.listen(MEDIA_PORT, "127.0.0.1", () => resolve(server)));
}

// ------------------------------------------------------------ the talker

function talker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance isolation check`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);
		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
		} else if (params[1] === "001") {
			ws.send(`JOIN ${CHANNEL}`);
		} else if (params[1] === "JOIN" && params[0].includes(nick)) {
			onJoin();
		}
	};

	return {
		joined: new Promise((resolve, reject) => {
			onJoin = resolve;
			setTimeout(() => reject(new Error(`${nick} never joined`)), 20000);
		}),
		say: (text) => ws.send(`PRIVMSG ${CHANNEL} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

// ------------------------------------------------------------ the page side

/** What the page knows about its isolation, as JSON. */
const isolation = `JSON.stringify({
	isolated: self.crossOriginIsolated === true,
	sab: typeof SharedArrayBuffer !== "undefined",
	controlled: !!navigator.serviceWorker.controller,
	servedByWorker: (performance.getEntriesByType("navigation")[0]?.workerStart ?? 0) > 0,
})`;

/**
 * Start a second translation worker from the app's own script (the same
 * URL the app uses, so the same response path through the service worker)
 * and ask it for its status: `threads` is whether SharedArrayBuffer exists
 * inside it, which only a cross-origin-isolated worker has.
 */
const workerThreads = `new Promise((resolve) => {
	const bundle = document.querySelector('script[src*="js/bundle.js"]');
	const v = new URL(bundle.src).searchParams.get("v") ?? "";
	const w = new Worker("js/translate-worker.js?v=" + encodeURIComponent(v));
	const done = (value) => { w.terminate(); resolve(JSON.stringify(value)); };
	w.onmessage = (e) => {
		if (e.data && e.data.type === "status") {
			done({threads: e.data.engines.seq2seq.threads === true});
		}
	};
	w.onerror = (e) => done({error: String(e.message || e)});
	w.postMessage({type: "status"});
	setTimeout(() => done({error: "no status reply in 15 s"}), 15000);
})`;

/** Add an `<img>` from `src` and report whether it loaded. */
const rawImage = (src) => `new Promise((resolve) => {
	const img = new Image();
	img.id = "coi-raw";
	img.onload = () => resolve(JSON.stringify({loaded: img.naturalWidth > 0, w: img.naturalWidth}));
	img.onerror = () => resolve(JSON.stringify({loaded: false}));
	img.src = ${JSON.stringify(src)};
	document.body.append(img);
	setTimeout(() => resolve(JSON.stringify({loaded: false, timeout: true})), 10000);
})`;

const previewState = `(() => {
	const link = Array.from(document.querySelectorAll("#chat .preview .toggle-thumbnail"))
		.find((a) => a.href.includes("preview.png"));
	const img = link?.querySelector("img");
	if (!img) return null;
	const r = img.getBoundingClientRect();
	return JSON.stringify({
		loaded: img.complete && img.naturalWidth > 0,
		shown: r.width > 0 && r.height > 0 && getComputedStyle(img).display !== "none",
	});
})()`;

const json = async (page, expression) => JSON.parse((await page.evaluate(expression)) ?? "null");

const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));

/** A plural catalog entry as a pattern for any count. */
const pluralPattern = (entry) =>
	new RegExp(
		"^(?:" +
			[entry.one, entry.other]
				.map((form) =>
					form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{count\\}", "\\d+")
				)
				.join("|") +
			")$"
	);
const THREADS_RELOAD = pluralPattern(EN["translate.threads.reload"]);
const THREADS_USING = pluralPattern(EN["translate.threads.using"]);

/** The flag the page mirrored for the worker (isolationFlag.ts), as JSON. */
const storedFlag = `new Promise((resolve) => {
	const req = indexedDB.open("seance-push", 1);
	req.onupgradeneeded = () => req.result.createObjectStore("kv");
	req.onerror = () => resolve(JSON.stringify("unreadable"));
	req.onsuccess = () => {
		const get = req.result.transaction("kv").objectStore("kv").get("isolate");
		get.onsuccess = () => {
			req.result.close();
			resolve(JSON.stringify(get.result ?? null));
		};
	};
})`;

/** Settings → Translation (the tab keeps its route whatever it is named). */
async function openTranslationTab(page) {
	await page.evaluate(`(() => { location.hash = "#/settings/translation"; })()`);
	await page.waitFor(`!!document.querySelector('#settings input[name="translationEnabled"]')`, {
		timeout: 20000,
		label: "Settings → Translation, with its switch",
	});
}

/** The CPU threads line, once the device probe has answered. */
async function threadsLine(page) {
	await page.waitFor(`!!document.querySelector("#settings .translate-device-threads")`, {
		timeout: 30000,
		label: "the CPU threads line",
	});

	return page.evaluate(
		`document.querySelector("#settings .translate-device-threads").textContent.trim()`
	);
}

/**
 * Whether the stored flag comes to say `value` within 5 s (waitFor coerces
 * its expression, so the promise is polled here).
 */
async function flagBecomes(page, value) {
	const started = Date.now();

	while ((await json(page, storedFlag)) !== value) {
		if (Date.now() - started > 5000) {
			return false;
		}

		await page.sleep(150);
	}

	return true;
}

/** Flip the switch and wait for the setting and the flag to follow. */
async function switchTranslation(page, on) {
	await page.click('#settings input[name="translationEnabled"]');
	await page.waitFor(
		`JSON.parse(localStorage.getItem("settings") || "{}").translationEnabled === ${on}`,
		{label: `the switch stored ${on}`}
	);
	await page.check(
		`switched ${on ? "on" : "off"}: the isolation flag follows`,
		await flagBecomes(page, on)
	);
}

/**
 * A fresh load of the scenario's URL (the connect form keeps its query),
 * through the worker: waits for the old document to be gone first.
 */
async function load(page) {
	await page.evaluate(`(() => { window.__coiOld = true; })()`);
	await page.goto(page.url);
	await page.waitFor(`!window.__coiOld && !!document.querySelector("#connect form")`, {
		timeout: 20000,
		label: "the connect form on a fresh load",
	});
}

export default async function run(page) {
	const server = await serveMedia();
	const media = (path) => `http://127.0.0.1:${MEDIA_PORT}${path}?run=${RUN}`;

	try {
		// 1. First load: the server sent no headers and no worker served it.
		await page.goto(page.url, {waitForSelector: "#connect form"});
		const first = await json(page, isolation);
		await page.check(
			`the first load is not isolated (${JSON.stringify(first)})`,
			!first.isolated && !first.sab && !first.servedByWorker
		);
		await page.waitFor("!!navigator.serviceWorker.controller", {
			timeout: 20000,
			label: "the service worker controls the page",
		});

		// 2. Translation is off by default: a reload the worker serves is
		//    still not isolated, and the page told it so.
		await page.send("Page.reload");
		await page.sleep(500);
		await page.waitFor(`!!document.querySelector("#connect form")`, {
			timeout: 20000,
			label: "the connect form after the reload",
		});
		const off = await json(page, isolation);
		await page.check(
			`translation off: a reload served by the worker is not isolated (${JSON.stringify(
				off
			)})`,
			!off.isolated && !off.sab && off.servedByWorker
		);
		await page.check(
			"translation off: the flag the page stored says off",
			await flagBecomes(page, false)
		);

		// 3. Switched on with the switch: the flag follows at once, and the
		//    threads line says a reload brings threads.
		await openTranslationTab(page);
		await switchTranslation(page, true);
		const before = await threadsLine(page);
		await page.check(
			`switched on: the threads line asks for a reload (${JSON.stringify(before)})`,
			THREADS_RELOAD.test(before)
		);
		await page.screenshot("1-threads-reload", {selector: "#settings"});

		// 4. A reload: the worker serves the document, with the headers.
		await load(page);
		const second = await json(page, isolation);
		await page.check(
			`after a reload the page is isolated, served by the worker (${JSON.stringify(second)})`,
			second.isolated && second.sab && second.servedByWorker
		);
		await openTranslationTab(page);
		const after = await threadsLine(page);
		await page.check(
			`isolated: the threads line says how many it uses (${JSON.stringify(after)})`,
			THREADS_USING.test(after)
		);
		await page.screenshot("2-threads-using", {selector: "#settings"});
		await page.click(".settings-modal-done");
		await page.waitFor(`!document.querySelector(".settings-modal")`, {
			label: "settings closed",
		});

		// 5. The translation worker's script came through the worker too.
		const worker = await json(page, workerThreads);
		await page.check(
			`the translation worker is isolated (SharedArrayBuffer inside it: ${JSON.stringify(
				worker
			)})`,
			worker.threads === true
		);

		// 6. A cross-origin image without CORP or CORS headers still loads.
		const raw = await json(page, rawImage(media("/raw.png")));
		await page.check(
			`a cross-origin <img> without CORP loads (${JSON.stringify(raw)})`,
			raw.loaded === true
		);
		await page.evaluate(`document.getElementById("coi-raw")?.remove()`);

		// 7. A link preview's image from that host renders.
		await page.waitFor(`!!document.querySelector("#connect form")`, {
			label: "the connect form",
		});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
			timeout: 30000,
			label: `${CHANNEL} in the sidebar`,
		});
		await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

		const bob = talker(TALKER);
		await bob.joined;
		bob.say(`isolated preview ${media("/preview.png")}`);
		await page.waitFor(`!!document.querySelector("#chat .media-veil-main")`, {
			timeout: 10000,
			label: "the preview veil",
		});
		await page.click("#chat .msg:last-child .media-veil-main");
		await page.waitFor(`${previewState} && JSON.parse(${previewState}).loaded`, {
			timeout: 10000,
			label: "the preview image loaded",
		});
		const preview = await json(page, previewState);
		await page.check(
			`the link preview's image renders (${JSON.stringify(preview)})`,
			preview.loaded && preview.shown
		);
		await page.screenshot("3-preview-isolated", {selector: "#chat .chat-content"});
		await page.screenshot("4-page-isolated");

		const still = await json(page, isolation);
		await page.check(
			`still isolated after connecting (${JSON.stringify(still)})`,
			still.isolated
		);

		bob.quit();
		await page.sleep(300);

		// 8. Switched off again: the page in front stays as it was loaded,
		//    and the next load is not isolated.
		await openTranslationTab(page);
		await switchTranslation(page, false);
		const inFront = await json(page, isolation);
		await page.check(
			`switched off: the page in front stays as it was loaded (${JSON.stringify(inFront)})`,
			inFront.isolated
		);
		await load(page);
		const offAgain = await json(page, isolation);
		await page.check(
			`switched off again: the next load is not isolated (${JSON.stringify(offAgain)})`,
			!offAgain.isolated && !offAgain.sab && offAgain.servedByWorker
		);

		await page.check(
			`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
			page.consoleErrors.length === 0
		);
	} finally {
		server.close();
	}
}
