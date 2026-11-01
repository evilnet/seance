// The composer in a real browser, on the in-page fake engine
// (?fakeTranslate on a non-production build), with a second user in
// #seance-translate (its own channel, not #seance, so these lines never
// land in a tester's own context) over a raw WebSocket who hears what the
// page actually sends.
// Steps, in order: the composer's translate dialog opens on the interface's
// own language, names every language in it (not in itself) and says
// "Correct" where the source and the target are the same; the panel sets
// the write target and the placeholder says so; the first Enter puts an "English → German" strip above the input with
// the fake's "[German] …" streaming in, Send disabled until it ends, the
// draft still in the input, the request logged with purpose "write";
// typing drops the strip; the check runs automatically once the
// translation ends, disabling Send again until the read-back line
// ("[English] [German] …", a read request) is done; the second Enter sends the
// translation (the other user hears "[German] …", the strip goes, the
// input clears) and ArrowUp recalls the original draft; Escape drops a
// strip and keeps the draft; a draft carrying the fake's "[fail]" marker
// gets the failure strip and Enter sends it as written, and one carrying
// "[echo]" -- which the fake hands back as typed -- is tried a second time
// with nothing but the draft (no context, no source) before the same strip
// reports "came back unchanged", while "[echo-once]", handed back only the
// first time, ends as the bare retry's translation, and a question whose read-back the
// fake answers ("[answer]") gets the bare second try there before the row
// says it couldn't check; a "/me" draft translates its text and goes out as
// an ACTION behind the command, while every other command is left alone; a three-line draft translates as one numbered request and
// ships as three lines; a draft carrying markdown, a nick, a URL and a code
// span comes back with every one of them intact (the engine only ever saw
// placeholders), the strip's Copy button's tooltip reads "Copied" and its
// text is selectable, a fenced code block is never sent for translation and comes
// back byte for byte; inline TeX and a bold word together survive both the
// strip and the round trip's read-back row; the chip's title names the
// route its text came down; with reading switched on in English and a
// German draft sent in French, the posted line keeps its read-back and the
// reading pipeline asks for no translation of it; switching the target off
// restores plain sending.
// Under `--mobile` the panel is asserted to be the full-screen sheet, with
// formality as a segmented control and the close button putting it away,
// and so is the newline-first keyboard: with a strip up, the Return's
// newline reaches the draft before the keypress does, the strip survives
// it and that Enter sends the translation rather than translating afresh
// (prose and `/me` alike). That path is a touch-primary device's -- with a
// hardware keyboard the Return is preventDefaulted and no newline is ever
// typed -- so it runs under `--mobile` only, and the desktop run asserts
// the opposite instead: there a trailing newline is a deliberate
// Shift+Enter, an edit of the draft, and it drops the strip.
// Detection is real (franc); only the engine is scripted.
//
//   corepack yarn build && python3 -m http.server -d public 8021 &
//   CHROME_BIN=/seance/tmp/chrome-pw.sh node tools/browser-drive.mjs tools/scenarios/translate-composer.mjs
//   … --mobile --width=390 --height=844
//
// Needs the dev ircd's plain-WS port on 127.0.0.1:8067. NODE_ENV must be
// unset for the build: a production build compiles the fake out. On touch
// the panel opens from the channel menu's "Translation…" entry; the
// synthetic contextmenu below is the harness's shortcut to the same panel.

const RUN = Date.now().toString(36);
const NICK = `tw${RUN}`;
const LISTENER = `hr${RUN}`;
const CHANNEL = "#seance-translate";
const IRCD = process.env.SEANCE_IRC_WS || "ws://127.0.0.1:8067/";
const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance-translate&fakeTranslate`;

const GLOBE = "#chat button.translate";
const MOBILE = process.argv.includes("--mobile");
const BAR = ".translate-bar";
const BAR_TEXT = ".translate-bar-row:first-child .translate-bar-text";
const INPUT = "#form #input";
// Both wrap their whole expression: `a || b` binds looser than `===`, `&&`
// and member access, so an unparenthesised `x || ""` in front of `=== "…"`
// would be read as `x || ("" === "…")` and pass the moment `x` is any
// non-empty string.
const REQUESTS = "((window.__seanceTranslateFake && window.__seanceTranslateFake.requests) || [])";
const barText = `((document.querySelector(${JSON.stringify(BAR_TEXT)}) || {}).textContent || "")`;
const inputValue = `document.querySelector(${JSON.stringify(INPUT)}).value`;
const ENTER = `document.querySelector(${JSON.stringify(
	INPUT
)}).dispatchEvent(new KeyboardEvent("keypress", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true}))`;
const key = (name, code) =>
	`document.querySelector(${JSON.stringify(
		INPUT
	)}).dispatchEvent(new KeyboardEvent("keydown", {key: ${JSON.stringify(
		name
	)}, code: ${JSON.stringify(
		name
	)}, keyCode: ${code}, which: ${code}, bubbles: true, cancelable: true}))`;

/** An own row that carries `text` and is no longer the pending copy. */
const settledSelf = (text) =>
	`[...document.querySelectorAll(".msg.self:not(.pending)")].some((m) => m.textContent.includes(${JSON.stringify(
		text
	)}))`;

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
		ws.send(`USER ${nick} 0 * :seance composer listener`);
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
		say: (text) => ws.send(`PRIVMSG ${CHANNEL} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

