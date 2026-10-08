// How strong the ps theme's two text treatments really are, measured from
// rendered pixels (docs/projects/ps-theme.md §7, §11). The legibility model
// (tools/ps/legibility.ts) treats the ground right around a word as
// `mix(ground, S, α)`: S is the halo colour for ink text by day and black for
// white text's shadow from dusk. This scenario measures α in Chromium and
// prints what tools/ps/legibility.ts records as ALPHA_HALO and ALPHA_SHADOW.
//
//   NODE_ENV=production corepack yarn build && python3 -m http.server -d public 8021 &
//   node tools/browser-drive.mjs tools/ps/calibrate.mjs --chrome=… --out=<dir>
//
// It writes the whole result to <dir>/ps-calibration.json, next to one
// screenshot of the swatches per treatment and device scale factor.
//
// **The treatment is read, not retyped.** The run connects to the dev ircd,
// picks ps in Appearance and has a second connection post one line into
// #seance. That line's `.content` (Source Sans 3, the words) and its nick in
// the nick column (Newsreader) are then read with `data-ps-text` forced to `ink` and to `light` and
// `--ps-halo` set to #ebf5fd: their computed font longhands, `text-shadow`
// and `color`. Transitions are switched off first, or a read right after the
// flip returns the state being left.
//
// **The swatches.** A fixed overlay, #808080, covers the app, with one row per
// (face, phrase, ground). Each row is a swatch of 360 × 48 CSS px with a flat
// ground G and one line of text in the computed font and shadow, Source Sans 3
// at the message size (the words) or Newsreader at the nick size. **The text is real
// chat** (PHRASES: short words, apostrophes, commas — the controller's ruling,
// 2026-09-25): the sample sentence the first passes used ("The quick brown fox
// 0123", "Marigold Ősz") has no thin marks, and overstated the light
// treatment by a third round them. The samples are still drawn, as the
// pipeline's control, but α is not taken from them. The light treatment draws
// white over the dusk amber, the moon's disc, the sun's core, snow, sky and
// grass, and (plan 3's white sooner) over the brightest grounds it now meets
// by day; ink draws #1b2638 over sky, grass, amber and snow. The rows are
// measured CHUNK at a time, one overlay and one screenshot each. Beside each
// swatch is its twin: the same swatch at an integer offset, with the text in
// #ff00ff.
//
// **The measurement**, at device scale factors 1, 2 and then 3 (a phone), at
// the default font-size step:
//
// 1. Page.captureScreenshot of the overlay, clipped at its top left. The PNG
//    goes back into the page and is decoded there (Image → canvas →
//    getImageData), so node needs no PNG decoder.
// 2. A swatch's pixels are its rect times the DPR.
// 3. **Core** pixels are where the swatch and its twin differ by more than
//    CORE_DIFF in some channel, i.e. every pixel the glyphs paint, however
//    faintly. **Ring** pixels are the non-core pixels one CSS px out: at
//    Chebyshev distance DPR device px from the core, which at DPR 1 is the
//    core's 8-adjacent neighbours.
// 4. A ring pixel R measures `a = dot(R − G, S − G) / |S − G|²`, clipped to
//    [0, 1]: how far toward S the treatment has moved the ground there.
// 5. The swatch's figure is the 10th percentile of `a` over its ring (nearest
//    rank, index ⌊0.1 (n − 1)⌋). The median and the ring's size are printed
//    beside it.
//
// The recorded α per treatment is the lowest 10th percentile over every
// phrase, face, ground and DPR (the samples left out), min(0.6, …), floored
// to four decimals: a measurement may only make the check stricter.
//
// **Why a twin, and not the colour rule the plan first wrote down.** That
// rule called a pixel core when it lay within 40 (max channel) of the text
// colour. It fails twice. The moon's disc, the sun's core and snow are all
// within 40 of white, so under it their bare ground is "core". And on every
// ground, the glyph's antialiased edge falls outside a 40-unit core and into
// the ring. That edge is mostly text colour, so it projects away from S and
// clips to 0: white over grass measures a shadow of about nothing. The
// literal rule still runs, and is printed and saved as a diagnostic column
// (`literal`), but nothing is recorded from it.
//
// **Why one CSS px, and not the first device pixel.** The first device pixel
// out sits 1 CSS px from the glyph at DPR 1 and half that at DPR 2, and the
// halo's two tight layers fall off steeply over that half pixel. Measured on
// the first device pixel, the halo read 0.22 at DPR 1 and 0.39 at DPR 2,
// which fails the DPR gate below. The second device pixel out at DPR 2 read
// 0.22 again. Every device-pixel layer out to 4 is still printed and saved
// (`layers`), so the first device pixel's figure stays on the record.
//
// **Checks that catch a bad pipeline before any α is believed** (each a
// failure of the run):
// - the decoded image is the clip times the DPR;
// - the overlay's grey decodes as 128, and a strip of every swatch far from
//   its text decodes as G exactly (no colour management in the round trip);
// - the swatch and its twin agree exactly more than 2 device px from the core
//   (the twin changed the glyphs and nothing else);
// - every swatch has a core and a ring of at least MIN_RING pixels;
// - the shadow over grass measures clearly above 0;
// - **the DPR gate.** On the samples (long lines, whose ring hardly moves with
//   the DPR), every higher DPR lands within 0.15 of DPR 1. On the phrases it
//   cannot: a thin mark is a pixel or two wide at DPR 1 and several at DPR 3,
//   so the ring round it strengthens with the DPR by up to 0.2 (measured
//   2026-09-25). A phrase's higher DPR may read stronger than its DPR 1, but
//   never weaker by more than 0.15: a broken ring at some DPR shows as a
//   collapse there, which is what the gate is for.
//
// **Skipped pairs.** Where G lies within MIN_SPAN of S (Euclidean distance in
// 0–255 sRGB), the projection divides by almost nothing and means nothing:
// the halo over snow is the one such pair here.
//
// **A proxy.** Headless Chromium antialiases text in grayscale. A real screen
// with subpixel antialiasing colours the glyph's edge pixels differently, so
// these figures describe the treatment's strength, not any one screen.

