# ps NG — the ps scene, rebuilt to be cheap

Status: **NG is the ps scene; classic deleted 2026-10-17; plan 5 (calm in budget, the skeins without the wander) built 2026-10-18, gate passed, §11.4** (decision 8, done on the user's go with the iPhone budgets still unmet, §8.3, §10.6). Plan 1 (the still scene) and plan 2 (motion) were built 2026-10-16 (§8.1, §9.7), plan 4 (the birds and the sun) 2026-10-17 (§10); plan 3's three-platform gate is §8.3. The design below was approved 2026-10-16; spike 2 (`ps-ng-plan-1.md` § What spike 2 decided) replaced its backdrop and its glass, and the sections say where.

The ps theme's scene (`docs/projects/ps-theme.md`) is loved and expensive: on an iPhone 16 it costs 93–106 % of a core in Safari at a rainy noon, most of it in WebKit's page process, and around 95–99 % at night. ps NG is a new renderer for the same theme. It keeps every element and the look, and draws them with a small set of cheap techniques, with tiers so a phone on low power does less.

Goals, in order: **performance first, then match the current look closely.** "Keep the spirit" means keep the same elements where possible, with far fewer animations.

## 1. Decisions

1. **A new renderer beside the old one, not a patch.** The cost is structural (§2), so fixes to classic saved 5–10 points each. NG reuses classic's DOM-free modules and replaces its renderer.
2. **What moves is classic's own CSS animations, played natively, group by group** (plan 2, the user's pick 2026-10-16, §9): every keyframe classic's scene uses already moves only `transform` and `opacity`. Only what classic drives with SMIL gets new code (wing poses swapped by `opacity`, the sun's fire, the buzzard's path, the grass sway), and rain gets tiles no larger than the viewport. A group that disappoints moves, on its own, to `element.animate` (where phase or rate must be set in code) or to prerendered bitmaps moved by transform — the technique this item first named. No WebGL (§2). What stands still is classic's own markup (§4).
3. **Glass is classic's live blur** (§5). The pre-blurred glass this item first chose was measured out in spike 2.
4. **Heat haze is dropped** for now; it may come back later.
5. **Three tiers** — full, calm, still — chosen by the existing gates, a setting and device power signals (§6).
6. **PR #98 (the canvas sun fire, canvas skeins and the text band) is superseded by NG** and will not merge. NG ports what it needs from its branch, `feat/ps-perf-band`: `flame.ts`, the skein sprite sheet from `birds.ts`, and, at first, the text band (the 52 % band behind the white words); on 2026-10-17 the user chose the original outline instead ("follow OG", as #98 itself had gone back to it on 2026-10-10), so NG carries the outline.
7. **The budgets are ceilings, not targets** (the user, 2026-10-16: "the goal is as low as possible regardless"). Calm was lifted from 15 to 24 after the red team showed one moving layer already costs 20–21.5.
8. **When NG matches classic**, its default flips and classic is deleted in one commit, with the scene half of `ps.css`. **Done 2026-10-17** (the user: "flip and delete"), with NG still over the iPhone budgets at night and dusk (§8.3).

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

| File        | Job                                                                                                       | Plan |
| ----------- | --------------------------------------------------------------------------------------------------------- | ---- |
| `scene.ts`  | `mount` / `update` / `destroy`, the minute tick, the gates, publishing                                    | 1    |
| `styles.ts` | `NG_STILL_CSS`, the adopted stylesheet: nothing animates or transitions, the in-flight layers out         | 1    |
| `groups.ts` | DOM-free: the motion groups, which run in each tier, and the gates each needs (§9)                        | 2    |
| `tiers.ts`  | DOM-free: full / calm / still from the host state and the setting; the forced-still states (§6, §9)       | 2    |
| `poses.ts`  | the SMIL replacements: skein and lark wing poses swapped by `opacity`, the buzzard's path, the grass sway | 2    |
| `flame.ts`  | the sun's fire: #98's frame cache, ported, 24 fps                                                         | 2    |
| `rain.ts`   | rain tiles, each no larger than the viewport, looping over one tile                                       | 2    |

The `sprites.ts`, `motion.ts` and `shapes.ts` this table first listed are not built unless a group falls back (decision 2).

There is no `backdrop.ts` and no frost of NG's own: the backdrop is classic's markup (§4), and the query view's frost is classic's `ps-private` rule (§4).

Shared with classic under `scenes/ps/`: `engine`, `palette`, `colour`, `grounds`, `glass`, `yurt`, `layers` (the gates), and three modules split out of classic's `scene.ts` for both to use — `markup.ts` (the scene's markup, its variables and classes), `watchers.ts` (the yurt's place, the composer's height, the land's proportions, the day's clouds) and `publish.ts` (what goes on `<html>` and `theme-color`). NG never imports classic's `scene.ts`, so its chunk carries no stepper, birds runtime or fades, and a page that boots on NG never fetches `scene-ps.js`.

**Styles.** NG's scene CSS ships inside its chunk as a stylesheet the scene adopts on mount and drops on destroy (a CSS import would land in the shared `style.css` and every theme).

**The preview flag.** Settings → Appearance shows "Scene renderer: Classic / NG (preview)" under the ps theme while `localStorage["thelounge.state.psngPreview"] === "1"`, or while the stored `psRenderer` is already `ng` (a restored backup carries the setting but not the flag).

**Rules the spike set:**

1. Only `transform` and `opacity` are animated.
2. No moving layer is larger than the viewport; a sheet tiles and loops over one tile.
3. No SMIL, no stepper, no per-frame writes to `currentTime` or CSS variables.
4. Variables change on the minute tick only, on the scene's own root (`@property … inherits: false` where a variable is the scene's alone).

**Published as classic publishes:** `data-ps-light`, `data-ps-text`, `--ps-halo`, `--canvas-bg-color`, the glass tints, `theme-color`. The chrome and its legibility tests apply unchanged.

## 4. Element by element

The NG column below is the first design. Plan 2 replaced it with classic's own CSS, group by group: where the two differ, §9.2 holds.

