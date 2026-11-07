// A nick on the ignore list gets Unignore in its menu, not Ignore
// (helpers/contextMenu.ts `ignoreItem`, ignore.ts `ignoresNick`).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/unignore-menu.mjs
//
// A second connection joins #seance; the page ignores it with /ignore,
// right-clicks it in the user list and finds "Unignore user" (with its
// icon drawn), clicks it, and the nick's menu says "Ignore user" again.
// `SEANCE_PORT` serves the app from another port.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);
const PEER = `peer${RUN}`;

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=ign${RUN}&join=%23seance`;

function peer() {
	const ws = new WebSocket("ws://127.0.0.1:8067/", "text.ircv3.net");
	ws.addEventListener("message", (e) => {
		for (const l of String(e.data).split("\r\n")) {
			if (l.startsWith("PING")) ws.send(l.replace("PING", "PONG"));
		}
	});
	return new Promise((resolve) =>
		ws.addEventListener("open", () => {
			ws.send(`NICK ${PEER}`);
			ws.send("USER p 0 * :p");
			setTimeout(() => {
				ws.send("JOIN #seance");
				resolve(ws);
			}, 1000);
		})
	);
}

const MENU = `Array.from(document.querySelectorAll("#context-menu .context-menu-item")).map((li) => li.textContent.trim())`;

async function openMenu(page) {
	await page.evaluate(`document.querySelector("#context-menu-container")?.click()`);
	await page.sleep(200);
	await page.evaluate(`(() => {
		const el = document.querySelector('.userlist .user[data-name="${PEER}"]');
		const r = el.getBoundingClientRect();
		el.dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5}));
	})()`);
	await page.waitFor(`document.querySelector("#context-menu")`, {label: "the nick's menu"});
	await page.sleep(200);
	return page.evaluate(MENU);
}

export default async function run(page) {
	const ws = await peer();

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
			timeout: 30000,
			label: "#seance in the sidebar",
		});
		await page.evaluate(
			`document.querySelector('.channel-list-item[data-name="#seance"]').click()`
		);
		await page.waitFor(`document.querySelector('.userlist .user[data-name="${PEER}"]')`, {
			label: "the peer in the user list",
		});

		let items = await openMenu(page);
		await page.check(
			`before: the menu offers Ignore (${items.join(" | ")})`,
			items.includes("Ignore user") && !items.includes("Unignore user")
		);
		await page.screenshot("0-ignore-menu", {selector: "#context-menu"});
		await page.evaluate(`document.querySelector("#context-menu-container")?.click()`);

		await page.fill("#input", `/ignore ${PEER}`);
		await page.evaluate(`document.querySelector("#form").requestSubmit()`);
		await page.sleep(500);

		items = await openMenu(page);
		await page.check(
			`ignored: the menu offers Unignore (${items.join(" | ")})`,
			items.includes("Unignore user") && !items.includes("Ignore user")
		);
		const glyph = await page.evaluate(`(() => {
			const li = document.querySelector("#context-menu .context-menu-action-unignore");
			const before = getComputedStyle(li, "::before");
			return {content: before.content, font: before.fontFamily, width: li.querySelector("*") ? null : before.width};
		})()`);
		await page.check(
			`its icon is the user-check glyph (${JSON.stringify(glyph)})`,
			glyph.content === '""'
		);
		await page.screenshot("1-unignore-menu", {selector: "#context-menu"});

		await page.click("#context-menu .context-menu-action-unignore");
		await page.sleep(500);
		items = await openMenu(page);
		await page.check(
			`after Unignore: Ignore again (${items.join(" | ")})`,
			items.includes("Ignore user")
		);
		await page.check("no console errors", page.consoleErrors.length === 0);
	} finally {
		ws.close();
	}
}
