# ps NG plan 5: calm in budget, cheaper skeins — Implementation Plan

> **Outcome (2026-10-18):** Task 3's wing strips were reverted after the iPhone gate (spec §11.4); the rest shipped, with calm cut to two sky clouds.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calm moves the clouds alone; the skeins lose their per-bird wander and fly on wing strips; one iPhone gate decides whether the strip stays.

**Architecture:** Calm is one array (`psng/groups.ts`). The wander is classic's `ps-bird-wander` on `.ps-bird`, deleted with NG's rules for it. A strip wraps a skein bird's existing pose stack (`poseStack`, untouched) in one `div.psng-strip` laid out side by side inside the bird's box, clipped, and moved by one `translateX` loop with discrete holds. The old opacity stack's keyframes stay until the gate (the harness's `x=stack` brings it back for comparison); Task 5 deletes the loser.

**Tech Stack:** TypeScript (DOM-free scene modules), CSS in `psng/styles.ts` template strings and `client/themes/ps.css`, mocha + chai, `tools/browser-drive.mjs` scenarios, the gitignored iPhone harness in `tmp/perf/ng2`.

**Spec:** `docs/projects/ps-ng.md` §11 (with §6, §9, §10.5, §10.6).

## Global Constraints

- Branch `feat/ps-ng-5` in the worktree `tmp/psng`; never stage `shells/capacitor/android/capacitor.settings.gradle`, `shells/capacitor/ios/App/CapApp-SPM/Package.swift` or `shells/capacitor/tools/ios-device.sh`. No AI co-author trailers.
- Only `transform` and `opacity` animate; no moving box larger than the viewport; no animated element inside an `<svg>`; never `steps()` (WebKit runs stepped timing on the main thread).
- Every NG loop's delay is moved by `--psng-t`; a wingbeat iteration is `POSE_BEATS` (80) beats.
- `birds.ts` keeps drawing `--wx`/`--wy`/`--wd`/`--wdl` from its seeded stream (dropping the draws reshapes every V); `test/scenes/ps/birds.ts` keeps its pinned values.
- Larks keep their pose stacks (`psng-pose2`); only the skeins get strips.
- The `psng-calm` class stays on the root in calm (the Auto checks read it).
- Browser scenarios: `CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" SEANCE_HTTP_PORT=8121 SEANCE_PORT=8121`, `public/` served on 8121, the dev ircd up; run `ps-ng.mjs` alone (it hangs when started right after another scenario).
- Mocha one file: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml <file>`.

## Review Focus

1. **A still scene's bird** (reduced motion, Still, a query, a hidden page): the strip at rest shows pose 0 and only pose 0 — not three neighbours poking out of the clip, not a blank box. Pinned in Task 3 (`ps-ng.mjs` still census: each `.ps-bird`'s visible pose box is `psng-pose-0`).
2. **A rest and its resume** (freeze pins the running transform inline): a frozen strip holds one whole pose, and thawing resumes at the clock's phase. Pinned in Task 3 (the existing freeze/thaw check covers `.psng-strip` once it is in `GROUP_OF`).
3. **The larks by day** are unchanged: still pose stacks, `psng-pose2`, under `psng-m-daybirds`. Pinned in Task 1 (`GROUP_OF`) and Task 3 (the `ngBirds` count test).
4. **Calm on a wet day** (a phone, storm): calm shows two sky clouds and no wet-weather clouds, no rain, snow, seeds or flash in the page. Pinned in Task 1 (calm census at the storm moment).
5. **A stored `thelounge.state.psngGroups`** naming groups calm no longer has (e.g. `smoke`): calm runs nothing, not smoke. Pinned by the existing "`only` cannot add a group the tier lacks" test, extended in Task 1.

---

### Task 1: Calm moves the clouds alone

**Files:**

- Modify: `client/js/scenes/psng/groups.ts:27`
- Modify: `client/js/scenes/psng/styles.ts` — delete the calm seed rules (`#theme-scene.psng.psng-calm .ps-seeds` in the display-none list, and `#theme-scene.psng.psng-calm .ps-seeds i { animation: none }`), and the calm pose rules (`psng-m-skeins.psng-calm … animation-name: psng-pose2` and `psng-calm .ps-bird .psng-pose-1, -3`)
- Modify: `client/components/Settings/Appearance.vue:557` (the calm hint)
- Modify: `tools/scenarios/ps-ng.mjs` — header comment (lines 88–93), `CALM_GROUPS` (line 300), `GROUP_OF["psng-pose2"]` → `"daybirds"`, the calm census `want` (lines ~538–544: drop the `weather:ps-seed` filter and the `psng-pose4`→`psng-pose2` mapping), add a calm census at the storm moment
- Test: `test/scenes/psng/groups.ts`, `test/scenes/psng/styles.ts`

