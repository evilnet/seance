/**
 * The yurt's motion (docs/projects/ps-yurt.md §8; plan 2): the moving HTML laid over the room's
 * pictures (ps/room.ts), placed in its design frame, and its animations hung on NG's group classes in
 * phase by --psng-t, with ps-ng.md's rules (transform and opacity only, nothing inside an svg). Each
 * moving part swaps with plan 1's still drawing (`ps-yt-still-<group>`), so still, calm, reduced
 * motion and a frozen rest are what NG already does. Adopted with the room's sheet (psng/scene.ts).
 * The rain, the snow and the storm's flash are the plains' own (`.ps-rain`, `.ps-snow`, `.ps-flash`),
 * run and hidden by NG's rules (styles.ts); a pane is their container. DOM-free.
 */
export const ROOM_MOTION_CSS = `/* One design unit on screen: the svg's xMidYMid slice scale, about the frame's middle (640, 400). */
#theme-scene .ps-indoor {
	--ps-ym-s: max(calc(100cqw / 1920), calc(100cqh / 800));
}

/* Each moving box at its place in the design frame. Physical left and top, not logical properties:
 * the room's picture is never mirrored, and a box sits on its window under dir="rtl" too. */
#theme-scene .ps-ym-pane,
#theme-scene .ps-ym-top > * {
	position: absolute;
	left: calc(50% + (var(--x) - 640) * var(--ps-ym-s));
	top: calc(50% + (var(--y) - 400) * var(--ps-ym-s));
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

#theme-scene .ps-ym-cloud {
	left: 0;
	aspect-ratio: 47 / 23;
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

/* The fire's two layers and the lamp's flame fill their boxes; the lamp burns at its level. */
#theme-scene .ps-ym-fire > div,
#theme-scene .ps-ym-lamp > div {
	position: absolute;
	inset: 0;
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
/* The hearth: the approved mockup's flicker — the fire's body and the stove's glow on its flick, the
 * tongues and the lamp's flame on its flick-b (1 written 0.999, as a pose's: never exactly 1 or 0). */
#theme-scene.psng.psng-m-hearth .ps-ym-fire-body,
#theme-scene.psng.psng-m-hearth .ps-ym-fireglow {
	animation: psng-yt-flick 2.4s ease-in-out infinite;
	animation-delay: calc(0s - var(--psng-t));
}

#theme-scene.psng.psng-m-hearth .ps-ym-fire-tongues,
#theme-scene.psng.psng-m-hearth .ps-ym-flame {
	animation: psng-yt-flick-b 1.7s ease-in-out infinite;
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