| Element                                                 | Classic                                                    | NG                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Sky, Milky Way, glow, moon, sun disc, land, river, veil | SVG/CSS layers                                             | classic's markup, still; its colours change on the minute tick (plan 1)                                                              |
| Overcast deck (rain, storm)                             | SVG billows, 2 s cross-fade                                | classic's billows; the day's set is swapped at once, no fade (plan 1)                                                                |
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
| Frosted query view                                      | `blur()` on the live scene                                 | classic's `ps-private` frost on the still markup; it snaps on and off instead of easing (plan 1)                                     |
| Animals                                                 | switched off                                               | stay off                                                                                                                             |
| Embers, settle                                          | chrome CSS                                                 | unchanged (not the scene)                                                                                                            |

Seeds and placements come from the same seeded generators as classic, so every star, cloud, firefly and bird stands where it does today.

**Plan 1 is the still scene**: classic's markup with every SMIL element removed, every SVG clock paused, `NG_STILL_CSS` adopted (classic's reduced-motion rules re-scoped to `#theme-scene.psng`), classic's gates applied at once and never `ps-hot`. Nothing in flight is drawn — no bird, drop, flake, seed, lightning or smoke — and each cloud rests where its delay puts it on its path. The looks that change from classic on purpose, for the user to judge:

- the query view's frost snaps on and off instead of easing;
- the day's clouds and deck swap at midnight without classic's 2 s cross-fade;
- the yurt's move to a new place is a cut: since 2026-10-17 its place is CSS alone, right-anchored (`ps-theme.md` §5), and no script hides or moves it;
- no heat haze on a hot day (decision 4).

## 5. Glass

**The glass is classic's live `backdrop-filter`, unchanged.** NG's stylesheet touches none of the glass (`#sidebar`, `#chat .header`, `#chat .userlist`, `#form`, the reaction chips), and the browser check holds `#sidebar`'s computed `backdrop-filter` equal under both renderers. Over a still scene a live blur costs nothing: WebKit re-blurs only when the backdrop changes (§2).

Spike 2 (2026-10-16, `ps-ng-plan-1.md` § What spike 2 decided; Chrome desktop and iPhone 16 Safari, sum % of one core) tried the alternatives against live blur over motion (G0: Chrome 7.2, iPhone +3 over still; in spike 2's short iPhone run, drawer open, 2026-10-16 (`tmp/perf/ng2/ios-short.md`), G0 34.3 against still's 30.9):

- **G1**, the pre-blurred backdrop copy this section first described, was not measured on its own; G3 is its cheapest form, and it failed.
- **G2**, live blur with the motion masked out of the glass: Chrome 9.1, dearer than G0, with hard edges. Out.
- **G3**, a frosted twin of the scene behind tint-only panels: Chrome 6.3, iPhone **408** (WebKit's GPU process 390). Out.

`#status-bar-tint` never carries a filter (CLAUDE.md, "The iOS status bar").

## 6. Tiers

| Tier  | Moves                                                                                                                      | iPhone budget |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | ------------- |
| full  | everything in §4                                                                                                           | ≤ 30          |
| calm  | clouds; everything else still (plan 5, §11.1)                                                                              | ≤ 24          |
| still | nothing: no animation object exists (plan 2: `animation: none`, and each loop resumes at its phase through `--psng-t`, §9) | ≤ 3           |

Plan 1's whole scene is the still tier: it creates no animation object, SMIL clock or stepper (the census in §7 holds it), and costs 1.1–1.4 on the iPhone (§8.1). `pause()` does not make a scene still on iOS — a paused animation is still Core Animation work in backboardd (19.1 against 1.1, §8.1) — so plan 2 stills with `animation: none`, and with `cancel()` wherever it creates animations itself.

**Forced still** (as today): reduced motion (`data-reduce-motion`), a hidden page, a page nobody attends to (`createAttention`), a query.

**The setting** "Scene animation" becomes Auto (default) / Full / Calm / Still in plan 2. Stored values are read as the new ones (on load, not rewritten, so an old backup restores the same way): `60` and `24` → Auto, `1s` and `sparse` → Calm, `off` → Still. Classic reads the new values: Auto and Full play at the screen's rate (classic's `60`), Calm steps once a second (`1s`), Still is `off`. Auto follows the device (below).

`cancel()` applies only where a group falls back to `element.animate` (decision 2); classic's own CSS animations go still the way plan 1 measured, by `animation: none` (§8.1, `rm` and `none`).

**Auto** follows the device (the user, 2026-10-17):

| Auto on…                                                         | normal power | low power |
| ---------------------------------------------------------------- | ------------ | --------- |
| a phone: `PHONE_LAYOUT_QUERY` **and** `(pointer: coarse)` match  | calm         | still     |
| anything else (desktop at any width, tablet, a mouse-driven PWA) | full         | calm      |

A narrow desktop window stays Full; an iPad in split view narrow enough for the phone layout counts as a phone. Full, Calm and Still chosen by hand ignore device and power; the forced-still states win over everything. Both are watched live (`themeScene.ts` `setDevice`).

Low power is two signals: a battery discharging below 20 % (the Battery API, where a browser has it), and the system's battery saver (Android's, iOS's Low Power Mode). Thermal state and data saver are dropped.

How each is read (`helpers/power.ts` merges the latest reading of each): the battery through `navigator.getBattery`; Android's battery saver as `powerSave` on the shell's `SystemAccessibility` plugin; iOS's Low Power Mode in the shell from a `Power` plugin in `SceneDelegate.swift`, and in Safari from the frame rate — on iOS a page too slow to keep 60 fps (a median frame of 28 ms or more over 30 frames) counts as low power, sampled 2 s after load, on each return to the page and every 2 minutes while it says low power. Measured 2026-10-17 on the iPhone 16 (coffee theme, median of 120 frames): Safari 17 ms with Low Power Mode off and 33 ms on; the shell 17 ms both ways — WebKit caps a Safari page at 30 fps in Low Power Mode but not the shell's web view, hence the plugin.

## 7. Testing

**Mocha** (DOM-free modules): `tiers.ts` as a truth table, the setting migration included; the motion plan (time, weather, tier → the animations that exist), holding rules 1–2 of §3; seeded placements equal to classic's; the existing legibility suite unchanged.

