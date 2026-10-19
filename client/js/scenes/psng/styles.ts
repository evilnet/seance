/**
 * The NG scene's own stylesheet, adopted by its mount: classic's
 * reduced-motion rules for the scene, re-scoped to #theme-scene.psng (plan 1,
 * Task 1's measured `none` rung), every animation off but the motion groups
 * plan 2 lifts, each of which runs classic's own animation while its
 * `psng-m-<group>` class is on the root, in phase by `--psng-t`; and the heat
 * haze's filter lifted off the ground, since NG builds no haze. Nothing here
 * touches the glass.
 */
/**
 * A wingbeat's keyframes: `poses` copies take turns, each shown for its share of the beat with a hard
 * edge, repeated POSE_BEATS times in one iteration. The pose copies used to loop every beat, and WebKit
 * does main-thread style work at every iteration of every animation: 152 skein copies on a ~0.47 s beat
 * at their own phases put that in every frame (plan 4 §10.5). Shown is 0.999 and hidden 0.001, never
 * 1 or 0: an opacity of exactly either at a swap lays out and repaints the bird.
 */
export const POSE_BEATS = 80;

function poseKeyframes(name: string, poses: number): string {
	const at = (x: number) => `${Number(x.toFixed(4))}%`;
	const beat = 100 / POSE_BEATS;
	const frames: string[] = [];

	for (let k = 0; k < POSE_BEATS; k++) {
		const start = k * beat;
		const edge = start + beat / poses;
		const end = k === POSE_BEATS - 1 ? "100%" : at(start + beat - 0.0001);
		frames.push(`\t${at(start)},\n\t${at(edge - 0.0001)} {\n\t\topacity: 0.999;\n\t}`);
		frames.push(`\t${at(edge)},\n\t${end} {\n\t\topacity: 0.001;\n\t}`);
	}

	return `@keyframes ${name} {\n${frames.join("\n\n")}\n}`;
}

