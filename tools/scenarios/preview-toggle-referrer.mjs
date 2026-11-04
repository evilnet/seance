// Two claims about media previews, in a real browser:
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/preview-toggle-referrer.mjs
//
// 1. Expanding a preview at the bottom of the channel keeps the channel at the
//    bottom. A veil has nothing to load, so no load event does it.
// 2. A media host never learns which site the client runs on: no Referer on
//    video or audio, whose elements have no referrerPolicy of their own.
//
// The scenario serves the media itself, which is how it sees the headers.

import {execFile} from "node:child_process";
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

export default async function run(page) {
	const requests = new Map();
	const media = createServer((req, res) => {
		requests.set(req.url.split("?")[0], req.headers.referer ?? null);
		// Empty on purpose: the request is the evidence, not the playback.
		res.writeHead(200, {"Content-Type": req.url.includes(".mp3") ? "audio/mpeg" : "video/mp4"});
		res.end();
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
		const run = Date.now().toString(36);
		await promisify(execFile)(process.execPath, [
			"tools/scenarios/seed-media.mjs",
			"wss://localhost:8443/",
			"#seance",
			`http://127.0.0.1:${MEDIA_PORT}/clip.mp4?run=${run}`,
			`http://127.0.0.1:${MEDIA_PORT}/song.mp3?run=${run}`,
		]);
		await page.waitFor(
			`document.querySelectorAll(".media-veil").length >= ${veilsBefore + 2}`,
			{
				timeout: 15000,
				label: "the seeded previews",
			}
		);
		await page.sleep(500);

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
		// The empty files fail to decode, which takes the elements back out.
		await page.sleep(1500);

		for (const path of ["/clip.mp4", "/song.mp3"]) {
			page.check(`${path} was requested`, requests.has(path));
			console.log(`  ${path} Referer: ${requests.get(path)}`);
			page.check(`${path} sent no Referer`, requests.get(path) === null);
		}
	} finally {
		media.close();
	}
}
