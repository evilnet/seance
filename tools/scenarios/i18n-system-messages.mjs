// The wave-B i18n frames end to end in a real browser: with the qqx pseudo
// locale seeded, the system-message frames (join / part / nick and the
// condensed summary) render pseudo-localized — RLE-wrapped lookalike text,
// the mapped copy doubled per the generator — while every nick, hostmask,
// reason and the server's own away/back sentences pass through untouched,
// and the interpolated names sit inside <bdi> so the RTL pseudo text cannot
// bleed into them.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   CHROME_BIN=$PWD/tmp/chrome-headless-wrapper.sh \
//     node tools/browser-drive.mjs tools/scenarios/i18n-system-messages.mjs
//
// Live-ircd gated, like the client's live tests: SEANCE_IRC_URL (default
// wss://localhost:8443/, TLS verification relaxed for localhost only) and
// SEANCE_IRC_CHANNEL (default #seance) point it elsewhere. When no ircd
// answers, the scenario prints a SKIP line and exits 0 — the frames' pot and
// toolchain coverage does not depend on one.
//
// Everything the burst needs is opless: the connect form's join field, a
// second user on a raw WebSocket (tools/scenarios/message-actions-single.mjs
// is the model) who joins/parts/rejoins, `/nick`, and `/away` + `/back`. A
// scratch channel is joined and parted too, so a real join+part round trip
// goes out from the composer. Self rows (own join, the away/back
// confirmations) render standalone by design — MessageList never condenses
// `self` — so the collapsed burst carries the *other* user's frames.
//
// eslint cannot parse .mjs (pre-existing repo state): this file is prettier-
// formatted by hand and checked only by running it.

import {copyFileSync, mkdirSync, readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const IRCD = process.env.SEANCE_IRC_URL ?? "wss://localhost:8443/";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";
const RLE = "\u202B"; // U+202B RIGHT-TO-LEFT EMBEDDING: qqx wraps every frame in it

if (new URL(IRCD).hostname === "localhost" || new URL(IRCD).hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert
}

// Two nicks per run: a network still holding the last run's connection would
// answer a reused one with 433 and the app has no second guess to make.
const stamp = Math.random().toString(36).slice(2, 6);
const NICK = `scenick${stamp}`;
const TALKER = `scentalk${stamp}`;
const SCRATCH = `#scen${stamp}`;

// `host` carries a path when the ircd's WebSocket lives under one
// (`irc.example.org/wockets/secure`); see the comment on it in js/irc/types.ts.
const ircd = new URL(IRCD);
const HOST = ircd.hostname + ircd.pathname.replace(/\/$/, "");
const IRC_PORT = ircd.port || (ircd.protocol === "wss:" ? "443" : "80");

export const url =
	`http://localhost:${PORT}/?host=${encodeURIComponent(HOST)}&port=${IRC_PORT}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

// The compiled pseudo locale: every frame's expected rendering. A frame
// renders as RLE + mapped-copy + mapped-copy + PDF, so the single mapped copy
// is the first half of the value with the isolates stripped. A {count} token
// survives the mapping, while the rendered summary carries the real number —
// the tokens are stripped out, leaving the count-independent mapped text.
const QQX = JSON.parse(
	readFileSync(
		resolve(dirname(fileURLToPath(import.meta.url)), "../../client/locales/qqx.json"),
		"utf8"
	)
);

function frame(key, {form = "other"} = {}) {
	const value = QQX[key];
	const text = typeof value === "string" ? value : value[form];
	const inner = text.slice(1, -1);
	const half = inner.slice(0, inner.length / 2);

	// A {count} token survives the mapping untouched, while the rendered
	// summary carries the real number in its place — so the mapped text
	// around the tokens is the count-independent part worth matching.
	return half.split(/\{\w+\}/).join("");
}

/** A raw dial to the ircd: reachable within 5 s, or the run is a SKIP. */
function ircdReachable() {
	return new Promise((done) => {
		const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
		const giveUp = setTimeout(() => {
			done(false);
			ws.close();
		}, 5000);

		ws.onopen = () => {
			clearTimeout(giveUp);
			ws.send("QUIT :seance scenario probe");
			done(true);
			setTimeout(() => ws.close(), 250);
		};

		ws.onerror = () => {
			clearTimeout(giveUp);
			done(false);
		};
	});
}

const IRC_UP = await ircdReachable();

/** A second user on the network, so the frames carry someone else's name. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance i18n scenario`);
	};

	let onJoined = () => {};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			ws.send(`JOIN ${CHANNEL}`);
		} else if (params[1] === "JOIN" && params[0].includes(nick)) {
			onJoined();
		} else if (params[1] === "433") {
			ws.send(`NICK ${nick}${Math.floor(Math.random() * 1000)}`);
		}
	};

	return {
		joined: new Promise((res, rej) => {
			onJoined = res;
			ws.onerror = () => rej(new Error(`${nick} never registered`));
			setTimeout(() => rej(new Error(`${nick} never joined ${CHANNEL}`)), 20000);
		}),
		join: () => ws.send(`JOIN ${CHANNEL}`),
		part: () => ws.send(`PART ${CHANNEL} :off again`),
		close: () => ws.close(),
	};
}

