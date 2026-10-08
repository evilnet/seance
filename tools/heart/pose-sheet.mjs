/* eslint-disable no-console */
// tools/heart/pose-sheet.mjs — the rig's own outline pipeline straight into a
// PNG grid, with no browser and no SVG.
//
//   node tools/heart/pose-sheet.mjs frog poses         # every named pose + the still
//   node tools/heart/pose-sheet.mjs frog gait 12       # 12 phases of each gait
//   node tools/heart/pose-sheet.mjs frog seq 0,2,4,6   # sequence times (seconds)
//   node tools/heart/pose-sheet.mjs kitten self        # rasteriser self-check
//   ... --out=tmp/x.png --scale=4 --cols=4
//   ... --view=8,8,126,102   # crop, for a rig whose box is mostly empty sky
//   ... --flat               # every layer one colour, the way -far.svg paints them
//
// This is the fast loop. `contact-sheet.mjs` photographs the shipped SVG through
// a real browser and has to wait out the animation in real time — a twelve-cell
// sheet costs about a visit, 40 s and up — so it is the honest final check but a
// slow way to tune a shape. This renders the same outlines the generator would
// emit, offline, in well under a second, so a pose can be judged and changed
// dozens of times before anything is generated at all. The frog took nine rounds
// here and three in the browser.
//
// Trust but verify: `self` renders the named animal's committed `-still.svg`
// pose through this rasteriser so you can compare it against the shipped file
// and satisfy yourself the offline picture is the same picture.
//
// PNG: 8-bit RGB, one IDAT, filter 0. Fill: even-odd scanline over the flat
// point list each outline already is, 3x supersampled.

import {deflateSync} from "node:zlib";
import {writeFileSync} from "node:fs";
import {outlineFrame, collect, paper} from "./lib/outline.mjs";
import {gaitPose, samplePoses} from "./lib/build.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
	const a = args.find((x) => x.startsWith(`--${k}=`));
	return a === undefined ? d : a.slice(k.length + 3);
};
const positional = args.filter((a) => !a.startsWith("--"));
const name = positional[0];
const cmd = positional[1] ?? "poses";
const arg = positional[2];
if (!name) {
	console.error(
		"usage: node tools/heart/pose-sheet.mjs <animal> [poses|gait|seq|self] [arg] [--out=] [--scale=] [--cols=]"
	);
	process.exit(2);
}
const SS = 3;
const SCALE = Number(opt("scale", 4));
const COLS = Number(opt("cols", 4));
const OUT = opt("out", `tmp/heart-${name}-poses.png`);

// ---------------------------------------------------------------- PNG
const crcTable = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();
const crc32 = (buf) => {
	let c = -1;
	for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}
function writePng(path, w, h, rgb) {
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	writeFileSync(
		path,
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", ihdr),
			chunk("IDAT", deflateSync(raw, {level: 9})),
			chunk("IEND", Buffer.alloc(0)),
		])
	);
}

// ------------------------------------------------------------ raster
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

/** Even-odd scanline fill of a flat closed polygon into an SS-supersampled buffer. */
function fillPoly(cov, w, h, pts) {
	const n = pts.length / 2;
	let ymin = Infinity;
	let ymax = -Infinity;
	for (let i = 1; i < pts.length; i += 2) {
		ymin = Math.min(ymin, pts[i]);
		ymax = Math.max(ymax, pts[i]);
	}
	const y0 = Math.max(0, Math.floor(ymin));
	const y1 = Math.min(h - 1, Math.ceil(ymax));
	const xs = [];
	for (let y = y0; y <= y1; y++) {
		const cy = y + 0.5;
		xs.length = 0;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const ax = pts[2 * i];
			const ay = pts[2 * i + 1];
			const bx = pts[2 * j];
			const by = pts[2 * j + 1];
			if (ay === by) continue;
			if (cy >= Math.min(ay, by) && cy < Math.max(ay, by)) {
				xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
			}
		}
		xs.sort((a, b) => a - b);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			const a = Math.max(0, Math.ceil(xs[k] - 0.5));
			const b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
			for (let x = a; x <= b; x++) cov[y * w + x] = 1;
		}
	}
}

/**
 * One cell: the outline layers of a pose, over the theme's sky, on a ground
 * band, in rig coordinates mapped by `view` ({x, y, w, h}).
 */
function renderCell(layers, view, cw, ch, fills) {
	const W = cw * SS;
	const H = ch * SS;
	const sx = W / view.w;
	const sy = H / view.h;
	const px = Buffer.alloc(W * H * 3);
	const sky = hex("#dbeeff");
	const ground = hex("#b7dcc2");
	const groundY = Math.round((100 - view.y) * sy);
	for (let y = 0; y < H; y++) {
		const c = y >= groundY ? ground : sky;
		for (let x = 0; x < W; x++) {
			px[(y * W + x) * 3] = c[0];
			px[(y * W + x) * 3 + 1] = c[1];
			px[(y * W + x) * 3 + 2] = c[2];
		}
	}
	layers.forEach((l, i) => {
		const cov = new Uint8Array(W * H);
		const p = new Array(l.pts.length);
		for (let k = 0; k < l.pts.length; k += 2) {
			p[k] = (l.pts[k] - view.x) * sx;
			p[k + 1] = (l.pts[k + 1] - view.y) * sy;
		}
		fillPoly(cov, W, H, p);
		const c = hex(fills[i]);
		for (let k = 0; k < cov.length; k++) {
			if (cov[k]) {
				px[k * 3] = c[0];
				px[k * 3 + 1] = c[1];
				px[k * 3 + 2] = c[2];
			}
		}
	});
	// box down to cw x ch
	const out = Buffer.alloc(cw * ch * 3);
	for (let y = 0; y < ch; y++) {
		for (let x = 0; x < cw; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			for (let dy = 0; dy < SS; dy++) {
				for (let dx = 0; dx < SS; dx++) {
					const k = ((y * SS + dy) * W + x * SS + dx) * 3;
					r += px[k];
					g += px[k + 1];
					b += px[k + 2];
				}
			}
			const k = (y * cw + x) * 3;
			out[k] = r / (SS * SS);
			out[k + 1] = g / (SS * SS);
			out[k + 2] = b / (SS * SS);
		}
	}
	return out;
}

