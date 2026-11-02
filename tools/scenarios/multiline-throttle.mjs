// Several multiline messages sent back to back (docs/projects/multiline-
// messages.md § Sharp edges). The regression this guards: the per-batch
// cooldown outlives the message that caused it, so a later message's batch —
// sent while the server was still cooling down from an earlier one, which is
// what "once throttling starts" means — had its opener dropped, its lines
// leaked as standalone messages (duplicating), its blank line drew
// ERR_NOTEXTTOSEND and its closer drew FAIL BATCH NO_ACTIVE_BATCH.
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   tools/nefarious-dev/run.sh -d   (or the native testnet on 8067)
//   CHROME_BIN=… node tools/browser-drive.mjs tools/scenarios/multiline-throttle.mjs \
//     --url='http://127.0.0.1:8001/?host=127.0.0.1&port=8067&tls=false&nick=mlthrottle&join=%23seance'
//
// Slow on purpose: the batches are serialised ~one cooldown apart, so six
// short messages take ~20 s.

const CHANNEL = "#seance";
const RUN = Date.now().toString(36);
export const url =
	"http://127.0.0.1:8001/?host=127.0.0.1&port=8067&tls=false&nick=mlthrottle&join=%23seance";

// Six short multiline messages, each with a blank line, sent back to back.
const MESSAGES = [];
for (let n = 1; n <= 6; n++) MESSAGES.push(`${RUN} m${n} a\n\n${RUN} m${n} b`);

const ERRORS = `Array.from(document.querySelectorAll("#chat .msg[data-type='error']")).map((el) => el.querySelector(".content")?.textContent.trim() ?? "").filter((t) => /BATCH|text to send/i.test(t))`;

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

	for (const msg of MESSAGES) {
		await page.fill("#input", msg);
		await page.evaluate(`document.querySelector("#form").requestSubmit()`);
		await page.sleep(150);
	}

	// The last message's "b" line arrives only after every batch has been paced
	// out; poll for it.
	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).some((el) => el.textContent.includes("${RUN} m6 b"))`,
		{timeout: 40000, label: "the last message to arrive"}
	);
	await page.sleep(1500);

	const errors = await page.evaluate(ERRORS);
	console.log(`=== error rows (${errors.length}) ===`);
	for (const e of errors) console.log("  ! " + e);
	page.check(`no cooldown-artifact error rows (${errors.length})`, errors.length === 0);

	for (let n = 1; n <= 6; n++) {
		const count = await page.evaluate(
			`Array.from(document.querySelectorAll("#chat .msg .content")).filter((el) => el.textContent.includes("${RUN} m${n} a")).length`
		);
		page.check(`message ${n} appears exactly once, not duplicated (got ${count})`, count === 1);
	}

	await page.screenshot("multiline-throttle", {selector: "#chat"});
	page.check("no console errors", page.consoleErrors.length === 0);
}
