// Translation switched off, its default (client/js/settings.ts
// `translationEnabled`, translate/switch.ts): absent, not just disabled. No
// translate button in the composer or the message toolbar, no translation
// panel ("Translation…" in the channel menu opens Settings instead, where
// the switch is), no TranslationLine, no strip; Settings → Translation is the interface language and the switch
// alone, under a tab named "Language"; and nothing of the machinery runs --
// no worker script fetched, no Worker constructed, no GPU adapter asked
// for -- not on a cold load, not when the interface language changes with a
// channel whose kept per-channel reading is on. Switched on, all of it comes
// back without a reload, and the kept channel starts reading again;
// switched off, it goes again at once. Nor does it cost the rest of the app
// anything: a load the service worker serves while it is off is not
// cross-origin isolated.
//
// Two halves, one served development build and no ircd (the network is
// fabricated in-page, lib/fake-network.mjs, so window.socket must exist):
//
// 1. Without ?fakeTranslate, so the real worker path is what is watched: an
//    init script counts `new Worker(...)` and `navigator.gpu.requestAdapter`
//    and the resource timeline is read for js/translate-worker.js. The
//    positive control is the switch: on, Settings asks the worker what is
//    downloaded, so the script is fetched and a Worker made; off, it is
//    terminated.
// 2. With ?fakeTranslate (the in-page fake, which never makes a Worker), the
//    surfaces: composer button, toolbar Translate, the channel menu, a German
//    line read into English, the composer's strip for the kept write
//    target -- on, then off again.
//
//   NODE_ENV=development pnpm build
//   python3 -m http.server -d public 8021 &
//   SEANCE_HTTP=http://localhost:8021/ CHROME_BIN=/seance/tmp/chrome-pw.sh \
//     node tools/browser-drive.mjs tools/scenarios/translate-off.mjs
//   … --mobile --width=390 --height=844
//
// The scenario does NOT seed translation on (lib/translation.mjs): the
// default is what it is about.

import {readFileSync} from "node:fs";
import {fakeNetworkSnippet} from "./lib/fake-network.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));

export const url = BASE;

const NETWORK = "fake-0000-0000";
const CHANNEL = "#seance";
// Someone else's line in the fabricated channel (fake-network.mjs baseId 0).
const OTHER_MSG = 21;
const GERMAN = "Guten Morgen zusammen, wie geht es euch heute?";

// What the real machinery would leave behind, counted from the document's
// start: every Worker made (by its URL, and whether it was terminated) and
// every adapter asked for. A headless Chromium may have no navigator.gpu,
// in which case the probe asks nothing either way: the Worker and the
// resource timeline are the claims that always hold.
const WATCH = `(() => {
	window.__watch = {workers: [], gpuAsks: 0};
	const RealWorker = window.Worker;
	if (RealWorker) {
		window.Worker = class extends RealWorker {
			constructor(url, options) {
				super(url, options);
				const entry = {url: String(url), terminated: false};
				window.__watch.workers.push(entry);
				const terminate = this.terminate.bind(this);
				this.terminate = () => {
					entry.terminated = true;
					terminate();
				};
			}
		};
	}
	if (navigator.gpu && typeof navigator.gpu.requestAdapter === "function") {
		const ask = navigator.gpu.requestAdapter.bind(navigator.gpu);
		navigator.gpu.requestAdapter = (...args) => {
			window.__watch.gpuAsks++;
			return ask(...args);
		};
	}
})()`;

// A channel whose reading and write target were on before translation was
// switched off: kept (thelounge.translate), never acted on while off.
const KEPT_CHANNEL = `(() => {
	if (!localStorage.getItem("thelounge.translate")) {
		localStorage.setItem("thelounge.translate", JSON.stringify({
			${JSON.stringify(`${NETWORK}/${CHANNEL}`)}: {read: true, write: "de"},
		}));
	}
})()`;

const STAMP_MSGIDS = `(() => {
	const root = document.getElementById("app");
	const store = root && root.__vue_app__ && root.__vue_app__.config.globalProperties.$store;
	if (!store) {
		return false;
	}
	// The toolbar (Message.vue canAct) renders only for lines the IRC
	// layer could address: the fabricated lines get a msgid.
	for (const net of store.state.networks) {
		for (const chan of net.channels) {
			for (const msg of chan.messages) {
				msg.msgid = msg.msgid || "seance-fake-" + msg.id;
			}
		}
	}
	return true;
})()`;

