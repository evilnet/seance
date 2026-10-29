// Click-to-reveal media previews, end to end in a real browser.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/scenarios/seed-media.mjs
//   node tools/browser-drive.mjs tools/scenarios/media-preview-reveal.mjs
//
// Asserts the privacy claim that matters: nothing is fetched from the media
// URL until the reader asks for it.
//
// The channel keeps its scrollback, so previews from earlier runs are still
// on screen and may point at servers that are no longer up. Everything here
// therefore targets the **last** preview — the one `seed-media.mjs` just
// posted — and reads its URL out of the DOM rather than assuming one.

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=drivebot&join=%23seance";

/** Index of the last veiled preview, and the link its message points at. */
const LAST_VEIL = `(() => {
	const veils = document.querySelectorAll(".media-veil");
	const veil = veils[veils.length - 1];
	if (!veil) return null;
	const link = veil.closest(".msg")?.querySelector(".content a[href]");
	return {index: veils.length - 1, link: link ? link.href : null};
})()`;

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});

	// A fresh profile has no saved network, so the form is pre-filled from the
	// query parameters and only needs submitting.
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector(".media-veil")`, {
		timeout: 30000,
		label: "a media preview to arrive in #seance",
	});

	// Let the join burst settle and pin the newest message to the viewport.
	await page.sleep(800);

	// The veil's caption is ONE catalog phrase with the file name inside it
	// (link.clickToShowFile), not a translated tail glued to the name: the
	// separator's place is the language's business.
	const hint = await page.evaluate(
		`(() => {
			const veils = document.querySelectorAll(".media-veil");
			const veil = veils[veils.length - 1];
			return veil?.querySelector(".media-veil-hint")?.textContent ?? "";
		})()`
	);
	page.check(
		`the veil's caption carries the file name and the hint as one phrase (${hint})`,
		/\.png/.test(hint) && /click to show/i.test(hint) && !/\.png\S*click/i.test(hint)
	);
	await page.evaluate(`document.querySelector("#chat .messages")?.scrollTo(0, 1e9)`);
	await page.sleep(300);

	const target = await page.evaluate(LAST_VEIL);

	if (!target?.link) {
		throw new Error("no seeded preview on screen — run tools/scenarios/seed-media.mjs first");
	}

	console.log(`  target: ${target.link}`);
	await page.screenshot("1-veiled");

	// 1. Veiled by default, and the media URL was never requested. Comparing
	//    against this exact URL matters: the app loads its own images from the
	//    same origin, so a blanket "no image resources" check is always false.
	page.check("preview is veiled", (await page.count(".media-veil")) > 0);
	page.check(
		"no media element mounted before revealing",
		(await page.count(".media-frame img, .media-frame video, .media-frame audio")) === 0
	);
	page.check(
		"the media URL has not been requested",
		await page.evaluate(
			`performance.getEntriesByType("resource").every(e => e.name !== ${JSON.stringify(
				target.link
			)})`
		)
	);

	// 2. Revealing mounts it, and now the URL is requested.
	const before = await page.count(".media-frame");
	await page.click(".media-veil-main", target.index);
	await page.waitFor(`document.querySelectorAll(".media-frame").length > ${before}`, {
		label: "the revealed media",
	});
	await page.sleep(300);
	await page.screenshot("2-revealed");
	page.check(
		"revealing requests the media URL",
		await page.evaluate(
			`performance.getEntriesByType("resource").some(e => e.name === ${JSON.stringify(
				target.link
			)})`
		)
	);

	// 3. The toolbar is hover-only, and hiding puts the veil back.
	const frame = (await page.count(".media-frame")) - 1;
	await page.hover(".media-frame", frame);
	await page.sleep(250);
	await page.screenshot("3-toolbar");
	page.check("toolbar is present on hover", (await page.count(".media-tools")) > 0);

	const veiledBefore = await page.count(".media-veil");
	await page.click(".media-tool-hide", frame);
	await page.sleep(400);
	page.check("hiding restores the veil", (await page.count(".media-veil")) > veiledBefore);
	page.check("hiding unmounts the media", (await page.count(".media-frame")) === before);

	// 4. The scope menu offers the scopes this message has: the host always,
	//    the channel outside queries, the sender's account when they are
	//    logged in (never on the dev ircd, which has no services).
	const again = await page.evaluate(LAST_VEIL);
	await page.click(".media-veil-trust", again.index);
	await page.waitFor(`document.querySelector("#context-menu")`, {label: "the trust menu"});
	await page.sleep(200);
	await page.screenshot("4-scope-menu");

	const labels = await page.evaluate(
		`Array.from(document.querySelectorAll("#context-menu li")).map(li => li.textContent.trim())`
	);
	console.log(`  menu: ${labels.join(" | ")}`);
	page.check(
		"menu offers the host scope",
		labels.some((l) => /^Always show from /.test(l))
	);
	page.check(
		"menu offers the channel scope",
		labels.some((l) => /^Always show in #/.test(l))
	);

	// 5. Trusting the channel reveals every veiled preview in it and persists.
	const channelItem = labels.findIndex((l) => /^Always show in #/.test(l));

	if (channelItem >= 0) {
		await page.click("#context-menu li", channelItem);
		await page.sleep(900);
		await page.screenshot("5-channel-trusted");
		page.check(
			"trusting the channel reveals the preview",
			(await page.count(".media-frame")) > before
		);
		page.check(
			"the trust is persisted",
			(
				JSON.parse(
					(await page.evaluate(`localStorage.getItem("thelounge.media.trusted")`)) ?? "{}"
				).channel ?? []
			).length > 0
		);
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
