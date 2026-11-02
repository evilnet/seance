// A private conversation survives a reload: the query window comes back in
// the sidebar with its lines (irc/querylog.ts), once each, and closing it
// forgets it for the next reload.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/query-log.mjs
//
// `SEANCE_IRC_URL` points it at another ircd (default ws://127.0.0.1:8067/),
// `SEANCE_PORT` at another static server. One browser profile throughout:
// localStorage surviving the reload is the point.

const IRCD = process.env.SEANCE_IRC_URL ?? "ws://127.0.0.1:8067/";
const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);
const NICK = `qlog${RUN}`;
const TALKER = `qtalk${RUN}`;

const ircd = new URL(IRCD);

if (ircd.hostname === "localhost" || ircd.hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export const url =
	`http://localhost:${PORT}/?host=${ircd.hostname}&port=${ircd.port}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=%23seance`;

const item = (name) => `.channel-list-item[data-name="${name}"]`;
/** Name of the conversation the chat window shows, or null. */
const ACTIVE = `(document.querySelector("#chat-container")?.dataset.currentChannel ?? null)`;
/** Texts of the rows the open conversation shows. */
const TEXTS = `JSON.stringify(Array.from(document.querySelectorAll("#chat .msg .content")).map((c) => c.textContent.trim()))`;

/** A second user who talks to the page in private. */
function talker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onWelcome = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance query log`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
		} else if (line.split(" ")[1] === "001") {
			onWelcome();
		}
	};

	return {
		ready: new Promise((resolve, reject) => {
			onWelcome = resolve;
			setTimeout(() => reject(new Error(`${nick} never registered`)), 20000);
		}),
		say: (text) => ws.send(`PRIVMSG ${NICK} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

export default async function run(page) {
	// F5: see reload-on-settings.mjs for why it is replaceState + Page.reload.
	const coldLoad = async (waitFor) => {
		await page.evaluate(
			`(() => { window.__coldLoad = true; history.replaceState(null, "", "/"); })()`
		);
		await page.send("Page.reload");
		const started = Date.now();

		for (;;) {
			try {
				if (await page.evaluate(`!window.__coldLoad && !!(${waitFor})`)) {
					return;
				}
			} catch {
				// the document is being replaced
			}

			if (Date.now() - started > 30000) {
				throw new Error(`timed out waiting for ${waitFor} after the reload`);
			}

			await page.sleep(150);
		}
	};

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="autoconnect"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`document.querySelector('${item("#seance")}')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});

	const bob = talker(TALKER);
	await bob.ready;
	bob.say("first private line");
	bob.say("second private line");

	await page.waitFor(`document.querySelector('${item(TALKER)}')`, {
		timeout: 20000,
		label: "the query window",
	});
	await page.click(item(TALKER));
	await page.waitFor(`${TEXTS}.includes("second private line")`, {
		timeout: 10000,
		label: "both lines in the query",
	});
	await page.sleep(1500); // past the log's write throttle
	await page.check(
		"the conversation is in localStorage",
		await page.evaluate(
			`Object.keys(localStorage).some((k) => k.startsWith("thelounge.querylog.") && localStorage.getItem(k).includes("second private line"))`
		)
	);
	await page.screenshot("1-before-reload");

	// 1. Reload: the window is back before the server says anything, and so
	//    are its lines, once each.
	await coldLoad(`document.querySelector('${item(TALKER)}')`);
	await page.check("the query window is back after the reload", true);
	// It was the conversation on screen: the page lands on it by itself,
	// and registration (`init`) does not move the view off it.
	await page.sleep(300);
	const landed = await page.evaluate(ACTIVE);
	await page.check(`the reload lands on the restored query (${landed})`, landed === TALKER);
	await page.waitFor(`!!document.querySelector('${item("#seance")}:not(.parted-channel)')`, {
		timeout: 20000,
		label: "registered and rejoined",
	});
	await page.sleep(1500);
	const stayed = await page.evaluate(ACTIVE);
	await page.check(`and stays there once registered (${stayed})`, stayed === TALKER);
	await page.click(item(TALKER));
	await page.sleep(500);
	const texts = JSON.parse(await page.evaluate(TEXTS));
	await page.check(
		`its lines are back, once each (${JSON.stringify(texts)})`,
		texts.filter((t) => t === "first private line").length === 1 &&
			texts.filter((t) => t === "second private line").length === 1
	);
	await page.screenshot("2-after-reload");

	// 2. Live lines still land in the restored window, after the old ones.
	bob.say("third private line");
	await page.waitFor(`${TEXTS}.includes("third private line")`, {
		timeout: 10000,
		label: "a live line in the restored query",
	});
	const order = JSON.parse(await page.evaluate(TEXTS)).filter((t) => t.endsWith("private line"));
	await page.check(
		`the live line follows the restored ones (${JSON.stringify(order)})`,
		JSON.stringify(order) ===
			JSON.stringify(["first private line", "second private line", "third private line"])
	);

	// 3. With nothing remembered, a reload lands on the last channel of the
	//    join list, not on the restored query that sorts after it.
	await page.evaluate(`localStorage.removeItem("thelounge.state.lastChannel")`);
	await coldLoad(`document.querySelector('${item(TALKER)}')`);
	await page.sleep(500);
	const fresh = await page.evaluate(ACTIVE);
	await page.check(`no memory: lands on #seance, not the query (${fresh})`, fresh === "#seance");
	await page.click(item(TALKER));
	await page.waitFor(`${TEXTS}.includes("third private line")`, {
		timeout: 10000,
		label: "the query open again",
	});

	// 4. Close it: the next reload does not bring it back.
	await page.fill("#input", "/close");
	await page.click("#submit");
	await page.waitFor(`!document.querySelector('${item(TALKER)}')`, {
		timeout: 10000,
		label: "the query closed",
	});
	await page.sleep(1500);
	await coldLoad(`document.querySelector('${item("#seance")}')`);
	await page.sleep(1500);
	const state = await page.evaluate(
		`JSON.stringify({last: localStorage.getItem("thelounge.state.lastChannel"), logs: Object.keys(localStorage).filter((k) => k.startsWith("thelounge.querylog.")).map((k) => localStorage.getItem(k))})`
	);
	await page.check(
		`a closed query does not come back (${state})`,
		(await page.count(item(TALKER))) === 0
	);

	// 5. Settings → General → "Keep private conversations on this device"
	//    off: what is kept is deleted, nothing more is kept, and a reload
	//    brings no query back.
	const LOGS = `Object.keys(localStorage).filter((k) => k.startsWith("thelounge.querylog.")).length`;
	bob.say("a line before the switch");
	await page.waitFor(`document.querySelector('${item(TALKER)}')`, {
		timeout: 10000,
		label: "the query reopened by a new line",
	});
	await page.sleep(1500);
	await page.check("kept again before the switch", (await page.evaluate(LOGS)) === 1);
	await page.evaluate(`location.hash = "#/settings"`);
	await page.waitFor(`!!document.querySelector('input[name="keepPrivateConversations"]')`, {
		timeout: 10000,
		label: "the setting in Settings",
	});
	await page.check(
		"the setting is on by default",
		await page.evaluate(
			`document.querySelector('input[name="keepPrivateConversations"]').checked`
		)
	);
	await page.click('input[name="keepPrivateConversations"]');
	await page.sleep(300);
	await page.check(
		"switched off, the kept conversations are deleted",
		(await page.evaluate(LOGS)) === 0
	);
	await page.screenshot("3-setting-off", {selector: ".settings-modal, #settings"});
	await page.click(".settings-modal-done");
	bob.say("a line after the switch");
	await page.sleep(2000);
	await page.check("nothing is kept while it is off", (await page.evaluate(LOGS)) === 0);
	await coldLoad(`document.querySelector('${item("#seance")}')`);
	await page.sleep(1500);
	await page.check(
		"with it off, a reload brings no query back",
		(await page.count(item(TALKER))) === 0
	);

	bob.quit();
	await page.check(
		`no console errors (${page.consoleErrors.join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