**Browser** (`tools/scenarios/ps-ng.mjs`, plan 1; 27 checks on the desktop, 24 with `--mobile`): the Settings radio pair under the preview flag, each choice mounting its renderer (desktop); the switch both ways — NG's `psng` class and adopted sheet, and back on classic neither, with classic's SMIL back and its clocks moving; the census — no animation on the scene, no SMIL element, every SVG clock paused, nothing moving in 300 ms, `#sidebar`'s `backdrop-filter` (the open drawer's on a phone) equal to classic's at the same minute; a hot noon — classic sets `ps-hot`, NG never does, and its grass is drawn in `--ps-grass`; reduced motion changing no pixel of NG's scene; a cold boot at 23:00 with NG stored — the first frame carries the night's `--ps-sky-top`, the sky's pixel matches it, and `scene-ps.js` is never fetched; and side-by-side screenshots of classic and NG at five pinned moments, with a contact sheet per viewport, for the user to judge — no pixel threshold. There is no glass-pixel check: the glass is classic's own (§5). Plan 2 adds the census of what moves (only `transform`/`opacity`, every animated box within the viewport) and calm's exact list.

## 8. Performance gates

Measured on every platform before anything is deployed or claimed (iPhone tethered via `ios-one.sh`, Android, Chrome; host load gated or the run labelled rank-only).

1. **Plan 2's sitting (§9.5):** each group alone over the still scene, full and calm, against coffee and classic in the same sitting; the Android emulator's ladder on a quiet host, rank-only. The Low Power Mode frame probe moves to plan 3 with Auto. (The backdrop repaint and re-blur gate that stood first here is superseded by plan 1: there is no canvas backdrop and no re-blur.)
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
- `pause()` is not still on iOS (waapi-paused 19.1 against none 1.1). Plan 2 never holds an animation paused: CSS animations go to `animation: none`, and any it creates with `element.animate` are `cancel()`led and recreated at their phase.
- Classic's reduced motion (`rm`) is already at coffee. Task 1b (`animation: none` in classic's own still states) was offered and not taken.
- The user accepted the harness `none` readings as NG's iPhone numbers. Task 6's own phone run was skipped on that ruling: NG's adopted sheet is the `none` rung's rules verbatim, and the harness readings of it stand as plan 1's iPhone figures (coffee 1.1–1.2; NG 1.1 at noon, 1.4 at night, 1.1 in rain and in a query).

### 8.2 Plan 1 Task 6: the browser check (2026-10-16)

`tools/scenarios/ps-ng.mjs` against the worktree's production build, headless Chrome, host load 3–15: 27 of 27 on the desktop (1280 × 900), 24 of 24 on a phone (390 × 844, `--mobile`). A cold boot's first frame came 0.1–11.5 ms after NG's mount, already on the night sky. Screenshots and the two contact sheets in `tmp/ps-ng-shots/` (gitignored).

### 8.3 Plan 3 Task 5: the three-platform gate (2026-10-17, over budget)

iPhone 16, Safari, USB, sum of WebContent + GPU + backboardd as % of one core, medians. The gate (14 slots, 2 rounds; round 2 lost slots 19–27 to a locked screen, so those are n = 1):

| moment | NG full (≤ 30) | NG calm (≤ 24) | classic |
| ------ | -------------- | -------------- | ------- |
| noon   | 83             | 29             | 393     |
| night  | 86             | 104            | 126     |
| storm  | 65             | 48             | 398     |
| dusk   | 86             | 102            | 118     |

Still 1.2, coffee 4.5. Plan 2's ladder then ran one round (18 of 36 slots before the tool's 45-minute limit; n = 1), one group alone over still, total (WebContent): clouds 25.6 (0.3), smoke 16.8 (0.9), grass 15.0 (0.3), stars 31.1 (5.4), fireflies 29.0 (6.5), rain 30.2 (9.0), storm 31.8 (9.2), **skeins 72.3 (37.1)**, **daybirds 56.3 (25.6)**, **sun 52.3 (26.2)**; full noon 83, night 86, storm 76; calm noon 30.5, **calm night 105 (61.5)**; classic noon 390.

What it shows: any one moving group costs backboardd 15–25 with no page work at all, so full ≤ 30 has room for about one group. The page work is in three groups — the skeins and the daybirds (wing poses) and the sun (calm keeps the spin with the fire held and reads 0.3 WebContent, so the fire is the sun's cost) — and calm's two-pose skeins cost more than full's four. NG is below classic at every moment. Plan 4 (§10) answers it; plan 3 resumes at Task 5 after it.

**Android (Task 5 Step 4, 2026-10-17, rank-only).** The `seance-android` emulator (`-gpu auto`), Chrome, 2 rounds of the same 14 slots through `droid-plan3.sh`, 28 of 28 valid; sum = every Chrome process + surfaceflinger, % of one core, median of 2. No phone was tethered, and the user waived the quiet-host gate (load 3.8–13.5 here; the guest-swap gate was off too, a cold boot held 280–600 MB). A cold-booted emulator had no route to the host (10.0.2.2), so the pages load over `adb reverse`; the first attempt's slots, all error pages, are void.

| moment | NG full | NG calm | classic |
| ------ | ------- | ------- | ------- |
| noon   | **227** | 132     | 102     |
| night  | 111     | 89      | 165     |
| storm  | **217** | 173     | 197     |
| dusk   | 102     | 90      | 164     |

Coffee 2.4, NG still 2.2. Classic's noon readings were 151 and 53. Nearly all of NG's day cost is the emulator's GPU process (192–200 of 217–227), which draws in software and so pays for every repainted pixel: NG's day motion repaints more than classic's here. NG is cheaper at night and dusk (by a third) and dearer at noon and in a storm; Step 4's "NG full below classic at each moment" is not met on the emulator. Unmeasured on a real Android phone.

**Chrome (Task 5 Step 5, 2026-10-17).** Google Chrome headed, full-screen on the MacBook's built-in 120 Hz display (the window's own size, `HEADED=1` in `lib.mjs`), 5 rounds, every slot 5 of 5 valid and at 119.8–120 Hz by its `requestAnimationFrame` interval. Total = renderer + GPU process CPU, % of one core, median. The user waived the 2.5 load gate (load 6–14), so the figures rank rather than measure.

| moment | NG full | NG calm | classic |
| ------ | ------- | ------- | ------- |
| noon   | 42      | 40      | 78      |
| night  | 74      | 65      | 123     |
| storm  | 45      | 31      | 85      |
| dusk   | 78      | 64      | 121     |

Coffee 6.0, NG still 7.5. NG's full is 36–45 % below classic at every moment: Step 5 passes. Calm saves little at night and dusk (65 and 64 against 74 and 78), where the skeins are the cost (§10.6).

