# ps NG plan 4: the birds and the sun — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the skeins, daybirds and sun groups to ≤ 5 WebContent each on the iPhone and calm to ≤ 24 at every moment, keeping classic's look, so plan 3 can resume at Task 5.

**Architecture:** Build the two fixes whose shape the spec already fixes and that cost a few lines — the sun's fire drawn from a sprite of its own frames, and calm taking its two unused wing copies out of the page (Task 2) — then one phone sitting measures them with the skeins' and daybirds' switches (Tasks 1 and 3). The larks move to HTML state boxes (Task 4) whatever the sitting says; the skeins get the fix the sitting points to (Task 5); then the gate (Task 6).

**Tech Stack:** TypeScript, mocha + chai + sinon, `tools/browser-drive.mjs` scenarios, the gitignored phone harness in the main checkout's `tmp/perf/ng2` (`app/spike.js`, `lib.mjs`, `ios-run.sh`, `run-chrome.mjs`, `summarize.mjs`).

**Spec:** `docs/projects/ps-ng.md` §10 (and §8.3, the numbers it answers). Plans 1–3: `docs/projects/ps-ng-plan-{1,2,3}.md`. Plan 3's ledger: `.superpowers/sdd/ps-ng-plan-3/progress.md`.

## Global Constraints

- Success (§10): WebContent ≤ 5 for each of skeins, daybirds and sun measured alone; calm ≤ 24 at every moment; calm's skeins no dearer than full's; full below classic at every moment; full ≤ 30 reported, not gated.
- Every fix keeps classic's poses, timings and paths (as NG already draws them). The only visible change allowed is the fire at 12 frames a second, only if the sprite fire misses, only with the user's OK on a side-by-side shot.
- Only `transform` and `opacity` animate; no `steps()` timing on any element in the scene; no moving box larger than the viewport; still is `animation: none`, never `pause()` (spec §6, §9). `element.animate` is not a fix on its own.
- NG never imports classic's `scene.ts`; `scene-ps.js` must not load on an NG page.
- Every new animation name goes into both censuses' `GROUP_OF` (`tools/scenarios/ps-ng.mjs:272`, `tmp/perf/ng2/app/spike.js` ~line 80), and every new animated element into the catch-all's `:not(…)` list and the matching `:not(.psng-m-<group>)` rule (`client/js/scenes/psng/styles.ts:35`, `:100–112`) — otherwise it never moves, or its slot reads invalid.
- Phone sittings: tell the user first, Auto-Lock Never, USB, each background job under 45 minutes (the tool's limit), no perf runs while another session is testing. A result that does not fit what the slots predict gets a Safari Web Inspector timeline before a fix is built on it (§10.2).
- A group no fix brings to its target stops the plan with a report before anything less like classic is tried.

## Review Focus

1. A palette change mid-loop: no frame of the old colours is drawn after `setColours` (Task 2).
2. Calm → full → still → full with calm's copies out of the page: every copy's animation and display come back exactly as full's (Task 2's styles test).
3. A lark resumed after a freeze (hidden page, query): its state boxes show the state `--psng-t` puts it in, away from a boundary (Task 4's `ps-ng.mjs` check).
4. The lark's chute and closed poses drawn where classic draws them, not one box lower (Task 4's position rule and its screenshot pair).
5. A canvas with no 2D context: the fire does nothing, as today (Task 2 keeps the existing test).

---

### Task 1: The sitting's switches (harness, no commit)

**Files** (gitignored, main checkout `/Users/rdrake/workspace/afternet/seance/tmp/perf/ng2`):

- Modify: `app/spike.js` (an `x=` switch table beside `nb=`, line 43; `psng-hold0`/`psng-hold1` into `GROUP_OF` as `skeins`)
- Modify: `lib.mjs` (`PLAN4` beside `PLAN3`)
- Modify: `ios-run.sh` (`SHORT=plan4`, beside `SHORT=plan2`, line 23)

**Interfaces:**

