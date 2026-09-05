// The connecting indicator in the chat header, in a real browser.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/connecting-indicator.mjs
//
// Dialling used to paint the full-width red `#user-visible-error` bar across
// the bottom of the chat. It is now a small spinning icon in the top right
// of the header, driven by `network.status.connecting`, and the red bar is
// left for actual errors. `yarn test` mounts no component, so the claims
// worth checking here are: the icon is there while dialling, it really
// turns, no red bar comes with it, and it goes away once registered.

import net from "node:net";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

// `SEANCE_URL` overrides where the built tree is being served from.
const HOST = process.env.SEANCE_URL ?? "http://localhost:8000";
const CHANNEL = "#seance";
const SILENT_PORT = 9873;

// A socket that accepts and then says nothing: the WebSocket handshake never
// completes, so the client sits in `connecting` for as long as we need it to.
// An unreachable address would do too, but it ends in a transport error and
// this scenario is about the dialling state, not the failure.
const silent = net.createServer(() => {});

export const url = `${HOST}/?host=localhost&port=${SILENT_PORT}&tls=false&nick=spinwatch&join=%23seance`;

const SPINNER = `document.querySelector("#chat .header .connecting-indicator")`;
const BANNER = "#user-visible-error";

/** Sample the icon's rendered transform across ~700 ms. */
const SAMPLE_SPIN = `(async () => {
	const el = ${SPINNER};
	if (!el) return null;
	const seen = [];
	for (let i = 0; i < 8; i++) {
		seen.push(getComputedStyle(el).transform);
		await new Promise((r) => setTimeout(r, 90));
	}
	return seen;
})()`;

export default async function run(page) {
	silent.listen(SILENT_PORT, "127.0.0.1");

	try {
		await check(page);
	} finally {
		silent.close();
	}
}

async function check(page) {
	// 1. Dialling somewhere that never answers.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector("#chat .header")`, {
		timeout: 15000,
		label: "the lobby to open",
	});

	await page.waitFor(`!!${SPINNER}`, {timeout: 10000, label: "the header spinner"});
	await page.check("the header shows a connecting icon", await page.evaluate(`!!${SPINNER}`));
	await page.check("no red error bar comes with it", (await page.count(BANNER)) === 0);
	await page.check(
		"it is in the header's right-hand group, before the mentions button",
		await page.evaluate(
			`(() => {
				// The icon is mid-rotation, so its own bounding box is the
				// rotated one; the wrapper is what actually takes up room.
				const spinner = document.querySelector("#chat .header .connecting-tooltip").getBoundingClientRect();
				const mentions = document.querySelector("#chat .header button.mentions").getBoundingClientRect();
				const title = document.querySelector("#chat .header .title").getBoundingClientRect();
				return spinner.left > title.right && spinner.right <= mentions.left + 1;
			})()`
		)
	);
	await page.check(
		"it says what it is doing",
		String(
			await page.evaluate(
				`document.querySelector("#chat .header .connecting-tooltip").dataset.tooltip`
			)
		).startsWith("Connecting")
	);

	const spins = (await page.evaluate(SAMPLE_SPIN)) ?? [];
	await page.check(
		`the icon actually turns (${new Set(spins).size} distinct of ${spins.length})`,
		new Set(spins).size > 2
	);
	await page.screenshot("1-connecting", {selector: "#chat .header"});

	// 2. A network that answers: the icon must not be left behind.
	await page.evaluate(`localStorage.removeItem("thelounge.networks")`);
	const nick = `spinwatch${Math.floor(Math.random() * 1000)}`;
	await page.goto(`${HOST}/?host=localhost&port=8443&tls=true&nick=${nick}&join=%23seance`, {
		waitForSelector: "#connect form",
	});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.sleep(500);

	await page.check("the icon is gone once registered", !(await page.evaluate(`!!${SPINNER}`)));
	await page.check("still no red error bar", (await page.count(BANNER)) === 0);
	await page.screenshot("2-connected", {selector: "#chat .header"});

	page.check("no console errors", page.consoleErrors.length === 0);
}
