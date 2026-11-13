// The composer's autocomplete takes a tap or a click: a press on the menu
// leaves the focus in the composer (autocompletion.ts), whose blur closes the
// menu (ChatInput.vue). The press used to take the focus, so the menu was
// gone before the tap or click landed and an entry could only be picked with
// Tab or Enter; on a phone the keyboard dropped as well.
//
//   pnpm build && python3 -m http.server -d "$PWD/public" 8000 &
//   node tools/browser-drive.mjs tools/scenarios/autocomplete-pick.mjs
//   node tools/browser-drive.mjs tools/scenarios/autocomplete-pick.mjs --mobile --width=412 --height=900
//
// No ircd needed: lib/tiny-ircd.mjs answers the JOIN with three nicks. What it
// checks: `@` opens the nick list; a click (or, with --mobile, a finger's tap)
// on a nick puts it in the draft, closes the menu and leaves the composer
// focused; a press elsewhere still closes the menu, the draft kept. The four
// lists (@nick, #channel, /command, colour) are one menu, so one is enough.
// `SEANCE_PORT` serves the app from another port.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9876;
const CHANNEL = "#pick";

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=picker&join=${encodeURIComponent(
	CHANNEL
)}`;

const INPUT = `document.querySelector("#input")`;
const MENU_OPEN = `(() => {
	const menu = document.querySelector(".textcomplete-menu");
	return !!menu && menu.style.display !== "none" && menu.querySelectorAll(".textcomplete-item").length > 0;
})()`;

/** The middle of the menu entry that reads `text`. */
async function entryAt(page, text) {
	const r = JSON.parse(
		await page.evaluate(`(() => {
			const li = [...document.querySelectorAll(".textcomplete-menu .textcomplete-item")]
				.find((el) => el.textContent.trim() === ${JSON.stringify(text)});
			return JSON.stringify(li ? li.getBoundingClientRect() : null);
		})()`)
	);

	if (!r || r.width === 0) {
		throw new Error(`no menu entry "${text}"`);
	}

	return {x: r.x + r.width / 2, y: r.y + r.height / 2};
}

/** A finger's tap (--mobile) or a mouse click at a point. */
async function press(page, {x, y}, finger) {
	if (finger) {
		await page.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{x, y, radiusX: 12, radiusY: 12, force: 1}],
		});
		await page.sleep(60);
		await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	} else {
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x, y});
		await page.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x,
			y,
			button: "left",
			buttons: 1,
			clickCount: 1,
		});
		await page.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x,
			y,
			button: "left",
			buttons: 0,
			clickCount: 1,
		});
	}

	await page.sleep(300);
}

export default async function run(page) {
	const finger = page.flags.has("--mobile");
	const how = finger ? "tap" : "click";
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		onLine(line, {send, nick}) {
			if (!line.startsWith("JOIN ")) {
				return false;
			}

			send(`:${nick}!u@tiny JOIN ${CHANNEL}`);
			send(`:tiny.test 353 ${nick} = ${CHANNEL} :${nick} alice bob carol`);
			send(`:tiny.test 366 ${nick} ${CHANNEL} :End of /NAMES list.`);
			return true;
		},
	});

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		const item = `document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`;
		await page.waitFor(item, {label: CHANNEL});
		await page.evaluate(`${item}.click()`);
		await page.waitFor(
			`${INPUT} && document.querySelector("#chat .userlist .names")?.textContent.includes("carol")`,
			{label: "the channel's nicks"}
		);

		const openMenu = async () => {
			await page.evaluate(`${INPUT}.focus()`);
			await page.send("Input.insertText", {text: "@"});
			await page.waitFor(MENU_OPEN, {label: "the nick menu"});
		};

		await openMenu();
		await page.screenshot(`menu-${how}`);
		await press(page, await entryAt(page, "bob"), finger);

		const value = await page.evaluate(`${INPUT}.value`);
		await page.check(
			`a ${how} on "bob" puts it in the draft (got ${JSON.stringify(value)})`,
			value.startsWith("bob")
		);
		await page.check(`the menu closes after the ${how}`, !(await page.evaluate(MENU_OPEN)));
		await page.check(
			`the composer keeps the focus (the keyboard stays up)`,
			await page.evaluate(`document.activeElement === ${INPUT}`)
		);

		// A press anywhere else still closes it, by the composer's blur.
		await page.evaluate(
			`${INPUT}.value = ""; ${INPUT}.dispatchEvent(new Event("input", {bubbles: true}))`
		);
		await openMenu();
		const chat = JSON.parse(
			await page.evaluate(
				`JSON.stringify(document.querySelector("#chat .chat").getBoundingClientRect())`
			)
		);
		await press(page, {x: chat.x + chat.width / 2, y: chat.y + 40}, finger);
		await page.check(`a ${how} on the chat closes the menu`, !(await page.evaluate(MENU_OPEN)));
		await page.check(
			`…and leaves the draft as it was`,
			(await page.evaluate(`${INPUT}.value`)) === "@"
		);
	} finally {
		await ircd.close();
	}
}
