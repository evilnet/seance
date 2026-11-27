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
// nick on either side, our own at the far side in the own fill), its
// actions as lines of the conversation (no icon, the nick in its colour,
// the time on hover, our own at the far side of a private conversation) and
// its reactions hanging off the bubble's bottom edge (a third of a chip on
// it, clear of the next row, the add chip by hover, focus or finger). Then the same at a 390 px phone, at the largest text
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

/** Reactions (`+draft/react`) from `nick` on the line `msgid`, one TAGMSG each. */
const react = (msgid, target, reactions) =>
	reactions.map(
		([nick, text], i) =>
			`@time=${at("12:29")};msgid=${msgid}r${i};+draft/react=${text.replace(
				/ /g,
				"\\s"
			)};+draft/reply=${msgid} ${from(nick)} TAGMSG ${target}`
	);

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
	// Messenger's reactions and actions: a short bubble with three chips (one
	// of them ours), a joined run with a reaction on a middle line and on its
	// last, a row of chips that wraps at a phone's width, and an action
	// between two bubbles.
	`@time=${at("12:24")};msgid=x20 ${from("frank")} PRIVMSG ${CHANNEL} :shipped!`,
	...react("x20", CHANNEL, [
		["bob", "👍"],
		["carol", "👍"],
		["alice", "🎉"],
		[NICK, "👀"],
	]),
	`@time=${at("12:25")};msgid=x21 ${from("erin")} PRIVMSG ${CHANNEL} :a run of three, the first`,
	`@time=${at("12:25")};msgid=x22 ${from("erin")} PRIVMSG ${CHANNEL} :the middle one, reacted to`,
	`@time=${at("12:25")};msgid=x23 ${from(
		"erin"
	)} PRIVMSG ${CHANNEL} :and the last, reacted to too`,
	...react("x22", CHANNEL, [["alice", "❤️"]]),
	...react("x23", CHANNEL, [
		["bob", "😂"],
		["carol", "😂"],
	]),
	`@time=${at("12:26")};msgid=x24 ${from("alice")} PRIVMSG ${CHANNEL} :vote on the release name`,
	...react("x24", CHANNEL, [
		["bob", "👍"],
		["carol", "🎉"],
		["dave", "🚀"],
		["erin", "❤️"],
		["frank", "😂"],
		["bob", "👀"],
		["carol", "🙏"],
		["dave", "ship it"],
		["erin", "🔥"],
		["frank", "✅"],
	]),
	`@time=${at("12:27")};msgid=x25 ${from("bob")} PRIVMSG ${CHANNEL} :before the action`,
	`@time=${at("12:27")};msgid=x26 ${from("dave")} PRIVMSG ${CHANNEL} :\x01ACTION nods along\x01`,
	`@time=${at("12:27")};msgid=x27 ${from("bob")} PRIVMSG ${CHANNEL} :after the action`,
	// In the query: our own bubble with a reaction (at the far side), our own
	// action and theirs.
	`@time=${at("12:28")};msgid=x30 ${from(NICK)} PRIVMSG ${PEER} :here it is, the phone at 390`,
	...react("x30", NICK, [[PEER, "❤️"]]),
	`@time=${at("12:28")};msgid=x31 ${from(
		NICK
	)} PRIVMSG ${PEER} :\x01ACTION sends the screenshot\x01`,
	`@time=${at("12:29")};msgid=x32 ${from(PEER)} PRIVMSG ${NICK} :\x01ACTION squints at it\x01`,
	`@time=${at("12:29")};msgid=x33 ${from(PEER)} PRIVMSG ${NICK} :can you send it again?`,
	...react("x33", PEER, [[NICK, "👍"]]),
	// Two of our own in a row: the second's time comes on hover, before it.
	`@time=${at("12:30")};msgid=x34 ${from(NICK)} PRIVMSG ${PEER} :one moment`,
	`@time=${at("12:30")};msgid=x35 ${from(NICK)} PRIVMSG ${PEER} :sent, it is in your downloads`,
	// A notice whose label is long and whose clock is the longest there is
	// (12-hour with seconds, before midnight).
	`@time=${DAY}T23:59:59.000Z;msgid=x09 ${from(
		"LongerNickname"
	)} NOTICE ${CHANNEL} :maintenance begins later today`,
	// More reactions on a line of ours in the query than a phone's line
	// holds, and a line of theirs after it.
	`@time=${at("12:31")};msgid=x36 ${from(PEER)} PRIVMSG ${NICK} :so many reactions`,
	`@time=${at("12:31")};msgid=x37 ${from(NICK)} PRIVMSG ${PEER} :react to this`,
	...react(
		"x37",
		NICK,
		["one", "two", "three", "four", "five", "six", "seven", "eight"].map((word) => [PEER, word])
	),
	`@time=${at("12:32")};msgid=x38 ${from(PEER)} PRIVMSG ${NICK} :done reacting`,
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
		avatar: (() => { const a = row.querySelector(":scope > .from .avatar"); if (!a || getComputedStyle(a).display === "none") return "none"; const r = a.getBoundingClientRect(), l = row.closest(".chat").getBoundingClientRect(); return r.left >= l.left && r.right <= l.right ? "shown" : "clipped"; })(),
		size: parseFloat(getComputedStyle(row).fontSize),
		bodySize: parseFloat(getComputedStyle(document.querySelector('#chat .chat .msg[data-type="message"]')).fontSize)};
})()`;

/** What of the chips, the actions and the shown headers reaches past the pane's sides. */
const PAST_PANE = `(() => {
	const c = document.querySelector("#chat .chat");
	const r = c.getBoundingClientRect();
	const right = r.left + c.clientWidth;
	const shown = (e) => getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility === "visible";
	// A header's box can be squeezed narrower than its text, which then
	// runs out of it: measured by its text as well as by its box.
	const ends = (e) => {
		const b = e.getBoundingClientRect();
		if (!e.matches(".msg > :is(.from, .time)")) return [b.left, b.right];
		const range = document.createRange();
		range.selectNodeContents(e);
		const t = range.getBoundingClientRect();
		return [Math.min(b.left, t.left), Math.max(b.right, t.right)];
	};
	return [...c.querySelectorAll('.msg-reactions, .msg-reaction, .msg[data-type="action"], .msg[data-type="action"] > *, .msg:is([data-type="message"], [data-type="notice"]) > :is(.from, .time)')]
		.filter(shown)
		.filter((e) => { const [left, end] = ends(e); return end > right + 0.5 || left < r.left - 0.5; })
		.map((e) => e.className + " " + e.textContent.trim().slice(0, 24));
})()`;

/** A Messenger bubble's reaction chips against the bubble and the row after it, by its words. */
const CHIPS = (text) => `(() => {
	const row = [...document.querySelectorAll('#chat .chat .msg[data-type="message"]')].find((m) => m.textContent.includes(${JSON.stringify(
		text
	)}));
	if (!row) return null;
	const b = row.getBoundingClientRect();
	const c = row.querySelector(":scope > .content").getBoundingClientRect();
	const r = row.querySelector(".msg-reactions").getBoundingClientRect();
	const chips = [...row.querySelectorAll(".msg-reaction:not(.msg-reaction-add)")].map((e) => e.getBoundingClientRect());
	const add = row.querySelector(".msg-reaction-add");
	const next = row.nextElementSibling?.matches(".msg") ? row.nextElementSibling : null;
	const nextBox = next?.getBoundingClientRect();
	const list = row.closest(".messages").getBoundingClientRect();
	const s = getComputedStyle(row.querySelector(".msg-reaction"));
	const tops = [...new Set(chips.map((x) => Math.round(x.top)))];
	const time = row.querySelector(":scope > .time");
	const ts = getComputedStyle(time);
	return {
		timeBottom: ts.visibility === "visible" && ts.position === "static" ? time.getBoundingClientRect().bottom : null,
		count: chips.length,
		lines: tops.length,
		bubble: {left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width},
		contentBottom: c.bottom,
		rowBottom: r.bottom,
		chipH: chips[0].height,
		firstTop: Math.min(...chips.map((x) => x.top)),
		lastBottom: Math.max(...chips.map((x) => x.bottom)),
		minLeft: Math.min(...chips.map((x) => x.left)),
		maxRight: Math.max(...chips.map((x) => x.right)),
		first: {left: chips[0].left, right: chips[0].right},
		next: nextBox ? {top: nextBox.top, type: next.dataset.type, joined: next.classList.contains("previous-source")} : null,
		list: {left: list.left, right: list.right},
		ring: s.boxShadow,
		fill: s.backgroundColor,
		border: s.borderTopColor + " " + s.borderTopWidth + " " + s.borderTopStyle,
		add: add ? {opacity: getComputedStyle(add).opacity} : null,
	};
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

	const geometry = async (type, text) => {
		const index = await page.evaluate(ROW_WITH(text, type));
		return index < 0
			? null
			: page.evaluate(GEOMETRY(`#chat .chat .msg[data-type="${type}"]`, index));
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
	// Messenger, with a mouse: a run's later line, hovered, keeps its time
	// hidden (a swipe shows it, as by finger: style.css § By finger and
	// trackpad), where it would stand beside the bubble (before it for our
	// own at the far side), inside the pane.
	const timeBeside = async (label, shot, own = false) => {
		const pick = `[...document.querySelectorAll('#chat .chat .msg.previous-source[data-type="message"]${
			own ? ".self" : ":not(.self)"
		}')].find((m) => getComputedStyle(m.querySelector(".time")).position === "absolute")`;
		await page.evaluate(`${pick}.scrollIntoView({block: "center"})`);
		await page.sleep(150);
		const at = await page.evaluate(
			`(() => { const r = ${pick}.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`
		);
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: at.x, y: at.y});
		await page.sleep(150);
		const got = await page.evaluate(`(() => {
			const m = ${pick};
			const box = (e) => { const r = e.getBoundingClientRect(); return {left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom)}; };
			const t = m.querySelector(".time");
			return {shown: getComputedStyle(t).visibility, time: box(t), bubble: box(m), list: box(document.querySelector("#chat .chat"))};
		})()`);
		page.check(
			`${label}: a later line's time stays hidden on hover, placed level with its bubble, inside the pane (${JSON.stringify(
				got
			)})`,
			got.shown === "hidden" &&
				got.time.left >= got.list.left &&
				got.time.right <= got.list.right &&
				got.time.top >= got.bubble.top - 2 &&
				got.time.bottom <= got.bubble.bottom + 2
		);
		await page.screenshot(shot);
		await unhover();
	};
	// A later line's hover time takes the pointer, so its tooltip (the full
	// date) opens under a mouse resting on it; over a link, the link keeps
	// the rest of its length.
	// Workspace shows a later line's time on hover; Messenger on hover shows
	// none (§ Session times), only to a keyboard's focus on the row (`focus`:
	// its first link or button takes it).
	const timeTakesPointer = async (text, label, focus = false) => {
		await scrollTo("message", text);
		await page.sleep(150);
		const index = await page.evaluate(ROW_WITH(text, "message"));
		if (focus) {
			// A real key first (Shift does nothing here): Chrome then counts the
			// script's focus as a keyboard's, which is what shows a time.
			await page.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Shift",
				code: "ShiftLeft",
				windowsVirtualKeyCode: 16,
			});
			await page.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "Shift",
				code: "ShiftLeft",
				windowsVirtualKeyCode: 16,
			});
			await page.evaluate(
				`${rowAt(
					"message",
					index
				)}.querySelector(".content :is(a, button)").focus({focusVisible: true})`
			);
		} else {
			await page.hover('#chat .chat .msg[data-type="message"]', index);
		}
		await page.sleep(150);
		const at = await page.evaluate(`(() => {
			const t = ${rowAt("message", index)}.querySelector(".time").getBoundingClientRect();
			return {x: t.left + t.width / 2, y: t.top + t.height / 2};
		})()`);
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", ...at});
		await page.sleep(200);
		const got = await page.evaluate(`(() => {
			const m = ${rowAt("message", index)};
			const t = m.querySelector(".time");
			const a = m.querySelector(".content a");
			const r = a?.getBoundingClientRect();
			const hit = document.elementFromPoint(${at.x}, ${at.y});
			return {shown: getComputedStyle(t).visibility, hit: hit?.closest(".time") ? "time" : hit?.className ?? null,
				hover: t.matches(":hover"), tip: getComputedStyle(t, "::after").display,
				link: !a || document.elementFromPoint(r.left + 4, r.top + r.height / 2)?.closest("a") === a};
		})()`);
		page.check(
			`${label}: a later line's ${
				focus ? "time, shown to a keyboard's focus," : "hover time"
			} takes the pointer and opens its date, a link under it keeps the rest (${JSON.stringify(
				got
			)})`,
			got.shown === "visible" &&
				got.hit === "time" &&
				got.hover &&
				got.tip !== "none" &&
				got.link
		);
		if (focus) {
			await page.evaluate(`document.activeElement?.blur()`);
		}
		await unhover();
	};
	// Messenger: a bubble's chips hang off its bottom edge, a third of a chip on
	// it, inset from the corner on its side, clear of the row after it.
	const chipsHang = async (text, label, side = "start") => {
		await scrollTo("message", text);
		await page.sleep(150);
		const g = await page.evaluate(CHIPS(text));
		const rtl = await page.evaluate(`document.documentElement.dir === "rtl"`);
		const fromLeft = (side === "start") !== rtl;
		const inset = fromLeft ? g.minLeft - g.bubble.left : g.bubble.right - g.maxRight;
		const onBubble = (g.bubble.bottom - (g.lastBottom - g.chipH)) / g.chipH;
		page.check(
			`${label}: the chips hang off the bubble's ${
				fromLeft ? "left" : "right"
			} corner, a third on it, clear of the next row (inset ${inset.toFixed(
				1
			)}px, ${onBubble.toFixed(2)} of a chip on it, ${JSON.stringify({
				lines: g.lines,
				next: g.next,
				lastBottom: g.lastBottom,
				timeBottom: g.timeBottom,
				ring: g.ring,
			})})`,
			inset >= 2 &&
				inset <= g.chipH &&
				onBubble >= 0.2 &&
				onBubble <= 0.5 &&
				g.rowBottom > g.contentBottom &&
				g.lastBottom > g.bubble.bottom + g.chipH / 2 &&
				g.ring !== "none" &&
				(!g.next || g.next.top >= g.lastBottom + 2) &&
				(!g.timeBottom || g.firstTop >= g.timeBottom - 1) &&
				g.minLeft >= g.list.left &&
				g.maxRight <= g.list.right
		);
		return g;
	};
	// Messenger's action, hovered: its time (hidden, as every row's is until
	// a swipe) just past its words, the toolbar up and inside the pane.
	const actionHover = async (text, label) => {
		await scrollTo("action", text);
		await page.sleep(150);
		const index = await page.evaluate(ROW_WITH(text, "action"));
		await page.hover('#chat .chat .msg[data-type="action"]', index);
		await page.sleep(150);
		const got = await page.evaluate(`(() => {
			const m = ${rowAt("action", index)};
			const t = m.querySelector(":scope > .time").getBoundingClientRect();
			const w = m.querySelector(":scope > .content").getBoundingClientRect();
			const c = document.querySelector("#chat .chat");
			const left = c.getBoundingClientRect().left + c.clientLeft;
			const right = left + c.clientWidth;
			const a = m.querySelector(".msg-actions");
			const b = a && getComputedStyle(a).display !== "none" ? a.getBoundingClientRect() : null;
			return {shown: getComputedStyle(m.querySelector(":scope > .time")).visibility,
				after: Math.round(t.left - w.right), before: Math.round(w.left - t.right),
				inside: t.left >= left && t.right <= right,
				toolbar: b && b.left >= left && b.right <= right};
		})()`);
		await unhover();
		return got;
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
			`an action: italic, in the text colour, no icon and no avatar, the nick bold in its colour, the words at the text column, its time hidden (${JSON.stringify(
				action
			)})`,
			action.italic &&
				action.avatar === "none" &&
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
		// No row shows a time of its own: Messenger stamps each stretch of
		// the conversation once, centred (§ Session times), and a swipe shows
		// every row's.
		page.check(
			"Messenger query: a run's first line keeps its time's place at the bubble's end, hidden, as a later line's is",
			peer1.time.visibility === "hidden" &&
				peer1.time.left >= peer1.content.right - 1 &&
				peer2.time.visibility === "hidden"
		);
		{
			const index = await page.evaluate(ROW_WITH("hey, got a minute", "message"));
			await page.hover('#chat .chat .msg[data-type="message"]', index);
			await page.sleep(150);
			page.check(
				"Messenger query: hovered, a run's first line still keeps its time hidden",
				(await geometry("message", "hey, got a minute")).time.visibility === "hidden"
			);
			await unhover();
			await page.sleep(100);
		}
		await page.screenshot("9-messenger-query");
		await timeBeside("Messenger query, theirs", "9g-messenger-query-time");
		await toolbarFits("yep", "Messenger query, a short line of theirs");
		await toolbarFits("sending you a screenshot", "Messenger query, our own at the far side");
		await chipsHang("here it is, the phone at 390", "Messenger query, our own", "end");
		await chipsHang("can you send it again?", "Messenger query, theirs");
		const qActions = await page.evaluate(`(() => {
			const list = document.querySelector("#chat .chat .messages").getBoundingClientRect();
			const at = (t) => [...document.querySelectorAll('#chat .chat .msg[data-type="action"]')].find((m) => m.textContent.includes(t)).getBoundingClientRect();
			const ours = at("sends the screenshot"), theirs = at("squints at it");
			return {oursEnd: Math.round(list.right - ours.right), theirsStart: Math.round(theirs.left - list.left), oursLeft: ours.left, middle: list.left + list.width / 2};
		})()`);
		page.check(
			`Messenger query: our own action at the far side, theirs at the start (${JSON.stringify(
				qActions
			)})`,
			qActions.oursEnd < 16 &&
				qActions.theirsStart < 24 &&
				qActions.oursLeft > qActions.middle
		);
		const qOwnAction = await page.evaluate(ACTION("sends the screenshot"));
		const qTheirAction = await page.evaluate(ACTION("squints at it"));
		page.check(
			`Messenger query: our own action, no icon, italic, the nick in its colour, and no avatar on either side (${JSON.stringify(
				{...qOwnAction, theirAvatar: qTheirAction.avatar}
			)})`,
			qOwnAction.avatar === "none" &&
				qTheirAction.avatar === "none" &&
				qOwnAction.icon === "none" &&
				qOwnAction.italic &&
				qOwnAction.nickColor === qOwnAction.nickClassColor
		);
		const qOwnHover = await actionHover(
			"sends the screenshot",
			"Messenger query, our own action"
		);
		page.check(
			`Messenger query, our own action hovered: its time hidden, placed before its words, the toolbar inside the pane (${JSON.stringify(
				qOwnHover
			)})`,
			qOwnHover.shown === "hidden" &&
				qOwnHover.before >= 0 &&
				qOwnHover.inside &&
				qOwnHover.toolbar
		);
		await scrollTo("action", "sends the screenshot");
		await page.screenshot("9a-messenger-query-reactions-actions");
		await timeBeside("Messenger query, our own", "9h-messenger-query-own-time", true);
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

		// Messenger's action: a line in the bubbles' text column, a run's
		// space above and below, read as Workspace reads it.
		const mAction = await page.evaluate(ACTION("nods along"));
		page.check(
			`Messenger: an action, italic, in the text colour, no icon, its avatar in the gutter, the nick bold in its colour, at the bubbles' text column, its time hidden (${JSON.stringify(
				mAction
			)})`,
			mAction.italic &&
				mAction.avatar === "shown" &&
				mAction.icon === "none" &&
				mAction.color === mAction.rowColor &&
				mAction.nickItalic === "normal" &&
				Number(mAction.nickWeight) >= 700 &&
				mAction.nickColor === mAction.nickClassColor &&
				near(mAction.content, mFirst.content.left, 1) &&
				mAction.time === "hidden" &&
				mAction.size === mAction.bodySize
		);
		const mActionGap = await page.evaluate(`(() => {
			const m = [...document.querySelectorAll('#chat .chat .msg[data-type="action"]')].find((x) => x.textContent.includes("nods along"));
			const r = m.getBoundingClientRect();
			return {above: Math.round(r.top - m.previousElementSibling.getBoundingClientRect().bottom),
				below: Math.round(m.nextElementSibling.getBoundingClientRect().top - r.bottom),
				fill: getComputedStyle(m).backgroundColor};
		})()`);
		page.check(
			`Messenger: an action between two bubbles has room above and below, and no fill (${JSON.stringify(
				mActionGap
			)})`,
			mActionGap.above >= 6 && mActionGap.below >= 6 && mActionGap.fill === NONE
		);
		const mHover = await actionHover("nods along", "Messenger");
		page.check(
			`Messenger, an action hovered: its time hidden, placed just past its words, inside the pane, the toolbar up inside it (${JSON.stringify(
				mHover
			)})`,
			mHover.shown === "hidden" &&
				mHover.after >= 0 &&
				mHover.after <= 20 &&
				mHover.inside &&
				mHover.toolbar
		);
		const mMention = await geometry("action", "hands seer the release notes");
		page.check(
			`Messenger: an action that mentions us is still marked (${mMention.background}, ${mMention.borderStart})`,
			mMention.background !== NONE && /solid$/.test(mMention.borderStart)
		);

		// Messenger's reactions: outside the bubble, on its edge.
		const three = await chipsHang("shipped!", "Messenger, a short bubble with three chips");
		page.check(
			`Messenger: three chips, and the short bubble does not widen to them (${
				three.count
			} chips, bubble ${three.bubble.width}px, chips to ${
				three.maxRight - three.bubble.left
			}px)`,
			three.count === 3 && three.maxRight > three.bubble.right
		);
		const middle = await chipsHang(
			"the middle one, reacted to",
			"Messenger, a run's middle line"
		);
		page.check(
			"Messenger: the line after a reacted middle line is still the run's",
			!!middle.next?.joined
		);
		await chipsHang("and the last, reacted to too", "Messenger, a run's last line");
		await chipsHang("vote on the release name", "Messenger, ten chips");
		await scrollTo("message", "the middle one, reacted to");
		await page.screenshot("9b-messenger-reactions");

		// The add chip: quiet until the message is hovered, focused or open,
		// and always there after a finger.
		page.check(
			`Messenger: the add chip is hidden while nothing points at the message (${JSON.stringify(
				three.add
			)})`,
			three.add?.opacity === "0"
		);
		await scrollTo("message", "shipped!");
		await page.hover(
			'#chat .chat .msg[data-type="message"]',
			await page.evaluate(ROW_WITH("shipped!", "message"))
		);
		await page.sleep(200);
		page.check(
			"Messenger: hovering the message brings the add chip",
			(await page.evaluate(CHIPS("shipped!"))).add?.opacity === "1"
		);
		await page.screenshot("9c-messenger-reactions-hover");
		await unhover();
		await page.sleep(200);
		await page.evaluate(
			`[...document.querySelectorAll('#chat .chat .msg[data-type="message"]')].find((x) => x.textContent.includes("shipped!")).querySelector(".msg-reaction-add").focus({focusVisible: true})`
		);
		await page.sleep(250);
		const focused = await page.evaluate(`(() => {
			const a = document.activeElement;
			const out = {add: a.matches(".msg-reaction-add"), tab: a.tabIndex, disabled: a.disabled, opacity: getComputedStyle(a).opacity};
			a.blur();
			return out;
		})()`);
		page.check(
			`Messenger: the add chip is in the tab order and shows on a keyboard's focus (${JSON.stringify(
				focused
			)})`,
			focused.add && focused.tab >= 0 && !focused.disabled && focused.opacity === "1"
		);
		await page.evaluate(`document.documentElement.dataset.input = "touch"`);
		await page.sleep(250);
		page.check(
			"Messenger, after a finger: the add chip is always there",
			(await page.evaluate(CHIPS("shipped!"))).add?.opacity === "1"
		);
		await page.evaluate(`document.documentElement.dataset.input = "pointer"`);

		const CHIP_INK = `(() => {
			const paint = ${PAINT};
			const m = [...document.querySelectorAll('#chat .chat .msg[data-type="message"]')].find((x) => x.textContent.includes("shipped!"));
			const chip = m.querySelector(".msg-reaction:not(.self, .msg-reaction-add)");
			return {border: paint(getComputedStyle(chip).borderTopColor), text: paint(getComputedStyle(m).getPropertyValue("--body-color").trim())};
		})()`;
		const chipInk = await page.evaluate(CHIP_INK);
		await contrast(true);
		await contrastLifts("Messenger");
		const chipInkMore = await page.evaluate(CHIP_INK);
		page.check(
			`Messenger, Increase Contrast: a chip's edge in the text colour (${JSON.stringify({
				chipInk,
				chipInkMore,
			})})`,
			chipInk.border !== chipInk.text && chipInkMore.border === chipInkMore.text
		);
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
		const forcedChip = await page.evaluate(CHIPS("shipped!"));
		page.check(
			`Messenger, forced colours: each chip has a visible edge (${forcedChip.border})`,
			!forcedChip.border.startsWith("rgba(0, 0, 0, 0)") && /solid$/.test(forcedChip.border)
		);
		await scrollTo("message", "shipped!");
		await page.screenshot("9d-messenger-reactions-forced-colors");
		await page.send("Emulation.setEmulatedMedia", {features: []});

		await page.evaluate(`document.documentElement.dir = "rtl"`);
		await page.sleep(200);
		await toolbarFits("yep", "Messenger channel, right to left");
		await chipsHang("shipped!", "Messenger, right to left");
		await chipsHang("vote on the release name", "Messenger, right to left, ten chips");
		page.check("Messenger, right to left: no sideways scroll", await noSideScroll());
		await scrollTo("message", "the middle one, reacted to");
		await page.screenshot("9e-messenger-rtl-reactions");
		await open(PEER, "sending you a screenshot");
		await toolbarFits("yep", "Messenger query, right to left, theirs");
		await toolbarFits("sending you a screenshot", "Messenger query, right to left, ours");
		await chipsHang(
			"here it is, the phone at 390",
			"Messenger query, right to left, our own",
			"end"
		);
		await chipsHang("can you send it again?", "Messenger query, right to left, theirs");
		const rtlOwnAction = await actionHover(
			"sends the screenshot",
			"Messenger query, right to left"
		);
		page.check(
			`Messenger query, right to left, our own action hovered: its time hidden, placed inside the pane (${JSON.stringify(
				rtlOwnAction
			)})`,
			rtlOwnAction.shown === "hidden" && rtlOwnAction.inside && rtlOwnAction.toolbar
		);
		await page.screenshot("9f-messenger-rtl-query");
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
		await timeTakesPointer(LONG_LINK, "phone Workspace at the largest text step");
		await page.evaluate(update("fontSize", "medium"));
		await page.sleep(300);
		await whoisSpaced("phone Workspace");
		await page.evaluate(update("messageLayout", "bubbles"));
		await page.sleep(300);
		await whoisSpaced("phone Messenger");
		await toolbarFits("yep", "phone Messenger channel, a short line");
		const phoneWrap = await chipsHang("vote on the release name", "phone Messenger, ten chips");
		page.check(
			`phone Messenger: ten chips wrap (${phoneWrap.lines} lines) and stay clear of the next row`,
			phoneWrap.lines >= 2
		);
		await chipsHang("the middle one, reacted to", "phone Messenger, a run's middle line");
		page.check("phone Messenger channel: no sideways scroll", await noSideScroll());
		await scrollTo("message", "vote on the release name");
		await page.screenshot("12a-phone-messenger-reactions");
		await timeBeside("phone Messenger channel", "12d-phone-messenger-time");
		await timeTakesPointer(
			"the middle one, reacted to",
			"phone Messenger channel, a short later line",
			true
		);
		// A run's first line's time takes no room either (no bubble gives up
		// width for one, whatever the input): out of the flow, hidden, and
		// shown to a keyboard's focus beside the bubble, inside the pane.
		// A real key first (Shift does nothing here): Chrome then counts the
		// script's focus as a keyboard's, which is what shows a time.
		await page.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Shift",
			code: "ShiftLeft",
			windowsVirtualKeyCode: 16,
		});
		await page.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Shift",
			code: "ShiftLeft",
			windowsVirtualKeyCode: 16,
		});
		const firstTime = await page.evaluate(`(() => {
			const m = [...document.querySelectorAll('#chat .chat .msg[data-type="message"]:not(.previous-source)')].find((x) => x.querySelector(".content :is(a, button)"));
			const t = m.querySelector(".time");
			const rest = {position: getComputedStyle(t).position, shown: getComputedStyle(t).visibility};
			m.querySelector(".content :is(a, button)").focus({focusVisible: true});
			const r = t.getBoundingClientRect();
			const c = document.querySelector("#chat .chat");
			const left = c.getBoundingClientRect().left + c.clientLeft;
			const got = {...rest, focused: getComputedStyle(t).visibility, left: Math.round(r.left), right: Math.round(r.right), pane: [Math.round(left), Math.round(left + c.clientWidth)]};
			document.activeElement.blur();
			return got;
		})()`);
		page.check(
			`phone Messenger: a run's first line's time takes no room, hidden until a keyboard's focus shows it inside the pane (${JSON.stringify(
				firstTime
			)})`,
			firstTime.position === "absolute" &&
				firstTime.shown === "hidden" &&
				firstTime.focused === "visible" &&
				firstTime.left >= firstTime.pane[0] &&
				firstTime.right <= firstTime.pane[1]
		);
		const phoneHover = await actionHover("nods along", "phone Messenger");
		page.check(
			`phone Messenger, an action hovered: its time hidden, placed inside the pane, the toolbar inside it (${JSON.stringify(
				phoneHover
			)})`,
			phoneHover.shown === "hidden" && phoneHover.inside && phoneHover.toolbar
		);
		await page.evaluate(update("fontSize", "huge"));
		await page.sleep(400);
		await chipsHang("vote on the release name", "phone Messenger at the largest text step");
		// What reaches past the pane: the chips, the actions and a first
		// line's header (a nick or a notice's label, and the time beside it)
		// add nothing sideways.
		const pastPane = await page.evaluate(PAST_PANE);
		page.check(
			`phone Messenger at the largest text step: no chip, row of chips, action or header reaches past the pane (${JSON.stringify(
				pastPane
			)})`,
			pastPane.length === 0
		);
		await scrollTo("message", "vote on the release name");
		await page.screenshot("12b-phone-messenger-huge-reactions");
		await page.evaluate(update("fontSize", "medium"));
		await page.sleep(300);
		await open(PEER, "sending you a screenshot");
		page.check("phone Messenger query: no sideways scroll", await noSideScroll());
		await page.screenshot("12-phone-messenger-query");
		await timeBeside(
			"phone Messenger query, our own",
			"12e-phone-messenger-query-own-time",
			true
		);
		await toolbarFits("yep", "phone Messenger query, a short line of theirs");
		await toolbarFits("sending you a screenshot", "phone Messenger query, our own");
		await chipsHang("here it is, the phone at 390", "phone Messenger query, our own", "end");
		await scrollTo("action", "sends the screenshot");
		await page.screenshot("12c-phone-messenger-query-reactions");

		// At the largest text step: more chips than the line holds stay on
		// one line that scrolls along, clear of the next row, each in reach.
		await page.evaluate(update("fontSize", "huge"));
		await page.sleep(300);
		await scrollTo("message", "react to this");
		await page.sleep(150);
		const manyChips = await page.evaluate(`(() => {
			const rows = [...document.querySelectorAll('#chat .chat .msg[data-type="message"]')];
			const row = rows.find((m) => m.textContent.includes("react to this"));
			const next = rows.find((m) => m.textContent.includes("done reacting"));
			const line = row.querySelector(".msg-reactions");
			const chips = [...line.querySelectorAll(".msg-reaction:not(.msg-reaction-add)")];
			const reach = (c) => { const b = c.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest(".msg-reaction") === c; };
			const l = line.getBoundingClientRect();
			const seen = chips.filter((c) => { const b = c.getBoundingClientRect(); return b.left >= l.left && b.right <= l.right; });
			const tops = new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top)));
			const lastBottom = Math.max(...chips.map((c) => c.getBoundingClientRect().bottom));
			const before = {n: chips.length, lines: tops.size, scrolls: line.scrollWidth > line.clientWidth,
				clear: next.getBoundingClientRect().top >= lastBottom, seen: seen.length, reach: seen.every(reach)};
			line.scrollLeft = line.scrollWidth;
			const last = chips.at(-1);
			return {...before, lastReach: reach(last)};
		})()`);
		page.check(
			`phone Messenger query at the largest text step: eight chips stay on one line that scrolls, clear of the next row, the ones in view and the last, scrolled to, in reach (${JSON.stringify(
				manyChips
			)})`,
			manyChips.n === 8 &&
				manyChips.lines === 1 &&
				manyChips.scrolls &&
				manyChips.clear &&
				manyChips.seen > 0 &&
				manyChips.reach &&
				manyChips.lastReach
		);
		await page.screenshot("12h-phone-messenger-query-many-chips");

		// The long press's toolbar on an older line of ours, the jump-to-recent
		// arrow up: inside the pane, left to right and right to left.
		const pressToolbar = async (label) => {
			await scrollTo("message", "here it is, the phone at 390");
			await page.sleep(200);
			const at = await page.evaluate(`(() => {
				const m = [...document.querySelectorAll('#chat .chat .msg[data-type="message"]')].find((x) => x.textContent.includes("here it is, the phone at 390"));
				const r = m.querySelector(".content").getBoundingClientRect();
				return {x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2)};
			})()`);
			await page.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{...at, id: 1}],
			});
			await page.sleep(750);
			const got = await page.evaluate(`(() => {
				const m = [...document.querySelectorAll('#chat .chat .msg[data-type="message"]')].find((x) => x.textContent.includes("here it is, the phone at 390"));
				const c = document.querySelector("#chat .chat");
				const left = c.getBoundingClientRect().left + c.clientLeft;
				const right = left + c.clientWidth;
				const buttons = [...m.querySelectorAll(".msg-actions button")].filter((b) => b.getBoundingClientRect().width > 0)
					.map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; });
				return {open: m.classList.contains("actions-open"), arrow: !!document.querySelector("#chat .scroll-down-shown"),
					left, right, buttons};
			})()`);
			await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
			await page.sleep(150);
			page.check(
				`${label}: a long press on an older line of ours, the arrow up, puts every button of the toolbar inside the pane (${JSON.stringify(
					got
				)})`,
				got.open &&
					got.arrow &&
					got.buttons.length >= 4 &&
					got.buttons.every(([l, r]) => l >= got.left && r <= got.right)
			);
			// A tap outside the scrollback puts it away (Message.vue).
			await page.evaluate(
				`document.body.dispatchEvent(new MouseEvent("click", {bubbles: true}))`
			);
			await page.waitFor(`!document.querySelector("#chat .msg.actions-open")`, {
				label: "the toolbar put away",
			});
		};
		await pressToolbar("phone Messenger query at the largest text step");
		await page.evaluate(`document.documentElement.dir = "rtl"`);
		await page.sleep(200);
		await pressToolbar("phone Messenger query at the largest text step, right to left");
		await page.evaluate(`document.documentElement.dir = "ltr"`);
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 5, y: 5});
		await page.evaluate(update("fontSize", "medium"));
		await page.sleep(300);

		// By finger, with the longest clock (12-hour with seconds): no time is
		// drawn until a swipe toward the pane's start slides the conversation
		// aside; then every later line's stands past its bubble, inside the
		// pane, and lifting the finger puts everything back.
		await page.evaluate(update("use12hClock", true));
		await page.evaluate(update("showSeconds", true));
		await page.sleep(300);
		const peek = async (label, shot) => {
			const state = `(() => {
				const box = (e) => { const r = e.getBoundingClientRect(); return {left: Math.round(r.left), right: Math.round(r.right)}; };
				const pane = box(document.querySelector("#chat .chat"));
				const rows = [...document.querySelectorAll('#chat .chat .messages > .msg:is([data-type="message"], [data-type="action"])')]
					.filter((m) => { const r = m.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 60; })
					.map((m) => ({shown: getComputedStyle(m.querySelector(".time")).display !== "none" && getComputedStyle(m.querySelector(".time")).visibility === "visible", time: box(m.querySelector(".time")), bubble: box(m),
						size: [m.getBoundingClientRect().width, m.getBoundingClientRect().height, m.getBoundingClientRect().top].map((v) => Math.round(v * 4) / 4)}));
				return {pane, rows, wide: document.querySelector("#chat .chat").scrollWidth > document.querySelector("#chat .chat").clientWidth};
			})()`;
			const before = await page.evaluate(state);
			const point = (x) => [{x, y: 420, id: 1}];
			await page.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: point(330),
			});
			// Every step of the way, nothing to scroll sideways.
			const wideAt = [];
			for (const x of [300, 240, 180, 100, 40]) {
				await page.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: point(x),
				});
				await page.sleep(50);
				const c = await page.evaluate(
					`(() => { const c = document.querySelector("#chat .chat"); return c.scrollWidth - c.clientWidth; })()`
				);
				if (c > 0) {
					wideAt.push([x, c]);
				}
			}
			await page.sleep(150);
			const during = await page.evaluate(state);
			page.check(
				`${label}: while the finger travels the pane has nothing to scroll sideways (${JSON.stringify(
					wideAt
				)})`,
				wideAt.length === 0
			);
			await page.screenshot(shot);
			await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
			await page.sleep(150);
			const after = await page.evaluate(state);
			page.check(
				`${label}: the swipe moves no row but the slide: every first line, later line and action keeps its size and height (${JSON.stringify(
					{before: before.rows.map((r) => r.size), during: during.rows.map((r) => r.size)}
				)})`,
				JSON.stringify(before.rows.map((r) => r.size)) ===
					JSON.stringify(during.rows.map((r) => r.size))
			);
			page.check(
				`${label}: a swipe shows every line's time, a first line's and an action's too, past its bubble, inside the pane (${JSON.stringify(
					during
				)})`,
				during.rows.length > 0 &&
					during.rows.every(
						(r) =>
							r.shown &&
							r.time.left >= r.bubble.right &&
							r.time.right <= during.pane.right
					)
			);
			page.check(
				`${label}: lifting the finger hides them and leaves nothing to scroll sideways (${JSON.stringify(
					after.rows.map((r) => r.shown)
				)})`,
				after.rows.every((r) => !r.shown) && !after.wide
			);
		};
		await peek("phone Messenger query", "12f-phone-messenger-query-swipe");
		await open(CHANNEL, "looks good from here");
		await page.evaluate(
			`document.querySelector('#chat .chat .msg.previous-source[data-type="message"]').scrollIntoView({block: "center"})`
		);
		await page.sleep(150);
		await peek("phone Messenger channel", "12g-phone-messenger-swipe");

		// One drag is one gesture: a drag the sidebar took (toward the pane's
		// end) never also slides the times out, even back past where it
		// started; a drag the times took never also moves the sidebar.
		const drag = async (xs) => {
			const point = (x) => [{x, y: 420, id: 1}];
			await page.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: point(xs[0]),
			});
			const seen = {peeked: false, sidebar: false};
			for (const x of xs.slice(1)) {
				await page.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: point(x),
				});
				await page.sleep(40);
				const now = await page.evaluate(
					`({peeked: !!document.querySelector("#chat .chat.time-peek"), sidebar: ${STORE}.state.sidebarDragging})`
				);
				seen.peeked ||= now.peeked;
				seen.sidebar ||= now.sidebar;
			}
			await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
			await page.sleep(400);
			const open = await page.evaluate(`${STORE}.state.sidebarOpen`);
			if (open) {
				await page.evaluate(`${STORE}.commit("sidebarOpen", false)`);
				await page.sleep(400);
			}
			return {...seen, open};
		};
		for (const [dir, flip] of [
			["ltr", (x) => x],
			["rtl", (x) => 390 - x],
		]) {
			await page.evaluate(`document.documentElement.dir = "${dir}"`);
			await page.sleep(200);
			const sidebarFirst = await drag([150, 220, 250, 210, 140, 100, 40].map(flip));
			page.check(
				`phone Messenger, ${dir}: a drag the sidebar took, brought back past its start, never slides the times out (${JSON.stringify(
					sidebarFirst
				)})`,
				sidebarFirst.sidebar && !sidebarFirst.peeked
			);
			const timesFirst = await drag([300, 260, 200, 150, 220, 300, 380].map(flip));
			page.check(
				`phone Messenger, ${dir}: a drag the times took, brought back past its start, never moves the sidebar (${JSON.stringify(
					timesFirst
				)})`,
				timesFirst.peeked && !timesFirst.sidebar && !timesFirst.open
			);
		}
		await page.evaluate(`document.documentElement.dir = "ltr"`);

		// With a mouse, at the largest text step and the longest clock: every
		// header (a nick or a notice's label, and the time beside it) inside
		// the pane.
		await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 5, y: 5});
		await page.evaluate(update("fontSize", "huge"));
		await page.sleep(400);
		const longClock = await page.evaluate(PAST_PANE);
		page.check(
			`phone Messenger at the largest text step, 12-hour clock with seconds: no header reaches past the pane (${JSON.stringify(
				longClock
			)})`,
			longClock.length === 0
		);
		await page.evaluate(update("fontSize", "medium"));
		await page.sleep(300);
		await page.evaluate(update("showSeconds", false));
	} finally {
		// The client dials again once the fixture is gone: that refusal is ours.
		page.expectWsErrors = true;
		await ircd.close();
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
