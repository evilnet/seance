// The image viewer's gestures (ImageViewer.vue, helpers/viewerGesture.ts).
//
//   pnpm build && python3 -m http.server -d "$PWD/public" 8000 &
//   node tools/browser-drive.mjs tools/scenarios/image-viewer-gestures.mjs --mobile
//   node tools/browser-drive.mjs tools/scenarios/image-viewer-gestures.mjs
//
// No ircd needed: lib/tiny-ircd.mjs answers the JOIN and a poster sends three
// pictures of different sizes, served by the scenario on SEANCE_MEDIA_PORT
// (default 8033). With --mobile, by finger: a tap on the picture hides and
// shows the buttons; a double tap zooms in on that point and back out; a
// pinch keeps the part of the picture between the fingers there; a pinch
// past the maximum or below fitted springs back; a swipe left or right goes
// to the next or previous picture (mirrored right to left), and toward no
// picture springs back; a short swipe down springs back, a long one closes.
// On a desktop: a wheel zooms about the pointer, a double click zooms in and
// out, a click on the picture still closes it. Both: + and 0 zoom by key, →
// steps, Escape closes. `SEANCE_PORT` serves the app from another port.

import http from "node:http";
import {clickAt, finger, key, mouse, tapAt, touch} from "./lib/input.mjs";
import {png} from "./lib/png.mjs";
import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const MEDIA_PORT = Number(process.env.SEANCE_MEDIA_PORT ?? "8033");
const IRCD_PORT = 9877;
const CHANNEL = "#gestures";
const RUN = Date.now().toString(36).slice(-5);

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=viewer${RUN}&join=${encodeURIComponent(
	CHANNEL
)}`;

// ------------------------------------------------------------ the pictures

/** A `width`×`height` diagonal gradient: every pixel tells where it is. */
const gradient = (width, height, tint) =>
	png(width, height, (x, y) => [
		Math.floor((x / width) * 255),
		Math.floor((y / height) * 255),
		tint,
	]);

const PICTURES = {
	"/a.png": gradient(1600, 1000, 40),
	"/b.png": gradient(800, 1200, 140),
	"/c.png": gradient(1200, 900, 240),
};

const media = http.createServer((req, res) => {
	const body = PICTURES[new URL(req.url, "http://x").pathname];

	if (!body) {
		res.writeHead(404).end();
		return;
	}

	res.writeHead(200, {
		"Content-Type": "image/png",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "max-age=3600",
	});
	res.end(body);
});

const LINKS = Object.keys(PICTURES).map((p) => `http://localhost:${MEDIA_PORT}${p}?run=${RUN}`);

const ircd = startTinyIrcd({
	port: IRCD_PORT,
	onLine(line, {send}) {
		if (/^JOIN /i.test(line)) {
			setTimeout(() => {
				for (const link of LINKS) {
					send(`:poster!p@tiny PRIVMSG ${CHANNEL} :${link}`);
				}
			}, 300);
		}

		return false;
	},
});

// ------------------------------------------------------------ helpers

const OPEN = `document.querySelector("#image-viewer.opened") !== null`;
const SRC = `(document.querySelector("#image-viewer img")?.getAttribute("src") || "")`;
const SCALE = `Number((document.querySelector("#image-viewer img")?.style.transform.match(/scale3d\\(([\\d.]+)/) || [])[1] || 0)`;
const HIDDEN = `document.querySelector("#image-viewer.controls-hidden") !== null`;

let mobile = false;

/** The picture's box on screen. */
async function imgBox(page) {
	return JSON.parse(
		await page.evaluate(
			`JSON.stringify(document.querySelector("#image-viewer img").getBoundingClientRect())`
		)
	);
}

/** Which of the picture's own pixels is under a point on screen. */
async function pixelAt(page, x, y) {
	return JSON.parse(
		await page.evaluate(`(() => {
			const img = document.querySelector("#image-viewer img");
			const r = img.getBoundingClientRect();
			return JSON.stringify({
				x: ((${x} - r.left) / r.width) * img.naturalWidth,
				y: ((${y} - r.top) / r.height) * img.naturalHeight,
			});
		})()`)
	);
}

const near = (a, b, tolerance) =>
	Math.abs(a.x - b.x) < tolerance && Math.abs(a.y - b.y) < tolerance;

/**
 * A one-finger drag from (x, y) by (dx, dy) in `steps` moves `ms` apart, held
 * still `hold` ms before it lifts (unless `lift` is false), `after` ms to settle.
 */
