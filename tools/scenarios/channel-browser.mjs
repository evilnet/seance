// The channel browser (docs/resources/client-features.md § Channel browser):
// opened from the sidebar's join form, it asks the server once, shows the
// MOTD's featured channels as cards and every channel as a row, searches on
// the device, and a row joins.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d        # with tmp/nefarious-dev/ircd.motd mounted for the cards
//   node tools/browser-drive.mjs tools/scenarios/channel-browser.mjs
//   node tools/browser-drive.mjs tools/scenarios/channel-browser.mjs --mobile --width=390 --height=844
//
// SEANCE_IRC_HOST / SEANCE_IRC_PORT (plain ws://) point it at another ircd;
// SEANCE_URL at another copy of public/.

const HOST = process.env.SEANCE_IRC_HOST ?? "127.0.0.1";
const PORT = process.env.SEANCE_IRC_PORT ?? "8067";
const RUN = Date.now().toString(36).slice(-5);
const NICK = `brw${RUN}`;
const HOME = `#brw${RUN}`;
const BASE = process.env.SEANCE_URL ?? "http://localhost:8000/";

export const url = `${BASE}?host=${HOST}&port=${PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	HOME
)}`;

/** The channels the bots fill, so the list has something to show. */
const SEEDED = [
	["#help", "Questions about the network and the client — ask away", 4],
	["#seance", "The client, its bugs and its plans | https://github.com/evilnet/seance", 3],
	["#lounge", "", 2],
	["#gaming", "Tonight: co-op at 20:00 UTC", 2],
	["#music", "What are you listening to?", 1],
	["#linux", "No distro wars. Okay, some.", 1],
	["#art", "Share what you made this week", 1],
	["#nighthawks", "", 1],
];