- Produces: slots `skeins-nowing`, `skeins-constop`, `daybirds-nolark` in `VARIANTS`, each with an `ok(b)` that proves its switch took; `PLAN4 = ["coffee", "ng-still", "skeins", "skeins-nowing", "skeins-constop", "skeins-calm", "daybirds", "daybirds-nolark", "sun"]` — 9 slots, where `skeins` is plan 2's entry, `skeins-calm` is `t=ps&ng=1&mo=calm&g=skeins` at `MOMENTS.DUSK`, and `sun` and `skeins-calm` are measured on Task 2's build.

- [ ] **Step 1: Add the `x=` switch to `app/spike.js`.** `q.get("x")` is a comma list; each key appends one `<style>` to `<html>` like the `nb=` block, and the page is not `applied` until it is in (as `NF`/`NR`, line 76). Keys (every selector under `#theme-scene.psng`, every rule `!important`):

  - `nowing`: `.ps-skein .psng-pose { animation: none }`, `.ps-skein .psng-pose-0 { opacity: 1 }`
  - `constop`: `.ps-skein .psng-pose { animation-name: psng-hold0 }`, `.ps-skein .psng-pose-0 { animation-name: psng-hold1 }`; `@keyframes psng-hold0 { 0%, 100% { opacity: 0 } }`, `psng-hold1` the same at 1
  - `nolark`: `.ps-lark .ps-lark-fl, .ps-lark .ps-lark-ch, .ps-lark .ps-lark-cl, .ps-lark .psng-pose { animation: none }`

- [ ] **Step 2: Add the slots and `PLAN4` to `lib.mjs`** and `SHORT=plan4` to `ios-run.sh`. Each switch slot's `qs` is its group's baseline (`t=ps&ng=1&mo=full&g=<group>`) plus `&x=<key>`, at the group's moment (`skeins` → `MOMENTS.DUSK`, `daybirds` → `MOMENTS.NOON`). Each `ok(b)` is `ng(<group>, <group>, false)(b)` plus a check on `b.names` (the `name:count` census): `nowing` no `psng-pose4`; `constop` `psng-hold0` and `psng-hold1` present, no `psng-pose4`; `nolark` no `ps-lark-fl`, `-ch`, `-cl`, and `psng-pose2` absent.

