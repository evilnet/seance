// Masked markdown links show where they go, and one whose text names another
// address asks before opening (helpers/linkSafety.ts, parse.ts).
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/masked-links.mjs
//   (also --mobile --width=390 --height=844, and SEANCE_THEME=ps)
//
// A second user posts a prose-labelled link, a link whose label is another
// address, and a link whose label is its own URL. The checks:
//  - the host follows the first two labels (`.md-link-host`), the honest
//    link has none, and only the lying one is marked `.mismatch`;
//  - a plain click on the lying link, a middle click, a Ctrl+click and
//    the label holds no link of its own; Cancel opens
//    nothing; Open anyway opens the real URL;
//  - a plain click on the prose-labelled link opens it with no dialog.
// Opening is recorded, never performed: a window listener notes each click
// and auxclick that reached it (and whether the page prevented it) and then
// prevents it, and HTMLAnchorElement.prototype.click — what the dialog's
// Open uses — is stubbed to record its href.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const PORT = process.env.SEANCE_PORT ?? "8000";
const CHANNEL = "#seance";
const TALKER = "linktalk";
const RUN = Date.now().toString(36);

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=linkwatch&join=%23seance`;

const LINES = {
	masked: `the spec is [here](https://example.org/spec) ${RUN}m`,
	mismatch: `verify at [paypal.com](https://evil.example/login) ${RUN}x`,
	honest: `notes [https://x.org/a](https://x.org/a) ${RUN}h`,
};

