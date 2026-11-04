// Two claims about media previews, in a real browser:
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/preview-toggle-referrer.mjs
//
// 1. Expanding a preview at the bottom of the channel keeps the channel at the
//    bottom. A veil has nothing to load, so no load event does it.
// 2. A media host gets no Referer, from an image, its animation probe, video
//    or audio. The probe is a CORS fetch, so when the HTTP cache cannot answer
//    it, it sends Origin. The image is no-store here to put it on the wire.
//
// The scenario serves the media itself, which is how it sees the headers.

import {execFile} from "node:child_process";
import {readFileSync} from "node:fs";
import {createServer} from "node:http";
import {promisify} from "node:util";

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=drivebot&join=%23seance";

const MEDIA_PORT = 8077;
const SCROLLER = `document.querySelector("#chat .chat")`;
const GAP = `(() => {
	const el = ${SCROLLER};
	return el.scrollHeight - el.scrollTop - el.clientHeight;
})()`;
const TYPES = {".mp4": "video/mp4", ".mp3": "audio/mpeg", ".png": "image/png"};

export default async function run(page) {
	const seen = new Map();
	const image = readFileSync("public/img/logo-art.png");
	const media = createServer((req, res) => {
		const path = req.url.split("?")[0];
		const entry = seen.get(path) ?? {requests: 0, referers: [], origins: []};
		entry.requests++;
		if (req.headers.referer) entry.referers.push(req.headers.referer);
		if (req.headers.origin) entry.origins.push(req.headers.origin);
		seen.set(path, entry);
		// The video and audio stay empty: the request is the evidence. They fail
		// to decode, which takes their elements back out.
		res.writeHead(200, {
			"Content-Type": TYPES[path.slice(path.lastIndexOf("."))],
			"Access-Control-Allow-Origin": "*",
			"Cache-Control": "no-store",
		});
		res.end(path.endsWith(".png") ? image : undefined);
	});
	await new Promise((resolve) => media.listen(MEDIA_PORT, "127.0.0.1", resolve));

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(`document.querySelector("#chat .chat")`, {
			timeout: 30000,
			label: "the channel",
		});
		await page.sleep(1500);

		const veilsBefore = await page.count(".media-veil");
		const stamp = Date.now().toString(36);
		await promisify(execFile)(process.execPath, [
			"tools/scenarios/seed-media.mjs",
			"wss://localhost:8443/",
			"#seance",
			`http://127.0.0.1:${MEDIA_PORT}/clip.mp4?run=${stamp}`,
			`http://127.0.0.1:${MEDIA_PORT}/song.mp3?run=${stamp}`,
			`http://127.0.0.1:${MEDIA_PORT}/pic.png?run=${stamp}`,
		]);
		await page.waitFor(
			`document.querySelectorAll(".media-veil").length >= ${veilsBefore + 3}`,
			{
				timeout: 15000,
				label: "the seeded previews",
			}
		);
		await page.sleep(500);

		// Overflows with or without scrollback, at the viewport's real size:
		// page.click centres its target, which in a short list leaves the bottom.
		await page.evaluate(`${SCROLLER}.style.paddingTop = "100vh"`);
		await page.evaluate(`${SCROLLER}.scrollTo(0, 1e9)`);
		await page.sleep(300);
		page.check("starts at the bottom", (await page.evaluate(GAP)) <= 1);

		const lastToggle = (await page.count(".toggle-preview")) - 1;
		const height = () => page.evaluate(`${SCROLLER}.scrollHeight`);
		const open = await height();
		await page.click(".toggle-preview", lastToggle);
		await page.sleep(300);
		const shut = await height();
		await page.click(".toggle-preview", lastToggle);
		await page.sleep(300);
		console.log(`  scrollHeight open ${open}, collapsed ${shut}, reopened ${await height()}`);
		page.check("collapsing changes the height", shut < open);
		const gap = await page.evaluate(GAP);
		console.log(`  gap below the expanded preview: ${gap}px`);
		await page.screenshot("1-expanded");
		page.check("expanding at the bottom stays at the bottom", gap <= 1);

		const veils = await page.count(".media-veil");
		await page.click(".media-veil-main", veils - 1);
		await page.click(".media-veil-main", veils - 2);
		await page.click(".media-veil-main", veils - 3);
		await page.sleep(2000);
		await page.screenshot("2-revealed");

		for (const path of ["/clip.mp4", "/song.mp3", "/pic.png"]) {
			const entry = seen.get(path);
			console.log(`  ${path}: ${JSON.stringify(entry)}`);
			page.check(`${path} was requested`, entry?.requests > 0);
			page.check(`${path} sent no Referer`, entry?.referers.length === 0);
		}

		page.check("the image was probed too", seen.get("/pic.png")?.requests >= 2);
		page.check("no console errors", page.consoleErrors.length === 0);
	} finally {
		media.close();
	}
}
