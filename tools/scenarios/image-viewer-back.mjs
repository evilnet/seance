// The image viewer never touches the history, and a pinch never closes it.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/scenarios/seed-media.mjs
//   node tools/browser-drive.mjs tools/scenarios/image-viewer-back.mjs
//   node tools/browser-drive.mjs tools/scenarios/image-viewer-back.mjs --mobile
//
// The router keeps the history one entry deep so iOS's edge swipes have
// nothing to go to (router.ts). The viewer used to push an entry of its own
// so back closed the image; closing it left that entry as forward history, a
// right-edge swipe went forward onto it and the left edge then had a page to
// go back to. Now back is a CloseWatcher where there is one (Chromium) and no
// entry anywhere (helpers/imageViewer.ts). Checks that every way of opening
// and closing leaves the Navigation API with nothing behind or ahead, that
// each open image has one close watcher whose close request (Android's back)
// closes it, that a real Escape closes it, and with --mobile that the
// viewer's own gesture holds: a pinch beside the image zooms it and does not
// close it, a tap on a zoomed image does not close it, a tap at the fitted
// size does; on a desktop, that a mouse pan let go over the backdrop is not a
// click. SEANCE_APP overrides the app's origin.

const app = process.env.SEANCE_APP || "http://localhost:8000";

export const url = `${app}/?host=localhost&port=8443&tls=true&nick=backbot&join=%23seance`;

const OPEN = `document.querySelector("#image-viewer.opened") !== null`;
const STACK = `JSON.stringify({len: history.length, back: navigation.canGoBack, fwd: navigation.canGoForward})`;
const SCALE = `Number((document.querySelector("#image-viewer img")?.style.transform.match(/scale3d\\(([\\d.]+)/) || [])[1] || 0)`;

let mobile = false;

/** A click, or under --mobile a finger's tap (the veil only answers a tap there). */
async function press(page, selector, index) {
	if (!mobile) {
		await page.click(selector, index);
		return;
	}

	const r = JSON.parse(
		await page.evaluate(`(() => {
			const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
			el.scrollIntoView({block: "center"});
			return JSON.stringify(el.getBoundingClientRect());
		})()`)
	);
	await tapAt(page, r.x + r.width / 2, r.y + r.height / 2);
}

async function openLastImage(page) {
	const veils = await page.count(".media-veil");

	if (veils > 0) {
		await press(page, ".media-veil-main", veils - 1);
		await page.waitFor(`document.querySelector(".media-frame img")`, {label: "revealed image"});
		await page.sleep(300);
	}

	const imgs = await page.count(".media-frame img");
	await press(page, ".media-frame img", imgs - 1);
	await page.waitFor(OPEN, {label: "the image viewer"});
	await page.sleep(400);
}

async function key(page, key, code, keyCode) {
	const base = {key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode};
	await page.send("Input.dispatchKeyEvent", {type: "rawKeyDown", ...base});
	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...base});
	await page.sleep(500);
}

/** The viewer's box and the fitted image's, in CSS px. */
async function boxes(page) {
	return JSON.parse(
		await page.evaluate(`JSON.stringify({
			viewer: document.querySelector("#image-viewer").getBoundingClientRect(),
			img: document.querySelector("#image-viewer img").getBoundingClientRect(),
		})`)
	);
}

async function mouse(page, type, x, y, extra) {
	await page.send("Input.dispatchMouseEvent", {type, x, y, ...extra});
}

// Counts the close watchers the viewer makes and destroys, and keeps the last.
const WRAP_CLOSE_WATCHER = `(() => {
	const Base = window.CloseWatcher;
	if (!Base) return;
	window.__cw = {made: 0, destroyed: 0, last: null};
	window.CloseWatcher = class extends Base {
		constructor(...args) {
			super(...args);
			__cw.made++;
			__cw.last = this;
		}
		destroy() {
			__cw.destroyed++;
			super.destroy();
		}
	};
})()`;

function finger(x, y, id) {
	return {x, y, id, radiusX: 12, radiusY: 12, force: 1};
}

async function touch(page, type, points) {
	await page.send("Input.dispatchTouchEvent", {type, touchPoints: points});
}

