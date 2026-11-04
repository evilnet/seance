// Regression: a pending copy must settle even when the server does not
// relay our @label on the echo-message copy (bus-contract §1.9). nefarious2
// relays it, so to reproduce the servers that do not, the page's WebSocket
// is shimmed to strip `label=s<n>` from inbound frames (leaving history's
// `label=h<n>` alone). Before the fix the faded copy stayed until the 60 s
// timeout; now it settles by exact text.
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   tools/nefarious-dev/run.sh -d   (or the native testnet on 8067)
//   CHROME_BIN=… SEANCE_IRC_WS=ws://127.0.0.1:8067/ \
//     node tools/browser-drive.mjs tools/scenarios/pending-no-label.mjs \
//     --url='http://127.0.0.1:8001/?host=127.0.0.1&port=8067&tls=false&nick=nolabel&join=%23seance'

const CHANNEL = "#seance";
const RUN = Date.now().toString(36);

export const url =
	"http://127.0.0.1:8001/?host=127.0.0.1&port=8067&tls=false&nick=nolabel&join=%23seance";

/** Drop our own send-labels (`label=s<n>`) from inbound frames. */
const INSTALL_SHIM = `(() => {
	const Native = WebSocket;
	window.__deliveredFrames = [];
	// Remove a "label=s<n>" tag wherever it sits in the message-tags block,
	// tidying the separators so the rest of the tags stay valid.
	const strip = (s) => s
		.replace(/;label=s[0-9]+/g, "")
		.replace(/@label=s[0-9]+;/g, "@")
		.replace(/@label=s[0-9]+ /g, "");
	window.WebSocket = class extends Native {
		addEventListener(type, listener, ...rest) {
			if (type !== "message") return super.addEventListener(type, listener, ...rest);
			return super.addEventListener(type, (ev) => {
				const data = strip(String(ev.data));
				window.__deliveredFrames.push(data);
				listener(data === String(ev.data) ? ev : new MessageEvent("message", {data}));
			}, ...rest);
		}
	};
	return true;
})()`;

const ROWS = `Array.from(document.querySelectorAll("#chat .msg[data-type='message']")).map((el) => ({
	text: el.querySelector(".content")?.textContent.trim() ?? "",
	pending: el.classList.contains("pending"),
	self: el.classList.contains("self"),
	opacity: getComputedStyle(el).opacity,
}))`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(INSTALL_SHIM);
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "input box"});
	await page.sleep(3000);

	const msg = `no-label ${RUN}`;
	await page.fill("#input", msg);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);

	// The copy shows faded at once.
	await page.sleep(120);
	let rows = (await page.evaluate(ROWS)).filter((r) => r.text.includes(RUN));
	const faded = rows.find((r) => r.pending);
	page.check(
		`the copy is shown${faded ? ` faded at opacity ${faded.opacity}` : ""}`,
		rows.length === 1
	);
	page.check(
		"the only signal is opacity (a pending row is translucent, nothing else)",
		!faded || Number(faded.opacity) < 0.8
	);
	await page.screenshot("1-sent", {selector: "#chat"});

	// The echo arrives without the label; the copy must still settle.
	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {
		timeout: 8000,
		label: "the copy to settle without a label",
	});
	await page.sleep(200);
	rows = (await page.evaluate(ROWS)).filter((r) => r.text.includes(RUN));
	page.check(`exactly one row after the echo (got ${rows.length})`, rows.length === 1);
	page.check("the settled row is opaque", rows.length === 1 && Number(rows[0].opacity) === 1);
	page.check("the settled row is self", rows.length === 1 && rows[0].self === true);
	await page.screenshot("2-settled", {selector: "#chat"});

	// The echo of our message really did reach the app without a send-label,
	// so the settle above was by content, not by label.
	const echo = await page.evaluate(
		`(window.__deliveredFrames ?? []).filter((f) => f.includes("PRIVMSG") && f.includes(${JSON.stringify(
			msg
		)}))`
	);
	page.check(`the echo frame arrived (${echo.length})`, echo.length >= 1);
	page.check(
		"no send-label reached the app on that echo",
		echo.every((f) => !/label=s/.test(f))
	);

	page.check("no console errors", page.consoleErrors.length === 0);
}
