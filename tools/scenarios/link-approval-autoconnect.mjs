// An unknown-server link blocks normal startup until the user decides what
// to do; a saved autoconnect network must not navigate over the prompt.
//
//   pnpm build && python3 -m http.server -d public 8020 &
//   tools/nefarious-dev/run.sh -d
//   SEANCE_PORT=8020 node tools/browser-drive.mjs tools/scenarios/link-approval-autoconnect.mjs

const PORT = process.env.SEANCE_PORT ?? "8000";
const BASE = `http://localhost:${PORT}/`;
const LINK = `${BASE}?host=127.0.0.1&port=8443&tls=true&join=%23seance`;

export const url = BASE;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`localStorage.setItem("thelounge.networks", JSON.stringify([{
		uuid: "saved-autoconnect",
		name: "Saved network",
		host: "localhost",
		port: 8443,
		tls: true,
		nick: "savedauto",
		join: "#seance",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		autoconnect: true
	}]))`);

	await page.goto(LINK, {waitForSelector: "#connect.link-approval"});
	await page.sleep(500);
	page.check("link approval remains open", (await page.count("#connect.link-approval")) === 1);
	page.check("saved network is blocked", page.wsFrames.length === 0);

	const banner = await page.evaluate(
		`document.querySelector(".connect-link-notice").textContent`
	);
	page.check("banner names the suggested server", banner.includes("127.0.0.1:8443"));
	await page.screenshot("link-blocks-autoconnect");

	await page.click(".link-approval-buttons .btn-cancel");
	await page.waitFor(`window.location.hash.startsWith("#/chan-")`, {
		label: "normal startup after declining",
	});
	page.check("saved network starts after declining", page.wsFrames.length > 0);
	page.check("approval dialog closed", (await page.count("#connect.link-approval")) === 0);
	page.check("no console errors", page.consoleErrors.length === 0);
}