export const NG_STILL_CSS = `/* ==== STILL_RULES (ps NG plan 1, Task 1, rung \`none\`) — lift verbatim into NG's stylesheet ====
 *
 * classic's reduced-motion rules (ps.css "---- reduced motion ----"), only the ones that touch the scene,
 * re-scoped from html[data-reduce-motion] to #theme-scene.psng. Left out on purpose: the two :root rules
 * (--ps-flip and the animal stills) — chrome/tokens, not scene markup.
 *
 * The JS half (spike.js \`strip\`, run on mount and from a childList/subtree MutationObserver on
 * #theme-scene, because the first tick and every weather change rebuild .ps-weather/.ps-overcast):
 *   1. #theme-scene.classList.add("psng")
 *   2. remove every \`animate, animateMotion, animateTransform, set\` under #theme-scene
 *   3. classic's gates, without fades: \`.ps-off\` on GATES[g].selector for every gate liveLayers() says is
 *      off at the moment (layers.ts); the transition: none below makes them instant. In the harness classic's
 *      own scene.ts applies them; the beacon records the resulting .ps-off set per slot.
 */
#theme-scene.psng * {
	transition: none !important;
}

/* Every animation off but the lifted groups' own (ps NG plan 2, Tasks 3 and 4); the rules below still
 * each of those while its psng-m-<group> class is absent. The sun's rays are exempt too (Task 6); g.ps-sway stays still for good (the wrapper sways). */
#theme-scene.psng *:not(.ps-cloud, .ps-stars i.tw, .ps-fireflies i, .ps-smoke i, .psng-sway, .psng-rain-tile, .ps-snow i, .ps-seeds i, .ps-flash, .ps-heatband, .ps-rays, .ps-flock, .ps-skein-sway, .psng-pose, .ps-buzzard, .psng-buzz-orbit, .psng-buzz-flap, .ps-lark-track, .psng-lark-fl, .psng-lark-ch, .psng-lark-cl) {
	animation: none !important;
}

/* Frozen (scene.ts freeze): every animation off, each moving element held inline where it stood; the
 * group classes stay, so nothing leaves the page. The storm's flash goes, so it is never held lit. */
#theme-scene.psng.psng-frozen * {
	animation: none !important;
}

#theme-scene.psng.psng-frozen .ps-flash {
	display: none;
}

/* What exists only in flight is out of the page while it is still: the weather's (the flash too, so
 * it is never caught lit) without psng-m-weather. */
#theme-scene.psng:not(.psng-m-skeins) .ps-skeins,
#theme-scene.psng:not(.psng-m-daybirds) .ps-daybirds,
#theme-scene.psng:not(.psng-m-weather) .ps-rain,
#theme-scene.psng:not(.psng-m-weather) .ps-snow,
#theme-scene.psng:not(.psng-m-weather) .ps-seeds,
#theme-scene.psng:not(.psng-m-weather) .ps-flash,
#theme-scene.psng:not(.psng-m-smoke) .ps-smoke {
	display: none;
}

/* A cloud still, where its delay puts it in its loop (--cp, plains.ts), on ps-drift's own path. */
#theme-scene.psng .ps-cloud {
	transform: translateX(calc((100cqw + 100% + 0.5rem) * var(--cp) - 100% - 0.25rem));
}
/* ==== end STILL_RULES ==== */

#theme-scene.psng .ps-ground {
	filter: none;
}

/* The sun's fire canvas (ngSun) lies over the region the old filter covered, +-123.2 of the sun's +-100
 * units; the browser scales its 160 pixels up smoothly. */
#theme-scene.psng .ps-fire {
	position: absolute;
	left: -11.6%;
	top: -11.6%;
	width: 123.2%;
	height: 123.2%;
}

/* ---- the groups (ps NG plan 2, Task 3) ----
 * Each still while its class is absent; with it, classic's own animation runs, its delay moved by
 * --psng-t (seconds since local midnight of the mount day, written by scene.ts on each resume) so a
 * loop resumes where the clock puts it. Classic's durations, keyframes and ps-windy rules stand. */
#theme-scene.psng:not(.psng-m-clouds) .ps-cloud,
#theme-scene.psng:not(.psng-m-stars) .ps-stars i.tw,
#theme-scene.psng:not(.psng-m-fireflies) .ps-fireflies i,
#theme-scene.psng:not(.psng-m-smoke) .ps-smoke i,
#theme-scene.psng:not(.psng-m-grass) .psng-sway,
#theme-scene.psng:not(.psng-m-weather) .psng-rain-tile,
#theme-scene.psng:not(.psng-m-weather) .ps-snow i,
#theme-scene.psng:not(.psng-m-weather) .ps-seeds i,
#theme-scene.psng:not(.psng-m-weather) .ps-flash,
#theme-scene.psng:not(.psng-m-weather) .ps-heatband,
#theme-scene.psng:not(.psng-m-sun) .ps-rays,
#theme-scene.psng:not(.psng-m-skeins) .ps-flock,
#theme-scene.psng:not(.psng-m-skeins) .ps-skein-sway,
#theme-scene.psng:not(.psng-m-skeins) .ps-bird .psng-pose,
#theme-scene.psng:not(.psng-m-daybirds) .ps-buzzard,
#theme-scene.psng:not(.psng-m-daybirds) .psng-buzz-orbit,
#theme-scene.psng:not(.psng-m-daybirds) .psng-buzz-flap,
#theme-scene.psng:not(.psng-m-daybirds) .ps-lark-track,
#theme-scene.psng:not(.psng-m-daybirds) .ps-lark .psng-lark-fl,
#theme-scene.psng:not(.psng-m-daybirds) .ps-lark .psng-lark-ch,
#theme-scene.psng:not(.psng-m-daybirds) .ps-lark .psng-lark-cl,
#theme-scene.psng:not(.psng-m-daybirds) .ps-lark .psng-pose {
	animation: none !important;
}

/* Calm shows two of the sky's five clouds and none of the wet weather's: the compositor pays for every
 * moving cloud (ps NG plan 5, spec §11.4), and calm's budget is the clouds' alone. */
#theme-scene.psng.psng-calm .ps-cloud-field > .ps-cloud:nth-child(n + 4),
#theme-scene.psng.psng-calm .ps-cloud:not(.ps-cloud-field > .ps-cloud) {
	display: none;
}

#theme-scene.psng.psng-m-clouds .ps-cloud {
	animation-delay: calc(var(--cdl) - var(--psng-t));
}

#theme-scene.psng.psng-m-sun .ps-rays {
	animation-delay: calc(0s - var(--psng-t));
}

#theme-scene.psng.psng-m-stars .ps-stars i.tw {
	animation-delay: calc(0s - var(--psng-t));
}

#theme-scene.psng.psng-m-fireflies .ps-fireflies i {
	animation-delay: calc(var(--dl) - var(--psng-t)), calc(var(--bl) - var(--psng-t));
}

#theme-scene.psng.psng-m-smoke .ps-smoke i {
	animation-delay: calc(var(--sdl) - var(--psng-t));
}

/* The near grass sways as one box: scene.ts wraps svg.ps-blades in div.psng-sway, which takes the
 * blades' place and classic's ps-sway (its --ps-sway is the root's, inherited). */
#theme-scene.psng .psng-sway {
	left: 0;
	right: 0;
	bottom: 0;
	height: 19%;
	transform-origin: 50% 100%;
}

#theme-scene.psng .psng-sway > .ps-blades {
	position: absolute;
	inset: 0;
	height: 100%;
}

#theme-scene.psng.psng-m-grass .psng-sway {
	animation: ps-sway 7s ease-in-out infinite alternate;
	animation-delay: calc(0s - var(--psng-t));
}

#theme-scene.psng.psng-m-grass.ps-windy .psng-sway {
	animation-duration: 2.4s;
}

/* ---- the weather (ps NG plan 2, Task 4) ----
 * Snow, seeds, the storm's flash and the heat band are classic's own animations, in phase. The rain is
 * rain.ts's tiles: each the scene's size, falling exactly its own height (a translateY percentage is of
 * the element's own box) over its sheet's --rd, its twin one tile up; the drops in them are classic's
 * (ps.css .ps-rain i) with its animation off, top from rain.ts, and classic's slant (3.9cqw across a
 * 118cqh fall) drawn into each drop as a skew, since a tile moves only in Y. */
#theme-scene.psng .psng-rain-sheet {
	position: absolute;
	inset: 0;
}

#theme-scene.psng .psng-rain-tile {
	position: absolute;
	/* rain.ts keeps classic's left of 0-110 % (its rng order): the drops past 100 % are clipped. */
	overflow: hidden;
}

#theme-scene.psng .ps-rain i {
	transform: skewX(atan2(-3.9cqw, 118cqh));
}

#theme-scene.psng.psng-m-weather .psng-rain-tile {
	animation: psng-rain-fall var(--rd) linear infinite;
	animation-delay: calc(0s - var(--psng-t));
}

@keyframes psng-rain-fall {
	from {
		transform: translateY(0);
	}

	to {
		transform: translateY(100%);
	}
}

#theme-scene.psng.psng-m-weather .ps-snow i {
	animation-delay: calc(var(--fdl) - var(--psng-t));
}

#theme-scene.psng.psng-m-weather .ps-seeds i {
	animation-delay: calc(var(--sdl) - var(--psng-t));
}

#theme-scene.psng.psng-m-weather .ps-flash,
#theme-scene.psng.psng-m-weather .ps-heatband {
	animation-delay: calc(0s - var(--psng-t));
}

/* ---- the birds (ps NG plan 2, Task 5) ----
 * The flocks' flight, the skeins' sway, the buzzard's drift and the larks' song
 * flights and wing sets are classic's own animations, in phase (each delay rule names its own
 * element: --sdl is the smoke's and the seeds' too). The wingbeats are poses.ts's stacks: one copy
 * of the bird per pose, each shown by opacity for its share of the beat, a hard swap on linear
 * timing; its delay is the SMIL's begin, the copy's share and one beat back, so it is never
 * positive and the copies' order is the beat's. */
#theme-scene.psng.psng-m-skeins .ps-flock {
	animation-delay: calc(var(--fdl) - var(--psng-t));
}

#theme-scene.psng.psng-m-skeins .ps-skein-sway {
	animation-delay: calc(var(--sdl) - var(--psng-t));
}

/* The larks' state boxes (poses.ts larkStates) are placed as a pose is, so the chute and the closed
 * wings draw where classic's do, not under the flutter's box. */
#theme-scene.psng .psng-pose,
#theme-scene.psng .psng-lark-fl,
#theme-scene.psng .psng-lark-ch,
#theme-scene.psng .psng-lark-cl {
	position: absolute;
	inset: 0;
}

#theme-scene.psng .psng-pose:not(.psng-pose-0) {
	opacity: 0;
}

#theme-scene.psng.psng-m-skeins .ps-bird .psng-pose {
	animation: psng-pose4 calc(var(--wdur) * ${POSE_BEATS}) linear infinite;
	animation-delay: calc(var(--wbegin) - var(--psng-t) + (var(--pf) - 1) * var(--wdur));
}

#theme-scene.psng.psng-m-daybirds .ps-lark .psng-pose {
	animation: psng-pose2 calc(var(--wdur) * ${POSE_BEATS}) linear infinite;
	animation-delay: calc(var(--wbegin) - var(--psng-t) + (var(--pf) - 1) * var(--wdur));
}

${poseKeyframes("psng-pose4", 4)}

${poseKeyframes("psng-pose2", 2)}

/* -70s is classic's own delay on .ps-buzzard (ps.css, ps-buzz-drift); keep the two in step. */
#theme-scene.psng.psng-m-daybirds .ps-buzzard {
	animation-delay: calc(-70s - var(--psng-t));
}

#theme-scene.psng.psng-m-daybirds .ps-lark-track {
	animation-delay: calc(var(--ldl) - var(--psng-t));
}

/* A lark's wing set (classic's ps-lark-fl/-ch/-cl, stepped at each stop on SVG groups): each state box holds
 * the value classic holds from a stop to 0.01 % before the next, then ramps to the next value at the
 * next stop on a linear timing — 6.6 ms early on the 66 s flight, under one frame — so it stays off
 * the main thread, where a stepped timing would put it. */
#theme-scene.psng.psng-m-daybirds .ps-lark .psng-lark-fl {
	animation: psng-lark-fl-h var(--ld) linear infinite;
	animation-delay: calc(var(--ldl) - var(--psng-t));
}

#theme-scene.psng.psng-m-daybirds .ps-lark .psng-lark-ch {
	animation: psng-lark-ch-h var(--ld) linear infinite;
	animation-delay: calc(var(--ldl) - var(--psng-t));
}

#theme-scene.psng.psng-m-daybirds .ps-lark .psng-lark-cl {
	animation: psng-lark-cl-h var(--ld) linear infinite;
	animation-delay: calc(var(--ldl) - var(--psng-t));
}

@keyframes psng-lark-fl-h {
	0%,
	62.99% {
		opacity: 1;
	}

	63%,
	68.99% {
		opacity: 0;
	}

	69%,
	72.99% {
		opacity: 1;
	}

	73%,
	79.99% {
		opacity: 0;
	}

	80%,
	82.49% {
		opacity: 1;
	}

	82.5%,
	100% {
		opacity: 0;
	}
}

@keyframes psng-lark-ch-h {
	0%,
	62.99% {
		opacity: 0;
	}

	63%,
	68.99% {
		opacity: 1;
	}

	69%,
	72.99% {
		opacity: 0;
	}

	73%,
	79.99% {
		opacity: 1;
	}

	80%,
	82.49% {
		opacity: 0;
	}

	82.5%,
	100% {
		opacity: 0;
	}
}

@keyframes psng-lark-cl-h {
	0%,
	62.99% {
		opacity: 0;
	}

	63%,
	68.99% {
		opacity: 0;
	}

	69%,
	72.99% {
		opacity: 0;
	}

	73%,
	79.99% {
		opacity: 0;
	}

	80%,
	82.49% {
		opacity: 0;
	}

	82.5%,
	100% {
		opacity: 1;
	}
}

/* The buzzard (poses.ts): classic's viewBox puts its (0, 0) at the box's centre, one unit 0.0625rem.
 * The plane is classic's scale(1 .5), moved to the centre of the circle fitted through LOOP's bounding
 * box, (-1, 1); the arm turns once per circle, from where LOOP starts (44, 0), -1.3deg; at the arm's
 * end, the radius (45) out, the bird faces along the circle (rotate="auto": a quarter turn on the
 * arm); the flap is classic's scale keyframes, eased as its keySplines. Each box is 0 x 0 at the
 * point its transform turns about, but the flap, centred on it. */
#theme-scene.psng .psng-buzz-plane,
#theme-scene.psng .psng-buzz-orbit,
#theme-scene.psng .psng-buzz-bird {
	position: absolute;
	left: 0;
	top: 0;
	width: 0;
	height: 0;
}

#theme-scene.psng .psng-buzz-plane {
	left: 50%;
	top: 50%;
	transform: scaleY(0.5) translate(-0.0625rem, 0.0625rem);
}

#theme-scene.psng .psng-buzz-orbit {
	transform: rotate(-1.3deg);
}

#theme-scene.psng .psng-buzz-bird {
	transform: translateX(2.8125rem) rotate(90deg);
}

#theme-scene.psng .psng-buzz-flap {
	position: absolute;
	left: -0.8125rem;
	top: -1.25rem;
	width: 1.625rem;
	height: 2.5rem;
}

#theme-scene.psng.psng-m-daybirds .psng-buzz-orbit {
	animation: psng-buzz-orbit var(--psng-od) linear infinite;
	animation-delay: calc(var(--psng-ob) - var(--psng-t));
}

#theme-scene.psng.psng-m-daybirds .psng-buzz-flap {
	animation: psng-buzz-flap var(--psng-fd) cubic-bezier(0.42, 0, 0.58, 1) infinite;
	animation-delay: calc(var(--psng-fb) - var(--psng-t));
}

@keyframes psng-buzz-orbit {
	from {
		transform: rotate(-1.3deg);
	}

	to {
		transform: rotate(358.7deg);
	}
}

/* classic's flap values at its keyTimes (birds.ts buzzard(): seconds of 52). */
@keyframes psng-buzz-flap {
	0% {
		transform: scaleY(1);
	}

	0.6154% {
		transform: scaleY(0.62);
	}

	1.2308% {
		transform: scaleY(0.88);
	}

	1.8462% {
		transform: scaleY(0.62);
	}

	2.4615% {
		transform: scaleY(0.88);
	}

	3.0769% {
		transform: scaleY(0.66);
	}

	3.75%,
	100% {
		transform: scaleY(1);
	}
}
`;
