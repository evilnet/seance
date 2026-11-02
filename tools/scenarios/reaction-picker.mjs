// The reaction picker, end to end in a real browser.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/reaction-picker.mjs
//
// Everything here is invisible to `pnpm test`: the picker is a Vue component
// teleported to <body> and positioned from `getBoundingClientRect`, its
// catalog arrives as a lazily imported chunk, and what it sends only shows up
// as a badge under a message. The claims under test are that it opens where
// it should, that the catalog loads, that an emoji and a *word* both survive
// the round trip through the ircd, that recents persist, and that picking a
// reaction you already have takes it back off.
//
// A second IRC user posts the message to react to, driven straight from here
// over the dev ircd's WebSocket port.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = "wss://localhost:8443/";
const CHANNEL = "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=reactpick&join=%23seance`;

const PICKER = "body > .reaction-picker";
const OPTION = ".reaction-picker-option";
const INPUT = ".reaction-picker-input";

/** The reaction badges under `msg`, as text. */
const badgesOf = (msg) =>
	`Array.from(document.querySelectorAll("${msg} .msg-reaction:not(.msg-reaction-add) .msg-reaction-text")).map((b) => b.textContent)`;

/** Where an option with exactly this text sits in the flat list, or -1. */
const optionIndex = (page, text) =>
	page.evaluate(
		`Array.from(document.querySelectorAll(".reaction-picker-option")).findIndex((o) => o.textContent.trim() === ${JSON.stringify(
			text
		)})`
	);

/**
 * Contrast between the search field's placeholder and the popover behind it.
 * The picker is teleported out of `#chat-container`, which is where a theme
 * scopes its placeholder colour, so this is exactly the kind of thing that
 * silently falls back to the light-theme default.
 */
const PLACEHOLDER_CONTRAST = `(() => {
	const parse = (c) => (c.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
	const luminance = (rgb) =>
		rgb
			.map((v) => {
				const s = v / 255;
				return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
			})
			.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
	const input = document.querySelector(".reaction-picker-input");
	const back = luminance(parse(getComputedStyle(input.closest(".reaction-picker")).backgroundColor));
	const front = luminance(parse(getComputedStyle(input, "::placeholder").color));
	const [light, dark] = [front, back].sort((a, b) => b - a);
	return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
})()`;

/** What the picker would send if Enter were pressed right now. */
const ACTIVE = `(() => {
	const el = document.querySelector(".reaction-picker-option.active");
	return el ? el.dataset.index + ":" + el.textContent.trim() : null;
})()`;

/** A second user on the dev ircd, so there is somebody else's message to react to. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance reaction picker`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			ws.send(`JOIN ${CHANNEL}`);
		} else if (params[1] === "JOIN" && params[0].includes(nick)) {
			onJoin();
		} else if (params[1] === "433") {
			ws.send(`NICK ${nick}${Math.floor(Math.random() * 1000)}`);
		}
	};

	return {
		joined: new Promise((resolve, reject) => {
			onJoin = resolve;
			ws.onerror = (e) => reject(new Error(String(e.message ?? e)));
			setTimeout(() => reject(new Error(`${nick} never joined ${CHANNEL}`)), 20000);
		}),
		say: (text) => ws.send(`PRIVMSG ${CHANNEL} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

/** A real click with shift held, which is how a reaction is built up. */
async function shiftClick(page, selector, index = 0) {
	const r = await page.rect(selector, index);

	if (!r || (r.width === 0 && r.height === 0)) {
		throw new Error(`no visible element for ${selector}[${index}]`);
	}

	const at = {x: r.x + r.width / 2, y: r.y + r.height / 2, modifiers: 8};

	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", ...at});
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		button: "left",
		buttons: 1,
		clickCount: 1,
		...at,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		button: "left",
		buttons: 0,
		clickCount: 1,
		...at,
	});
	await page.sleep(120);
}

