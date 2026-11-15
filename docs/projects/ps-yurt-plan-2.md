# Inside the yurt, plan 2: motion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In a private conversation the yurt's room moves as the plains do: the stove's fire and its glow flicker, the lamp's flame flickers, steam rises from the pot, clouds drift across the windows, rain, snow and lightning fill the panes, and stars twinkle in the windows and the crown, under NG's tiers, freeze and snaps.

**Architecture:** The room's one SVG becomes a stack of layers in `.ps-indoor`, bottom to top:

- the back picture (what is seen through the openings);
- the moving window panes (HTML), so the frames, the pipe and the curtains stay in front of the weather;
- the front picture (everything else, with holes at the openings);
- the glows, as screen-blended layers of their own, the fire's in a box that can flicker;
- what plan 1 drew after the glows (the stove's second drawing, the beam, the fire);
- the moving hearth and steam (HTML).

The HTML is placed in the room's design frame by one CSS length that follows the SVG's `slice`. The motion is CSS only: the room's stylesheet hangs it on NG's group classes (two new groups, `hearth` and `steam`, and the existing `clouds`, `weather` and `stars`) and phases it by `--psng-t`. Each moving part swaps with plan 1's still drawing, so still, calm, reduced motion and a frozen rest are what NG already does. A query stops forcing still.

**Tech Stack:** TypeScript building strings (DOM-free under mocha), CSS animations of `transform` and `opacity`, Vite, mocha, `tools/browser-drive.mjs` scenarios (Playwright Chromium).

**Spec:** `docs/projects/ps-yurt.md`: §8 (motion), §11 (cost), §12 (tests), §13 (plan 2) and §14 (left to the builder). Also the approved mockup's fire motion: `docs/resources/themes/ps-yurt/mockup.html`, `.flick` and `.flick-b`. Plan 1 (`docs/projects/ps-yurt-plan-1.md`) is built and merged into local `develop` at `48c60e57b`; its report's open decisions stay out of this plan (see "Not in this plan").

## Global Constraints

- **The motion rules are ps-ng.md's, unchanged (spec §8):** only `transform` and `opacity` animate; nothing animates inside an `<svg>`, and there is no SMIL; nothing is written per frame; no moving box is larger than the viewport; pose swaps go by opacity at 0.999/0.001; every delay is offset by `--psng-t`; the tiers are full, calm and still; a rest that ends on its own (a hidden or unattended page) freezes; reduced motion, Still and the open drawer snap.
- **"A query is now just another view to `tierFor`."**
- **Calm:** `hearth` and `clouds`. **Phone:** halves the particles, as outside.
- **Moving between plains and room is a cut. Only one picture is in the render tree.**
- **The room's markup is built on the first query,** kept until the theme unmounts, and rebuilt only for a new day's weather (the moving panes are rebuilt with plan 1's static weather slot, on the same `weatherChanged` trigger).
- **The fire moves as the approved mockup's did** (§14 leaves "HTML poses or the canvas" to the builder). The mockup's own motion was opacity: the fire's body and the stove's two glows on its `flick` (2.4 s), the fire's two tongues on its `flick-b` (1.7 s). This plan keeps those values, with 1 written as 0.999 (the poses' rule). The lamp's flame flickers on `flick-b` (§8: "the lamp's flicker").
- **The glows are screen-blended layers over the room,** and `.ps-indoor` isolates them. The fire's glow layer flickers by opacity. Task 6 measures that.
- **The cost gate (spec §11):** the room may cost no more than the plains at the same tier, measured on the iPhone (the user's sitting); still stays absolute at 3 % or less. Chrome on this machine ranks, it does not pass.
- **CLAUDE.md:**
  - no px (rem, or the room's design units through `--ps-ym-s`);
  - reduced motion as the scene reads it today (`systemAccessibility`), never `@media`;
  - `ps/room.ts`, `psng/room-motion.ts`, `psng/groups.ts` and `psng/tiers.ts` stay DOM-free.
- **The moving boxes are placed with physical `left` and `top`, not logical properties.** The room's picture is never mirrored (plan 1's ruling; plan 5's mirroring must leave `.ps-indoor` out), and a box must sit on the SVG's window under `dir="rtl"` too. One comment says so where they are set.
- **The plains are unchanged:** no rule this plan adds selects anything outside `.ps-indoor`, and `psng/styles.ts` is not edited.
- **Browser checks need the dev ircd:**
  - `tools/nefarious-dev/run.sh`, or, without Docker, the native build in `/seance/testnet`: `ircd -n -d <dir> -f <dir>/ircd.conf`, with `tools/nefarious-dev`'s `ircd.conf` and `local.conf` over `tools/docker/base.conf-dist`, as plan 1 task 9 ran it. `ps-yurt.mjs` needs none (its own `lib/tiny-ircd.mjs`).
  - Between Task 1 and Task 5, the query checks in `theme-ps.mjs` and `ps-ng.mjs` (still and frozen; the nine-group and clouds-only censuses) and `ps-yurt.mjs`'s "no CSS animation" check are expected to fail; Task 5 rewrites them.
- **Branch:** `ps-yurt-motion`, from local `develop`. Commits end with the session's attribution lines; never push.

## Review Focus

1. **Back and forth between a channel and a query while moving:** each picture's loops start at the clock's phase every time, and nothing jumps back to where it stood minutes ago. The plains' sun canvas never draws in a query. Tests: Task 1 (round trips: `--psng-t` and the fire loop).
2. **A new day's weather while a query is open, moving or frozen:** the moving panes are rebuilt with the static slot, so no rain is left falling on a hot day, and a thaw after the rebuild throws nothing. Test: Task 3 (mount across midnight, 21 June clear → 22 June heat).
3. **Screens far from 1280 × 800** (390 × 844, 932 × 430, 2560 × 1080): every moving pane sits inside its window's frame, and the moving fire on the stove's door. Test: Task 5 (alignment at four screens).
4. **A phone in a query:**

   - the open drawer holds the room still, as it holds the plains;
   - auto on a phone is calm, which here is the hearth and the clouds;
   - the drops and flakes are halved.

   Tests: Task 1 (mount: phone, auto, drawer), Task 3 (`windowMotion(w, true)`) and Task 5 (phone counts).

5. **Reduced motion or Still inside a query shows plan 1's still room:** the static weather, the SVG's fire and steam, never an empty window or half a swap. Moving shows visibly: the stove's door changes between frames at full and at calm. Tests:
   - Task 2 (pixel comparison of the still room against plan 1);
   - Tasks 3 and 4 (every swap pair in the CSS census);
   - Task 5 (the still census, and frame differences at the door and in a pane).

## Not in this plan

- **Plan 1's open decisions:** the night's warmth around the stove (the mockup's darkness holes), the first query's build cost (Task 6 measures it again but does not tune it), the scrim's far edge at 2.01, and a second night-shading method. Also heat's warmer floor light. All are the user's calls.
- **Shape poses or a canvas for the fire:** the mockup's opacity flicker is what was approved; another fire is a plan of its own.

## File structure

| File                                                                                                                               | Responsibility                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client/js/scenes/psng/tiers.ts`, `groups.ts` (modify)                                                                             | A query is a view like any other; the `hearth` and `steam` groups; calm is the clouds and the hearth.                                                                  |
| `client/js/scenes/psng/scene.ts` (modify)                                                                                          | The sun's canvas off in a query; `--psng-t` rewritten on a change of view; the room's motion CSS adopted with its sheet; `.ps-ym-panes` filled on the weather trigger. |
| `client/js/scenes/ps/room.ts` (modify)                                                                                             | The layers and their slots; `windowMotion(weather, phone)`; the fire, lamp and steam boxes; the still classes on plan 1's drawings.                                    |
| `client/js/scenes/psng/room-motion.ts` (new)                                                                                       | `ROOM_MOTION_CSS`: the boxes' placement, the room's animations on the group classes, and the still/moving swaps.                                                       |
| `client/themes/ps.css` (modify)                                                                                                    | The layers fill `.ps-indoor`; `.ps-indoor` isolates; the glow layers screen-blend.                                                                                     |
| `test/scenes/psng/{tiers,groups,mount}.ts`, `test/scenes/ps/room.ts`, `test/scenes/psng/room-motion.ts` (new), `test/themes/ps.ts` | As each task says.                                                                                                                                                     |
| `tools/scenarios/{ps-yurt,ps-ng,theme-ps}.mjs`                                                                                     | The browser checks (Task 5).                                                                                                                                           |
| `docs/projects/ps-yurt.md`, `docs/resources/{ps-theme-map,themes,codebase-guide}.md`, `docs/projects/ps-ng.md`                     | Cost (§11.2) and docs.                                                                                                                                                 |

---

### Task 1: A query moves

**Files:**

- Modify: `client/js/scenes/psng/tiers.ts`, `client/js/scenes/psng/groups.ts`, `client/js/scenes/psng/scene.ts` (`syncFire`, `update`)
- Test: `test/scenes/psng/tiers.ts`, `test/scenes/psng/groups.ts`, `test/scenes/psng/mount.ts`

**Interfaces:**

- Produces:

  - `type Group` gains `"hearth" | "steam"`;
  - `GROUPS` is the nine groups as today, then `"hearth"` and `"steam"`;
  - `groupsFor("calm")` is `Set {"clouds", "hearth"}`;
  - `tierFor(state, reduceMotion)` no longer reads `state.view`.

- [ ] **Step 1: Write the failing tests.**

  - **`test/scenes/psng/tiers.ts`:** in the truth table, `const still = !visible || !attended || reduce;` (the view leaves the row). Title the case "a query is just another view (spec §8)".
  - **`test/scenes/psng/groups.ts`:**

    ```ts
    it("full runs every group, calm the clouds and the hearth, still none", function () {
      expect([...groupsFor("full")].sort()).to.deep.equal([...GROUPS].sort());
      expect([...groupsFor("calm")]).to.deep.equal(["clouds", "hearth"]);
      expect(groupsFor("still").size).to.equal(0);
      expect(GROUPS).to.include.members(["hearth", "steam"]);
    });
    // and in the override test:
    expect([...(groupOverride(store("hearth,steam")) ?? [])]).to.deep.equal(["hearth", "steam"]);
    ```

  - **`test/scenes/psng/mount.ts`:**

    - **Rework "full: every group's class…".** It becomes "full: every group's class; unattended: frozen with its classes; a query: every class, not frozen (spec §8)". After `scene.update(state({view: "query"}))`, expect `frozen()` false and `motionClasses(page).sort()` deep-equal `all`. Then `scene.update(state({view: "query", attended: false}))` must freeze it, and query plus Still must snap as before.
    - **New: "the sun's canvas stops in a query and runs again on the plains".** Use `plantFire(page)`, mounting at noon, full:
      - `paints.pending()` is 1;
      - after `update(state({view: "query"}))` it is 0;
      - after `update(state())` it is 1.
    - **New: "--psng-t: rewritten at each change of view while moving, from the clock less the rested time" (Review Focus 1).** Mount on 21 June 2026 at 12:00:00, full (`--psng-t` = `43200s`). Then, with the page's clock:

      - 90 s on, a query: `43290s`;
      - 30 s on, a channel: `43320s`;
      - unattended for 60 s, then attended (the thaw's rewrite): `43320s`;
      - 10 s on, a query: `43330s`;
      - 10 s on, a channel: `43340s`.

      The fire loop is stopped in both queries.

    - **New: "a phone in a query: auto is calm (the clouds and the hearth); the drawer holds it still" (Review Focus 4).** Mount with `phone: true`, `motion: "auto"`, `view: "query"`:
      - the motion classes are exactly `psng-m-clouds`, `psng-m-hearth` and `psng-calm`;
      - with the drawer open (`plantDrawer`, `set("menu-open")`), there is no group class.

- [ ] **Step 2: Run:** `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/scenes/psng/tiers.ts test/scenes/psng/groups.ts test/scenes/psng/mount.ts`. Expected: FAIL. A query is still and frozen, calm lacks `hearth`, the fire loop runs in a query, and `--psng-t` is not rewritten on a view change.

- [ ] **Step 3: Implement.**

  - **`tiers.ts`:** drop `state.view === "query"` from the still condition.
  - **`groups.ts`:** add the two groups at the end of `GROUPS`; `CALM` becomes `["clouds", "hearth"]`.
  - **`scene.ts`:**
    - `syncFire` starts the loop only when `tier === "full" && sunOn && sunLive && latest.view !== "query"`.
    - In `update`, when the view changes, it is not the first update and the tier after `setGroups()` is not still, write `--psng-t` exactly as the still → moving move does: `phaseSeconds(new Date(), mounted) - restedS`. The view to compare against is the one before this update.
    - A comment says why: a picture leaving the render tree drops its animations, and the one coming back starts them anew.

- [ ] **Step 4: Run** the Step 2 command. Expected: PASS. Then run `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml` and update only the expectations that list calm's classes or a query's freeze. They are the intended change; ledger them.

- [ ] **Step 5: Commit** this plan (`docs/projects/ps-yurt-plan-2.md`) with the task: `ps: a private conversation moves as a channel does — the hearth and steam groups, calm keeps the hearth`.

### Task 2: The room in layers

**Files:**

- Modify: `client/js/scenes/ps/room.ts` (`roomMarkup`, the crown piece, the window clips, the defs), `client/themes/ps.css` (the `.ps-indoor` rules)
- Test: `test/scenes/ps/room.ts`, `test/themes/ps.ts`

**Interfaces:**

- Produces `roomMarkup()` as follows. Every SVG has `viewBox="-320 0 1920 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true"`.

  ```
  <div class="ps-indoor">
    <svg class="ps-yt" …>{defs}{back}</svg>
    <div class="ps-ym-panes" data-weather=""></div>
    <svg class="ps-yt ps-yt-front" …>{front}</svg>
    <div class="ps-ym-fireglow"><svg class="ps-yt" …>{the fire's two glows}</svg></div>
    <svg class="ps-yt ps-yt-glow" …>{the lamp's glow, the screen's}</svg>
    <svg class="ps-yt ps-yt-over" …>{the stove's second drawing, the beam, the fire, the lamp's flame, the screen}</svg>
    <div class="ps-ym-top"></div>
  </div>
  ```

  - **back:** the windows' views (`windowView` for each pane) and the static weather slot `.ps-yt-weather`, then the crown's opening sky, its veil and its still stars. Their clips grow by 2 design units, so the back overdraws each opening and no ring of the scene's own sky shows at an edge; the frames and the crown's rim cover the overdraw.
  - **front:**

    - the floor, boards, roof, poles, the crown's ring, the wall, lattice, band and skirt, inside one `<g mask="url(#ps-yt-openings)">`;
    - the crown's ribs and rim (`<g class="ps-yt-ribs">`; the crown piece's class stays on its back part);
    - the window frames, curtains and side windows, the rug, hearth, pool and golden glow, and everything standing.

    Nothing in it blends.

  - **The glow layers** hold plan 1's glow shapes with their classes (`ps-yt-glow-fire`, `-lamp`, `-screen`) and no `mix-blend-mode` in the markup; `ps.css` blends the layer.
  - **The over layer:** plan 1's `<g class="ps-yt-stove-over">`, the beam, the fire, the lamp's flame and the screen, in plan 1's order.
  - **defs:** gains `<mask id="ps-yt-openings" maskUnits="userSpaceOnUse" x="-3000" y="-3000" width="8000" height="8000">`. It holds a white rect over everything, then each window's inner polygon and the crown's opening polygon in black, not grown.

- Produces in `ps.css`, beside plan 1's `.ps-indoor` rules:

  - `#theme-scene .ps-indoor { isolation: isolate; }`;
  - `#theme-scene .ps-indoor > svg, #theme-scene .ps-indoor > div { position: absolute; inset: 0; }`;
  - every `.ps-indoor` SVG (direct or in `.ps-ym-fireglow`): `display: block; inline-size: 100%; block-size: 100%;`;
  - `#theme-scene .ps-indoor > .ps-ym-fireglow, #theme-scene .ps-indoor > .ps-yt-glow { mix-blend-mode: screen; }`.

- [ ] **Step 1: Write the failing tests** (`test/scenes/ps/room.ts`):

  ```ts
  it("is a stack of layers in the design frame, in order", function () {
    const at = (s: string) => markup.indexOf(s);
    const order = [
      '<div class="ps-indoor"><svg class="ps-yt" viewBox="-320 0 1920 800" preserveAspectRatio="xMidYMid slice"',
      '<div class="ps-ym-panes" data-weather="">',
      '<svg class="ps-yt ps-yt-front" viewBox="-320 0 1920 800"',
      '<div class="ps-ym-fireglow"><svg class="ps-yt" viewBox="-320 0 1920 800"',
      '<svg class="ps-yt ps-yt-glow" viewBox="-320 0 1920 800"',
      '<svg class="ps-yt ps-yt-over" viewBox="-320 0 1920 800"',
      '<div class="ps-ym-top"></div></div>',
    ].map(at);
    expect(order[0]).to.equal(0);
    order.slice(1).forEach((i, k) => expect(i, `layer ${k + 1}`).to.be.above(order[k]));
    expect(markup).to.not.contain("mix-blend-mode");
  });

  it("sees the views out, their weather and the crown's sky behind the panes; the frames, the ribs and all that stands in front; the glows above them", function () {
    const panes = markup.indexOf('class="ps-ym-panes"');
    const glow = markup.indexOf('class="ps-ym-fireglow"');
    expect(markup.indexOf('class="ps-yt-weather"')).to.be.below(panes);
    [
      "ps-yt-p-window-back",
      "ps-yt-p-window-left",
      "ps-yt-p-window-right",
      "ps-yt-ribs",
      "ps-yt-p-stove",
      "ps-yt-p-table",
    ].forEach((c) => expect(markup.indexOf(c), c).to.be.above(panes).and.below(glow));
    expect(markup.indexOf('class="ps-yt-glow-fire"')).to.be.above(glow);
    expect(markup.split('mask="url(#ps-yt-openings)"').length - 1).to.equal(1);
  });
  ```

  The existing tests keep passing, plan 1's order tests included: the glows after what stands, the stove drawn over them, the beam after it. The deterministic check stays.

  In `test/themes/ps.ts`, pin the four rules above.

- [ ] **Step 2: Run:** `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/scenes/ps/room.ts test/themes/ps.ts`. Expected: FAIL (one SVG).

- [ ] **Step 3: Implement** the layers in `room.ts` and the rules in `ps.css`. Plan 1's pieces keep their markup; only where each is drawn changes.

- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.

- [ ] **Step 5: Prove the still room is unchanged (Review Focus 5).**

  - Run `node tools/browser-drive.mjs tools/scenarios/ps-yurt.mjs` against a production build of this task's BASE, keep the screenshots, then rebuild at HEAD and run it again.
  - Compare `yurt-noon-clear`, `yurt-noon-rain`, `yurt-noon-snow`, `yurt-21-clear` and `yurt-21-snow` pixel by pixel with a scratch page that diffs two PNGs on a canvas.
  - Expected: no pixel more than 2 levels apart, except up to 6 where the fire's glow overlaps the lamp's. They now blend as two layers, not as one group.
  - Where a difference points:
    - a ring at a window's or the crown's edge means the back's overdraw is missing;
    - a window's view darker at night means the glow layers are not over the back;
    - the whole picture means the layer order or the blend.

- [ ] **Step 6: Commit:** `ps: the yurt in layers — the views out behind, the room in front, the glows over them, room for what moves`.

### Task 3: The windows move

**Files:**

- Create: `client/js/scenes/psng/room-motion.ts`, `test/scenes/psng/room-motion.ts`
- Modify: `client/js/scenes/ps/room.ts` (`windowMotion`; the still classes in `windowWeather` and `cloud`), `client/js/scenes/psng/scene.ts` (`buildRoom`, `apply`)
- Test: `test/scenes/ps/room.ts`, `test/scenes/psng/mount.ts`

**Interfaces:**

- Consumes: Task 1's groups; Task 2's `.ps-ym-panes`.
- Produces `windowMotion(weather: Weather, phone: boolean): string`, the slot's content:
  - **Panes.** One `<div class="ps-ym-pane" data-pane="back|left|right|crown" style="--x:…;--y:…;--w:…;--h:…;clip-path:polygon(…)">` for each window `windowPanes()` returns, then the crown.
    - `--x`/`--y`/`--w`/`--h` are the pane's bbox in design units (`n()`).
    - The clip is the inner quad's points, or the crown opening's, as percentages of that bbox, not grown.
    - Rng per pane: `rng(611 + i * 17 + WEATHERS.indexOf(weather) * 101)`.
    - Counts use the static weather's per-pane `count(k)` = `max(1, round(k · iw / backWidth · (phone ? 0.5 : 1)))`, factored out of `windowWeather` so both read it.
  - **Fair weather** (`FAIR_CLOUDS`): `count(FAIR_CLOUDS[weather])` `<div class="ps-ym-cloud" style="top:…%;width:…%;--cd:…s;--cdl:…s">`. Each holds `<svg viewBox="-23 -12 47 23">` with `cloud()`'s four ellipses, `style="fill: var(--ps-cloud)"`.
    - `top` = (0.1 + 0.25·r)·100 %.
    - `width` = 47·k / iw·100 %, where k = (0.55 + 0.35·r)·(iw / backWidth)^0.3.
    - `--cd` = (70 + 30·r)·√(iw / backWidth) s, halved in `wind`; `--cdl` = −r·`--cd`.
  - **Rain and storm:** `rainTiles(count(weather === "storm" ? 60 : 34), {width: iw, height: ih})`, the plains' tiles.
  - **Snow:** `<div class="ps-snow">` with `count(44)` `<i style="left:…%;--fs:…rem;--fd:…s;--fdl:…s;--fx:…cqw;opacity:…">`:
    - left 0–105 %;
    - `--fs` (2 + 3.4·r)/16 rem;
    - `--fd` 3 + 3·r s;
    - `--fdl` −r·6 s;
    - `--fx` −30 + 50·r cqw;
    - opacity 0.5 + 0.5·r.
  - **Storm:** also `<div class="ps-flash"></div>`.
  - **Every pane:** `<div class="ps-ym-stars">` with `<i class="ps-ym-tw" style="left:…%;top:…%;--tw:…s;--twl:…s">`: 6 in the back, 4 in a side window, 5 in the crown, never halved. Top is 0–55 % in a window and 0–100 % in the crown; `--tw` is 3 + 3·r s and `--twl` is −r·6 s.
- Produces `ROOM_MOTION_CSS: string` (`psng/room-motion.ts`):
  - `#theme-scene .ps-indoor { --ps-ym-s: max(calc(100cqw / 1920), calc(100cqh / 800)); }`, the SVG's `slice` scale for one design unit, around the frame's middle (640, 400).
  - **Placement** of `.ps-ym-pane` and `.ps-ym-top > *`: `position: absolute; left: calc(50% + (var(--x) - 640) * var(--ps-ym-s)); top: calc(50% + (var(--y) - 400) * var(--ps-ym-s)); width: calc(var(--w) * var(--ps-ym-s)); height: calc(var(--h) * var(--ps-ym-s));`, with the comment on physical properties.
  - `.ps-ym-pane { container-type: size; overflow: hidden; }` and `.ps-ym-pane > * { position: absolute; }`, so classic's `cqw`/`cqh` keyframes measure the pane.
  - **Clouds:**
    - `.ps-ym-cloud { left: 0; aspect-ratio: 47 / 23; }`, with its SVG filling it;
    - `#theme-scene.psng.psng-m-clouds .ps-ym-cloud { animation: ps-drift var(--cd) linear infinite; animation-delay: calc(var(--cdl) - var(--psng-t)); }`.
  - **Stars:**
    - `.ps-ym-stars { inset: 0; opacity: var(--ps-stars, 0); }`;
    - `.ps-ym-tw` a 0.125rem white disc;
    - `#theme-scene.psng.psng-m-stars .ps-ym-tw { animation: ps-twinkle var(--tw) ease-in-out infinite alternate; animation-delay: calc(var(--twl) - var(--psng-t)); }`.
  - **Rain, snow and the flash** are run and hidden by NG's existing rules; the pane is their container.
  - **Swaps:**
    - `#theme-scene.psng.psng-m-clouds .ps-yt-still-clouds, #theme-scene.psng.psng-m-weather .ps-yt-still-weather { display: none; }`;
    - `#theme-scene.psng:not(.psng-m-clouds) .ps-ym-cloud, #theme-scene.psng:not(.psng-m-stars) .ps-ym-stars { display: none; }`.
- Produces the still classes in `windowWeather`:
  - the fair-weather clouds carry `ps-yt-still-clouds` (`cloud()` takes an optional class; the deck's clouds do not);
  - the streaks carry `ps-yt-still-weather` beside `ps-yt-rain`, and so do the flakes beside `ps-yt-flake`;
  - the drops on the panes, the drift and the veil keep theirs (none is in flight).
- In `scene.ts`:

  - `buildRoom` adopts `roomCss() + ROOM_MOTION_CSS`;
  - `apply`'s `roomBuilt` branch also sets `.ps-ym-panes`' `innerHTML` to `windowMotion(m.weather, isPhoneLayout())` and its `dataset.weather`.

- [ ] **Step 1: Write the failing tests.**

  - **`test/scenes/ps/room.ts`** gains `describe("the windows' motion (§8)")` with:
    - **Per weather:**
      - deterministic;
      - one pane per window clip in `roomMarkup()` plus the crown;
      - each pane with `data-pane`, four numeric custom properties and a `clip-path:polygon(` of 4 points (windows) or at least 20 (crown);
      - no `<animate`.
    - **Clear, wind and heat:** the `.ps-ym-cloud` count equals the `ps-yt-still-clouds` count in `windowWeather(w, false)`. Every wind `--cd` ≤ 0.5 × the clear maximum + 1, and rain, snow and storm have no `.ps-ym-cloud`.
    - **Rain:** `psng-rain-tile` present, and each pane's drops equal that pane's `ps-yt-rain` streaks. **Storm:** more drops than rain, and one `.ps-flash` per window pane. **Snow:** `.ps-snow` flakes equal the `ps-yt-flake` count. Clear has none of these.
    - **Phone (Review Focus 4):** `windowMotion(w, true)` has half the drops and flakes of `windowMotion(w, false)`, ±1 per pane.
    - **`windowWeather`:** fair clouds carry `ps-yt-still-clouds`, streaks and flakes carry `ps-yt-still-weather`, and drops and the veil carry neither.
  - **`test/scenes/psng/room-motion.ts`** (new). Parse `ROOM_MOTION_CSS` into `[selector, body]` rules as `test/scenes/psng/styles.ts` does. Then:
    - every selector starts with `#theme-scene` and names `.ps-indoor`, a `.ps-ym-` class or a `.ps-yt-still-` class, never the plains;
    - **`clouds` and `stars`:** a `:not(.psng-m-<g>)` rule with `display: none` on its moving class, and a `.psng-m-<g> ` rule whose `animation-delay` uses `var(--psng-t)`;
    - **`clouds` and `weather`:** a `.psng-m-<g> ` rule with `display: none` on its `ps-yt-still-` class;
    - every keyframes name it uses is defined in `client/themes/ps.css`, in `NG_STILL_CSS` or in itself;
    - every `@keyframes` it defines animates only `transform` and `opacity`;
    - no `transition`, no `@media`, no `backdrop-filter`.
  - **`test/scenes/psng/mount.ts` (Review Focus 2):** "the panes follow the day's weather with the static slot, moving or frozen".
    - Mount in a query on 21 June 2026 at 23:59 (clear), full: `.ps-ym-panes`' `dataset.weather` is `clear`, and its markup has `ps-ym-cloud`.
    - Make it unattended (frozen), cross midnight, make it attended: no throw.
    - `dataset.weather` is now `heat`, and the markup has no `psng-rain-tile`.

- [ ] **Step 2: Run:** `NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/scenes/ps/room.ts test/scenes/psng/room-motion.ts test/scenes/psng/mount.ts`. Expected: FAIL (no `windowMotion`, no `ROOM_MOTION_CSS`).

- [ ] **Step 3: Implement** the Interfaces above.

- [ ] **Step 4: Run** the Step 2 command, then the full mocha suite. Expected: PASS.

- [ ] **Step 5: Look at it.** Build, run `ps-yurt.mjs`, and open the noon clear, rain, snow and storm screenshots. The clouds sit in the windows behind their frames and the pipe, and the rain and snow stay inside the panes. Its "no CSS animation" check now fails, as expected until Task 5.

- [ ] **Step 6: Commit:** `ps: the yurt's windows move — clouds, rain, snow, lightning and stars, as outside`.

### Task 4: The fire, the lamp and the steam

**Files:**

- Modify: `client/js/scenes/ps/room.ts` (`.ps-ym-top`'s content; the still classes on the over layer's fire, the lamp's flame and the pot's steam), `client/js/scenes/psng/room-motion.ts`
- Test: `test/scenes/ps/room.ts`, `test/scenes/psng/room-motion.ts`

**Interfaces:**

- Produces, in `roomMarkup()`'s `.ps-ym-top`, built once with the room:

  - **The fire.** `<div class="ps-ym-fire" style="--x;--y;--w;--h">` is the bbox of plan 1's fire drawing in design units. It holds two layers, each `<svg viewBox="{bbox}">` filling it:

    - `<div class="ps-ym-fire-body">` with the fire's arched body;
    - `<div class="ps-ym-fire-tongues">` with its two tongues.

    Together they are plan 1's fire string exactly, split in two; they stay lit and keep `url(#ps-yt-fire)`. The over layer's still fire goes into a `<g class="ps-yt-still-hearth">`.

  - **The lamp.** `<div class="ps-ym-lamp" style="--x;--y;--w;--h">` is the bbox of the lamp's flame sprite. It holds `<div class="ps-ym-flame"><svg viewBox="{bbox}">{the flame sprite}</svg></div>`. The over layer's still flame gains `ps-yt-still-hearth`.
  - **The steam.** `<div class="ps-ym-steam" style="--x;--y;--w:0;--h:0">` sits at the projected rim of the pot, `[-0.17, 0.84, -0.1]`. It holds three `<i style="--sd:3.6s;--sdl:{0|-1.2|-2.4}s">`. The pot's steam sprite in the stove's markup moves into a `<g class="ps-yt-still-steam">`, so both drawings of the stove carry it.

- Produces in `ROOM_MOTION_CSS`:

  - **The mockup's two flickers:**
    - `@keyframes psng-yt-flick { 0%, 100% { opacity: 0.999; } 22% { opacity: 0.86; } 47% { opacity: 0.97; } 63% { opacity: 0.8; } 81% { opacity: 0.94; } }`;
    - `@keyframes psng-yt-flick-b { 0%, 100% { opacity: 0.9; } 30% { opacity: 0.999; } 55% { opacity: 0.75; } 80% { opacity: 0.95; } }`.
  - **The fire's body and the glow:** `#theme-scene.psng.psng-m-hearth .ps-ym-fire-body, #theme-scene.psng.psng-m-hearth .ps-ym-fireglow { animation: psng-yt-flick 2.4s ease-in-out infinite; animation-delay: calc(0s - var(--psng-t)); }`.
  - **The tongues and the lamp's flame:** `#theme-scene.psng.psng-m-hearth .ps-ym-fire-tongues, #theme-scene.psng.psng-m-hearth .ps-ym-flame { animation: psng-yt-flick-b 1.7s ease-in-out infinite; animation-delay: calc(0s - var(--psng-t)); }`.
  - **The fire's layers and the flame fill their boxes;** `.ps-ym-lamp { opacity: var(--ps-in-lamp); }`.
  - **The steam:**
    - `.ps-ym-steam i`: `position: absolute; left: 0; bottom: 0; inline-size: 0.75rem; block-size: 0.75rem; border-radius: 50%; background: radial-gradient(closest-side, rgb(255 255 255 / 55%), transparent); opacity: 0;`;
    - `#theme-scene.psng.psng-m-steam .ps-ym-steam i { animation: ps-smoke-rise var(--sd) linear infinite; animation-delay: calc(var(--sdl) - var(--psng-t)); }`, the smoke group's keyframes (spec §8).
  - **Swaps:**

    - `#theme-scene.psng.psng-m-hearth .ps-yt-still-hearth, #theme-scene.psng.psng-m-steam .ps-yt-still-steam { display: none; }`;
    - `#theme-scene.psng:not(.psng-m-hearth) .ps-ym-fire, #theme-scene.psng:not(.psng-m-hearth) .ps-ym-lamp, #theme-scene.psng:not(.psng-m-steam) .ps-ym-steam { display: none; }`.

    The glow layer has no swap: it is always shown, and only flickers with the class.

- [ ] **Step 1: Write the failing tests.**

  - **`room.ts`:** "draws the fire, the lamp's flame and the steam over the over layer":
    - `.ps-ym-top` holds `.ps-ym-fire` with `.ps-ym-fire-body` then `.ps-ym-fire-tongues`, `.ps-ym-lamp` with one `.ps-ym-flame`, and `.ps-ym-steam` with 3 `<i`;
    - the body's and the tongues' inner markup, joined, equals the still fire's;
    - `ps-yt-still-hearth` occurs twice (fire, flame) and `ps-yt-still-steam` twice (both stove drawings).
  - **`room-motion.ts`:**
    - `hearth` and `steam` each have a hide rule, a lifted rule with `var(--psng-t)` and a still-swap rule, as in Task 3;
    - `psng-yt-flick` and `psng-yt-flick-b` animate opacity only, never at exactly 1 or 0;
    - the glow layer's rule names `.ps-ym-fireglow` under `psng-m-hearth`.

- [ ] **Step 2: Run** the room and room-motion tests. Expected: FAIL.

- [ ] **Step 3: Implement** the Interfaces above.

- [ ] **Step 4: Run** them, then the full suite. Expected: PASS.

- [ ] **Step 5: Look at it:** build, run `ps-yurt.mjs`, and look at noon and 21:00. The fire sits in the door, the lamp's flame on its wick, and the steam rises from the pot. At 21:00 a burst of screenshots shows the warm light around the stove changing.

- [ ] **Step 6: Commit:** `ps: the yurt's hearth — the fire and its glow flicker as in the mockup, the lamp too, steam from the pot`.

### Task 5: The browser checks

**Files:**

- Modify: `tools/scenarios/ps-yurt.mjs`, `tools/scenarios/ps-ng.mjs` (the censuses' groups and the query's census), `tools/scenarios/theme-ps.mjs` (`checkRoom` and its callers)

- [ ] **Step 1: Write the checks.**

  - **`ps-yurt.mjs`** (focus emulation on, as `scene-rest.mjs` does). Its check 4 becomes the animation census in a query:
    1. **Full, at a clear noon:**
       - every running CSS animation's target is inside `.ps-indoor`, none inside `.ps-frost`, and none has an `<svg>` ancestor (`target.closest("svg") === null`);
       - every keyframe touches only `transform` and `opacity` (`effect.getKeyframes()`, ignoring `offset`, `easing` and `composite`);
       - every name is one of `ps-drift`, `ps-twinkle`, `psng-rain-fall`, `ps-flake`, `ps-flash`, `psng-yt-flick`, `psng-yt-flick-b` and `ps-smoke-rise`;
       - `ps-drift`, `psng-yt-flick`, `psng-yt-flick-b` and `ps-smoke-rise` all run.
    2. **Per weather day:** rain runs `psng-rain-fall`, snow `ps-flake`, storm `ps-flash`, and a clear 21:00 `ps-twinkle`.
    3. **Calm** (the scene-motion setting at calm, in the init script's settings): only `ps-drift`, `psng-yt-flick` and `psng-yt-flick-b`.
    4. **Still** (emulated reduced motion): no animation. `.ps-yt-still-hearth` and `.ps-yt-still-clouds` are displayed, and `.ps-ym-fire`, `.ps-ym-cloud` and `.ps-ym-steam` are not.
    5. **A hidden page in a query, then shown:**
       - hidden (the visibility emulation `ps-ng.mjs` uses): `psng-frozen`, no animation, and every `.ps-ym-cloud`'s computed transform the same 1 s apart;
       - shown: animations run again.
    6. **Alignment at every screen size the scenario runs (Review Focus 3):**
       - each `.ps-ym-pane[data-pane=back|left|right]` rect lies inside the rect of `.ps-yt-p-window-<pane>` (±1 px), and the crown pane inside `.ps-yt-p-crown`;
       - `.ps-ym-fire`'s centre lies inside the rect of the over layer's `.ps-yt-stove-over`, within 2 % of the scene's width of its horizontal centre (the door is centred on the stove).
    7. **Visible motion (Review Focus 5):**
       - at full, two frames 300 ms apart differ inside the stove door's rect;
       - at calm they do too;
       - at a clear noon, two frames 500 ms apart differ inside the back pane.
    8. **Phone:** each pane's drops are half the desktop run's (±1). Record them in the run's log and compare across the two runs.
    9. **Screenshots:** noon clear, 21:00 clear, noon rain, noon storm and noon snow.
  - **`ps-ng.mjs`:**
    - `ALL_GROUPS` gains `hearth` and `steam`, and `CALM_GROUPS` becomes `["clouds", "hearth"]`. A channel's root now carries those classes, with no moving element of theirs on the plains.
    - `GROUP_OF` gains `psng-yt-flick` and `psng-yt-flick-b` → `hearth`; inside `.ps-indoor`, `ps-smoke-rise` counts as `steam`.
    - In a query, `frozenCensus(…, true)` becomes "a query runs as a channel does":
      - moving, with the room shown and the plains out, and every running animation inside `.ps-indoor`;
      - a hidden page inside the query gives the frozen census, then thaws;
      - back in `#seance` it moves, as now.
  - **`theme-ps.mjs`:** `checkRoom`'s stopped and frozen checks become `checkRunning`. The room is shown, the plains are out, and none of `VIEW_STATE.running` is outside `.ps-indoor`. This applies at noon, an hour on (shown again) and at golden hour. The publish checks stand.

- [ ] **Step 2: Run, with the dev ircd up:**

  - `node tools/browser-drive.mjs tools/scenarios/ps-yurt.mjs` at 1280 × 800, `--mobile --width=390 --height=844`, `--mobile --width=932 --height=430` and `--width=2560 --height=1080`;
  - `theme-ps.mjs`;
  - `ps-ng.mjs`, and with `--mobile --width=390 --height=844`.

  Run them one at a time (scenarios sharing `#seance` contaminate each other's glyph samples). Expected: every check ok, except `theme-ps.mjs`'s two rim glyph samples that develop's own build fails (1.81 and 2.47; plan 1 task 9).

- [ ] **Step 3: Commit:** `ps: browser checks for the moving yurt — what moves, where, and when it stops`.

### Task 6: The cost

**Files:**

- Modify: `docs/projects/ps-yurt.md` (§11.2), and `client/js/scenes/psng/room-motion.ts` plus its test only if a Step 2 rule applies

- [ ] **Step 1: Measure** in headless Chromium on this machine (the `perf-measure` skill; plan 1's scratch `tmp/yurt-check/perf.mjs` is the model).

  - The figure is the scene's main-thread task load (`scene-rest.mjs`'s `taskLoad`) over 10 s.
  - Each slot compares a query with `#seance` on the same build at the same pinned minute.
  - Slots: full and calm (the setting) at a clear noon, a rainy noon and a clear 21:00; still (reduced motion) in a query.
  - Profiles: 1280 × 800, and the phone profile (390 × 844 `--mobile`, CPU 4×).
  - Three rounds, the slots rotated each round, with the load recorded per run.
  - **The first query's open,** read as in §11.1 (its long frame and `buildRoom`'s profile), against §11.1's figures.

- [ ] **Step 2: Gate and rule.**

  - **Expected:** the query costs no more than the channel at the same tier, within noise, and still costs 3 % or less.
  - **If calm in a query reads over calm in `#seance` beyond noise,** the window clouds leave calm (spec §11):
    - add `#theme-scene.psng.psng-calm .ps-ym-cloud { display: none; }` and `#theme-scene.psng.psng-calm .ps-yt-still-clouds { display: inline; }`;
    - add a room-motion test pinning both;
    - measure again, and record both readings.
  - **If full reads over:**
    - name the largest group: rerun with `thelounge.state.psngGroups` naming all but one;
    - measure the glow layer's own flicker with `.ps-ym-fireglow { animation: none !important; }` injected by the harness;
    - report the figures, and do not tune silently. If the glow's flicker is what crosses the gate, the proposed fix is that the glow stays steady while the fire flickers; it is the user's call.

- [ ] **Step 3: Record** in `ps-yurt.md` §11.2, in §11.1's style: the method, a table, and what it rules out. Include the first open's figures beside plan 1's, and note that the iPhone sitting is the user's.

- [ ] **Step 4: Commit:** `ps: the moving yurt's cost, measured`.

### Task 7: The docs

**Files:**

- Modify: `docs/projects/ps-yurt.md` (status; §8 as built), `docs/resources/ps-theme-map.md`, `docs/resources/themes.md`, `docs/projects/ps-ng.md` (the tiers section), `docs/resources/codebase-guide.md`

- [ ] **Step 1: Update:**

  - **`ps-yurt.md`:**
    - status "plan 2 (motion) built, <date>";
    - §8 gains "As built": the layers and their slots, `--ps-ym-s`, the swap classes, the groups, and the mockup's flicker for the fire;
    - §12's changed-on-purpose list is ticked.
  - **`ps-theme-map.md` and `themes.md`:** the room moves in a query (the groups, the layers), with `ps-yurt.mjs`'s census.
  - **`ps-ng.md`:** one line in its tiers section saying that since ps-yurt plan 2 a query is just another view.
  - **`codebase-guide.md`:** the `ps-yurt.md` entry reads plan 2 built.

- [ ] **Step 2: Run:** `pnpm lint`. Expected: clean.

- [ ] **Step 3: Commit:** `ps: docs — the yurt moves`.
