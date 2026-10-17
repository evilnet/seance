# ps NG plan 3 — Auto, the gate, and classic retired — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Scene animation" setting's Auto follow the device (a touch phone, and low power), prove NG within budget on three platforms, then make NG the only ps renderer and delete classic.

**Architecture:** `tierFor` (`client/js/scenes/psng/tiers.ts`) gains two inputs on `SceneHostState`, `phone` and `lowPower`, fed by the scene host (`client/js/themeScene.ts`). `phone` comes from two media queries; `lowPower` from a small Vue-free `client/js/helpers/power.ts` (one tested rule and a merge of the latest reading per source), wired to the Battery API, to one new field on the Android shell's existing `SystemAccessibility` plugin, and on iOS to whichever of a frame probe or a native report Task 4's measurement picks. A measured gate stands before the flip; the flip and classic's deletion are one commit, with the test refactors it needs landed just before it.

**Tech Stack:** TypeScript, Vue 3, mocha + chai + sinon, Capacitor 8 (Java on Android; Swift on iOS only if Task 4 needs it), `tools/browser-drive.mjs` scenarios, the phone harness in the main checkout's `tmp/perf/ng2`.

**Spec:** `docs/projects/ps-ng.md` (§6 Tiers, §8 Performance gates, decision 8). Plans 1 and 2: `docs/projects/ps-ng-plan-1.md`, `docs/projects/ps-ng-plan-2.md`. Red team of this plan (Codex and ponytail, 2026-10-17) folded in.

## Decisions taken for this plan (the user, 2026-10-17)

1. **Auto by device**, replacing spec §6's "Auto is full unless a power signal says otherwise":

   | Auto on…                                                         | normal power | low power |
   | ---------------------------------------------------------------- | ------------ | --------- |
   | a phone: `PHONE_LAYOUT_QUERY` **and** `(pointer: coarse)` match  | calm         | still     |
   | anything else (desktop at any width, tablet, a mouse-driven PWA) | full         | calm      |

   A narrow desktop window stays Full. An iPad in split view narrow enough for the phone layout counts as a phone (touch); accepted. Full, Calm and Still chosen by hand ignore device and power. The forced-still states (hidden, at rest, query, reduced motion) win over everything, as now.

2. **Low power is two signals only:** a battery discharging below 20 % (the Battery API, where a browser has it), and the system's battery saver — Android's battery saver, iOS's Low Power Mode. **Thermal state and data saver are dropped** from spec §6.
3. **iOS: measure first, build one.** Task 4 measures whether Low Power Mode caps WebKit's frames at 30 fps, in Safari and in the shell, before any iOS code is written.
4. **Plan 2's 18-slot iPhone sitting is folded into Task 5's gate.**
5. The drawer lag at Full on a phone (measured 2026-10-17, `06e3ff67`) is left: under Auto a phone is Calm or Still.

## Global Constraints

- Budgets (iPhone 16, Safari, WebContent + GPU + backboardd, % of a core): **full ≤ 30, calm ≤ 24, still ≤ 3** (spec §6). Ceilings, not targets.
- Battery rule: **`!charging && level < 0.2`**.
- Every signal is watched live: a change re-tiers a mounted scene without a reload.
- `nativeCall` (`client/js/helpers/capacitor.ts:70`) **resolves `null`** for a browser, a shell without the plugin, or a failed call; it never rejects. Treat `null` as "no reading".
- Modules mocha loads stay free of Vue, the store and the DOM (`power.ts`, `tiers.ts`); no Node built-ins in `client/`.
- Size anything new in the UI in `rem`.
- localStorage keys stay `thelounge.*`; stored `psAnimation` values are read, never rewritten.
- Until Task 6, the host defaults to classic (`themeScene.ts:117`): every browser or device check of NG before Task 6 sets `settings.psRenderer = "ng"` (and `thelounge.state.psngPreview = "1"` where Settings must show it).
- Type-check is not part of `yarn lint`. Run `npx tsc -p client/tsconfig.json --noEmit` (clean today) and `npx tsc -p test/tsconfig.json --noEmit` (69 errors today, all pre-existing: JSON imports and `tools/pages-site.mjs`; a task may add none).
- Measure before deploying or claiming a perf result, with the scene on screen; sum WebContent + GPU + backboardd on iOS; host load < 2.5 or the run labelled rank-only.
- iPhone phone time per sitting **≤ ~30 minutes**; tell the user before a sitting starts.
- `shells/capacitor/tools/ios-device.sh` is an untracked copy — never commit it. After `cap sync`, revert `shells/capacitor/android/capacitor.settings.gradle` and `shells/capacitor/ios/App/CapApp-SPM/Package.swift`.
- No AI credit trailers, no model names in commits.

