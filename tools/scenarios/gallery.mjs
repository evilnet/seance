// The capture gallery (docs/resources/themes.md § Checking a theme): one
// fixed conversation drawn under every theme the app ships, in every message
// layout that theme allows, at a desktop and a phone width, a screenshot of
// the channel and of a private conversation in each, and a manifest with a
// hash of each picture's pixels. Two runs compare with
// tools/gallery-compare.mjs, so "this change moved nothing" (or "moved
// exactly these cells") is shown rather than said.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   node tools/browser-drive.mjs --quiet --stable-raster --out=tmp/gallery/base tools/scenarios/gallery.mjs
//   node tools/gallery-compare.mjs tmp/gallery/base tmp/gallery/branch
//
// No ircd needed: lib/tiny-ircd.mjs sends lib/gallery-conversation.mjs when
// the page joins. `SEANCE_PORT` serves the app from another port;
// `GALLERY_THEMES=coffee,ps` captures only those themes.
//
// What makes it repeatable:
// - the themes come from the app's own list (configuration.ts), checked
//   against client/themes/*.css both ways, and each theme's layouts from what
//   the app applies: Lines and Bubbles are each asked for through the
//   setting, and whatever `data-message-layout` the app sets (absent counts
//   as lines) is a cell. A theme whose stylesheet reads
//   `prefers-color-scheme` (macos) is captured in light and in dark, the
//   dark one as `<theme>-dark`;
// - the theme and the layout are set through `settings/update`, the store
//   action Settings → Appearance uses, and each capture waits for the
//   stylesheet's load, the fonts and two frames;
// - every line has a pinned time, the page's clock is held at CLOCK (a Date
//   shim running on from there, put back before each cell), the time zone is
//   Etc/UTC and the locale en-US, so the times, the day marker and the ps
//   scene's hour and weather are the same every run;
// - reduced motion is the system's (`prefers-reduced-motion: reduce`, which
//   the app reflects as html[data-reduce-motion]): no entrance, no drift,
//   no glitter, and ps's scene holds still at the hour's colours. ps is
//   then ticked at CLOCK by a hidden/visible round trip;
// - the live rows' 3 s hold is over before the first capture, the sidebar
//   is switched with a synthetic click so nothing is hovered, and the caret
//   is made transparent (a capture-only style; the focus is left as the app
//   leaves it);
// - Chromium rasterises on one thread, whole tiles at a time
//   (browser-drive's --stable-raster, checked): otherwise the blurred glass
//   of ps and macos and macos's avatar gradients come out a few pixels
//   apart from run to run;
// - the phone pass boots cold at its size on a cleared origin, as a phone
//   would, rather than resizing the desktop's page.