function grid(cells, cw, ch) {
	const cols = Math.min(COLS, cells.length);
	const rows = Math.ceil(cells.length / cols);
	const gap = 4;
	const W = cols * cw + (cols + 1) * gap;
	const H = rows * ch + (rows + 1) * gap;
	const px = Buffer.alloc(W * H * 3, 0x22);
	cells.forEach((cell, i) => {
		const cx = gap + (i % cols) * (cw + gap);
		const cy = gap + Math.floor(i / cols) * (ch + gap);
		for (let y = 0; y < ch; y++) {
			cell.copy(px, ((cy + y) * W + cx) * 3, y * cw * 3, (y + 1) * cw * 3);
		}
	});
	return {px, W, H};
}

/** A paper.js item as a flat point list (for the --parts debug view). */
function flat(item) {
	const pts = [];
	const L = item.length;
	for (let k = 0; k < 120; k++) {
		const p = item.getPointAt((k / 120) * L);
		pts.push(p.x, p.y);
	}
	return pts;
}

// ------------------------------------------------------------- drive
const def = (await import(`./rigs/${name}.mjs`)).default;
const {rig} = def;
// every far outline in the lighter tint, the near one last and on top —
// a rig may have any number of far groups (the ladybug has four). `--flat`
// paints them all alike instead, which is what `<animal>-far.svg` does: a
// pair of shapes told apart only by tint is told apart by nothing there, and
// that is exactly where the ladybug read as a rabbit.
const FLAT = args.includes("--flat");
const fillsFor = (n) =>
	FLAT ? Array(n).fill("#7fb069") : [...Array(Math.max(0, n - 1)).fill("#a8c6a0"), "#7fb069"];

const poseOf = (p) => {
	const v = {};
	for (const ch of rig.channels()) v[ch.name] = p[ch.name] ?? p[ch.key] ?? ch.rest ?? 0;
	return v;
};

const frames = [];
if (cmd === "poses") {
	for (const [poseName, p] of Object.entries(rig.poses ?? {})) frames.push([poseName, poseOf(p)]);
	frames.push(["still", poseOf(rig.still ?? {})]);
} else if (cmd === "self") {
	// the committed <animal>-still.svg's own pose, to compare this rasteriser
	// against the shipped file before trusting a round of tuning to it
	frames.push(["still", poseOf(rig.still ?? {})]);
} else if (cmd === "gait") {
	const N = Number(arg ?? 12);
	for (const [gaitName, gait] of Object.entries(rig.gaits ?? {})) {
		const chans = rig.channels(gaitName);
		for (let i = 0; i < N; i++) {
			frames.push([
				`${gaitName} ${Math.round((i / N) * 100)}%`,
				gaitPose(gait, chans, i / N),
			]);
		}
	}
} else if (cmd === "seq") {
	const {poses} = samplePoses(def);
	for (const t of (arg ?? "0").split(",").map(Number)) {
		const f = poses.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
		frames.push([`t=${f.t.toFixed(2)}`, f.v]);
	}
}

// `--view=x,y,w,h` crops the render: a rig whose box is mostly empty sky (the
// bird's is 800 units tall for 76 units of bird) is unreadable at its own box.
const viewOpt = opt("view");
const view = viewOpt
	? (([x, y, w, h]) => ({x, y, w, h}))(viewOpt.split(",").map(Number))
	: {...rig.viewBox};
if (opt("fillet")) rig.fillet = Number(opt("fillet"));
const cw = Math.round(view.w * SCALE);
const ch = Math.round(view.h * SCALE);
const PARTS = args.includes("--parts");
const shades = [
	"#c94f4f",
	"#e08b3a",
	"#c9c23a",
	"#5aa84a",
	"#3aa8a0",
	"#3a6ec9",
	"#8b4ac9",
	"#c94a9a",
];
const cells = [];
for (const [name, v] of frames) {
	if (PARTS) {
		const b = {};
		collect(rig.root, new paper.Matrix(), v, b);
		const ls = [];
		(b.far ?? []).forEach((it, i) => ls.push({pts: flat(it), fill: "#bcd"}));
		(b.near ?? []).forEach((it, i) => ls.push({pts: flat(it), fill: shades[i % 8]}));
		cells.push(
			renderCell(
				ls,
				view,
				cw,
				ch,
				ls.map((l) => l.fill)
			)
		);
		console.log(`${name} parts`);
		continue;
	}
	const o = outlineFrame(rig, v, null);
	cells.push(renderCell(o.layers, view, cw, ch, fillsFor(o.layers.length)));
	console.log(`${name}${o.failed ? "  UNION FAILED" : ""}`);
}
const {px, W, H} = grid(cells, cw, ch);
writePng(OUT, W, H, px);
console.log(`${OUT}  ${W}x${H}, ${cells.length} cells, ${COLS} cols`);