async function drag(
	page,
	x,
	y,
	dx,
	dy,
	{steps = 10, ms = 16, hold = 0, lift = true, after = 450} = {}
) {
	await touch(page, "touchStart", [finger(x, y)]);

	for (let i = 1; i <= steps; i++) {
		await page.sleep(ms);
		await touch(page, "touchMove", [finger(x + (dx * i) / steps, y + (dy * i) / steps)]);
	}

	if (!lift) {
		return;
	}

	await page.sleep(hold);
	await touch(page, "touchEnd", []);
	await page.sleep(after);
}

/** Two fingers about (x, y), `from` px apart, moved to `to` px apart. */
async function pinchAt(page, x, y, from, to) {
	const h = from / 2;
	await touch(page, "touchStart", [finger(x - h, y, 0), finger(x + h, y, 1)]);

	for (let i = 1; i <= 10; i++) {
		await page.sleep(16);
		const d = (from + ((to - from) * i) / 10) / 2;
		await touch(page, "touchMove", [finger(x - d, y, 0), finger(x + d, y, 1)]);
	}
}

async function lift(page) {
	await touch(page, "touchEnd", []);
	await page.sleep(450);
}

/** A finger's tap (--mobile) or a click on the `index`th `selector`, scrolled into view. */
async function press(page, selector, index = 0) {
	const r = JSON.parse(
		await page.evaluate(`(() => {
			const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
			el.scrollIntoView({block: "center"});
			return JSON.stringify(el.getBoundingClientRect());
		})()`)
	);
	const x = r.x + r.width / 2;
	const y = r.y + r.height / 2;
	await (mobile ? tapAt(page, x, y, 0) : clickAt(page, x, y));
}

async function revealAll(page) {
	for (let i = 0; i < 5 && (await page.count(".media-veil-main")) > 0; i++) {
		await press(page, ".media-veil-main");
		await page.sleep(400);
	}
}

async function openImage(page, index) {
	await press(page, ".media-frame img", index);

	await page.waitFor(OPEN, {label: "the image viewer"});
	await page.waitFor(`document.querySelector("#image-viewer img:not(.loading)")`, {
		label: "the picture loaded",
	});
	await page.sleep(400);
}

async function close(page) {
	await page.evaluate(`document.querySelector("#image-viewer .close-btn")?.click()`);
	await page.sleep(400);
}

// ------------------------------------------------------------ the run

export default async function run(page) {
	await new Promise((resolve) => media.listen(MEDIA_PORT, "127.0.0.1", resolve));

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		mobile = await page.evaluate(`matchMedia("(hover: none) and (pointer: coarse)").matches`);
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(
			`document.querySelectorAll(".media-veil, .media-frame img").length >= 3`,
			{timeout: 30000, label: "three image previews"}
		);
		await page.sleep(500);
		await revealAll(page);
		await page.waitFor(`document.querySelectorAll(".media-frame img").length >= 3`, {
			label: "three revealed images",
		});

		await (mobile ? touchChecks(page) : mouseChecks(page));
		await bothChecks(page);
		page.check("no console errors", page.consoleErrors.length === 0);
	} finally {
		media.close();
		ircd.close?.();
	}
}

