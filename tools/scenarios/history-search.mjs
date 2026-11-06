// Searching the server's history (soju.im/search, issue #169): the query goes
// to the server and comes back as rows in the search window, never into the
// channel; filters work, and a hit goes straight to its message in the main window.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d        # an image with soju.im/search
//   node tools/browser-drive.mjs tools/scenarios/history-search.mjs
//   node tools/browser-drive.mjs tools/scenarios/history-search.mjs --mobile --width=390 --height=844
//
// SEANCE_IRC_HOST / SEANCE_IRC_PORT (plain ws://) point it at another ircd;
// SEANCE_URL at another copy of public/.

import {mouse} from "./lib/backdrop.mjs";

const HOST = process.env.SEANCE_IRC_HOST ?? "127.0.0.1";
const PORT = process.env.SEANCE_IRC_PORT ?? "8067";
const RUN = Date.now().toString(36).slice(-5);
const NICK = `srch${RUN}`;
const TALKER = `tlk${RUN}`;
const HOME = `#srch${RUN}`;
const OTHER = `#srcb${RUN}`;
const BASE = process.env.SEANCE_URL ?? "http://localhost:8000/";

export const url = `${BASE}?host=${HOST}&port=${PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	`${HOME},${OTHER}`
)}`;

const WINDOW = ".chat-view[data-type='search-results']";
const ROWS = `${WINDOW} .search-hit`;
const ROW = (name) => `.channel-list-item[data-name="${name}"]`;

function speaker(nick) {
	const ws = new WebSocket(`ws://${HOST}:${PORT}/`, ["text.ircv3.net"]);
	let joins = 0;
	let onJoined = () => {};
	let onDrained = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance search`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "PONG" && line.endsWith(":drained")) {
			onDrained();
		} else if (params[1] === "001") {
			ws.send("OPER seanceop seance"); // no fake lag for the filler lines
			ws.send(`JOIN ${HOME},${OTHER}`);
		} else if (params[1] === "JOIN" && params[0].includes(nick) && ++joins === 2) {
			onJoined();
		}
	};

	return {
		joined: new Promise((resolve, reject) => {
			onJoined = resolve;
			setTimeout(() => reject(new Error(`${nick} never joined`)), 20000);
		}),
		say: (target, text) => ws.send(`PRIVMSG ${target} :${text}`),
		drained: () =>
			new Promise((resolve) => {
				onDrained = resolve;
				ws.send("PING :drained");
			}),
		quit: () => ws.send("QUIT :done"),
	};
}

const count = (page, selector) =>
	page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const text = (page, selector) =>
	page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? ""`);
const sentCommands = (page, since, re) =>
	page.wsFrames.slice(since).filter((f) => f.dir === "out" && re.test(f.payloadData ?? ""));

/** Search for exactly this query, whatever chips are up: the route is the search's state. */
async function search(page, q) {
	await page.evaluate(
		`location.hash = location.hash.split("?")[0] + "?q=" + ${JSON.stringify(
			encodeURIComponent(q)
		)}`
	);
	await page.sleep(700);
}

