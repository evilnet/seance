// Offered in place (docs/resources/translation.md § Offered in place): with
// translation off by the user's own switch (its default), a conversation
// whose recent lines from others are mostly in a language the user does not
// read offers to switch it on, in one card above the composer. Real
// Chromium, a fabricated network (lib/fake-network.mjs: #seance is chan 2,
// the query "moria" chan 3) and no ircd.
//
// The scenario does NOT seed translation on (lib/translation.mjs): the off
// state is what it is about.
//
//  1. A conversation with only a couple of lines: no card, and not even the
//     detector is fetched.
//  2. Six Portuguese lines from others: the card names Portuguese and
//     English, with the one consent line; the detector is loaded and nothing
//     else -- no Worker, no translate-worker.js.
//  3. The query beside it, with nothing in it, shows no card; back in the
//     channel the card is there again.
//  4. "Not now" is per conversation and survives a reload (the same lines
//     after it offer nothing).
//  5. A deploy that turned translation off offers nothing.
//  6. On the in-page fake engine (?fakeTranslate), "Translate messages"
//     switches translation on and the lines on screen are read; the card
//     goes.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   SEANCE_HTTP=http://localhost:8021/ CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/translate-discover.mjs
//   … --mobile --width=390 --height=844

import {readFileSync} from "node:fs";
import {fakeNetworkSnippet} from "./lib/fake-network.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));

export const url = BASE;

const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;
const CARD = "#form .translate-discover";
const DECLINES = "thelounge.translateDiscoveryDeclined";
const PORTUGUESE = [
	"Bom dia a todos, alguém já experimentou a nova versão do cliente?",
	"Sim, instalei ontem à noite e está a funcionar muito bem no telemóvel",
	"Eu ainda não consegui, o servidor estava sempre a desligar a ligação",
	"Tens de limpar a cache do navegador primeiro, depois volta a tentar",
	"Obrigado, vou tentar isso quando chegar a casa depois do trabalho",
	"Alguém sabe se a tradução automática já funciona nos canais grandes?",
];

// Every Worker made, by its URL, counted from the document's start.
const WATCH = `(() => {
	window.__watch = {workers: []};
	const RealWorker = window.Worker;
	if (RealWorker) {
		window.Worker = class extends RealWorker {
			constructor(url, options) {
				super(url, options);
				window.__watch.workers.push(String(url));
			}
		};
	}
})()`;
const fetched = (pattern) =>
	`performance.getEntriesByType("resource").some((e) => ${pattern}.test(e.name))`;
const LID_FETCHED = fetched(String.raw`/\/js\/lid[.\/-]/`);
const WORKER_FETCHED = fetched(String.raw`/\/js\/translate-worker\.js/`);

/** Lines from others, as the msg handler would push them. */
const say = (lines, {chan = 2, start = 100, from = "moria"} = {}) =>
	`(() => {
		const lines = ${JSON.stringify(lines)};
		lines.forEach((text, i) => window.socket.dispatch("msg", {
			chan: ${chan},
			msg: {id: ${start} + i, type: "message", from: {mode: "", modes: [], away: "", lastMessage: Date.now(), nick: i % 2 ? "ana" : ${JSON.stringify(
		from
	)}}, text, self: false, time: new Date(), users: []},
		}));
	})()`;

const open = (chan) =>
	`${STORE}.commit("activeChannel", {network: ${STORE}.state.networks[0], channel: ${STORE}.state.networks[0].channels.find((c) => c.id === ${chan})}); location.hash = "#/chan-${chan}"`;

async function boot(page, address) {
	await page.goto(address, {waitForSelector: "#connect form"});
	page.check(
		"a development build fabricated the network",
		await page.evaluate(fakeNetworkSnippet())
	);
	await page.waitFor(`!!document.querySelector("#form #input")`, {label: "the composer"});
}

/** No card after the observation has had time to settle (SETTLE_MS is 1.5 s). */
async function stillNoCard(page) {
	await page.sleep(2500);
	return !(await page.evaluate(`!!document.querySelector("${CARD}")`));
}

