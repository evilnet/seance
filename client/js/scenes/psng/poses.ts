/**
 * The birds in NG (ps NG plan 2, Task 5), DOM-free: classic's bird markup
 * (birds.ts, as markup.ts `sceneMarkup` inserts it) rewritten so nothing but
 * CSS transform and opacity moves it. A skein bird's or a lark's wingbeat,
 * a SMIL morph of the wing's `d`, becomes a pose stack: one copy of the bird
 * per pose of a beat, each drawn at its pose, shown by opacity for its share
 * of the beat (styles.ts `psng-pose4`/`psng-pose2`). The body lift and the
 * cranes' glide between bursts are not reproduced: every bird flaps on at its
 * beat. The buzzard's `animateMotion` circle becomes a rotating arm, and its
 * flap a CSS scale.
 */

export interface WingTiming {
	/** The SMIL's whole cycle (seconds): every beat of a burst, then a crane's glide. */
	dur: number;
	/** The SMIL's begin (seconds, ≤ 0): where the cycle stood at the document's start. */
	begin: number;
	/**
	 * One beat (seconds): dur × the keyTime at which the first pose comes round
	 * again — a skein bird's keyTimes[4] (BEAT's four poses), a lark's keyTimes[2].
	 */
	beat: number;
	/** The beat's poses, in order: a skein bird's up, level, down, flex; a lark's up, down. */
	poses: string[];
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** One bird's or lark's wing timing, read off its first `<animate attributeName="d">`; null without one. */
export function wingTiming(svgMarkup: string): WingTiming | null {
	const tag = /<animate attributeName="d"[^>]*>/.exec(svgMarkup)?.[0];
	const dur = tag && Number.parseFloat(attr(tag, "dur") ?? "");
	const begin = tag && Number.parseFloat(attr(tag, "begin") ?? "");
	const values = tag ? (attr(tag, "values") ?? "").split(";") : [];
	const keyTimes = tag ? (attr(tag, "keyTimes") ?? "").split(";").map(Number) : [];
	const again = values.indexOf(values[0], 1);

	if (!dur || !Number.isFinite(begin) || again < 1 || !(keyTimes[again] > 0)) {
		return null;
	}

	return {
		dur,
		begin: begin as number,
		beat: Number((dur * keyTimes[again]).toFixed(4)),
		poses: values.slice(0, again),
	};
}

/**
 * The bird's `<svg>` once per pose, every SMIL element out and each animated
 * wing drawn at that pose, each copy in a `psng-pose` box carrying its index
 * (`--pi`), its share of the beat (`--pf`), the beat (`--wdur`) and the SMIL's
 * begin (`--wbegin`). Markup with no wing timing comes back as it was.
 */
export function poseStack(svgMarkup: string, poses: readonly string[]): string {
	const t = wingTiming(svgMarkup);

	if (!t) {
		return svgMarkup;
	}

	const still = svgMarkup.replace(/<animate[^>]*\/>/g, "");
	return poses
		.map(
			(pose, i) =>
				`<div class="psng-pose psng-pose-${i}" style="--pi:${i};--pf:${i / poses.length};` +
				`--wdur:${t.beat}s;--wbegin:${t.begin}s">` +
				// The wings that were animated are the paths left with a closing tag (the rest close themselves).
				still.replace(/(<path[^>]* d=")[^"]*(")><\/path>/g, `$1${pose}$2/>`) +
				`</div>`
		)
		.join("");
}

const seconds = (re: RegExp, s: string) => (re.exec(s) ?? []).slice(1, 3).map(Number);

/**
 * The buzzard in boxes: the plane squashed as classic's `scale(1 .5)` and
 * moved to the circle's centre; in it an arm turning once per circle (its
 * `animateMotion`'s dur and begin); at the arm's end the bird, turned to face
 * along the circle (classic's `rotate="auto"`); in that its flap (the
 * `animateTransform`'s dur and begin). classic's `LOOP` is not quite a circle:
 * the circle through its bounding box, x −46..44 and y −44..46, centre
 * (−1, 1), radius 45, is the one drawn (styles.ts).
 */
function buzzard(div: string): string {
	const [od, ob] = seconds(/<animateMotion dur="([\d.]+)s" begin="(-?[\d.]+)s"/, div);
	const [fd, fb] = seconds(
		/<animateTransform[^>]*type="scale"[^>]*dur="([\d.]+)s" begin="(-?[\d.]+)s"/,
		div
	);
	const body = /<path d="([^"]*)"\/>/.exec(div)?.[1] ?? "";
	return (
		`<div class="ps-buzzard"><div class="psng-buzz-plane">` +
		`<div class="psng-buzz-orbit" style="--psng-od:${od}s;--psng-ob:${ob}s"><div class="psng-buzz-bird">` +
		`<div class="psng-buzz-flap" style="--psng-fd:${fd}s;--psng-fb:${fb}s">` +
		`<svg viewBox="-13 -20 26 40" aria-hidden="true"><path transform="scale(.64)" d="${body}"/></svg>` +
		`</div></div></div></div></div>`
	);
}

const LARK_STATES = ["fl", "ch", "cl"] as const;

/**
 * A lark's three wing sets (classic's `<g class="ps-lark-fl|ch|cl">`, stepped by
 * ps.css on SVG groups, which WebKit runs on the main thread) as three HTML
 * state boxes, `psng-lark-fl|ch|cl`, each an `<svg>` of that set alone with the
 * body between its far and near wing, as classic layers them; the flutter's
 * box is a pose stack. styles.ts switches the boxes by opacity.
 */
export function larkStates(svgMarkup: string): string {
	const only = (state: string) =>
		svgMarkup.replace(
			/<g class="ps-lark-(fl|ch|cl)">([\s\S]*?)<\/g>/g,
			(_, s: string, inner: string) => (s === state ? inner : "")
		);
	const fl = only("fl");
	return LARK_STATES.map(
		(state) =>
			`<div class="psng-lark-${state}">` +
			(state === "fl" ? poseStack(fl, wingTiming(fl)?.poses ?? []) : only(state)) +
			`</div>`
	).join("");
}

/** Classic's scene markup with every skein bird a pose stack, every lark in state boxes and the buzzard in boxes. */
export function ngBirds(markup: string): string {
	const stack = (svg: string) => poseStack(svg, wingTiming(svg)?.poses ?? []);
	return markup
		.replace(/<svg viewBox="0 0 32 20"[\s\S]*?<\/svg>/g, stack)
		.replace(/<svg viewBox="0 0 20 14"[\s\S]*?<\/svg>/g, larkStates)
		.replace(/<div class="ps-buzzard">[\s\S]*?<\/div>/, buzzard);
}
