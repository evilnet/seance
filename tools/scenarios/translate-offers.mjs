// Suggested writing (docs/resources/translation.md § Suggested writing), in
// a real browser on the in-page fake engine (?fakeTranslate) and a
// fabricated network (lib/fake-network.mjs: #seance is chan 2, the query
// with moria chan 3), so it needs a development build and no ircd. What the
// composer sends is read off the bus (`input`), which the fabricated
// network has no IRC client to answer.
//
// In order:
//  1. A reply to a Portuguese line offers "Reply in Portuguese"; taken, it
//     is for this message: "This message goes in Portuguese".
//  2. Send safety: a Return before the preview sends nothing ("Translating…
//     Press Return again"), nor does one in the instant it lands; the next
//     Return after it has been on screen sends the translation, tagged, as
//     a reply. The language goes with the message.
//  3. No offer for a reply to a machine-translated line, to the user's own
//     line, or over an edit.
//  4. Adversarial, the parent edited mid-preview: the preview and a Return
//     waiting on it go, and the draft is previewed again. Cancelling the
//     reply takes the message's language with it.
//  5. "Send as written" sends the draft as typed, untagged, while the
//     preview is still on its way.
//  6. A query whose other person writes Polish offers "Write to moria in
//     Polish"; "Another language…" opens the list with "This message only"
//     set, and a pick is this message's language; "Always here" makes it
//     the conversation's.
//  7. Adversarial, the other person changes language mid-preview: the
//     message's language and its preview go, and the offer says what it
//     says now.
//  8. Adversarial, the page put away and back while a preview is out
//     (pagehide takes the worker down): the preview is asked again, not
//     failed, and when it lands nothing is sent by itself.
//  9. "Not now" hides offers in that conversation, on this device.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   SEANCE_HTTP=http://localhost:8021/ CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/translate-offers.mjs
//   … --mobile --width=390 --height=844

import {fakeNetworkSnippet} from "./lib/fake-network.mjs";
import {SHEET, TRANSLATION_ON} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";

export const url = `${BASE}?fakeTranslate`;

const NETWORK = "fake-0000-0000";
const CHANNEL = 2;
const QUERY = 3;
const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;
const CHAN = (id) => `${STORE}.getters.findChannel(${id}).channel`;
const OFFER = `((document.querySelector("#form .translate-offer") || {}).textContent || "").replace(/\\s+/g, " ").trim()`;
const OUTGOING = (id) =>
	`JSON.parse(JSON.stringify(${STORE}.state.outgoingTranslations[${id}] ?? null))`;
const SENT = `JSON.parse(JSON.stringify(window.__sent))`;
const QUEUED = `!!document.querySelector("#form .translate-bar-queued")`;
const RECORD = (name) =>
	`(JSON.parse(localStorage.getItem("thelounge.translate") || "{}")[${JSON.stringify(
		`${NETWORK}/${name}`
	)}] ?? null)`;

let nextId = 900;

async function say(page, chan, text, extra = {}) {
	const id = nextId++;

	await page.evaluate(`window.socket.dispatch("msg", {
		chan: ${chan},
		msg: Object.assign({id: ${id}, type: "message", from: {mode: "", modes: [], away: "", lastMessage: Date.now(), nick: "moria"}, text: ${JSON.stringify(
		text
	)}, self: false, time: new Date(), users: [], msgid: "seance-offer-${id}"}, ${JSON.stringify(
		extra
	)}),
	})`);

	return id;
}

const read = (id) => `["done", "skipped"].includes(${STORE}.state.translations[${id}]?.status)`;

async function replyTo(page, chan, id) {
	await page.evaluate(
		`(() => { const c = ${CHAN(chan)}; c.replyTo = c.messages.find((m) => m.id === ${id}); })()`
	);
	await page.sleep(150);
}

async function cancelReply(page, chan) {
	await page.evaluate(`${CHAN(chan)}.replyTo = null`);
	await page.sleep(150);
}

async function typeDraft(page, text) {
	await page.fill("#form #input", text);
	await page.evaluate(
		`document.querySelector("#form #input").dispatchEvent(new Event("input", {bubbles: true}))`
	);
}

async function pressEnter(page) {
	await page.evaluate(
		`document.querySelector("#form #input").dispatchEvent(new KeyboardEvent("keypress", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true}))`
	);
}

async function open(page, chan) {
	await page.evaluate(`location.hash = "#/chan-${chan}"`);
	await page.waitFor(`${STORE}.state.activeChannel?.channel.id === ${chan}`, {
		label: `conversation ${chan} open`,
	});
	await page.sleep(200);
}

