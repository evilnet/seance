# ps NG — red team of the spec and plan 1 (2026-10-16)

Four independent read-only reviews: performance evidence, codebase fit, look and legibility, plan quality. Verdict from all four: **restructure plan 1 before building**. Findings merged and de-duplicated; C = confirmed in code or data, P = plausible.

## A. Design-level (change the spec)

1. **The canvas backdrop is the plan's biggest risk, and the spike says it may be unnecessary.** (C, three reviewers) `landSvg`/`yurtSvg` take every colour, opacity and the shrubs' unsquash from 38 `ps.css` class rules (`ps.css:1281–1441`), which an SVG drawn as an image never sees — the land and yurt would paint black, the yurt's night glow and snow cap would show at noon. `MOON`, `SUN`, `weatherClouds` and the five clouds are HTML/CSS, not SVG; the moon's phase is set on the live DOM; the sun's rays are a conic gradient; the Milky Way a rotated blur; the glow a `color-mix`. Porting all of it to canvas is a project. The spike measured a still page as free whatever it is built from, so **classic's own still markup (its animations stripped) is a candidate backdrop** that matches the look by construction. The open question is the glass over it (B).
2. **The glass needs its own fork.** Pre-blurred frost as planned is ~4× less blurred than classic's `blur(0.625rem)` (C, arithmetic), snaps its tint at the day/night flip while text colour eases (C), would paint the night glass cream if built from `--ps-g-tint` (C), frosts surfaces classic leaves clear on the phone (C) and loses to classic's drawer selectors on specificity (C). Two alternatives to measure: (a) a frost canvas inside `#theme-scene`, clipped to the panels, leaving `ps.css`'s tints and transitions alone; (b) classic's live `backdrop-filter` kept, with the moving layers masked out of the glass rectangles so nothing behind the glass changes.
3. **The calm tier's ≤ 15 is below the measured floor.** (C) One moving layer already costs 20–21.5 on the iPhone. Re-budget calm (≈ 22–24) or make it duty-cycled (move 10 s of every 60 s, paused between).
4. **The full tier's ≤ 30 is likely spent by the planned canvases.** (C, inference) A canvas adds ~14 over transforms at any resolution; three `shapes.ts` canvases plus night's fireflies and stars land near 35. Prefer wing poses as 2–3 prerendered frames swapped by `opacity`; measure a combined night slot before plan 2.
5. **Rule 2 ("no layer larger than the viewport") is not what was measured.** (C) The tile that kept WebContent at 0 was 1.25 viewports tall, the cloud strip 2 wide. State the rule in device pixels and test landscape phone and iPad.
6. **The once-a-minute repaint was never measured and the metric cannot see it.** (C) The playlist's 45 s slots never contain the harness's 60 s repaint; a 300 ms task once a minute is 0.5 points of average CPU but a visible stall. Budget the longest task per tick (e.g. ≤ 16 ms), and re-render only when the published values change (night is static for hours), not every minute.

## B. Measurement method (fix before any gate)

- Run-to-run noise exceeds every pass threshold: the same variant read 20–31; ≥ 5 interleaved rounds, a floor slot each round, median and IQR; a pass must beat the floor's own spread. (C)
- No baseline for "still ≤ 3": measure the app with a non-ps theme (`coffee`) in the same state; no chrome animation running (`getAnimations()` empty). (C)
- Readings can measure the wrong state: sleep vs still both read ~1; the 2-minute rest turns "full" into "still"; clock and weather unpinned. The page should beacon `{visibility, tier, running animations}` to the host; disable rest; `?at=` / `?weather=` setup pages. (C)
- Safari tab ≠ the real targets (home-screen PWA, Capacitor shells); MobileSafari's own 2–9 % is outside the sum; no energy or memory reading; the only phone is 60 Hz. (C/P)
- Android has no data; make it blocking before plan 2, on a real phone. Chrome's table ran at load up to 34 and does not support a ranking. (C)

## C. Plan 1 mechanics (fix while rewriting)

- Order: the riskiest unknown (does it look like classic?) is checked last. Add a visual spike first; move the Low Power probe, star sheets and Android gates to plan 2 where they are used. (C)
- The still scene omits the five clouds, the near grass, the rays, the big stars' glow — present in every classic frame, reduced motion included. (C)
- The query view reuses the glass frost (wrong radius, brightened) and leaves a sharp yurt on top; the veil is painted under the on-screen yurt, so the yurt stands unveiled on wet days — and grounds.ts measures it veiled. (C)
- `adoptedStyleSheets` cascade after `ps.css`; the `@media not (prefers-reduced-transparency)` wrapper fails closed in a browser that does not know the feature. Mirror `ps.css`'s reduced-transparency block instead. (P)
- At boot the classic chunk is fetched and run before `psRenderer` applies (settings apply in key order). `setRenderer` must also bump the ticket, clear `failed`, and resolve retries through `sceneKey`. (C)
- Vue replaces `#chat .header` and `#form`; inline per-element positions are lost. Publish positions as variables and re-find on every update, as classic's watchers do; listen to `visualViewport` (the iOS keyboard moves `#form` without resizing it). (C)
- Async paints race each other and `destroy()`; a scene mounted while `display: none` measures 0×0. Generation counter, skip empty boxes, tests for both. (C)
- `Box`/`BackdropKey` lack the root font size; a font step changes the blur radius. (C)
- `stars()` returns markup, `MOON`/`SUN` are HTML: needs `starPoints()`, `moonSvg(phase)`, `sunSvg()`. The yurt needs classic's geometry (`translateX(-50%)`, the `clamp` fallback); write `--ps-sky-*` before the first paint so a night start never flashes daylight. (C)
- Tests: the mocha stand-in lacks sheets, canvas, Image, URL, the meta; Task 5's noon test expects a glow that is 0 at noon, and the veil comes from `levelsAt`, not the palette. (C)
- Commands: no `vue-tsc` in the repo; the worktree has no `node_modules` or `public/`; `tmp/perf/ng/app/js` points at the main checkout's build, so a phone reading would measure the wrong build. (C)
- Exposure: hide the "NG (preview)" choice behind a flag until it moves. (P)
- Memory: full-viewport canvases at DPR 3 are ~12 MB each; budget them. (P)

## Checked and fine

The settings backup carries `psRenderer` without changes; `host.mounted` is read only by tests; Task 2's move does not change classic at runtime; every signature the plan names matches; the status-bar tint, `theme-color` and `data-ps-text` publishing match classic.