**Verdict.** NG is below classic on the iPhone (every moment, §8.3 above) and in Chrome; on the Android emulator it is below at night and dusk and above by day. No platform meets the §6 budgets at night or dusk. The user ruled to flip and delete regardless (2026-10-17); the skeins and calm's budget are the open work.

## 9. Plan 2: motion (designed 2026-10-16)

The user's picks in conversation, 2026-10-16: classic's own CSS animations, group by group (decision 2); one iPhone sitting at the end with a slot per group; the Android emulator on a quiet host in plan 2 (rank-only) and a real Android phone in plan 3; the new setting and its migration in plan 2, Auto meaning Full until plan 3. The inventory this design stands on is `tmp/ps-ng-plan2-inventory.md` (gitignored; every count and line from it).

### 9.1 How a group comes back

`NG_STILL_CSS` keeps `animation: none` for the whole scene. A class per group on `#theme-scene` (`psng-m-<group>`) lifts it for that group only, and the browser plays classic's keyframes natively — no stepper, no SMIL. Going still removes the classes: the measured `animation: none` (§8.1).

**Phase on resume.** Each group's animations take `animation-delay: calc(var(--d) - var(--psng-t))`, where `--d` is classic's own (negative, seeded) delay and `--psng-t` the seconds since local midnight of the day the scene mounted, less the time the scene has spent frozen (below), written at mount and once on each resume (never on the minute tick, so a running loop never jumps) — never per frame (§3 rule 3). A loop resumes where the clock, less its frozen time, puts it, not at its start.

**A rest freezes; a choice snaps.** A still that ends on its own — a hidden or unattended page, a query — freezes the scene where it stands: each running animation's `transform` and `opacity` are pinned inline, then `psng-frozen` on the root takes every animation away (`animation: none`, so nothing is left for Core Animation), the group classes stay so no layer leaves the page, and the time spent frozen comes off `--psng-t`, so on the way back each loop goes on from where it stood. Reduced motion, the setting at Still and the phone's open drawer drop the group classes instead, and the scene snaps to its still look. If WebKit mishandles a variable in `animation-delay`, NG writes each group's delays once on resume instead.

### 9.2 The groups

| Group                                                 | Classic today                                            | NG                                                                                                                                                                                         | Full | Calm                            |
| ----------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------- |
| clouds (5, +4 wet)                                    | CSS `ps-drift` in `cqw`                                  | classic's CSS                                                                                                                                                                              | runs | runs                            |
| stars (52 of 190 twinkle)                             | CSS `opacity`                                            | classic's CSS                                                                                                                                                                              | runs | still                           |
| fireflies (34; 17 on a phone)                         | CSS drift + blink                                        | classic's CSS                                                                                                                                                                              | runs | glowing, in place               |
| smoke (5 puffs)                                       | CSS                                                      | classic's CSS                                                                                                                                                                              | runs | runs                            |
| rain, snow, seeds (130 / 120 / 26; halved on a phone) | per-particle CSS; rain sheets 2.36 viewports tall on #98 | rain in `rain.ts` tiles no larger than the viewport; snow, seeds and lightning are classic's per-particle CSS (tiny boxes, already inside the viewport), tiles only if the sitting says so | runs | rain and snow run; seeds still  |
| lightning                                             | `opacity` flash                                          | classic's CSS                                                                                                                                                                              | runs | runs                            |
| grass sway                                            | SVG `<g>` transform                                      | one wrapper element carrying classic's keyframe                                                                                                                                            | runs | still                           |
| skeins (38 birds, 3 flocks)                           | CSS flight + 76 SMIL wing morphs                         | classic's flight CSS; wings as 3–4 poses swapped by `opacity` (`poses.ts`)                                                                                                                 | runs | flight runs; wings on two poses |
| buzzard, skylarks                                     | SMIL `animateMotion` + 6 wing morphs                     | the path as a CSS loop; the larks' wings as poses                                                                                                                                          | runs | still                           |
| sun                                                   | CSS ray spin + SMIL `baseFrequency` fire                 | the spin is classic's CSS; the fire is `flame.ts`, 24 fps                                                                                                                                  | runs | spin runs; fire still           |
| heat haze                                             | SVG displacement                                         | dropped (decision 4)                                                                                                                                                                       | —    | —                               |

The gates stand as in plan 1: a group runs only while `liveLayers` (`layers.ts`) has its layer on.

### 9.3 Tiers and the setting

Still runs no group. It is forced by reduced motion (`data-reduce-motion`), a hidden page, a page at rest (`createAttention`: 15 s unfocused or 2 minutes idle), a query, or the setting at Still. The setting and its migration are §6.

### 9.4 Testing