export default async function run(page) {
	await page.addInitScript(WATCH);
	await boot(page, page.url);
	page.check(
		"translation is off, its default",
		(await page.evaluate(`${STORE}.state.settings.translationEnabled`)) !== true
	);

	// --- 1. Too little to go by. ------------------------------------------
	page.check("two lines from others: no card", await stillNoCard(page));
	page.check("and the detector is not even fetched", !(await page.evaluate(LID_FETCHED)));

	// --- 2. People here write Portuguese. ---------------------------------
	await page.evaluate(say(PORTUGUESE));
	await page.waitFor(`!!document.querySelector("${CARD}")`, {
		label: "the card",
		timeout: 20000,
	});

	const card = await page.evaluate(`({
		lead: document.querySelector("${CARD} .translate-suggest-lead")?.textContent.trim(),
		note: document.querySelector("${CARD} .translate-suggest-note")?.textContent.trim(),
		accept: document.querySelector("${CARD} .translate-discover-accept")?.textContent.trim(),
		decline: document.querySelector("${CARD} .translate-discover-decline")?.textContent.trim(),
	})`);

	console.log("card", JSON.stringify(card));
	page.check(
		`the card names the language and the user's (${card.lead})`,
		card.lead ===
			EN["translate.discover.lead"]
				.replace("{language}", "Portuguese")
				.replace("{reading}", "English")
	);
	page.check(
		"with the one consent line and two buttons",
		card.note === EN["translate.panel.enableHint"] &&
			card.accept === EN["translate.discover.accept"] &&
			card.decline === EN["translate.discover.decline"]
	);
	page.check(
		"the detector loaded, and nothing of the translation machinery",
		(await page.evaluate(LID_FETCHED)) &&
			!(await page.evaluate(WORKER_FETCHED)) &&
			(await page.evaluate(`window.__watch.workers.length`)) === 0
	);
	await page.screenshot("1-discover-card");

	// --- 3. Another conversation. -----------------------------------------
	await page.evaluate(open(3));
	await page.waitFor(`${STORE}.state.activeChannel?.channel.id === 3`, {label: "the query"});
	page.check("the empty query beside it offers nothing", await stillNoCard(page));
	await page.evaluate(open(2));
	await page.waitFor(`!!document.querySelector("${CARD}")`, {label: "the card again"});
	page.check("back in the channel, the card is there", true);

	// --- 4. Not now. -------------------------------------------------------
	await page.click(`${CARD} .translate-discover-decline`);
	await page.waitFor(`!document.querySelector("${CARD}")`, {label: "the card gone"});
	page.check(
		"Not now is kept for this conversation",
		(await page.evaluate(`localStorage.getItem("${DECLINES}")`)) ===
			JSON.stringify(["fake-0000-0000/#seance"])
	);
	page.check(
		"and translation is still off",
		(await page.evaluate(`${STORE}.state.settings.translationEnabled`)) !== true
	);

	await boot(page, page.url);
	await page.evaluate(say(PORTUGUESE));
	page.check("after a reload, the same lines offer nothing here", await stillNoCard(page));

	// --- 5. Off by the deploy. ---------------------------------------------
	await page.evaluate(`localStorage.removeItem("${DECLINES}")`);
	await boot(page, page.url);
	await page.evaluate(
		`${STORE}.commit("branding", {...${STORE}.state.branding, translation: {...(${STORE}.state.branding.translation || {}), enabled: false}})`
	);
	await page.evaluate(say(PORTUGUESE));
	page.check("a deploy with translation off offers nothing", await stillNoCard(page));

	// --- 6. Translate messages. --------------------------------------------
	await boot(page, `${BASE}?fakeTranslate`);
	await page.evaluate(say(PORTUGUESE));
	await page.waitFor(`!!document.querySelector("${CARD}")`, {
		label: "the card, before switching on",
		timeout: 20000,
	});
	await page.click(`${CARD} .translate-discover-accept`);
	await page.waitFor(`${STORE}.state.settings.translationEnabled === true`, {
		label: "translation on",
	});
	await page.waitFor(`!document.querySelector("${CARD}")`, {label: "the card gone once on"});
	await page.waitFor(
		`document.querySelectorAll("#chat .translation-line, #chat .msg-translation").length > 0`,
		{
			label: "the lines on screen are read",
			timeout: 20000,
		}
	);
	page.check("Translate messages switches translation on and reads what is on screen", true);
	await page.screenshot("2-discover-accepted");

	page.check(
		`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
