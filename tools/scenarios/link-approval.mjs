// A web+irc:// link must not connect to a server the user never approved.
//
//   corepack yarn build && python3 -m http.server -d public 8020 &
//   tools/nefarious-dev/run.sh -d
//   SEANCE_PORT=8020 node tools/browser-drive.mjs tools/scenarios/link-approval.mjs
//
// Claims under test (docs/projects/irc-link-new-server-dialog.md):
//  1. a link to an unknown server opens the connect form pre-filled, with a
//     banner naming what the link asked for — no WebSocket is dialed and
//     nothing is saved;
//  2. approving the form connects, joins the linked channel and saves the
//     network;
//  3. the same link opened again now matches the saved network and connects
//     by itself — no form, no second approval.

const PORT = process.env.SEANCE_PORT ?? "8000";
const LINK = "web+irc://localhost:8443/#seance";

export const url = `http://localhost:${PORT}/?uri=${encodeURIComponent(LINK)}`;

export default async function run(page) {
	// 1. Unknown server: the form, the banner, no socket, nothing saved.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.waitFor(`document.querySelector(".connect-link-notice")`, {label: "link banner"});

	const banner = await page.evaluate(
		`document.querySelector(".connect-link-notice").textContent`
	);
	page.check("banner names the server", banner.includes("localhost:8443"));
	page.check("banner names the channel", banner.includes("#seance"));

	const field = (id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).value`);
	page.check("host pre-filled", (await field("connect:host")) === "localhost");
	page.check("port pre-filled", (await field("connect:port")) === "8443");
	page.check("channel pre-filled", (await field("connect:channels")) === "#seance");
	page.check("no socket before approval", page.wsFrames.length === 0);
	page.check(
		"nothing saved before approval",
		(await page.evaluate(`localStorage.getItem("thelounge.networks")`)) === null
	);
	await page.screenshot("link-suggested");

	// 2. Approve: name yourself, click Connect, land in the linked channel.
	await page.fill("#connect\\:nick", "linkapprove");
	await page.click("#connect button[type=submit]");
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		label: "joined #seance after approval",
	});
	// The row is no proof of a dial: an autojoin channel is listed as a
	// placeholder before the socket opens. Wait for the socket itself.
	for (let waited = 0; page.wsFrames.length === 0 && waited < 5000; waited += 100) {
		await page.sleep(100);
	}

	page.check("socket opened after approval", page.wsFrames.length > 0);
	page.check(
		"network saved after approval",
		String(await page.evaluate(`localStorage.getItem("thelounge.networks")`)).includes(
			'"localhost"'
		)
	);
	await page.screenshot("link-approved");

	// 3. The same link again: saved match, connects without the form.
	await page.goto(page.url, {waitForSelector: "#viewport"});
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		label: "auto-connected to the saved network",
	});
	page.check("no approval form the second time", (await page.count("#connect form")) === 0);
	await page.screenshot("link-saved-reconnect");

	page.check("no console errors", page.consoleErrors.length === 0);
}
