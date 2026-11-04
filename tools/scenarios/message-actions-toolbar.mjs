// The message action toolbar on a pointer device: it floats above the row it
// belongs to, it stands down while a selection is dragged out, it keeps clear
// of the jump-to-recent arrow, and the delete button is a trash can, not a ✕.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/message-actions-toolbar.mjs
//
// `SEANCE_IRC_URL` and `SEANCE_IRC_CHANNEL` point it at another network; it
// joins the channel twice (the app and a second user), says forty lines and
// quits, so pick a channel where that is welcome. Nothing in `pnpm test`
// mounts a component, which is why this exists; the touch behaviour (a long
// press) is tools/scenarios/message-actions-single.mjs --mobile.

const IRCD = process.env.SEANCE_IRC_URL ?? "wss://localhost:8443/";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";

const ircd = new URL(IRCD);

if (ircd.hostname === "localhost" || ircd.hostname === "127.0.0.1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert
}

// Two nicks per run, because a network that still holds the last run's
// connection would answer the reused one with 433 and the app has no second
// guess to make.
const stamp = Math.random().toString(36).slice(2, 6);
const NICK = `hovbar${stamp}`;
const TALKER = `hovtalk${stamp}`;

// `host` carries a path when the ircd's WebSocket lives under one
// (`irc.example.org/wockets/secure`); see the comment on it in js/irc/types.ts.
const HOST = ircd.hostname + ircd.pathname.replace(/\/$/, "");
const IRC_PORT = ircd.port || (ircd.protocol === "wss:" ? "443" : "80");

export const url =
	`http://localhost:${PORT}/?host=${encodeURIComponent(HOST)}&port=${IRC_PORT}` +
	`&tls=${ircd.protocol === "wss:"}&nick=${NICK}&join=${encodeURIComponent(CHANNEL)}`;

/** The ids of every message currently showing a tap-opened toolbar. */
const OPEN = `Array.from(document.querySelectorAll("#chat .msg.actions-open")).map((m) => m.id)`;

/** A second user on the same network, so there are messages to tap. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance hover toolbar`);
	};

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
			onJoin();
		} else if (params[1] === "433") {
			ws.send(`NICK ${nick}${Math.floor(Math.random() * 1000)}`);
		}
	};

	return {
		joined: new Promise((resolve, reject) => {
			onJoin = resolve;
			ws.onerror = (e) => reject(new Error(String(e.message ?? e)));
			setTimeout(() => reject(new Error(`${nick} never joined ${CHANNEL}`)), 20000);
		}),
		say: (text) => ws.send(`PRIVMSG ${CHANNEL} :${text}`),
		quit: () => ws.send("QUIT :done"),
	};
}

/** The rects of the toolbar every row is showing; display: none has none. */
const VISIBLE_BARS = `Array.from(document.querySelectorAll("#chat .msg-actions"))
	.map((el) => el.getBoundingClientRect())
	.filter((r) => r.width > 0 && r.height > 0)
	.map((r) => ({x: r.x, y: r.y, width: r.width, height: r.height}))`;

const visibleBars = async (page) =>
	JSON.parse(await page.evaluate(`JSON.stringify(${VISIBLE_BARS})`));

/** The ids of the rows tinted as the one a toolbar acts on. */
const tinted = async (page) =>
	JSON.parse(
		await page.evaluate(
			`JSON.stringify(Array.from(document.querySelectorAll("#chat .msg"))
				.filter((m) => getComputedStyle(m).boxShadow.includes("inset"))
				.map((m) => m.id))`
		)
	);

