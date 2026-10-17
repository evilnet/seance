# ps NG — the ps scene, rebuilt to be cheap

Status: **plan 1 (the still scene) built 2026-10-16** on branch `feat/ps-ng`, behind a preview flag: NG draws classic's scene markup with nothing moving, and costs what the coffee theme costs on the iPhone (§8.1). **Plan 2 (motion) built 2026-10-16** (§9, what landed in §9.7): classic's own CSS animations run again group by group, by tier, in phase, with the browser check green on the desktop and a phone; its iPhone sitting (§9.5) is still to do. The design below was approved 2026-10-16; spike 2 (`ps-ng-plan-1.md` § What spike 2 decided) replaced its backdrop and its glass, and the sections say where.

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
- the yurt's move to a new place: `ps-yurt-moving` hides it at once (no fade-out) and it reappears in its new place about 0.4 s later (ps.css, `watchers.ts` `placeYurt`), a short gap rather than a clean cut;
- no heat haze on a hot day (decision 4).

## 5. Glass

**The glass is classic's live `backdrop-filter`, unchanged.** NG's stylesheet touches none of the glass (`#sidebar`, `#chat .header`, `#chat .userlist`, `#form`, the reaction chips), and the browser check holds `#sidebar`'s computed `backdrop-filter` equal under both renderers. Over a still scene a live blur costs nothing: WebKit re-blurs only when the backdrop changes (§2).

Spike 2 (2026-10-16, `ps-ng-plan-1.md` § What spike 2 decided; Chrome desktop and iPhone 16 Safari, sum % of one core) tried the alternatives against live blur over motion (G0: Chrome 7.2, iPhone +3 over still; in spike 2's short iPhone run, drawer open, 2026-10-16 (`tmp/perf/ng2/ios-short.md`), G0 34.3 against still's 30.9):

- **G1**, the pre-blurred backdrop copy this section first described, was not measured on its own; G3 is its cheapest form, and it failed.
- **G2**, live blur with the motion masked out of the glass: Chrome 9.1, dearer than G0, with hard edges. Out.
- **G3**, a frosted twin of the scene behind tint-only panels: Chrome 6.3, iPhone **408** (WebKit's GPU process 390). Out.

`#status-bar-tint` never carries a filter (CLAUDE.md, "The iOS status bar").

## 6. Tiers

| Tier  | Moves                                                                                                                                                     | iPhone budget |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| full  | everything in §4                                                                                                                                          | ≤ 30          |
| calm  | clouds, weather (rain, snow, lightning), smoke, skeins with wings on two poses; still: stars, fireflies (glowing, in place), seeds, larks, buzzard, grass | ≤ 24          |
| still | nothing: no animation object exists (plan 2: `animation: none`, and each loop resumes at its phase through `--psng-t`, §9)                                | ≤ 3           |

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

### 8.3 Plan 3 Task 5: the iPhone gate (2026-10-17, over budget)

iPhone 16, Safari, USB, sum of WebContent + GPU + backboardd as % of one core, medians. The gate (14 slots, 2 rounds; round 2 lost slots 19–27 to a locked screen, so those are n = 1):

| moment | NG full (≤ 30) | NG calm (≤ 24) | classic |
| ------ | -------------- | -------------- | ------- |
| noon   | 83             | 29             | 393     |
| night  | 86             | 104            | 126     |
| storm  | 65             | 48             | 398     |
| dusk   | 86             | 102            | 118     |

Still 1.2, coffee 4.5. Plan 2's ladder then ran one round (18 of 36 slots before the tool's 45-minute limit; n = 1), one group alone over still, total (WebContent): clouds 25.6 (0.3), smoke 16.8 (0.9), grass 15.0 (0.3), stars 31.1 (5.4), fireflies 29.0 (6.5), rain 30.2 (9.0), storm 31.8 (9.2), **skeins 72.3 (37.1)**, **daybirds 56.3 (25.6)**, **sun 52.3 (26.2)**; full noon 83, night 86, storm 76; calm noon 30.5, **calm night 105 (61.5)**; classic noon 390.