const PT = "Bom dia a todos, alguém sabe se a reunião de amanhã ainda está marcada para as dez?";
const PL = [
	"Cześć, czy możesz mi pomóc z konfiguracją serwera dzisiaj wieczorem?",
	"Nie wiem, dlaczego to połączenie ciągle się zrywa po kilku minutach.",
];
const DE = [
	"Hallo, ich habe gerade gesehen, dass der Server wieder läuft, danke dafür.",
	"Kannst du mir bitte sagen, wann wir das nächste Mal darüber sprechen?",
];

export default async function run(page) {
	await page.addInitScript(TRANSLATION_ON);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	page.check(
		"a development build fabricated the network",
		await page.evaluate(fakeNetworkSnippet())
	);
	await page.waitFor(`document.querySelectorAll("#chat .msg").length >= 3`, {
		label: "the fabricated channel's messages",
	});
	// What the composer sends, read off the bus.
	await page.evaluate(`(() => {
		window.__sent = [];
		const emit = window.socket.emit.bind(window.socket);
		window.socket.emit = (name, payload) => {
			if (name === "input") { window.__sent.push(payload); }
			return emit(name, payload);
		};
	})()`);

	// --- 1. A reply to a Portuguese line. --------------------------------
	const pt = await say(page, CHANNEL, PT, {msgid: "seance-offer-pt"});

	await page.waitFor(read(pt), {label: "the Portuguese line is read", timeout: 15000});
	page.check("no offer before a reply is started", (await page.evaluate(OFFER)) === "");
	await replyTo(page, CHANNEL, pt);
	page.check(
		`a reply to it offers "Reply in Portuguese" (${await page.evaluate(OFFER)})`,
		(await page.evaluate(OFFER)).startsWith("Reply in Portuguese")
	);
	await page.screenshot("1-reply-offer");
	await page.click("#form .translate-offer-accept");
	await page.sleep(150);
	page.check(
		`taken, it is this message's language (${await page.evaluate(OFFER)})`,
		(await page.evaluate(OFFER)).startsWith("This message goes in Portuguese") &&
			(await page.evaluate(RECORD("#seance"))) === null
	);

	// --- 2. Send safety. --------------------------------------------------
	await typeDraft(page, "thanks, see you all tomorrow at the station");
	await pressEnter(page);
	await page.sleep(100);
	page.check(
		"a Return before the preview sends nothing, and says so",
		(await page.evaluate(SENT)).length === 0 && (await page.evaluate(QUEUED))
	);
	await page.waitFor(`${STORE}.state.outgoingTranslations[${CHANNEL}]?.status === "done"`, {
		label: "the preview lands",
		timeout: 15000,
	});
	await pressEnter(page);
	await page.sleep(50);
	page.check(
		"nothing went by itself when it landed, nor on a Return in that instant",
		(await page.evaluate(SENT)).length === 0
	);
	await page.screenshot("2-strip-shown");
	await page.sleep(700);
	await pressEnter(page);
	await page.sleep(200);

	const sent = (await page.evaluate(SENT))[0];

	console.log("sent", JSON.stringify(sent));
	page.check(
		"the next Return sends the translation, tagged, as the reply",
		!!sent &&
			sent.text.startsWith("[Portuguese]") &&
			sent.language === "pt" &&
			sent.machineTranslated === true &&
			sent.reply === "seance-offer-pt"
	);
	page.check(
		"the language went with the message",
		(await page.evaluate(OFFER)) === "" && (await page.evaluate(OUTGOING(CHANNEL))) === null
	);

	// --- 3. No offer: machine-translated, own line, edit. ----------------
	const mt = await say(page, CHANNEL, PT.replace("dez", "onze"), {
		language: "pt",
		machineTranslated: true,
	});

	await page.waitFor(read(mt), {label: "the machine-translated line is read", timeout: 15000});
	await replyTo(page, CHANNEL, mt);
	page.check(
		"no offer for a reply to a machine-translated line",
		(await page.evaluate(OFFER)) === ""
	);
	await page.evaluate(`(() => {
		const c = ${CHAN(CHANNEL)};
		c.replyTo = Object.assign({}, c.messages.find((m) => m.id === ${pt}), {self: true, id: 1});
	})()`);
	await page.sleep(150);
	page.check("no offer for a reply to the user's own line", (await page.evaluate(OFFER)) === "");
	await replyTo(page, CHANNEL, pt);
	await page.evaluate(
		`${CHAN(CHANNEL)}.editing = ${CHAN(CHANNEL)}.messages.find((m) => m.id === ${pt})`
	);
	await page.sleep(150);
	page.check("no offer over an edit", (await page.evaluate(OFFER)) === "");
	await page.evaluate(`${CHAN(CHANNEL)}.editing = null`);
	await cancelReply(page, CHANNEL);

	// --- 4. The parent edited mid-preview; the reply cancelled. ----------
	await replyTo(page, CHANNEL, pt);
	await page.click("#form .translate-offer-accept");
	await typeDraft(page, "I will bring the slides and the projector for the meeting");
	await pressEnter(page);
	await page.waitFor(QUEUED, {label: "a Return waits on the preview"});

	const before = await page.evaluate(`window.__seanceTranslateFake.requests.length`);

	// The edit handler replaces channel.replyTo with the edited message.
	await page.evaluate(`(() => {
		const c = ${CHAN(CHANNEL)};
		c.replyTo = Object.assign({}, c.replyTo, {text: c.replyTo.text + " (às onze, afinal)"});
	})()`);
	await page.sleep(200);
	page.check(
		"the parent edited: the waiting Return went, and the draft is previewed again",
		!(await page.evaluate(QUEUED)) &&
			(await page.evaluate(`window.__seanceTranslateFake.requests.length`)) > before &&
			(await page.evaluate(SENT)).length === 1
	);
	await page.waitFor(`${STORE}.state.outgoingTranslations[${CHANNEL}]?.status === "done"`, {
		label: "the new preview lands",
		timeout: 15000,
	});
	await cancelReply(page, CHANNEL);
	page.check(
		"the reply cancelled: the message's language and its preview went",
		(await page.evaluate(OUTGOING(CHANNEL))) === null &&
			!(await page.evaluate(`!!document.querySelector("#form .translate-offer-taken")`))
	);
	await pressEnter(page);
	await page.sleep(200);
	page.check(
		"and Return sends the draft as typed",
		(await page.evaluate(SENT))[1]?.text ===
			"I will bring the slides and the projector for the meeting" &&
			(await page.evaluate(SENT))[1]?.language === undefined
	);

	// --- 5. Send as written. ---------------------------------------------
	await replyTo(page, CHANNEL, pt);
	await page.click("#form .translate-offer-accept");
	await typeDraft(page, "running five minutes late, start without me please");
	await pressEnter(page);
	await page.waitFor(`!!document.querySelector("#form .translate-bar-as-written")`, {
		label: "the strip, with Send as written",
	});
	await page.screenshot("3-strip-pending");
	await page.click("#form .translate-bar-as-written");
	await page.sleep(200);

	const asWritten = (await page.evaluate(SENT))[2];

	page.check(
		"Send as written sends the draft as typed, untagged, the reply kept",
		asWritten?.text === "running five minutes late, start without me please" &&
			asWritten.language === undefined &&
			asWritten.reply === "seance-offer-pt" &&
			(await page.evaluate(OUTGOING(CHANNEL))) === null
	);
	await page.sleep(2000);
	page.check(
		"and nothing else went when the preview would have landed",
		(await page.evaluate(SENT)).length === 3
	);

	// --- 6. A query in Polish. -------------------------------------------
	await open(page, QUERY);

	for (const text of PL) {
		const id = await say(page, QUERY, text);

		await page.waitFor(read(id), {label: "a Polish line is read", timeout: 15000});
	}

	page.check(
		`the query offers "Write to moria in Polish" (${await page.evaluate(OFFER)})`,
		(await page.evaluate(OFFER)).startsWith("Write to moria in Polish")
	);
	await page.screenshot("4-query-offer");
	await page.click("#form .translate-offer-other");
	await page.waitFor(`!!document.querySelector("${SHEET} .language-sheet-list")`, {
		label: "Another language… opens the list",
	});
	page.check(
		'"This message only" is set',
		await page.evaluate(
			`document.querySelector("${SHEET} .language-sheet-once-box")?.checked === true`
		)
	);
	await page.evaluate(
		`document.querySelector('${SHEET} .language-sheet-row[data-code="es"]').click()`
	);
	await page.waitFor(`!document.querySelector("${SHEET}")`, {label: "a pick closes the sheet"});
	page.check(
		`the pick is this message's language (${await page.evaluate(OFFER)})`,
		(await page.evaluate(OFFER)).startsWith("This message goes in Spanish") &&
			(await page.evaluate(RECORD("moria")))?.write == null
	);
	await page.click("#form .translate-offer-always");
	await page.sleep(200);
	page.check(
		"Always here: Spanish is the conversation's language",
		(await page.evaluate(RECORD("moria")))?.write === "es" &&
			(await page.evaluate(OFFER)) === ""
	);
	// Back to no language, for the next step.
	await page.evaluate(`(() => {
		const all = JSON.parse(localStorage.getItem("thelounge.translate") || "{}");
		delete all[${JSON.stringify(`${NETWORK}/moria`)}];
		localStorage.setItem("thelounge.translate", JSON.stringify(all));
		${STORE}.commit("translateChannelRemove", ${JSON.stringify(`${NETWORK}/moria`)});
	})()`);
	await page.sleep(200);

	// --- 7. The other person changes language mid-preview. ---------------
	page.check(
		`the Polish offer is back (${await page.evaluate(OFFER)})`,
		(await page.evaluate(OFFER)).startsWith("Write to moria in Polish")
	);
	await page.click("#form .translate-offer-accept");
	await typeDraft(page, "sure, I can help after dinner, around eight");
	await page.waitFor(`${STORE}.state.outgoingTranslations[${QUERY}]?.to === "pl"`, {
		label: "the Polish preview starts",
		timeout: 10000,
	});

	for (const text of DE) {
		const id = await say(page, QUERY, text);

		await page.waitFor(read(id), {label: "a German line is read", timeout: 15000});
	}

	await page.sleep(300);

	const switched = await page.evaluate(OUTGOING(QUERY));

	console.log("after the switch", JSON.stringify(switched), await page.evaluate(OFFER));
	page.check(
		"the Polish preview and the message's language went",
		(switched === null || switched.to !== "pl") &&
			!(await page.evaluate(`!!document.querySelector("#form .translate-offer-taken")`))
	);
	page.check(
		`the offer says what it says now (${await page.evaluate(OFFER)})`,
		(await page.evaluate(OFFER)).startsWith("Write to moria in German")
	);

	// --- 8. Hidden and shown again while a preview is out. ---------------
	await page.click("#form .translate-offer-accept");
	await typeDraft(page, "let me check the logs and I will get back to you");
	await pressEnter(page);
	await page.waitFor(QUEUED, {label: "a Return waits on the German preview"});

	const sentBefore = (await page.evaluate(SENT)).length;

	await page.evaluate(`(() => {
		const set = (state) => {
			Object.defineProperty(document, "visibilityState", {configurable: true, get: () => state});
			Object.defineProperty(document, "hidden", {configurable: true, get: () => state === "hidden"});
			document.dispatchEvent(new Event("visibilitychange"));
		};
		set("hidden");
		window.dispatchEvent(new Event("pagehide"));
		setTimeout(() => { set("visible"); window.dispatchEvent(new Event("pageshow")); }, 400);
	})()`);
	await page.waitFor(`${STORE}.state.outgoingTranslations[${QUERY}]?.status === "done"`, {
		label: "the German preview lands after the page came back",
		timeout: 15000,
	});
	await page.sleep(800);
	page.check(
		"the preview was asked again, not left failed",
		(await page.evaluate(OUTGOING(QUERY)))?.text.startsWith("[German]")
	);
	page.check(
		"nothing was sent by itself when it landed",
		(await page.evaluate(SENT)).length === sentBefore
	);
	await pressEnter(page);
	await page.sleep(200);
	page.check(
		"the next Return sends it",
		(await page.evaluate(SENT))[sentBefore]?.language === "de"
	);

	// --- 9. Not now. -----------------------------------------------------
	await page.waitFor(`document.querySelector("#form .translate-offer-decline")`, {
		label: "the offer is back after the send",
	});
	await page.click("#form .translate-offer-decline");
	await page.sleep(200);
	page.check(
		"Not now: no offer in this conversation, remembered on this device",
		(await page.evaluate(OFFER)) === "" &&
			(await page.evaluate(
				`JSON.parse(localStorage.getItem("thelounge.translateOffersDeclined") || "[]").includes(${JSON.stringify(
					`${NETWORK}/moria`
				)})`
			))
	);
	await open(page, CHANNEL);
	await replyTo(page, CHANNEL, pt);
	page.check(
		"another conversation still offers",
		(await page.evaluate(OFFER)).startsWith("Reply in Portuguese")
	);
	await page.screenshot("5-reply-offer-again");

	page.check(
		`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
