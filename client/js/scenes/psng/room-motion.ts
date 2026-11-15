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

/* ---- the groups: each moves with its class, in phase ---- */
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
#theme-scene.psng.psng-m-weather .ps-yt-still-weather {
	display: none;
}

#theme-scene.psng:not(.psng-m-clouds) .ps-ym-cloud,
#theme-scene.psng:not(.psng-m-stars) .ps-ym-stars {
	display: none;
}
`;
