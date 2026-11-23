// Windows' contrast themes and Reduce Transparency in a real browser, under
// ps (the theme with the most glass): with forced colours on, the scene
// leaves the page, no surface keeps a blur, the composer's focus and the open
// conversation are drawn as outlines in the system's Highlight; with reduced
// transparency, <html> carries data-reduce-transparency and ps's glass turns
// solid (style.css § forced colours, helpers/systemAccessibility.ts).
//
//   pnpm build && python3 -m http.server -d "$PWD/public" 8000 &
//   node tools/browser-drive.mjs tools/scenarios/forced-colors.mjs
//
// No ircd needed: lib/tiny-ircd.mjs. `SEANCE_PORT` serves the app from another port.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9879;
const CHANNEL = "#contrast";

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=hc&join=${encodeURIComponent(
	CHANNEL
)}`;

const cs = (selector, prop) =>
	`(() => { const el = document.querySelector(${JSON.stringify(
		selector
	)}); return el ? getComputedStyle(el)[${JSON.stringify(prop)}] : null; })()`;

export default async function run(page) {
	const ircd = startTinyIrcd({port: IRCD_PORT});
	const media = (features) => page.send("Emulation.setEmulatedMedia", {features});

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(
			`localStorage.setItem("settings", JSON.stringify({...JSON.parse(localStorage.getItem("settings") ?? "{}"), theme: "ps"}))`
		);
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		const item = `.channel-list-item[data-name="${CHANNEL}"]`;
		await page.waitFor(`!!document.querySelector('${item}')`, {label: CHANNEL});
		await page.evaluate(`document.querySelector('${item}').click()`);
		await page.waitFor(`!!document.querySelector("#input")`, {label: "the channel"});
		await page.waitFor(`!!document.querySelector("#theme-scene > *")`, {label: "ps's scene"});
		page.check(
			"ps: the scene shows",
			(await page.evaluate(cs("#theme-scene", "display"))) !== "none"
		);
		page.check(
			"ps: the sidebar is glass",
			(await page.evaluate(cs("#sidebar", "backdropFilter"))) !== "none"
		);

		// Reduce Transparency (Chromium has the query; WebKit's comes from the shell).
		await media([{name: "prefers-reduced-transparency", value: "reduce"}]);
		await page.waitFor(`document.documentElement.hasAttribute("data-reduce-transparency")`, {
			label: "data-reduce-transparency set",
		});
		page.check(
			"reduced transparency: the sidebar's glass is solid",
			(await page.evaluate(cs("#sidebar", "backdropFilter"))) === "none"
		);
		// No blur, and no see-through fill either: the colour's alpha reaches 1
		// once ps's light flip (a transition) has run.
		const opaque = `/^rgb\\(/.test(${cs("#sidebar", "backgroundColor")})`;
		await page
			.waitFor(opaque, {label: "the sidebar's fill turns opaque", timeout: 5000})
			.catch(() => {});
		page.check(
			`reduced transparency: the sidebar's fill is opaque (${await page.evaluate(
				cs("#sidebar", "backgroundColor")
			)})`,
			await page.evaluate(opaque)
		);
		await media([]);
		await page.waitFor(`!document.documentElement.hasAttribute("data-reduce-transparency")`, {
			label: "data-reduce-transparency cleared",
		});

		// Forced colours.
		await media([{name: "forced-colors", value: "active"}]);
		await page.waitFor(`matchMedia("(forced-colors: active)").matches`, {
			label: "forced colours",
		});
		page.check(
			"forced colours: the scene leaves the page",
			(await page.evaluate(cs("#theme-scene", "display"))) === "none"
		);
		page.check(
			"forced colours: no blur on the sidebar",
			(await page.evaluate(cs("#sidebar", "backdropFilter"))) === "none"
		);
		page.check(
			"forced colours: the open conversation is outlined",
			(await page.evaluate(cs(`${item}.active`, "outlineStyle"))) === "solid"
		);
		await page.evaluate(`document.querySelector("#input").focus()`);
		page.check(
			"forced colours: the composer's focus outlines the bar",
			(await page.evaluate(cs("#form", "outlineStyle"))) === "solid"
		);
		// A control that draws its focus as a shadow: the settings' first switch.
		await page.evaluate(`document.activeElement.blur()`);
		await page.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Tab",
			code: "Tab",
			windowsVirtualKeyCode: 9,
		});
		await page.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Tab",
			code: "Tab",
			windowsVirtualKeyCode: 9,
		});
		const ring = JSON.parse(
			await page.evaluate(
				`JSON.stringify({tag: document.activeElement?.tagName, style: getComputedStyle(document.activeElement).outlineStyle, color: getComputedStyle(document.activeElement).outlineColor})`
			)
		);
		page.check(
			`forced colours: a keyboard focus is a ring (${ring.tag} ${ring.style})`,
			ring.style === "solid"
		);
		// The context menu keeps focus on itself (aria-activedescendant): the
		// row the arrow keys reach is marked in the system's selection colours.
		await page.evaluate(
			`document.querySelector('${item}').dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: 40, clientY: 40}))`
		);
		await page.waitFor(`!!document.querySelector("#context-menu")`, {
			label: "the context menu",
		});
		await page.evaluate(
			`document.querySelector("#context-menu").dispatchEvent(new KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}))`
		);
		await page.waitFor(`!!document.querySelector("#context-menu .context-menu-item.active")`, {
			label: "an active row",
		});
		const marks = JSON.parse(
			await page.evaluate(`(() => {
				const probe = document.createElement("div");
				probe.style.backgroundColor = "highlight";
				document.body.append(probe);
				const want = getComputedStyle(probe).backgroundColor;
				probe.remove();
				const row = document.querySelector("#context-menu .context-menu-item.active");
				return JSON.stringify({want, got: getComputedStyle(row).backgroundColor});
			})()`)
		);
		page.check(
			`forced colours: the menu's active row is the system selection (${marks.got})`,
			marks.got === marks.want
		);
		// A selected tab whose button paints its own label (Settings): the
		// label and icon take the selection's text colour, not the theme's.
		await page.evaluate(
			`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))`
		);
		await page.evaluate(`document.querySelector("#sidebar .icon.settings").click()`);
		await page.waitFor(
			`!!document.querySelector('li[role="tab"][aria-selected="true"] button')`,
			{
				label: "Settings, with a selected tab",
			}
		);
		const tab = JSON.parse(
			await page.evaluate(`(() => {
				const probe = document.createElement("div");
				probe.style.color = "highlighttext";
				document.body.append(probe);
				const want = getComputedStyle(probe).color;
				probe.remove();
				const button = document.querySelector('li[role="tab"][aria-selected="true"] button');
				return JSON.stringify({want, got: getComputedStyle(button).color});
			})()`)
		);
		page.check(
			`forced colours: the selected Settings tab's label is the selection's text (${tab.got})`,
			tab.got === tab.want
		);
		await page.screenshot("forced-colors-ps");
		await media([]);
	} finally {
		await ircd.close();
	}
}
