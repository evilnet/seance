// The reading pipeline in a real browser, on the in-page fake engine
// (?fakeTranslate on a non-production build) with a second user speaking
// German in #seance-translate (its own channel, not #seance, so these lines
// never land in a tester's own context) through a raw WebSocket to the dev
// ircd. Steps, in
// order: nothing is translated while the globe is off, and the two German
// lines said before it is switched on -- and the page's own German line
// said then too -- are translated once it is (reading
// covers what the channel shows, not only what arrives after the switch;
// the switch-on's requeue of the backlog is let settle and every later
// count is taken against it); a German
// line gets a "German → English" line with the fake's "[English] …" echo; an
// English line gets no translation but a muted "English" mark, whose menu's
// "Translate anyway" translates it; a Spanish line franc cannot tell from
// Galician is translated with no source named and no "probably" guess in its
// request; a three-word line too short for franc, said before any language is
// declared, is translated with no source named (the engine places it; the
// chip reads "? → English"); the chip's menu retranslates from another source
// (the detector's runners-up one click each, never the line's own source;
// "Retranslate from…" opens the picker, Escape asks for nothing, French
// makes the chip read "French → English" and the request carry `from: "fr"`, and
// the runners-up survive that choice so one click puts it back on German);
// a five-line burst is translated and proved
// batched (the in-page request log shows one multi-line LLM request, not
// five singles, and every burst line's echo is rendered); the chip's menu
// can hide a translation; the toolbar's Translate opens a menu that
// translates one message on request or names its language first; the page's own German line is translated like anyone's; the
// translation panel opens on the globe's context menu as one column of
// controls of equal width, each language named in the interface's
// language (never a code) and a link to Settings, and closes on Escape; a line the fake hands back
// unchanged (its `[echo]` token) fails with "the line came back unchanged"
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
// globe on and translates the history the rejoin loads, the page's own
// line from before the part included; and, with the channel switched off
// again at the end, the toolbar's Translate still translates one line ad
// hoc from a language picked in its menu's dialog.
// Detection is real (franc); only the engine is scripted.
//
// The speaker negotiates message-tags + echo-message so it learns the
// msgid the server gave its own line, and batch + draft/multiline so it
// can send one multi-line message; the run flips
// CAP_draft_message_redaction on (the rig leaves it off, and without it
// REDACT answers FAIL DISABLED and the page never offers the cap) and
// back off at the end.
//
//   corepack yarn build && python3 -m http.server -d public 8021 &
//   (or any port, with SEANCE_HTTP=http://localhost:<port>/)
//   CHROME_BIN=/seance/tmp/chrome-pw.sh node tools/browser-drive.mjs tools/scenarios/translate-reading.mjs
//   … --mobile --width=390 --height=844
//
// Needs the dev ircd's plain-WS port on 127.0.0.1:8067. The run flips a
// server feature through an oper, so a rig whose oper is not the Docker
// default wants `SEANCE_OPER=seanceop SEANCE_OPER_PASSWORD=seance` (the
// native rig's, tools/nefarious-dev/local.conf) in the environment. NODE_ENV must be
// unset for the build: a production build compiles the fake out. Under
// `--mobile` the globe's tap opens the panel rather than switching reading
// (there is no right-click on a phone), so the switch is thrown through the
// panel's own control there; with a pointer the switch-on click opens the
// panel too (and the run puts it away with Escape before going on), while
// the switch-off click must leave it closed.

import {rigFeature} from "./lib/rig-feature.mjs";

