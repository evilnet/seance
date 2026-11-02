// The "Your own messages" setting end to end in a real browser: the three
// radios under Settings → Appearance move `data-own-messages` on <html>,
// an own row's text is the muted colour under the default and the body
// colour under the other two, the row carries a band under "band" and
// nothing under "plain", another user's row never changes, a theme that
// bands its own rows (princess) shows that band under "band" only, the
// stored value is the name, and the choice
// survives a reload (client/js/helpers/ownMessages.ts, settings.ts,
// style.css).
//
//   pnpm build && python3 -m http.server -d public 8021 &
//   node tools/browser-drive.mjs tools/scenarios/own-messages.mjs
//
// The default target is a plain-WS ircd on 127.0.0.1:8067 (the dev ircd's
// ws:// port); SEANCE_IRC_WS overrides it for the scripted second user.

const RUN = Date.now().toString(36);
const NICK = `om${RUN}`;
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const BASE = process.env.SEANCE_SCENARIO_BASE ?? "http://localhost:8021/";
const IRCD = process.env.SEANCE_IRC_WS ?? "ws://127.0.0.1:8067/";
const TARGET = new URL(IRCD);

export const url =
	`${BASE}?host=${TARGET.hostname}&port=${TARGET.port}` +
	`&tls=${TARGET.protocol === "wss:"}&nick=${NICK}` +
	`&join=${encodeURIComponent(CHANNEL)}`;

const DATASET = `document.documentElement.dataset.ownMessages ?? null`;
const STORED = `JSON.parse(localStorage.getItem("settings") ?? "{}").ownMessages ?? null`;
const OWN = `#chat .msg.self[data-type="message"]`;
const OTHER = `#chat .msg[data-type="message"]:not(.self)`;
const RADIO = (value) => `input[name="ownMessages"][value="${value}"]`;

