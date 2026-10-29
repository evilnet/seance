// The RTL plumbing end to end in a real browser, across every theme: with
// the qqx pseudo locale stored (the explicit-pick path — an explicitly
// stored dev-only pick activates in any build), <html dir> is rtl from the
// pre-paint script, the sidebar docks to the RIGHT edge, the message gutter
// mirrors (time column on the inline-start side, content flowing left of
// it), the composer mirrors with the send button at the inline end, and no
// viewport ever grows a horizontal scrollbar. The chat itself is fabricated
// through the same `init` bus event a registration dispatches
// (lib/fake-network.mjs) — this scenario is about locale-driven rendering,
// so no ircd is dialed (nothing is dialed at all).
//
//   NODE_ENV=development npx tsx tools/i18n/compile.ts \
//     && NODE_ENV=development npx webpack        # the servable dev build
//   python3 -m http.server -d public 8000 &
//   CHROME_BIN=$PWD/tmp/chrome-headless-wrapper.sh \
//     node tools/browser-drive.mjs tools/scenarios/i18n-rtl-layout.mjs
//
// The dev build is required: the fabrication goes through window.socket,
// which client/js/socket.ts only exposes when NODE_ENV != production.
//
// Every theme in client/themes/*.css is enumerated from the directory (not
// hardcoded) and run at two viewports — the driver's desktop size, then
// --mobile 390x844 with touch emulation — giving one screenshot per theme
// and viewport in tmp/scenarios/i18n-rtl-<theme>[-mobile].png. A theme that
// is not served (public/themes/<name>.css missing) is skipped with a SKIP
// line instead of failing the run. The screenshots are the verification
// artifact: look at them, especially for off-side vendor tooltips.
//
// eslint cannot parse .mjs (pre-existing repo state): this file is
// prettier-formatted by hand and checked only by running it.

import {copyFileSync, mkdirSync, readdirSync} from "node:fs";
import {resolve} from "node:path";
import {FAKE_NETWORK_SNIPPET} from "./lib/fake-network.mjs";

const BASE = process.env.SEANCE_HTTP ?? "http://localhost:8000/";
const MOBILE = {width: 390, height: 844};

export const url = BASE;

/** Every theme the tree ships, by basename — never a hardcoded list. */
const allThemes = readdirSync(resolve("client/themes"))
	.filter((file) => file.endsWith(".css"))
	.map((file) => file.slice(0, -".css".length))
	.sort();

/** A theme only runs if the build actually serves its stylesheet. */
async function servedThemes() {
	const served = [];
	const skipped = [];

	for (const name of allThemes) {
		try {
			const res = await fetch(new URL(`themes/${name}.css`, BASE));

			if (res.ok) {
				served.push(name);
				continue;
			}
		} catch {
			// server not reachable yet; the scenario fails loudly below
		}

		skipped.push(name);
	}

	return {served, skipped};
}

/** A cold reload of the app (the same dance i18n-language-switch.mjs uses):
 * `Page.reload`, polling through the document swap (evaluate fails while the
 * old document is torn down). */
const reload = async (page, waitForSelector) => {
	await page.evaluate(`(() => { window.__preReload = true; })()`);
	await page.send("Page.reload");
	const started = Date.now();

	for (;;) {
		try {
			if (
				await page.evaluate(
					`!window.__preReload && !!document.querySelector(${JSON.stringify(
						waitForSelector
					)})`
				)
			) {
				return;
			}
		} catch {
			// the document is being replaced
		}

		if (Date.now() - started > 20000) {
			throw new Error(`timed out waiting for ${waitForSelector} after reload`);
		}

		await page.sleep(150);
	}
};

/** Boot on the stored qqx pick + theme: seed the blob on the app's own
 * origin (about:blank has no storage), then reload so the pre-paint script
 * reads it before anything else and boot applies the theme by swapping
 * <link id="theme">. */
async function bootWith(page, theme) {
	await page.evaluate(
		`localStorage.setItem("settings", JSON.stringify({locale: "qqx", theme: ${JSON.stringify(
			theme
		)}}))`
	);
	await reload(page, "#connect form");
}

/** One bounding-box sweep of everything the direction claims live on. */
const GEOMETRY = `(() => {
	const rect = (sel) => {
		const el = document.querySelector(sel);
		return el ? el.getBoundingClientRect().toJSON() : null;
	};
	const doc = document.documentElement;
	return {
		dir: doc.dir,
		clientW: doc.clientWidth,
		scrollW: doc.scrollWidth,
		innerW: window.innerWidth,
		sidebar: rect("#sidebar"),
		messages: rect("#chat .messages"),
		time: rect('#chat .msg[data-type="message"] .time'),
		content: rect('#chat .msg[data-type="message"] .content'),
		form: rect("#form"),
		input: rect("#input"),
		submit: rect("#submit"),
	};
})()`;

async function setViewport(page, {width, height, mobile}) {
	await page.send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile,
	});
	await page.send("Emulation.setTouchEmulationEnabled", {enabled: mobile, maxTouchPoints: 5});
}

