// A channel whose topic opens with an emoji shows that emoji in its sidebar
// row in place of the speech bubbles (docs/resources/client-features.md
// § Channel emoji from the topic).
//
//   pnpm build && python3 -m http.server -d public 8020 &
//   SEANCE_PORT=8020 node tools/browser-drive.mjs tools/scenarios/channel-emoji.mjs
//   SEANCE_THEME=ps …   (any theme: screenshots of the sidebar in it)
//
// No ircd needed: lib/tiny-ircd.mjs registers the connection and answers
// each JOIN with the channel's topic from TOPICS.
//
// Claims:
//   1. a channel whose topic opens with an emoji (after formatting) draws it,
//      a flag and a ZWJ sequence whole;
//   2. a plain topic, a text symbol without the emoji selector (♥) and no
//      topic at all keep the bubbles;
//   3. every channel's name starts in the same column and every row is as
//      tall, emoji or not;
//   4. a TOPIC change swaps the emoji, and one without an emoji puts the
//      bubbles back;
//   5. an unsent draft's pen takes the emoji's place, and the emoji comes
//      back with the row's selection;
//   6. a message in another channel pulses the emoji's opacity, not its
//      colour; with reduced motion it stays still;
//   7. no console errors.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const THEME = process.env.SEANCE_THEME ?? "";
const BASE = `http://localhost:${PORT}/`;
// Outside browser-drive.mjs's DevTools ports (9222–10221), which are picked at random.
const IRCD_PORT = 9176;

export const url = BASE;

const TOPICS = {
	"#games": "🎮 Games, all of them",
	"#formatted": "\x02\x0304🔥\x0f hot takes only",
	"#pride": "🏳️‍🌈 everyone welcome",
	"#deutsch": "🇩🇪 Auf Deutsch, bitte",
	"#plain": "Welcome to #plain 🎉",
	"#hearts": "♥ text heart, no selector",
	"#none": "",
};

const NETWORK = {
	uuid: "emoji-0000",
	name: "Emoji",
	host: "127.0.0.1",
	port: IRCD_PORT,
	tls: false,
	nick: "probe",
	join: Object.keys(TOPICS).join(","),
	sasl: "",
	saslAccount: "",
	saslPassword: "",
	autoconnect: true,
};

