// The translate panel in a real browser, on the in-page fake engine
// (?fakeTranslate on a non-production build), with a second user in
// #seance-translate over a raw WebSocket who hears what the page sends.
//
// Steps, in order: the composer's 文A opens the panel, focused, with
// nothing in the message box touched; typing in it streams the fake's
// "[German] …" into the panel, Insert waiting until it is done; the
// read-back comes up under it ("Reads as: …"); Insert puts the
// translation in the message box, closes the panel and the button then
// names the language ("DE"); Return sends it, the other user hears the
// translation and the line is tagged as German, machine-translated; the
// panel again, inserted and then edited, goes as the user's own line,
// untagged; a "[fail]" text says it couldn't translate, Insert stays
// disabled and Try again asks once more; Escape closes the panel and
// leaves the draft in the box; the panel's language button opens the
// sheet's list, and a pick translates what is typed into that language;
// a reply to the other user's French line marks 文A dashed with "FR".
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   CHROME_BIN=/seance/tmp/chrome-pw.sh node tools/browser-drive.mjs tools/scenarios/translate-panel.mjs
//   … --mobile --width=390 --height=844
//
// Needs the dev ircd's plain-WS port on 127.0.0.1:8067. NODE_ENV must be
// unset for the build: a production build compiles the fake out.

import {SHEET, TRANSLATION_ON, TRANSLATION_OFFERED} from "./lib/translation.mjs";

const RUN = Date.now().toString(36);
const NICK = `tp${RUN}`;
const LISTENER = `hp${RUN}`;
const CHANNEL = "#seance-translate";
const IRCD = process.env.SEANCE_IRC_WS || "ws://127.0.0.1:8067/";
const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance-translate&fakeTranslate`;

const INPUT = "#form #input";
const BUTTON = "#form #translate-once";
const PANEL = "#form .translate-panel";
const FIELD = "#translate-panel-input";
const INSERT = `${PANEL} .translate-panel-insert`;
const text = (sel) =>
	`((document.querySelector(${JSON.stringify(sel)}) || {}).textContent || "").trim()`;
const translation = text(`${PANEL} .translate-panel-translation`);
const readBack = text(`${PANEL} .translate-panel-check`);
const inputValue = `document.querySelector(${JSON.stringify(INPUT)}).value`;
const insertDisabled = `document.querySelector(${JSON.stringify(INSERT)}).disabled`;
const buttonCode = text(`${BUTTON} .translate-once-target`);
const ENTER = `document.querySelector(${JSON.stringify(
	INPUT
)}).dispatchEvent(new KeyboardEvent("keypress", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true}))`;
const ESCAPE = `document.querySelector(${JSON.stringify(
	FIELD
)}).dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true}))`;

/** The last own line the store holds, with its language tags. */
const LAST_OWN = `(() => {
	const store = document.getElementById("app")?.__vue_app__?.config.globalProperties.$store;
	const chan = store?.state.activeChannel?.channel;
	const own = (chan?.messages || []).filter((m) => m.self && m.type === "message");
	const last = own[own.length - 1];

	return last ? {text: last.text, language: last.language ?? null, mt: !!last.machineTranslated} : null;
})()`;

/** A second user who records every PRIVMSG body it hears in the channel. */
function listener(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	const heard = [];
	let joinedResolve;
	let joinedReject;
	const joined = new Promise((resolve, reject) => {
		joinedResolve = resolve;
		joinedReject = reject;
		setTimeout(() => reject(new Error("listener never joined")), 20000);
	});
	const from = (command) => new RegExp(`^(?:@\\S+ )?:${nick}\\S* ${command}`);

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance panel listener`);
	};
	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(line.replace("PING", "PONG"));
		} else if (/ 001 /.test(line)) {
			ws.send(`JOIN ${CHANNEL}`);
		} else if (/ 433 /.test(line)) {
			ws.send(`NICK ${nick}_`);
		} else if (from("JOIN").test(line)) {
			joinedResolve();
		} else if (/ PRIVMSG /.test(line)) {
			const body = line.indexOf(" :", line.indexOf("PRIVMSG"));

			if (body > 0) {
				heard.push(line.slice(body + 2));
			}
		}
	};
	ws.onerror = () => joinedReject(new Error("listener socket error"));

	return {
		joined,
		heard: () => heard.slice(),
		say: (line) => ws.send(`PRIVMSG ${CHANNEL} :${line}`),
		quit: () => ws.send("QUIT :done"),
	};
}

