// The looks in a real browser (docs/resources/themes.md § Looks): Settings →
// Appearance → Look offers Classic, Messenger and Workspace and stores the
// pick; Workspace draws a run as a flat row across the column (the avatar a
// rounded square in a gutter, the nick bold and the time over the run, a
// later line's time in the gutter on hover, the mention band and our own
// "highlighted row" across the whole row, the quieter lines' text in the
// messages' column) and keeps every kind of row working (a reply's strip, a
// reaction, a link's preview, a multiline message, an edited and a deleted
// line, our own unconfirmed line, the unread and day dividers, the message
// toolbar); Messenger draws a private conversation two-sided (no avatar or
// nick on either side, our own at the far side in the own fill) and a
// channel as before. Then the same at a 390 px phone, at the largest text
// step, right to left, and under forced colours.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/looks.mjs
//
// No ircd: lib/tiny-ircd.mjs sends the capture gallery's conversation
// (lib/gallery-conversation.mjs) and a few lines of its own after it. It
// never echoes what the page sends, so a line we type stays unconfirmed.
// `SEANCE_PORT` serves the app from another port.

import {CHANNEL, DAY, NICK, PEER, conversation} from "./lib/gallery-conversation.mjs";
import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9883;

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	CHANNEL
)}`;

const STORE = `document.querySelector("[data-v-app]").__vue_app__.config.globalProperties.$store`;
const update = (name, value) =>
	`${STORE}.dispatch("settings/update", {name: ${JSON.stringify(name)}, value: ${JSON.stringify(
		value
	)}})`;
const item = (name) => `.channel-list-item[data-name="${name}"]`;
const RADIO = (value) => `input[name="messageLayout"][value="${value}"]`;
const LAYOUT = `document.documentElement.dataset.messageLayout ?? null`;
const STORED = `JSON.parse(localStorage.getItem("settings") ?? "{}").messageLayout ?? null`;

const at = (hhmm) => `${DAY}T${hhmm}:00.000Z`;
const from = (nick) => `:${nick}!${nick}@gallery.test`;

/** The rows the gallery does not have, after its conversation. */
const EXTRA = [
	`@time=${at("12:20")};msgid=x01 ${from(
		"alice"
	)} PRIVMSG ${CHANNEL} :the shot: https://example.com/shot.png`,
	`@time=${at("12:21")} ${from("bob")} BATCH +ml draft/multiline ${CHANNEL}`,
	`@batch=ml;msgid=x02 ${from("bob")} PRIVMSG ${CHANNEL} :a first line`,
	`@batch=ml ${from("bob")} PRIVMSG ${CHANNEL} :and a second one`,
	`${from("bob")} BATCH -ml`,
	`@time=${at("12:22")};msgid=x03;+evilnet.github.io/edit=g18 ${from(
		"carol"
	)} PRIVMSG ${CHANNEL} :looks good from here, mostly`,
	`@time=${at("12:23")} ${from("alice")} REDACT ${CHANNEL} g05`,
];

/** A row's geometry and the styles the checks read, by selector. */
const GEOMETRY = (selector, index = 0) => `(() => {
	const row = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
	if (!row) return null;
	const box = (el) => {
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const s = getComputedStyle(el);
		return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
			display: s.display, visibility: s.visibility};
	};
	const s = getComputedStyle(row);
	const list = row.closest(".messages");
	return {
		row: box(row),
		list: box(list),
		from: box(row.querySelector(":scope > .from")),
		avatar: box(row.querySelector(":scope > .from .avatar")),
		avatarRadius: row.querySelector(":scope > .from .avatar") ? getComputedStyle(row.querySelector(":scope > .from .avatar")).borderTopLeftRadius : null,
		nickWeight: row.querySelector(":scope > .from .user") ? getComputedStyle(row.querySelector(":scope > .from .user")).fontWeight : null,
		time: box(row.querySelector(":scope > .time")),
		content: box(row.querySelector(":scope > .content")),
		text: box(row.querySelector(":scope > .content .text, :scope > .content")),
		background: s.backgroundColor,
		radius: s.borderTopLeftRadius,
		borderStart: s.borderInlineStartWidth + " " + s.borderInlineStartStyle,
		shadow: s.boxShadow,
		opacity: s.opacity,
	};
})()`;

const ROW_WITH = (text, type = "message") =>
	`[...document.querySelectorAll('#chat .chat .msg[data-type="${type}"]')].indexOf([...document.querySelectorAll('#chat .chat .msg[data-type="${type}"]')].find((m) => m.textContent.includes(${JSON.stringify(
		text
	)})))`;

