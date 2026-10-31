// A real click on a modal's backdrop, for scenarios. Backdrops close through
// `v-backdrop` (client/js/helpers/backdrop.ts), which counts a click only
// when the pointer went down and came up on the backdrop itself, so a bare
// `element.click()` from script no longer closes anything: press and release
// the mouse on a point where the backdrop is the topmost element.
//
//   import {clickBackdrop} from "./lib/backdrop.mjs";
//   await clickBackdrop(page, "#mentions-popup-container");

/** A point where `selector` itself is the topmost element, or null. */
export async function backdropPoint(page, selector) {
	return JSON.parse(
		await page.evaluate(`(() => {
			const backdrop = document.querySelector(${JSON.stringify(selector)});
			for (let y = 10; y < innerHeight; y += 20)
				for (let x = 10; x < innerWidth; x += 20)
					if (document.elementFromPoint(x, y) === backdrop) return JSON.stringify({x, y});
			return "null";
		})()`)
	);
}

export async function mouse(page, type, x, y, buttons) {
	await page.send("Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: "left",
		buttons,
		clickCount: type === "mouseMoved" ? 0 : 1,
	});
}

/** Press and release the left button on the backdrop `selector`. */
export async function clickBackdrop(page, selector) {
	const point = await backdropPoint(page, selector);

	if (!point) {
		throw new Error(`no visible backdrop for ${selector}`);
	}

	await mouse(page, "mousePressed", point.x, point.y, 1);
	await mouse(page, "mouseReleased", point.x, point.y, 0);
}
