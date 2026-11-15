// Chat cues (client/js/chatCues.ts, docs/resources/themes.md § Chat cues) in
// a real browser, under the ps theme: someone joining the open channel puts
// `data-chat-cue="join"` on <html> and `psng-cue-join` on the scene, the moon
// and the sun run `ps-cue-glow`, and all of it is gone CUE_MS later; a
// message inside QUIET_MS is not cued, one after it is; a mention replaces a
// showing cue; a line in another channel and our own line cue nothing; and
// with reduced motion on nothing is cued at all.
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
const SCENE_CUE = `[...document.querySelector("#theme-scene").classList].filter((c) => c.startsWith("psng-cue-")).join(" ")`;
const GLOW = `(() => {
	const names = [".ps-moon svg", ".ps-sun svg"].map((s) => getComputedStyle(document.querySelector("#theme-scene " + s)).animationName);
	return names.join(" ");
})()`;
const INPUT = `document.querySelector("#input")`;

export default async function run(page) {
	let send = () => {};
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		onLine(line, ctx) {
			send = ctx.send;
			return false;
		},
	});
	const from = (nick) => `:${nick}!u@tiny`;

	try {
		await page.send("Emulation.setFocusEmulationEnabled", {enabled: true});
		await page.addInitScript(
			`try { localStorage.setItem("settings", JSON.stringify({theme: "ps"})); } catch (e) {}`
		);
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		const item = `document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`;
		await page.waitFor(item, {label: CHANNEL});
		await page.evaluate(`${item}.click()`);
		await page.waitFor(
			`${INPUT} && document.querySelector("#theme-scene.psng")?.children.length > 0`,
			{label: "the channel under the ps scene"}
		);
		// Past the joins of the connect itself (our own: never cued anyway).
		await page.sleep(2500);
		page.check("nothing cued after our own joins", (await page.evaluate(CUE)) === null);

		await page.screenshot("before");
		send(`${from("alice")} JOIN ${CHANNEL}`);
		await page.waitFor(`${CUE} === "join"`, {label: "the join cue"});
		page.check(
			"a join: psng-cue-join on the scene",
			(await page.evaluate(SCENE_CUE)) === "psng-cue-join"
		);
		const glow = await page.evaluate(GLOW);
		page.check(`a join: the moon and sun glow (${glow})`, glow === "ps-cue-glow ps-cue-glow");
		await page.sleep(600); // near the glow's peak (30 % of 2.6 s)
		await page.screenshot("join-glow");

		send(`${from("alice")} PRIVMSG ${CHANNEL} :hello`);
		await page.sleep(300);
		page.check("a message while a cue shows is dropped", (await page.evaluate(CUE)) === "join");

		send(`${from("bob")} PRIVMSG ${CHANNEL} :${NICK}: ping`);
		await page.waitFor(`${CUE} === "mention"`, {label: "a mention replacing the join"});
		page.check(
			"a mention: psng-cue-mention, ps-cue-mention",
			(await page.evaluate(SCENE_CUE)) === "psng-cue-mention" &&
				(await page.evaluate(GLOW)) === "ps-cue-mention ps-cue-mention"
		);

		await page.waitFor(`${CUE} === null`, {label: "the cue's end", timeout: 4000});
		page.check(
			"the end: no class, no glow",
			(await page.evaluate(SCENE_CUE)) === "" &&
				(await page.evaluate(GLOW)) !== "ps-cue-glow ps-cue-glow"
		);

		send(`${from("alice")} PRIVMSG ${CHANNEL} :inside the quiet`);
		await page.sleep(300);
		page.check("a message inside the quiet is not cued", (await page.evaluate(CUE)) === null);
		await page.sleep(2000);

		send(`${from("alice")} PRIVMSG ${OTHER} :somewhere else`);
		await page.sleep(300);
		page.check("a line in another channel is not cued", (await page.evaluate(CUE)) === null);

		await page.evaluate(
			`(() => { const i = ${INPUT}; i.value = "my own line"; i.dispatchEvent(new Event("input")); })()`
		);
		await page.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		await page.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		await page.sleep(500);
		page.check("our own line is not cued", (await page.evaluate(CUE)) === null);

		send(`${from("carol")} PART ${CHANNEL} :bye`);
		await page.waitFor(`${CUE} === "part"`, {label: "the part cue"});
		page.check(
			"a part: psng-cue-part on the scene, no glow in ps",
			(await page.evaluate(SCENE_CUE)) === "psng-cue-part" &&
				!(await page.evaluate(GLOW)).includes("ps-cue")
		);
		await page.waitFor(`${CUE} === null`, {label: "the part's end", timeout: 4000});
		await page.sleep(2100);

		await page.send("Emulation.setEmulatedMedia", {
			features: [{name: "prefers-reduced-motion", value: "reduce"}],
		});
		await page.waitFor(`document.documentElement.hasAttribute("data-reduce-motion")`, {
			label: "reduced motion on",
		});
		send(`${from("dave")} JOIN ${CHANNEL}`);
		await page.sleep(500);
		page.check("reduced motion: nothing cued", (await page.evaluate(CUE)) === null);
	} finally {
		await ircd.close();
	}
}