What it shows: any one moving group costs backboardd 15–25 with no page work at all, so full ≤ 30 has room for about one group. The page work is in three groups — the skeins and the daybirds (wing poses) and the sun (calm keeps the spin with the fire held and reads 0.3 WebContent, so the fire is the sun's cost) — and calm's two-pose skeins cost more than full's four. NG is below classic at every moment. Plan 4 (§10) answers it; plan 3 resumes at Task 5 after it.

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

### 10.1 What is suspected (read from the code, 2026-10-17)

- **Skeins**: 38 birds in 3 flocks, each bird 4 pose copies (`div.psng-pose`, each a whole `<svg>`), about 196 animations nested four transform levels deep (flock fly, sway, per-bird `ps-bird-wander`, per-pose `psng-pose4`). A flock beyond `--ps-skein-count`, and the whole layer at `--ps-skeins-op` 0, is hidden only by opacity and keeps animating.
- **Daybirds**: the buzzard is HTML (drift, orbit, flap; no pose copies). The 3 larks have 2 pose copies each, and inside each copy's `<svg>` five `<g>` run `steps(1)` opacity animations — 30 animated SVG elements, which WebKit repaints on the main thread.
- **Sun**: the fire is `flame.ts`'s canvas, 160 × 160, woken 24 times a second; every paint maps 25,600 pixels through a colour table in JavaScript and calls `putImageData`. The spinning rays (mask + blur) are not the cost (calm noon, §8.3).

### 10.2 The measurement sitting

One group alone at its moment, each switch against its group's baseline in the same sitting; 13 slots × 2 rounds ≈ 25 minutes, run as two background jobs of about 13 minutes (the tool's 45-minute limit), Auto-Lock off:

| slot                            | switch                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `coffee`, `ng-still`            | the floor                                                                                 |
| `skeins` (dusk, three flocks)   | baseline                                                                                  |
| `skeins-nowing`                 | pose animations off                                                                       |
| `skeins-nowander`               | `ps-bird-wander` off                                                                      |
| `skeins-calm`                   | calm's two-pose wingbeat, the skeins alone                                                |
| `skeins-1flock`, `-1flock-hide` | 2026-05-14 20:45 (one flock showing): the hidden flocks as they are, then `display: none` |
| `daybirds` (noon)               | baseline                                                                                  |
| `daybirds-nolarkg`              | the larks' inner `<g>` animations off                                                     |
| `daybirds-nobuzz`               | the buzzard off                                                                           |
| `sun`, `sun-bitmap`             | today's fire; a prototype fire drawn from cached images with `drawImage`                  |

Every switch is CSS the harness injects, except `sun-bitmap`: a prototype path in `flame.ts` behind a `localStorage` flag, removed or made real in §10.3.

### 10.3 The fixes

The first fix in each list that meets the target is taken; two are never kept.

1. **Skeins.** A hidden flock (beyond the count, or the layer at opacity 0) leaves the render tree — always, since it is waste. Then, by what the sitting shows: if the wander is the cost, it folds into the flock's sway (3 animations, not 38); if the wingbeat is, (a) the pose swap with fewer nested animated layers, (b) the swap by `element.animate`, `cancel()` on still and never `pause()`, (c) a prerendered strip of the four poses per bird, one element moved through it.
2. **Larks.** The inner `<g>` animations move up to HTML pose copies swapped by `opacity`, as the skeins' wings are.
3. **Sun.** The fire from cached images if `sun-bitmap` reads ≤ 5 WebContent; otherwise the fire at 12 frames a second, measured again. Calm keeps the fire held, as now.
4. **Calm's wingbeat** takes whatever the skeins end with, on two poses; `skeins-calm` must then cost no more than full's skeins.

Every fix keeps classic's poses, timings and paths. The one visible change allowed is the fire's lower rate, only if the bitmap fails, and only with the user's OK on a side-by-side shot. A group no fix brings to its target stops the plan with a report before anything less like classic is tried.

### 10.4 The gate and the tests

The gate is plan 3's 14 slots (`coffee`, `ng-still`, `full`/`calm`/`classic` at noon, night, storm and dusk) plus each fixed group alone, 2 rounds, split into jobs under 45 minutes. It passes on §10's success criteria. Mocha: the hidden-flock rule, the larks' pose markup, `flame.ts`'s image cache bounded and dropped on unmount. `ps-ng.mjs` stays green at its three sizes and adds: no animation on an element inside an `<svg>` in the scene, no hidden flock animating; classic/NG pairs at dusk and noon for the user. After plan 4 passes, plan 3 resumes at Task 5 (Android, then Chrome headed at 120 Hz) and Task 6.
