// The font-size setting end to end in a real browser: while the Appearance
// slider is dragged only the sample box under it renders the new step; when
// it is let go `data-font-size` on <html> moves, the root font size follows
// and so does everything sized in rem off it — the chat area (input,
// messages, user list) and the chrome (sidebar rows, header, footer,
// buttons) alike — the stored value is the scale name and not the slider
// index, and the choice survives a reload (client/js/helpers/fontSize.ts,
// settings.ts, style.css). A real mouse drag checks nothing moves under the
// pointer and the slider lands on the stop under it.
//
//   pnpm build && python3 -m http.server -d public 8021 &
//   node tools/browser-drive.mjs tools/scenarios/font-size-setting.mjs
//
// The default target is a plain-WS ircd on 127.0.0.1:8067 (the dev ircd's
// ws:// port).

const RUN = Date.now().toString(36);
const NICK = `fs${RUN}`;
const BASE = "http://localhost:8021/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance`;

const DATASET = `document.documentElement.dataset.fontSize ?? null`;
const ROOT_PX = `getComputedStyle(document.documentElement).fontSize`;
const FORM_PX = `getComputedStyle(document.querySelector("#form")).fontSize`;
const USERLIST_PX = `getComputedStyle(document.querySelector(".userlist")).fontSize`;
const SIDEBAR_ROW_PX = `getComputedStyle(document.querySelector('.channel-list-item[data-type="channel"]')).fontSize`;
const HEADER_HEIGHT = `getComputedStyle(document.querySelector("#chat .header")).height`;
const FOOTER_BTN = `getComputedStyle(document.querySelector("#footer button.settings")).width`;
const STORED = `JSON.parse(localStorage.getItem("settings") ?? "{}").fontSize ?? null`;
const SLIDER = `.font-size-setting input[type="range"]`;

