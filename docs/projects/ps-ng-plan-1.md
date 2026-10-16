# ps NG — Plan 1: the foundation and the still tier

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A selectable NG renderer for the `ps` theme that draws the still scene as one canvas, frosts the glass from a pre-blurred copy of it, publishes what classic publishes, and costs about what a still page does — with the pre-motion measurement gates run first.

**Architecture:** A `psRenderer` setting makes the scene host load `scenes/psng/scene` instead of `scenes/ps/scene` for the `ps` theme. NG reuses classic's DOM-free modules (engine, palette, grounds, glass, yurt) and the yurt/composer watchers moved out of classic's `scene.ts`. The still scene is planned by a pure function and painted into a canvas (land, yurt, moon and clouds as classic's own SVG markup drawn as images); the glass shows a downscaled copy of that canvas behind its tint. No animation exists in this plan; motion is plan 2, the Auto signals and classic's removal plan 3.

**Tech Stack:** TypeScript (strict), Canvas 2D, constructed stylesheets, Vue 3 (one settings control), mocha + chai + sinon, `tools/browser-drive.mjs` scenarios, the spike harness in `tmp/perf/ng/` (gitignored, local).

**Spec:** `docs/projects/ps-ng.md`

## Global Constraints

- Only `transform` and `opacity` are ever animated; no SMIL, no stepper, no per-frame writes to `currentTime` or CSS variables (spec §3 rules 1–4). This plan creates no animation at all.
- No moving layer larger than the viewport (spec §3 rule 2).
- Variables change on the minute tick only, on the scene's own root, except the values classic already publishes on `<html>`.
- NG publishes exactly what classic publishes: `data-ps-light`, `data-ps-text`, `--ps-halo`, `--canvas-bg-color`, the glass tints (`glassVars`), `theme-color` (handed back on destroy unless something else wrote it).
- `#status-bar-tint` never carries a filter.
- Reduced motion is read from `data-reduce-motion` / `systemAccessibility()`, never a new `@media` query.
- Size the chrome in `rem`; no Node built-ins in `client/`; explicit types in new code.
- `psRenderer` default is `"classic"`; nothing changes for a user who does not pick NG.
- Perf gates: measured on the iPhone tethered (`tmp/perf/ng/ios-one.sh` / `ios-wifi-run.sh`, Auto-Lock off, `devicectl` call before each `xctrace`), host load recorded; nothing is deployed or claimed before the numbers exist.
- Commits carry no AI-credit trailers. Prettier before every commit (`npx prettier --write <files>`).

## Review Focus

1. **Theme switched away from ps (or renderer back to classic) while NG is mounted** — every NG trace goes: the adopted stylesheet, `data-ps-renderer`, `--psng-frost`, per-panel inline `background-position`, blob URLs, the minute timer, observers. Test in Task 6.
2. **Reduced transparency** — `ps.css`'s solid glass must still win: NG's frost rules sit inside `@media not (prefers-reduced-transparency: reduce)`. Test in Task 6 (stylesheet text) and Task 7 (browser, emulated media).
3. **Resize or rotation storms** — re-blur at most once per 250 ms burst (`REBLUR_DEBOUNCE_MS`), repositions every frame of a burst are free. Test in Task 5.
4. **Mounted into a hidden page** — nothing is painted until the page is visible; the first visible update paints and publishes at once. Test in Task 6.
5. **NG chunk fails to load** — the daylight fallback stays, as for classic; the host warns once. Test in Task 3.

---

### Task 1: The pre-motion gates (spec §8.1)

Measurements only; results recorded in the spec. No production code.

**Files:**
- Modify: `tmp/perf/ng/index.html` (gitignored harness) — add variants `v=reblur`, `v=ff&n=<count>`, `v=stars&sheets=<count>`, `v=probe`
- Modify: `docs/projects/ps-ng.md` §8 — a results table under "Before motion code"

**Interfaces:**
- Consumes: the harness's `place()`, `cloudSprite()`, `paintBackdrop()`, `paintGlass()`, the playlist mode, `ios-wifi-run.sh`, `reparse.sh`, `ios-one.sh`.
- Produces: four verdicts the later plans read: re-blur cost per event, whether fireflies keep one layer each (else 4 shared sheets), whether star sheets read as pulsing, whether the frame probe sees Low Power Mode.

- [ ] **Step 1: Add the variants to the harness**
  - `v=reblur&every=<s>`: the `bitmap` variant plus `drawBackdrop()` (repaint + `paintGlass()` with `glass=pre`) every `every` seconds; log `performance.now()` deltas of each repaint into `window.__ng.reblurMs`.
  - `v=ff&n=<count>`: backdrop plus `count` 6 × 6 CSS px glowing dots, each its own element with two CSS animations: a `transform` drift (6–12 s, alternate) and an `opacity` blink (2–5 s), periods seeded.
  - `v=stars&sheets=<count>`: night backdrop without stars plus 52 star dots split into `count` full-viewport canvases, each with one `opacity` animation (`0.55 ↔ 1`, periods 3.1, 4.3, 5.7, 7.9 s).
  - `v=probe`: no scene; draws the median and p90 of the last 120 `requestAnimationFrame` intervals in 4rem text, updated every second.

- [ ] **Step 2: Run the iPhone round** (tethered, Auto-Lock Never, Safari)

Run: `./ios-wifi-run.sh 2 "v=bitmap&glass=pre" "v=reblur&every=60&glass=pre" "v=reblur&every=5&glass=pre" "v=xform&n=12&tile=1" "v=ff&n=34" "v=stars&sheets=4" "v=floor"` then `./reparse.sh iw-`
Expected: one JSON line per slot, `wc`/`gpu`/`bb` non-zero for the motion slots (a slot with all zeros means the screen slept — rerun it).

- [ ] **Step 3: Read the re-blur's own time**

Run the `reblur&every=5` page with Safari's Web Inspector (or Chrome DevTools on desktop at DPR 3 emulation) and read `__ng.reblurMs`.
Expected: a number per repaint; record the median.

- [ ] **Step 4: The Low Power Mode probe**

The user opens `?v=probe` on the iPhone, reads the median, turns Low Power Mode on in Control Centre, reads it again.
Expected: two medians (≈16.7 ms and, if the cap holds on iOS 27, ≈33.3 ms).

- [ ] **Step 5: Show the star sheets to the user**

Screen-record or show `?v=stars&sheets=4&night=1` on the phone; the user says whether it reads as twinkling or pulsing.

- [ ] **Step 6: Android baseline, when the host is quiet**

Gate: `sysctl -n vm.loadavg` < 2.5, emulator cold-booted (`-no-snapshot-load`), swap < 50 MB, MemAvailable > 600 MB.
Run: `./droid-run.sh 2 "v=floor" "v=bitmap&glass=pre" "v=xform&n=3&tile=1" "v=c2d&res=0.5&fps=30" "v=ff&n=34"`
Expected: JSON lines with non-zero `sum`; if the gate cannot be met today, write "not run" in the table and continue — plan 2 Task 1 re-checks it.

- [ ] **Step 7: Record the verdicts in spec §8 and commit**

Table columns: gate, measurement, verdict. Verdict rules: re-blur passes if `reblur&every=60` is within 1 point of `bitmap&glass=pre`; fireflies keep one layer each if `ff&n=34` is within 5 points of `xform&n=12&tile=1`, else spec §4's fallback (4 sheets) applies; star sheets per the user's word; the probe is usable if the Low Power median is ≥ 30 ms.

```bash
git add docs/projects/ps-ng.md
git commit -m "docs: ps NG — the pre-motion gates, measured"
```

---

### Task 2: Move the shared watchers out of classic's scene.ts

**Files:**
- Create: `client/js/scenes/ps/watchers.ts`
- Modify: `client/js/scenes/ps/scene.ts` (remove `placeYurt`, `watchComposer`, `themeColorFor`; import them)
- Modify: `client/js/scenes/ps/grounds.ts` (gains `themeColorFor`)
- Test: `test/scenes/ps/mount.ts`, `test/scenes/ps/grounds.ts` (existing suites must pass unchanged in behaviour)

**Interfaces:**
- Produces:
  - `placeYurt(root: HTMLElement): {seen(): void; refind(): void; destroy(): void}` in `watchers.ts` (body moved verbatim, its doc comment with it)
  - `watchComposer(root: HTMLElement, html: HTMLElement): {refind(): void; destroy(): void}` in `watchers.ts`
  - `themeColorFor(published: Published): string` in `grounds.ts`

- [ ] **Step 1: Move the three functions** (no edits to their bodies), update imports in `scene.ts` and in `test/scenes/ps/*.ts` that import `themeColorFor`.
- [ ] **Step 2: Run the ps suites**

Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml 'test/scenes/ps/*.ts' test/tests/themeScene.ts`
Expected: PASS, same count as before the move.

- [ ] **Step 3: Commit**

```bash
git add client/js/scenes/ps test/scenes/ps
git commit -m "ps: the yurt and composer watchers in their own module, theme-color in grounds"
```

---

### Task 3: The renderer switch

**Files:**
- Modify: `client/js/themeScene.ts`
- Modify: `client/js/settings.ts` (new `psRenderer` entry beside `psAnimation`)
- Modify: `client/components/Settings/Appearance.vue` (a two-option radio group under the ps settings: "Scene renderer: Classic / NG (preview)")
- Create: `client/js/scenes/psng/scene.ts` (stub: `mount` returning a handle whose `update`/`destroy` do nothing; Task 6 fills it)
- Test: `test/tests/themeScene.ts`

**Interfaces:**
- Produces:
  - `export type PsRenderer = "classic" | "ng"` and `normalizePsRenderer(value: unknown): PsRenderer` (unknown → `"classic"`) in `themeScene.ts`
  - `SCENES["ps-ng"]: () => import(/* webpackChunkName: "scene-ps-ng" */ "./scenes/psng/scene")`
  - `sceneKey(theme: string, renderer: PsRenderer): string` — `"ps-ng"` for `ps` + `ng`, else `theme`
  - `SceneHost.setRenderer(renderer: PsRenderer): void` — when the asked theme is `ps` and the key changes, unmount and mount the other module; otherwise only remembered
  - settings `psRenderer: {default: "classic", apply: (store, value) => themeScene.setRenderer(normalizePsRenderer(value))}`

- [ ] **Step 1: Write the failing tests** in `test/tests/themeScene.ts`, using the file's existing fake loaders:
  - `sceneKey("ps", "ng") === "ps-ng"`, `sceneKey("ps", "classic") === "ps"`, `sceneKey("coffee", "ng") === "coffee"`
  - `"setRenderer('ng') with ps mounted remounts with the ps-ng loader"`: loaders `{ps, "ps-ng"}` as sinon fakes; `setTheme("ps")`, then `setRenderer("ng")` → the `ps` handle's `destroy` called once, the `ps-ng` loader called once, `host.mounted === "ps-ng"`
  - `"setRenderer with another theme only remembers it"`: `setTheme("coffee")`, `setRenderer("ng")`, no loader called; then `setTheme("ps")` → the `ps-ng` loader called
  - `"a failing ps-ng chunk leaves the root empty and warns once"`: the `ps-ng` loader rejects; `warn` called once; `mounted` is `null`
- [ ] **Step 2: Run to see them fail**

Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/tests/themeScene.ts`
Expected: FAIL (`sceneKey` / `setRenderer` not defined).
- [ ] **Step 3: Implement** `PsRenderer`, `normalizePsRenderer`, `sceneKey`, the `ps-ng` loader, `setRenderer`; `setTheme` resolves its loader through `sceneKey(name, renderer)`. Add the setting and the Appearance radio group (bound like `psAnimation`'s and shown under the same `v-if`; radios, so no `v-switch`). Create the stub module.
- [ ] **Step 4: Run to see them pass**, then `npx vue-tsc --noEmit -p tsconfig.json` (or the repo's lint type-check) — Expected: PASS, no type errors.
- [ ] **Step 5: Commit**

```bash
git add client/js/themeScene.ts client/js/settings.ts client/components/Settings/Appearance.vue client/js/scenes/psng/scene.ts test/tests/themeScene.ts
git commit -m "ps: a renderer setting that loads the NG scene in place of classic's"
```

---

### Task 4: Tiers (pure)

**Files:**
- Create: `client/js/scenes/psng/tiers.ts`
- Test: `test/scenes/psng/tiers.ts`

**Interfaces:**
- Produces:
  - `export type Tier = "full" | "calm" | "still"`
  - `export type SceneAnimation = "auto" | "full" | "calm" | "still"`
  - `migrateAnimation(stored: unknown): SceneAnimation` — `"60"`, `"24"` → `"auto"`; `"1s"`, `"sparse"` → `"calm"`; `"off"` → `"still"`; a `SceneAnimation` value → itself; anything else → `"auto"`
  - `export interface PowerSignals {lowPower?: boolean; thermal?: "nominal" | "fair" | "serious" | "critical"; batteryLow?: boolean; saveData?: boolean; frameCapped?: boolean}`
  - `export interface TierInput {visible: boolean; attended: boolean; view: SceneView; reduceMotion: boolean; setting: SceneAnimation; power: PowerSignals}`
  - `tierFor(input: TierInput): Tier` — `"still"` if `!visible || !attended || view === "query" || reduceMotion || setting === "still"`; else `"calm"` if `setting === "calm"` or (`setting === "auto"` and any of `lowPower`, `thermal` ∈ {`serious`, `critical`}, `batteryLow`, `saveData`, `frameCapped`); else `"full"`

- [ ] **Step 1: Write the failing tests** — a table-driven `tierFor` test covering each forced-still condition alone, each power signal alone under `auto`, `thermal: "fair"` → `"full"`, every power signal ignored under `setting: "full"`, and `migrateAnimation` for all six stored values plus `undefined` and `"bogus"`.
- [ ] **Step 2: Run to see them fail** — `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/scenes/psng/tiers.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `tiers.ts` (imports `SceneView` type only from `themeScene.ts`).
- [ ] **Step 4: Run to see them pass** — Expected: PASS.
- [ ] **Step 5: Commit** — `git add client/js/scenes/psng/tiers.ts test/scenes/psng/tiers.ts && git commit -m "ps NG: tiers — full, calm, still from the gates, the setting and power signals"`

---

### Task 5: The backdrop plan and the re-blur rule (pure)

**Files:**
- Create: `client/js/scenes/psng/backdrop.ts` (pure part)
- Test: `test/scenes/psng/backdrop.ts`

**Interfaces:**
- Consumes: `Moment` (`engine.ts`), `Palette` (`palette.ts`), `sceneVars` (classic `scene.ts` — move it to `scenes/ps/vars.ts` in this task if importing `scene.ts` would pull classic's markup into NG's chunk), `landSvg`, `yurtSvg`, `weatherClouds` (`plains.ts`), `moonShape`.
- Produces:
  - `export interface Box {width: number; height: number; dpr: number}` (CSS px, device pixel ratio)
  - `export type BackdropLayer = {kind: "sky"; stops: Array<[number, string]>} | {kind: "milky"; opacity: number} | {kind: "stars"; opacity: number; points: Array<{x: number; y: number; r: number}>} | {kind: "glow"; x: number; y: number; radius: number; colour: string; opacity: number} | {kind: "image"; name: "moon" | "sun" | "overcast" | "land" | "yurt"; url: string; x: number; y: number; width: number; height: number; opacity: number} | {kind: "veil"; colour: string; opacity: number}`
  - `backdropLayers(m: Moment, p: Palette, box: Box, yurtLeft: number | null, phone: boolean): BackdropLayer[]` — back to front: sky, milky, stars, glow, moon, sun disc, overcast, land, yurt, veil; layers at opacity 0 omitted. Geometry and colours are classic's: each layer's place and size port the matching rule of `client/themes/ps.css` (`#theme-scene .ps-milky`, `.ps-stars`, `.ps-glow`, `.ps-moon`, `.ps-sun`, `.ps-overcast`, `.ps-ground .ps-land`, `.ps-yurt`, `.ps-veil`) resolved at `box`, with `sceneVars(m, p)` for every custom property those rules read. Star points come from classic's seeded `stars()` generator (same count, same places).
  - `svgDataUrl(markup: string, vars: Record<string, string>): string` — `data:image/svg+xml;charset=utf-8,` + `encodeURIComponent` of the markup with `style="<vars as name:value;>"` added to its root `<svg>` and `xmlns` ensured
  - `export interface BackdropKey {minute: number; weather: Weather; light: "day" | "night"; yurtLeft: number | null; width: number; height: number; dpr: number}`
  - `reblurNeeded(prev: BackdropKey | null, next: BackdropKey): boolean` — true on the first key and when any field differs, except `yurtLeft` changes smaller than 1 CSS px
  - `export const REBLUR_DEBOUNCE_MS = 250`

- [ ] **Step 1: Write the failing tests**
  - `"layers run back to front"`: at a clear noon (`momentAt(new Date(2026, 5, 21, 12, 0), "clear")`), kinds in order `sky, glow, sun, land, yurt` (no stars, milky or moon by day), and a `veil` only when `p` sets one
  - `"night has the stars at classic's places"`: at 23:00 the `stars` layer has the same point count as classic's `stars()` markup's `<i>` count, first point equal to classic's first star's position resolved at `box`
  - `"geometry follows the box"`: the land image's `width` equals `box.width` at 390 and at 1512
  - `"the yurt stands where yurtLeft says"`: `yurtLeft: 300` → yurt layer `x === 300`; `null` → classic's 70 % of the scene
  - `"svgDataUrl carries the vars"`: decoded URL contains `style="--ps-grass:#123456;"` on the root `<svg` and `xmlns="http://www.w3.org/2000/svg"`
  - `"reblurNeeded"`: `null` → true; identical keys → false; minute +1 → true; weather, light, width, height, dpr each → true; `yurtLeft` 300 → 300.4 → false, 300 → 302 → true
- [ ] **Step 2: Run to see them fail** — `… mocha … test/scenes/psng/backdrop.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the pure part of `backdrop.ts`.
- [ ] **Step 4: Run to see them pass** (and `test/scenes/ps/*.ts` still pass if `sceneVars` moved) — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "ps NG: the still backdrop as an ordered layer plan, and when to re-blur"`

---

### Task 6: The NG scene — paint, frost, publish (still tier)

**Files:**
- Modify: `client/js/scenes/psng/backdrop.ts` (DOM part: painting and the frost copy)
- Modify: `client/js/scenes/psng/scene.ts` (replace the stub)
- Create: `client/js/scenes/psng/styles.ts` (the stylesheet text)
- Test: `test/scenes/psng/mount.ts` (stand-in page in the style of `test/scenes/ps/mount.ts`)

**Interfaces:**
- Consumes: Task 2's `placeYurt`, `watchComposer`, `themeColorFor`; Task 4's `tierFor`; Task 5's `backdropLayers`, `svgDataUrl`, `reblurNeeded`, `REBLUR_DEBOUNCE_MS`; `momentAt`, `paletteAt`, `publishedFor`, `glassVars`.
- Produces:
  - `paintBackdrop(ctx: CanvasRenderingContext2D, layers: BackdropLayer[], box: Box): Promise<void>` — loads each `image` layer's URL with `new Image()` (`decode()`), draws in order
  - `frostCopy(source: HTMLCanvasElement, radiusCssPx: number, dpr: number): HTMLCanvasElement` — downscale by `1 / Math.max(1, Math.round(radiusCssPx * dpr / 2))` with `imageSmoothingQuality = "high"`, then scale back up to the source size
  - `export const NG_CSS: string` in `styles.ts`; `export const FROST_SELECTORS = ["#sidebar", "#chat .header", "#chat .userlist", "#form"]`
  - `export interface SceneDeps {paint: typeof paintBackdrop; frost: typeof frostCopy; toUrl(canvas: HTMLCanvasElement): Promise<string>}` and `mount(root: HTMLElement, initial: SceneHostState, deps?: Partial<SceneDeps>): SceneHandle`

**What `NG_CSS` holds** (one constructed `CSSStyleSheet`, adopted on mount, removed on destroy):
- `#theme-scene .psng-backdrop` fills the scene (`position: absolute; inset: 0; width: 100%; height: 100%`).
- Inside `@media not (prefers-reduced-transparency: reduce)`, under `:root[data-ps-renderer="ng"]`: each of `FROST_SELECTORS` gets `backdrop-filter: none` (and the prefixed one) and `background-image: linear-gradient(<the tint ps.css paints>, <same>), var(--psng-frost)` with `background-repeat: no-repeat` and `background-size: auto, var(--psng-frost-size)`; the day lift is `filter`-free — the frost copy is drawn already brightened by day (`ctx.filter = "brightness(1.3) saturate(1.12)"`; where `"filter" in ctx` is false, the downscaled copy's pixels are brightened and saturated through `getImageData` — it is about 1/400 of the screen, so this is cheap); `#chat .msg-reaction:not(.self, .msg-reaction-add)` gets `backdrop-filter: none` and `--ps-g-tint: var(--ps-g-tint-a)` (the phone's tint-only chips, already held by the legibility tests).
- `#theme-scene.psng-private .psng-backdrop { opacity: 0 }` and `#theme-scene.psng-private .psng-frost-view { opacity: 1 }` — the query view shows the frost copy (a second canvas `.psng-frost-view`, opacity 0 otherwise).

**What `mount` does:**
- Sets `html.dataset.psRenderer = "ng"`, adopts the sheet, builds `<canvas class="psng-backdrop">` and `<canvas class="psng-frost-view">` in `root`, starts `placeYurt(root)` and `watchComposer(root, html)`.
- On the first visible update, and on each minute boundary while visible (classic's scheduling: `60000 - (s*1000 + ms) + 20`), computes `momentAt`/`paletteAt`, publishes as classic does (`data-ps-light`, `data-ps-text`, `--ps-halo`, `--canvas-bg-color`, `glassVars`, `theme-color`), and if `reblurNeeded` repaints the backdrop, makes the frost copy, writes it to `--psng-frost` on `<html>` (a blob URL; the previous one revoked) and to the frost-view canvas.
- Positions the frost under each panel: for each element matching `FROST_SELECTORS`, inline `background-position: <-left>px <-top>px` for the second background (`0 0, -Lpx -Tpx`) and `--psng-frost-size: <scene width>px <scene height>px` on `<html>`; re-run by a `ResizeObserver` on those elements and on `root`, and on the sidebar's `transitionend`. A resize burst re-blurs once, `REBLUR_DEBOUNCE_MS` after its last event.
- `update(state)`: hidden → clear the minute timer; visible again → tick at once; `view === "query"` toggles `psng-private` on `root`.
- `destroy()`: clears the timer and observers, revokes blob URLs, removes the sheet, `data-ps-renderer`, `--psng-frost`, `--psng-frost-size`, the inline positions, the published values classic also removes, hands `theme-color` back as classic does, empties `root`.

- [ ] **Step 1: Write the failing tests** in `test/scenes/psng/mount.ts` (stand-in globals installed and removed inside each test, sinon clock; `deps` fakes: `paint` resolves at once, `frost` returns a stand-in canvas, `toUrl` resolves `"blob:1"`, `"blob:2"`, …):
  - `"publishes what classic publishes"`: mount visible at 2026-06-21 12:00; `html.dataset.psLight`, `psText`, `--ps-halo`, `--canvas-bg-color`, every `glassVars` property and the meta's `content` equal what `publishedFor`/`glassVars`/`themeColorFor` give for that moment
  - `"paints once per minute that changes the key, not on a resize-only reposition"`: `paint` called once at mount; clock +60 s → twice; a reposition (fire the panels' ResizeObserver with unchanged scene size) → still twice
  - `"a resize burst re-blurs once"`: five root resizes 50 ms apart, then +250 ms → `paint` +1 exactly
  - `"mounted hidden paints nothing until visible"`: `visible: false` → `paint` not called after 120 s; `update({visible: true…})` → called once, meta written
  - `"a query shows the frost view"`: `update({view: "query"…})` → `root.classList.contains("psng-private")`
  - `"destroy leaves nothing"`: after destroy, `data-ps-renderer` absent, sheet removed from `document.adoptedStyleSheets`, `--psng-frost` absent, every blob URL revoked (`URL.revokeObjectURL` spy called for each `toUrl` result), no pending timers (`clock.countTimers() === 0`), meta content back to the theme's, `root.children.length === 0`
  - `"reduced transparency is never outranked"`: `NG_CSS` places every `--psng-frost` rule inside `@media not (prefers-reduced-transparency: reduce)` (string check on the sheet text) and contains no `backdrop-filter` other than `none`
- [ ] **Step 2: Run to see them fail** — `… mocha … test/scenes/psng/mount.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `paintBackdrop`, `frostCopy`, `styles.ts`, `scene.ts`.
- [ ] **Step 4: Run to see them pass**, plus the whole scene set: `… mocha … 'test/scenes/**/*.ts' test/tests/themeScene.ts` — Expected: PASS.
- [ ] **Step 5: Build and smoke** — `NODE_ENV=production corepack yarn build`; serve `public/` on 8000; in Chrome set `settings` = `{"theme":"ps","psRenderer":"ng"}`; Expected: the sky, land and yurt drawn, the sidebar frosted, no console errors.
- [ ] **Step 6: Commit** — `git commit -m "ps NG: the still scene painted once a minute, glass frosted from its blurred copy"`

---

### Task 7: Browser check, the still tier on the iPhone, docs

**Files:**
- Create: `tools/scenarios/ps-ng.mjs` (pattern: `tools/scenarios/theme-ps.mjs`, its `CLOCK_SHIM` and `__setClock`)
- Modify: `docs/projects/ps-ng.md` (status line; a "Plan 1 landed" note with the measured still-tier number)
- Modify: `CLAUDE.md` (one bullet: the NG renderer, where it lives, its browser check)

**Interfaces:**
- Consumes: everything above; `tmp/perf/ng/ios-one.sh`, `tmp/perf/ng/app/` + a `ps-setup.html` variant writing `{"theme":"ps","psRenderer":"ng"}`.

- [ ] **Step 1: Write the scenario's checks**
  - renderer switch: with `psRenderer: "ng"` the root holds `.psng-backdrop`; switching to classic leaves no `.psng-*`, no `data-ps-renderer`, no adopted sheet
  - census: `document.querySelector("#theme-scene").getAnimations({subtree: true}).length === 0`; no `<animate*>`/`<set>` in `#theme-scene`
  - glass: at a pinned clear noon, the sidebar's computed `backdrop-filter` is `none` and a pixel sampled at its centre differs from the frost copy's pixel at the same point by no more than the tint composite predicts (± 8 per channel)
  - reduced transparency: `page.emulateMedia({reducedTransparency: "reduce"})` (or CDP `Emulation.setEmulatedMedia` with `prefers-reduced-transparency`) → the sidebar's background is `ps.css`'s solid colour, no frost image
  - screenshots: classic and NG at 2026-06-21 12:00, 20:45, 21:40, 23:30 clear, and 2026-10-19 12:00 (rain), 2026-01-15 12:00 (snow), saved side by side under `tmp/ps-ng-shots/`
- [ ] **Step 2: Run it** — `node tools/browser-drive.mjs --scenario tools/scenarios/ps-ng.mjs` against a fresh build — Expected: every check `ok`, screenshots written.
- [ ] **Step 3: The iPhone reading** (tethered): `./ios-one.sh ng-still http://192.168.1.38:8112/ps-setup-ng.html 3` and `./ios-one.sh classic http://192.168.1.38:8112/ps-setup.html 3` alternately at the same hour.
Expected: NG still ≤ 3 (spec §6 budget for still); record both in spec §8.
- [ ] **Step 4: Show the screenshots to the user**; note their verdict on the look in the spec.
- [ ] **Step 5: Docs and commit** — status line in the spec ("Plan 1 landed <date>"), the CLAUDE.md bullet, then `corepack yarn lint` — Expected: clean.

```bash
git add tools/scenarios/ps-ng.mjs docs/projects/ps-ng.md CLAUDE.md
git commit -m "ps NG: browser check, the still tier measured on the iPhone"
```

---

## Plans 2 and 3 (outline, written when plan 1 lands)

- **Plan 2, motion:** `sprites.ts`, `motion.ts`, `shapes.ts`; one task per element group from spec §4 (clouds; rain, snow and seeds sheets; stars; fireflies; smoke; grass; lightning; skeins with the ported sheet; buzzard and larks; the sun's fire ported from `feat/ps-perf-band`'s `flame.ts`), each ending in one iPhone reading; the calm tier's list; the animation census extended.
- **Plan 3, Auto and retirement:** the native power plugin (iOS `ProcessInfo`, Android `PowerManager`), the Battery API and the frame probe feeding `PowerSignals`; the "Scene animation" setting's new values with `migrateAnimation`; the full three-platform gate at noon, night and storm; the default flipped to NG, classic and the scene half of `ps.css` deleted in one commit.