import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";

const RUN = Date.now().toString(36);
const NICK = `cal${RUN}`;
const BASE = `http://localhost:${process.env.SEANCE_HTTP_PORT ?? "8021"}/`;
const PORT = process.env.SEANCE_IRC_PORT ?? "8067";

export const url = `${BASE}?host=127.0.0.1&port=${PORT}&tls=false&nick=${NICK}&join=%23seance`;

const HALO = "#ebf5fd";
const TREATMENTS = {
	light: {
		text: "#ffffff",
		toward: "#000000",
		grounds: {
			"dusk amber": "#ffb96f",
			"moon disc": "#fdfaf0",
			"sun core": "#fffef6",
			snow: "#eef2f7",
			sky: "#9ccaf5",
			grass: "#69b04a",
			// Plan 3 (white sooner, 2026-09-25): the brightest grounds the light
			// treatment now meets by day (tools/ps/legibility.ts, the moments where
			// dark ink would not hold): a cloud on a clear afternoon, the yurt's
			// roof and felt, the snowy far fields and the river's pale far end on a
			// winter afternoon, the yurt's roof under the rain's veil and the noon
			// horizon under the storm's.
			"cloud by day": "#ffffff",
			"roof by day": "#f5f8fb",
			"felt by day": "#f7f0e3",
			"snowy fields": "#fceaf2",
			"river far end": "#e4e7de",
			"rain-veiled roof": "#c7ccd5",
			"storm-veiled horizon": "#8797a9",
		},
	},
	ink: {
		text: "#1b2638",
		toward: HALO,
		grounds: {
			sky: "#9ccaf5",
			grass: "#69b04a",
			amber: "#ffc478",
			snow: "#eef2f7",
		},
	},
};
/**
 * The real chat phrases α is measured on, each in both faces: the shortest
 * words, an apostrophe, commas (the controller's ruling, 2026-09-25). The
 * sample lines of the first passes stay as the pipeline's control.
 */
const PHRASES = ["it,", "ok", "yes", "tea's ready", "wind's dropped", "good night, plains"];
const SAMPLES = {words: "The quick brown fox 0123", nick: "Marigold Ősz"};
const FACES = ["words", "nick"];
/** Rows per overlay, each overlay measured from one screenshot. */
const CHUNK = 24;
/** The twin's text colour: far from every ground and every treatment colour. */
const TWIN_TEXT = "#ff00ff";
const DPRS = [1, 2, 3];

