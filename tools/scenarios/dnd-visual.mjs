// The do-not-disturb GUI, looked at and measured in several themes
// (docs/projects/do-not-disturb.md): the presence pill under the logo in each
// of its states and its menu, the lobby row's presence dot in its three
// colours and its menu, the network form's Presence select, the schedule
// editor in Settings → Notifications, and a WHOIS card's "Away: (no message)"
// row with a query's "… is away" line. Every menu item is picked and its
// effect read back (the pill's words, the dot's colour, `thelounge.dnd`,
// `thelounge.networks`); a real Tab reaches the pill and the dot with a
// visible ring; the pill's words stay whole and inside the sidebar, also at
// the huge step; the dot's hit box is measured; the pill's and the menus'
// text contrast is sampled from rendered pixels with the text hidden, since
// the ps theme's glass makes a computed background meaningless.
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/dnd-visual.mjs --no-ws \
//     --out=/tmp/claude-1000/visual/raw-desktop
//   node tools/browser-drive.mjs tools/scenarios/dnd-visual.mjs --no-ws \
//     --mobile --width=390 --height=844 --out=/tmp/claude-1000/visual/raw-mobile
//
// THEMES (default `coffee,ps-day,ps-night,day,princess`) picks the themes; a
// `ps-day`/`ps-night` entry is the ps theme with the local clock moved to
// 12:30 or 01:30 through a time-zone override. Screenshots are named
// `<theme>-<nn>-<what>.png` so a contact sheet keeps their order.
//
// SEANCE_URL (default http://localhost:8001/) and SEANCE_IRC_WS (default
// ws://127.0.0.1:8067/, plain WebSocket) point it at another build or ircd.
import {inflateSync} from "node:zlib";
import {writeFileSync, mkdirSync} from "node:fs";
import {join} from "node:path";
import {observe} from "./lib/irc-observer.mjs";

const RUN = Date.now().toString(36).slice(-5);
const NICK = `vis${RUN}`;
const PEER = `peer${RUN}`;
const BASE = process.env.SEANCE_URL ?? "http://localhost:8001/";
const IRCD = process.env.SEANCE_IRC_WS ?? "ws://127.0.0.1:8067/";
const IRCD_PORT = Number(new URL(IRCD).port || 8067);
const THEMES = (process.env.THEMES ?? "coffee,ps-day,ps-night,day,princess")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

export const url = `${BASE}?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=%23seance`;

const LOBBY = '.channel-list-item[data-type="lobby"]';
const PILL = "#sidebar .presence-pill";
const DOT = `${LOBBY} .lobby-presence .presence-dot`;
const MENU = "#context-menu";
const MENU_ITEM = (cls) => `${MENU} .context-menu-${cls}`;
const STORE = `document.querySelector("[data-v-app]").__vue_app__.config.globalProperties.$store`;

/** The IANA zone whose local hour is `hour` right now: Etc/GMT-N is UTC+N. */
function zoneFor(hour) {
	let off = (((hour - new Date().getUTCHours()) % 24) + 24) % 24;

	if (off > 14) {
		off -= 24;
	}

	return off === 0 ? "Etc/GMT" : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
}

const VISIBILITY = (state) => `(() => {
	Object.defineProperty(document, "visibilityState", {configurable: true, get: () => ${JSON.stringify(
		state
	)}});
	Object.defineProperty(document, "hidden", {configurable: true, get: () => ${state === "hidden"}});
	document.dispatchEvent(new Event("visibilitychange"));
})()`;

// ---- PNG (Chrome's captureScreenshot: 8-bit RGB or RGBA, not interlaced).

function decodePng(buf) {
	let pos = 8;
	let width = 0;
	let height = 0;
	let channels = 4;
	const idat = [];

	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos);
		const type = buf.toString("latin1", pos + 4, pos + 8);
		const data = buf.subarray(pos + 8, pos + 8 + len);

		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;

			if (data[8] !== 8 || !channels || data[12] !== 0) {
				throw new Error("unsupported PNG");
			}
		} else if (type === "IDAT") {
			idat.push(data);
		}

		pos += 12 + len;
	}

	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = Buffer.alloc(height * stride);

	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? out[y * stride + x - channels] : 0;
			const b = y > 0 ? out[(y - 1) * stride + x] : 0;
			const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
			let v = line[x];

			if (f === 1) {
				v += a;
			} else if (f === 2) {
				v += b;
			} else if (f === 3) {
				v += (a + b) >> 1;
			} else if (f === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}

			out[y * stride + x] = v & 255;
		}
	}

	return {width, height, channels, data: out};
}

const lum = ([r, g, b]) =>
	[r, g, b]
		.map((x) => {
			const s = x / 255;
			return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
		})
		.reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);

const ratio = (a, b) => {
	const [l, d] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (l + 0.05) / (d + 0.05);
};

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" → [r, g, b, a]. */
const parseRgb = (s) => {
	const p = (String(s).match(/[\d.]+/g) || []).map(Number);
	return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
};

