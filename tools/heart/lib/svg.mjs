// The <3 theme's animal file formats (tools/heart/README.md § The files).

export const SKY = "#dbeeff";

/** `w` of hexB mixed into hexA in sRGB, as #rrggbb — color-mix(in srgb, A, B w). */
export function mix(hexA, hexB, w) {
	const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
	const a = rgb(hexA);
	const b = rgb(hexB);
	return (
		"#" +
		a
			.map((c, i) =>
				Math.round(c * (1 - w) + b[i] * w)
					.toString(16)
					.padStart(2, "0")
			)
			.join("")
	);
}

/**
 * A closed outline (flat [x, y, …]) as path data: every stride-th point,
 * scaled by k and rounded to an integer first, written as one absolute
 * move and relative lines, so rounding never drifts along the outline and a
 * frame costs about four characters a point.
 */
export function encodePath(pts, k = 1, stride = 1) {
	const xs = [];
	const ys = [];
	for (let i = 0; i < pts.length; i += 2 * stride) {
		xs.push(Math.round(pts[i] * k));
		ys.push(Math.round(pts[i + 1] * k));
	}
	let d = `M${xs[0]},${ys[0]}`;
	for (let i = 1; i < xs.length; i++) d += `l${xs[i] - xs[i - 1]},${ys[i] - ys[i - 1]}`;
	return d + "z";
}

/** The absolute points of a path encodePath wrote. */
export function decodePath(d) {
	const out = [];
	let x = 0;
	let y = 0;
	d.slice(1, -1)
		.split("l")
		.forEach((pair, i) => {
			const [dx, dy] = pair.split(",").map(Number);
			if (i === 0) {
				x = dx;
				y = dy;
			} else {
				x += dx;
				y += dy;
			}
			out.push([x, y]);
		});
	return out;
}

/** Attribute numbers: up to `d` decimals (four by default), no trailing zeros. */
export const fmt = (n, d = 4) => {
	const p = 10 ** d;
	return String(Math.round(n * p) / p);
};

/**
 * The translate's own keyTime precision: six decimals, not the usual four.
 * A long loop period (a minute or more) makes four decimals of a *fraction*
 * of it a coarse ~few-millisecond grid in absolute time — fine for a gait's
 * own frame spacing, but not for a ramped segment's speed, whose stored
 * *position* has to land on whatever time the file actually keeps once
 * rounded, or the two disagree and a frame-to-frame velocity check reads a
 * spurious jump that was never in the underlying motion (`build.mjs`'s
 * `travelCurve` snaps a ramp's virtual samples to this exact grid before
 * computing their positions, for the same reason). Applied to every
 * translate keyTime and position, gait and ramp alike, so the whole curve
 * — not just the ramped part — reads back at the precision it was built to.
 */
export const TRAVEL_DECIMALS = 6;

/** Scenery paths: `{d, fill}` in the rig's own coordinates, so each carries
 * the same `k` the outlines are encoded with as a transform. */
const sceneryPaths = (decor, k) =>
	(decor ?? [])
		.map((p) => `<path fill="${p.fill}" transform="scale(${fmt(k)})" d="${p.d}"/>`)
		.join("");

const animate = (attrs) =>
	`<animate${Object.entries(attrs)
		.map(([k, v]) => ` ${k}="${v}"`)
		.join("")}/>`;

/**
 * An animal file: a wide stage; the animal's paths, far legs first and the
 * near outline last so it paints on top, each morphing through the
 * sequence's clips in one chain (the ids and the chain live on the near
 * path, the others sync to its begins); the travel as a translate over the
 * whole loop; and, when the sequence turns, a mirror flip about the
 * animal's centre at that moment (a scale about the centre: the two static
 * translates bracket it). Hearts, when given, ride inside the same groups.
 * The outer group fades the visit in from `travel.first` and out ending at
 * `travel.tExit` — the moment the box starts crossing the stage edge it
 * leaves by, not the end of the loop's time on stage — so the fade is
 * always done before any clipping would show; the animal then travels on,
 * invisibly, until the loop restarts. The six keyTimes (and the fade
 * duration itself, shrunk for a visit too short for two back-to-back fades)
 * come from `build.mjs`'s `fadeTimes()` as `travel.fadeKeyTimes`, so they
 * stay strictly increasing — this file only renders them. Starts at
 * `opacity="0"` so nothing shows before the animation's first sample.
 *
 * `decor`, when a rig has any, is scenery the animal moves *behind*: each
 * `{d, fill}` is painted last, as a sibling of the outer group rather than a
 * child of it, so it neither travels nor fades and stays put for the whole
 * loop. Its `d` is in the rig's own coordinates — the space the outline
 * paths are encoded in — so it carries the same `k` as a transform. It is
 * authored against the *stage*, which is why the still takes `stillDecor`
 * instead and never this.
 */