const WORKER_FETCHED = `performance.getEntriesByType("resource").some((e) => /\\/js\\/translate-worker\\.js/.test(e.name))`;
const WATCHED = `JSON.parse(JSON.stringify(window.__watch))`;
const STORED_SETTING = `JSON.parse(localStorage.getItem("settings") || "{}").translationEnabled ?? null`;
const KEPT = `JSON.parse(localStorage.getItem("thelounge.translate") || "{}")[${JSON.stringify(
	`${NETWORK}/${CHANNEL}`
)}] || null`;

/** Every translation surface the chat view can show, present or not. */
const SURFACES = `(() => ({
	composer: !!document.querySelector("#translate-once"),
	strip: !!document.querySelector(".translate-bar"),
	panel: !!document.querySelector(".translation-panel"),
	lines: document.querySelectorAll("#chat .msg-translation, #chat [class*='msg-translat']").length,
	topicFlip: !!document.querySelector("#chat .topic-flip"),
	placeholder: document.querySelector("#input")?.getAttribute("placeholder") ?? "",
	target: document.querySelector("#translate-once .translate-once-target")?.textContent.trim() ?? "",
}))()`;

const isPhone = `matchMedia("(hover: none) and (pointer: coarse)").matches`;

async function pressEscape(page) {
	const key = {
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
		nativeVirtualKeyCode: 27,
	};

	await page.send("Input.dispatchKeyEvent", {type: "keyDown", ...key});
	await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...key});
	await page.sleep(150);
}

/** A finger held on the element past the long-press threshold (Message.vue, 500 ms). */
async function longPress(page, selector) {
	const r = await page.rect(selector);
	const point = {
		x: r.x + Math.min(r.width / 2, 40),
		y: r.y + r.height / 2,
		radiusX: 12,
		radiusY: 12,
		force: 1,
	};

	await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [point]});
	await page.sleep(700);
	await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	await page.sleep(250);
}

/** Whether the message's toolbar offers Translate, the toolbar opened the way this device opens it. */
async function toolbarTranslate(page, phone) {
	const row = `#msg-${OTHER_MSG}`;

	if (phone) {
		await longPress(page, `${row} .content`);
	} else {
		await page.hover(`${row} .content`);
	}

	await page.waitFor(`!!document.querySelector(${JSON.stringify(`${row} .msg-actions`)})`, {
		label: "the message toolbar is up",
	});

	const offered = await page.evaluate(
		`!!document.querySelector(${JSON.stringify(`${row} .msg-action-translate`)})`
	);

	// Put it away: a tap on the empty scrollback above the lines on touch,
	// the pointer off it otherwise.
	if (phone) {
		const top = await page.rect("#chat .chat-content");
		const at = {x: top.x + top.width / 2, y: top.y + 40, radiusX: 4, radiusY: 4, force: 1};

		await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [at]});
		await page.sleep(60);
		await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
	} else {
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 2, y: 2});
	}

	await page
		.waitFor(
			`!document.querySelector(${JSON.stringify(
				`${row}.actions-open, ${row} .msg-actions:hover`
			)})`,
			{label: "the toolbar put away", timeout: 5000}
		)
		.catch(() => {});
	await page.sleep(300);

	return offered;
}

/** Whether the channel menu (the header's ⋮) offers "Translation…". */
async function menuOffersTranslation(page) {
	await page.click("#chat .header button.menu");
	await page.waitFor(`!!document.querySelector("#context-menu")`, {label: "the channel menu"});

	const offered = await page.evaluate(
		`!!document.querySelector("#context-menu .context-menu-translate")`
	);

	await pressEscape(page);
	await page.waitFor(`!document.querySelector("#context-menu")`, {
		label: "the channel menu closed",
	});

	return offered;
}

/**
 * Off by the user's setting: the channel menu's "Translation…" is still
 * there, and opens Settings → Translation (named "Language" while off),
 * without making any of the machinery.
 */
async function menuOpensTranslationSettings(page) {
	await page.click("#chat .header button.menu");
	await page.waitFor(`!!document.querySelector("#context-menu")`, {label: "the channel menu"});

	if (
		!(await page.evaluate(
			`!!document.querySelector("#context-menu .context-menu-translate-off")`
		))
	) {
		await pressEscape(page);
		return false;
	}

	await page.click("#context-menu .context-menu-translate-off");
	await page.waitFor(`!!document.querySelector('#settings input[name="translationEnabled"]')`, {
		label: "Settings → Translation, with its switch",
	});
	await closeSettings(page);

	return true;
}

async function fabricate(page) {
	const made = await page.evaluate(fakeNetworkSnippet());

	page.check("a development build fabricated the network", made === true);
	await page.waitFor(`document.querySelectorAll("#chat .msg").length >= 3`, {
		label: "the fabricated channel's messages",
	});
	await page.evaluate(STAMP_MSGIDS);
}

