# ps NG — Plan 2: motion, classic's own animations group by group

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NG's scene moves again — classic's own CSS animations played natively, one group at a time, with only classic's SMIL replaced — under a new Auto / Full / Calm / Still setting, and one iPhone sitting at the end says what each group costs.

**Architecture:** `NG_STILL_CSS` keeps every animation off; a class per motion group on `#theme-scene` (`psng-m-<group>`) lifts it for that group, and each group's delays become `calc(<classic's delay> - var(--psng-t))` so a loop resumes where the clock puts it. `tiers.ts` decides full / calm / still from the host state and the setting; `groups.ts` decides which groups run. Only the SMIL parts get new code: wing poses, the buzzard's loop, the sun's fire (`flame.ts`, ported from `feat/ps-perf-band`). NG builds classic's weather layer (minus the heat haze), with rain as viewport-sized tiles.

**Tech Stack:** TypeScript (strict), Vue 3 (the setting's radios), constructed stylesheets, canvas 2D (the fire only), mocha + chai + sinon, `tools/browser-drive.mjs` scenarios, the phone harness in `tmp/perf/ng2/` (gitignored).

**Spec:** `docs/projects/ps-ng.md` — §9 is this plan's design (approved 2026-10-16); §3, §6 and decision 2 carry its consequences. Facts with file:line: `tmp/ps-ng-plan2-inventory.md` (gitignored, read it for any classic detail; the line numbers are from `9ee919e2`).

## Global Constraints

- Only `transform` and `opacity` animate in NG (spec §3 rule 1); the census in Task 7 holds it. The fire's canvas repaint is the one exception, and it is a canvas, not an animation.
- No moving layer larger than the viewport (rule 2). No SMIL, no stepper, no per-frame writes to `currentTime` or CSS variables (rule 3); `--psng-t` is written once per resume, never per frame.
- Still means no running animation at all: `animation: none` for CSS, `cancel()` for anything made with `element.animate`, the fire's frame loop stopped. Never `pause()` (spec §8.1: 19.1 against 1.1).
- NG never imports `scenes/ps/scene.ts` or `scenes/ps/stepper.ts`; it never sets `ps-hot` and never builds the heat haze (decision 4).
- NG never touches the glass (no rule on `backdrop-filter`, `background` or tints of `#sidebar`, `#chat .header`, `#chat .userlist`, `#form`, the reaction chips) and publishes exactly what classic publishes.
- Reduced motion is read from `systemAccessibility()` / `onSystemAccessibility` and `data-reduce-motion`, never a new `@media` query. Sizes in `rem`. No Node built-ins in `client/`.
- The setting's values are `auto | full | calm | still`; read on load, not rewritten in storage (a restored old backup works the same way): a stored `60`/`24` reads as `auto`, `1s`/`sparse` as `calm`, `off` as `still`, anything else as `auto`. Classic: auto and full = its native rate (`{kind: "native"}`), calm = `1s` stepping, still = off.
- `--psng-t` is the seconds since local midnight of the day the scene mounted (a fixed reference: small enough for WebKit's time precision even days later). It is written at mount and on each move from still to a moving tier — never on the minute tick, so a running loop never jumps — and always before the group classes, in the same flush.
- Worktree setup: `ln -s ../../node_modules node_modules` in `tmp/psng` before building or testing; remove it before each commit (it is not ignored). Build `NODE_ENV=production npx webpack`; type-check `npx tsc --noEmit -p client/tsconfig.json`; lint `npx eslint`, `npx prettier --check`, `npx stylelint` on changed files. Mocha: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml <files>`.
- Phone runs: the user's rules — one sitting, duration stated first, `devicectl … lockState` before each `xctrace`, summarise only through `node summarize.mjs ios ios-2.jsonl <rid>`, start `serve.py` with `nohup … & disown` (a server started from an agent's shell dies with it). Chrome and the emulator: load gate; above 2.5 the result is "rank-only".
- Commits carry no AI-credit trailers. Prettier before every commit. Push to `origin feat/ps-ng`.

## Review Focus

1. **Coming back after a long time hidden** — a cloud or skein is where the clock puts it, not at its loop's start and not frozen where it stopped. Test in Task 3 (`--psng-t` written on resume) and Task 7 (positions against the clock).
2. **Reduced motion switched on while the scene runs** — every group stops at once, nothing in flight stays on screen, and switching it off resumes in phase. Test in Task 2 (tier) and Task 7 (census).
3. **Theme switched away, or renderer back to classic, while NG moves** — the fire's frame loop, every group class, `--psng-t` and any `element.animate` animation are gone; classic mounts clean. Test in Task 6 (fire stopped on destroy) and Task 7.
4. **Midnight with the page open on a rainy → clear day** — the weather layer (rain tiles, flash, seeds) is rebuilt for the new day without a frame of the old weather's motion. Test in Task 4.
5. **A phone layout** — the halved counts (fireflies 17, rain/snow/seeds halved) hold, and no animated element is wider or taller than the viewport in landscape. Test in Task 4 (tile sizes against a landscape viewport) and Task 7 (`--mobile` census).

---

### Task 1: The setting becomes Auto / Full / Calm / Still

**Files:**

- Modify: `client/js/themeScene.ts:15-26` (`SceneMotion`, `SCENE_MOTIONS`, `normalizeSceneMotion`), `client/js/settings.ts:244-251` (`psAnimation` default and comment), `client/js/scenes/ps/stepper.ts:40-53` (`stepModeFor`), `client/js/scenes/ps/scene.ts:227` (`!== "off"`), `client/components/Settings/Appearance.vue:583-596` (labels and hints)
- Test: `test/tests/themeScene.ts`, `test/scenes/ps/stepper.ts`

**Interfaces:**

- Produces: `export type SceneMotion = "auto" | "full" | "calm" | "still"`; `SCENE_MOTIONS = ["auto", "full", "calm", "still"]`; `normalizeSceneMotion(value: unknown): SceneMotion` (legacy map as in Global Constraints; default `"auto"`); `stepModeFor("auto" | "full") → {kind: "native"}`, `("calm") → {kind: "step", interval: 1000, catchUp: false}`, `("still") → null`. The host's initial state (`themeScene.ts:269`) and `settings.ts` default become `"auto"`.

- [ ] **Step 1: Write the failing tests** — `normalizeSceneMotion`: `"60"`, `"24"` → `"auto"`; `"1s"`, `"sparse"` → `"calm"`; `"off"` → `"still"`; `"full"` → `"full"`; `undefined`, `"bogus"` → `"auto"`. `stepModeFor`: the four values as above. The settings default: source-text check that `psAnimation`'s `default:` in `client/js/settings.ts` is `"auto"`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement**; Appearance labels: Auto "follows your device; for now the same as Full", Full "everything moves, at your screen's rate", Calm "clouds, weather, smoke and the birds' flight; the rest holds still", Still "a still picture; the sky still follows the time of day". The radios stay radios (no `v-switch`).
- [ ] **Step 4: Run the ps suites and `test/tests/themeScene.ts`; `tsc`** — Expected: PASS, no errors.
- [ ] **Step 5: Commit** — `ps: Scene animation becomes Auto, Full, Calm or Still`

---

### Task 2: Tiers and groups

**Files:**

- Create: `client/js/scenes/psng/tiers.ts`, `client/js/scenes/psng/groups.ts`
- Modify: `client/js/scenes/psng/scene.ts` (read the tier, toggle the group classes)
- Test: `test/scenes/psng/tiers.ts`, `test/scenes/psng/groups.ts`, `test/scenes/psng/mount.ts`

**Interfaces:**

- Consumes: `SceneHostState`, `SceneMotion` (Task 1); `Gate`, `GATES`, `liveLayers` (`scenes/ps/layers.ts`).
- Produces:

  - `export type Tier = "full" | "calm" | "still"`; `tierFor(state: SceneHostState, reduceMotion: boolean): Tier` — still when `!visible`, `!attended`, `view === "query"`, `reduceMotion`, or `motion === "still"`; calm when `motion === "calm"`; else full.
  - `export type Group = "clouds" | "stars" | "fireflies" | "smoke" | "grass" | "weather" | "skeins" | "daybirds" | "sun"`; `GROUPS: readonly Group[]`.
  - `groupsFor(tier: Tier, only?: ReadonlySet<Group>): Set<Group>` — full: all; calm: `clouds, smoke, weather, skeins, sun`; still: none; intersected with `only` when given.
  - `groupOverride(storage: {get(key: string): string | null}): Set<Group> | undefined` — reads `thelounge.state.psngGroups` (comma-separated group names, unknown names ignored; absent → `undefined`). For the phone ladder only; documented in Task 7's CLAUDE.md line.
  - In `scene.ts`: on every `update` and on reduced motion changing (`onSystemAccessibility`), compute the tier and set exactly the classes `psng-m-<group>` for `groupsFor(tier, override)` plus `psng-calm` when the tier is calm; on destroy remove them all.

- [ ] **Step 1: Write the failing tests** — `tierFor` as a truth table over visible × attended × view × reduceMotion × motion (32+ rows generated in the test, each asserting the rule above); `groupsFor` for each tier, and with `only = {"clouds"}` → `{"clouds"}` in full and in calm, `{}` in still; `groupOverride` for `"clouds,stars"`, `"clouds,nope"`, `null`; on the stand-in: mount visible full → every `psng-m-*` class present; `update({…, attended: false})` → none; reduced motion on through the stand-in's `matchMedia`/`systemAccessibility` hook → none; `motion: "calm"` → calm's five plus `psng-calm`; destroy → none.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `'test/scenes/**/\*.ts' test/tests/themeScene.ts`\*\* — Expected: PASS; plan 1's "gates without fades" still counts one pending timer.
- [ ] **Step 5: Commit** — `ps NG: tiers and motion groups`

---

### Task 3: The CSS groups and phase on resume

**Files:**

- Modify: `client/js/scenes/psng/styles.ts`, `client/js/scenes/psng/scene.ts`
- Test: `test/scenes/psng/styles.ts`, `test/scenes/psng/mount.ts`

**Interfaces:**

- Consumes: the group classes (Task 2).
- Produces:

  - `NG_STILL_CSS` restructured: `#theme-scene.psng *` keeps `transition: none !important`; `animation: none !important` applies to each group's selectors only while its class is absent (`#theme-scene.psng:not(.psng-m-clouds) .ps-cloud { animation: none !important }` and so on), and the in-flight layers' `display: none` likewise per group. The cloud rest transform stays for when clouds are still.
  - Per group, while its class is present, `animation-delay` rewritten from classic's own variables: clouds `calc(var(--cdl) - var(--psng-t))`; stars `calc(0s - var(--psng-t))`; fireflies `calc(var(--dl) - var(--psng-t)), calc(var(--bl) - var(--psng-t))`; smoke `calc(var(--sdl) - var(--psng-t))`; grass (the wrapper, below) `calc(0s - var(--psng-t))`. Classic's durations, keyframes and `ps-windy` rules stay as they are.
  - Calm under `psng-calm`: the seeds keep `animation: none` (calm runs the weather group, but not its seeds); fireflies are not in calm's groups, so they glow in place by plan 1's rules.
  - The grass: `scene.ts` wraps the `svg.ps-blades` in a `div.psng-sway` once at mount; the sheet moves classic's `ps-sway` animation from `g.ps-sway` to the wrapper (`transform-origin: 50% 100%`, `animation: ps-sway 7s ease-in-out infinite alternate`, `2.4s` under `.ps-windy`) and keeps it off the `<g>`.
  - `writePhase(root: HTMLElement, now: Date): void` in `scene.ts` — sets `--psng-t` to `secondsSinceMidnight(now)` + `"s"`; called at mount and on every move from still to a moving tier, before the group classes are set. `phaseSeconds(now: Date, reference: Date): number` exported from `tiers.ts` (DOM-free): seconds from local midnight of `reference` to `now`.

- [ ] **Step 1: Write the failing tests** — `test/scenes/psng/styles.ts` on the sheet text: for each of `clouds, stars, fireflies, smoke, grass` there is a `:not(.psng-m-<group>)` rule with `animation: none` and a `.psng-m-<group>` rule whose `animation-delay` contains `var(--psng-t)`; no rule names `backdrop-filter`, `#sidebar`, `#form`, `.header`, `.userlist`; no `@media`. `phaseSeconds(new Date(2026, 5, 21, 0, 1, 30), new Date(2026, 5, 21, 9)) === 90`; `phaseSeconds(new Date(2026, 5, 22, 0, 0, 10), new Date(2026, 5, 21, 9)) === 86410`. On the stand-in: mount writes `--psng-t` before any `psng-m-*` class; still → full writes it once; full → full writes nothing; the minute ticks across midnight while full write nothing. Plan 1's sheet-text test (`test/scenes/psng/mount.ts`, the `NG_STILL_CSS` check) changes with the restructured sheet — update it to the new per-group rules; Task 8's `still` slot is what re-validates plan 1's 1.1 on the phone.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the scene suites; build; in Chrome (worktree build, `psRenderer: "ng"`, preview flag) check at noon that the clouds drift and nothing else moves when `thelounge.state.psngGroups = "clouds"`, and that `getAnimations({subtree: true})` on `#theme-scene` lists only `ps-drift` animations** — Expected: PASS; only `ps-drift`.
- [ ] **Step 5: Commit** — `ps NG: clouds, stars, fireflies, smoke and grass move again, in phase`

---

### Task 4: The weather layer

**Files:**

- Create: `client/js/scenes/psng/rain.ts`
- Modify: `client/js/scenes/psng/scene.ts`, `client/js/scenes/psng/styles.ts`
- Test: `test/scenes/psng/rain.ts`, `test/scenes/psng/mount.ts`

**Interfaces:**

- Consumes: `weatherLayers(weather, phone)` and `rain(count)` from `scenes/ps/plains.ts` (read their output; the heat haze string `HEAT_HAZE` is never inserted); the group class `psng-m-weather`.
- Produces:

  - In `scene.ts`: on a weather change (where plan 1 rebuilds the overcast) fill `.ps-weather` with `weatherLayers(m.weather, isPhoneLayout())` minus the haze, then strip SMIL from it as at mount; rain is replaced by `rainTiles(count, viewport)`'s markup.
  - `rainTiles(count: number, viewport: {width: number; height: number}): string` in `rain.ts` (DOM-free) — the same drops `rain(count)` draws (rng 1301, same order), split over 3 sheets by speed; each sheet is two tiles of exactly one viewport height, **each tile its own animated element** (one box holding both would be two viewports tall — perf-band's mistake), looping by `translateY` over one tile height. `export const RAIN_TILE_SECONDS = [0.61, 0.73, 0.84]` (perf-band's sheet speeds).
  - Snow, seeds, the flash and the heat band keep classic's per-particle markup and keyframes, under `psng-m-weather` with their delays shifted by `--psng-t` (`--fdl`, `--sdl`; the flash and the band have none).

- [ ] **Step 1: Write the failing tests** — `rainTiles(130, {width: 1512, height: 900})`: 130 drops in total, 3 sheets, every animated element's width and height `≤` the viewport's (rule 2 is about size, not position: a tile mid-flight is partly off-screen), the drops' horizontal positions equal `rain(130)`'s (parse both); the phone's `rainTiles(65, {width: 932, height: 430})` (landscape) holds the same bounds. On the stand-in: a rain day mounts `.ps-weather` content with no `ps-heat` filter text and no SMIL; at local midnight into a clear day the rain markup is gone in the same tick.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the scene suites; in Chrome with `psngGroups = "weather"` on 2026-10-19 12:00 (rain) and a storm day, check every animated element's width and height are at most the viewport's** — Expected: PASS.
- [ ] **Step 5: Commit** — `ps NG: the weather moves — rain in viewport tiles, snow, seeds and lightning as classic's`

---

### Task 5: Wing poses and the buzzard's loop

**Files:**

- Create: `client/js/scenes/psng/poses.ts`
- Modify: `client/js/scenes/psng/scene.ts`, `client/js/scenes/psng/styles.ts`
- Test: `test/scenes/psng/poses.ts`, `test/scenes/psng/mount.ts`

**Interfaces:**

- Consumes: the skein and day-bird markup classic's `sceneMarkup` already inserts (`birds.ts` `bird()`, `lark()`, `buzzard()`); groups `skeins`, `daybirds`.
- Produces:

  - `wingTiming(svgMarkup: string): {dur: number; begin: number} | null` (DOM-free) — reads one bird's or lark's wing `<animate attributeName="d">` `dur` and `begin` (seconds) before the SMIL is stripped.
  - `poseStack(svgMarkup: string, poses: readonly string[]): string` (DOM-free) — the bird's `<svg>` repeated once per pose with the wing paths set to that pose's `d` (the poses come from the `values` of the bird's own `<animate>`: 4 for full, `up` and `down` for calm), each copy a sibling box `psng-pose` with `--pi` (its index) and the bird's `--wdur`/`--wbegin`.
  - In `scene.ts`, at mount, before SMIL is stripped: every skein bird and lark becomes its pose stack; the body lift `animateTransform` is dropped (the flight, sway and wander stay classic's CSS). One keyframe `psng-pose` in the sheet shows copy `--pi` for its quarter of the cycle by `opacity` with plain keyframe pairs (1 at its quarter's start and just before its end, 0 from its end — a hard swap on linear timing; no `steps()`, which spec §2 measured as page work in WebKit); under `psng-calm` only the first two copies run, at the same `--wdur`.
  - The buzzard: the `animateMotion` loop becomes a wrapper rotating 360° over 26 s (begin −4 s) around the loop's centre with the bird offset by its radius, and the flap `animateTransform` becomes a CSS `scale` keyframe from the same values over 52 s (begin −9 s); classic's `ps-buzz-drift` stays on the outer box. If the loop path (`LOOP` in `birds.ts`) is not a circle, fit the circle through its bounding box and say so in the report.

- [ ] **Step 1: Write the failing tests** — `wingTiming` on one bird from `skeinsMarkup()` and one lark from `dayBirdsMarkup()` returns their `dur`/`begin` as numbers; `poseStack` of a bird with 4 poses has 4 `psng-pose` boxes, each with one wing `d` equal to that pose and no `<animate`; the 38 birds and 3 larks of the markup all yield a timing. On the stand-in (plant the bird lists): after mount no SMIL element is left and each bird's place holds a pose stack.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the scene suites; in Chrome with `psngGroups = "skeins,daybirds"` at a moment with skeins (pick it with `birdsAt` in a one-off `npx tsx` call and note it) and one with the buzzard and larks, take a screenshot pair against classic for the user** — Expected: PASS; the birds fly and beat their wings.
- [ ] **Step 5: Commit** — `ps NG: the birds fly again — wing poses by opacity, the buzzard's loop in CSS`

---

### Task 6: The sun's fire

**Files:**

- Create: `client/js/scenes/psng/flame.ts` (from `git show feat/ps-perf-band:client/js/scenes/ps/flame.ts`)
- Modify: `client/js/scenes/psng/scene.ts`, `client/js/scenes/psng/styles.ts` (the `.ps-fire` box: perf-band's `ps.css` rule, scoped to `#theme-scene.psng`)
- Test: `test/scenes/psng/flame.ts`, `test/scenes/psng/mount.ts`

**Interfaces:**

- Consumes: perf-band's `FIRE`, `FIRE_SIZE`, `createTurbulence`, `fireField`, `fireColours`, `createFire` — ported without its stepper interface: NG drives it itself.
- Produces:

  - `FIRE_FPS_NG = 24`; `fireDriver(canvas: HTMLCanvasElement, raf = requestAnimationFrame, caf = cancelAnimationFrame): {start(): void; stop(): void; setColours(flame: string, edge: string): void; destroy(): void}` — paints at most 24 frames a second from the frame cache; `stop()` cancels the frame request (no loop left); the cache is bounded at one loop (7 s × 24 = 168 frames, about 4.3 MB).
  - In `scene.ts`: the sun's markup gets perf-band's `<canvas class="ps-fire" width="160" height="160">` in place of the `#ps-s-fire` filter group; the driver runs while the tier's groups include `sun`, the sun gate is live and the tier is full (calm keeps the fire still: one frame painted); the rays' `ps-spin` runs under `psng-m-sun` with its delay shifted by `--psng-t`.

- [ ] **Step 1: Write the failing tests** — the cache never holds more than 168 frames after 400 simulated frames; `start` then `stop` leaves no pending frame request (a fake `raf`/`caf`); at 24 fps over one simulated second exactly 24 paints; calm paints once and requests nothing; destroy with the driver running leaves no frame request (Review Focus 3).
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the scene suites; in Chrome at noon with `psngGroups = "sun"`, check the fire moves and the rays turn, and `#theme-scene` has no `filter` attribute referencing `ps-s-fire`** — Expected: PASS.
- [ ] **Step 5: Commit** — `ps NG: the sun's fire from a frame cache at 24 frames a second`

---

### Task 7: Browser check in motion, and docs

**Files:**

- Modify: `tools/scenarios/ps-ng.mjs`, `docs/projects/ps-ng.md` (status, §9 results), `CLAUDE.md` (the NG bullet: motion groups, `thelounge.state.psngGroups`, the new setting)

- [ ] **Step 1: Add the checks**
  - census per tier: full at noon, full at 23:00 (stars, fireflies), full on a storm day — every running animation's keyframes touch only `transform`/`opacity` (`anim.effect.getKeyframes()`), every animated element's width and height (`getBoundingClientRect()`, untransformed size) are at most the viewport's (± 1 px), no SMIL element; calm — exactly calm's groups' animations; still (setting Still, reduced motion, hidden, a query) — `getAnimations({subtree: true}).length === 0` and the fire requests no frame (sample `requestAnimationFrame` calls over 1 s);
  - phase: still for 30 s (setting Still), then Full — each cloud's `translateX` equals what `(--psng-t − --cdl) mod --cd` predicts within 2 % of its path;
  - reduced motion toggled live: off → on → off, each state's census as above;
  - switch to classic while NG moves: no `psng-m-*`, no `--psng-t`, no frame requests from NG, classic's clocks moving;
  - screenshots in motion, classic and NG, at 2026-06-21 12:00, 20:45, 23:30, 2026-10-19 12:00 (rain) and a storm day, desktop and `--mobile`, with a contact sheet per viewport, under `tmp/ps-ng-shots/plan2/`.
- [ ] **Step 2: Run it** — `node tools/browser-drive.mjs --scenario tools/scenarios/ps-ng.mjs` and with `--mobile` — Expected: every check `ok`.
- [ ] **Step 3: Docs** — spec status and §9 (what landed, the screenshots' paths); CLAUDE.md's NG bullet.
- [ ] **Step 4: Lint and commit** — `ps NG: browser check of the scene in motion`

---

### Task 8: The phone sitting

Measurement only; the controller runs it with the user. Nothing is deployed and nothing is claimed before it.

**Files:**

- Modify (gitignored): `tmp/perf/ng2/` — copy the worktree's fresh build into `app/` (keep `spike.js`'s `<script>`), add a `g=` query knob to `spike.js` that writes `thelounge.state.psngGroups`, a `mo=` knob that sets `psAnimation`, and `VARIANTS` entries in `lib.mjs` (no commas in labels).
- Modify: `docs/projects/ps-ng.md` §9.5 — the results table and the verdict.

- [ ] **Step 1: Pick the moments** — with one `npx tsx` call on `momentAt`, `birdsAt` and `levelsAt`, choose: a clear noon with the buzzard; a night with stars, fireflies and smoke; a dusk with skeins; the rain day 2026-10-19 12:30; a storm day. Record them in `lib.mjs`.
- [ ] **Step 2: Chrome check of every slot** (`run-chrome.mjs`, 1 round) — Expected: every slot valid by beacon, each group slot's census showing only its group.
- [ ] **Step 3: The iPhone sitting** (≈ 30 min: 18 slots × 2 rounds × 50 s) — `coffee`; `still`; each group alone over still at its moment (`clouds`, `stars`, `fireflies`, `smoke`, `grass`, `weather` rain, `weather` storm, `skeins`, `daybirds`, `sun`); `full` noon, `full` night, `full` storm; `calm` noon, `calm` night; `classic` noon. Tell the user to plug in, with the duration first. `skeins` at a dusk with all three flocks is the slot most likely to miss: 38 birds × 4 poses is about 150 opacity animations plus 38 wander loops, more than the fireflies' 68 that §9.6 already plans a fallback for; its fallback is perf-band's sprite-sheet canvas per flock (decision 2's bitmaps).
- [ ] **Step 4: Decide** — per slot, the paired per-round difference over that round's `still`: each group's share; `full` ≤ 30, `calm` ≤ 24, `still` ≤ 3 in every round. A group or tier over budget falls back by decision 2 (`element.animate`, then bitmaps) or by §9.6 (fireflies to 4 sheets, then stars; the fire to frames or still), and is re-measured in a short second run. A slot with fewer than 2 valid readings is re-run, not read.
- [ ] **Step 5: Android emulator** — the same ladder on a quiet host (load < 2.5, emulator swap < 50 MB, cold boot), rank-only; skip with a note if the host is never quiet for 2 hours.
- [ ] **Step 6: Record and commit** — `docs: ps NG — what each group costs on the iPhone`
