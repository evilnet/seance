// An animated image preview plays once, then holds a still; it plays again
// under the pointer, anywhere on its message, and keeps looping while its message is the newest one
// (LinkPreview.vue `shouldPlay`, helpers/animatedImage.ts `animationInfo`).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/animated-preview.mjs
//
// The scenario serves its own GIF (64×64, three frames of 500 ms: one play
// is 1.5 s) on SEANCE_MEDIA_PORT (default 8032): `/cors.gif` with
// `Access-Control-Allow-Origin: *`, so the play is timed from the file, and
// `/plain.gif` without, so the 6 s fallback applies. `SEANCE_IRC_URL`,
// `SEANCE_IRC_CHANNEL` and `SEANCE_PORT` as in the other scenarios.

import http from "node:http";

const IRCD = process.env.SEANCE_IRC_URL ?? "ws://127.0.0.1:8067/";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";
const MEDIA_PORT = Number(process.env.SEANCE_MEDIA_PORT ?? "8032");
const RUN = Date.now().toString(36).slice(-5);
const NICK = `anim${RUN}`;
const TALKER = `animtalk${RUN}`;

const ircd = new URL(IRCD);

if (ircd.hostname === "localhost" || ircd.hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export const url =
	`http://localhost:${PORT}/?host=${ircd.hostname}&port=${ircd.port}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

// ------------------------------------------------------------ the GIF

/**
 * A `size`×`size` frame of one palette index, LZW-coded the "uncompressed"
 * way: minimum code size 2, a clear code every two pixels so codes stay
 * 3 bits wide and the dictionary never grows.
 */
function frameData(size, index) {
	const codes = [];

	for (let i = 0; i < size * size; i += 2) {
		codes.push(4, index, index); // clear, pixel, pixel
	}

	codes.push(5); // end of information
	const out = [];
	let acc = 0;
	let bits = 0;

	for (const code of codes) {
		acc |= code << bits;
		bits += 3;

		while (bits >= 8) {
			out.push(acc & 255);
			acc >>= 8;
			bits -= 8;
		}
	}

	if (bits > 0) {
		out.push(acc & 255);
	}

	const blocks = [2]; // LZW minimum code size

	for (let i = 0; i < out.length; i += 255) {
		const chunk = out.slice(i, i + 255);
		blocks.push(chunk.length, ...chunk);
	}

	blocks.push(0);
	return blocks;
}

function animatedGif(size = 64, delayCs = 50) {
	const le16 = (n) => [n & 255, n >> 8];
	const palette = [255, 60, 60, 60, 200, 60, 60, 60, 255, 255, 255, 255]; // red, green, blue, white
	const netscape = [0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0];
	const frames = [0, 1, 2].flatMap((index) => [
		...[0x21, 0xf9, 0x04, 0x00, ...le16(delayCs), 0x00, 0x00],
		...[0x2c, 0, 0, 0, 0, ...le16(size), ...le16(size), 0x00],
		...frameData(size, index),
	]);
	return Buffer.from([
		...Buffer.from("GIF89a"),
		...le16(size),
		...le16(size),
		0x81, // global table of 4 colours
		0,
		0,
		...palette,
		...netscape,
		...frames,
		0x3b,
	]);
}

function serveMedia() {
	const gif = animatedGif();
	const server = http.createServer((req, res) => {
		const path = new URL(req.url, "http://x").pathname;
		const headers = {"Content-Type": "image/gif", "Cache-Control": "max-age=300"};

		if (path === "/cors.gif") {
			headers["Access-Control-Allow-Origin"] = "*";
		} else if (path !== "/plain.gif") {
			res.writeHead(404).end();
			return;
		}

		res.writeHead(200, headers).end(gif);
	});

	return new Promise((resolve) => server.listen(MEDIA_PORT, "127.0.0.1", () => resolve(server)));
}

// ------------------------------------------------------------ the talker

function talker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance animated preview`);
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

// ------------------------------------------------------------ the run

/** The state of the preview whose link contains `needle`. */
const stateOf = (needle) => `(() => {
	const link = Array.from(document.querySelectorAll("#chat .preview .toggle-thumbnail"))
		.find((a) => a.href.includes(${JSON.stringify(needle)}));
	if (!link) return null;
	const img = link.querySelector("img");
	const canvas = link.querySelector("canvas.media-still");
	const box = (el) => { const r = el.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)}; };
	return JSON.stringify({
		loaded: !!img && img.complete && img.naturalWidth > 0,
		still: !!canvas && getComputedStyle(canvas).display !== "none",
		live: !!img && getComputedStyle(img).display !== "none",
		img: img ? box(img) : null,
		canvas: canvas ? box(canvas) : null,
	});
})()`;

