// Chat cues (client/js/chatCues.ts, docs/resources/themes.md § Chat cues) in
// a real browser, under the default theme: someone else's line in the open
// channel sets `data-chat-cue` on <html> and its row rises in
// (`chat-cue-arrive`), a mention flashes too (`chat-cue-mention`), and the cue
// is gone CUE_MS later; a line in another channel and a part cue nothing
// (our own lines: test/tests/chatCues.ts); switching channels ends a cue; ps and Keeki answering or naming
// each other raise hearts (`chat-cue-hearts`), and nobody else does; under
// reduced motion the cue is still set, nothing moves, and ps and Keeki's row
// blushes instead.
//
//   pnpm build && python3 -m http.server -d "$PWD/public" 8000 &
//   node tools/browser-drive.mjs tools/scenarios/chat-cues.mjs
//
// No ircd needed: lib/tiny-ircd.mjs, whose socket the scenario writes to.
// `SEANCE_PORT` serves the app from another port.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9877;
const CHANNEL = "#cues";
const OTHER = "#elsewhere";
const NICK = "cuer";

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	`${CHANNEL},${OTHER}`
)}`;

const CUE = `(document.documentElement.dataset.chatCue ?? null)`;
const LAST = `[...document.querySelectorAll("#chat .msg")].at(-1)`;
const ROW_ANIM = `getComputedStyle(${LAST}).animationName`;
const HEARTS = `getComputedStyle(${LAST}, "::after").animationName`;
const INPUT = `document.querySelector("#input")`;

export default async function run(page) {
	let send = () => {};
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		onLine(line, ctx) {
			send = ctx.send;

			if (line.startsWith("JOIN ")) {
				for (const chan of [CHANNEL, OTHER]) {
					ctx.send(`:${ctx.nick}!u@tiny JOIN ${chan}`);
					ctx.send(
						`:tiny.test 353 ${ctx.nick} = ${chan} :${ctx.nick} alice bob ps Keeki`
					);
					ctx.send(`:tiny.test 366 ${ctx.nick} ${chan} :End of /NAMES list.`);
				}

				return true;
			}

			return false;
		},
	});
	const from = (nick) => `:${nick}!u@tiny`;
	const say = (nick, text) => send(`${from(nick)} PRIVMSG ${CHANNEL} :${text}`);
	const cueIs = async (want, label) =>
		page.check(`${label}: cue ${want}`, (await page.evaluate(CUE)) === want);
	const lastSays = (text) =>
		page.waitFor(`${LAST}?.textContent.includes(${JSON.stringify(text)})`, {label: text});

	try {
		await page.send("Emulation.setFocusEmulationEnabled", {enabled: true});
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		const item = (name) => `document.querySelector('.channel-list-item[data-name="${name}"]')`;
		await page.waitFor(item(CHANNEL), {label: CHANNEL});
		await page.evaluate(`${item(CHANNEL)}.click()`);
		await page.waitFor(INPUT, {label: "the channel"});
		await page.sleep(1000);
		await cueIs(null, "after our own joins");

		say("alice", "hello");
		await lastSays("hello");
		await cueIs("message", "a message");
		page.check(
			"a message: its row rises in",
			(await page.evaluate(ROW_ANIM)) === "chat-cue-arrive"
		);
		page.check("not ps and Keeki: no hearts", (await page.evaluate(HEARTS)) === "none");

		say("bob", `${NICK}: ping`);
		await lastSays("ping");
		await cueIs("mention", "a mention");
		page.check(
			"a mention: rises and flashes",
			(await page.evaluate(ROW_ANIM)) === "chat-cue-arrive, chat-cue-mention"
		);
		await page.waitFor(`${CUE} === null`, {label: "the cue's end", timeout: 4000});
		page.check("the end: no animation", (await page.evaluate(ROW_ANIM)) === "none");

		send(`${from("alice")} PRIVMSG ${OTHER} :somewhere else`);
		await page.sleep(300);
		await cueIs(null, "a line in another channel");

		send(`${from("bob")} PART ${CHANNEL} :bye`);
		await page.sleep(300);
		await cueIs(null, "a part");

		// ps and Keeki: a line naming the other, and an answer to the other's line.
		say("ps", "hey Keeki");
		await lastSays("hey Keeki");
		page.check("ps names Keeki: hearts", (await page.evaluate(HEARTS)) === "chat-cue-hearts");
		await page.sleep(500);
		await page.screenshot("hearts");
		say("Keeki", "hi there");
		await lastSays("hi there");
		page.check("Keeki answers ps: hearts", (await page.evaluate(HEARTS)) === "chat-cue-hearts");
		say("alice", "and me");
		await lastSays("and me");
		page.check("alice after them: no hearts", (await page.evaluate(HEARTS)) === "none");

		// A cue ends with its conversation.
		await page.evaluate(`${item(OTHER)}.click()`);
		await page.waitFor(`${CUE} === null`, {label: "the cue ends on a switch", timeout: 1000});
		await page.evaluate(`${item(CHANNEL)}.click()`);
		await page.sleep(500);

		await page.send("Emulation.setEmulatedMedia", {
			features: [{name: "prefers-reduced-motion", value: "reduce"}],
		});
		await page.waitFor(`document.documentElement.hasAttribute("data-reduce-motion")`, {
			label: "reduced motion on",
		});
		say("ps", "Keeki, still here?");
		await lastSays("still here?");
		await cueIs("message", "reduced motion: the cue is still set");
		const still = JSON.parse(
			await page.evaluate(
				`JSON.stringify({row: ${ROW_ANIM}, hearts: ${HEARTS}, bg: getComputedStyle(${LAST}).backgroundColor})`
			)
		);
		page.check(
			`reduced motion: nothing moves, the row blushes (${still.bg})`,
			still.row === "none" && still.hearts === "none" && still.bg !== "rgba(0, 0, 0, 0)"
		);
	} finally {
		await ircd.close();
	}
}