/** Settings → Translation (the tab keeps its route whatever it is named). */
async function openTab(page) {
	await page.evaluate(`(() => { location.hash = "#/settings/translation"; })()`);
	await page.waitFor(`!!document.querySelector('#settings select[name="locale"]')`, {
		label: "Settings → Translation open",
	});
}

async function closeSettings(page) {
	await page.click(".settings-modal-done");
	await page.waitFor(`!document.querySelector(".settings-modal")`, {label: "settings closed"});
	await page.waitFor(`!!document.querySelector("#chat")`, {label: "back in the channel"});
}

const TAB = `(() => ({
	tab: document.querySelector(".settings-menu button.translation .tab-label")?.textContent.trim() ?? "",
	heading: document.querySelector("#settings h2")?.textContent.trim() ?? "",
	label: document.querySelector("#settings .translate-target > span")?.textContent.trim() ?? "",
	switchThere: !!document.querySelector('#settings input[name="translationEnabled"]'),
	switchOn: !!document.querySelector('#settings input[name="translationEnabled"]')?.checked,
	hint: document.querySelector("#settings .translate-switch-hint")?.textContent.trim() ?? "",
	options: !!document.querySelector("#settings .translate-options"),
	formality: !!document.querySelector('#settings input[name="translateFormality"]'),
	models: document.querySelectorAll("#settings .translate-model").length,
	languageHint: [...document.querySelectorAll("#settings .translate-hint")].some(
		(el) => el.textContent.trim() === ${JSON.stringify(EN["translate.settings.languageHint"])}
	),
}))()`;

async function flipSwitch(page, on) {
	await page.click('#settings input[name="translationEnabled"]');
	await page.waitFor(`(${STORED_SETTING}) === ${on}`, {label: `the switch stored ${on}`});
}

async function checkOff(page, phone, where) {
	const s = await page.evaluate(SURFACES);

	console.log(`surfaces (${where})`, JSON.stringify(s));
	page.check(`${where}: no translate button in the composer`, s.composer === false);
	page.check(
		`${where}: no strip, no panel, no translation under a message`,
		!s.strip && !s.panel && s.lines === 0
	);
	page.check(`${where}: no topic flipper`, s.topicFlip === false);
	page.check(
		`${where}: the composer's placeholder names no write language (${s.placeholder})`,
		s.placeholder === EN["composer.placeholder"].replace("{name}", CHANNEL)
	);
	page.check(
		`${where}: the channel menu has no "Translation…" panel`,
		(await menuOffersTranslation(page)) === false
	);
	page.check(
		`${where}: the channel menu's "Translation…" opens Settings, where the switch is`,
		await menuOpensTranslationSettings(page)
	);
	page.check(
		`${where}: the toolbar has no Translate`,
		(await toolbarTranslate(page, phone)) === false
	);
}

