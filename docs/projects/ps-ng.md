# ps NG — the ps scene, rebuilt to be cheap

Status: **design approved 2026-10-16**, spike done (§2), implementation plan next. Plan 1 Task 1 (what the still markup costs on the iPhone) measured 2026-10-16, §8.1. Branch `feat/ps-ng`.

The ps theme's scene (`docs/projects/ps-theme.md`) is loved and expensive: on an iPhone 16 it costs 93–106 % of a core in Safari at a rainy noon, most of it in WebKit's page process, and around 95–99 % at night. ps NG is a new renderer for the same theme. It keeps every element and the look, and draws them with a small set of cheap techniques, with tiers so a phone on low power does less.

Goals, in order: **performance first, then match the current look closely.** "Keep the spirit" means keep the same elements where possible, with far fewer animations.

## 1. Decisions

1. **A new renderer beside the old one, not a patch.** The cost is structural (§2), so fixes to classic saved 5–10 points each. NG reuses classic's DOM-free modules and replaces its renderer.
2. **Technique A: prerendered bitmaps moved by CSS transform**, one layer per element, a small canvas only for what changes shape, no WebGL (§2).
3. **Glass is pre-blurred** (§5).
4. **Heat haze is dropped** for now; it may come back later.
5. **Three tiers** — full, calm, still — chosen by the existing gates, a setting and device power signals (§6).
6. **PR #98 (the canvas sun fire, canvas skeins and the text band) is superseded by NG** and will not merge. NG ports what it needs from its branch, `feat/ps-perf-band`: `flame.ts`, the skein sprite sheet from `birds.ts`, and the text band (the 52 % band behind the white words, the user's pick over the outline) — the band rides along with NG.
7. **The budgets are ceilings, not targets** (the user, 2026-10-16: "the goal is as low as possible regardless"). Calm was lifted from 15 to 24 after the red team showed one moving layer already costs 20–21.5.
8. **When NG matches classic**, its default flips and classic is deleted in one commit, with the scene half of `ps.css`.

## 2. What the spike measured (2026-10-16)

A throwaway harness (`tmp/perf/ng/`, gitignored: `index.html`, `run-chrome.mjs`, `ios-wifi-run.sh`, `ios-one.sh`, `reparse.sh`) drew the same motion — 5 clouds, 130 rain drops, a skein of 20 birds — over one still backdrop with each engine.

**iPhone 16, iOS 27.0.1, Safari, tethered.** Sum of WebContent + WebKit.GPU + backboardd, % of one core, two rounds each.

| Variant                                                                        | Sum                       | Where                         |
| ------------------------------------------------------------------------------ | ------------------------- | ----------------------------- |
| current ps (preview build: canvas fire and skeins, 60 fps), rainy noon, 3 runs | 106 / 93 / 93             | WebContent 54–83              |
| floor (gradient only)                                                          | 1–2                       | —                             |
| still backdrop + live `backdrop-filter` glass                                  | 1.6–1.7                   | —                             |
| 1 / 6 / 12 transform layers, tiled                                             | 20–21.5 / 22–24 / 23–24.5 | backboardd only, WebContent 0 |
| 3 transform layers, sheets 2× viewport                                         | 27–31                     | WebContent 4.5                |
| 3 transform layers + `steps(15)` / `steps(30)`                                 | 16–22 / 26                | `steps()` adds WebContent 4–6 |
| one 2D canvas, 0.5× / 0.25×, 30 fps                                            | 34 / 27–33                | split three ways              |
| one WebGL canvas, 0.5× / 0.25×, 30 fps                                         | 58–70 / 48–58             | WebContent + backboardd       |
| canvas motion + live blur / pre-blurred glass                                  | 33, 79 (spike) / 26–37    |                               |

Read as a cost structure, not as NG's predicted figure (the harness moves 3 layers; ps at night runs ~150 animations):

- Nothing moving costs nothing, live blur included: WebKit only re-blurs when the backdrop changes.
- Anything moving through Core Animation costs ~20 points of backboardd (compositing the screen at 60 Hz), and the count of layers barely matters (+3 from 1 to 12).
- WebContent stays at 0 only while every moving layer fits the viewport. Larger layers pull WebKit back in.
- Canvas costs more and keeps the page process busy; resolution barely matters. WebGL is the worst.
- `steps()` saves compositing in Chrome but costs page work in WebKit: not used.

