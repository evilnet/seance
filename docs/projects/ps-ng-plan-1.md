# ps NG — Plan 1: the still scene, classic's markup without its motion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A selectable NG renderer for the `ps` theme that shows classic's scene still — the same markup and CSS, with no animation object, SMIL clock or stepper in it — and costs on the iPhone what the `coffee` theme costs, so plan 2 can add motion one element at a time from a clean floor.

**Architecture:** A `psRenderer` setting makes the scene host load `scenes/psng/scene` for the `ps` theme. NG mounts classic's own markup (`sceneMarkup`), removes its SMIL, and adopts a small stylesheet that turns every CSS animation in the scene off and hides the groups that only exist in flight; it keeps classic's minute tick (scene variables, moon phase, overcast, publishing) and its yurt and composer watchers. The glass is classic's live blur, untouched. Rewritten 2026-10-16 after the red team (`ps-ng-redteam-1.md`) and spike 2 (below) replaced the canvas backdrop and the pre-blurred glass.

**Tech Stack:** TypeScript (strict), Vue 3 (one settings control), constructed stylesheets, mocha + chai + sinon, `tools/browser-drive.mjs` scenarios, the spike harness in `tmp/perf/ng2/` (gitignored, local).

**Spec:** `docs/projects/ps-ng.md` (§4 and §5 are amended by this plan's results; Task 6 updates them).

## What spike 2 decided (2026-10-16, `tmp/perf/ng2/`, `tmp/ps-ng-spike2/`)

| Reading                                                      | Chrome desktop | iPhone 16 Safari                          |
| ------------------------------------------------------------ | -------------- | ----------------------------------------- |
| coffee theme                                                 | 1.1            | 1.1                                       |
| classic as shipped                                           | 14.3           | 93–106 (spike 1)                          |
| classic's markup, animations **paused** (`psAnimation: off`) | 1.0            | **23–25**, all backboardd, WebContent 0.1 |
| the same with live blur over motion (G0)                     | 7.2            | +3 over still                             |
| frosted twin (G3)                                            | 6.3            | **408**, WebKit GPU process 390 % — out   |
| live blur with motion masked out (G2)                        | 9.1            | — out (dearer than G0, hard edges)        |

So: **glass = classic's live blur**; **backdrop = classic's markup**, but paused is not still on iOS — Task 1 finds what costs the 23 before anything is built on it.

## Global Constraints

- NG creates no animation object, no SMIL clock and no stepper in plan 1; the census in Task 6 holds it.
- NG never changes the glass: no rule in NG's stylesheet touches `backdrop-filter`, `background` or the tints of `#sidebar`, `#chat .header`, `#chat .userlist`, `#form` or the reaction chips.
- NG publishes exactly what classic publishes: `data-ps-light`, `data-ps-text`, `--ps-halo`, `--canvas-bg-color`, the glass tints (`glassVars`), `ps-form-tall`, `theme-color` (handed back on destroy unless something else wrote it).
- `psRenderer` defaults to `"classic"`; the NG option is shown in Settings only while `localStorage["thelounge.state.psngPreview"] === "1"`.
- Reduced motion is read from `data-reduce-motion` / `systemAccessibility()`, never a new `@media` query. `#status-bar-tint` never carries a filter. Sizes in `rem`. No Node built-ins in `client/`.
- Worktree setup: `tmp/psng` has no `node_modules` or `public/`. Before building or testing: `ln -s ../../node_modules node_modules` (remove before committing; it is not ignored there), then `NODE_ENV=production npx webpack` in the worktree. Type-check: `npx tsc --noEmit -p client/tsconfig.json` (no `vue-tsc` in this repo; `.vue` files are not type-checked by it). Lint: `npx eslint <files>`, `npx prettier --check <files>`, `npx stylelint <css files>`.
- iPhone readings: tethered, Auto-Lock Never, at most ~15 minutes of phone time per run (the user's limit), ≥ 3 interleaved rounds with a `coffee` slot every round, `devicectl … lockState` before each `xctrace`, beacons validating every slot. Serve the **worktree's** build, never the main checkout's `public/`.
- Commits carry no AI-credit trailers. Prettier before every commit.

## Review Focus

1. **Theme switched away from ps, or renderer back to classic, while NG is mounted** — NG's adopted sheet, the scene's root classes and variables, the minute timer and both watchers are gone; classic mounts clean. Test in Task 5 and Task 6.
2. **Boot with `psRenderer: "ng"` stored** — the classic chunk is never fetched. Test in Task 4.
3. **A night or rainy cold start** — the first frame already shows the night sky or the deck (variables written before the first paint, as classic does), never the daylight fallback under night text. Test in Task 6 (screenshot at 23:00 taken within 300 ms of mount).
4. **A query (the private view)** — classic's frost (`ps-private` → `.ps-frost` blur) applies to NG unchanged; its iPhone cost is measured, since spike 2 showed WebKit re-applying a static `filter: blur` on every composite. Reading in Task 6.
5. **Reduced motion** — NG is still already; the scene looks the same with it on as off, and classic's reduced-motion rules do not unhide what NG hides. Check in Task 6.

---

### Task 1: Find what makes the still markup cost 23 on the iPhone

Measurement only. Its verdict fixes the contents of NG's stylesheet (Task 5).

**Files:**

- Modify: `tmp/perf/ng2/app/spike.js` (gitignored) — new option `m=none` and `hide=<groups>`
- Modify: `tmp/perf/ng2/ios-run.sh` (gitignored) — `SHORT=3` slot set
- Modify: `docs/projects/ps-ng.md` §8 — the results table

**Interfaces:**

- Produces: `STILL_RULES` — the exact CSS (and markup removals) that bring classic's markup to within 2 points of `coffee` on the iPhone; Task 5 ships them verbatim.

- [ ] **Step 1: Add the variants to `spike.js`**, each applied at load before the scene mounts (a `<style>` appended to `<html>` and a `MutationObserver` on `#theme-scene` that removes nodes as they are inserted):
  - `m=none`: `#theme-scene, #theme-scene * { animation: none !important; transition: none !important; }`; remove every `animate`, `animateMotion`, `animateTransform`, `set` element; hide `.ps-skeins, .ps-daybirds, .ps-smoke, .ps-weather` (`display: none`); `psAnimation: "off"` as before so the stepper never starts.
  - `hide=sun|stars|fireflies|clouds|ground|grass|veil|frost` (comma-separated, with `m=none`): `display: none` on `.ps-sun`, `.ps-stars`, `.ps-fireflies`, `.ps-cloud-field`, `.ps-ground`, `.ps-blades`, `.ps-veil`; `frost` removes every `filter` (`#theme-scene * { filter: none !important }` and strips SVG `filter=` attributes).
- [ ] **Step 2: Chrome sanity check** — `node run-chrome.mjs` with the new slots (desktop only, 2 rounds) — Expected: every slot valid by beacon, `runningAnimations` 0 for `m=none`.
- [ ] **Step 3: iPhone run** — `SHORT=3 DWELL=50 ./ios-run.sh 3` with slots `coffee`, `still` (paused, the 23 reference), `none`, `none,hide=sun`, `none,hide=frost` — 5 slots × 3 rounds × 50 s ≈ 13 min.
      Expected: one JSON row per slot; summarise with the medians script (`node -e` over `ios-2.jsonl`, as for `ios-short2.md`).
- [ ] **Step 4: Decide.** The first variant within 2 points of `coffee` is `STILL_RULES`. If none is, run one more ≤ 13-minute set with `none,hide=<group>` for the remaining groups (stars, fireflies, clouds, ground, grass, veil) and take the group whose removal closes the gap; that group gets its own still treatment in Task 5 (named in the spec).
- [ ] **Step 5: Record and commit** — the table and the verdict in spec §8.

```bash
git add docs/projects/ps-ng.md
git commit -m "docs: ps NG — what the still markup costs on the iPhone, and why"
```

---

### Task 2: The text band rides along

**Files:** the two commits of `feat/ps-text-band`: `76fddb2a` ("ps: white words over a band instead of an outline") and `95d9e792` ("ps: docs — the glyph samples measured with the band") — `client/themes/ps.css`, `test/themes/ps.ts`, `tools/ps/{calibrate.mjs,legibility.ts,palette-blocks.ts}`, `docs/projects/ps-theme.md`, `CLAUDE.md`.

**Interfaces:** none new; chrome only, both renderers.

- [ ] **Step 1: Cherry-pick** — `git cherry-pick -x 76fddb2a 95d9e792`; resolve conflicts by keeping develop's surrounding text and the band's changed lines.
- [ ] **Step 2: Run the ps suites** — `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml 'test/scenes/ps/*.ts' test/themes/ps.ts` — Expected: PASS.
- [ ] **Step 3: Generated palette unchanged** — `npx tsx tools/ps/palette-blocks.ts` (without `--write`) — Expected: reports no change (the band's 0.52 was chosen so the palette holds; spec memory says regen unchanged).
- [ ] **Step 4: Commit** — the cherry-picks are the commits.

---

### Task 3: Share classic's minute work with NG

**Files:**

- Create: `client/js/scenes/ps/watchers.ts`
- Create: `client/js/scenes/ps/publish.ts`
- Modify: `client/js/scenes/ps/scene.ts`, `client/js/scenes/ps/grounds.ts`
- Create: `test/scenes/ps/standin.ts` (the stand-in page from `test/scenes/ps/mount.ts`, moved so both suites import it)
- Modify: `test/scenes/ps/mount.ts`, `test/scenes/ps/scene.ts`

**Interfaces:**

- Produces:

  - `placeYurt(root: HTMLElement): {seen(): void; refind(): void; destroy(): void}` and `watchComposer(root: HTMLElement, html: HTMLElement): {refind(): void; destroy(): void}` in `watchers.ts` — moved verbatim (NG uses classic's `.ps-yurt` element, so no parameter changes)
  - `watchLand(root: HTMLElement): {destroy(): void}` in `watchers.ts` — moved verbatim (it writes `--ps-land-round-x/-y`)
  - `overcastBuilder(overcast: HTMLElement): {build(weather: Weather, fade: boolean): void; end(): void}` in `watchers.ts` — classic's `buildOvercast` and `endFade`, moved out of `mount`'s closure unchanged in behaviour
  - `themeColorFor(published: Published): string` in `grounds.ts`
  - `publishMoment(root: HTMLElement, html: HTMLElement, meta: HTMLMetaElement | null, m: Moment, p: Palette): string | null` in `publish.ts` — classic's tail of `apply`: moon phase attributes (`.ps-m-ell` rx and fill, `.ps-m-shape` mirror), `root.dataset.weather` / `season`, `data-ps-light`, `data-ps-text`, `--ps-halo`, `--canvas-bg-color`, the `glassVars` set/remove loop, the meta's content; returns the colour it wrote
  - `unpublish(html: HTMLElement, meta: HTMLMetaElement | null, themeColor: string | null, wrote: string | null): void` in `publish.ts` — classic's destroy-time removal and meta hand-back
  - `test/scenes/ps/standin.ts` exports the stand-in classes and an `installPage(): {restore(): void; …}` used by both mount suites

- [ ] **Step 1: Move them**; classic's `mount` calls the moved functions; behaviour unchanged.
- [ ] **Step 2: Run the ps suites** — as Task 2 Step 2 plus `test/tests/themeScene.ts` — Expected: PASS, the same test count as before.
- [ ] **Step 3: Commit** — `git commit -m "ps: the minute's publishing and the scene watchers in their own modules"`

---

### Task 4: The renderer switch

**Files:**

- Modify: `client/js/themeScene.ts`, `client/js/settings.ts`, `client/js/store-settings.ts` (if the apply order needs it), `client/components/Settings/Appearance.vue`
- Create: `client/js/scenes/psng/scene.ts` (stub: `mount` returning a handle whose `update`/`destroy` do nothing)
- Test: `test/tests/themeScene.ts`

**Interfaces:**

- Produces:

  - `export type PsRenderer = "classic" | "ng"`; `normalizePsRenderer(value: unknown): PsRenderer` (unknown → `"classic"`)
  - `SCENES["ps-ng"] = () => import(/* webpackChunkName: "scene-ps-ng" */ "./scenes/psng/scene")`
  - `sceneKey(theme: string, renderer: PsRenderer): string` — `"ps-ng"` for `ps` + `ng`, else `theme`
  - `SceneHost.setRenderer(renderer: PsRenderer): void` — remembers it; if the asked theme is `ps` and `sceneKey` changes: bump `ticket`, clear `failed`, unmount, `attempt(sceneKey(asked, renderer), ticket)`. `setTheme` and `retry` resolve through `sceneKey` too (`failed` holds the key, not the theme name).
  - setting `psRenderer: {default: "classic", apply: (store, value) => themeScene.setRenderer(normalizePsRenderer(value))}`, declared **before** `theme` in the settings object so `applyAll` (key order, `store-settings.ts`) sets the renderer before the first `setTheme`
  - Appearance: a radio pair "Scene renderer: Classic / NG (preview)" under the ps settings, shown only while `localStorage["thelounge.state.psngPreview"] === "1"` (read once in `setup`)

- [ ] **Step 1: Write the failing tests** (the file's fake loaders):
  - `sceneKey("ps","ng") === "ps-ng"`, `sceneKey("ps","classic") === "ps"`, `sceneKey("coffee","ng") === "coffee"`
  - `"setRenderer('ng') with ps mounted swaps the module"`: `ps` handle destroyed once, `ps-ng` loader called once, `mounted === "ps-ng"`
  - `"setRenderer before setTheme('ps') never loads classic"`: `setRenderer("ng")`, `setTheme("ps")` → `ps` loader never called
  - `"setRenderer with another theme only remembers it"`
  - `"a failing ps-ng chunk keeps the fallback and retries the ps-ng key"`: the `ps-ng` loader rejects once then resolves; `warn` once; `retry()` (via `setVisible(true)`) calls the `ps-ng` loader again, never `ps`
  - `"settings apply psRenderer before theme"`: the key order of the settings object puts `psRenderer` before `theme`
- [ ] **Step 2: Run to see them fail** — `… mocha … test/tests/themeScene.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**, the setting, the guarded radio pair (radios, so no `v-switch`), the stub.
- [ ] **Step 4: Run to see them pass**; `npx tsc --noEmit -p client/tsconfig.json` — Expected: PASS, no errors.
- [ ] **Step 5: Commit** — `git commit -m "ps: a renderer setting that loads the NG scene in place of classic's"`

---

### Task 5: The NG still scene

**Files:**

- Modify: `client/js/scenes/psng/scene.ts`
- Create: `client/js/scenes/psng/styles.ts`
- Test: `test/scenes/psng/mount.ts` (on `test/scenes/ps/standin.ts`)

**Interfaces:**

- Consumes: Task 1's `STILL_RULES`; Task 3's `placeYurt`, `watchComposer`, `watchLand`, `overcastBuilder`, `publishMoment`, `unpublish`; classic's `sceneMarkup`, `sceneVars`, `sceneClasses`, `weatherChanged`; `momentAt`, `paletteAt`; `isPhoneLayout`.
- Produces:
  - `export const NG_STILL_CSS: string` in `styles.ts` — `STILL_RULES`, plus classic's reduced-motion rest places for the clouds (`ps.css`'s rule that parks `.ps-cloud` at its `--cp` place under reduced motion, restated under `#theme-scene.psng`)
  - `mount(root: HTMLElement, initial: SceneHostState): SceneHandle`

**What `mount` does:** adds class `psng` to `root`; adopts a `CSSStyleSheet` of `NG_STILL_CSS` (`document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]`); `root.innerHTML = sceneMarkup(isPhoneLayout())`, then removes every SMIL element (`root.querySelectorAll("animate, animateMotion, animateTransform, set")`) and pauses every `svg` (`pauseAnimations()`, so the sun's filter clock is still); starts `placeYurt`, `watchComposer`, `watchLand`; on each minute while visible (classic's scheduling: `60000 - (s * 1000 + ms) + 20`, first tick at once when visible): writes `sceneVars` on `root`, toggles `sceneClasses`, rebuilds the overcast through `overcastBuilder` on `weatherChanged`, calls `publishMoment`. `update`: `view === "query"` toggles `ps-private` (classic's frost, unchanged); hidden → clear the timer; visible again → tick at once; `yurt.refind()`, `composer.refind()`. `destroy`: timer, watchers, overcast's `end()`, `unpublish`, removes the sheet from `adoptedStyleSheets`, removes `psng` and every inline property from `root`, empties it.

- [ ] **Step 1: Write the failing tests** in `test/scenes/psng/mount.ts`:
  - `"no animation and no SMIL"`: after mount, the stand-in root holds no `animate*`/`set` element and `pauseAnimations` was called on every `svg`
  - `"publishes what classic publishes"`: mount visible at 2026-06-21 12:00 and at 23:00; every published attribute and property and the meta's content equal classic's `mount` at the same instant (run both on the stand-in)
  - `"ticks on the minute, not while hidden"`: `publishMoment` effects change at +60 s; mounted hidden → nothing written until `update({visible: true…})`, which writes at once
  - `"a query sets ps-private"`
  - `"destroy leaves nothing"`: sheet gone from `adoptedStyleSheets`, `psng` gone, `root` empty, no pending timers (`clock.countTimers() === 0`), meta back to the theme's colour, the published attributes removed as classic removes them
- [ ] **Step 2: Run to see them fail** — `… mocha … test/scenes/psng/mount.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `styles.ts` and `scene.ts`; extend the stand-in with `CSSStyleSheet` (`replaceSync`) and `document.adoptedStyleSheets` (installed and removed per test).
- [ ] **Step 4: Run to see them pass**, then the whole scene set: `… mocha … 'test/scenes/**/*.ts' test/tests/themeScene.ts test/themes/ps.ts` — Expected: PASS.
- [ ] **Step 5: Build and smoke** — worktree build; serve `public/` on 8000; in Chrome set `settings = {"theme":"ps","psRenderer":"ng"}` and `thelounge.state.psngPreview = "1"` — Expected: classic's scene, nothing moving, the glass as classic's, no console errors.
- [ ] **Step 6: Commit** — `git commit -m "ps NG: classic's scene, still — its markup with no animation, SMIL or stepper"`

---

### Task 6: Browser check, iPhone readings, docs

**Files:**

- Create: `tools/scenarios/ps-ng.mjs` (pattern: `tools/scenarios/theme-ps.mjs`, its `CLOCK_SHIM`/`__setClock`, its CDP `Emulation.setEmulatedMedia` with a SKIP fallback; needs the dev ircd for `#seance`)
- Modify: `docs/projects/ps-ng.md` (status; §4 and §5 amended — backdrop is classic's markup, glass is classic's live blur, G1/G3 out with their numbers; §8 readings), `CLAUDE.md` (one bullet: the NG renderer, its preview flag, its browser check)

- [ ] **Step 1: Write the scenario's checks**
  - switch: with `psRenderer: "ng"` the root has class `psng`; back to classic → no `psng`, no adopted NG sheet, classic's animations running
  - census: `document.querySelector("#theme-scene").getAnimations({subtree: true}).length === 0`; no SMIL element; `#sidebar`'s computed `backdrop-filter` equals classic's at the same moment
  - cold night start: set the clock to 23:00, mount, screenshot within 300 ms — the sky pixel at the top centre is classic's night `--ps-sky-top` (± 6 per channel), not the daylight fallback
  - reduced motion (`data-reduce-motion` set): the scene's screenshot equals the one without it (± 2 per channel over 95 % of pixels)
  - screenshots: classic and NG at 2026-06-21 12:00, 20:45, 23:30, 2026-10-19 12:00 (rain), 2026-01-15 12:00 (snow), desktop and `--mobile`, under `tmp/ps-ng-shots/`
- [ ] **Step 2: Run it** against a fresh worktree build — `node tools/browser-drive.mjs --scenario tools/scenarios/ps-ng.mjs` — Expected: every check `ok`.
- [ ] **Step 3: iPhone readings** — point `tmp/perf/ng2/app` at the worktree's fresh `public/`; slots `coffee`, `ng`, `ng` with the drawer open, `ng` in a query; 3 rounds (≈ 11 min).
      Expected: `ng` within 2 of `coffee`; drawer open and query recorded as they are (they carry classic's glass and frost costs, which plan 2's budget starts from).
- [ ] **Step 4: Show the screenshots to the user** and record their verdict.
- [ ] **Step 5: Docs, lint, commit** — `npx eslint` / `npx prettier --check` / `npx stylelint` on the changed files — Expected: clean.

```bash
git add tools/scenarios/ps-ng.mjs docs/projects/ps-ng.md CLAUDE.md
git commit -m "ps NG: browser check and iPhone readings of the still scene"
```

---

## Plans 2 and 3 (outline)

- **Plan 2, motion:** `tiers.ts` (full/calm/still, `migrateAnimation`), `motion.ts` (`element.animate`, transform/opacity only, created once, then only `pause`/`play`/`updatePlaybackRate`); one task per element group of spec §4, each re-enabling one classic element as compositor motion and ending in one iPhone reading against plan 1's floor; wingbeats as prerendered poses swapped by `opacity`; the gates moved from plan 1 (Low Power probe, star sheets, fireflies' layer count, Android on a real phone); the query view's frost cost if Task 6 shows it high.
- **Plan 3, Auto and retirement:** the native power plugin, the Battery API and the probe feeding `PowerSignals`; the "Scene animation" setting's new values; the three-platform gate; the default flipped; classic's animation code and the scene half of `ps.css` that NG no longer reads deleted in one commit.
