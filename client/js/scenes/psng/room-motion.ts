/**
 * The yurt's motion (docs/projects/ps-yurt.md §8; plan 2): the moving HTML laid over the room's
 * pictures (ps/room.ts), placed in its design frame, and its animations hung on NG's group classes in
 * phase by --psng-t, with ps-ng.md's rules (transform and opacity only, nothing inside an svg). Each
 * moving part swaps with plan 1's still drawing (`ps-yt-still-<group>`), so still, calm, reduced
 * motion and a frozen rest are what NG already does. Adopted with the room's sheet (psng/scene.ts).
 * The rain, the snow and the storm's flash are the plains' own (`.ps-rain`, `.ps-snow`, `.ps-flash`),
 * run and hidden by NG's rules (styles.ts); a pane is their container. DOM-free.
 */
import {DESIGN_FRAME} from "../ps/yurt";

/** The design frame's middle and size, as the svg's viewBox (yurt.ts). */
const F = DESIGN_FRAME;
const MID_X = F.x + F.width / 2;
const MID_Y = F.y + F.height / 2;

export const ROOM_MOTION_CSS = `/* One design unit on screen: the svg's xMidYMid slice scale, about the frame's middle (${MID_X}, ${MID_Y}). */
#theme-scene .ps-indoor {
	--ps-ym-s: max(calc(100cqw / ${F.width}), calc(100cqh / ${F.height}));
}

/* Each moving box at its place in the design frame. Physical left and top, not logical properties:
 * the room's picture is never mirrored, and a box sits on its window under dir="rtl" too. */
#theme-scene .ps-ym-pane,
#theme-scene .ps-ym-top > * {
	position: absolute;
	left: calc(50% + (var(--x) - ${MID_X}) * var(--ps-ym-s));
	top: calc(50% + (var(--y) - ${MID_Y}) * var(--ps-ym-s));
	width: calc(var(--w) * var(--ps-ym-s));
	height: calc(var(--h) * var(--ps-ym-s));
}

/* A pane is the container classic's cqw/cqh keyframes measure, clipped to its glass. */
#theme-scene .ps-ym-pane {
	container-type: size;
	overflow: hidden;
}

#theme-scene .ps-ym-pane > * {
	position: absolute;
}

/* A cloud rests where its delay puts it in its loop (--cp), on ps-drift's own path, as the plains' do
 * (styles.ts): a cloud a frozen scene rebuilds stays on its path, not at the window's edge. */
#theme-scene .ps-ym-cloud {
	left: 0;
	aspect-ratio: 47 / 23;
	transform: translateX(calc((100cqw + 100% + 0.5rem) * var(--cp) - 100% - 0.25rem));
}

#theme-scene .ps-ym-cloud > svg {
	display: block;
	inline-size: 100%;
	block-size: 100%;
}

#theme-scene .ps-ym-stars {
	inset: 0;
	opacity: var(--ps-stars, 0);
}

#theme-scene .ps-ym-tw {
	position: absolute;
	inline-size: 0.125rem;
	block-size: 0.125rem;
	border-radius: 50%;
	background: #fff;
}

/* The fire's flames and the lamp's flame fill their boxes; the lamp burns at its level. */
#theme-scene .ps-ym-fire > div,
#theme-scene .ps-ym-lamp > div {
	position: absolute;
	inset: 0;
}

/* The stove's fire (ps-yurt.md §16): kept inside the door's opening (its clip, room.ts), as strong as the
 * burn, and grown from the coals with it — small at dusk, full by night. */
#theme-scene .ps-ym-fire {
	overflow: hidden;
	opacity: var(--ps-in-burn);
}

#theme-scene .ps-ym-flames {
	transform-origin: 50% 100%;
	transform: scale(calc(0.55 + 0.45 * var(--ps-in-burn)));
}

/* Its parts (the user, 2026-11-21: "soft firelight, flowing"): the firebox's glow and the embers' pulse
 * behind three layers of blurred flame, each six poses stacked in its box (flames.ts), and the white-hot
 * core; the mid and inner flames and the core add their light to the outer flame. */
#theme-scene .ps-ym-fback,
#theme-scene .ps-ym-fembers,
#theme-scene .ps-ym-hotcore,
#theme-scene .ps-ym-fl,
#theme-scene .ps-ym-fpose {
	position: absolute;
}

#theme-scene .ps-ym-fback {
	background: radial-gradient(70% 60% at 50% 95%, rgb(255 120 40 / 45%), rgb(140 40 20 / 18%) 60%, transparent 85%);
}

#theme-scene .ps-ym-fembers {
	background:
		radial-gradient(12% 40% at 18% 72%, #ff8a2e, transparent),
		radial-gradient(14% 45% at 50% 78%, #ffc04a, transparent),
		radial-gradient(12% 40% at 82% 70%, #ff7a26, transparent),
		radial-gradient(8% 28% at 34% 82%, #ffd27a, transparent),
		radial-gradient(8% 28% at 66% 84%, #ff9a3a, transparent);
}

#theme-scene .ps-ym-hotcore {
	border-radius: 50%;
	background: radial-gradient(closest-side, #fffbe6, rgb(255 236 170 / 70%) 45%, transparent);
	mix-blend-mode: screen;
}

#theme-scene .ps-ym-fpose {
	inset: 0;
	opacity: 0.001;
}

#theme-scene .ps-ym-fl-outer {
	--fb: 3.6s;
}

#theme-scene .ps-ym-fl-mid {
	--fb: 2.7s;
	mix-blend-mode: screen;
}

#theme-scene .ps-ym-fl-inner {
	--fb: 2.1s;
	mix-blend-mode: screen;
}

#theme-scene .ps-ym-fire svg,
#theme-scene .ps-ym-lamp svg {
	display: block;
	inline-size: 100%;
	block-size: 100%;
}

#theme-scene .ps-ym-lamp {
	opacity: var(--ps-in-lamp);
}

/* The pot's steam: puffs from its rim, on the smoke's keyframes (ps.css ps-smoke-rise). */
#theme-scene .ps-ym-steam i {
	position: absolute;
	left: 0;
	bottom: 0;
	inline-size: 0.75rem;
	block-size: 0.75rem;
	border-radius: 50%;
	background: radial-gradient(closest-side, rgb(255 255 255 / 55%), transparent);
	opacity: 0;
}

/* ---- the groups: each moves with its class, in phase ---- */
/* The hearth: the approved mockup's flicker — the stove's glow on its flick, the lamp's flame on its
 * flick-b (1 written 0.999, as a pose's: never exactly 1 or 0) — and the fire's flow (§16), the same at
 * full and in calm: each pose fades in over a sixth of its layer's beat, holds a sixth and fades out over
 * a sixth while its neighbours fade, so one is always at full and the flames morph without a break. */
#theme-scene.psng.psng-m-hearth .ps-ym-fireglow {
	animation: psng-yt-flick 2.4s ease-in-out infinite;
	animation-delay: calc(0s - var(--psng-t));
}

#theme-scene.psng.psng-m-hearth .ps-ym-flame {
	animation: psng-yt-flick-b 1.7s ease-in-out infinite;
	animation-delay: calc(0s - var(--psng-t));
}

#theme-scene.psng.psng-m-hearth .ps-ym-fpose {
	animation: psng-yt-flow var(--fb) ease-in-out infinite;
	animation-delay: calc(var(--fb) * var(--fk) / -6 - var(--psng-t));
}

#theme-scene.psng.psng-m-hearth .ps-ym-hotcore {
	animation: psng-yt-flick-b 1.6s ease-in-out infinite;
	animation-delay: calc(0s - var(--psng-t));
}

#theme-scene.psng.psng-m-hearth .ps-ym-fback {
	animation: psng-yt-flick 1.9s ease-in-out infinite;
	animation-delay: calc(0s - var(--psng-t));
}

#theme-scene.psng.psng-m-hearth .ps-ym-fembers {
	animation: psng-yt-embers 2.8s ease-in-out infinite alternate;
	animation-delay: calc(0s - var(--psng-t));
}

#theme-scene.psng.psng-m-steam .ps-ym-steam i {
	animation: ps-smoke-rise var(--sd) linear infinite;
	animation-delay: calc(var(--sdl) - var(--psng-t));
}

@keyframes psng-yt-flick {
	0%,
	100% {
		opacity: 0.999;
	}

	22% {
		opacity: 0.86;
	}

	47% {
		opacity: 0.97;
	}

	63% {
		opacity: 0.8;
	}

	81% {
		opacity: 0.94;
	}
}

@keyframes psng-yt-flick-b {
	0%,
	100% {
		opacity: 0.9;
	}

	30% {
		opacity: 0.999;
	}

	55% {
		opacity: 0.75;
	}

	80% {
		opacity: 0.95;
	}
}

#theme-scene.psng.psng-m-clouds .ps-ym-cloud {
	animation: ps-drift var(--cd) linear infinite;
	animation-delay: calc(var(--cdl) - var(--psng-t));
}

#theme-scene.psng.psng-m-stars .ps-ym-tw {
	animation: ps-twinkle var(--tw) ease-in-out infinite alternate;
	animation-delay: calc(var(--twl) - var(--psng-t));
}

/* A pose of the fire fades in, holds and fades out; the embers glow and dim (1 written 0.999, 0 as 0.001). */
@keyframes psng-yt-flow {
	0% {
		opacity: 0.001;
	}

	16.667%,
	33.333% {
		opacity: 0.999;
	}

	50%,
	100% {
		opacity: 0.001;
	}
}

@keyframes psng-yt-embers {
	from {
		opacity: 0.62;
	}

	to {
		opacity: 0.999;
	}
}

/* ---- the swaps: the still drawing while a group is off, the moving one while it is on ---- */
#theme-scene.psng.psng-m-clouds .ps-yt-still-clouds,
#theme-scene.psng.psng-m-weather .ps-yt-still-weather,
#theme-scene.psng.psng-m-hearth .ps-yt-still-hearth,
#theme-scene.psng.psng-m-steam .ps-yt-still-steam {
	display: none;
}

#theme-scene.psng:not(.psng-m-clouds) .ps-ym-cloud,
#theme-scene.psng:not(.psng-m-stars) .ps-ym-stars,
#theme-scene.psng:not(.psng-m-hearth) .ps-ym-fire,
#theme-scene.psng:not(.psng-m-hearth) .ps-ym-lamp,
#theme-scene.psng:not(.psng-m-steam) .ps-ym-steam {
	display: none;
}

/* Calm keeps the hearth and lets the window clouds rest (spec §11: measured over the plains' calm, the
 * window clouds leave calm before the stove's fire does; ps-yurt.md §11.2): the still clouds show. */
#theme-scene.psng.psng-calm .ps-ym-cloud {
	display: none;
}

#theme-scene.psng.psng-calm .ps-yt-still-clouds {
	display: inline;
}
`;
