// Searching the server's history (soju.im/search, issue #169): the query goes
// to the server and comes back as rows in the search window, never into the
// channel; filters, the lines around a hit and Open in channel all work.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d        # an image with soju.im/search
//   node tools/browser-drive.mjs tools/scenarios/history-search.mjs
//   node tools/browser-drive.mjs tools/scenarios/history-search.mjs --mobile --width=390 --height=844
//
// SEANCE_IRC_HOST / SEANCE_IRC_PORT (plain ws://) point it at another ircd;
// SEANCE_URL at another copy of public/.

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

		if (params[1] === "001") {
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
		quit: () => ws.send("QUIT :done"),
	};
}

const count = (page, selector) =>
	page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const text = (page, selector) =>
	page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? ""`);
const sentCommands = (page, since, re) =>
	page.wsFrames.slice(since).filter((f) => f.dir === "out" && re.test(f.payloadData ?? ""));

/** Type a query in the window's own field and submit it. */
async function search(page, q) {
	await page.evaluate(`(() => {
		const input = document.querySelector("${WINDOW} .search-query input");
		input.value = ${JSON.stringify(q)};
		input.dispatchEvent(new Event("input", {bubbles: true}));
		input.form.requestSubmit();
	})()`);
	await page.sleep(700);
}

export default async function run(page) {
	const talker = speaker(TALKER);
	await talker.joined;

	await page.goto(page.url, {waitForSelector: "#connect form"});
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
	await page.sleep(1500);

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
		"1. in nefarious2's spelling, scoped to the channel",
		asked[0] && new RegExp(`SEARCH in=${HOME} limit=\\d+ text=fake`).test(asked[0].payloadData)
	);
	page.check(
		"1. four hits, ours among them, no other channel's",
		(await count(page, ROWS)) === 4
	);
	await page.screenshot("1-results");

	// A phrase is one substring, and only the last selector may hold a space.
	const phraseFrom = page.wsFrames.length;
	await search(page, '"fake lag"');
	page.check(
		"1. a quoted phrase goes as one trailing parameter",
		sentCommands(page, phraseFrom, /limit=\d+ :text=fake lag/).length === 1
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
		"2. and takes it out of the field",
		(await page.evaluate(`document.querySelector("${WINDOW} .search-query input").value`)) ===
			"fake lag"
	);

	// Every channel.
	await search(page, "fake lag in:*");
	page.check("3. in:* finds the other channel", (await count(page, ROWS)) === 5);
	page.check(
		"3. and names it on the row",
		await page.evaluate(
			`[...document.querySelectorAll("${WINDOW} .search-chan")].some((e) => e.textContent === ${JSON.stringify(
				OTHER
			)})`
		)
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

	// Editing the field says the results are for the last search.
	await page.evaluate(`(() => {
		const input = document.querySelector("${WINDOW} .search-query input");
		input.value = "something else";
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
		/^something else\b/.test(
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

	// The lines around a hit, asked for and not landing in the channel.
	await search(page, "autojoin");
	const contextFrom = page.wsFrames.length;
	// Clicked through quickly: only the last one is asked about.
	await page.evaluate(
		`document.querySelectorAll(${JSON.stringify(ROWS)}).forEach((row) => row.click())`
	);
	await page.waitFor(`document.querySelectorAll(".search-context-line").length > 1`, {
		timeout: 10000,
		label: "context lines",
	});
	page.check(
		"6. a hit asks for the lines around it",
		sentCommands(page, contextFrom, /CHATHISTORY AROUND .* msgid=/).length === 1
	);
	page.check("6. the hit is marked", (await count(page, ".search-context-line.hit")) === 1);
	await page.screenshot("6-context");

	// Closing gives the focus back to the row, phone sheet included.
	await page.evaluate(`document.querySelector(".search-context-head button").click()`);
	await page.sleep(200);
	await page.evaluate(`(() => {
		const row = document.querySelector("${ROWS}");
		row.focus();
		row.click();
	})()`);
	await page.waitFor(`document.querySelectorAll(".search-context-line").length > 1`, {
		timeout: 10000,
		label: "context lines again",
	});
	await page.evaluate(`document.querySelector(".search-context-head button").click()`);
	await page.sleep(200);
	page.check(
		"6b. focus returns to the row",
		await page.evaluate(`document.activeElement === document.querySelector("${ROWS}")`)
	);
	await page.click(ROWS);
	await page.waitFor(`document.querySelectorAll(".search-context-line").length > 1`, {
		timeout: 10000,
		label: "context lines once more",
	});

	// Open in channel, and the channel untouched by all of the above.
	page.check(
		"7. a loaded hit offers Open in channel",
		(await text(page, ".search-context-foot .oper-btn-primary")) === "Open in channel"
	);
	await page.click(".search-context-foot .oper-btn-primary");
	await page.waitFor(`!document.querySelector("${WINDOW}")`, {
		timeout: 5000,
		label: "the window closed",
	});
	await page.sleep(400);
	page.check(
		"7. back in the channel with the same lines, no search row added",
		(await count(page, "#chat .msg[data-type='message']")) === chatLines
	);

	talker.quit();
}