**Chrome (headless, 1512×900 @2×)**, host load 4–34, so ranking only: every engine 2–9 points over a 2.8 floor; live blur over a moving canvas 15.3 (GPU 10.3) against 3.5 pre-blurred.

**Chrome already composites ps's animations**: a trace of the preview build shows all 40 running animations on the compositor, style work 10.6 ms/s. Classic's cost is compositing, raster of its canvases and SVG, SMIL and live blur, not animation bookkeeping.

**Android**: not measured (the emulator swapped under host load). A gate in §8.

## 3. Architecture

**Selection.** NG is the `ps` theme. A setting `psRenderer` (`classic` | `ng`, default `classic`) makes the scene host in `client/js/themeScene.ts` load NG's module (its own `SCENES` entry, `ps-ng`) for the `ps` theme, so A/B is one setting in one build. The chrome half of `ps.css` (glass, fonts, palettes, messages) serves both.

**Modules**, new under `client/js/scenes/psng/`:

| File          | Job                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `scene.ts`    | `mount` / `update` / `destroy`, the minute tick, publishing                                                            |
| `backdrop.ts` | paints the still scene into one canvas; the pre-blurred copy (§5)                                                      |
| `sprites.ts`  | draws each moving element's bitmap, once per palette change                                                            |
| `motion.ts`   | the only place animations are created (`element.animate`); afterwards only `pause()`, `play()`, `updatePlaybackRate()` |
| `shapes.ts`   | small canvases at low frame rates for what changes shape: wingbeats, the sun's fire                                    |
| `tiers.ts`    | full / calm / still from the host state, the setting and device signals                                                |

Imported unchanged from `scenes/ps/`: `engine`, `palette`, `colour`, `grounds`, `glass`, `yurt`. Every NG file but `scene.ts` stays DOM-free where it can, so mocha loads it.

**Styles.** NG's scene CSS ships inside its chunk as a stylesheet the scene adds on mount and removes on destroy (a CSS import would land in the shared `style.css` and every theme).

**Rules the spike set:**

1. Only `transform` and `opacity` are animated.
2. No moving layer is larger than the viewport; a sheet tiles and loops over one tile.
3. No SMIL, no stepper, no per-frame writes to `currentTime` or CSS variables.
4. Variables change on the minute tick only, on the scene's own root (`@property … inherits: false` where a variable is the scene's alone).

**Published as classic publishes:** `data-ps-light`, `data-ps-text`, `--ps-halo`, `--canvas-bg-color`, the glass tints, `theme-color`. The chrome and its legibility tests apply unchanged.

## 4. Element by element

| Element                                                 | Classic                                                    | NG                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Sky, Milky Way, glow, moon, sun disc, land, river, veil | SVG/CSS layers                                             | the still backdrop: one canvas, repainted on the minute                                                                              |
| Overcast deck (rain, storm)                             | SVG billows, 2 s cross-fade                                | in the backdrop; a second backdrop canvas cross-fades by `opacity` when the weather changes                                          |
| Sun's fire                                              | SVG `feTurbulence` on develop; `flame.ts` canvas in PR #98 | `flame.ts`'s frame cache, ported from #98, 24 fps, in `shapes.ts`; the 90 s spin by `transform`                                      |
| Stars (52 twinkling)                                    | 52 opacity animations                                      | 4 star sheets, each twinkling by `opacity` with its own period (gate §8)                                                             |
| Clouds (5, +4 wet)                                      | `cqw` drift                                                | each a small sprite crossing by `transform`                                                                                          |
| Rain, snow, seeds                                       | 3 rain sheets, per-flake and per-seed animations           | tiled sheets with mixed tile heights so the repeat does not show                                                                     |
| Lightning                                               | opacity flash                                              | one layer, `opacity`                                                                                                                 |
| Near grass                                              | SVG sway                                                   | grass bitmap swaying by `skewX`                                                                                                      |
| Fireflies (34)                                          | drift + blink, 68 animations                               | each a tiny sprite, drift by `transform`, blink by `opacity` (gate §8; fallback 4 shared sheets)                                     |
| Yurt, smoke (5 puffs)                                   | SVG, fade-and-jump rule                                    | yurt a still layer placed by `transform` (`yurt.ts` rules kept); puffs rise as sprites                                               |
| Skeins                                                  | SVG strips on develop; canvas flocks in PR #98             | flight by `transform`; wingbeats on one small canvas per flock at 12–24 fps (`shapes.ts`, sprite sheet ported from #98's `birds.ts`) |
| Buzzard, skylarks                                       | CSS + stepped wing frames                                  | glide by `transform`; the larks' wings in `shapes.ts`                                                                                |
| Heat haze                                               | SVG displacement filter                                    | **dropped** (may return)                                                                                                             |
| Frosted query view                                      | `blur()` on the live scene                                 | the pre-blurred backdrop copy, still                                                                                                 |
| Animals                                                 | switched off                                               | stay off                                                                                                                             |
| Embers, settle                                          | chrome CSS                                                 | unchanged (not the scene)                                                                                                            |