Mocha: `tiers.ts` as a truth table (setting × reduced motion × hidden × rest × query); the migration; `groups.ts` (tier, time, weather → groups); the `--psng-t` arithmetic; `rain.ts`'s tiles never larger than the viewport; `flame.ts`'s cache bounded. Browser (`ps-ng.mjs`): a census per tier (every running animation moves only `transform` or `opacity`, no animated element wider or taller than the viewport, no SMIL, calm's exact list, still with none); a resume keeps each loop's phase; side-by-side screenshots of classic and NG in motion for the user.

### 9.5 The phone sitting

One sitting, about 30 minutes, iPhone 16 Safari, through `tmp/perf/ng2` with a per-group query knob: `coffee`; still; each group alone over still; full; calm; classic as shipped — with night and rain slots for the groups that only exist there. Within budget: full ≤ 30, calm ≤ 24, still ≤ 3 (§6). A group over its share falls back on its own (decision 2) and is re-measured in a short second run. The Android emulator runs the same ladder on a quiet host, rank-only.

### 9.6 Risks

1. **Night as a whole** runs the most at once. If full at night is over 30, the fireflies become 4 shared sheets (§4), then the stars.
2. **The sun's fire canvas**: a canvas cost about 14 in the spike. If over its share, it becomes prerendered frames swapped by `opacity`, or stays still in Full too.
3. **A variable in `animation-delay`**: the fallback is in §9.1.
4. **Classic under the new setting**: Calm becomes classic's once-a-second stepping; nothing else in classic changes.

### 9.7 What landed (2026-10-16)

Built overnight from `ps-ng-plan-2.md`, one commit per task:

1. `ceab2f85` — the setting becomes **Auto / Full / Calm / Still** (`psAnimation` `auto|full|calm|still`, default `auto`), read on load and never rewritten in storage: a stored `60`/`24` reads as Auto, `1s`/`sparse` as Calm, `off` as Still, anything else as Auto. Classic: Auto and Full are its native rate, Calm its once-a-second stepping, Still off.
2. `21dd1d3c` — `tiers.ts` (`tierFor`: still for a hidden or unattended page, a query, reduced motion or the setting at Still; calm for Calm; full otherwise) and `groups.ts` (the nine groups, calm's five — clouds, smoke, weather, skeins, sun — and `thelounge.state.psngGroups`, a comma list that narrows them for the phone ladder; set but empty, nothing moves). `scene.ts` sets exactly the running groups' `psng-m-<group>` classes and `psng-calm`, writing `--psng-t` first on each move out of still.
3. `5f257abc` — clouds, stars, fireflies, smoke and the near grass move again as classic's own animations, each delay moved by `--psng-t`. The grass sways as one wrapper (`div.psng-sway`), so the flowers sway with the blades.
4. `45ddebd3`, `cd7c406d` — the weather: rain in `rain.ts`'s viewport-sized tiles (two per sheet, each falling its own height), the drops falling straight with classic's slant drawn into each as a skew; snow, seeds, the storm's flash and the heat band as classic's CSS; the seeds hidden in calm. The tiles' periods are [0.52, 0.62, 0.71] s so a one-viewport tile falls at classic's speed (ruling R5).
5. `df8cdcf7` — the birds: the skeins' flight, sway and wander as classic's CSS; every wingbeat a stack of pose copies swapped by `opacity` (`poses.ts`) over **one beat** — four poses in full (`psng-pose4`), up and down in calm (`psng-pose2`); the cranes flap continuously, their glide pause not reproduced (ruling R3). The buzzard flies a CSS loop on the circle fitted through classic's path. The larks' wing sets keep classic's `steps(1, end)` animations (ruling R4), their beat on `psng-pose2`.
6. `ebc684a3` — the sun: the rays' spin is classic's CSS; the fire is `flame.ts`, a canvas painted from a frame cache at 24 frames a second, its loop running only in full with the sun's group and gate on (calm keeps the one frame it painted, still requests none).
7. `741f6976` — the browser check in motion (`tools/scenarios/ps-ng.mjs`, its header lists every check): the full census at noon, 23:00, a storm day and a dusk (only `transform`/`opacity` keyframes, every animated box within the viewport, no SMIL, the moment's groups running, the fire's frames as a positive control); calm's exact set against full's at the same moment; the still census (no animation, no frame from NG's chunk, every in-flight layer computing `display: none`) under the setting, reduced motion toggled live off → on → off, a hidden page and a query; the phase after 30 s still, and again after reduced motion goes off (`--psng-t` the clock's seconds since the mount day's midnight ± 3 s, every cloud within 0.05 % of where it predicts, 2 % allowed); classic mounted clean after NG moved, and nothing of NG left when the theme goes to coffee while it moves; plan 1's checks kept. After the review's fix round: 80 of 80 on the desktop (1280 × 900), 77 of 77 on a phone (390 × 844) and 77 of 77 on a landscape phone (932 × 430), host load about 2.7.

Screenshots in motion, classic and NG side by side, desktop and phone, with a contact sheet per viewport: `tmp/ps-ng-shots/plan2/` (gitignored; `contact-desktop.png`, `contact-mobile.png`; the landscape phone in `landscape/`), at 21 June 12:00, 14 May 20:45, 21 June 23:30, 19 October 12:00 (rain) and 19 July 12:00 (storm). The brief's 21 June 20:45 has no skeins at all — the passage is spring and autumn (`birdsAt`) — so 14 May 20:45, the nearest clear day with skeins, 24 minutes after its sunset, stands in for the dusk.

For the user to judge in the pairs: the flowers swaying with the grass, the rain falling straight with its slant drawn in, the buzzard on a fitted circle, and the cranes flapping without their glide.

## 10. Plan 4: the birds and the sun (designed 2026-10-17)

The user's picks in conversation, 2026-10-17: fix the three groups the iPhone named (§8.3) rather than move the budgets; measure each suspect before building; success is **page work (WebContent) ≤ 5 for each of the skeins, daybirds and sun measured alone, calm ≤ 24 at every moment, and full below classic at every moment** — full ≤ 30 is reported against, not gated, since one moving group already costs 15–25 in backboardd.

### 10.1 What is suspected (read from the code, 2026-10-17; Codex reviewed)

- **Skeins**: 38 birds in 3 flocks, each bird 4 pose copies (`div.psng-pose`, each a whole `<svg>`), about 196 animations nested four transform levels deep (flock fly, sway, per-bird `ps-bird-wander`, per-pose `psng-pose4`). A flock past the night's count is already out of the render tree (`liveLayers` gates, `.ps-off`). The pose keyframes hold each copy at 1 or 0 with a 0.01 % edge, linear, not `steps()`, so they should stay on Core Animation; calm runs `psng-pose2` on copies 0 and 2 and sets copies 1 and 3 to `animation: none !important` while they stay in the page. Why that costs more than four swaps is not known: a change in which copies get their own layer is the first suspect, not the two-pose timing. The body's fill is a gradient (`url(#ps-b-belly)`) whose stops read CSS variables.
- **Daybirds**: the buzzard is HTML (drift, orbit, flap; no pose copies). The 3 larks have 2 pose copies each, and inside each copy's `<svg>` five `<g>` run `steps(1)` opacity animations — 30 animated SVG elements. WebKit's Core Animation path refuses `steps()` timing, so these run on the main thread wherever they sit.
- **Sun**: the fire is `flame.ts`'s canvas, 160 × 160, woken 24 times a second; every paint maps 25,600 pixels through a colour table in JavaScript and calls `putImageData`. The spinning rays (mask + blur) are not the cost (calm noon, §8.3).

### 10.2 The measurement sitting

Revised after the plan's review (2026-10-17): the two fixes that cost a few lines — the sprite fire and calm's two copies out of the page (§10.3 items 3 and 4) — are built first and measured as they ship, and a slot is kept only if its answer decides something. One group alone at its moment with the tier forced (`mo=full`, or `mo=calm` for `skeins-calm`), each switch against its group's baseline in the same sitting, the harness's 30 s settle before each 15 s reading, the page attended, the order rotated each round. 9 slots × 2 rounds ≈ 17 minutes, one background job, Auto-Lock off:

| slot                 | switch                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `coffee`, `ng-still` | the floor                                                                                    |
| `skeins` (dusk)      | baseline, three flocks                                                                       |
| `skeins-nowing`      | pose animations off (copy 0 shown): wingbeat and its layers gone                             |
| `skeins-constop`     | pose animations kept, every keyframe at the copy's resting opacity: the layers stay, no swap |
| `skeins-calm`        | calm's skeins as they ship (copies 1 and 3 out of the page)                                  |
| `daybirds` (noon)    | baseline                                                                                     |
| `daybirds-nolark`    | the larks' inner and outer animations off: what is left is the buzzard                       |
| `sun` (noon)         | the sprite fire as it ships                                                                  |

Cut from the first draft, with why: the larks' two half-switches (the lark fix is built whatever they say), the wander (each bird has its own delay, so folding it would change their paths), `pose2all` (calm's fix is measured directly), a held-fire slot (calm noon already reads 0.3 WebContent, §8.3) and the old fire (the target is absolute; §8.3 has it at 26.2). Every switch is CSS the harness injects and is checked in Chrome for the change it claims before the phone. WebContent CPU is the measure of page work; a result that does not fit gets a Safari Web Inspector timeline before a fix is built on it.

### 10.3 The fixes

Within each list the first fix that meets the target is taken; fixes from different lists combine.

1. **Skeins**, by what the sitting shows. If `constop` reads like the baseline, the layers cost: the four copies on fewer animated layers. If it reads like `nowing`, the swap costs: (a) the swap on a flatter tree, (b) a prerendered strip of the four poses per bird moved by `transform` with hard-edged linear keyframes (never `steps()`). The chosen fix's markup is designed and approved before it is built. `element.animate` is not a fix on its own: WebKit runs CSS and Web Animations on one engine. If the swap repaints, a solid-fill slot (the gradient's stops literal per hour) is read first.
2. **Larks**, built regardless. Each lark shows one of three states at a time over its long cycle (`ps-lark-fl` flapping, `-ch` chute, `-cl` closed), so it becomes 4 HTML copies — the 2 flapping poses (already copies), the chute and the closed pose — under 3 absolutely placed state boxes switched by linear opacity keyframes that hold each state from its stop to 0.01 % before the next (classic's `steps(1, end)` changes at the next stop; 6.6 ms early on a 66 s cycle): 5 animations per lark on HTML instead of 10 on SVG `<g>`, as the skeins' wings are. `steps()` stays off Core Animation wherever it sits, so placement and timing change together.
3. **Sun.** The fire draws each frame from a sprite canvas it fills once per colour change (one `putImageData` per frame per palette, then `drawImage` of its cell; about 17 MB), measured warm. If `sun` reads above 5 WebContent, the fire at 12 frames a second on top of the sprite, then without it. A video or animated image is the next fallback only if all of those fail, and needs its transparency, palette and stopping specified first. Calm keeps the fire held, as now.
4. **Calm's wingbeat.** Calm never shows copies 1 and 3, so they leave the render tree (`display: none`) instead of being held by `animation: none !important`; `skeins-calm` must then cost no more than full's skeins, or the change is reverted and reported.

Every fix keeps classic's poses, timings and paths (as NG already draws them). The one visible change allowed is the fire's lower rate, only if the sprite misses, and only with the user's OK on a side-by-side shot. A group no fix brings to its target stops the plan with a report before anything less like classic is tried.

### 10.4 The gate and the tests

The gate is plan 3's 14 slots (`coffee`, `ng-still`, `full`/`calm`/`classic` at noon, night, storm and dusk) plus `skeins`, `daybirds` and `sun` alone, 2 rounds, in two jobs of about 17 minutes. It passes on §10's success criteria. Mocha: the larks' state boxes and their keyframes free of `steps()`, `flame.ts`'s sprite emptied on a palette change and on destroy, calm's copies out of the page. `ps-ng.mjs` stays green at its three sizes and adds: no animation on an element inside an `<svg>` in the scene, each lark in the state its clock gives it across a freeze; classic/NG pairs at dusk and noon for the user. After plan 4 passes, plan 3 resumes at Task 5 (Android, then Chrome headed at 120 Hz) and Task 6.

### 10.5 The measurement sitting (2026-10-17)

iPhone 16, Safari, USB, rid `ios2-1792260636000`, `SHORT=plan4`, 9 slots × 2 rounds on the build at `21f1a8ec` (the sprite fire and calm's copies out of the page; the larks still on their SVG groups). % of one core, medians (n = 2 unless noted). The Mac's load ran 16–47 through it; slot 9 (`skeins-nowing`, round 2) lost its trace to xctrace ("timed out waiting for device to boot") and reads all zeros, so `skeins-nowing` is n = 1, and the two `daybirds-nolark` readings disagree (WebContent 20.4 with a 38 s recording window under load 34, and 0.4).

| slot              | sum  | WebContent | GPU  | backboardd |
| ----------------- | ---- | ---------- | ---- | ---------- |
| `coffee`          | 1.0  | 0.1        | 0.0  | 0.9        |
| `ng-still`        | 1.5  | 0.2        | 0.0  | 1.4        |
| `skeins` (dusk)   | 69.5 | 34.0       | 9.6  | 25.9       |
| `skeins-nowing`   | 31.4 | 9.9        | 0.2  | 21.3       |
| `skeins-constop`  | 91.6 | 59.7       | 0.8  | 31.2       |
| `skeins-calm`     | 98.6 | 57.2       | 12.9 | 28.5       |
| `daybirds` (noon) | 54.1 | 24.0       | 9.3  | 20.8       |
| `daybirds-nolark` | 26.5 | 10.4       | 0.6  | 15.5       |
| `sun` (noon)      | 49.4 | 4.6        | 22.1 | 22.7       |

What it shows:

- **Sun**: the sprite fire reads 4.6 WebContent (26.2 for the old fire, §8.3): under 5, so it stays at 24 frames a second; no 12-frame fire.
- **Skeins**: the reading fits neither of §10.3's branches. Holding every copy at its resting opacity on a constant keyframe (`constop`) costs far _more_ page work than the swap (59.7 against 34.0), and calm's two swapping copies with copies 1 and 3 out of the page cost as much (57.2): the cheapest skeins are the ones where all four copies run the same keyframes. With the poses off (`nowing`, n = 1) the page work is near 10 — the wander, sway and flight alone. Per §10.2 a reading that does not fit gets a Safari Web Inspector timeline of the `skeins` and `skeins-constop` slots before a fix is designed.
- **Calm**: `skeins-calm` is above `skeins`, so calm's copies-out change (§10.3 item 4) is reverted (`f31e2a2b`) and reported; calm's skeins stay over budget until the skeins' fix.
- **Daybirds**: the larks were most of the page work (24.0 with them, 10.4 or 0.4 without); the lark state boxes (`c72a15b4`) were built after this build and are measured at the gate.

### 10.6 The gate (2026-10-17, failed on calm and the skeins)

iPhone 16, Safari, USB, build `f0cbbc6a` (the sprite fire, the lark state boxes, the 80-beat wingbeats; calm's copies-out reverted), two jobs of 2 rounds, every slot n = 2: `gate4a` (noon, night, sun) and `gate4b` rid `ios2-1792266428000` (storm, dusk, skeins, daybirds). Sum of WebContent + GPU + backboardd as % of one core, medians, WebContent in brackets; §8.3's plan 3 gate beside it.

| moment | NG full (vs 30) | NG calm (≤ 24) | classic | plan 3: full / calm |
| ------ | --------------- | -------------- | ------- | ------------------- |
| noon   | 68.1 (6.7)      | 31.6 (0.3)     | 397.1   | 83 / 29             |
| night  | 88.5 (40.4)     | 60.3 (23.6)    | 117.4   | 86 / 104            |
| storm  | 77.2 (13.7)     | 43.4 (6.7)     | 395.3   | 65 / 48             |
| dusk   | 92.2 (40.8)     | 57.8 (21.6)    | 117.4   | 86 / 102            |

Alone, WebContent: skeins 28.4 (✗, ≤ 5), daybirds 0.9 (✓), sun 4.5 (✓). Still 1.1–1.3, coffee 0.8–0.9.

Against §10's criteria: **full below classic at every moment** — passes; **daybirds and sun ≤ 5** — pass; **skeins ≤ 5** — fails at 28.4 (the user's pick after §10.5's short job: stop the skeins there and go to the gate); **calm ≤ 24** — fails at every moment. Calm's page work fell (night 61.5 → 23.6, dusk → 21.6), but calm noon is 31.4 backboardd with 0.3 page work: one moving group's Core Animation cost already sits past 24 (§8.3), so calm ≤ 24 cannot be met by page work alone, and at night and dusk the skeins' page work is the rest. Plan 3 stays paused until the user decides what follows.

After the gate (the user's "2"), a diagnostic job on the skeins alone at dusk (rid `ios2-1792268123000`, n = 2, WebContent with the running animations): as built 29.0 (196), half the wings off 21.5 (124), the per-bird wander off 13.6 (158), the wings off 9.9 (44). Each wing copy costs about 0.1 and the 38 wanders about 0.4 each, more together than apart; with no wingbeat at all the skeins still read 9.9, so ≤ 5 would need the per-bird wander changed as well — a change to classic's look. The user's pick (option 4, 2026-10-17): stop plan 4 here with the skeins at about 29 and calm over 24, push what is built, and resume plan 3. A strip per bird, the wander dropped, or both remain open for a later plan.

## 11. Plan 5: calm in budget, cheaper skeins (designed 2026-10-17)

The user's picks after §8.3 and §10.6: calm moves **one group, the clouds**; the skeins' wings become **strips** and their per-bird wander gives way to **the skein's own sway**. Full keeps every other group as it is. Android by day (§8.3) is out of scope until there is a real Android phone to measure. Red-teamed by a ponytail review (2026-10-17; Codex skipped this round by the user): measure once at the gate, a smaller strip, and the places the change reaches.

### 11.1 Calm

Calm's page work is already small (0.3 at noon, §10.6); its cost is Core Animation's, 15–25 per moving group (§8.3), and calm moves four. So calm becomes the clouds alone: `psng/groups.ts`'s `CALM` is `["clouds"]`, and smoke, the weather, the sun's spin and the skeins stand at their still look in calm, as they do in the still tier. On a wet day that means no rain, snow or lightning in calm — calm shows two of the sky's clouds and none of the wet weather's, nothing falls (§11.4) (the user: "OK, clouds only"). The `psng-calm` class stays: the Auto checks read it as the tier's marker.

If the clouds alone read over 24 at the gate (§8.3's ladder read 25.6, n = 1), calm gets fewer clouds; the drift's speed is not a lever, since the cost is per composited frame.

### 11.2 The skeins

> **Superseded by §11.4:** the wing strips below were built, measured and reverted; the skeins keep the pose stacks and lose only the wander.

The skeins alone cost 29 WebContent (§10.6): about 19 is the wings (38 birds × 4 pose copies swapped by `opacity`, about 150 animations) and about 15 the 38 per-bird wanders (`ps-bird-wander`), more together than apart; without the wander they read 13.6 (§10.6).

- **Wing strips.** `poseStack`'s four pose boxes stay as they are (`--pi` on each), laid side by side in one wrapper inside a clip box one pose wide (`left: calc(var(--pi) * 100%)`), and one `translateX` loop on the wrapper steps through them with discrete holds in its keyframes — never `steps()`, which WebKit runs on the main thread (§2) — over `POSE_BEATS` beats per iteration as the pose loop does, each bird keeping its own delay so the birds flap out of step. The animation stays outside the `<svg>` (the census forbids motion inside one). 38 animations in place of about 150. Two poses are not a cheaper lever: calm's two-copy skeins read 57.2 against the four's 34.0 (§10.5). The cranes still never glide (§9).
- **No per-bird wander.** `ps-bird-wander`'s animation and keyframes and NG's rules for it go; the birds hold their places in the V and `ps-skein-sway` is the skein's motion besides its flight. `birds.ts` keeps drawing `--wx`/`--wy`/`--wd`/`--wdl` from its seeded stream (dead values; dropping the draws would reshape every V).

The strip ships behind a harness switch (`x=strip`, plan 4's `x=` table) so the gate compares it with the pose stack in one build; if it does not beat the stack, the stack stays and only the wander's removal ships.

### 11.3 The gate and the tests

- iPhone, one job of 2 rounds (5 slots, about 25 minutes): calm noon and calm storm (**≤ 24, gated**; night and dusk move the same clouds as noon, storm adds the wet weather's four), the skeins alone with the pose stack and with `x=strip` (≤ 5 WebContent, reported), and full at dusk (below §10.6's 92.2, reported).
- Mocha: the strip's wrapper (`test/scenes/psng/poses.ts`), calm's group set (`test/scenes/psng/groups.ts`), the wander's rules gone (`test/scenes/psng/styles.ts`, `test/scenes/ps/birds.ts` keeps its pinned values).
- `tools/scenarios/ps-ng.mjs`: `CALM_GROUPS`, the strip's keyframe name in the known list, the dead calm pose and seed mapping out, the wander's checks out, its header.
- Words: the Scene animation setting's Calm description (`Settings/Appearance.vue`), §6's calm row, the CLAUDE.md ps NG bullet.

### 11.4 The gate (2026-10-18: failed on the strips, then passed without them)

iPhone 16, Safari, USB, rid `ios2-1792334245000`, `SHORT=gate5`, build `65bf63c7` (calm = the clouds, no wander, the strips), 2 rounds, every slot n = 2, host load 5–16 (waived). Sum of WebContent + GPU + backboardd as % of one core, both readings per slot (WebContent in brackets); §10.6 beside it.

| slot                        | readings           | §10.6       |
| --------------------------- | ------------------ | ----------- |
| calm noon (≤ 24)            | 30.3, 27.8 (0.3)   | 31.6        |
| calm storm (≤ 24)           | 36.2, 36.0 (0.2)   | 43.4        |
| skeins alone, strips        | 64.9, 69.3 (42–44) | 69.5 (34.0) |
| skeins alone, opacity stack | 75.6, 68.1 (41–43) | —           |
| full dusk                   | 144.1, 143.6 (106) | 92.2 (40.8) |

Still 1.1–2.5, coffee 1.0–1.9.

- **Calm fails ≤ 24.** The clouds alone cost 28–30 at noon, all of it backboardd (WebContent 0.3), and 36 in a storm; one moving group already sits past the budget (§8.3, §10.6). Taking the other three groups out lowered calm by only 2–7. The spec's fallback is fewer clouds in calm: the user's call.
- **The strip does not beat the stack.** 42–44 WebContent against 41–43 with the opacity stack back (`x=stack`, no wander either), so 38 animations instead of 152 bought nothing, and per §11.2 only the wander's removal was to ship.
- **Both are worse than before, which the change should not do.** The skeins alone read 42 WebContent with the wander gone, against 28.4 in §10.6 with it; full dusk reads 106 WebContent against 40.8. Something in this build costs the page about 60 points at dusk. The suspect is `#theme-scene.psng .ps-bird { overflow: clip visible }`, which both variants carry on 38 birds; unmeasured.

**Resolved (2026-10-18, same day).** The regression is `65bf63c7`, the strips. iPhone, `SHORT=base`/`clip`, load 5–16, n = 2: skeins alone WebContent 29.4 at `826f8736`, **14.6 at `9c90547d`** (the birds hold their places, no strips), 43.3 at `65bf63c7`; full dusk 91.7 (WebContent 41.4), **84.2 (36.0)**, 142.8 (106.2). `overflow: clip visible` is not the cause (`x=noclip`: skeins 47.6, dusk 106.3), and the opacity stack on the strip markup stays at 42, so the `.psng-strip` wrapper and its placed pose boxes cost it. The strips are reverted; the poses are the stacks of plan 2 again, without the wander. Gate rerun on the reverted tree (`b3ec7320`, rid `ios2-1792344702000`, n = 2, `SHORT=g5b`): calm noon 31.3 (WebContent 0.3), calm storm 34.2 (0.3) — still over 24, all backboardd, the clouds' cost; skeins alone 40.3 (13.9); full dusk 84.6 (36.5). Calm now shows two of the sky's five clouds and none of the wet weather's (`styles.ts`, the user's pick of the fewer-clouds fallback): calm noon 19.3, calm storm 20.4, both ≤ 24 (rid `ios2-1792346007000`; skeins alone 39.4 (15.1), full dusk 83.8 (35.2)). **The gate passes.**

### 11.5 The phone sitting before merge (2026-10-18)

§9.5's ladder on PR #116's head (`6c91f198`: §11.4's tree plus the review fixes — the shells' plugin paths and a thaw that keeps a star's own opacity), iPhone 16, Safari, USB, rid `ios2-1792355935000`, 19 slots × 2 rounds rotated, 38 of 38 valid; % of one core, median (WebContent). Classic cannot run: this build deletes it (§10.6 has it at 397 noon, 117 dusk). The host's load ran 7–42 through it (a macOS Contacts sync and ReportCrash, not ours); the phone's readings agree within 2 points per slot except `calm-storm` (19.1, 31.5), re-run in a short second job (rid `ios2-1792358107000`, 3 rounds): 19.4, 19.5, 20.1.

| slot           | sum        |     | slot                | sum         |
| -------------- | ---------- | --- | ------------------- | ----------- |
| coffee         | 0.9 (0.1)  |     | sun (noon)          | 47.6 (4.6)  |
| still          | 0.3 (0.1)  |     | full noon           | 61.8 (6.3)  |
| clouds         | 26.0 (0.3) |     | full night          | 82.3 (36.2) |
| stars          | 30.6 (5.4) |     | full storm          | 77.1 (14.1) |
| fireflies      | 27.0 (6.2) |     | full dusk           | 83.8 (36.8) |
| smoke          | 15.9 (0.9) |     | calm noon           | 19.1 (0.2)  |
| grass          | 13.6 (0.3) |     | calm night          | 20.4 (0.2)  |
| weather, rain  | 30.6 (9.3) |     | calm storm (re-run) | 19.5 (0.2)  |
| weather, storm | 29.3 (9.1) |     | skeins alone (dusk) | 39.4 (14.5) |
| daybirds       | 15.1 (1.0) |     |                     |             |

- **Still ≤ 3 and calm ≤ 24 pass**, at noon, night and in a storm.
- **No regression from §11.4**: skeins alone 39.4 and full dusk 83.8 again, calm noon 19.1 against 19.3.
- **Full ≤ 30 fails at every moment**, as since §10.6; full is at or below §10.6 everywhere (noon 68.1 → 61.8, night 88.5 → 82.3, storm 77.2 → 77.1, dusk 92.2 → 83.8) and far below classic.
- Each moving group alone costs 14–31, mostly backboardd; the page work is the skeins (14.5), the rain (9.3), the fireflies (6.2) and the stars (5.4). The sun's fire is the one GPU cost (21.5).