**Interfaces:**

- Produces: `groupsFor("calm")` = `{"clouds"}`.

- [ ] **Step 1: Change the tests.** `test/scenes/psng/groups.ts`: rename "full runs every group, calm five, still none" to "full runs every group, calm the clouds, still none", expecting `[...groupsFor("calm")]` to deep-equal `["clouds"]`; add to "`only` cannot add a group the tier lacks": `expect(groupsFor("calm", new Set<Group>(["smoke", "weather"])).size).to.equal(0)`. `test/scenes/psng/styles.ts`: assert `NG_STILL_CSS` and the motion CSS contain no `psng-calm .ps-seeds` and no `psng-calm .ps-bird`.
- [ ] **Step 2: Run them; expect FAIL** (calm still has five groups; the calm rules are present).
- [ ] **Step 3: Implement.** `const CALM: readonly Group[] = ["clouds"];`; delete the four calm rules listed above. Hint copy, exactly: `calm: "the clouds drift; the rest holds still"`.
- [ ] **Step 4: Run** both test files, then `corepack yarn lint`. Expected: PASS, lint clean.
- [ ] **Step 5: Browser check.** `corepack yarn build`, then `node tools/browser-drive.mjs tools/scenarios/ps-ng.mjs` (env above) and `--mobile --width=390 --height=844`. Expected: every check passes; the calm census lists `psng-calm psng-m-clouds` and only `clouds:*` animations at noon and in the storm.
- [ ] **Step 6: Words and commit.** §6's calm row in `docs/projects/ps-ng.md` becomes `| calm | clouds; everything else still (plan 5, §11.1) | ≤ 24 |`; the CLAUDE.md ps NG bullet's calm clause ("calm for Calm (clouds, smoke, weather without the seeds, skeins on two wing poses, the sun's spin with the fire on its last frame; …)") becomes "calm for Calm (the clouds alone; …)". `git commit -m "ps NG: calm moves the clouds alone"`.

### Task 2: The skeins' birds hold their places

**Files:**

- Modify: `client/themes/ps.css:1597-1606` — the `animation:` line of `#theme-scene .ps-bird` and `@keyframes ps-bird-wander` (keep `position: absolute` and the comment above becomes "Each bird holds its place in the line; the skein's sway moves them together.")
- Modify: `client/js/scenes/psng/styles.ts` — `.ps-bird` out of the `:not(…)` exemption list, `#theme-scene.psng:not(.psng-m-skeins) .ps-bird` out of the still list, the `psng-m-skeins .ps-bird { animation-delay … --wdl … }` rule deleted
- Modify: `tools/scenarios/ps-ng.mjs` — `GROUP_OF["ps-bird-wander"]` and the `["skeins", ".ps-bird"]` delay part (line ~541) deleted
- Test: `test/scenes/psng/styles.ts:117` (the `.ps-bird` delay expectation), `test/themes/ps.ts:3422` (`ps-bird-wander` in the birds' `FRAMES` list) and `:3501` (the `.ps-bird` animation expectation, which becomes `undefined`)

- [ ] **Step 1: Change the tests.** Drop the `.ps-bird` delay expectation; add `it("no bird wanders: ps-bird-wander is gone from ps.css and NG", …)` asserting `ps.css` text and the motion CSS contain no `ps-bird-wander` and NG's CSS no `.ps-bird {` animation rule. Keep `test/scenes/ps/birds.ts` as it is.
- [ ] **Step 2: Run; expect FAIL** on the new test.
- [ ] **Step 3: Implement** the deletions above.
- [ ] **Step 4: Run** `test/scenes/psng/styles.ts`, `test/scenes/ps/birds.ts`, `test/themes/ps.ts`, then `corepack yarn lint`. Expected: PASS.
- [ ] **Step 5: Browser check** as Task 1 Step 5 (desktop only). Expected: all pass; no `ps-bird-wander` in any census.
- [ ] **Step 6: Commit** `ps NG: the skeins' birds hold their places in the V`.

### Task 3: Wing strips

**Files:**

- Modify: `client/js/scenes/psng/poses.ts` — new `wingStrip`, used by `ngBirds` for skein birds
- Modify: `client/js/scenes/psng/styles.ts` — `stripKeyframes`, the strip rules
- Modify: `tools/scenarios/ps-ng.mjs` — `GROUP_OF["psng-strip4"] = "skeins"`, the delay parts gain `["skeins", ".psng-strip"]` and lose `["skeins", ".psng-pose"]`, the still census's pose-0 check, the header
- Test: `test/scenes/psng/poses.ts`, `test/scenes/psng/styles.ts`

**Interfaces:**

- Consumes: `poseStack(svgMarkup, poses)`, `wingTiming(svgMarkup)` (poses.ts, unchanged), `POSE_BEATS` (styles.ts).
- Produces: `wingStrip(svgMarkup: string): string` — `<div class="psng-strip" style="--wdur:<beat>s;--wbegin:<begin>s">` + `poseStack(…)` + `</div>`; markup without wing timing comes back unchanged. `stripKeyframes(name: string, poses: number, gap = 1): string`. Keyframe name `psng-strip4`.

- [ ] **Step 1: Write the failing tests.** `test/scenes/psng/poses.ts`:
  - `it("wingStrip: one psng-strip around the bird's pose stack, carrying its beat and begin", …)` — on the first `viewBox="0 0 32 20"` svg of the fixture: exactly one `class="psng-strip"`, its style has `--wdur:${t.beat}s` and `--wbegin:${t.begin}s`, and inside it `poseStack(svg, t.poses)` verbatim; `wingStrip("<svg></svg>")` returns its input.
  - Extend the `ngBirds` count test (line 75): still `38 * 4 + 3 * 2` pose boxes, plus `38` `psng-strip` wrappers, and no lark inside a strip.
    `test/scenes/psng/styles.ts`:
  - `stripKeyframes("psng-strip4", 4)` has `POSE_BEATS * 4` holds; within beat 0 the holds are `translateX(0%)`, `translateX(-100%)`, `translateX(-200%)`, `translateX(-300%)` in order, each hold's two stops at `start` and `next − 0.0001` (`at()`'s 4-decimal rounding), the last stop `100%`; the text has no `steps(`.
  - The motion CSS: `#theme-scene.psng.psng-m-skeins .psng-strip` animates `psng-strip4 calc(var(--wdur) * 80) linear infinite` with delay `calc(var(--wbegin) - var(--psng-t) - var(--wdur))`; `.ps-bird` in NG has `overflow: clip`; `.psng-strip` is in the exemption list and in `:not(.psng-m-skeins)`'s still list; no rule animates `.ps-bird .psng-pose` with `psng-pose4` any more, and `@keyframes psng-pose4` is still present (the gate's `x=stack`).