/** Layout, in whole CSS px so rect × DPR indexes exactly. */
const SWATCH_W = 360;
const SWATCH_H = 48;
const PAD = 16;
const MARGIN = 8;
const ROW_GAP = 16;
const TWIN_DX = SWATCH_W + 16;
/** The strip at each swatch's right end that must decode as G exactly. */
const FAR_STRIP = 24;
const OVERLAY_GREY = 128;
/** The measuring viewport: tall enough for one overlay of CHUNK rows. */
const VIEW_W = 1280;
const VIEW_H = Math.max(900, MARGIN * 2 + CHUNK * (SWATCH_H + ROW_GAP));

/** Real and twin differing by more than this, in some channel, is glyph paint. */
const CORE_DIFF = 2;
/** The plan's first core rule, kept as a diagnostic: within this of the text colour. */
const LITERAL_CORE = 40;
const MIN_RING = 50;
/** Euclidean sRGB distance |S − G| below which a pair is skipped. */
const MIN_SPAN = 60;
const PERCENTILE = 0.1;
/** The sanity gates. */
const GRASS_FLOOR = 0.1;
const DPR_SPREAD = 0.15;

/** The computed style copied from the real message onto a swatch's text. */
const FONT_PROPS = [
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"font-stretch",
	"font-variant",
	"font-variation-settings",
	"font-feature-settings",
	"font-optical-sizing",
	"font-kerning",
	"font-synthesis",
	"letter-spacing",
	"word-spacing",
	"line-height",
	"text-rendering",
	"-webkit-font-smoothing",
];

const OTHERS_LINE = `document.querySelector('#chat .chat .msg[data-type="message"]:not(.self) .content')`;

/** Someone else in #seance, as tools/scenarios/theme-ps.mjs's `neighbour()`. */
async function neighbour(nick) {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, ["text.ircv3.net"]);
	ws.binaryType = "arraybuffer";
	const text = (data) => (typeof data === "string" ? data : new TextDecoder().decode(data));
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error(`the neighbour ${nick} could not connect`));
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`the neighbour ${nick} did not register`)),
			15000
		);
		ws.onmessage = (ev) => {
			const line = text(ev.data);

			if (line.startsWith("PING ")) {
				ws.send(`PONG ${line.slice(5)}`);
			} else if (/^:\S+ 001 /.test(line)) {
				clearTimeout(timer);
				resolve();
			}
		};
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :${nick}`);
	});
	ws.send("JOIN #seance");
	return {
		say: (line) => ws.send(`PRIVMSG #seance :${line}`),
		quit: () => {
			ws.send("QUIT");
			ws.close();
		},
	};
}

