// The sidebar's edge beside the chat drags to a new width, which survives a
// reload, scales with the font-size setting (it is kept in rem), and a
// double-click puts the default back. The phone's drawer keeps its own
// width and has no handle (SidebarResizer.vue, sidebarWidth.ts).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/sidebar-resize.mjs
//
// No ircd: the connect form has the sidebar too.

const BASE = process.env.SEANCE_BASE ?? "http://localhost:8000/";

export const url = BASE;

const WIDTH = `Math.round(document.querySelector("#sidebar").getBoundingClientRect().width)`;

async function drag(page, fromX, toX, y) {
	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: fromX, y});
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: fromX,
		y,
		button: "left",
		clickCount: 1,
	});

	for (let i = 1; i <= 5; i++) {
		const x = fromX + ((toX - fromX) * i) / 5;
		await page.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x,
			y,
			button: "left",
			buttons: 1,
		});
	}

	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: toX,
		y,
		button: "left",
		clickCount: 1,
	});
	await page.sleep(200);
}

export default async function run(page) {
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 900,
		height: 700,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.goto(url, {waitForSelector: "#sidebar"});

	const start = await page.evaluate(WIDTH);
	const handle = await page.rect("#sidebar .sidebar-resizer");
	page.check(
		`a handle on the sidebar's edge (${start}px wide sidebar)`,
		!!handle && handle.width > 0
	);

	const x = handle.x + handle.width / 2;
	const y = handle.y + 200;
	await drag(page, x, x - 60, y);
	const narrower = await page.evaluate(WIDTH);
	page.check(
		`dragging 60px in narrows it: ${start} → ${narrower}`,
		Math.abs(narrower - (start - 60)) <= 4
	);
	await page.screenshot("narrower");

	await page.goto(url, {waitForSelector: "#sidebar"});
	page.check(
		"the width survives a reload",
		Math.abs((await page.evaluate(WIDTH)) - narrower) <= 1
	);

	const again = await page.rect("#sidebar .sidebar-resizer");
	await drag(page, again.x + again.width / 2, 10, y);
	const min = await page.evaluate(WIDTH);
	page.check(`it stops at 8rem (${min}px)`, min === 128);

	const h = await page.rect("#sidebar .sidebar-resizer");
	const hx = h.x + h.width / 2;
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: hx,
		y,
		button: "left",
		clickCount: 1,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: hx,
		y,
		button: "left",
		clickCount: 1,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: hx,
		y,
		button: "left",
		clickCount: 2,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: hx,
		y,
		button: "left",
		clickCount: 2,
	});
	await page.sleep(200);
	page.check("a double-click puts the default back", (await page.evaluate(WIDTH)) === start);

	page.check(
		"the double-click saved nothing",
		(await page.evaluate(`localStorage.getItem("thelounge.state.sidebarWidth")`)) === null
	);

	// A click without a move changes and saves nothing.
	const c = await page.rect("#sidebar .sidebar-resizer");
	const cx = c.x + 1;
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: cx,
		y,
		button: "left",
		clickCount: 1,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: cx,
		y,
		button: "left",
		clickCount: 1,
	});
	await page.sleep(400);
	page.check(
		"a plain click changes and saves nothing",
		(await page.evaluate(WIDTH)) === start &&
			(await page.evaluate(`localStorage.getItem("thelounge.state.sidebarWidth")`)) === null
	);

	// A cancelled drag puts the width back, unsaved, and lets go of the page.
	const k = await page.rect("#sidebar .sidebar-resizer");
	const kx = k.x + k.width / 2;
	await page.evaluate(`(() => {
		const h = document.querySelector("#sidebar .sidebar-resizer");
		const at = (type, x) => h.dispatchEvent(new PointerEvent(type, {pointerId: 7, clientX: x, clientY: ${y}, button: 0, buttons: 1, bubbles: true, isPrimary: true}));
		h.setPointerCapture = () => {};
		h.releasePointerCapture = () => {};
		at("pointerdown", ${kx});
		at("pointermove", ${kx} + 50);
		h.dispatchEvent(new PointerEvent("pointercancel", {pointerId: 7, clientX: 0, bubbles: true}));
		// The real capture back, for the drag below.
		delete h.setPointerCapture;
		delete h.releasePointerCapture;
	})()`);
	await page.sleep(200);
	page.check(
		"a cancelled drag restores the width and saves nothing",
		(await page.evaluate(WIDTH)) === start &&
			(await page.evaluate(`localStorage.getItem("thelounge.state.sidebarWidth")`)) ===
				null &&
			!(await page.evaluate(
				`document.documentElement.classList.contains("sidebar-resizing")`
			))
	);

	// The handle moved with the reset: take it again, and see the drag took.
	const d = await page.rect("#sidebar .sidebar-resizer");
	const dx = d.x + d.width / 2;
	await drag(page, dx, dx - 40, y);
	const dragged = await page.evaluate(WIDTH);
	page.check(
		`a second drag narrows it again (${dragged}px)`,
		Math.abs(dragged - (start - 40)) <= 4
	);

	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 400,
		height: 800,
		deviceScaleFactor: 1,
		mobile: true,
	});
	await page.sleep(300);
	page.check(
		"the phone's drawer keeps its own width and no handle",
		(await page.evaluate(
			`getComputedStyle(document.querySelector("#sidebar .sidebar-resizer")).display`
		)) === "none" && (await page.evaluate(WIDTH)) === start
	);
	// Dragged far out in a modest window, the sidebar shrinks in its row as
	// the default does, leaving the chat its share, and what is announced is
	// the width shown.
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 800,
		height: 700,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.sleep(300);
	const w = await page.rect("#sidebar .sidebar-resizer");
	await drag(page, w.x + w.width / 2, 790, y);
	const shown = await page.evaluate(WIDTH);
	const kept = Number(
		await page.evaluate(`localStorage.getItem("thelounge.state.sidebarWidth")`)
	);
	const announced = Number(
		await page.evaluate(
			`document.querySelector("#sidebar .sidebar-resizer").getAttribute("aria-valuenow")`
		)
	);
	page.check(
		`dragged out at 800px it shrinks in its row, the chat keeping its share: ${shown}px shown, ${kept}rem kept, ${announced} announced`,
		shown < 480 && 800 - shown >= 320 && kept === 30 && announced === Math.round(shown / 16)
	);
	page.check("no console errors", page.consoleErrors.length === 0);
}
