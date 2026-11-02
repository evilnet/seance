// A long paste goes out as several draft/multiline batches, paced past the
// server's per-batch cooldown (docs/projects/multiline-messages.md § Sharp
// edges). The regression this guards: pacing the next batch on the previous
// batch's echo alone sent its opener into the cooldown, so the server dropped
// the opener but delivered the batch's lines as standalone messages — the
// message duplicated, blank lines drew ERR_NOTEXTTOSEND and the closer drew
// FAIL BATCH NO_ACTIVE_BATCH, all shown to the user.
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   tools/nefarious-dev/run.sh -d   (or the native testnet on 8067)
//   CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/multiline-paste.mjs \
//     --url='http://127.0.0.1:8001/?host=127.0.0.1&port=8067&tls=false&nick=mlpaste&join=%23seance'
//
// It is slow on purpose: the pacing waits out a real cooldown (~15 s for a
// 100-line batch), so the run takes ~30 s.

const CHANNEL = "#seance";
const RUN = Date.now().toString(36);
export const url =
	"http://127.0.0.1:8001/?host=127.0.0.1&port=8067&tls=false&nick=mlpaste&join=%23seance";

// 120 lines → two batches (max-lines=100). Blank lines at 105 and 110 fall in
// the second batch, so a regression would surface their ERR_NOTEXTTOSEND too.
const LINES = [];
for (let i = 1; i <= 120; i++) LINES.push(i === 105 || i === 110 ? "" : `${RUN} line ${i}`);
const MESSAGE = LINES.join("\n");

const ERRORS = `Array.from(document.querySelectorAll("#chat .msg[data-type='error']")).map((el) => el.querySelector(".content")?.textContent.trim() ?? "")`;
// Count how many times line 101 appears — exactly once when the batch is not
// leaked as standalone messages and then re-sent.
const COUNT_101 = `Array.from(document.querySelectorAll("#chat .msg .content")).filter((el) => el.textContent.includes("${RUN} line 101")).length`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "input box"});
	await page.sleep(3000);

	await page.fill("#input", MESSAGE);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);

	// Both batches: the first at once, the second after it waits out the
	// cooldown. Poll for line 120 (the last) to arrive.
	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).some((el) => el.textContent.includes("${RUN} line 120"))`,
		{timeout: 40000, label: "the whole message to arrive"}
	);
	await page.sleep(1500);

	const errors = (await page.evaluate(ERRORS)).filter(
		(e) => e.includes(RUN) || /BATCH|text to send/i.test(e)
	);
	console.log("=== error rows ===");
	for (const e of errors) console.log("  ! " + e);
	page.check(`no cooldown-artifact error rows (${errors.length})`, errors.length === 0);

	const count101 = await page.evaluate(COUNT_101);
	page.check(`line 101 appears exactly once, not duplicated (got ${count101})`, count101 === 1);

	await page.screenshot("multiline-paste", {selector: "#chat"});
	page.check("no console errors", page.consoleErrors.length === 0);
}
