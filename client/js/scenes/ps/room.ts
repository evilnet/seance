/**
 * The yurt's room as one static picture (docs/projects/ps-yurt.md §5, plan 1
 * task 4): every piece of the approved mockup
 * (docs/resources/themes/ps-yurt/mockup.html, `interior` and `PIECES`) drawn
 * through yurt.ts's camera into the design frame, coloured by class
 * (indoor.ts `roomCss` shades them by the minute) and the windows by the
 * plains' own custom properties. What the mockup did with masks, blend-mode
 * rectangles and a brightened copy of the stove is left out: the classes'
 * night mix does it. The light (the beam, the glows, the low sun, the stars,
 * the moon) is drawn once and driven by opacity from the minute's levels; the
 * fire, the lamp's flame and the night screen are the only literal colours
 * (`ps-yt-lit`). The windows' weather is a slot (`.ps-yt-weather`) the scene
 * fills for the day (task 5). Pure and Vue-free: mocha loads it directly.
 */
import {WEATHERS, type Weather} from "./engine";
import type {RoomColour} from "./indoor";
import {
	abox,
	arc,
	box,
	circle3,
	cylinderSide,
	depthOf,
	fill,
	freeFrame,
	hull,
	line3,
	n,
	onWall,
	poly3,
	polyRuns,
	project,
	pts,
	quadratic,
	ROOM_GEOMETRY,
	sprite,
	strokeAt,
	surface,
	wallFrame,
	wallPt,
	type Frame,
	type P3,
	type Painter,
} from "./yurt";

const {
	radius: R,
	wallHeight: WALL_H,
	crownHeight: CROWN_H,
	crownRadius: CROWN_R,
	near: NEAR,
} = ROOM_GEOMETRY;
const FOCAL = ROOM_GEOMETRY.focal;

/** The pieces along the wall, by angle from the back (0°), + to the right. */
const ROOM: ReadonlyArray<readonly [Piece, number]> = [
	["hooks", -120],
	["washstand", -102],
	["closet", -82],
	["desk", -60],
	["chests", -38],
	["bed", 45],
	["kitchen", 86],
];
const SIDE_WINDOWS = [-60, 69] as const;
const RUG_R = 2.5;
const TABLE = [-1.35, -0.55] as const;
const BASKET = [-0.75, 0.35] as const;
/** The back window: 3.1 m wide, from 0.45 m to 1.9 m, flat in the curved wall. */
const WX = 1.55;
const WY0 = 0.45;
const WY1 = 1.9;
const FR = 0.08;
const ZW = Math.sqrt(R * R - WX * WX) - 0.02;
const STOVE_R = 0.38;

/** The clips of the three windows' panes, which the windows' weather (task 5) is clipped to. */
export const WINDOW_CLIPS = ["ps-yt-win-back", "ps-yt-win-left", "ps-yt-win-right"] as const;

type Piece = "closet" | "bed" | "chests" | "desk" | "kitchen" | "washstand" | "hooks";

/** Every piece's class, in the markup as `ps-yt-p-<name>`. */
export const ROOM_PIECES: readonly string[] = [
	"closet",
	"desk",
	"chests",
	"bed",
	"kitchen",
	"washstand",
	"hooks",
	"stove",
	"post",
	"table",
	"chair",
	"rug",
	"crown",
	"window-back",
	"window-left",
	"window-right",
	"curtains",
].map((p) => `ps-yt-p-${p}`);

/** A class for a fill colour, a stroke colour, or both, and any further classes. */
function cls(fillKey?: RoomColour, strokeKey?: RoomColour, more = ""): string {
	return `class="${[fillKey && `ps-yt-c-${fillKey}`, strokeKey && `ps-yt-s-${strokeKey}`, more]
		.filter(Boolean)
		.join(" ")}"`;
}

const piece = (name: string, body: string) => `<g class="ps-yt-p-${name}">${body}</g>`;
const LIT = 'class="ps-yt-lit"';

/* ---------- small round things, drawn flat at their place ---------- */
const PLANT = {
	pot: "M-9,0 L-7,-12 L7,-12 L9,0 Z",
	leaves: "M0,-12 C-12,-20 -14,-30 -6,-34 C-2,-26 0,-20 0,-12 C2,-24 8,-32 14,-30 C12,-22 6,-16 0,-12",
};
const SPR = {
	lamp: `<rect x="-9" y="-6" width="18" height="6" rx="2" ${cls(
		"gold"
	)}/><path d="M-6,-6 C-10,-16 -8,-26 0,-32 C8,-26 10,-16 6,-6 Z" ${cls(
		"chimney"
	)} opacity=".55"/>`,
	flame: `<path d="M0,-26 C-5,-18 -5,-12 0,-9 C5,-12 5,-18 0,-26 Z" fill="#ffe7a0" ${LIT}/>`,
	bowl: `<path d="M-8,-5 a8,5 0 0 0 16,0 Z" ${cls("china")}/>`,
	mug: `<rect x="-7" y="-14" width="14" height="14" rx="2" ${cls(
		"cream"
	)}/><path d="M7,-11 a4,4 0 0 1 0,8" fill="none" ${cls(
		undefined,
		"cream"
	)} stroke-width="2.4"/>`,
	plant: `<path d="${PLANT.pot}" ${cls("clay")}/><path d="${PLANT.leaves}" ${cls("leaf")}/>`,
	plate: `<ellipse cx="0" cy="-11" rx="5" ry="11" ${cls("plate", "blue")} stroke-width="1.5"/>`,
	jarA: `<rect x="-7" y="-22" width="14" height="22" rx="3" ${cls(
		"jarAmber"
	)}/><rect x="-8" y="-25" width="16" height="4" rx="1" ${cls("woodD")}/>`,
	jarB: `<rect x="-6" y="-16" width="12" height="16" rx="3" ${cls(
		"jarGreen"
	)}/><rect x="-7" y="-19" width="14" height="4" rx="1" ${cls("woodD")}/>`,
	bowls: `<path d="M-12,-10 h24 l-3,10 h-18 Z" ${cls(
		"china"
	)}/><path d="M-9,-18 h18 l-2,8 h-14 Z" ${cls("chinaB")}/>`,
	cups: `<rect x="-8" y="-14" width="16" height="14" rx="3" ${cls(
		"blue"
	)}/><rect x="10" y="-14" width="16" height="14" rx="3" ${cls(
		"cream"
	)}/><rect x="28" y="-14" width="14" height="14" rx="3" ${cls("green")}/>`,
	thermos: `<rect x="-8" y="-38" width="16" height="38" rx="5" ${cls(
		"thermos"
	)}/><path d="M-8,-24 h16 M-8,-14 h16" ${cls(
		undefined,
		"gold"
	)} stroke-width="2"/><rect x="-5" y="-44" width="10" height="7" rx="2" ${cls("iron")}/>`,
	basin: `<path d="M-22,-12 h44 l-6,12 h-32 Z" ${cls(
		"tin"
	)}/><ellipse cx="0" cy="-12" rx="22" ry="4" ${cls("tinL")}/>`,
	jug: `<path d="M-7,0 L-9,-20 Q0,-26 9,-20 L7,0 Z" ${cls(
		"cream"
	)}/><path d="M9,-18 q7,4 0,12" ${cls(undefined, "cream")} stroke-width="2.5" fill="none"/>`,
	finial: `<circle cx="0" cy="-6" r="6" ${cls("gold")}/><circle cx="-2" cy="-8" r="2" ${cls(
		"white"
	)} opacity=".4"/>`,
	kettle: `<g transform="translate(0,-15)"><path d="M18,-2 C30,-6 34,-14 38,-16 L36,-12 C32,-6 26,2 18,4 Z" ${cls(
		"copper"
	)}/><ellipse cx="0" cy="0" rx="23" ry="15" ${cls(
		"copper"
	)}/><ellipse cx="-6" cy="-5" rx="10" ry="4" ${cls(
		"white"
	)} opacity=".2"/><ellipse cx="0" cy="-13" rx="11" ry="3.5" ${cls(
		"copperD"
	)}/><circle cx="0" cy="-17" r="3" ${cls(
		"iron"
	)}/><path d="M-16,-8 Q0,-34 16,-8" fill="none" ${cls(
		undefined,
		"iron"
	)} stroke-width="2.5"/></g>`,
	pot: `<g transform="translate(0,-28)"><rect x="-24" y="0" width="48" height="28" rx="4" ${cls(
		"potIron"
	)}/><rect x="-24" y="3" width="48" height="3" ${cls(
		"white"
	)} opacity=".12"/><ellipse cx="0" cy="0" rx="25" ry="5" ${cls(
		"potIronL"
	)}/><rect x="-31" y="6" width="7" height="4" rx="2" ${cls(
		"potIron"
	)}/><rect x="24" y="6" width="7" height="4" rx="2" ${cls("potIron")}/></g>`,
	steam: `<g fill="none" ${cls(
		undefined,
		"white"
	)} stroke-width="2" stroke-linecap="round" opacity=".45"><path d="M-6,-34 q-6,-12 2,-22 q8,-10 0,-22"/><path d="M6,-36 q6,-12 -2,-22 q-6,-9 2,-18"/></g>`,
	teapot: `<g transform="translate(0,-11)"><path d="M12,-4 C20,-6 24,-14 27,-15" ${cls(
		undefined,
		"blue"
	)} stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M-12,-6 a7,8 0 0 0 0,12" ${cls(
		undefined,
		"blue"
	)} stroke-width="3" fill="none"/><ellipse cx="0" cy="0" rx="14" ry="11" ${cls(
		"blue"
	)}/><ellipse cx="-4" cy="-4" rx="6" ry="3" ${cls(
		"white"
	)} opacity=".25"/><ellipse cx="0" cy="-10" rx="7" ry="2.5" ${cls(
		"blueD"
	)}/><circle cx="0" cy="-13" r="2.4" ${cls("cream")}/></g>`,
	dumplings:
		`<g transform="translate(0,-3)"><ellipse cx="0" cy="0" rx="24" ry="6" ${cls("dough")}/>` +
		[
			[-9, -3],
			[2, -4],
			[12, -3],
			[-3, -7],
			[8, -7],
		]
			.map(
				([x, y]) =>
					`<ellipse cx="${x}" cy="${y}" rx="6" ry="3.5" ${cls("doughL", "doughEdge")}/>`
			)
			.join("") +
		`<path d="M-4,-14 q-4,-8 2,-14 M6,-14 q4,-8 -2,-14" ${cls(
			undefined,
			"white"
		)} stroke-width="1.8" fill="none" opacity=".5"/></g>`,
	tbowl: `<g transform="translate(0,-3)"><path d="M-10,-4 a10,7 0 0 0 20,0 Z" ${cls(
		"china"
	)}/><path d="M-10,-4 h20" ${cls(undefined, "blue")} stroke-width="2"/></g>`,
	basket:
		`<g transform="rotate(-18)"><rect x="-8" y="-74" width="13" height="66" rx="5" ${cls(
			"log"
		)}/></g>` +
		[
			[-18, -42, 10, 6],
			[2, -48, 11, 7],
			[20, -42, 9, 5.5],
		]
			.map(
				([x, y, r, e]) =>
					`<circle cx="${x}" cy="${y}" r="${r}" ${cls(
						"log"
					)}/><circle cx="${x}" cy="${y}" r="${e}" ${cls("logEnd")}/>`
			)
			.join("") +
		`<path d="M-36,-40 L36,-40 L30,0 L-30,0 Z" ${cls("wicker")}/>` +
		`<path d="M-35,-31 Q0,-27 35,-31 M-33,-20 Q0,-16 33,-20 M-31,-9 Q0,-5 31,-9" ${cls(
			undefined,
			"wickerD"
		)} stroke-width="2" fill="none"/>` +
		`<path d="M-20,-40 L-18,0 M0,-40 L0,0 M20,-40 L18,0" ${cls(
			undefined,
			"wickerD"
		)} stroke-width="1.6"/>`,
};

