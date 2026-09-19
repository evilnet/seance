// The themes end to end in a real browser (docs/resources/themes.md): every
// theme in the Appearance dropdown swaps the stylesheet link, is stored by
// name, and sets the browser chrome colour — its own for the four handoff
// themes (coffee, creama, cobalt, frost), the deploy's (whatever the tag held
// at boot) for day and morning, which carry none. On those four the colour
// pairs the design was checked against are measured from computed styles:
// text, timestamps, links, the join line and a nick on a highlighted row at
// ≥ 4.5:1, the header and footer icons at ≥ 3:1, the input placeholder — the
// one deliberate exception — at ≥ 3:1. Day and morning are only exercised for the
// switching; their open contrast items are docs/projects/accessibility.md's.
// A screenshot of the chat under each theme lands in the output directory.
//
//   corepack yarn build && python3 -m http.server -d public 8021 &
//   node tools/browser-drive.mjs tools/scenarios/themes.mjs
//
// The default target is a plain-WS ircd on 127.0.0.1:8067 (the dev ircd's
// ws:// port); SEANCE_IRC_WS overrides it for the scripted second user.

const RUN = Date.now().toString(36);
const NICK = `th${RUN}`;
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const BASE = process.env.SEANCE_SCENARIO_BASE ?? "http://localhost:8021/";
const IRCD = process.env.SEANCE_IRC_WS ?? "ws://127.0.0.1:8067/";
// The page dials whatever IRCD points at, so the two cannot drift apart.
const TARGET = new URL(IRCD);
// Coffee last: it is what the page boots on, and the store only writes a
// setting that changed.
const THEMES = [
	"creama",
	"cobalt",
	"frost",
	"molokai",
	"princess",
	"princess_",
	"keeki",
	"day",
	"morning",
	"coffee",
];
const OWN_COLOR = {
	coffee: "#1a1816",
	creama: "#efe9de",
	cobalt: "#101720",
	frost: "#eef2f7",
	molokai: "#1b1d1e",
	princess: "#f2f7fc",
	princess_: "#000000",
	keeki: "#22143a",
};

export const url =
	`${BASE}?host=${TARGET.hostname}&port=${TARGET.port}` +
	`&tls=${TARGET.protocol === "wss:"}&nick=${NICK}` +
	`&join=${encodeURIComponent(CHANNEL)}`;

const THEME_HREF = `document.getElementById("theme").getAttribute("href")`;
const STORED = `JSON.parse(localStorage.getItem("settings") ?? "{}").theme ?? null`;
const META = `document.querySelector('meta[name="theme-color"]').content`;

/** Colour helpers installed once: any CSS colour (a hex from a custom
 * property, an rgb() from a computed style) resolved through a probe element,
 * then WCAG contrast between two of them. */
const INSTALL_CONTRAST = `(() => {
	if (window.__themeCheck) return true;
	const probe = document.createElement("span");
	probe.style.position = "absolute";
	document.body.appendChild(probe);
	const rgb = (value) => {
		probe.style.color = "";
		probe.style.color = value;
		return (getComputedStyle(probe).color.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
	};
	const lum = (v) =>
		v
			.map((x) => {
				const s = x / 255;
				return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
			})
			.reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
	const ratio = (a, b) => {
		const [l, d] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
		return Math.round(((l + 0.05) / (d + 0.05)) * 100) / 100;
	};
	const cs = (sel, prop, pseudo) => {
		const el = document.querySelector(sel);
		return el ? getComputedStyle(el, pseudo || null)[prop] : null;
	};
	const root = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	// The background the text actually sits on: the first painted one at or
	// above the element. A row with a background of its own — a mention, one
	// of princess_'s bands, the selected channel's pill — is what its text
	// has to clear, not whatever the surface behind the row happens to be.
	const bgOf = (sel) => {
		let el = document.querySelector(sel);
		while (el) {
			const bg = getComputedStyle(el).backgroundColor;
			const parts = (bg.match(/[\d.]+/g) || []).map(Number);
			if (parts.length < 4 || parts[3] > 0.95) return bg;
			el = el.parentElement;
		}
		return root("--window-bg-color");
	};
	window.__themeCheck = {ratio, cs, root, bgOf};
	return true;
})()`;

/** [label, foreground, background, minimum] — each side is an expression on
 * window.__themeCheck. */
const PAIRS = [
	[
		"message text on the window",
		`cs('#chat .msg[data-type="message"] .content', "color")`,
		`root("--window-bg-color")`,
		4.5,
	],
	[
		"timestamps on the window",
		`cs("#chat .msg .time", "color")`,
		`root("--window-bg-color")`,
		4.5,
	],
	["a link on the window", `cs("#chat .messages a", "color")`, `root("--window-bg-color")`, 4.5],
	[
		"the join line on the window",
		`cs('#chat .msg[data-type="join"] .content', "color")`,
		`root("--window-bg-color")`,
		4.5,
	],
	[
		"a nick on a highlighted row",
		`cs("#chat .msg.highlight .user", "color")`,
		`cs("#chat .msg.highlight", "backgroundColor")`,
		4.5,
	],
	[
		"a channel row on the sidebar",
		`cs('.channel-list-item[data-type="channel"] .name', "color")`,
		`bgOf('.channel-list-item[data-type="channel"]')`,
		4.5,
	],
	[
		"header icons on the window",
		`cs("#chat button.menu", "color")`,
		`root("--window-bg-color")`,
		3,
	],
	[
		"footer icons on the sidebar",
		`cs("#footer button.help", "color")`,
		`root("--body-bg-color")`,
		3,
	],
	[
		"the input placeholder",
		`cs("#input", "color", "::placeholder")`,
		`cs("#form", "backgroundColor")`,
		3,
	],
];