/** A second user on a raw WebSocket, so an own row has a neighbour to
 * compare with. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};
	const send = (line) => ws.send(line);

	ws.onopen = () => {
		send(`NICK ${nick}`);
		send(`USER ${nick} 0 * :own messages`);
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
	const cs = (selector, prop) =>
		page.evaluate(
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				return el ? getComputedStyle(el)[${JSON.stringify(prop)}] : null;
			})()`
		);
	const ownText = () => cs(`${OWN} .content`, "color");
	const otherText = () => cs(`${OTHER} .content`, "color");
	const ownBand = () => cs(OWN, "backgroundColor");
	const otherBand = () => cs(OTHER, "backgroundColor");
	const bodyColor = () => cs("#chat .messages", "color");
	const mutedColor = () =>
		page.evaluate(
			`getComputedStyle(document.documentElement).getPropertyValue("--body-color-muted").trim()`
		);
	const toRgb = (value) =>
		page.evaluate(
			`(() => {
				const el = document.createElement("span");
				el.style.color = ${JSON.stringify(value)};
				document.body.appendChild(el);
				const out = getComputedStyle(el).color;
				el.remove();
				return out;
			})()`
		);
	const NONE = "rgba(0, 0, 0, 0)";

	const pick = async (value) => {
		await page.click(RADIO(value));
		await page.sleep(150);
	};
	const openAppearance = async () => {
		await page.click(`#footer button.settings`);
		await page.waitFor(`!!document.querySelector(".settings-menu button.appearance")`, {
			label: "settings open",
		});
		await page.click(`.settings-menu button.appearance`);
		await page.waitFor(`!!document.querySelector(${JSON.stringify(RADIO("muted"))})`, {
			label: "the own-messages radios",
		});
		await page.evaluate(
			`document.querySelector(${JSON.stringify(
				RADIO("muted")
			)}).scrollIntoView({block: "center"})`
		);
	};
	const backToChat = async () => {
		await page.click(".settings-modal-done");
		await page.waitFor(`!!document.querySelector("#input")`, {label: "back in the channel"});
		await page.sleep(200);
	};
	const setTheme = async (name) => {
		await page.evaluate(
			`(() => {
				const el = document.querySelector("#theme-select");
				el.value = ${JSON.stringify(name)};
				el.dispatchEvent(new Event("change", {bubbles: true}));
			})()`
		);
		await page.sleep(700);
	};

	// A ?host link only pre-fills the connect form; connect for real, with
	// autoconnect so the reload at the end brings the network back.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="autoconnect"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector("#form #input")`, {
		timeout: 20000,
		label: "chat input up",
	});
	await page.sleep(2500); // the join burst and the catch-up

	const talker = speaker("kalliope");
	await talker.joined;
	await page.sleep(400);
	talker.say("anyone else seeing relay lag on hub-3?");
	await page.waitFor(`!!document.querySelector(${JSON.stringify(OTHER)})`, {
		label: "kalliope's line",
	});
	await page.click("#input");
	await page.send("Input.insertText", {text: "on it, give me five"});
	await pressEnter(page);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(`${OWN}:not(.pending)`)})`, {
		label: "our own message is echoed",
	});

	page.check("boots at muted", (await page.evaluate(DATASET)) === "muted");
	const muted = await toRgb(await mutedColor());
	const body = await bodyColor();
	page.check(`own text is the muted colour (${muted})`, (await ownText()) === muted);
	page.check(`kalliope's text is the body colour (${body})`, (await otherText()) === body);
	page.check("no band on coffee by default", (await ownBand()) === NONE);
	await page.screenshot("1-coffee-muted");

	await openAppearance();
	page.check(
		"the muted radio is checked",
		await page.evaluate(`document.querySelector(${JSON.stringify(RADIO("muted"))}).checked`)
	);
	await pick("band");
	page.check("html carries band", (await page.evaluate(DATASET)) === "band");
	page.check("stored as band", (await page.evaluate(STORED)) === "band");
	await page.screenshot("2-settings-band");
	await backToChat();
	page.check("band: own text is the body colour", (await ownText()) === body);
	const band = await ownBand();
	page.check(`band: own row carries a band (${band})`, band !== NONE && band !== "");
	page.check("band: kalliope's row does not", (await otherBand()) === NONE);
	await page.screenshot("3-coffee-band");

	await openAppearance();
	await pick("plain");
	page.check("html carries plain", (await page.evaluate(DATASET)) === "plain");
	await backToChat();
	page.check("plain: own text is the body colour", (await ownText()) === body);
	page.check("plain: no band", (await ownBand()) === NONE);
	await page.screenshot("4-coffee-plain");

	// Princess bands its own rows itself: that band shows only under
	// "band", in the theme's own colour (--own-bg), never under the default
	// or "plain" — the three looks do not overlap.
	await openAppearance();
	await setTheme("princess");
	await pick("muted");
	await backToChat();
	page.check("princess: no band under the default", (await ownBand()) === NONE);
	page.check(
		"princess: own text greyed under the default",
		(await ownText()) !== (await otherText())
	);
	await page.screenshot("5-princess-muted");
	await openAppearance();
	await pick("band");
	await backToChat();
	page.check(
		"princess: band is the theme's own (#e2edff)",
		(await ownBand()) === "rgb(226, 237, 255)"
	);
	await openAppearance();
	await pick("plain");
	await backToChat();
	page.check("princess: plain, no band", (await ownBand()) === NONE);
	await page.screenshot("6-princess-plain");

	// Back to coffee on "band", then a reload: the choice comes back.
	await openAppearance();
	await setTheme("coffee");
	await pick("band");
	await backToChat();
	// A cold load of the page (font-size-setting.mjs explains the dance);
	// same profile, so localStorage is the thing being tested. The channel
	// comes back empty of our own line (no chathistory on the dev ircd), so
	// say it again.
	await page.evaluate(
		`(() => { window.__coldLoad = true; history.replaceState(null, "", ${JSON.stringify(
			BASE
		)}); location.reload(); })()`
	);
	await page.waitFor(`!window.__coldLoad && !!document.querySelector("#form #input")`, {
		timeout: 20000,
		label: "rebooted onto chat",
	});
	page.check("band survives a reload", (await page.evaluate(DATASET)) === "band");
	await page.sleep(1500);
	await page.click("#input");
	await page.send("Input.insertText", {text: "back after the reload"});
	await pressEnter(page);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(`${OWN}:not(.pending)`)})`, {
		label: "our own message after the reload",
	});
	page.check("reload: own row carries a band", (await ownBand()) === band);
	await page.screenshot("7-reloaded-band");

	talker.quit();
	page.check("no console errors", page.consoleErrors.length === 0);
}
