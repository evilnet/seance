/**
 * The yurt's room in 3D (docs/projects/ps-yurt.md §5): one eye standing 1 m
 * inside the door, the yurt's middle (the stove) at the origin, projected into
 * one fixed design frame, so the picture is made once and placed in CSS alone.
 * Metres throughout: x to the right, y up from the floor, z away from the door.
 * Numbers in, SVG strings out; no DOM, no Vue: mocha loads it directly. The
 * approved mockup (docs/resources/themes/ps-yurt/mockup.html, `interior`) is
 * the reference: the same camera, the same clipping, the same painters, with
 * one change: a face names its colour through a class (`fill`), which ps.css's
 * room rules (indoor.ts `roomCss`) shade by the minute, where the mockup
 * painted literal colours.
 */

export type P3 = readonly [number, number, number];
export type Face = "front" | "left" | "right" | "top" | "bottom";
type Pair = readonly [number, number];
type Deco = Partial<Record<Face, (S: Painter) => string>>;

/** The room and the eye: a yurt 4 m in radius, its lattice 2 m high, the crown at 3.2 m; the eye at 1.55 m, 1 m inside the door, pitched 0.7° up. */
export const ROOM_GEOMETRY = {
	radius: 4,
	wallHeight: 2.0,
	crownHeight: 3.2,
	crownRadius: 0.75,
	eye: [0, 1.55, -3.0] as P3,
	focal: 507,
	pitchDeg: 0.7,
	near: 0.12,
} as const;

/** The design frame the room is projected into: 2.4 : 1, wide enough for a 21:9 window, the stove's x at 640. */
export const DESIGN_FRAME = {x: -320, y: 0, width: 1920, height: 800} as const;

/** Where the frame's middle lands: the stove's x, and the image's vertical middle. */
const CX = 640;
const CY = 400;
const PITCH = (ROOM_GEOMETRY.pitchDeg * Math.PI) / 180;
const COS_P = Math.cos(PITCH);
const SIN_P = Math.sin(PITCH);
const RAD = Math.PI / 180;

/** A coordinate to one decimal: sub-pixel at the frame's scale. */
export const n = (v: number) => String(Math.round(v * 10) / 10);
export const pts = (arr: ReadonlyArray<readonly number[]>) =>
	arr.map((p) => n(p[0]) + "," + n(p[1])).join(" ");

/** A room point in the eye's frame: x right, y up, z ahead (the depth). */
function toEye(q: P3): [number, number, number] {
	const [ex, ey, ez] = ROOM_GEOMETRY.eye;
	const dx = q[0] - ex;
	const dy = q[1] - ey;
	const dz = q[2] - ez;
	return [dx, dy * COS_P - dz * SIN_P, dy * SIN_P + dz * COS_P];
}

/** How far ahead of the eye a room point stands (negative behind it). */
export const depthOf = (q: P3) => toEye(q)[2];

/** A room point on the design frame, with its depth. */
export function project(q: P3): [x: number, y: number, depth: number] {
	const [x, y, z] = toEye(q);
	const f = ROOM_GEOMETRY.focal;
	return [CX + (f * x) / z, CY - (f * y) / z, z];
}

const lerp3 = (a: P3, b: P3, t: number): P3 => [
	a[0] + (b[0] - a[0]) * t,
	a[1] + (b[1] - a[1]) * t,
	a[2] + (b[2] - a[2]) * t,
];

/** A polygon cut where it passes behind the eye (depth is linear in the room, so the cut is a plane). */
export function clipPolygon(l: readonly P3[]): P3[] {
	const near = ROOM_GEOMETRY.near;
	const out: P3[] = [];

	for (let i = 0; i < l.length; i++) {
		const a = l[i];
		const b = l[(i + 1) % l.length];
		const za = depthOf(a);
		const zb = depthOf(b);

		if (za >= near) {
			out.push(a);
		}

		if (za >= near !== zb >= near) {
			out.push(lerp3(a, b, (near - za) / (zb - za)));
		}
	}

	return out.length >= 3 ? out : [];
}

/** A polygon of room points, projected; nothing when none of it is in front of the eye. */
export function poly3(l: readonly P3[], attrs: string): string {
	const cut = clipPolygon(l);
	return cut.length ? `<polygon points="${pts(cut.map(project))}" ${attrs}/>` : "";
}

/** A stroke `m` metres wide at depth `z`, in the frame's px, kept between 0.8 and `max`. */
export const widthAt = (m: number, z: number, max = 18) =>
	n(Math.min(Math.max((ROOM_GEOMETRY.focal * m) / z, 0.8), max));