/** Where the lit things stand, found while the pieces are drawn. */
interface Lights {
	lamp?: P3;
	screen?: P3;
	flame?: string;
	screenFace?: string;
}

/** A chair in a frame turned toward what it serves (b toward it): legs, seat, and a back away from it. */
function chair(fr: Frame): string {
	let s = "";

	for (const [a, b] of [
		[-0.19, -0.19],
		[0.14, -0.19],
		[-0.19, 0.14],
		[0.14, 0.14],
	]) {
		s += box(fr, [a, a + 0.05], [b, b + 0.05], [0, 0.45], "wood");
	}

	s += box(fr, [-0.21, 0.21], [-0.21, 0.21], [0.45, 0.5], "woodL");
	s +=
		box(fr, [-0.2, -0.15], [-0.21, -0.16], [0.5, 0.98], "wood") +
		box(fr, [0.15, 0.2], [-0.21, -0.16], [0.5, 0.98], "wood");
	s += box(fr, [-0.2, 0.2], [-0.21, -0.16], [0.74, 0.95], "woodL", {
		front: (S) => S.circle(0, 0.845, 0.05, cls("furn")),
	});
	return piece("chair", s);
}

/* ---------- the furniture along the round wall: each gives how far it stands out, and its markup ---------- */
const PIECES: Record<Piece, (fr: Frame, lights: Lights) => {d: number; svg: string}> = {
	closet(fr) {
		const front = (S: Painter) => {
			const k = S.px(0, 1);
			const orn = (s: number) =>
				S.circle(s, 1.08, 0.11, `${cls("blue", "cream")} stroke-width="${n(0.014 * k)}"`) +
				S.diamond(s, 1.08, 0.03, 0.08, cls("cream"));
			return (
				S.rect(-0.4, 0.42, -0.02, 1.74, cls("furnL")) +
				S.rect(0.02, 0.42, 0.4, 1.74, cls("furnL")) +
				orn(-0.21) +
				orn(0.21) +
				[
					[-0.36, -0.06],
					[0.06, 0.36],
				]
					.map(
						([a, b]) =>
							S.rect(a, 1.65, b, 1.675, cls("green")) +
							S.rect(a, 0.5, b, 0.525, cls("green"))
					)
					.join("") +
				S.circle(-0.05, 1.0, 0.018, cls("gold")) +
				S.circle(0.05, 1.0, 0.018, cls("gold")) +
				S.rect(-0.38, 0.14, 0.38, 0.34, cls("furnL")) +
				S.rect(-0.07, 0.23, 0.07, 0.255, cls("gold"))
			);
		};
		return {
			d: 0.62,
			svg:
				box(fr, [-0.42, 0.42], [0.04, 0.52], [0, 0.08], "furnD") +
				box(fr, [-0.45, 0.45], [0, 0.58], [0.08, 1.82], "furn", {front}) +
				box(fr, [-0.48, 0.48], [0, 0.62], [1.82, 1.9], "furnD"),
		};
	},

	/* A painted four-poster: shaped head- and footboards with thickness, posts with brass finials,
	 * an orange frame with cream line-work; soft bedding in its own colours — a blue quilt turned
	 * down at the head and draped over the side, puffy pillows, a red cushion, and a mustard throw
	 * folded across the foot; the rug on the wall above it below the roof line. */
	bed(fr) {
		const Wl = surface((s, t) => onWall(fr, s, t));
		const kw = Wl.px(0, 1.4);
		let s =
			Wl.rect(-0.7, 0.98, 0.7, 1.8, cls("rug"), 8) +
			Wl.rect(
				-0.63,
				1.05,
				0.63,
				1.73,
				`fill="none" ${cls(undefined, "rugB")} stroke-width="${n(0.028 * kw)}"`,
				8
			) +
			Wl.diamond(0, 1.39, 0.18, 0.26, cls("rugP")) +
			Wl.diamond(0, 1.39, 0.1, 0.15, cls("rugB")) +
			[
				[-0.48, 1.18],
				[0.48, 1.18],
				[-0.48, 1.6],
				[0.48, 1.6],
			]
				.map(([a, c]) => Wl.diamond(a, c, 0.06, 0.09, cls("rugB")))
				.join("");

		for (let a = -0.65; a <= 0.66; a += 0.1) {
			s += Wl.line(
				[
					[a, 0.98],
					[a, 0.92],
				],
				`${cls(undefined, "rugB")} stroke-width="${n(0.012 * kw)}"`
			);
		}

		const L = 1.08;
		const D = 1.42;
		const HEAD = -L;
		const FOOT = L;
		const T = 0.07;
		const eye = ROOM_GEOMETRY.eye;
		const across = (A: number) => surface((b, c) => fr.pt(A, b, c));
		const seesPlus = (A: number) => {
			const p = fr.pt(A, D / 2, 0.6);
			return fr.u[0] * (eye[0] - p[0]) + fr.u[2] * (eye[2] - p[2]) > 0;
		};
		const roundRect = (
			s0: number,
			t0: number,
			s1: number,
			t1: number,
			rs: number,
			rt: number,
			k = 5
		) => {
			const l: Array<[number, number]> = [];
			const corner = (cs: number, ct: number, a0: number) => {
				for (let i = 0; i <= k; i++) {
					l.push([
						cs + rs * Math.cos(a0 + (Math.PI / 2) * (i / k)),
						ct + rt * Math.sin(a0 + (Math.PI / 2) * (i / k)),
					]);
				}
			};
			corner(s1 - rs, t0 + rt, -Math.PI / 2);
			corner(s1 - rs, t1 - rt, 0);
			corner(s0 + rs, t1 - rt, Math.PI / 2);
			corner(s0 + rs, t0 + rt, Math.PI);
			return l;
		};
		const archOutline = (
			s0: number,
			s1: number,
			t0: number,
			tSide: number,
			tPeak: number,
			k = 18
		) => {
			const l: Array<[number, number]> = [
				[s0, t0],
				[s1, t0],
				[s1, tSide],
			];

			for (let i = 1; i < k; i++) {
				l.push([
					s1 + ((s0 - s1) * i) / k,
					tSide + (tPeak - tSide) * Math.sin((Math.PI * i) / k),
				]);
			}

			l.push([s0, tSide]);
			return l;
		};
		const medallion = (S: Painter, b: number, c: number, r: number) =>
			S.circle(
				b,
				c,
				r,
				`${cls("green", "cream")} stroke-width="${strokeAt(S, b, c, 0.014)}"`
			) +
			S.circle(b, c, r * 0.42, cls("gold")) +
			[-1, 1]
				.map((m) =>
					S.circle(
						b + m * r * 2.2,
						c,
						r * 0.48,
						`${cls("blue", "cream")} stroke-width="${strokeAt(S, b, c, 0.01)}"`
					)
				)
				.join("");
		/** A shaped board across the bed: its far face as a rim, then the near face painted. */
		const board = (
			A0: number,
			A1: number,
			outline: Array<[number, number]>,
			inset: Array<[number, number]>,
			orn: (S: Painter) => string
		) => {
			const [far, near] = seesPlus(A1) ? [A0, A1] : [A1, A0];
			const N = across(near);
			return (
				across(far).poly(outline, fill("furn", "side")) +
				N.poly(outline, fill("furn")) +
				N.poly(
					inset,
					`${cls("furnL", "cream")} stroke-width="${strokeAt(N, D / 2, 0.6, 0.014)}"`
				) +
				orn(N)
			);
		};
		/** A corner post to the floor with a brass finial: four of them, at the wall and at the front. */
		const post = (a0: number, a1: number, b0: number, h: number) =>
			box(fr, [a0, a1], [b0, b0 + 0.1], [0, h], "furnD") +
			sprite(fr.pt((a0 + a1) / 2, b0 + 0.05, h), SPR.finial, 0.008);
		const headboard =
			board(
				HEAD - T,
				HEAD,
				archOutline(0, D, 0, 1.12, 1.42),
				archOutline(0.12, D - 0.12, 0.64, 1.04, 1.28),
				(S) => medallion(S, D / 2, 0.9, 0.085)
			) +
			post(HEAD - 0.09, HEAD + 0.02, 0, 1.34) +
			post(HEAD - 0.09, HEAD + 0.02, D - 0.1, 1.34);
		const footboard =
			board(
				FOOT,
				FOOT + T,
				archOutline(0, D, 0, 0.66, 0.8),
				archOutline(0.12, D - 0.12, 0.2, 0.58, 0.7),
				(S) => medallion(S, D / 2, 0.42, 0.065)
			) +
			post(FOOT - 0.02, FOOT + 0.09, 0, 0.9) +
			post(FOOT - 0.02, FOOT + 0.09, D - 0.1, 0.9);
		// Seen from the side the bed faces, a board is behind the bedding; seen from beyond it, in front.
		const headBehind = seesPlus(HEAD);
		const footBehind = !seesPlus(FOOT + T);

		if (headBehind) {
			s += headboard;
		}

		if (footBehind) {
			s += footboard;
		}

		s +=
			box(fr, [HEAD + 0.01, HEAD + 0.09], [D - 0.1, D - 0.02], [0, 0.14], "furnD") +
			box(fr, [FOOT - 0.09, FOOT - 0.01], [D - 0.1, D - 0.02], [0, 0.14], "furnD");
		s += box(fr, [HEAD, FOOT], [0.02, D], [0.14, 0.4], "furn", {
			front: (S) =>
				S.rect(
					HEAD + 0.07,
					0.17,
					FOOT - 0.07,
					0.27,
					`fill="none" ${cls(undefined, "cream")} stroke-width="${strokeAt(
						S,
						0,
						0.22,
						0.012
					)}"`
				) + [-0.6, 0.1, 0.8].map((a) => S.circle(a, 0.22, 0.022, cls("cream"))).join(""),
		});
		s += box(fr, [HEAD + 0.02, FOOT - 0.02], [0.04, D - 0.02], [0.4, 0.58], "mattress");
		const lean = (aBot: number, aTop: number, cBot: number, cTop: number) =>
			surface((b, t) => fr.pt(aBot + (aTop - aBot) * t, b, cBot + (cTop - cBot) * t));

		for (const [b0, b1] of [
			[0.08, 0.68],
			[0.74, 1.34],
		]) {
			const P = lean(HEAD + 0.27, HEAD + 0.06, 0.58, 0.96);
			s +=
				P.poly(roundRect(b0, 0, b1, 1, 0.09, 0.24), cls("pillow")) +
				P.poly(roundRect(b0 + 0.03, 0, b1 - 0.03, 0.36, 0.07, 0.14), cls("pillowShade")) +
				P.line(
					[
						[b0 + 0.1, 0.62],
						[(b0 + b1) / 2, 0.56],
						[b1 - 0.1, 0.62],
					],
					`${cls(undefined, "crease")} stroke-width="${strokeAt(
						P,
						(b0 + b1) / 2,
						0.5,
						0.01
					)}"`
				);
		}

		const Cu = lean(HEAD + 0.42, HEAD + 0.29, 0.58, 0.84);
		s +=
			Cu.poly(roundRect(0.46, 0, 0.96, 1, 0.07, 0.26), cls("rug")) +
			Cu.poly(
				roundRect(0.5, 0.12, 0.92, 0.88, 0.05, 0.2),
				`fill="none" ${cls(undefined, "gold")} stroke-width="${strokeAt(
					Cu,
					0.7,
					0.5,
					0.012
				)}"`
			) +
			Cu.diamond(0.71, 0.5, 0.06, 0.2, cls("gold"));
		const QA = HEAD + 0.5;
		const QT = 0.66;
		const QB = D + 0.03;
		const QF = FOOT - 0.01;
		const Qtop = surface((a, b) => fr.pt(a, b, QT));
		s += Qtop.poly(roundRect(QA, 0.02, QF, QB, 0.07, 0.07), cls("quiltTop"));
		s += Qtop.poly(
			roundRect(QA + 0.24, 0.16, QF - 0.14, QB - 0.14, 0.05, 0.05),
			`fill="none" ${cls(undefined, "cream")} stroke-width="${strokeAt(Qtop, 0, 0.7, 0.018)}"`
		);

		for (const [a, b] of [
			[QA + 0.55, 0.45],
			[QA + 0.55, 0.98],
			[QA + 1.05, 0.45],
			[QA + 1.05, 0.98],
			[QA + 0.8, 0.71],
		]) {
			s += Qtop.circle(a, b, 0.04, cls("gold"));
		}

		s += Qtop.poly(roundRect(QA, 0.02, QA + 0.16, QB, 0.04, 0.05), cls("sheet"));
		const Qf = surface((a, c) => fr.pt(a, QB, c));
		const hem: Array<[number, number]> = [];

		for (let i = 0; i <= 48; i++) {
			const a = QF - ((QF - QA) * i) / 48;
			hem.push([a, 0.3 + 0.016 * Math.sin(a * 6.5)]);
		}

		s += Qf.poly([[QA, QT], [QF, QT], ...hem], cls("blue"));
		s += Qf.line(
			hem.filter(([a]) => a > QA + 0.18).map(([a, c]) => [a, c + 0.07] as [number, number]),
			`${cls(undefined, "cream")} stroke-width="${strokeAt(Qf, 0, 0.4, 0.016)}"`
		);
		s += Qf.poly(
			[
				[QA, QT],
				[QA + 0.16, QT],
				[QA + 0.16, 0.57],
				[QA + 0.08, 0.555],
				[QA, 0.565],
			],
			cls("sheetSide")
		);
		const TA = FOOT - 0.44;
		const TB = FOOT - 0.12;
		const TT = QT + 0.025;
		const Ttop = surface((a, b) => fr.pt(a, b, TT));
		s +=
			Ttop.rect(TA, 0, TB, QB + 0.02, cls("gold")) +
			Ttop.rect(TA + 0.05, 0, TA + 0.09, QB + 0.02, cls("rug")) +
			Ttop.rect(TB - 0.09, 0, TB - 0.05, QB + 0.02, cls("rug"));
		const Tf = surface((a, c) => fr.pt(a, QB + 0.02, c));
		s +=
			Tf.rect(TA, 0.36, TB, TT, fill("gold", "side")) +
			Tf.rect(TA + 0.05, 0.36, TA + 0.09, TT, cls("rug")) +
			Tf.rect(TB - 0.09, 0.36, TB - 0.05, TT, cls("rug"));

		for (let a = TA + 0.02; a < TB; a += 0.035) {
			s += Tf.line(
				[
					[a, 0.36],
					[a, 0.32],
				],
				`${cls(undefined, "gold")} stroke-width="${strokeAt(Tf, a, 0.34, 0.008)}"`
			);
		}

		if (!headBehind) {
			s += headboard;
		}

		if (!footBehind) {
			s += footboard;
		}

		return {d: D + 0.06, svg: s};
	},

	chests(fr, lights) {
		const deco = (w: number, c0: number, h: number) => (S: Painter) => {
			const k = S.px(0, c0 + h / 2);
			const m = c0 + h / 2;
			const scroll = (a: number) =>
				S.line(
					[
						[a, m],
						[a + 0.04, m + 0.05],
						[a + 0.08, m + 0.065],
						[a + 0.12, m + 0.05],
						[a + 0.16, m],
					],
					`${cls(undefined, "green")} stroke-width="${n(0.022 * k)}"`
				);
			return (
				S.rect(
					-w + 0.05,
					c0 + 0.05,
					w - 0.05,
					c0 + h - 0.05,
					`fill="none" ${cls(undefined, "cream")} stroke-width="${n(0.012 * k)}"`
				) +
				S.circle(0, m, h * 0.26, `${cls("blue", "cream")} stroke-width="${n(0.012 * k)}"`) +
				scroll(-w + 0.1) +
				scroll(w - 0.26)
			);
		};
		let s = box(fr, [-0.48, 0.48], [0.02, 0.5], [0, 0.06], "furnD");
		s += box(fr, [-0.5, 0.5], [0, 0.52], [0.06, 0.6], "furn", {front: deco(0.5, 0.06, 0.54)});
		s += box(fr, [-0.45, 0.45], [0, 0.46], [0.6, 1.05], "furn", {front: deco(0.45, 0.6, 0.45)});
		s += box(fr, [0.08, 0.32], [0.05, 0.08], [1.05, 1.34], "woodD", {
			front: (S) =>
				S.rect(0.1, 1.08, 0.3, 1.31, cls("photoSky")) +
				S.poly(
					[
						[0.1, 1.11],
						[0.16, 1.21],
						[0.2, 1.16],
						[0.24, 1.2],
						[0.3, 1.11],
					],
					cls("photoHill")
				) +
				S.rect(0.1, 1.08, 0.3, 1.11, cls("photoGrass")),
		});
		const lampAt = fr.pt(-0.25, 0.24, 1.05);
		s += sprite(lampAt, SPR.lamp) + sprite(fr.pt(0.36, 0.3, 1.05), SPR.bowl);
		lights.lamp = fr.pt(-0.25, 0.24, 1.25);
		lights.flame = sprite(lampAt, SPR.flame);
		return {d: 0.52, svg: s};
	},

	desk(fr, lights) {
		const screen = (S: Painter, attrs: string) => S.rect(-0.29, 0.95, 0.29, 1.27, attrs);
		let s = box(fr, [0.56, 0.62], [0.04, 0.1], [0, 0.71], "wood");
		s += box(fr, [-0.62, -0.22], [0.02, 0.6], [0.02, 0.71], "woodL", {
			front: (S) =>
				S.rect(-0.58, 0.4, -0.26, 0.66, cls("wood")) +
				S.rect(-0.58, 0.08, -0.26, 0.34, cls("wood")) +
				S.circle(-0.42, 0.53, 0.016, cls("gold")) +
				S.circle(-0.42, 0.21, 0.016, cls("gold")),
		});
		s += box(fr, [0.56, 0.62], [0.52, 0.6], [0, 0.71], "wood");
		s += box(fr, [-0.65, 0.65], [0, 0.62], [0.71, 0.75], "wood");
		s +=
			box(fr, [-0.12, 0.12], [0.12, 0.3], [0.75, 0.77], "stand") +
			box(fr, [-0.03, 0.03], [0.18, 0.22], [0.77, 0.95], "stand");
		s += box(fr, [-0.32, 0.32], [0.16, 0.2], [0.92, 1.3], "monitor", {
			front: (S) =>
				screen(S, cls("screenDay")) +
				S.rect(-0.26, 0.98, -0.15, 1.24, `${cls("black")} opacity=".12"`) +
				[1.2, 1.15, 1.1]
					.map((c, i) =>
						S.rect(
							-0.12,
							c,
							[0.12, 0.06, 0.18][i],
							c + 0.025,
							`${cls("black")} opacity=".2"`
						)
					)
					.join("") +
				S.rect(-0.12, 0.99, 0.24, 1.03, `${cls("black")} opacity=".14"`),
		});
		s += box(fr, [-0.22, 0.12], [0.36, 0.5], [0.75, 0.765], "keys");
		s += sprite(fr.pt(0.36, 0.42, 0.75), SPR.mug) + sprite(fr.pt(0.53, 0.14, 0.75), SPR.plant);
		// The chair, pushed in: its back is to the room.
		const seat = fr.pt(0.02, 0.95, 0);
		s += chair(freeFrame(seat[0], seat[2], -fr.n[0], -fr.n[2]));
		lights.screen = fr.pt(0, 0.2, 1.11);
		lights.screenFace = screen(
			surface((a, c) => fr.pt(a, 0.201, c)),
			`fill="#a9c6ff" class="ps-yt-lit" opacity=".85"`
		);
		return {d: 1.14, svg: s};
	},

	kitchen(fr) {
		let s =
			box(fr, [-0.575, -0.545], [0, 0.32], [0.9, 1.9], "wood") +
			box(fr, [0.545, 0.575], [0, 0.32], [0.9, 1.9], "wood");

		for (const c of [1.24, 1.56]) {
			s += box(fr, [-0.545, 0.545], [0, 0.3], [c, c + 0.03], "wood");
		}

		s += box(fr, [-0.575, 0.575], [0, 0.34], [1.87, 1.9], "woodD");

		for (let i = 0; i < 4; i++) {
			s += sprite(fr.pt(-0.4 + i * 0.12, 0.12, 1.59), SPR.plate);
		}

		s += sprite(fr.pt(0.22, 0.14, 1.59), SPR.jarA) + sprite(fr.pt(0.4, 0.14, 1.59), SPR.jarB);
		s +=
			sprite(fr.pt(-0.32, 0.15, 1.27), SPR.bowls) + sprite(fr.pt(0.05, 0.15, 1.27), SPR.cups);
		s += box(fr, [-0.55, 0.55], [0.02, 0.56], [0, 0.06], "furnD");
		s += box(fr, [-0.575, 0.575], [0, 0.58], [0.06, 0.86], "furn", {
			front(S) {
				const k = S.px(0, 0.45);
				return (
					S.rect(-0.53, 0.12, -0.03, 0.8, cls("furnL")) +
					S.rect(0.03, 0.12, 0.53, 0.8, cls("furnL")) +
					S.circle(
						-0.28,
						0.46,
						0.1,
						`${cls("blue", "cream")} stroke-width="${n(0.014 * k)}"`
					) +
					S.circle(
						0.28,
						0.46,
						0.1,
						`${cls("blue", "cream")} stroke-width="${n(0.014 * k)}"`
					)
				);
			},
		});
		s += box(fr, [-0.6, 0.6], [0, 0.62], [0.86, 0.9], "woodL");
		s += sprite(fr.pt(-0.3, 0.3, 0.9), SPR.thermos) + sprite(fr.pt(0.2, 0.32, 0.9), SPR.basin);
		return {d: 0.62, svg: s};
	},

	washstand(fr) {
		const Wl = surface((s, t) => onWall(fr, s, t));
		let s =
			Wl.circle(0, 1.38, 0.24, cls("wood")) +
			Wl.circle(0, 1.38, 0.2, cls("mirror")) +
			Wl.poly(
				[
					[-0.1, 1.3],
					[-0.02, 1.52],
					[0.04, 1.5],
					[-0.04, 1.28],
				],
				`${cls("white")} opacity=".35"`
			);
		s += box(fr, [-0.3, 0.3], [0.02, 0.43], [0, 0.06], "furnD");
		s += box(fr, [-0.32, 0.32], [0, 0.45], [0.06, 0.78], "furn", {
			front: (S) =>
				S.rect(-0.26, 0.14, 0.26, 0.72, cls("furnL")) +
				S.circle(
					0,
					0.43,
					0.1,
					`${cls("blue", "cream")} stroke-width="${strokeAt(S, 0, 0.43, 0.014)}"`
				),
		});
		s += box(fr, [-0.35, 0.35], [0, 0.48], [0.78, 0.82], "woodL");
		s +=
			sprite(fr.pt(-0.06, 0.24, 0.82), SPR.basin, 0.009) +
			sprite(fr.pt(0.24, 0.2, 0.82), SPR.jug, 0.009);
		return {d: 0.48, svg: s};
	},

	hooks(fr) {
		const Wl = surface((s, t) => onWall(fr, s, t));
		const robe: Array<[number, number]> = [
			[-0.38, 1.62],
			[-0.22, 1.62],
			[0.0, 1.5],
			[-0.04, 1.36],
			[-0.12, 1.42],
			[-0.08, 0.5],
			[-0.52, 0.5],
			[-0.48, 1.42],
			[-0.56, 1.36],
			[-0.6, 1.5],
		];
		let s = Wl.rect(-0.6, 1.62, 0.5, 1.68, cls("wood"), 6);
		s +=
			Wl.poly(robe, cls("blue")) +
			Wl.rect(-0.5, 1.02, -0.1, 1.09, cls("gold"), 3) +
			Wl.line(
				[
					[-0.36, 1.6],
					[-0.18, 1.3],
				],
				`${cls(undefined, "cream")} stroke-width="${strokeAt(Wl, -0.3, 1.4, 0.014)}"`
			);
		s +=
			Wl.ellipse(0.2, 1.52, 0.15, 0.09, cls("rug")) +
			Wl.rect(0.03, 1.47, 0.37, 1.5, cls("gold"), 3);
		s +=
			box(fr, [0.0, 0.13], [0.05, 0.36], [0, 0.32], "boots") +
			box(fr, [0.17, 0.3], [0.05, 0.36], [0, 0.32], "boots");
		return {d: 0.36, svg: s};
	},
};