async function touchChecks(page) {
	await openImage(page, 0);
	const fit = await page.evaluate(SCALE);
	let box = await imgBox(page);
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	await page.screenshot("1-open");

	// A tap on the picture puts the buttons away; the next brings them back.
	await tapAt(page, cx, cy);
	page.check("a tap on the picture hides the buttons", await page.evaluate(HIDDEN));
	page.check("…and leaves it open", await page.evaluate(OPEN));
	await page.screenshot("2-controls-hidden");
	await tapAt(page, cx, cy);
	page.check("a second tap shows them", !(await page.evaluate(HIDDEN)));

	// A double tap zooms in on that point, and back out. Half way down: a
	// point the zoom can keep where it was without pulling an edge inside
	// the screen (the clamp would move it, rightly).
	const at = {x: box.x + box.width * 0.25, y: box.y + box.height * 0.5};
	const before = await pixelAt(page, at.x, at.y);
	await tapAt(page, at.x, at.y, 80);
	await tapAt(page, at.x, at.y, 500);
	const zoomed = await page.evaluate(SCALE);
	const after = await pixelAt(page, at.x, at.y);
	page.check(`a double tap zooms in (${fit} → ${zoomed})`, zoomed > fit * 1.5);
	page.check(
		`…on the tapped point (${Math.round(before.x)},${Math.round(before.y)} → ${Math.round(
			after.x
		)},${Math.round(after.y)})`,
		near(before, after, 25)
	);
	page.check("…and the buttons stay", !(await page.evaluate(HIDDEN)));
	await page.screenshot("3-double-tapped");
	await tapAt(page, at.x, at.y, 80);
	await tapAt(page, at.x, at.y, 500);
	page.check("a second double tap goes back to fitted", (await page.evaluate(SCALE)) === fit);

	// A pinch keeps the part of the picture between the fingers there —
	// across: the wide picture overflows the width, while still shorter
	// than the screen it stays centred down it.
	const px = box.x + box.width * 0.8;
	const py = box.y + box.height * 0.5;
	const under = await pixelAt(page, px, py);
	await pinchAt(page, px, py, 60, 160);
	const held = await pixelAt(page, px, py);
	page.check(
		`a pinch zooms about the fingers (x ${Math.round(under.x)} → ${Math.round(held.x)})`,
		Math.abs(under.x - held.x) < 25
	);
	await lift(page);

	// Past the maximum it springs back to it; below fitted, back to fitted.
	await pinchAt(page, cx, cy, 40, 380);
	await pinchAt(page, cx, cy, 40, 380);
	await lift(page);
	const max = await page.evaluate(SCALE);
	page.check(`a pinch past the maximum springs back to 3 (${max})`, max === 3);

	// Stretched past it, one finger lifting leaves the picture where it is:
	// the finger left carries on from the stretch, not from a second one.
	await pinchAt(page, cx, cy, 60, 300);
	await page.sleep(100);
	const stretched = await page.evaluate(SCALE);
	await touch(page, "touchEnd", [finger(cx - 150, cy, 0)]);
	await touch(page, "touchMove", [finger(cx - 150, cy, 0)]);
	await page.sleep(100);
	const kept = await page.evaluate(SCALE);
	page.check(
		`a finger lifting from a stretched pinch keeps the stretch (${stretched} → ${kept})`,
		stretched > 3 && Math.abs(kept - stretched) < 0.01
	);
	await lift(page);
	await pinchAt(page, cx, cy, 380, 20);
	await page.screenshot("4-pinched-below-fit");
	await lift(page);
	await pinchAt(page, cx, cy, 380, 20);
	await lift(page);
	const least = await page.evaluate(SCALE);
	page.check(`a pinch below fitted springs back to it (${least})`, least === fit);
	box = await imgBox(page);
	page.check(
		"…centred",
		Math.abs(box.x + box.width / 2 - cx) < 2 && Math.abs(box.y + box.height / 2 - cy) < 2
	);

	// Sideways: next and previous; toward no picture, it springs back.
	const first = await page.evaluate(SRC);
	await drag(page, cx + 100, cy, 160, 0);
	page.check(
		"a swipe right on the first picture stays on it",
		(await page.evaluate(SRC)) === first
	);
	page.check("…and springs back", Math.abs((await imgBox(page)).x - box.x) < 2);
	await drag(page, cx + 100, cy, -200, 0);
	await page.sleep(300);
	page.check("a swipe left goes to the next picture", /b\.png/.test(await page.evaluate(SRC)));
	await page.screenshot("5-next");
	await drag(page, cx - 100, cy, 200, 0);
	await page.sleep(300);
	page.check("a swipe right goes back", (await page.evaluate(SRC)) === first);

	// The next and previous buttons run the screen's full height at its
	// edges, where a thumb starts a swipe: one begun on them swipes, and a
	// tap on them is still their click.
	const btn = await page.evaluate(
		`JSON.stringify(document.querySelector("#image-viewer .next-image-btn").getBoundingClientRect())`
	);
	const edge = JSON.parse(btn);
	await drag(page, edge.x + edge.width / 2, cy + 80, -200, 0);
	await page.sleep(300);
	page.check(
		"a swipe begun on the next button's strip goes to the next",
		/b\.png/.test(await page.evaluate(SRC))
	);
	await drag(page, cx - 100, cy, 200, 0);
	await page.sleep(300);
	await tapAt(page, edge.x + edge.width / 2, edge.y + edge.height / 2, 600);
	page.check(
		"a tap on the next button goes to the next",
		/b\.png/.test(await page.evaluate(SRC))
	);
	page.check("…and leaves it open", await page.evaluate(OPEN));
	await drag(page, cx - 100, cy, 200, 0);
	await page.sleep(300);
	page.check("…and a swipe right comes back", (await page.evaluate(SRC)) === first);

	// A finger that lands while the picture is still flying out does not
	// undo the step.
	await drag(page, cx + 100, cy, -200, 0, {steps: 8, after: 60});
	await tapAt(page, cx, cy, 500);
	page.check(
		"a tap during the fly-out keeps the step",
		/b\.png/.test(await page.evaluate(SRC)) && (await page.evaluate(OPEN))
	);
	await drag(page, cx - 100, cy, 200, 0);
	await page.sleep(300);

	// A drag that stops before the finger lifts is not a flick.
	await drag(page, cx, cy, 0, 60, {steps: 4, hold: 400});
	page.check("a quick drag down held before lifting springs back", await page.evaluate(OPEN));

	// A short, slow drag down springs back; a long one closes.
	await drag(page, cx, cy, 0, 50, {ms: 60});
	page.check("a short swipe down leaves it open", await page.evaluate(OPEN));
	page.check("…at its place", Math.abs((await imgBox(page)).y - box.y) < 2);

	// Mid-swipe, the backdrop fades.
	await drag(page, cx, cy, 0, 250, {lift: false});
	const dimmed = Number(
		await page.evaluate(
			`getComputedStyle(document.querySelector("#image-viewer")).getPropertyValue("--viewer-dim")`
		)
	);
	page.check(`the backdrop fades as it goes (${dimmed})`, dimmed < 0.8);
	await page.screenshot("6-swiping-down");
	await touch(page, "touchEnd", []);
	await page.sleep(500);
	page.check("a long swipe down closes the viewer", !(await page.evaluate(OPEN)));

	// Right to left: a swipe right is next.
	await page.evaluate(`document.documentElement.dir = "rtl"`);
	await openImage(page, 0);
	box = await imgBox(page);
	await drag(page, box.x + box.width / 2 - 100, box.y + box.height / 2, 200, 0);
	await page.sleep(300);
	page.check(
		"right to left, a swipe right goes to the next",
		/b\.png/.test(await page.evaluate(SRC))
	);
	await close(page);
	await page.evaluate(`document.documentElement.dir = "ltr"`);
}

