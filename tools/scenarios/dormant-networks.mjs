// Saved networks this page has not connected stay in the sidebar, greyed
// under the live ones, and one tap connects them
// (docs/resources/client-features.md § Saved networks in the sidebar).
//
//   pnpm build && python3 -m http.server -d public 8020 &
//   SEANCE_PORT=8020 node tools/browser-drive.mjs tools/scenarios/dormant-networks.mjs
//   … --mobile --width=390 --height=844
//
// No ircd needed: lib/tiny-ircd.mjs registers the connections.
//
// Claims:
//   1. after a reload the autoconnect network is live and the other two
//      saved networks show as greyed rows below it, nothing dialled for them;
//   2. a tap on one connects it: its live row takes the greyed row's place;
//   3. a tap on one whose password was not kept opens the connect form
//      filled from it, asking for the password, and dials nothing;
//   4. /quit on a live network puts it back as a greyed row;
//   5. with nothing live, the greyed rows replace the "not connected" text;
//   6. no console errors.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const BASE = `http://localhost:${PORT}/`;
const IRCD_PORT = 9871;

export const url = BASE;

const net = (uuid, name, extra) => ({
	uuid,
	name,
	host: "127.0.0.1",
	port: IRCD_PORT,
	tls: false,
	nick: uuid.slice(0, 6),
	join: "#tiny",
	sasl: "",
	saslAccount: "",
	saslPassword: "",
	autoconnect: false,
	...extra,
});

const NETWORKS = [
	net("auto00-0000", "Auto network", {autoconnect: true}),
	net("libera-0000", "Libera over TCP"),
	net("locked-0000", "Needs a password", {sasl: "plain", saslAccount: "bob"}),
];

const dormant = (uuid) => `#saved-network-${uuid}`;
const live = (uuid) => `#network-${uuid}`;
const exists = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`;

async function openSidebar(page) {
	// The phone layout keeps the sidebar off-canvas.
	if (
		(await page.evaluate(`window.innerWidth <= 768`)) &&
		!(await page.evaluate(`!!document.querySelector("#viewport.menu-open")`))
	) {
		// Past the drawer's own closing slide, which a tap would land in.
		await page.sleep(500);
		await page.click("#viewport .lt");
		await page.waitFor(`document.querySelector("#viewport.menu-open")`, {label: "drawer open"});
		await page.sleep(500);
	}
}

export default async function run(page) {
	const ircd = startTinyIrcd({port: IRCD_PORT});

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(
			`localStorage.setItem("thelounge.networks", ${JSON.stringify(
				JSON.stringify(NETWORKS)
			)})`
		);
		await page.goto(page.url, {waitForSelector: live("auto00-0000")});
		await page.waitFor(exists(`${live("auto00-0000")}:not(:has(.not-connected))`), {
			label: "autoconnect network registered",
		});
		await openSidebar(page);

		// 1
		page.check(
			"two greyed rows",
			(await page.count("#sidebar .dormant-network")) === 2 &&
				(await page.count(dormant("libera-0000"))) === 1 &&
				(await page.count(dormant("locked-0000"))) === 1
		);
		page.check(
			"greyed rows come after the live one",
			await page.evaluate(
				`(() => {
					const rows = [...document.querySelectorAll("#sidebar .network")].map((el) => el.id);
					return rows.indexOf("network-auto00-0000") < rows.indexOf("saved-network-libera-0000");
				})()`
			)
		);
		page.check(
			"greyed row is faded",
			(await page.evaluate(
				`Number(getComputedStyle(document.querySelector("${dormant(
					"libera-0000"
				)} .channel-list-item")).opacity)`
			)) < 0.7
		);
		page.check(
			"password row says so",
			/password/i.test(
				await page.evaluate(
					`document.querySelector("${dormant(
						"locked-0000"
					)} .dormant-network-state").textContent`
				)
			)
		);
		await page.screenshot("dormant-rows");

		// 2
		await page.click(`${dormant("libera-0000")} .dormant-network-connect`);
		await page.waitFor(exists(live("libera-0000")), {label: "live row appears"});
		await page.waitFor(exists(`${live("libera-0000")}:not(:has(.not-connected))`), {
			label: "tapped network registered",
		});
		page.check("greyed row gone", (await page.count(dormant("libera-0000"))) === 0);
		page.check(
			"live row named from the entry",
			/Libera over TCP/.test(
				await page.evaluate(
					`document.querySelector("${live(
						"libera-0000"
					)} .lobby-title .name").textContent`
				)
			)
		);
		await openSidebar(page);
		await page.screenshot("dormant-connected");

		// 4
		await page.evaluate(
			`(() => {
				const lobby = document.querySelector("${live(
					"libera-0000"
				)} .channel-list-item[data-type='lobby']");
				lobby.click();
			})()`
		);
		await page.waitFor(`document.querySelector("#input")`, {label: "composer"});
		await page.evaluate(
			`(() => {
				const input = document.querySelector("#input");
				input.value = "/quit";
				input.dispatchEvent(new Event("input"));
				document.querySelector("#form").requestSubmit();
			})()`
		);
		await page.waitFor(exists(dormant("libera-0000")), {label: "quit network greyed again"});
		page.check("quit network has no live row", (await page.count(live("libera-0000"))) === 0);

		// 3
		await openSidebar(page);
		await page.click(`${dormant("locked-0000")} .dormant-network-connect`);
		await page.waitFor(`location.hash.startsWith("#/connect")`, {label: "connect form"});
		await page.waitFor(exists("#connect form"), {label: "connect form rendered"});
		page.check(
			"form filled from the entry",
			(await page.evaluate(`document.getElementById("connect:host").value`)) === "127.0.0.1"
		);
		page.check(
			"form asks for the password",
			(await page.count("#connect\\:saslPassword")) === 1
		);
		page.check("password network not dialled", (await page.count(live("locked-0000"))) === 0);
		await page.screenshot("dormant-password-form");

		// 5
		await page.evaluate(
			`localStorage.setItem("thelounge.networks", ${JSON.stringify(
				JSON.stringify(NETWORKS.map((n) => ({...n, autoconnect: false})))
			)})`
		);
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await openSidebar(page);
		await page.waitFor(exists("#sidebar .dormant-network"), {label: "greyed rows alone"});
		page.check("no empty text", (await page.count("#sidebar .empty")) === 0);
		page.check("three greyed rows", (await page.count("#sidebar .dormant-network")) === 3);
		page.check(
			"nothing live",
			(await page.count("#sidebar .network:not(.dormant-network)")) === 0
		);
		await page.screenshot("dormant-alone");

		page.check("no console errors", page.consoleErrors.length === 0);
	} finally {
		await ircd.close();
	}
}