/* ---------- the windows ---------- */
type Quad = Array<[number, number, number]>;
const quadPath = (q: Quad) => "M" + q.map((p) => n(p[0]) + "," + n(p[1])).join(" L") + " Z";

function bbox(q: Quad) {
	const xs = q.map((p) => p[0]);
	const ys = q.map((p) => p[1]);
	return {
		x: Math.min(...xs),
		y: Math.min(...ys),
		w: Math.max(...xs) - Math.min(...xs),
		h: Math.max(...ys) - Math.min(...ys),
	};
}

/** Seeded so every device draws the same stars. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The moon in the back window: the plains' moon with its own ids; publish.ts sets its phase on every `.ps-m-ell`. */
function windowMoon(cx: number, cy: number, r: number): string {
	const size = (r / 30) * 120;
	return (
		`<g class="ps-yt-moon"><svg x="${n(cx - size / 2)}" y="${n(cy - size / 2)}" width="${n(
			size
		)}" height="${n(size)}" viewBox="-60 -60 120 120">` +
		`<defs><radialGradient id="ps-yt-m-halo"><stop offset="0" stop-color="#e3e9ff" stop-opacity=".42"/><stop offset=".55" stop-color="#c7d2ff" stop-opacity=".12"/><stop offset="1" stop-color="#c7d2ff" stop-opacity="0"/></radialGradient>` +
		`<radialGradient id="ps-yt-m-disc" cx=".42" cy=".4" r=".7"><stop offset="0" stop-color="#fdfaf0"/><stop offset=".62" stop-color="#ece5cf"/><stop offset="1" stop-color="#c9c0a6"/></radialGradient>` +
		`<mask id="ps-yt-m-phase" maskUnits="userSpaceOnUse" x="-60" y="-60" width="120" height="120"><rect x="-60" y="-60" width="120" height="120" fill="#000" ${LIT}/>` +
		`<g class="ps-m-shape"><path d="M0,-30 A30,30 0 0 1 0,30 Z" fill="#fff" ${LIT}/><ellipse class="ps-m-ell ps-yt-lit" rx="0" ry="30" fill="#000"/></g></mask></defs>` +
		`<circle r="60" fill="url(#ps-yt-m-halo)"/><circle r="30" fill="#39426a" opacity=".32" ${LIT}/>` +
		`<g mask="url(#ps-yt-m-phase)"><circle r="30" fill="url(#ps-yt-m-disc)"/></g></svg></g>`
	);
}