/** Bounded wait for the listener's copy of a line: the relay is not the echo. */
async function heard(other, text, timeout = 10000) {
	const deadline = Date.now() + timeout;

	for (;;) {
		if (other.heard().includes(text)) {
			return true;
		}

		if (Date.now() > deadline) {
			return false;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function openPanel(page) {
	await page.evaluate(
		`document.querySelector(${JSON.stringify(
			GLOBE
		)}).dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true}))`
	);
	await page.waitFor(`!!document.querySelector(".translation-panel")`, {label: "panel open"});
}

async function setWriteTarget(page, code) {
	await openPanel(page);
	await page.evaluate(
		`(() => { const s = document.querySelector('.translation-panel select[name="translateWrite"]'); s.value = ${JSON.stringify(
			code
		)}; s.dispatchEvent(new Event("change", {bubbles: true})); })()`
	);
	await page.evaluate(
		`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true}))`
	);
	await page.waitFor(`!document.querySelector(".translation-panel")`, {label: "panel closed"});
}

/**
 * The phone layout, under `--mobile`: the same choices as a full-screen
 * sheet, with room to press them. Whether the harness's emulation also
 * reports a touch-primary device decides how the sheet is opened here — a
 * tap on the globe where it does (there is no right-click on a phone), the
 * synthetic contextmenu where only the width query makes the layout.
 */
async function panelIsASheet(page) {
	const touch = await page.evaluate(`matchMedia("(hover: none) and (pointer: coarse)").matches`);

	page.check(`--mobile emulates a touch-primary device: ${touch}`, true);

	if (touch) {
		await page.click(GLOBE);
	} else {
		await openPanel(page);
	}

	await page.waitFor(`!!document.querySelector(".translation-panel--sheet")`, {
		label: "the panel came up as a sheet",
	});

	const rect = await page.rect(".translation-panel--sheet");
	const viewport = await page.evaluate(`({w: innerWidth, h: innerHeight})`);
	const size = rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "none";

	await page.check(
		`the sheet fills the viewport (${size} of ${viewport.w}x${viewport.h})`,
		!!rect &&
			Math.round(rect.x) === 0 &&
			Math.round(rect.y) === 0 &&
			Math.round(rect.width) === viewport.w &&
			Math.round(rect.height) === viewport.h
	);
	await page.check(
		"formality is a segmented control, not a native picker",
		await page.evaluate(
			`!!document.querySelector('.translation-panel-segmented[role="radiogroup"]') && !document.querySelector('select[name="translateFormality"]')`
		)
	);

	// The formality group alone: the reading switch above it is a segmented
	// control of its own (Off/On) in this layout.
	const segments = await page.evaluate(
		`[...document.querySelectorAll('.translation-panel-segment[name="translateFormality"]')].map((b) => b.textContent.trim())`
	);

	await page.check(
		`the three choices are spelled out (${segments.join(", ")})`,
		segments.join("|") === "As written|Formally|Casually"
	);
	await page.check(
		"the write target is a native select in this layout too",
		await page.evaluate(
			`!!document.querySelector('.translation-panel select[name="translateWrite"]')`
		)
	);
	await page.check(
		"the hints the desktop panel omits are shown",
		(await page.evaluate(
			`getComputedStyle(document.querySelector(".translation-panel-hint")).display`
		)) !== "none"
	);
	await page.check(
		"the close button is on screen",
		await page.evaluate(
			`(() => {
				const r = document.querySelector(".translation-panel-close").getBoundingClientRect();
				return r.height > 0 && r.bottom <= innerHeight + 1;
			})()`
		)
	);
	await page.screenshot("translation-sheet");
	await page.click(".translation-panel-close");
	await page.waitFor(`!document.querySelector(".translation-panel")`, {
		label: "the close button closed the sheet",
	});
}

async function typeAndEnter(page, text) {
	await page.fill(INPUT, text);
	await page.evaluate(ENTER);
}

/**
 * The newline-first keyboard case (F8): with a strip up, the Return's
 * newline arrives as an `input` event before the keypress, and the strip
 * must survive it so that Enter sends the translation instead of
 * translating the draft afresh.
 */
async function newlineFirstKeyboard(page, other) {
	const nlDraft = `the keyboard sends its newline first ${RUN}`;

	await typeAndEnter(page, nlDraft);
	await page.waitFor(`${barText} === ${JSON.stringify(`[German] ${nlDraft}`)}`, {
		timeout: 20000,
		label: "the newline case translated",
	});
	await page.waitFor(
		`!!document.querySelector(".translate-bar-send") && !document.querySelector(".translate-bar-send").disabled`,
		{timeout: 25000, label: "its read-back finished"}
	);
	await newlineThenEnter(page, "prose");
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the newline-first Enter sent the translation",
	});
	await page.check(
		"the other user heard the translation, not the draft",
		(await heard(other, `[German] ${nlDraft}`)) && !other.heard().includes(nlDraft)
	);
	await page.check(
		"the input cleared, newline and all",
		(await page.evaluate(inputValue)) === ""
	);

	const nlAction = `nods at the keyboard ${RUN}`;

	await typeAndEnter(page, `/me ${nlAction}`);
	await page.waitFor(`${barText} === ${JSON.stringify(`[German] ${nlAction}`)}`, {
		timeout: 20000,
		label: "the action's newline case translated",
	});
	await page.waitFor(
		`!!document.querySelector(".translate-bar-send") && !document.querySelector(".translate-bar-send").disabled`,
		{timeout: 25000, label: "the action's read-back finished"}
	);
	await newlineThenEnter(page, "/me");
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the newline-first Enter sent the action",
	});
	await page.check(
		"the other user heard the translated ACTION",
		await heard(other, `\u0001ACTION [German] ${nlAction}\u0001`)
	);
	await page.fill(INPUT, "");
}

/**
 * The second Enter as a newline-first keyboard delivers it: the Return's
 * newline lands in the draft as an `input` event and only then does the
 * `keypress` arrive (ChatInput.vue onSubmit strips exactly that newline
 * back off). The two go out as separate evaluates on purpose -- the strip's
 * watcher flushes in a microtask, so putting them in one call would let the
 * case pass whether or not the draft-comparison tolerates the newline.
 */
async function appendNewline(page) {
	await page.evaluate(
		`(() => {
			const el = document.querySelector(${JSON.stringify(INPUT)});
			const set = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value"
			).set;
			set.call(el, el.value + "\\n");
			el.dispatchEvent(new Event("input", {bubbles: true}));
		})()`
	);
}

async function newlineThenEnter(page, label) {
	await appendNewline(page);
	await page.check(
		`the strip survived the trailing newline (${label})`,
		await page.evaluate(`!!document.querySelector(${JSON.stringify(BAR)})`)
	);
	await page.evaluate(ENTER);
}

/**
 * The other half of the same rule, on a hardware keyboard: the Return is
 * preventDefaulted and never reaches the draft, so a trailing newline is a
 * deliberate Shift+Enter -- an edit of the draft like any other, and the
 * strip the draft was translated into goes.
 */
async function hardwareNewlineIsAnEdit(page) {
	const draft = `shift and enter is an edit ${RUN}`;

	await typeAndEnter(page, draft);
	await page.waitFor(`${barText} === ${JSON.stringify(`[German] ${draft}`)}`, {
		timeout: 20000,
		label: "a strip to edit",
	});
	await appendNewline(page);
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the hardware keyboard's newline dropped the strip",
	});
	await page.check(
		"the draft kept its newline (nothing stripped it)",
		(await page.evaluate(inputValue)) === `${draft}\n`
	);
	await page.fill(INPUT, "");
}

