// Reading everywhere (docs/resources/translation.md § Reading everywhere),
// in a real browser on the in-page fake engine (?fakeTranslate) and a
// fabricated network (lib/fake-network.mjs: #seance on screen, chan 2, and a
// query with moria, chan 3), so it needs a development build and no ircd.
// Detection is real (fastText and ELD); only the engine is scripted, and its
// request log (`__seanceTranslateFake.requests`) is how "no work" is seen.
//
// In order:
//  1. An existing user's version-1 blob (#seance `read: false`, `write: "pt"`)
//     with translation on is migrated at boot: the blob is version 2 with
//     the write target kept, the one-time "every conversation" note shows,
//     and its "Choose conversations" opens this conversation's panel with
//     "Translate messages here" on.
//  2. A German line in the query in the background is not looked at: no
//     request, no entry. One in #seance, on screen, is translated live.
//     Opening the query reads its line.
//  3. Adversarial, a phone in the background: with the page hidden, a
//     German line in #seance (still the active channel) is not translated;
//     once the page is visible again it is.
//  4. "Translate messages here" off: a German line stays as written and the
//     exclusion is stored; on again, that line is read.
//  5. History: an 80-line German page lands above the screen. Only lines
//     in or near view are requested, the oldest never; scrolling to the top
//     translates what comes into view.
//  6. Adversarial, a failed download/line: a line the fake fails (`[fail]`)
//     keeps its failure across leaving and reopening the conversation, with
//     no second request (no retry loop behind the reader's back).
//  7. "I also read" Spanish (Settings → Language): a Spanish line is left as
//     written, no request; German is still read. "Translate into" French:
//     what is on screen is read again into French.
//  8. Translation off: the channel menu's "Translation…" opens the panel as
//     one button; pressing it switches translation on without Settings and
//     closes the panel. With only English on screen the first-run note says
//     what will happen; with a German line on screen that line is
//     translated instead and no note shows.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   SEANCE_HTTP=http://localhost:8021/ CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/translate-everywhere.mjs
//   … --mobile --width=390 --height=844

import {readFileSync} from "node:fs";
import {fakeNetworkSnippet} from "./lib/fake-network.mjs";
import {TRANSLATION_ON, closeTranslationSheet, setReadingThroughSheet} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));

export const url = `${BASE}?fakeTranslate`;

const NETWORK = "fake-0000-0000";
const CHANNEL = 2;
const QUERY = 3;
const KEY = `${NETWORK}/#seance`;

const V1_BLOB = `(() => {
	if (!sessionStorage.getItem("seeded")) {
		sessionStorage.setItem("seeded", "1");
		localStorage.setItem("thelounge.translate", JSON.stringify({
			${JSON.stringify(KEY)}: {read: false, write: "pt"},
		}));
	}
})()`;

const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;
const BLOB = `JSON.parse(localStorage.getItem("thelounge.translate") || "{}")`;

let nextId = 500;

/** Dispatch one line from moria into a conversation; returns its message id. */
async function say(page, chan, text, {replay = false} = {}) {
	const id = nextId++;

	await page.evaluate(`window.socket.dispatch("msg", {
		chan: ${chan},
		${replay ? "replay: true," : ""}
		msg: {id: ${id}, type: "message", from: {mode: "", modes: [], away: "", lastMessage: Date.now(), nick: "moria"}, text: ${JSON.stringify(
		text
	)}, self: false, time: new Date(), users: [], msgid: "seance-fake-${id}"},
	})`);

	return id;
}

/** The requests the fake engine received whose text contains `needle`. */
const asked = (page, needle) =>
	page.evaluate(
		`(window.__seanceTranslateFake?.requests ?? []).filter((r) => r.text.includes(${JSON.stringify(
			needle
		)})).length`
	);

// Through JSON: a reactive proxy does not come back by value.
const entry = async (page, id) =>
	JSON.parse(await page.evaluate(`JSON.stringify(${STORE}.state.translations[${id}] ?? null)`));
const translated = (id) => `!!document.querySelector("#msg-${id} .msg-translated")`;
const translatedText = (page, id) =>
	page.evaluate(`document.querySelector("#msg-${id} .msg-translated")?.textContent ?? ""`);