- [ ] **Step 2: Run; expect FAIL** (`wingStrip`/`stripKeyframes` not defined).
- [ ] **Step 2b: Measure the wings' reach.** classic draws a bird's `<svg>` with `overflow: visible` (`test/themes/ps.ts:3496`), so a wing may reach outside the bird's box, where a clip on the box would cut it. In the running app at dusk, for every `.ps-skein .ps-bird` and each of its four `.psng-pose` boxes, compare the union of its paths' `getBoundingClientRect()` with the bird's box; record the largest overhang on each side as a fraction of the bird's width and height. Within the box: Step 5's clip is `overflow: clip` as written. Outside it: the poses are spaced `--psng-gap` bird widths apart (`left: calc(var(--pi) * var(--psng-gap) * 100%)`, holds `translateX(${-j * gap * 100}%)`, `gap` = 1 + 2 × the largest horizontal overhang, rounded up to 0.25) and the bird is clipped with `overflow: clip` on a `div.psng-strip-clip` wrapper inset by the overhangs (negative `inset`) instead of on `.ps-bird`. Write the measured overhangs and the chosen `gap` into the commit message.
- [ ] **Step 3: Implement `wingStrip`** and switch `ngBirds`'s skein replace (`viewBox="0 0 32 20"`) to it.
- [ ] **Step 4: Implement `stripKeyframes`** beside `poseKeyframes`, the same loop with `poses` holds per beat, hold `j` = `transform: translateX(${-j * gap * 100}%)`.
- [ ] **Step 5: The rules** (NG's motion CSS, after the existing pose rules so equal specificity wins):
  - `#theme-scene.psng .ps-bird { overflow: clip; }`
  - `#theme-scene.psng .psng-strip { position: absolute; inset: 0; }`
  - `#theme-scene.psng .psng-strip .psng-pose { left: calc(var(--pi) * 100%); right: auto; width: 100%; opacity: 1; }`
  - the animation rule from Step 1; `${stripKeyframes("psng-strip4", 4)}`
  - delete `#theme-scene.psng.psng-m-skeins .ps-bird .psng-pose { animation: psng-pose4 … }` (keep `poseKeyframes("psng-pose4", 4)`), and `.ps-bird .psng-pose` from the still list; add `.psng-strip` to the exemption list and `#theme-scene.psng:not(.psng-m-skeins) .ps-bird .psng-strip` to the still list.
- [ ] **Step 6: Run** both test files, `test/scenes/psng/*.ts`, then `corepack yarn lint`. Expected: PASS.
- [ ] **Step 7: Browser check.** Build; `ps-ng.mjs` desktop, `--mobile --width=390 --height=844` and `--mobile --width=932 --height=430`. Add to the still census: for each `.ps-skein .ps-bird`, the one `.psng-pose` whose box intersects the bird's box is `psng-pose-0`. Expected: all pass at 23:00 and dusk (`psng-strip4` under skeins, every strip box within the viewport, none inside an `<svg>`), the frozen and thawed phases within the existing tolerances.
- [ ] **Step 8: Look.** Take the scenario's dusk screenshot pair against `feat/ps-ng`'s (the contact sheet); the birds draw whole, flapping, nothing clipped at a wing tip. If a wingtip is clipped, Step 2b's overhang was under-measured: re-measure, do not widen the bird.
- [ ] **Step 9: Commit** `ps NG: the skeins flap on wing strips, one animation a bird`.

### Task 4: The gate (the user's phone, about 25 minutes)

**Files (gitignored harness, `tmp/perf/ng2`):**

- Modify: `app/spike.js` — `X.stack`: the strip off and the opacity stack back: `#theme-scene.psng .psng-strip { animation: none !important; } #theme-scene.psng .psng-strip .psng-pose { left: 0 !important; } #theme-scene.psng .psng-strip .psng-pose:not(.psng-pose-0) { opacity: 0 !important; } #theme-scene.psng.psng-m-skeins .psng-strip .psng-pose { animation: psng-pose4 calc(var(--wdur) * 80) linear infinite !important; animation-delay: calc(var(--wbegin) - var(--psng-t) + (var(--pf) - 1) * var(--wdur)) !important; }`
- Modify: `lib.mjs` — `calm-noon`/`calm-storm` `ok` checks expect calm = clouds (`ng("calm", "clouds", false)`); `skeins` expects `psng-strip4` and no `psng-pose4`; new `skeins-stack` (skeins, `MOMENTS.DUSK`, `x=stack`, ok: `psng-pose4` present, `psng-strip4` absent); `GATE5 = ["coffee", "ng-still", "calm-noon", "calm-storm", "skeins", "skeins-stack", "full-dusk"]`
- Modify: `ios-run.sh` — `SHORT=gate5`
- Modify: `docs/projects/ps-ng.md` — new §11.4 with the results

- [ ] **Step 1: Refresh the harness app** (`tmp/perf/ng2/refresh-app.sh`; it prints the worktree HEAD, which must be Task 3's commit) and dry-run `gate5` in Chrome: every slot's `ok` passes.
- [ ] **Step 2: Ask the user** to tether the phone (USB, Auto-Lock Never, charger), saying it takes about 25 minutes. Wait for the go.
- [ ] **Step 3: Run** `SHORT=gate5 ./ios-run.sh 2`, then `node summarize.mjs ios <out>.jsonl`.
- [ ] **Step 4: Write §11.4**: the table (sum, WebContent, GPU, backboardd, n) and against §11.3: calm noon and storm ≤ 24 (gated); skeins and skeins-stack WebContent (≤ 5 reported); full dusk against 92.2. Commit `docs: ps NG plan 5's gate`.
- [ ] **Step 5: Stop and report** to the user: pass or fail on calm, and which wing build won. If calm fails, the spec's fallback is fewer clouds in calm — that is the user's call, not this task's.

### Task 5: Keep the winner

**Files:**

- Modify: `client/js/scenes/psng/styles.ts`, `poses.ts`, their tests, `tools/scenarios/ps-ng.mjs`, `docs/projects/ps-ng.md` (§9's pose-stack sentences, §11.4's verdict), CLAUDE.md's ps NG bullet

- [ ] **Step 1 (strip won, `skeins` WebContent below `skeins-stack`'s):** delete `poseKeyframes("psng-pose4", 4)` and its `GROUP_OF` entry; the styles test's "`psng-pose4` still present" becomes "absent". CLAUDE.md: "every wingbeat a stack of pose copies swapped by `opacity`" becomes "a skein bird's wingbeat a strip of its four poses slid inside a clip, a lark's a stack of pose copies swapped by `opacity`"; the "the cranes never glide" sentence stays, and "the birds no longer wander" joins the list of what differs from classic.
- [ ] **Step 1 (stack won):** revert Task 3's commit (`git revert`), keep Tasks 1–2; CLAUDE.md gains only "the birds no longer wander".
- [ ] **Step 2: Run** `corepack yarn test` (lint + mocha) and `ps-ng.mjs` desktop. Expected: lint clean, 0 failing, every check passes.
- [ ] **Step 3: Commit and push** `ps NG: <the winner> stays` and `git push -u origin feat/ps-ng-5`.