import {createHash} from "node:crypto";
import {readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

import {CHANNEL, CLOCK, NICK, PEER, conversation} from "./lib/gallery-conversation.mjs";
import {decodePng} from "./lib/png.mjs";
import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9881;
const ONLY = (process.env.GALLERY_THEMES ?? "").split(",").filter(Boolean);
const ORIGIN = `http://localhost:${PORT}`;

export const url = `${ORIGIN}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	CHANNEL
)}`;

const VIEWPORTS = [
	{name: "desktop", width: 1280, height: 800, mobile: false},
	{name: "phone", width: 390, height: 844, mobile: true},
];
// The channel is taller than a phone, and than the desktop in Bubbles: it is
// drawn at its end, where a reader lands, and, where it overflows, again from
// its start (`channel-top`). A change that makes a theme overflow or stop
// overflowing shows in a compare as that cell added or removed.
const WINDOWS = [
	{name: "channel", item: CHANNEL, text: "looks good from here", top: true},
	{name: "query", item: PEER, text: "sending you a screenshot"},
];
const LAYOUTS = ["lines", "bubbles"];

const THEMES_DIR = fileURLToPath(new URL("../../client/themes/", import.meta.url));
const STORE = `document.querySelector("[data-v-app]").__vue_app__.config.globalProperties.$store`;
const update = (name, value) =>
	`${STORE}.dispatch("settings/update", {name: ${JSON.stringify(name)}, value: ${JSON.stringify(
		value
	)}})`;
const item = (name) =>
	`document.querySelector('.channel-list-item[data-name="${name.replace(/"/g, '\\"')}"]')`;
const LAYOUT = `(document.documentElement.dataset.messageLayout ?? "lines")`;

/** The page's clock, held at an instant and running on from it (theme-ps.mjs's shim). */
const CLOCK_SHIM = `(() => {
	const RealDate = Date;
	const realNow = RealDate.now.bind(RealDate);
	let offset = ${CLOCK} - realNow();
	function ShimDate(...a) {
		if (!new.target) return RealDate();
		return a.length ? new RealDate(...a) : new RealDate(realNow() + offset);
	}
	ShimDate.prototype = RealDate.prototype;
	ShimDate.now = () => realNow() + offset;
	ShimDate.UTC = RealDate.UTC;
	ShimDate.parse = RealDate.parse;
	window.Date = ShimDate;
	window.__galleryClock = () => { offset = ${CLOCK} - realNow(); };
})()`;

/** No caret to blink into one capture and out of the next. */
const NO_CARET = `document.addEventListener("DOMContentLoaded", () => {
	const s = document.createElement("style");
	s.textContent = "* { caret-color: transparent !important; }";
	document.head.appendChild(s);
});`;

const VISIBILITY = (state) => `(() => {
	Object.defineProperty(document, "visibilityState", {configurable: true, get: () => ${JSON.stringify(
		state
	)}});
	Object.defineProperty(document, "hidden", {configurable: true, get: () => ${state === "hidden"}});
	document.dispatchEvent(new Event("visibilitychange"));
})()`;

/** Fonts loaded, images in, the list at its end (or its start), two frames drawn. */
const SETTLE = (top = false) => `(async () => {
	await new Promise((r) => setTimeout(r, 0));
	document.body.getBoundingClientRect();
	await document.fonts.ready;
	const chat = document.querySelector("#chat .chat");
	if (chat) chat.scrollTop = ${top ? 0 : "chat.scrollHeight"};
	await new Promise((r) => setTimeout(r, 150));
	for (const img of document.images) {
		if (!img.complete) await new Promise((r) => { img.onload = img.onerror = r; });
	}
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	await document.fonts.ready;
	return true;
})()`;

function themeFiles() {
	return readdirSync(THEMES_DIR)
		.filter((f) => f.endsWith(".css"))
		.map((f) => f.slice(0, -4))
		.sort();
}

function pixelHash(file) {
	const {width, height, rgba} = decodePng(readFileSync(file));
	const hash = createHash("sha256");
	hash.update(`${width}x${height}\n`);
	hash.update(rgba);
	return {width, height, hash: hash.digest("hex").slice(0, 32)};
}

async function setScheme(page, scheme) {
	await page.send("Emulation.setEmulatedMedia", {
		features: [
			{name: "prefers-reduced-motion", value: "reduce"},
			{name: "prefers-color-scheme", value: scheme},
		],
	});
	await page.waitFor(`matchMedia("(prefers-color-scheme: ${scheme})").matches`, {
		label: `${scheme} scheme`,
	});
}

/** Theme `name` on screen: the link's load, then the app's own layout pass on it. */
async function applyTheme(page, name) {
	const href = `document.getElementById("theme").getAttribute("href").replace(/\\?.*$/, "")`;

	if ((await page.evaluate(href)) === `themes/${name}.css`) {
		await page.evaluate(update("theme", name));
		return;
	}

	await page.evaluate(`(() => {
		window.__galleryLoaded = false;
		document.getElementById("theme").addEventListener("load", () => { window.__galleryLoaded = true; }, {once: true});
	})()`);
	await page.evaluate(update("theme", name));
	await page.waitFor(`window.__galleryLoaded && ${href} === "themes/${name}.css"`, {
		label: `${name}'s stylesheet`,
	});
}

async function openWindow(page, win) {
	await page.evaluate(`${item(win.item)}.click()`);
	await page.waitFor(
		`${item(
			win.item
		)}?.classList.contains("active") && [...document.querySelectorAll("#chat .msg")].some((m) => m.textContent.includes(${JSON.stringify(
			win.text
		)}))`,
		{label: `${win.name} open`}
	);
}

async function boot(page, viewport, first) {
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: 1,
		mobile: viewport.mobile,
	});
	await page.send("Emulation.setTouchEmulationEnabled", {
		enabled: viewport.mobile,
		maxTouchPoints: viewport.mobile ? 5 : 1,
	});

	if (first) {
		await page.goto(page.url, {waitForSelector: "#connect form"});
	} else {
		// A cold start on a cleared origin (browser-testing.md rule 8): the
		// settings, saved network and kept lines of the last pass are gone.
		await page.send("Storage.clearDataForOrigin", {origin: ORIGIN, storageTypes: "all"});
		await page.evaluate(
			`window.__galleryOld = true; history.replaceState(null, "", ${JSON.stringify(
				page.url
			)})`
		);
		await page.send("Page.reload", {ignoreCache: false});

		for (const until = Date.now() + 20000; ; ) {
			try {
				if (
					await page.evaluate(
						`!window.__galleryOld && !!document.querySelector("#connect form")`
					)
				) {
					break;
				}
			} catch {
				// the document is being replaced
			}

			if (Date.now() > until) {
				throw new Error(`${viewport.name}: the connect form never came back`);
			}

			await page.sleep(150);
		}

		page.check(
			`${viewport.name}: boots with nothing kept from the last pass`,
			(await page.count(".channel-list-item")) === 0
		);
	}

	await page.waitFor(`document.documentElement.hasAttribute("data-reduce-motion")`, {
		label: "reduced motion",
	});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`${item(CHANNEL)} && ${item(PEER)}`, {label: "the channel and the query"});

	// Each window drawn once, so no unread marker or badge is left for the
	// first cell alone; then the live rows' hold runs out.
	for (const win of [...WINDOWS, ...WINDOWS]) {
		await openWindow(page, win);
	}

	await page.waitFor(`document.querySelectorAll("#chat .msg[data-live]").length === 0`, {
		label: "no live row",
		timeout: 6000,
	});
}