Seeds and placements come from the same seeded generators as classic, so every star, cloud, firefly and bird stands where it does today.

## 5. Glass

The glass (sidebar, header, composer, user list, the phone's drawer) shows a **pre-blurred copy of the backdrop** behind its tint, aligned to the scene under it, instead of a live `backdrop-filter`. The brightening and saturation are a CSS `filter` on that still copy, computed once. `glass.ts`'s tints hold, since they are solved against the same grounds.

What changes: moving things (a cloud, the birds, rain) pass under the glass and are hidden by it rather than showing through blurred. The tint is 0.40–0.78 opaque by day, so this should read as subtle; the screenshots in §7 show it.

While the drawer slides, it shows its tint only; it frosts once it rests (as classic delays its blur today).

**Re-blur** (repaint the backdrop, blur again): the minute tick; a change of weather; the day/night flip; the yurt's fade-and-jump to a new place; resize, orientation or device-pixel-ratio change; the frosted query view turning on or off.

**Reposition only** (new background positions, no re-blur): the sidebar opening or closing, a font-size step, any chrome layout change.

`#status-bar-tint` never carries a filter (CLAUDE.md, "The iOS status bar").

## 6. Tiers

| Tier  | Moves                                                                                                                                                 | iPhone budget |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| full  | everything in §4                                                                                                                                      | ≤ 30          |
| calm  | clouds, weather (rain, snow, lightning), smoke, skeins with wings at 8 fps; still: stars, fireflies (glowing, in place), seeds, larks, buzzard, grass | ≤ 24          |
| still | nothing: every animation `pause()`d where it stands                                                                                                   | ≤ 3           |

**Forced still** (as today): reduced motion (`data-reduce-motion`), a hidden page, a page nobody attends to (`createAttention`), a query.

**The setting** "Scene animation" becomes Auto (default) / Full / Calm / Still. Stored values migrate once: `60` and `24` → Auto, `1s` and `sparse` → Calm, `off` → Still.

**Auto** is full unless a power signal says otherwise, then calm; every signal is watched live:

- iOS shell: Low Power Mode or thermal state serious or worse (`ProcessInfo`), through a small native plugin in the style of `SystemAccessibilityPlugin`.
- Android shell: battery saver or thermal throttling (`PowerManager`), the same plugin.
- Chromium: discharging below 20 % (Battery API), or data saver.
- Safari on the web: a short frame-interval probe, if Low Power Mode's 30 fps cap still shows on iOS 26/27 (unverified; gate §8).

## 7. Testing

**Mocha** (DOM-free modules): `tiers.ts` as a truth table, the setting migration included; the motion plan (time, weather, tier → the animations that exist), holding rules 1–2 of §3; the re-blur triggers; seeded placements equal to classic's; the existing legibility suite unchanged.

**Browser** (`tools/scenarios/ps-ng.mjs`): mount, unmount and the renderer switch leaving nothing behind; an animation census (no SMIL, no stepper, only `transform`/`opacity`, every animated box within the viewport); the glass's pixels matching the blurred backdrop under them; the forced-still gates and calm's exact list; side-by-side screenshots of classic and NG at pinned moments (noon, golden hour, dusk, night, rain, snow) for the user to judge — no pixel threshold.

## 8. Performance gates

Measured on every platform before anything is deployed or claimed (iPhone tethered via `ios-one.sh`, Android, Chrome; host load gated or the run labelled rank-only).

1. **Before motion code:** the backdrop repaint + re-blur at 3× density; 34 tiny firefly layers; star sheets twinkling; the Low Power Mode frame probe; an Android baseline on a quiet host or a real phone.
2. **As each element lands:** one iPhone reading, so each addition's cost is visible alone.
3. **Before the default flips:** iPhone, Android and Chrome at noon, night and storm, against classic in the same session, within the §6 budgets.

Not yet known: 120 Hz screens (the compositing floor may double on ProMotion), glass over motion on iOS (one unexplained 79), night as a whole.

### 8.1 Plan 1 Task 1: what the still markup costs on the iPhone (2026-10-16)

iPhone 16, iOS 27.0.1, Safari, tethered. Sum = WebContent + WebKit GPU + backboardd, in % of one core; median (IQR); 50 s dwell; every reading validated by beacons through `summarize.mjs`. The user chose one sitting of about 26 minutes in place of separate runs A and B. Run id `ios2-1792189463000`, 3 rounds, 30 of 30 valid.

| slot           | what                                                                                        | sum              | backboardd |
| -------------- | ------------------------------------------------------------------------------------------- | ---------------- | ---------- |
| coffee         | reference                                                                                   | 1.2 (1.1–32.6)   | 1.1        |
| still          | classic markup, animations paused (`psAnimation` off)                                       | 25.1 (24.2–25.3) | 24.9       |
| still-nofilter | still + every filter removed                                                                | 17.9 (17.0–64.6) | 17.7       |
| rm             | classic with `data-reduce-motion` (`animation: none`), SMIL paused                          | 1.2 (1.1–1.5)    | 1.0        |
| none           | rm's rules re-scoped to `#theme-scene.psng`, SMIL removed, gates without fades, 12:30 clear | 1.1 (1.1–1.5)    | 0.9        |
| none-night     | none at 23:00                                                                               | 1.4 (1.3–1.5)    | 1.3        |
| none-rain      | none 2026-10-19 12:30                                                                       | 1.2 (0.6–35.3)   | 1.0        |
| none-hot       | none 2027-06-21 12:30                                                                       | 1.2 (1.1–1.5)    | 1.1        |
| none-query     | none in a query (ps-private frost) at 23:00                                                 | 1.1 (1.1–1.1)    | 0.9        |
| waapi-paused   | none + `element.animate` stand-in, `pause()` after 5 s                                      | 19.1 (16.6–48.1) | 15.5       |

Single readings with WebContent-only spikes (WebContent 59–90, backboardd at most 2): coffee 64.1, none-rain 69.3, waapi-paused 77.1, still-nofilter 111.2. That is phone-side noise; it hit coffee too. One none-rain reading was 0.0 everywhere (empty trace).

Rain re-run, run id `ios2-1792193002000`, 3 rounds, 6 of 6 valid: coffee 1.1 (0.9 / 1.1 / 1.2); none-rain 1.1 (0.8 / 1.1 / 1.2). An earlier attempt (`ios2-1792187814000`) is void: the harness's page server died at slot 4.

Chrome desktop (rank-only, load 3.8–9.7): coffee 3.4, still 4.4, still-nofilter 2.6, rm 2.8, none 3.7. It cannot rank.

**Verdict.**

- The 23–25 of classic's paused still is the paused animations. WebKit keeps them as Core Animation work in backboardd. Filters account for about 7 of it.
- `none` passes: every none slot is within 2 of the same run's coffee, rain confirmed by its re-run. `none` becomes `STILL_RULES` (`NG_STILL_CSS`, Task 5).
- `pause()` is not still on iOS (waapi-paused 19.1 against none 1.1). Plan 2 stills animations with `cancel()` and recreates them at their phase.
- Classic's reduced motion (`rm`) is already at coffee. Task 1b (`animation: none` in classic's own still states) was offered and not taken.
- The user accepted the harness `none` readings as NG's iPhone numbers. Task 6's own phone run is optional.
