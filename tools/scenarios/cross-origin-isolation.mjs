// The root service worker makes the app cross-origin isolated
// (docs/projects/translation-devices.md § Multithreading): it adds
// `Cross-Origin-Opener-Policy: same-origin` and
// `Cross-Origin-Embedder-Policy: credentialless` to the documents and the
// app's own worker scripts it serves, so a static host that sends no headers
// still gets multithreaded WebAssembly for the CPU translation models, from
// the load after the worker took control.
//
//   NODE_ENV=production corepack yarn build
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
// fresh profile (the default): a reused one already has the worker.
//
// Claims under test:
//   1. the first load is not isolated, and the worker takes control of it;
//   2. after a reload the page is isolated, served by the worker;
//   3. the translation worker's script is isolated too (SharedArrayBuffer
//      exists inside it: its status reply's `threads`);
//   4. a cross-origin image without CORP still loads (credentialless);
//   5. a link preview's image from that host renders;
//   6. no console errors.

import http from "node:http";
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

		// 2. A reload: the worker serves the document, with the headers.
		await page.send("Page.reload");
		await page.sleep(500);
		await page.waitFor(`!!document.querySelector("#connect form")`, {
			timeout: 20000,
			label: "the connect form after the reload",
		});
		const second = await json(page, isolation);
		await page.check(
			`after a reload the page is isolated, served by the worker (${JSON.stringify(second)})`,
			second.isolated && second.sab && second.servedByWorker
		);

		// 3. The translation worker's script came through the worker too.
		const worker = await json(page, workerThreads);
		await page.check(
			`the translation worker is isolated (SharedArrayBuffer inside it: ${JSON.stringify(
				worker
			)})`,
			worker.threads === true
		);

		// 4. A cross-origin image without CORP or CORS headers still loads.
		const raw = await json(page, rawImage(media("/raw.png")));
		await page.check(
			`a cross-origin <img> without CORP loads (${JSON.stringify(raw)})`,
			raw.loaded === true
		);
		await page.evaluate(`document.getElementById("coi-raw")?.remove()`);

		// 5. A link preview's image from that host renders.
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
		await page.screenshot("1-preview-isolated", {selector: "#chat .chat-content"});
		await page.screenshot("2-page-isolated");

		const still = await json(page, isolation);
		await page.check(
			`still isolated after connecting (${JSON.stringify(still)})`,
			still.isolated
		);

		bob.quit();
		await page.sleep(300);
		await page.check(
			`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
			page.consoleErrors.length === 0
		);
	} finally {
		server.close();
	}
}
