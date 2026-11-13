// soju.im/bouncer-networks in a real browser, against the dev soju.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d          # soju's upstream
//   tools/soju-dev/run.sh -d               # ws://127.0.0.1:8090, seance/seance
//   node tools/browser-drive.mjs tools/scenarios/bouncer-networks.mjs
//
// A saved network pointing at soju with no network of its own is the
// control connection; each network soju lists is added once as a saved
// network of its own, bound with BOUNCER BIND (irc/bouncer.ts,
// docs/resources/irc-layer.md § soju's networks). The checks: soju's
// existing network is added and registers bound; the server button opens
// the bouncer panel on the control connection only; add / rename there
// reach soju (an added network is added here too), a refusal is shown in
// soju's words; a delete stops the network bound to it without removing
// it; and a reload keeps every entry on its uuid and adds nothing back. The
// scenario resets soju to one network ("SeanceDev", the dev nefarious2)
// before it starts.

const HOST = process.env.SEANCE_URL ?? "http://localhost:8000";
const SOJU = process.env.SEANCE_SOJU_URL ?? "ws://127.0.0.1:8090/";
// Where soju reaches the dev nefarious2: 127.0.0.1 with run.sh's host
// networking; host.docker.internal from a container with published ports.
const UPSTREAM = process.env.SEANCE_SOJU_UPSTREAM ?? "127.0.0.1";
const CONTROL = "11111111-5050-4050-8050-000000000001";

export const url = `${HOST}/`;

const SAVED_CONTROL = {
	uuid: CONTROL,
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

		send(`BOUNCER ADDNETWORK name=SeanceDev;host=${UPSTREAM};port=6667;tls=0`);
		await sleep(1500);
	});
}

// By uuid: a bound network's sidebar name is whatever its upstream's
// ISUPPORT NETWORK says, as for any network.
const LOBBY = (uuid) =>
	`document.querySelector("#network-${uuid} .channel-list-item[data-type='lobby']")`;
const CONNECTED = (uuid) => `${LOBBY(uuid)}?.querySelector(".connection-status-icon.is-connected")`;
const SAVED = `JSON.parse(localStorage.getItem("thelounge.networks"))`;
const PANEL_NAMES = `[...document.querySelectorAll("#bouncer .bouncer-name strong")].map((e) => e.textContent)`;

/**
 * soju offers web push, so each new network may ask (PushPrompt.vue); answer
 * No to whatever asks within `ms`, so the prompt does not cover the page.
 */
async function dismissPush(page, ms = 3000) {
	for (let waited = 0; waited <= ms; waited += 250) {
		if ((await page.count("#push-prompt[data-armed]")) > 0) {
			await page.click("#pushPromptNo");
			waited = 0;
		}

		await page.sleep(250);
	}
}

/** Scroll the form's submit button into view and press it (the form scrolls inside the modal). */
async function submit(page) {
	await page.evaluate(
		`document.querySelector("#bouncer .bouncer-form button[type=submit]").scrollIntoView({block: "center"})`
	);
	await page.click("#bouncer .bouncer-form button[type=submit]");
}