async function heard(other, line, timeout = 10000) {
	const deadline = Date.now() + timeout;

	for (;;) {
		if (other.heard().includes(line)) {
			return true;
		}

		if (Date.now() > deadline) {
			return false;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** What 文A and the composer look like, for a panel that did not open. */
const BUTTON_STATE = `(() => {
	const b = document.querySelector(${JSON.stringify(BUTTON)});
	const store = document.getElementById("app")?.__vue_app__?.config.globalProperties.$store;
	const active = store?.state.activeChannel;

	return {
		button: !!b,
		disabled: b?.disabled ?? null,
		expanded: b?.getAttribute("aria-expanded") ?? null,
		connected: active?.network.status.connected ?? null,
		channel: active?.channel.name ?? null,
		type: active?.channel.type ?? null,
		note: store?.state.translation.note ?? null,
	};
})()`;

async function openPanel(page) {
	// 文A is disabled until the network counts as connected, which on a
	// real ircd can come a moment after the channel view does.
	await page.waitFor(`!document.querySelector(${JSON.stringify(BUTTON)}).disabled`, {
		timeout: 20000,
		label: "文A is enabled",
	});
	await page.evaluate(`document.querySelector(${JSON.stringify(BUTTON)}).click()`);

	const deadline = Date.now() + 5000;

	while (!(await page.evaluate(`!!document.querySelector(${JSON.stringify(FIELD)})`))) {
		if (Date.now() > deadline) {
			page.check(
				`文A opens the panel (${JSON.stringify(await page.evaluate(BUTTON_STATE))})`,
				false
			);
			throw new Error("the panel did not open");
		}

		await page.sleep(100);
	}
}

/** Pick `code` in the sheet's list, opened from the panel's language button. */
async function pickLanguage(page, code) {
	await page.evaluate(
		`document.querySelector(${JSON.stringify(`${PANEL} .translate-panel-language`)}).click()`
	);

	const row = `${SHEET} .language-sheet-row[data-code="${code}"]`;

	await page.waitFor(`!!document.querySelector(${JSON.stringify(row)})`, {
		label: "the sheet's language list",
	});
	await page.evaluate(`document.querySelector(${JSON.stringify(row)}).click()`);
	await page.waitFor(`!document.querySelector(${JSON.stringify(SHEET)})`, {
		label: "the pick closed the sheet",
	});
}

export default async function run(page) {
	await page.addInitScript(TRANSLATION_ON);
	// Every line the page sends, as sent: the echo is no evidence of the
	// tags, since an ircd may strip a client tag it does not know (the dev
	// ircd drops +evilnet.github.io/machine-translated and keeps the
	// language).
	await page.addInitScript(`(() => {
		const send = WebSocket.prototype.send;
		window.__seanceSent = [];
		WebSocket.prototype.send = function (data) {
			window.__seanceSent.push(String(data));
			return send.call(this, data);
		};
	})()`);
	const other = listener(LISTENER);

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector(${JSON.stringify(INPUT)})`, {
		timeout: 20000,
		label: "the channel view",
	});
	await page.waitFor(TRANSLATION_OFFERED, {
		timeout: 20000,
		label: "translation offered (the fake reports a GPU)",
	});
	await other.joined;

	// 1. The panel opens on 文A, focused; the message box is untouched.
	await page.fill(INPUT, "draft stays");
	await openPanel(page);
	await page.check(
		"the panel's text box has the focus",
		await page.evaluate(`document.activeElement?.id === "translate-panel-input"`)
	);
	await page.check(
		"the message box keeps its draft",
		(await page.evaluate(inputValue)) === "draft stays"
	);

	// 2. Escape closes it and leaves the draft.
	await page.evaluate(ESCAPE);
	await page.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, {
		label: "Escape closes the panel",
	});
	await page.check(
		"the draft is still in the box",
		(await page.evaluate(inputValue)) === "draft stays"
	);
	await page.fill(INPUT, "");

	// 3. Type, translated into German as it is typed; Insert waits for it.
	await openPanel(page);
	await pickLanguage(page, "de");

	const typed = `the build is green again ${RUN}`;

	await page.fill(FIELD, typed);
	await page.check("Insert waits while it translates", await page.evaluate(insertDisabled));
	await page.waitFor(`${translation} === ${JSON.stringify(`[German] ${typed}`)}`, {
		timeout: 20000,
		label: "the German streams into the panel",
	});
	await page.waitFor(`!${insertDisabled}`, {label: "Insert is ready"});
	await page.waitFor(`${readBack}.startsWith("Reads as:")`, {
		timeout: 25000,
		label: "the read-back comes up",
	});
	await page.screenshot("translate-panel");

	// 4. Insert: the translation in the box, the panel closed, DE on 文A.
	await page.click(INSERT);
	await page.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, {
		label: "Insert closes the panel",
	});
	await page.check(
		"the box holds the translation",
		(await page.evaluate(inputValue)) === `[German] ${typed}`
	);
	await page.check("the button names German", (await page.evaluate(buttonCode)) === "DE");

	// 5. Sent unchanged: the translation goes, tagged.
	await page.evaluate(ENTER);
	await page.check(
		"the other user heard the translation",
		await heard(other, `[German] ${typed}`)
	);
	await page.waitFor(`(${LAST_OWN})?.text === ${JSON.stringify(`[German] ${typed}`)}`, {
		label: "the own line",
	});

	const sent = await page.evaluate(LAST_OWN);
	const wire = await page.evaluate(
		`(window.__seanceSent || []).find((l) => / PRIVMSG \\S+ :/.test(l) && l.endsWith(${JSON.stringify(
			`[German] ${typed}`
		)})) ?? null`
	);

	await page.check(
		`the line went out as German, machine-translated (${JSON.stringify(wire)})`,
		!!wire &&
			/^@\S*\+draft\/language=de[;\s]/.test(wire) &&
			/^@\S*\+evilnet\.github\.io\/machine-translated[;=\s]/.test(wire)
	);
	await page.check(`the own line is German (${JSON.stringify(sent)})`, sent?.language === "de");

	// 6. Inserted and edited: the user's own line, untagged.
	const second = `see you at the meeting ${RUN}`;

	await openPanel(page);
	await page.fill(FIELD, second);
	await page.waitFor(`!${insertDisabled}`, {timeout: 20000, label: "the second translation"});
	await page.click(INSERT);
	await page.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, {
		label: "Insert closes the panel",
	});
	await page.fill(INPUT, `[German] ${second} !`);
	await page.evaluate(ENTER);
	await page.check("the edited line went as typed", await heard(other, `[German] ${second} !`));
	await page.waitFor(`(${LAST_OWN})?.text === ${JSON.stringify(`[German] ${second} !`)}`, {
		label: "the edited own line",
	});

	const edited = await page.evaluate(LAST_OWN);

	await page.check(
		`the edited line carries no translation tags (${JSON.stringify(edited)})`,
		!edited?.mt
	);

	// 7. A failure: said in the panel, Insert disabled, Try again there.
	await openPanel(page);
	await page.fill(FIELD, `[fail] this one breaks ${RUN}`);
	await page.waitFor(`!!document.querySelector("${PANEL} .translate-panel-retry")`, {
		timeout: 20000,
		label: "the failure and Try again",
	});
	await page.check("Insert stays disabled", await page.evaluate(insertDisabled));
	await page.click(`${PANEL} .translate-panel-cancel`);
	await page.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, {
		label: "Cancel closes the panel",
	});
	await page.check("Cancel left the box empty", (await page.evaluate(inputValue)) === "");

	// 8. Replying to a French line suggests French: dashed FR on 文A (the
	// conversation's own German stays solid, so the suggestion is another).
	const french = `Est-ce que le serveur redémarre ce soir, quelqu'un le sait ? ${RUN}`;

	other.say(french);
	const frenchLine = `(() => {
		const store = document.getElementById("app")?.__vue_app__?.config.globalProperties.$store;
		const chan = store?.state.activeChannel?.channel;
		return (chan?.messages || []).find((m) => !m.self && m.text === ${JSON.stringify(french)}) ?? null;
	})()`;

	// The line itself, not RUN on screen: RUN is in the earlier lines too.
	await page.waitFor(`!!${frenchLine}`, {
		timeout: 20000,
		label: "the French line arrives",
	});
	await page.evaluate(`(() => {
		const store = document.getElementById("app")?.__vue_app__?.config.globalProperties.$store;
		store.state.activeChannel.channel.replyTo = ${frenchLine};
	})()`);
	await page.waitFor(
		`document.querySelector(${JSON.stringify(BUTTON)}).classList.contains("suggested")`,
		{
			timeout: 20000,
			label: "the reply suggests a language",
		}
	);
	await page.check("the suggestion is French", (await page.evaluate(buttonCode)) === "FR");

	other.quit();
}
