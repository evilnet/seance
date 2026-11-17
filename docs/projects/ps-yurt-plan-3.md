# Inside the yurt, plan 3: the stove's fire — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The fire in the yurt's stove burns while the yurt's chimney smokes outside (dusk to dawn, every season), goes out by day, and its flames dance.

**Architecture:**

- **The burn:** a new light level, `burn`, is the plains' own smoke value (`palette.ts` `smokeOpacity`), so the room's fire and the plains' chimney follow one rule. The stove's glow (`--ps-in-fire`) follows the burn. The still fire and still steam fade with it. Embers drawn under the fire show through when it is out.
- **Asleep by day:** the moving fire, its glow and the steam take the plains' smoke gate (`ps-off`) while the chimney is cold, so nothing animates unseen.
- **The dancing:** plan 2's opacity-flickered fire layers give way to dancing flames. Three tongues and a core, each its own HTML box with its own svg, lick up from their base by `transform`; sparks rise. All of it hangs on the `hearth` group, and the sparks are off in calm.

**Tech Stack:** TypeScript building strings (DOM-free under mocha), CSS animations of `transform` and `opacity`, Vite, mocha, `tools/browser-drive.mjs` scenarios.

**Spec:** `docs/projects/ps-yurt.md` §16 (the design, approved 2026-11-15), within §8 (motion) and §11 (cost). The approaches as shown to the user are the Artifact "The stove's fire": https://claude.ai/artifact/GejpkUoPCkSKmPn1aVqS24.

## Global Constraints

- **ps-ng.md's motion rules, unchanged:** only `transform` and `opacity` animate; nothing animates inside an `<svg>`, and there is no SMIL; nothing is written per frame; no moving box is larger than the viewport; every delay is offset by `--psng-t`; the tiers are full, calm and still; a rest that ends on its own freezes; reduced motion, Still and the open drawer snap. An opacity never sits at exactly 0 or 1 in a keyframe (0.001 and 0.999).
- **§16:**
  - "The room's fire follows that same value": burn = `p.smokeOpacity`, and the glow is min(1, burn × (0.8 + 0.18 × storm)).
  - "By day the stove is out": a dark door with a few dull embers, no fire glow, no steam.
  - "The lamp is unchanged."
  - "A stormy day is out too."
  - Calm: the flames, the core and the glow, without the sparks.
  - The embers are still; nothing moves by day.
- **Nothing animates unseen:** the gate is `ps-off` (`ps.css` `#theme-scene .ps-off { display: none }`), written in `apply` from `live.smoke` (`layers.ts`), as plan 2 gates the room's stars from `live.stars`.
- **No change to the plains or their smoke, and no change to the lamp.** Plan 2 deferred the lamp's unseen flicker; this plan leaves it deferred.
- **CLAUDE.md:** no px (the room's design units through `--ps-ym-s`, or rem); modules under mocha stay DOM-free; reduced motion as the scene reads it today, never `@media`.
- **Branch:** `ps-yurt-fire`, from local `develop` (`affa95009`).
- **Browser checks:** `ps-yurt.mjs` needs no ircd. `ps-ng.mjs` and `theme-ps.mjs` need the dev ircd, run natively as in plans 1 and 2. Run them one at a time.
- **Commits:** end with the session's attribution lines; never push.

## Review Focus

1. **Dusk and dawn:** the room's fire catches at the minute the plains' chimney starts to smoke and dies at the minute it stops. There are no flames by day in any weather, a storm included, and at dusk the still fire is faint rather than at full strength. Tests: Task 1 (a dusk minute: burn equals the smoke value, strictly between 0 and 1; a stormy noon: 0).
2. **A page left open across sunset:** the gate lifts at the minute's tick that first sees smoke, so the moving fire, the glow and the steam come back, and it falls again at dawn. Test: Task 1 (a mount ticking across the smoke's first minute).
3. **Calm on a phone at night:** the tongues and the core move, the sparks don't, and the door visibly changes between frames. Tests: Task 2 (the CSS census) and Task 3 (the browser's calm check and its frame difference).
4. **Screens far from 1280 × 800:** the flames and sparks stay inside the door's arched opening (the fire's box is clipped to it), and the box sits on the stove's door. Tests: Task 2 (the clip in the markup) and Task 3 (alignment at four screens).
5. **Still, reduced motion or a frozen rest:** at night the still fire shows at its strength; by day only the embers show; flames never appear by day. Tests: Task 1 (the burn classes) and Task 3 (the still census by night and by day).