export default async function run(page) {
	const server = await serveMedia();
	const state = async (needle) => JSON.parse((await page.evaluate(stateOf(needle))) ?? "null");
	const media = (path) => `http://127.0.0.1:${MEDIA_PORT}${path}?run=${RUN}`;

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
			timeout: 30000,
			label: `${CHANNEL} in the sidebar`,
		});
		await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

		const bob = talker(TALKER);
		await bob.joined;

		// 1. A GIF from a host that allows a CORS read: timed from the file.
		bob.say(`look ${media("/cors.gif")}`);
		await page.waitFor(`!!document.querySelector("#chat .media-veil-main")`, {
			timeout: 10000,
			label: "the preview veil",
		});
		await page.click("#chat .msg:last-child .media-veil-main");
		await page.waitFor(`${stateOf("cors.gif")} && JSON.parse(${stateOf("cors.gif")}).loaded`, {
			timeout: 10000,
			label: "the GIF loaded",
		});
		const playing = await state("cors.gif");
		await page.check(
			`it plays on arrival (${JSON.stringify(playing)})`,
			playing.live && !playing.still
		);

		// Newest message: it keeps looping past its one play (1.5 s).
		await page.hover("#input"); // off the image
		await page.sleep(3000);
		const newest = await state("cors.gif");
		await page.check(
			`as the newest message it keeps playing past one play (${JSON.stringify(newest)})`,
			newest.live && !newest.still
		);

		// 2. Something newer arrives: it holds its still, in the same box.
		bob.say("something newer");
		await page.sleep(800);
		const held = await state("cors.gif");
		await page.check(
			`with a newer message it holds a still (${JSON.stringify(held)})`,
			held.still && !held.live
		);
		await page.check(
			`the still takes the image's box (${JSON.stringify(playing.img)} vs ${JSON.stringify(
				held.canvas
			)})`,
			Math.abs(held.canvas.w - playing.img.w) <= 1 &&
				Math.abs(held.canvas.h - playing.img.h) <= 1
		);
		await page.screenshot("1-held-still", {selector: "#chat .chat-content"});

		// 3. Under the pointer it plays again; away, it holds again.
		await page.hover(`#chat .toggle-thumbnail[href*="cors.gif"] canvas`);
		await page.sleep(300);
		const hovered = await state("cors.gif");
		await page.check(
			`hovered, it plays (${JSON.stringify(hovered)})`,
			hovered.live && !hovered.still
		);
		await page.hover("#input");
		await page.sleep(300);
		const left = await state("cors.gif");
		await page.check(
			`left, it holds again (${JSON.stringify(left)})`,
			left.still && !left.live
		);

		// 3b. The pointer anywhere on its message plays it: the nick, far
		//     from the image, is enough.
		await page.evaluate(`Array.from(document.querySelectorAll("#chat .msg"))
			.find((m) => m.querySelector('.toggle-thumbnail[href*="cors.gif"]'))
			.setAttribute("data-anim-row", "1")`);
		await page.hover(`#chat .msg[data-anim-row="1"] .from`);
		await page.sleep(300);
		const onRow = await state("cors.gif");
		await page.check(
			`the pointer on the message's nick plays it (${JSON.stringify(onRow)})`,
			onRow.live && !onRow.still
		);
		await page.hover("#input");
		await page.sleep(300);
		const offRow = await state("cors.gif");
		await page.check(
			`off the row, it holds again (${JSON.stringify(offRow)})`,
			offRow.still && !offRow.live
		);

		// 4. A host without CORS: the file cannot be read, one play is 6 s.
		bob.say(`and ${media("/plain.gif")}`);
		await page.sleep(500);
		await page.click("#chat .msg:last-child .media-veil-main");
		await page.waitFor(
			`${stateOf("plain.gif")} && JSON.parse(${stateOf("plain.gif")}).loaded`,
			{
				timeout: 10000,
				label: "the second GIF loaded",
			}
		);
		bob.say("newer than that");
		await page.hover("#input");
		await page.sleep(3000);
		const early = await state("plain.gif");
		await page.check(
			`unreadable timing: still playing at 3 s (${JSON.stringify(early)})`,
			early.live && !early.still
		);
		await page.sleep(4000);
		const late = await state("plain.gif");
		await page.check(
			`unreadable timing: held after the 6 s fallback (${JSON.stringify(late)})`,
			late.still && !late.live
		);
		await page.screenshot("2-both-held", {selector: "#chat .chat-content"});

		bob.quit();
		// A host without CORS headers makes the timing read fail on the console; nothing else may.
		const errors = page.consoleErrors.filter((e) => !/CORS|plain\.gif|Failed to fetch/.test(e));
		await page.check(`no console errors (${errors.join(" | ")})`, errors.length === 0);
	} finally {
		server.close();
	}
}
