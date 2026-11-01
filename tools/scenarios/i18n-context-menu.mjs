// The chat header's channel-settings dropdown (`Chat.vue`'s `.menu` button →
// `ContextMenu.vue`'s anchored branch) in both directions. The anchor math is
// physical `left` positioning: LTR right-aligns the menu under the button
// (it opens toward the content); RTL mirrors the button onto the opposite
// screen edge, so the menu must anchor to the button's other edge — and
// whichever edge the mirrored layout parks the button against, the clamped
// menu must stay on screen. Before the fix the RTL menu opened 393 px off
// the left edge with every item clipped mid-word.
//
// The chat is fabricated the way i18n-rtl-layout.mjs does (lib/fake-
// network.mjs dispatches the registration `init` event; no ircd is dialed),
// so this needs the servable development build (window.socket is dev-only):
//
//   NODE_ENV=development npx tsx tools/i18n/compile.ts \
//     && NODE_ENV=development npx webpack        # the servable dev build
//   python3 -m http.server -d public 8000 &
//   CHROME_BIN=$PWD/tmp/chrome-headless-wrapper.sh \
//     node tools/browser-drive.mjs tools/scenarios/i18n-context-menu.mjs
//
// Screenshots: tmp/scenarios/{rtl,ltr}-context-menu.png.
//
// eslint cannot parse .mjs (pre-existing repo state): prettier-formatted by
// hand, checked by running it.

import {resolve} from "node:path";
import {FAKE_NETWORK_SNIPPET} from "./lib/fake-network.mjs";

const BASE = process.env.SEANCE_HTTP ?? "http://127.0.0.1:8000/";

export const url = BASE;

/** A cold reload, polling through the document swap (the dance
 * i18n-rtl-layout.mjs uses — evaluate fails while the old document dies). */
const reloadUntil = async (page, expression, label) => {
	await page.evaluate(`(() => { window.__preReload = true; })()`);
	await page.send("Page.reload");
	const started = Date.now();

	for (;;) {
		try {
			if (await page.evaluate(expression)) {
				return;
			}
		} catch {
			// the document is being replaced
		}

		if (Date.now() - started > 25000) {
			throw new Error(`timed out waiting for ${label}`);
		}

		await page.sleep(150);
	}
};

/** Boot with `settings` seeded, wait for the direction it implies, fabricate
 * the chat, open the header settings menu, measure everything. */
async function pass(page, settings, dir, shot) {
	await page.evaluate(
		`localStorage.setItem("settings", JSON.stringify(${JSON.stringify(settings)}))`
	);
	await reloadUntil(
		page,
		`document.documentElement.dir === ${JSON.stringify(dir)}`,
		`dir=${dir} after the ${settings.locale} reload`
	);

	const faked = await page.evaluate(FAKE_NETWORK_SNIPPET);
	page.check(`[${dir}] fake network dispatched (dev build)`, faked === true);

	await page.evaluate(`document.querySelector("#chat .menu").click()`);
	await page.waitFor(`!!document.querySelector("#context-menu")`, {
		label: `[${dir}] context menu opened`,
	});

	const m = await page.evaluate(`(() => {
		const menu = document.querySelector("#context-menu").getBoundingClientRect();
		const btn = document.querySelector("#chat .menu").getBoundingClientRect();
		return {
			menu: {left: menu.left, right: menu.right, width: menu.width},
			button: {left: btn.left, right: btn.right},
			innerWidth: window.innerWidth,
		};
	})()`);
	console.log(`[${dir}]`, JSON.stringify(m));

	page.check(
		`[${dir}] menu on screen (left=${m.menu.left.toFixed(1)}, right=${m.menu.right.toFixed(
			1
		)}, vw=${m.innerWidth})`,
		m.menu.left >= -1 && m.menu.right <= m.innerWidth + 1
	);

	if (dir === "ltr") {
		// The anchored branch's original shape: right-aligned under the button.
		page.check(
			`[${dir}] menu right-aligned under the button`,
			Math.abs(m.menu.right - m.button.right) < 2
		);
	}

	await page.screenshot(shot, {selector: "#viewport"});

	// Close it so the next pass starts clean.
	await page.evaluate(`document.body.click()`);
	await page.sleep(150);
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await pass(page, {locale: "qqx"}, "rtl", "rtl-context-menu");
	await pass(page, {locale: "en"}, "ltr", "ltr-context-menu");
	page.check("no console errors", page.consoleErrors.length === 0);
}
