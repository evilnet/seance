/**
 * The NG scene's own stylesheet, adopted by its mount: classic's
 * reduced-motion rules for the scene, re-scoped to #theme-scene.psng (plan 1,
 * Task 1's measured `none` rung), every animation off but the motion groups
 * plan 2 lifts, each of which runs classic's own animation while its
 * `psng-m-<group>` class is on the root, in phase by `--psng-t`; and the heat
 * haze's filter lifted off the ground, since NG builds no haze. Nothing here
 * touches the glass.
 */
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

/* Every animation off but the five lifted groups' own (ps NG plan 2, Task 3); the rules below still
 * each of those while its psng-m-<group> class is absent. The weather, the birds and the sun's rays
 * stay still here until their own tasks lift them; g.ps-sway stays still for good (the wrapper sways). */
#theme-scene.psng *:not(.ps-cloud, .ps-stars i.tw, .ps-fireflies i, .ps-smoke i, .psng-sway) {
	animation: none !important;
}

#theme-scene.psng .ps-skeins,
#theme-scene.psng .ps-daybirds,
#theme-scene.psng .ps-rain,
#theme-scene.psng .ps-snow,
#theme-scene.psng .ps-seeds,
#theme-scene.psng .ps-flash,
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

/* ---- the groups (ps NG plan 2, Task 3) ----
 * Each still while its class is absent; with it, classic's own animation runs, its delay moved by
 * --psng-t (seconds since local midnight of the mount day, written by scene.ts on each resume) so a
 * loop resumes where the clock puts it. Classic's durations, keyframes and ps-windy rules stand. */
#theme-scene.psng:not(.psng-m-clouds) .ps-cloud,
#theme-scene.psng:not(.psng-m-stars) .ps-stars i.tw,
#theme-scene.psng:not(.psng-m-fireflies) .ps-fireflies i,
#theme-scene.psng:not(.psng-m-smoke) .ps-smoke i,
#theme-scene.psng:not(.psng-m-grass) .psng-sway {
	animation: none !important;
}

#theme-scene.psng.psng-m-clouds .ps-cloud {
	animation-delay: calc(var(--cdl) - var(--psng-t));
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
`;