function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance masked links`);
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

/** The masked link in the row whose text ends with `tag`. */
const LINK = (tag) =>
	`Array.from(document.querySelectorAll("#chat .msg .content")).find((c) => c.textContent.includes(${JSON.stringify(
		tag
	)}))?.querySelector("a.md-link")`;

const RECORDER = `(() => {
	window.__opened = [];
	window.__clicks = [];
	for (const type of ["click", "auxclick"]) {
		window.addEventListener(type, (ev) => {
			const a = ev.target instanceof Element ? ev.target.closest("a[href]") : null;
			if (!a) return;
			window.__clicks.push({type, href: a.href, prevented: ev.defaultPrevented});
			ev.preventDefault();
		});
	}
	HTMLAnchorElement.prototype.click = function () { window.__opened.push(this.href); };
	window.open = (u) => { window.__opened.push(String(u)); return null; };
})()`;

/** Where to press: the middle of the link's first line box (a wrapped link's
 * bounding box can have empty corners), after the pointer has left the rows
 * so no hover toolbar from a neighbouring row floats over the link. */
async function pointOn(page, sel) {
	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: 1, y: 1});
	await page.sleep(150);
	await page.evaluate(`${sel}.scrollIntoView({block: "center"})`);
	const r = await page.evaluate(
		`(() => { const b = ${sel}.getClientRects()[0]; return {x: b.x + Math.min(b.width / 2, 20), y: b.y + b.height / 2}; })()`
	);
	const onLink = await page.evaluate(
		`${sel}.contains(document.elementFromPoint(${r.x}, ${r.y}))`
	);
	await page.check(`the press lands on the link (${Math.round(r.x)},${Math.round(r.y)})`, onLink);
	return r;
}

/** A mouse press, or on --mobile a finger's tap (a mouse means a mouse there). */
async function pressAt(page, sel, {button = "left", modifiers = 0} = {}) {
	const r = await pointOn(page, sel);

	if (page.flags.has("--mobile")) {
		const touchPoints = [{x: r.x, y: r.y, radiusX: 8, radiusY: 8, force: 1}];
		await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints});
		await page.sleep(60);
		await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
		await page.sleep(300);
		return;
	}

	const buttons = button === "middle" ? 4 : 1;
	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x: r.x, y: r.y});
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: r.x,
		y: r.y,
		button,
		buttons,
		clickCount: 1,
		modifiers,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: r.x,
		y: r.y,
		button,
		buttons: 0,
		clickCount: 1,
		modifiers,
	});
	await page.sleep(150);
}

const dialogOpen = (page) =>
	page.evaluate(`!!document.querySelector("#confirm-dialog-overlay.opened")`);

async function cancelDialog(page) {
	await page.click("#confirm-dialog .btn-cancel");
	await page.sleep(150);
}

export default async function run(page) {
	// SEANCE_THEME=ps (say) to see the host over another theme's message rows.
	if (process.env.SEANCE_THEME) {
		await page.addInitScript(
			`localStorage.setItem("settings", JSON.stringify({theme: ${JSON.stringify(
				process.env.SEANCE_THEME
			)}}))`
		);
	}

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2500);

	const talker = speaker(TALKER);
	await talker.joined;
	talker.say(LINES.masked);
	talker.say(LINES.mismatch);
	talker.say(LINES.honest);
	await page.waitFor(`${LINK(RUN + "h")} != null`, {timeout: 10000, label: "the three links"});
	await page.sleep(300);
	await page.evaluate(RECORDER);

	const hostOf = (tag) =>
		page.evaluate(`${LINK(tag)}?.querySelector(".md-link-host")?.textContent ?? null`);
	const classOf = (tag) => page.evaluate(`${LINK(tag)}?.className ?? ""`);

	await page.check(
		`the prose link shows its host (${await hostOf(RUN + "m")})`,
		(await hostOf(RUN + "m")) === "example.org"
	);
	await page.check(
		`the lying link shows its real host (${await hostOf(RUN + "x")})`,
		(await hostOf(RUN + "x")) === "evil.example"
	);
	await page.check("the honest link shows no host", (await hostOf(RUN + "h")) === null);
	await page.check(
		"only the lying link is marked",
		(await classOf(RUN + "x")).includes("mismatch") &&
			!(await classOf(RUN + "m")).includes("mismatch") &&
			!(await classOf(RUN + "h")).includes("mismatch")
	);

	const rowOf = (tag) => page.evaluate(`${LINK(tag)}.closest(".msg").id`);
	await page.screenshot("1-links", {selector: `#${await rowOf(RUN + "m")}`, pad: 90});

	// The lying link: every way of opening it asks first.
	const X = LINK(RUN + "x");
	const ways = page.flags.has("--mobile")
		? [["a tap", {}]] // a phone has no middle button or Ctrl
		: [
				["a plain click", {}],
				["a middle click", {button: "middle"}],
				["a Ctrl+click", {modifiers: 2}],
		  ];
	for (const [label, opts] of ways) {
		await pressAt(page, X, opts);
		await page.check(`${label} on the lying link asks first`, await dialogOpen(page));
		await page.check(
			`${label} opened nothing`,
			(await page.evaluate("window.__opened.length")) === 0 &&
				(await page.evaluate(`window.__clicks.every((c) => c.prevented)`))
		);
		if (label === ways[0][0]) {
			await page.screenshot("2-dialog", {selector: "#confirm-dialog", pad: 20});
			const said = await page.evaluate(
				`document.querySelector("#confirm-dialog .confirm-text p")?.textContent ?? ""`
			);
			await page.check(
				`the dialog names the real host (${said})`,
				/goes to evil\.example/.test(said)
			);
		}
		if (await dialogOpen(page)) await cancelDialog(page);
	}

	// The label holds no link of its own: a right click, a long press or a
	// hover on it names the masked link's real destination, never the label's.
	const nested = await page.evaluate(`${X}.querySelector("a")`);
	await page.check("the label holds no link of its own", nested === null);
	await page.check(
		"Cancel opened nothing",
		(await page.evaluate("window.__opened.length")) === 0
	);

	await pressAt(page, X);
	if (await dialogOpen(page)) {
		await page.click("#confirm-dialog .btn-danger");
		await page.sleep(150);
	}
	const opened = await page.evaluate("window.__opened");
	await page.check(
		`Open anyway opens the real URL (${JSON.stringify(opened)})`,
		opened.length === 1 && opened[0] === "https://evil.example/login"
	);

	// The prose link opens straight away.
	await page.evaluate("window.__clicks.length = 0");
	await pressAt(page, LINK(RUN + "m"));
	await page.check("a plain click on the prose link raises no dialog", !(await dialogOpen(page)));
	const plain = await page.evaluate("window.__clicks");
	await page.check(
		`the prose link's click went through (${JSON.stringify(plain)})`,
		plain.length === 1 && !plain[0].prevented && plain[0].href === "https://example.org/spec"
	);

	talker.quit();
	await page.check("no console errors", page.consoleErrors.length === 0);
}