const NONE = "rgba(0, 0, 0, 0)";
const near = (a, b, slack = 2) => Math.abs(a - b) <= slack;

export default async function run(page) {
	let sendToPage = () => {};
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "server-time message-tags echo-message batch draft/multiline draft/message-redaction",
		onLine(line, ctx) {
			if (line.startsWith("JOIN ")) {
				sendToPage = ctx.send;
				for (const out of [...conversation("tiny.test"), ...EXTRA]) ctx.send(out);
				return true;
			}

			// Never echoed: a line we send stays unconfirmed.
			return line.startsWith("PRIVMSG ") || line.startsWith("TAGMSG ");
		},
	});

	const geometry = async (type, text, extra = "") => {
		const index = await page.evaluate(ROW_WITH(text, type));
		return index < 0
			? null
			: page.evaluate(GEOMETRY(`#chat .chat .msg[data-type="${type}"]${extra}`, index));
	};
	const open = async (name, text) => {
		await page.evaluate(`document.querySelector(${JSON.stringify(item(name))}).click()`);
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				item(name)
			)})?.classList.contains("active") && [...document.querySelectorAll("#chat .msg")].some((m) => m.textContent.includes(${JSON.stringify(
				text
			)}))`,
			{label: `${name} open`}
		);
		await page.evaluate(
			`(() => { const c = document.querySelector("#chat .chat"); c.scrollTop = c.scrollHeight; })()`
		);
		await page.sleep(250);
	};
	const scrollTo = (type, text) =>
		page.evaluate(
			`document.querySelectorAll('#chat .chat .msg[data-type="${type}"]')[${ROW_WITH(
				text,
				type
			)}].scrollIntoView({block: "center"})`
		);
	const noSideScroll = () =>
		page.evaluate(
			`(() => { const c = document.querySelector("#chat .chat"); return c.scrollWidth <= c.clientWidth && document.documentElement.scrollWidth <= innerWidth; })()`
		);
	const openAppearance = async () => {
		await page.click(`#footer button.settings`);
		await page.waitFor(`!!document.querySelector(".settings-menu button.appearance")`, {
			label: "settings open",
		});
		await page.click(`.settings-menu button.appearance`);
		await page.waitFor(`!!document.querySelector(${JSON.stringify(RADIO("lines"))})`, {
			label: "the look radios",
		});
		await page.evaluate(
			`document.querySelector(${JSON.stringify(
				RADIO("lines")
			)}).scrollIntoView({block: "center"})`
		);
	};
	const backToChat = async () => {
		await page.click(".settings-modal-done");
		await page.waitFor(`!!document.querySelector("#input")`, {label: "back in the chat"});
		await page.sleep(200);
	};

	try {
		await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/UTC"});
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(`!!document.querySelector(${JSON.stringify(item(PEER))})`, {
			label: "the channel and the query",
		});
		await open(CHANNEL, "looks good from here");
		await page.waitFor(`!!document.querySelector("#chat .msg-redacted")`, {
			label: "the extra rows",
		});

		// ---- the setting
		await openAppearance();
		const choices = await page.evaluate(
			`[...document.querySelectorAll('input[name="messageLayout"]')].map((i) => i.value + "=" + [...i.closest("label").childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim())`
		);
		page.check(
			`Look offers Classic, Messenger and Workspace (${choices.join(", ")})`,
			JSON.stringify(choices) ===
				JSON.stringify(["lines=Classic", "bubbles=Messenger", "workspace=Workspace"])
		);
		page.check(
			"Classic is the default and stores nothing",
			(await page.evaluate(LAYOUT)) === "lines" && (await page.evaluate(STORED)) === null
		);
		page.check(
			"no Combine messages switch under Classic",
			(await page.count('input[name="psGroupMessages"]')) === 0
		);
		await page.click(RADIO("workspace"));
		await page.sleep(200);
		page.check(
			"Workspace: html carries workspace, stored as workspace",
			(await page.evaluate(LAYOUT)) === "workspace" &&
				(await page.evaluate(STORED)) === "workspace"
		);
		page.check(
			"Workspace shows the Combine messages switch",
			(await page.count('input[name="psGroupMessages"]')) === 1
		);
		await page.screenshot("1-settings-workspace", {selector: "#settings"});
		await backToChat();

		// ---- Workspace, a channel at the desktop
		await open(CHANNEL, "looks good from here");
		await page.screenshot("2-workspace-channel");
		const first = await geometry("message", "morning all");
		const later = await geometry("message", "the build went green");
		const mention = await geometry("message", "can you look at the theme gallery");
		const reply = await geometry("message", "which commit was it");
		const join = await geometry("join", "frank");
		const own = await geometry("message", "on it, capturing");

		page.check(
			`a row spans the column (${first.row.width} of ${first.list.width})`,
			near(first.row.width, first.list.width, 1)
		);
		page.check(
			`no bubble: no fill, no corner (${first.background}, ${first.radius})`,
			first.background === NONE && first.radius === "0px"
		);
		page.check(
			`the avatar is a rounded square in the gutter (${first.avatar.width}×${first.avatar.height}, ${first.avatarRadius}, ends ${first.avatar.right} before the text at ${first.content.left})`,
			near(first.avatar.width, first.avatar.height, 0.5) &&
				first.avatarRadius !== "50%" &&
				parseFloat(first.avatarRadius) > 0 &&
				first.avatar.left > first.row.left &&
				first.avatar.right < first.content.left - 4
		);
		page.check(
			`the header: the nick bold, the time beside it on one line (${first.nickWeight})`,
			Number(first.nickWeight) >= 700 &&
				first.time.visibility === "visible" &&
				first.time.left > first.from.right &&
				near(first.time.bottom, first.from.bottom, 4) &&
				first.content.top >= first.from.bottom - 1
		);
		page.check(
			"a later line: no header, its time hidden, its text in the same column",
			later.from.display === "none" &&
				later.time.visibility === "hidden" &&
				near(later.content.left, first.content.left, 1)
		);

		await scrollTo("message", "the build went green");
		const laterIndex = await page.evaluate(ROW_WITH("the build went green", "message"));
		await page.hover('#chat .chat .msg[data-type="message"]', laterIndex);
		await page.sleep(150);
		const hovered = await geometry("message", "the build went green");
		const timeFill = await page.evaluate(
			`getComputedStyle(document.querySelectorAll('#chat .chat .msg[data-type="message"]')[${laterIndex}].querySelector(".time")).backgroundColor`
		);
		page.check(
			`hovered, a later line's time shows over the row's end, level with its line, on the window's colour (${hovered.time.left}–${hovered.time.right} of ${hovered.row.right}, ${timeFill})`,
			hovered.time.visibility === "visible" &&
				near(hovered.time.right, hovered.row.right, 1) &&
				hovered.time.top >= hovered.row.top - 1 &&
				hovered.time.bottom <= hovered.content.bottom + 2 &&
				timeFill !== NONE
		);
		page.check(
			`hovered, the row is tinted across its width and its toolbar is up (${hovered.shadow})`,
			hovered.shadow !== "none" &&
				(await page.evaluate(
					`getComputedStyle(document.querySelectorAll('#chat .chat .msg[data-type="message"]')[${laterIndex}].querySelector(".msg-actions")).display`
				)) === "flex"
		);
		await page.screenshot("3-workspace-hover");
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 5, y: 5});

		page.check(
			`a mention is a band across the row, the bar at its start (${mention.background}, ${mention.borderStart})`,
			mention.background !== NONE &&
				/^3px solid$/.test(mention.borderStart) &&
				near(mention.row.width, mention.list.width, 1) &&
				near(mention.content.left, first.content.left, 1) &&
				near(mention.avatar.left, first.avatar.left, 1)
		);
		page.check(
			"a reply's strip sits over its line, in the text column, no bubble around it",
			(await page.evaluate(
				`(() => { const m = document.querySelectorAll('#chat .chat .msg[data-type="message"]')[${await page.evaluate(
					ROW_WITH("which commit was it", "message")
				)}]; const q = m.querySelector(".msg-reply-quote").getBoundingClientRect(); const c = m.querySelector(".content").getBoundingClientRect(); return Math.abs(q.left - c.left) <= 1 && q.top >= c.top - 1; })()`
			)) && reply.background === NONE
		);
		page.check(
			`a join's icon starts at the text column (${join.from.left} vs ${first.content.left})`,
			near(join.from.left, first.content.left, 1) && near(join.row.width, join.list.width, 1)
		);
		page.check(
			"our own line, by default: greyed, no band",
			own.background === NONE &&
				(await page.evaluate(
					`getComputedStyle(document.querySelectorAll('#chat .chat .msg[data-type="message"]')[${await page.evaluate(
						ROW_WITH("on it, capturing", "message")
					)}].querySelector(".content")).color`
				)) !==
					(await page.evaluate(
						`getComputedStyle(document.querySelectorAll('#chat .chat .msg[data-type="message"]')[${await page.evaluate(
							ROW_WITH("morning all", "message")
						)}].querySelector(".content")).color`
					))
		);
		page.check(
			"a reaction sits under its line",
			await page.evaluate(
				`(() => { const m = document.querySelectorAll('#chat .chat .msg[data-type="message"]')[${await page.evaluate(
					ROW_WITH("on it, capturing", "message")
				)}]; const r = m.querySelector(".msg-reactions"); const t = m.querySelector(".content"); return !!r && r.getBoundingClientRect().top > t.getBoundingClientRect().top + 8 && r.getBoundingClientRect().left >= t.getBoundingClientRect().left - 1; })()`
			)
		);

		const preview = await page.evaluate(
			`(() => { const m = [...document.querySelectorAll('#chat .chat .msg')].find((x) => x.textContent.includes("the shot:")); const p = m?.querySelector(".preview"); if (!p) return null; const r = p.getBoundingClientRect(), c = m.querySelector(".content").getBoundingClientRect(); return r.left >= c.left - 1 && r.right <= c.right + 1 && r.height > 0; })()`
		);
		page.check(`a link's preview sits in the text column (${preview})`, preview === true);
		const multi = await geometry("message", "a first line");
		page.check(
			"a multiline message is one row, both lines in it",
			!!multi &&
				(await page.evaluate(
					`[...document.querySelectorAll('#chat .chat .msg[data-type="message"]')].some((m) => m.textContent.includes("a first line") && m.textContent.includes("and a second one"))`
				))
		);
		page.check(
			"an edited line carries its mark, a deleted one its placeholder",
			(await page.count("#chat .chat .msg .msg-edited")) >= 1 &&
				(await page.count("#chat .chat .msg .msg-redacted")) >= 1
		);
		page.check(
			"a day's divider is drawn, and the line after it has its header",
			(await page.evaluate(
				`(() => { const m = document.querySelector("#chat .chat .date-marker-container + .msg"); return !!m && (m.dataset.type !== "message" || getComputedStyle(m.querySelector(".from")).display !== "none"); })()`
			)) === true
		);
		page.check("no sideways scroll at the desktop", await noSideScroll());
		await page.screenshot("4-workspace-rows");

		// Our own unconfirmed line (the server never echoes): faded, a full row.
		await page.click("#input");
		await page.send("Input.insertText", {text: "a line the server has not echoed"});
		await page.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			text: "\r",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		await page.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		await page.waitFor(`!!document.querySelector("#chat .chat .msg.pending")`, {
			label: "our unconfirmed line",
		});
		const pending = await page.evaluate(GEOMETRY("#chat .chat .msg.pending"));
		page.check(
			`an unconfirmed line is faded and spans the row (${pending.opacity})`,
			pending.opacity === "0.55" && near(pending.row.width, pending.list.width, 1)
		);

		// The unread divider: a line arrives while the query is open.
		await open(PEER, "sending you a screenshot");
		sendToPage(
			`@time=${at("12:24")};msgid=x05 ${from("carol")} PRIVMSG ${CHANNEL} :one more thing`
		);
		await page.sleep(400);
		await open(CHANNEL, "one more thing");
		page.check(
			"the unread divider is drawn, and the line after it has its header",
			(await page.evaluate(
				`(() => { const m = document.querySelector("#chat .chat .unread-marker + .msg"); return !!m && getComputedStyle(m.querySelector(".from")).display !== "none" && m.querySelector(".from .avatar") !== null; })()`
			)) === true
		);

		// Your own messages: highlighted row is a band across the whole row.
		await page.evaluate(update("ownMessages", "band"));
		await page.sleep(150);
		const banded = await geometry("message", "on it, capturing");
		page.check(
			`Your own messages: highlighted row bands the whole row (${banded.background})`,
			banded.background !== NONE && near(banded.row.width, banded.list.width, 1)
		);
		await scrollTo("message", "on it, capturing");
		await page.screenshot("5-workspace-own-band");
		await page.evaluate(update("ownMessages", "muted"));

		// Forced colours: the band goes, the bar stays.
		await page.send("Emulation.setEmulatedMedia", {
			features: [{name: "forced-colors", value: "active"}],
		});
		await page.sleep(200);
		const forced = await geometry("message", "can you look at the theme gallery");
		page.check(
			`forced colours: the mention keeps its bar (${forced.borderStart})`,
			/^3px solid$/.test(forced.borderStart)
		);
		await scrollTo("message", "can you look at the theme gallery");
		await page.screenshot("6-workspace-forced-colors");
		await page.send("Emulation.setEmulatedMedia", {features: []});

		// Right to left: the gutter and the avatar move to the right.
		await page.evaluate(`document.documentElement.dir = "rtl"`);
		await page.sleep(200);
		const rtl = await geometry("message", "morning all");
		page.check(
			`right to left: the avatar at the row's right, the text before it (${rtl.avatar.left} > ${rtl.content.right})`,
			rtl.avatar.left > rtl.content.right && rtl.avatar.right < rtl.row.right
		);
		page.check("right to left: no sideways scroll", await noSideScroll());
		await scrollTo("message", "morning all");
		await page.screenshot("7-workspace-rtl");
		await page.evaluate(`document.documentElement.dir = "ltr"`);

		// A query is drawn like a channel.
		await open(PEER, "sending you a screenshot");
		const qFirst = await geometry("message", "hey, got a minute");
		const qOwn = await geometry("message", "sending you a screenshot");
		page.check(
			"Workspace: a query is drawn as a channel (avatars, headers, own line at the start)",
			qFirst.avatar?.display !== "none" &&
				qFirst.from.display !== "none" &&
				near(qOwn.content.left, qFirst.content.left, 1)
		);
		await page.screenshot("8-workspace-query");

		// ---- Messenger
		await page.evaluate(update("messageLayout", "bubbles"));
		await page.sleep(200);
		const peer1 = await geometry("message", "hey, got a minute");
		const peer2 = await geometry("message", "the phone layout");
		const mine = await geometry("message", "sending you a screenshot");
		page.check(
			"Messenger query: no avatar and no nick on either side",
			peer1.from.display === "none" &&
				peer2.from.display === "none" &&
				mine.from.display === "none"
		);
		page.check(
			`Messenger query: theirs at the start, ours at the far side (${
				peer1.row.left - peer1.list.left
			}, ${mine.list.right - mine.row.right})`,
			peer1.row.left - peer1.list.left < 16 &&
				mine.list.right - mine.row.right < 16 &&
				mine.row.left > mine.list.left + mine.list.width * 0.2
		);
		const ownFill = await page.evaluate(
			`(() => { const e = document.createElement("span"); e.style.color = getComputedStyle(document.documentElement).getPropertyValue("--bubble-own-bg"); document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })()`
		);
		page.check(
			`Messenger query: ours in the own fill (${mine.background} = ${ownFill}), theirs not`,
			mine.background === ownFill && peer1.background !== ownFill
		);
		page.check(
			"Messenger query: a run's first line shows its time at the bubble's end, a later line's is hidden",
			peer1.time.visibility === "visible" &&
				peer1.time.left >= peer1.content.right - 1 &&
				peer2.time.visibility === "hidden"
		);
		await page.screenshot("9-messenger-query");
		await open(CHANNEL, "looks good from here");
		const mFirst = await geometry("message", "morning all");
		page.check(
			"Messenger channel: unchanged, the avatar and the nick over the run",
			mFirst.from.display !== "none" &&
				mFirst.avatar.display !== "none" &&
				mFirst.avatarRadius === "50%" &&
				mFirst.background !== NONE
		);

		// ---- a phone
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 1,
			mobile: true,
		});
		await page.evaluate(update("messageLayout", "workspace"));
		await page.sleep(400);
		await open(CHANNEL, "looks good from here");
		const phone = await geometry("message", "morning all");
		page.check(
			`phone: a tighter gutter (text at ${phone.content.left - phone.row.left}px, avatar ${
				phone.avatar.width
			}px)`,
			phone.content.left - phone.row.left < first.content.left - first.row.left &&
				phone.avatar.width < first.avatar.width
		);
		page.check("phone: no sideways scroll", await noSideScroll());
		await page.screenshot("10-phone-workspace");
		await page.evaluate(update("fontSize", "huge"));
		await page.sleep(400);
		page.check("phone at the largest text step: no sideways scroll", await noSideScroll());
		await page.screenshot("11-phone-workspace-huge");
		await page.evaluate(update("fontSize", "medium"));
		await page.evaluate(update("messageLayout", "bubbles"));
		await page.sleep(300);
		await open(PEER, "sending you a screenshot");
		const phoneMine = await geometry("message", "sending you a screenshot");
		const phonePeer = await geometry("message", "hey, got a minute");
		page.check(
			"phone Messenger query: ours at the far side, theirs at the start, no headers",
			phoneMine.list.right - phoneMine.row.right < 16 &&
				phonePeer.row.left - phonePeer.list.left < 16 &&
				phoneMine.from.display === "none" &&
				phonePeer.from.display === "none"
		);
		page.check("phone Messenger query: no sideways scroll", await noSideScroll());
		await page.screenshot("12-phone-messenger-query");
	} finally {
		await ircd.close();
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
