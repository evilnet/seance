// Where the search panel goes as the window narrows, as the Mac app: beside
// the chat while 15rem of chat is left, over the chat's box below that, over
// the screen in the phone layout. The sidebar never moves for it, nothing
// runs past the window's edge (the ✕ stays whole), and the head keeps clear
// of the traffic lights wherever it reaches the window's left edge. The
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
		sidebar: box("#sidebar"),
		chat: box("#chat-container"),
		panel: box("#search-panel"),
		query: box(".search-query"),
		close: box(".search-close, .search-cancel"),
		mode: panel?.classList.contains("screen-overlay") ? "screen" : panel?.classList.contains("covering") ? "chat" : "beside",
		past: [...document.querySelectorAll("#viewport *")]
			.filter((el) => {
				const r = el.getBoundingClientRect();
				return r.width && r.right > innerWidth + 1 && !el.closest("#sidebar") && getComputedStyle(el).visibility !== "hidden";
			})
			.map((el) => el.tagName.toLowerCase() + "." + [...el.classList].join(".")),
		menuOpen: document.querySelector("#viewport").classList.contains("menu-open"),
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

export default async function run(page) {
	const ircd = startTinyIrcd({port: IRCD_PORT});

	try {
		// The Mac app's bridge, answering nothing: loading-error-handlers.js
		// and native.ts set data-platform="macos" from it, as in the app.
		await page.addInitScript(
			`window.seanceShell = {platform: "macos", call: () => Promise.reject({code: "unimplemented", message: "fake"}), listen() {}};`
		);
		await resize(page, 1280);
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.click('#connect button[type="submit"]');
		await page.waitFor(`document.querySelector("#chat .header")`, {
			timeout: 20000,
			label: "joined",
		});
		await page.sleep(800);
		page.check(
			"the Mac app's layout",
			await page.evaluate(`document.documentElement.dataset.platform === "macos"`)
		);

		// The sidebar's list scrolls below its strip.
		await resize(page, 1000, 320);
		await page.evaluate(
			`[...document.querySelectorAll("#sidebar *")].forEach((el) => { el.scrollTop = 9999; })`
		);
		await page.sleep(200);
		const strip = await page.evaluate(
			`(() => { const r = document.querySelector("#sidebar .logo-container").getBoundingClientRect(); return {top: r.top, bottom: r.bottom}; })()`
		);
		const list = await page.evaluate(
			`(() => { const r = document.querySelector("#sidebar .jump-to-input").getBoundingClientRect(); return {top: r.top}; })()`
		);
		page.check("the sidebar's strip stays while its list scrolls", strip.top === 0);
		page.check(
			"the list scrolls under the strip, not under the lights",
			list.top < 0 || list.top >= strip.bottom - 1
		);
		await page.screenshot("sidebar-scrolled");

		await resize(page, 1280);
		const sidebarBefore = (await page.evaluate(STATE)).sidebar;
		await page.click("#chat button.search");
		await page.waitFor(`document.querySelector("#search-panel .search-query")`, {
			label: "search open",
		});

		const expect = [
			[1280, "beside"],
			[900, "beside"],
			[760, "chat"],
			[560, "chat"],
			[500, "chat"],
			[470, "screen"],
			[400, "screen"],
		];

		for (const [width, mode] of expect) {
			await resize(page, width);
			const s = await page.evaluate(STATE);
			page.check(
				`${width}px: search ${
					mode === "beside" ? "beside the chat" : `over the ${mode}`
				} (got ${s.mode})`,
				s.mode === mode
			);
			page.check(
				`${width}px: nothing past the window's edge ${s.past.join(" ")}`,
				s.past.length === 0
			);
			page.check(
				`${width}px: the close button whole`,
				!!s.close && s.close.right <= width && s.close.left >= (s.panel?.left ?? 0)
			);

			if (mode !== "screen") {
				page.check(
					`${width}px: the sidebar keeps its place and width`,
					s.sidebar?.left === sidebarBefore.left &&
						s.sidebar?.right === sidebarBefore.right
				);
			}

			if (mode === "beside") {
				page.check(
					`${width}px: 15rem of chat beside`,
					s.chat.right - s.chat.left >= 15 * 16 - 1
				);
			}

			if (mode === "chat") {
				page.check(
					`${width}px: over the chat's box exactly`,
					s.panel.left === s.chat.left && s.panel.right === s.chat.right
				);
			}

			page.check(`${width}px: the search field clear of the lights`, !underLights(s.query));
			await page.screenshot(`search-${width}`);
		}

		// The sidebar closed (the Mac menu's Toggle Sidebar; the header's
		// toggle is under the panel): covering the chat reaches the window's
		// left edge.
		await resize(page, 520);
		await page.evaluate(`document.querySelector("#chat .lt").click()`);
		await page.sleep(400);
		const closed = await page.evaluate(STATE);
		page.check(
			"sidebar closed: search over the chat",
			closed.mode === "chat" && closed.panel.left === 0
		);
		page.check(
			"sidebar closed: the search field clear of the lights",
			!underLights(closed.query)
		);
		await page.screenshot("search-sidebar-closed");
	} finally {
		await ircd.close();
	}
}