async function tapAt(page, x, y) {
	await touch(page, "touchStart", [finger(x, y, 0)]);
	await page.sleep(60);
	await touch(page, "touchEnd", []);
	await page.sleep(500);
}

/** Two fingers spreading from around (x, y), lifted one after the other. */
async function pinchOut(page, x, y) {
	await touch(page, "touchStart", [finger(x - 20, y, 0)]);
	await page.sleep(30);
	await touch(page, "touchStart", [finger(x - 20, y, 0), finger(x + 20, y, 1)]);

	for (let step = 1; step <= 10; step++) {
		await page.sleep(16);
		await touch(page, "touchMove", [
			finger(x - 20 - step * 8, y, 0),
			finger(x + 20 + step * 8, y, 1),
		]);
	}

	// The second finger lifts first; the last one lifts where it stood, still,
	// which is what used to read as a tap.
	// (CDP releases a point by leaving it out of the next event's list.)
	await touch(page, "touchMove", [finger(x - 100, y, 0)]);
	await page.sleep(80);
	await touch(page, "touchEnd", []);
	await page.sleep(500);
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	mobile = await page.evaluate(`matchMedia("(hover: none) and (pointer: coarse)").matches`);
	await page.evaluate(WRAP_CLOSE_WATCHER);
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector(".media-veil, .media-frame img")`, {
		timeout: 30000,
		label: "an image preview in #seance (run seed-media.mjs first)",
	});
	await page.sleep(800);
	await page.evaluate(`document.querySelector("#chat .messages")?.scrollTo(0, 1e9)`);
	await page.sleep(300);

	const hash = await page.evaluate(`location.hash`);
	const start = JSON.parse(await page.evaluate(STACK));
	console.log(`  route ${hash}, history ${JSON.stringify(start)}`);
	page.check("the app opens with nothing behind or ahead", !start.back && !start.fwd);

	const stackClean = async (label) => {
		const now = JSON.parse(await page.evaluate(STACK));
		page.check(
			`${label}: the history is unchanged (${JSON.stringify(now)})`,
			!now.back && !now.fwd && now.len === start.len
		);
	};

	// 1. Open: no entry.
	await openLastImage(page);
	await page.screenshot("1-open");
	await stackClean("open");

	// 2. ✕.
	await press(page, "#image-viewer .close-btn", 0);
	await page.sleep(500);
	page.check("✕ closes the image", !(await page.evaluate(OPEN)));
	await stackClean("✕");

	if (mobile) {
		// 3. A pinch beside the fitted image zooms it and leaves it open.
		await openLastImage(page);
		const fitted = await page.evaluate(SCALE);
		const {viewer, img} = await boxes(page);
		const midX = viewer.x + viewer.width / 2;
		// Below the image, on the backdrop.
		const belowY = Math.min(viewer.y + viewer.height - 60, img.y + img.height + 60);
		await pinchOut(page, midX, belowY);
		const zoomed = await page.evaluate(SCALE);
		console.log(`  scale fitted ${fitted} → after pinch ${zoomed}`);
		page.check("a pinch beside the image zooms it", zoomed > fitted * 1.2);
		page.check("a pinch leaves the viewer open", await page.evaluate(OPEN));
		await page.screenshot("2-pinched");

		// 4. A tap while zoomed in does not close it.
		await tapAt(page, midX, viewer.y + viewer.height / 2);
		page.check("a tap on a zoomed image leaves it open", await page.evaluate(OPEN));

		// 5. The buttons keep their taps: ✕ by finger closes.
		await press(page, "#image-viewer .close-btn", 0);
		page.check("a tap on ✕ closes the image", !(await page.evaluate(OPEN)));

		// 6. At the fitted size, a tap on the backdrop closes it.
		await openLastImage(page);
		const spot = JSON.parse(
			await page.evaluate(`(() => {
				const v = document.querySelector("#image-viewer");
				for (let y = innerHeight - 30; y > 0; y -= 20)
					for (let x = 30; x < innerWidth; x += 20)
						// Clear of the buttons by a finger's width: Chrome's touch
						// adjustment snaps a tap beside one onto it, as on a phone.
						if ([[0, 0], [-40, 0], [40, 0], [0, -40], [0, 40]].every(
							([dx, dy]) => document.elementFromPoint(x + dx, y + dy) === v
						)) return JSON.stringify({x, y});
				return "null";
			})()`)
		);
		await tapAt(page, spot.x, spot.y);
		page.check("a tap at the fitted size closes the image", !(await page.evaluate(OPEN)));
		await stackClean("touch");
	} else {
		// 3. A mouse pan of a zoomed image released on the backdrop leaves
		// it open. Zoomed until it overflows the height but not the width, so
		// it pans and there is backdrop beside it to let go over.
		await openLastImage(page);
		const {viewer} = await boxes(page);
		const cx = viewer.x + viewer.width / 2;
		const cy = viewer.y + viewer.height / 2;

		for (let i = 0; i < 30 && (await boxes(page)).img.height <= viewer.height; i++) {
			await mouse(page, "mouseWheel", cx, cy, {deltaX: 0, deltaY: 100});
			await page.sleep(20);
		}

		const {img} = await boxes(page);
		page.check(
			"the zoomed image overflows the height and leaves backdrop beside it",
			img.height > viewer.height && img.right < viewer.right - 120
		);
		const releaseX = img.right + 60;
		const releaseY = cy + 160;
		page.check(
			"the release point is the backdrop",
			await page.evaluate(
				`document.elementFromPoint(${releaseX}, ${releaseY}) === document.querySelector("#image-viewer")`
			)
		);
		const yBefore = img.y;
		await mouse(page, "mousePressed", cx, cy, {button: "left", buttons: 1, clickCount: 1});

		for (let step = 1; step <= 8; step++) {
			await mouse(page, "mouseMoved", cx, cy + step * 20, {button: "left", buttons: 1});
		}

		await mouse(page, "mouseMoved", releaseX, releaseY, {button: "left", buttons: 1});
		await mouse(page, "mouseReleased", releaseX, releaseY, {
			button: "left",
			buttons: 0,
			clickCount: 1,
		});
		await page.sleep(400);
		page.check("a mouse pan leaves the viewer open", await page.evaluate(OPEN));
		page.check("the pan moved the image", (await boxes(page)).img.y !== yBefore);

		// 4. A plain click on the image still closes it, as it always has.
		const now = (await boxes(page)).img;
		await mouse(page, "mousePressed", cx, cy, {button: "left", buttons: 1, clickCount: 1});
		await mouse(page, "mouseReleased", cx, cy, {button: "left", buttons: 0, clickCount: 1});
		await page.sleep(500);
		page.check(
			`a click on the image closes it (${Math.round(now.height)}px tall)`,
			!(await page.evaluate(OPEN))
		);
	}

	// 7. The close watcher: one per open image, gone again on any close, and
	// its close request (Android's back) closes the image. Escape cannot show
	// this: the app's own Escape binding closes the viewer first.
	const watching = await page.evaluate(`window.__cw !== undefined`);
	console.log(`  CloseWatcher: ${watching ? "wrapped" : "absent"}`);

	if (watching) {
		const cw = async () =>
			JSON.parse(
				await page.evaluate(`JSON.stringify({made: __cw.made, destroyed: __cw.destroyed})`)
			);
		await page.evaluate(`__cw.made = 0; __cw.destroyed = 0`);
		await openLastImage(page);
		page.check("opening makes one close watcher", (await cw()).made === 1);
		await press(page, "#image-viewer .close-btn", 0);
		await page.sleep(500);
		page.check("✕ destroys it", (await cw()).destroyed === 1);
		await openLastImage(page);
		page.check("reopening makes a fresh one", (await cw()).made === 2);
		await page.evaluate(`__cw.last.requestClose()`);
		await page.sleep(500);
		page.check("its close request closes the image", !(await page.evaluate(OPEN)));
		await stackClean("close request");
	}

	// Keys last: in headless Chrome no CDP touch is acknowledged after a CDP
	// key event, so the touch checks above have to come first.

	// 8. Escape.
	await openLastImage(page);
	await key(page, "Escape", "Escape", 27);
	page.check("Escape closes the image", !(await page.evaluate(OPEN)));
	await stackClean("Escape");

	page.check("route unchanged at the end", (await page.evaluate(`location.hash`)) === hash);
	page.check("still in the chat", (await page.count("#chat .messages")) > 0);
	await page.screenshot("3-end");

	page.check("no console errors", page.consoleErrors.length === 0);
}
