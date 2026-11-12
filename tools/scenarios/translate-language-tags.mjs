// Two Seance instances in one channel, talking through the language tags
// (docs/resources/translation.md § Language tags), on the in-page fake
// engine (?fakeTranslate on a non-production build). A is browser-drive's
// page, B a second Chromium with a profile of its own (lib/device.mjs), and
// a raw WebSocket speaker with message-tags stands in for "any other client".
//
// Steps, in order:
//  1. A sends a translate-panel translation into Spanish of a draft only the tag can
//     place ("hola"): the line A puts on the wire carries
//     `+draft/language=es` and the machine-translated flag; A's own row (the
//     echo) says "(machine translated)".
//  2. B receives it with the language on the message and, when the server
//     relays the flag, the same note; with reading on in English B
//     translates it *from Spanish* (the request carries `from: "es"`), while
//     the same text from the raw speaker, untagged, is left alone as the
//     reading scenario's "hola" is. A server that still drops the vendored
//     flag (nefarious2 before it lets `+evilnet.github.io/` through) shows no
//     note on B, and the run says which it saw.
//  3. A tagged line in the reader's own language is not translated: the
//     speaker's `+draft/language=en` "hola" asks the engine for nothing.
//  4. B replies through its translate panel into English with a draft A's
//     detector could not place alone: A, reading in English, sees the tag
//     name its own language and asks for no translation; there is no
//     ping-pong, since nothing is translated or sent on anyone's behalf.
//  5. Sent as written (no write target), A's line is untagged.
//
//   NODE_ENV=development pnpm build && python3 -m http.server -d public 8021 &
//   CHROME_BIN=<chromium> node tools/browser-drive.mjs tools/scenarios/translate-language-tags.mjs --no-ws
//
// Needs the dev ircd's plain-WS port on 127.0.0.1:8067 (message-tags,
// echo-message). NODE_ENV must be unset or "development" for the build: a
// production build compiles the fake out.

import {startDevice} from "./lib/device.mjs";
import {
	SHEET,
	TRANSLATION_ON,
	TRANSLATION_OFFERED,
	openTranslationSheet,
	setReadingThroughSheet,
} from "./lib/translation.mjs";

const RUN = Date.now().toString(36);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHANNEL = "#seance-langtags";
const IRCD = process.env.SEANCE_IRC_WS || "ws://127.0.0.1:8067/";
const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/";
const linkFor = (nick) =>
	`${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${nick}&join=${encodeURIComponent(
		CHANNEL
	)}&fakeTranslate`;

export const url = linkFor(`la${RUN}`);

