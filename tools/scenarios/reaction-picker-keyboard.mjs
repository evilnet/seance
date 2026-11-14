// The message toolbar's reaction picker stays open when its search field
// raises the keyboard. Android lays the page out again in what its keyboard
// leaves (index.html's `interactive-widget=resizes-content`), and for a frame,
// until the scrollback sticks to its bottom again, a message near the bottom
// sits past the new window edge. The popover took that frame for the message
// being scrolled away and closed (ReactionPicker.vue `reposition`), which
// dropped the keyboard again: on a touch screen wide enough for the popover
// (a tablet, a foldable, a phone at a small display size) the search could
// not be used. Only a scroll of the scrollback closes it now.
//
//   pnpm build && python3 -m http.server -d "$PWD/public" 8000 &
//   node tools/browser-drive.mjs tools/scenarios/reaction-picker-keyboard.mjs --mobile --width=820 --height=1180
//
// No ircd needed: lib/tiny-ircd.mjs offers message-tags and answers the JOIN
// with a scrollback of messages that carry msgids. A headless Chromium has no
// keyboard, so the scenario plays Android's: the window loses 340px when the
// search field is tapped. What it checks: with the scrollback at its bottom, a
// tap on the last message's picker search keeps the picker open, the field
// focused and the popover on screen; a search and a tap on an emoji send the
// reaction on that message; scrolled up, a message the keyboard pushes out of
// the scrollback keeps its picker, inside the window; and scrolling the
// scrollback still closes a picker whose message has gone.
// `SEANCE_PORT` serves the app from another port.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9877;
const CHANNEL = "#keys";
const COUNT = 80;
const KEYBOARD_PX = 340;

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=keys&join=${encodeURIComponent(
	CHANNEL
)}`;

const PICKER = `document.querySelector("body > .reaction-picker")`;
const SEARCH = `document.querySelector(".reaction-picker-input")`;
const LIST = `document.querySelector("#chat .chat")`;
const msg = (n) =>
	`[...document.querySelectorAll("#chat .msg")].find((m) => m.querySelector(".content")?.textContent.trim() === "line ${n}")`;

/** A finger's tap, or a press held for `holdMs` (a long press). */
async function tap(page, {x, y}, holdMs = 60) {
	await page.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{x, y, radiusX: 12, radiusY: 12, force: 1}],
	});
	await page.sleep(holdMs);
	await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	await page.sleep(300);
}

async function centre(page, expr, label) {
	const r = JSON.parse(
		await page.evaluate(`(() => {
			const el = ${expr};
			return JSON.stringify(el ? el.getBoundingClientRect() : null);
		})()`)
	);

	if (!r || r.width === 0) {
		throw new Error(`nothing to press: ${label}`);
	}

	return {x: r.x + r.width / 2, y: r.y + r.height / 2};
}

const pickerOnScreen = (page) =>
	page.evaluate(`(() => {
		const r = ${PICKER}?.getBoundingClientRect();
		return !!r && r.top >= 0 && r.bottom <= innerHeight && r.height > 100;
	})()`);

export default async function run(page) {
	if (!page.flags.has("--mobile")) {
		throw new Error(
			"run with --mobile --width=820 --height=1180: the picker is a popover on a touch screen"
		);
	}

	const width = Number(page.opt("width", 820));
	const height = Number(page.opt("height", 1180));
	const keyboard = async (up) => {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width,
			height: up ? height - KEYBOARD_PX : height,
			deviceScaleFactor: 1,
			mobile: true,
		});
		await page.sleep(800); // the picker re-reads the layout for 600 ms after a resize
	};

	const sent = [];
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "message-tags",
		onLine(line, {send, nick}) {
			sent.push(line);

			if (!line.startsWith("JOIN ")) {
				return false;
			}

			send(`:${nick}!u@tiny JOIN ${CHANNEL}`);
			send(`:tiny.test 353 ${nick} = ${CHANNEL} :${nick} alice`);
			send(`:tiny.test 366 ${nick} ${CHANNEL} :End of /NAMES list.`);

			for (let i = 1; i <= COUNT; i++) {
				send(`@msgid=line${i} :alice!a@tiny PRIVMSG ${CHANNEL} :line ${i}`);
			}

			return true;
		},
	});

	/** Long-press message `n` and tap its toolbar's react button. */
	const openPicker = async (n) => {
		await tap(
			page,
			await centre(page, `${msg(n)}?.querySelector(".content")`, `line ${n}`),
			700
		);
		await tap(
			page,
			await centre(
				page,
				`${msg(n)}?.querySelector(".msg-action-react")`,
				`line ${n}'s react button`
			)
		);
		await page.waitFor(`${PICKER}?.querySelector(".reaction-picker-option")`, {
			label: `the picker on line ${n}`,
		});
		await page.sleep(300); // past the pop-in
	};

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		const item = `document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`;
		await page.waitFor(item, {label: CHANNEL});
		await page.evaluate(`${item}.click()`);
		await page.waitFor(`!!${msg(COUNT)}`, {label: "the scrollback"});
		await page.sleep(500);

		// 1. At the bottom: the last message's picker, its search tapped.
		await openPicker(COUNT);
		await page.check(
			"the picker is a popover here, not the phone's sheet",
			!(await page.evaluate(`${PICKER}.classList.contains("sheet")`))
		);
		await tap(page, await centre(page, SEARCH, "the search field"));
		await keyboard(true);
		await page.screenshot("1-keyboard-up");
		await page.check(
			"the picker stays open as the keyboard comes up",
			await page.evaluate(`!!${PICKER}`)
		);
		await page.check(
			"the search field keeps the caret (the keyboard stays up)",
			await page.evaluate(`document.activeElement === ${SEARCH}`)
		);
		await page.check("the popover is inside the window", await pickerOnScreen(page));

		// 2. The search is usable: what it finds is picked by a tap.
		await page.send("Input.insertText", {text: "smil"});
		await page.sleep(300);
		const before = sent.length;
		await tap(
			page,
			await centre(
				page,
				`${PICKER}.querySelector(".reaction-picker-option:not(.free)")`,
				"an emoji"
			)
		);
		const reaction = sent.slice(before).find((l) => l.includes("TAGMSG"));
		await page.check(
			`a tap on an emoji it found reacts to line ${COUNT} (${reaction ?? "nothing sent"})`,
			!!reaction &&
				/\+draft\/react=[^\x00-\x7f]/.test(reaction) &&
				reaction.includes(`=line${COUNT}`)
		);
		await page.check("…and closes the picker", !(await page.evaluate(`!!${PICKER}`)));
		await keyboard(false);

		// 3. Scrolled up, with a message at the bottom edge of the scrollback:
		//    the keyboard pushes it out of the shrunk list, and the list does
		//    not follow (it is not at its bottom). The picker stays, on screen.
		const low = COUNT - 6;
		await page.evaluate(`${msg(low)}.scrollIntoView({block: "end"})`);
		await page.sleep(400);
		await openPicker(low);
		await tap(page, await centre(page, SEARCH, "the search field"));
		await keyboard(true);
		await page.screenshot("3-scrolled-up-keyboard");
		await page.check(
			"scrolled up, the picker stays open as the keyboard covers its message",
			await page.evaluate(`!!${PICKER}`)
		);
		await page.check("…inside the window", await pickerOnScreen(page));
		await keyboard(false);

		// 4. Scrolling the scrollback still takes the picker away with its message.
		await page.check(
			"the picker is open before the scroll",
			await page.evaluate(`!!${PICKER}`)
		);
		await page.evaluate(`${LIST}.scrollTop = 0`);
		await page.sleep(400);
		await page.check(
			"scrolling the message out of view closes its picker",
			!(await page.evaluate(`!!${PICKER}`))
		);

		await page.check(
			`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
			page.consoleErrors.length === 0
		);
	} finally {
		await ircd.close();
	}
}
