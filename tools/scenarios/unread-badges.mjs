// The sidebar badges follow the IRC layer's counters (IrcClient.pushMessage,
// handlers/markread.ts readNow): two lines in a channel nobody has open count
// 2, opening it clears the badge and leaves the new-messages line above the
// first of them, a trip to Settings does not bring the line back over what
// was read, the next line counts 1, a private conversation read here stays
// read across a reload (its read point in the query log) and one left unread
// is still 1 after it.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/unread-badges.mjs
//
// `SEANCE_IRC_URL` points it at another ircd (default ws://127.0.0.1:8067/),
// `SEANCE_PORT` at another static server.

const IRCD = process.env.SEANCE_IRC_URL ?? "ws://127.0.0.1:8067/";
const PORT = process.env.SEANCE_PORT ?? "8000";
const RUN = Date.now().toString(36).slice(-5);
const NICK = `unread${RUN}`;
const TALKER = `utalk${RUN}`;
const ircd = new URL(IRCD);

export const url =
	`http://localhost:${PORT}/?host=${ircd.hostname}&port=${ircd.port}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=%23seance`;

const item = (name) => `.channel-list-item[data-name="${name}"]`;
const badge = (name) =>
	`(document.querySelector('${item(name)} .badge')?.textContent.trim() || "")`;
const LOBBY = `.channel-list-item[data-type="lobby"] .lobby-title .name`;
const ACTIVE = `(document.querySelector("#chat-container")?.dataset.currentChannel ?? null)`;

function talker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onWelcome = () => {};
	let onJoin = () => {};
	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance unread`);
	};
	ws.onmessage = (ev) => {
		const line = String(ev.data);
		if (line.startsWith("PING")) ws.send(`PONG${line.slice(4)}`);
		else if (line.split(" ")[1] === "001") onWelcome();
		else if (line.split(" ")[1] === "366") onJoin();
	};
	return {
		ready: new Promise((resolve) => (onWelcome = resolve)),
		join: () =>
			new Promise((resolve) => {
				onJoin = resolve;
				ws.send("JOIN #seance");
			}),
		chan: (text) => ws.send(`PRIVMSG #seance :${text}`),
		pm: (text) => ws.send(`PRIVMSG ${NICK} :${text}`),
	};
}

export default async function run(page) {
	const coldLoad = async (waitFor) => {
		await page.evaluate(
			`(() => { window.__coldLoad = true; history.replaceState(null, "", "/"); })()`
		);
		await page.send("Page.reload");
		const started = Date.now();
		for (;;) {
			try {
				if (await page.evaluate(`!window.__coldLoad && !!(${waitFor})`)) return;
			} catch {
				// the document is being replaced
			}
			if (Date.now() - started > 30000) throw new Error(`timed out: ${waitFor}`);
			await page.sleep(150);
		}
	};

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="autoconnect"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector('${item("#seance")}:not(.parted-channel)')`, {
		timeout: 30000,
		label: "#seance joined",
	});

	const bob = talker(TALKER);
	await bob.ready;
	await bob.join();

	// 1. Lines in a channel nobody has open count; opening it zeroes the badge.
	await page.click(LOBBY);
	await page.sleep(500);
	bob.chan("one");
	bob.chan("two");
	await page.waitFor(`${badge("#seance")} === "2"`, {timeout: 10000, label: "#seance badge 2"});
	await page.check("two lines in #seance count 2", true);
	await page.click(item("#seance"));
	await page.sleep(500);
	await page.check(
		`opening #seance clears its badge ("${await page.evaluate(badge("#seance"))}")`,
		(await page.evaluate(badge("#seance"))) === ""
	);
	await page.check(
		"the new-messages line stands above 'one'",
		await page.evaluate(
			`(() => { const m = document.querySelector("#chat .unread-marker"); const n = m?.nextElementSibling; return !!n && n.textContent.includes("one"); })()`
		)
	);
	await page.screenshot("1-opened");

	// 1b. Settings and back: the line does not jump back above what was read.
	await page.click("#footer button.settings");
	await page.sleep(800);
	await page.click(".settings-modal-done");
	await page.waitFor(
		`document.querySelector("#chat-container")?.dataset.currentChannel === "#seance"`,
		{
			timeout: 10000,
			label: "back on #seance",
		}
	);
	await page.sleep(500);
	// router.ts moved the store's line past everything on the way out.
	const marker = await page.evaluate(
		`(() => { const m = document.querySelector("#chat .unread-marker"); return m ? (m.nextElementSibling?.textContent.trim().slice(0, 40) ?? "end") : "none"; })()`
	);
	await page.check(
		`back from Settings, no new-messages line over read lines (${marker})`,
		marker === "none"
	);

	// 2. Away from it again: the next line counts 1, not on top of the old 2.
	await page.click(LOBBY);
	await page.sleep(500);
	bob.chan("three");
	await page.waitFor(`${badge("#seance")} !== ""`, {timeout: 10000, label: "#seance badge"});
	await page.sleep(300);
	const after = await page.evaluate(badge("#seance"));
	await page.check(`one more line counts 1 (${after})`, after === "1");

	// 3. A query read here stays read across a reload.
	bob.pm("private one");
	bob.pm("private two");
	await page.waitFor(`${badge(TALKER)} === "2"`, {timeout: 10000, label: "query badge 2"});
	await page.click(item(TALKER));
	await page.sleep(500);
	await page.check("opening the query clears it", (await page.evaluate(badge(TALKER))) === "");
	await page.click(item("#seance"));
	await page.sleep(1500); // past the log's write throttle
	await coldLoad(`document.querySelector('${item(TALKER)}')`);
	await page.waitFor(`!!document.querySelector('${item("#seance")}:not(.parted-channel)')`, {
		timeout: 30000,
		label: "registered again",
	});
	await page.sleep(2000);
	const q = await page.evaluate(badge(TALKER));
	await page.check(`the query read here is not unread after the reload ("${q}")`, q === "");
	await page.check(`landed on #seance (${await page.evaluate(ACTIVE)})`, true);
	await page.screenshot("2-after-reload");

	// 4. Unread across the reload stays unread, once.
	await page.click(LOBBY);
	await page.sleep(500);
	bob.pm("private three");
	await page.waitFor(`${badge(TALKER)} === "1"`, {timeout: 10000, label: "query badge 1"});
	await page.sleep(1500);
	await coldLoad(`document.querySelector('${item(TALKER)}')`);
	await page.waitFor(`!!document.querySelector('${item("#seance")}:not(.parted-channel)')`, {
		timeout: 30000,
		label: "registered again",
	});
	await page.sleep(2000);
	const q2 = await page.evaluate(badge(TALKER));
	await page.check(`an unread private line is still 1 after the reload ("${q2}")`, q2 === "1");
	await page.screenshot("3-unread-kept");
}