function bot(nick, channels) {
	const ws = new WebSocket(`ws://${HOST}:${PORT}/`, ["text.ircv3.net"]);
	let onReady = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance browser bot`);
	};
	ws.onmessage = ({data}) => {
		const line = String(data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
		} else if (/ 376 | 422 /.test(line)) {
			ws.send(`JOIN ${channels.map(([name]) => name).join(",")}`);
			setTimeout(() => {
				for (const [name, topic] of channels) {
					if (topic) {
						ws.send(`TOPIC ${name} :${topic}`);
					}
				}

				onReady();
			}, 1500);
		}
	};

	return {
		ready: new Promise((resolve, reject) => {
			onReady = resolve;
			setTimeout(() => reject(new Error(`${nick} never registered`)), 20000);
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

export default async function run(page) {
	// Bots: the most-populated channel first in the list.
	const bots = [];
	const most = Math.max(...SEEDED.map(([, , n]) => n));

	for (let i = 0; i < most; i++) {
		const mine = SEEDED.filter(([, , n]) => n > i).map(([name, topic]) => [
			name,
			i === 0 ? topic : "",
		]);
		bots.push(bot(`bot${RUN}${i}`, mine));
	}

	await Promise.all(bots.map((b) => b.ready));

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${HOME}"]')`, {
		timeout: 30000,
		label: `${HOME} in the sidebar`,
	});
	await page.sleep(1500);

	// 1. Two ways in: the sidebar's join form, or `/list` from the composer
	// (the phone run, where the sidebar is a drawer).
	const before = page.wsFrames.length;
	const mobile = await page.evaluate(`matchMedia("(hover: none) and (pointer: coarse)").matches`);

	if (mobile) {
		await page.evaluate(`(() => {
			const input = document.querySelector("#input");
			input.value = "/list";
			input.dispatchEvent(new Event("input", {bubbles: true}));
			document.querySelector("#form").requestSubmit();
		})()`);
	} else {
		await page.click("#sidebar .add-channel");
		await page.sleep(300);
		await page.screenshot("1-join-form", {selector: "#sidebar"});
		await page.click("#sidebar .join-browse");
	}

	await page.waitFor(`document.querySelector("#channel-browser")`, {label: "the browser opens"});
	await page.sleep(300);
	await page.screenshot("2-loading");

	// 2. One LIST, and the answer.
	await page.waitFor(`document.querySelectorAll("#channel-browser .browse-row").length >= 8`, {
		timeout: 15000,
		label: "the rows arrive",
	});
	await page.sleep(500);
	page.check("one LIST was sent", sentCommands(page, before, /^LIST/).length === 1);
	await page.screenshot("3-list");

	const cards = await count(page, "#channel-browser .browse-card");
	page.check("the MOTD's four featured channels are cards", cards === 4);
	page.check(
		"a card carries the MOTD's blurb",
		(await text(page, "#channel-browser .browse-card .browse-card-blurb")).startsWith(
			"Questions about the network"
		)
	);
	page.check(
		"#help, the fullest, is the first row",
		(await text(page, "#channel-browser .browse-row .browse-row-name bdi")) === "#help"
	);
	page.check(
		"the featured row wears a star",
		(await count(page, ".browse-row.featured .browse-tag")) >= 3
	);
	page.check(
		"Refresh is disabled right after an answer",
		await page.evaluate(`document.querySelector(".browse-refresh").disabled`)
	);

	// 3. Search is on the device: no second LIST.
	await page.fill("#channel-browser .browse-query input", "co-op");
	await page.sleep(300);
	const hits = await count(page, "#channel-browser .browse-row");
	page.check("a topic word finds its channel", hits === 1);
	page.check("typing asked the server nothing", sentCommands(page, before, /^LIST/).length === 1);
	await page.screenshot("4-search");

	await page.fill("#channel-browser .browse-query input", "nothinglikeit");
	await page.sleep(300);
	page.check(
		"a lone name with no match offers to start it",
		(await count(page, ".browse-center .oper-btn-primary")) === 1
	);
	await page.screenshot("5-create");

	await page.click("#channel-browser .browse-clear");
	await page.sleep(200);

	// 4. A chip narrows the list.
	await page.click("#channel-browser .browse-chip", 1); // Featured
	await page.sleep(300);
	// #quiet is featured but empty, so the server never listed it: three rows.
	page.check(
		"the Featured chip keeps the featured rows",
		(await count(page, "#channel-browser .browse-row")) === 3
	);
	await page.click("#channel-browser .browse-chip", 0);
	await page.sleep(200);

	// 5. A row joins and the chat opens there.
	await page.click("#channel-browser .browse-row", 0);
	await page.waitFor(
		`document.querySelector("#chat .header .title")?.textContent.trim() === "#help"`,
		{
			timeout: 10000,
			label: "#help opens",
		}
	);
	await page.sleep(500);
	await page.screenshot("6-joined");
	page.check("the join was sent", sentCommands(page, before, /^JOIN #help/).length === 1);

	// 6. The header's ⋯ menu: "List all channels" on the network window opens
	// the browser; "List banned users" on a channel opens its ban list the
	// first time (it used to appear in the sidebar only, and open on the second).
	const menuItem = async (label) => {
		await page.click("#chat button.menu");
		await page.waitFor(`document.querySelector("#context-menu-container")`, {
			label: "the menu",
		});
		await page.sleep(200);
		await page.evaluate(`[...document.querySelectorAll("#context-menu .context-menu-item")]
			.find((e) => e.textContent.trim() === ${JSON.stringify(label)}).click()`);
	};

	await page.click('#sidebar .channel-list-item[data-type="lobby"]');
	await page.sleep(400);
	await menuItem("List all channels");
	await page.waitFor(`document.querySelector("#channel-browser")`, {
		label: "the browser from the menu",
	});
	page.check("the menu's channel list opens the browser", true);
	await page.sleep(300);
	await page.screenshot("7-from-menu");

	await page.click(`#sidebar .channel-list-item[data-name="${HOME}"]`);
	await page.sleep(400);
	await page.evaluate(`(() => {
		const input = document.querySelector("#input");
		input.value = "/ban *!*@evil.example";
		input.dispatchEvent(new Event("input", {bubbles: true}));
		document.querySelector("#form").requestSubmit();
	})()`);
	await page.sleep(1200);
	await menuItem("List banned users");
	await page.waitFor(`document.querySelector("#ban-browser .ban-row")`, {
		timeout: 10000,
		label: "the Bans window opens at once",
	});
	await page.sleep(300);
	await page.screenshot("8-ban-list");

	page.check("no console errors", page.consoleErrors.length === 0);

	for (const b of bots) {
		b.quit();
	}
}
