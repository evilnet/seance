// On a Mac, Option plus a letter types a character (⌥M types µ), and the page
// sees the same keydown as Alt+M. A shortcut has to stop that or the character
// lands in the composer: Mousetrap only calls preventDefault when the handler
// returns false. CDP's `text` is what the OS would insert.
//
//   tools/nefarious-dev/run.sh -d
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/option-keys.mjs --no-ws

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";
const CHANNEL = "#seance";

export const url = `${BASE}?host=localhost&port=8443&tls=true&nick=optkeys&join=%23seance`;

// The app's Alt shortcuts: the key, its keycode, what Option types.
const KEYS = [
	["m", 77, "µ"],
	["u", 85, "¨"],
	["s", 83, "ß"],
	["k", 75, "˚"],
	["j", 74, "∆"],
	["a", 65, "å"],
	["/", 191, "÷"],
];

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form button[type=submit]").click()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 20000,
		what: "joined",
	});
	await page.sleep(800);

	for (const [key, code, typed] of KEYS) {
		await page.evaluate(
			`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]').click()`
		);
		await page.sleep(300);
		await page.evaluate(`(() => {
			const input = document.querySelector("#input");
			input.value = "";
			input.dispatchEvent(new Event("input", {bubbles: true}));
			input.focus();
		})()`);

		await page.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: typed,
			text: typed,
			windowsVirtualKeyCode: code,
			modifiers: 1,
		});
		await page.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: typed,
			windowsVirtualKeyCode: code,
			modifiers: 1,
		});
		await page.sleep(300);

		const value = await page.evaluate(`document.querySelector("#input")?.value ?? ""`);
		page.check(`Option+${key} types nothing (${JSON.stringify(value)})`, value === "");

		// Whatever it opened goes away before the next key.
		await page.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			key: "Escape",
			code: "Escape",
			windowsVirtualKeyCode: 27,
		});
		await page.sleep(300);
	}
}
