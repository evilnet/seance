// A modal's backdrop closes it on a click that began on the backdrop, not on
// a drag that began inside the modal and ended past its edge
// (client/js/helpers/backdrop.ts, `v-backdrop`).
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/backdrop-drag.mjs
//
// The browser fires a click whose press and release landed on different
// elements on their nearest common ancestor — the backdrop — so selecting
// text in a dialog and letting go outside it used to close the dialog, as did
// a press on the backdrop let go inside. Uses the Help modal (its paragraphs
// are selectable text; Settings has none), which needs no IRC connection, on
// a window wide enough for it to float over a backdrop.

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";

export const url = `${BASE}#/help`;

const OPEN = `document.querySelector("#help .settings-modal") !== null`;

async function mouse(page, type, x, y, buttons) {
	await page.send("Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: "left",
		buttons,
		clickCount: type === "mouseMoved" ? 0 : 1,
	});
}

/** A point on the backdrop: outside the pane, on #help itself. */
async function backdropPoint(page) {
	return JSON.parse(
		await page.evaluate(`(() => {
			const backdrop = document.querySelector("#help");
			for (let y = 10; y < innerHeight; y += 20)
				for (let x = 10; x < innerWidth; x += 20)
					if (document.elementFromPoint(x, y) === backdrop) return JSON.stringify({x, y});
			return "null";
		})()`)
	);
}

async function openHelp(page) {
	await page.evaluate(`location.hash = "#/help"`);
	await page.waitFor(OPEN, {label: "the help modal"});
	await page.sleep(400);
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#help .settings-modal"});
	await page.sleep(500);

	const spot = await backdropPoint(page);
	page.check("the modal floats over a backdrop (needs a wide window)", spot !== null);

	if (!spot) {
		return;
	}

	// 1. Press on text in the pane and let go over the backdrop: a text
	// selection by mouse. (Headless Chrome makes no selection from CDP mouse
	// events, so the check is where the click lands.)
	const title = JSON.parse(
		await page.evaluate(`(() => {
			const body = document.querySelector("#help .settings-modal-body");
			const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
			for (let node = walk.nextNode(); node; node = walk.nextNode()) {
				const el = node.parentElement;
				if (node.textContent.trim().length < 8 || getComputedStyle(el).userSelect === "none") continue;
				const range = document.createRange();
				range.selectNodeContents(node);
				const box = range.getBoundingClientRect();
				if (box.width > 40 && box.top > 0 && box.bottom < innerHeight) return JSON.stringify(box);
			}
			return "null";
		})()`)
	);
	const startX = title.x + 4;
	const startY = title.y + title.height / 2;
	await mouse(page, "mouseMoved", startX, startY, 0);
	await page.evaluate(
		`window.__clicks = []; document.addEventListener("click", (e) => __clicks.push(e.target.id || e.target.tagName), true)`
	);
	await mouse(page, "mousePressed", startX, startY, 1);

	for (let step = 1; step <= 10; step++) {
		await mouse(
			page,
			"mouseMoved",
			startX + ((spot.x - startX) * step) / 10,
			startY + ((spot.y - startY) * step) / 10,
			1
		);
	}

	await mouse(page, "mouseReleased", spot.x, spot.y, 0);
	await page.sleep(400);
	const clicks = JSON.parse(await page.evaluate(`JSON.stringify(__clicks)`));
	console.log(`  the drag's click landed on ${JSON.stringify(clicks)}`);
	// What the bug needs: the browser puts the click on the backdrop.
	page.check("the drag's click landed on the backdrop", clicks.at(-1) === "help");
	page.check("a drag let go over the backdrop leaves the modal open", await page.evaluate(OPEN));
	await page.screenshot("1-after-drag");

	// 2. A click inside the pane leaves it open.
	await mouse(page, "mousePressed", startX, startY, 1);
	await mouse(page, "mouseReleased", startX, startY, 0);
	await page.sleep(300);
	page.check("a click inside the modal leaves it open", await page.evaluate(OPEN));

	// 3. A press that began on the backdrop and ended inside does not close.
	await mouse(page, "mousePressed", spot.x, spot.y, 1);
	await mouse(page, "mouseMoved", startX, startY, 1);
	await mouse(page, "mouseReleased", startX, startY, 0);
	await page.sleep(300);
	page.check("a press from the backdrop let go inside leaves it open", await page.evaluate(OPEN));

	// 4. A click on the backdrop closes it.
	await mouse(page, "mousePressed", spot.x, spot.y, 1);
	await mouse(page, "mouseReleased", spot.x, spot.y, 0);
	await page.sleep(500);
	page.check("a click on the backdrop closes the modal", !(await page.evaluate(OPEN)));

	// 5. And again after reopening (the directive is bound afresh).
	await openHelp(page);
	await mouse(page, "mousePressed", spot.x, spot.y, 1);
	await mouse(page, "mouseReleased", spot.x, spot.y, 0);
	await page.sleep(500);
	page.check("a reopened modal closes on a backdrop click", !(await page.evaluate(OPEN)));

	page.check("no console errors", page.consoleErrors.length === 0);
}