/** A segment cut where it passes behind the eye. */
function clipSegment(a: P3, b: P3): [P3, P3] | null {
	const near = ROOM_GEOMETRY.near;
	const za = depthOf(a);
	const zb = depthOf(b);

	if (za < near && zb < near) {
		return null;
	}

	if (za < near) {
		return [lerp3(a, b, (near - za) / (zb - za)), b];
	}

	if (zb < near) {
		return [a, lerp3(b, a, (near - zb) / (za - zb))];
	}

	return [a, b];
}

/** A straight line in the room, `m` metres wide at its middle. */
export function line3(a: P3, b: P3, attrs: string, m: number, max?: number): string {
	const cut = clipSegment(a, b);

	if (!cut) {
		return "";
	}

	const [p, q] = cut.map(project);
	return `<line x1="${n(p[0])}" y1="${n(p[1])}" x2="${n(q[0])}" y2="${n(
		q[1]
	)}" stroke-width="${widthAt(m, (p[2] + q[2]) / 2, max)}" ${attrs}/>`;
}

/** The runs of a room polyline in front of the eye, projected. */
function runsOf(l: readonly P3[]): Array<Array<[number, number, number]>> {
	const out: Array<Array<[number, number, number]>> = [];
	let cur: Array<[number, number, number]> = [];

	for (const q of l) {
		if (depthOf(q) >= ROOM_GEOMETRY.near) {
			cur.push(project(q));
		} else {
			if (cur.length > 1) {
				out.push(cur);
			}

			cur = [];
		}
	}

	if (cur.length > 1) {
		out.push(cur);
	}

	return out;
}

/** A room polyline, each run `m` metres wide at its middle. */
export function polyRuns(l: readonly P3[], attrs: string, m: number): string {
	return runsOf(l)
		.map(
			(run) =>
				`<polyline points="${pts(run)}" fill="none" stroke-width="${widthAt(
					m,
					run[run.length >> 1][2]
				)}" ${attrs}/>`
		)
		.join("");
}

/** A room polyline with the caller's own attributes. */
export function lineRuns(l: readonly P3[], attrs: string): string {
	return runsOf(l)
		.map((run) => `<polyline points="${pts(run)}" fill="none" ${attrs}/>`)
		.join("");
}

/** A point on the round wall at angle `th` (degrees from the back, + to the right), height `h`. */
export const wallPt = (th: number, h: number, r: number = ROOM_GEOMETRY.radius): P3 => [
	r * Math.sin(th * RAD),
	h,
	r * Math.cos(th * RAD),
];

/** The wall's visible arc at height `h`, projected, a point every `step` degrees. */
export function arc(
	h: number,
	r: number = ROOM_GEOMETRY.radius,
	step = 1
): Array<[number, number, number]> {
	const out: Array<[number, number, number]> = [];

	for (let th = -179; th <= 179; th += step) {
		const q = wallPt(th, h, r);

		if (depthOf(q) > ROOM_GEOMETRY.near) {
			out.push(project(q));
		}
	}

	return out;
}

/** A level circle in the room as a polygon of `k` points. */
export function circle3(x: number, y: number, z: number, r: number, k = 48): P3[] {
	return Array.from(
		{length: k},
		(_, i): P3 => [
			x + r * Math.cos((i / k) * 2 * Math.PI),
			y,
			z + r * Math.sin((i / k) * 2 * Math.PI),
		]
	);
}

