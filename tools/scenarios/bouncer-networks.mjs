// soju.im/bouncer-networks in a real browser, against the dev soju.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d          # soju's upstream
//   tools/soju-dev/run.sh -d               # ws://127.0.0.1:8090, seance/seance
//   node tools/browser-drive.mjs tools/scenarios/bouncer-networks.mjs
//
// A saved network pointing at soju is the bouncer connection; each network
// soju lists becomes a sidebar network of its own, bound with BOUNCER BIND.
// The checks: soju's existing network appears and registers bound, the
// server button opens the panel, add / rename / delete there reach soju and
// the sidebar follows, and a reload brings the network back on the same
// uuid. The scenario resets soju to one network ("SeanceDev", the dev
// nefarious2) before it starts.

const HOST = process.env.SEANCE_URL ?? "http://localhost:8000";
const SOJU = process.env.SEANCE_SOJU_URL ?? "ws://127.0.0.1:8090/";
const ROOT = "11111111-5050-4050-8050-000000000001";

export const url = `${HOST}/`;

const SAVED_ROOT = {
	uuid: ROOT,
	name: "soju",
	host: "127.0.0.1",
	port: 8090,
	tls: false,
	nick: "seance",
	join: "",
	sasl: "plain",
	saslAccount: "seance",
	saslPassword: "seance",
	rememberPassword: true,
	autoconnect: true,
};

/** Log in to soju outside the browser, run `fn(send, lines)` once registered. */
function soju(fn) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(SOJU, ["text.ircv3.net"]);
		const lines = [];
		const send = (l) => ws.send(l);
		const timer = setTimeout(() => reject(new Error("soju setup timed out")), 10000);

		ws.onopen = () => {
			send("CAP LS 302");
			send("NICK setup");
			send("USER setup 0 * :setup");
		};
		ws.onmessage = async (ev) => {
			const line = typeof ev.data === "string" ? ev.data : await ev.data.text();
			lines.push(line);
			if (/ CAP \* LS /.test(line)) send("CAP REQ :sasl batch soju.im/bouncer-networks");
			if (/ CAP \* ACK /.test(line)) send("AUTHENTICATE PLAIN");
			if (line === "AUTHENTICATE +")
				send(`AUTHENTICATE ${Buffer.from("seance\0seance\0seance").toString("base64")}`);
			if (/ 903 /.test(line)) send("CAP END");
			if (/ 422 | 376 /.test(line)) {
				await fn(send, lines);
				clearTimeout(timer);
				ws.close();
				resolve(lines);
			}
		};
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** soju holds exactly one network, SeanceDev → the dev nefarious2. */
async function resetSoju() {
	await soju(async (send, lines) => {
		send("BOUNCER LISTNETWORKS");
		await sleep(500);

		for (const line of lines) {
			const m = line.match(/BOUNCER NETWORK (\S+) /);
			if (m) send(`BOUNCER DELNETWORK ${m[1]}`);
		}

		send("BOUNCER ADDNETWORK name=SeanceDev;host=127.0.0.1;port=6667;tls=0");
		await sleep(1500);
	});
}

const LOBBY = (name) =>
	`[...document.querySelectorAll(".channel-list-item[data-type='lobby']")].find((el) => el.querySelector(".name")?.textContent.trim() === ${JSON.stringify(
		name
	)})`;
const CONNECTED = (name) => `${LOBBY(name)}?.querySelector(".connection-status-icon.is-connected")`;