- [ ] **Step 3: Chrome preflight** (after Task 2's build is in `app/`): `SLOTS="<PLAN4>" MAXLOAD=50 node run-chrome.mjs 1 > chrome-plan4-pre.jsonl`, then `beaconOk` on each slot's newest beacon in `beacons.jsonl`, as plan 3 did.
      Expected: 9/9 `beaconOk`; `nsanims` against the baseline: `nowing` −152 at dusk, `nolark` −36, `constop` equal (by design; its names prove it).

- [ ] **Step 4: Dry run.** `DRYRUN=1 SHORT=plan4 ./ios-run.sh 2`.
      Expected: 18 items, about 17 minutes.

### Task 2: The sprite fire, and calm's two copies out of the page

**Files:**

- Modify: `client/js/scenes/psng/flame.ts:314–400` (`fireDriver`)
- Modify: `client/js/scenes/psng/styles.ts:249–253` (calm's copies 1 and 3)
- Test: `test/scenes/psng/flame.ts`, `test/scenes/psng/styles.ts`

**Interfaces:**

- Consumes: `fireField`, `fireColours`, `FIRE_SIZE`, `FIRE_FPS_NG` (unchanged).
- Produces: `fireDriver(canvas, after?, cancel?, sprite?)` where `sprite: () => HTMLCanvasElement | OffscreenCanvas | null` defaults to an `OffscreenCanvas` (else a detached `<canvas>`) of `FIRE_SIZE × (FIRE_SIZE · 168)`; the returned object keeps `start`, `stop`, `setColours`, `destroy`, `cachedFrames` and adds `get spriteFrames(): number` (cells filled for the current colours). A `sprite` returning `null` keeps today's `putImageData`-every-paint path.

- [ ] **Step 1: Write the failing tests.**

  - `test/scenes/psng/flame.ts`, with a fake main context and a fake sprite context recording calls:
    - `"draws a frame from its sprite cell after the first time, with no putImageData"`: first paint of frame i → `putImageData` into the sprite at cell i, then `drawImage(sprite, 0, i·160, 160, 160, 0, 0, 160, 160)` on the main context; the next loop's paint of i → `drawImage` only.
    - `"a palette change empties the sprite and repaints the current frame in the new colours"`: fill some cells, `setColours` → `spriteFrames` 0, the current frame's cell refilled with the new LUT before it is drawn.
    - `"with no sprite it paints by putImageData as before"`: `sprite: () => null` → every paint `putImageData` on the main context, `spriteFrames` 0.
    - `"destroy drops the sprite"`: after `destroy()`, `spriteFrames` 0 and a later `start()`… `tick` draws nothing.
      Keep every existing test as it is (they pass no fourth argument, so they now run the sprite path with a fake from their own context factory; adjust only how the fake is made).
  - `test/scenes/psng/styles.ts` `"calm takes wing copies 1 and 3 out of the page"`: the rule for `#theme-scene.psng.psng-calm .ps-bird .psng-pose-1, … .psng-pose-3` sets `display: none` and no longer `animation: none !important`; no rule outside `.psng-calm` sets their `display`.

- [ ] **Step 2: Run them to see them fail.**
      Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/scenes/psng/flame.ts test/scenes/psng/styles.ts`
      Expected: the five new tests FAIL.

- [ ] **Step 3: Implement.** `paint` fills the frame's sprite cell once per colour generation (LUT + `putImageData` into the sprite context at `(0, index · FIRE_SIZE)`), then draws that cell onto the main canvas; the main context's `globalCompositeOperation = "copy"` is set once, so no `clearRect`. `setColours` and `destroy` mark every cell empty (a `Set<number>` of filled indices). Comment the sprite's size (160 × 26,880, about 17 MB). Calm's rule: `display: none` for copies 1 and 3.

- [ ] **Step 4: Run the psng folder.**
      Run: `… npx mocha --config=test/.mocharc.yml 'test/scenes/psng/*.ts'`
      Expected: PASS.

- [ ] **Step 5: Browser check** — `NODE_ENV=production npx webpack`, serve `public/` on 8041, `CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" SEANCE_HTTP_PORT=8041 node tools/browser-drive.mjs tools/scenarios/ps-ng.mjs --out=tmp/ps-ng-shots/plan4-t2`.
      Expected: `ok` on all 86 checks (the fire's frames and calm's exact set included).

- [ ] **Step 6: Two commits**, so Task 3 can revert either alone.

```bash
git add client/js/scenes/psng/flame.ts test/scenes/psng/flame.ts
git commit -m "ps NG: the sun's fire draws each frame from a sprite it fills once, not recoloured every paint"
git add client/js/scenes/psng/styles.ts test/scenes/psng/styles.ts
git commit -m "ps NG: calm takes the two wing copies it never shows out of the page"
```

- [ ] **Step 7: Refresh the harness app** (`tmp/perf/ng2/refresh-app.sh`; it prints the worktree HEAD, which must be the second commit).

### Task 3: The measurement sitting

**Files:**

- Modify: `docs/projects/ps-ng.md` (§10.5)

- [ ] **Step 1: Tell the user** what it needs (Auto-Lock Never, USB, phone untouched, ~17 minutes) and wait for "ready". Start `serve.py` with `nohup … &` from the harness directory.

- [ ] **Step 2: Run it** in the background (timeout 2,700,000 ms): `SHORT=plan4 ./ios-run.sh 2 > ios-plan4.out 2> ios-plan4.err`, then `node summarize.mjs ios ios-2.jsonl <rid>`.
      Expected: 18 valid of 18; coffee ≤ 5 and ng-still ≤ 3 (otherwise the phone was not idle: report and re-run).

- [ ] **Step 3: Read it.**

  - **Skeins:** `constop` near `skeins` means the layers cost; near `nowing` means the swap does.
  - **Daybirds:** `nolark` against `daybirds` shows how much is the larks, against the buzzard.
  - **Calm:** `skeins-calm` against `skeins`.
  - **Sun:** `sun`'s WebContent, against §8.3's 26.2 for the old fire.

- [ ] **Step 4: Decide the sun.**

  - `sun` ≤ 5 WebContent: the sprite fire stays.
  - Otherwise: `FIRE_FPS_NG = 12` on top of the sprite (the tests naming 24 and 168 become 12 and 84), and measure `sun` again in one short job.
  - Still over: revert the sprite commit, keep 12, measure once more.
  - A 12-frame fire ships only after the user approves a classic/NG sun side by side from `ps-ng.mjs`'s pairs.

- [ ] **Step 5: Decide calm.** If `skeins-calm` is above `skeins`, revert the calm commit and report to the user before Task 5.

- [ ] **Step 6: Write §10.5** (date, rid, summarize's table, Step 3's reading, the decisions) and commit.

```bash
git add docs/projects/ps-ng.md
git commit -m "docs: plan 4's measurement sitting"
```

### Task 4: The larks on HTML state boxes

**Files:**

- Modify: `client/js/scenes/psng/poses.ts` (`ngBirds`; new `larkStates(svgMarkup: string): string`)
- Modify: `client/js/scenes/psng/styles.ts` (the catch-all at :35, the `:not(.psng-m-daybirds)` rule at :100–112, the lark delays at :286–291, the `.psng-pose` position rule at :230, new keyframes)
- Modify: `tools/scenarios/ps-ng.mjs` (`GROUP_OF` at :272, one census check, one freeze check)
- Modify: `tmp/perf/ng2/app/spike.js` (`GROUP_OF`, gitignored)
- Test: `test/scenes/psng/poses.ts` (:81 and a new test), `test/scenes/psng/styles.ts` (:125 and a new test), `test/scenes/psng/mount.ts:153`

**Interfaces:**

- Consumes: `poseStack`, `wingTiming` (unchanged).
- Produces: `larkStates(svgMarkup)` → `div.psng-lark-fl` (holding `poseStack` of the flapping wings: far and near up-wing with the body), `div.psng-lark-ch` (one `<svg>`: far and near chute, the body), `div.psng-lark-cl` (one `<svg>`: closed, the body); no `<g class="ps-lark-*">` left. Keyframes `psng-lark-fl-h`, `psng-lark-ch-h`, `psng-lark-cl-h` (group `daybirds`).

- [ ] **Step 1: Write the failing tests and update the old ones.**

  - `test/scenes/psng/poses.ts`, new: `"larkStates: three HTML state boxes, the flap a pose stack, no animated group left"` — per lark one each of `psng-lark-fl`, `-ch`, `-cl`; `psng-lark-fl` holds `wingTiming`'s 2 poses; no `ps-lark-fl`/`-ch`/`-cl` class and no SMIL left; one body path per `<svg>`. Line 81's count of `ps-lark-ch` groups becomes a count of `psng-lark-ch` boxes: 3.
  - `test/scenes/psng/styles.ts`, new: `"the larks' state boxes hold each state from its own stop to the next, on linear keyframes"` — each `-h` keyframe holds `ps-lark-fl`/`-ch`/`-cl`'s value at a stop (0, 63, 69, 73, 80, 82.5) until 0.01 % before the next stop, where it ramps to the next value (classic's `steps(1, end)` changes at the next stop; this ramp ends there, 6.6 ms early on a 66 s cycle, under one frame); the rules say `linear`; no `steps(` anywhere in NG's stylesheet. Line 125's `[daybirds, .ps-lark-fl]` becomes `.psng-lark-fl` (and `-ch`, `-cl` beside it).
  - `test/scenes/psng/mount.ts:153`: `<div class="ps-lark-bird"><div class="psng-lark-fl"><div class="psng-pose psng-pose-0"`.

- [ ] **Step 2: Run them to see them fail.** Expected: FAIL on the new and changed assertions.

- [ ] **Step 3: Implement.**

  - `larkStates` is used by `ngBirds` for the `20 14` svgs.
  - In `styles.ts`:
    - `.psng-lark-fl, .psng-lark-ch, .psng-lark-cl` join the `.psng-pose` rule (`position: absolute; inset: 0`), so the chute and closed poses draw where classic's do;
    - the three boxes replace `.ps-lark-fl`, `-ch`, `-cl` in the catch-all's `:not(…)` list and in the `:not(.psng-m-daybirds)` rule;
    - they run `psng-lark-*-h` on `--ld`, `linear`, with delay `calc(var(--ldl) - var(--psng-t))` under `psng-m-daybirds`, in place of the old `.ps-lark .ps-lark-*` delay selectors.
  - In both `GROUP_OF`s, `psng-lark-fl-h`, `-ch-h` and `-cl-h` become `daybirds`.

- [ ] **Step 4: Run the psng tests.** Expected: PASS.

- [ ] **Step 5: Add to `ps-ng.mjs`:**

  - in the full census (noon, 23:00, storm, dusk), `"no animation runs on an element inside an <svg>"`: no running animation's target has an `<svg>` ancestor inside `#theme-scene`;
  - in the frozen-rest check, at noon, `"each lark shows the state its clock puts it in"`: from the lark's `--ld`, `--ldl` and `--psng-t`, the expected state at that moment, sampled only when it is ≥ 1 % from a stop; that state's box has opacity > 0 and the other two 0, before and after the thaw.

- [ ] **Step 6: Browser check** at the three sizes (desktop, `--mobile --width=390 --height=844`, `--mobile --width=932 --height=430`), and one classic/NG pair of a lark in its chute and closed states for the user.
      Expected: `ok` on every check.

- [ ] **Step 7: Commit.**

```bash
git add client/js/scenes/psng/poses.ts client/js/scenes/psng/styles.ts tools/scenarios/ps-ng.mjs test/scenes/psng/poses.ts test/scenes/psng/styles.ts test/scenes/psng/mount.ts
git commit -m "ps NG: the larks change state on HTML boxes with hard edges, not stepped SVG groups"
```

### Task 5: The skeins, as the sitting says

**Files:** decided by the design the user approves in Step 2.

- [ ] **Step 1: Read the skeins alone.** At ≤ 5 WebContent after Task 2 (calm's fix does not touch full), this task is done. Otherwise `constop` near the baseline means the layers cost, and near `nowing` the swap does. If the numbers fit neither, take a Safari Web Inspector timeline of the `skeins` slot first.

- [ ] **Step 2: Write the fix's design** into the ledger: which elements, which keyframes, what the tests assert.

  - Layers: the four copies on fewer animated layers.
  - Swap: (a) the swap on a flatter tree; (b) a prerendered strip of the four poses per bird, moved by `transform` on hard-edged linear keyframes, never `steps()`.
  - Then get the user's OK. The spec names the fix's shape, not its markup.

- [ ] **Step 3: Build it with TDD** like Task 4, steps 1–4: the new names go into both `GROUP_OF`s and the catch-all.

- [ ] **Step 4: Measure** in a short job: `skeins` and `skeins-calm`, both ≤ 5 WebContent, and calm's no dearer than full's.

- [ ] **Step 5: Browser check** at the three sizes, then commit.

### Task 6: The gate

**Files:**

- Modify: `tmp/perf/ng2/lib.mjs` and `ios-run.sh` (gitignored): `SHORT=gate4a` and `gate4b`. Together they hold plan 3's 14 slots plus `skeins`, `daybirds` and `sun` alone, about 9 slots each.
- Modify: `docs/projects/ps-ng.md` (§10.6); `CLAUDE.md` (the ps NG bullet: the sprite fire, calm's copies, the lark state boxes, whatever skein fix landed).

- [ ] **Step 1: Refresh the harness app** from the worktree HEAD and dry-run both halves.
      Expected: each half about 17 minutes, under 20.

- [ ] **Step 2: Tell the user, then run both halves** as Task 3 did.
      Expected:

  - calm ≤ 24 at noon, night, storm and dusk;
  - full below classic at each moment;
  - `skeins`, `daybirds` and `sun` alone each ≤ 5 WebContent;
  - full against 30, noted.

- [ ] **Step 3: If a criterion fails,** stop and report with the table; this plan builds nothing more.

- [ ] **Step 4: Screenshots:** send the user `ps-ng.mjs`'s classic/NG pairs at dusk and noon.

- [ ] **Step 5: Full suite.** `corepack yarn lint` (0 errors), then mocha (0 failing).

- [ ] **Step 6: Write §10.6 and the CLAUDE.md bullet, commit, push.**

```bash
git add docs/projects/ps-ng.md CLAUDE.md
git commit -m "docs: ps NG plan 4's gate"
git push origin feat/ps-ng
```

Then plan 3 resumes at Task 5 Step 4 (Android), Step 5 (Chrome headed at 120 Hz), Step 6, and Task 6.
