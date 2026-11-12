// Where the search panel goes as the window narrows, as the Mac app: beside
// the chat while 15rem of chat is left, over the chat's box below that, over
// the screen in the phone layout. The sidebar never moves for it, nothing
// runs past the window's edge (the ✕ stays whole, the Mac's zoomed sidebar
// included), the choice holds still at the threshold (bourbaki's gap), a
// text size change alone moves it, and the head keeps clear of the traffic
// lights wherever it reaches the window's left edge, right to left too. The
// sidebar's list scrolls under its strip, not the strip under the lights.
//
// No ircd needed: lib/tiny-ircd.mjs registers the connection.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs tools/scenarios/search-layout.mjs

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9873;
const CHANNELS = ["#tiny", ..."abcdefghij"].map((c) => (c.length === 1 ? `#${c}` : c));

export const url =
	`http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=layout` +
	`&join=${encodeURIComponent(CHANNELS.join(","))}`;

/** The traffic lights' corner (style.css --mac-traffic-lights-end, --mac-titlebar-height). */
const LIGHTS = {right: 84, bottom: 52};

const STATE = `(() => {
	const box = (sel) => {
		const el = document.querySelector(sel);
		const r = el?.getBoundingClientRect();
		return r && r.width ? {left: r.left, right: r.right, top: r.top, bottom: r.bottom} : null;
	};
	const panel = document.querySelector("#search-panel");
	return {
		rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
		sidebar: box("#sidebar"),
		chat: box("#chat-container"),
		panel: box("#search-panel"),
		query: box(".search-query"),
		close: box(".search-close, .search-cancel"),
		headerPadLeft: parseFloat(getComputedStyle(document.querySelector("#chat .header")).paddingLeft),
		mode: panel?.classList.contains("screen-overlay") ? "screen" : panel?.classList.contains("covering") ? "chat" : "beside",
		past: [...document.querySelectorAll("#viewport *")]
			.filter((el) => {
				const r = el.getBoundingClientRect();
				return r.width && r.right > innerWidth + 1 && !el.closest("#sidebar") && getComputedStyle(el).visibility !== "hidden";
			})
			.map((el) => el.tagName.toLowerCase() + "." + [...el.classList].join(".")),
	};
})()`;

async function resize(page, width, height = 600) {
	await page.send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.sleep(400);
}

const underLights = (r) => !!r && r.left < LIGHTS.right && r.top < LIGHTS.bottom;

/** Reload with these settings (localStorage "settings"), connected and in #tiny. */
async function boot(page, settings) {
	// The last boot's network is saved and would connect by itself.
	await page.goto(page.url, {waitForSelector: "body"});
	await page.evaluate(
		`localStorage.clear(); localStorage.setItem("settings", ${JSON.stringify(
			JSON.stringify({matchSystemAppearance: false, ...settings})
		)})`
	);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`document.querySelector("#chat .header")`, {
		timeout: 20000,
		label: "joined",
	});
	await page.sleep(800);
}

async function openSearch(page) {
	await page.click("#chat button.search");
	await page.waitFor(`document.querySelector("#search-panel .search-query")`, {
		label: "search open",
	});
	await page.sleep(300);
}

/** The sweep: each width's expected place, and the checks every width gets. */
async function sweep(page, tag, widths) {
	const sidebarBefore = (await page.evaluate(STATE)).sidebar;

	for (const [width, mode] of widths) {
		await resize(page, width);
		const s = await page.evaluate(STATE);
		const at = `${tag} ${width}px`;
		page.check(
			`${at}: search ${mode === "beside" ? "beside the chat" : `over the ${mode}`} (got ${
				s.mode
			})`,
			s.mode === mode
		);
		page.check(
			`${at}: nothing past the window's edge ${s.past.join(" ")}`,
			s.past.length === 0
		);
		page.check(
			`${at}: the close button whole, inside the panel`,
			!!s.close &&
				s.close.right <= Math.min(width, s.panel.right) &&
				s.close.left >= s.panel.left
		);

		if (mode !== "screen") {
			page.check(
				`${at}: the sidebar keeps its place and width`,
				s.sidebar?.left === sidebarBefore.left && s.sidebar?.right === sidebarBefore.right
			);
		}

		if (mode === "beside") {
			page.check(`${at}: 15rem of chat beside`, s.chat.right - s.chat.left >= 15 * s.rem - 1);
		}

		if (mode === "chat") {
			page.check(
				`${at}: over the chat's box exactly`,
				["left", "right", "top", "bottom"].every((k) => s.panel[k] === s.chat[k])
			);
		}

		page.check(`${at}: the search field clear of the lights`, !underLights(s.query));
		await page.screenshot(`${tag}-${width}`);
	}
}