/** The view out of one window: the sky and the land in the plains' own colours, the stars, and (the back window) the moon and the low sun. */
function windowView(q: Quad, clip: string, side: boolean, seed: number): string {
	const {x: ix, y: iy, w: iw, h: ih} = bbox(q);
	const r = rng(seed);
	let s = `<g clip-path="url(#${clip})"><rect x="${n(ix)}" y="${n(iy)}" width="${n(
		iw
	)}" height="${n(ih)}" fill="url(#ps-yt-sky)"/>`;
	let stars = "";

	for (let i = 0; i < 14; i++) {
		stars += `<circle cx="${n(ix + r() * iw)}" cy="${n(iy + r() * ih * 0.5)}" r="${n(
			0.5 + r() * 0.9
		)}" fill="#fff" opacity="${n(0.5 + r() * 0.5)}" ${LIT}/>`;
	}

	s += `<g class="ps-yt-star">${stars}</g>`;

	if (side) {
		// To the side the plains run flat to low hills.
		s +=
			`<path style="fill: color-mix(in oklab, var(--ps-mount), var(--ps-sky-hor) 50%)" d="M${n(
				ix
			)},${n(iy + ih * 0.6)} Q${n(ix + iw * 0.3)},${n(iy + ih * 0.5)} ${n(ix + iw * 0.6)},${n(
				iy + ih * 0.58
			)} T${n(ix + iw)},${n(iy + ih * 0.55)} V${n(iy + ih)} H${n(ix)} Z"/>` +
			`<rect x="${n(ix)}" y="${n(iy + ih * 0.66)}" width="${n(iw)}" height="${n(
				ih * 0.34
			)}" style="fill: var(--ps-far)"/>` +
			`<path style="fill: var(--ps-hill2)" d="M${n(ix)},${n(iy + ih * 0.84)} Q${n(
				ix + iw * 0.5
			)},${n(iy + ih * 0.74)} ${n(ix + iw)},${n(iy + ih * 0.82)} V${n(iy + ih)} H${n(
				ix
			)} Z"/>`;
	} else {
		s += windowMoon(ix + iw * 0.24, iy + ih * 0.2, 8);
		s += `<g class="ps-yt-window-sun"><circle cx="${n(ix + iw * 0.78)}" cy="${n(
			iy + ih * 0.5
		)}" r="36" fill="url(#ps-yt-sun-glow)"/><circle cx="${n(ix + iw * 0.78)}" cy="${n(
			iy + ih * 0.5
		)}" r="9" fill="#fff3cf" ${LIT}/></g>`;
		const sx = Math.round((iw / 400) * 1000) / 1000;
		const sy = Math.round((ih / 161) * 1000) / 1000;
		s +=
			`<g transform="translate(${n(ix - 470 * sx)},${n(iy)}) scale(${sx},${sy})">` +
			`<path style="fill: color-mix(in oklab, var(--ps-mount), var(--ps-sky-hor) 45%)" d="M0,86 C60,70 110,54 170,62 C230,70 260,40 330,44 C400,48 430,76 500,70 C580,62 620,30 700,36 C780,42 820,70 900,64 C980,58 1030,34 1100,42 C1150,48 1180,60 1200,62 L1200,400 L0,400 Z"/>` +
			`<path style="fill: color-mix(in oklab, var(--ps-mount), #fff 55%)" opacity=".7" d="M580,62 C600,46 620,30 700,36 C730,38 752,46 770,54 C740,52 720,50 700,52 C670,48 640,58 600,64 Z"/>` +
			`<path style="fill: var(--ps-mount)" d="M0,112 C80,96 140,84 220,92 C300,100 340,76 420,80 C500,84 560,104 640,98 C720,92 780,72 860,78 C940,84 1000,102 1080,96 C1140,92 1180,98 1200,100 L1200,400 L0,400 Z"/>` +
			`<path style="fill: var(--ps-far)" d="M0,128 C200,120 400,132 600,126 C800,120 1000,132 1200,126 L1200,400 L0,400 Z"/>` +
			`<path style="fill: var(--ps-hill2)" transform="translate(0,-58)" d="M0,190 C120,170 260,160 400,172 C520,182 600,200 740,188 C880,176 1000,160 1200,176 L1200,400 L0,400 Z"/>` +
			`</g>`;
	}

	s += `<polygon points="${n(ix + iw * 0.1)},${n(iy)} ${n(ix + iw * 0.32)},${n(iy)} ${n(
		ix + iw * 0.02
	)},${n(iy + ih)} ${n(ix - iw * 0.2)},${n(iy + ih)}" fill="#ffffff" opacity=".07" ${LIT}/>`;
	return s + `</g>`;
}

