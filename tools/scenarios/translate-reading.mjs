// The reading pipeline in a real browser, on the in-page fake engine
// (?fakeTranslate on a non-production build) with a second user speaking
// German in #seance-translate (its own channel, not #seance, so these lines
// never land in a tester's own context) through a raw WebSocket to the dev
// ircd. Steps, in
// order: nothing is translated while reading is off, and the two German
// lines said before it is switched on -- and the page's own German line
// said then too -- are translated once it is (reading
// covers what the channel shows, not only what arrives after the switch;
// the switch-on's requeue of the backlog is let settle and every later
// count is taken against it); a German
// line gets a translated line labelled "from German" with the fake's "[English] …" echo; an
// English line gets no translation and no mark, and the toolbar's Translate
// translates it; a Spanish line in this German channel is translated from
// Spanish, not from the channel's German; a "lol" and a "hola" neither
// identifier is sure of are left alone, with nothing under them and no
// request; a short German line is translated from German; the chip's menu retranslates from another source
// (the detector's runners-up one click each, never the line's own source;
// "Retranslate from…" opens the picker, Escape asks for nothing, French
// makes the chip read "from French" and the request carry `from: "fr"`, and
// the runners-up survive that choice so one click puts it back on German);
// a five-line burst is translated and proved
// batched (the in-page request log shows one multi-line LLM request, not
// five singles, and every burst line's echo is rendered); the chip's menu
// can hide a translation; the toolbar's Translate opens a menu that
// translates one message on request or names its language first; the page's own German line is translated like anyone's; the
// translation panel opens from the channel menu as one column of
// controls of equal width, each language named in the interface's
// language (never a code) and a link to Settings, and closes on Escape; a line the fake hands back
// unchanged (its `[echo]` token) shows nothing under it at all
// and costs the engine nothing -- the next line is still translated; a
// German question the fake answers
// (its `[answer]` token) fails with "answered the question instead of translating it"; a line carrying the fake's `[fail]`
// marker fails once and its retry button succeeds the second time; a line carrying `*Betonung*` and the page's own nick keeps both
// (the chip's menu offers Copy translation and the line is selectable); a line
// naming a speaker who has since left the channel and the channel itself
// keeps both byte for byte and the fake's request log shows neither ever
// reached the engine; a
// `draft/multiline` message is translated line by line rather than losing
// all but its first; a two-line `$$…$$` display-math block survives a
// translation byte for byte, embedded line break included; switching off
// stops new ones; a REDACT of a translated line takes its translation
// away with the original text; declaring German in the panel (a chip named
// in the reader's language, gone from the picker's options) turns reading
// back on and the nine-character "So ist es" line translates from a source
// it only guesses at; a "load more" is
// translated, newest row first and no more than `HISTORY_QUEUE_CAP` of the
// page; changing the reading language in Settings re-points reading (the
// interface follows it): every translation already on screen is replaced by
// one in the new language, what arrives after the move is read into it and
// the rejoin's history too (the chip names it); and leaving the channel
// with /part and joining it again keeps the
// reading on and translates the history the rejoin loads, the page's own
// line from before the part included; and, with the channel switched off
// again at the end, the toolbar's Translate still translates one line ad
// hoc from a language picked in its menu's dialog.
// Detection is real (fastText and ELD); only the engine is scripted.
//
// The speaker negotiates message-tags + echo-message so it learns the
// msgid the server gave its own line, and batch + draft/multiline so it
// can send one multi-line message; the run flips
// CAP_draft_message_redaction on (the rig leaves it off, and without it
// REDACT answers FAIL DISABLED and the page never offers the cap) and
// back off at the end.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   (or any port, with SEANCE_HTTP=http://localhost:<port>/)
//   CHROME_BIN=/seance/tmp/chrome-pw.sh node tools/browser-drive.mjs tools/scenarios/translate-reading.mjs
//   … --mobile --width=390 --height=844
//
// Needs the dev ircd's plain-WS port on 127.0.0.1:8067. The run flips a
// server feature through an oper, so a rig whose oper is not the Docker
// default wants `SEANCE_OPER=seanceop SEANCE_OPER_PASSWORD=seance` (the
// native rig's, tools/nefarious-dev/local.conf) in the environment. NODE_ENV must be
// unset for the build: a production build compiles the fake out. The
// reading switch is thrown in the channel menu's translation panel, whose
// close button puts it away again.

import {rigFeature} from "./lib/rig-feature.mjs";
import {
	READING_ON,
	SHEET,
	TRANSLATION_OFFERED,
	closeTranslationSheet,
	openTranslationSheet,
} from "./lib/translation.mjs";

const RUN = Date.now().toString(36);
const NICK = `tr${RUN}`;
const SPEAKER = `de${RUN}`;
const CHANNEL = "#seance-translate";
const IRCD = process.env.SEANCE_IRC_WS || "ws://127.0.0.1:8067/";
const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8021/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance-translate&fakeTranslate`;

/** Init script: translation switched off by the user, unless a setting is already stored. */
const TRANSLATION_OFF = `(() => {
	try {
		const settings = JSON.parse(localStorage.getItem("settings") || "{}") || {};

		if (!("translationEnabled" in settings)) {
			settings.translationEnabled = false;
			localStorage.setItem("settings", JSON.stringify(settings));
		}
	} catch (e) {}
})()`;

const PAUSED = `!!document.getElementById("app").__vue_app__.config.globalProperties.$store.state.translation.paused`;
const LINES = `document.querySelectorAll('.msg-translated').length`;
const MOBILE = process.argv.includes("--mobile");
const REQUESTS = `(window.__seanceTranslateFake && window.__seanceTranslateFake.requests) || []`;
const STORE_TRANSLATIONS = `document.getElementById("app").__vue_app__.config.globalProperties.$store.state.translations`;
const REDACTION_FEATURE = "CAP_draft_message_redaction";
const PENDING = `Object.values(${STORE_TRANSLATIONS}).filter((e) => e.status === "pending").length`;

/** The newest row whose text includes `text`, as an expression. */
const newestRow = (text) =>
	`[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		text
	)})).pop()`;

/**
 * The done-translation count once nothing is pending and it has held still
 * for three samples. Switching reading on queues what the channel shows
 * (earlier runs' lines in #seance-translate included), so the counts after
 * it are taken against this rather than from zero.
 */
async function settledLines(page, label) {
	const samples = [];

	for (let i = 0; i < 90; i++) {
		const pending = Number(await page.evaluate(PENDING));

		samples.push(pending === 0 ? Number(await page.evaluate(LINES)) : -1);

		const last = samples.slice(-3);

		if (last.length === 3 && last[0] >= 0 && last.every((n) => n === last[0])) {
			return last[0];
		}

		await page.sleep(700);
	}

	throw new Error(`the translations never settled: ${label}`);
}

/**
 * Reading on or off: the channel menu's sheet, its reading switch, and the
 * close button puts it away.
 */
async function setReading(page, code) {
	await openPanel(page);
	await setPanelRead(page, Boolean(code));
	await closeTranslationSheet(page);
}

/** The sheet, from the channel menu's "Translation…". */
const openPanel = openTranslationSheet;

/**
 * The sheet's reading switch ("Translate messages here into …", the
 * exclusion). The language is not chosen here: it is Settings → Language's
 * "Translate into". By its class, not by label: the interface may be in
 * French by then.
 */
function setPanelRead(page, on) {
	return page.evaluate(`(() => {
		const box = document.querySelector("${SHEET} .language-sheet-read-box");

		if (box.checked !== ${on}) {
			box.click();
		}
	})()`);
}

/**
 * The reading-language override, set through Settings -> Translation:
 * "Interface and reading language" is one control (the locale setting; the
 * per-channel picker went with the unification). The interface switches to
 * the language too. Leaves through Done, which hands the view back to the
 * channel.
 */
async function setReadOverride(page, code) {
	// By its route: on a phone the footer's Settings is in the closed
	// sidebar, off the screen.
	await page.evaluate(`location.hash = "#/settings/translation"`);
	await page.waitFor(`!!document.querySelector('select[name="locale"]')`, {
		label: "the translation tab",
	});
	await page.evaluate(
		`(() => { const s = document.querySelector('select[name="locale"]'); s.value = ${JSON.stringify(
			code
		)}; s.dispatchEvent(new Event("change", {bubbles: true})); })()`
	);
	await page.click(`.settings-modal-done`);
	await page.waitFor(`!document.querySelector(".settings-modal")`, {
		label: "settings closed after the override",
	});
}

/**
 * The chip's menu. A freshly translated line sits at the bottom edge of the
 * scrollback, where the composer overlaps it, so the chip is brought into
 * the middle before it is clicked.
 */
/**
 * A line the reader leaves alone: its entry is a skip, nothing renders
 * under it and no request carried its text.
 */
async function expectLeftAlone(page, row, text, label) {
	const entry = `${STORE_TRANSLATIONS}[(${row}).id.replace(/^msg-/, "")]`;

	await page.waitFor(`!!(${row}) && (${entry})?.status === "skipped"`, {
		timeout: 15000,
		label: `${label} is left alone`,
	});
	await page.check(
		`${label} shows nothing under it`,
		await page.evaluate(`!(${row}).querySelector(".msg-translation")`)
	);
	await page.check(
		`${label} was never sent to the engine`,
		(await page.evaluate(
			`(${REQUESTS}).filter((r) => r.text.trim() === ${JSON.stringify(text)}).length`
		)) === 0
	);
}

/**
 * What a translated row says of its source, as the flipper before it tells
 * it (TranslationFlip.vue's title, English interface): "from German",
 * "sent in German", or "" with no flipper.
 */
function chipOf(row) {
	return `(() => { const r = ${row}; const f = r && r.querySelector(".msg-translate-flip"); const m = f && /^(?:Translated from (.+)\\. Show the original|Sent in (.+)\\. Show what was sent)$/.exec(f.title); return m ? (m[1] ? "from " + m[1] : "sent in " + m[2]) : ""; })()`;
}

/** A translated row's menu, from the Translate action in its toolbar. */
async function openChipMenu(page, row, label) {
	await page.evaluate(
		`document.querySelector(${JSON.stringify(row)}).scrollIntoView({block: "center"})`
	);

	if (MOBILE) {
		await page.evaluate(`document.querySelector(${JSON.stringify(row)}).click()`);
	} else {
		await page.hover(row);
	}

	await page.evaluate(
		`document.querySelector(${JSON.stringify(
			row
		)}).querySelector(".msg-action-translate").click()`
	);
	await page.waitFor(`!!document.querySelector(".context-menu-translate-retry-pick")`, {
		label,
	});
}

function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	/** The msgid the server gave each line this speaker sent, by text. */
	const msgids = new Map();
	/** Guarantees a fresh batch tag even for two calls in the same millisecond. */
	let batchSeq = 0;
	let joinedResolve;
	let joinedReject;
	const joined = new Promise((resolve, reject) => {
		joinedResolve = resolve;
		joinedReject = reject;
		setTimeout(() => reject(new Error("speaker never joined")), 20000);
	});
	// Tagged lines arrive with an `@tags` prefix in front of the source.
	const from = (command) => new RegExp(`^(?:@\\S+ )?:${nick}\\S* ${command}`);

	ws.onopen = () => {
		// echo-message + message-tags: the echo of our own PRIVMSG carries
		// the msgid REDACT needs (the live REDACT line itself has no tags).
		// batch + draft/multiline: this speaker also sends one multi-line
		// message, which the page joins into a single message.
		ws.send("CAP LS 302");
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance translation reader`);
	};
	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(line.replace("PING", "PONG"));
		} else if (/ CAP \S+ LS :/.test(line)) {
			// The last LS line only: a continuation reads `LS * :…`.
			ws.send("CAP REQ :message-tags echo-message batch draft/multiline");
		} else if (/ CAP \S+ (ACK|NAK)/.test(line)) {
			ws.send("CAP END");
		} else if (/ 001 /.test(line)) {
			ws.send(`JOIN ${CHANNEL}`);
		} else if (/ 433 /.test(line)) {
			ws.send(`NICK ${nick}_`);
		} else if (from("JOIN").test(line)) {
			joinedResolve();
		} else if (from("PRIVMSG").test(line)) {
			const tags = /^@(\S+) /.exec(line);
			const msgid = tags && /(?:^|;)msgid=([^;]+)/.exec(tags[1]);
			const body = line.indexOf(" :", line.indexOf("PRIVMSG"));

			if (msgid && body > 0) {
				msgids.set(line.slice(body + 2), msgid[1]);
			}
		}
	};
	ws.onerror = () => joinedReject(new Error("speaker socket error"));

	return {
		joined,
		say: (text) => ws.send(`PRIVMSG ${CHANNEL} :${text}`),
		// The speaker joined first, so the channel is its to set the topic of.
		topic: (text) => ws.send(`TOPIC ${CHANNEL} :${text}`),
		/** One `draft/multiline` message: the page joins the batch's lines with newlines. */
		sayMultiline(lines) {
			const tag = `ml${Date.now().toString(36)}${(batchSeq++).toString(36)}`;

			ws.send(`BATCH +${tag} draft/multiline ${CHANNEL}`);

			for (const line of lines) {
				ws.send(`@batch=${tag} PRIVMSG ${CHANNEL} :${line}`);
			}

			ws.send(`BATCH -${tag}`);
		},
		msgidOf: (text) => msgids.get(text),
		redact: (msgid) => ws.send(`REDACT ${CHANNEL} ${msgid} :tidying up`),
		quit: () => ws.send("QUIT :done"),
	};
}