async function open(page, chan) {
	await page.evaluate(`(() => { location.hash = "#/chan-${chan}"; })()`);
	await page.waitFor(`${STORE}.state.activeChannel?.channel.id === ${chan}`, {
		label: `conversation ${chan} on screen`,
	});
	await page.sleep(300);
}

async function setHidden(page, hidden) {
	await page.evaluate(`(() => {
		Object.defineProperty(document, "visibilityState", {configurable: true, get: () => ${JSON.stringify(
			hidden ? "hidden" : "visible"
		)}});
		Object.defineProperty(document, "hidden", {configurable: true, get: () => ${hidden}});
		document.dispatchEvent(new Event("visibilitychange"));
	})()`);
}

async function fabricate(page) {
	const made = await page.evaluate(fakeNetworkSnippet());

	page.check("a development build fabricated the network", made === true);
	await page.waitFor(`document.querySelectorAll("#chat .msg").length >= 3`, {
		label: "the fabricated channel's messages",
	});
}

async function setting(page, name, value) {
	await page.evaluate(
		`${STORE}.dispatch("settings/update", {name: ${JSON.stringify(
			name
		)}, value: ${JSON.stringify(value)}, sync: true})`
	);
	await page.sleep(300);
}

/** Settings → Language, then back to #seance. */
async function inSettings(page, act) {
	await page.evaluate(`(() => { location.hash = "#/settings/translation"; })()`);
	await page.waitFor(`!!document.querySelector('#settings select[name="translateInto"]')`, {
		label: "Settings → Translation, with Translate into",
	});
	await act();
	await page.click(".settings-modal-done");
	await page.waitFor(`!document.querySelector(".settings-modal")`, {label: "settings closed"});
	await open(page, CHANNEL);
}

const GERMAN = (n) =>
	`Zeile ${n}: Heute ist das Wetter wirklich schön, und wir gehen am Nachmittag im Park spazieren.`;