/** The curtain left of the back window, in the window's plane (metres); the right one is its mirror. */
function curtainOutline(m: number): Array<[number, number]> {
	const o = WX - 1.1;
	const P0: [number, number] = [-1.42 - o, 2.0];
	const P1: [number, number] = [-0.92 - o, 2.0];
	const tieIn: [number, number] = [-1.14 - o, 1.15];
	const botIn: [number, number] = [-1.06 - o, 0.36];
	const botOut: [number, number] = [-1.5 - o, 0.36];
	const tieOut: [number, number] = [-1.3 - o, 1.15];
	const l: Array<[number, number]> = [
		P0,
		P1,
		...quadratic(P1, [-0.98 - o, 1.6], tieIn),
		...quadratic(tieIn, [-1.2 - o, 0.8], botIn),
		botOut,
		...quadratic(botOut, [-1.44 - o, 0.8], tieOut),
		...quadratic(tieOut, [-1.5 - o, 1.6], P0),
	];
	return l.map(([s, t]) => [s * m, t]);
}

/** The back window's pane, projected. */
function backPane(): Quad {
	return (
		[
			[-WX + FR, WY0 + FR],
			[WX - FR, WY0 + FR],
			[WX - FR, WY1 - FR],
			[-WX + FR, WY1 - FR],
		] as const
	).map(([s, t]) => project([s, t, ZW]));
}

/** A side window's pane, projected: 1.06 m wide, from 1.07 m to 1.78 m. */
function sidePane(fr: Frame): Quad {
	return (
		[
			[-0.528, 1.07],
			[0.528, 1.07],
			[0.528, 1.78],
			[-0.528, 1.78],
		] as const
	).map(([a, c]) => project(fr.pt(a, 0.03, c)));
}

/** The panes the weather shows in: the back window's, and each side window's while it is in front of the eye. */
function windowPanes(): Array<{clip: string; inner: Quad}> {
	const out = [{clip: WINDOW_CLIPS[0] as string, inner: backPane()}];

	SIDE_WINDOWS.forEach((th, i) => {
		const fr = wallFrame(th);

		if ([-0.6, 0.6].some((a) => [1.0, 1.85].some((c) => depthOf(fr.pt(a, 0.03, c)) < NEAR))) {
			return;
		}

		out.push({clip: WINDOW_CLIPS[i + 1], inner: sidePane(fr)});
	});

	return out;
}

/** A cloud in the plains' own cloud colour. */
function cloud(x: number, y: number, k: number, style = "fill: var(--ps-cloud)"): string {
	return `<g class="ps-yt-cloud" style="${style}" transform="translate(${n(x)},${n(y)}) scale(${
		Math.round(k * 100) / 100
	})"><ellipse cx="0" cy="4" rx="22" ry="6"/><ellipse cx="-8" cy="0" rx="9" ry="7"/><ellipse cx="5" cy="-2" rx="11" ry="9"/><ellipse cx="15" cy="2" rx="8" ry="6"/></g>`;
}

/** How many clouds the back window shows in each fair weather. */
const FAIR_CLOUDS: Partial<Record<Weather, number>> = {clear: 2, wind: 4, heat: 1};

/**
 * The day's weather in the windows (docs/projects/ps-yurt.md §7), still: the
 * contents of `.ps-yt-weather`, rebuilt when the day's weather changes. Each
 * window is veiled as the plains are on a wet day (their own --ps-veil);
 * counts are the back window's, scaled by each window's width and halved on a
 * phone, from fixed seeds so every device draws the same.
 */