## Review Focus

1. **A rotation, a resize, or a mouse plugged into a tablet** while a scene runs: the tier changes at once. Pinned in Task 1 (`setDevice` forwards a change, ignores a repeat; the hook listens to both queries' `change`).
2. **No reading at all** — a browser without `getBattery` (Safari, Firefox, possibly Android's WebView), a shell built before `powerSave`: `lowPower` is false, nothing throws. Pinned in Task 2 (`null` sources).
3. **The battery boundary:** charging at 5 % is not low power; discharging at exactly 20 % is not; at 19 % it is. Pinned in Task 2.
4. **A setting chosen by hand on a phone:** Full on a phone at low power is Full. Pinned in Task 1's truth table.
5. **Two sources disagreeing in either order:** the battery says fine, the system says saver — low power, whichever arrived last. Pinned in Task 2 (the merge).
6. **Someone who chose Classic in the preview:** after Task 6 their stored `psRenderer: "classic"` is ignored and they get NG (`store-settings.ts:21` applies only declared settings). Pinned in Task 6 Step 3.
7. **A slow device read as Low Power Mode** (only if Task 4 builds the frame probe): it goes Still, and the probe looks again every 2 minutes while it says low power, so a passing slowdown does not stick. Pinned in Task 4 branch A.

---

### Task 1: Auto follows the device

**Files:**

- Modify: `client/js/themeScene.ts` (`SceneHostState` :55, `SceneHost` :85, `createSceneHost`, the `themeScene` initial state :283, `installThemeSceneHooks` :386)
- Modify: `client/js/scenes/psng/tiers.ts`
- Modify: `client/components/Settings/Appearance.vue:590` (Auto's description)
- Modify: `docs/projects/ps-ng.md` §6 (the Auto paragraph becomes Decisions 1's table and Decision 2's two signals)
- Test: `test/scenes/psng/tiers.ts`, `test/tests/themeScene.ts`, `tools/scenarios/ps-ng.mjs`

**Interfaces:**

- Produces: `SceneHostState` gains `phone: boolean; lowPower: boolean`. `SceneHost.setDevice(device: Partial<{phone: boolean; lowPower: boolean}>): void` — calls `handle?.update({...state})` once, only when a value changed. `tierFor(state, reduceMotion)` keeps its signature.
- Consumes: `PHONE_LAYOUT_QUERY` from `client/js/helpers/device.ts`.

- [ ] **Step 1: Extend the truth table in `test/scenes/psng/tiers.ts`**

Add loops over `phone` and `lowPower` (both `[true, false]`), put them in `state`, and compute:

```ts
const auto = phone ? (lowPower ? "still" : "calm") : lowPower ? "calm" : "full";
const want =
  still || motion === "still"
    ? "still"
    : motion === "calm"
    ? "calm"
    : motion === "full"
    ? "full"
    : auto;
```

and change the count to `expect(rows).to.equal(256)`.

- [ ] **Step 2: Add a host test in `test/tests/themeScene.ts`**

`it("setDevice re-tiers a mounted scene, and a repeat is no update")`: mount the fake module as the neighbouring `setMotion` test does, call `h.setDevice({phone: true})`, `h.setDevice({phone: true})`, `h.setDevice({lowPower: true})`; with `seen` logging `${st.phone} ${st.lowPower}`, expect `["mount false false", "update true false", "update true true"]`.

- [ ] **Step 3: Run both, see them fail**

Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/scenes/psng/tiers.ts test/tests/themeScene.ts`
Expected: FAIL (wrong tier for `auto` rows; `setDevice` is not a function).

- [ ] **Step 4: Implement**

`tierFor`: after the forced-still check, `full` → full, `calm` → calm, `auto` → Decisions 1's table. `setDevice` in `createSceneHost`. Initial state `phone: false, lowPower: false` in every `SceneHostState` literal (grep `motion: "auto"` in `client/` and `test/`). `installThemeSceneHooks`: `const layout = matchMedia(PHONE_LAYOUT_QUERY)`, `const touch = matchMedia("(pointer: coarse)")`, `const syncPhone = () => themeScene.setDevice({phone: layout.matches && touch.matches})`, called once and on both queries' `change`. Classic ignores both fields. Auto's text in Appearance.vue: `"follows your device: Full on a computer or tablet, Calm on a phone, one step less on low power"`.

- [ ] **Step 5: Run the two files, lint and both type-checks**

Expected: PASS; lint clean; `client` 0 errors, `test` 69.

- [ ] **Step 6: Browser check**

`corepack yarn build`. In `tools/scenarios/ps-ng.mjs`, every existing check that expects Full's groups sets `psAnimation: "full"` explicitly (on a `--mobile` run Auto is now Calm). Add: with `psAnimation: "auto"`, on `--mobile` (touch emulated) the scene carries `psng-calm`; on the desktop viewport it does not; on a desktop viewport resized to 390 × 844 without touch, still no `psng-calm`.
Run: `node tools/browser-drive.mjs tools/scenarios/ps-ng.mjs`, then `--mobile --width=390 --height=844`.
Expected: every check passes on both.

- [ ] **Step 7: Commit**

```bash
git add client/js/themeScene.ts client/js/scenes/psng/tiers.ts client/components/Settings/Appearance.vue docs/projects/ps-ng.md test/scenes/psng/tiers.ts test/tests/themeScene.ts tools/scenarios/ps-ng.mjs
git commit -m "ps NG: Auto follows the device — Calm on a touch phone, Full elsewhere"
```

### Task 2: Low power from the battery

**Files:**

- Create: `client/js/helpers/power.ts`
- Modify: `client/js/themeScene.ts` (`installThemeSceneHooks` wires it)
- Test: `test/helpers/power.ts`, `tools/scenarios/ps-ng.mjs`

**Interfaces:**

- Consumes: `SceneHost.setDevice` (Task 1).
- Produces (Tasks 3 and 4 feed the `saver` source):

  - `export interface PowerReadings {battery: {charging: boolean; level: number} | null; saver: boolean | null}`
  - `export function lowPowerFrom(r: PowerReadings): boolean` — `r.saver === true || (r.battery !== null && !r.battery.charging && r.battery.level < 0.2)`.
  - `export function createPowerMerge(set: (low: boolean) => void): {update(part: Partial<PowerReadings>): void}` — keeps the latest value per source (both start `null`), calls `set(lowPowerFrom(...))` on the first update and then only when the answer changes.

- [ ] **Step 1: Write `test/helpers/power.ts`**

Separate `it`s:

- `lowPowerFrom`: charging 0.05 → false; discharging 0.2 → false; discharging 0.19 → true; `saver: true` with battery `null` → true; both `null` → false.
- The merge: `update({battery: {charging: false, level: 0.5}})` then `update({battery: {charging: false, level: 0.1}})` → `set` calls `[false, true]`.
- Either order: `update({saver: true})` then `update({battery: {charging: true, level: 0.9}})` → `[true]` (the battery's reading does not cancel the saver); then `update({saver: false})` → `[true, false]`. And the battery first, the saver second, same final answers.
- A repeat that does not change the answer calls `set` no more.

- [ ] **Step 2: Run, see it fail**

Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/helpers/power.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement and wire**

`power.ts` as the interface says. In `installThemeSceneHooks`, inline (untested wiring, the house pattern of `systemAccessibility.ts`): `const power = createPowerMerge((lowPower) => themeScene.setDevice({lowPower}))`; if `navigator.getBattery` exists, read the battery once and on `chargingchange`/`levelchange`, a rejection leaving `battery` `null`; otherwise `power.update({battery: null})` so the merge answers once.

- [ ] **Step 4: Run the test file, lint, both type-checks**

Expected: PASS; lint clean; type-check counts unchanged.

- [ ] **Step 5: Browser check**

In `tools/scenarios/ps-ng.mjs` (desktop, `psRenderer: "ng"`, `psAnimation: "auto"`): an init script defines `navigator.getBattery` resolving a fake battery (discharging, 0.5) with a hook that sets `level` and fires `levelchange`. No `psng-calm`; level 0.1 → `psng-calm` within 500 ms; 0.5 → gone.
Run: `corepack yarn build && node tools/browser-drive.mjs tools/scenarios/ps-ng.mjs`
Expected: every check passes.

- [ ] **Step 6: Commit**

```bash
git add client/js/helpers/power.ts client/js/themeScene.ts test/helpers/power.ts tools/scenarios/ps-ng.mjs
git commit -m "ps NG: a battery below 20 % takes Auto one step down"
```

### Task 3: Android's battery saver, on the existing plugin

**Files:**

- Modify: `shells/capacitor/android/app/src/main/java/chat/seance/app/SystemAccessibilityPlugin.java` (`status()` :88, `load()`, `handleOnDestroy()`, the class Javadoc)
- Modify: `client/js/helpers/systemAccessibility.ts:48` (`AndroidSystemStatus` gains `powerSave?: boolean`)
- Modify: `client/js/themeScene.ts` (`installThemeSceneHooks`)

**Interfaces:**

- Consumes: `onAndroidSystemStatus` (`systemAccessibility.ts:73`; replays the last report to a late listener, nothing outside the Android shell), Task 2's merge.
- Produces: `status()` and every `changed` event carry `powerSave` (`PowerManager.isPowerSaveMode()`).

- [ ] **Step 1: Implement**

Java: `result.put("powerSave", powerManager().isPowerSaveMode())`; in `load()` register a `BroadcastReceiver` for `PowerManager.ACTION_POWER_SAVE_MODE_CHANGED` that calls `notifyListeners("changed", status())`; unregister it in `handleOnDestroy()`; one line in the Javadoc's list. TS: `onAndroidSystemStatus((s) => { if (s.powerSave !== undefined) power.update({saver: s.powerSave}); })` beside Task 2's wiring (a shell without the field leaves `saver` `null`).

- [ ] **Step 2: Build and install on the emulator**

Per the `android-emulator-workflow` memory: `corepack yarn build`, `cd shells/capacitor && corepack yarn sync`, Gradle `assembleDebug`, `adb install -r`; revert the two sync-touched files.
Expected: the app launches.

- [ ] **Step 3: Verify the signal reaches the scene**

In the app: ps theme, `psRenderer` `ng`, `psAnimation` `auto`. With `tmp/tools/cdp.mjs` on the WebView: `adb shell dumpsys battery unplug` (a charging emulator refuses battery saver), then `adb shell cmd power set-mode 1`; read `nativeCall("SystemAccessibility","status")`'s `powerSave` (must be `true` before looking further) and `#theme-scene`'s classes: no `psng-m-` class (still). `set-mode 0` → `psng-calm` back. Finally `adb shell dumpsys battery reset`.
Expected: each change within 2 s, no reload.

- [ ] **Step 4: Commit**

```bash
git add shells/capacitor/android/app/src/main/java/chat/seance/app/SystemAccessibilityPlugin.java client/js/helpers/systemAccessibility.ts client/js/themeScene.ts
git commit -m "Android shell: battery saver takes the ps scene's Auto one step down"
```

### Task 4: iOS Low Power Mode — measure, then build one

**Step 1 decides the branch. Build only what it says.**

- [ ] **Step 1: Measure (≤ 5 minutes of the user's phone, USB, tell the user first)**

Through `ios_webkit_debug_proxy` and a `wk.mjs` copy matching each page: sample 120 `requestAnimationFrame` intervals into a global, poll it (WebKit ignores `awaitPromise`), take the median. Four readings: Safari on the harness page (`http://<mac>:8113/?t=coffee`, served by `tmp/perf/ng2/serve.py` in the main checkout) and the installed shell (debug build, inspectable), each with Low Power Mode off and on (the user toggles it).
Expected: four medians. A median ≥ 28 ms with Low Power Mode on and ~16.7 ms off is "the cap shows" for that context. Write the four numbers into spec §6.

- [ ] **Branch A — the cap shows in both Safari and the shell: a frame probe, no Swift**

Files: `client/js/helpers/power.ts` (add `export function framesSayLowPower(median: number): boolean` → `median >= 28`), `test/helpers/power.ts`, `client/js/themeScene.ts`.
Tests: 33 → true, 17 → false, 8.3 → false.
Wiring: on iOS only (Safari or the shell: `/iPhone|iPad/` in the user agent or `nativePlatform() === "ios"`), sample 30 intervals at start and when the page becomes visible, and every 2 minutes while the last sample said low power; feed `power.update({saver})`. Spec §6 gains one line: on iOS a device too slow to keep 60 fps counts as low power.
Verify: the Step 1 toggle again on the phone, Safari and shell, reading `#theme-scene`'s classes: on → still, off → calm within 2 minutes or on the next return to the page.

- [ ] **Branch B — no cap in the shell: a native report, in `SceneDelegate.swift`**

Files: `shells/capacitor/ios/App/App/SceneDelegate.swift` only — no new file, no `project.pbxproj` edit. In it: `class PowerPlugin: CAPPlugin, CAPBridgedPlugin` (`identifier = "PowerPlugin"`, `jsName = "Power"`, `pluginMethods = [CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)]`, `@objc func status(_ call: CAPPluginCall)` resolving `["lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled]`, `load()` observing `.NSProcessInfoPowerStateDidChange` and calling `notifyListeners("changed", data:)` on the main queue), and `class BridgeViewController: CAPBridgeViewController` with `override func capacitorDidLoad() { bridge?.registerPluginInstance(PowerPlugin()) }`; `window?.rootViewController = BridgeViewController()`. TS: in the shell on iOS, `nativeCall("Power","status")` (a `null` is no reading) and `nativeListen("Power","changed", …)` → `power.update({saver: s.lowPower})`. Capacitor 8 (`shells/capacitor/package.json:24`).
Verify: simulator build (`xcodebuild … -destination 'platform=iOS Simulator,name=iPhone 17 Pro' … CODE_SIGNING_ALLOWED=NO` → `** BUILD SUCCEEDED **`); in the simulator `Capacitor.nativePromise("Power","status",{})` resolves `{lowPower: false}` (read through a global); then on the phone (install with `ios-device.sh`, the user toggles Low Power Mode): calm → still → calm without a reload. If Safari showed the cap but the shell did not, also do Branch A for Safari only.

- [ ] **Branch C — no cap anywhere and the user does not want the plugin:** record it in spec §6 ("iOS has no low-power signal; an iPhone is Calm under Auto") and stop.

- [ ] **Last step: lint, type-checks, commit**

```bash
git add <the branch's files> docs/projects/ps-ng.md
git commit -m "ps NG: iOS Low Power Mode takes Auto one step down"   # or "docs: iOS Low Power Mode measured" for branch C
```

### Task 5: The three-platform gate

No product code. Spec §8.3: before the default flips, iPhone, Android and Chrome against classic in the same session, within the budgets.

**Files:**

- Modify: `/Users/rdrake/workspace/afternet/seance/tmp/perf/ng2/lib.mjs` (gitignored harness in the **main checkout**, outside the worktree; add the slots below to `VARIANTS`)
- Modify: `docs/projects/ps-ng.md` (a new §8.3 with the tables)

- [ ] **Step 0: Merge `fix/psng-fire-pace` into `feat/ps-ng`**

The branch (pushed, three commits, 2026-10-17) is what the gate must measure: the sun's fire waking 24 times a second instead of on every screen refresh (it cost a 120 Hz desktop about 15 % of a core), the yurt's fade, and a rest that freezes the scene in place and resumes from there. `ps-ng.mjs` will conflict with Task 6's edits only if Task 6 comes first; here it merges cleanly or with small hand fixes. Update spec §9.1 (the phase is the clock minus the time spent frozen) and the CLAUDE.md ps NG bullet (a rest freezes; reduced motion, Still and the drawer snap). Run `test/scenes/psng/*.ts` and `ps-ng.mjs` desktop; expected PASS (86/86 on the branch).

- [ ] **Step 1: Refresh the harness's app and preflight**

`NODE_ENV=production corepack yarn build` in the worktree; `rsync -a public/ <main>/tmp/perf/ng2/app/` and put `<script src="spike.js"></script>` back as the first line of `<head>` in `app/index.html`. Slots, with explicit `mo=` so Auto's device rule never chooses: `coffee`, `ng-still`, and for each of four moments — `noon` `2026-09-25T12:30`, `night` `2026-09-25T23:30`, `storm` `2026-07-19T12:00`, `dusk` `2026-05-14T20:45` (plan 2's three-flock skeins) — `full-<m>`, `calm-<m>`, `classic-<m>`: **14 slots**. `DRYRUN=1 SLOTS="…" ./ios-run.sh 2` prints the playlist and duration (14 × 2 × 50 s + 45 s ≈ 24 min). One Chrome round through `run-chrome.mjs` with the same slots must give a valid beacon for every slot, and each slot's beacon records the groups running (`#theme-scene`'s `psng-m-` classes); `dusk` must show `skeins`, `storm` must show `weather`.
Expected: dry run prints 28 items and ≤ 30 min; the Chrome round is 14/14 valid with those groups.

- [ ] **Step 2: iPhone sitting (Safari, USB, ≤ 30 min)**

Tell the user first. `SLOTS="…" ./ios-run.sh 2`, then `node summarize.mjs ios ios-2.jsonl <rid>`. Then one reading in the shell (owed since plan 1): the installed app at `full-noon`, 15 s of Activity Monitor.
Expected: every NG slot within its budget with ≥ 2 valid readings.

- [ ] **Step 3: If a tier is over budget**

Run plan 2's ladder (`SHORT=plan2`) at that moment only, to name the group, and stop: a group's fallback (spec decision 2) is a new plan. Report to the user.

- [ ] **Step 4: Android** — a real phone if the user has one tethered, else the emulator rank-only on a host with load < 2.5: `droid-plan2.sh` with the same 14 slots.
      Expected: NG's full below classic's at each moment.

- [ ] **Step 5: Chrome, headed, on the laptop's 120 Hz screen** — not headless. Headless renders at 60 Hz in a 1512 × 900 window, and on 2026-10-17 it showed NG cheaper than classic while the user's Chrome on the built-in XDR display (120 Hz, 3024 × 1964) showed the reverse: anything that wakes per screen refresh costs twice as much there. Run `run-chrome.mjs`'s slots with `headless: false`, the window full-screen on the built-in display, the Mac on its charger with **Low Power Mode off** (it slows the CPU and inflates every percentage), 5 rounds, load gate 2.5. Each slot records the median `requestAnimationFrame` interval; it must be ~8.3 ms, or the slot is not at 120 Hz and is re-run. Windows open on the user's screen: tell the user first and run while they are away from the Mac. Cost per slot is renderer + GPU process CPU, as Chrome's Task Manager counts them (the user's reference reading: classic 12–18 %, NG after the fire fix 11–15 %, with Low Power Mode on).
      Expected: NG's full at or below classic's at each moment; every slot at ~8.3 ms.

- [ ] **Step 6: Write §8.3 and commit**

```bash
git add docs/projects/ps-ng.md
git commit -m "docs: ps NG's three-platform gate"
```

### Task 6: NG becomes ps; classic is deleted

Spec decision 8: the default flips and classic goes **in one commit** (Step 4). Steps 1–3 are refactors that keep that commit reviewable; they change no behaviour. Only after Task 5 passed and the user has said go.

**Keep:** NG plays classic's `animation` declarations and `@keyframes` in `ps.css` (`ps-twinkle`, `ps-spin`, `ps-drift`, `ps-ffdrift`, `ps-ffblink`, `ps-smoke-rise`, `ps-sway`, `ps-skein-fly`, `ps-skein-west`, `ps-skein-sway`, `ps-bird-wander`, `ps-buzz-drift`, `ps-lark-fly/-fl/-ch/-cl`, `ps-flake`, `ps-seed`, `ps-flash`, `ps-shimmer`). Only the rules listed in Step 4 go.

**Interfaces:**

- Produces: `SCENES = {ps: () => import(/* webpackChunkName: "scene-ps" */ "./scenes/psng/scene")}`. Gone: `PsRenderer`, `normalizePsRenderer`, `sceneKey`, `SceneHost.setRenderer`, the `psRenderer` setting, the `thelounge.state.psngPreview` flag, `layerGates`, `overcastBuilder`'s fade argument. NG's files stay under `scenes/psng/` with their `psng` names.

- [ ] **Step 1: Shared test stand-in (refactor commit)**

`git mv test/scenes/ps/standin.ts test/scenes/standin.ts`; re-point its importers (`test/scenes/ps/mount.ts`, `test/scenes/psng/mount.ts:20`). Run `test/scenes/**/*.ts`; expected PASS. Commit: `test: the scene stand-in page is shared by both renderers' tests`.

- [ ] **Step 2: Tests that will outlive classic stop reading it (refactor commit)**

- `test/scenes/psng/mount.ts`: the "publishes what classic publishes" loop (:217–236) becomes one pinned moment (noon, 21 June) asserting NG's own published values as literals captured now; delete "NG then classic on the same root" and the `mountClassic` import.
- `test/scenes/ps/{scene,grounds,layers}.ts` and `test/themes/ps.ts:34`: import from `scenes/ps/markup` / `scenes/ps/watchers`, not `scenes/ps/scene`.
- `test/themes/ps.ts:3010` ("sways the blades…") and `:3206` (the windy duration): assert on NG's wrapper — `.psng-sway`'s animation in `psng/styles.ts` names `ps-sway`, and `@keyframes ps-sway` in `ps.css` still contains `skewX(`.
- `tools/scenarios/ps-ng.mjs` `mountNgAt` (:525): remount by switching the theme to coffee and back to ps after setting the clock, not by `setRenderer`, so each phase check keeps a fresh mount day.
  Run: mocha on `test/scenes/**/*.ts test/themes/ps.ts`, and `ps-ng.mjs` desktop. Expected: PASS. Commit: `test: ps NG's tests stand on their own`.

- [ ] **Step 3: The scenarios' classic-only checks, marked (no commit yet)**

Prepare, in the working tree, the scenario edits Step 4 needs: `theme-ps.mjs` drops the stepper clock sampling (:755–850), the stopped/running check by `animationsPaused` (:1000–1095), the heat haze (:2960–3070) and the cloud fade (:3564), and its chunk check expects `js/scene-ps.js` (now NG's) fetched once and `scene-ps-ng.js` never; `ps-scene-settings.mjs`: Calm is `psng-calm` with only calm's groups, Still no `psng-m-` class, Full the moment's groups; `scene-rest.mjs`: a rested page has no `psng-m-` class and input brings them back; `ps-ng.mjs`: drop the radio pair, `setRenderer`, the preview flag (:188), the backdrop-equals-classic check, "switch to classic", the classic `ps-hot` check, the classic half of the screenshot pairs and contact sheet, and "no `scene-ps.js`". `theme-ps.mjs` boots once with `psRenderer: "classic"` stored and expects NG's scene (Review Focus 6).

- [ ] **Step 4: The flip and the deletion (the one commit)**

- `themeScene.ts`: the `SCENES` above; remove `PsRenderer`, `normalizePsRenderer`, `sceneKey`, `setRenderer`, the host's `renderer`; the top comment no longer says calm steps once a second.
- `settings.ts`: remove `psRenderer` and its import; the `psAnimation` comment names `psng/tiers.ts`. `Appearance.vue`: remove the "Scene renderer" radios (:353–374), `psngOffered`, and `storage` if unused.
- Delete `client/js/scenes/ps/scene.ts`, `client/js/scenes/ps/stepper.ts`, `test/scenes/ps/stepper.ts`, `test/scenes/ps/mount.ts`. Remove `layerGates` (`layers.ts`) and its tests (`test/scenes/ps/layers.ts:251+`), and `overcastBuilder`'s fade branch (`watchers.ts`; `build(weather)` takes no flag; update NG's call at `psng/scene.ts:175`). `test/tests/themeScene.ts`: `SCENES` keys `["ps"]`, the renderer block (:449–560) deleted.
- `ps.css`, by selector: `.ps-overcast-set.ps-arriving` / `.ps-leaving`; the `.ps-blades .ps-sway` animation and the windy blades' rule (keep `@keyframes ps-sway`); `.ps-hot .ps-ground`; the `animation: ps-drop` declaration and `@keyframes ps-drop` (keep the rest of `.ps-rain i`); `.ps-heat-haze`; both `.ps-paused` rules; the `transition` declarations on scene elements that NG's `transition: none !important` overrides. Fix comments naming classic's `scene.ts`. `test/themes/ps.ts`: remove the assertions on `ps-paused` (:2657), `ps-hot`/haze (:3182–3201), the overcast fade (:3378–3395), the paused flash (:3426) and `ps-drop` (:3431–3484).
- Docs: `CLAUDE.md` — merge the ps and ps NG bullets into one ps bullet for the one renderer (no stepper, no `psRenderer`, no preview flag; Auto by device and power; keep the chrome, words and palette text); `docs/resources/themes.md:50–52` and `docs/projects/ps-theme.md` (:140, :190, :253, §10.3–10.4): say NG replaced classic's scene machinery and point to `ps-ng.md`; `docs/projects/ps-ng.md`: status line "NG is the ps scene; classic deleted <date>", decision 8 done.

Run: `corepack yarn test`, both type-checks, `NODE_ENV=production corepack yarn build`, then `theme-ps.mjs`, `ps-scene-settings.mjs`, `scene-rest.mjs`, `ps-ng.mjs` (desktop), `theme-ps.mjs` and `ps-ng.mjs` with `--mobile --width=390 --height=844`, `ps-ng.mjs` with `--mobile --width=932 --height=430`.
Expected: lint clean, 0 failing, type-check counts unchanged, every scenario check passes; report the counts.

```bash
git add -A client test tools/scenarios docs CLAUDE.md
git status --short   # nothing under shells/capacitor may be staged
git commit -m "ps: NG is the ps scene; the classic renderer is deleted"
```

- [ ] **Step 5: On the iPhone**

Install with `shells/capacitor/tools/ios-device.sh`; tell the user. Expected: the ps theme draws, Calm under Auto on the phone, and Settings → Appearance shows no renderer choice.