export default async function run(page) {
	const talker = speaker(TALKER);
	await talker.joined;

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="autoconnect"]'); // dialled again on step 8's reload
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector(${JSON.stringify(ROW(OTHER))})`, {
		timeout: 30000,
		label: `${OTHER} in the sidebar`,
	});
	await page.sleep(1500);

	// Seen by the page live, so strict presence cannot hide them.
	talker.say(HOME, "why does autojoin take so long");
	talker.say(HOME, "each command costs 2 s of fake lag on connect");
	talker.say(HOME, "fake lag in docker never shows");
	talker.say(HOME, "the picture https://example.test/fake-lag.png explains it");
	talker.say(HOME, "right");
	talker.say(OTHER, "fake lag over here too");
	talker.say(HOME, `${"padding words go by ".repeat(20)}until the tailword at its end`);
	await page.sleep(8000); // the dev ircd paces a burst

	const opened = await page.evaluate(`(() => {
		const item = document.querySelector(${JSON.stringify(ROW(HOME))});
		item?.click();
		return Boolean(item);
	})()`);
	page.check("the channel opens", opened);
	await page.sleep(500);
	await page.evaluate(`(() => {
		const input = document.querySelector("#input");
		input.value = "so the fake lag clock has to stay under 4 s";
		input.dispatchEvent(new Event("input", {bubbles: true}));
		document.querySelector("#form").requestSubmit();
	})()`);
	await page.sleep(1000);
	const chatLines = await count(page, "#chat .msg[data-type='message']");

	// Pressing a header button over the open mentions pane closes it and does the job.
	await page.evaluate(`document.querySelector("#chat button.mentions").click()`);
	await page.sleep(300);
	const searchButton = JSON.parse(
		await page.evaluate(`(() => {
			const box = document.querySelector("#chat button.search").getBoundingClientRect();
			const point = {x: box.x + box.width / 2, y: box.y + box.height / 2};
			const under = document.elementFromPoint(point.x, point.y);
			return JSON.stringify(under?.id === "mentions-popup-container" ? point : null);
		})()`)
	);

	// On the phone layout the pane is the whole screen: nothing beside it to press.
	if (searchButton) {
		await mouse(page, "mousePressed", searchButton.x, searchButton.y, 1);
		await mouse(page, "mouseReleased", searchButton.x, searchButton.y, 0);
		await page.sleep(300);
		page.check(
			"the search button over the mentions pane closes it and opens search, ready to type",
			await page.evaluate(`!document.querySelector("#mentions-popup-container") &&
				document.activeElement === document.querySelector("${WINDOW} .search-query input")`)
		);
		await page.evaluate(
			`document.querySelector("${WINDOW} :is(.search-close, .search-cancel)").click()`
		);
		await page.sleep(300);
	} else {
		await page.evaluate(
			`document.querySelector("#mentions-popup-container .mentions-close").click()`
		);
		await page.sleep(200);
	}

	// /search opens the window; the field, not the lobby, owns the query.
	const start = page.wsFrames.length;
	await page.evaluate(`(() => {
		const input = document.querySelector("#input");
		input.value = "/search fake lag";
		input.dispatchEvent(new Event("input", {bubbles: true}));
		document.querySelector("#form").requestSubmit();
	})()`);
	await page.waitFor(`document.querySelector("${ROWS}")`, {
		timeout: 10000,
		label: "search results",
	});

	const asked = sentCommands(page, start, /\bSEARCH\b/);
	page.check("1. SEARCH goes to the server", asked.length === 1);
	page.check(
		"1. in the spec's one parameter, scoped to the channel",
		asked[0] && new RegExp(`SEARCH in=${HOME};text=fake;limit=\\d+$`).test(asked[0].payloadData)
	);
	page.check(
		"1. four hits, ours among them, no other channel's",
		(await count(page, ROWS)) === 4
	);
	await page.screenshot("1-results");

	// A long line: four lines at most, the ones with the match; the match is painted.
	await search(page, "tailword");
	const longHit = await page.evaluate(`(() => {
		const box = document.querySelector("${WINDOW} .search-text");
		const mark = CSS.highlights.get("search-hit");
		const range = mark && [...mark][0];
		const at = range?.getBoundingClientRect();
		const lines = box.clientHeight / at.height;
		const row = box.getBoundingClientRect();
		const meta = box.closest(".search-hit").querySelector(".search-meta").getBoundingClientRect();
		return {
			lines,
			shown: !!at && at.top >= row.top - 1 && at.bottom <= row.bottom + 1,
			word: range?.toString(),
			selectable: getComputedStyle(box).userSelect,
			timeClear: meta.bottom <= row.top + 1,
		};
	})()`);
	page.check(
		`1. a long line stops at four lines (${longHit.lines})`,
		longHit.lines > 0 && longHit.lines < 4.5
	);
	page.check("1. and shows the match, late in it", longHit.shown && longHit.word === "tailword");
	page.check("1. selectable, or WebKit paints no mark", longHit.selectable === "text");
	page.check("1. the time stays out of the text", longHit.timeClear);
	await page.screenshot("1-long-line");

	// Typing searches once it pauses, one search for the whole burst, under the field.
	const typing = (value) =>
		page.evaluate(`(() => {
			const field = document.querySelector("${WINDOW} .search-query input");
			field.value = ${JSON.stringify(value)};
			field.dispatchEvent(new Event("input", {bubbles: true}));
		})()`);

	// Words in the field, filters in chips: a finished filter moves over.
	await typing("right in:*");
	page.check(
		"1. a filter still being typed stays in the field",
		(await page.evaluate(`document.querySelector("${WINDOW} .search-query input").value`)) ===
			"right in:*"
	);
	await typing("right in:* ");
	await page.sleep(100);
	page.check(
		"1. then moves to its chip",
		(await page.evaluate(`document.querySelector("${WINDOW} .search-query input").value`)) ===
			"right " &&
			(await text(page, `${WINDOW} .search-chip.on`))
				.toLowerCase()
				.includes("all my channels")
	);
	await page.evaluate(`(() => {
		const field = document.querySelector("${WINDOW} .search-query input");
		field.value = "fake from:${TALKER}";
		field.dispatchEvent(new Event("input", {bubbles: true}));
		field.form.requestSubmit();
	})()`);
	await page.sleep(300);
	page.check(
		"1. Enter does the same to the last one",
		(await page.evaluate(`document.querySelector("${WINDOW} .search-query input").value`)) ===
			"fake" && (await text(page, `${WINDOW} .search-chip[data-filter]`)).includes(TALKER)
	);
	await search(page, "tailword");

	await page.sleep(2500); // past the gap since the search above
	const typedFrom = page.wsFrames.length;
	await typing("ri");
	await page.sleep(1500);
	page.check(
		"1. two letters ask nothing",
		sentCommands(page, typedFrom, /^(@\S+ )?SEARCH /).length === 0
	);

	for (const value of ["rig", "righ", "right"]) {
		await typing(value);
		await page.sleep(150);
	}

	await page.sleep(400);
	page.check(
		"1. nothing yet while it is typed",
		sentCommands(page, typedFrom, /^(@\S+ )?SEARCH /).length === 0
	);
	await page.waitFor(
		`[...document.querySelectorAll("${ROWS}")].some((row) => row.textContent.includes("right"))`,
		{timeout: 5000, label: "the typed search's hit"}
	);
	page.check(
		"1. then one search, for what the field says",
		sentCommands(page, typedFrom, /^(@\S+ )?SEARCH /).length === 1 &&
			sentCommands(page, typedFrom, /text=right/).length === 1
	);
	page.check(
		"1. and the field keeps what was typed",
		(await page.evaluate(`document.querySelector("${WINDOW} .search-query input").value`)) ===
			"right"
	);
	await search(page, "fake lag");

	// A phrase is one substring, its space escaped.
	const phraseFrom = page.wsFrames.length;
	await search(page, '"fake lag"');
	page.check(
		"1. a quoted phrase goes as one escaped value",
		sentCommands(page, phraseFrom, /;text=fake\\slag;/).length === 1
	);
	// The picture says fake-lag.png: both words, not the phrase.
	page.check("1. and leaves out what only has the words", (await count(page, ROWS)) === 3);

	// Without: hidden here, and said so.
	await search(page, "fake lag -docker");
	page.check("2. Without hides a row", (await count(page, ROWS)) === 3);
	page.check(
		"2. the status line counts it",
		/1 hidden by filters/.test(await text(page, `${WINDOW} .search-status`))
	);
	page.check(
		"2. its chip is there to remove",
		(await text(page, `${WINDOW} .search-chip[data-filter]`)).includes("docker")
	);
	await page.click(`${WINDOW} .search-chip[data-filter] .search-chip-remove`);
	await page.sleep(700);
	page.check("2. removing the chip brings it back", (await count(page, ROWS)) === 4);
	page.check(
		"2. and the field still holds the words",
		(await page.evaluate(`document.querySelector("${WINDOW} .search-query input").value`)) ===
			"fake lag"
	);

	// Every channel.
	await search(page, "fake lag in:*");
	page.check("3. in:* finds the other channel", (await count(page, ROWS)) === 5);
	await search(page, "right");
	await search(page, "fake lag *");
	page.check("3. so does a bare *", (await count(page, ROWS)) === 5);

	// Every-channel search leaves out private messages, and may come back empty
	// for other reasons of the server's: what is loaded still counts.
	talker.say(NICK, "whispered onlyinprivate");
	await page.sleep(500);
	await search(page, "onlyinprivate in:*");
	page.check(
		"3. an empty every-channel answer falls back to loaded lines, and says so",
		(await count(page, ROWS)) === 1 && (await count(page, `${WINDOW} .search-banner`)) === 1
	);
	await search(page, "nowhereatall in:*");
	page.check(
		"3. nothing loaded either is just no matches",
		(await count(page, ROWS)) === 0 && (await count(page, `${WINDOW} .search-banner`)) === 0
	);
	await search(page, "fake lag in:*");
	page.check(
		"3. and names it on the row",
		await page.evaluate(
			`[...document.querySelectorAll("${WINDOW} .search-chan")].some((e) => e.textContent === ${JSON.stringify(
				OTHER
			)})`
		)
	);

	// Loaded lines beside the server's rows: private lines are marked, and paging
	// goes on from the server's oldest, not from theirs.
	talker.say(NICK, "whispered inbothplaces");
	await page.sleep(500);
	const afterPrivate = Date.now();
	await page.sleep(100);
	talker.say(OTHER, "said inbothplaces");
	await page.sleep(500);
	await search(page, "inbothplaces in:*");
	page.check(
		"3. every channel adds loaded private lines, marked",
		(await count(page, ROWS)) === 2 &&
			(await count(page, `${WINDOW} .search-loaded`)) === 1 &&
			(await count(page, `${WINDOW} .search-banner`)) === 0
	);
	await page.screenshot("3-loaded-private");
	const olderFrom = page.wsFrames.length;
	await page.evaluate(
		`[...document.querySelectorAll("${WINDOW} .search-status button")].find((b) => b.textContent.trim() === "Search older").click()`
	);
	await page.sleep(500);
	const older = sentCommands(page, olderFrom, /^(@\S+ )?SEARCH /)[0]?.payloadData ?? "";
	page.check(
		"3. and Search older pages from the server's row",
		new Date(/before=([^;\s]+)/.exec(older)?.[1]).getTime() > afterPrivate
	);

	// One conversation, same fallback: nothing is stored for a private conversation
	// without accounts.
	await search(page, `onlyinprivate in:${TALKER}`);
	page.check(
		"3. an empty answer for one conversation falls back too, and says so",
		(await count(page, ROWS)) === 1 && (await count(page, `${WINDOW} .search-banner`)) === 1
	);
	// has:image, through the sheet.
	await search(page, "fake lag");
	await page.click(`${WINDOW} .search-chips > button:last-child`);
	await page.sleep(200);
	page.check("4. the filter sheet opens", (await count(page, "#search-filters")) === 1);
	await page.screenshot("4-filters");
	await page.evaluate(
		`[...document.querySelectorAll("#search-filters .search-seg button")].find((b) => b.textContent.trim() === "Image").click()`
	);
	await page.evaluate(`document.querySelector("#search-filters").requestSubmit()`);
	await page.sleep(700);
	page.check("4. it closes on apply", (await count(page, "#search-filters")) === 0);
	page.check("4. has:image leaves the picture", (await count(page, ROWS)) === 1);

	// A sheet takes the focus, keeps Tab, and gives it back.
	await search(page, "fake lag");
	await page.click(`${WINDOW} .search-chips > button:last-child`);
	await page.sleep(200);
	page.check(
		"4b. focus moves into the sheet",
		await page.evaluate(
			`document.querySelector("#search-filters").contains(document.activeElement)`
		)
	);
	page.check(
		"4b. the window behind it is inert",
		await page.evaluate(`document.querySelector("${WINDOW} .search-list").inert`)
	);

	// The range's last day is included: today's messages stay with today as the end.
	await page.evaluate(
		`[...document.querySelectorAll("#search-filters .search-seg button")].find((b) => b.textContent.trim().startsWith("Range")).click()`
	);
	await page.sleep(100);
	await page.evaluate(`(() => {
		const end = document.querySelectorAll("#search-filters input[type=date]")[1];
		const now = new Date();
		const pad = (n) => String(n).padStart(2, "0");
		end.value = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
		end.dispatchEvent(new Event("input", {bubbles: true}));
		document.querySelector("#search-filters").requestSubmit();
	})()`);
	await page.sleep(700);
	page.check("4c. a range ending today includes today", (await count(page, ROWS)) === 4);

	await page.evaluate(
		`document.querySelector("${WINDOW} .search-chips > button:last-child").click()`
	);
	await page.sleep(200);
	await page.evaluate(
		`[...document.querySelectorAll("#search-filters button")].find((b) => b.textContent.trim() === "Cancel").click()`
	);
	await page.sleep(200);
	page.check("4d. Cancel closes the sheet", (await count(page, "#search-filters")) === 0);

	// A range the wrong way round is refused where it was entered.
	await page.evaluate(
		`document.querySelector("${WINDOW} .search-chips > button:last-child").click()`
	);
	await page.sleep(200);
	await page.evaluate(`(() => {
		[...document.querySelectorAll("#search-filters .search-seg button")].find((b) => b.textContent.trim().startsWith("Range")).click();
	})()`);
	await page.sleep(100);
	await page.evaluate(`(() => {
		const [from, to] = document.querySelectorAll("#search-filters input[type=date]");
		from.value = "2026-10-20";
		from.dispatchEvent(new Event("input", {bubbles: true}));
		to.value = "2026-10-10";
		to.dispatchEvent(new Event("input", {bubbles: true}));
		document.querySelector("#search-filters").requestSubmit();
	})()`);
	await page.sleep(200);
	page.check(
		"4dd. a reversed range stays in the sheet and says why",
		(await count(page, "#search-filters .search-range-error")) === 1
	);
	await page.evaluate(
		`[...document.querySelectorAll("#search-filters button")].find((b) => b.textContent.trim() === "Cancel").click()`
	);
	await page.sleep(200);

	// An edit too short to search by itself says the results are for the last search.
	await page.evaluate(`(() => {
		const input = document.querySelector("${WINDOW} .search-query input");
		input.value = "so";
		input.dispatchEvent(new Event("input", {bubbles: true}));
	})()`);
	await page.sleep(100);
	page.check("4e. an edited field says so", (await count(page, `${WINDOW} .search-stale`)) === 1);
	await page.screenshot("4e-edited");

	// A filter applied now searches what the field says, not the last search.
	await page.evaluate(
		`document.querySelector("${WINDOW} .search-chips > button:last-child").click()`
	);
	await page.sleep(200);
	await page.evaluate(
		`[...document.querySelectorAll("#search-filters .search-seg button")].find((b) => b.textContent.trim() === "Link").click()`
	);
	await page.evaluate(`document.querySelector("#search-filters").requestSubmit()`);
	await page.sleep(700);
	page.check(
		"4f. applying a filter keeps the edited words",
		/^so\b/.test(
			await page.evaluate(`document.querySelector("${WINDOW} .search-query input").value`)
		)
	);

	// No matches.
	await search(page, "nothingmatchesthis");
	page.check(
		"5. no matches says so",
		/No matches in/.test(await text(page, `${WINDOW} .search-center`))
	);
	await page.screenshot("5-empty");

	// A hit takes the chat beside to the message, and the results stay; on a
	// phone the panel tucks away until the header's magnifier.
	await search(page, "autojoin");
	await page.click(ROWS);
	await page.sleep(400);
	page.check(
		"7. the results stay: beside the chat, or tucked away on a phone",
		await page.evaluate(`(() => {
			const panel = document.querySelector("${WINDOW}")?.closest("#search-panel");
			const phone = matchMedia("(max-width: 768px)").matches;
			return !!panel && (getComputedStyle(panel).display === "none") === phone;
		})()`)
	);
	page.check(
		"7. the channel opens at the hit",
		await page.evaluate(
			`Array.from(document.querySelectorAll("#chat .msg")).some((m) => m.getAnimations().length > 0)`
		)
	);
	page.check(
		"7. back in the channel with the same lines, no search row added",
		(await count(page, "#chat .msg[data-type='message']")) === chatLines
	);

	// A hit the channel has not loaded: older than a reload's first page. It opens
	// in the main window, among the lines around it.
	const FAR = `faraway${RUN}`;
	talker.say(OTHER, `${FAR} is the line to page back to ||spoiler||`);
	for (let i = 0; i < 60; i++) {
		talker.say(OTHER, `filler line ${i}`);
	}
	await talker.drained();
	await page.sleep(1000);
	await page.goto(BASE, {waitForSelector: "#chat, #connect"});
	await page.waitFor(`document.querySelector(${JSON.stringify(ROW(OTHER))})`, {
		timeout: 30000,
		label: `${OTHER} after the reload`,
	});
	await page.evaluate(`document.querySelector(${JSON.stringify(ROW(HOME))}).click()`);
	await page.sleep(3000);
	await page.evaluate(`(() => {
		const input = document.querySelector("#input");
		input.value = ${JSON.stringify(`/search ${FAR} in:${OTHER}`)};
		input.dispatchEvent(new Event("input", {bubbles: true}));
		document.querySelector("#form").requestSubmit();
	})()`);
	await page.waitFor(`document.querySelector("${ROWS}")`, {
		timeout: 10000,
		label: "the far hit",
	});
	const farFrom = page.wsFrames.length;
	await page.click(ROWS);
	const far = `Array.from(document.querySelectorAll("#chat .msg")).find((m) => m.textContent.includes(${JSON.stringify(
		FAR
	)}))`;
	await page.waitFor(`!!${far}`, {timeout: 20000, label: "the far hit loaded"});
	await page.waitFor(`(${far}?.getAnimations().length ?? 0) > 0`, {
		timeout: 5000,
		label: "the far hit flashing",
	});
	page.check(
		"8. the main window opens at the far hit, without paging back",
		sentCommands(page, farFrom, /CHATHISTORY AROUND .* msgid=/).length === 1 &&
			sentCommands(page, farFrom, /CHATHISTORY BEFORE /).length === 0 &&
			(await text(page, ".past-bar-text")).includes("older messages")
	);
	await page.screenshot("8-far-hit");
	page.check(
		"8. the panel stays, now beside the hit's channel",
		(await count(page, ROWS)) > 0 &&
			/#\/chan-\d+\/search/.test(await page.evaluate("location.hash"))
	);

	// Closed by the magnifier beside the chat, or by Cancel on a phone, where the
	// panel covers the header; then open again with the searches remembered.
	const panelShown = `getComputedStyle(document.querySelector("#search-panel")).display !== "none"`;
	if (!(await page.evaluate(panelShown))) {
		await page.click("#chat .header button.search"); // a phone tucked it away
		await page.sleep(200);
	}
	const phone = (await count(page, `${WINDOW} .search-cancel`)) === 1;
	await page.click(phone ? `${WINDOW} .search-cancel` : "#chat .header button.search");
	await page.sleep(200);
	page.check(
		phone ? "9. Cancel closes search" : "9. the magnifier closes search",
		(await count(page, WINDOW)) === 0
	);
	await page.click("#chat .header button.search");
	await page.waitFor(`document.querySelector("${WINDOW}")`, {
		timeout: 5000,
		label: "search opened again",
	});
	page.check(
		"9. it opens empty, with the searches kept on this device",
		(await count(page, ROWS)) === 0 &&
			(await page.evaluate(
				`document.querySelector("${WINDOW} .search-query input").value`
			)) === "" &&
			(await count(page, `${WINDOW} .search-recent-item`)) > 0
	);

	talker.quit();
}