export function windowWeather(weather: Weather, phone: boolean): string {
	const panes = windowPanes();
	const backWidth = bbox(panes[0].inner).w;
	let out = `<g data-weather="${weather}">`;

	panes.forEach((pane, i) => {
		const {x: ix, y: iy, w: iw, h: ih} = bbox(pane.inner);
		const r = rng(211 + i * 17 + WEATHERS.indexOf(weather) * 101);
		const count = (k: number) =>
			Math.max(1, Math.round(k * (iw / backWidth) * (phone ? 0.5 : 1)));
		let s = `<g clip-path="url(#${pane.clip})">`;
		s += `<rect x="${n(ix)}" y="${n(iy)}" width="${n(iw)}" height="${n(
			ih
		)}" style="fill: var(--ps-veil-c); opacity: var(--ps-veil)"/>`;
		const fair = FAIR_CLOUDS[weather];

		if (fair !== undefined) {
			for (let k = 0; k < count(fair); k++) {
				s += cloud(
					ix + iw * (0.15 + 0.7 * r()),
					iy + ih * (0.1 + 0.25 * r()),
					(0.55 + 0.35 * r()) * (iw / backWidth) ** 0.3
				);
			}
		} else {
			const deck =
				weather === "storm"
					? "color-mix(in oklab, var(--ps-cloud), #000 30%)"
					: weather === "rain"
					? "color-mix(in oklab, var(--ps-cloud), #000 10%)"
					: "color-mix(in oklab, var(--ps-cloud), #fff 30%)";
			s += `<rect class="ps-yt-deck" x="${n(ix)}" y="${n(iy)}" width="${n(iw)}" height="${n(
				ih * 0.4
			)}" style="fill: ${deck}" opacity=".85"/>`;
			s +=
				cloud(ix + iw * 0.25, iy + ih * 0.32, 1.3, `fill: ${deck}`) +
				cloud(ix + iw * 0.7, iy + ih * 0.36, 1.5, `fill: ${deck}`);
		}

		if (weather === "rain" || weather === "storm") {
			for (let k = 0; k < count(weather === "storm" ? 60 : 34); k++) {
				const x = ix + r() * (iw + 10);
				const y = iy + r() * ih;
				s += `<line class="ps-yt-rain" x1="${n(x)}" y1="${n(y)}" x2="${n(x - 3)}" y2="${n(
					y + 9
				)}" style="stroke: color-mix(in oklab, var(--ps-sky-hor), #fff 45%)" stroke-width="1" opacity=".6"/>`;
			}

			for (let k = 0; k < count(14); k++) {
				s += `<circle class="ps-yt-drop ps-yt-lit" cx="${n(
					ix + 4 + r() * (iw - 8)
				)}" cy="${n(iy + 4 + r() * (ih - 8))}" r="${n(
					1 + r() * 1.2
				)}" fill="#ffffff" opacity=".32"/>`;
			}
		}

		if (weather === "snow") {
			for (let k = 0; k < count(44); k++) {
				s += `<circle class="ps-yt-flake" cx="${n(ix + r() * iw)}" cy="${n(
					iy + r() * ih
				)}" r="${n(
					0.7 + r() * 1.2
				)}" style="fill: color-mix(in oklab, var(--ps-cloud), #fff 60%)"/>`;
			}

			s += `<path class="ps-yt-drift" style="fill: color-mix(in oklab, var(--ps-cloud), #fff 70%)" d="M${n(
				ix
			)},${n(iy + ih)} L${n(ix)},${n(iy + ih - 5)} Q${n(ix + iw * 0.2)},${n(iy + ih - 9)} ${n(
				ix + iw * 0.42
			)},${n(iy + ih - 6)} Q${n(ix + iw * 0.7)},${n(iy + ih - 3)} ${n(ix + iw)},${n(
				iy + ih - 8
			)} L${n(ix + iw)},${n(iy + ih)} Z"/>`;
		}

		out += s + `</g>`;
	});

	return out + `</g>`;
}