export default async function run(page) {
	await resetSoju();

	await page.goto(page.url);
	await page.evaluate(
		`localStorage.setItem("thelounge.networks", JSON.stringify([${JSON.stringify(
			SAVED_ROOT
		)}]))`
	);
	await page.goto(page.url);

	// 1. The bouncer connection lists SeanceDev, which comes up bound.
	await page.waitFor(CONNECTED("soju"), {label: "the bouncer connection", timeout: 20000});
	await page.waitFor(CONNECTED("SeanceDev"), {label: "SeanceDev registered", timeout: 20000});
	const sent = page.wsFrames.filter((f) => f.dir === "out").map((f) => f.payloadData);
	page.check(
		"SeanceDev binds before CAP END",
		sent.some((l) => /^BOUNCER BIND \S+$/.test(l))
	);
	page.check(
		"only the bouncer connection has the server button",
		(await page.evaluate(`!!${LOBBY("soju")}.querySelector(".bouncer-panel")`)) &&
			(await page.evaluate(`!${LOBBY("SeanceDev")}.querySelector(".bouncer-panel")`))
	);
	const devUuid = await page.evaluate(
		`JSON.parse(localStorage.getItem("thelounge.networks")).find((n) => n.name === "SeanceDev")?.uuid`
	);
	page.check("SeanceDev is saved, linked to the bouncer", !!devUuid);
	page.check(
		"its saved entry holds no password",
		await page.evaluate(
			`JSON.parse(localStorage.getItem("thelounge.networks")).find((n) => n.uuid === "${devUuid}").saslPassword === ""`
		)
	);
	await page.screenshot("1-sidebar");

	// 2. The panel lists it.
	await page.click(".channel-list-item[data-type='lobby'] .bouncer-panel");
	await page.waitFor(`document.querySelector("#bouncer .bouncer-row")`, {label: "the panel"});
	page.check(
		"the panel lists SeanceDev",
		await page.evaluate(
			`[...document.querySelectorAll("#bouncer .bouncer-name strong")].map((e) => e.textContent).join() === "SeanceDev"`
		)
	);
	await page.screenshot("2-panel");

	// 3. Add one.
	await page.click("#bouncer .settings-modal-body > .container > .btn");
	await page.fill("#bouncer\\:name", "Second");
	await page.fill("#bouncer\\:host", "127.0.0.1");
	await page.fill("#bouncer\\:port", "6667");
	await page.click("#bouncer\\:tls");
	await page.screenshot("3-add-form");
	await page.click("#bouncer .bouncer-form button[type=submit]");
	await page.waitFor(
		`[...document.querySelectorAll("#bouncer .bouncer-name strong")].some((e) => e.textContent === "Second")`,
		{label: "Second in the panel"}
	);
	page.check("the form closed", (await page.count("#bouncer .bouncer-form")) === 0);

	// 4. Rename it.
	await page.click("#bouncer .bouncer-row .btn", 2); // the second row's Edit
	await page.fill("#bouncer\\:name", "Renamed");
	await page.click("#bouncer .bouncer-form button[type=submit]");
	await page.waitFor(
		`[...document.querySelectorAll("#bouncer .bouncer-name strong")].some((e) => e.textContent === "Renamed")`,
		{label: "the rename in the panel"}
	);

	// 5. A refusal is shown in soju's words.
	await page.click("#bouncer .bouncer-row .btn", 2);
	await page.fill("#bouncer\\:port", "notaport");
	await page.click("#bouncer .bouncer-form button[type=submit]");
	await page.waitFor(`document.querySelector("#bouncer .bouncer-form .bouncer-error")`, {
		label: "soju's refusal",
	});
	await page.screenshot("5-refused");
	await page.click("#bouncer .bouncer-form button[type=button]");

	await page.click("#bouncer .settings-modal-done");
	await page.waitFor(CONNECTED("Renamed"), {label: "Renamed registered", timeout: 20000});
	await page.screenshot("4-two-networks");

	// 6. Delete it: gone from the sidebar and the saved list.
	await page.click(".channel-list-item[data-type='lobby'] .bouncer-panel");
	await page.waitFor(`document.querySelector("#bouncer .bouncer-row")`, {label: "the panel"});
	await page.click("#bouncer .bouncer-row .btn", 3); // Delete…
	await page.click("#bouncer .bouncer-row .btn", 2); // Delete (confirm)
	await page.waitFor(`document.querySelectorAll("#bouncer .bouncer-row").length === 1`, {
		label: "the row gone",
	});
	await page.click("#bouncer .settings-modal-done");
	await page.waitFor(`!${LOBBY("Renamed")}`, {label: "Renamed gone from the sidebar"});
	page.check(
		"and from the saved networks",
		await page.evaluate(
			`!JSON.parse(localStorage.getItem("thelounge.networks")).some((n) => n.name === "Renamed")`
		)
	);

	// 7. A reload brings SeanceDev back on the same uuid.
	await page.goto(page.url);
	await page.waitFor(CONNECTED("SeanceDev"), {label: "SeanceDev after a reload", timeout: 20000});
	page.check(
		"same uuid after a reload",
		(await page.evaluate(
			`JSON.parse(localStorage.getItem("thelounge.networks")).filter((n) => n.name === "SeanceDev").map((n) => n.uuid).join()`
		)) === devUuid
	);

	page.check("no console errors", page.consoleErrors.length === 0);
}
