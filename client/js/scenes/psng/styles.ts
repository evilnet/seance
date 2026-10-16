/**
 * The NG scene's own stylesheet (ps NG plan 1), adopted by its mount: classic's
 * reduced-motion rules for the scene, re-scoped to #theme-scene.psng (Task 1's
 * measured `none` rung, verbatim, its backticks escaped), and the heat haze's
 * filter lifted off the ground, since NG builds no haze. Nothing here touches
 * the glass.
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
	animation: none !important;
	transition: none !important;
}

#theme-scene.psng .ps-skeins,
#theme-scene.psng .ps-daybirds,
#theme-scene.psng .ps-rain,
#theme-scene.psng .ps-snow,
#theme-scene.psng .ps-seeds,
#theme-scene.psng .ps-flash,
#theme-scene.psng .ps-smoke {
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
`;