export default async function run(page) {
	const other = listener(LISTENER);

	// The strip's Copy button goes through navigator.clipboard, which a
	// headless page is not granted by default.
	await page.grantPermissions(["clipboardReadWrite", "clipboardSanitizedWrite"], BASE);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector(${JSON.stringify(INPUT)})`, {
		timeout: 20000,
		label: "the channel view",
	});
	await page.waitFor(`!!document.querySelector(${JSON.stringify(GLOBE)})`, {
		timeout: 20000,
		label: "the globe (the fake reports a GPU)",
	});
	await other.joined;

	// Scrollback for the context: a line from the other user before any
	// draft, so a request built from the channel has something to quote
	// whatever the channel's history holds.
	const opener = `did anyone look at the log rotation ${RUN}`;

	other.say(opener);
	await page.waitFor(`document.body.innerText.includes(${JSON.stringify(opener)})`, {
		timeout: 20000,
		label: "the other user's line in the channel",
	});

	// 0. One message, one language: no write target on the channel, and the
	// composer's translate button translates the draft this once into a
	// language picked in its dialog; the strip comes up as for a write
	// target and Enter sends the translation. The button is dead on an
	// empty draft, and the dialog remembers the language for the next pick.
	const ONCE = "#form #translate-once";
	const ONCE_SELECT = '.source-language-picker select[name="translateInto"]';
	const onceDraft = `could someone translate just this one line ${RUN}`;

	await page.waitFor(`!!document.querySelector(${JSON.stringify(ONCE)})`, {
		label: "the composer's translate button",
	});
	// The button is the send target's toggle, live with or without a
	// draft; with one, the dialog offers "This message only".
	await page.check(
		"the translate button is live on an empty draft",
		!(await page.evaluate(`document.querySelector(${JSON.stringify(ONCE)}).disabled`))
	);
	await page.check(
		"the translate button is off with no send target",
		(await page.evaluate(
			`document.querySelector(${JSON.stringify(ONCE)}).getAttribute("aria-pressed")`
		)) === "false"
	);
	await page.fill(INPUT, onceDraft);
	await page.click(ONCE);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(ONCE_SELECT)})`, {
		label: "the translate-into dialog",
	});
	// Nothing picked on this channel yet: the target starts as the language
	// the interface is in, not as whatever sorts first in the list.
	await page.check(
		"the dialog starts on the interface's own language",
		(await page.evaluate(`document.querySelector(${JSON.stringify(ONCE_SELECT)}).value`)) ===
			"en"
	);
	await page.check(
		"the dialog's languages are named in the interface language",
		await page.evaluate(
			`(() => {
				const s = document.querySelector(${JSON.stringify(ONCE_SELECT)});
				const text = (v) => s.querySelector('option[value="' + v + '"]').textContent.trim();
				// Not the endonym: an English interface offers "French"
				// (SourceLanguagePicker.vue name()).
				const names = new Intl.DisplayNames(
					[document.documentElement.lang || "en"],
					{type: "language"}
				);
				return text("de") === names.of("de") && text("fr") === names.of("fr");
			})()`
		)
	);
	await page.evaluate(
		`(() => { const s = document.querySelector(${JSON.stringify(
			ONCE_SELECT
		)}); s.value = "es"; s.dispatchEvent(new Event("change", {bubbles: true})); })()`
	);
	await page.click(".source-language-picker-once-box");
	await page.click(".source-language-picker-confirm");
	await page.waitFor(
		`(document.querySelector(${JSON.stringify(
			BAR_TEXT
		)}) || {}).textContent === ${JSON.stringify(`[Spanish] ${onceDraft}`)}`,
		{timeout: 30000, label: "the one-off translation is in the strip"}
	);
	await page.check(
		"the strip's chip names the picked language",
		String(
			await page.evaluate(`(document.querySelector(".translate-bar-chip") || {}).textContent`)
		).includes("Spanish")
	);
	await page.check(
		"the channel still has no write target",
		(await page.evaluate(
			`document.querySelector("#form #input").getAttribute("placeholder")`
		)) === `Write to ${CHANNEL}`
	);
	// The read-back under the strip runs first; a send waits for it.
	await page.waitFor(
		`(document.querySelector(".translate-bar-check .translate-bar-text") || {}).textContent === ${JSON.stringify(
			`[English] [Spanish] ${onceDraft}`
		)}`,
		{timeout: 30000, label: "the one-off translation's read-back"}
	);
	await page.evaluate(ENTER);
	await page.check(
		"Enter sent the one-off translation",
		await heard(other, `[Spanish] ${onceDraft}`)
	);
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the strip is gone after the send",
	});

	// The same language twice is a cleanup pass: the fake "corrects" the
	// line, the chip says so, and Enter sends the corrected line.
	const ONCE_FROM = '.source-language-picker select[name="translateFrom"]';
	const polishDraft = `pls fix my speling here ${RUN}`;

	await page.fill(INPUT, polishDraft);
	await page.click(ONCE);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(ONCE_SELECT)})`, {
		label: "the dialog for the cleanup",
	});
	// The channel's last one-off, not the interface's language: a
	// remembered pick still outranks the default (`lastOnceTarget`).
	await page.check(
		"the dialog remembers Spanish, the one-off picked before it",
		(await page.evaluate(`document.querySelector(${JSON.stringify(ONCE_SELECT)}).value`)) ===
			"es"
	);
	await page.check(
		"the dialog's source starts as the language the page reads",
		(await page.evaluate(`document.querySelector(${JSON.stringify(ONCE_FROM)}).value`)) === "en"
	);
	await page.evaluate(
		`(() => { const s = document.querySelector(${JSON.stringify(
			ONCE_SELECT
		)}); s.value = "en"; s.dispatchEvent(new Event("change", {bubbles: true})); })()`
	);
	await page.waitFor(`!!document.querySelector(".source-language-picker-hint")`, {
		label: "the same-language hint",
	});
	// The same language twice corrects rather than translates, and the
	// button says which of the two it is.
	await page.check(
		"the confirm button says Correct for a same-language pick",
		(await page.evaluate(
			`document.querySelector(".source-language-picker-confirm").textContent.trim()`
		)) === "Correct"
	);
	await page.click(".source-language-picker-once-box");
	await page.click(".source-language-picker-confirm");
	await page.waitFor(
		`(document.querySelector(${JSON.stringify(
			BAR_TEXT
		)}) || {}).textContent === ${JSON.stringify(`[Corrected] ${polishDraft}`)}`,
		{timeout: 30000, label: "the cleanup is in the strip"}
	);
	await page.check(
		"the strip's chip says the line was corrected",
		String(
			await page.evaluate(`(document.querySelector(".translate-bar-chip") || {}).textContent`)
		).includes("corrected")
	);
	await page.check(
		"no read-back row under a corrected line",
		(await page.count(".translate-bar-check")) === 0
	);
	await page.evaluate(ENTER);
	await page.check(
		"Enter sent the corrected line",
		await heard(other, `[Corrected] ${polishDraft}`)
	);
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the strip is gone after the corrected send",
	});

	// The button as a toggle: with no draft, a pick without "This message
	// only" becomes the channel's send target -- the button lit, the
	// placeholder saying so -- until the button is clicked again.
	await page.fill(INPUT, "");
	await page.click(ONCE);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(ONCE_SELECT)})`, {
		label: "the dialog on an empty draft",
	});
	await page.check(
		"no one-off box without a draft",
		(await page.count(".source-language-picker-once-box")) === 0
	);
	await page.evaluate(
		`(() => { const s = document.querySelector(${JSON.stringify(
			ONCE_SELECT
		)}); s.value = "de"; s.dispatchEvent(new Event("change", {bubbles: true})); })()`
	);
	await page.click(".source-language-picker-confirm");
	await page.waitFor(
		`document.querySelector(${JSON.stringify(ONCE)}).getAttribute("aria-pressed") === "true"`,
		{label: "the button is on"}
	);
	await page.check(
		"the placeholder says the channel sends in German",
		(await page.evaluate(
			`document.querySelector("#form #input").getAttribute("placeholder")`
		)) === `Write to ${CHANNEL} · sent in German`
	);
	const modeDraft = `sent while the button is on ${RUN}`;

	await typeAndEnter(page, modeDraft);
	await page.waitFor(
		`(document.querySelector(${JSON.stringify(
			BAR_TEXT
		)}) || {}).textContent === ${JSON.stringify(`[German] ${modeDraft}`)}`,
		{timeout: 30000, label: "the first Enter translates under the button's target"}
	);
	await page.waitFor(
		`(document.querySelector(".translate-bar-check .translate-bar-text") || {}).textContent === ${JSON.stringify(
			`[English] [German] ${modeDraft}`
		)}`,
		{timeout: 30000, label: "its read-back"}
	);
	await page.evaluate(ENTER);
	await page.check(
		"the second Enter sends it in German",
		await heard(other, `[German] ${modeDraft}`)
	);
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the strip is gone after the German send",
	});
	await page.click(ONCE);
	await page.waitFor(
		`document.querySelector(${JSON.stringify(ONCE)}).getAttribute("aria-pressed") === "false"`,
		{label: "the button is off again"}
	);
	await page.check(
		"the placeholder is plain again",
		(await page.evaluate(
			`document.querySelector("#form #input").getAttribute("placeholder")`
		)) === `Write to ${CHANNEL}`
	);

	// The next pick starts from the language picked last time.
	await page.fill(INPUT, `and this one too ${RUN}`);
	await page.click(ONCE);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(ONCE_SELECT)})`, {
		label: "the dialog again",
	});
	await page.check(
		"the dialog remembers English, the last pick",
		(await page.evaluate(`document.querySelector(${JSON.stringify(ONCE_SELECT)}).value`)) ===
			"en"
	);
	await page.screenshot("translate-once", {selector: "#form"});
	await page.click(".source-language-picker-cancel");
	await page.waitFor(`!document.querySelector(${JSON.stringify(ONCE_SELECT)})`, {
		label: "the dialog closed",
	});
	await page.fill(INPUT, "");

	// 1. The write target.
	await openPanel(page);
	await page.check(
		"the write target options are named in the interface language",
		await page.evaluate(
			`(() => {
				const s = document.querySelector('.translation-panel select[name="translateWrite"]');
				const text = (v) => s.querySelector('option[value="' + v + '"]').textContent.trim();
				// The panel names a language in the language the channel is
				// read in, not in itself (TranslationPanel.vue name()).
				const names = new Intl.DisplayNames(
					[document.documentElement.lang || "en"],
					{type: "language"}
				);
				return text("de") === names.of("de") && text("fr") === names.of("fr");
			})()`
		)
	);
	await page.evaluate(
		`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true}))`
	);
	await page.waitFor(`!document.querySelector(".translation-panel")`, {label: "panel closed"});

	// A write target that is the page's own language: every draft in it is
	// corrected on the first Enter, and the placeholder says so.
	const correctedDraft = `my speling is awful in here ${RUN}`;

	await setWriteTarget(page, "en");
	await page.check(
		"the placeholder says the channel sends corrected",
		(await page.evaluate(
			`document.querySelector("#form #input").getAttribute("placeholder")`
		)) === `Write to ${CHANNEL} · sent corrected`
	);
	await typeAndEnter(page, correctedDraft);
	await page.waitFor(
		`(document.querySelector(${JSON.stringify(
			BAR_TEXT
		)}) || {}).textContent === ${JSON.stringify(`[Corrected] ${correctedDraft}`)}`,
		{
			timeout: 30000,
			label: "the first Enter corrects a draft in the write target's own language",
		}
	);
	await page.check(
		"its chip says corrected",
		String(
			await page.evaluate(`(document.querySelector(".translate-bar-chip") || {}).textContent`)
		).includes("corrected")
	);
	await page.evaluate(ENTER);
	await page.check(
		"the second Enter sends the corrected line",
		await heard(other, `[Corrected] ${correctedDraft}`)
	);
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the strip is gone after the corrected send",
	});

	await setWriteTarget(page, "de");
	await page.check(
		"the placeholder says the channel sends in German",
		(
			await page.evaluate(`document.querySelector(${JSON.stringify(INPUT)}).placeholder`)
		).includes("sent in German")
	);

	if (MOBILE) {
		await panelIsASheet(page);
	}

	// 2. The first Enter translates into the strip.
	const draft = `please keep the timestamps in the log ${RUN}`;

	await typeAndEnter(page, draft);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(BAR)})`, {label: "the strip"});
	// The chip is the pair, named in the reading language (English here);
	// the source joins it once the route has answered.
	await page.waitFor(
		`(document.querySelector(".translate-bar-chip") || {textContent: ""}).textContent.trim() === "English → German"`,
		{timeout: 20000, label: "the chip reads English → German"}
	);
	await page.check(
		"Send is disabled while it streams",
		await page.evaluate(`document.querySelector("#submit").disabled`)
	);
	await page.waitFor(
		`${barText}.startsWith("[German] please keep") && !document.querySelector(".translate-bar-caret")`,
		{timeout: 20000, label: "the translation streamed to the end"}
	);
	await page.check(
		"the draft is still in the input",
		(await page.evaluate(inputValue)) === draft
	);
	await page.check(
		"the request went out as a write",
		(await page.evaluate(
			`${REQUESTS}.some((r) => r.purpose === "write" && r.text === ${JSON.stringify(draft)})`
		)) === true
	);

	// The route behind the strip, in the chip's title: the pair, the model's
	// own id, and GPU or CPU. The fake runs as the `llm` candidate, so this
	// one is a GPU route.
	const chipTitle = String(
		await page.evaluate(`document.querySelector(".translate-bar-chip").title`)
	);

	await page.check(
		`the chip's title names the route it took (${chipTitle})`,
		chipTitle.includes("→ German") && chipTitle.endsWith("(GPU)")
	);
	await page.screenshot("composer-strip");

	// 3. Typing drops the strip; the next Enter translates afresh.
	await page.fill(INPUT, `${draft} edited`);
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "typing dropped the strip",
	});
	await page.evaluate(ENTER);
	await page.waitFor(`${barText} === ${JSON.stringify(`[German] ${draft} edited`)}`, {
		timeout: 20000,
		label: "translated again",
	});

	// 4. The check runs automatically and Send waits for it.
	await page.waitFor(`!!document.querySelector(".translate-bar-check")`, {
		timeout: 20000,
		label: "the check started",
	});
	await page.check(
		"Send is disabled while the check runs",
		await page.evaluate(`document.querySelector("#submit").disabled`)
	);
	await page.waitFor(
		`(document.querySelector(".translate-bar-check .translate-bar-text") || {}).textContent === ${JSON.stringify(
			`[English] [German] ${draft} edited`
		)}`,
		{timeout: 20000, label: "the read-back line"}
	);
	await page.check(
		"the read-back row is labelled German → English",
		(await page.evaluate(
			`(document.querySelector(".translate-bar-check-label") || {textContent: ""}).textContent.trim()`
		)) === "German → English"
	);
	await page.check(
		"the read-back row is marked as the reading language",
		(await page.evaluate(
			`(document.querySelector(".translate-bar-check .translate-bar-text") || {}).lang`
		)) === "en"
	);
	await page.check(
		"Send is enabled once the check ends",
		!(await page.evaluate(`document.querySelector("#submit").disabled`)) &&
			!(await page.evaluate(`document.querySelector(".translate-bar-send").disabled`))
	);
	await page.check(
		"the check went out as a read",
		(await page.evaluate(`${REQUESTS}.slice(-1)[0].purpose`)) === "read"
	);
	// The read-back is built like an incoming line's translation: the check
	// for this translation carried the channel's recent lines.
	const readBackRequests = `${REQUESTS}.filter((r) => r.purpose === "read" && r.text.indexOf(${JSON.stringify(
		`${draft} edited`
	)}) !== -1)`;

	await page.check(
		"the read-back carried the channel's context",
		await page.evaluate(
			`(() => { const reads = ${readBackRequests}; return reads.length > 0 && reads[0].contextLines > 0; })()`
		)
	);
	await page.check(
		"the read-back quoted no voice (that is the writer's)",
		(await page.evaluate(`${readBackRequests}[0].voice`)) === 0
	);

	const readBackText = await page.evaluate(
		`(document.querySelector(".translate-bar-check .translate-bar-text") || {}).textContent`
	);

	await page.screenshot("composer-check");

	// 5. The second Enter sends the translation.
	const requestsBeforeSend = await page.evaluate(`${REQUESTS}.length`);
	/** The translation row under the own line carrying `text`, settled or not. */
	const ownTranslation = (text, settled) =>
		`(() => {
			const row = [...document.querySelectorAll(${JSON.stringify(
				settled ? ".msg.self:not(.pending)" : ".msg.self"
			)})].find((m) => m.textContent.includes(${JSON.stringify(text)}));
			const line = row && row.querySelector(".msg-translation-text");
			return line ? line.textContent.trim() : "";
		})()`;

	await page.evaluate(ENTER);
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the strip went with the send",
	});
	await page.waitFor(settledSelf(`[German] ${draft} edited`), {
		timeout: 20000,
		label: "the translation in the timeline, echoed back",
	});
	await page.waitFor(
		`${ownTranslation(`[German] ${draft} edited`, true)} === ${JSON.stringify(readBackText)}`,
		{timeout: 5000, label: "the posted line shows the read-back as its translation"}
	);
	await page.check(
		"the posted line's chip names German → English",
		await page.evaluate(
			`(() => {
				const row = [...document.querySelectorAll(".msg.self:not(.pending)")].find((m) =>
					m.textContent.includes(${JSON.stringify(`[German] ${draft} edited`)})
				);
				const chip = row && row.querySelector(".msg-translation-chip");
				return !!chip && chip.textContent.trim() === "German → English";
			})()`
		)
	);
	await page.check(
		"no translation request was made for the posted line",
		(await page.evaluate(`${REQUESTS}.length`)) === requestsBeforeSend
	);
	await page.screenshot("composer-posted-read-back");
	await page.check("the input cleared", (await page.evaluate(inputValue)) === "");
	await page.check(
		"the other user heard the German line",
		await heard(other, `[German] ${draft} edited`)
	);
	await page.check(
		"the other user never heard the draft",
		!other.heard().includes(`${draft} edited`)
	);
	// ArrowUp in an empty input edits the newest own line (the translation);
	// Escape dismisses that, and the next ArrowUp walks the input history,
	// where the original draft is what was kept.
	await page.evaluate(key("ArrowUp", 38));
	await page.waitFor(`!!document.querySelector(".compose-bar")`, {
		label: "ArrowUp edits the sent line",
	});
	await page.check(
		"the edit holds the translation that was sent",
		(await page.evaluate(inputValue)) === `[German] ${draft} edited`
	);
	await page.evaluate(key("Escape", 27));
	await page.waitFor(`!document.querySelector(".compose-bar")`, {label: "the edit dismissed"});
	await page.evaluate(key("ArrowUp", 38));
	await page.check(
		"ArrowUp then recalls the original draft from the history",
		(await page.evaluate(inputValue)) === `${draft} edited`
	);
	await page.fill(INPUT, "");

	// 5b. The Return of a newline-first keyboard (Android's, iOS's) puts
	// its newline in the draft before the keypress reaches the composer.
	// The strip is a translation of the draft, and that newline is not an
	// edit of it: it must not cancel the strip, or the Enter that follows
	// would translate afresh instead of sending what is on screen. Both
	// shapes of draft, since the comparison is against the part the strip
	// translated: plain prose, and a `/me` whose command is not in it.
	//
	// Only under --mobile: ChatInput.vue's onEnterKey takes the
	// newline-tolerating path (onSubmit(true), which strips the newline
	// back off) on a touch-primary device alone. With a hardware keyboard
	// it preventDefaults the Return, so no newline ever reaches the draft
	// that way and one that does is a deliberate Shift+Enter -- the
	// desktop run asserts that opposite.
	if (MOBILE) {
		await newlineFirstKeyboard(page, other);
	} else {
		await hardwareNewlineIsAnEdit(page);
	}

	// 6. Escape drops a strip and keeps the draft.
	const kept = `this one I will keep typing ${RUN}`;

	await typeAndEnter(page, kept);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "a strip to escape",
	});
	await page.evaluate(key("Escape", 27));
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "Escape dropped the strip",
	});
	await page.check("Escape kept the draft", (await page.evaluate(inputValue)) === kept);

	// 7. A failure offers the draft as written.
	const failing = `[fail] this one breaks on purpose ${RUN}`;

	await typeAndEnter(page, failing);
	await page.waitFor(`!!document.querySelector(".translate-bar.failed")`, {
		timeout: 20000,
		label: "the failure strip",
	});
	await page.check(
		"the send button offers the draft as written",
		(await page.evaluate(
			`document.querySelector(".translate-bar-send").getAttribute("aria-label")`
		)) === "Send as written" &&
			(await page.evaluate(
				`document.querySelector(".translate-bar-send").getAttribute("title")`
			)) === "Send as written"
	);
	await page.screenshot("composer-failed");
	await page.evaluate(ENTER);
	await page.waitFor(settledSelf(`this one breaks on purpose ${RUN}`), {
		timeout: 20000,
		label: "sent as written",
	});
	await page.check(
		"the line that went carries the draft, untranslated",
		await page.evaluate(
			`[...document.querySelectorAll(".msg.self")].some((m) => m.textContent.includes(${JSON.stringify(
				failing
			)}))`
		)
	);

	// 7b. An answer equal to the draft is no translation either: the fake's
	// "[echo]" token hands the text straight back, and the strip says so
	// rather than offering the draft as its own translation.
	const echoed = `[echo] this one comes back as typed ${RUN}`;

	await typeAndEnter(page, echoed);
	await page.waitFor(`!!document.querySelector(".translate-bar.failed")`, {
		timeout: 20000,
		label: "the echo strip",
	});
	await page.check(
		"the reason says the line came back unchanged",
		(await page.evaluate(
			`(document.querySelector(".translate-bar-reason") || {}).textContent`
		)) === "came back unchanged"
	);

	// The echo bought one more generation, and a bare one: the same draft
	// with the source left to the model and nothing of the channel in the
	// prompt. Filtered by the draft's own text rather than counted, because
	// the retry is not the only request the page makes.
	const echoWrites = `${REQUESTS}.filter((r) => r.purpose === "write" && r.text.indexOf("[echo]") !== -1)`;
	const echoTitle = await page.evaluate(`document.querySelector(".translate-bar-chip").title`);

	await page.check(
		"the echo was tried twice, the second time bare",
		await page.evaluate(
			`(() => {
				const tries = ${echoWrites};
				return (
					tries.length === 2 &&
					tries[1].from === null &&
					tries[1].contextLines === 0 &&
					tries[1].voice === 0
				);
			})()`
		)
	);
	await page.check(
		"the first try carried the channel's context",
		(await page.evaluate(`${echoWrites}[0].contextLines`)) > 0
	);
	await page.check(
		"the chip's title says the retry named no source",
		(() => {
			const title = String(echoTitle);

			return title.startsWith("auto → German") && title.endsWith("retried without a source");
		})()
	);
	await page.check(
		"the dev build kept the retry as the last composer request",
		await page.evaluate(
			`(() => {
				const last = window.seanceTranslateLast;
				return (
					!!last &&
					last.kind === "write" &&
					last.retry === true &&
					last.error === "came back unchanged" &&
					last.from === null &&
					last.context.recent.length === 0 &&
					(window.seanceTranslateLog || []).length >= 2
				);
			})()`
		)
	);
	await page.check(
		"the send button offers the draft as written",
		(await page.evaluate(
			`document.querySelector(".translate-bar-send").getAttribute("aria-label")`
		)) === "Send as written"
	);
	await page.screenshot("composer-echoed");
	await page.evaluate(ENTER);
	await page.waitFor(settledSelf(echoed), {
		timeout: 20000,
		label: "the echoed draft sent as written",
	});
	await page.check("the other user heard the draft as typed", await heard(other, echoed));
	await page.check(
		"the input cleared after the echo send",
		(await page.evaluate(inputValue)) === ""
	);

	// 7c. The bare second try is a real second chance: the fake's
	// "[echo-once]" token hands the first request back and translates the
	// next one, so the strip ends done with the retry's translation and the
	// second Enter sends it like any other.
	const retried = `[echo-once] this one needs a second try ${RUN}`;

	await typeAndEnter(page, retried);
	await page.waitFor(`${barText} === ${JSON.stringify(`[German] ${retried}`)}`, {
		timeout: 30000,
		label: "the bare retry's translation",
	});
	await page.check(
		"the strip is not a failure",
		!(await page.evaluate(`!!document.querySelector(".translate-bar.failed")`))
	);
	// The chip is the draft's direction, not the request's source: the bare
	// retry named none, and the label still reads English → German; the
	// title is where the retry shows.
	await page.check(
		"the chip still reads English → German after the retry",
		(await page.evaluate(
			`document.querySelector(".translate-bar-chip").textContent.trim()`
		)) === "English → German"
	);

	const retryTitle = String(
		await page.evaluate(`document.querySelector(".translate-bar-chip").title`)
	);

	await page.check(
		`the chip's title mentions the retry (${retryTitle})`,
		retryTitle.startsWith("auto → German") && retryTitle.includes("retried without a source")
	);

	const retryWrites = `${REQUESTS}.filter((r) => r.purpose === "write" && r.text.indexOf("[echo-once]") !== -1)`;

	await page.check(
		"the retried draft went out twice, the second time bare",
		await page.evaluate(
			`(() => {
				const tries = ${retryWrites};
				return (
					tries.length === 2 &&
					tries[0].contextLines > 0 &&
					tries[1].from === null &&
					tries[1].contextLines === 0
				);
			})()`
		)
	);
	await page.check(
		"the capture holds both tries and only the first as an echo",
		await page.evaluate(
			`(() => {
				const log = (window.seanceTranslateLog || []).filter(
					(e) => e.kind === "write" && e.draft === ${JSON.stringify(retried)}
				);
				return (
					log.length === 2 &&
					log[0].retry === false &&
					log[0].error === "came back unchanged" &&
					log[1].retry === true &&
					log[1].error === null
				);
			})()`
		)
	);
	await page.screenshot("composer-retried");
	await page.waitFor(
		`!!document.querySelector(".translate-bar-send") && !document.querySelector(".translate-bar-send").disabled`,
		{timeout: 30000, label: "the round trip finished and Send is offered"}
	);
	await page.evaluate(ENTER);
	await page.waitFor(settledSelf(`[German] ${retried}`), {
		timeout: 20000,
		label: "the retry's translation in the timeline",
	});
	await page.check(
		"the other user heard the retry's translation",
		await heard(other, `[German] ${retried}`)
	);
	await page.check(
		"the input cleared after the retry send",
		(await page.evaluate(inputValue)) === ""
	);

	// 7d. A read-back that answers the question instead of translating it
	// gets the bare second try an echo gets: the fake's "[answer]" token
	// replies to a read request without a question mark (the draft's own
	// translation, a write, keeps its mark), so the round trip asks twice,
	// the second time bare, and then says it couldn't check.
	const asked = `is the [answer] build green again ${RUN}?`;

	await typeAndEnter(page, asked);
	await page.waitFor(`${barText} === ${JSON.stringify(`[German] ${asked}`)}`, {
		timeout: 30000,
		label: "the question's translation keeps its mark",
	});
	await page.waitFor(`!!document.querySelector(".translate-bar-check .translate-bar-failed")`, {
		timeout: 30000,
		label: "the answered read-back fails the check",
	});

	const answeredReads = `${REQUESTS}.filter((r) => r.purpose === "read" && r.text.indexOf(${JSON.stringify(
		`build green again ${RUN}`
	)}) !== -1)`;

	await page.check(
		"the answered read-back was tried twice, the second time bare",
		await page.evaluate(
			`(() => {
				const tries = ${answeredReads};
				return (
					tries.length === 2 &&
					tries[0].contextLines > 0 &&
					tries[1].from === null &&
					tries[1].contextLines === 0
				);
			})()`
		)
	);
	await page.check(
		"the capture judged both read-backs answered",
		await page.evaluate(
			`(() => {
				const log = (window.seanceTranslateLog || []).filter(
					(e) => e.kind === "check" && e.draft === ${JSON.stringify(`[German] ${asked}`)}
				);
				return (
					log.length === 2 &&
					log[0].retry === false &&
					log[1].retry === true &&
					log.every((e) => e.error === "answered the question instead of translating it")
				);
			})()`
		)
	);
	await page.screenshot("composer-answered-read-back");
	await page.fill(INPUT, "");
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		timeout: 10000,
		label: "clearing the draft dropped the strip",
	});

	// 8. `/me` is prose: its text translates and the command goes back on
	// the front of the translation. Every other command is left alone.
	const action = `waves ${RUN}`;

	await typeAndEnter(page, `/me ${action}`);
	await page.waitFor(`${barText} === ${JSON.stringify(`[German] ${action}`)}`, {
		timeout: 20000,
		label: "the action's text translated",
	});
	await page.check(
		"the draft kept its command while the strip is up",
		(await page.evaluate(inputValue)) === `/me ${action}`
	);
	await page.waitFor(
		`!!document.querySelector(".translate-bar-send") && !document.querySelector(".translate-bar-send").disabled`,
		{timeout: 25000, label: "the action's read-back finished"}
	);
	await page.evaluate(ENTER);
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the strip went with the action",
	});
	await page.waitFor(settledSelf(`[German] ${action}`), {
		timeout: 20000,
		label: "the action in the timeline",
	});
	await page.check(
		"the other user heard it as an ACTION, translated",
		await heard(other, `\u0001ACTION [German] ${action}\u0001`)
	);
	await page.check(
		"the input cleared after the action",
		(await page.evaluate(inputValue)) === ""
	);

	// A command that is not `/me` still goes out as typed, with no strip.
	await typeAndEnter(page, "/topic");
	await page.waitFor(`${inputValue} === ""`, {
		timeout: 20000,
		label: "the command was sent",
	});
	await page.check(
		"no strip for a command",
		!(await page.evaluate(`!!document.querySelector(${JSON.stringify(BAR)})`))
	);

	// 9. A multi-line draft keeps its lines. The form submit is the Send button's path.
	const lines = [`line one ${RUN}`, `line two ${RUN}`, `line three ${RUN}`];

	await page.fill(INPUT, lines.join("\n"));
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(
		`${barText} === ${JSON.stringify(lines.map((l) => `[German] ${l}`).join("\n"))}`,
		{
			timeout: 25000,
			label: "three lines translated as one",
		}
	);
	await page.check(
		"one numbered request carried the three lines",
		(await page.evaluate(`${REQUESTS}.slice(-1)[0].lines`)) === 3
	);
	// The automatic check runs on this draft too; Send waits for it.
	await page.waitFor(`!document.querySelector("#submit").disabled`, {
		timeout: 20000,
		label: "Send re-enabled once the multi-line draft's check ends",
	});
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(
		`document.body.innerText.includes(${JSON.stringify(`[German] line three ${RUN}`)})`,
		{
			timeout: 20000,
			label: "the three lines in the timeline",
		}
	);
	await page.check(
		"the other user heard all three German lines",
		(await heard(other, `[German] line one ${RUN}`)) &&
			(await heard(other, `[German] line two ${RUN}`)) &&
			(await heard(other, `[German] line three ${RUN}`))
	);

	// 9b. Markdown markers, a nick, a URL and a code span survive: the fake
	// echoes its input, so what the strip shows is exactly what was
	// protected and put back. The nick, the URL and the code span are
	// placeholders on every route — the engine never sees them — while the
	// marks themselves are what the LLM route is given (spans.ts
	// `LLM_MARKERS`, measured: bare `⟦n⟧` pairs around words it must
	// translate stop the model translating), and the fake runs as the `llm`
	// candidate here.
	const fidelity = `Hello everyone, this is supposed to be in *German*. Ask ${LISTENER}. See https://example.org/x and \`code\``;

	await page.fill(INPUT, "");
	await typeAndEnter(page, fidelity);
	await page.waitFor(`${barText} === ${JSON.stringify(`[German] ${fidelity}`)}`, {
		timeout: 25000,
		label: "the strip kept the markers, the nick, the URL and the code span",
	});

	const fidelityRequest = await page.evaluate(`${REQUESTS}.slice(-1)[0]`);

	await page.check(
		"the engine never saw the nick, the URL or the code span",
		!fidelityRequest.text.includes(LISTENER) &&
			!fidelityRequest.text.includes("https://example.org/x") &&
			!fidelityRequest.text.includes("`code`")
	);
	await page.check(
		`the LLM route was given the marks themselves (markers: ${fidelityRequest.markers})`,
		fidelityRequest.markers === "literal" && fidelityRequest.text.includes("*German*")
	);
	await page.screenshot("composer-markdown");

	// The strip can be copied and selected.
	await page.check(
		"the strip offers a Copy button once the translation is done",
		await page.evaluate(`!!document.querySelector(".translate-bar-copy")`)
	);
	await page.evaluate(`document.querySelector(".translate-bar-copy").click()`);
	await page.waitFor(
		`document.querySelector(".translate-bar-copy").getAttribute("aria-label") === "Copied" && document.querySelector(".translate-bar-copy").getAttribute("title") === "Copied"`,
		{timeout: 5000, label: "the Copy button's tooltip reads Copied"}
	);
	await page.check(
		"the strip's text is selectable",
		(await page.evaluate(
			`getComputedStyle(document.querySelector(".translate-bar-text")).userSelect`
		)) === "text"
	);
	await page.evaluate(key("Escape", 27));
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the fidelity strip dismissed",
	});

	// 9c. A fenced code block is one span: it is never sent for translation
	// and it comes back byte for byte, with the prose around it translated.
	const fenced = [`first line ${RUN}`, "```", "x = 1", "```", `last line ${RUN}`].join("\n");
	const fencedOut = [
		`[German] first line ${RUN}`,
		"```",
		"x = 1",
		"```",
		`[German] last line ${RUN}`,
	].join("\n");

	await page.fill(INPUT, fenced);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.waitFor(`${barText} === ${JSON.stringify(fencedOut)}`, {
		timeout: 25000,
		label: "the code block shipped verbatim, the prose around it translated",
	});
	await page.check(
		"only the two prose lines went to the engine",
		(await page.evaluate(`${REQUESTS}.slice(-1)[0].lines`)) === 2
	);
	await page.screenshot("composer-code-block");
	await page.evaluate(key("Escape", 27));
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the code-block strip dismissed",
	});
	await page.fill(INPUT, "");

	// 9d. Inline TeX and an emphasis pair together: the engine only ever
	// sees a placeholder for the math — its content must not change — while
	// the bold marks reach it as `**`, and both the primary strip and the
	// round-trip's read-back row keep them intact.
	const math = "the result is $`x^2`$ and it is **final**";

	await typeAndEnter(page, math);
	await page.waitFor(`${barText} === ${JSON.stringify(`[German] ${math}`)}`, {
		timeout: 25000,
		label: "the strip kept the TeX and the bold word",
	});
	await page.check(
		"the engine never saw the TeX literally",
		!(await page.evaluate(`${REQUESTS}.slice(-1)[0].text`)).includes("x^2")
	);
	await page.waitFor(
		`(document.querySelector(".translate-bar-check .translate-bar-text") || {}).textContent === ${JSON.stringify(
			`[English] [German] ${math}`
		)}`,
		{timeout: 25000, label: "the read-back row kept the TeX and the bold word too"}
	);
	await page.screenshot("composer-math");
	await page.evaluate(key("Escape", 27));
	await page.waitFor(`!document.querySelector(${JSON.stringify(BAR)})`, {
		label: "the math strip dismissed",
	});
	await page.fill(INPUT, "");

	// 9e. Reading is on and the posted line would be read: its text is German
	// behind the fake's "[French]" prefix, so the reading pipeline, which
	// reads own lines too, would translate it into English if it were not
	// the line the read-back is for. It keeps the read-back and no reading
	// request is made for it.
	await openPanel(page);
	await page.evaluate(
		`(() => { for (const s of document.querySelectorAll('.translation-panel-segmented .translation-panel-segment')) { if (s.textContent.trim() === "On") { s.click(); return; } } throw new Error("no On segment"); })()`
	);
	await page.evaluate(
		`document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true}))`
	);
	await page.waitFor(`!document.querySelector(".translation-panel")`, {label: "panel closed"});
	await page.waitFor(
		`document.querySelector(${JSON.stringify(GLOBE)}).classList.contains("on")`,
		{
			label: "reading is on in English",
		}
	);
	await setWriteTarget(page, "fr");

	const german = `Ich möchte die Protokolle morgen früh noch einmal gründlich prüfen ${RUN}`;
	const posted = `[French] ${german}`;
	const readsOfPosted = `${REQUESTS}.filter((r) => r.purpose === "read" && r.text.indexOf(${JSON.stringify(
		german
	)}) !== -1).length`;

	await typeAndEnter(page, german);
	await page.waitFor(`${barText} === ${JSON.stringify(posted)}`, {
		timeout: 25000,
		label: "the German draft translated into French",
	});
	await page.waitFor(
		`(document.querySelector(".translate-bar-check .translate-bar-text") || {}).textContent === ${JSON.stringify(
			`[English] ${posted}`
		)}`,
		{timeout: 25000, label: "the French line's read-back"}
	);
	await page.waitFor(
		`!!document.querySelector(".translate-bar-send") && !document.querySelector(".translate-bar-send").disabled`,
		{timeout: 20000, label: "Send offered once the read-back is done"}
	);

	const readsBeforeSend = Number(await page.evaluate(readsOfPosted));

	await page.check(
		`the read-back was the one reading request for the line so far (${readsBeforeSend})`,
		readsBeforeSend === 1
	);
	await page.evaluate(ENTER);
	await page.waitFor(settledSelf(posted), {
		timeout: 20000,
		label: "the French line in the timeline, echoed back",
	});
	await page.waitFor(
		`${ownTranslation(posted, true)} === ${JSON.stringify(`[English] ${posted}`)}`,
		{
			timeout: 5000,
			label: "the posted line shows its read-back",
		}
	);
	// The reader's path awaits the probe and detection before it queues, so
	// a request it made would only show up after a while.
	await page.sleep(3000);

	const readsAfterSend = Number(await page.evaluate(readsOfPosted));

	await page.check(
		`no reading request was made for the posted line (${readsAfterSend} read requests carry it)`,
		readsAfterSend === readsBeforeSend
	);
	await page.check(
		"the posted line still shows the read-back",
		(await page.evaluate(ownTranslation(posted, true))) === `[English] ${posted}`
	);
	await page.screenshot("composer-posted-read-while-reading");

	// 10. Off again: plain sending.
	await setWriteTarget(page, "");
	await page.check(
		"the placeholder is plain again",
		!(
			await page.evaluate(`document.querySelector(${JSON.stringify(INPUT)}).placeholder`)
		).includes("sent in")
	);
	await typeAndEnter(page, `plain again ${RUN}`);
	await page.waitFor(
		`document.body.innerText.includes(${JSON.stringify(`plain again ${RUN}`)})`,
		{
			timeout: 20000,
			label: "a plain line",
		}
	);
	await page.check(
		"no strip once off",
		!(await page.evaluate(`!!document.querySelector(${JSON.stringify(BAR)})`))
	);
	await page.check("the other user heard it as typed", await heard(other, `plain again ${RUN}`));

	await page.check("no console errors", page.consoleErrors.length === 0);
	other.quit();
	await page.screenshot("final");
}