async function pickPs(page) {
	await page.click(`#footer button.settings`);
	await page.waitFor(`document.querySelector(".settings-menu button.appearance")`, {
		label: "settings open",
	});
	await page.click(`.settings-menu button.appearance`);
	await page.waitFor(`document.querySelector("#theme-select")`, {label: "the theme select"});
	await page.evaluate(
		`(() => {
			const el = document.querySelector("#theme-select");
			el.value = "ps";
			el.dispatchEvent(new Event("change", {bubbles: true}));
		})()`
	);
	await page.sleep(700);
	await page.click(`.settings-modal-done`);
	await page.waitFor(`!document.querySelector(".settings-modal-done")`, {
		label: "settings closed",
	});
	await page.click(`.channel-list-item[data-name="#seance"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "back in #seance"});
	await page.sleep(300);
}

/**
 * The two treatments as the stylesheet computes them, read off the
 * neighbour's line in one evaluate: the scene rewrites data-ps-text and
 * --ps-halo on its minute tick, so nothing may run between the flip and the
 * read.
 */
const READ_TREATMENTS = `(() => {
	const h = document.documentElement;
	if (!document.getElementById("ps-calibrate-still")) {
		const still = document.createElement("style");
		still.id = "ps-calibrate-still";
		still.textContent = "#chat .chat .msg, #chat .chat .msg * { transition: none !important; }";
		document.head.append(still);
	}
	const content = ${OTHERS_LINE};
	const nick = content.closest(".msg").querySelector(".from .user");
	const props = ${JSON.stringify(FONT_PROPS)};
	const read = (el) => {
		const cs = getComputedStyle(el);
		const font = {};
		for (const p of props) font[p] = cs.getPropertyValue(p);
		return {font, color: cs.color, textShadow: cs.textShadow};
	};
	h.style.setProperty("--ps-halo", ${JSON.stringify(HALO)});
	const out = {htmlFontSize: getComputedStyle(h).fontSize, fontSizeStep: h.dataset.fontSize ?? null};
	for (const state of ["ink", "light"]) {
		h.dataset.psText = state;
		out[state] = {words: read(content), nick: read(nick)};
	}
	return out;
})()`;

/** Wait until the page has painted what was just changed. */
const PAINTED = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`;

/** Every row a treatment draws: each face, over each ground, the sample (the control) and then every phrase. */
function rowsOf(t) {
	const rows = [];

	for (const face of FACES) {
		for (const [name, ground] of Object.entries(t.grounds)) {
			rows.push({face, sample: SAMPLES[face], reference: true, name, ground});

			for (const sample of PHRASES) {
				rows.push({face, sample, reference: false, name, ground});
			}
		}
	}

	return rows;
}

/**
 * One overlay of `rows`: the swatch at MARGIN and its twin TWIN_DX to the
 * right. Returns the layout and the text's own extent, so the far strip can
 * be proved clear of it.
 */
function buildOverlay(t, rows, style) {
	/** The swatch's text colour at its own x, the twin's at TWIN_DX. */
	const inks = JSON.stringify([
		[0, t.text],
		[TWIN_DX, TWIN_TEXT],
	]);
	const twinX = MARGIN + TWIN_DX;

	return `(async () => {
		document.getElementById("ps-calibrate")?.remove();
		const rows = ${JSON.stringify(rows)};
		const style = ${JSON.stringify(style)};
		const fontOf = (f) => [f["font-style"], f["font-weight"], f["font-size"], f["font-family"]].join(" ");
		for (const row of rows) {
			await document.fonts.load(fontOf(style[row.face].font), row.sample);
		}
		const overlay = document.createElement("div");
		overlay.id = "ps-calibrate";
		overlay.style.cssText =
			"position: fixed; inset: 0; z-index: 9999; margin: 0; padding: 0; background: #808080;";
		const layout = [];
		rows.forEach((row, i) => {
			const y = ${MARGIN} + i * (${SWATCH_H} + ${ROW_GAP});
			const spans = [];
			for (const [dx, colour] of ${inks}) {
				const sw = document.createElement("div");
				sw.style.cssText =
					"position: absolute; box-sizing: border-box; display: flex; align-items: center; " +
					"overflow: visible; white-space: nowrap; margin: 0; " +
					"left: " + (${MARGIN} + dx) + "px; top: " + y + "px; " +
					"width: ${SWATCH_W}px; height: ${SWATCH_H}px; padding: 0 ${PAD}px; background: " + row.ground + ";";
				const span = document.createElement("span");
				for (const [p, v] of Object.entries(style[row.face].font)) span.style.setProperty(p, v);
				span.style.color = colour;
				span.style.textShadow = style[row.face].textShadow;
				span.textContent = row.sample;
				sw.append(span);
				overlay.append(sw);
				spans.push(span);
			}
			layout.push({...row, x: ${MARGIN}, y, w: ${SWATCH_W}, h: ${SWATCH_H}, tx: ${twinX}, spans});
		});
		document.body.append(overlay);
		await ${PAINTED};
		const rightmost = Math.max(...layout.map((r) => r.spans[0].getBoundingClientRect().right));
		const fontsReady = rows.map((row) => [row.face + " " + row.sample, document.fonts.check(fontOf(style[row.face].font), row.sample)]);
		return {
			width: ${MARGIN} * 2 + ${TWIN_DX + SWATCH_W},
			height: ${MARGIN} * 2 + rows.length * (${SWATCH_H} + ${ROW_GAP}) - ${ROW_GAP},
			rows: layout.map(({spans, ...r}) => r),
			rightmost,
			fontsReady,
		};
	})()`;
}

/**
 * Decode the screenshot in the page and measure every row. Runs in the page;
 * everything it needs arrives as JSON.
 */
function measure(b64, overlay, dpr, t) {
	return `(async () => {
		const img = new Image();
		img.src = "data:image/png;base64,${b64}";
		await img.decode();
		const W = img.naturalWidth, H = img.naturalHeight;
		const canvas = document.createElement("canvas");
		canvas.width = W;
		canvas.height = H;
		const ctx = canvas.getContext("2d", {willReadFrequently: true});
		ctx.drawImage(img, 0, 0);
		const data = ctx.getImageData(0, 0, W, H).data;
		const dpr = ${dpr};
		const overlay = ${JSON.stringify(overlay)};
		const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
		const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
		const maxDiff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
		const text = hex(${JSON.stringify(t.text)});
		const S = hex(${JSON.stringify(t.toward)});
		const pct = (sorted, q) => sorted.length ? sorted[Math.floor(q * (sorted.length - 1))] : null;
		const FAR = 255;

		/** Chebyshev distance to the nearest mask pixel, in device px, up to max (FAR beyond). */
		function distanceFrom(mask, w, h, max) {
			const dist = new Uint8Array(w * h).fill(FAR);
			for (let i = 0; i < w * h; i++) if (mask[i]) dist[i] = 0;
			for (let d = 1; d <= max; d++) {
				const next = [];
				for (let y = 0; y < h; y++) {
					for (let x = 0; x < w; x++) {
						if (dist[y * w + x] !== FAR) continue;
						search: for (let dy = -1; dy <= 1; dy++) {
							for (let dx = -1; dx <= 1; dx++) {
								const nx = x + dx, ny = y + dy;
								if (nx >= 0 && ny >= 0 && nx < w && ny < h && dist[ny * w + nx] === d - 1) {
									next.push(y * w + x);
									break search;
								}
							}
						}
					}
				}
				for (const i of next) dist[i] = d;
			}
			return dist;
		}

		/** a toward S at every pixel exactly d device px from the mask, sorted. */
		function strengthsAt(dist, d, w, h, x0, y0, G) {
			const v = [S[0] - G[0], S[1] - G[1], S[2] - G[2]];
			const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
			const a = [];
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (dist[y * w + x] !== d) continue;
					const R = px(x0 + x, y0 + y);
					const k = ((R[0] - G[0]) * v[0] + (R[1] - G[1]) * v[1] + (R[2] - G[2]) * v[2]) / vv;
					a.push(Math.min(1, Math.max(0, k)));
				}
			}
			return a.sort((p, q) => p - q);
		}

		const rows = overlay.rows.map((row) => {
			const G = hex(row.ground);
			const x0 = row.x * dpr, tx0 = row.tx * dpr, y0 = row.y * dpr;
			const w = row.w * dpr, h = row.h * dpr;
			const span = Math.hypot(S[0] - G[0], S[1] - G[1], S[2] - G[2]);

			// The core: every pixel where the glyphs paint, from the twin.
			const core = new Uint8Array(w * h);
			let coreCount = 0;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (maxDiff(px(x0 + x, y0 + y), px(tx0 + x, y0 + y)) > ${CORE_DIFF}) {
						core[y * w + x] = 1;
						coreCount++;
					}
				}
			}
			const dist = distanceFrom(core, w, h, Math.max(4, 2 * dpr));

			// The twin changed the glyphs and nothing else: exact agreement
			// more than 2 device px from the core.
			let twinMismatch = 0, twinMaxDiff = 0;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (dist[y * w + x] <= 2) continue;
					const diff = maxDiff(px(x0 + x, y0 + y), px(tx0 + x, y0 + y));
					if (diff > 0) { twinMismatch++; twinMaxDiff = Math.max(twinMaxDiff, diff); }
				}
			}

			// The far strip decodes as G exactly.
			let farOff = 0, farMaxDiff = 0;
			for (let y = 2 * dpr; y < h - 2 * dpr; y++) {
				for (let x = w - ${FAR_STRIP + 4} * dpr; x < w - 4 * dpr; x++) {
					const diff = maxDiff(px(x0 + x, y0 + y), G);
					if (diff > 0) { farOff++; farMaxDiff = Math.max(farMaxDiff, diff); }
				}
			}

			// The ring: one CSS px out from the glyph, the device pixels at
			// distance dpr (at DPR 1, the core's 8-adjacent neighbours).
			const a = strengthsAt(dist, dpr, w, h, x0, y0, G);

			// Every device-pixel layer, for the record.
			const layers = [1, 2, 3, 4].map((d) => {
				const v = strengthsAt(dist, d, w, h, x0, y0, G);
				return {d, ring: v.length, p10: pct(v, ${PERCENTILE}), median: pct(v, 0.5)};
			});

			// The plan's first rule, as a diagnostic: core within LITERAL_CORE
			// of the text colour, ring its 8-adjacent neighbours.
			const literalCore = new Uint8Array(w * h);
			let literalCount = 0;
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					if (maxDiff(px(x0 + x, y0 + y), text) <= ${LITERAL_CORE}) {
						literalCore[y * w + x] = 1;
						literalCount++;
					}
				}
			}
			const groundIsCore = maxDiff(G, text) <= ${LITERAL_CORE};
			const la = groundIsCore ? [] : strengthsAt(distanceFrom(literalCore, w, h, 1), 1, w, h, x0, y0, G);

			return {
				face: row.face,
				sample: row.sample,
				reference: row.reference,
				name: row.name,
				ground: row.ground,
				span: Math.round(span * 10) / 10,
				skipped: span < ${MIN_SPAN},
				core: coreCount,
				ring: a.length,
				p10: pct(a, ${PERCENTILE}),
				median: pct(a, 0.5),
				min: a.length ? a[0] : null,
				twinMismatch,
				twinMaxDiff,
				farOff,
				farMaxDiff,
				layers,
				literal: groundIsCore
					? {degenerate: "the ground is within ${LITERAL_CORE} of the text colour, so it is all core", core: literalCount}
					: {core: literalCount, ring: la.length, p10: pct(la, ${PERCENTILE}), median: pct(la, 0.5)},
			};
		});

		return {
			W,
			H,
			grey: px(2 * dpr, 2 * dpr),
			rows,
		};
	})()`;
}

const f3 = (v) => (v === null || v === undefined ? "  –  " : v.toFixed(3));

export default async function run(page) {
	mkdirSync(page.outDir, {recursive: true});
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.click(`.channel-list-item[data-name="#seance"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.waitFor(`document.querySelector("#chat .msg")`, {label: "the join burst"});
	await page.sleep(1000);

	const peer = await neighbour(`${NICK}n`);
	peer.say(`hello from the neighbour ${RUN}`);
	await page.waitFor(OTHERS_LINE, {label: "the neighbour's line"});

	await pickPs(page);
	page.check(
		"the stylesheet is themes/ps.css",
		(await page.evaluate(`document.getElementById("theme").getAttribute("href")`)) ===
			"themes/ps.css"
	);
	await page.waitFor(OTHERS_LINE, {label: "the neighbour's line, under ps"});

	// ---- the treatments, as computed

	const read = await page.evaluate(READ_TREATMENTS);
	peer.quit();
	console.log(`html font-size ${read.htmlFontSize} (step ${read.fontSizeStep ?? "default"})`);

	for (const state of ["ink", "light"]) {
		for (const face of FACES) {
			const r = read[state][face];
			console.log(
				`${state} ${face}: ${r.font["font-weight"]} ${r.font["font-size"]}/${r.font["line-height"]} ` +
					`${r.font["font-family"]}; color ${r.color}; text-shadow ${r.textShadow}`
			);
		}
	}

	page.check(
		`the ink treatment's halo is #ebf5fd (${read.ink.words.textShadow})`,
		read.ink.words.textShadow.split("rgb(235, 245, 253)").length === 4
	);
	page.check(
		`the light treatment's shadow is the 70/45/35 % black (${read.light.words.textShadow})`,
		/rgba\(0, 0, 0, 0\.7\).*rgba\(0, 0, 0, 0\.45\).*rgba\(0, 0, 0, 0\.35\)/.test(
			read.light.words.textShadow
		)
	);
	page.check(
		`the light treatment's outline (B) is eight 1px offsets at 78 % black (${
			read.light.words.textShadow.split("0.78)").length - 1
		} found)`,
		read.light.words.textShadow.split("0.78)").length - 1 === 8
	);
	page.check(
		`under it, the faint second ring is eight 2px offsets at 28 % black (${
			read.light.words.textShadow.split("0.28)").length - 1
		} found)`,
		read.light.words.textShadow.split("0.28)").length - 1 === 8 &&
			read.light.words.textShadow.indexOf("0.28)") >
				read.light.words.textShadow.lastIndexOf("0.78)")
	);
	page.check(
		`ink text is #1b2638 (${read.ink.words.color})`,
		read.ink.words.color === "rgb(27, 38, 56)"
	);
	page.check(
		`light text is white (${read.light.words.color})`,
		read.light.words.color === "rgb(255, 255, 255)"
	);
	// The computed family list quotes a name with a space or a figure
	// ("Source Sans 3"), so the first entry is read with its quotes off.
	const firstFamily = (font) => font["font-family"].split(",")[0].trim().replace(/^"|"$/g, "");
	page.check(
		`the words are Source Sans 3 500 (${read.ink.words.font["font-family"]} ${read.ink.words.font["font-weight"]})`,
		firstFamily(read.ink.words.font) === "Source Sans 3" &&
			read.ink.words.font["font-weight"] === "500"
	);
	page.check(
		`the nick is Newsreader 700 (${read.ink.nick.font["font-family"]} ${read.ink.nick.font["font-weight"]})`,
		firstFamily(read.ink.nick.font) === "Newsreader" &&
			read.ink.nick.font["font-weight"] === "700"
	);

	// ---- measure

	const results = [];

	for (const dpr of DPRS) {
		await page.send("Emulation.setDeviceMetricsOverride", {
			width: VIEW_W,
			height: VIEW_H,
			deviceScaleFactor: dpr,
			mobile: false,
		});
		await page.evaluate(PAINTED);
		await page.sleep(300);

		for (const [treatment, t] of Object.entries(TREATMENTS)) {
			const all = rowsOf(t);

			for (let k = 0; k * CHUNK < all.length; k++) {
				const rows = all.slice(k * CHUNK, (k + 1) * CHUNK);
				const where = `${treatment} dpr ${dpr} overlay ${k + 1}`;
				const overlay = await page.evaluate(buildOverlay(t, rows, read[treatment]));
				page.check(
					`${where}: the fonts are loaded`,
					overlay.fontsReady.every(([, ok]) => ok)
				);
				page.check(
					`${where}: the text ends ${Math.round(
						SWATCH_W + MARGIN - overlay.rightmost
					)}px before the swatch's right edge, clear of the far strip`,
					overlay.rightmost < MARGIN + SWATCH_W - FAR_STRIP - 4 - 24
				);
				await page.evaluate(PAINTED);
				await page.sleep(200);

				const shot = await page.send("Page.captureScreenshot", {
					format: "png",
					clip: {x: 0, y: 0, width: overlay.width, height: overlay.height, scale: 1},
				});
				const file = join(
					page.outDir,
					`ps-calibration-${treatment}-dpr${dpr}-${k + 1}.png`
				);
				writeFileSync(file, Buffer.from(shot.data, "base64"));
				console.log(`shot ${file}`);

				const m = await page.evaluate(measure(shot.data, overlay, dpr, t));
				page.check(
					`${where}: the decoded image is the clip times the DPR (${m.W}×${m.H})`,
					m.W === overlay.width * dpr && m.H === overlay.height * dpr
				);
				page.check(
					`${where}: the overlay's grey decodes as ${OVERLAY_GREY} (${m.grey})`,
					m.grey.every((c) => c === OVERLAY_GREY)
				);

				for (const r of m.rows) {
					const at = `${treatment} ${r.face} "${r.sample}" dpr ${dpr} ${r.ground} (${r.name})`;
					page.check(
						`${at}: the far strip is G exactly (${r.farOff} px off, by up to ${r.farMaxDiff})`,
						r.farOff === 0
					);
					page.check(
						`${at}: the twin agrees beyond 2 px of the core (${r.twinMismatch} px off, by up to ${r.twinMaxDiff})`,
						r.twinMismatch === 0
					);
					page.check(`${at}: a core is found (${r.core} px)`, r.core > 0);
					page.check(
						`${at}: the ring has at least ${MIN_RING} px (${r.ring})`,
						r.ring >= MIN_RING
					);
					results.push({treatment, dpr, ...r});
				}
			}
		}

		await page.evaluate(`document.getElementById("ps-calibrate")?.remove()`);
	}

	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});

	// ---- report

	console.log(
		"\nThe ring one CSS px out. Diagnostics: the first device pixel out (d1), and the" +
			"\nplan's first rule (core within 40 of the text colour, its 8-adjacent ring)." +
			"\n\ntreatment face  dpr ground   name          sample               p10    median  ring   d1 p10   literal p10 / median / ring"
	);

	for (const r of results) {
		const lit = r.literal.degenerate
			? "ground is core"
			: `${f3(r.literal.p10)} / ${f3(r.literal.median)} / ${r.literal.ring}`;
		const main = r.skipped
			? `skipped: |S − G| = ${r.span} < ${MIN_SPAN}  `
			: `${f3(r.p10)}  ${f3(r.median)}   ${String(r.ring).padEnd(5)}  ${f3(r.layers[0].p10)}`;
		console.log(
			`${r.treatment.padEnd(9)} ${r.face.padEnd(5)} ${r.dpr}   ${r.ground}  ${r.name.padEnd(
				12
			)}  ${JSON.stringify(r.sample).padEnd(20)} ${main}    ${lit}`
		);
	}

	console.log("\np10 / median by distance from the core, in device px");

	for (const r of results.filter((x) => !x.skipped)) {
		console.log(
			`${r.treatment.padEnd(6)} ${r.face.padEnd(5)} dpr ${r.dpr} ${r.name.padEnd(
				11
			)} ${JSON.stringify(r.sample).padEnd(20)} ` +
				r.layers.map((l) => `d${l.d} ${f3(l.p10)} / ${f3(l.median)}`).join("   ")
		);
	}

	const minima = {};

	for (const treatment of Object.keys(TREATMENTS)) {
		const kept = results.filter((r) => r.treatment === treatment && !r.skipped);
		const lowest = (list) => list.reduce((m, r) => (r.p10 < m.p10 ? r : m));
		const low = lowest(kept.filter((r) => !r.reference));
		const sample = lowest(kept.filter((r) => r.reference));
		minima[treatment] = {
			p10: low.p10,
			at: `${low.face} "${low.sample}" dpr ${low.dpr} ${low.ground} (${low.name})`,
			// Floored, never rounded up: the recorded strength may only understate the measured.
			records: Math.floor(Math.min(0.6, low.p10) * 10000) / 10000,
			sample: {p10: sample.p10, at: `${sample.face} dpr ${sample.dpr} ${sample.ground}`},
		};
		console.log(
			`\nminimum ${treatment}: ${low.p10.toFixed(6)} at ${minima[treatment].at}; ` +
				`min(0.6, measured), floored = ${minima[treatment].records.toFixed(4)}` +
				` (the samples alone: ${sample.p10.toFixed(6)} at ${minima[treatment].sample.at})`
		);
	}

	// ---- the sanity gates

	for (const r of results.filter(
		(x) => x.treatment === "light" && x.name === "grass" && x.reference
	)) {
		page.check(
			`the shadow over grass measures clearly above 0 (${r.face} dpr ${r.dpr}: ${f3(r.p10)})`,
			r.p10 > GRASS_FLOOR
		);
	}

	for (const dpr of DPRS.filter((d) => d !== 1)) {
		for (const r1 of results.filter((x) => x.dpr === 1 && !x.skipped)) {
			const r2 = results.find(
				(x) =>
					x.dpr === dpr &&
					x.treatment === r1.treatment &&
					x.face === r1.face &&
					x.sample === r1.sample &&
					x.ground === r1.ground
			);
			const what = `${r1.treatment} ${r1.face} "${r1.sample}" ${r1.ground}`;

			if (r1.reference) {
				page.check(
					`${what}: DPR ${dpr} within ${DPR_SPREAD} of DPR 1 (${f3(r1.p10)} → ${f3(
						r2.p10
					)})`,
					Math.abs(r2.p10 - r1.p10) <= DPR_SPREAD
				);
			} else {
				page.check(
					`${what}: DPR ${dpr} no weaker than DPR 1 by more than ${DPR_SPREAD} (${f3(
						r1.p10
					)} → ${f3(r2.p10)})`,
					r2.p10 >= r1.p10 - DPR_SPREAD
				);
			}
		}
	}

	const out = join(page.outDir, "ps-calibration.json");
	writeFileSync(
		out,
		JSON.stringify(
			{
				date: new Date().toISOString(),
				method: {
					core: `real and twin (${TWIN_TEXT} text) differ by more than ${CORE_DIFF} in some channel`,
					ring: "non-core pixels one CSS px out: Chebyshev distance DPR device px from the core (at DPR 1, its 8-adjacent neighbours)",
					strength: "dot(R − G, S − G) / |S − G|², clipped to [0, 1]",
					percentile: `${PERCENTILE} (nearest rank, index floor(q (n − 1)))`,
					skip: `|S − G| < ${MIN_SPAN}, Euclidean in 0–255 sRGB`,
					literal: `diagnostic only: core within ${LITERAL_CORE} (max channel) of the text colour`,
				},
				phrases: PHRASES,
				samples: SAMPLES,
				read,
				results,
				minima,
			},
			null,
			"\t"
		)
	);
	console.log(`\nwrote ${out}`);
}
