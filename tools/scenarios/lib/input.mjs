// A finger, a mouse and a key for scenarios, through CDP's Input domain:
// what the page gets is the browser's own event stream (touch adjustment,
// compatibility mouse events, clicks), not script-made events.
//
//   import {finger, touch, tapAt, mouse, clickAt, key} from "./lib/input.mjs";
//
// CDP releases a touch point by leaving it out of the next event's list.

export function finger(x, y, id = 0) {
	return {x, y, id, radiusX: 12, radiusY: 12, force: 1};
}

export async function touch(page, type, points) {
	await page.send("Input.dispatchTouchEvent", {type, touchPoints: points});
}

/** One finger down at (x, y), up 60 ms later, then `after` ms to settle. */
export async function tapAt(page, x, y, after = 500) {
	await touch(page, "touchStart", [finger(x, y)]);
	await page.sleep(60);
	await touch(page, "touchEnd", []);
	await page.sleep(after);
}

export async function mouse(page, type, x, y, extra) {
	await page.send("Input.dispatchMouseEvent", {type, x, y, ...extra});
}

/** A left click at (x, y); `clickCount` 2 is a double click's second. */
export async function clickAt(page, x, y, clickCount = 1) {
	await mouse(page, "mouseMoved", x, y);
	await mouse(page, "mousePressed", x, y, {button: "left", buttons: 1, clickCount});
	await mouse(page, "mouseReleased", x, y, {button: "left", buttons: 0, clickCount});
}

/** A key pressed and let go; `text` for a key that types (+, 0). */
export async function key(page, key, code, keyCode, text) {
	const base = {key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode};
	await page.send("Input.dispatchKeyEvent", {
		type: text ? "keyDown" : "rawKeyDown",
		...base,
		text,
	});
	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...base});
	await page.sleep(500);
}