export default async function run(page) {
	await page.addInitScript(TRANSLATION_ON);
	await page.addInitScript(V1_BLOB);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await fabricate(page);

	// --- 1. The migration and its note. --------------------------------
	const blob = await page.evaluate(BLOB);

	page.check(
		"migrated: version 2, the write target kept, no `read` left",
		blob.version === 2 && blob[KEY]?.write === "pt" && !("read" in blob[KEY])
	);
	await page.waitFor(`!!document.querySelector(".translate-note")`, {
		label: "the one-time note",
	});
	page.check(
		"the note says every conversation is read",
		(await page.evaluate(
			`document.querySelector("#translate-note-lead").textContent.trim()`
		)) === EN["translate.note.everywhere"]
	);
	await page.screenshot("1-note-everywhere");
	await page.click(".translate-note-choose");
	await page.waitFor(`!!document.querySelector(".translation-sheet")`, {
		label: "Choose conversations opens the sheet",
	});
	page.check(
		"the sheet's switch: this conversation is translated",
		await page.evaluate(
			`document.querySelector(".translation-sheet .language-sheet-read-box").checked`
		)
	);
	await closeTranslationSheet(page);
	page.check(
		"the note is gone and does not come back",
		!(await page.evaluate(`!!document.querySelector(".translate-note")`)) &&
			(await page.evaluate(
				`JSON.parse(localStorage.getItem("thelounge.state.translateNotes") || "[]").includes("everywhere")`
			))
	);

	// --- 2. Background does nothing; on screen reads; opening reads. ----
	const inQuery = await say(page, QUERY, GERMAN(1));
	const live = await say(page, CHANNEL, GERMAN(2));

	await page.waitFor(translated(live), {
		label: "the line on screen is translated",
		timeout: 15000,
	});
	await page.sleep(1000);
	page.check(
		"the query in the background: no request, no entry",
		(await asked(page, "Zeile 1:")) === 0 && (await entry(page, inQuery)) === null
	);
	await open(page, QUERY);
	await page.waitFor(translated(inQuery), {
		label: "opening the query reads its line",
		timeout: 15000,
	});
	page.check(
		`opened: "${await translatedText(page, inQuery)}" is the fake's English`,
		(await translatedText(page, inQuery)).startsWith("[English]")
	);
	await open(page, CHANNEL);
	page.check(
		"reopening #seance does not translate its finished line again",
		(await asked(page, "Zeile 2:")) === 1
	);

	// --- 3. The page in the background. --------------------------------
	await setHidden(page, true);

	const hidden = await say(page, CHANNEL, GERMAN(3));

	await page.sleep(1500);
	page.check(
		"hidden: the active channel's new line is not looked at",
		(await asked(page, "Zeile 3:")) === 0 && (await entry(page, hidden)) === null
	);
	await setHidden(page, false);
	await page.waitFor(translated(hidden), {
		label: "back from the background, the line is read",
		timeout: 15000,
	});
	page.check("back: one request for it", (await asked(page, "Zeile 3:")) === 1);

	// --- 4. An exclusion. -----------------------------------------------
	await setReadingThroughSheet(page, false);

	const excluded = await say(page, CHANNEL, GERMAN(4));

	await page.sleep(1500);
	page.check(
		"excluded: the line stays as written, the exclusion is stored",
		(await asked(page, "Zeile 4:")) === 0 && (await page.evaluate(BLOB))[KEY]?.exclude === true
	);
	await setReadingThroughSheet(page, true);
	await page.waitFor(translated(excluded), {
		label: "included again, the line on screen is read",
		timeout: 15000,
	});
	await page.screenshot("2-reading");

	// --- 5. A history page above the screen. ----------------------------
	const firstHistoryId = 2000;
	const page80 = Array.from({length: 80}, (_, i) => ({
		id: firstHistoryId + i,
		type: "message",
		from: {mode: "", modes: [], away: "", lastMessage: Date.now(), nick: "moria"},
		text: `Alt ${i}: Gestern haben wir lange über das neue Projekt gesprochen und viel gelacht.`,
		self: false,
		time: new Date(Date.now() - (200 - i) * 60000).toISOString(),
		users: [],
		msgid: `seance-fake-h${i}`,
	}));

	await page.evaluate(
		`window.socket.dispatch("more", {chan: ${CHANNEL}, messages: ${JSON.stringify(
			page80
		)}.map((m) => ({...m, time: new Date(m.time)})), totalMessages: 200, moreAvailable: false})`
	);
	await page.sleep(2500);

	const historyAsked = await page.evaluate(
		`(window.__seanceTranslateFake?.requests ?? []).filter((r) => /Alt \\d+:/.test(r.text)).length`
	);

	console.log(`history requests with the page landed above the screen: ${historyAsked}`);
	page.check(
		`only lines near the screen are read (${historyAsked} of 80), never the oldest`,
		historyAsked < 80 && (await asked(page, "Alt 0:")) === 0
	);
	await page.evaluate(`document.querySelector("#chat .chat").scrollTop = 0`);
	// The fake engine streams word by word, a line or so every two seconds,
	// and what is on the visible part is read before the margin below it.
	await page.waitFor(translated(firstHistoryId), {
		label: "scrolled to the top, the oldest line is read",
		timeout: 90000,
	});

	// The order the lines were asked for: the visible part (it ends around
	// "Alt 19" at the desktop size, sooner on a phone), newest first, down
	// to the oldest, before anything in the margin below it.
	const order = await page.evaluate(
		`(window.__seanceTranslateFake?.requests ?? []).map((r) => /^Alt (\\d+):/.exec(r.text)?.[1]).filter(Boolean).map(Number)`
	);
	const oldest = order.indexOf(0);
	const belowFirst = order.slice(0, oldest).filter((n, i, all) => n > all[0]);

	console.log(`history read in this order: ${order.join(" ")}`);
	page.check(
		`the visible part is read before the margin below it (${belowFirst.length} below first)`,
		oldest >= 0 && belowFirst.length === 0
	);
	await page.screenshot("3-history-top");
	await page.evaluate(
		`(() => { const c = document.querySelector("#chat .chat"); c.scrollTop = c.scrollHeight; })()`
	);
	await page.sleep(500);

	// --- 6. A failed line is not retried behind the reader's back. -------
	const failing = await say(page, CHANNEL, `${GERMAN(6)} [fail]`);

	await page.waitFor(`${STORE}.state.translations[${failing}]?.status === "failed"`, {
		label: "the line fails",
		timeout: 15000,
	});
	await open(page, QUERY);
	await open(page, CHANNEL);
	await page.sleep(1500);
	page.check(
		"reopened: the failure stands, asked once",
		(await entry(page, failing))?.status === "failed" && (await asked(page, "Zeile 6:")) === 1
	);

	// --- 7. I also read; Translate into. ---------------------------------
	await inSettings(page, async () => {
		await page.evaluate(`(() => {
			const select = document.querySelector("#settings .translate-also-add");
			select.value = "es";
			select.dispatchEvent(new Event("change", {bubbles: true}));
		})()`);
		await page.waitFor(`!!document.querySelector("#settings .translate-also-chip")`, {
			label: "Spanish is a chip",
		});
		await page.screenshot("4-settings-also-read");
	});

	const spanish = await say(
		page,
		CHANNEL,
		"Hola a todos, mañana vamos a la playa con mis amigos y después comemos paella."
	);
	const german = await say(page, CHANNEL, GERMAN(7));

	await page.waitFor(translated(german), {label: "German is still read", timeout: 15000});
	page.check(
		"Spanish, which the user also reads, is left as written, never asked",
		(await asked(page, "Hola a todos")) === 0 &&
			(await entry(page, spanish))?.status === "skipped"
	);

	await inSettings(page, async () => {
		await page.evaluate(`(() => {
			const select = document.querySelector('#settings select[name="translateInto"]');
			select.value = "fr";
			select.dispatchEvent(new Event("change", {bubbles: true}));
		})()`);
	});
	await page.waitFor(
		`(document.querySelector("#msg-${german} .msg-translated")?.textContent ?? "").startsWith("[French]")`,
		{label: "on screen, read again into French", timeout: 15000}
	);
	await setting(page, "translateInto", "");
	await setting(page, "translateAlsoRead", []);

	// --- 8. Off: two taps from the conversation. --------------------------
	await setting(page, "translationEnabled", false);
	await page.evaluate(`localStorage.removeItem("thelounge.state.translateNotes")`);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await fabricate(page);
	await page.click("#chat .header button.menu");
	await page.click("#context-menu .context-menu-translate");
	await page.waitFor(`!!document.querySelector(".translation-sheet-enable-button")`, {
		label: "the panel is one button",
	});
	await page.screenshot("5-enable-panel");
	await page.click(".translation-sheet-enable-button");
	await page.waitFor(`!document.querySelector(".translation-sheet")`, {
		label: "the panel closes",
	});
	page.check(
		"translation is on, and Settings never opened",
		(await page.evaluate(`${STORE}.state.settings.translationEnabled`)) === true &&
			!(await page.evaluate(`!!document.querySelector(".settings-modal")`))
	);
	await page.waitFor(`!!document.querySelector(".translate-note")`, {
		label: "nothing to translate on screen: the first-run note",
		timeout: 15000,
	});
	page.check(
		"the first-run note names English",
		(await page.evaluate(
			`document.querySelector("#translate-note-lead").textContent.trim()`
		)) === EN["translate.note.firstRun"].replace("{language}", "English")
	);
	await page.screenshot("6-first-run-note");

	// Again, with a German line on screen: it is translated, no note.
	await setting(page, "translationEnabled", false);
	await page.evaluate(`localStorage.removeItem("thelounge.state.translateNotes")`);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await fabricate(page);

	const waiting = await say(page, CHANNEL, GERMAN(8));

	await page.click("#chat .header button.menu");
	await page.click("#context-menu .context-menu-translate");
	await page.waitFor(`!!document.querySelector(".translation-sheet-enable-button")`, {
		label: "the panel is one button",
	});
	await page.click(".translation-sheet-enable-button");
	await page.waitFor(translated(waiting), {
		label: "the German line on screen is translated in front of the reader",
		timeout: 15000,
	});
	await page.sleep(800);
	page.check(
		"something was translated: no first-run note",
		!(await page.evaluate(`!!document.querySelector(".translate-note")`))
	);
	page.check("no page errors", page.consoleErrors.length === 0);
}