const INPUT = "#form #input";
const PANEL = "#form .translate-panel";
const INSERT_READY = `(() => {
	const b = document.querySelector("#form .translate-panel-insert");
	return !!b && !b.disabled;
})()`;
const ENTER = `document.querySelector(${JSON.stringify(
	INPUT
)}).dispatchEvent(new KeyboardEvent("keypress", {key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true}))`;
const REQUESTS = "((window.__seanceTranslateFake && window.__seanceTranslateFake.requests) || [])";
const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store`;

/** The newest message in the open channel whose text includes `text`, as plain fields. */
const messageOf = (text) => `(() => {
	const msgs = ${STORE}.state.activeChannel.channel.messages;
	const m = [...msgs].reverse().find((x) => typeof x.text === "string" && x.text.includes(${JSON.stringify(
		text
	)}));
	return m ? {id: m.id, text: m.text, self: !!m.self, language: m.language ?? null, machineTranslated: !!m.machineTranslated} : null;
})()`;

/** Whether the newest row carrying `text` shows the "(machine translated)" note. */
const noteOn = (text) => `(() => {
	const r = [...document.querySelectorAll(".msg")].filter((m) => m.textContent.includes(${JSON.stringify(
		text
	)})).pop();
	return !!(r && r.querySelector(".msg-machine-translated"));
})()`;

/** The read requests the engine got for exactly this text. */
const readsOf = (text) =>
	`${REQUESTS}.filter((r) => r.purpose === "read" && r.text.trim() === ${JSON.stringify(
		text
	)}).map((r) => ({from: r.from, to: r.to}))`;

/** A raw client with message-tags that says lines, tagged or not. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let joinedResolve;
	const joined = new Promise((resolve, reject) => {
		joinedResolve = resolve;
		setTimeout(() => reject(new Error("speaker never joined")), 20000);
	});

	ws.onopen = () => {
		ws.send("CAP REQ :message-tags");
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance language-tag speaker`);
		ws.send("CAP END");
	};
	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(line.replace("PING", "PONG"));
		} else if (/ 001 /.test(line)) {
			ws.send(`JOIN ${CHANNEL}`);
		} else if (new RegExp(`^(?:@\\S+ )?:${nick}\\S* JOIN`).test(line)) {
			joinedResolve();
		}
	};

	return {
		joined,
		say: (text, tags) => ws.send(`${tags ? `@${tags} ` : ""}PRIVMSG ${CHANNEL} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

async function connect(dev) {
	await dev.addInitScript(TRANSLATION_ON);
	await dev.goto(dev.url, {waitForSelector: "#connect form"});
	await dev.click('#connect button[type="submit"]');
	await dev.waitFor(`!!document.querySelector(${JSON.stringify(INPUT)})`, {
		timeout: 25000,
		label: "the channel view",
	});
	await dev.waitFor(TRANSLATION_OFFERED, {timeout: 20000, label: "translation offered"});
}

/**
 * The conversation's send target through the menu's sheet: Write in's Off,
 * or its language, which opens the list, and the row is the pick (a pick
 * closes the sheet).
 */
async function setWriteTarget(dev, code) {
	await openTranslationSheet(dev);

	if (!code) {
		await dev.click(`${SHEET} .translation-sheet-off`);
	} else {
		await dev.click(`${SHEET} .translation-sheet-language`);
		await dev.waitFor(
			`!!document.querySelector('${SHEET} .language-sheet-row[data-code="${code}"]')`,
			{label: "the sheet's language list"}
		);
		await dev.evaluate(
			`document.querySelector('${SHEET} .language-sheet-row[data-code="${code}"]').click()`
		);
	}

	await dev.waitFor(`!document.querySelector(${JSON.stringify(SHEET)})`, {
		label: "the pick closed the sheet",
	});
}

/**
 * Type a draft in the translate panel (TranslatePanel.vue), Insert its
 * translation into the composer, and send it unchanged.
 */
async function sendTranslated(dev, draft) {
	await dev.evaluate(`document.querySelector("#form #translate-once").click()`);
	await dev.waitFor(`!!document.querySelector("#translate-panel-input")`, {
		label: "the panel opens",
	});
	await dev.fill("#translate-panel-input", draft);
	await dev.waitFor(INSERT_READY, {timeout: 20000, label: `the translation of "${draft}"`});
	await dev.evaluate(`document.querySelector("#form .translate-panel-insert").click()`);
	await dev.waitFor(`!document.querySelector(${JSON.stringify(PANEL)})`, {
		label: "Insert closes the panel",
	});
	await dev.evaluate(ENTER);
	await dev.waitFor(`document.querySelector(${JSON.stringify(INPUT)}).value === ""`, {
		timeout: 10000,
		label: "the composer clears once sent",
	});
}

/** The first outbound IRC line on B's socket carrying `text`. */
const outboundOf = (dev, text) =>
	dev.wsFrames.find((f) => f.dir === "out" && f.line.includes(text))?.line ?? "";
const inboundOf = (dev, text) =>
	dev.wsFrames.filter((f) => f.dir === "in" && f.line.includes(text)).pop()?.line ?? "";

export default async function run(page) {
	const b = await startDevice({chrome: process.env.CHROME_BIN, name: "langtags-b"});
	const raw = speaker(`ls${RUN}`);
	// browser-drive's page keeps no frame list of its own: A's outbound lines
	// are read from its WebSocket through a wrapper installed before boot.
	await page.addInitScript(`(() => {
		const Native = WebSocket;
		window.__seanceSent = [];
		window.WebSocket = class extends Native {
			send(data) { window.__seanceSent.push(String(data)); return super.send(data); }
		};
	})()`);
	const sentByA = (text) =>
		page.evaluate(
			`(window.__seanceSent || []).filter((l) => l.includes(${JSON.stringify(
				text
			)})).pop() || ""`
		);

	try {
		b.url = linkFor(`lb${RUN}`);
		page.url = url;
		await connect(page);
		await connect(b);
		await raw.joined;

		// Both read in English (the interface's language) from here on.
		await setReadingThroughSheet(page, true);
		await setReadingThroughSheet(b, true);

		// 1. A writes "hola" into Spanish through the composer.
		await setWriteTarget(page, "es");
		const draft = "hola";

		await sendTranslated(page, draft);
		await page.sleep(1500);

		const aLine = await sentByA(`PRIVMSG ${CHANNEL} :`);
		console.log(`  A sent: ${aLine}`);
		page.check(
			"1. A's line carries +draft/language=es and the machine-translated flag",
			/^@(?:[^ ]*;)?\+draft\/language=es(?:;[^ ]*)? /.test(aLine) &&
				/[@;]\+evilnet\.github\.io\/machine-translated(?:[; ])/.test(aLine)
		);

		const sentText = aLine.slice(aLine.indexOf(" :", aLine.indexOf("PRIVMSG")) + 2);

		// What the server relays decides what everyone, A's own echo
		// included, is told: nefarious2 before it lets `+evilnet.github.io/`
		// through drops the flag and keeps the language.
		await b.waitFor(`!!(${messageOf(sentText)})`, {timeout: 10000, label: "B hears A"});
		const relayed = inboundOf(b, sentText);
		const flagRelayed = relayed.includes("+evilnet.github.io/machine-translated");
		console.log(`  B heard: ${relayed}`);
		console.log(
			`  the server ${flagRelayed ? "relays" : "drops"} +evilnet.github.io/machine-translated`
		);

		const aOwn = await page.evaluate(messageOf(sentText));

		page.check(
			`1. A's own copy (the echo) knows its language (${JSON.stringify(aOwn)})`,
			aOwn?.self === true && aOwn.language === "es" && aOwn.machineTranslated === flagRelayed
		);
		page.check(
			`1. A's own row ${flagRelayed ? "says" : "does not say"} (machine translated)`,
			(await page.evaluate(noteOn(sentText))) === flagRelayed
		);
		await page.screenshot("a-own-line");

		// 2. B's copy.
		const bCopy = await b.evaluate(messageOf(sentText));

		page.check(
			`2. B's copy carries the sender's language (${JSON.stringify(bCopy)})`,
			bCopy?.self === false &&
				bCopy.language === "es" &&
				bCopy.machineTranslated === flagRelayed
		);
		page.check(
			`2. B's row ${flagRelayed ? "says" : "does not say"} (machine translated)`,
			(await b.evaluate(noteOn(sentText))) === flagRelayed
		);
		await b.waitFor(`${readsOf(sentText)}.length > 0`, {
			timeout: 20000,
			label: "B asks for a translation of A's line",
		});
		const bReads = await b.evaluate(readsOf(sentText));

		page.check(
			`2. B translates A's line from Spanish (${JSON.stringify(bReads)})`,
			bReads.every((r) => r.from === "es" && r.to === "en")
		);

		// The same text untagged, from a client that sends no tags: left
		// alone, as the reading scenario's "hola" is.
		raw.say(sentText);
		await b.waitFor(
			`${STORE}.state.activeChannel.channel.messages.filter((m) => m.text === ${JSON.stringify(
				sentText
			)}).length >= 2`,
			{timeout: 10000, label: "B hears the untagged copy"}
		);
		await sleep(4000);
		page.check(
			"2. the untagged copy asks for nothing more",
			(await b.evaluate(`${readsOf(sentText)}.length`)) === bReads.length
		);

		// 3. Tagged in the reader's own language: no request.
		const english = `hola ${RUN}`;

		raw.say(english, "+draft/language=en");
		await b.waitFor(`!!(${messageOf(english)})`, {
			timeout: 10000,
			label: "B hears the en line",
		});
		await sleep(4000);
		page.check(
			"3. a line tagged in the reader's language is not translated",
			(await b.evaluate(`${readsOf(english)}.length`)) === 0 &&
				(await b.evaluate(messageOf(english)))?.language === "en"
		);

		// 4. B answers through its composer into English.
		await setWriteTarget(b, "en");
		await sendTranslated(b, "ok");
		await sleep(1500);

		const bLine = outboundOf(b, `PRIVMSG ${CHANNEL} :`);
		console.log(`  B sent: ${bLine}`);
		page.check(
			"4. B's reply carries +draft/language=en",
			/^@(?:[^ ]*;)?\+draft\/language=en[; ]/.test(bLine)
		);

		const bText = bLine.slice(bLine.indexOf(" :", bLine.indexOf("PRIVMSG")) + 2);

		await page.waitFor(`!!(${messageOf(bText)})`, {timeout: 10000, label: "A hears B"});
		await page.sleep(4000);
		page.check(
			`4. A, reading in English, asks for no translation of B's English reply (${JSON.stringify(
				await page.evaluate(messageOf(bText))
			)})`,
			(await page.evaluate(`${readsOf(bText)}.length`)) === 0 &&
				(await page.evaluate(messageOf(bText)))?.language === "en"
		);
		page.check(
			"4. nothing was sent on anyone's behalf (one line each)",
			(await page.evaluate(
				`(window.__seanceSent || []).filter((l) => / PRIVMSG /.test(l)).length`
			)) === 1 &&
				b.wsFrames.filter((f) => f.dir === "out" && / PRIVMSG /.test(f.line)).length === 1
		);

		// 5. As written: A clears its target and sends plainly.
		await setWriteTarget(page, "");
		const asWritten = `sent as written ${RUN}`;

		await page.fill(INPUT, asWritten);
		await page.evaluate(ENTER);
		await page.sleep(1500);
		const aPlain = await sentByA(asWritten);

		page.check(
			`5. a line sent as written is untagged (${aPlain})`,
			!!aPlain && !aPlain.includes("+draft/language")
		);
	} finally {
		raw.quit();
		await b.close();
	}
}