export default async function run(page) {
	const mobile = page.flags.has("--mobile");
	const layout = mobile ? "mobile" : "desktop";
	const results = [];
	const record = (theme, label, ok, detail = "") => {
		results.push({theme, layout, label, ok: !!ok, detail});
		page.check(`${theme}: ${label}${detail ? ` (${detail})` : ""}`, ok);
	};
	/** A measurement reported, not asserted. */
	const note = (theme, label, detail) => {
		results.push({theme, layout, label, ok: null, detail});
		console.log(`  note ${theme}: ${label} (${detail})`);
	};

	const press = async (selector) => {
		if (!mobile) {
			await page.click(selector);
			return;
		}

		const r = await page.rect(selector);
		const touch = [{x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1}];
		await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: touch});
		await page.sleep(60);
		await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
		await page.sleep(250);
	};

	const openDrawer = async () => {
		if (mobile && !(await page.evaluate(`!!document.querySelector("#viewport.menu-open")`))) {
			await press("#viewport .lt");
			await page.waitFor(`document.querySelector("#viewport.menu-open")`, {
				label: "the drawer open",
			});
			await page.sleep(500);
		}
	};

	const closeMenu = async () => {
		if (await page.count(MENU)) {
			for (const type of ["keyDown", "keyUp"]) {
				await page.send("Input.dispatchKeyEvent", {
					type,
					key: "Escape",
					code: "Escape",
					windowsVirtualKeyCode: 27,
				});
			}

			await page.waitFor(`!document.querySelector('${MENU}')`, {label: "the menu closed"});
		}
	};

	const openMenu = async (opener, cls) => {
		await openDrawer();
		await press(opener);
		await page.waitFor(`document.querySelector('${MENU_ITEM(cls)}')`, {
			label: `menu item ${cls}`,
		});
		await page.sleep(150);
	};

	const choose = async (opener, cls) => {
		await openMenu(opener, cls);
		await press(MENU_ITEM(cls));
		await page.waitFor(`!document.querySelector('${MENU}')`, {label: "the menu to close"});
		// The scenario's own Tab and Escape presses leave the page in keyboard
		// modality, so the focus handed back to the opener would show its ring.
		await page.evaluate(`document.activeElement && document.activeElement.blur()`);
		await page.sleep(200);
	};

	const menuOnScreen = () =>
		page.evaluate(`(() => {
			const r = document.querySelector("${MENU}").getBoundingClientRect();
			return {ok: r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
				box: [r.left, r.top, r.right, r.bottom].map(Math.round).join(",") + " in " + innerWidth + "×" + innerHeight};
		})()`);

	const pillText = () =>
		page.evaluate(
			`document.querySelector('${PILL} .presence-pill-text').textContent.replace(/\\s+/g, " ").trim()`
		);
	const dotClass = () =>
		page.evaluate(
			`(() => { const d = document.querySelector('${DOT}'); return d.classList.contains("is-dnd") ? "red" : d.classList.contains("is-away") ? "amber" : d.classList.contains("is-online") ? "green" : "?"; })()`
		);
	const stored = (key) =>
		page.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)}) || "null")`);
	const setSetting = (name, value) =>
		page.evaluate(
			`${STORE}.dispatch("settings/update", {name: ${JSON.stringify(
				name
			)}, value: ${JSON.stringify(value)}, sync: true})`
		);

	/** The union of the selectors' boxes, padded and kept on screen. */
	const region = (selectors, pad = 12) =>
		page.evaluate(`(() => {
			const boxes = ${JSON.stringify(selectors)}
				.flatMap((s) => [...document.querySelectorAll(s)].slice(0, 1))
				.map((el) => el.getBoundingClientRect())
				.filter((r) => r.width > 0 && r.height > 0);
			if (!boxes.length) return null;
			const x0 = Math.max(0, Math.min(...boxes.map((b) => b.left)) - ${pad});
			const y0 = Math.max(0, Math.min(...boxes.map((b) => b.top)) - ${pad});
			const x1 = Math.min(innerWidth, Math.max(...boxes.map((b) => b.right)) + ${pad});
			const y1 = Math.min(innerHeight, Math.max(...boxes.map((b) => b.bottom)) + ${pad});
			return {x: x0, y: y0, width: x1 - x0, height: y1 - y0};
		})()`);

	let theme = "";
	let shotN = 0;
	let contrastN = 0;
	const shot = async (what, selectors, pad = 12) => {
		const clip = selectors ? await region(selectors, pad) : null;
		const name = `${theme}-${String(++shotN).padStart(2, "0")}-${what}`;
		await page.screenshot(name, clip ? {clip} : {});
	};

	/** A capture at `scale`, for the 1px focus rings. */
	const shotScaled = async (what, selectors, scale = 3, pad = 8) => {
		const clip = await region(selectors, pad);

		if (!clip) {
			return;
		}

		const r = await page.send("Page.captureScreenshot", {
			format: "png",
			clip: {...clip, scale},
		});
		mkdirSync(page.outDir, {recursive: true});
		const file = join(page.outDir, `${theme}-${String(++shotN).padStart(2, "0")}-${what}.png`);
		writeFileSync(file, Buffer.from(r.data, "base64"));
		console.log(`shot ${file}`);
	};

	/**
	 * The text contrast of `selector` against what is really behind it: its
	 * computed colour, then its box captured with every glyph in it (and the
	 * dot) made transparent, and the ratio against each background pixel. The
	 * worst 2 % is what is reported; the border and a 2px rim are left out.
	 */
	const contrast = async (selector, {hover = false} = {}) => {
		if (hover) {
			await page.hover(selector);
			await page.sleep(250);
		}

		const info = await page.evaluate(`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return null;
			const cs = getComputedStyle(el);
			const fg = cs.color;
			const r = el.getBoundingClientRect();
			const inset = parseFloat(cs.borderTopWidth) + 2;
			const style = document.createElement("style");
			style.id = "__contrast";
			style.textContent = ${JSON.stringify(
				`${selector}, ${selector} *, ${selector} *::before, ${selector} *::after, ${selector}::before, ${selector}::after { color: transparent !important; transition: none !important; text-shadow: none !important; } ${selector} .presence-dot { visibility: hidden !important; }`
			)};
			document.head.appendChild(style);
			return {
				fg,
				clip: (() => {
					const x = Math.max(0, r.left + inset), y = Math.max(0, r.top + inset);
					const x1 = Math.min(innerWidth, r.right - inset), y1 = Math.min(innerHeight, r.bottom - inset);
					return {x, y, width: Math.max(1, x1 - x), height: Math.max(1, y1 - y)};
				})(),
			};
		})()`);

		if (!info) {
			return null;
		}

		await page.sleep(120);
		const shotData = await page.send("Page.captureScreenshot", {
			format: "png",
			clip: {...info.clip, scale: 1},
		});
		await page.evaluate(`document.getElementById("__contrast")?.remove()`);
		mkdirSync(join(page.outDir, "contrast"), {recursive: true});
		writeFileSync(
			join(
				page.outDir,
				"contrast",
				`${theme}-${++contrastN}-${selector.replace(/[^a-z0-9]+/gi, "_")}.png`
			),
			Buffer.from(shotData.data, "base64")
		);
		const png = decodePng(Buffer.from(shotData.data, "base64"));
		const [fr, fg, fb, fa] = parseRgb(info.fg);
		const ratios = [];

		for (let i = 0; i < png.data.length; i += png.channels) {
			const bg = [png.data[i], png.data[i + 1], png.data[i + 2]];
			// A translucent foreground lands on the pixel behind it.
			const fgOver = [fr, fg, fb].map((c, k) => c * fa + bg[k] * (1 - fa));
			ratios.push(ratio(fgOver, bg));
		}

		ratios.sort((a, b) => a - b);
		const worst = ratios[Math.floor(ratios.length * 0.02)] ?? 0;
		return {fg: info.fg, worst: Math.round(worst * 100) / 100};
	};

	/** Real Tab presses from the top of the page until `selector` has the
	 * focus; then whether it shows a ring. */
	const tabTo = async (selector, max = 120) => {
		// Tab from a stand-in at the top of the sidebar: a blur alone leaves
		// the sequential navigation starting point at the last element pressed.
		await page.evaluate(`(() => {
			const start = document.createElement("button");
			start.id = "__tab-start";
			start.style.cssText = "position:absolute;inline-size:1px;block-size:1px;opacity:0";
			document.getElementById("sidebar").prepend(start);
			start.focus();
			start.addEventListener("blur", () => start.remove(), {once: true});
		})()`);

		for (let i = 0; i < max; i++) {
			await page.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: "Tab",
				code: "Tab",
				windowsVirtualKeyCode: 9,
			});
			await page.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: "Tab",
				code: "Tab",
				windowsVirtualKeyCode: 9,
			});

			if (
				await page.evaluate(
					`document.activeElement === document.querySelector(${JSON.stringify(selector)})`
				)
			) {
				await page.sleep(150);
				return page.evaluate(`(() => {
					const el = document.activeElement;
					const cs = getComputedStyle(el);
					return {
						presses: ${i + 1},
						visible: el.matches(":focus-visible"),
						outline: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 ? cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor : "",
						shadow: cs.boxShadow !== "none" ? cs.boxShadow : "",
					};
				})()`);
			}
		}

		return null;
	};

	// ---- One connection for the whole run, and someone away with no message.
	const peer = await observe(IRCD, PEER, {caps: ["draft/pre-away"], join: "#seance"});

	try {
		peer.send("AWAY *");
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.click('#connect button[type="submit"]');
		await page.waitFor(
			`document.querySelector('${LOBBY} .connection-status-icon.is-connected')`,
			{timeout: 30000, label: "connected"}
		);
		await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
			label: "#seance joined",
		});

		const command = async (text) => {
			await page.fill("#input", text);
			await page.click("#submit");
			await page.sleep(1500);
		};

		await command(`/query ${PEER}`);
		await command("hello");
		await command(`/whois ${PEER}`);

		const goTo = async (name) => {
			await openDrawer();
			await press(`.channel-list-item[data-name="${name}"]`);
			await page.waitFor(
				`document.querySelector('.channel-list-item[data-name="${name}"].active')`,
				{label: `${name} open`}
			);
			await page.sleep(300);
		};

		for (const entry of THEMES) {
			theme = entry;
			shotN = 0;
			const errorsBefore = page.consoleErrors.length;
			const name = entry.startsWith("ps") ? "ps" : entry;

			await page.send("Emulation.setTimezoneOverride", {
				timezoneId:
					entry === "ps-day" ? zoneFor(12) : entry === "ps-night" ? zoneFor(1) : "",
			});
			await setSetting("theme", name);
			await page.waitFor(
				`document.getElementById("theme").getAttribute("href") === "themes/${name}.css"`,
				{label: `the ${name} stylesheet`}
			);
			await page.sleep(800);

			if (name === "ps") {
				await page.evaluate(VISIBILITY("hidden"));
				await page.sleep(200);
				await page.evaluate(VISIBILITY("visible"));
				const want = entry === "ps-day" ? "day" : "night";
				await page
					.waitFor(`document.documentElement.dataset.psLight === "${want}"`, {
						label: `ps ${want}`,
						timeout: 10000,
					})
					.catch(() => undefined);
				const light = await page.evaluate(`document.documentElement.dataset.psLight ?? ""`);
				record(theme, `the scene shows ${want}`, light === want, light);
				await page.sleep(1300); // --ps-flip
			}

			await goTo("#seance");
			await openDrawer();

			// ---- The pill at rest.
			let text = await pillText();
			record(theme, "the pill starts Online · auto", text === "Online · auto", text);
			record(theme, "the dot starts green", (await dotClass()) === "green");
			await shot("pill-online-auto", ["#sidebar .logo-container", LOBBY]);

			const pillContrast = await contrast(PILL);
			record(
				theme,
				"pill text contrast ≥ 4.5 (Online)",
				pillContrast && pillContrast.worst >= 4.5,
				pillContrast && `${pillContrast.worst}:1, ${pillContrast.fg}`
			);

			const geom = async () =>
				page.evaluate(`(() => {
					const side = document.getElementById("sidebar").getBoundingClientRect();
					const pillEl = document.querySelector(${JSON.stringify(PILL)});
					const pill = pillEl.getBoundingClientRect();
					const t = pillEl.querySelector(".presence-pill-text");
					const lh = parseFloat(getComputedStyle(t).lineHeight);
					return {
						whole: t.scrollHeight <= t.clientHeight + 1 && t.scrollWidth <= t.clientWidth + 1,
						lines: Math.round(t.getBoundingClientRect().height / lh),
						inside: pill.left >= side.left - 0.5 && pill.right <= side.right + 0.5,
						pillW: Math.round(pill.width), sideW: Math.round(side.width),
					};
				})()`);
			const checkGeom = async (state) => {
				const g = await geom();
				record(
					theme,
					`${state}: the pill text is whole, ≤ 2 lines, inside the sidebar`,
					g.whole && g.lines <= 2 && g.inside,
					`${g.lines} line(s), pill ${g.pillW}px in ${g.sideW}px`
				);
			};

			await checkGeom("Online · auto");

			// ---- Focus: the pill, then the dot, by real Tab presses.
			const pillFocus = await tabTo(PILL);
			record(
				theme,
				"Tab reaches the pill and shows a ring",
				!!pillFocus && pillFocus.visible && !!(pillFocus.outline || pillFocus.shadow),
				pillFocus
					? `${pillFocus.presses} presses, ${
							pillFocus.outline || pillFocus.shadow || "no ring"
					  }`
					: "never reached"
			);
			await shotScaled("pill-focus", [PILL], 2);
			const dotFocus = await tabTo(DOT, 160);
			record(
				theme,
				"Tab reaches the dot and shows a ring",
				!!dotFocus && dotFocus.visible && !!(dotFocus.outline || dotFocus.shadow),
				dotFocus
					? `${dotFocus.presses} presses, ${
							dotFocus.outline || dotFocus.shadow || "no ring"
					  }`
					: "never reached"
			);
			await shotScaled("dot-focus", [`${LOBBY} .lobby-presence`], 3);
			await page.evaluate(`document.activeElement && document.activeElement.blur()`);

			// ---- The dot's hit box.
			const hit = await page.evaluate(`(() => {
				const r = document.querySelector(${JSON.stringify(DOT)}).getBoundingClientRect();
				const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
				return {w: r.width, h: r.height, rem: Math.round((Math.min(r.width, r.height) / rem) * 100) / 100};
			})()`);
			record(
				theme,
				"the dot's hit box is ≥ 1.5rem",
				hit.rem >= 1.5,
				`${hit.w.toFixed(1)}×${hit.h.toFixed(1)}px = ${hit.rem}rem`
			);

			// ---- The dot's own colour against what is behind it (WCAG 1.4.11
			// asks 3:1 of a graphic that carries meaning); reported only.
			const dotBehind = async () => {
				const info = await page.evaluate(`(() => {
					const d = document.querySelector(${JSON.stringify(DOT)});
					const cs = getComputedStyle(d, "::before");
					const r = d.getBoundingClientRect();
					d.style.visibility = "hidden";
					return {bg: cs.backgroundColor, clip: {x: r.left, y: r.top, width: r.width, height: r.height}};
				})()`);
				await page.sleep(80);
				const cap = await page.send("Page.captureScreenshot", {
					format: "png",
					clip: {...info.clip, scale: 1},
				});
				await page.evaluate(
					`document.querySelector(${JSON.stringify(DOT)}).style.visibility = ""`
				);
				const png = decodePng(Buffer.from(cap.data, "base64"));
				const dot = parseRgb(info.bg);
				const rs = [];

				for (let i = 0; i < png.data.length; i += png.channels) {
					rs.push(ratio(dot, [png.data[i], png.data[i + 1], png.data[i + 2]]));
				}

				rs.sort((a, b) => a - b);
				return Math.round((rs[Math.floor(rs.length * 0.02)] ?? 0) * 100) / 100;
			};

			note(theme, "the green dot against the sidebar", `${await dotBehind()}:1`);

			// ---- The dot's ring (the 3:1 a status mark needs) against what is
			// behind the dot: the ring's colour, composited over each pixel of
			// the dot's hit box with the dot hidden; the worst 2 %.
			const ringBehind = async () => {
				const info = await page.evaluate(`(() => {
					const d = document.querySelector(${JSON.stringify(DOT)});
					const shadow = getComputedStyle(d, "::before").boxShadow;
					const r = d.getBoundingClientRect();
					d.style.visibility = "hidden";
					return {shadow, clip: {x: r.left, y: r.top, width: r.width, height: r.height}};
				})()`);
				await page.sleep(80);
				const cap = await page.send("Page.captureScreenshot", {
					format: "png",
					clip: {...info.clip, scale: 1},
				});
				await page.evaluate(
					`document.querySelector(${JSON.stringify(DOT)}).style.visibility = ""`
				);
				const png = decodePng(Buffer.from(cap.data, "base64"));
				// color-mix() computes to color(srgb r g b / a), 0-1 channels.
				const srgb = info.shadow.match(
					/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/
				);
				const colour = srgb
					? `rgba(${[1, 2, 3]
							.map((i) => Math.round(Number(srgb[i]) * 255))
							.join(", ")}, ${srgb[4] ?? 1})`
					: (info.shadow.match(/rgba?\([^)]*\)/) ?? ["rgb(0, 0, 0)"])[0];
				const [rr, rg, rb, ra] = parseRgb(colour);
				const rs = [];

				for (let i = 0; i < png.data.length; i += png.channels) {
					const bg = [png.data[i], png.data[i + 1], png.data[i + 2]];
					const over = [rr, rg, rb].map((c, k) => c * ra + bg[k] * (1 - ra));
					rs.push(ratio(over, bg));
				}

				rs.sort((a, b) => a - b);
				return {
					worst: Math.round((rs[Math.floor(rs.length * 0.02)] ?? 0) * 100) / 100,
					colour,
				};
			};
			const greenRing = await ringBehind();
			record(
				theme,
				"the green dot's ring against the sidebar ≥ 3:1",
				greenRing.worst >= 3,
				`${greenRing.worst}:1, ${greenRing.colour}`
			);

			// ---- The pill menu, every item.
			await openMenu(PILL, "status-auto");
			await shot("pill-menu", [PILL, MENU], 10);
			const onScreen = await menuOnScreen();
			record(theme, "the pill menu is wholly on screen", onScreen.ok, onScreen.box);
			const items = await page.evaluate(
				`[...document.querySelectorAll('${MENU} .context-menu-item, ${MENU} .context-menu-divider')].map((e) => e.classList.contains("context-menu-divider") ? "—" : e.textContent.trim())`
			);
			record(
				theme,
				"the pill menu lists its six items and a divider",
				items.length === 7 && items[4] === "—" && /^Follow schedule \(/.test(items[5]),
				items.join(" | ")
			);
			const menuC = await contrast(MENU_ITEM("dnd-1h"));
			record(
				theme,
				"menu item text contrast ≥ 4.5",
				menuC && menuC.worst >= 4.5,
				menuC && `${menuC.worst}:1`
			);
			const menuH = await contrast(MENU_ITEM("dnd-8h"), {hover: true});
			record(
				theme,
				"hovered menu item text contrast ≥ 4.5",
				menuH && menuH.worst >= 4.5,
				menuH && `${menuH.worst}:1`
			);
			await closeMenu();

			// Until I turn it off.
			await choose(PILL, "dnd-indefinite");
			text = await pillText();
			record(
				theme,
				"Until I turn it off: the pill says Do not disturb",
				text === "Do not disturb",
				text
			);
			record(theme, "… and the dot turns red", (await dotClass()) === "red");
			record(
				theme,
				"… stored as indefinite",
				(await stored("thelounge.dnd"))?.manual?.kind === "indefinite"
			);
			await openDrawer();
			await shot("pill-dnd-indefinite", ["#sidebar .logo-container", LOBBY]);
			const dndC = await contrast(PILL);
			record(
				theme,
				"pill text contrast ≥ 4.5 (DND)",
				dndC && dndC.worst >= 4.5,
				dndC && `${dndC.worst}:1, ${dndC.fg}`
			);
			await openMenu(PILL, "dnd-indefinite");
			const ticked = await page.evaluate(
				`document.querySelector('${MENU_ITEM(
					"dnd-indefinite"
				)}').getAttribute("aria-checked")`
			);
			record(theme, "… and the menu ticks it", ticked === "true", ticked);
			// The menus' own check mark: FontAwesome's, drawn by CSS.
			const mark = await page.evaluate(`(() => {
				const cs = getComputedStyle(document.querySelector('${MENU_ITEM("dnd-indefinite")}'), "::after");
				return {content: cs.content, font: cs.fontFamily};
			})()`);
			record(
				theme,
				"the tick is the menus' FontAwesome check",
				mark.content === '"\uf00c"' && /FontAwesome/.test(mark.font),
				`${JSON.stringify(mark.content)} ${mark.font}`
			);
			await shot("pill-menu-ticked", [PILL, MENU], 10);
			await closeMenu();

			// For 1 hour, 24h clock.
			await setSetting("use12hClock", false);
			await choose(PILL, "dnd-1h");
			text = await pillText();
			record(
				theme,
				"For 1 hour: the pill says until HH:MM",
				/^Do not disturb · until \d\d:\d\d$/.test(text),
				text
			);
			const until1 = (await stored("thelounge.dnd"))?.manual?.until ?? 0;
			record(
				theme,
				"… stored an hour ahead",
				Math.abs(until1 - Date.now() - 3600_000) < 120_000
			);
			await openDrawer();
			await shot("pill-dnd-1h", ["#sidebar .logo-container", LOBBY]);
			await checkGeom("For 1 hour");

			// For 8 hours.
			await choose(PILL, "dnd-8h");
			const until8 = (await stored("thelounge.dnd"))?.manual?.until ?? 0;
			text = await pillText();
			record(
				theme,
				"For 8 hours: stored eight hours ahead, the pill says until",
				Math.abs(until8 - Date.now() - 8 * 3600_000) < 120_000 && /until/.test(text),
				text
			);

			// The longest label: 12h clock, a time tomorrow at 10:41 AM.
			await setSetting("use12hClock", true);
			await page.evaluate(`(() => {
				const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 41, 0, 0);
				const offset = d.getTime() - 3600000 - Date.now();
				const real = Date.now;
				window.__realNow = real;
				Date.now = () => real.call(Date) + offset;
			})()`);
			await choose(PILL, "dnd-1h");
			await page.evaluate(`Date.now = window.__realNow`);
			text = await pillText();
			record(
				theme,
				"the long 12h label reads until <day> 10:41 AM",
				/^Do not disturb · until [A-Z][a-z]{2} 10:41 AM$/.test(text),
				text
			);
			await openDrawer();
			await shot("pill-dnd-long-12h", ["#sidebar .logo-container", LOBBY]);
			await checkGeom("long 12h label");
			const longC = await contrast(PILL);
			record(
				theme,
				"pill text contrast ≥ 4.5 (long DND label)",
				longC && longC.worst >= 4.5,
				longC && `${longC.worst}:1`
			);

			// The huge step, the long label.
			await setSetting("fontSize", "huge");
			await page.sleep(500);
			await openDrawer();
			await checkGeom("huge step, long label");
			await shot("pill-dnd-long-huge", ["#sidebar .logo-container", LOBBY]);
			await openMenu(PILL, "status-auto");
			const hugeMenu = await menuOnScreen();
			record(
				theme,
				"at the huge step the pill menu is wholly on screen",
				hugeMenu.ok,
				hugeMenu.box
			);
			await shot("pill-menu-huge", [PILL, MENU], 6);
			await closeMenu();
			await setSetting("fontSize", "large");
			await page.sleep(300);
			await setSetting("use12hClock", false);

			// Off.
			await choose(PILL, "status-auto");
			text = await pillText();
			record(theme, "Off: back to Online · auto", text === "Online · auto", text);
			record(theme, "… and the dot is green", (await dotClass()) === "green");
			record(theme, "… stored off", (await stored("thelounge.dnd"))?.manual?.kind === "off");

			// Follow schedule, on and off.
			await choose(PILL, "dnd-schedule");
			record(
				theme,
				"Follow schedule: stored enabled",
				(await stored("thelounge.dnd"))?.schedule?.enabled === true
			);
			await openMenu(PILL, "dnd-schedule");
			record(
				theme,
				"… and the menu ticks it",
				(await page.evaluate(
					`document.querySelector('${MENU_ITEM(
						"dnd-schedule"
					)}').getAttribute("aria-checked")`
				)) === "true"
			);
			await press(MENU_ITEM("dnd-schedule"));
			await page.waitFor(`!document.querySelector('${MENU}')`, {label: "the menu to close"});
			await page.sleep(200);
			record(
				theme,
				"Follow schedule again: stored disabled",
				(await stored("thelounge.dnd"))?.schedule?.enabled === false
			);
			text = await pillText();
			record(theme, "… and the pill is Online · auto", text === "Online · auto", text);

			// ---- The dot, every mode.
			await openMenu(DOT, "presence-online");
			await shot("dot-menu", [DOT, MENU], 10);
			const dotOnScreen = await menuOnScreen();
			record(theme, "the dot menu is wholly on screen", dotOnScreen.ok, dotOnScreen.box);
			const dotItems = await page.evaluate(
				`[...document.querySelectorAll('${MENU} .context-menu-item')].map((e) => [e.textContent.trim(), e.getAttribute("role"), e.getAttribute("aria-checked")])`
			);
			const checkedItems = dotItems.filter(([, , c]) => c === "true");
			record(
				theme,
				"the dot menu lists four modes, Auto ticked",
				dotItems.length === 4 &&
					dotItems.every(([, role]) => role === "menuitemradio") &&
					checkedItems.length === 1 &&
					checkedItems[0][0] === "Auto",
				dotItems.map(([t, , c]) => (c === "true" ? `${t} (checked)` : t)).join(" | ")
			);
			const dotMenuC = await contrast(MENU_ITEM("presence-away"));
			record(
				theme,
				"dot menu item text contrast ≥ 4.5",
				dotMenuC && dotMenuC.worst >= 4.5,
				dotMenuC && `${dotMenuC.worst}:1`
			);
			await closeMenu();

			const dotColour = async () =>
				page.evaluate(`(() => {
					const d = document.querySelector(${JSON.stringify(DOT)});
					return getComputedStyle(d, "::before").backgroundColor;
				})()`);

			for (const [mode, colour, label, pill] of [
				["away", "amber", "Away", "Away"],
				["dnd", "red", "Do not disturb", "Do not disturb"],
				["online", "green", "Online", "Online"],
				["auto", "green", "Auto", "Online · auto"],
			]) {
				await choose(DOT, `presence-${mode}`);
				await page.sleep(300);
				const got = await dotClass();
				const net = (await stored("thelounge.networks")) ?? [];
				record(
					theme,
					`dot menu ${label}: the dot is ${colour}, the mode saved`,
					got === colour && net.some((n) => (n.presenceMode ?? "auto") === mode),
					`${got}, ${await dotColour()}`
				);
				text = await pillText();
				record(theme, `… the pill follows (${label})`, text === pill, text);

				if (mode === "away" || mode === "dnd") {
					note(theme, `the ${colour} dot against the sidebar`, `${await dotBehind()}:1`);
				}

				if (mode !== "auto") {
					const ring = await ringBehind();
					record(
						theme,
						`the ${colour} dot's ring against the sidebar ≥ 3:1`,
						ring.worst >= 3,
						`${ring.worst}:1, ${ring.colour}`
					);
				}

				if (mode !== "auto") {
					await openDrawer();
					await shot(`dot-${colour}-${mode}`, [LOBBY], 8);
				}
			}

			// ---- The network form's Presence select.
			await openDrawer();
			await press(`${LOBBY} .edit-network`);
			await page.waitFor(`document.querySelector("#connect\\\\:presenceMode")`, {
				label: "the Presence select",
			});
			await page.evaluate(
				`document.querySelector("#connect\\\\:presenceMode").scrollIntoView({block: "center"})`
			);
			await page.sleep(300);
			await shot(
				"form-presence-select",
				[
					"#connect\\:presenceMode",
					'label[for="connect:presenceMode"]',
					"#connect-presence-hint",
				],
				16
			);
			const form = await page.evaluate(`(() => {
				const s = document.querySelector("#connect\\\\:presenceMode");
				const words = [...s.options].map((o) => o.textContent.trim());
				const hint = document.querySelector("#connect-presence-hint").textContent.trim();
				const r = s.getBoundingClientRect();
				return {words, hint, fits: s.scrollWidth <= s.clientWidth + 1, w: Math.round(r.width)};
			})()`);
			record(
				theme,
				"the select offers the dot menu's four words, a hint for the mode",
				form.words.join("|") === "Online|Auto|Away|Do not disturb" &&
					form.hint === "Away when you're not looking.",
				`${form.words.join("|")} / ${form.hint}`
			);
			const selectC = await page.evaluate(`(() => {
				const s = document.querySelector("#connect\\\\:presenceMode");
				const cs = getComputedStyle(s);
				return {fg: cs.color, bg: cs.backgroundColor};
			})()`);
			const sfg = parseRgb(selectC.fg);
			const sbg = parseRgb(selectC.bg);
			const sRatio = sbg[3] > 0.95 ? Math.round(ratio(sfg, sbg) * 100) / 100 : null;
			record(
				theme,
				"the select's text contrast ≥ 4.5 (computed)",
				sRatio === null || sRatio >= 4.5,
				sRatio === null ? `translucent ${selectC.bg}, not measured` : `${sRatio}:1`
			);
			await page.evaluate(`(() => {
				const s = document.querySelector("#connect\\\\:presenceMode");
				s.value = "away";
				s.dispatchEvent(new Event("change", {bubbles: true}));
			})()`);
			await page.sleep(200);
			await page.click('#connect button[type="submit"]');
			await page.waitFor(`!document.querySelector("#connect\\\\:presenceMode")`, {
				label: "the form saved and closed",
			});
			await page.sleep(500);

			// Saving lands on Settings → Networks; Done leaves it.
			if (await page.count(".settings-modal-done")) {
				await page.click(".settings-modal-done");
				await page.waitFor(`!document.querySelector(".settings-modal-done")`, {
					label: "Settings closed",
				});
				await page.sleep(300);
			}

			const savedNet = (await stored("thelounge.networks")) ?? [];
			record(
				theme,
				"the select saves Away",
				savedNet.some((n) => n.presenceMode === "away") && (await dotClass()) === "amber",
				await dotClass()
			);
			await choose(DOT, "presence-auto");

			// ---- The schedule editor, through the pill menu's Edit schedule….
			await choose(PILL, "dnd-edit-schedule");
			await page.waitFor(`document.querySelector("#settings .dnd-schedule")`, {
				label: "Settings → Notifications",
			});
			await page.evaluate(
				`document.querySelector("#settings .dnd-schedule").scrollIntoView({block: "center"})`
			);
			await page.sleep(400);
			await shot("schedule-disabled", ["#settings .dnd-schedule"], 12);
			const fieldsOff = await page.evaluate(`(() => {
				const f = document.querySelector("#settings .dnd-schedule-fields");
				return {disabled: f.disabled, opacity: getComputedStyle(f).opacity};
			})()`);
			record(
				theme,
				"schedule off: its fields are disabled and dimmed",
				fieldsOff.disabled === true && Number(fieldsOff.opacity) < 1,
				JSON.stringify(fieldsOff)
			);
			await page.click("#settings .dnd-schedule > label.opt input");
			await page.sleep(300);
			record(
				theme,
				"schedule on: its fields are enabled",
				(await page.evaluate(
					`document.querySelector("#settings .dnd-schedule-fields").disabled`
				)) === false
			);
			record(
				theme,
				"the schedule switch saves enabled",
				(await stored("thelounge.dnd"))?.schedule?.enabled === true
			);
			await page.fill("#settings .dnd-times label:nth-child(1) input", "22:30");
			await page.fill("#settings .dnd-times label:nth-child(2) input", "06:15");
			await page.sleep(200);
			let sched = (await stored("thelounge.dnd"))?.schedule ?? {};
			record(
				theme,
				"the from/to inputs save",
				sched.start === "22:30" && sched.end === "06:15",
				`${sched.start}–${sched.end}`
			);
			const daysBefore = sched.days ?? [];
			await page.click("#settings .dnd-days label:nth-child(1) input");
			await page.sleep(200);
			sched = (await stored("thelounge.dnd"))?.schedule ?? {};
			record(
				theme,
				"a weekday checkbox saves",
				daysBefore.includes(0) !== (sched.days ?? []).includes(0),
				`[${daysBefore}] → [${sched.days}]`
			);
			await shot("schedule-enabled", ["#settings .dnd-schedule"], 12);
			const timeC = await page.evaluate(`(() => {
				const i = document.querySelector("#settings .dnd-times input");
				const cs = getComputedStyle(i);
				let el = i, bg = cs.backgroundColor;
				while (el && (bg.match(/[\\d.]+/g) || []).map(Number)[3] === 0) { el = el.parentElement; bg = el ? getComputedStyle(el).backgroundColor : bg; }
				return {fg: cs.color, bg, scheme: cs.colorScheme};
			})()`);
			const tfg = parseRgb(timeC.fg);
			const tbg = parseRgb(timeC.bg);
			const tRatio = tbg[3] > 0.95 ? Math.round(ratio(tfg, tbg) * 100) / 100 : null;
			record(
				theme,
				"the time inputs' text contrast ≥ 4.5 (computed)",
				tRatio === null || tRatio >= 4.5,
				tRatio === null
					? `translucent ${timeC.bg}, not measured`
					: `${tRatio}:1, color-scheme ${timeC.scheme}`
			);
			// Put it back: the day, the window, then off.
			await page.click("#settings .dnd-days label:nth-child(1) input");
			await page.fill("#settings .dnd-times label:nth-child(1) input", "23:00");
			await page.fill("#settings .dnd-times label:nth-child(2) input", "07:00");
			await page.click("#settings .dnd-schedule > label.opt input");
			await page.sleep(300);
			sched = (await stored("thelounge.dnd"))?.schedule ?? {};
			record(
				theme,
				"the schedule switch saves disabled",
				sched.enabled === false && sched.start === "23:00"
			);
			await page.click(".settings-modal-done");
			await page.waitFor(`!document.querySelector("#settings .dnd-schedule")`, {
				label: "Settings closed",
			});
			await page.sleep(300);

			// ---- The query's away line and the WHOIS card's star row.
			await goTo(PEER);
			const awaySel = '#chat .chan.active .msg[data-type="away"]';
			const awayCount = await page.count(`#chat .msg[data-type="away"]`);
			const awayText = await page.evaluate(
				`[...document.querySelectorAll('#chat .msg[data-type="away"]')].map((m) => m.textContent.replace(/\\s+/g, " ").trim()).pop() ?? ""`
			);
			record(
				theme,
				`the query says ${PEER} is away`,
				new RegExp(`${PEER}\\s+is away$`).test(awayText),
				awayText
			);
			const whoisRow = await page.evaluate(`(() => {
				const rows = [...document.querySelectorAll('#chat dl.whois > div')];
				const row = rows.reverse().find((r) => r.querySelector("dt")?.textContent.trim() === "Away:");
				return row ? row.querySelector("dd")?.textContent.trim() : null;
			})()`);
			record(
				theme,
				"the WHOIS card's Away row says (no message)",
				whoisRow === "(no message)",
				String(whoisRow)
			);
			void awaySel;

			if (awayCount) {
				await page.evaluate(
					`[...document.querySelectorAll('#chat .msg[data-type="away"]')].pop().scrollIntoView({block: "center"})`
				);
				await page.sleep(200);
				await page.screenshot(`${theme}-${String(++shotN).padStart(2, "0")}-query-away`, {
					clip: await page.evaluate(`(() => {
						const r = [...document.querySelectorAll('#chat .msg[data-type="away"]')].pop().getBoundingClientRect();
						return {x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: Math.min(innerWidth - Math.max(0, r.left - 8), r.width + 16), height: r.height + 16};
					})()`),
				});
			}

			const cardBox = await page.evaluate(`(() => {
				const card = [...document.querySelectorAll('#chat dl.whois')].pop();
				if (!card) return null;
				const msg = card.closest(".msg") || card;
				msg.scrollIntoView({block: "center"});
				const r = msg.getBoundingClientRect();
				return {x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: Math.min(innerWidth, r.width + 16), height: Math.min(innerHeight, r.height + 16)};
			})()`);

			if (cardBox) {
				await page.sleep(200);
				const box = await page.evaluate(`(() => {
					const msg = [...document.querySelectorAll('#chat dl.whois')].pop().closest(".msg");
					const r = msg.getBoundingClientRect();
					const x = Math.max(0, r.left - 8), y = Math.max(0, r.top - 8);
					return {x, y, width: Math.min(innerWidth - x, r.width + 16), height: Math.min(innerHeight - y, r.height + 16)};
				})()`);
				await page.screenshot(`${theme}-${String(++shotN).padStart(2, "0")}-whois-card`, {
					clip: box,
				});
			}

			// ---- The whole sidebar with the drawer open (phone) or as it is.
			await goTo("#seance");
			await openDrawer();
			await shot("sidebar", ["#sidebar"], 0);

			const errors = page.consoleErrors.slice(errorsBefore);
			record(theme, "no console errors", errors.length === 0, errors.slice(0, 3).join(" / "));
		}
	} finally {
		peer.close();
		await page.send("Emulation.setTimezoneOverride", {timezoneId: ""}).catch(() => undefined);
		mkdirSync(page.outDir, {recursive: true});
		writeFileSync(join(page.outDir, "results.json"), JSON.stringify(results, null, 2));
	}
}