const CONTENTS = (type) =>
	`Array.from(document.querySelectorAll("#chat [data-type='${type}'] .content")).map((c) => c.textContent)`;

const ON_CHANNEL = `document.querySelector("#chat-container")?.dataset.currentChannel === ${JSON.stringify(
	CHANNEL
)}`;

const SEND = async (page, line) => {
	await page.fill("#input", line);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
};

export default async function run(page) {
	if (!IRC_UP) {
		console.log(
			"SKIP i18n-system-messages: dev ircd not reachable — start tools/nefarious-dev/run.sh"
		);
		return;
	}

	// Seed the locale before the app boots: the pre-paint script and
	// activate() read the settings blob, and an explicit qqx pick activates in
	// any build (the devOnly filter governs "auto" and the selector only).
	await page.addInitScript(`localStorage.setItem("settings", JSON.stringify({locale: "qqx"}))`);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.waitFor(`document.documentElement.lang === "qqx"`, {
		timeout: 15000,
		label: "qqx active after boot",
	});

	// Connect and open the channel the form asked for.
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(ON_CHANNEL, {timeout: 15000, label: "the channel window open"});
	await page.waitFor(`${CONTENTS("join")}.length > 0`, {
		timeout: 15000,
		label: "our own join row",
	});

	// 1. A user-triggered join+part round trip on a scratch channel: the view
	// moves there and back, and a real JOIN/PART pair goes out.
	await SEND(page, `/join ${SCRATCH}`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${SCRATCH}"]')`, {
		timeout: 15000,
		label: "the scratch channel in the sidebar",
	});
	await SEND(page, `/part`);
	// A parted channel keeps its window, so the view has to be moved back.
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(ON_CHANNEL, {timeout: 15000, label: "the channel window focused"});

	// 2. Someone else joins, parts, rejoins: the burst's foreign names, all
	// consecutive condensed types, so they collapse into one block.
	const talker = speaker(TALKER);
	await talker.joined;
	await page.waitFor(`${CONTENTS("join")}.some((c) => c.includes(${JSON.stringify(TALKER)}))`, {
		timeout: 15000,
		label: "the talker's join frame",
	});
	talker.part();
	await page.waitFor(`${CONTENTS("part")}.some((c) => c.includes(${JSON.stringify(TALKER)}))`, {
		timeout: 15000,
		label: "the talker's part frame",
	});
	talker.join();
	await page.waitFor(
		`${CONTENTS("join")}.filter((c) => c.includes(${JSON.stringify(TALKER)})).length >= 2`,
		{timeout: 15000, label: "the talker's second join frame"}
	);

	// 3. Our own rename (a condensed row with both names), then away and back
	// (self rows, standalone, carrying the server's own sentences).
	await SEND(page, `/nick ${NICK}2`);
	await page.waitFor(
		`${CONTENTS("nick")}.some((c) => c.includes(${JSON.stringify(NICK + "2")}))`,
		{timeout: 15000, label: "our nick frame"}
	);
	await SEND(page, `/away sealing the vault`);
	await page.waitFor(`${CONTENTS("away")}.length > 0`, {
		timeout: 15000,
		label: "the away confirmation",
	});
	await SEND(page, `/back`);
	await page.waitFor(`${CONTENTS("back")}.length > 0`, {
		timeout: 15000,
		label: "the back confirmation",
	});

	// (a) Frames render pseudo-localized: RLE-wrapped lookalikes, the English
	// copy gone. Checked on the talker's rows, so the name is not ours.
	const joins = JSON.parse(await page.evaluate(`JSON.stringify(${CONTENTS("join")})`));
	const talkerJoin = joins.find((c) => c.includes(TALKER));
	page.check("a join frame rendered", talkerJoin !== undefined);
	page.check(
		"the join frame is pseudo-localized (RLE + the compiled qqx copy)",
		talkerJoin !== undefined &&
			talkerJoin.includes(RLE) &&
			talkerJoin.includes(frame("system.join"))
	);
	page.check(
		"no English join copy leaked",
		joins.every((c) => !c.includes("has joined the channel"))
	);

	const parts = JSON.parse(await page.evaluate(`JSON.stringify(${CONTENTS("part")})`));
	const talkerPart = parts.find((c) => c.includes(TALKER));
	page.check(
		"the part frame is pseudo-localized",
		talkerPart !== undefined && talkerPart.includes(frame("system.part"))
	);

	const nicks = JSON.parse(await page.evaluate(`JSON.stringify(${CONTENTS("nick")})`));
	page.check(
		"the nick frame is pseudo-localized",
		nicks.some((c) => c.includes(frame("system.nick")))
	);

	// (b) Nicks stay verbatim — the raw ASCII nick, unlookaliked, inside a
	// <bdi>, which this wave owns for system-message frames.
	page.check(
		"the talker's nick is verbatim inside <bdi>",
		await page.evaluate(
			`Array.from(document.querySelectorAll("#chat [data-type='join'] .content")).some(
				(c) => c.querySelector("bdi") && c.querySelector("bdi").textContent === ${JSON.stringify(TALKER)}
			)`
		)
	);
	page.check(
		"the rename shows both nicks verbatim",
		nicks.some((c) => c.includes(NICK) && c.includes(`${NICK}2`))
	);
	const nickBdis = await page.evaluate(
		`document.querySelectorAll("#chat [data-type='nick'] .content bdi").length`
	);
	page.check("both sides of the rename are direction-isolated", nickBdis >= 2);

	// The away/back confirmations are the server's own sentences: no frame,
	// no pseudo text.
	const aways = JSON.parse(await page.evaluate(`JSON.stringify(${CONTENTS("away")})`));
	page.check(
		"the away confirmation stays verbatim server text",
		aways.length > 0 && aways.every((c) => !c.includes(RLE))
	);

	// (c) The collapsed burst: the tCount + Intl.ListFormat product —
	// pseudo-localized parts with the real counts inside, one block for the
	// whole consecutive run.
	const summary = await page.evaluate(
		`(Array.from(document.querySelectorAll(
			"#chat [data-type='condensed'] .condensed-summary .content"
		)).pop() ?? {textContent: ""}).textContent`
	);
	page.check("the condensed summary rendered", summary.length > 0);
	page.check("the condensed summary is pseudo-localized", summary.includes(RLE));
	page.check("the condensed summary carries the counts", /\d/.test(summary));
	page.check(
		"the condensed join part is the compiled qqx plural",
		summary.includes(frame("condensed.join"))
	);
	page.check(
		"the condensed left part is the compiled qqx plural",
		summary.includes(frame("condensed.left"))
	);
	page.check(
		"the condensed nick part is the compiled qqx plural",
		summary.includes(frame("condensed.nick"))
	);

	// The deliverable: expand the burst first, so the screenshot shows the
	// frames and their <bdi> names under the summary line.
	const blockCount = await page.evaluate(
		`document.querySelectorAll("#chat [data-type='condensed']").length`
	);

	if (blockCount > 0) {
		await page.click(
			"#chat [data-type='condensed'] .condensed-summary .content",
			blockCount - 1
		);
		await page.sleep(300);
	}

	const shot = await page.screenshot("i18n-system-messages");
	mkdirSync("tmp/scenarios", {recursive: true});
	copyFileSync(shot, "tmp/scenarios/i18n-system-messages.png");

	talker.close();
	page.check("no console errors", page.consoleErrors.length === 0);
}