/** Boot on the stored qqx pick + theme, fabricate the chat, measure. */
async function runPass(page, theme, tag, {desktop}) {
	await bootWith(page, theme);
	await page.waitFor(`document.documentElement.dir === "rtl"`, {
		label: `${theme}${tag}: dir is rtl`,
	});

	const href = await page.evaluate(
		`document.getElementById("theme")?.getAttribute("href") ?? null`
	);
	page.check(
		`${theme}${tag}: theme link swapped to themes/${theme}.css (${href})`,
		href === `themes/${theme}.css`
	);
	page.check(
		`${theme}${tag}: documentElement.lang is qqx`,
		(await page.evaluate(`document.documentElement.lang`)) === "qqx"
	);

	// The chat, without a server.
	const faked = await page.evaluate(FAKE_NETWORK_SNIPPET);
	page.check(
		`${theme}${tag}: the fabricated chat rendered (window.socket present)`,
		faked === true
	);

	if (!faked) {
		throw new Error(
			"i18n-rtl-layout needs the development build: window.socket is dev-only (client/js/socket.ts)"
		);
	}

	await page.waitFor(`!!document.querySelector('#chat .msg[data-type="message"]')`, {
		label: `${theme}${tag}: a message row is on screen`,
	});
	await page.sleep(250); // let the theme's stylesheet settle if it swapped late

	const g = await page.evaluate(GEOMETRY);

	page.check(
		`${theme}${tag}: no horizontal scrollbar (scrollWidth ${g.scrollW} ≤ clientWidth ${g.clientW})`,
		g.scrollW <= g.clientW
	);

	if (desktop) {
		page.check(
			`${theme}${tag}: sidebar is visible`,
			!!g.sidebar && g.sidebar.width > 0 && g.sidebar.height > 0
		);
		// 16px of tolerance for the themes that inset the whole viewport in a
		// gutter of their own (bourbaki's --dos-gap, 0.5rem = 10px): docking
		// to the right edge inside the theme's frame still docks right.
		page.check(
			`${theme}${tag}: sidebar docks to the right edge (right ${g.sidebar.right.toFixed(
				1
			)} vs viewport ${g.clientW})`,
			!!g.sidebar && g.sidebar.right >= g.clientW - 16 && g.sidebar.right <= g.clientW
		);
	} else {
		// Mobile: the sidebar hides past the inline-START edge — which RTL
		// flips to the RIGHT (--slide-away sign flip in style.css).
		page.check(
			`${theme}${tag}: hidden sidebar parks off the right edge (left ${g.sidebar.left.toFixed(
				1
			)} ≥ viewport ${g.clientW})`,
			!!g.sidebar && g.sidebar.left >= g.clientW - 2
		);
	}

	page.check(
		`${theme}${tag}: the message gutter mirrored — time column on the right half`,
		!!g.time && !!g.messages && g.time.left > g.messages.left + g.messages.width / 2
	);
	page.check(
		`${theme}${tag}: the time column hugs the inline-start (right) edge`,
		!!g.time && !!g.messages && g.messages.right - g.time.right <= 32
	);

	if (desktop) {
		// Column mode: [content | nick | time] mirrored — content left of the
		// gutter. (Mobile's inline flow stacks the row, so there is no
		// gutter to be left of; there the content itself must start at the
		// inline-start edge.)
		page.check(
			`${theme}${tag}: content flows left of the time column`,
			!!g.time && !!g.content && g.content.right <= g.time.left + 1
		);
	} else if (theme === "ps") {
		// ps stacks its rows (time, nick, the text under the nick) and puts
		// a message on a fit-content card; right-to-left for that layout is
		// its own plan (CLAUDE.md, the ps theme: "Plan 5 brings right-to-left"),
		// so the inline-flow edge is reported, not failed, until it lands.
		const ok = !!g.content && !!g.messages && g.content.right >= g.messages.right - 32;
		console.log(
			`${
				ok ? "ok" : "KNOWN"
			} ${theme}${tag}: inline flow — content at the inline-start (right) edge (ps right-to-left is plan 5)`
		);
	} else {
		page.check(
			`${theme}${tag}: inline flow — content starts at the inline-start (right) edge`,
			!!g.content && !!g.messages && g.content.right >= g.messages.right - 32
		);
	}

	page.check(
		`${theme}${tag}: composer mirrored — send button sits at the inline end (left of the input)`,
		!!g.submit && !!g.input && g.submit.right <= g.input.left + 1
	);
	page.check(
		`${theme}${tag}: composer mirrored — input hugs the inline-start (right) side of the form`,
		!!g.input && !!g.form && g.form.right - g.input.right <= 32
	);

	const shot = await page.screenshot(`i18n-rtl-${theme}${tag}`);
	mkdirSync("tmp/scenarios", {recursive: true});
	copyFileSync(shot, `tmp/scenarios/i18n-rtl-${theme}${tag}.png`);
	console.log(
		`rtl ${theme}${tag}: measured, screenshot tmp/scenarios/i18n-rtl-${theme}${tag}.png`
	);
}

export default async function run(page) {
	const {served, skipped} = await servedThemes();

	for (const name of skipped) {
		console.log(
			`SKIP i18n-rtl-layout theme ${name}: themes/${name}.css is not served by this build`
		);
	}

	if (served.length === 0) {
		throw new Error("no theme is served by this build — nothing to loop over");
	}

	console.log(`themes to run (${served.length}): ${served.join(", ")}`);

	// Land on the app's origin first: the per-theme seeding writes
	// localStorage, which about:blank (the driver's start page) denies.
	await page.goto(page.url, {waitForSelector: "#connect form"});

	// Desktop pass first at the driver's own size, then the mobile pass.
	await setViewport(page, {
		width: Number(page.opt("width", 1280)),
		height: Number(page.opt("height", 900)),
		mobile: false,
	});

	for (const theme of served) {
		await runPass(page, theme, "", {desktop: true});
	}

	await setViewport(page, {...MOBILE, mobile: true});

	for (const theme of served) {
		await runPass(page, theme, "-mobile", {desktop: false});
	}

	page.check("no console errors", page.consoleErrors.length === 0);
}
