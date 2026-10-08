#!/usr/bin/env node
/* eslint-disable no-console */
// A contact sheet of one of the <3 theme's animals: twelve screenshots of the
// visit, taken across the window the animal is actually visible, stitched into
// one PNG grid you can open (or hand to a model) and read pose by pose.
//
//   node tools/heart/contact-sheet.mjs puppy
//   node tools/heart/contact-sheet.mjs puppy --out=tmp/sheet-puppy.png
//   node tools/heart/contact-sheet.mjs bunny --times=1,4,8,12 --height=200
//   node tools/heart/contact-sheet.mjs --all --out=tmp/sheet-cast.png
//
// Options:
//   --all            the whole cast, one row per animal, four cells each, each
//                    at its own magnification (CAST below): a picture of every
//                    animal in one PNG. It photographs eight visits end to end,
//                    so it takes about four minutes. Rows are *not* to the same
//                    scale — the bird is 10 % of its own box, so a row that
//                    showed it at its true size beside the horse would show a
//                    speck — and the sheet says so under the title.
//   --out=<path>     where to write the PNG (default tmp/heart-<animal>-sheet.png)
//   --times=a,b,c    sample times in seconds, **relative to the sequence's
//                    `first`** — the same clock the audit's `onStage` and
//                    `tExit` are in, so `--times=0` is the moment the visit
//                    starts, not the moment the page loads. Any number of them;
//                    the grid grows to fit.
//   --height=<px>    the animal's rendered height (default 150); raise it and
//                    lower --cols if a small animal reads too small
//   --cols=<n>       columns in the grid (default 4)
//   --cell=<w>,<h>   the cell's width and height as shares of the animal's
//                    rendered height (default 2.4,1.5). A rig whose box is
//                    mostly empty — the bird's is 800 units tall for 76 units
//                    of bird, because the empty sky above it *is* its route —
//                    has to be shot at a large --height to be legible at all,
//                    and the default cell would then be enormous and almost
//                    entirely sky. Narrow the cell instead: the bird reads at
//                    `--height=520 --cell=0.5,1.35 --cols=6`.
//   --slot=<token>   the animal's `--ps-<animal>-h` from the theme, which is
//                    what the ground band and the box's rest height are shares
//                    of. The default is the animal's own token, read from its
//                    rig's `theme` block, so footing is right without passing
//                    anything; give it a number to see the animal against some
//                    other slot's band.
//   --far            use the distant-visitor tint; the default is the near file,
//                    falling back to `-far` for an animal that has no near file
//                    (the dolphin never comes close)
//   --chrome=<bin>   the Chromium binary, passed to the driver ($CHROME_BIN is
//                    the other way; the default is `chromium` on PATH)
//
// Why a browser at all: the files animate with SMIL, and SMIL inside a CSS
// `background-image` cannot be seeked from outside — no `setCurrentTime`, no
// DOM to reach. The only way to see second 9 of the visit is to wait nine
// seconds, so the tool loads one cell, waits, shoots, waits, shoots. A twelve
// cell sheet of the puppy takes about as long as one visit (~40 s).
//
// Chromium is launched through `tools/browser-drive.mjs` and nothing else:
// this container's /dev/shm is 64 MB and the renderer dies rasterising these
// layers without the `--disable-dev-shm-usage` the driver already passes. Run
// directly, this file re-spawns itself as a driver scenario.
//
// What a cell is: the animal's own stage is 16–24 times as wide as the animal
// (tools/heart/README.md § The pipeline), so a cell showing the whole stage
// would show a 1/24-scale animal. Each cell therefore *tracks* it — the
// background-position for a shot is computed from the file's own travel curve
// so the animal lands in the middle of the cell. That holds through a `turn`
// too: the mirror is a scale about the animal's own centre, bracketed by two
// static translates (`lib/svg.mjs`), so the centre the tracking follows is the
// one point the flip leaves alone. Everything else about the cell mirrors the
// theme's slot: `background-size: auto <height>`, the box's bottom tucked into
// a flat ground band, over the theme's sky.