const RUN = Date.now().toString(36);
const NICK = `tr${RUN}`;
const SPEAKER = `de${RUN}`;
const CHANNEL = "#seance-translate";
const IRCD = process.env.SEANCE_IRC_WS || "ws://127.0.0.1:8067/";
const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8021/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance-translate&fakeTranslate`;

const LINES = `document.querySelectorAll('.msg-translation[data-status="done"]').length`;
const GLOBE = "#chat button.translate";
const MOBILE = process.argv.includes("--mobile");
const REQUESTS = `(window.__seanceTranslateFake && window.__seanceTranslateFake.requests) || []`;
const REDACTION_FEATURE = "CAP_draft_message_redaction";
const PENDING = `document.querySelectorAll('.msg-translation[data-status="pending"]').length`;

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
 * Reading on or off. The globe's click is the switch where there is a
 * pointer; on touch the tap opens the panel instead (there is no
 * right-click to reach it with), so the switch is the panel's first
 * control and the close button puts it away.
 */
async function setReading(page, code) {
	await page.click(GLOBE);

	if (!MOBILE) {
		// Switching a channel on opens its panel with it, so the reader can
		// see and adjust the languages at once; switching off is only that.
		// The panel is put away again before the run goes on.
		await page.sleep(300);

		const panel = await page.evaluate(`!!document.querySelector(".translation-panel")`);

		if (code) {
			await page.check("the switch-on click opened the panel", panel);

			if (panel) {
				await page.evaluate(
					`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))`
				);
				await page.waitFor(`!document.querySelector(".translation-panel")`, {
					label: "the panel closed again before the next step",
				});
			}
		} else {
			await page.check("the switch-off click left the panel closed", !panel);
		}

		return;
	}

	await page.waitFor(`!!document.querySelector(".translation-panel")`, {
		label: "the tap opened the panel",
	});
	await setPanelRead(page, Boolean(code));
	await page.evaluate(`document.querySelector(".translation-panel-close").click()`);
	await page.waitFor(`!document.querySelector(".translation-panel")`, {
		label: "the close button put the panel away",
	});
}

/**
 * The panel without touching the switch: a right-click where there is a
 * pointer, and on touch the tap itself, which is how the panel opens there.
 */
async function openPanel(page) {
	if (MOBILE) {
		await page.click(GLOBE);
	} else {
		await page.evaluate(
			`document.querySelector(${JSON.stringify(
				GLOBE
			)}).dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true}))`
		);
	}

	await page.waitFor(`!!document.querySelector(".translation-panel")`, {
		timeout: 10000,
		label: "the panel opened",
	});
}

/** Set one of the panel's selects and let Vue hear it. */
function setPanelSelect(page, name, value) {
	return page.evaluate(
		`(() => { const s = document.querySelector('.translation-panel select[name=${JSON.stringify(
			name
		)}]'); s.value = ${JSON.stringify(
			value
		)}; s.dispatchEvent(new Event("change", {bubbles: true})); })()`
	);
}

/**
 * The panel's reading switch (Off / On). The language is not chosen here:
 * it is the interface's, with the Settings override as the exception.
 */
function setPanelRead(page, on) {
	return page.evaluate(
		`(() => { for (const s of document.querySelectorAll('.translation-panel-segmented .translation-panel-segment')) { if (s.textContent.trim() === (${JSON.stringify(
			on
		)} ? "On" : "Off")) { s.click(); return; } } throw new Error("no reading segment"); })()`
	);
}

/**
 * The reading-language override, set through Settings -> Translation:
 * "Interface and reading language" is one control (the locale setting; the
 * per-channel picker went with the unification). The interface switches to
 * the language too. Leaves through Done, which hands the view back to the
 * channel.
 */
async function setReadOverride(page, code) {
	await page.click(`#footer button.settings`);
	await page.waitFor(`!!document.querySelector(".settings-menu button.translation")`, {
		label: "settings open for the override",
	});
	await page.click(`.settings-menu button.translation`);
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
async function openChipMenu(page, chip, label) {
	await page.evaluate(
		`document.querySelector(${JSON.stringify(chip)}).scrollIntoView({block: "center"})`
	);
	await page.click(chip);
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
	await page.waitFor(`!!document.querySelector(${JSON.stringify(GLOBE)})`, {
		timeout: 10000,
		label: "globe shown once the probe answered",
	});
	await page.check(
		"globe starts off",
		!(await page.evaluate(
			`document.querySelector(${JSON.stringify(GLOBE)}).classList.contains("on")`
		))
	);

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

	await setReading(page, "en");
	await page.waitFor(
		`document.querySelector(${JSON.stringify(GLOBE)}).classList.contains("on")`,
		{label: "globe on"}
	);
	await page.waitFor(
		preSwitch
			.map(
				(line) =>
					`!!(${newestRow(line)})?.querySelector('.msg-translation[data-status="done"]')`
			)
			.join(" && "),
		{timeout: 90000, label: "the two lines said before the switch are translated once it is on"}
	);
	await page.waitFor(
		`!!(${ownBeforeRow})?.querySelector('.msg-translation[data-status="done"]')`,
		{timeout: 90000, label: "the page's own line said before the switch is translated too"}
	);
	await page.check(
		"the own line's translation is the fake's English echo",
		String(
			await page.evaluate(
				`((${ownBeforeRow}).querySelector(".msg-translation-text") || {}).textContent`
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

	const globeLabel = String(
		await page.evaluate(
			`document.querySelector(${JSON.stringify(GLOBE)}).getAttribute("aria-label")`
		)
	);

	// On touch the button is the way into the panel, and says so.
	await page.check(
		MOBILE
			? `the globe offers the settings (${globeLabel})`
			: `the tooltip names the language (${globeLabel})`,
		globeLabel.startsWith(MOBILE ? "Translation settings" : "Translating into")
	);

	other.say("Ich schicke dir gleich das Log, einen Moment bitte.");
	await page.waitFor(`${LINES} === ${base + 1}`, {timeout: 15000, label: "one translated line"});

	// The exact text repeats across every run's chathistory backlog (unlike
	// the RUN-suffixed markers below), so take the newest match, not the
	// first -- and look its chip and text up inside that row, since the
	// backlog's translations sit above it.
	const translatedRow = newestRow("Ich schicke dir gleich das Log");
	const translatedRowId = String(await page.evaluate(`(${translatedRow}).id`));
	const CHIP = `#${translatedRowId} .msg-translation-chip`;
	const TEXT = `#${translatedRowId} .msg-translation-text`;

	// Every label names its languages in the reader's language: this
	// channel is read in English, so the German line's chip is in English.
	await page.check(
		"a chip reads German → English in a channel read in English",
		(await page.evaluate(
			`document.querySelector(${JSON.stringify(CHIP)}).textContent.trim()`
		)) === "German → English"
	);
	await page.check(
		"the fake's English echo is shown",
		String(
			await page.evaluate(`document.querySelector(${JSON.stringify(TEXT)}).textContent`)
		).includes("[English] Ich schicke dir")
	);
	await page.screenshot("translated-line");

	// Once a translation is shown and done, it is the bright line and the
	// original dims (docs/resources/translation.md § Reading a channel):
	// read both reference colours rather than hard-coding hex.
	const bodyColor = String(await page.evaluate(`getComputedStyle(document.body).color`));
	const mutedColor = String(
		await page.evaluate(`getComputedStyle(document.querySelector(".time")).color`)
	);
	await page.check(
		"the translated row carries the translated class",
		await page.evaluate(`(${translatedRow}).classList.contains("translated")`)
	);
	await page.check(
		"the original text is muted",
		(await page.evaluate(
			`getComputedStyle((${translatedRow}).querySelector(".content")).color`
		)) === mutedColor
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
	await openChipMenu(page, CHIP, "the chip menu offers the source items");

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
	await openChipMenu(page, CHIP, "the chip menu opened again");
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
	await page.check(
		"the chip now reads French → English",
		(await page.evaluate(
			`document.querySelector(${JSON.stringify(CHIP)}).textContent.trim()`
		)) === "French → English"
	);
	await page.waitFor(`${LINES} === ${base + 1}`, {
		timeout: 15000,
		label: "the retranslation from French is in",
	});

	// The candidates survived the explicit source, so the detector's own
	// guess is one click away again.
	await openChipMenu(page, CHIP, "the chip menu opened a third time");

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
	await page.waitFor(
		`document.querySelector(${JSON.stringify(CHIP)}).textContent.trim() === "German → English"`,
		{timeout: 15000, label: "the one-click candidate put it back on German"}
	);
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

	// A line the detector places in the reading language is not left bare:
	// it carries a small muted mark naming the language it was taken for,
	// and the mark's menu translates it anyway.
	const englishRow = newestRow("needs no line at all");

	await page.waitFor(`!!(${englishRow})?.querySelector(".msg-translation-skipped-tag")`, {
		timeout: 15000,
		label: "the English line carries the skipped mark",
	});

	const englishRowId = String(await page.evaluate(`(${englishRow}).id`));
	const ENGLISH_TAG = `#${englishRowId} .msg-translation-skipped-tag`;

	await page.check(
		"the mark names the language in the reader's language",
		(await page.evaluate(
			`document.querySelector(${JSON.stringify(ENGLISH_TAG)}).textContent.trim()`
		)) === "English"
	);
	await page.check(
		"the mark has no text row, no caret, and leaves the original its ink",
		await page.evaluate(
			`!document.querySelector(${JSON.stringify(
				`#${englishRowId} .msg-translation`
			)}) && !document.querySelector(${JSON.stringify(
				`#${englishRowId} .msg-translation-caret`
			)}) && !document.getElementById(${JSON.stringify(
				englishRowId
			)}).classList.contains("translated")`
		)
	);
	await page.screenshot("skipped-mark");
	await openChipMenu(page, ENGLISH_TAG, "the mark's menu opened");
	await page.check(
		"the mark's menu offers Translate anyway, and nothing to copy or hide",
		await page.evaluate(
			`!!document.querySelector(".context-menu-translate-anyway") && !document.querySelector(".context-menu-translate-copy") && !document.querySelector(".context-menu-translate-hide")`
		)
	);
	await page.screenshot("skipped-mark-menu");
	await page.click(".context-menu-translate-anyway");
	await page.waitFor(
		`!!document.querySelector(${JSON.stringify(
			`#${englishRowId} .msg-translation[data-status="done"]`
		)})`,
		{timeout: 20000, label: "Translate anyway produced a translation"}
	);
	await page.check(
		"the translation replaced the mark",
		await page.evaluate(
			`!document.querySelector(${JSON.stringify(
				ENGLISH_TAG
			)}) && document.querySelector(${JSON.stringify(
				`#${englishRowId} .msg-translation-text`
			)}).textContent.includes("[English] this one is already")`
		)
	);
	// That translation is a done line the later counts must not see as theirs.
	base += 1;
	await page.check("one more done line", (await page.evaluate(LINES)) === base + 1);

	// A line the detector cannot place, with no English among its candidates
	// (franc ranks Spanish, Portuguese and Galician within a hundredth of each
	// other here), is translated: its source left to the engine, and the
	// request told no guess -- not "probably German" from this channel's prior.
	const spanish = "claude es muy lento estos días";

	other.say(spanish);
	await page.waitFor(`${LINES} === ${base + 2}`, {
		timeout: 20000,
		label: "the Spanish line the detector could not place is translated",
	});
	// The chip names the detector's contenders instead of dropping the source
	// (labels.ts): "Spanish / Portuguese → English", in whichever order franc
	// ranked them this run -- never a bare "→ English".
	const spanishChip = String(
		await page.evaluate(
			`((${newestRow(
				spanish
			)}).querySelector(".msg-translation-chip") || {}).textContent || ""`
		)
	).trim();
	const CONTENDER = "(Spanish|Portuguese|Galician)";

	await page.check(
		`its chip names the detector's contenders (${JSON.stringify(spanishChip)})`,
		new RegExp(`^${CONTENDER}( / ${CONTENDER}|\\?) → English$`).test(spanishChip)
	);

	const spanishRequests = await page.evaluate(
		`(${REQUESTS}).filter((r) => r.text.indexOf(${JSON.stringify(
			spanish
		)}) !== -1).map((r) => ({from: r.from, sourceHint: r.sourceHint}))`
	);

	await page.check(
		`its request named no source and no probable one (${JSON.stringify(spanishRequests)})`,
		Array.isArray(spanishRequests) &&
			spanishRequests.length > 0 &&
			spanishRequests.every((r) => r.from === null && r.sourceHint === null)
	);
	base += 1;

	// A short line with no function words ("ja so gut": nine characters, three
	// words, under DETECT_MIN_LENGTH so franc is never asked): the classifier
	// has no verdict for it, and the short-line lookup (wordlookup.ts) finds
	// German, Slovak, Polish and English all listing some of its words, with
	// German only 1.8x ahead — too close to place on its own. The channel's
	// prior is what settles it: everything said here has been German, German
	// is among the contenders, so the line is placed German and translated
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
		`!!document.querySelector(${JSON.stringify(
			`#${unsureRowId} .msg-translation[data-status="done"]`
		)})`,
		{timeout: 20000, label: "the short German line translated"}
	);
	await page.check(
		"the short line's chip names German (the prior settled the lookup's tie)",
		(
			await page.evaluate(
				`document.querySelector('#${unsureRowId} .msg-translation-chip').textContent`
			)
		).trim() === "German → English"
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

	// A word nothing can place at all: no function word, and no language's
	// frequency table lists "lol" either, so the lookup has no opinion, the
	// line stays short, and it goes to the engine with no source named —
	// the behaviour every unplaceable short line had before the lookup.
	const unplaceable = "lol";
	const unplaceableRows = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		unplaceable
	)}))`;
	const unplaceableBefore = await page.evaluate(`${unplaceableRows}.length`);

	other.say(unplaceable);
	await page.waitFor(`${unplaceableRows}.length > ${unplaceableBefore}`, {
		timeout: 15000,
		label: "the unplaceable word arrived",
	});

	const unplaceableRowId = String(await page.evaluate(`${unplaceableRows}.pop().id`));

	await page.waitFor(
		`!!document.querySelector(${JSON.stringify(
			`#${unplaceableRowId} .msg-translation[data-status="done"]`
		)})`,
		{timeout: 20000, label: "the unplaceable word translated"}
	);
	await page.check(
		"the unplaceable word's chip names no source (? → English)",
		(
			await page.evaluate(
				`document.querySelector('#${unplaceableRowId} .msg-translation-chip').textContent`
			)
		).trim() === "? → English"
	);
	const unplaceableRequests = await page.evaluate(
		`(${REQUESTS}).filter((r) => r.text.trim() === ${JSON.stringify(
			unplaceable
		)}).map((r) => ({from: r.from}))`
	);
	await page.check(
		`its request left the source to the engine (${JSON.stringify(unplaceableRequests)})`,
		Array.isArray(unplaceableRequests) &&
			unplaceableRequests.length > 0 &&
			unplaceableRequests.every((r) => r.from === null)
	);
	base += 1;
	await page.check("one more done line", (await page.evaluate(LINES)) === base + 1);

	// A lone word, from the same German-speaking user, that no function word
	// and no trigram can place: the short-line lookup (wordlookup.ts) reads it
	// out of the frequency table instead, where "hola" is Spanish and nothing
	// else. The chip names Spanish -- not the channel's German prior, and not
	// a bare "? → English" -- and the request carries `from: "es"`, which is
	// what makes the engine translate *from* Spanish rather than echo the word
	// back. Counted like the line above: four characters fit no RUN marker.
	const loneWord = "hola";
	const loneRows = `[...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		loneWord
	)}))`;
	const loneBefore = await page.evaluate(`${loneRows}.length`);

	other.say(loneWord);
	await page.waitFor(`${loneRows}.length > ${loneBefore}`, {
		timeout: 15000,
		label: "the lone Spanish word arrived",
	});

	const loneRowId = String(await page.evaluate(`${loneRows}.pop().id`));

	await page.waitFor(
		`!!document.querySelector(${JSON.stringify(
			`#${loneRowId} .msg-translation[data-status="done"]`
		)})`,
		{timeout: 20000, label: "the lone word translated"}
	);

	const loneChip = String(
		await page.evaluate(
			`document.querySelector('#${loneRowId} .msg-translation-chip').textContent`
		)
	).trim();

	await page.check(
		`the lone word's chip names Spanish (${JSON.stringify(loneChip)})`,
		loneChip === "Spanish → English"
	);

	const loneRequests = await page.evaluate(
		`(${REQUESTS}).filter((r) => r.text.trim() === ${JSON.stringify(
			loneWord
		)}).map((r) => ({from: r.from}))`
	);

	await page.check(
		`its request asked for Spanish as the source (${JSON.stringify(loneRequests)})`,
		Array.isArray(loneRequests) &&
			loneRequests.length > 0 &&
			loneRequests.every((r) => r.from === "es")
	);
	await page.screenshot("lone-word-placed");
	base += 1;
	await page.check("one more done line", (await page.evaluate(LINES)) === base + 1);

	const requestsBeforeBurst = await page.evaluate(`(${REQUESTS}).length`);

	for (let i = 1; i <= 5; i++) {
		other.say(`Zeile ${i} von fünf, alle sollten übersetzt werden.`);
	}

	await page.waitFor(`${LINES} === ${base + 6}`, {timeout: 20000, label: "burst translated"});

	// The burst was batched into one multi-line LLM request, not five
	// independent translations: the request log (client/js/translate/fakePort.ts)
	// shows a request with `lines >= 2`, and fewer requests than burst lines
	// overall — the tell for the per-line fallback never firing.
	const burstRequests = await page.evaluate(`(${REQUESTS}).slice(${requestsBeforeBurst})`);
	await page.check(
		`the burst was batched, not five singles (${
			burstRequests.length
		} requests, lines per request: ${burstRequests.map((r) => r.lines).join(",")})`,
		burstRequests.some((r) => r.lines >= 2) && burstRequests.length < 5
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

	// The chip's menu: copy one translation, hide one translation.
	await page.evaluate(
		`document.querySelector(${JSON.stringify(CHIP)}).scrollIntoView({block: "center"})`
	);
	await page.click(CHIP);
	await page.waitFor(`!!document.querySelector(".context-menu-translate-hide")`, {
		label: "chip menu open",
	});
	await page.check(
		"the chip's menu offers Copy translation first",
		await page.evaluate(
			`!!document.querySelector("#context-menu-item-0.context-menu-translate-copy")`
		)
	);
	await page.check(
		"the translated line is selectable",
		(await page.evaluate(
			`getComputedStyle(document.querySelector(${JSON.stringify(TEXT)})).userSelect`
		)) === "text"
	);
	await page.click(".context-menu-translate-hide");
	await page.waitFor(`${LINES} === ${base + 5}`, {label: "one translation hidden"});
	await page.check(
		"Show original only drops the translated class and the original's colour",
		(await page.evaluate(`(${translatedRow}).classList.contains("translated")`)) === false &&
			(await page.evaluate(
				`getComputedStyle((${translatedRow}).querySelector(".content")).color`
			)) === bodyColor
	);

	// No word floor: a two-word line the classifier places ("ist" is a German
	// function word, and a single hit decides a line of three words or fewer)
	// translates by itself now. One hit is a hint, not a source
	// (detect.ts `Detection.weak`), so the line goes to the engine with no
	// source named and the chip offers the guess with a question mark. Like
	// "ja so gut" above, no RUN marker fits, so the rows with this text are
	// counted first and the new one is newest.
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
		`!!document.querySelector(${JSON.stringify(
			`#${shortRowId} .msg-translation[data-status="done"]`
		)})`,
		{timeout: 20000, label: "the two-word line is translated by itself"}
	);
	await page.check(
		"the two-word line's chip offers the guess (German? → English)",
		(
			await page.evaluate(
				`document.querySelector('#${shortRowId} .msg-translation-chip').textContent`
			)
		).trim() === "German? → English"
	);

	const shortRequests = await page.evaluate(
		`(${REQUESTS}).filter((r) => r.text.indexOf(${JSON.stringify(
			shortAsk
		)}) !== -1).map((r) => ({from: r.from}))`
	);

	await page.check(
		`a one-hit verdict is no source: its request left it to the engine (${JSON.stringify(
			shortRequests
		)})`,
		Array.isArray(shortRequests) &&
			shortRequests.length > 0 &&
			shortRequests.every((r) => r.from === null)
	);

	// The toolbar's Translate on a line the pipeline leaves alone: an English
	// line carries the skipped mark, and the toolbar is its other way in.
	const toolbarAsk = `one more line in english for the toolbar ${RUN}`;

	other.say(toolbarAsk);
	await page.waitFor(`!!(${newestRow(toolbarAsk)})`, {label: "the toolbar line arrived"});

	const shortAskRow = `document.getElementById(${JSON.stringify(
		String(await page.evaluate(`(${newestRow(toolbarAsk)}).id`))
	)})`;

	await page.waitFor(
		`!!(${shortAskRow}) && !!(${shortAskRow}).querySelector(".msg-translation-skipped-tag")`,
		{timeout: 15000, label: "the pipeline left the English line alone"}
	);

	if (MOBILE) {
		await page.evaluate(`${shortAskRow}.click()`);
	} else {
		await page.hover(`#${await page.evaluate(`${shortAskRow}.id`)}`);
	}

	// The action opens a menu: translate now, or name the line's language
	// first. The mark's own menu still carries "Translate anyway".
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

	await page.waitFor(
		`!!(${ownRow}) && !!(${ownRow}).querySelector('.msg-translation[data-status="done"]')`,
		{timeout: 15000, label: "the own line is translated"}
	);
	await page.check(
		"the own line added exactly one done line",
		(await page.evaluate(LINES)) === base + 8
	);
	await page.check(
		"the own row's chip reads German → English",
		(await page.evaluate(
			`((${ownRow}).querySelector(".msg-translation-chip") || {}).textContent.trim()`
		)) === "German → English"
	);

	// The panel: opened from the globe's context menu, full language names,
	// closes on Escape.
	await page.evaluate(
		`document.querySelector(${JSON.stringify(
			GLOBE
		)}).dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true}))`
	);
	await page.waitFor(`!!document.querySelector(".translation-panel")`, {
		timeout: 10000,
		label: "panel opens",
	});

	const panelRect = await page.rect(".translation-panel");
	const viewport = await page.evaluate(`({w: innerWidth, h: innerHeight})`);

	await page.check(
		`panel is tall enough (${panelRect ? panelRect.height : "none"}px)`,
		!!panelRect && panelRect.height > 40
	);
	await page.check(
		"panel lies inside the viewport",
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
				`(document.querySelector(".translation-panel-more") || {}).getAttribute("href")`
			)
		).endsWith("/settings/translation")
	);

	if (MOBILE) {
		// The phone's layout is the sheet, asserted in full by
		// tools/scenarios/translate-composer.mjs --mobile.
		await page.check(
			"the panel came up as the phone's sheet",
			await page.evaluate(`!!document.querySelector(".translation-panel--sheet")`)
		);
	} else {
		// One column: every setting is a label with its control under it, so
		// The four selects and the variant input come out the same width
		// (the reading switch is a segmented control, not a control row).
		const controlWidths = await page.evaluate(
			`[...document.querySelectorAll(".translation-panel .translation-panel-control")].map((c) => Math.round(c.getBoundingClientRect().width))`
		);

		await page.check(
			`the four controls share one width (${controlWidths.join(", ")})`,
			controlWidths.length === 4 && new Set(controlWidths).size === 1
		);
		await page.check(
			"the hints stay out of the desktop panel",
			(await page.evaluate(
				`getComputedStyle(document.querySelector(".translation-panel-hint")).display`
			)) === "none"
		);
	}

	await page.screenshot("translation-panel");

	const readLabel = String(
		await page.evaluate(
			`document.querySelector(".translation-panel-label")?.textContent.trim() ?? ""`
		)
	);
	const readingEndonym = await page.evaluate(
		`new Intl.DisplayNames([navigator.language], {type: "language"}).of(navigator.language.split("-")[0])`
	);

	await page.check(
		`the reading section names the language in itself (${readLabel})`,
		// The language comes from the interface (the unified setting), and
		// the label carries its endonym — "English", never the bare code.
		readLabel.startsWith("Read messages in ") &&
			readLabel.endsWith(readingEndonym) &&
			!/^[a-z]{2}$/i.test(readLabel.replace("Read messages in ", ""))
	);

	await page.evaluate(
		`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))`
	);
	await page.waitFor(`!document.querySelector(".translation-panel")`, {
		timeout: 5000,
		label: "panel closes on Escape",
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
	await page.waitFor(
		`!!(${failRow}) && !!(${failRow}).querySelector('.msg-translation[data-status="done"]')`,
		{timeout: 15000, label: "the retry succeeds"}
	);
	await page.check(
		"the retried translation carries the English echo",
		await page.evaluate(
			`(${failRow}).querySelector(".msg-translation-text").textContent.includes("[English]")`
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
		`!!(${emphasisRow}) && !!(${emphasisRow}).querySelector('.msg-translation[data-status="done"]')`,
		{timeout: 15000, label: "the emphasised line is translated"}
	);
	await page.check(
		"the emphasis survived and renders as emphasis in the translation",
		(await page.evaluate(
			`((${emphasisRow}).querySelector(".msg-translation-text .irc-italic") || {}).textContent`
		)) === "Betonung"
	);
	await page.check(
		"the page's own nick came back untouched",
		await page.evaluate(
			`(${emphasisRow}).querySelector(".msg-translation-text").textContent.includes(${JSON.stringify(
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

	await page.waitFor(
		`!!(${nameRow}) && !!(${nameRow}).querySelector('.msg-translation[data-status="done"]')`,
		{timeout: 20000, label: "the line naming a departed nick and a channel is translated"}
	);

	const nameTranslation = await page.evaluate(
		`(${nameRow}).querySelector(".msg-translation-text").textContent`
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
	await page.waitFor(
		`!!(${multiRow}) && !!(${multiRow}).querySelector('.msg-translation[data-status="done"]')`,
		{timeout: 25000, label: "the multi-line message is translated"}
	);

	for (const line of multiLines) {
		await page.check(
			`the multi-line translation carries "${line.slice(0, 24)}…"`,
			await page.evaluate(
				`(${multiRow}).querySelector(".msg-translation-text").textContent.includes(${JSON.stringify(
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
	await page.waitFor(
		`!!(${mathRow}) && !!(${mathRow}).querySelector('.msg-translation[data-status="done"]')`,
		{timeout: 25000, label: "the math-block message is translated"}
	);

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
		await page.evaluate(`!!(${mathRow}).querySelector(".msg-translation-text .md-math-block")`)
	);
	await page.check(
		"the prose around the math block was translated",
		await page.evaluate(
			`(${mathRow}).querySelector(".msg-translation-text").textContent.includes("[English]") && (${mathRow}).querySelector(".msg-translation-text").textContent.includes(${JSON.stringify(
				mathMarker
			)})`
		)
	);
	await page.screenshot("translated-math-block");

	// Off again: a new German line gets nothing.
	await setReading(page, "");
	await page.waitFor(
		`!document.querySelector(${JSON.stringify(GLOBE)}).classList.contains("on")`,
		{label: "globe off"}
	);
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
		await page.evaluate(`!!(${burstRow}) && !!(${burstRow}).querySelector(".msg-translation")`)
	);

	other.redact(burstMsgid);
	await page.waitFor(`!!(${burstRow}) && !!(${burstRow}).querySelector(".msg-redacted")`, {
		timeout: 15000,
		label: "the redacted row shows the deleted button",
	});
	await page.check(
		"the deleted row keeps no translation",
		await page.evaluate(`!(${burstRow}).querySelector(".msg-translation")`)
	);
	const afterRedact = await page.evaluate(LINES);

	await page.check(
		`the redaction took exactly one translated line away (${afterRedact} vs ${base + 13})`,
		afterRedact === base + 13
	);
	await page.screenshot("redacted-translation");

	// The channel's declared languages. Reading is off by now, so this turns
	// it back on through the panel's own control on either layout -- and the
	// panel is where German is declared in the first place.
	await openPanel(page);
	await setPanelSelect(page, "translateLanguageAdd", "de");
	await page.waitFor(`!!document.querySelector(".translation-panel-chip")`, {
		label: "German is declared as spoken here",
	});

	const chipText = String(
		await page.evaluate(`document.querySelector(".translation-panel-chip").textContent.trim()`)
	);

	// The panel's chips name their language in the reader's language, like
	// every label does (TranslationPanel.vue `name`).
	await page.check(
		`the chip names the language for the reader (${chipText})`,
		chipText.startsWith("German")
	);
	await page.check(
		"the picker no longer offers a language the channel has declared",
		!(await page.evaluate(
			`[...document.querySelectorAll('.translation-panel select[name="translateLanguageAdd"] option')].some((o) => o.value === "de")`
		))
	);
	await page.screenshot("panel-languages");

	await setPanelRead(page, true);
	await page.evaluate(`document.querySelector(".translation-panel-close").click()`);
	await page.waitFor(`!document.querySelector(".translation-panel")`, {
		label: "the panel closed after declaring German",
	});
	await page.waitFor(
		`document.querySelector(${JSON.stringify(GLOBE)}).classList.contains("on")`,
		{label: "reading is on again"}
	);

	// Switching on again queues what the channel shows once more.
	const reBase = await settledLines(page, "the second switch-on's requeue");

	// Nine characters, three words: under DETECT_MIN_LENGTH, so franc is
	// never asked; the classifier places it ("ist" is a German function word
	// and a single hit decides a line of three words or fewer). German is
	// declared as spoken here by now, though the verdict does not need it.
	// One hit is a hint: the line translates with no source named and the
	// chip offers German as a guess.
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
		"the short line's chip offers the guess (German? → English)",
		(await page.evaluate(
			`((${shortRow}).querySelector(".msg-translation-chip") || {}).textContent.trim()`
		)) === "German? → English"
	);

	// History the reader asks for: a "load more" is translated, newest line
	// first, and at most HISTORY_QUEUE_CAP of the page
	// (client/js/translate/eligibility.ts).
	const HISTORY_QUEUE_CAP = 40;

	await page.check(
		"there are older messages to load",
		(await page.evaluate(
			`(() => { const el = document.querySelector("#chat .show-more"); return el ? getComputedStyle(el).display : "none"; })()`
		)) !== "none"
	);

	// The order the rows gain a translation line in is the order the reader
	// queued them in: an entry is committed per line as it is queued. Watched
	// from before the load, so nothing is missed by looking too late.
	await page.evaluate(
		`(() => {
			window.__seanceTranslationOrder = [];
			const seen = new Set(
				[...document.querySelectorAll(".msg-translation")]
					.map((el) => (el.closest(".msg") || {}).id)
					.filter(Boolean)
			);
			const scan = () => {
				for (const el of document.querySelectorAll(".msg-translation")) {
					const row = el.closest(".msg");

					if (row && row.id && !seen.has(row.id)) {
						seen.add(row.id);
						window.__seanceTranslationOrder.push(row.id);
					}
				}
			};

			new MutationObserver(scan).observe(document.querySelector("#chat .messages"), {
				childList: true,
				subtree: true,
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
				done: document.querySelectorAll('.msg-translation[data-status="done"]').length,
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

	await page.waitFor(
		`!!(${echoRow}) && !!(${echoRow}).querySelector('.msg-translation[data-status="failed"]')`,
		{timeout: 20000, label: "the echoed line fails"}
	);
	await page.check(
		"the reason says the line came back unchanged",
		(await page.evaluate(
			`((${echoRow}).querySelector(".msg-translation-reason") || {}).textContent.trim()`
		)) === "the line came back unchanged"
	);
	await page.check(
		"the failed line still shows its chip",
		await page.evaluate(`!!(${echoRow}).querySelector(".msg-translation-chip")`)
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
		`!!(${afterEchoRow}) && !!(${afterEchoRow}).querySelector('.msg-translation[data-status="done"]')`,
		{timeout: 20000, label: "the next line is translated: the engine was not paused"}
	);

	const doneAfterNext = Number(await page.evaluate(LINES));

	await page.check(
		`the echo cost the engine nothing (${doneBeforeNext} then ${doneAfterNext} done lines)`,
		doneAfterNext === doneBeforeNext + 1
	);
	// The globe's label is where a pause shows (Chat.vue `translateLabel`, its aria-label).
	await page.check(
		"no engine was paused",
		!String(
			await page.evaluate(
				`document.querySelector(${JSON.stringify(GLOBE)}).getAttribute("aria-label")`
			)
		).includes("paused:")
	);
	// The tooltip names the reading language itself, never the channel's
	// on/off flag: `translateLabel`'s `reading` var once took the boolean
	// and rendered "Translating into true".
	const globeTitle = String(
		await page.evaluate(
			`document.querySelector(${JSON.stringify(GLOBE)}).getAttribute("aria-label")`
		)
	);

	await page.check(
		`the globe names the reading language (${globeTitle})`,
		globeTitle.startsWith("Translating into English") && !/\btrue\b/.test(globeTitle)
	);

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
	await page.check(
		"no engine was paused by the answer",
		!String(
			await page.evaluate(
				`document.querySelector(${JSON.stringify(GLOBE)}).getAttribute("aria-label")`
			)
		).includes("paused:")
	);
	await page.evaluate(`(${questionRow}).scrollIntoView({block: "center"})`);
	await page.screenshot("answered-question");

	// Another reading language: the Settings override (the locale setting,
	// "Interface and reading language" -- one control since the
	// unification). The interface switches to French and reading follows it
	// -- for what arrives next, and for what is already on screen: the move
	// requeues every reading channel (reader.ts `requeueReading`), so the
	// finished English translations go and come back in French.
	const afterEchoText = `((${afterEchoRow}).querySelector('.msg-translation[data-status="done"] .msg-translation-text') || {}).textContent || ""`;

	await setReadOverride(page, "fr");

	const frenchName = String(
		await page.evaluate(`new Intl.DisplayNames(["fr"], {type: "language"}).of("fr")`)
	);

	await page.waitFor(`(${afterEchoText}).includes("[French] ")`, {
		timeout: 90000,
		label: "a translation already on screen is replaced with one in the new language",
	});

	const afterEchoChip = String(
		await page.evaluate(
			`((${afterEchoRow}).querySelector(".msg-translation-chip") || {}).textContent || ""`
		)
	).trim();

	await page.check(
		`the requeued translation's chip names the new target (${afterEchoChip})`,
		afterEchoChip.endsWith(`→ ${frenchName}`)
	);
	// Nothing on screen still reads as English: a line the requeue's cap left
	// behind has no translation at all, never a stale one.
	await page.check(
		"no finished translation on screen is still in the old language",
		await page.evaluate(
			`[...document.querySelectorAll('.msg-translation[data-status="done"] .msg-translation-text')].every((n) => !n.textContent.includes("[English] "))`
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
	)}).querySelector('.msg-translation[data-status="done"] .msg-translation-text') || {}).textContent || ""`;

	await page.waitFor(`(${frenchText}).includes("[French]")`, {
		timeout: 30000,
		label: "a line said after the move is translated into French",
	});

	const frenchChip = String(
		await page.evaluate(
			`((${newestRow(
				frenchMarker
			)}).querySelector(".msg-translation-chip") || {}).textContent || ""`
		)
	).trim();

	await page.check(
		`the new line's chip names the new target (${frenchChip})`,
		frenchChip.endsWith(`→ ${frenchName}`)
	);
	await page.screenshot("reading-language-changed");

	// An own line said just before leaving, so the rejoin's history (newest
	// first, capped) is sure to bring it back: read live into French first.
	const ownPartMarker = `Abschiedszeile${RUN}`;
	const ownPart = `Meine eigene Zeile kurz vor dem Verlassen des Kanals, ${ownPartMarker}.`;
	const ownPartRow = `[...document.querySelectorAll(".msg.self:not(.pending)")].filter((m) => m.textContent.includes(${JSON.stringify(
		ownPartMarker
	)})).pop()`;
	const ownPartText = `((((${ownPartRow}) || document).querySelector('.msg-translation[data-status="done"] .msg-translation-text') || {}).textContent || "")`;

	await page.fill("#input", ownPart);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`!!(${ownPartRow}) && ${ownPartText}.includes("[French]")`, {
		timeout: 30000,
		label: "the own line before the part is translated into French",
	});

	// Leave and come back: the channel keeps its setting, so the globe is on
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
		`!!document.querySelector(${JSON.stringify(
			GLOBE
		)}) && document.body.innerText.includes(${JSON.stringify(afterEchoMarker)})`,
		{timeout: 30000, label: "the rejoin opened the channel with its history"}
	);
	await page.check(
		"the globe is still on after the rejoin",
		await page.evaluate(
			`document.querySelector(${JSON.stringify(GLOBE)}).classList.contains("on")`
		)
	);
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
	await page.waitFor(
		`!document.querySelector(${JSON.stringify(GLOBE)}).classList.contains("on")`,
		{label: "reading off again at the end"}
	);

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
	await page.waitFor(
		`!!(${adhocRow}) && !!(${adhocRow}).querySelector('.msg-translation[data-status="done"]')`,
		{timeout: 30000, label: "the ad-hoc translation arrived"}
	);

	const adhocChip = String(
		await page.evaluate(
			`((${adhocRow}).querySelector(".msg-translation-chip") || {}).textContent || ""`
		)
	).trim();

	// Both ends named in the interface's language, French by now.
	const germanInFrench = String(
		await page.evaluate(`new Intl.DisplayNames(["fr"], {type: "language"}).of("de")`)
	);

	await page.check(
		`the ad-hoc chip names the picked source and the reading language (${adhocChip})`,
		adhocChip === `${germanInFrench} → ${frenchName}`
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
