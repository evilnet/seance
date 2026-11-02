# Vite 8 sweep: what moving the client build off webpack takes

_Survey, 2026-11-02. Status: **migration under way** on branch `feat/vite8` (steps 1, 2, 4 and 5 of the plan below; step 3 is the stack audit's TypeScript work). Earlier the same day: finished, nothing shipped. Briefly stopped and then resumed the same day at rdrake's request, to close the spike's gaps (native shells, Safari/Firefox, a development build, the Pages workflow) and to say what the move improves. Read beside the stack audit (`docs/projects/stack-audit.md` on `claude/stack-audit-1b0a45`), which weighs Vite against Rspack and an updated webpack. Reopens the
toolchain spec shelved on 2026-09-11 (local branch
`docs/toolchain-upgrade-spec`, `docs/projects/toolchain-upgrade.md`), which
set Vite aside as a config rewrite for a dev loop we do not use. This page
weighs it again with Vite 8 (Rolldown + Oxc), against today's
`webpack.config.ts`. The spike is local branch `spike/vite8` (four commits on
`77a4075d`, not pushed)._

## Verdict

**Move to Vite 8, and skip the Rspack spike.** rdrake is fine with swapping
build-chain tools when it makes things better, so keeping webpack, Babel or
the PostCSS chain counts for nothing; judged on the merits, Vite wins (the
reasoning is under "Vite against Rspack" below). Vite 8 covers every duty `webpack.config.ts` has: about half are
built in, the rest are a ~60-line custom plugin plus a second small config for
the push worker. The spike builds a `public/` that boots, connects, renders
all the lazy chunks (highlighter + a Prism grammar, KaTeX, Lua, CodeMirror,
the ps scene), passes the whole mocha suite and the adjusted build test, and
passes the browser scenarios it was put through. A production build takes
**4 s instead of 15 s** (typecheck moved out, see below), and the move
deletes Babel, six webpack loaders and plugins, and the vestigial
development build `yarn test:mocha` runs today.

What it costs is one real behaviour change, not config: the bundle becomes
an ES module (`<script type="module">`). That change produced the one
serious bug the spike hit: a page that loads `js/bundle.js?v=<token>` boots
**the app twice** as soon as a lazy chunk loads, because the chunk imports
`./bundle.js` without the query and the browser treats the two URLs as two
modules. The fix (a content-hashed entry, no `?v=` on it) is in the spike
and verified; it changes `index.html`, the service worker's shell list and
the build test. Everything else is cosmetic or a deletion.

## What it improves

For rdrake, in short: **faster builds and a much smaller build toolchain;
nothing changes for people using Seance.** All figures measured on this Mac
the same afternoon, webpack on `develop` (77a4075d) against `spike/vite8`
(464130d1, webpack and Babel removed).

**For you (build and test time).**

| What                                         | webpack (`develop`)  | Vite (spike)                     |
| -------------------------------------------- | -------------------- | -------------------------------- |
| `NODE_ENV=production yarn build`, two runs   | 14.0 s, 13.6 s       | 4.6 s, 4.7 s                     |
| … of which typechecking                      | inside the 14 s      | separate: `yarn typecheck` 3.4 s |
| the build `yarn test:mocha` does first       | 10.7 s (thrown away) | 4.6 s (the real `public/`)       |
| `yarn test` (lint + typecheck + mocha, wall) | 123.7 s              | 119.5 s                          |

So a build is about **3× faster**, and `cap sync` or a Pages run waits
4–5 s instead of 14. `yarn test` barely moves: mocha's ~110 s dominates it.
What does change is that `yarn test` now builds the real `public/`, so the
build test can no longer pass or fail on a stale tree.

**For contributors.** One config to read instead of the webpack/Babel pair:
`webpack.config.ts` + `babel.config.cjs` (525 lines) become
`vite.config.ts` + `vite.push.config.ts` (224) plus `scripts/build-info.ts`
(170, the build identity and branding helpers that used to sit inside the
webpack config). No Babel, no loader chain: TypeScript and Vue files go
through one compiler (Oxc). The typecheck is its own command with its own
failure. A dev server with hot reload becomes available for free if anyone
wants one (nobody does today). Vue's own tooling (Vitest, Router 5's plugin)
assumes Vite.

**For users: nothing visible.** Same bundle size (1.27 MB of JS, the push
module 16 kB smaller), same app; cold start in the iOS shell 1.3–1.6 s on
Vite against 1.3 s on webpack (three launches each); offline start works.
Users would only notice if something broke.

**For maintenance (`yarn audit`, same day, same registry).**