export default async function run(page) {
	// Translation starts switched off by the user (settings.ts
	// translationEnabled), so the run can show the switch-on reading what
	// the channel already holds. Only an absent setting is written: once the
	// run switches it on, a reload keeps it on.
	await page.addInitScript(TRANSLATION_OFF);
	// The rig leaves message redaction off: without the feature REDACT
	// answers FAIL DISABLED and the page is never offered the cap that
	// makes it show one.
	const feature = await rigFeature(REDACTION_FEATURE, "TRUE");

	await page.check("the rig offers draft/message-redaction for this run", feature.after);

	try {
		await scenario(page);
	} finally {
		if (!feature.before) {
			await rigFeature(REDACTION_FEATURE, "FALSE");
		}
	}
}

async function scenario(page) {
	// The "load more" section needs the server to hold more history than the
	// page's join fill shows (LATEST 50), and the ircd's chathistory expires
	// within minutes, so nothing is left over from earlier runs. Before the
	// page joins, the speaker stocks the channel with more than a page of
	// German lines -- paced, so the server's fake lag never kicks in, and as
	// plain lines, since a draft/multiline batch's members do not come back
	// in chathistory.
	const other = speaker(SPEAKER);

	await other.joined;

	for (let i = 1; i <= 55; i++) {
		other.say(
			`Fuellzeile ${i} faellt in den Verlauf dieses Tests und hat genug Worte fuer die Erkennung.`
		);
		await page.sleep(300);
	}

	// Let the server settle the burst before the page's join fill reads it.
	await page.sleep(1500);

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector("#form #input")`, {
		timeout: 20000,
		label: "chat input up",
	});
	await page.check("translation starts off", !(await page.evaluate(READING_ON)));

	// A German topic before the switch: the header shows it as set while
	// reading is off, and the switch-on reads it like the lines (reader.ts
	// `readTopic`) -- in the topic's place, with a flipper before it.
	const TOPIC = ".header .topic";
	const FLIP = ".header .topic .topic-flip";
	const topicText = `(document.querySelector(${JSON.stringify(TOPIC)}) || {}).textContent || ""`;
	const topicHeight = `(document.querySelector(".header") || {}).offsetHeight`;
	const topicBefore = `Willkommen im Kanal, hier wird ueber alles Moegliche geredet ${RUN}`;

	other.topic(topicBefore);
	await page.waitFor(`(${topicText}).includes(${JSON.stringify(topicBefore)})`, {
		label: "the header shows the speaker's topic",
	});
	await page.check("no flipper while reading is off", (await page.count(FLIP)) === 0);
	const headerHeightBefore = Number(await page.evaluate(topicHeight));

	// Two German lines before the switch: nothing is translated while reading
	// is off, and switching it on translates what the channel shows -- these
	// two lines, and the backlog of earlier runs the join loaded.
	const preSwitch = [
		"Guten Tag zusammen, wie geht es euch heute?",
		"Und hier ist noch eine zweite Zeile vor dem Einschalten.",
	];

	preSwitch.forEach((line) => other.say(line));
	await page.waitFor(`document.body.innerText.includes("zweite Zeile vor dem Einschalten")`, {
		label: "both German lines arrived before the switch",
	});

	// The page's own German line, also before the switch: own lines are part
	// of what the channel shows, so the switch-on translates it as well.
	const ownBeforeMarker = `Eigenzeile${RUN}`;
	const ownBefore = `Ich schreibe selbst noch eine eigene Zeile vor dem Einschalten, ${ownBeforeMarker}.`;
	const ownBeforeRow = `[...document.querySelectorAll(".msg.self:not(.pending)")].filter((m) => m.textContent.includes(${JSON.stringify(
		ownBeforeMarker
	)})).pop()`;

	await page.fill("#input", ownBefore);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`!!(${ownBeforeRow})`, {
		timeout: 15000,
		label: "the page's own German line arrived before the switch",
	});
	await page.sleep(1500);
	await page.check("nothing translated while reading is off", (await page.evaluate(LINES)) === 0);

	// Switching translation on is the whole setup: the channel menu's
	// "Translation…" is one button while it is off, and the conversation
	// reads from then on (switch.ts `readsHere`).
	await openPanel(page);
	await page.click(`${SHEET} .translation-sheet-enable-button`);
	await page.waitFor(`!document.querySelector(${JSON.stringify(SHEET)})`, {
		label: "the enable button closed the sheet",
	});
	await page.waitFor(READING_ON, {label: "reading on"});
	await page.waitFor(TRANSLATION_OFFERED, {
		timeout: 10000,
		label: "translation offered once the probe answered",
	});
	await page.waitFor(
		preSwitch
			.map((line) => `!!(${newestRow(line)})?.querySelector('.msg-translated')`)
			.join(" && "),
		{timeout: 90000, label: "the two lines said before the switch are translated once it is on"}
	);
	await page.waitFor(`!!(${ownBeforeRow})?.querySelector('.msg-translated')`, {
		timeout: 90000,
		label: "the page's own line said before the switch is translated too",
	});
	await page.check(
		"the own line's translation is the fake's English echo",
		String(
			await page.evaluate(
				`((${ownBeforeRow}).querySelector(".msg-translated") || {}).textContent`
			)
		).includes("[English] Ich schreibe selbst")
	);

	// The topic, read with the lines: the fake's English copy stands where
	// the topic stood, the header no taller for it, and the flipper swaps
	// the two. A new topic is read again.
	await page.waitFor(`(${topicText}).includes("[English] " + ${JSON.stringify(topicBefore)})`, {
		timeout: 90000,
		label: "the switch-on translated the topic",
	});
	await page.check(
		"the translated topic takes no extra room in the header",
		Number(await page.evaluate(topicHeight)) === headerHeightBefore
	);
	await page.check("the topic has its flipper", (await page.count(FLIP)) === 1);
	await page.check(
		"the flipper offers the original",
		String(
			await page.evaluate(
				`document.querySelector(${JSON.stringify(FLIP)}).getAttribute("aria-label")`
			)
		) === "Show the original topic"
	);
	await page.check(
		"the header's tooltip carries the original while the translation shows",
		String(
			await page.evaluate(
				`document.querySelector(${JSON.stringify(TOPIC)}).getAttribute("title")`
			)
		) === topicBefore
	);
	await page.click(FLIP);
	await page.waitFor(
		`!(${topicText}).includes("[English]") && (${topicText}).includes(${JSON.stringify(
			topicBefore
		)})`,
		{
			label: "the flipper shows the original topic",
		}
	);
	await page.check(
		"the flipper then offers the translation",
		String(
			await page.evaluate(
				`document.querySelector(${JSON.stringify(FLIP)}).getAttribute("aria-label")`
			)
		) === "Show the translated topic"
	);
	await page.click(FLIP);
	await page.waitFor(`(${topicText}).includes("[English] ")`, {
		label: "the flipper shows the translation again",
	});
	await page.screenshot("translated-topic", {selector: "#chat .header"});

	const topicAfter = `Neues Thema fuer heute, bitte hoeflich bleiben ${RUN}`;

	other.topic(topicAfter);
	await page.waitFor(`(${topicText}).includes("[English] " + ${JSON.stringify(topicAfter)})`, {
		timeout: 90000,
		label: "a changed topic is read again",
	});

	// Moved on where a step adds a done line the later counts must not see
	// as theirs (Translate anyway on the English line, the Spanish line).
	let base = await settledLines(page, "the switch-on's requeue");

	other.say("Ich schicke dir gleich das Log, einen Moment bitte.");
	await page.waitFor(`${LINES} === ${base + 1}`, {timeout: 15000, label: "one translated line"});

	// The exact text repeats across every run's chathistory backlog (unlike
	// the RUN-suffixed markers below), so take the newest match, not the
	// first -- and look its chip and text up inside that row, since the
	// backlog's translations sit above it.
	const translatedRow = newestRow("Ich schicke dir gleich das Log");
	const translatedRowId = String(await page.evaluate(`(${translatedRow}).id`));
	const LINE_FLIP = `#${translatedRowId} .msg-translate-flip`;
	// The line's text: a tap on it swaps the translation and the original.
	const LINE_TEXT = `#${translatedRowId} .msg-flippable`;
	const TEXT = `#${translatedRowId} .msg-translated`;

	// Every label names its languages in the reader's language: this
	// channel is read in English, so the German line's chip is in English.
	await page.check(
		"a chip reads German → English in a channel read in English",
		(await page.evaluate(chipOf(translatedRow))) === "from German"
	);
	await page.check(
		"the fake's English echo is shown",
		String(
			await page.evaluate(`document.querySelector(${JSON.stringify(TEXT)}).textContent`)
		).includes("[English] Ich schicke dir")
	);
	await page.screenshot("translated-line");

	// A done translation stands in the original's place, at the body colour
	// (docs/resources/translation.md § Reading a channel): read the
	// reference colour rather than hard-coding hex.
	const bodyColor = String(await page.evaluate(`getComputedStyle(document.body).color`));
	await page.check(
		"the translated row carries the translated class",
		await page.evaluate(`(${translatedRow}).classList.contains("translated")`)
	);
	await page.check(
		"the translation text is the bright body colour",
		(await page.evaluate(
			`getComputedStyle(document.querySelector(${JSON.stringify(TEXT)})).color`
		)) === bodyColor
	);

	// The chip's menu can retranslate from another source. The detector's
	// runners-up are one click each; the line's own source is not among them
	// (that item would only repeat Retranslate), and "Retranslate from…"
	// opens the picker for any supported language.
	await openChipMenu(page, `#${translatedRowId}`, "the chip menu offers the source items");

	const sourceItems = await page.evaluate(
		`[...document.querySelectorAll(".context-menu-translate-retry-from")].map((i) => i.textContent.trim())`
	);

	await page.check(
		`the menu offers the detector's runners-up (${sourceItems.join(", ") || "none"})`,
		sourceItems.length > 0 &&
			sourceItems.every((label) => /^Retranslate from: \S/.test(label)) &&
			!sourceItems.includes("Retranslate from: German")
	);
	await page.screenshot("chip-menu-sources");

	const requestsBeforePicker = await page.evaluate(`(${REQUESTS}).length`);

	await page.click(".context-menu-translate-retry-pick");
	await page.waitFor(`!!document.querySelector(".source-language-picker")`, {
		label: "the source picker opened",
	});
	await page.check(
		MOBILE
			? "the picker came up as the phone's sheet"
			: "the picker came up as the desktop popover",
		(await page.evaluate(`!!document.querySelector(".source-language-picker--sheet")`)) ===
			MOBILE
	);

	const pickerRect = await page.rect(".source-language-picker");
	const pickerViewport = await page.evaluate(`({w: innerWidth, h: innerHeight})`);

	await page.check(
		"the picker lies inside the viewport",
		!!pickerRect &&
			pickerRect.x >= 0 &&
			pickerRect.y >= 0 &&
			pickerRect.x + pickerRect.width <= pickerViewport.w &&
			pickerRect.y + pickerRect.height <= pickerViewport.h
	);

	const fromLabels = await page.evaluate(
		`[...document.querySelectorAll('select[name="translateFrom"] option')].map((o) => o.textContent.trim())`
	);

	// In the interface's language, not in the language's own: an English
	// interface offers "German" (SourceLanguagePicker.vue name()).
	const fromExpected = await page.evaluate(
		`(() => {
			const names = new Intl.DisplayNames([document.documentElement.lang || "en"], {
				type: "language",
			});
			return names.of("de");
		})()`
	);

	await page.check(
		`the picker names each language in the interface's (${fromLabels.length} options)`,
		fromLabels.includes(fromExpected) &&
			!fromLabels.includes("Deutsch") &&
			fromLabels.every((label) => !/^[a-z]{2}$/i.test(label))
	);
	await page.screenshot("source-language-picker");

	// Escape closes it and asks for nothing.
	await page.evaluate(
		`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))`
	);
	await page.waitFor(`!document.querySelector(".source-language-picker")`, {
		label: "Escape closed the picker",
	});
	await page.sleep(700);
	await page.check(
		"Escape asked for no translation",
		(await page.evaluate(`(${REQUESTS}).length`)) === requestsBeforePicker
	);

	// Chosen: French. The chip says so and the request carries it.
	await openChipMenu(page, `#${translatedRowId}`, "the chip menu opened again");
	await page.click(".context-menu-translate-retry-pick");
	await page.waitFor(`!!document.querySelector(".source-language-picker")`, {
		label: "the source picker opened again",
	});
	await page.evaluate(
		`(() => { const s = document.querySelector('select[name="translateFrom"]'); s.value = "fr"; s.dispatchEvent(new Event("change", {bubbles: true})); })()`
	);
	await page.click(".source-language-picker-confirm");
	await page.waitFor(`!document.querySelector(".source-language-picker")`, {
		label: "Translate closed the picker",
	});
	await page.waitFor(`(${REQUESTS}).length > ${requestsBeforePicker}`, {
		timeout: 15000,
		label: "the chosen source went to the engine",
	});

	const frenchRequest = await page.evaluate(`(${REQUESTS})[(${REQUESTS}).length - 1]`);

	await page.check(
		`the request asked for French as the source (from: ${
			frenchRequest && frenchRequest.from
		}, to: ${frenchRequest && frenchRequest.to})`,
		!!frenchRequest && frenchRequest.from === "fr" && frenchRequest.to === "en"
	);
	// Nothing shows while the retranslation runs; it swaps in when done.
	await page.waitFor(`${chipOf(translatedRow)} === "from French"`, {
		timeout: 15000,
		label: "the flipper now reads from French",
	});
	await page.waitFor(`${LINES} === ${base + 1}`, {
		timeout: 15000,
		label: "the retranslation from French is in",
	});

	// The candidates survived the explicit source, so the detector's own
	// guess is one click away again.
	await openChipMenu(page, `#${translatedRowId}`, "the chip menu opened a third time");

	const afterItems = await page.evaluate(
		`[...document.querySelectorAll(".context-menu-translate-retry-from")].map((i) => i.textContent.trim())`
	);

	await page.check(
		`an explicit source keeps the runners-up (${afterItems.join(", ") || "none"})`,
		afterItems.includes("Retranslate from: German") &&
			!afterItems.includes("Retranslate from: French")
	);

	// And one click puts the line back on German.
	await page.evaluate(
		`[...document.querySelectorAll(".context-menu-translate-retry-from")].find((i) => i.textContent.includes("German")).click()`
	);
	await page.waitFor(`${chipOf(translatedRow)} === "from German"`, {
		timeout: 15000,
		label: "the one-click candidate put it back on German",
	});
	await page.waitFor(`${LINES} === ${base + 1}`, {
		timeout: 15000,
		label: "the German line is translated",
	});

	const germanRequest = await page.evaluate(`(${REQUESTS})[(${REQUESTS}).length - 1]`);

	await page.check(
		`the one-click candidate asked for German (from: ${germanRequest && germanRequest.from})`,
		!!germanRequest && germanRequest.from === "de"
	);

	other.say("this one is already in english so it needs no line at all");
	await page.waitFor(`document.body.innerText.includes("needs no line at all")`, {
		label: "English line arrived",
	});
	await page.sleep(1500);
	await page.check(
		"an English line gets no translation",
		(await page.evaluate(LINES)) === base + 1
	);

	// A line the detector places in the reading language shows nothing: in
	// a channel that writes it, a mark on every line would be noise. The
	// toolbar's Translate still translates it.
	const englishRow = newestRow("needs no line at all");
	const englishRowId = String(await page.evaluate(`(${englishRow}).id`));
	const englishEntry = `document.getElementById("app").__vue_app__.config.globalProperties.$store.state.translations[${JSON.stringify(
		englishRowId.replace(/^msg-/, "")
	)}]`;

	await page.waitFor(`(${englishEntry})?.status === "skipped"`, {
		timeout: 15000,
		label: "the pipeline left the English line alone",
	});
	await page.check(
		"the English line carries no mark, no text row and keeps its ink",
		await page.evaluate(
			`!document.querySelector(${JSON.stringify(
				`#${englishRowId} .msg-translation-skipped`
			)}) && !document.querySelector(${JSON.stringify(
				`#${englishRowId} .msg-translation`
			)}) && !document.getElementById(${JSON.stringify(
				englishRowId
			)}).classList.contains("translated")`
		)
	);
	await page.screenshot("skipped-unmarked");

	if (MOBILE) {
		await page.evaluate(`document.getElementById(${JSON.stringify(englishRowId)}).click()`);
	} else {
		await page.hover(`#${englishRowId}`);
	}

	await page.evaluate(
		`document.getElementById(${JSON.stringify(
			englishRowId
		)}).querySelector(".msg-action-translate").click()`
	);
	await page.waitFor(`!!document.querySelector(".context-menu-translate-now")`, {
		label: "the toolbar's Translate opened its menu",
	});
	await page.click(".context-menu-translate-now");
	await page.waitFor(
		`!!document.querySelector(${JSON.stringify(`#${englishRowId} .msg-translated`)})`,
		{timeout: 20000, label: "the toolbar's Translate produced a translation"}
	);
	await page.check(
		"the translation is there",
		await page.evaluate(
			`document.querySelector(${JSON.stringify(
				`#${englishRowId} .msg-translated`
			)}).textContent.includes("[English] this one is already")`
		)
	);
	// That translation is a done line the later counts must not see as theirs.
	base += 1;
	await page.check("one more done line", (await page.evaluate(LINES)) === base + 1);

	// A Spanish line in a channel that has written German all along: both
	// identifiers call it Spanish, so it is translated from Spanish -- not
	// "probably German" from this channel's prior.
	const spanish = "claude es muy lento estos días";

	other.say(spanish);
	await page.waitFor(`${LINES} === ${base + 2}`, {
		timeout: 20000,
		label: "the Spanish line is translated",
	});
	await page.check(
		"its chip names Spanish",
		String(await page.evaluate(chipOf(newestRow(spanish)))).trim() === "from Spanish"
	);

	const spanishRequests = await page.evaluate(
		`(${REQUESTS}).filter((r) => r.text.indexOf(${JSON.stringify(
			spanish
		)}) !== -1).map((r) => ({from: r.from}))`
	);

	await page.check(
		`its request asked for Spanish as the source (${JSON.stringify(spanishRequests)})`,
		Array.isArray(spanishRequests) &&
			spanishRequests.length > 0 &&
			spanishRequests.every((r) => r.from === "es")
	);
	base += 1;

	// A short German line ("ja so gut", nine characters): fastText barely
	// ranks it, but ELD calls it German and reliable, and English is not
	// among fastText's contenders, so it is placed German and translated
	// *from* German. No RUN marker fits under ten characters, so the rows with
	// this text are counted first and the new one is the newest.
	const unsureLine = "ja so gut";
	const unsureRows = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		unsureLine
	)}))`;
	const unsureBefore = await page.evaluate(`${unsureRows}.length`);

	other.say(unsureLine);
	await page.waitFor(`${unsureRows}.length > ${unsureBefore}`, {
		timeout: 15000,
		label: "the short German line arrived",
	});

	const unsureRowId = String(await page.evaluate(`${unsureRows}.pop().id`));

	// The engine places it and the line translates.
	await page.waitFor(
		`!!document.querySelector(${JSON.stringify(`#${unsureRowId} .msg-translated`)})`,
		{timeout: 20000, label: "the short German line translated"}
	);
	await page.check(
		"the short line's chip names German",
		(
			await page.evaluate(chipOf(`document.getElementById(${JSON.stringify(unsureRowId)})`))
		).trim() === "from German"
	);
	const unsureRequests = await page.evaluate(
		`(${REQUESTS}).filter((r) => r.text.indexOf(${JSON.stringify(
			unsureLine
		)}) !== -1).map((r) => ({from: r.from}))`
	);
	await page.check(
		`its request asked for German as the source (${JSON.stringify(unsureRequests)})`,
		Array.isArray(unsureRequests) &&
			unsureRequests.length > 0 &&
			unsureRequests.every((r) => r.from === "de")
	);
	base += 1;
	await page.check("one more done line", (await page.evaluate(LINES)) === base + 1);

	// Two words neither identifier is sure of ("lol"; "hola", which fastText
	// ranks English first): both left alone. Handed to the engine, a "lol"
	// came back "from Polish".
	for (const word of ["lol", "hola"]) {
		const rows = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
			word
		)}))`;
		const before = await page.evaluate(`${rows}.length`);

		other.say(word);
		await page.waitFor(`${rows}.length > ${before}`, {
			timeout: 15000,
			label: `"${word}" arrived`,
		});
		await expectLeftAlone(page, `${rows}.pop()`, word, `"${word}"`);
	}

	const requestsBeforeBurst = await page.evaluate(`(${REQUESTS}).length`);

	for (let i = 1; i <= 5; i++) {
		other.say(`Zeile ${i} von fünf, alle sollten übersetzt werden.`);
	}

	await page.waitFor(`${LINES} === ${base + 6}`, {timeout: 20000, label: "burst translated"});

	// On the LLM route the burst is batched into one multi-line request,
	// not five independent translations: the request log
	// (client/js/translate/fakePort.ts) shows a request with `lines >= 2`,
	// and fewer requests than burst lines overall -- the tell for the
	// per-line fallback never firing. A seq2seq route (OPUS-MT, the default
	// for German → English) takes one line a request by design: there each
	// line goes once.
	const burstRequests = await page.evaluate(`(${REQUESTS}).slice(${requestsBeforeBurst})`);
	const burstEngines = [...new Set(burstRequests.map((r) => r.engine))];

	await page.check(
		burstEngines.includes("llm")
			? `the burst was batched, not five singles (${
					burstRequests.length
			  } requests, lines per request: ${burstRequests.map((r) => r.lines).join(",")})`
			: `the burst went to ${burstEngines.join(", ")} one line a request, each once (${
					burstRequests.length
			  } requests)`,
		burstEngines.includes("llm")
			? burstRequests.some((r) => r.lines >= 2) && burstRequests.length < 5
			: burstRequests.length === 5 && new Set(burstRequests.map((r) => r.text)).size === 5
	);

	for (let i = 1; i <= 5; i++) {
		await page.check(
			`burst line ${i} shows its own translation`,
			await page.evaluate(
				`document.body.innerText.includes(${JSON.stringify(
					`[English] Zeile ${i} von fünf`
				)})`
			)
		);
	}

	// The channel now mostly writes German: the translate panel's language
	// list (the chip opens the panel, its language button the sheet) lists
	// it under "Spoken in … lately".
	await page.click("#form #translate-once");
	await page.waitFor(`!!document.querySelector(".translate-panel")`, {
		label: "the translate panel",
	});
	await page.click("#form .translate-panel-language");
	await page.waitFor(`!!document.querySelector(".language-sheet")`, {
		label: "the language sheet",
	});
	await page.check(
		"the sheet lists German as spoken here lately",
		await page.evaluate(
			`[...document.querySelectorAll(".language-sheet-chip")].some((c) => c.textContent.trim() === "German")`
		)
	);
	await page.evaluate(
		`document.querySelector(".language-sheet").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))`
	);
	await page.waitFor(`!document.querySelector(".language-sheet")`, {label: "the sheet closed"});
	await page.click("#form .translate-panel-cancel");
	await page.waitFor(`!document.querySelector(".translate-panel")`, {label: "the panel closed"});

	// The translated row's menu (its toolbar's Translate): swap first, then
	// Copy translation.
	await openChipMenu(page, `#${translatedRowId}`, "the translation menu open");
	await page.check(
		"the menu offers the original first and Copy translation second",
		await page.evaluate(
			`!!document.querySelector("#context-menu-item-0.context-menu-translate-flip") && !!document.querySelector("#context-menu-item-1.context-menu-translate-copy")`
		)
	);
	// Copy closes the menu (and copies; nothing here reads the clipboard).
	await page.click(".context-menu-translate-copy");
	await page.waitFor(`!document.querySelector("#context-menu-container")`, {
		label: "the menu closed",
	});
	await page.check(
		"the translated line is selectable",
		(await page.evaluate(
			`getComputedStyle(document.querySelector(${JSON.stringify(TEXT)})).userSelect`
		)) === "text"
	);
	await page.check(
		"the translation stands in the original's place",
		await page.evaluate(
			`(${translatedRow}).querySelector(".content .msg-translated").textContent.trim().startsWith("[English]") && !!(${translatedRow}).querySelector(".content > .msg-translated")`
		)
	);
	// A tap on the text swaps the original back.
	await page.click(LINE_TEXT);
	await page.waitFor(`${LINES} === ${base + 5}`, {label: "one translation swapped back"});
	await page.check(
		"the tap shows the original, at the line's own colour",
		(await page.evaluate(`(${translatedRow}).classList.contains("translated")`)) === false &&
			(await page.evaluate(
				`!(${translatedRow}).querySelector(".msg-translated") && !(${translatedRow}).querySelector(".content").textContent.includes("[English]")`
			)) &&
			(await page.evaluate(
				`getComputedStyle((${translatedRow}).querySelector(".content")).color`
			)) === bodyColor
	);
	await page.check(
		"the marker stays, dimmed, and says a tap brings the translation back",
		(await page.evaluate(
			`(() => { const f = document.querySelector(${JSON.stringify(
				LINE_FLIP
			)}); return f.classList.contains("original") && f.title === "Show the translation" && f.tagName === "SPAN"; })()`
		)) === true
	);

	// No word floor: a two-word line both identifiers call German translates
	// by itself, from German. Like "ja so gut" above, no RUN marker fits, so
	// the rows with this text are counted first and the new one is newest.
	const shortAsk = "ist gut";
	const shortRows = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		shortAsk
	)}))`;
	const shortBefore = await page.evaluate(`${shortRows}.length`);

	other.say(shortAsk);
	await page.waitFor(`${shortRows}.length > ${shortBefore}`, {
		timeout: 15000,
		label: "the two-word line arrived",
	});

	const shortRowId = String(await page.evaluate(`${shortRows}.pop().id`));

	await page.waitFor(
		`!!document.querySelector(${JSON.stringify(`#${shortRowId} .msg-translated`)})`,
		{timeout: 20000, label: "the two-word line is translated by itself"}
	);
	await page.check(
		"the two-word line's chip names German",
		(
			await page.evaluate(chipOf(`document.getElementById(${JSON.stringify(shortRowId)})`))
		).trim() === "from German"
	);

	const shortRequests = await page.evaluate(
		`(${REQUESTS}).filter((r) => r.text.indexOf(${JSON.stringify(
			shortAsk
		)}) !== -1).map((r) => ({from: r.from}))`
	);

	await page.check(
		`its request asked for German as the source (${JSON.stringify(shortRequests)})`,
		Array.isArray(shortRequests) &&
			shortRequests.length > 0 &&
			shortRequests.every((r) => r.from === "de")
	);

	// The toolbar's Translate on a line the pipeline leaves alone, once more.
	const toolbarAsk = `one more line in english for the toolbar ${RUN}`;

	other.say(toolbarAsk);
	await page.waitFor(`!!(${newestRow(toolbarAsk)})`, {label: "the toolbar line arrived"});

	const shortAskRow = `document.getElementById(${JSON.stringify(
		String(await page.evaluate(`(${newestRow(toolbarAsk)}).id`))
	)})`;

	await page.waitFor(
		`document.getElementById("app").__vue_app__.config.globalProperties.$store.state.translations[(${shortAskRow}).id.replace(/^msg-/, "")]?.status === "skipped"`,
		{timeout: 15000, label: "the pipeline left the English line alone"}
	);

	if (MOBILE) {
		await page.evaluate(`${shortAskRow}.click()`);
	} else {
		await page.hover(`#${await page.evaluate(`${shortAskRow}.id`)}`);
	}

	// The action opens a menu: translate now, or name the line's language
	// first.
	await page.evaluate(`${shortAskRow}.querySelector(".msg-action-translate").click()`);
	await page.waitFor(`!!document.querySelector(".context-menu-translate-now")`, {
		label: "the toolbar's Translate opened its menu",
	});
	await page.check(
		"the menu offers naming the line's language too",
		(await page.count(".context-menu-translate-from-pick")) === 1
	);
	await page.click(".context-menu-translate-now");
	await page.waitFor(`${LINES} === ${base + 7}`, {timeout: 15000, label: "translate on request"});
	await page.screenshot("translated-burst");

	// The page's own line is read like anyone's: a live German line from the
	// page gets its translation (no write target is set, so there is no
	// read-back for it to keep).
	const ownMarker = `Eigennachricht${RUN}`;
	const ownLine = `Ich sende hier einen langen deutschen Satz zum Testen der ${ownMarker} für eigene Nachrichten.`;

	await page.fill("#input", ownLine);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`document.body.innerText.includes(${JSON.stringify(ownMarker)})`, {
		timeout: 10000,
		label: "own line sent",
	});

	const ownRow = `[...document.querySelectorAll(".msg.self:not(.pending)")].filter((m) => m.textContent.includes(${JSON.stringify(
		ownMarker
	)})).pop()`;

	await page.waitFor(`!!(${ownRow}) && !!(${ownRow}).querySelector('.msg-translated')`, {
		timeout: 15000,
		label: "the own line is translated",
	});
	await page.check(
		"the own line added exactly one done line",
		(await page.evaluate(LINES)) === base + 8
	);
	await page.check(
		"the own row's chip reads sent in German",
		(await page.evaluate(chipOf(ownRow))) === "sent in German"
	);

	// The sheet: opened from the channel menu, full language names, closes
	// on Escape.
	await openPanel(page);

	const panelRect = await page.rect(SHEET);
	const viewport = await page.evaluate(`({w: innerWidth, h: innerHeight})`);

	await page.check(
		`the sheet is tall enough (${panelRect ? panelRect.height : "none"}px)`,
		!!panelRect && panelRect.height > 40
	);
	await page.check(
		"the sheet lies inside the viewport",
		!!panelRect &&
			panelRect.x >= 0 &&
			panelRect.y >= 0 &&
			panelRect.x + panelRect.width <= viewport.w &&
			panelRect.y + panelRect.height <= viewport.h
	);

	await page.check(
		"the footer links to Settings -> Translation",
		String(
			await page.evaluate(
				`(document.querySelector(${JSON.stringify(
					`${SHEET} .translation-sheet-settings`
				)}) || {}).getAttribute("href")`
			)
		).endsWith("/settings/translation")
	);

	// Opened from the menu, the sheet is on its switches: the language list
	// stays closed until Write in's language asks for it.
	await page.check(
		"the menu's sheet opens on its switches, the list closed",
		(await page.count(`${SHEET} .language-sheet-list`)) === 0 &&
			(await page.count(`${SHEET} .language-sheet-read-box`)) === 1
	);

	await page.screenshot("translation-sheet");

	const readLabel = String(
		await page.evaluate(
			`document.querySelector(${JSON.stringify(
				`${SHEET} .language-sheet-read`
			)})?.textContent.trim() ?? ""`
		)
	);
	// translate.panel.readHere: "Translate messages here into {language}".
	const READ_LEAD = "Translate messages here into ";
	const readingEndonym = await page.evaluate(
		`new Intl.DisplayNames([navigator.language], {type: "language"}).of(navigator.language.split("-")[0])`
	);

	await page.check(
		`the reading section names the language in itself (${readLabel})`,
		// The language comes from the interface (the unified setting), and
		// the label carries its endonym — "English", never the bare code.
		readLabel.startsWith(READ_LEAD) &&
			readLabel.endsWith(readingEndonym) &&
			!/^[a-z]{2}$/i.test(readLabel.replace(READ_LEAD, ""))
	);

	// A real key press: Escape reaches the sheet through the app's own
	// binding (App.vue, helpers/escapeLayer.ts), not a listener of its own.
	for (const type of ["keyDown", "keyUp"]) {
		await page.send("Input.dispatchKeyEvent", {
			type,
			key: "Escape",
			code: "Escape",
			windowsVirtualKeyCode: 27,
			nativeVirtualKeyCode: 27,
		});
	}

	await page.waitFor(`!document.querySelector(${JSON.stringify(SHEET)})`, {
		timeout: 5000,
		label: "the sheet closes on Escape",
	});

	// A line carrying the fake's failure token fails once; the retry
	// button succeeds the second time.
	const failMarker = `Wiederholungsprobe${RUN}`;
	const failLine = `Dies ist ein langer deutscher Testsatz mit einem [fail] Marker für die ${failMarker}.`;

	other.say(failLine);

	const failRow = `[...document.querySelectorAll(".msg")].find((m) => m.textContent.includes(${JSON.stringify(
		failMarker
	)}))`;

	await page.waitFor(
		`!!(${failRow}) && !!(${failRow}).querySelector('.msg-translation[data-status="failed"]')`,
		{timeout: 15000, label: "the marked line fails once"}
	);
	await page.check(
		"the failed line offers a retry button",
		await page.evaluate(`!!(${failRow}).querySelector(".msg-translation-retry")`)
	);
	await page.evaluate(
		`(${failRow}).querySelector(".msg-translation-retry").scrollIntoView({block: "center"})`
	);
	await page.screenshot("failed-retry");
	await page.click(`#${await page.evaluate(`(${failRow}).id`)} .msg-translation-retry`);
	await page.waitFor(`!!(${failRow}) && !!(${failRow}).querySelector('.msg-translated')`, {
		timeout: 15000,
		label: "the retry succeeds",
	});
	await page.check(
		"the retried translation carries the English echo",
		await page.evaluate(
			`(${failRow}).querySelector(".msg-translated").textContent.includes("[English]")`
		)
	);
	await page.check(
		"the retry added exactly one done line",
		(await page.evaluate(LINES)) === base + 9
	);

	// The names in the channel are protected and the emphasis survives: the
	// fake echoes what it was given, so the translated line still carries
	// the emphasis (rendered, as in the original) and the page's own nick.
	// The nick travels as a placeholder; the marks reach the LLM route as
	// `*…*` themselves (spans.ts `LLM_MARKERS`, and the composer scenario
	// pins the form the request carries), which is why what comes back has
	// to be rendered emphasis either way.
	const emphasisMarker = `Betonungsprobe${RUN}`;

	other.say(
		`Hallo ${NICK}, das ist *Betonung* in der ${emphasisMarker} und danach folgt noch mehr Text.`
	);

	const emphasisRow = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		emphasisMarker
	)})).pop()`;

	await page.waitFor(
		`!!(${emphasisRow}) && !!(${emphasisRow}).querySelector('.msg-translated')`,
		{timeout: 15000, label: "the emphasised line is translated"}
	);
	await page.check(
		"the emphasis survived and renders as emphasis in the translation",
		(await page.evaluate(
			`((${emphasisRow}).querySelector(".msg-translated .irc-italic") || {}).textContent`
		)) === "Betonung"
	);
	await page.check(
		"the page's own nick came back untouched",
		await page.evaluate(
			`(${emphasisRow}).querySelector(".msg-translated").textContent.includes(${JSON.stringify(
				NICK
			)})`
		)
	);

	// A name is a name whoever holds it and a channel name is an address:
	// neither ever reaches the model. The nick here belongs to someone who
	// spoke and then left, so the user list no longer has them -- which is
	// exactly the case the user list alone used to miss -- and the channel
	// name is one nothing fenced at all before. The proof is the request
	// the fake logged: the protected text carries placeholders where both
	// were, while the rendered translation carries them byte for byte.
	const goneNick = `weg${RUN}`;
	const gone = speaker(goneNick);

	await gone.joined;
	gone.say("Ich bin nur kurz da und sage schnell noch etwas dazu.");
	await page.waitFor(`${newestRow("Ich bin nur kurz da")} !== undefined`, {
		timeout: 15000,
		label: "the departing speaker's line arrived",
	});
	gone.quit();
	await page.waitFor(`!document.querySelector('.userlist .user[data-name="${goneNick}"]')`, {
		timeout: 15000,
		label: "the speaker left the user list",
	});

	const nameMarker = `Namensprobe${RUN}`;

	other.say(
		`Frag doch mal ${goneNick} im ${CHANNEL} nach der ${nameMarker}, er weiß da sicher Bescheid.`
	);

	const nameRow = newestRow(nameMarker);

	await page.waitFor(`!!(${nameRow}) && !!(${nameRow}).querySelector('.msg-translated')`, {
		timeout: 20000,
		label: "the line naming a departed nick and a channel is translated",
	});

	const nameTranslation = await page.evaluate(
		`(${nameRow}).querySelector(".msg-translated").textContent`
	);

	await page.check(
		"the departed speaker's nick came back byte for byte",
		nameTranslation.includes(goneNick)
	);
	await page.check("the channel name came back byte for byte", nameTranslation.includes(CHANNEL));

	const nameRequest = await page.evaluate(
		`JSON.stringify((${REQUESTS}).filter((r) => (r.text || "").includes(${JSON.stringify(
			nameMarker
		)})).pop() || null)`
	);
	const nameRequestText = nameRequest ? JSON.parse(nameRequest).text : "";

	await page.check(
		`the nick never reached the engine (request text: ${JSON.stringify(nameRequestText)})`,
		nameRequestText !== "" && !nameRequestText.includes(goneNick)
	);
	await page.check(
		"the channel name never reached the engine",
		nameRequestText !== "" && !nameRequestText.includes(CHANNEL)
	);
	await page.check(
		"both travelled as placeholders",
		(nameRequestText.match(/\u27e6\s*\d+\s*\u27e7/g) || []).length >= 2
	);

	// A draft/multiline message is one message with newlines in it: every
	// line of it is translated, not just the first.
	const multiMarker = `Mehrzeiler${RUN}`;
	const multiLines = [
		`Erste Zeile vom ${multiMarker} mit genügend Worten darin.`,
		`Zweite Zeile vom ${multiMarker} und noch ein paar Worte mehr.`,
		`Dritte Zeile vom ${multiMarker}, damit ist dann Schluss.`,
	];

	other.sayMultiline(multiLines);

	const multiRow = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		multiMarker
	)})).pop()`;

	await page.waitFor(`!!(${multiRow})`, {
		timeout: 15000,
		label: "the multi-line message arrived",
	});
	await page.check(
		"the three lines arrived as one message",
		await page.evaluate(
			multiLines
				.map((l) => `(${multiRow}).textContent.includes(${JSON.stringify(l)})`)
				.join(" && ")
		)
	);
	await page.waitFor(`!!(${multiRow}) && !!(${multiRow}).querySelector('.msg-translated')`, {
		timeout: 25000,
		label: "the multi-line message is translated",
	});

	for (const line of multiLines) {
		await page.check(
			`the multi-line translation carries "${line.slice(0, 24)}…"`,
			await page.evaluate(
				`(${multiRow}).querySelector(".msg-translated").textContent.includes(${JSON.stringify(
					`[English] ${line}`
				)})`
			)
		);
	}

	await page.screenshot("translated-multiline");

	// nefarious2 charges a per-connection cooldown after a delivered
	// draft/multiline batch and silently drops the opener of one started
	// inside that window (its lines still arrive, just unbatched) --
	// documented in CLAUDE.md's multiline section. The speaker's previous
	// batch just landed, so the next one waits it out.
	await page.sleep(5000);

	// Display TeX spanning a two-line `$$…$$` block: the fences and the
	// content between them are never sent for translation and come back
	// byte for byte (the embedded line break included), with the prose
	// around them translated as usual.
	const mathMarker = `Mathezeile${RUN}`;
	const mathLines = [
		`Hier folgt eine Formel namens ${mathMarker}: $$\\int_0^1 x\\,dx`,
		`$$ und das war die Formel.`,
	];

	other.sayMultiline(mathLines);

	const mathRow = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		mathMarker
	)})).pop()`;

	await page.waitFor(`!!(${mathRow})`, {
		timeout: 15000,
		label: "the math-block message arrived",
	});
	await page.waitFor(`!!(${mathRow}) && !!(${mathRow}).querySelector('.msg-translated')`, {
		timeout: 25000,
		label: "the math-block message is translated",
	});

	// The `$$…$$` fences are markdown syntax, stripped by the renderer like
	// any other marker (`*bold*` doesn't show its asterisks either): the
	// TeX renders through the same `MathSpan`/KaTeX path any other display
	// math does, raw TeX until the KaTeX chunk lands and rendered markup
	// after -- so byte-for-byte survival is proved structurally (a
	// `.md-math-block` span exists at all, rather than the fences and the
	// backslashes showing up as mangled prose) and the surrounding words
	// are proved by the ordinary translated-line check.
	await page.check(
		"the display math survived as its own span, not mangled into prose",
		await page.evaluate(`!!(${mathRow}).querySelector(".msg-translated .md-math-block")`)
	);
	await page.check(
		"the prose around the math block was translated",
		await page.evaluate(
			`(${mathRow}).querySelector(".msg-translated").textContent.includes("[English]") && (${mathRow}).querySelector(".msg-translated").textContent.includes(${JSON.stringify(
				mathMarker
			)})`
		)
	);
	await page.screenshot("translated-math-block");

	// Off again: a new German line gets nothing.
	await setReading(page, "");
	await page.waitFor(`!(${READING_ON})`, {label: "reading off"});
	other.say("Nach dem Ausschalten passiert hier nichts mehr.");
	await page.waitFor(`document.body.innerText.includes("passiert hier nichts mehr")`, {
		label: "post-switch line arrived",
	});
	await page.sleep(1500);

	// base + 14: the nine of the count above, the emphasised line, the two
	// of the departed-nick step, the multi-line message and the math block.
	const afterOff = await page.evaluate(LINES);

	await page.check(
		`no translation after switching off (${afterOff} vs ${base + 14})`,
		afterOff === base + 14
	);

	// A deleted message keeps neither its text nor its translation: the
	// speaker redacts one of its own translated lines (an unauthenticated
	// author may redact its own message with no window) and the row loses
	// the translated copy with the original.
	const burstText = "Zeile 5 von fünf, alle sollten übersetzt werden.";
	const burstMsgid = other.msgidOf(burstText);

	await page.check(
		`the speaker learned its line's msgid (${burstMsgid ?? "none"})`,
		!!burstMsgid
	);

	// The row is found before the REDACT: afterwards its text is behind the
	// "deleted" button and no longer in textContent. The last match, not the
	// first: #seance-translate keeps its history, so earlier runs of this scenario are
	// replayed above this one's line (their rows carry negative ids).
	const burstRowId = await page.evaluate(
		`(([...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes("Zeile 5 von fünf")).pop()) || {}).id || ""`
	);
	const burstRow = `document.getElementById(${JSON.stringify(burstRowId)})`;

	await page.check(
		`the burst line's row was found (${burstRowId || "none"}) with its translation`,
		await page.evaluate(`!!(${burstRow}) && !!(${burstRow}).querySelector(".msg-translated")`)
	);

	other.redact(burstMsgid);
	await page.waitFor(`!!(${burstRow}) && !!(${burstRow}).querySelector(".msg-redacted")`, {
		timeout: 15000,
		label: "the redacted row shows the deleted button",
	});
	await page.check(
		"the deleted row keeps no translation",
		await page.evaluate(
			`!(${burstRow}).querySelector(".msg-translation, .msg-translated, .msg-translate-flip")`
		)
	);
	const afterRedact = await page.evaluate(LINES);

	await page.check(
		`the redaction took exactly one translated line away (${afterRedact} vs ${base + 13})`,
		afterRedact === base + 13
	);
	await page.screenshot("redacted-translation");

	// Reading is off by now: the sheet's own switch turns it back on.
	await openPanel(page);
	await setPanelRead(page, true);
	await closeTranslationSheet(page);
	await page.waitFor(READING_ON, {label: "reading is on again"});

	// Switching on again queues what the channel shows once more.
	const reBase = await settledLines(page, "the second switch-on's requeue");

	// Nine characters, three words: both identifiers call it German. German
	// is the channel's language lately, though the verdict does not need it.
	const shortLine = "So ist es";

	other.say(shortLine);
	await page.waitFor(`${LINES} === ${reBase + 1}`, {
		timeout: 20000,
		label: "the short German line is translated",
	});

	const shortRow = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		shortLine
	)})).pop()`;

	await page.check(
		"the short line's chip names German",
		(await page.evaluate(chipOf(shortRow))) === "from German"
	);

	// History the reader asks for: a "load more" is translated once it is in
	// view, newest line first, and at most HISTORY_QUEUE_CAP of it a scan
	// (client/js/translate/reader.ts `scanOnScreen`).
	const HISTORY_QUEUE_CAP = 40;

	await page.check(
		"there are older messages to load",
		(await page.evaluate(
			`(() => { const el = document.querySelector("#chat .show-more"); return el ? getComputedStyle(el).display : "none"; })()`
		)) !== "none"
	);

	// The order the rows gain a translation entry in is the order the reader
	// queued them in: an entry is committed per line as it is queued. Watched
	// from before the load, so nothing is missed by looking too late.
	await page.evaluate(
		`(() => {
			window.__seanceTranslationOrder = [];
			const store = document.getElementById("app").__vue_app__.config.globalProperties.$store;
			const seen = new Set(Object.keys(store.state.translations).map((id) => "msg-" + id));

			// A line is queued as its entry is committed; nothing renders
			// until it is done, so the commits are what tells the order.
			store.subscribe((mutation) => {
				const id = mutation.type === "translationEntry" && mutation.payload && "msg-" + mutation.payload.id;

				if (id && !seen.has(id)) {
					seen.add(id);
					window.__seanceTranslationOrder.push(id);
				}
			});
		})()`
	);

	const rowsBefore = Number(
		await page.evaluate(`document.querySelectorAll("#chat .msg").length`)
	);
	const topBefore = String(
		await page.evaluate(`(document.querySelector("#chat .msg") || {}).id || ""`)
	);
	const doneBefore = Number(await page.evaluate(LINES));

	// Clicked where it stands: scrolling the scrollback to the top would let
	// MessageList's own IntersectionObserver fire a second load on top of
	// this one, and the page's size is what the assertions below count.
	await page.evaluate(`document.querySelector("#chat .show-more button").click()`);
	await page.waitFor(`document.querySelectorAll("#chat .msg").length > ${rowsBefore}`, {
		timeout: 20000,
		label: "a page of older messages arrived",
	});
	// Only what is in view is read (onScreen.ts): bring the loaded page's
	// newest rows onto the screen, as reading back to the button would --
	// the row that was the top before the load at the bottom of the view.
	await page.evaluate(
		`document.getElementById(${JSON.stringify(topBefore)}).scrollIntoView({block: "end"})`
	);
	await page.waitFor(`${LINES} > ${doneBefore}`, {
		timeout: 30000,
		label: "the loaded history is translated",
	});
	await page.sleep(6000);

	const loaded = await page.evaluate(
		`(() => {
			const rows = [...document.querySelectorAll("#chat .msg")];
			const found = rows.findIndex((m) => m.id === ${JSON.stringify(topBefore)});
			const ids = rows.slice(0, found < 0 ? 0 : found).map((m) => m.id);
			const order = (window.__seanceTranslationOrder || [])
				.filter((id) => ids.includes(id))
				.map((id) => ids.indexOf(id));

			return {
				count: ids.length,
				order,
				done: document.querySelectorAll('.msg-translated').length,
			};
		})()`
	);

	await page.check(
		`the load brought ${loaded.count} older rows and queued ${loaded.order.length} of them`,
		loaded.count > 0 && loaded.order.length >= 2
	);
	await page.check(
		`the newest of them was queued first (row indexes ${loaded.order.join(", ")})`,
		loaded.order.every((index, i) => i === 0 || index < loaded.order[i - 1])
	);
	await page.check(
		`at most HISTORY_QUEUE_CAP of the page was queued (${
			loaded.done - doneBefore
		} translated, page of ${loaded.count})`,
		loaded.done - doneBefore <= HISTORY_QUEUE_CAP &&
			loaded.order.every((index) => index >= loaded.count - HISTORY_QUEUE_CAP)
	);
	await page.screenshot("translated-history");
	// What the load left queued finishes first, so the echo step below counts
	// its own lines alone.
	await settledLines(page, "the loaded page's queue");

	// An answer equal to the line is not a translation: the `[echo]` token
	// makes the fake hand the text back, which fails the line -- and it is
	// the answer's failure, not the engine's, so it counts toward no pause
	// and the next normal line is still translated. Sent one at a time: two
	// lines in flight together would be batched, and then the second would
	// be echoed too.
	const echoMarker = `Echoprobe${RUN}`;

	other.say(
		`Dies ist ein langer deutscher Testsatz mit einem [echo] Marker für die ${echoMarker}.`
	);

	const echoRow = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		echoMarker
	)})).pop()`;

	const echoEntry = `document.getElementById("app").__vue_app__.config.globalProperties.$store.state.translations[(${echoRow}).id.replace(/^msg-/, "")]`;

	await page.waitFor(`!!(${echoRow}) && (${echoEntry})?.status === "failed"`, {
		timeout: 20000,
		label: "the echoed line fails",
	});
	await page.check(
		"the store records the line came back unchanged",
		(await page.evaluate(`(${echoEntry}).error`)) === "came back unchanged"
	);
	// A line handed back as it was is the line to read: no chip, no
	// reason, no mark under it.
	await page.check(
		"the echoed line shows nothing under it",
		await page.evaluate(`!(${echoRow}).querySelector(".msg-translation")`)
	);
	await page.evaluate(`(${echoRow}).scrollIntoView({block: "center"})`);
	await page.screenshot("echoed-translation");

	const doneBeforeNext = Number(await page.evaluate(LINES));
	const afterEchoMarker = `Nachechoprobe${RUN}`;

	other.say(`Und dies ist wieder ein ganz normaler deutscher Satz für die ${afterEchoMarker}.`);

	const afterEchoRow = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		afterEchoMarker
	)})).pop()`;

	await page.waitFor(
		`!!(${afterEchoRow}) && !!(${afterEchoRow}).querySelector('.msg-translated')`,
		{timeout: 20000, label: "the next line is translated: the engine was not paused"}
	);

	const doneAfterNext = Number(await page.evaluate(LINES));

	await page.check(
		`the echo cost the engine nothing (${doneBeforeNext} then ${doneAfterNext} done lines)`,
		doneAfterNext === doneBeforeNext + 1
	);
	await page.check("no engine was paused", !(await page.evaluate(PAUSED)));

	// A question answered rather than translated is no translation either:
	// the fake's `[answer]` token replies without a question mark, and the
	// line fails with the answered reason -- the answer's failure, so no
	// engine is paused for it.
	const questionMarker = `Frageprobe${RUN}`;

	other.say(
		`Kannst du mir bitte sagen, wann das Treffen morgen beginnt, ${questionMarker} [answer]?`
	);

	const questionRow = newestRow(questionMarker);

	await page.waitFor(
		`!!(${questionRow}) && !!(${questionRow}).querySelector('.msg-translation[data-status="failed"]')`,
		{timeout: 20000, label: "the answered question fails"}
	);
	await page.check(
		"the reason says the question was answered",
		String(
			await page.evaluate(
				`((${questionRow}).querySelector(".msg-translation-reason") || {}).textContent || ""`
			)
		).trim() === "answered the question instead of translating it"
	);
	await page.check("no engine was paused by the answer", !(await page.evaluate(PAUSED)));
	await page.evaluate(`(${questionRow}).scrollIntoView({block: "center"})`);
	await page.screenshot("answered-question");

	// Another reading language: the Settings override (the locale setting,
	// "Interface and reading language" -- one control since the
	// unification). The interface switches to French and reading follows it
	// -- for what arrives next, and for what is already on screen: the move
	// requeues every reading channel (reader.ts `requeueReading`), so the
	// finished English translations go and come back in French.
	const afterEchoText = `((${afterEchoRow}).querySelector('.msg-translated') || {}).textContent || ""`;

	await setReadOverride(page, "fr");

	await page.waitFor(`(${afterEchoText}).includes("[French] ")`, {
		timeout: 90000,
		label: "a translation already on screen is replaced with one in the new language",
	});

	// The chip shows only the source ("from …"); its title carries the
	// whole direction, target included.
	const afterEchoChip = String(
		await page.evaluate(
			`((${afterEchoRow}).querySelector(".msg-translated") || {lang: ""}).lang`
		)
	).trim();

	await page.check(
		`the requeued translation's chip names the new target (${afterEchoChip})`,
		afterEchoChip === "fr"
	);
	// Nothing on screen still reads as English: a line the requeue's cap left
	// behind has no translation at all, never a stale one.
	await page.check(
		"no finished translation on screen is still in the old language",
		await page.evaluate(
			`[...document.querySelectorAll('.msg-translated')].every((n) => !n.textContent.includes("[English] "))`
		)
	);

	// The requeue is a backlog like a switch-on's: let it drain before the
	// next line is said, so that line is a request of its own rather than
	// one batched behind the channel's scripted failures.
	await settledLines(page, "the reading-language change's requeue");

	// What arrives after the move is read into French: the request targets
	// the new reading language and the chip names it in the reader's.
	const frenchMarker = `Sprachwechsel${RUN}`;
	const frenchLine = `Und dies ist der Satz, der die neue Lesesprache fuer die ${frenchMarker} beweist.`;

	other.say(frenchLine);
	await page.waitFor(`!!(${newestRow(frenchMarker)})`, {
		label: "the line after the move arrived",
	});

	const frenchText = `((${newestRow(
		frenchMarker
	)}).querySelector('.msg-translated') || {}).textContent || ""`;

	await page.waitFor(`(${frenchText}).includes("[French]")`, {
		timeout: 30000,
		label: "a line said after the move is translated into French",
	});

	const frenchChip = String(
		await page.evaluate(
			`((${newestRow(frenchMarker)}).querySelector(".msg-translated") || {lang: ""}).lang`
		)
	).trim();

	await page.check(
		`the new line's chip names the new target (${frenchChip})`,
		frenchChip === "fr"
	);
	await page.screenshot("reading-language-changed");

	// An own line said just before leaving, so the rejoin's history (newest
	// first, capped) is sure to bring it back: read live into French first.
	const ownPartMarker = `Abschiedszeile${RUN}`;
	const ownPart = `Meine eigene Zeile kurz vor dem Verlassen des Kanals, ${ownPartMarker}.`;
	const ownPartRow = `[...document.querySelectorAll(".msg.self:not(.pending)")].filter((m) => m.textContent.includes(${JSON.stringify(
		ownPartMarker
	)})).pop()`;
	const ownPartText = `((((${ownPartRow}) || document).querySelector('.msg-translated') || {}).textContent || "")`;

	await page.fill("#input", ownPart);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`!!(${ownPartRow}) && ${ownPartText}.includes("[French]")`, {
		timeout: 30000,
		label: "the own line before the part is translated into French",
	});

	// Leave and come back: the channel keeps its setting, so reading is on
	// after the rejoin and the history the join loads is translated.
	await page.fill("#input", `/part ${CHANNEL}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(
		`!(document.querySelector("#chat") || document.body).innerText.includes(${JSON.stringify(
			afterEchoMarker
		)})`,
		{timeout: 15000, label: "the channel was left"}
	);
	await page.fill("#input", `/join ${CHANNEL}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(
		`${TRANSLATION_OFFERED} && document.body.innerText.includes(${JSON.stringify(
			afterEchoMarker
		)})`,
		{timeout: 30000, label: "the rejoin opened the channel with its history"}
	);
	await page.check("reading is still on after the rejoin", await page.evaluate(READING_ON));
	await page.waitFor(`(${afterEchoText}).includes("[French]")`, {
		timeout: 90000,
		label: "the history the rejoin loaded is translated",
	});
	await page.waitFor(`!!(${ownPartRow}) && ${ownPartText}.includes("[French]")`, {
		timeout: 90000,
		label: "the page's own line from before the rejoin is translated",
	});
	await page.screenshot("rejoined-translated");

	// Off before the speaker goes: a switch-off drops what the load left
	// waiting, so nothing is mid-translation as the sockets close.
	await setReading(page, "");
	await page.waitFor(`!(${READING_ON})`, {label: "reading off again at the end"});

	// Ad hoc, on a channel that is switched off: the toolbar's Translate is
	// still there, its menu names the line's language, and the pick is the
	// source the request goes out with. The target is the reading language,
	// French by now.
	const adhocMarker = `Einzelzeile${RUN}`;
	const adhocLine = `Diese Zeile uebersetze ich von Hand, ${adhocMarker}, obwohl der Kanal aus ist.`;

	other.say(adhocLine);
	await page.waitFor(`!!(${newestRow(adhocMarker)})`, {label: "the ad-hoc line arrived"});

	const adhocRow = newestRow(adhocMarker);
	const adhocId = String(await page.evaluate(`(${adhocRow}).id`));

	await page.evaluate(`(${adhocRow}).scrollIntoView({block: "center"})`);

	if (MOBILE) {
		await page.evaluate(`(${adhocRow}).click()`);
	} else {
		await page.hover(`#${adhocId}`);
	}

	await page.check(
		"the switched-off channel still offers Translate on the line",
		(await page.evaluate(`!!(${adhocRow}).querySelector(".msg-action-translate")`)) === true
	);
	await page.evaluate(`(${adhocRow}).querySelector(".msg-action-translate").click()`);
	await page.waitFor(`!!document.querySelector(".context-menu-translate-from-pick")`, {
		label: "the ad-hoc menu",
	});
	await page.click(".context-menu-translate-from-pick");
	await page.waitFor(`!!document.querySelector(".source-language-picker")`, {
		label: "the source picker opened from the toolbar",
	});
	await page.evaluate(
		`(() => {
			const s = document.querySelector('.source-language-picker select[name="translateFrom"]');
			s.value = "de";
			s.dispatchEvent(new Event("change", {bubbles: true}));
		})()`
	);
	// The toolbar is `display: none` off hover, and the picker is positioned
	// against the button's rect: a toolbar that went away while the pointer
	// was in the dialog would leave the picker measuring zeros and jumping
	// to the corner of the screen. It stays up while the picker is open.
	await page.check(
		"the toolbar stays up while its picker is open",
		(await page.evaluate(
			`getComputedStyle((${adhocRow}).querySelector(".msg-actions")).display`
		)) !== "none"
	);
	await page.click(".source-language-picker-confirm");
	await page.waitFor(`!!(${adhocRow}) && !!(${adhocRow}).querySelector('.msg-translated')`, {
		timeout: 30000,
		label: "the ad-hoc translation arrived",
	});

	const adhocChip = String(
		await page.evaluate(
			`(() => { const e = ${STORE_TRANSLATIONS}[(${adhocRow}).id.replace(/^msg-/, "")]; return e.from + " → " + (${adhocRow}).querySelector(".msg-translated").lang; })()`
		)
	).trim();

	// Both ends named in the interface's language, French by now.
	const germanInFrench = String(
		await page.evaluate(`new Intl.DisplayNames(["fr"], {type: "language"}).of("de")`)
	);

	await page.check(
		`the ad-hoc translation is from the picked source into the reading language (${adhocChip}, ${germanInFrench})`,
		adhocChip === "de → fr"
	);

	const adhocRequest = await page.evaluate(
		`JSON.stringify((${REQUESTS}).filter((r) => (r.text || "").includes(${JSON.stringify(
			adhocMarker
		)})).pop() || null)`
	);

	await page.check(
		`the request carried the picked source (${adhocRequest})`,
		!!adhocRequest && JSON.parse(adhocRequest).from === "de"
	);
	await page.screenshot("adhoc-translate");

	other.quit();
	await page.check("no console errors", page.consoleErrors.length === 0);
}