/** The room, as the page shows it. */
export function roomMarkup(): string {
	// The walls and the roof.
	const top = arc(WALL_H);
	const base = arc(0);
	const wallPoly = pts([...top, ...base.slice().reverse()]);
	const roofPoly = pts([...top, [top[top.length - 1][0], -9000], [top[0][0], -9000]]);
	const ribbon = (h0: number, h1: number, r: number, attrs: string) =>
		`<polygon points="${pts([...arc(h0, r), ...arc(h1, r).reverse()])}" ${attrs}/>`;
	let lattice = "";

	for (let th0 = -180; th0 < 180; th0 += 5) {
		for (const dir of [1, -1]) {
			const l: P3[] = [];

			for (let k = 0; k <= 10; k++) {
				l.push(wallPt(th0 + (dir * 28.6 * k) / 10, (WALL_H * k) / 10, R - 0.03));
			}

			lattice += polyRuns(l, cls(undefined, "lattice"), 0.028);
		}
	}

	let poles = "";

	for (let th = 0; th < 360; th += 5) {
		poles += line3(
			wallPt(th, WALL_H - 0.02, R - 0.06),
			wallPt(th, CROWN_H - 0.04, CROWN_R + 0.06),
			`${cls(undefined, "pole")} stroke-linecap="round"`,
			0.04,
			7
		);
	}

	let boards = "";

	for (let x = -R; x <= R; x += 0.22) {
		const zz = Math.sqrt(Math.max(0, R * R - x * x));
		boards += line3([x, 0, -zz], [x, 0, zz], cls(undefined, "board"), 0.012);
	}

	// The crown: its ring, the sky through it, its bent ribs.
	const openingPts = pts(circle3(0, CROWN_H, 0, CROWN_R - 0.06).map(project));
	const arch = (f: number, alongX: boolean) => {
		const l: P3[] = [];
		const rr = CROWN_R - 0.06;

		for (let k = 0; k <= 12; k++) {
			const u = -rr + (2 * rr * k) / 12;
			const h = CROWN_H + 0.22 * (1 - (u / rr) ** 2);
			l.push(alongX ? [u, h, f] : [f, h, u]);
		}

		return l;
	};
	const ribs = [arch(-0.28, true), arch(0.28, true), arch(-0.28, false), arch(0.28, false)]
		.map((l) => polyRuns(l, cls(undefined, "crown"), 0.045))
		.join("");
	let crownStars = "";
	const r = rng(31);

	for (let i = 0; i < 7; i++) {
		const a = r() * 2 * Math.PI;
		const d = Math.sqrt(r()) * 0.55;
		const p = project([Math.cos(a) * d, CROWN_H + 0.5, Math.sin(a) * d]);
		crownStars += `<circle cx="${n(p[0])}" cy="${n(p[1])}" r="${n(
			0.8 + r()
		)}" fill="#fff" opacity=".85" ${LIT}/>`;
	}

	// The windows: the wide back one with curtains, and one on each side.
	const W = surface((s, t) => [s, t, ZW]);
	const Cp = surface((s, t) => [s, t, ZW - 0.05]);
	const backInner = backPane();
	const backOuter: Quad = (
		[
			[-WX, WY0],
			[WX, WY0],
			[WX, WY1],
			[-WX, WY1],
		] as const
	).map(([s, t]) => project([s, t, ZW]));
	const views: Array<{inner: Quad; clip: string; side: boolean; seed: number}> = [
		{inner: backInner, clip: WINDOW_CLIPS[0], side: false, seed: 77},
	];
	let back = `<path ${cls("wood")} fill-rule="evenodd" d="${quadPath(backOuter)} ${quadPath(
		backInner
	)}"/>`;

	for (const x of [-WX / 2, 0, WX / 2]) {
		back += W.rect(x - 0.025, WY0 + FR, x + 0.025, WY1 - FR, cls("wood"));
	}

	back += W.rect(-WX + FR, 1.36, WX - FR, 1.41, cls("wood"));
	back += `<polygon points="${pts(backInner)}" fill="none" ${cls(
		undefined,
		"woodD"
	)} stroke-width="1.5"/>`;
	back += abox([-WX - 0.12, WX + 0.12], [WY0 - 0.06, WY0], [ZW - 0.16, ZW + 0.02], "woodL");
	back +=
		sprite([-WX + 0.32, WY0, ZW - 0.08], SPR.plant, 0.0085) +
		sprite([WX - 0.4, WY0, ZW - 0.08], SPR.jug, 0.0075);
	back += line3(
		[-WX - 0.55, 2.04, ZW - 0.06],
		[WX + 0.55, 2.04, ZW - 0.06],
		`${cls(undefined, "woodD")} stroke-linecap="round"`,
		0.04
	);
	let curtains = "";

	for (const m of [1, -1]) {
		const o = WX - 1.1;
		curtains += Cp.poly(curtainOutline(m), cls("curtain"));
		curtains += (
			[
				[
					[-1.25 - o, 1.98],
					[-1.24 - o, 1.6],
					[-1.22 - o, 1.17],
				],
				[
					[-1.05 - o, 1.98],
					[-1.08 - o, 1.6],
					[-1.18 - o, 1.17],
				],
				[
					[-1.2 - o, 1.13],
					[-1.26 - o, 0.8],
					[-1.3 - o, 0.44],
				],
			] as const
		)
			.map(([a, c, b]) =>
				Cp.line(
					[a, ...quadratic(a, c, b)].map(([x, y]) => [x * m, y] as [number, number]),
					`${cls(undefined, "cream")} stroke-width="${strokeAt(
						Cp,
						(-1.2 - o) * m,
						1.2,
						0.012
					)}" opacity=".55"`
				)
			)
			.join("");
		curtains += Cp.ellipse((-1.22 - o) * m, 1.15, 0.1, 0.04, cls("gold"));
	}

	let sideWindows = "";

	SIDE_WINDOWS.forEach((th, i) => {
		const fr = wallFrame(th);
		const S = surface((a, c) => fr.pt(a, 0.03, c));
		const corners: Array<[number, number]> = [
			[-0.6, 1.0],
			[0.6, 1.0],
			[0.6, 1.85],
			[-0.6, 1.85],
		];

		if (corners.some(([a, c]) => depthOf(fr.pt(a, 0.03, c)) < NEAR)) {
			return;
		}

		const innerQ = sidePane(fr);
		const outer: Quad = corners.map(([a, c]) => project(fr.pt(a, 0.03, c)));
		views.push({inner: innerQ, clip: WINDOW_CLIPS[i + 1], side: true, seed: 101 + i});
		sideWindows += piece(
			i === 0 ? "window-left" : "window-right",
			`<path ${cls("wood")} fill-rule="evenodd" d="${quadPath(outer)} ${quadPath(
				innerQ
			)}"/>` +
				S.rect(-0.022, 1.07, 0.022, 1.78, cls("wood")) +
				S.rect(-0.53, 1.42, 0.53, 1.46, cls("wood")) +
				`<polygon points="${pts(innerQ)}" fill="none" ${cls(
					undefined,
					"woodD"
				)} stroke-width="1.2"/>` +
				box(fr, [-0.68, 0.68], [0, 0.12], [0.94, 1.0], "woodL") +
				S.rect(-0.72, 1.86, 0.72, 1.93, cls("curtain")) +
				S.rect(-0.72, 1.86, 0.72, 1.875, cls("rugB"))
		);
	});

	// The round stove and its pipe through the crown.
	const doorMap = (s: number, t: number): P3 => {
		const ph = -Math.PI / 2 + s / STOVE_R;
		return [(STOVE_R + 0.003) * Math.cos(ph), t, (STOVE_R + 0.003) * Math.sin(ph)];
	};
	const Dr = surface(doorMap);
	const across = (y0: number, y1: number, half: number, z: number, attrs: string) =>
		poly3(
			[
				[-half, y0, z],
				[half, y0, z],
				[half, y1, z],
				[-half, y1, z],
			],
			attrs
		);
	// The stove, drawn twice: once in its place among what stands, once over the glows (body, below).
	const stoveBody =
		[-2.4, -0.75, 0.9, 2.55]
			.map((a) =>
				abox(
					[Math.cos(a) * 0.3 - 0.03, Math.cos(a) * 0.3 + 0.03],
					[0, 0.16],
					[Math.sin(a) * 0.3 - 0.03, Math.sin(a) * 0.3 + 0.03],
					"ironD"
				)
			)
			.join("") +
		cylinderSide(0, 0, STOVE_R + 0.02, 0.14, 0.18, cls("ironTop")) +
		cylinderSide(0, 0, STOVE_R, 0.18, 0.72, 'fill="url(#ps-yt-iron)"') +
		cylinderSide(0, 0, STOVE_R + 0.008, 0.22, 0.25, 'fill="url(#ps-yt-brass)"') +
		cylinderSide(0, 0, STOVE_R + 0.008, 0.64, 0.67, 'fill="url(#ps-yt-brass)"') +
		Dr.arched(
			-0.17,
			0.17,
			0.29,
			0.5,
			0.08,
			`${cls("ironD", "doorEdge")} stroke-width="${strokeAt(Dr, 0, 0.4, 0.012)}"`
		) +
		Dr.rect(-0.11, 0.26, 0.11, 0.28, cls("ironD")) +
		Dr.circle(0.13, 0.42, 0.017, cls("gold")) +
		cylinderSide(0, 0, STOVE_R + 0.04, 0.72, 0.76, cls("ironTop")) +
		poly3(circle3(0, 0.76, 0, STOVE_R + 0.04), cls("ironTopL")) +
		poly3(
			circle3(0, 0.762, 0, STOVE_R - 0.06),
			`fill="none" ${cls(undefined, "ironRing")} stroke-width="1.2"`
		) +
		cylinderSide(0, 0.1, 0.11, 0.76, 0.84, cls("collar")) +
		poly3(circle3(0, 0.84, 0.1, 0.11, 24), cls("collarTop")) +
		across(0.84, CROWN_H + 0.3, 0.075, 0.1, cls("pipe")) +
		[1.1, 1.6, 2.1, 2.6].map((h) => across(h, h + 0.04, 0.088, 0.1, cls("pipeBand"))).join("") +
		sprite([-0.17, 0.76, -0.1], SPR.pot + SPR.steam, 0.0055) +
		sprite([0.18, 0.76, -0.12], SPR.kettle, 0.0055);
	const stove = piece("stove", stoveBody);
	const fire =
		Dr.arched(-0.125, 0.125, 0.33, 0.48, 0.06, `fill="url(#ps-yt-fire)" ${LIT}`) +
		Dr.poly(
			[
				[-0.09, 0.34],
				[-0.11, 0.4],
				[-0.06, 0.46],
				[-0.05, 0.51],
				[-0.01, 0.45],
				[0.0, 0.39],
				[-0.02, 0.34],
			],
			`fill="#fff6c4" opacity=".9" ${LIT}`
		) +
		Dr.poly(
			[
				[0.02, 0.34],
				[0.0, 0.41],
				[0.05, 0.47],
				[0.07, 0.52],
				[0.1, 0.45],
				[0.11, 0.39],
				[0.09, 0.34],
			],
			`fill="#fff6c4" opacity=".9" ${LIT}`
		) +
		Dr.rect(-0.125, 0.33, 0.125, 0.36, `fill="#ffcf6a" opacity=".55" ${LIT}`);
	const door = project(doorMap(0, 0.42));

	// The posts that hold the crown.
	const post = (x: number) => {
		const bands = (S: Painter, s0: number, s1: number) =>
			[0.55, 1.45, 2.35]
				.map(
					(h) =>
						S.rect(s0, h, s1, h + 0.13, cls("blue")) +
						S.line(
							[
								[s0, h + 0.13],
								[s1, h + 0.13],
							],
							`${cls(undefined, "cream")} stroke-width="${strokeAt(
								S,
								(s0 + s1) / 2,
								h,
								0.012
							)}"`
						)
				)
				.join("");
		return piece(
			"post",
			abox([x - 0.09, x + 0.09], [0, 0.15], [-0.09, 0.09], "furnD") +
				abox([x - 0.06, x + 0.06], [0.15, CROWN_H - 0.2], [-0.06, 0.06], "pole", {
					front: (S) => bands(S, x - 0.06, x + 0.06),
					left: (S) => bands(S, -0.06, 0.06),
					right: (S) => bands(S, -0.06, 0.06),
				}) +
				abox([x - 0.09, x + 0.09], [CROWN_H - 0.2, CROWN_H - 0.08], [-0.09, 0.09], "furnD")
		);
	};

	// The dining table on its pedestal, all of it on the rug.
	const table = () => {
		const [tx, tz] = TABLE;
		let s =
			cylinderSide(tx, tz, 0.28, 0, 0.05, cls("furnD")) +
			poly3(circle3(tx, 0.05, tz, 0.28, 32), fill("furnD", "top"));
		s += cylinderSide(tx, tz, 0.07, 0.05, 0.71, 'fill="url(#ps-yt-wood)"');
		s += cylinderSide(tx, tz, 0.11, 0.3, 0.36, cls("blue"));
		s +=
			cylinderSide(tx, tz, 0.52, 0.71, 0.75, cls("furnD")) +
			poly3(circle3(tx, 0.75, tz, 0.52), cls("furn"));
		const T = surface((a, b) => [tx + a, 0.751, tz + b]);
		s +=
			T.ellipse(
				0,
				0,
				0.38,
				0.38,
				`fill="none" ${cls(undefined, "cream")} stroke-width="${strokeAt(T, 0, 0, 0.012)}"`
			) +
			T.ellipse(
				0,
				0,
				0.46,
				0.46,
				`fill="none" ${cls(undefined, "blue")} stroke-width="${strokeAt(
					T,
					0,
					0,
					0.012
				)}" stroke-dasharray="${strokeAt(T, 0, 0, 0.05)} ${strokeAt(T, 0, 0, 0.05)}"`
			);
		s +=
			sprite([tx + 0.08, 0.75, tz + 0.2], SPR.teapot, 0.006) +
			sprite([tx - 0.1, 0.75, tz - 0.05], SPR.dumplings, 0.006) +
			sprite([tx + 0.24, 0.75, tz - 0.14], SPR.tbowl, 0.006);
		return piece("table", s);
	};

	// The pieces along the wall, then everything standing, far to near.
	const lights: Lights = {};
	const things: Array<{z: number; svg: string}> = ROOM.map(([kind, th]) => {
		const fr = wallFrame(th);
		const p = PIECES[kind](fr, lights);
		return {z: depthOf(fr.pt(0, p.d, 0.6)), svg: piece(kind, p.svg)};
	});
	things.push(
		{z: depthOf([-0.63, 1, 0]), svg: post(-0.63)},
		{z: depthOf([0.63, 1, 0]), svg: post(0.63)}
	);
	things.push({z: depthOf([0, 0.4, -STOVE_R]), svg: stove});
	things.push({z: depthOf([TABLE[0], 0.4, TABLE[1]]), svg: table()});

	for (const [dx, dz] of [
		[-0.66, 0.0],
		[0.06, 0.66],
	]) {
		const cx = TABLE[0] + dx;
		const cz = TABLE[1] + dz;
		things.push({z: depthOf([cx, 0.5, cz]), svg: chair(freeFrame(cx, cz, -dx, -dz))});
	}

	things.push({
		z: depthOf([BASKET[0], 0.3, BASKET[1]]),
		svg: piece("basket", sprite([BASKET[0], 0, BASKET[1]], SPR.basket, 0.0062)),
	});
	const standing = things
		.filter((t) => t.z > NEAR)
		.sort((a, b) => b.z - a.z)
		.map((t) => t.svg)
		.join("");

	// The floor's things: the rug, the hearth, the light that falls there.
	const Fl = surface((a, b) => [a, 0.005, b]);
	const rug =
		Fl.ellipse(0, 0.1, RUG_R, RUG_R, cls("rug"), 72) +
		Fl.ellipse(
			0,
			0.1,
			RUG_R - 0.14,
			RUG_R - 0.14,
			`fill="none" ${cls(undefined, "rugB")} stroke-width="${strokeAt(Fl, 0, 0.1, 0.05)}"`,
			72
		) +
		Fl.ellipse(
			0,
			0.1,
			RUG_R - 0.38,
			RUG_R - 0.38,
			`fill="none" ${cls(undefined, "rugP")} stroke-width="${strokeAt(
				Fl,
				0,
				0.1,
				0.045
			)}" stroke-dasharray="${strokeAt(Fl, 0, 0.1, 0.12)} ${strokeAt(Fl, 0, 0.1, 0.08)}"`,
			72
		) +
		Fl.ellipse(
			0,
			0.1,
			RUG_R - 0.64,
			RUG_R - 0.64,
			`fill="none" ${cls(undefined, "rugB")} stroke-width="${strokeAt(Fl, 0, 0.1, 0.015)}"`,
			72
		);
	const patch: [number, number] = [-0.95, 0.85];
	const beam = hull(
		[
			...circle3(0, CROWN_H, 0, CROWN_R - 0.06, 24),
			...circle3(patch[0], 0.005, patch[1], 0.8, 24),
		].map(project)
	);
	const lamp = lights.lamp && depthOf(lights.lamp) > NEAR ? project(lights.lamp) : null;
	const screenAt = lights.screen && depthOf(lights.screen) > NEAR ? project(lights.screen) : null;
	const backBox = bbox(backInner);

	const defs =
		`<defs>` +
		`<linearGradient id="ps-yt-roof" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="380"><stop offset="0" ${cls(
			"roofA",
			undefined,
			"ps-yt-stop"
		)}/><stop offset="1" ${cls("roofB", undefined, "ps-yt-stop")}/></linearGradient>` +
		`<linearGradient id="ps-yt-wall" gradientUnits="userSpaceOnUse" x1="0" y1="300" x2="0" y2="700"><stop offset="0" ${cls(
			"wallA",
			undefined,
			"ps-yt-stop"
		)}/><stop offset="1" ${cls("wallB", undefined, "ps-yt-stop")}/></linearGradient>` +
		`<linearGradient id="ps-yt-floor" gradientUnits="userSpaceOnUse" x1="0" y1="470" x2="0" y2="820"><stop offset="0" ${cls(
			"floorA",
			undefined,
			"ps-yt-stop"
		)}/><stop offset="1" ${cls("floorB", undefined, "ps-yt-stop")}/></linearGradient>` +
		`<linearGradient id="ps-yt-iron" x1="0" y1="0" x2="1" y2="0"><stop offset="0" ${cls(
			"ironD",
			undefined,
			"ps-yt-stop"
		)}/><stop offset=".38" ${cls("ironLit", undefined, "ps-yt-stop")}/><stop offset=".62" ${cls(
			"ironMid",
			undefined,
			"ps-yt-stop"
		)}/><stop offset="1" ${cls("ironShadow", undefined, "ps-yt-stop")}/></linearGradient>` +
		`<linearGradient id="ps-yt-brass" x1="0" y1="0" x2="1" y2="0"><stop offset="0" ${cls(
			"brassA",
			undefined,
			"ps-yt-stop"
		)}/><stop offset=".38" ${cls("brassB", undefined, "ps-yt-stop")}/><stop offset=".62" ${cls(
			"brassC",
			undefined,
			"ps-yt-stop"
		)}/><stop offset="1" ${cls("brassD", undefined, "ps-yt-stop")}/></linearGradient>` +
		`<linearGradient id="ps-yt-wood" x1="0" y1="0" x2="1" y2="0"><stop offset="0" ${cls(
			"woodRed",
			undefined,
			"ps-yt-stop"
		)}/><stop offset=".4" ${cls("furnL", undefined, "ps-yt-stop")}/><stop offset="1" ${cls(
			"woodRed",
			undefined,
			"ps-yt-stop"
		)}/></linearGradient>` +
		`<linearGradient id="ps-yt-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color: var(--ps-sky-top)"/><stop offset=".55" style="stop-color: var(--ps-sky-mid)"/><stop offset="1" style="stop-color: var(--ps-sky-hor)"/></linearGradient>` +
		`<radialGradient id="ps-yt-sun-glow"><stop offset="0" stop-color="#ffe2a0" stop-opacity=".9"/><stop offset="1" stop-color="#ffb060" stop-opacity="0"/></radialGradient>` +
		`<radialGradient id="ps-yt-fire" cx=".5" cy=".85" r=".8"><stop offset="0" stop-color="#fff6c0"/><stop offset=".4" stop-color="#ffb347"/><stop offset=".8" stop-color="#e2582a"/><stop offset="1" stop-color="#9c2f1a"/></radialGradient>` +
		`<radialGradient id="ps-yt-g-fire"><stop offset="0" stop-color="#ffa040" stop-opacity=".85"/><stop offset=".45" stop-color="#ff7a2a" stop-opacity=".32"/><stop offset="1" stop-color="#ff6a20" stop-opacity="0"/></radialGradient>` +
		`<radialGradient id="ps-yt-g-lamp"><stop offset="0" stop-color="#ffd08a" stop-opacity=".8"/><stop offset="1" stop-color="#ffb060" stop-opacity="0"/></radialGradient>` +
		`<radialGradient id="ps-yt-g-screen"><stop offset="0" stop-color="#9fbaff" stop-opacity=".55"/><stop offset="1" stop-color="#7f9fff" stop-opacity="0"/></radialGradient>` +
		`<radialGradient id="ps-yt-g-golden"><stop offset="0" stop-color="#ffb070" stop-opacity=".9"/><stop offset="1" stop-color="#ffb070" stop-opacity="0"/></radialGradient>` +
		`<linearGradient id="ps-yt-beam-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffbe8" stop-opacity=".34"/><stop offset="1" stop-color="#fff3cc" stop-opacity=".07"/></linearGradient>` +
		`<clipPath id="ps-yt-roof-clip"><polygon points="${roofPoly}"/></clipPath>` +
		`<clipPath id="ps-yt-wall-clip"><polygon points="${wallPoly}"/></clipPath>` +
		views
			.map((v) => `<clipPath id="${v.clip}"><polygon points="${pts(v.inner)}"/></clipPath>`)
			.join("") +
		`<clipPath id="ps-yt-crown"><polygon points="${openingPts}"/></clipPath>` +
		`</defs>`;

	const body =
		// The floor first: everything else stands on it or rises from its edge.
		`<rect x="-3000" y="-3000" width="8000" height="8000" fill="url(#ps-yt-floor)"/>` +
		`<g opacity=".5">${boards}</g>` +
		// The roof and its poles, the crown.
		`<polygon points="${roofPoly}" fill="url(#ps-yt-roof)"/>` +
		`<g clip-path="url(#ps-yt-roof-clip)">${poles}</g>` +
		piece(
			"crown",
			poly3(circle3(0, CROWN_H, 0, CROWN_R + 0.1), cls("crown")) +
				`<polygon points="${openingPts}" style="fill: color-mix(in oklab, var(--ps-sky-top), var(--ps-sky-mid) 35%)"/>` +
				`<polygon points="${openingPts}" style="fill: var(--ps-veil-c); opacity: var(--ps-veil)"/>` +
				`<g clip-path="url(#ps-yt-crown)"><g class="ps-yt-star">${crownStars}</g>${ribs}</g>` +
				poly3(
					circle3(0, CROWN_H, 0, CROWN_R - 0.03),
					`fill="none" ${cls(undefined, "poleEdge")} stroke-width="2"`
				)
		) +
		// The wall: lining, lattice, the band under the roof and the skirt.
		`<polygon points="${wallPoly}" fill="url(#ps-yt-wall)"/>` +
		`<g clip-path="url(#ps-yt-wall-clip)" opacity=".9">${lattice}</g>` +
		ribbon(WALL_H - 0.09, WALL_H, R - 0.04, cls("band")) +
		ribbon(0, 0.1, R - 0.04, cls("skirt")) +
		// The views out, their weather (the scene fills it for the day), the windows' frames.
		views.map((v) => windowView(v.inner, v.clip, v.side, v.seed)).join("") +
		`<g class="ps-yt-weather" data-weather=""></g>` +
		piece("window-back", back) +
		piece("curtains", curtains) +
		sideWindows +
		// On the floor: the rug, the hearth, the light that falls there.
		piece("rug", rug) +
		Fl.ellipse(0, 0, 0.66, 0.66, cls("hearth")) +
		Fl.ellipse(0, 0, 0.58, 0.58, cls("hearthL")) +
		`<g class="ps-yt-pool-sun">${Fl.ellipse(
			patch[0],
			patch[1],
			0.8,
			0.8,
			`fill="#fff6dc" opacity=".45" ${LIT}`
		)}</g>` +
		`<g class="ps-yt-golden">${Fl.ellipse(
			0.15,
			2.4,
			0.9,
			0.5,
			`fill="#ffc070" opacity=".6" ${LIT}`
		)}<ellipse cx="${n(backBox.x + backBox.w / 2)}" cy="${n(
			backBox.y + backBox.h / 2
		)}" rx="${n(backBox.w * 0.8)}" ry="${n(
			backBox.h * 1.2
		)}" fill="url(#ps-yt-g-golden)"/></g>` +
		// Everything standing, far to near.
		standing +
		// The glows light the walls, the floor and everything standing (a screen blend over them, the
		// mockup's order); the stove is drawn again over them, so its iron stays dark against its own glow.
		`<g style="mix-blend-mode: screen">` +
		`<circle class="ps-yt-glow-fire" cx="${n(door[0])}" cy="${n(door[1])}" r="${n(
			(FOCAL * 2.4) / door[2]
		)}" fill="url(#ps-yt-g-fire)"/>` +
		`<g class="ps-yt-glow-fire">${Fl.ellipse(
			0,
			-0.5,
			1.3,
			1.0,
			'fill="url(#ps-yt-g-fire)"'
		)}</g>` +
		(lamp
			? `<circle class="ps-yt-glow-lamp" cx="${n(lamp[0])}" cy="${n(lamp[1])}" r="${n(
					(FOCAL * 0.75) / lamp[2]
			  )}" fill="url(#ps-yt-g-lamp)"/>`
			: "") +
		(screenAt
			? `<circle class="ps-yt-glow-screen" cx="${n(screenAt[0])}" cy="${n(
					screenAt[1]
			  )}" r="${n((FOCAL * 0.45) / screenAt[2])}" fill="url(#ps-yt-g-screen)"/>`
			: "") +
		`</g>` +
		`<g class="ps-yt-stove-over">${stoveBody}</g>` +
		// The sun's beam through the crown, over everything it falls across, the stove and its pipe too.
		`<polygon class="ps-yt-beam" points="${pts(beam)}" fill="url(#ps-yt-beam-fill)"/>` +
		// What stays bright in the dark: the fire, the lamp's flame, the screen at night.
		fire +
		(lights.flame ? `<g class="ps-yt-glow-lamp">${lights.flame}</g>` : "") +
		(lights.screenFace ? `<g class="ps-yt-glow-screen">${lights.screenFace}</g>` : "");

	return `<div class="ps-indoor"><svg class="ps-yt" viewBox="-320 0 1920 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${defs}${body}</svg></div>`;
}
