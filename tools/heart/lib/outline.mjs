// The <3 theme's rig → outline step (tools/heart/README.md): a rig is a tree
// of parts under pivots; per frame the parts are transformed by the pose,
// the near ones united with paper.js into one closed outline and each far
// leg into its own, then every outline is resampled from a marker, aligned
// to the previous frame and filleted at its concave vertices only. Ported
// from the approved mockup; feetOf and the return shape of outlineFrame are
// new (the travel step needs the planted feet).

import paper from "paper";

// paper.js wants a project; a size is enough — boolean ops never draw.
paper.setup(new paper.Size(8, 8));

export {paper};

export const P = (d) => new paper.Path({pathData: d, insert: false});
export const Circle = (x, y, r) =>
	new paper.Path.Circle({center: [x, y], radius: r, insert: false});
export const Ellipse = (x, y, rx, ry) =>
	new paper.Path.Ellipse({center: [x, y], radius: [rx, ry], insert: false});

/** Clones of `items` scaled about the origin (a far leg is thinner and a little shorter). */
export function scaled(items, sx, sy) {
	return items.map((i) => {
		const c = i.clone({insert: false});
		c.scale(sx, sy, new paper.Point(0, 0));
		return c;
	});
}

/**
 * Walk the rig from `node`, accumulating the pose `v` into the matrix, and
 * drop every transformed part into bins.near / bins.far, every marker into
 * bins.markers ({layer, point}) and every foot into bins.feet ({layer, x, y}).
 */
export function collect(node, parentM, v, bins) {
	const m = parentM.clone().translate(node.pivot?.[0] ?? 0, node.pivot?.[1] ?? 0);
	if (node.rot) m.rotate(v[node.rot] ?? 0);
	if (node.scale) m.scale(v[node.scale[0]] ?? 1, v[node.scale[1]] ?? 1);
	if (node.ty) m.translate(0, v[node.ty] ?? 0);
	const layer = node.layer ?? "near";
	for (const s of node.shapes ?? []) {
		const item = typeof s === "function" ? s(v) : s.clone({insert: false});
		item.transform(m);
		(bins[layer] ??= []).push(item);
	}
	if (node.marker) {
		(bins.markers ??= []).push({layer, point: m.transform(new paper.Point(node.marker))});
	}
	if (node.foot) {
		const p = m.transform(new paper.Point(node.foot));
		(bins.feet ??= []).push({layer, x: p.x, y: p.y});
	}
	for (const c of node.children ?? []) collect(c, m, v, bins);
}

export function unite(items) {
	let acc = items[0];
	for (let i = 1; i < items.length; i++) acc = acc.unite(items[i], {insert: false});
	return acc;
}

/** The outer boundary of a union: a pocket enclosed by a folded leg is legitimate and dropped. */
export function largest(item) {
	if (item.className === "CompoundPath") {
		let best = null;
		for (const c of item.children) {
			if (!best || Math.abs(c.area) > Math.abs(best.area)) best = c;
		}
		return best.clone({insert: false});
	}
	return item;
}

/**
 * A boolean union can fail on a degenerate coincidence and come back as a
 * hull-like blob: larger than the sum of its parts, or smaller than the
 * largest of them. Null then; the caller nudges the pose and retries.
 */
export function safeUnite(items) {
	const parts = items.reduce((a, i) => a + Math.abs(i.area), 0);
	const u = unite(items);
	const ok =
		Math.abs(u.area) <= parts * 1.02 &&
		Math.abs(u.area) >= Math.max(...items.map((i) => Math.abs(i.area)));
	return ok ? u : null;
}

/**
 * Smooth only the concave vertices of a closed outline (flat [x, y, …]),
 * so every V notch where two parts meet softens into a curve while convex
 * tips (ears, hooves, paws) keep their exact shape.
 */