export default async function run(page) {
	const ircd = startTinyIrcd({port: IRCD_PORT});

	try {
		// The Mac app's bridge, answering nothing: loading-error-handlers.js
		// and native.ts set data-platform="macos" from it, as in the app.
		await page.addInitScript(
			`window.seanceShell = {platform: "macos", call: () => Promise.reject({code: "unimplemented", message: "fake"}), listen() {}};`
		);

		// 1. The default: macos theme, medium text.
		await resize(page, 1000, 320);
		await boot(page, {theme: "macos"});
		page.check(
			"the Mac app's layout",
			await page.evaluate(`document.documentElement.dataset.platform === "macos"`)
		);

		await page.evaluate(
			`[...document.querySelectorAll("#sidebar *")].forEach((el) => { el.scrollTop = 9999; })`
		);
		await page.sleep(200);
		const scroll = await page.evaluate(`(() => {
			const strip = document.querySelector("#sidebar .logo-container").getBoundingClientRect();
			const list = [...document.querySelectorAll("#sidebar *")].find((el) => el.scrollTop > 0);
			return {stripTop: strip.top, stripBottom: strip.bottom, listTop: list ? list.getBoundingClientRect().top : null};
		})()`);
		page.check("the sidebar's strip stays while its list scrolls", scroll.stripTop === 0);
		page.check(
			"the list scrolls under the strip, not under the lights",
			scroll.listTop !== null && scroll.listTop >= scroll.stripBottom - 1
		);
		await page.screenshot("sidebar-scrolled");

		await resize(page, 1280);
		await openSearch(page);
		await sweep(page, "medium", [
			[1280, "beside"],
			[900, "beside"],
			[760, "chat"],
			[560, "chat"],
			[500, "chat"],
			[470, "screen"],
			[400, "screen"],
		]);

		// Covering, the head carries the sidebar toggle the panel covers.
		await resize(page, 600);
		page.check(
			"covering: the head has the sidebar toggle",
			(await page.count("#search-panel .search-head .lt")) === 1
		);
		await page.click("#search-panel .search-head .lt");
		await page.sleep(400);
		let s = await page.evaluate(STATE);
		page.check("sidebar closed: search beside a 600px chat", s.mode === "beside" && !s.sidebar);
		await page.screenshot("sidebar-closed-600");

		// A text size change alone, the sidebar closed: no box it watches
		// changes size, and the choice still follows.
		await page.evaluate(`document.documentElement.dataset.fontSize = "large"`);
		await page.sleep(400);
		s = await page.evaluate(STATE);
		page.check(
			`large text: 600px no longer fits both (got ${s.mode})`,
			s.mode === "chat" && s.panel.left === 0
		);
		page.check(
			"large text, sidebar closed: the search field clear of the lights",
			!underLights(s.query)
		);
		await page.screenshot("sidebar-closed-large");
		await page.evaluate(`document.documentElement.dataset.fontSize = "medium"`);
		await page.sleep(400);
		page.check("back to medium: beside again", (await page.evaluate(STATE)).mode === "beside");

		// 2. Small text: the Mac zooms the sidebar back up (245px), the case
		// that ran the row past the window and cut the ✕ off.
		await resize(page, 1280);
		await boot(page, {theme: "keeki", fontSize: "small"});
		await openSearch(page);
		await sweep(page, "small", [
			[1280, "beside"],
			[760, "beside"],
			[620, "chat"],
			[520, "chat"],
			[470, "screen"],
		]);

		// 3. bourbaki's #viewport gap: the choice holds still at the threshold.
		await resize(page, 1280);
		await boot(page, {theme: "bourbaki"});
		await openSearch(page);
		const flips = [];

		for (let width = 760; width <= 840; width += 2) {
			await resize(page, width);
			const seen = new Set();

			for (let i = 0; i < 6; i++) {
				seen.add((await page.evaluate(STATE)).mode);
				await page.sleep(50);
			}

			if (seen.size > 1) {
				flips.push(width);
			}
		}

		page.check(`bourbaki: no flicker at the threshold ${flips.join(" ")}`, flips.length === 0);

		// 4. Right to left: the panel is the leftmost pane.
		await resize(page, 1280);
		await boot(page, {theme: "macos", locale: "ar"});
		await openSearch(page);
		s = await page.evaluate(STATE);
		page.check(
			"rtl: right to left",
			await page.evaluate(`document.documentElement.dir === "rtl"`)
		);
		page.check(
			"rtl beside: the search field clear of the lights",
			s.mode === "beside" && !underLights(s.query)
		);
		page.check(
			`rtl beside: the chat's header keeps its buttons' room (${s.headerPadLeft}px)`,
			s.headerPadLeft < LIGHTS.right
		);
		await page.screenshot("rtl-1280");
		await resize(page, 600);
		s = await page.evaluate(STATE);
		page.check(
			"rtl 600px: over the chat, clear of the lights",
			s.mode === "chat" && !underLights(s.query)
		);
		await page.screenshot("rtl-600");
	} finally {
		await ircd.close();
	}
}