const overlaps = (a, b) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});

	await page.check(
		"the browser is a pointer device (this scenario hovers; --mobile is the other one)",
		!(await page.evaluate(`window.matchMedia("(hover: none) and (pointer: coarse)").matches`))
	);

	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

	// Enough lines that the scrollback scrolls, marked so previous runs'
	// history in the channel is left alone.
	const token = `hov-${Date.now().toString(36)}`;
	const talker = speaker(TALKER);
	await talker.joined;

	const LINES = 40;

	for (let n = 1; n <= LINES; n++) {
		talker.say(`line ${n} of ${token}`);
	}

	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).filter((c) => c.textContent.includes(${JSON.stringify(
			token
		)})).length === ${LINES}`,
		{timeout: 30000, label: `${LINES} messages on screen`}
	);
	await page.sleep(500);

	const ids = JSON.parse(
		await page.evaluate(
			`JSON.stringify(Array.from(document.querySelectorAll("#chat .msg")).filter((m) => m.textContent.includes(${JSON.stringify(
				token
			)})).map((m) => m.id))`
		)
	);
	const sel = (i) => `#${ids[i]}`;

	// 1. Hover a row: its toolbar shows, and shows above the row — its bottom
	//    edge at the row's top, not over the text.
	const target = sel(LINES - 4);
	await page.hover(`${target} .content`);
	await page.sleep(100);

	const row = await page.rect(target);
	const bar = await page.rect(`${target} .msg-actions`);
	await page.check(
		`hovering a row shows its toolbar (${JSON.stringify(bar)})`,
		bar && bar.width > 0 && bar.height > 0
	);
	const hoveredTint = await tinted(page);
	await page.check(
		`the hovered row, and only it, is tinted (${JSON.stringify(hoveredTint)})`,
		hoveredTint.length === 1 && hoveredTint[0] === ids[LINES - 4]
	);
	await page.check(
		`the toolbar sits above the row (bar bottom ${
			bar && (bar.y + bar.height).toFixed(1)
		}, row top ${row.y.toFixed(1)})`,
		bar && bar.y + bar.height <= row.y + 3 && bar.y + bar.height >= row.y - 3
	);
	// The row's text itself (its inline boxes, not the padding around them)
	// is clear of the toolbar.
	const text = JSON.parse(
		await page.evaluate(
			`(() => {
				const range = document.createRange();
				range.selectNodeContents(document.querySelector(${JSON.stringify(`${target} .content`)}));
				const r = range.getBoundingClientRect();
				return JSON.stringify({x: r.x, y: r.y, width: r.width, height: r.height});
			})()`
		)
	);
	await page.check(
		`the text of the hovered row is not under the toolbar (bar bottom ${
			bar && (bar.y + bar.height).toFixed(1)
		}, text top ${text.y.toFixed(1)})`,
		bar && !overlaps(bar, text)
	);

	// The pointer can travel up onto the toolbar without losing it.
	await page.hover(`${target} .msg-action-reply`);
	await page.sleep(100);
	await page.check(
		"moving the pointer onto the toolbar keeps it open",
		(await visibleBars(page)).length === 1
	);
	// The toolbar floats over the row above; the tint stays on its own row.
	const barTint = await tinted(page);
	await page.check(
		`on the toolbar, the tint stays on the row it acts on (${JSON.stringify(barTint)})`,
		barTint.length === 1 && barTint[0] === ids[LINES - 4]
	);
	await page.screenshot("1-toolbar-above-row", {selector: target, pad: 60});

	// 2. The delete button is a trash can behind a divider, not a ✕ that
	//    reads as "close".
	const glyph = await page.evaluate(
		`getComputedStyle(document.querySelector(${JSON.stringify(
			`${target} .msg-action-delete`
		)}), "::before").content`
	);
	await page.check(
		`the delete button is a trash can (::before content ${glyph})`,
		glyph.includes("\uf2ed")
	);
	await page.check(
		"a divider separates delete from the other actions",
		await page.evaluate(
			`document.querySelector(${JSON.stringify(
				`${target} .msg-action-delete`
			)}).previousElementSibling.classList.contains("msg-action-divider")`
		)
	);
	// The one-tap reactions lead, then the picker's smiley, then a divider
	// before the rest — three of them, emoji glyphs, none of them a word.
	const quick = JSON.parse(
		await page.evaluate(
			`JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
				`${target} .msg-action-quick`
			)})).map((b) => b.textContent.trim()))`
		)
	);
	await page.check(
		`three quick reactions lead the toolbar (${quick.join(" ")})`,
		quick.length === 3 &&
			(await page.evaluate(
				`(() => {
					const bar = document.querySelector(${JSON.stringify(`${target} .msg-actions`)});
					const kids = Array.from(bar.children);
					return kids[0].classList.contains("msg-actions-quick") &&
						kids[1].classList.contains("msg-action-react") &&
						kids[2].classList.contains("msg-action-divider") &&
						kids[3].classList.contains("msg-action-reply");
				})()`
			))
	);
	const label = await page.evaluate(
		`document.querySelector(${JSON.stringify(
			`${target} .msg-action-delete`
		)}).getAttribute("aria-label")`
	);
	await page.check(
		`the delete button says what it deletes ("${label}")`,
		label === "Delete message"
	);

	// 3. Dragging out a selection hides every toolbar for the drag, and
	//    releasing brings hover back.
	const from = await page.rect(`${sel(LINES - 8)} .content`);
	const to = await page.rect(`${sel(LINES - 5)} .content`);
	const start = {x: from.x + 40, y: from.y + from.height / 2};
	const finish = {x: to.x + 120, y: to.y + to.height / 2};

	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", ...start});
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		...start,
		button: "left",
		buttons: 1,
		clickCount: 1,
	});

	for (let step = 1; step <= 6; step++) {
		await page.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: start.x + ((finish.x - start.x) * step) / 6,
			y: start.y + ((finish.y - start.y) * step) / 6,
			button: "left",
			buttons: 1,
		});
		await page.sleep(30);
	}

	await page.check(
		"the scrollback knows a selection is being dragged",
		await page.evaluate(`document.querySelector("#chat .chat").classList.contains("selecting")`)
	);
	await page.check(
		"no toolbar shows while the selection is dragged",
		(await visibleBars(page)).length === 0
	);
	await page.check(
		"text really was selected",
		await page.evaluate(`!window.getSelection().isCollapsed`)
	);
	await page.screenshot("2-dragging-selection", {selector: sel(LINES - 8), pad: 80});

	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		...finish,
		button: "left",
		buttons: 0,
		clickCount: 1,
	});
	await page.sleep(100);

	await page.check(
		"releasing the button ends the stand-down",
		!(await page.evaluate(
			`document.querySelector("#chat .chat").classList.contains("selecting")`
		))
	);
	// The selection is live now, and a live selection in the scrollback
	// keeps every toolbar away (`selection-live`, helpers/touchSelection.ts)
	// so none covers what was selected; collapsing it brings hover back.
	await page.check(
		"the toolbars stay away while the selection stands",
		(await visibleBars(page)).length === 0
	);

	await page.evaluate(`window.getSelection().removeAllRanges()`);
	await page.sleep(100);
	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: finish.x + 1, y: finish.y});
	await page.sleep(100);
	await page.check(
		"the hovered row's toolbar is back once the selection is gone",
		(await visibleBars(page)).length === 1
	);

	// 4. Scrolled back, the jump-to-recent arrow is up and owns its corner:
	//    the toolbar of a row beside it moves left of it, and the arrow is
	//    on top should they ever meet.
	await page.evaluate(`document.querySelector("#chat .chat").scrollTop -= 400`);
	await page.waitFor(`document.querySelector("#chat .scroll-down-shown")`, {label: "the arrow"});
	await page.sleep(300); // its 0.2 s glide

	const arrow = await page.rect("#chat .scroll-down-arrow");

	// The row whose toolbar would sit beside the arrow: the one just above it.
	const beside = JSON.parse(
		await page.evaluate(
			`JSON.stringify(Array.from(document.querySelectorAll("#chat .msg"))
				.map((m) => ({id: m.id, r: m.getBoundingClientRect()}))
				.filter(({r}) => r.height > 0 && r.y + r.height > ${arrow.y} && r.y < ${arrow.y + arrow.height})
				.map(({id}) => id))`
		)
	);
	await page.check(`there is a row beside the arrow (${beside.join(", ")})`, beside.length > 0);

	const besideRow = `#${beside[beside.length - 1]}`;
	await page.hover(`${besideRow} .content`);
	await page.sleep(300);

	const shifted = await page.rect(`${besideRow} .msg-actions`);
	await page.check(
		`the toolbar is clear of the arrow (toolbar right ${
			shifted && (shifted.x + shifted.width).toFixed(1)
		}, arrow left ${arrow.x.toFixed(1)})`,
		shifted && shifted.width > 0 && shifted.x + shifted.width <= arrow.x
	);
	await page.check(
		"the arrow stacks over the toolbar",
		Number(
			await page.evaluate(
				`getComputedStyle(document.querySelector("#chat .scroll-down")).zIndex`
			)
		) >
			Number(
				await page.evaluate(
					`getComputedStyle(document.querySelector(${JSON.stringify(
						`${besideRow} .msg-actions`
					)})).zIndex`
				)
			)
	);
	await page.screenshot("3-clear-of-the-arrow", {
		clip: {
			x: shifted.x - 40,
			y: shifted.y - 40,
			width: 1280 - shifted.x,
			height: arrow.y + arrow.height - shifted.y + 80,
		},
	});

	// The arrow still does its job with a toolbar beside it.
	await page.click("#chat .scroll-down");
	await page.waitFor(`!document.querySelector("#chat .scroll-down-shown")`, {
		label: "back at the bottom",
	});
	await page.sleep(300);
	await page.hover(`${target} .content`);
	await page.sleep(100);
	const home = await page.rect(`${target} .msg-actions`);
	await page.check(
		`with the arrow gone the toolbar is back at the edge (right ${
			home && (home.x + home.width).toFixed(1)
		}, row right ${(row.x + row.width).toFixed(1)})`,
		home && row.x + row.width - (home.x + home.width) < 16
	);

	talker.quit();
}
