// The ps scene rests on a page nobody attends to (themeScene.ts
// createAttention): a desktop window that lost the focus, or that nobody has
// touched for two minutes, stays visible to the browser and would otherwise
// animate — and repaint the glass over the scene — all day.
//
//   NODE_ENV=production corepack yarn build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/scene-rest.mjs
//
// No ircd: the connect form has the scene behind it. The run exports
// `sceneRest` so browser-drive leaves the page's attention alone, then:
// a blur rests the scene after 15 s — it freezes (NG, psng/scene.ts): the
// `psng-m-` group classes stay, `psng-frozen` is on the root and no CSS
// animation is left, with nothing drawn — and the focus runs it at once
// (`psng-frozen` gone, the animations moving again); two minutes without
// input rest it, a pointer move runs it. Focus and blur are the window's
// events dispatched from the page — headless Chromium's focus is emulated,
// so a real one cannot be lost.

const BASE = "http://localhost:8001/";

export const url = BASE;
export const sceneRest = true;

const UNFOCUSED_REST_MS = 15_000;
const IDLE_REST_MS = 120_000;

/** What moves: NG's group classes, its freeze, and CSS animations whose clock moved over 250 ms. */
const STATE = `(async () => {
	const s = document.querySelector("#theme-scene");
	const anims = s.getAnimations({subtree: true}).filter((a) => "animationName" in a);
	const animAt = anims.map((a) => a.currentTime);
	await new Promise((r) => setTimeout(r, 250));
	return {
		mounted: s.classList.contains("psng") && s.children.length > 0,
		groups: [...s.classList].filter((c) => c.startsWith("psng-m-")).length,
		frozen: s.classList.contains("psng-frozen"),
		anims: anims.length,
		running: anims.filter((a, i) => a.currentTime !== animAt[i]).length,
	};
})()`;

/** Main-thread task time and style recalculations per second of wall clock, over `ms` (CDP Performance metrics). */
async function taskLoad(page, ms) {
	const read = async () => {
		const {metrics} = await page.send("Performance.getMetrics");
		const get = (name) => metrics.find((m) => m.name === name).value;
		return {task: get("TaskDuration"), styles: get("RecalcStyleCount"), at: get("Timestamp")};
	};
	const a = await read();
	await page.sleep(ms);
	const b = await read();
	return {load: (b.task - a.task) / (b.at - a.at), styles: (b.styles - a.styles) / (b.at - a.at)};
}

const pct = (x) => `${(x * 100).toFixed(1)} %`;

export default async function run(page) {
	await page.send("Performance.enable");
	// A headless page has no focus of its own; this one holds it until the
	// run blurs it (browser-drive leaves focus alone for every scenario).
	await page.send("Emulation.setFocusEmulationEnabled", {enabled: true});
	await page.addInitScript(
		`try { localStorage.setItem("settings", JSON.stringify({theme: "ps"})); } catch (e) {}`
	);
	await page.goto(url, {waitForSelector: "#connect"});
	await page.waitFor(
		`(() => { const s = document.querySelector("#theme-scene"); return s.classList.contains("psng") && s.children.length > 0; })()`
	);
	await page.sleep(3000);

	const running = (s) => s.groups > 0 && !s.frozen && s.running > 0;
	const resting = (s) => s.groups > 0 && s.frozen && s.anims === 0;
	const describe = (s) =>
		`${s.groups} psng-m- classes; psng-frozen ${s.frozen}; ${s.running} of ${s.anims} CSS animations moving`;

	let s = await page.evaluate(STATE);
	page.check(`attended at load: the scene runs (${describe(s)})`, s.mounted && running(s));
	const busy = await taskLoad(page, 5000);
	console.log(
		`attended: ${busy.styles.toFixed(1)} style recalculations a second, task time ${pct(
			busy.load
		)}`
	);

	// The window loses the focus: still running inside the grace, resting after it.
	await page.evaluate(`window.dispatchEvent(new Event("blur"))`);
	await page.sleep(UNFOCUSED_REST_MS - 5000);
	s = await page.evaluate(STATE);
	page.check(`10 s after a blur: still running (${describe(s)})`, running(s));
	await page.sleep(6000);
	s = await page.evaluate(STATE);
	page.check(
		`16 s after a blur: the scene freezes, its groups kept (${describe(s)})`,
		resting(s)
	);
	const still = await taskLoad(page, 5000);
	page.check(
		`frozen, nothing is drawn: ${busy.styles.toFixed(1)} → ${still.styles.toFixed(
			1
		)} style recalculations a second (the minute's tick may land in the window), task time ${pct(
			busy.load
		)} → ${pct(still.load)}`,
		still.styles < 1
	);
	await page.screenshot("scene-rest-resting");

	await page.evaluate(`window.dispatchEvent(new Event("focus"))`);
	s = await page.evaluate(STATE);
	page.check(
		`the focus back: psng-frozen off, the scene runs at once (${describe(s)})`,
		running(s)
	);

	// Focused, untouched: rests after two minutes; a pointer move runs it.
	await page.sleep(IDLE_REST_MS - 10000);
	s = await page.evaluate(STATE);
	page.check(
		`focused, ${(IDLE_REST_MS - 10000) / 1000} s untouched: still running (${describe(s)})`,
		running(s)
	);
	await page.sleep(11000);
	s = await page.evaluate(STATE);
	page.check(
		`focused, ${(IDLE_REST_MS + 1000) / 1000} s untouched: the scene rests (${describe(s)})`,
		resting(s)
	);

	// Back on its tab (a tab switch fires no focus): visible again is attended.
	await page.evaluate(`window.dispatchEvent(new Event("blur"))`);
	await page.sleep(UNFOCUSED_REST_MS + 1000);
	s = await page.evaluate(STATE);
	page.check(`rested before the tab switch (${describe(s)})`, resting(s));
	await page.evaluate(`(() => {
		Object.defineProperty(document, "visibilityState", {configurable: true, get: () => "hidden"});
		document.dispatchEvent(new Event("visibilitychange"));
		Object.defineProperty(document, "visibilityState", {configurable: true, get: () => "visible"});
		document.dispatchEvent(new Event("visibilitychange"));
		delete document.visibilityState;
	})()`);
	s = await page.evaluate(STATE);
	page.check(`hidden and shown again, no input: the scene runs (${describe(s)})`, running(s));

	await page.sleep(UNFOCUSED_REST_MS + 1000);
	s = await page.evaluate(STATE);
	page.check(`still without the focus: rested again (${describe(s)})`, resting(s));
	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 400, y: 300});
	s = await page.evaluate(STATE);
	page.check(`a pointer move: the scene runs again (${describe(s)})`, running(s));
}