export default async function run(page) {
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "server-time message-tags echo-message",
		onLine(line, ctx) {
			if (line.startsWith("JOIN ")) {
				for (const out of conversation("tiny.test")) ctx.send(out);
				return true;
			}

			// Nothing is typed; swallow anything the page sends on its own.
			return line.startsWith("PRIVMSG ") || line.startsWith("TAGMSG ");
		},
	});
	page.check(
		"run with --stable-raster (without it ps and macos differ by a few pixels run to run)",
		page.flags.has("--stable-raster")
	);
	const cells = [];

	try {
		await page.addInitScript(CLOCK_SHIM);
		await page.addInitScript(NO_CARET);
		await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/UTC"});
		await page.send("Emulation.setLocaleOverride", {locale: "en-US"});
		await setScheme(page, "light");

		for (const [index, viewport] of VIEWPORTS.entries()) {
			await boot(page, viewport, index === 0);

			const appThemes = await page.evaluate(
				`${STORE}.state.serverConfiguration.themes.map((t) => t.name)`
			);

			if (index === 0) {
				const files = themeFiles();
				const unlisted = files.filter((f) => !appThemes.includes(f));
				const missing = appThemes.filter((t) => !files.includes(t));
				page.check(
					`every theme file is in the app's list (${unlisted.join(", ") || "all"})`,
					unlisted.length === 0
				);
				page.check(
					`every listed theme has a file (${missing.join(", ") || "all"})`,
					missing.length === 0
				);
			}

			const themes = appThemes.filter((t) => ONLY.length === 0 || ONLY.includes(t));

			for (const theme of themes) {
				const css = await page.evaluate(
					`fetch("themes/${theme}.css").then((r) => r.text())`
				);
				const schemes = /prefers-color-scheme/.test(css) ? ["light", "dark"] : ["light"];

				for (const scheme of schemes) {
					await setScheme(page, scheme);
					const label = scheme === "light" ? theme : `${theme}-${scheme}`;
					const done = new Set();

					for (const wanted of LAYOUTS) {
						await page.evaluate(update("messageLayout", wanted));
						await applyTheme(page, theme);
						const layout = await page.evaluate(LAYOUT);

						if (done.has(layout)) continue;
						done.add(layout);

						for (const win of WINDOWS) {
							await openWindow(page, win);

							if (theme === "ps") {
								await page.waitFor(
									`document.querySelector("#theme-scene")?.children.length > 0 && document.documentElement.dataset.psLight`,
									{label: "the ps scene"}
								);
							}

							await page.evaluate(`window.__galleryClock()`);

							if (theme === "ps") {
								await page.evaluate(VISIBILITY("hidden"));
								await page.evaluate(VISIBILITY("visible"));
								await page.sleep(400);
							}

							const overflows = await page.evaluate(
								`(() => { const c = document.querySelector("#chat .chat"); return c.scrollHeight > c.clientHeight; })()`
							);

							for (const top of win.top && overflows ? [false, true] : [false]) {
								await page.evaluate(SETTLE(top));
								const window = top ? `${win.name}-top` : win.name;
								const name = `${label}.${layout}.${viewport.name}.${window}`;
								const file = await page.screenshot(name);
								cells.push({name, ...pixelHash(file)});
							}
						}
					}
				}

				await setScheme(page, "light");
			}
		}

		page.check(`${cells.length} cells captured`, cells.length > 0);
		page.check("no console errors", page.consoleErrors.length === 0);
	} finally {
		const browser = await page.send("Browser.getVersion").catch(() => ({}));
		writeFileSync(
			join(page.outDir, "manifest.json"),
			`${JSON.stringify(
				{
					clock: new Date(CLOCK).toISOString(),
					browser: browser.product ?? null,
					cells: cells.sort((a, b) => a.name.localeCompare(b.name)),
				},
				null,
				"\t"
			)}\n`
		);
		await ircd.close();
	}
}