export default async function run(page) {
	await page.addInitScript(WATCH);
	await page.addInitScript(KEPT_CHANNEL);

	// --- 1. The real path, from a cold load. ---------------------------
	await page.goto(page.url, {waitForSelector: "#connect form"});

	const phone = await page.evaluate(isPhone);

	await fabricate(page);
	page.check(
		"the setting is not stored: off by default",
		(await page.evaluate(STORED_SETTING)) === null
	);
	await checkOff(page, phone, "cold load, off");
	await page.screenshot("1-off-channel");

	// The interface language moves with a kept reading channel in the store:
	// reading is not restarted, no service is made.
	await openTab(page);

	const off = await page.evaluate(TAB);

	console.log("tab (off)", JSON.stringify(off));
	page.check(
		`off: the tab is "${EN["settings.tabs.language"]}" (${off.tab})`,
		off.tab === EN["settings.tabs.language"]
	);
	page.check(
		`off: the heading is "${EN["translate.settings.headingLanguage"]}" (${off.heading})`,
		off.heading === EN["translate.settings.headingLanguage"]
	);
	page.check(
		`off: the picker is "${EN["translate.settings.interfaceLanguageLabel"]}" (${off.label})`,
		off.label === EN["translate.settings.interfaceLanguageLabel"]
	);
	page.check("off: the switch is offered, off", off.switchThere && !off.switchOn);
	page.check(
		"off: the switch says what it does and what it downloads",
		off.hint === EN["translate.settings.enableHint"]
	);
	page.check(
		"off: no formality, no models, no reading-language hint",
		!off.options && !off.formality && off.models === 0 && !off.languageHint
	);
	await page.screenshot("2-off-settings");

	for (const tag of ["de", "en"]) {
		await page.evaluate(`(() => {
			const select = document.querySelector('#settings select[name="locale"]');
			select.value = ${JSON.stringify(tag)};
			select.dispatchEvent(new Event("change", {bubbles: true}));
		})()`);
		await page.waitFor(`document.documentElement.lang.startsWith(${JSON.stringify(tag)})`, {
			label: `the interface in ${tag}`,
		});
		await page.sleep(400);
	}

	const quiet = await page.evaluate(WATCHED);

	console.log("watched (off)", JSON.stringify(quiet));
	page.check(
		"off: translate-worker.js was never fetched",
		(await page.evaluate(WORKER_FETCHED)) === false
	);
	page.check("off: no Worker was made", quiet.workers.length === 0);
	page.check("off: no GPU adapter was asked for", quiet.gpuAsks === 0);
	const kept = await page.evaluate(KEPT);

	page.check(
		"off: the kept channel's reading and write target are left alone",
		kept?.read === true && kept?.write === "de"
	);

	// Switched on: the rest of the tab appears, named for translation, and
	// asking what is downloaded starts the worker -- the positive control.
	await flipSwitch(page, true);
	await page.waitFor(`document.querySelectorAll("#settings .translate-model").length > 0`, {
		label: "the model manager appears",
	});

	const on = await page.evaluate(TAB);

	console.log("tab (on)", JSON.stringify(on));
	page.check(
		`on: the tab is "${EN["settings.tabs.translation"]}"`,
		on.tab === EN["settings.tabs.translation"]
	);
	page.check(
		`on: the heading is "${EN["translate.settings.heading"]}"`,
		on.heading === EN["translate.settings.heading"]
	);
	page.check(
		`on: the picker is "${EN["translate.settings.languageLabel"]}"`,
		on.label === EN["translate.settings.languageLabel"]
	);
	page.check(
		"on: formality and the models are there",
		on.options && on.formality && on.models > 0 && on.languageHint
	);
	await page.waitFor(WORKER_FETCHED, {
		label: "translate-worker.js fetched once on",
		timeout: 15000,
	});

	const running = await page.evaluate(WATCHED);

	page.check(
		"on: a translate worker was made (the control: the watch sees one)",
		running.workers.some((w) => /translate-worker\.js/.test(w.url) && !w.terminated)
	);
	page.check(
		`on: the device probe ran (${running.gpuAsks} GPU asks; none where there is no navigator.gpu)`,
		running.gpuAsks > 0 || !(await page.evaluate(`!!navigator.gpu`))
	);
	await page.screenshot("3-on-settings");

	await flipSwitch(page, false);
	await page.waitFor(`!document.querySelector("#settings .translate-options")`, {
		label: "the options go",
	});

	const gone = await page.evaluate(WATCHED);
	const back = await page.evaluate(TAB);

	page.check(
		"off again: the worker is terminated at once",
		gone.workers.every((w) => w.terminated)
	);
	page.check(
		"off again: the tab is the language again",
		back.tab === EN["settings.tabs.language"] && !back.options
	);
	await closeSettings(page);
	await checkOff(page, phone, "switched off again");

	// --- 2. The surfaces, on the in-page fake. -------------------------
	await page.goto(`${BASE}?fakeTranslate`, {waitForSelector: "#connect form"});

	// A load the service worker served with translation off is not
	// cross-origin isolated: the worker isolates only while it is on
	// (client/service-worker.js `isolationWanted`, isolationFlag.ts).
	const isolation = await page.evaluate(`({
		isolated: self.crossOriginIsolated === true,
		servedByWorker: (performance.getEntriesByType("navigation")[0]?.workerStart ?? 0) > 0,
	})`);

	console.log("isolation (second load, off)", JSON.stringify(isolation));
	page.check(
		"off: a load the service worker served is not cross-origin isolated",
		isolation.servedByWorker && !isolation.isolated
	);
	await fabricate(page);
	await checkOff(page, phone, "fake, off");
	page.check(
		"fake, off: the fake engine saw nothing",
		(await page.evaluate(`(window.__seanceTranslateFake?.requests ?? []).length`)) === 0
	);

	await openTab(page);
	await flipSwitch(page, true);
	await closeSettings(page);
	await page.waitFor(`!!document.querySelector("#translate-once")`, {
		label: "the composer's translate button appears",
	});
	await page.evaluate(STAMP_MSGIDS);

	// A German line arrives: the kept channel reads again, into English.
	await page.evaluate(`window.socket.dispatch("msg", {
		chan: 2,
		msg: {id: 31, type: "message", from: {mode: "", modes: [], away: "", lastMessage: Date.now(), nick: "moria"}, text: ${JSON.stringify(
			GERMAN
		)}, self: false, time: new Date(), users: [], msgid: "seance-fake-31"},
	})`);
	await page.waitFor(
		`!!document.querySelector("#msg-31 .msg-translation, #msg-31 [class*='msg-translat']")`,
		{
			label: "the German line is read",
			timeout: 15000,
		}
	);

	const onSurfaces = await page.evaluate(SURFACES);

	console.log("surfaces (fake, on)", JSON.stringify(onSurfaces));
	page.check("on: the composer's translate button is there", onSurfaces.composer);
	page.check(
		"on: the kept write target names German on the translate button",
		onSurfaces.target.endsWith("→ DE")
	);
	page.check("on: a line is read under its message", onSurfaces.lines > 0);
	page.check(
		'on: the channel menu offers "Translation…"',
		(await menuOffersTranslation(page)) === true
	);
	page.check("on: the toolbar offers Translate", (await toolbarTranslate(page, phone)) === true);

	// The kept write target: the first Enter brings the strip up.
	await page.fill("#form #input", "good morning everyone");
	await page.evaluate(
		`document.querySelector("#form #input").dispatchEvent(new KeyboardEvent("keypress", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true}))`
	);
	await page.waitFor(`!!document.querySelector(".translate-bar")`, {label: "the strip comes up"});
	await page.screenshot("4-on-channel");

	// Off again, from Settings, with the strip up and a line read.
	await openTab(page);
	await flipSwitch(page, false);
	await closeSettings(page);
	await checkOff(page, phone, "fake, switched off");
	page.check(
		"fake, switched off: the draft stayed in the input",
		(await page.evaluate(`document.querySelector("#form #input").value`)) ===
			"good morning everyone"
	);
	page.check(
		"fake, switched off: the engines hold nothing",
		await page.evaluate(
			`Object.values(globalThis.__seanceTranslateFake?.loaded ?? {}).every((ids) => ids.length === 0)`
		)
	);

	const requestsOff = await page.evaluate(
		`(window.__seanceTranslateFake?.requests ?? []).length`
	);

	// Off, a new German line is not looked at, and Enter sends as typed.
	await page.evaluate(`window.socket.dispatch("msg", {
		chan: 2,
		msg: {id: 32, type: "message", from: {mode: "", modes: [], away: "", lastMessage: Date.now(), nick: "moria"}, text: "Noch eine Zeile auf Deutsch, bitte nicht übersetzen.", self: false, time: new Date(), users: [], msgid: "seance-fake-32"},
	})`);
	await page.sleep(1500);
	page.check(
		"fake, switched off: a new line is not read and the engine is asked nothing",
		(await page.evaluate(
			`document.querySelectorAll("#msg-32 [class*='msg-translat']").length`
		)) === 0 &&
			(await page.evaluate(`(window.__seanceTranslateFake?.requests ?? []).length`)) ===
				requestsOff
	);
	page.check(
		"fake, switched off: the kept channel's setting survives the round trip",
		(await page.evaluate(KEPT))?.read === true && (await page.evaluate(KEPT))?.write === "de"
	);
	await page.screenshot("5-off-again-channel");

	// The first Enter, with the channel's write target still kept: no strip,
	// the draft goes as typed (out of the input; the fabricated network has
	// no connection to carry it, which is not this check's business).
	await page.evaluate(
		`document.querySelector("#form #input").dispatchEvent(new KeyboardEvent("keypress", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true}))`
	);
	await page.sleep(600);
	page.check(
		"fake, switched off: Enter sends the draft as typed, with no strip",
		!(await page.evaluate(`!!document.querySelector(".translate-bar")`)) &&
			(await page.evaluate(`document.querySelector("#form #input").value`)) === ""
	);

	// The composer's language picker open when translation goes off does not
	// come back open with it.
	await openTab(page);
	await flipSwitch(page, true);
	await closeSettings(page);
	await page.waitFor(`!!document.querySelector("#translate-once")`, {
		label: "the composer's translate button is back",
	});
	await page.fill("#form #input", "one more");
	await page.click("#translate-once");
	await page.waitFor(`!!document.querySelector(".language-sheet")`, {
		label: "the composer's language picker",
	});
	await openTab(page);
	await flipSwitch(page, false);
	await flipSwitch(page, true);
	await closeSettings(page);
	await page.waitFor(`!!document.querySelector("#translate-once")`, {
		label: "the composer's translate button, once more",
	});
	page.check(
		"on again: the picker left open at the switch-off stays closed",
		!(await page.evaluate(`!!document.querySelector(".language-sheet")`))
	);
}
