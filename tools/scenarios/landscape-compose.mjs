// Compose mode: in a band as short as a landscape phone's keyboard leaves,
// the channel header goes while the composer has the caret, and comes back
// when it loses it (style.css `@container viewport (max-height: 18rem)`).
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/landscape-compose.mjs --mobile
//
// `SEANCE_IRC_URL` and `SEANCE_IRC_CHANNEL` point it at another network.
//
// Chromium cannot raise a keyboard, so the scenario does what iOS does: it
// shrinks the viewport to what the keyboard leaves (926x180) with the caret
// in the composer, and grows it back. `--mobile` is required — the app only
// sizes itself from the visual viewport on a touch device.
const IRCD = process.env.SEANCE_IRC_URL ?? "wss://localhost:8443/";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";
const ircd = new URL(IRCD);
const stamp = Math.random().toString(36).slice(2, 6);
const NICK = `land${stamp}`;
const HOST = ircd.hostname + ircd.pathname.replace(/\/$/, "");
const IRC_PORT = ircd.port || (ircd.protocol === "wss:" ? "443" : "80");

export const url =
	`http://localhost:${PORT}/?host=${encodeURIComponent(HOST)}&port=${IRC_PORT}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

const HEADER_SHOWN = `getComputedStyle(document.querySelector("#chat .header")).display !== "none"`;
const FOCUSED = `document.activeElement === document.querySelector("#input")`;

/** A phone in landscape: 926x428, and 926x180 once the keyboard and Safari's form bar are up. */
const LANDSCAPE = {width: 926, height: 428};
const KEYBOARD_UP = {width: 926, height: 180};

export default async function run(page) {
	const resize = async ({width, height}) => {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: 1,
			mobile: true,
		});
		// The app re-reads the visual viewport on a settle schedule (viewport.ts).
		await page.sleep(700);
	};

	await resize(LANDSCAPE);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	page.check(
		"the browser is emulating a touch device (pass --mobile)",
		await page.evaluate(`matchMedia("(hover: none) and (pointer: coarse)").matches`)
	);

	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#chat .header")`, {label: "the channel header"});

	// Landscape, no keyboard: the header stays, caret or not.
	page.check("428px tall, no caret: header shown", await page.evaluate(HEADER_SHOWN));
	await page.evaluate(`document.querySelector("#input").focus()`);
	page.check("the composer has the caret", await page.evaluate(FOCUSED));
	page.check(
		"428px tall, caret in the composer: header shown",
		await page.evaluate(HEADER_SHOWN)
	);
	await page.screenshot("landscape-compose-no-keyboard");

	// The keyboard comes up.
	await resize(KEYBOARD_UP);
	page.check(
		"180px tall, caret in the composer: header hidden",
		!(await page.evaluate(HEADER_SHOWN))
	);
	const messages = await page.rect("#chat .chat-view .messages, #chat .chat");
	const form = await page.rect("#form");
	// With the header (3rem) it would start 48px or more down.
	page.check(
		`the scrollback starts at the top of the band (y=${messages?.y})`,
		messages !== null && messages.y < 16
	);
	page.check(
		`the composer is inside the band (bottom=${form?.y + form?.height})`,
		form.y + form.height <= 180
	);
	await page.screenshot("landscape-compose-keyboard");

	// Done on the keyboard: the caret leaves, the header returns at once.
	await page.evaluate(`document.querySelector("#input").blur()`);
	page.check("180px tall, no caret: header shown", await page.evaluate(HEADER_SHOWN));

	await resize(LANDSCAPE);
	page.check("428px tall again: header shown", await page.evaluate(HEADER_SHOWN));

	// The sidebar still slides over the chat: the container query must not
	// have changed the stacking inside #viewport.
	await page.click("#viewport .lt");
	await page.sleep(300);
	const onTop = await page.evaluate(
		`(() => { const el = document.elementFromPoint(40, 200); return !!el && !!el.closest("#sidebar"); })()`
	);
	page.check("the sidebar opens over the chat", onTop);
	await page.screenshot("landscape-compose-sidebar");
}