async function mouseChecks(page) {
	await openImage(page, 0);
	const fit = await page.evaluate(SCALE);
	let box = await imgBox(page);
	const at = {x: box.x + box.width * 0.3, y: box.y + box.height * 0.6};

	// The wheel zooms about the pointer, up for in.
	const before = await pixelAt(page, at.x, at.y);

	for (let i = 0; i < 3; i++) {
		await mouse(page, "mouseWheel", at.x, at.y, {deltaX: 0, deltaY: -100});
		await page.sleep(30);
	}

	const zoomed = await page.evaluate(SCALE);
	const after = await pixelAt(page, at.x, at.y);
	page.check(`the wheel up zooms in (${fit} → ${zoomed})`, zoomed > fit * 1.5);
	page.check("…about the pointer", near(before, after, 20));

	for (let i = 0; i < 6; i++) {
		await mouse(page, "mouseWheel", at.x, at.y, {deltaX: 0, deltaY: 100});
		await page.sleep(30);
	}

	page.check(
		"the wheel down zooms out, no further than fitted",
		(await page.evaluate(SCALE)) === fit
	);

	// A double click zooms in and out; a click closes.
	await clickAt(page, at.x, at.y, 1);
	await clickAt(page, at.x, at.y, 2);
	await page.sleep(500);
	page.check("a double click leaves it open", await page.evaluate(OPEN));
	page.check("…and zooms in", (await page.evaluate(SCALE)) > fit * 1.5);
	await clickAt(page, at.x, at.y, 1);
	await clickAt(page, at.x, at.y, 2);
	await page.sleep(500);
	page.check("a second double click goes back to fitted", (await page.evaluate(SCALE)) === fit);

	box = await imgBox(page);
	await clickAt(page, box.x + box.width / 2, box.y + box.height / 2);
	await page.sleep(600);
	page.check("a click on the picture still closes it", !(await page.evaluate(OPEN)));
}

// Keys last: in headless Chrome no CDP touch is acknowledged after a CDP key
// event, so every touch check has to come first.
async function bothChecks(page) {
	await openImage(page, 1);
	const fit = await page.evaluate(SCALE);

	await key(page, "+", "Equal", 187, "+");
	const keyed = await page.evaluate(SCALE);
	page.check(`+ zooms in (${fit} → ${keyed})`, keyed > fit);
	await key(page, "0", "Digit0", 48, "0");
	page.check("0 goes back to fitted", (await page.evaluate(SCALE)) === fit);

	await key(page, "ArrowRight", "ArrowRight", 39);
	page.check("→ goes to the next picture", /c\.png/.test(await page.evaluate(SRC)));

	await key(page, "Escape", "Escape", 27);
	page.check("Escape closes the viewer", !(await page.evaluate(OPEN)));
}