import {spawn} from "node:child_process";
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {basename, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const THEME = join(ROOT, "client/themes/ps");
const DRIVER = join(ROOT, "tools/browser-drive.mjs");

/** The theme's sky and ground (client/themes/ps.css `--ps-sky`, `--ps-ground`). */
const SKY = "#dbeeff";
const GROUND = "#b7dcc2";
/** The cell's proportions, as shares of the animal's rendered height, from
 * the theme's own `--strip` ratios: a ground band 0.14 strip tall under an
 * animal whose box bottom sits 0.12 strip above the foot of the meadow.
 *
 * Both are shares of a *strip*, so turning them into shares of the rendered
 * height needs the animal's own `--ps-<animal>-h` — which is not in the
 * SVG, but is in the rig: every cast rig carries a `theme` block holding the
 * token the stylesheet must use (`tools/heart/rigs/<animal>.mjs`, checked by
 * `test/themes/ps.ts`). `slotOf` reads it from there, so the band under an
 * animal is the band it actually gets. This was a hardcoded 0.44 until the
 * cast grew and four boxes with it, and a wrong band reads as an animal
 * floating above the grass or sunk into it. A rig with no `theme` block — a
 * held animal, cast in no scene — falls back to it. */
const SLOT = 0.44;

/** The animal's own `--ps-<animal>-h`, from its rig. */
async function slotOf(name) {
	try {
		const def = (await import(`./rigs/${name}.mjs`)).default;
		return def.theme?.height ?? SLOT;
	} catch {
		return SLOT;
	}
}

/**
 * `--all`: the whole cast, one row each, at the magnification that makes the
 * animal legible rather than at a shared scale. `height` is the rendered height
 * of the animal's *box* in px — chosen so the body inside that box comes out at
 * about the same size for everything that walks, which is why the numbers vary
 * so much: the frog's box holds its hop and the bird's 800 units hold 76 units
 * of bird, because the sky above it is its flight path. Rows are therefore not
 * comparable in size, and the sheet's subtitle says so.
 *
 * The cell around it is **not** a hand-picked pair. A cell has to hold the
 * whole box plus the gap the theme leaves under it (`sit`, 0.12 strip, which is
 * 0.12/slot of the rendered height — two thirds of it for the ladybug, whose
 * token is 0.19), and it has to be wider than the box or the animal is cut off
 * at the sides. Both come out of `cellFor` below; the first version of this
 * table guessed them and clipped the frog and the ladybug to unreadable blobs.
 */
const CAST = [
	{name: "horse", height: 132},
	{name: "deer", height: 128},
	{name: "puppy", height: 184},
	{name: "bunny", height: 124},
	{name: "kitten", height: 136},
	{name: "frog", height: 160},
	{name: "ladybug", height: 150},
	{name: "bird", height: 460},
];

/** The cell for one row of `--all`, as shares of the rendered height: wide
 * enough for the box with room either side, tall enough for the box *and* the
 * gap the slot leaves under it. `minW` keeps a very tall box (the bird's) from
 * asking for a sliver of a cell. */
function cellFor(box, slot, minW = 0.8) {
	return [Math.max(minW, (box.w / box.h) * 1.25), (1 + sit(slot)) * 1.06];
}
const band = (slot) => 0.14 / slot;
const sit = (slot) => 0.12 / slot;
const CELL_W = 2.4;
const CELL_H = 1.5;
/** `--cell=w,h` overrides both, in the same units (shares of the height). */
function cellShape(spec) {
	if (!spec) {
		return [CELL_W, CELL_H];
	}

	const [w, h] = spec.split(",").map(Number);

	if (!(w > 0) || !(h > 0)) {
		throw new Error(`--cell wants two positive numbers, got ${spec}`);
	}

	return [w, h];
}
/** Drawn around the grid, in px. */
const GAP = 8;
const MARGIN = 12;
const LABEL = 22;
const TITLE = 26;
/** How long after `showAt` positions the cell the screenshot is rasterised —
 * one CDP round trip. Under a tenth of a second of travel, a few px. */
const LEAD = 0.08;
const DEFAULT_SAMPLES = 12;

// ------------------------------------------------------------ the files

/** `viewBox="a b c d"` as four numbers. */
function viewBox(svg) {
	const m = svg.match(/viewBox="([-\d. ]+)"/);

	if (!m) {
		throw new Error("no viewBox");
	}

	const [x, y, w, h] = m[1].trim().split(/\s+/).map(Number);
	return {x, y, w, h};
}

/**
 * What one animal's files say about its visit. Everything here is read back
 * out of the committed SVG, not recomputed: the file is what the browser
 * actually animates.
 *
 * - `period`, `first`: the loop, cross-checked against the rig.
 * - `visible`: the two middle keyTimes of the outer group's fade — the window
 *   between "fully faded in" and "starting to fade out", which is the window
 *   worth photographing. It is *not* `first … first + onStage`: the sequence
 *   keeps sampling past `tExit` and the animal travels on invisibly, so the
 *   last second or two of `onStage` is a blank cell.
 * - `travel`: the outer translate's own keyframes (absolute times, user units).
 * - `box`: the animal's own box within the stage, from the still's viewBox —
 *   the stage file's viewBox is the whole stage and cannot give it.
 */
function readAnimal(name, far) {
	const near = join(THEME, `${name}.svg`);
	const file = far || !existsSync(near) ? join(THEME, `${name}-far.svg`) : near;

	if (!existsSync(file)) {
		throw new Error(`no ${basename(file)} in client/themes/ps — generate it first`);
	}

	const svg = readFileSync(file, "utf8");
	const stage = viewBox(svg);
	const nearStill = join(THEME, `${name}-still.svg`);
	const still = existsSync(nearStill) ? nearStill : join(THEME, `${name}-far-still.svg`);
	const box = viewBox(readFileSync(still, "utf8"));
	const fade = svg.match(/values="0;0;1;1;0;0" keyTimes="([^"]+)" dur="([\d.]+)s"/);

	if (!fade) {
		throw new Error(`${basename(file)} has no visit fade to read the visible window from`);
	}

	const period = Number(fade[2]);
	const kt = fade[1].split(";").map(Number);
	// `type="translate" calcMode="linear"` with nothing between the two is the
	// travel; the puppy's hearts carry a translate of their own, but it is
	// additive (`type="translate" additive="sum"`) and does not match.
	const move = svg.match(
		/type="translate" calcMode="linear" values="([^"]*)" keyTimes="([^"]*)"/
	);

	if (!move) {
		throw new Error(`${basename(file)} has no travel translate`);
	}

	// Informational only: the clip chain's total is the audit's `onStage`.
	let onStage = 0;

	for (const clip of svg.match(/<animate id="s\d+"[^>]*\/>/g) ?? []) {
		const dur = Number(clip.match(/dur="([\d.]+)s"/)[1]);
		const rep = Number((clip.match(/repeatCount="(\d+)"/) ?? [0, 1])[1]);
		onStage += dur * rep;
	}

	const first = Number((svg.match(/begin="([\d.]+)s;s\d+\.end/) ?? [0, 0])[1]);
	return {
		file,
		period,
		first,
		onStage,
		visible: [kt[2] * period, kt[3] * period],
		box,
		stage,
		travel: {
			times: move[2].split(";").map((t) => Number(t) * period),
			xs: move[1].split(";").map((v) => Number(v.split(" ")[0])),
		},
	};
}

/** Sample times (relative to `first`) at the centres of `n` equal slices of the
 * visible window, so neither the fade-in nor the fade-out boundary is ever the
 * cell that gets photographed. */
function defaultTimes(a, n = DEFAULT_SAMPLES) {
	const [from, to] = a.visible.map((t) => t - a.first);
	return Array.from({length: n}, (_, i) => from + ((to - from) * (i + 0.5)) / n);
}

// ------------------------------------------------------------ the pages

/** The one cell, with its own tracking maths: `showAt(t)` puts the animal's
 * centre in the middle of the cell for sequence time `t`. */
function cellPage(a, geom) {
	const track = {
		period: a.period,
		first: a.first,
		times: a.travel.times,
		xs: a.travel.xs,
		// user unit → px, from the image's own height
		scale: geom.animal / a.stage.h,
		centre: a.box.x + a.box.w / 2,
		cellW: geom.cellW,
	};
	return `<title>${a.file} cell</title>
<style>
	html, body { margin: 0; padding: 0; background: #fff; }
	#cell {
		width: ${geom.cellW}px;
		height: ${geom.cellH}px;
		background-color: ${SKY};
		background-image: url("${basename(a.file)}"), linear-gradient(${GROUND}, ${GROUND});
		background-repeat: no-repeat;
		background-size: auto ${geom.animal}px, 100% ${geom.band}px;
		background-position: 0 calc(100% - ${geom.sit}px), 0 100%;
	}
</style>
<div id="cell"></div>
<script>
const T = ${JSON.stringify(track)};
const cell = document.getElementById("cell");
let t0 = null;

/** The travel translate at absolute time \`at\`, linearly between keyframes. */
function travelAt(at) {
	const t = ((at % T.period) + T.period) % T.period;
	const n = T.times.length;

	if (t <= T.times[0]) return T.xs[0];

	for (let i = 1; i < n; i++) {
		if (t <= T.times[i]) {
			const span = T.times[i] - T.times[i - 1];
			const k = span > 0 ? (t - T.times[i - 1]) / span : 0;
			return T.xs[i - 1] + (T.xs[i] - T.xs[i - 1]) * k;
		}
	}

	return T.xs[n - 1];
}

/** Seconds since the image started animating. */
window.__sheetElapsed = () => (t0 === null ? -1 : (performance.now() - t0) / 1000);

/** Centre the animal for sequence time \`t\` (relative to \`first\`); returns it.
 * Both layers are restated: background-position-x takes one value per layer,
 * and a single value would slide the ground band off with the animal. */
window.__sheetShowAt = (t) => {
	const x = (T.centre + travelAt(T.first + t)) * T.scale;
	cell.style.backgroundPositionX = (T.cellW / 2 - x).toFixed(1) + "px, 0px";
	return t;
};

// The SMIL clock of an SVG used as a background-image starts when the image is
// first painted: one frame after load is as close to that moment as the page
// can get, and the first sample is seconds away.
window.addEventListener("load", () => {
	requestAnimationFrame(() => {
		t0 = performance.now();
		window.__sheetShowAt(0);
		window.__sheetReady = true;
	});
});
</script>
`;
}

/** The stitcher: a canvas, the shots as data URIs, one PNG back out. No image
 * library — the browser is already here, and a data URI does not taint a
 * canvas the way a file:// image would. */
function gridPage(shots, geom, title) {
	const cols = Math.min(geom.cols, shots.length);
	const rows = Math.ceil(shots.length / cols);
	const w = MARGIN * 2 + cols * geom.cellW + (cols - 1) * GAP;
	const h = MARGIN * 2 + TITLE + rows * (geom.cellH + LABEL) + (rows - 1) * GAP;
	return `<title>contact sheet</title>
<style>html, body { margin: 0; background: #fff; }</style>
<canvas id="sheet" width="${w}" height="${h}"></canvas>
<script>
const SHOTS = ${JSON.stringify(shots)};
const G = ${JSON.stringify({...geom, cols, rows, w, h})};
const c = document.getElementById("sheet").getContext("2d");
c.fillStyle = "#ffffff";
c.fillRect(0, 0, G.w, G.h);
c.fillStyle = "#222222";
c.font = "600 15px system-ui, sans-serif";
c.textBaseline = "top";
c.fillText(${JSON.stringify(title)}, ${MARGIN}, ${MARGIN - 4});

window.__sheetPng = (async () => {
	const imgs = await Promise.all(SHOTS.map((s) => new Promise((res, rej) => {
		const img = new Image();
		img.onload = () => res(img);
		img.onerror = () => rej(new Error("a shot did not decode"));
		img.src = s.png;
	})));

	for (let i = 0; i < imgs.length; i++) {
		const col = i % G.cols;
		const row = Math.floor(i / G.cols);
		const x = ${MARGIN} + col * (G.cellW + ${GAP});
		const y = ${MARGIN + TITLE} + row * (G.cellH + ${LABEL} + ${GAP});
		c.fillStyle = "#444444";
		c.font = "13px system-ui, sans-serif";
		c.fillText(SHOTS[i].label, x + 2, y + 3);
		c.drawImage(imgs[i], x, y + ${LABEL});
		c.strokeStyle = "#94a8b8";
		c.lineWidth = 1;
		c.strokeRect(x + 0.5, y + ${LABEL} + 0.5, G.cellW - 1, G.cellH - 1);
	}

	return document.getElementById("sheet").toDataURL("image/png");
})();
</script>
`;
}

/** The `--all` stitcher: one row per animal, each row at its own cell size,
 * so a tall-boxed animal can be shot larger than a wide-boxed one. Same canvas
 * trick as `gridPage`. */
function rowsPage(rows, title, subtitle) {
	const width =
		MARGIN * 2 +
		Math.max(...rows.map((r) => r.shots.length * r.cellW + (r.shots.length - 1) * GAP));
	const height = MARGIN * 2 + TITLE * 2 + rows.reduce((h, r) => h + LABEL + r.cellH + GAP, 0);
	return `<title>contact sheet</title>
<style>html, body { margin: 0; background: #fff; }</style>
<canvas id="sheet" width="${width}" height="${height}"></canvas>
<script>
const ROWS = ${JSON.stringify(rows)};
const c = document.getElementById("sheet").getContext("2d");
c.fillStyle = "#ffffff";
c.fillRect(0, 0, ${width}, ${height});
c.textBaseline = "top";
c.fillStyle = "#222222";
c.font = "600 16px system-ui, sans-serif";
c.fillText(${JSON.stringify(title)}, ${MARGIN}, ${MARGIN - 4});
c.fillStyle = "#666666";
c.font = "13px system-ui, sans-serif";
c.fillText(${JSON.stringify(subtitle)}, ${MARGIN}, ${MARGIN + 17});

window.__sheetPng = (async () => {
	let y = ${MARGIN + TITLE * 2};

	for (const row of ROWS) {
		c.fillStyle = "#222222";
		c.font = "600 13px system-ui, sans-serif";
		c.fillText(row.label, ${MARGIN}, y + 3);
		const imgs = await Promise.all(row.shots.map((s) => new Promise((res, rej) => {
			const img = new Image();
			img.onload = () => res(img);
			img.onerror = () => rej(new Error("a shot did not decode"));
			img.src = s.png;
		})));

		for (let i = 0; i < imgs.length; i++) {
			const x = ${MARGIN} + i * (row.cellW + ${GAP});
			c.drawImage(imgs[i], x, y + ${LABEL});
			c.strokeStyle = "#94a8b8";
			c.lineWidth = 1;
			c.strokeRect(x + 0.5, y + ${LABEL} + 0.5, row.cellW - 1, row.cellH - 1);
		}

		y += ${LABEL} + row.cellH + ${GAP};
	}

	return document.getElementById("sheet").toDataURL("image/png");
})();
</script>
`;
}

// ------------------------------------------------------------ the run

/** One animal's cells: builds its page, waits its visit out, shoots it. */
async function shootAnimal(page, name, {far, animal, cw, ch, slot, spec, cols, samples}) {
	const a = readAnimal(name, far);
	const geom = {
		animal,
		band: Math.round(animal * band(slot)),
		sit: Math.round(animal * sit(slot)),
		cellW: Math.round(animal * cw),
		cellH: Math.round(animal * ch),
		cols,
	};
	const times = spec ? spec.split(",").map((s) => Number(s.trim())) : defaultTimes(a, samples);
	const dir = join(ROOT, "tmp", "heart-contact-sheet", name);
	mkdirSync(dir, {recursive: true});
	copyFileSync(a.file, join(dir, basename(a.file)));
	writeFileSync(join(dir, "cell.html"), cellPage(a, geom));

	console.log(
		`${name}: ${basename(a.file)}, visit ${a.first}–${(a.first + a.onStage).toFixed(1)} s ` +
			`of a ${a.period} s loop, visible ${a.visible[0].toFixed(1)}–${a.visible[1].toFixed(
				1
			)} s`
	);
	console.log(`  sampling t = ${times.map((t) => t.toFixed(1)).join(", ")} (after first)`);

	// A time outside the fade is a blank cell, which reads as a broken tool
	// rather than as a time nobody can see. Say so before the waiting starts.
	const outside = times.filter((t) => a.first + t < a.visible[0] || a.first + t > a.visible[1]);

	if (outside.length) {
		console.log(
			`  note: t = ${outside.map((t) => t.toFixed(1)).join(", ")} ${
				outside.length > 1 ? "are" : "is"
			} outside the visit's fade ` +
				`(${(a.visible[0] - a.first).toFixed(1)}–${(a.visible[1] - a.first).toFixed(
					1
				)} s) — those cells come out faint or empty, which is the file behaving`
		);
	}

	await page.goto(pathToFileURL(join(dir, "cell.html")).href);
	await page.waitFor("window.__sheetReady === true", {label: "the cell's image"});

	const shots = [];

	for (const t of times) {
		const target = a.first + t;

		for (;;) {
			const now = await page.evaluate("window.__sheetElapsed()");

			if (now >= target - LEAD) {
				break;
			}

			// page.sleep, not page.waitFor: a whole visit is longer than the
			// driver's 20 s wait timeout.
			await page.sleep(Math.min(1000, Math.ceil((target - LEAD - now) * 1000)));
		}

		await page.evaluate(`window.__sheetShowAt(window.__sheetElapsed() - ${a.first} + ${LEAD})`);
		const shot = await page.send("Page.captureScreenshot", {
			format: "png",
			clip: {x: 0, y: 0, width: geom.cellW, height: geom.cellH, scale: 1},
		});
		shots.push({png: `data:image/png;base64,${shot.data}`, label: `t = ${t.toFixed(1)} s`});
		console.log(`  shot ${shots.length}/${times.length} at t = ${t.toFixed(1)} s`);
	}

	return {a, geom, shots, times, dir};
}

/** Stitch a page of cells and write the PNG it hands back. */
async function stitch(page, html, dir, out) {
	writeFileSync(join(dir, "grid.html"), html);
	await page.goto(pathToFileURL(join(dir, "grid.html")).href);
	const url = await page.evaluate("window.__sheetPng");

	if (!url || !url.startsWith("data:image/png;base64,")) {
		throw new Error("the stitcher gave back no PNG");
	}

	mkdirSync(resolve(out, ".."), {recursive: true});
	writeFileSync(out, Buffer.from(url.slice("data:image/png;base64,".length), "base64"));
	console.log(`\ncontact sheet ${out}`);
}

/** Runs inside tools/browser-drive.mjs (this file is its own scenario). */
export default async function run(page) {
	const all = page.flags.has("--all");
	const name = page.opt("animal", null);

	if (!name && !all) {
		throw new Error("--animal=<name> is required (or --all for the whole cast)");
	}

	const far = page.flags.has("--far");
	const spec = page.opt("times", null);
	const cols = Number(page.opt("cols", 4));

	if (all) {
		const samples = Number(page.opt("samples", 4));
		const rows = [];
		const dir = join(ROOT, "tmp", "heart-contact-sheet", "cast");
		mkdirSync(dir, {recursive: true});

		for (const {name: animalName, height} of CAST) {
			const slot = Number(page.opt("slot", await slotOf(animalName)));
			const [cw, ch] = cellFor(readAnimal(animalName, far).box, slot);
			const {a, geom, shots, times} = await shootAnimal(page, animalName, {
				far,
				animal: height,
				cw,
				ch,
				slot,
				spec,
				cols: samples,
				samples,
			});
			rows.push({
				label:
					`${animalName} — box ${geom.animal}px, t = ` +
					`${times.map((t) => t.toFixed(1)).join(", ")} s after first, ` +
					`loop ${a.period} s`,
				cellW: geom.cellW,
				cellH: geom.cellH,
				shots,
			});
		}

		await stitch(
			page,
			rowsPage(
				rows,
				`the <3 theme's cast — ${rows.length} animals, ${rows[0].shots.length} moments of one visit each`,
				"each row at its own magnification, so every animal is legible: they are not to scale with one another"
			),
			dir,
			resolve(page.opt("sheet-out", join("tmp", "sheet-cast.png")))
		);
		return;
	}

	const [cw, ch] = cellShape(page.opt("cell", null));
	const slot = Number(page.opt("slot", await slotOf(name)));

	if (!(slot > 0)) {
		throw new Error(`--slot wants a positive height token, got ${page.opt("slot", SLOT)}`);
	}

	const {a, geom, shots, dir} = await shootAnimal(page, name, {
		far,
		animal: Number(page.opt("animal-height", 150)),
		cw,
		ch,
		slot,
		spec,
		cols,
		samples: DEFAULT_SAMPLES,
	});
	const title =
		`${name}${far || a.file.includes("-far") ? " (far)" : ""} — ` +
		`${shots.length} samples of a visit, t after first = ${a.first} s, loop ${a.period} s`;
	await stitch(
		page,
		gridPage(shots, geom, title),
		dir,
		resolve(page.opt("sheet-out", join("tmp", `heart-${name}-sheet.png`)))
	);
}

// ----------------------------------------------------------- the command

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
	const argv = process.argv.slice(2);
	const all = argv.includes("--all");
	const name = argv.find((x) => !x.startsWith("--"));
	const opt = (key) => argv.find((x) => x.startsWith(`--${key}=`))?.slice(key.length + 3);

	if (!name && !all) {
		console.error(
			"usage: node tools/heart/contact-sheet.mjs <animal> [--out=…] [--times=…]\n" +
				"       node tools/heart/contact-sheet.mjs --all [--out=…]"
		);
		process.exit(2);
	}

	const out = resolve(
		opt("out") ?? join("tmp", all ? "sheet-cast.png" : `heart-${name}-sheet.png`)
	);
	const args = [
		DRIVER,
		import.meta.filename,
		...(all ? ["--all"] : [`--animal=${name}`]),
		`--sheet-out=${out}`,
		"--no-ws",
		`--out=${join(ROOT, "tmp", "heart-contact-sheet", all ? "cast" : name, "shots")}`,
	];

	for (const [cli, driver] of [
		["times", "times"],
		["height", "animal-height"],
		["cols", "cols"],
		["cell", "cell"],
		["slot", "slot"],
		["samples", "samples"],
		// the driver's own: $CHROME_BIN is the other way to point it at a binary
		["chrome", "chrome"],
	]) {
		const v = opt(cli);

		if (v !== undefined) {
			args.push(`--${driver}=${v}`);
		}
	}

	if (argv.includes("--far")) {
		args.push("--far");
	}

	const child = spawn(process.execPath, args, {stdio: "inherit", cwd: ROOT});
	child.on("exit", (code) => process.exit(code ?? 1));
}
