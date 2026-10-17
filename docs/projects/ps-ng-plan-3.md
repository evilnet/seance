# ps NG plan 3 — Auto, the gate, and classic retired — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Scene animation" setting's Auto follow the device (phone layout and power), prove NG within budget on three platforms, then make NG the only ps renderer and delete classic.

**Architecture:** `tierFor` (`client/js/scenes/psng/tiers.ts`) gains two inputs on `SceneHostState`, `phone` and `lowPower`, fed by the scene host (`client/js/themeScene.ts`): `phone` from the phone-layout media query, `lowPower` from a new Vue-free `client/js/helpers/power.ts` that combines the Battery API, data saver and a native `Power` plugin (Android `PowerManager`, iOS `ProcessInfo`). A measured gate stands between that and the flip; the flip and classic's deletion are one commit.

**Tech Stack:** TypeScript, Vue 3, mocha + chai + sinon, Capacitor 7 (Java plugin on Android, Swift `CAPBridgedPlugin` on iOS), `tools/browser-drive.mjs` scenarios, the `tmp/perf/ng2` phone harness.

**Spec:** `docs/projects/ps-ng.md` (§6 Tiers, §8 Performance gates, decision 8). Plans 1 and 2: `docs/projects/ps-ng-plan-1.md`, `docs/projects/ps-ng-plan-2.md`.

## Decisions taken for this plan (the user, 2026-10-17)

1. **Auto by device**, replacing spec §6's "Auto is full unless a power signal says otherwise":

   | Auto on…                             | normal power | low power |
   | ------------------------------------ | ------------ | --------- |
   | phone layout (`isPhoneLayout()`)     | calm         | still     |
   | anything else (desktop, tablet, PWA) | full         | calm      |

   Full, Calm and Still chosen by hand ignore device and power. The forced-still states (hidden, at rest, query, reduced motion) win over everything, as now.

2. **Plan 2's 18-slot iPhone sitting is folded into Task 6's gate:** tiers at noon, night and storm against classic and coffee; the per-group ladder only for a tier over budget.
3. The drawer lag at Full on a phone (measured 2026-10-17, `06e3ff67`) is left: under Auto a phone is Calm or Still.

## Global Constraints

- Budgets (iPhone 16, Safari, WebContent + GPU + backboardd, % of a core): **full ≤ 30, calm ≤ 24, still ≤ 3** (spec §6). Ceilings, not targets.
- Battery threshold: **discharging and level < 0.2** (spec §6 "discharging below 20 %").
- iOS hot: `ProcessInfo.thermalState` **`.serious` or `.critical`**. Android hot: `PowerManager.getCurrentThermalStatus() >= THERMAL_STATUS_SEVERE` (API 29+; below 29, never hot).
- Every signal is watched live (spec §6): a change re-tiers a mounted scene without a reload.
- Modules mocha loads stay free of Vue, the store and the DOM (`power.ts`, `tiers.ts`); no Node built-ins in `client/`.
- Size anything new in the UI in `rem`.
- localStorage keys stay `thelounge.*`; stored `psAnimation` values are read, never rewritten (spec §6).
- Measure before deploying or claiming a perf result: iPhone **and** Android with the scene on screen; sum WebContent + GPU + backboardd on iOS; host load gated (< 2.5) or the run labelled rank-only.
- iPhone phone time per sitting: **≤ ~30 minutes**, the user's limit; tell the user before a sitting starts.
- `shells/capacitor/tools/ios-device.sh` is an untracked copy — never commit it. After `cap sync`, revert `shells/capacitor/android/capacitor.settings.gradle` and `shells/capacitor/ios/App/CapApp-SPM/Package.swift`.
- No AI credit trailers, no model names in commits.

## Review Focus