/** The convex hull of projected points (the sunbeam's outline). */
export function hull(points: ReadonlyArray<readonly number[]>): Array<[number, number]> {
	const p = points
		.map((q): [number, number] => [q[0], q[1]])
		.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o: number[], a: number[], b: number[]) =>
		(a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower: Array<[number, number]> = [];
	const upper: Array<[number, number]> = [];

	for (const q of p) {
		while (
			lower.length >= 2 &&
			cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0
		) {
			lower.pop();
		}

		lower.push(q);
	}

	for (const q of [...p].reverse()) {
		while (
			upper.length >= 2 &&
			cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0
		) {
			upper.pop();
		}

		upper.push(q);
	}

	return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** A quadratic curve from p0 through control c to p1, as k points after p0. */
export const quadratic = (p0: Pair, c: Pair, p1: Pair, k = 8): Array<[number, number]> =>
	Array.from({length: k}, (_, i): [number, number] => {
		const t = (i + 1) / k;
		return [
			(1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
			(1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1],
		];
	});

/** Draws on one surface of the room: map(s, t) gives the room point, and every shape on it is projected point by point. */
export interface Painter {
	/** The frame's px per metre at (s, t). */
	px(s: number, t: number): number;
	poly(l: ReadonlyArray<readonly [number, number]>, attrs: string): string;
	rect(s0: number, t0: number, s1: number, t1: number, attrs: string, k?: number): string;
	ellipse(s: number, t: number, rs: number, rt: number, attrs: string, k?: number): string;
	circle(s: number, t: number, r: number, attrs: string): string;
	diamond(s: number, t: number, w: number, h: number, attrs: string): string;
	/** A panel from t0 up to t1 at its sides and t1 + rise in its middle. */
	arched(s0: number, s1: number, t0: number, t1: number, rise: number, attrs: string): string;
	line(l: ReadonlyArray<readonly [number, number]>, attrs: string): string;
}

export function surface(map: (s: number, t: number) => P3): Painter {
	const ring = (s0: number, t0: number, s1: number, t1: number, k: number) => {
		const l: Array<[number, number]> = [];

		for (let i = 0; i < k; i++) {
			l.push([s0 + ((s1 - s0) * i) / k, t0]);
		}

		for (let i = 0; i < k; i++) {
			l.push([s1, t0 + ((t1 - t0) * i) / k]);
		}

		for (let i = 0; i < k; i++) {
			l.push([s1 - ((s1 - s0) * i) / k, t1]);
		}

		for (let i = 0; i < k; i++) {
			l.push([s0, t1 - ((t1 - t0) * i) / k]);
		}

		return l;
	};

	const api: Painter = {
		px: (s, t) => ROOM_GEOMETRY.focal / depthOf(map(s, t)),
		poly: (l, attrs) =>
			poly3(
				l.map(([s, t]) => map(s, t)),
				attrs
			),
		rect: (s0, t0, s1, t1, attrs, k = 1) => api.poly(ring(s0, t0, s1, t1, k), attrs),
		ellipse: (s, t, rs, rt, attrs, k = 28) =>
			api.poly(
				Array.from({length: k}, (_, i): [number, number] => [
					s + rs * Math.cos((i / k) * 2 * Math.PI),
					t + rt * Math.sin((i / k) * 2 * Math.PI),
				]),
				attrs
			),
		circle: (s, t, r, attrs) => api.ellipse(s, t, r, r, attrs, 22),
		diamond: (s, t, w, h, attrs) =>
			api.poly(
				[
					[s, t + h],
					[s + w, t],
					[s, t - h],
					[s - w, t],
				],
				attrs
			),
		arched(s0, s1, t0, t1, rise, attrs) {
			const l: Array<[number, number]> = [
				[s0, t0],
				[s1, t0],
				[s1, t1],
			];

			for (let i = 1; i < 12; i++) {
				const u = i / 12;
				l.push([s1 + (s0 - s1) * u, t1 + rise * Math.sin(Math.PI * u)]);
			}

			l.push([s0, t1]);
			return api.poly(l, attrs);
		},
		line: (l, attrs) =>
			lineRuns(
				l.map(([s, t]) => map(s, t)),
				attrs
			),
	};
	return api;
}

/** A stroke `m` metres wide on a surface at (s, t), in px. */
export const strokeAt = (S: Painter, s: number, t: number, m: number) =>
	n(Math.max(0.6, m * S.px(s, t)));

/** The class that colours a face: the colour's own, and the face's shade unless it faces the eye squarely. */
export function fill(colour: string, face?: Face): string {
	return `class="ps-yt-c-${colour}${face && face !== "front" ? ` ps-yt-f-${face}` : ""}"`;
}

/** A frame places a piece: a along it (+ to the right, seen from where it faces), b toward where it faces, c up. */
export interface Frame {
	u: P3;
	n: P3;
	pt(a: number, b: number, c: number): P3;
	/** A wall frame's angle, in degrees from the back. */
	th?: number;
}

/** A frame backed on the round wall at angle `thDeg`, facing the middle. */
export function wallFrame(thDeg: number): Frame {
	const r = [Math.sin(thDeg * RAD), 0, Math.cos(thDeg * RAD)] as const;
	const u: P3 = [Math.cos(thDeg * RAD), 0, -Math.sin(thDeg * RAD)];
	const R = ROOM_GEOMETRY.radius;
	return {
		th: thDeg,
		u,
		n: [-r[0], 0, -r[2]],
		pt: (a, b, c) => [r[0] * (R - b) + u[0] * a, c, r[2] * (R - b) + u[2] * a],
	};
}

/** A frame standing at (x, z) on the floor, facing (nx, nz). */
export function freeFrame(x: number, z: number, nx: number, nz: number): Frame {
	const l = Math.hypot(nx, nz);
	const ux = nx / l;
	const uz = nz / l;
	return {
		u: [-uz, 0, ux],
		n: [ux, 0, uz],
		pt: (a, b, c) => [x - uz * a + ux * b, c, z + ux * a + uz * b],
	};
}

/** A point on the wall's surface, `s` metres along it from a wall frame's middle, at height `c`. */
export function onWall(fr: Frame, s: number, c: number): P3 {
	const R = ROOM_GEOMETRY.radius - 0.02;
	const t = (fr.th ?? 0) * RAD + s / R;
	return [Math.sin(t) * R, c, Math.cos(t) * R];
}

interface FaceSpec {
	nrm: P3;
	map: (s: number, t: number) => P3;
	s: Pair;
	t: Pair;
}

/** Draws the faces turned toward the eye, each in its colour's class and its face's shade, then its decoration. */
function faces(F: Record<Face, FaceSpec>, colour: string, deco: Deco): string {
	const eye = ROOM_GEOMETRY.eye;
	let out = "";

	for (const name of ["left", "right", "top", "bottom", "front"] as const) {
		const f = F[name];
		const m = f.map((f.s[0] + f.s[1]) / 2, (f.t[0] + f.t[1]) / 2);

		if (
			f.nrm[0] * (eye[0] - m[0]) + f.nrm[1] * (eye[1] - m[1]) + f.nrm[2] * (eye[2] - m[2]) <=
			0
		) {
			continue;
		}

		const S = surface(f.map);
		out += S.rect(f.s[0], f.t[0], f.s[1], f.t[1], fill(colour, name));
		out += deco[name]?.(S) ?? "";
	}

	return out;
}

/** A box in a frame (against the wall, or turned toward a table). */
export function box(fr: Frame, a: Pair, b: Pair, c: Pair, colour: string, deco: Deco = {}): string {
	const neg = (v: P3): P3 => [-v[0], -v[1], -v[2]];
	return faces(
		{
			left: {nrm: neg(fr.u), map: (s, t) => fr.pt(a[0], s, t), s: b, t: c},
			right: {nrm: fr.u, map: (s, t) => fr.pt(a[1], s, t), s: b, t: c},
			top: {nrm: [0, 1, 0], map: (s, t) => fr.pt(s, t, c[1]), s: a, t: b},
			bottom: {nrm: [0, -1, 0], map: (s, t) => fr.pt(s, t, c[0]), s: a, t: b},
			front: {nrm: fr.n, map: (s, t) => fr.pt(s, b[1], t), s: a, t: c},
		},
		colour,
		deco
	);
}

/** A box standing square to the room. */
export function abox(x: Pair, y: Pair, z: Pair, colour: string, deco: Deco = {}): string {
	return faces(
		{
			left: {nrm: [-1, 0, 0], map: (s, t) => [x[0], t, s], s: z, t: y},
			right: {nrm: [1, 0, 0], map: (s, t) => [x[1], t, s], s: z, t: y},
			top: {nrm: [0, 1, 0], map: (s, t) => [s, y[1], t], s: x, t: z},
			bottom: {nrm: [0, -1, 0], map: (s, t) => [s, y[0], t], s: x, t: z},
			front: {nrm: [0, 0, -1], map: (s, t) => [s, t, z[0]], s: x, t: y},
		},
		colour,
		deco
	);
}

/** The side of an upright cylinder that faces the eye, from y0 to y1. */
export function cylinderSide(
	cx: number,
	cz: number,
	r: number,
	y0: number,
	y1: number,
	attrs: string
): string {
	const eye = ROOM_GEOMETRY.eye;
	const d = Math.hypot(eye[0] - cx, eye[2] - cz);
	const toward = Math.atan2(eye[2] - cz, eye[0] - cx);
	const half = Math.acos(Math.min(1, r / d));
	const bottom: P3[] = [];
	const top: P3[] = [];

	for (let i = 0; i <= 28; i++) {
		const ph = toward - half + (2 * half * i) / 28;
		bottom.push([cx + r * Math.cos(ph), y0, cz + r * Math.sin(ph)]);
		top.push([cx + r * Math.cos(ph), y1, cz + r * Math.sin(ph)]);
	}

	return poly3([...bottom, ...top.reverse()], attrs);
}

/** A small round thing drawn flat at its place (its base at q), `unit` metres per drawing unit; nothing behind the eye. */
export function sprite(q: P3, body: string, unit = 0.0115): string {
	if (depthOf(q) < ROOM_GEOMETRY.near) {
		return "";
	}

	const [x, y, z] = project(q);
	return `<g transform="translate(${n(x)},${n(y)}) scale(${n(
		(ROOM_GEOMETRY.focal * unit) / z
	)})">${body}</g>`;
}