export function animalSvg({viewBox: vb, k, stageW, layers, clips, travel, flip, hearts, decor}) {
	const last = layers.length - 1;
	const centre = (vb.x + vb.w / 2) * k;
	const paths = layers.map((layer, i) => {
		const anims = clips.map((c) => {
			const attrs = {};
			if (i === last) attrs.id = c.id;
			attrs.attributeName = "d";
			attrs.calcMode = "linear";
			attrs.values = c.values.map((f) => f[i]).join(";");
			attrs.keyTimes = c.keyTimes.map((t) => fmt(t)).join(";");
			attrs.dur = `${fmt(c.dur)}s`;
			attrs.begin = i === last ? c.begin : `${c.id}.begin`;
			if (c.repeat > 1) attrs.repeatCount = c.repeat;
			attrs.fill = "freeze";
			return animate(attrs);
		});
		return `<path fill="${layer.fill}" d="${clips[0].values[0][i]}">${anims.join("")}</path>`;
	});
	const heart = hearts
		? `<path fill="${hearts.fill}" opacity="0" transform="translate(${fmt(hearts.x)} ${fmt(
				hearts.y
		  )})" d="${hearts.d}">` +
		  animate({
				attributeName: "opacity",
				calcMode: "linear",
				values: "0;1;1;0",
				keyTimes: "0;0.15;0.6;1",
				dur: "1.4s",
				begin: hearts.begin,
		  }) +
		  `<animateTransform attributeName="transform" type="translate" additive="sum" calcMode="linear" values="0 0;0 ${fmt(
				-hearts.rise
		  )}" dur="1.4s" begin="${hearts.begin}"/></path>`
		: "";
	const scale = flip
		? `<animateTransform attributeName="transform" type="scale" additive="sum" calcMode="discrete" values="1 1;-1 1" keyTimes="0;${fmt(
				flip.at
		  )}" dur="${fmt(travel.period)}s" repeatCount="indefinite"/>`
		: "";
	const translate = `<animateTransform attributeName="transform" type="translate" calcMode="linear" values="${travel.xs
		.map((x) => `${fmt(x, TRAVEL_DECIMALS)} 0`)
		.join(";")}" keyTimes="${travel.keyTimes
		.map((t) => fmt(t, TRAVEL_DECIMALS))
		.join(";")}" dur="${fmt(travel.period)}s" repeatCount="indefinite"/>`;
	const scenery = sceneryPaths(decor, k);
	const fade = animate({
		attributeName: "opacity",
		calcMode: "linear",
		values: "0;0;1;1;0;0",
		keyTimes: travel.fadeKeyTimes.map((t) => fmt(t)).join(";"),
		dur: `${fmt(travel.period)}s`,
		repeatCount: "indefinite",
	});
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${fmt(vb.y * k)} ${fmt(
			stageW * k
		)} ${fmt(vb.h * k)}">` +
		`<g opacity="0">${fade}${translate}<g transform="translate(${fmt(
			centre
		)} 0)">${scale}<g transform="translate(${fmt(-centre)} 0)">${paths.join(
			""
		)}${heart}</g></g></g>${scenery}</svg>\n`
	);
}

/**
 * One frame, no stage, no motion: the reduced-motion still, in the rig's own
 * box.
 *
 * `decor` here is a rig's `stillDecor`, not the animated file's `decor`, and
 * the two are deliberately different arrays. Stage scenery is authored
 * against a box `aspect × viewBox.h` wide and a still's viewBox is the rig's
 * own, so a pond built for the stage crops to a featureless band here. A rig
 * whose animal is not legible without its scenery — the dolphin, which with
 * no water is a fish in the sky — draws a second, box-sized copy for this.
 * Same `{d, fill}` shape, same rig coordinates, same `k`, painted over the
 * animal.
 */
export function stillSvg({viewBox: vb, k, layers, frame, decor}) {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(vb.x * k)} ${fmt(
		vb.y * k
	)} ${fmt(vb.w * k)} ${fmt(vb.h * k)}">${layers
		.map((l, i) => `<path fill="${l.fill}" d="${frame[i]}"/>`)
		.join("")}${sceneryPaths(decor, k)}</svg>\n`;
}