1. **A rotation or window resize across the phone breakpoint** while a scene runs: the tier changes at once (a landscape phone stays phone layout by the short-side rule). Pinned in Task 1 (`setDevice` forwards a change, ignores a repeat; the hook listens to the query's `change`).
2. **A browser with no Battery API, no `navigator.connection`, or a shell without the `Power` plugin** (an older Android build, a browser tab): `lowPower` is false and nothing throws. Pinned in Task 2.
3. **The boundaries:** charging at 5 % is not low power; discharging at exactly 20 % is not; at 19 % it is. Pinned in Task 2.
4. **A setting chosen by hand on a phone:** Full on a phone at low power is Full. Pinned in Task 1's truth table.
5. **A native report that arrives after a web one, or the reverse:** the newest reading of each source is kept and combined, never the last report alone. Pinned in Task 2 (`followPower` with two sources in either order).
6. **Someone who chose Classic in the preview**: after Task 7 their stored `psRenderer: "classic"` is ignored and they get NG, with no error and no empty scene. Pinned in Task 7 Step 5 (`theme-ps.mjs` boots with whatever `settings` holds; add `psRenderer: "classic"` to its stored settings).

---

### Task 1: Auto follows the device

**Files:**

- Modify: `client/js/themeScene.ts` (`SceneHostState` :55, `SceneHost` :85, `createSceneHost`, the `themeScene` initial state :283, `installThemeSceneHooks` :386)
- Modify: `client/js/scenes/psng/tiers.ts`
- Modify: `client/components/Settings/Appearance.vue:590` (Auto's description)
- Modify: `docs/projects/ps-ng.md` §6 ("Auto is full unless…" becomes Decisions 1's table)
- Test: `test/scenes/psng/tiers.ts`, `test/tests/themeScene.ts`

**Interfaces:**

- Produces: `SceneHostState` gains `phone: boolean; lowPower: boolean`. `SceneHost.setDevice(device: Partial<{phone: boolean; lowPower: boolean}>): void` — updates the mounted handle with the new state only when a value changed. `tierFor(state, reduceMotion)` keeps its signature.
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

`it("setDevice re-tiers a mounted scene, and a repeat is no update")`: mount the fake module as the neighbouring `setMotion` test does, call `h.setDevice({phone: true})`, `h.setDevice({phone: true})`, `h.setDevice({lowPower: true})`; expect `seen` (logging `${st.phone} ${st.lowPower}`) to equal `["mount false false", "update true false", "update true true"]`.

- [ ] **Step 3: Run both, see them fail**

Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/scenes/psng/tiers.ts test/tests/themeScene.ts`
Expected: FAIL (type errors or wrong tier for `auto` rows; `setDevice` is not a function).

- [ ] **Step 4: Implement**

`tierFor`: after the forced-still check, `full` → full, `calm` → calm, `auto` → the table in Decisions 1. `createSceneHost`: `setDevice` merges, compares, and calls `handle?.update({...state})` once if anything changed. Initial state `phone: false, lowPower: false` everywhere a `SceneHostState` literal exists (grep `motion: "auto"`). `installThemeSceneHooks`: `const phone = window.matchMedia(PHONE_LAYOUT_QUERY)`, `themeScene.setDevice({phone: phone.matches})` and the same on its `change` event. Classic ignores both fields. Appearance.vue Auto's text: `"follows your device: Full on a computer or tablet, Calm on a phone, one step less on low power"`.

- [ ] **Step 5: Run the two files, then `corepack yarn lint`**

Expected: PASS; lint clean.

- [ ] **Step 6: Browser check**

`corepack yarn build`, then `node tools/browser-drive.mjs tools/scenarios/ps-ng.mjs` and `--mobile --width=390 --height=844`. The mobile run's "the moment's groups running" checks assume Full under Auto; with Auto now Calm on a phone, set `psAnimation: "full"` in the scenario's mobile setup where it checks Full, and add one check: on the phone viewport with `psAnimation: "auto"`, the scene carries `psng-calm`; on the desktop viewport, it does not.
Expected: all checks pass on both viewports.

- [ ] **Step 7: Commit**

```bash
git add client/js/themeScene.ts client/js/scenes/psng/tiers.ts client/components/Settings/Appearance.vue docs/projects/ps-ng.md test/scenes/psng/tiers.ts test/tests/themeScene.ts tools/scenarios/ps-ng.mjs
git commit -m "ps NG: Auto follows the device — Calm on a phone, Full elsewhere"
```

### Task 2: Power signals on the web, and the native contract

**Files:**

- Create: `client/js/helpers/power.ts`
- Modify: `client/js/themeScene.ts` (`installThemeSceneHooks` wires it)
- Test: `test/helpers/power.ts`

**Interfaces:**

- Consumes: `SceneHost.setDevice` (Task 1); `nativeCall`, `nativeListen` from `client/js/helpers/capacitor.ts`.
- Produces (Tasks 3 and 4 implement the native side of this contract): native plugin **`Power`**, method `status()` → `{lowPower: boolean; hot: boolean}`, event `"changed"` with the same object.

  - `export interface PowerReadings {battery?: {charging: boolean; level: number}; saveData?: boolean; native?: {lowPower: boolean; hot: boolean}}`
  - `export function lowPowerFrom(r: PowerReadings): boolean` — true when `native.lowPower || native.hot || saveData || (battery && !battery.charging && battery.level < 0.2)`.
  - `export interface PowerEnv {getBattery?: () => Promise<BatteryLike>; connection?: ConnectionLike; native: {call(): Promise<{lowPower: boolean; hot: boolean}>; listen(cb: (s: {lowPower: boolean; hot: boolean}) => void): void}}` where `BatteryLike` has `charging`, `level`, `addEventListener("chargingchange" | "levelchange", fn)` and `ConnectionLike` has `saveData?` and `addEventListener("change", fn)`.
  - `export function followPower(env: PowerEnv, set: (low: boolean) => void): void` — reads every source, keeps the newest reading per source, calls `set` with `lowPowerFrom` whenever the combined answer changes (and once at the first reading). A source that is missing or rejects is left out, never thrown.
  - `export function browserPowerEnv(): PowerEnv` — the real one (`navigator.getBattery`, `navigator.connection`, `nativeCall("Power", "status")`, `nativeListen("Power", "changed", …)`).

- [ ] **Step 1: Write `test/helpers/power.ts`**

Tests (each a separate `it`):

- `lowPowerFrom`: `{battery: {charging: true, level: 0.05}}` → false; `{battery: {charging: false, level: 0.2}}` → false; `{battery: {charging: false, level: 0.19}}` → true; `{saveData: true}` → true; `{native: {lowPower: false, hot: true}}` → true; `{}` → false.
- `followPower` with no battery, no connection and a native `call` that rejects: `set` is called once with `false` (after `await` of a tick), and nothing throws.
- `followPower` with a fake battery (discharging, 0.5) then `level = 0.1` + `levelchange`: `set` calls are `[false, true]`.
- Two sources in either order: native resolves `{lowPower: true, hot: false}`, then the battery reports charging 0.9 → stays `[true]` (the battery's reading does not cancel the native one); then the native `changed` reports `{lowPower: false, hot: false}` → `[true, false]`.
- A repeat reading that does not change the answer calls `set` no more.

- [ ] **Step 2: Run, see it fail**

Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/helpers/power.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `client/js/helpers/power.ts` and wire it**

In `installThemeSceneHooks`: `followPower(browserPowerEnv(), (lowPower) => themeScene.setDevice({lowPower}))`. In a browser `nativeCall` rejects (no bridge) — that is the "missing source" path.

- [ ] **Step 4: Run the test file and `corepack yarn lint`**

Expected: PASS; lint clean.

- [ ] **Step 5: Browser check of the Battery path**

Add to `tools/scenarios/ps-ng.mjs` (desktop): an init script that defines `navigator.getBattery` returning a fake battery (discharging, 0.5) with a test hook to fire `levelchange`; with `psAnimation: "auto"`, the scene has no `psng-calm`; set level 0.1 and fire → `psng-calm` within 500 ms; back to 0.5 → gone.
Run: `corepack yarn build && node tools/browser-drive.mjs tools/scenarios/ps-ng.mjs`
Expected: all checks pass.

- [ ] **Step 6: Commit**

```bash
git add client/js/helpers/power.ts client/js/themeScene.ts test/helpers/power.ts tools/scenarios/ps-ng.mjs
git commit -m "ps NG: low power (battery, data saver, the shells' Power plugin) takes Auto one step down"
```

### Task 3: The Android shell's `Power` plugin

**Files:**

- Create: `shells/capacitor/android/app/src/main/java/chat/seance/app/PowerPlugin.java`
- Modify: `shells/capacitor/android/app/src/main/java/chat/seance/app/MainActivity.java:18` (register beside `SystemAccessibilityPlugin`)

**Interfaces:**

- Produces: the `Power` contract of Task 2 (`@CapacitorPlugin(name = "Power")`, `@PluginMethod status`, `notifyListeners("changed", …)`).

- [ ] **Step 1: Implement `PowerPlugin`**

Model it on `SystemAccessibilityPlugin.java` (its `load()`/`handleOnDestroy()` pattern and Javadoc style). `lowPower` = `PowerManager.isPowerSaveMode()`, watched with a receiver for `PowerManager.ACTION_POWER_SAVE_MODE_CHANGED`; `hot` = on API ≥ 29 `getCurrentThermalStatus() >= PowerManager.THERMAL_STATUS_SEVERE`, watched with `addThermalStatusListener`; below 29 always false. Unregister both in `handleOnDestroy`.

- [ ] **Step 2: Build and install on the emulator**

Follow the `android-emulator-workflow` memory (SDK adb, `-gpu auto`). `corepack yarn build`, `cd shells/capacitor && corepack yarn sync`, Gradle `assembleDebug`, `adb install -r`. Revert the two sync-touched files afterwards.
Expected: the app launches.

- [ ] **Step 3: Verify the signals reach the page**

With `tmp/tools/cdp.mjs` on the WebView: evaluate `document.querySelector("#theme-scene").className` under the ps theme and Auto on the emulator's phone layout. Then `adb shell cmd power set-mode 1` → the scene has no `psng-m-` classes (still); `adb shell cmd power set-mode 0` → `psng-calm` back. Then `adb shell cmd thermalservice override-status 3` → still; `adb shell cmd thermalservice reset` → calm.
Expected: each class change within 2 s, no reload.

- [ ] **Step 4: Commit**

```bash
git add shells/capacitor/android/app/src/main/java/chat/seance/app/PowerPlugin.java shells/capacitor/android/app/src/main/java/chat/seance/app/MainActivity.java
git commit -m "Android shell: the Power plugin reports battery saver and thermal throttling"
```

### Task 4: The iOS shell's `Power` plugin

**Files:**

- Create: `shells/capacitor/ios/App/App/PowerPlugin.swift`
- Create: `shells/capacitor/ios/App/App/BridgeViewController.swift`
- Modify: `shells/capacitor/ios/App/App/SceneDelegate.swift:11` (`CAPBridgeViewController()` → `BridgeViewController()`)
- Modify: `shells/capacitor/ios/App/App.xcodeproj/project.pbxproj` (both Swift files in the App target: `PBXFileReference`, `PBXBuildFile`, the App group, the Sources build phase)

**Interfaces:**

- Produces: the `Power` contract of Task 2 on iOS.

- [ ] **Step 1: Implement**

`PowerPlugin: CAPPlugin, CAPBridgedPlugin` with `identifier = "PowerPlugin"`, `jsName = "Power"`, `pluginMethods = [CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)]`. `lowPower` = `ProcessInfo.processInfo.isLowPowerModeEnabled` (notification `.NSProcessInfoPowerStateDidChange`); `hot` = `thermalState == .serious || thermalState == .critical` (`ProcessInfo.thermalStateDidChangeNotification`); both observers call `notifyListeners("changed", data: status)` on the main queue. `BridgeViewController: CAPBridgeViewController` overrides `capacitorDidLoad()` with `bridge?.registerPluginInstance(PowerPlugin())`.

- [ ] **Step 2: Simulator build**

Per the `ios-simulator-webview` memory: `xcodebuild -project App.xcodeproj -scheme App -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath /tmp/seance-sim-dd build CODE_SIGNING_ALLOWED=NO`
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Verify on the simulator that the plugin answers**

`node tmp/tools/wk.mjs 'window.Capacitor.Plugins.Power ? "yes" : "no"'` and `node tmp/tools/wk.mjs 'window.Capacitor.nativePromise("Power","status").then(s => window.__s = s)'` then read `window.__s` (WebKit ignores `awaitPromise`; poll a global).
Expected: `"yes"`, then `{"lowPower":false,"hot":false}`.

- [ ] **Step 4: Verify on the iPhone (≤ 3 minutes of the user's phone)**

Install with `shells/capacitor/tools/ios-device.sh` (USB or Wi-Fi). Ask the user to turn Low Power Mode on in Control Center, then off. Read `#theme-scene`'s classes through `ios_webkit_debug_proxy` and a copy of `wk.mjs` matching the shell's page.
Expected: Auto on the phone: calm (`psng-calm`) → still (no `psng-m-` class) with Low Power Mode on → calm again, without a reload. The thermal path is not verifiable on demand; state it as unverified.

- [ ] **Step 5: Commit**

```bash
git add shells/capacitor/ios/App/App/PowerPlugin.swift shells/capacitor/ios/App/App/BridgeViewController.swift shells/capacitor/ios/App/App/SceneDelegate.swift shells/capacitor/ios/App/App.xcodeproj/project.pbxproj
git commit -m "iOS shell: the Power plugin reports Low Power Mode and a hot device"
```

### Task 5: Low Power Mode in Safari on the web (measure first)

Spec §6 makes this conditional: a frame-interval probe only if Low Power Mode's 30 fps cap still shows on iOS 26/27.

**Files (only if Step 1 says the cap shows):**

- Modify: `client/js/helpers/power.ts` (a fourth reading, `frames?: {median: number}`)
- Test: `test/helpers/power.ts`
- Modify: `docs/projects/ps-ng.md` §6 (the result, either way)

**Interfaces:**

- Consumes/extends Task 2's `PowerReadings` and `PowerEnv` (`PowerEnv.frames?: () => Promise<number>` resolving the median rAF interval in ms over 30 frames).

- [ ] **Step 1: Measure (≤ 3 minutes of the user's phone, Safari, USB)**

Open the harness (`tmp/perf/ng2`, served on :8113) at `?t=coffee`. Through `ios_webkit_debug_proxy` + `tmp/tools/wkphone.mjs`, sample 120 rAF intervals into a global and read the median: once with Low Power Mode off, once with it on (ask the user to toggle).
Expected: a number for each. If on/off medians are both ~16.7 ms, **stop here**: write the result into spec §6 ("no 30 fps cap on iOS <version>; Safari on the web has no low-power signal") and commit only the doc.

- [ ] **Step 2 (cap shown): tests**

`lowPowerFrom({frames: {median: 33}})` → true; `{median: 17}` → false; `{median: 8.3}` → false. `followPower` with `frames` resolving 33 → `set(true)`. The probe runs only where `native` is absent (a shell has its plugin).

- [ ] **Step 3: Implement**

Threshold: median ≥ 28 ms. The probe runs at start and on each `visibilitychange` to visible, skipped while the page is hidden; `browserPowerEnv().frames` uses `requestAnimationFrame`.

- [ ] **Step 4: Run tests and lint; repeat Step 1's toggle and read `#theme-scene`'s classes**

Expected: PASS; on the phone in Safari, Low Power Mode on → still, off → calm (the probe re-runs when the page is shown again).

- [ ] **Step 5: Commit**

```bash
git add client/js/helpers/power.ts test/helpers/power.ts docs/projects/ps-ng.md
git commit -m "ps NG: Safari on an iPhone in Low Power Mode is low power (frame-interval probe)"
```

### Task 6: The three-platform gate

No code. Spec §8.3: before the default flips, iPhone, Android and Chrome at noon, night and storm, against classic in the same session, within the budgets.

**Files:**

- Modify: `tmp/perf/ng2/lib.mjs` (gitignored harness; add the slots below if missing)
- Modify: `docs/projects/ps-ng.md` (a new §8.3 with the tables)

- [ ] **Step 1: Slots**

Per platform, one round = `coffee`, `ng-still`, then for each moment `noon` (`2026-09-25T12:30`), `night` (`2026-09-25T23:30`), `storm` (the storm day plan 2 used, `2026-07-19T12:00`): `full-<moment>`, `calm-<moment>`, `classic-<moment>`. 12 slots. Use explicit `mo=full|calm|still` so Auto's device rule does not choose for you.

- [ ] **Step 2: iPhone sitting (Safari, USB, ≤ 30 min)**

Tell the user first. `DWELL=50`, 2 rounds rotated: 12 × 2 × 50 s + 45 s ≈ 21 min. `cd tmp/perf/ng2 && SLOTS="…" ./ios-run.sh 2`, then `node summarize.mjs ios ios-2.jsonl <rid>`. Then one shell reading (spec plan 1: owed before the flip): the installed app at `full-noon`, 15 s of Activity Monitor (the shell's WebContent is `chat.seance.app`'s).
Expected: every NG slot within its budget (full ≤ 30, calm ≤ 24, still ≤ 3), each with ≥ 2 valid readings.

- [ ] **Step 3: If a tier is over budget**

Run plan 2's ladder for that moment only (`SHORT=plan2`, the groups alone over still) to name the group, and stop: a group's fallback (spec decision 2) is a new plan, not this one. Report to the user.

- [ ] **Step 4: Android (a real phone if the user has one tethered, else the emulator rank-only on a host with load < 2.5)**

`tmp/perf/ng2/droid-plan2.sh` with the same 12 slots.
Expected: NG's full below classic at each moment; ranks recorded.

- [ ] **Step 5: Chrome on the Mac**

`node tmp/perf/ng2/run-chrome.mjs` (or the plan-2 variant) with the 12 slots, 5 rounds, load gate 2.5.
Expected: NG's full below classic at each moment.

- [ ] **Step 6: Write §8.3 and commit**

```bash
git add docs/projects/ps-ng.md
git commit -m "docs: ps NG's three-platform gate"
```

### Task 7: NG becomes ps; classic is deleted

Spec decision 8: the default flips and classic goes **in one commit**. Only after Task 6 passed and the user has said go.

**Keep in mind:** NG plays classic's own `animation` declarations and `@keyframes` in `ps.css` (`ps-twinkle`, `ps-spin`, `ps-drift`, `ps-ffdrift`, `ps-ffblink`, `ps-smoke-rise`, `ps-sway`, `ps-skein-fly`, `ps-skein-west`, `ps-skein-sway`, `ps-bird-wander`, `ps-buzz-drift`, `ps-lark-fly/-fl/-ch/-cl`, `ps-flake`, `ps-seed`, `ps-flash`, `ps-shimmer`). The scene half of `ps.css` is **not** deleted wholesale; only the blocks listed in Step 4.

**Files:**

- Delete: `client/js/scenes/ps/scene.ts`, `client/js/scenes/ps/stepper.ts`, `test/scenes/ps/stepper.ts`, `test/scenes/ps/mount.ts`, `test/scenes/ps/standin.ts`
- Modify: `client/js/themeScene.ts`, `client/js/settings.ts`, `client/components/Settings/Appearance.vue`, `client/js/scenes/ps/layers.ts`, `client/js/scenes/ps/watchers.ts`, `client/themes/ps.css`
- Modify tests: `test/tests/themeScene.ts`, `test/scenes/ps/{scene,grounds,layers}.ts`, `test/scenes/psng/mount.ts`, `test/themes/ps.ts`
- Modify scenarios: `tools/scenarios/{theme-ps,ps-scene-settings,scene-rest,ps-ng}.mjs`
- Modify docs: `CLAUDE.md` (the ps and ps NG bullets), `docs/projects/ps-theme.md`, `docs/resources/themes.md`, `docs/projects/ps-ng.md`

**Interfaces:**

- Produces: `SCENES = {ps: () => import(/* webpackChunkName: "scene-ps" */ "./scenes/psng/scene")}`. Gone: `PsRenderer`, `normalizePsRenderer`, `sceneKey`, `SceneHost.setRenderer`, the `psRenderer` setting, the `thelounge.state.psngPreview` flag, `layerGates`, `overcastBuilder`'s fade argument. NG's files stay under `scenes/psng/` with their `psng` class names (renaming them buys nothing).

- [ ] **Step 1: Capture classic's published values as fixtures, before deleting it**

`test/scenes/psng/mount.ts`'s "publishes what classic publishes" loop compares NG with classic at several moments. Run it once printing classic's values (`data-ps-light`, `data-ps-text`, `--ps-halo`, `--canvas-bg-color`, the glass tints, `theme-color`) per moment, then rewrite the loop to assert NG against those literals. Delete the "NG then classic on the same root" test and the `mountClassic` import.
Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/scenes/psng/mount.ts`
Expected: PASS against the literals, with classic still present.

- [ ] **Step 2: The host and the setting**

`themeScene.ts`: the `SCENES` above; remove `PsRenderer`, `normalizePsRenderer`, `sceneKey`, `setRenderer` and the host's `renderer`; the doc comment at the top no longer says calm steps once a second. `settings.ts`: remove `psRenderer` and its import; the `psAnimation` comment names `psng/tiers.ts`, not `stepper.ts`. `Appearance.vue`: remove the "Scene renderer" radios, `psngOffered`, and the `storage` import if nothing else uses it. A stored `psRenderer` in the `settings` object is left alone and ignored. `test/tests/themeScene.ts`: `SCENES` keys are `["ps"]`; delete the renderer block.

- [ ] **Step 3: Delete classic's code and its dead remainder**

Delete the five files above. Remove `layerGates` from `layers.ts` (and its tests from `test/scenes/ps/layers.ts`), and `overcastBuilder`'s fade branch from `watchers.ts` (its `build(weather)` takes no fade flag; update NG's call). Re-point the imports in `test/scenes/ps/{scene,grounds,layers}.ts` and `test/themes/ps.ts` from `scenes/ps/scene` to `scenes/ps/markup` / `scenes/ps/watchers`.
Run: `npx tsc -p client --noEmit` (or `corepack yarn lint`, which type-checks)
Expected: no errors.

- [ ] **Step 4: The classic-only rules in `ps.css`**

Remove, by selector: `.ps-overcast-set.ps-arriving` / `.ps-leaving`; the `.ps-blades .ps-sway` animation and the windy blades' rule; `.ps-hot .ps-ground`; the `animation: ps-drop` declaration in `.ps-rain i` and `@keyframes ps-drop` (keep the rest of that rule); `.ps-heat-haze`; both `.ps-paused` rules; the `transition` declarations on scene elements that NG's `transition: none !important` already overrides. Keep the reduced-motion group's `#theme-scene` lines (they still match NG's DOM). Fix the comments in `ps.css` that name classic's `scene.ts`. In `test/themes/ps.ts` remove the assertions on `ps-paused`, `ps-hot`/the haze, the overcast fade and `ps-drop`.
Run: `npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml 'test/themes/ps.ts' 'test/scenes/**/*.ts' test/tests/themeScene.ts`
Expected: PASS.

- [ ] **Step 5: The scenarios**

- `theme-ps.mjs`: drop the stepper clock sampling, the stopped/running check by `animationsPaused`, the heat haze, the cloud fade; the chunk check expects `js/scene-ps.js` (now NG's chunk) fetched once. Everything else it checks (glass, fonts, words, published values, weather, yurt) runs on NG unchanged; any check that fails because it measured classic-only motion is replaced by the equivalent `ps-ng.mjs` census, not loosened.
- `ps-scene-settings.mjs`: Calm is `psng-calm` on `#theme-scene` with only calm's groups; Still has no `psng-m-` class; Full has all the moment's groups.
- `scene-rest.mjs`: a rested page has no `psng-m-` class; input brings them back.
- `ps-ng.mjs`: drop the radio pair, `setRenderer`, the preview flag, the backdrop-equals-classic check, "switch to classic", the classic `ps-hot` check, the screenshot pairs and contact sheet's classic half, and "no `scene-ps.js`" (replace with: `scene-ps-ng.js` is never requested).

Run, after `NODE_ENV=production corepack yarn build`: `node tools/browser-drive.mjs tools/scenarios/<name>.mjs` for all four, plus `--mobile --width=390 --height=844` for `theme-ps.mjs` and `ps-ng.mjs`, and `--mobile --width=932 --height=430` for `ps-ng.mjs`.
Expected: every check passes; report the counts.

- [ ] **Step 6: Docs**

`CLAUDE.md`: merge the ps and ps NG bullets so the ps bullet describes the one renderer (no stepper, no `psRenderer`, no preview flag, Auto by device and power from Tasks 1–2, the `Power` plugins); keep the chrome, words and palette text as it is. `docs/resources/themes.md` and `docs/projects/ps-theme.md`: where they describe classic's scene machinery, say NG replaced it and point to `ps-ng.md`. `docs/projects/ps-ng.md`: status line "NG is the ps scene; classic deleted <date>, <sha>", decision 8 marked done.

- [ ] **Step 7: Full verification**

Run: `corepack yarn test` (lint + mocha)
Expected: lint clean, 0 failing.

- [ ] **Step 8: One commit**

```bash
git add -A client test tools/scenarios docs CLAUDE.md
git status --short   # nothing from shells/capacitor (sync files, ios-device.sh) may be staged
git commit -m "ps: NG is the ps scene; the classic renderer is deleted"
```

- [ ] **Step 9: On the iPhone**

Install with `shells/capacitor/tools/ios-device.sh`; tell the user it is there. Expected: the ps theme draws (Auto → Calm on the phone), Settings → Appearance shows no renderer choice.