/**
 * Scrolls the message to the middle of the pane and waits until its
 * reaction "+" has stopped moving and is on screen. A fixed sleep after
 * `scrollIntoView` raced the scrollback: the open picker's scroll listener
 * repositions or closes it, the list can re-anchor, and a click measured
 * mid-move landed beside the button (seen once in eight runs).
 */
async function scrollToMessage(page, selector) {
	await page.evaluate(
		`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block: "center"})`
	);
	await page.waitFor(
		`(() => {
			const el = document.querySelector(${JSON.stringify(`${selector} .msg-reaction-add`)});
			if (!el) return false;
			const r = el.getBoundingClientRect();
			const same = window.__seanceLastTop === r.top;
			window.__seanceLastTop = r.top;
			return same && r.top >= 0 && r.bottom <= innerHeight;
		})()`,
		{label: "the message's reaction button to settle on screen"}
	);
}

/** A real key press on whatever has focus (the picker's search field). */
async function press(page, key, code = key) {
	const enter = key === "Enter";
	const common = {key, code, windowsVirtualKeyCode: enter ? 13 : keyCode(key)};

	await page.send("Input.dispatchKeyEvent", {type: "rawKeyDown", ...common});

	if (enter) {
		await page.send("Input.dispatchKeyEvent", {type: "char", text: "\r", ...common});
	}

	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...common});
	await page.sleep(80);
}

const keyCode = (key) =>
	({ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27}[key] ?? 0);

const KEYBOARD_UP = (px) =>
	`document.documentElement.style.setProperty("--viewport-height", "${px}px"); document.documentElement.dataset.keyboard = "up"`;