export function filletConcave(pts, rounds, strength) {
	const n = pts.length / 2;
	let area = 0;
	for (let k = 0; k < n; k++) {
		const j = (k + 1) % n;
		area += pts[2 * k] * pts[2 * j + 1] - pts[2 * j] * pts[2 * k + 1];
	}
	const wind = Math.sign(area) || 1;
	let cur = pts.slice();
	for (let r = 0; r < rounds; r++) {
		const next = cur.slice();
		for (let k = 0; k < n; k++) {
			const a = (k - 1 + n) % n;
			const b = (k + 1) % n;
			const v1x = cur[2 * k] - cur[2 * a];
			const v1y = cur[2 * k + 1] - cur[2 * a + 1];
			const v2x = cur[2 * b] - cur[2 * k];
			const v2y = cur[2 * b + 1] - cur[2 * k + 1];
			const cross = v1x * v2y - v1y * v2x;
			if (Math.sign(cross) === wind || Math.abs(cross) < 0.05) continue; // convex or straight
			const a2 = (k - 2 + n) % n;
			const b2 = (k + 2) % n;
			const mx = (cur[2 * a2] + cur[2 * a] + cur[2 * b] + cur[2 * b2]) / 4;
			const my = (cur[2 * a2 + 1] + cur[2 * a + 1] + cur[2 * b + 1] + cur[2 * b2 + 1]) / 4;
			next[2 * k] = cur[2 * k] + (mx - cur[2 * k]) * strength;
			next[2 * k + 1] = cur[2 * k + 1] + (my - cur[2 * k + 1]) * strength;
		}
		cur = next;
	}
	return cur;
}

/** n points along `path`, clockwise, starting nearest `marker`, as a flat list. */
export function resample(path, n, marker) {
	if (!path.clockwise) path.reverse();
	const L = path.length;
	const start = path.getNearestLocation(marker).offset;
	const pts = [];
	for (let k = 0; k < n; k++) {
		const p = path.getPointAt((start + (k / n) * L) % L);
		pts.push(p.x, p.y);
	}
	return pts;
}

/** Rotate the point list so it lines up with the previous frame's, so a blend between frames never crosses the shape. */
export function align(pts, prev) {
	if (!prev || prev.length !== pts.length) return pts;
	const n = pts.length / 2;
	let best = Infinity;
	let bestS = 0;
	for (let sft = -12; sft <= 12; sft++) {
		let d = 0;
		for (let k = 0; k < n; k += 3) {
			const j = (((k + sft) % n) + n) % n;
			d += (pts[2 * j] - prev[2 * k]) ** 2 + (pts[2 * j + 1] - prev[2 * k + 1]) ** 2;
		}
		if (d < best) {
			best = d;
			bestS = sft;
		}
	}
	if (!bestS) return pts;
	const out = new Array(pts.length);
	for (let k = 0; k < n; k++) {
		const j = (((k + bestS) % n) + n) % n;
		out[2 * k] = pts[2 * j];
		out[2 * k + 1] = pts[2 * j + 1];
	}
	return out;
}

/** The feet of a pose, in rig space (no union: cheap enough for every frame of every cycle). */
export function feetOf(rig, v) {
	const bins = {};
	collect(rig.root, new paper.Matrix(), v, bins);
	return bins.feet ?? [];
}

/**
 * One frame: the pose `v` through the rig → layers [far…, near], each a flat
 * point list aligned to `prev` (the previous frame's layers, or null). A
 * failed union is retried up to four times with the pose nudged by 0.013°
 * per attempt; `failed` is true when even that did not help.
 */
export function outlineFrame(rig, v, prev, attempt = 0) {
	const bins = {};
	const vv = attempt
		? Object.fromEntries(
				Object.entries(v).map(([k, x]) => [
					k,
					typeof x === "number" ? x + 0.013 * attempt : x,
				])
		  )
		: v;
	collect(rig.root, new paper.Matrix(), vv, bins);
	const markers = bins.markers ?? [];
	const nearMarker = markers.find((m) => m.layer === "near")?.point ?? new paper.Point(1e4, 0);
	const farMarkers = markers.filter((m) => m.layer === "far").map((m) => m.point);
	const groups = bins.far ? rig.farGroups(bins.far) : [];
	const unions = groups.map((g) => safeUnite(g));
	const near = safeUnite(bins.near);
	const failed = !near || unions.some((u) => !u);
	if (failed && attempt < 4) return outlineFrame(rig, v, prev, attempt + 1);
	const layers = [];
	unions.forEach((u, gi) => {
		const path = largest(u ?? unite(groups[gi]));
		const pts = resample(path, rig.nFar ?? 120, farMarkers[gi] ?? new paper.Point(0, 1e4));
		layers.push({
			cls: "far",
			pts: align(filletConcave(pts, 6, 0.6), prev?.[layers.length]?.pts),
		});
	});
	const pts = resample(largest(near ?? unite(bins.near)), rig.n ?? 320, nearMarker);
	layers.push({
		cls: "near",
		pts: align(filletConcave(pts, rig.fillet ?? 14, 0.5), prev?.[layers.length]?.pts),
	});
	return {layers, failed, attempts: attempt};
}