/** A second user on the dev ircd: the joins, mention and link the pairs need. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};
	const send = (line) => ws.send(line);

	ws.onopen = () => {
		send(`NICK ${nick}`);
		send(`USER ${nick} 0 * :seance themes`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			send(`JOIN ${CHANNEL}`);
		} else if (params[1] === "JOIN" && params[0].includes(nick)) {
			onJoin();
		} else if (params[1] === "433") {
			send(`NICK ${nick}${Math.floor(Math.random() * 1000)}`);
		}
	};

	return {
		joined: new Promise((resolve, reject) => {
			onJoin = resolve;
			ws.onerror = (e) => reject(new Error(String(e.message ?? e)));
			setTimeout(() => reject(new Error(`${nick} never joined ${CHANNEL}`)), 20000);
		}),
		say: (line) => send(`PRIVMSG ${CHANNEL} :${line}`),
		quit: () => send("QUIT :done"),
	};
}

/** A real Enter keystroke in the focused input (keydown with text → keypress). */
async function pressEnter(page) {
	const key = {key: "Enter", code: "Enter", windowsVirtualKeyCode: 13};
	await page.send("Input.dispatchKeyEvent", {type: "keyDown", text: "\r", ...key});
	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...key});
}

export default async function run(page) {
	// A ?host link only pre-fills the connect form (a link is a suggestion,
	// boot.ts handleQueryParams); connect for real.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	const deployColor = await page.evaluate(META);
	page.check(
		`the page boots on coffee (${await page.evaluate(THEME_HREF)}, chrome ${deployColor})`,
		(await page.evaluate(THEME_HREF)) === "themes/coffee.css"
	);
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2500); // let the join burst and the catch-up settle

	const talker = speaker("kalliope");
	await talker.joined;
	await page.sleep(400);
	talker.say("anyone else seeing relay lag on hub-3?");
	await page.sleep(300);
	talker.say(`${NICK}: paste the logs into https://example.org/paste when you have them`);
	await page.waitFor(`!!document.querySelector("#chat .msg.highlight .user")`, {
		label: "the mention is highlighted",
	});
	// One message of our own, so every screenshot shows an own row and a theme
	// that bands them (keeki) is seen doing it.
	await page.click("#input");
	await page.fill("#input", "on it, give me five");
	await pressEnter(page);
	await page.waitFor(
		`!!document.querySelector('#chat .msg.self[data-type="message"]:not(.pending) .content')`,
		{
			label: "our own message is echoed",
		}
	);
	await page.evaluate(INSTALL_CONTRAST);

	const setTheme = async (name) => {
		await page.click(`#footer button.settings`);
		await page.waitFor(`!!document.querySelector(".settings-menu button.appearance")`, {
			label: "settings open",
		});
		await page.click(`.settings-menu button.appearance`);
		await page.waitFor(`!!document.querySelector("#theme-select")`, {
			label: "the theme select",
		});
		// The window's generic @change handler stores the select's value as the
		// setting; a bubbling `change` is what picking an option produces.
		await page.evaluate(
			`(() => {
				const el = document.querySelector("#theme-select");
				el.value = ${JSON.stringify(name)};
				el.dispatchEvent(new Event("change", {bubbles: true}));
			})()`
		);
		await page.sleep(700);
		await page.screenshot(`settings-${name}`);
		// Settings is a modal; Done returns to the channel it covered.
		await page.click(".settings-modal-done");
		await page.waitFor(`document.querySelector("#input")`, {label: "back in the channel"});
		await page.sleep(300);
	};

	for (const name of THEMES) {
		await setTheme(name);

		const href = await page.evaluate(THEME_HREF);
		page.check(
			`${name}: the stylesheet link is themes/${name}.css (${href})`,
			href === `themes/${name}.css`
		);
		const stored = await page.evaluate(STORED);
		page.check(`${name}: stored by name (${stored})`, stored === name);
		const meta = await page.evaluate(META);
		const wanted = OWN_COLOR[name] ?? deployColor;
		page.check(
			`${name}: browser chrome is ${
				OWN_COLOR[name] ? "its own" : "the deploy's"
			} colour (${meta})`,
			meta.toLowerCase() === wanted.toLowerCase()
		);

		if (OWN_COLOR[name]) {
			for (const [label, fg, bg, min] of PAIRS) {
				const ratio = await page.evaluate(
					`(() => { const c = window.__themeCheck; const f = c.${fg}; const b = c.${bg}; return f && b ? c.ratio(f, b) : null; })()`
				);
				page.check(`${name}: ${label} ${ratio}:1 ≥ ${min}`, ratio !== null && ratio >= min);
			}
		}

		await page.screenshot(`chat-${name}`);
	}

	// The choice (coffee again, the last switch) survives a reload.
	await page.goto(BASE, {waitForSelector: "#footer button.settings"});
	await page.sleep(500);
	page.check(
		`coffee is back after a reload (${await page.evaluate(THEME_HREF)})`,
		(await page.evaluate(THEME_HREF)) === "themes/coffee.css"
	);

	talker.quit();
	page.check(`no console errors (${page.consoleErrors.length})`, page.consoleErrors.length === 0);
}
