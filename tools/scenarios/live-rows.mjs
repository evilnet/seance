// Live rows (client/js/liveRows.ts, docs/resources/themes.md § Live rows) in a
// real browser: someone else's line arriving in the open channel is drawn with
// `data-live` (`message`, or `mention` when it names us), even while a pending
// copy of our own line sits below it; a line in another channel is not, and
// coming back to a channel draws none of its rows as live again; under reduced
// motion the attribute is still set. style.css animates nothing on it.
//
//   pnpm build && python3 -m http.server -d "$PWD/public" 8000 &
//   node tools/browser-drive.mjs tools/scenarios/live-rows.mjs
//
// No ircd needed: lib/tiny-ircd.mjs, whose socket the scenario writes to.
// `SEANCE_PORT` serves the app from another port.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9878;
const CHANNEL = "#live";
const OTHER = "#elsewhere";
const NICK = "liver";

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	`${CHANNEL},${OTHER}`
)}`;

const ROW = (text) =>
	`[...document.querySelectorAll("#chat .msg")].find((m) => m.textContent.includes(${JSON.stringify(
		text
	)}))`;
const LIVE = (text) => `(${ROW(text)}?.dataset.live ?? null)`;
const ANY_LIVE = `document.querySelectorAll("#chat .msg[data-live]").length`;
const INPUT = `document.querySelector("#input")`;

export default async function run(page) {
	let send = () => {};
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		// echo-message: our own line stays pending until the echo, which never
		// comes here, so it holds the bottom of the list.
		caps: "echo-message",
		onLine(line, ctx) {
			send = ctx.send;

			if (line.startsWith("JOIN ")) {
				for (const chan of [CHANNEL, OTHER]) {
					ctx.send(`:${ctx.nick}!u@tiny JOIN ${chan}`);
					ctx.send(`:tiny.test 353 ${ctx.nick} = ${chan} :${ctx.nick} alice bob`);
					ctx.send(`:tiny.test 366 ${ctx.nick} ${chan} :End of /NAMES list.`);
				}

				return true;
			}

			// Swallow our PRIVMSGs: no echo, so the copy stays pending.
			return line.startsWith("PRIVMSG ");
		},
	});
	const from = (nick) => `:${nick}!u@tiny`;
	const say = (nick, text, chan = CHANNEL) => send(`${from(nick)} PRIVMSG ${chan} :${text}`);
	const shows = (text) => page.waitFor(`!!${ROW(text)}`, {label: text});
	const liveIs = async (text, want, label) => {
		const got = await page.evaluate(LIVE(text));
		page.check(`${label}: data-live ${want} (${got})`, got === want);
	};
	const item = (name) => `document.querySelector('.channel-list-item[data-name="${name}"]')`;

	try {
		await page.send("Emulation.setFocusEmulationEnabled", {enabled: true});
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(item(CHANNEL), {label: CHANNEL});
		await page.evaluate(`${item(CHANNEL)}.click()`);
		await page.waitFor(INPUT, {label: "the channel"});
		await page.sleep(1000);
		page.check("after our own joins: no live row", (await page.evaluate(ANY_LIVE)) === 0);

		say("alice", "hello");
		await shows("hello");
		await liveIs("hello", "message", "a message");

		say("bob", `${NICK}: ping`);
		await shows("ping");
		await liveIs("ping", "mention", "a mention");

		// A pending copy of ours at the bottom: the line that arrives goes in
		// above it and is still marked.
		await page.click("#input");
		await page.send("Input.insertText", {text: "mine, pending"});
		const key = {key: "Enter", code: "Enter", windowsVirtualKeyCode: 13};
		await page.send("Input.dispatchKeyEvent", {type: "keyDown", text: "\r", ...key});
		await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...key});
		await page.waitFor(`!!document.querySelector("#chat .msg.pending")`, {label: "pending"});
		say("alice", "under the pending one");
		await shows("under the pending one");
		await liveIs("under the pending one", "message", "above a pending copy");
		page.check(
			"the pending copy is still last",
			await page.evaluate(
				`[...document.querySelectorAll("#chat .msg")].at(-1).classList.contains("pending")`
			)
		);

		// Elsewhere, then back: nothing drawn again is live.
		say("alice", "somewhere else", OTHER);
		await page.sleep(1500);
		await page.evaluate(`${item(OTHER)}.click()`);
		await shows("somewhere else");
		await liveIs("somewhere else", null, "a line read later in its channel");
		await page.evaluate(`${item(CHANNEL)}.click()`);
		await shows("hello");
		page.check("back again: no row is live", (await page.evaluate(ANY_LIVE)) === 0);

		await page.send("Emulation.setEmulatedMedia", {
			features: [{name: "prefers-reduced-motion", value: "reduce"}],
		});
		await page.waitFor(`document.documentElement.hasAttribute("data-reduce-motion")`, {
			label: "reduced motion on",
		});
		say("alice", "still here");
		await shows("still here");
		await liveIs("still here", "message", "reduced motion");
		page.check(
			"style.css animates nothing on it",
			(await page.evaluate(`getComputedStyle(${ROW("hello")}).animationName`)) === "none"
		);
	} finally {
		await ircd.close();
	}
}