|                                   | webpack (`develop`) | Vite (spike) | Change                                               |
| --------------------------------- | ------------------- | ------------ | ---------------------------------------------------- |
| devDependencies in `package.json` | 70                  | 56           | −16 removed, +2 added (`vite`, `@vitejs/plugin-vue`) |
| packages `yarn audit` checks      | 1,118               | 898          | −220                                                 |
| audit findings (paths)            | 315                 | 242          | −73                                                  |
| distinct advisories               | 105                 | 85           | −20, none new                                        |

The 20 advisories that go: 12 in `fast-uri` (webpack's schema validation),
2 in `postcss-selector-parser`, and one each in `@babel/runtime`,
`@babel/plugin-transform-modules-systemjs`, `semver`, `deepmerge`,
`baseline-browser-mapping` and `@vue/server-renderer` (that last one from
the Vue 3.5 bump the spike also carries); 11 high, 5 moderate, 4 low. The 85
left are mostly in the lint and test chains (`brace-expansion`, `js-yaml`,
`minimatch`, `postcss`, `nanoid`, `svgo`), which the build tool does not
touch. Dropping `cssnano`/`postcss-preset-env` for Lightning CSS (plan step 5) would take a few more.

**What gets worse or riskier.**

- The page loads an **ES module** instead of a classic script. Both serious
  bugs the spike found came from that and showed up only in a real browser:
  the app booting twice, and the runtime chunk missing from the offline
  cache. Both are fixed and now pinned by `build.ts`, and the module entry
  has since run in Chrome, Firefox, Safari, Mobile Safari, the iOS and Android shells,
  under a sub-path and offline. But the service-worker/precache area is the
  hardest to test, and it is the part that changes.
- **`NODE_ENV` unset now means a production build.** Vite sets it itself;
  a development build (token `dev`, eruda) needs `NODE_ENV=development`.
  Under webpack, unset meant development.
- No `css/style.css.map`; copied scripts (`loading-error-handlers.js`, the
  service worker) are no longer minified; licence notices sit inline instead
  of in `*.LICENSE.txt` files.
- Rolldown and Oxc are young (1.x) next to webpack/terser; a minifier
  difference has already shown up once (strings as template literals).
- TypeScript has to move to ≥ 5.6 for the config to typecheck.

**Vite against Rspack** (the stack audit's preferred first try, its § 2).

|                                   | Vite 8                                                                        | Rspack 2                                                                |
| --------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Evidence in this repo             | Spike: every target above, mocha, scenarios, audit numbers                    | None yet (a one-day spike)                                              |
| Build speed                       | 4.6 s measured                                                                | Rust too; likely similar, unmeasured                                    |
| Shipped output                    | Changes: ES-module entry, hashed name, SW list stamped                        | Unchanged: classic script, `?v=`, fixed names                           |
| Config                            | Rewritten, smaller (224 lines)                                                | webpack's, nearly as is (~520)                                          |
| Code changes                      | `require.context` → glob; Prism map; chunk naming function                    | none (`require.context`, magic comments keep working)                   |
| Babel, webpack, loaders removed   | yes                                                                           | Babel and most loaders yes (built-in SWC/CSS); webpack-API plugins stay |
| CSS source map, `.LICENSE.txt`    | lost                                                                          | kept                                                                    |
| Dev server / Vitest / Vue plugins | the ecosystem default                                                         | possible, not the default                                               |
| `desktop/mac-translate`           | its `import.meta` workaround loader disappears; worker becomes a small config | its third config carries over unchanged                                 |

**The call: Vite.** Judged on the merits, with no weight on keeping webpack,
Babel or PostCSS for their own sake:

- **Rspack's one real advantage is that the shipped files do not change.**
  That was worth a lot while the ES-module entry was untested. It has now
  run on every target Seance ships to (Chrome, Firefox, Safari, Mobile Safari, the Tauri window, the
  iOS and Android shells, a `/prN/` sub-path, offline, under Tauri's CSP),
  the two bugs it caused are fixed and pinned by `build.ts`, and what it
  cost is a few lines in `index.html`, the service worker and the test.
- **Rspack keeps the webpack shape**: the ~520-line config, the loader
  chain (`vue-loader`, `postcss-loader`), webpack-API plugins,
  `require.context` and magic comments. It removes Babel, but the result is
  still webpack's model with a faster engine. Vite ends with a config less
  than half the size and one compiler for TypeScript and Vue.
- **Evidence.** Vite's numbers here are measured; Rspack's build time,
  `vue-loader` on Rspack 2 and output parity are not. A one-day Rspack
  spike would at best reach where Vite already is.
- **Direction.** Vite is what the Vue ecosystem builds on (plugin-vue,
  Vitest, Router 5's plugin, Vue's own tooling); taking it once means later
  moves (Vitest, `vue-tsc`, a dev server if wanted) need no second bundler
  change. Rspack would leave that move still to make.
- What Vite costs that Rspack would not: the CSS source map, the
  `*.LICENSE.txt` files, and minified copies of the two hand-written
  scripts. None of them is load-bearing; the open questions below cover
  them.

Remaining effort: about 2–3 days in the five steps of the migration plan,
most of the code already on `spike/vite8`. The stack audit's step 1
(bundler-agnostic clean-up) is the same as this plan's steps 1–3 and stays
first either way.

## What `webpack.config.ts` does, and the Vite 8 answer

Two configurations: `app` (everything) and `push` (the service worker's
module), plus a development variant that `yarn test:mocha` builds. Risk is
what can go wrong on the switch, not difficulty.

| #   | Duty (webpack)                                                                                                                                                                                                | Vite 8                                                                                                                                                                                                                                                                                                                                                                                    | Risk                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | Entry `client/js/vue.ts` → `js/bundle.js`, classic script                                                                                                                                                     | Built in: `rolldownOptions.input`, `entryFileNames`. Output is **ESM** (lazy `import()` needs it): `<script type="module">`                                                                                                                                                                                                                                                               | **High** without the fix in row 16; low with it                    |
| 2   | `babel-loader` (preset-env, transform-runtime, typescript-vue3) on `client/` + `shared/` `.ts`                                                                                                                | Built in: Oxc strips TS and lowers to `build.target`. Babel goes entirely                                                                                                                                                                                                                                                                                                                 | Low: mocha passed; nothing needs ES5                               |
| 3   | `vue-loader` (+ `preserveWhitespace: false`)                                                                                                                                                                  | `@vitejs/plugin-vue` 6. `preserveWhitespace` is a Vue 2 option Vue 3 ignores: delete it. Template asset URLs need `transformAssetUrls: false` (else `<img src="img/…">` becomes an import and the build fails)                                                                                                                                                                            | Low                                                                |
| 4   | `fork-ts-checker-webpack-plugin` (typecheck in the build, `.ts` only — it never checked `.vue`)                                                                                                               | None: Vite does not typecheck. `tsc --noEmit -p client/tsconfig.json` takes 2.6 s. Root project (`vite.config.ts`) needs TypeScript ≥ 5.6 first (row 21)                                                                                                                                                                                                                                  | Low; just has to be wired into `yarn test`/`build`                 |
| 5   | CSS: `style.css` imported from `vue.ts` → `mini-css-extract` → `css/style.css`; `css-loader` with `url: false`; `postcss-loader` (postcss-import, postcss-preset-env, cssnano)                                | Built in: `cssCodeSplit: false` + `assetFileNames` → `css/style.css`. `url(../fonts/…)` it cannot resolve is left as is (warning), same bytes as today. `postcss.config.js` still runs; postcss-import is built into Vite. Minifier is now Lightning CSS                                                                                                                                  | Low; see rows 18–19                                                |
| 6   | `css/style.css.map`                                                                                                                                                                                           | **Not produced**: Vite has no CSS source maps in a build                                                                                                                                                                                                                                                                                                                                  | Low: only the build test asserts it. Accept                        |
| 7   | Fixed lazy-chunk names via `webpackChunkName` (`highlighter`, `flourite`, `katex`, `code-editor`, `fengari`, `emoji-catalog`, `scene-ps`, `js/eruda`, `prism-*`)                                              | Rolldown names a chunk after its module (`luaEditor`, `scene`, `dist`). A 10-line `chunkFileNames` function renames by module id. New: a 1.3 kB `js/rolldown-runtime.js` that the **entry imports statically**, so it is part of the app shell (row 17)                                                                                                                                   | Low                                                                |
| 8   | `splitChunks`: initial `node_modules` → `js/bundle.vendor.js`; no async vendor group                                                                                                                          | Drop it. Both files carry the same `?v=` token, so every deploy invalidates both: the split buys no caching. One `bundle` file (same 1.27 MB total)                                                                                                                                                                                                                                       | Low; touches `index.html`, the SW shell list, `build.ts`           |
| 9   | Prism grammars: a template-literal `import()` of `prismjs/components/prism-<id>` with a `webpackInclude` regex of 73 names                                                                                    | No bare-specifier dynamic-import-vars. `import.meta.glob` works in Vite but **breaks mocha** (tsx has no `import.meta.glob`; `test/helpers/highlighter.ts` dies at load). Spike: an explicit `{id: () => import("prismjs/components/prism-id")}` map, which works under webpack, Vite and Node. The regex named `ansi`, which Prism does not have (72 exist); webpack silently skipped it | Low                                                                |
| 10  | `require.context(".", false, /\.vue$/)` in `components/MessageTypes/index.ts`                                                                                                                                 | `import.meta.glob("./*.vue", {eager: true})` (not loaded under mocha)                                                                                                                                                                                                                                                                                                                     | Low                                                                |
| 11  | `scripts/fengari-match-budget.js` loader on `fengari/src/lstrlib.js`                                                                                                                                          | A `transform` hook with `filter: {id}`, calling the same exported `patch()`. Build test's step-budget check passes; `test-lua-live.mjs` passes all 10 live tests                                                                                                                                                                                                                          | Low                                                                |
| 12  | `resolve.fallback` (`fs`, `path`, `os`, `crypto`, `readline`, `child_process` → false) for Fengari                                                                                                            | Built in: Vite externalizes Node built-ins to an empty stub, with one warning each (fengari, readline-sync, tmp). Same runtime result                                                                                                                                                                                                                                                     | Low; the warnings can be silenced with an alias to an empty module |
| 13  | `DefinePlugin`: `__VUE_PROD_DEVTOOLS__`, `__VUE_OPTIONS_API__`, `process.env.SEANCE_*`, `process.env.FENGARICONF`                                                                                             | `define` for `process.env.*` (keep the `process.env` spelling: `configuration.ts`, `build.ts` run under mocha, where `import.meta.env` does not exist); the Vue flags via plugin-vue `features`                                                                                                                                                                                           | Low                                                                |
| 14  | `BannerPlugin` licence notices on 4 chunks; terser extracted `/*!` comments to `*.LICENSE.txt`                                                                                                                | `output.postBanner(chunk)` (plain `banner` is stripped by the minifier). Notices stay **inline**, no `.LICENSE.txt` files. Prism's own `@license` line is dropped by Oxc; the banner already states it                                                                                                                                                                                    | Low                                                                |
| 15  | `CopyPlugin`: fonts, KaTeX css+fonts, `loading-error-handlers.js` (+ theme pairs), `client/*`, `index.html` (+ token, branding), manifest (+ branding), SW (+ token, app name), audio, img, themes, themes/ps | A custom plugin, ~60 lines: `generateBundle` → `this.emitFile` with the same transforms (moved to `scripts/build-info.ts`, shared). `vite-plugin-static-copy` would also do; not worth a dependency. Copied JS is no longer minified (`loading-error-handlers.js` 2.6 → 6.8 kB; the SW likewise)                                                                                          | Low                                                                |
| 16  | `index.html` loads `js/bundle.js?v=<token>`                                                                                                                                                                   | **Must change.** Lazy chunks `import … from "./bundle.js"`; the page's `bundle.js?v=…` is another module, so the app evaluates twice (second socket per network; seen as `nick_` and the reconnect throttle). Fix: `entryFileNames: "js/bundle-[hash].js"`, stamped into `index.html` and the SW shell list at build time. Verified in `own-messages.mjs`                                 | **High** if missed — found only in a real browser                  |
| 17  | Service worker (`client/service-worker.js`): copied with `__HASH__`/app name; precaches named shell files                                                                                                     | Same copy; shell list loses `bundle.vendor.js`, gains the hashed entry **and the entry's static imports** (`js/rolldown-runtime.js`), stamped from the bundle at build time — without them an installed app's offline cold start fails, which no test caught until `build.ts` pinned it. `update-signal.mjs` passes (deploy detection unchanged)                                          | Low                                                                |
| 18  | `push` config: `client/js/push/worker-entry.ts` → `js/push.js`, `target: webworker`, no splitting, runs after `app` (`clean` race)                                                                            | `vite.push.config.ts`: `format: "iife"` (it is `importScripts`ed), `emptyOutDir: false`, run second. 98.7 kB vs 114.5 kB                                                                                                                                                                                                                                                                  | Low                                                                |
| 19  | `output.clean` keeping `js/push.js*`                                                                                                                                                                          | `emptyOutDir` on the app build, off on the push build                                                                                                                                                                                                                                                                                                                                     | Low                                                                |
| 20  | `NormalModuleReplacementPlugin` `debug` → noop; `externals: {json3: "JSON"}`                                                                                                                                  | Delete: socket.io remnants, nothing in `client/` imports either                                                                                                                                                                                                                                                                                                                           | None                                                               |
| 21  | `--mode=development` (what `test:mocha` runs): `target: node`, output `test/public/`, istanbul in babel, socket.js → noop                                                                                     | Delete. Nothing reads `test/public/` (mocha ignores it; the build test reads `public/`), and nyc instruments sources itself. Its only live effect was the typecheck. `test:mocha` should run the real build (4 s) — which also ends the "stale `public/` fails the build test" trap                                                                                                       | None                                                               |
| 22  | `publicPath: "auto"` (deploys under a sub-path)                                                                                                                                                               | `base: "./"`: chunk URLs resolve against the importing module. Spike served from `/` only; a sub-path deploy (Pages `/prN/`) is worth one check                                                                                                                                                                                                                                           | Low                                                                |
| 23  | `.browserslistrc` (`last 2 year, firefox esr`) for Babel and postcss-preset-env                                                                                                                               | Vite ignores browserslist for JS: `build.target` default is Baseline widely available 2026-01-01 (Chrome 111, Firefox 114, Safari/iOS 16.4). The iOS shell targets 26.0; fine                                                                                                                                                                                                             | Low                                                                |

"Per-theme CSS outputs" in the brief are not builds: `client/themes/*.css`
and `client/themes/ps/*` are copied verbatim (no PostCSS, no minifying),
and `coffee.css` `@import`s `day.css` at run time. Row 15 covers them.

## What the spike proved

Branch `spike/vite8`: `c92feb09` (Vite beside webpack), `a5d6a5b0`
(Vue 3.5), `9c9a887c` (the runtime chunk precached) and `464130d1` (webpack,
Babel and the loaders removed; `yarn build` is Vite).

| Check                                                      | Result                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production yarn build:vite`                      | app 2.7 s + push 1.2 s wall, vs webpack 14.7 s (webpack's includes fork-ts-checker; add `tsc` 2.6 s to Vite's for a fair figure)                                                                                                                |
| Output size                                                | JS entry 1,268.6 kB vs 1,270.0 kB (bundle + vendor); `style.css` 150.7 vs 152.1 kB; push 98.7 vs 114.5 kB; same 72 Prism chunks                                                                                                                 |
| `yarn lint`                                                | clean (after root `tsconfig.json` gets `moduleResolution: "bundler"`; the 2 warnings are on `develop` too)                                                                                                                                      |
| mocha, whole suite                                         | Vue 3.2: 3637 passing, only `build.ts` failing (4, all understood); after adjusting `build.ts`: 17/17. Vue 3.5: 3641 passing, 0 failing                                                                                                         |
| Browser (`tools/browser-drive.mjs`, real Chrome, dev ircd) | pass: `help-modal`, `install-guide`, `link-approval`, `disconnected-channel`, `update-signal`, `scripting-editor`, `test-lua-live` (10/10), `ps-ng`, `own-messages`, `input-focus`, and a scratch check that KaTeX and a Python block highlight |
| Same, with Vue 3.5.44 + Vuex 4.1.0                         | pass: `help-modal`, `input-focus`, `own-messages`; `network-panel` fails one check ("an ordinary nick is not clipped"), **identically on the webpack build**                                                                                    |

Second round (after the stop was lifted), on `464130d1`:

| Gap                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages workflow, dry run                               | Fresh worktree, `yarn --frozen-lockfile --non-interactive`, two `yarn build`s with the workflow's `SEANCE_VERSION`/`RELEASE`/`TRACK`, `tools/pages-site.mjs` with `SITE_BASE=/seance/`: release at the root, a PR build at `/seance/pr999/`. Help shows "v5.0.2-pr999.464130d" and the PR preview text. Ran on Node 26 here, not CI's 22                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Sub-path deploy (`/seance/pr999/`)                    | Chrome: `help-modal` and the lazy-chunk check (KaTeX, Prism) pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Offline cold start                                    | After one visit, network off, reload: the app mounts. The precache holds the hashed entry and `rolldown-runtime.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Firefox 158.0.1                                       | Headless over WebDriver BiDi, on the sub-path: boots, connects to the dev ircd, KaTeX, highlighted block, reload — all pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Safari 27.2                                           | Real desktop Safari through `safaridriver`, on the sub-path: boots, connects to the dev ircd, KaTeX, highlighted block, reload — all pass. Mobile Safari in the iOS Simulator boots it too. (Playwright's WebKit 26.5 dies on Connect on the webpack build as well: a Playwright problem.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Development build                                     | Finding: with `NODE_ENV` unset Vite builds production anyway. `NODE_ENV=development yarn build`: token `dev`, the eruda chunk, unminified names; `help-modal` and the lazy-chunk check pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| iOS shell (Capacitor, iPhone 17 Pro Simulator, Debug) | Boots; mount after launch 1.3–1.6 s (Vite) vs 1.3 s (webpack's `public/` in the same binary), three launches each; inside the WKWebView: connects to `ws://127.0.0.1:8067`, KaTeX, highlighted block, reload pass. The very first launch after the Simulator booted stayed blank past 8 s once; not seen again in six timed launches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Android shell (Pixel 7 AVD, API 35)                   | Boots with its saved state, ps theme scene drawn; every lazy chunk imports in the WebView and none boots a second app. IRC is unreachable from the emulator's WebView on both builds (known), so no connect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tauri shell                                           | `shells/tauri` from `feat/desktop-shells` (committed state, via `git archive`) compiled in scratch with the Vite production build as its `frontendDist`: debug build 46 s. Its `--smoke` probe: bridge answers, unknown plugin rejects `unimplemented`, origin `tauri://localhost`, secure context, no service worker — all as expected — but it reports **FAIL** on `<html data-shell="desktop">`, because the code that sets it (`client/js/native.ts`) exists only on `feat/desktop-shells`, not on `develop`, which the spike builds from. A `--drive` walk-through in the Tauri window passes: ES-module entry loads, connects to `ws://127.0.0.1:8067` and joins `#seance`, KaTeX renders, the Python block highlights. Also served with Tauri's exact CSP as an HTTP header in Chrome: no violations. `test/tests/tauriShell.ts` reads only the config and is unaffected. A full smoke pass needs the spike merged with `feat/desktop-shells` |
| webpack removed                                       | `yarn test` (lint, typecheck, mocha) green, 3641 passing, after deleting one `eslint-disable` that Vue 3.5's types made unused (`Username.vue`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Found on the way and **not caused by Vite** (both on the webpack build too):

- The example Lua script "pinger" fails to load: `pattern too complex (step limit)` on its line 7 (`scripting-editor.mjs` logs it 4 times and still
  passes). The step budget, or the example, is wrong.
- `network-panel.mjs` "an ordinary nick is not clipped" fails.

## Gotchas a reviewer should know

1. **Double evaluation** (row 16). Anything that loads the entry by a second
   URL — a query string, a different relative path — runs the app twice.
   The build test should pin that `index.html` and the chunks name the entry
   identically.
2. **Oxc writes strings as template literals** (`` `ff18c1d09f` ``). The
   build test's `"${token}"` search failed on that alone; anything else that
   greps the bundle for a quoted string will too.
3. **Lightning CSS rejects primer-tooltips' IE hack**
   (`@media (min-width: 0\0)`) and fails the build;
   `css.lightningcss.errorRecovery: true` drops that one rule. Since step 5
   Lightning CSS is the only CSS tool (no `postcss.config.js`). Against
   cssnano + postcss-preset-env the only properties lost are fallbacks the
   targets do not need (`font-feature-settings: "tnum"` beside
   `font-variant-numeric`, a plain `text-decoration` before
   `underline dotted`). It does not prefix a CSS-wide keyword:
   `user-select: inherit` got no `-webkit-` twin, so `style.css` writes
   that one out.
4. **TypeScript 5.4.5 cannot parse `@vitejs/plugin-vue`'s `.d.mts`**
   (`export {… as "module.exports"}`, TS 5.6 syntax), so `tsc -p tsconfig.json` fails on `vite.config.ts` even with `skipLibCheck`; and
   `moduleResolution: "node"` cannot see Vite's types at all (`exports`
   only). eslint is fine once the root tsconfig says `bundler`.
5. **`import.meta.glob` is Vite-only.** Any module mocha loads must not use
   it (row 9). The same goes for `import.meta.env`.
6. **Vite sets `NODE_ENV=production` for every build** unless the variable is
   already set: a bare `yarn build` is a production build. Development
   builds need `NODE_ENV=development`.
7. `vue-tsc` 3.3 runs (8 s) but, under TS 5.4.5 and the current tsconfig,
   reports every SFC as "not a module" (20 errors, 5 files). How many real
   template errors exist is unknown until TypeScript is bumped; nothing
   checks `.vue` files today.
8. **Copied scripts are not minified by Vite.** webpack's terser minified
   every `.js` asset, copied ones included; Vite only minifies what it
   bundles. The spike shipped `service-worker.js` at 90 KB (webpack: 30 KB)
   and `loading-error-handlers.js` at 6.8 KB (2.6 KB). `vite.config.mts`
   now runs them through `minifySync` (Oxc, the bundle's own minifier) as
   classic scripts for `build.target`, back to 29.6 KB and 2.6 KB. Oxc
   writes their strings with backticks too (item 2), so the build test and
   `update-signal.mjs` accept either quote.
9. **The entry has no `?v=`**, so anything that read the page's build from
   the bundle's URL now reads it from `css/style.css?v=` (`update-signal.mjs`).
10. Safari logs "`rolldown-runtime.js` was preloaded … but not used": Vite's
    preload helper adds a `modulepreload` for the runtime when a lazy chunk
    loads, though the entry already imported it. Harmless.

## The local `desktop/mac-translate` branch

It adds a third webpack configuration (the translation worker), an i18n
instrument loader, a `prepaint.js` copy, locale JSON copies and wasm copies.
Under Vite: the worker is a third small config like the push one (or
`new Worker(new URL(…, import.meta.url), {type: "module"})`, which Vite
bundles itself); the `onnxruntime-web/webgpu` alias maps 1:1; the wasm and
locale copies are rows in the copy table; `tools/transformers-importmeta-loader.mjs`
**goes away** (it works around webpack's `import.meta` shim, which Rolldown
does not have); the instrument loader becomes a `transform` hook with
`enforce: "pre"`. Whichever lands second rebases onto the other; nothing in
the plan blocks it.

## Surrounding stack

| Package    | Have   | Latest | Notes                                                                                                                                                                                                         |
| ---------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vite       | —      | 8.3.5  | Node `^20.19 \|\| >=22.12`; `.node-version` is `22`, CI gets the latest 22                                                                                                                                    |
| vue        | 3.2.35 | 3.5.44 | **Not required by Vite** (plugin-vue 6 accepts `^3.2.25`; the spike built 3.2.35 first). But it is a cheap minor bump the spike verified, and a prerequisite for Router 5 (`^3.5.34`) and Pinia 4 (`^3.5.11`) |
| vuex       | 4.0.2  | 4.1.0  | Final release; runs on Vue 3.5 (verified). Stays                                                                                                                                                              |
| vue-router | 4.0.15 | 5.4.0  | Needs Vue ≥ 3.5.34 (Vite ≥ 7.3 only for its optional Vite plugin). Nothing in the app needs it; do it when routing is open anyway                                                                             |
| pinia      | —      | 4.1.0  | Needs Vue ≥ 3.5.11 **and TypeScript ≥ 5.6**                                                                                                                                                                   |
| typescript | 5.4.5  | —      | ≥ 5.6 needed for `vite.config.ts` to typecheck and for Pinia; `@typescript-eslint` 7.8 pins `< 5.5`, so it moves to 8 with it                                                                                 |

**Vue 3.5 comes along almost free**: one `yarn add`, mocha and the
reactivity-sensitive scenarios unchanged. The old spec's warning stands —
3.4 rewrote computed and 3.5 made array `watch` shallow, failures show as a
stale sidebar or nick, never in mocha — so it ships as its own step with the
scenarios run.

**Vuex stays; Pinia is not worth it now.** The store is 320 + 124 lines;
the gain is typed `commit`s, the cost is ~51 `commit` sites and store use in ~45 files,
mostly components the suite cannot mount, i.e. a browser-verification
bill. Revisit only if someone wants the typing for its own sake, after the
TypeScript bump.

## Simplifications, ranked by payoff against risk

| Rank | Change                                                                                                                                                                                                                                                   | Payoff                                                                                    | Risk                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | Delete the development build in `test:mocha`/`test:nospec`/`coverage` (row 21); `test:mocha` = real build + mocha                                                                                                                                        | ~11 s off every test run; the stale-`public/` trap goes                                   | None                                                       |
| 2    | Delete dead config: `json3` external, the `debug` replacement, `preserveWhitespace`, the socket.js replacement                                                                                                                                           | Less to read                                                                              | None                                                       |
| 3    | Babel out: `babel.config.cjs`, `@babel/core`, `@babel/preset-env`, `@babel/plugin-transform-runtime`, `babel-preset-typescript-vue3`, `babel-loader`, `babel-plugin-istanbul`                                                                            | Most of the old audit findings; one transformer (Oxc) instead of two                      | Low                                                        |
| 4    | webpack out: `webpack`, `webpack-cli`, `copy-webpack-plugin`, `mini-css-extract-plugin`, `css-loader`, `postcss-loader`, `vue-loader`, `fork-ts-checker-webpack-plugin`, `@types/webpack-env`, `ts-node` (only webpack-cli loaded the TS config with it) | 4 s builds; a config of ~200 lines instead of ~520                                        | Medium                                                     |
| 5    | One bundle instead of bundle + vendor (row 8)                                                                                                                                                                                                            | One file fewer in `index.html`, the SW, the shells' caches                                | Low                                                        |
| 6    | CSS: drop `cssnano`, `postcss-preset-env`, `postcss-import` and let Lightning CSS minify and lower (targets from `build.target`)                                                                                                                         | Three old PostCSS deps out; one minifier                                                  | Low–medium: compare `style.css` before/after, `themes.mjs` |
| 7    | Typecheck out of the bundler: `tsc -b` (and later `vue-tsc`) in `yarn test`                                                                                                                                                                              | Two failures reported separately; `.vue` files checked for the first time                 | Low (needs TS ≥ 5.6)                                       |
| 8    | Prism map instead of the `webpackInclude` regex                                                                                                                                                                                                          | Bundler-agnostic, typo-proof (the `ansi` entry)                                           | None                                                       |
| 9    | Vite dev server (`vite` with HMR)                                                                                                                                                                                                                        | A dev loop nobody uses yet; needs `index.html` as a Vite entry                            | Medium; optional                                           |
| 10   | Vitest instead of mocha + tsx                                                                                                                                                                                                                            | `import.meta.glob` under test, one config; but 3,600 tests and the root-level spy pattern | High; not now                                              |

## Migration plan

Each step is one reviewable PR (draft upstream, only when rdrake asks), runs
the full suite, and leaves `develop` building. Steps 1–3 are webpack-only
and worth doing even if the switch waits.

1. **Shared build helpers and dead config.** `scripts/build-info.ts`
   (identity, branding, transforms, notices) imported by
   `webpack.config.ts`; delete rows 20 and `preserveWhitespace`; Prism map
   (row 9). No output change: diff `public/` before and after.
2. **One bundle.** Drop the vendor cache group under webpack; update
   `index.html`, the SW shell list, `build.ts`. Isolates the SW/precache
   change from the bundler change. Check: `update-signal.mjs`,
   `pwa-check`, an installed PWA opening offline.
3. **TypeScript ≥ 5.6 + `@typescript-eslint` 8**, and the typecheck as its
   own command (`tsc -b`) in `yarn test` and `yarn build`. Root tsconfig
   `module: esnext` / `moduleResolution: bundler`.
4. **The switch.** `vite.config.ts` + `vite.push.config.ts` (the spike's,
   cleaned), `require.context` → `import.meta.glob`, `index.html` module
   script and hashed entry, SW shell list (entry plus its static imports), `build.ts` (entry pinned by name
   in `index.html`, SW and chunks; no CSS map; token in either quote), the
   `test:mocha`/`test:e2e`/`watch` scripts, `pages.yml` unchanged (`yarn build`). Remove webpack, Babel and the loaders (rows 3–4 of the ranking).
   Docs: `CLAUDE.md` Commands, `codebase-guide.md`, `browser-testing.md`,
   comments that say "webpack" (48 files across `client/`, `docs/`, `tools/`,
   `test/`, `shells/`). Check: the
   scenario list above, both native shells, a `/prN/`-style sub-path, Safari.
5. **CSS minification**: Lightning CSS only (ranking 6).
6. **Vue 3.5.44 + Vuex 4.1.0.** Check: `network-panel`, `input-focus`,
   `own-messages`, `themes`, live client test.
7. Later, each on its own: `vue-tsc` in `yarn test` (fix what it finds),
   Router 5, the Vite dev server, Pinia only if wanted.

The `desktop/mac-translate` work rebases onto step 4 or step 4 absorbs it,
whichever lands second (see above).

## Open questions

- Tauri: the full `--smoke` pass once the Vite move and
  `feat/desktop-shells` meet (its `data-shell` code is not on `develop`).

- Is `css/style.css.map` used by anyone? Vite cannot produce it.
- Minify the copied `loading-error-handlers.js` and `service-worker.js`
  (Oxc's `minify` from `rolldown/utils`, 5 lines), or ship them readable?
- Keep `?v=` on `style.css`, `push.js` and `loading-error-handlers.js`, or
  hash those too (each then needs stamping into `index.html`/the SW)?
- Content-hash the lazy chunks too (`[name]-[hash].js`)? Today, as under
  webpack, they keep fixed names without `?v=`, so only the service worker's
  network-first fetch stands between a new entry and a stale chunk (or a
  stale `rolldown-runtime.js`) in the HTTP cache. Hashing them costs nothing
  under Vite: only the entry names them.