export default async function run(page) {
	// The Vue wiring, stop by stop: `input` then `change`, as letting go of a
	// drag or a keyboard step fires them. The pointer behaviour is checked
	// further down with a real drag out of raw CDP mouse events.
	const setSlider = (index) =>
		page.evaluate(
			`(() => {
				const el = document.querySelector(${JSON.stringify(SLIDER)});
				el.value = String(${index});
				el.dispatchEvent(new Event("input", {bubbles: true}));
				el.dispatchEvent(new Event("change", {bubbles: true}));
			})()`
		);
	const samplePx = () =>
		page.evaluate(`getComputedStyle(document.querySelector(".font-size-sample")).fontSize`);

	// A ?host link only pre-fills the connect form (a link is a suggestion,
	// boot.ts handleQueryParams); connect for real, autoconnect on so the
	// reload at the end brings the network back by itself.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="autoconnect"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector("#form #input")`, {
		timeout: 20000,
		label: "chat input up",
	});
	page.check("boots at large", (await page.evaluate(DATASET)) === "large");
	page.check("default root is 20px", (await page.evaluate(ROOT_PX)) === "20px");
	page.check("input area at 20px", (await page.evaluate(FORM_PX)) === "20px");
	page.check("sidebar rows at 20px", (await page.evaluate(SIDEBAR_ROW_PX)) === "20px");
	page.check("header is 3rem = 60px", (await page.evaluate(HEADER_HEIGHT)) === "60px");
	page.check("footer buttons 3rem = 60px", (await page.evaluate(FOOTER_BTN)) === "60px");
	await page.screenshot("chat-large");

	// To Settings → Appearance, by real clicks. Both are <button>s rendered
	// through custom router-links, not <a>s.
	await page.click(`#footer button.settings`);
	await page.waitFor(`!!document.querySelector(".settings-menu button.appearance")`, {
		label: "settings open",
	});
	await page.click(`.settings-menu button.appearance`);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(SLIDER)})`, {label: "slider up"});
	page.check(
		"slider sits at large",
		(await page.evaluate(`document.querySelector(${JSON.stringify(SLIDER)}).value`)) === "3"
	);

	// A real drag, all mouse events. Applying every step live re-laid out
	// the page (rem chrome, centred container) under the pointer, which
	// resized and moved the slider so the value changed again before the
	// button came up. Now a drag renders only the sample box: the slider's
	// box must not move while the button is down, <html> must still carry
	// the old step until the button comes up, the stop it lands on is the
	// one under the pointer, and the box is the same size at every scale.
	const sliderBox = () =>
		page.evaluate(
			`(() => {
				const r = document.querySelector(${JSON.stringify(SLIDER)}).getBoundingClientRect();
				return [r.left, r.top, r.width, r.height].map(Math.round);
			})()`
		);
	// Where the thumb for stop `index` (of 0..5) sits on `box`; Chromium's
	// thumb is 16px wide.
	const stopX = (box, index) => box[0] + 8 + (index / 5) * (box[2] - 16);

	const drag = async (from, to) => {
		const box = await sliderBox();
		const y = box[1] + box[3] / 2;
		const mouse = (type, x, buttons) =>
			page.send("Input.dispatchMouseEvent", {
				type,
				x,
				y,
				button: "left",
				buttons,
				clickCount: 1,
			});
		const step = from < to ? 8 : -8;
		const xs = [];

		for (
			let x = stopX(box, from);
			step > 0 ? x < stopX(box, to) : x > stopX(box, to);
			x += step
		) {
			xs.push(x);
		}

		xs.push(stopX(box, to));
		let moved = false;
		await mouse("mouseMoved", xs[0], 0);
		await mouse("mousePressed", xs[0], 1);

		for (const x of xs) {
			await mouse("mouseMoved", x, 1);
			await page.sleep(20);

			if ((await sliderBox()).join() !== box.join()) {
				moved = true;
			}
		}

		const landed = Number(
			await page.evaluate(`document.querySelector(${JSON.stringify(SLIDER)}).value`)
		);
		const heldAt = await page.evaluate(DATASET);
		const sampleAt = await samplePx();
		await mouse("mouseReleased", xs[xs.length - 1], 0);
		await page.sleep(50);
		return {box, moved, landed, heldAt, sampleAt};
	};

	await page.evaluate(
		`document.querySelector(${JSON.stringify(SLIDER)}).scrollIntoView({block: "center"})`
	);
	const down = await drag(3, 1);
	page.check("drag down: slider held still", !down.moved);
	page.check("drag down: lands on the stop under the pointer", down.landed === 1);
	page.check("drag down: page still at large while held", down.heldAt === "large");
	page.check("drag down: sample shows small (13px) while held", down.sampleAt === "13px");
	page.check("drag down: small applied on release", (await page.evaluate(DATASET)) === "small");
	page.check("drag down: root is 13px", (await page.evaluate(ROOT_PX)) === "13px");
	const up = await drag(1, 4);
	page.check("drag up: slider held still", !up.moved);
	page.check("drag up: lands on the stop under the pointer", up.landed === 4);
	page.check("drag up: page still at small while held", up.heldAt === "small");
	page.check("drag up: sample shows xlarge (26px) while held", up.sampleAt === "26px");
	page.check("drag up: xlarge applied on release", (await page.evaluate(DATASET)) === "xlarge");
	page.check("sample matches the page once applied", (await samplePx()) === "26px");
	const after = await sliderBox();
	page.check(
		"same size at every scale",
		down.box.slice(2).join() === up.box.slice(2).join() &&
			after.slice(2).join() === up.box.slice(2).join()
	);
	await page.screenshot("settings-dragged-xlarge");

	await setSlider(5);
	page.check("html carries huge", (await page.evaluate(DATASET)) === "huge");
	page.check("root moves live", (await page.evaluate(ROOT_PX)) === "34px");
	page.check(
		"label reads Huge",
		(await page.evaluate(`document.querySelector(".font-size-value")?.textContent.trim()`)) ===
			"Huge"
	);
	page.check("stored as the name, not the index", (await page.evaluate(STORED)) === "huge");

	// The settings window's generic @change handler heard that change too;
	// the input has no `name` precisely so that handler cannot overwrite the
	// name with the raw slider index.
	page.check("drag end does not clobber", (await page.evaluate(STORED)) === "huge");
	await page.screenshot("settings-huge");

	// Spot-check the other end of the scale, then back to huge.
	await setSlider(0);
	page.check("tiny is 10px", (await page.evaluate(ROOT_PX)) === "10px");
	await setSlider(5);
	page.check("back to huge", (await page.evaluate(ROOT_PX)) === "34px");

	// Back on the channel the chat text actually wears it.
	await page.click(`.channel-list-item[data-name="#seance"]`);
	await page.waitFor(`!!document.querySelector("#form #input")`, {label: "back on chat"});
	page.check("input area at 34px", (await page.evaluate(FORM_PX)) === "34px");
	page.check("userlist at 34px", (await page.evaluate(USERLIST_PX)) === "34px");
	// The chrome wears it too: that is the point of sizing it in rem.
	page.check("sidebar rows at 34px", (await page.evaluate(SIDEBAR_ROW_PX)) === "34px");
	page.check("header grew to 102px", (await page.evaluate(HEADER_HEIGHT)) === "102px");
	page.check("footer buttons grew to 102px", (await page.evaluate(FOOTER_BTN)) === "102px");
	// The sidebar scales at half rate: 8rem + 128px = 400px at a 34px root.
	page.check(
		"sidebar 400px at huge",
		(await page.evaluate(`getComputedStyle(document.querySelector("#sidebar")).width`)) ===
			"400px"
	);

	if ((await page.count(".messages .msg")) > 0) {
		page.check(
			"messages at 34px",
			(await page.evaluate(
				`getComputedStyle(document.querySelector(".messages .msg")).fontSize`
			)) === "34px"
		);
	}

	await page.screenshot("chat-huge");

	// Survives a reload. replaceState first so the ?uri params do not run
	// again (reload-on-settings.mjs explains the dance); same profile, so
	// localStorage is the thing being tested.
	await page.evaluate(
		`(() => { window.__coldLoad = true; history.replaceState(null, "", ${JSON.stringify(
			BASE
		)}); location.reload(); })()`
	);
	await page.waitFor(`!window.__coldLoad && !!document.querySelector("#form #input")`, {
		timeout: 20000,
		label: "rebooted onto chat",
	});
	page.check("huge survives reload", (await page.evaluate(DATASET)) === "huge");
	page.check("input area still 34px", (await page.evaluate(FORM_PX)) === "34px");
	await page.screenshot("reloaded-huge");

	page.check("no console errors", page.consoleErrors.length === 0);
}