const row = (name) => `#sidebar .channel-list-item[data-name="${name}"]`;
const exists = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`;

/** The row's ::before: what it draws and how. */
const icon = (page, name) =>
	page.evaluate(`(() => {
		const el = document.querySelector(${JSON.stringify(row(name))});
		if (!el) return null;
		const s = getComputedStyle(el, "::before");
		return {
			emoji: el.dataset.emoji ?? null,
			content: s.content,
			font: s.fontFamily,
			animation: s.animationName,
			opacity: s.opacity,
		};
	})()`);

/** The row's height in px. */
const height = async (page, name) => Math.round((await page.rect(row(name)))?.height ?? 0);

/** Where the row's name starts, from the row's own inline start. */
const nameStart = (page, name) =>
	page.evaluate(`(() => {
		const el = document.querySelector(${JSON.stringify(row(name))});
		const n = el?.querySelector(".name");
		if (!n) return null;
		return Math.round(n.getBoundingClientRect().left - el.getBoundingClientRect().left);
	})()`);

export default async function run(page) {
	let push = null;

	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "message-tags server-time",
		onLine(line, {send, nick}) {
			push = send;
			const [cmd, target] = line.split(" ");

			if (cmd.toUpperCase() !== "JOIN") {
				return false;
			}

			for (const chan of target.split(",").filter(Boolean)) {
				send(`:${nick}!u@tiny JOIN ${chan}`);

				if (TOPICS[chan]) {
					send(`:tiny.test 332 ${nick} ${chan} :${TOPICS[chan]}`);
				}

				send(`:tiny.test 353 ${nick} = ${chan} :${nick} bob`);
				send(`:tiny.test 366 ${nick} ${chan} :End of /NAMES list.`);
			}

			return true;
		},
	});

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(
			`localStorage.setItem("thelounge.networks", ${JSON.stringify(
				JSON.stringify([NETWORK])
			)})`
		);

		if (THEME) {
			await page.evaluate(
				`localStorage.setItem("settings", ${JSON.stringify(
					JSON.stringify({theme: THEME})
				)})`
			);
		}

		await page.goto(page.url, {waitForSelector: "#sidebar"});
		await page.waitFor(exists(row("#none")), {label: "channels joined"});
		await page.waitFor(
			`document.querySelector(${JSON.stringify(row("#games"))})?.dataset.emoji`,
			{
				label: "#games has its emoji",
			}
		);
		await page.sleep(500);

		// 1. Emoji topics draw their emoji, whole.
		const expected = {
			"#games": "🎮",
			"#formatted": "🔥",
			"#pride": "🏳️‍🌈",
			"#deutsch": "🇩🇪",
		};

		for (const [name, emoji] of Object.entries(expected)) {
			const s = await icon(page, name);
			page.check(`${name}: data-emoji is ${emoji}`, s?.emoji === emoji);
			page.check(`${name}: ::before draws it`, s?.content === JSON.stringify(emoji));
			page.check(`${name}: in the emoji font`, /Emoji/.test(s?.font ?? ""));
		}

		// 2. Everything else keeps the bubbles.
		for (const name of ["#plain", "#hearts", "#none"]) {
			const s = await icon(page, name);
			page.check(`${name}: no data-emoji`, s?.emoji === null);
			page.check(`${name}: the bubbles`, s?.content === '""');
		}

		// 3. One column for the names.
		const starts = {};

		for (const name of Object.keys(TOPICS)) {
			starts[name] = await nameStart(page, name);
		}

		const columns = new Set(Object.values(starts));
		page.check(`names start in one column (${JSON.stringify(starts)})`, columns.size === 1);

		// The selected row is taller than the rest (its close button), so it
		// is measured against a selected row without an emoji instead.
		const heights = {};

		for (const name of Object.keys(TOPICS)) {
			if (!(await page.evaluate(`${exists(`${row(name)}.active`)}`))) {
				heights[name] = await height(page, name);
			}
		}

		page.check(
			`unselected rows are one height (${JSON.stringify(heights)})`,
			new Set(Object.values(heights)).size === 1
		);

		await page.click(row("#pride"));
		await page.waitFor(exists(`${row("#pride")}.active`), {label: "#pride open"});
		const selectedEmoji = await height(page, "#pride");
		await page.click(row("#none"));
		await page.waitFor(exists(`${row("#none")}.active`), {label: "#none open"});
		const selectedPlain = await height(page, "#none");
		page.check(
			`a selected row is as tall with an emoji (${selectedEmoji}) as without (${selectedPlain})`,
			selectedEmoji === selectedPlain
		);

		await page.screenshot("sidebar", {selector: "#sidebar"});

		// 4. A TOPIC change follows.
		push(":bob!u@tiny TOPIC #games :🎲 Board games now");
		await page.waitFor(
			`document.querySelector(${JSON.stringify(row("#games"))})?.dataset.emoji === "🎲"`,
			{label: "#games swapped to 🎲"}
		);
		push(":bob!u@tiny TOPIC #games :No emoji any more");
		await page.waitFor(
			`!document.querySelector(${JSON.stringify(row("#games"))})?.dataset.emoji`,
			{label: "#games lost its emoji"}
		);
		page.check("#games: the bubbles again", (await icon(page, "#games"))?.content === '""');
		push(":bob!u@tiny TOPIC #plain :🧪 Now with an emoji");
		await page.waitFor(
			`document.querySelector(${JSON.stringify(row("#plain"))})?.dataset.emoji === "🧪"`,
			{label: "#plain gained 🧪"}
		);

		// 5. A draft's pen takes the slot while the row is not selected.
		await page.click(row("#deutsch"));
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				row("#deutsch")
			)})?.classList.contains("active")`,
			{
				label: "#deutsch open",
			}
		);
		await page.fill("#input", "half a thought");
		await page.click(row("#pride"));
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				row("#deutsch")
			)})?.classList.contains("has-draft")`,
			{label: "#deutsch has a draft"}
		);
		const drafted = await icon(page, "#deutsch");
		page.check("draft: the pen, not the emoji", drafted?.content === '""');
		page.check("draft: in the icon font", /FontAwesome/.test(drafted?.font ?? ""));
		await page.screenshot("draft", {selector: "#sidebar"});
		await page.click(row("#deutsch"));
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				row("#deutsch")
			)})?.classList.contains("active")`,
			{
				label: "#deutsch open again",
			}
		);
		page.check(
			"draft, selected: the emoji",
			(await icon(page, "#deutsch"))?.content === '"🇩🇪"'
		);
		await page.fill("#input", "");

		// 6. Activity pulses the emoji's opacity.
		push(":bob!u@tiny PRIVMSG #pride :hello there");
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				row("#pride")
			)})?.classList.contains("has-activity")`,
			{label: "#pride has activity"}
		);
		const pulsing = await icon(page, "#pride");
		page.check(
			`activity: the opacity pulse (${pulsing?.animation})`,
			pulsing?.animation === "channel-emoji-pulse"
		);
		await page.evaluate(`document.documentElement.setAttribute("data-reduce-motion", "")`);
		await page.sleep(100);
		const still = await icon(page, "#pride");
		page.check(
			`reduced motion: no animation (${still?.animation})`,
			still?.animation === "none"
		);
		page.check(`reduced motion: fully opaque (${still?.opacity})`, still?.opacity === "1");
		await page.evaluate(`document.documentElement.removeAttribute("data-reduce-motion")`);

		page.check(
			`no console errors${
				page.consoleErrors.length ? `: ${page.consoleErrors.join(" | ")}` : ""
			}`,
			page.consoleErrors.length === 0
		);
	} finally {
		await ircd.close();
	}
}
