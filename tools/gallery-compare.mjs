#!/usr/bin/env node
// Compares two runs of the capture gallery (tools/scenarios/gallery.mjs,
// docs/resources/themes.md § Checking a theme), cell by cell: identical,
// changed (how many pixels, and the box around them), added or removed.
// Exits 1 on any difference, so "this change moved nothing" is a zero exit.
//
//   node tools/gallery-compare.mjs tmp/gallery/base tmp/gallery/branch
//
// For each changed cell a picture goes to `<after>/diff`:
// before, after, and the before dimmed with every changed pixel in magenta,
// side by side. Cells are matched by name, from each run's manifest (which
// a run writes only when it passed), and judged by their decoded pixels.

import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";

import {decodePng, png} from "./scenarios/lib/png.mjs";

const dirs = process.argv.slice(2);

if (dirs.length !== 2) {
	console.error("usage: node tools/gallery-compare.mjs <before-dir> <after-dir>");
	process.exit(2);
}

const [before, after] = dirs.map((d) => resolve(d));
const outDir = join(after, "diff");

function manifest(dir) {
	let run;

	try {
		run = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	} catch {
		run = null;
	}

	if (!run?.cells?.length) {
		console.error(`${dir}: no manifest, so not a gallery run that passed`);
		process.exit(2);
	}

	return run;
}

const runA = manifest(before);
const runB = manifest(after);
const a = new Set(runA.cells);
const b = new Set(runB.cells);

if (runA.browser !== runB.browser) {
	console.log(`warning: the runs used ${runA.browser} and ${runB.browser}; expect differences`);
}

/** Null when the two pictures match; else the changed pixels, their box and a picture of the three side by side. */
function diff(name) {
	const x = decodePng(readFileSync(join(before, `${name}.png`)));
	const y = decodePng(readFileSync(join(after, `${name}.png`)));

	if (x.width !== y.width || x.height !== y.height) {
		return {size: `${x.width}×${x.height} → ${y.width}×${y.height}`};
	}

	const {width, height} = x;
	const changed = new Uint8Array(width * height);
	let count = 0;
	let box = null;

	for (let i = 0; i < width * height; i++) {
		const o = i * 4;

		if (
			x.rgba[o] !== y.rgba[o] ||
			x.rgba[o + 1] !== y.rgba[o + 1] ||
			x.rgba[o + 2] !== y.rgba[o + 2] ||
			x.rgba[o + 3] !== y.rgba[o + 3]
		) {
			changed[i] = 1;
			count++;
			const px = i % width;
			const py = (i - px) / width;
			box = box
				? {
						x0: Math.min(box.x0, px),
						y0: Math.min(box.y0, py),
						x1: Math.max(box.x1, px),
						y1: Math.max(box.y1, py),
				  }
				: {x0: px, y0: py, x1: px, y1: py};
		}
	}

	if (count === 0) return null;

	const gap = 8;
	const rgb = (img, px, py) => {
		const o = (py * width + px) * 4;
		return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]];
	};
	const picture = png(width * 3 + gap * 2, height, (px, py) => {
		const panel = Math.floor(px / (width + gap));
		const lx = px - panel * (width + gap);

		if (lx >= width) return [255, 255, 255];
		if (panel === 0) return rgb(x, lx, py);
		if (panel === 1) return rgb(y, lx, py);
		if (changed[py * width + lx]) return [255, 0, 255];
		return rgb(x, lx, py).map((v) => Math.round(v * 0.3 + 178));
	});
	mkdirSync(outDir, {recursive: true});
	const file = join(outDir, `${name}.diff.png`);
	writeFileSync(file, picture);
	return {count, box, file};
}

let identical = 0;
const report = [];

for (const name of a) {
	if (!b.has(name)) {
		report.push(`removed   ${name}`);
		continue;
	}

	const d = diff(name);

	if (!d) {
		identical++;
	} else {
		report.push(
			d.size
				? `changed   ${name}: size ${d.size}`
				: `changed   ${name}: ${d.count} px in ${d.box.x0},${d.box.y0}–${d.box.x1},${
						d.box.y1
				  } (${d.box.x1 - d.box.x0 + 1}×${d.box.y1 - d.box.y0 + 1}) → ${d.file}`
		);
	}
}

for (const name of b) {
	if (!a.has(name)) report.push(`added     ${name}`);
}

for (const line of report.sort()) console.log(line);
console.log(
	`\n${identical} identical, ${report.length} different (of ${a.size} before, ${b.size} after)`
);
process.exit(report.length > 0 ? 1 : 0);
