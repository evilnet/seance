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

const LONG_LINK =
	"https://example.com/notes/release/2026/the-long-path-to-the-final-draft-of-the-notes-for-everyone";

/** The rows the gallery does not have, after its conversation. */
const EXTRA = [
	`@time=${at("12:20")};msgid=x01 ${from(
		"alice"
	)} PRIVMSG ${CHANNEL} :the shot: https://example.com/shot.png`,
	// A later line that is a link from end to end: its hover time is over it.
	`@time=${at("12:20")};msgid=x06 ${from("alice")} PRIVMSG ${CHANNEL} :${LONG_LINK}`,
	`@time=${at("12:21")} ${from("bob")} BATCH +ml draft/multiline ${CHANNEL}`,
	`@batch=ml;msgid=x02 ${from("bob")} PRIVMSG ${CHANNEL} :a first line`,
	`@batch=ml ${from("bob")} PRIVMSG ${CHANNEL} :and a second one`,
	`${from("bob")} BATCH -ml`,
	`@time=${at("12:22")};msgid=x03;+evilnet.github.io/edit=g18 ${from(
		"carol"
	)} PRIVMSG ${CHANNEL} :looks good from here, mostly`,
	`@time=${at("12:23")} ${from("alice")} REDACT ${CHANNEL} g05`,
	// A stretch of status lines of different kinds (drawn one by one with
	// condensing off), an action that mentions us and one of our own.
	`@time=${at("12:23")};msgid=x10 ${from("erin")} JOIN ${CHANNEL}`,
	`@time=${at("12:23")};msgid=x11 ${from("erin")} NICK :erin_afk`,
	`@time=${at("12:23")};msgid=x12 ${from(
		"alice"
	)} KICK ${CHANNEL} erin_afk :that was a long lunch`,
	`@time=${at("12:23")};msgid=x13 ${from(
		"bob"
	)} PART ${CHANNEL} :back in a bit, the release notes need a second pair of eyes`,
	`@time=${at("12:23")};msgid=x14 ${from(
		"dave"
	)} PRIVMSG ${CHANNEL} :\x01ACTION hands ${NICK} the release notes\x01`,
	`@time=${at("12:23")};msgid=x15 ${from(NICK)} PRIVMSG ${CHANNEL} :\x01ACTION ships it\x01`,
	// Short lines, for the toolbar: one in the channel, one in the query.
	`@time=${at("12:23")};msgid=x07 ${from("frank")} PRIVMSG ${CHANNEL} :yep`,
	`@time=${at("12:23")};msgid=x08 ${from(PEER)} PRIVMSG ${NICK} :yep`,
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

/** The last row of each status kind in the channel: where its icon and words stand, their inks. */
const STATUS = `(() => {
	const out = {};
	const body = parseFloat(getComputedStyle(document.querySelector('#chat .chat .msg[data-type="message"]')).fontSize);
	for (const row of document.querySelectorAll('#chat .chat .messages > .msg:not([data-type="message"], [data-type="notice"], [data-type="action"], [data-type="condensed"])')) {
		const from = row.querySelector(":scope > .from");
		const content = row.querySelector(":scope > .content");
		const f = from.getBoundingClientRect(), c = content.getBoundingClientRect(), r = row.getBoundingClientRect();
		const before = getComputedStyle(from, "::before");
		const prev = row.previousElementSibling?.getBoundingClientRect();
		out[row.dataset.type] = {content: c.left, contentEnd: c.right, iconStart: f.left, iconEnd: f.right, rowStart: r.left,
			icon: before.content, glyph: before.content + " " + before.transform,
			iconColor: before.color, inkColor: getComputedStyle(content).color,
			time: getComputedStyle(row.querySelector(":scope > .time")).visibility,
			size: parseFloat(getComputedStyle(row).fontSize), bodySize: body,
			gapBefore: prev ? Math.round(c.top - prev.bottom) : null};
	}
	return out;
})()`;

/** An action row's styles, by its words. */
const ACTION = (text) => `(() => {
	const row = [...document.querySelectorAll('#chat .chat .msg[data-type="action"]')].find((m) => m.textContent.includes(${JSON.stringify(
		text
	)}));
	const content = row.querySelector(":scope > .content");
	const nick = content.querySelector(":scope > .user");
	const probe = document.createElement("span");
	probe.className = [...nick.classList].filter((c) => c.startsWith("color-")).concat("user").join(" ");
	document.querySelector("#chat .chat .messages").append(probe);
	const nickClassColor = getComputedStyle(probe).color;
	probe.remove();
	const s = getComputedStyle(content);
	return {italic: s.fontStyle === "italic", color: s.color, rowColor: getComputedStyle(row).color,
		icon: getComputedStyle(row.querySelector(":scope > .from"), "::before").content,
		nickItalic: getComputedStyle(nick).fontStyle, nickWeight: getComputedStyle(nick).fontWeight,
		nickColor: getComputedStyle(nick).color, nickClassColor,
		content: content.getBoundingClientRect().left,
		time: getComputedStyle(row.querySelector(":scope > .time")).visibility,
		size: parseFloat(getComputedStyle(row).fontSize),
		bodySize: parseFloat(getComputedStyle(document.querySelector('#chat .chat .msg[data-type="message"]')).fontSize)};
})()`;

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

			if (line.startsWith("WHOIS ")) {
				for (const out of [
					`:tiny.test 311 ${NICK} alice alice gallery.test * :Alice`,
					`:tiny.test 312 ${NICK} alice tiny.test :the tiny server`,
					`:tiny.test 330 ${NICK} alice alice :is logged in as`,
					`:tiny.test 318 ${NICK} alice :End of /WHOIS list.`,
				]) {
					ctx.send(out);
				}

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
	const rowAt = (type, index) =>
		`document.querySelectorAll('#chat .chat .msg[data-type="${type}"]')[${index}]`;
	const unhover = () => page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 5, y: 5});
	// The toolbar of the row with `text`, hovered, against the pane's inside.
	const toolbarFits = async (text, label) => {
		await scrollTo("message", text);
		await page.sleep(150);
		const index = await page.evaluate(ROW_WITH(text, "message"));
		await page.hover('#chat .chat .msg[data-type="message"]', index);
		await page.sleep(150);
		const box = await page.evaluate(`(() => {
			const a = ${rowAt("message", index)}?.querySelector(".msg-actions");
			if (!a || getComputedStyle(a).display === "none") return null;
			const c = document.querySelector("#chat .chat");
			const left = c.getBoundingClientRect().left + c.clientLeft;
			const b = a.getBoundingClientRect();
			return {start: Math.round(b.left - left), end: Math.round(left + c.clientWidth - b.right),
				arrow: !!document.querySelector("#chat .scroll-down-shown")};
		})()`);
		page.check(
			`${label}: the toolbar stays inside the pane (${JSON.stringify(box)})`,
			!!box && box.start >= 0 && box.end >= 0
		);
		await unhover();
		return box;
	};
	// Colours as a canvas paints them, so an oklab and an rgb spelling compare.
	const PAINT = `((c) => { const x = document.createElement("canvas").getContext("2d"); x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].join(); })`;
	// Under Increase Contrast: a run's time and our own greyed words in the text colour.
	const contrastLifts = async (label) => {
		const got = await page.evaluate(`(() => {
			const paint = ${PAINT};
			const rows = [...document.querySelectorAll('#chat .chat .msg[data-type="message"]')];
			const first = rows.find((m) => m.textContent.includes("morning all"));
			const own = rows.find((m) => m.textContent.includes("on it, capturing"));
			return {text: paint(getComputedStyle(first).getPropertyValue("--body-color").trim()),
				time: paint(getComputedStyle(first.querySelector(".time")).color),
				own: paint(getComputedStyle(own.querySelector(".content")).color)};
		})()`);
		page.check(
			`${label}: Increase Contrast puts the time and our own greyed words in the text colour (${JSON.stringify(
				got
			)})`,
			got.time === got.text && got.own === got.text
		);
	};
	// A reply's strip, focused from the keyboard: a ring, inside the strip.
	const quoteRing = async (label) => {
		const index = await page.evaluate(ROW_WITH("which commit was it", "message"));
		const ring = await page.evaluate(`(() => {
			const q = ${rowAt("message", index)}.querySelector(".msg-reply-quote");
			q.focus({focusVisible: true});
			const s = getComputedStyle(q);
			const out = {visible: q.matches(":focus-visible"), style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset};
			q.blur();
			return out;
		})()`);
		page.check(
			`${label}: a reply's strip shows a keyboard's ring inside it (${JSON.stringify(ring)})`,
			ring.visible &&
				ring.style !== "none" &&
				parseFloat(ring.width) > 0 &&
				parseFloat(ring.offset) <= -parseFloat(ring.width)
		);
	};
	// A whois in one column: each label after the first a step below the value before it.
	const whoisSpaced = async (label) => {
		await page.evaluate(
			`document.querySelectorAll("#chat .chat .whois").forEach((w) => w.closest(".msg").dataset.seen = "1")`
		);
		await page.click("#input");
		await page.send("Input.insertText", {text: "/whois alice"});
		const key = {key: "Enter", code: "Enter", windowsVirtualKeyCode: 13};
		await page.send("Input.dispatchKeyEvent", {type: "keyDown", text: "\r", ...key});
		await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...key});
		const WHOIS = `[...document.querySelectorAll("#chat .chat .whois")].find((w) => !w.closest(".msg").dataset.seen)`;
		await page.waitFor(`!!${WHOIS}`, {label: "a whois"});
		await page.sleep(200);
		const got = await page.evaluate(`(() => {
			const w = ${WHOIS};
			w.scrollIntoView({block: "center"});
			const dts = [...w.querySelectorAll("dt")];
			const dds = [...w.querySelectorAll("dd")];
			const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
			return {pairs: dts.length,
				oneColumn: dts.length > 1 && Math.abs(dts[1].getBoundingClientRect().left - dds[0].getBoundingClientRect().left) < 2,
				first: getComputedStyle(dts[0]).marginBlockStart,
				later: dts.slice(1).map((d) => parseFloat(getComputedStyle(d).marginBlockStart) / rem)};
		})()`);
		page.check(
			`${label}: a whois's pairs stand apart in one column (${JSON.stringify(got)})`,
			got.pairs >= 2 &&
				got.oneColumn &&
				got.first === "0px" &&
				got.later.every((m) => m === 0.25)
		);
	};
	// A later line's hover time over a link: the link still takes the click.
	const timeLetsThrough = async (label) => {
		await scrollTo("message", LONG_LINK);
		await page.sleep(150);
		const index = await page.evaluate(ROW_WITH(LONG_LINK, "message"));
		await page.hover('#chat .chat .msg[data-type="message"]', index);
		await page.sleep(150);
		const got = await page.evaluate(`(() => {
			const m = ${rowAt("message", index)};
			const t = m.querySelector(".time").getBoundingClientRect();
			const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
			return {shown: getComputedStyle(m.querySelector(".time")).visibility, hit: hit?.closest(".time") ? "time" : hit?.closest("a") ? "link" : hit?.className ?? null};
		})()`);
		page.check(
			`${label}: a later line's hover time shows, and the link under it takes the pointer (${JSON.stringify(
				got
			)})`,
			got.shown === "visible" && got.hit === "link"
		);
		await unhover();
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
		await quoteRing("Workspace");
		page.check(
			`a join's words start at the text column, its icon in the gutter (${join.content.left} vs ${first.content.left}, icon ends ${join.from.right})`,
			near(join.content.left, first.content.left, 1) &&
				join.from.right < join.content.left - 4 &&
				join.from.left > join.row.left &&
				near(join.row.width, join.list.width, 1)
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

		// ---- Workspace's status lines and actions, condensing off
		await page.evaluate(update("statusMessages", "shown"));
		await page.sleep(300);
		await scrollTo("kick", "that was a long lunch");
		await page.sleep(150);
		await page.screenshot("4a-workspace-status-lines");
		const statusOk = async (label, column) => {
			const rows = await page.evaluate(STATUS);
			const kinds = Object.keys(rows);
			page.check(
				`${label}: every kind of status line is drawn (${kinds.join(", ")})`,
				["join", "part", "quit", "kick", "mode", "topic", "nick"].every((k) =>
					kinds.includes(k)
				)
			);
			for (const [type, r] of Object.entries(rows)) {
				page.check(
					`${label}: a ${type}'s words start at the text column, its icon in the gutter, in the words' ink, its time hidden (${JSON.stringify(
						r
					)})`,
					near(r.content, column, 1) &&
						r.icon !== "none" &&
						r.iconEnd <= r.content - 4 &&
						r.iconStart >= r.rowStart &&
						r.iconColor === r.inkColor &&
						r.time === "hidden" &&
						r.size < r.bodySize
				);
			}
			page.check(
				`${label}: a join and a part differ by their icon's shape (${rows.join?.glyph} / ${rows.part?.glyph})`,
				!!rows.join && !!rows.part && rows.join.glyph !== rows.part.glyph
			);
			return rows;
		};
		const status = await statusOk("Workspace", first.content.left);
		page.check(
			`a block of status lines is held close: kick ${status.kick.gapBefore}px, part ${status.part.gapBefore}px after the line before`,
			status.kick.gapBefore <= 3 && status.part.gapBefore <= 3
		);

		const action = await page.evaluate(ACTION("waves at everyone"));
		page.check(
			`an action: italic, in the text colour, no icon, the nick bold in its colour, the words at the text column, its time hidden (${JSON.stringify(
				action
			)})`,
			action.italic &&
				action.icon === "none" &&
				action.color === action.rowColor &&
				action.nickItalic === "normal" &&
				Number(action.nickWeight) >= 700 &&
				action.nickColor === action.nickClassColor &&
				near(action.content, first.content.left, 1) &&
				action.time === "hidden" &&
				action.size === action.bodySize
		);
		const mentionAction = await geometry("action", "hands seer the release notes");
		page.check(
			`an action that mentions us gets the mention band (${mentionAction.background}, ${mentionAction.borderStart})`,
			mentionAction.background !== NONE && /^3px solid$/.test(mentionAction.borderStart)
		);
		const ownAction = await page.evaluate(ACTION("ships it"));
		page.check(
			`our own action, by default: greyed like our own messages (${ownAction.color} vs ${action.color})`,
			ownAction.color !== action.color
		);

		// Hovered, the time comes over the row's end, letting the pointer through.
		for (const [type, text] of [
			["kick", "that was a long lunch"],
			["action", "waves at everyone"],
		]) {
			await scrollTo(type, text);
			await page.sleep(150);
			const index = await page.evaluate(ROW_WITH(text, type));
			await page.hover(`#chat .chat .msg[data-type="${type}"]`, index);
			await page.sleep(150);
			const got = await page.evaluate(`(() => {
				const m = ${rowAt(type, index)};
				const t = m.querySelector(":scope > .time");
				const r = t.getBoundingClientRect(), row = m.getBoundingClientRect();
				const words = m.querySelector(":scope > .content").getBoundingClientRect();
				return {shown: getComputedStyle(t).visibility, end: Math.round(row.right - r.right),
					level: Math.abs(r.top - row.top) < 1, pointer: getComputedStyle(t).pointerEvents,
					fill: getComputedStyle(t).backgroundColor, inRow: r.bottom <= words.bottom + 2};
			})()`);
			page.check(
				`hovered, a ${type}'s time shows over the row's end on the window's colour (${JSON.stringify(
					got
				)})`,
				got.shown === "visible" &&
					got.end === 0 &&
					got.pointer === "none" &&
					got.fill !== NONE &&
					got.inRow
			);
			if (type === "kick") await page.screenshot("4b-workspace-status-hover");
			await unhover();
		}

		// Condensed, the summary is drawn as one status line: icon in the gutter.
		await page.evaluate(update("statusMessages", "condensed"));
		await page.sleep(300);
		const summary = await page.evaluate(`(() => {
			const s = [...document.querySelectorAll("#chat .chat .condensed-summary")].pop();
			s.scrollIntoView({block: "center"});
			const f = s.querySelector(".from").getBoundingClientRect();
			const c = s.querySelector(".content").getBoundingClientRect();
			return {icon: getComputedStyle(s.querySelector(".from"), "::before").content, iconEnd: f.right, content: c.left,
				caret: !!s.querySelector(".toggle-button"), size: parseFloat(getComputedStyle(s).fontSize)};
		})()`);
		page.check(
			`a condensed group's summary: an icon in the gutter, the words at the text column, the caret kept (${JSON.stringify(
				summary
			)})`,
			summary.icon !== "none" &&
				summary.iconEnd <= summary.content - 4 &&
				near(summary.content, first.content.left, 1) &&
				summary.caret &&
				summary.size === status.kick.size
		);
		await page.evaluate(
			`[...document.querySelectorAll("#chat .chat .condensed-summary .content")].pop().click()`
		);
		await page.sleep(200);
		const child = await page.evaluate(`(() => {
			const g = [...document.querySelectorAll('#chat .chat .msg[data-type="condensed"]')].pop();
			const m = g.querySelector(".msg");
			return {content: m.querySelector(":scope > .content").getBoundingClientRect().left,
				icon: m.querySelector(":scope > .from").getBoundingClientRect().right};
		})()`);
		page.check(
			`an opened group's lines: the words at the text column, the icon in the gutter (${JSON.stringify(
				child
			)})`,
			near(child.content, first.content.left, 1) && child.icon <= child.content - 4
		);
		await page.screenshot("4c-workspace-condensed-open");
		await page.evaluate(
			`[...document.querySelectorAll("#chat .chat .condensed-summary .content")].pop().click()`
		);
		await page.evaluate(update("statusMessages", "shown"));
		await page.sleep(200);

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
		const bandedAction = await geometry("action", "ships it");
		const bandedActionInk = await page.evaluate(ACTION("ships it"));
		page.check(
			`Your own messages: highlighted row bands our own action, its words in the text colour (${bandedAction.background})`,
			bandedAction.background !== NONE && bandedActionInk.color === bandedActionInk.rowColor
		);
		await scrollTo("message", "on it, capturing");
		await page.screenshot("5-workspace-own-band");
		await page.evaluate(update("ownMessages", "muted"));

		const contrast = async (on) => {
			await page.send("Emulation.setEmulatedMedia", {
				features: on ? [{name: "prefers-contrast", value: "more"}] : [],
			});
			await page.waitFor(`(document.documentElement.dataset.contrast === "more") === ${on}`, {
				label: `Increase Contrast ${on ? "on" : "off"}`,
			});
			await page.sleep(100);
		};
		await contrast(true);
		await contrastLifts("Workspace");
		await contrast(false);

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
		await quoteRing("Workspace, forced colours");
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
		const rtlStatus = await page.evaluate(STATUS);
		page.check(
			`right to left: a status line's icon in the gutter at the right, its words before it (${JSON.stringify(
				rtlStatus.kick
			)})`,
			Object.values(rtlStatus).every((r) => r.iconStart >= r.contentEnd + 4) &&
				// The words' right edges line up: each starts at the text column.
				(await page.evaluate(`(() => {
					const ends = [...document.querySelectorAll('#chat .chat .messages > .msg:not([data-type="condensed"]) > .content')].map((c) => c.getBoundingClientRect().right);
					return Math.max(...ends) - Math.min(...ends) <= 1;
				})()`))
		);
		await scrollTo("kick", "that was a long lunch");
		await page.screenshot("7a-workspace-rtl-status");
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
		await toolbarFits("yep", "Messenger query, a short line of theirs");
		await toolbarFits("sending you a screenshot", "Messenger query, our own at the far side");
		await open(CHANNEL, "looks good from here");
		const mFirst = await geometry("message", "morning all");
		page.check(
			"Messenger channel: unchanged, the avatar and the nick over the run",
			mFirst.from.display !== "none" &&
				mFirst.avatar.display !== "none" &&
				mFirst.avatarRadius === "50%" &&
				mFirst.background !== NONE
		);
		await toolbarFits("yep", "Messenger channel, a short line");
		const back = await toolbarFits("morning all", "Messenger channel, scrolled back");
		page.check(
			"Messenger channel, scrolled back: the jump-to-recent arrow is up",
			!!back?.arrow
		);
		await quoteRing("Messenger");
		await contrast(true);
		await contrastLifts("Messenger");
		await contrast(false);

		// Forced colours: a mention's bar in the system's highlight.
		await page.send("Emulation.setEmulatedMedia", {
			features: [{name: "forced-colors", value: "active"}],
		});
		await page.sleep(200);
		const mentionBar = await page.evaluate(`(() => {
			const paint = ${PAINT};
			const m = ${rowAt(
				"message",
				await page.evaluate(ROW_WITH("can you look at the theme gallery", "message"))
			)};
			const probe = document.createElement("span");
			probe.style.borderInlineStart = "3px solid highlight";
			document.body.append(probe);
			const want = paint(getComputedStyle(probe).borderInlineStartColor);
			probe.remove();
			const s = getComputedStyle(m);
			return {bar: paint(s.borderInlineStartColor), want, width: s.borderInlineStartWidth};
		})()`);
		page.check(
			`Messenger, forced colours: a mention's bar is the system's highlight (${JSON.stringify(
				mentionBar
			)})`,
			mentionBar.bar === mentionBar.want && parseFloat(mentionBar.width) > 0
		);
		await quoteRing("Messenger, forced colours");
		await page.send("Emulation.setEmulatedMedia", {features: []});

		await page.evaluate(`document.documentElement.dir = "rtl"`);
		await page.sleep(200);
		await toolbarFits("yep", "Messenger channel, right to left");
		await open(PEER, "sending you a screenshot");
		await toolbarFits("yep", "Messenger query, right to left, theirs");
		await toolbarFits("sending you a screenshot", "Messenger query, right to left, ours");
		await page.evaluate(`document.documentElement.dir = "ltr"`);
		await open(CHANNEL, "looks good from here");

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
		await statusOk("phone Workspace", phone.content.left);
		await scrollTo("part", "second pair of eyes");
		await page.screenshot("10a-phone-workspace-status");
		await page.evaluate(update("fontSize", "huge"));
		await page.sleep(400);
		page.check("phone at the largest text step: no sideways scroll", await noSideScroll());
		await page.screenshot("11-phone-workspace-huge");
		await statusOk(
			"phone Workspace at the largest text step",
			(
				await geometry("message", "morning all")
			).content.left
		);
		await scrollTo("part", "second pair of eyes");
		await page.screenshot("11a-phone-workspace-huge-status");
		await timeLetsThrough("phone Workspace at the largest text step");
		await page.evaluate(update("fontSize", "medium"));
		await page.sleep(300);
		await whoisSpaced("phone Workspace");
		await page.evaluate(update("messageLayout", "bubbles"));
		await page.sleep(300);
		await whoisSpaced("phone Messenger");
		await toolbarFits("yep", "phone Messenger channel, a short line");
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
		await toolbarFits("yep", "phone Messenger query, a short line of theirs");
		await toolbarFits("sending you a screenshot", "phone Messenger query, our own");
	} finally {
		await ircd.close();
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
