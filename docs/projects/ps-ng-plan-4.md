# ps NG plan 4: the birds and the sun — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the skeins, daybirds and sun groups to ≤ 5 WebContent each on the iPhone and calm to ≤ 24 at every moment, keeping classic's look, so plan 3 can resume at Task 5.

**Architecture:** Measure first (Task 1 builds the switches, Task 3 sits with the phone), build the two fixes the spec already fixes in shape — the sun's fire drawn from cached images (Task 2, before the sitting, so it is measured as it ships) and the larks as HTML copies on hard-edged linear keyframes (Task 4) — then the skeins and calm fixes the sitting picks (Task 5), then the gate (Task 6).

**Tech Stack:** TypeScript, mocha + chai + sinon, `tools/browser-drive.mjs` scenarios, the gitignored phone harness in the main checkout's `tmp/perf/ng2` (`app/spike.js`, `lib.mjs`, `ios-run.sh`, `run-chrome.mjs`, `summarize.mjs`).

**Spec:** `docs/projects/ps-ng.md` §10 (and §8.3, the numbers it answers). Plans 1–3: `docs/projects/ps-ng-plan-{1,2,3}.md`. Plan 3's ledger: `.superpowers/sdd/ps-ng-plan-3/progress.md`.

## Global Constraints

- Success (§10): WebContent ≤ 5 for each of skeins, daybirds and sun measured alone; calm ≤ 24 at every moment; full below classic at every moment; full ≤ 30 reported, not gated.
- Every fix keeps classic's poses, timings and paths (as NG already draws them). The only visible change allowed is the fire at 12 frames a second, only if the image fire misses, only with the user's OK on a side-by-side shot.
- Within a fix list the first fix that meets the target is taken; fixes from different lists combine.
- Only `transform` and `opacity` animate; no `steps()` timing on any running animation in the scene; no moving box larger than the viewport; still is `animation: none`, never `pause()` (spec §6, §9).
- `element.animate` is not a fix on its own (WebKit runs CSS and Web Animations on one engine).
- NG never imports classic's `scene.ts`; `scene-ps.js` must not load on an NG page.
- Phone sittings: tell the user first, Auto-Lock Never, USB, each background job under 45 minutes (the tool's limit; ~13 slots × 55 s each), no perf runs while another session is testing.
- A group no fix brings to its target stops the plan with a report before anything less like classic is tried.

## Review Focus

1. A palette change while cached images are still being made: no frame of the old colours may be drawn after `setColours` (pinned in Task 2).
2. `destroy()` with image work pending: nothing drawn afterwards, every image closed (Task 2).
3. A browser without `createImageBitmap`, or one that rejects it: the fire still paints, as today (Task 2).
4. A lark resumed after a freeze (hidden page, query): its three state wrappers keep the phase `--psng-t` gives them, so the lark is never in two states or none (Task 4's `ps-ng.mjs` check).
5. Calm → full → still with the calm copies changed (Task 5): every copy's animation and display come back exactly as full's (Task 5's styles test).

---

### Task 1: The sitting's switches (harness, no commit)

**Files** (gitignored, main checkout `/Users/rdrake/workspace/afternet/seance/tmp/perf/ng2`):

- Modify: `app/spike.js` (a new `x=` switch table, beside `nb=` at line 43)
- Modify: `lib.mjs` (a `PLAN4` slot list beside `PLAN3`, after line 89)
- Modify: `ios-run.sh` (two `SHORT=plan4a` / `SHORT=plan4b` lists beside `SHORT=plan2`, line 23)

**Interfaces:**

- Produces: slot labels `skeins-nowing skeins-constop skeins-nowander skeins-calm skeins-pose2all daybirds-nolarkg daybirds-nolark daybirds-larkg-linear sun-held sun-bitmap` in `VARIANTS`, each with an `ok(b)` that proves its switch took; `PLAN4A`/`PLAN4B` arrays of ≤ 7 labels each.

- [ ] **Step 1: Add the `x=` switch to `app/spike.js`.** `q.get("x")` is a comma list; each key appends one `<style>` to `<html>` like the `nb=` block. Keys and CSS (all selectors under `#theme-scene.psng`, each rule `!important`):

  - `nowing`: `.ps-skein .psng-pose { animation: none }` and `.ps-skein .psng-pose-0 { opacity: 1 }`
  - `constop`: `.ps-skein .psng-pose { animation-name: psng-hold0 }`, `.ps-skein .psng-pose-0 { animation-name: psng-hold1 }`, with `@keyframes psng-hold0 { 0%, 100% { opacity: 0 } }` and `psng-hold1` the same at 1
  - `nowander`: `.ps-skein .ps-bird { animation: none }`
  - `pose2all`: `.ps-skein .psng-pose { animation-name: psng-pose2 }`
  - `nolarkg`: `.ps-lark .ps-lark-fl, .ps-lark .ps-lark-ch, .ps-lark .ps-lark-cl { animation: none }`
  - `nolark`: `nolarkg`'s rule plus `.ps-lark .psng-pose { animation: none }`
  - `larkg-linear`: `.ps-lark .ps-lark-fl { animation-name: psng-lark-fl-h; animation-timing-function: linear }` (and `-ch`, `-cl` likewise), with `psng-lark-*-h` keyframes holding `ps-lark-fl`/`-ch`/`-cl`'s values (`client/themes/ps.css:1785–1810`) between their percentages, each change 0.01 % wide
    Mark the page not `applied` until the style is in, as `NF`/`NR` do (line 76).

- [ ] **Step 2: Add the slots to `lib.mjs`.** Each `qs` is the group's baseline `qs` (`t=ps&ng=1&mo=full&g=<group>`) plus `&x=<key>`, at the group's moment (`skeins` → `MOMENTS.DUSK`, `daybirds` → `MOMENTS.NOON`); `skeins-calm` is `t=ps&ng=1&mo=calm&g=skeins` at `MOMENTS.DUSK`. Each `ok(b)` is `ng(<cls>, <grp>, false)(b)` plus a check on `b.names` (the `name:count` census) that proves the switch: `nowing` no `psng-pose4`; `constop` `psng-hold0`/`psng-hold1` present, no `psng-pose4`; `nowander` no `ps-bird-wander`; `pose2all` `psng-pose2` count = the baseline's `psng-pose4` count; `nolarkg` no `ps-lark-fl`/`-ch`/`-cl`; `nolark` that and no `psng-pose2`; `larkg-linear` `psng-lark-fl-h` present, no `ps-lark-fl`. `PLAN4A = ["coffee", "ng-still", "skeins", "skeins-nowing", "skeins-constop", "skeins-nowander", "skeins-calm"]`, `PLAN4B = ["skeins-pose2all", "daybirds", "daybirds-nolarkg", "daybirds-nolark", "daybirds-larkg-linear", "sun-held", "sun-bitmap"]`, where `sun-bitmap` is plan 2's `sun` entry (`t=ps&ng=1&mo=full&g=sun` at `MOMENTS.NOON`) measured on Task 2's build, and `sun-held` is `t=ps&ng=1&mo=calm&g=sun` at noon (the spin with the fire held: the floor the image fire is read against; the old fire's 52.3 / 26.2 WebContent is §8.3's). The target is absolute (≤ 5 WebContent), so no slot runs the old fire.

- [ ] **Step 3: Chrome preflight.** `SLOTS="<PLAN4A and PLAN4B>" MAXLOAD=50 node run-chrome.mjs 1 > chrome-plan4-pre.jsonl`, then evaluate `beaconOk` on each slot's newest beacon in `beacons.jsonl`, as plan 3 did.
      Expected: 14/14 `beaconOk`; each switch's `nsanims` differs from its baseline's as its key says (nowing −152 at dusk, nowander −38, nolarkg −30, nolark −36; constop, pose2all, larkg-linear equal). A slot that matches its baseline exactly is a broken switch: fix it before the phone.

- [ ] **Step 4: Dry runs.** `DRYRUN=1 SHORT=plan4a ./ios-run.sh 2` and `SHORT=plan4b`.
      Expected: 14 items each, each under 15 minutes.

### Task 2: The image fire

**Files:**

- Modify: `client/js/scenes/psng/flame.ts:314–400` (`fireDriver`)
- Test: `test/scenes/psng/flame.ts`

**Interfaces:**

- Consumes: `fireField`, `fireColours`, `FIRE_SIZE`, `FIRE_FPS_NG` (unchanged).
- Produces: `fireDriver(canvas, after?, cancel?, toImage?)` where `toImage: (data: ImageData) => Promise<ImageBitmap>` defaults to `(d) => createImageBitmap(d)` when `createImageBitmap` exists, else is absent; the returned object keeps `start`, `stop`, `setColours`, `destroy`, `cachedFrames` and adds `get cachedImages(): number`.

- [ ] **Step 1: Write the failing tests** in `test/scenes/psng/flame.ts`, with a fake 2D context recording `putImageData`/`drawImage`/`clearRect` calls and a `toImage` stub returning promises the test resolves by hand (fake bitmaps carry a `close` spy):

  - `"paints a frame from its cached image once it is made, with no putImageData"`: start, advance one frame, resolve its image, advance a loop → that frame's later paint is `clearRect` + `drawImage`, no `putImageData`.
  - `"paints by putImageData while a frame's image is still being made"`: first paint of a frame before its promise resolves calls `putImageData`.
  - `"a palette change closes every image and never draws one of the old colours"`: resolve images, `setColours` with new colours, then resolve an image requested under the old colours → that image is closed and never drawn; `cachedImages` is 0 right after the change.
  - `"destroy closes every image and draws nothing after"`: images resolved and one pending; `destroy()`, then resolve the pending one → closed, no further context call.
  - `"holds at most one loop of images (168)"`: 400 simulated frames with every promise resolved → `cachedImages` ≤ 168.
  - `"with no toImage it paints by putImageData as before"`: `toImage` undefined → every paint `putImageData`, `cachedImages` 0.
  - `"a rejected toImage leaves that frame on putImageData"`: rejected promise → next paint of that frame `putImageData`, no unhandled rejection.
    Keep every existing test passing unchanged except where they pass a fourth argument.

- [ ] **Step 2: Run them to see them fail.**
      Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/scenes/psng/flame.ts`
      Expected: the seven new tests FAIL (`cachedImages` undefined, `drawImage` never called).

- [ ] **Step 3: Implement in `fireDriver`.** A `Map<number, ImageBitmap>` beside `frames`; `paint` uses the frame's image when it has one (`clearRect(0, 0, FIRE_SIZE, FIRE_SIZE)` then `drawImage(img, 0, 0)`), otherwise today's LUT + `putImageData` and, if `toImage` exists and no request is out for that index, asks for its image from a copy of the `ImageData`. Each request carries the colour generation (a counter bumped by `setColours` and `destroy`); a result from an older generation is closed and dropped. `setColours` and `destroy` close and clear the images. Comment the 17 MB a full loop of images holds at 160 × 160.

- [ ] **Step 4: Run the file, then the psng folder.**
      Run: the Step 2 command, then `… npx mocha --config=test/.mocharc.yml 'test/scenes/psng/*.ts'`
      Expected: PASS, no new warnings.

- [ ] **Step 5: Browser check.** `NODE_ENV=production npx webpack`, serve `public/` on 8041, `CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" SEANCE_HTTP_PORT=8041 node tools/browser-drive.mjs tools/scenarios/ps-ng.mjs --out=tmp/ps-ng-shots/plan4-fire`
      Expected: `ok` on every check (86 of 86 today); the fire's frames check still passes.

- [ ] **Step 6: Commit** (its own commit, so Task 3 can revert it alone).

```bash
git add client/js/scenes/psng/flame.ts test/scenes/psng/flame.ts
git commit -m "ps NG: the sun's fire is drawn from images it keeps, not recoloured every frame"
```

- [ ] **Step 7: Refresh the harness app** (`tmp/perf/ng2/refresh-app.sh`; it prints the worktree's HEAD, which must be this commit).

### Task 3: The measurement sitting

**Files:**

- Modify: `docs/projects/ps-ng.md` (a new §10.5 with the table)

- [ ] **Step 1: Tell the user** what the sitting needs (Auto-Lock Never, USB, phone untouched, ~26 minutes in two halves) and wait for "ready". Start `serve.py` with `nohup … &` from the harness directory.

- [ ] **Step 2: First half.** `SHORT=plan4a ./ios-run.sh 2 > ios-plan4a.out 2> ios-plan4a.err` in the background (timeout 2,700,000 ms). On completion `node summarize.mjs ios ios-2.jsonl <rid>`.
      Expected: 14 valid of 14; coffee ≤ 5 and ng-still ≤ 3 (else the phone was not idle — report before the second half).

- [ ] **Step 3: Second half.** The same with `SHORT=plan4b`.

- [ ] **Step 4: Read the results against §10.3.** Write down, for the ledger: skeins — `constop` near the baseline means the layers cost, near `nowing` means the swap does; `nowander`'s saving; `skeins-calm` and `pose2all` against `skeins`. Larks — what `nolarkg`, `nolark` and `larkg-linear` each save. Sun — `sun-bitmap`'s WebContent against `sun-held`'s.

- [ ] **Step 5: The sun's decision.** `sun-bitmap` WebContent ≤ 5: Task 2 stays. Otherwise `git revert` Task 2's commit, set `FIRE_FPS_NG = 12` in `flame.ts` (update the tests that name 24 and 168 → 84), commit, and measure `sun-bitmap`'s slot again in a third short job; the 12-frame fire ships only after the user approves a classic/NG side-by-side of the sun from `ps-ng.mjs`'s pairs.

- [ ] **Step 6: Write §10.5** (date, rids, the table as summarize prints it, the reading from Step 4, the sun's decision) and commit.

```bash
git add docs/projects/ps-ng.md
git commit -m "docs: plan 4's measurement sitting"
```

### Task 4: The larks on HTML

**Files:**

- Modify: `client/js/scenes/psng/poses.ts` (`ngBirds`, a new `larkStates(svgMarkup: string): string`)
- Modify: `client/js/scenes/psng/styles.ts:255–296` (lark rules and keyframes)
- Modify: `tools/scenarios/ps-ng.mjs` (two census checks)
- Test: `test/scenes/psng/poses.ts`, `test/scenes/psng/styles.ts`, `test/scenes/psng/mount.ts:141–160`

**Interfaces:**

- Consumes: `poseStack`, `wingTiming` (unchanged).
- Produces: `larkStates(svgMarkup)` → `div.psng-lark-fl` (holding `poseStack` of the flapping wings: far and near up-wing, with the body), `div.psng-lark-ch` (one `<svg>`: far and near chute, the body), `div.psng-lark-cl` (one `<svg>`: closed, the body); no `<g class="ps-lark-*">` left; `ngBirds` uses it for the `20 14` svgs.

- [ ] **Step 1: Write the failing tests.**

  - `test/scenes/psng/poses.ts` `"larkStates: three HTML state boxes, the flap a pose stack, no animated group left"`: for each of the 3 lark svgs, one each of `psng-lark-fl`, `-ch`, `-cl`; `psng-lark-fl` holds the poses `wingTiming` finds (2); no `ps-lark-fl`/`-ch`/`-cl` class and no SMIL in the output; the body path appears once per `<svg>`.
  - `test/scenes/psng/styles.ts` `"the larks' state boxes run hard-edged linear keyframes at classic's percentages"`: `NG_STILL_CSS`'s motion rules contain `psng-lark-fl-h`, `-ch-h`, `-cl-h` keyframes whose stops are `ps-lark-fl`/`-ch`/`-cl`'s (63, 69, 73, 80, 82.5) each held to the next with a 0.01 % edge; the rules use `linear`; no `steps(` anywhere in the psng stylesheet.
  - `test/scenes/psng/mount.ts`: the existing lark assertion at line 153 becomes `<div class="ps-lark-bird"><div class="psng-lark-fl"><div class="psng-pose psng-pose-0"`.

- [ ] **Step 2: Run them to see them fail.** Run the three files.
      Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement `larkStates` and the rules.** The state boxes run on `--ld` with delay `calc(var(--ldl) - var(--psng-t))` under `psng-m-daybirds`, replacing the three `.ps-lark .ps-lark-*` selectors at styles.ts:286–291; the pose swap inside `psng-lark-fl` keeps its rule (styles.ts:255). Still/frozen behaviour comes from the existing group-class and `psng-frozen` rules; nothing new there.

- [ ] **Step 4: Run the psng tests.** Expected: PASS.

- [ ] **Step 5: Add the census checks to `ps-ng.mjs`** in the full census (noon, 23:00, storm, dusk): `"no animation runs on an element inside an <svg>"` (every running animation's target has no `<svg>` ancestor inside `#theme-scene`) and `"no running animation uses steps()"` (`getComputedTiming`/`effect.getTiming().easing` and the keyframes' `easing` never start with `steps`); and in the frozen-rest check, at the noon slot, `"each lark shows exactly one state box"` (computed opacity > 0 on exactly one of its three boxes, before and after the thaw).

- [ ] **Step 6: Browser check** at the three sizes (as plan 3: desktop, `--mobile --width=390 --height=844`, `--mobile --width=932 --height=430`).
      Expected: `ok` on every check, the three new ones included.

- [ ] **Step 7: Commit.**

```bash
git add client/js/scenes/psng/poses.ts client/js/scenes/psng/styles.ts tools/scenarios/ps-ng.mjs test/scenes/psng/poses.ts test/scenes/psng/styles.ts test/scenes/psng/mount.ts
git commit -m "ps NG: the larks change state on HTML boxes with hard edges, not stepped SVG groups"
```

### Task 5: The skeins and calm, as the sitting says

**Files:**

- Modify: `client/js/scenes/psng/styles.ts:226–253` (skein rules)
- Test: `test/scenes/psng/styles.ts`

The branch is picked from Task 3 Step 4's reading; take only the branches the numbers point to.

- [ ] **Step 1: Calm's copies.** If `skeins-calm` costs more than `skeins` and `pose2all` does not: write the failing test `"calm takes copies 1 and 3 out of the render tree"` (the rule for `.psng-calm .ps-bird .psng-pose-1, .psng-pose-3` sets `display: none`, no `animation: none !important`; outside `.psng-calm` no rule touches their display), run it (FAIL), change the rule, run the psng tests (PASS). If `pose2all` costs as much as `skeins-calm`, the two-pose timing is the cost: stop and report to the user with the numbers.

- [ ] **Step 2: The wander.** If `nowander` saves more than 5 WebContent: the wander moves onto a layer the birds share only if each bird's path stays classic's; if no such layer exists, report the saving to the user and leave it.

- [ ] **Step 3: Layers or swap.** If after Step 1 the skeins alone are still above 5 WebContent: `constop` near the baseline (layers) or near `nowing` (swap) picks §10.3 item 1's list. Before any code, write the chosen fix's design (which elements, which keyframes, what the tests assert) into the ledger and get the user's OK — the spec names the fix's shape, not its markup. A swap that repaints first gets one solid-fill slot (the gradient's stops literal) in a short job before anything else.

- [ ] **Step 4: Browser check** at the three sizes. Expected: `ok` on every check.

- [ ] **Step 5: Commit** each fix taken on its own.

```bash
git add client/js/scenes/psng/styles.ts test/scenes/psng/styles.ts
git commit -m "ps NG: calm's two wing poses take the other two out of the page"
```

### Task 6: The gate

**Files:**

- Modify: `tmp/perf/ng2/lib.mjs` / `ios-run.sh` (gitignored: `SHORT=gate4a`/`gate4b`, plan 3's 14 slots split 7 + 7, plus each fixed group alone at its moment in whichever half is shorter)
- Modify: `docs/projects/ps-ng.md` (§10.6), `CLAUDE.md` (the ps NG bullet: the image fire, the lark state boxes, whichever skein/calm fix landed)

- [ ] **Step 1: Refresh the harness app** from the worktree HEAD and dry-run both halves (each under 15 minutes).

- [ ] **Step 2: Tell the user, then run both halves** on the iPhone as Task 3 did.
      Expected: calm ≤ 24 at noon, night, storm and dusk; full below classic at each; each fixed group alone ≤ 5 WebContent; full against 30 noted.

- [ ] **Step 3: If a criterion fails,** stop and report with the table; nothing more is built in this plan.

- [ ] **Step 4: Screenshots for the user:** `ps-ng.mjs`'s classic/NG pairs at dusk and noon (`tmp/ps-ng-shots/plan4-gate*/contact-*.png`), sent to the user for the look.

- [ ] **Step 5: Full suite.** `corepack yarn lint` (0 errors) and mocha (0 failing).

- [ ] **Step 6: Write §10.6 and the CLAUDE.md bullet, commit, push.**

```bash
git add docs/projects/ps-ng.md CLAUDE.md
git commit -m "docs: ps NG plan 4's gate"
git push origin feat/ps-ng
```

Then plan 3 resumes at Task 5 Step 4 (Android), Step 5 (Chrome headed at 120 Hz), Step 6, and Task 6.
