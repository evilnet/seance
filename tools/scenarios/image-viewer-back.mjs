// Back with an image open closes the image, not the app.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/scenarios/seed-media.mjs
//   node tools/browser-drive.mjs tools/scenarios/image-viewer-back.mjs
//
// An installed PWA's back (Android's gesture or button, iOS's edge swipe) is
// a history back, and the router keeps the history one entry deep, so the
// viewer pushes an entry of its own (helpers/imageViewer.ts). Checks that
// back pops that entry and closes the image with the route untouched, and
// that closing any other way takes the entry off again, so the next back
// does not land on a stale one. SEANCE_APP overrides the app's origin.

const app = process.env.SEANCE_APP || "http://localhost:8000";

export const url = `${app}/?host=localhost&port=8443&tls=true&nick=backbot&join=%23seance`;

const OPEN = `document.querySelector("#image-viewer.opened") !== null`;
const MARKED = `!!(history.state && "seanceImageViewer" in history.state)`;

async function openLastImage(page) {
	const veils = await page.count(".media-veil");

	if (veils > 0) {
		await page.click(".media-veil-main", veils - 1);
		await page.waitFor(`document.querySelector(".media-frame img")`, {label: "revealed image"});
		await page.sleep(300);
	}

	const imgs = await page.count(".media-frame img");
	await page.click(".media-frame img", imgs - 1);
	await page.waitFor(OPEN, {label: "the image viewer"});
	await page.sleep(300);
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector(".media-veil, .media-frame img")`, {
		timeout: 30000,
		label: "an image preview in #seance (run seed-media.mjs first)",
	});
	await page.sleep(800);
	await page.evaluate(`document.querySelector("#chat .messages")?.scrollTo(0, 1e9)`);
	await page.sleep(300);

	const hash = await page.evaluate(`location.hash`);
	const depth = await page.evaluate(`history.length`);
	console.log(`  route ${hash}, history.length ${depth}`);

	// 1. Open, then back: the image closes and the app stays where it was.
	await openLastImage(page);
	await page.screenshot("1-open");
	page.check("opening pushes the viewer's entry", await page.evaluate(MARKED));
	page.check(
		"opening grows the history by one",
		(await page.evaluate(`history.length`)) === depth + 1
	);

	await page.evaluate(`history.back()`);
	await page.sleep(600);
	await page.screenshot("2-after-back");
	page.check("back closes the image", !(await page.evaluate(OPEN)));
	page.check("back leaves the route alone", (await page.evaluate(`location.hash`)) === hash);
	page.check("back pops the viewer's entry", !(await page.evaluate(MARKED)));
	page.check("still in the chat", (await page.count("#chat .messages")) > 0);

	// 2. Open, close with ✕: the viewer's entry comes off again.
	await openLastImage(page);
	await page.click("#image-viewer .close-btn");
	await page.sleep(600);
	page.check("✕ closes the image", !(await page.evaluate(OPEN)));
	page.check("✕ takes the viewer's entry off", !(await page.evaluate(MARKED)));
	page.check("✕ leaves the route alone", (await page.evaluate(`location.hash`)) === hash);

	// 3. Open, close with Escape: same.
	await openLastImage(page);
	await page.evaluate(
		`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", keyCode: 27, bubbles: true}))`
	);
	await page.sleep(600);
	page.check("Escape closes the image", !(await page.evaluate(OPEN)));
	page.check("Escape takes the viewer's entry off", !(await page.evaluate(MARKED)));

	// 4. And back once more still closes a freshly opened image.
	await openLastImage(page);
	await page.evaluate(`history.back()`);
	await page.sleep(600);
	page.check("back closes a reopened image", !(await page.evaluate(OPEN)));
	page.check("route unchanged at the end", (await page.evaluate(`location.hash`)) === hash);
	await page.screenshot("3-end");

	page.check("no console errors", page.consoleErrors.length === 0);
}