export default async function run(page) {
	await resetSoju();

	await page.goto(page.url);
	await page.evaluate(
		`localStorage.setItem("thelounge.networks", JSON.stringify([${JSON.stringify(
			SAVED_CONTROL
		)}]))`
	);
	await page.goto(page.url);

	// 1. The control connection lists SeanceDev, which is added and comes up bound.
	await page.waitFor(CONNECTED(CONTROL), {label: "the control connection", timeout: 20000});
	await page.waitFor(`${SAVED}.some((n) => n.name === "SeanceDev" && n.bouncerNetId)`, {
		label: "SeanceDev saved as a network of its own",
		timeout: 20000,
	});
	const devUuid = await page.evaluate(
		`${SAVED}.find((n) => n.name === "SeanceDev" && n.bouncerNetId).uuid`
	);
	await page.waitFor(CONNECTED(devUuid), {label: "SeanceDev registered", timeout: 20000});
	const sent = page.wsFrames.filter((f) => f.dir === "out").map((f) => f.payloadData);
	page.check(
		"SeanceDev binds before CAP END",
		sent.some((l) => /^BOUNCER BIND \S+$/.test(l))
	);
	page.check(
		"only the control connection has the server button",
		(await page.evaluate(`!!${LOBBY(CONTROL)}.querySelector(".bouncer-panel")`)) &&
			(await page.evaluate(`!${LOBBY(devUuid)}.querySelector(".bouncer-panel")`))
	);
	await dismissPush(page);
	await page.screenshot("1-sidebar");

	// 2. The panel lists it, with changes offered (soju master has labeled-response).
	await page.click(`#network-${CONTROL} .bouncer-panel`);
	await page.waitFor(`document.querySelector("#bouncer .bouncer-row")`, {label: "the panel"});
	page.check(
		"the panel lists SeanceDev",
		(await page.evaluate(`${PANEL_NAMES}.join()`)) === "SeanceDev"
	);
	await page.screenshot("2-panel");

	// 3. Add one: soju takes it, and it is added here as a network of its own.
	await page.click("#bouncer .settings-modal-body > .container > .btn");
	await page.fill("#bouncer\\:name", "Second");
	await page.fill("#bouncer\\:host", UPSTREAM);
	await page.fill("#bouncer\\:port", "6667");
	await page.click("#bouncer\\:tls");
	await page.screenshot("3-add-form");
	await submit(page);
	await page.waitFor(`${PANEL_NAMES}.includes("Second")`, {label: "Second in the panel"});
	page.check("the form closed", (await page.count("#bouncer .bouncer-form")) === 0);
	await page.waitFor(`${SAVED}.some((n) => n.name === "Second" && n.bouncerNetId)`, {
		label: "Second saved as a bound network",
	});
	const secondUuid = await page.evaluate(`${SAVED}.find((n) => n.name === "Second")?.uuid`);
	await page.waitFor(CONNECTED(secondUuid), {label: "Second registered", timeout: 20000});
	// Its push prompt comes up over the panel; answer it before going on.
	await dismissPush(page);

	// 4. Rename it on soju: the panel follows.
	await page.click("#bouncer .bouncer-row .btn", 2); // the second row's Edit
	await page.fill("#bouncer\\:name", "Renamed");
	await submit(page);
	await page.waitFor(`${PANEL_NAMES}.includes("Renamed")`, {label: "the rename in the panel"});

	// 5. A refusal is shown in soju's words.
	await page.click("#bouncer .bouncer-row .btn", 2);
	await page.fill("#bouncer\\:port", "notaport");
	await submit(page);
	await page.waitFor(`document.querySelector("#bouncer .bouncer-form .bouncer-error")`, {
		label: "soju's refusal",
	});
	await page.screenshot("5-refused");
	await page.click("#bouncer .bouncer-form button[type=button]");

	await page.click("#bouncer .settings-modal-done");
	await page.screenshot("4-two-networks");

	// 6. Delete it on soju: the network bound to it stops connecting by
	// itself, and stays here (with its history) for the user to remove.
	await page.click(`#network-${CONTROL} .bouncer-panel`);
	await page.waitFor(`document.querySelector("#bouncer .bouncer-row")`, {label: "the panel"});
	await page.click("#bouncer .bouncer-row .btn", 3); // Delete…
	await page.click("#bouncer .bouncer-row .btn", 2); // Delete (confirm)
	await page.waitFor(`document.querySelectorAll("#bouncer .bouncer-row").length === 1`, {
		label: "the row gone",
	});
	await page.click("#bouncer .settings-modal-done");
	await page.waitFor(`${SAVED}.find((n) => n.uuid === "${secondUuid}")?.autoconnect === false`, {
		label: "Second stops connecting by itself",
	});
	page.check(
		"Second stays saved",
		await page.evaluate(`${SAVED}.some((n) => n.uuid === "${secondUuid}")`)
	);

	// 7. A reload keeps SeanceDev on its uuid, adds nothing back, and leaves
	// the deleted network off.
	const before = await page.evaluate(`${SAVED}.length`);
	await page.goto(page.url);
	await page.waitFor(CONNECTED(devUuid), {label: "SeanceDev after a reload", timeout: 20000});
	await dismissPush(page);
	await sleep(2000);
	page.check(
		"same uuid after a reload",
		(await page.evaluate(
			`${SAVED}.filter((n) => n.name === "SeanceDev").map((n) => n.uuid).join()`
		)) === devUuid
	);
	page.check(
		"nothing added back by the reload",
		(await page.evaluate(`${SAVED}.length`)) === before
	);
	page.check(
		"the deleted network did not reconnect",
		!(await page.evaluate(`!!${CONNECTED(secondUuid)}`))
	);

	page.check("no console errors", page.consoleErrors.length === 0);
}
