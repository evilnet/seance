// Collapsing a network must hide every child channel, including the channel
// currently open. The server lobby remains as the control that expands it.
//
//   pnpm build && python3 -m http.server -d public 8020 &
//   tools/nefarious-dev/run.sh -d
//   SEANCE_PORT=8020 node tools/browser-drive.mjs tools/scenarios/network-collapse.mjs

const PORT = process.env.SEANCE_PORT ?? "8000";
const CHANNEL = "#seance";
const CHANNEL_ROW = `.channel-list-item[data-name="${CHANNEL}"]`;

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=collapsecheck&join=%23seance`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click("#connect button[type=submit]");
	await page.waitFor(`document.querySelector('${CHANNEL_ROW}')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});

	page.check("joined channel starts visible", (await page.count(CHANNEL_ROW)) === 1);
	page.check("joined channel is active", (await page.count(`${CHANNEL_ROW}.active`)) === 1);

	await page.click(".collapse-network");
	await page.waitFor(`!document.querySelector('${CHANNEL_ROW}')`, {
		label: "active channel to be hidden",
	});

	page.check("collapsed network hides its active channel", (await page.count(CHANNEL_ROW)) === 0);
	page.check(
		"collapsed network keeps its lobby visible",
		(await page.count('.channel-list-item[data-type="lobby"]')) === 1
	);
	await page.screenshot("network-collapsed", {selector: "#sidebar"});

	await page.click(".collapse-network");
	await page.waitFor(`document.querySelector('${CHANNEL_ROW}')`, {
		label: "channel to return after expansion",
	});
	page.check("expanding restores the channel", (await page.count(CHANNEL_ROW)) === 1);
	page.check("no console errors", page.consoleErrors.length === 0);
}