---

### Task 1: The fire follows the chimney

**Files:**

- Modify:
  - `client/js/scenes/ps/indoor.ts` (`IndoorLevels`, `indoorLevels`, `roomCss`);
  - `client/js/scenes/ps/room.ts` (the embers; the burn class on the still fire and still steam);
  - `client/js/scenes/psng/scene.ts` (the chimney's gate in `apply`).
- Test: `test/scenes/ps/indoor.ts`, `test/scenes/ps/room.ts`, `test/scenes/psng/mount.ts`, `test/scenes/ps/legibility.ts`.

**Interfaces:**

- Produces:
  - `IndoorLevels.burn: number` = `p.smokeOpacity`;
  - `fire` = min(1, burn × (0.8 + 0.18 × `WEATHER[m.weather].storm`));
  - `indoorVars` writes nine levels, `--ps-in-burn` among them;
  - `roomCss()` gains `.ps-yt-burn { opacity: var(--ps-in-burn); }`.
- Produces in `roomMarkup()`'s over layer:
  - before the still fire, `<g class="ps-yt-embers">`: the coal bed at the door's foot, a few dull ember shapes in `ROOM_COLOURS` reds drawn with `Dr`, lit (`LIT`), always drawn;
  - the still fire becomes `<g class="ps-yt-still-hearth ps-yt-burn">`;
  - the pot's still steam becomes `<g class="ps-yt-still-steam ps-yt-burn">`, in both stove drawings.
- Produces in `scene.ts` `apply`, after the panes: `room?.querySelectorAll(".ps-ym-fire, .ps-ym-fireglow, .ps-ym-steam")` each toggle `ps-off` with `!live.smoke`.

- [ ] **Step 1: Write the failing tests.**

  - **`test/scenes/ps/indoor.ts`:**
    - "the fire burns while the chimney smokes, and its glow with it (§16)":
      - 21 June 2026 at 12:30, clear: `burn` 0 and `fire` 0;
      - at 23:00, clear: `burn` 1 and `fire` close to 0.8;
      - at 12:30, storm: `burn` 0 and `fire` 0;
      - the first minute from 18:00 whose `p.smokeOpacity` is strictly between 0 and 1 (search the minutes): `burn` equals `p.smokeOpacity`;
      - `roomCss()` contains `.ps-yt-burn { opacity: var(--ps-in-burn); }`.
    - "writes exactly the nine levels" adds `--ps-in-burn`.
  - **`test/scenes/ps/room.ts`:** "draws the coal bed under the fire, and fades the still fire and steam with the burn":
    - in the over layer's markup, `class="ps-yt-embers"` comes before `class="ps-yt-still-hearth ps-yt-burn"`;
    - `ps-yt-still-steam ps-yt-burn` occurs twice;
    - the embers' fills carry `ps-yt-lit` (the census test already enforces that).
  - **`test/scenes/psng/mount.ts`:**
    - **The noon publish expectation:** `"--ps-in-fire": "0.000"`, and a new `"--ps-in-burn": "0.000"`.
    - **"the moving fire, its glow and the steam sleep while the chimney does (Review Focus 2)":** plant `.ps-indoor` with a list for `.ps-ym-fire, .ps-ym-fireglow, .ps-ym-steam` returning three stand-in elements, as the stars' test does.
      - Mount in a query at 21 June 19:00. All three carry `ps-off` (no smoke yet; check that 19:00 has none, and pick another hour if it does).
      - Tick a minute at a time until the plains' `--ps-smoke-op` on the root is above 0, which must happen by 23:00. None carries `ps-off` then.
  - **`test/scenes/ps/legibility.ts`:** no new test. Re-run it after Step 3. Day grounds under the fire's glow are gone, so a pinned figure may move; ledger any update with its old and new value.

- [ ] **Step 2: Run:** `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/scenes/ps/indoor.ts test/scenes/ps/room.ts test/scenes/psng/mount.ts`. Expected: FAIL (no `burn`, no embers, no gate).

- [ ] **Step 3: Implement** the Interfaces above. In `indoorLevels`, `burn` takes `p.smokeOpacity` as it is; nothing else in the room reads `burn` but the class, the glow and the gate.

- [ ] **Step 4: Run** the Step 2 command, then `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/scenes/ps/legibility.ts test/scenes/ps/glass.ts test/scenes/ps/grounds.ts`. Expected: PASS. Then run the full suite (`NODE_ENV=production pnpm build && pnpm test:mocha:built`).

- [ ] **Step 5: Commit** this plan and §16 with the task: `ps: the yurt's stove burns while the chimney smokes — out by day, embers in the door`.

### Task 2: The dancing flames

**Files:**

- Modify:
  - `client/js/scenes/ps/room.ts` (`.ps-ym-top`'s fire);
  - `client/js/scenes/psng/room-motion.ts`;
  - `client/js/scenes/psng/styles.ts` (the catch-all's allow-list only).
- Test: `test/scenes/ps/room.ts`, `test/scenes/psng/room-motion.ts`.

**Interfaces:**

- Consumes: Task 1's `burn`.
- Produces in `roomMarkup()`'s `.ps-ym-top`, in place of plan 2's `.ps-ym-fire-body` and `.ps-ym-fire-tongues`:

  ```
  <div class="ps-ym-fire" style="--x;--y;--w;--h;clip-path:polygon(…)"><div class="ps-ym-flames">
    3 × <div class="ps-ym-tongue ps-ym-t{1|2|3}" style="left:…%;bottom:…%;width:…%;height:…%"><svg viewBox="0 0 20 40" preserveAspectRatio="none">{tongue}</svg></div>
    <div class="ps-ym-core" style="…"><svg …>{core}</svg></div>
    4 × <div class="ps-ym-spark" style="left:…%;--sd:…s;--sdl:…s"></div>
  </div></div>
  ```

  - **The box:** plan 2's fire box, with its clip.
  - **The clip:** the door's opening, the outline `Dr.arched(-0.125, 0.125, 0.33, 0.48, 0.06)` draws, sampled at 16 or more points, in percent of the box.
  - **A tongue:** the Artifact's teardrop path, filled with the fire's own colours (`ROOM_LIT` `#ffe7a0`/`#ffb347`/`#e2582a` as a radial gradient defined in the tongue's own svg, its id prefixed `ps-yt-`). The tongues' feet stand on the coal bed's top, and the middle one is the tallest.
  - **The core:** a smaller, paler copy (`#fff6c0` to `#ffcf6a`).
  - **A spark:** a 0.09rem dot of `#ffd77a`, starting at the coals.
  - **Plan 1's still fire** is unchanged, in the over layer.

- Produces in `ROOM_MOTION_CSS` (plan 2's `.ps-ym-fire-body` and `.ps-ym-fire-tongues` rules go):
  - **The fire's strength:** `#theme-scene .ps-ym-fire { overflow: hidden; opacity: var(--ps-in-burn); }`.
  - **Its size:** `.ps-ym-flames { position: absolute; inset: 0; transform-origin: 50% 100%; transform: scale(calc(0.55 + 0.45 * var(--ps-in-burn))); }`.
  - **The tongues and the core** sit absolutely with `transform-origin: 50% 100%`, their svg filling them.
  - **The dance, under `#theme-scene.psng.psng-m-hearth`:**
    - `.ps-ym-t1` on `psng-yt-lick-a` (0.95 s), `.ps-ym-t2` on `psng-yt-lick-b` (1.2 s) and `.ps-ym-t3` on `psng-yt-lick-c` (0.8 s), each `ease-in-out infinite`;
    - `.ps-ym-core` on `psng-yt-core` (0.45 s `ease-in-out infinite alternate`);
    - every delay `calc(0s - var(--psng-t))`.
  - **The keyframes:**
    - the licks scale and lean about the base (the Artifact's `lick-a`, `lick-b` and `lick-c`: `transform` only);
    - `psng-yt-core` scales and fades between 0.85 and 0.999.
  - **The sparks:**
    - `#theme-scene.psng.psng-m-hearth:not(.psng-calm) .ps-ym-spark { animation: psng-yt-rise var(--sd) linear infinite; animation-delay: calc(var(--sdl) - var(--psng-t)); }`;
    - `psng-yt-rise` translates up about 40 design units' worth of the box (in `%` of the spark's box or in cqh; the builder's call) and fades 0.001 → 0.999 → 0.001;
    - the sparks rest at 0.001 opacity, and `#theme-scene.psng.psng-calm .ps-ym-spark { display: none; }`.
  - **Kept:** `psng-yt-flick` on `.ps-ym-fireglow` and `psng-yt-flick-b` on `.ps-ym-flame` (the lamp).
- Produces in `NG_STILL_CSS`: the catch-all's allow-list drops `.ps-ym-fire-body, .ps-ym-fire-tongues` and gains `.ps-ym-tongue, .ps-ym-core, .ps-ym-spark`.

- [ ] **Step 1: Write the failing tests.**

  - **`room.ts`:** "draws the stove's flames to dance: three tongues, a core and four sparks, clipped to the door (§16)":

    - `.ps-ym-fire`'s style carries `clip-path:polygon(` with at least 16 points;
    - inside `.ps-ym-flames`: exactly 3 `ps-ym-tongue`, 1 `ps-ym-core` and 4 `ps-ym-spark`;
    - no `ps-ym-fire-body` or `ps-ym-fire-tongues`;
    - every id in the moving fire's svgs starts with `ps-yt-` and is unique in `roomMarkup()` (the existing id test covers the uniqueness).

    Replace plan 2's "draws the fire, the lamp's flame and the steam over the over layer" assertions about the body and tongues; keep its lamp and steam assertions.

  - **`room-motion.ts`:**
    - "hearth: the tongues and the core dance in phase with psng-m-hearth": `rule(".psng-m-hearth ", c, PHASED)` for each of `ps-ym-t1`, `ps-ym-t2`, `ps-ym-t3` and `ps-ym-core`.
    - "the sparks rise at full and rest in calm (§16)": a rule under `.psng-m-hearth` (with `:not(.psng-calm)`) phasing `ps-ym-spark`, and `rule(".psng-calm ", "ps-ym-spark", NONE)`.
    - "the fire's strength and size follow the burn": `.ps-ym-fire`'s rule has `opacity: var(--ps-in-burn)`, and `.ps-ym-flames`'s `transform` uses `var(--ps-in-burn)`.
    - The existing tests then hold over the new keyframes: names that exist, `transform`/`opacity` only, the allow-list. Extend "never at exactly 1 or 0" to `psng-yt-core` and `psng-yt-rise`.

- [ ] **Step 2: Run:** `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/scenes/ps/room.ts test/scenes/psng/room-motion.ts test/scenes/psng/styles.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces above.

- [ ] **Step 4: Run** the Step 2 command, then the full suite. Expected: PASS.

- [ ] **Step 5: Look at it:**

  - build, then run the scratch probe (`tmp/yurt-check/layers/probe.mjs`, focus on) at 22:00 and at noon;
  - at 22:00 the tongues lick inside the door and the sparks stay inside its arch;
  - at noon the door is dark with embers and nothing moves.

- [ ] **Step 6: Commit:** `ps: the yurt's fire dances — three tongues and a core licking up from the coals, sparks rising`.

### Task 3: The browser checks and the cost

**Files:**

- Modify:

  - `tools/scenarios/ps-yurt.mjs`;
  - `tools/scenarios/ps-ng.mjs` (`GROUP_OF`);
  - `docs/projects/ps-yurt.md` (§11.3).

- [ ] **Step 1: Write the checks.**

  - **`ps-yurt.mjs`:**
    - **By day, a clear noon at full:**
      - none of `psng-yt-lick-a`, `-b`, `-c`, `psng-yt-core`, `psng-yt-rise`, `psng-yt-flick` or `ps-smoke-rise` runs;
      - `.ps-ym-fire`, `.ps-ym-fireglow` and `.ps-ym-steam` compute `display: none`;
      - the door's rect (the over layer's `.ps-yt-stove-over`, lower third) is the same in two frames 300 ms apart.
    - **By night, a clear 21:00 at full:**
      - the three licks, the core, the rise, the glow's flick and the steam all run;
      - the door changes between two frames 300 ms apart;
      - every `.ps-ym-spark`'s rect lies inside `.ps-ym-fire`'s rect.
    - **Alignment (Review Focus 4):** move 4f's fire check to 21:00. `.ps-ym-fire`'s centre is within 2 % of the scene's width of the stove's centre, at each screen.
    - **Calm at 21:00:** the licks, the core and the flickers run, and no `psng-yt-rise` or `ps-drift`; the door changes between frames (Review Focus 3).
    - **Still at 21:00 (reduced motion):** `.ps-yt-still-hearth` computes an opacity of at least 0.95 and nothing runs. **Still at noon:** its computed opacity is 0, and `.ps-yt-embers` shows (Review Focus 5).
    - **Rewrite** the full-at-noon expectations that named both flickers and the steam: by day only the drift (and the lamp's unseen flicker) run.
  - **`ps-ng.mjs`:** `GROUP_OF` gains `psng-yt-lick-a`, `-b`, `-c`, `psng-yt-core` and `psng-yt-rise` → `hearth`.
  - **`theme-ps.mjs`:** unchanged; its query checks run at noon, where the clouds still move.

- [ ] **Step 2: Run** `ps-yurt.mjs` at 1280 × 800, `--mobile --width=390 --height=844`, `--mobile --width=932 --height=430` and `--width=2560 --height=1080`, then `ps-ng.mjs` and `theme-ps.mjs` with the dev ircd, one at a time. Expected: every check ok, except `theme-ps.mjs`'s two rim glyph samples that develop fails.

- [ ] **Step 3: Measure** with plan 2's scratch `tmp/yurt-check/perf2.mjs`, a query against a channel at a clear 21:00:

  - full and calm, desktop and the phone profile at 4×, three rounds;
  - noon still checked once for each profile.

  Record §11.3 in §11.2's style: the table, the load, and what it rules out. Expected: the query at night costs no more than plan 2's §11.2 night figures, within noise. Report it if it does, and don't tune silently.

- [ ] **Step 4: Commit:** `ps: browser checks for the stove's fire, and its cost`.

### Task 4: The docs

**Files:**

- Modify: `docs/projects/ps-yurt.md` (§16 status; §8's "As built"), `docs/resources/ps-theme-map.md`, `docs/resources/themes.md`, `docs/resources/codebase-guide.md`

- [ ] **Step 1: Update:**

  - **`ps-yurt.md`:**
    - §16 status "built, <date>";
    - §8's "As built" names the dancing flames and sparks in place of the body and tongues' flicker, and the chimney's gate.
  - **`ps-theme-map.md` and `themes.md`:** the stove burns while the chimney smokes and dances; out by day.
  - **`codebase-guide.md`:** the `ps-yurt.md` entry adds plan 3.

- [ ] **Step 2: Run:** `pnpm lint`. Expected: clean.

- [ ] **Step 3: Commit:** `ps: docs — the stove's fire`.