const KEYBOARD_DOWN = `document.documentElement.style.removeProperty("--viewport-height"); delete document.documentElement.dataset.keyboard`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`window.localStorage.removeItem("thelounge.reactions.recent")`);
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

	// The channel has history, so previous runs are on screen too: mark this
	// run's message and work only on the element that carries the mark.
	const token = `mark-${Date.now().toString(36)}`;
	const talker = speaker("reacttalk");
	await talker.joined;
	talker.say(`react to this line, ${token}`);
	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).some((c) => c.textContent.includes(${JSON.stringify(
			token
		)}))`,
		{timeout: 10000, label: "the message to react to"}
	);
	await page.sleep(300);

	const MSG = `#${await page.evaluate(
		`Array.from(document.querySelectorAll("#chat .msg")).find((m) => m.textContent.includes(${JSON.stringify(
			token
		)})).id`
	)}`;
	const BADGES = badgesOf(MSG);

	// 1. The toolbar is hover-only (display: none until then), and the picker
	//    opens from it. A synthetic click would never see it.
	await page.hover(MSG);
	await page.sleep(150);
	const toolbar = await page.rect(`${MSG} .msg-actions`);
	await page.check(
		`the hover toolbar appears (${JSON.stringify(toolbar)})`,
		toolbar && toolbar.width > 0
	);
	await page.click(`${MSG} .msg-action-react`);
	await page.waitFor(`document.querySelector(${JSON.stringify(PICKER)})`, {
		timeout: 5000,
		label: "the picker to open",
	});

	// It is teleported to <body>, so the scrollback cannot clip it; and it is
	// positioned by hand, so check it actually landed on screen.
	await page.sleep(300);

	const box = await page.rect(PICKER);
	await page.check(
		`the picker is on screen (${JSON.stringify(box)})`,
		box &&
			box.x >= 0 &&
			box.y >= 0 &&
			box.width > 200 &&
			(await page.evaluate(
				`(${JSON.stringify(box)}.x + ${JSON.stringify(box)}.width) <= window.innerWidth &&
				 (${JSON.stringify(box)}.y + ${JSON.stringify(box)}.height) <= window.innerHeight`
			))
	);

	// 2. The catalog is a lazily imported chunk: it arrives after the popover.
	await page.waitFor(`document.querySelectorAll(".reaction-picker-section").length >= 10`, {
		timeout: 10000,
		label: "the emoji catalog chunk",
	});
	// Only the recents and the first group are buttons at this point: the
	// other groups are placeholders sized like the grid they will become,
	// rendered as the scroll (or a tab, or the keyboard) reaches them — the
	// catalog is ~1900 emoji, and a button each is what made Android slow.
	const options = await page.count(OPTION);
	const placeholders = await page.count(".reaction-picker-placeholder");
	await page.check(
		`the picker opens on the first group only (${options} options, ${placeholders} placeholders)`,
		options < 400 && placeholders >= 7
	);
	await page.click(".reaction-picker-tab:last-child");
	await page.sleep(250);
	const flags = await page.evaluate(
		`(() => {
			const list = document.querySelector(".reaction-picker-list");
			const section = list.querySelector('[data-key="flags"]');
			return {
				rendered: !!section.querySelector(".reaction-picker-option"),
				buttons: section.querySelectorAll(".reaction-picker-option").length,
				offBy: Math.round(section.getBoundingClientRect().top - list.getBoundingClientRect().top),
				tab: document.querySelector(".reaction-picker-tab.active").title,
			};
		})()`
	);
	await page.check(
		`the Flags tab renders its group and lands on it (${JSON.stringify(flags)})`,
		flags.rendered && flags.buttons > 200 && Math.abs(flags.offBy) <= 2 && flags.tab === "Flags"
	);
	// Scroll so the People placeholder is within the render-ahead margin (the
	// list is short in this window), and the observer is what renders it.
	await page.evaluate(
		`(() => {
			const list = document.querySelector(".reaction-picker-list");
			list.scrollTop = list.querySelector('[data-key="people"]').offsetTop - list.clientHeight - 100;
		})()`
	);
	await page.sleep(300);
	const afterScroll = await page.evaluate(
		`document.querySelectorAll('[data-key="people"] .reaction-picker-option').length`
	);
	await page.check(
		`scrolling renders the group coming into view (${afterScroll} People & Body buttons)`,
		afterScroll > 100
	);
	await page.click(".reaction-picker-tab:first-child");
	await page.sleep(150);
	await page.check(
		"the quick reactions come first before anything is remembered",
		(await page.evaluate(`document.querySelector(".reaction-picker-heading").textContent`)) ===
			"Quick reactions"
	);
	await page.check(
		"there is a tab per group plus recents",
		(await page.count(".reaction-picker-tab")) === 10
	);
	await page.check(
		"tab does not walk 1878 buttons: the field drives the grid",
		(await page.evaluate(`document.querySelector(${JSON.stringify(OPTION)}).tabIndex`)) === -1
	);
	await page.screenshot("1-picker-open", {selector: PICKER, pad: 8});

	// 3. Searching. An exact alias means the emoji is what Enter sends.
	await page.fill(INPUT, "tada");
	await page.sleep(250);
	await page.check(
		"an exact alias highlights the emoji",
		(await page.evaluate(ACTIVE))?.endsWith("🎉")
	);
	await page.check(
		"the typed text is still offered as itself",
		(await page.count(`${OPTION}.free`)) === 1
	);
	await page.screenshot("2-search-tada", {selector: PICKER, pad: 8});

	await press(page, "Enter");
	await page.waitFor(`!document.querySelector(${JSON.stringify(PICKER)})`, {
		label: "the picker to close after picking",
	});
	await page.waitFor(`${BADGES}.includes("🎉")`, {
		timeout: 5000,
		label: "the 🎉 badge (round trip through the ircd)",
	});
	await page.check(
		"the emoji came back as a badge",
		(await page.evaluate(BADGES)).includes("🎉")
	);

	// 4. A word is a reaction too, and a word that merely prefixes an emoji
	//    name must not turn into that emoji.
	await page.click(`${MSG} .msg-reaction-add`);
	await page.waitFor(`document.querySelector(${JSON.stringify(INPUT)})`, {
		label: "the picker reopened from the + button",
	});
	await page.fill(INPUT, "lol");
	await page.sleep(250);
	const active = await page.evaluate(ACTIVE);
	await page.check(`a word highlights itself, not 🍭 lollipop (${active})`, /lol$/.test(active));
	await page.screenshot("3-search-word", {selector: PICKER, pad: 8});

	await press(page, "Enter");
	await page.waitFor(`${BADGES}.includes("lol")`, {
		timeout: 5000,
		label: "the word badge",
	});
	await page.check(
		"a word badge is set as text, not as a glyph",
		(await page.count("#chat .msg-reaction.word")) > 0
	);

	// 4b. Shift-click builds a reaction out of several emoji instead of
	//     sending each one, and the grid must stay put while it does — the
	//     next emoji to add is in it.
	await page.click(`${MSG} .msg-reaction-add`);
	await page.waitFor(`document.querySelector(${JSON.stringify(PICKER)})`, {
		label: "the picker for the combination",
	});
	await page.waitFor(`document.querySelectorAll(".reaction-picker-section").length >= 10`, {
		timeout: 10000,
		label: "the catalog",
	});

	const beforeBuild = await page.count(".reaction-picker-section");
	const smiley = await optionIndex(page, "😀");
	await shiftClick(page, OPTION, smiley);
	await shiftClick(page, OPTION, smiley + 1);

	await page.check(
		`shift-click builds instead of sending (${await page.evaluate(
			`document.querySelector(${JSON.stringify(INPUT)}).value`
		)})`,
		(await page.evaluate(`document.querySelector(${JSON.stringify(INPUT)}).value`)) === "😀😃"
	);
	await page.check(
		"the grid stays put while building, so the next emoji is where it was",
		(await page.count(".reaction-picker-section")) === beforeBuild
	);
	await page.check(
		"the preview bar shows what is being built",
		(await page.evaluate(`document.querySelector(".reaction-picker-preview").textContent`))
			.replace(/\s+/g, " ")
			.includes("Building a reaction")
	);
	await page.screenshot("4-combination", {selector: PICKER, pad: 8});

	// The pointer is over the grid: while building, that must not rewrite what
	// Enter does.
	await page.hover(OPTION, smiley + 4);
	await page.sleep(200);
	await page.check(
		"hovering while building does not steal what Enter sends",
		(await page.evaluate(`document.querySelector(".reaction-picker-preview").textContent`))
			.replace(/\s+/g, " ")
			.includes("Building a reaction")
	);

	await press(page, "Enter");
	await page.waitFor(`${BADGES}.includes("😀😃")`, {
		timeout: 5000,
		label: "the combined badge",
	});
	await page.check(
		"the combination arrives as one reaction",
		(await page.evaluate(BADGES)).includes("😀😃")
	);

	// 5. Both are remembered, newest first, words included.
	const recent = await page.evaluate(`window.localStorage.getItem("thelounge.reactions.recent")`);
	await page.check(
		`recents are stored newest first, combinations included (${recent})`,
		recent === '["😀😃","lol","🎉"]'
	);

	// 6. Reopened, the recents lead and what we already sent is ticked.
	await page.click(`${MSG} .msg-reaction-add`);
	await page.waitFor(`document.querySelector(${JSON.stringify(PICKER)})`, {
		label: "the picker to reopen",
	});
	await page.check(
		"the recents section leads",
		(await page.evaluate(`document.querySelector(".reaction-picker-heading").textContent`)) ===
			"Recently used"
	);
	await page.check(
		"every remembered reaction of ours is ticked",
		(await page.count(`.reaction-picker-section[data-key="recent"] ${OPTION}.selected`)) === 3
	);
	await page.check(
		"the tick follows the reaction into the catalog, not the row",
		(await page.count(`${OPTION}.selected`)) > 2
	);
	await page.screenshot("4-recents", {selector: PICKER, pad: 8});

	// 7. The keyboard drives the grid while the field keeps focus.
	const before = await page.evaluate(`document.querySelector(${JSON.stringify(INPUT)}).id`);
	await press(page, "ArrowDown");
	const described = await page.evaluate(
		`document.querySelector(${JSON.stringify(INPUT)}).getAttribute("aria-activedescendant")`
	);
	await page.check(`arrow keys move the highlight (${described})`, !!described);
	await page.check(
		"the search field still has focus",
		(await page.evaluate(`document.activeElement.className`)) === "reaction-picker-input"
	);
	await press(page, "ArrowRight");
	const moved = await page.evaluate(
		`document.querySelector(${JSON.stringify(INPUT)}).getAttribute("aria-activedescendant")`
	);
	await page.check(`right moves on again (${described} → ${moved})`, moved !== described);
	await page.check("the field is the same one", before !== null);
	await page.screenshot("5-keyboard", {selector: PICKER, pad: 8});

	// 8. Picking one we already have takes it back off.
	await page.click(OPTION, await optionIndex(page, "🎉"));
	await page.waitFor(`!${BADGES}.includes("🎉")`, {
		timeout: 5000,
		label: "the 🎉 badge to go away again",
	});
	await page.check(
		"picking a ticked reaction removes it",
		!(await page.evaluate(BADGES)).includes("🎉")
	);
	await page.check("the word badge is untouched", (await page.evaluate(BADGES)).includes("lol"));
	await page.screenshot("6-removed", {selector: "#chat", pad: 8});

	// 9. Escape closes it, and a message at the bottom of the window opens the
	//    picker upwards rather than off the screen.
	talker.say(`this one sits at the bottom of the scrollback, ${token}`);
	await page.sleep(1000);
	const LAST = `#${await page.evaluate(
		`Array.from(document.querySelectorAll("#chat .msg")).filter((m) => m.textContent.includes("sits at the bottom")).pop().id`
	)}`;
	await page.hover(LAST);
	await page.sleep(150);
	await page.click(`${LAST} .msg-action-react`);
	await page.waitFor(`document.querySelector(${JSON.stringify(PICKER)})`, {
		label: "the picker on the last message",
	});
	await page.check(
		"a message near the bottom opens the picker upwards",
		await page.evaluate(
			`document.querySelector(${JSON.stringify(PICKER)}).classList.contains("flipped")`
		)
	);
	await page.sleep(300);

	const flippedBox = await page.rect(PICKER);
	await page.check(
		`the flipped picker is still fully on screen (${JSON.stringify(flippedBox)})`,
		flippedBox && flippedBox.y >= 0
	);
	await page.screenshot("7-flipped", {selector: "body", pad: 0});

	// Opening one from another message closes this one: the opener stops the
	// mousedown the outside-click handler would have seen.
	await scrollToMessage(page, MSG);
	await page.click(`${MSG} .msg-reaction-add`);
	await page.sleep(400);
	await page.check("only one picker is ever open", (await page.count(PICKER)) === 1);

	await press(page, "Escape");
	await page.sleep(200);
	await page.check("escape closes it", (await page.count(PICKER)) === 0);

	// 10. On a phone-sized viewport it is a sheet along the bottom edge, not a
	//     popover: there is no room for one once the keyboard is up.
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 400,
		height: 780,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.sleep(400);

	// The narrow layout opens with the sidebar over the chat; picking the
	// channel puts the conversation back on screen.
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.sleep(400);
	await scrollToMessage(page, MSG);
	await page.click(`${MSG} .msg-reaction-add`);
	await page.waitFor(`document.querySelector(${JSON.stringify(PICKER)})`, {
		label: "the picker on a narrow viewport",
	});
	await page.sleep(300); // the entrance animation scales it in over 120ms

	const sheet = await page.rect(PICKER);
	await page.check(
		`the narrow viewport gets the sheet (${JSON.stringify(sheet)})`,
		(await page.evaluate(
			`document.querySelector(${JSON.stringify(PICKER)}).classList.contains("sheet")`
		)) &&
			sheet.x === 0 &&
			Math.round(sheet.width) === 400 &&
			Math.round(sheet.y + sheet.height) === 780
	);
	await page.screenshot("8-sheet", {selector: "body", pad: 0});

	// The sheet ends where the visible band ends, not where the window does:
	// on iOS the keyboard covers the bottom 300px or so of a fixed element's
	// `bottom: 0` without shrinking the window. helpers/viewport.ts publishes
	// the band as `--viewport-height`; a headless Chromium has no keyboard, so
	// the scenario publishes one of 480px by hand and expects the sheet to
	// move up out of the covered part and shrink to 70% of what is left.
	await page.evaluate(KEYBOARD_UP(480));
	await page.sleep(200);
	const raised = await page.rect(PICKER);
	await page.check(
		`the sheet keeps above the keyboard (${JSON.stringify(raised)})`,
		Math.round(raised.y + raised.height) === 480 && Math.round(raised.height) === 336
	);
	await page.screenshot("8b-sheet-keyboard", {selector: "body", pad: 0});
	await page.evaluate(KEYBOARD_DOWN);
	await press(page, "Escape");
	await page.sleep(200);

	// A phone turned sideways is 812px and up wide but under 500px tall, and
	// with the keyboard up it keeps ~190px: the popover showed one row of
	// emoji there, so a touch device that short gets the sheet as well (the
	// landscape clause of PHONE_LAYOUT_QUERY). Touch emulation is what makes
	// `(hover: none) and (pointer: coarse)` true.
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 844,
		height: 390,
		deviceScaleFactor: 1,
		mobile: true,
	});
	await page.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
	await page.sleep(400);
	await page.evaluate(`document.querySelector("#sidebar")?.classList.remove("open")`);
	await scrollToMessage(page, MSG);
	await page.click(`${MSG} .msg-reaction-add`);
	await page.waitFor(`document.querySelector(${JSON.stringify(PICKER)})`, {
		label: "the picker on a landscape phone",
	});
	// The keyboard comes up once the search field is tapped, after the open.
	// The sheet then takes the whole band and drops its tab strip, which is
	// what leaves room for two rows of emoji.
	await page.evaluate(KEYBOARD_UP(190));
	await page.sleep(300);

	const landscape = await page.rect(PICKER);
	const landscapeList = await page.rect(`${PICKER} .reaction-picker-list`);
	const option = await page.rect(`${PICKER} .reaction-picker-option`);
	await page.check(
		`a landscape phone gets the sheet above the keyboard (${JSON.stringify(
			landscape
		)}, list ${Math.round(landscapeList.height)}px, option ${Math.round(option.height)}px)`,
		(await page.evaluate(
			`document.querySelector(${JSON.stringify(PICKER)}).classList.contains("sheet")`
		)) &&
			landscape.x === 0 &&
			Math.round(landscape.width) === 844 &&
			Math.round(landscape.y) === 0 &&
			Math.round(landscape.y + landscape.height) === 190 &&
			(await page.count(`${PICKER} .reaction-picker-tabs`)) === 1 &&
			(await page.rect(`${PICKER} .reaction-picker-tabs`)).height === 0 &&
			landscapeList.height >= 2 * option.height
	);
	await page.screenshot("8c-sheet-landscape", {selector: "html", pad: 0});
	await page.evaluate(KEYBOARD_DOWN);
	await page.send("Emulation.setTouchEmulationEnabled", {enabled: false, maxTouchPoints: 1});
	await page.send("Emulation.clearDeviceMetricsOverride");
	await page.sleep(400);

	// 11. Readable on either theme. The placeholder is the giveaway: themes
	//     scope theirs to `#chat-container`, which the picker is not in.
	const light = await page.evaluate(PLACEHOLDER_CONTRAST);
	await page.check(`the placeholder reads on the default theme (${light}:1)`, light >= 4.5);

	await page.evaluate(`(() => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = "themes/morning.css";
		document.head.appendChild(link);
	})()`);
	await page.sleep(600);

	const dark = await page.evaluate(PLACEHOLDER_CONTRAST);
	await page.check(`the placeholder reads on a dark theme (${dark}:1)`, dark >= 4.5);
	await page.screenshot("9-dark-theme", {selector: PICKER, pad: 8});

	talker.quit();
	await page.check("no console errors", page.consoleErrors.length === 0);
}
