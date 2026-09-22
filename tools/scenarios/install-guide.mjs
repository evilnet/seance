// The install guide (InstallGuide.vue): opens over the connect form on a
// fresh profile in a browser that can install the app, walks through the
// platform's steps with an illustration each, and stays away after "don't
// show this again".
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/install-guide.mjs
//   node tools/browser-drive.mjs tools/scenarios/install-guide.mjs --mobile --width=390 --height=844 --platform=android
//   node tools/browser-drive.mjs tools/scenarios/install-guide.mjs --mobile --width=390 --height=844 --platform=ios
//
// `--platform` overrides the user agent so the phone routes can be checked
// on a Linux Chromium; without it the browser's own (desktop Chromium) is
// what the guide sees. No IRC connection is needed.

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";

export const url = BASE;

/** Tell browser-drive to leave the guide alone (it dismisses it by default). */
export const installGuide = true;

const GUIDE = "#install-guide";
const KEY = "thelounge.state.installGuide";

const AGENTS = {
	android:
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
	ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
};

const EXPECTED = {
	desktop: ["Install Seance", "Use the install button in the address bar", "Confirm"],
	android: ["Install Seance", "Open the browser menu", "Choose Install app", "Confirm"],
	ios: ["Install Seance", "Open the Share menu", "Choose Add to Home Screen", "Tap Add"],
};

const PROBE = `(() => {
	const guide = document.querySelector("${GUIDE}");
	if (!guide) return null;
	const art = guide.querySelector(".install-art");
	const text = (sel) => (guide.querySelector(sel)?.textContent ?? "").trim();
	const buttons = Array.from(guide.querySelectorAll(".install-guide-nav .btn")).map((b) =>
		b.textContent.trim()
	);
	return {
		title: text("h2"),
		body: text(".install-guide-text > p:not(.install-guide-count):not(.install-guide-note)"),
		count: text(".install-guide-count"),
		art: art ? art.dataset.art : null,
		artBox: art ? art.getBoundingClientRect().toJSON() : null,
		buttons,
		rect: guide.getBoundingClientRect().toJSON(),
		window: {w: innerWidth, h: innerHeight},
		checked: guide.querySelector(".install-guide-remember input").checked,
	};
})()`;

export default async function run(page) {
	const platform = page.opt("platform", "desktop");

	if (AGENTS[platform]) {
		await page.send("Emulation.setUserAgentOverride", {userAgent: AGENTS[platform]});
	}

	await page.goto(page.url, {waitForSelector: GUIDE});

	let p = await page.evaluate(PROBE);
	const expected = EXPECTED[platform];

	await page.check("the guide is open over the connect form", p !== null);
	await page.check(`the introduction ("${p.title}")`, p.title === expected[0]);
	await page.check("the introduction has no step counter", p.count === "");
	await page.check("the introduction draws the app in its own window", p.art === "intro");
	await page.check("the checkbox starts unchecked", p.checked === false);
	await page.check(
		"the illustration has room",
		p.artBox && p.artBox.width > 200 && p.artBox.height > 100
	);
	await page.check(
		p.rect.width >= p.window.w - 1
			? "narrow window: the guide is the whole screen"
			: "wide window: the guide floats over a backdrop",
		p.rect.width >= p.window.w - 1 || (p.rect.width < p.window.w && p.rect.height < p.window.h)
	);
	await page.check(
		"the introduction offers to show how",
		p.buttons.includes("Show me how") && !p.buttons.includes("Back")
	);
	await page.screenshot(`${platform}-0-intro`);

	// Walk every step.
	for (let i = 1; i < expected.length; i++) {
		const last = i === expected.length - 1;
		await page.click(`${GUIDE} .install-guide-nav .btn:last-child`);
		await page.sleep(100);
		p = await page.evaluate(PROBE);
		await page.check(`step ${i}: "${p.title}"`, p.title === expected[i]);
		await page.check(
			`step ${i}: counter says ${i} of ${expected.length - 1}`,
			p.count === `Step ${i} of ${expected.length - 1}`
		);
		await page.check(`step ${i}: an illustration (${p.art})`, !!p.art && p.art !== "intro");
		await page.check(
			`step ${i}: ${last ? "Done" : "Next"} and Back`,
			p.buttons.includes("Back") && p.buttons.includes(last ? "Done" : "Next")
		);
		await page.screenshot(`${platform}-${i}-${p.art}`);
	}

	// Back works.
	await page.click(`${GUIDE} .install-guide-nav .btn-secondary`);
	await page.sleep(100);
	p = await page.evaluate(PROBE);
	await page.check(
		"Back returns to the previous step",
		p.title === expected[expected.length - 2]
	);

	// Close without the checkbox: the guide returns on the next load.
	await page.click(`${GUIDE} .install-guide-close`);
	await page.sleep(300);
	await page.check("the close button closes the guide", (await page.evaluate(PROBE)) === null);
	await page.check(
		"closing without the checkbox remembers nothing",
		(await page.evaluate(`localStorage.getItem("${KEY}")`)) === null
	);

	await page.goto(page.url, {waitForSelector: GUIDE});
	await page.check("the guide is back on the next load", (await page.evaluate(PROBE)) !== null);

	// Tick the checkbox and finish: never again.
	await page.click(`${GUIDE} .install-guide-remember input`);
	p = await page.evaluate(PROBE);
	await page.check("the checkbox ticks", p.checked === true);
	await page.screenshot(`${platform}-checked`);

	// Through every step, then Done.
	for (let i = 0; i < expected.length; i++) {
		await page.click(`${GUIDE} .install-guide-nav .btn:last-child`);
		await page.sleep(100);
	}

	await page.sleep(300);
	await page.check("Done closes the guide", (await page.evaluate(PROBE)) === null);
	await page.check(
		"the checkbox is remembered",
		(await page.evaluate(`localStorage.getItem("${KEY}")`)) === "dismissed"
	);

	await page.goto(page.url, {waitForSelector: "#connect"});
	await page.sleep(500);
	await page.check("the guide stays away after that", (await page.evaluate(PROBE)) === null);

	// Settings brings it back on request.
	await page.goto(`${page.url}#/settings`, {waitForSelector: "#show-install-guide"});
	await page.click("#show-install-guide");
	await page.sleep(300);
	p = await page.evaluate(PROBE);
	await page.check("Settings reopens the guide", p !== null && p.title === expected[0]);
	await page.check(
		"reopening from Settings forgets the earlier answer",
		(await page.evaluate(`localStorage.getItem("${KEY}")`)) === null
	);
	await page.screenshot(`${platform}-from-settings`);
}
