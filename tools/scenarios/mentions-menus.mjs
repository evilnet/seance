// The Mentions popup over a page with no active channel: a click on a sender or
// a channel in a row opens that row's menu, for the row's network. They used to
// throw (activeChannel undefined). The lobby comes first because the IRC layer
// still counts the last chat shown as attended, and reads what arrives there.
//
//   tools/nefarious-dev/run.sh -d
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/mentions-menus.mjs --no-ws

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";
const IRCD = "wss://localhost:8443/";
const CHANNEL = "#seance";
const NICK = "menus" + Math.floor(Math.random() * 1000);

export const url = `${BASE}?host=localhost&port=8443&tls=true&nick=${NICK}&join=%23seance`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A second user mentions the page's nick, naming the joined channel and one it
// is not in.
function mention(text) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(IRCD, ["text.ircv3.net"]);

		ws.onopen = () => {
			ws.send(`NICK ${NICK}b`);
			ws.send("USER a 0 * :a");
		};

		ws.onerror = () => reject(new Error("second user's connection failed"));

		ws.onmessage = (event) => {
			const line = String(event.data);

			if (line.startsWith("PING")) {
				ws.send(line.replace("PING", "PONG"));
			}

			if (/ 001 /.test(line)) {
				ws.send(`JOIN ${CHANNEL}`);
				setTimeout(() => {
					ws.send(`PRIVMSG ${CHANNEL} :${text}`);
					setTimeout(() => {
						ws.close();
						resolve();
					}, 500);
				}, 2500);
			}
		};
	});
}

async function openMentions(page) {
	if (await page.evaluate(`!!document.querySelector("#mentions-popup-container")`)) {
		return;
	}

	const key = {key: "m", code: "KeyM", modifiers: 1, windowsVirtualKeyCode: 77};
	await page.send("Input.dispatchKeyEvent", {type: "rawKeyDown", ...key});
	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...key});
	await page.sleep(600);
}

const menuLabels = (page) =>
	page.evaluate(`[...document.querySelectorAll("#context-menu [role^=menuitem]")]
		.map((e) => e.textContent.trim())`);

async function closeMenu(page) {
	await page.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
	});
	await page.sleep(300);
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`localStorage.setItem("thelounge.mentions", JSON.stringify([{
		network: "00000000-0000-4000-8000-000000000000",
		target: "#gone",
		time: "2020-01-01T00:00:00.000Z",
		type: "message",
		text: "${NICK}: see #gone",
		from: {nick: "ghost"},
	}]))`);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form button[type=submit]").click()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 20000,
		what: "joined",
	});
	await page.sleep(800);
	// Not page.click: the middle of the lobby's row is its toolbar.
	await page.evaluate(`document.querySelector('.channel-list-item[data-type="lobby"]').click()`);
	await page.sleep(400);
	await mention(`${NICK}: see ${CHANNEL} and #menus-elsewhere`);
	await sleep(1500);

	await page.evaluate(`location.hash = "#/connect"`);
	await page.sleep(500);
	await openMentions(page);

	const inline = "#mentions-popup-container .inline-channel";

	// Real mouse events: el.click() would not notice something on top.
	await page.click(inline, 0);
	await page.sleep(300);
	let labels = await menuLabels(page);
	page.check(`a joined channel offers Go to channel (${labels})`, labels[0] === "Go to channel");
	await closeMenu(page);

	await openMentions(page);
	await page.click(inline, 1);
	await page.sleep(300);
	labels = await menuLabels(page);
	page.check(`another channel offers Join channel (${labels})`, labels[0] === "Join channel");
	await page.click("#context-menu .context-menu-join");
	await page.waitFor(
		`document.querySelector('.channel-list-item[data-name="#menus-elsewhere"]')`,
		{
			timeout: 8000,
			what: "Join channel joined it, with no channel active",
		}
	);
	page.check("Join channel works with no channel active", true);

	// The join may have switched the page: back to one with no active channel.
	await page.evaluate(`location.hash = "#/connect"`);
	await page.sleep(500);
	await openMentions(page);
	await page.click("#mentions-popup-container .from .user");
	await page.sleep(300);
	labels = await menuLabels(page);
	page.check(`the sender gets a user menu (${labels})`, labels.includes("User information"));
	await page.screenshot("sender-menu");
	await closeMenu(page);

	// The stored entry for a network no longer on the page, with a chat open: no
	// menu, which could only be the active network's.
	await page.evaluate(
		`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]').click()`
	);
	await page.sleep(500);
	await openMentions(page);

	// By any input: nothing in it to click, tab to or activate.
	const ghost = await page.evaluate(`(() => {
		const row = [...document.querySelectorAll("#mentions-popup-container .mentions-entry")]
			.find((e) => e.textContent.includes("ghost"));
		return row && {
			text: row.querySelector(".content").textContent.trim(),
			active: row.querySelectorAll(".inline-channel, .from [role=button], .content [role=button], [tabindex]").length,
		};
	})()`);
	page.check(
		`the gone network's row is shown (${ghost?.text})`,
		ghost?.text === `${NICK}: see #gone`
	);
	page.check("...with no nick or channel to activate", ghost?.active === 0);

	const errors = page.consoleErrors.map((e) => `${e.type}: ${e.text}`);
	page.check(
		`no console errors${errors.length ? ` (${errors.join(" | ")})` : ""}`,
		errors.length === 0
	);
}
