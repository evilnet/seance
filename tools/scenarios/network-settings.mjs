// Saved networks live under Settings → Networks. Opening management UI must
// not connect; add, edit and delete are explicit actions.
//
//   pnpm build && python3 -m http.server -d public 8020 &
//   SEANCE_PORT=8020 node tools/browser-drive.mjs tools/scenarios/network-settings.mjs

const PORT = process.env.SEANCE_PORT ?? "8000";
const BASE = `http://localhost:${PORT}/`;
const SETTINGS = `${BASE}#/settings/networks`;

export const url = BASE;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`localStorage.setItem("thelounge.networks", JSON.stringify([{
		uuid: "managed-network",
		name: "Managed network",
		host: "irc.example.org",
		port: 8443,
		tls: true,
		nick: "networktester",
		join: "#example",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		autoconnect: false
	}]))`);

	await page.goto(SETTINGS, {waitForSelector: ".network-settings-item"});
	page.check("sidebar add button removed", (await page.count("#footer .connect")) === 0);
	page.check("saved network listed", (await page.count(".network-settings-item")) === 1);
	page.check("management does not connect", page.wsFrames.length === 0);
	await page.screenshot("network-settings");

	await page.click('.network-settings-actions a[href="#/settings/networks/managed-network"]');
	await page.waitFor(`document.querySelector("#connect.network-form-embedded")`, {
		label: "embedded network editor",
	});
	page.check(
		"editor loads saved host",
		(await page.evaluate(`document.getElementById("connect:host").value`)) === "irc.example.org"
	);
	page.check("editing does not connect", page.wsFrames.length === 0);
	await page.screenshot("network-settings-edit");

	await page.click(".network-settings-back");
	await page.waitFor(`document.querySelector(".network-settings-item")`, {
		label: "return to networks",
	});
	await page.click(".network-settings-actions .btn-danger");
	await page.waitFor(`document.querySelector("#confirm-dialog .btn-danger")`, {
		label: "delete confirmation",
	});
	await page.click("#confirm-dialog .btn-danger");
	page.check("network deleted", (await page.count(".network-settings-item")) === 0);
	page.check(
		"saved entry deleted",
		(await page.evaluate(`JSON.parse(localStorage.getItem("thelounge.networks")).length`)) === 0
	);
	page.check("no console errors", page.consoleErrors.length === 0);
}
