# Checking Seance in a real browser

`corepack yarn test` never mounts a Vue component, never opens a socket from a
browser and never touches the DOM. That is deliberate — modules that run under
mocha stay free of store and DOM imports — but it means the whole rendering
layer, the store, and everything about how Chrome actually talks to nefarious2
is outside the suite. `tools/browser-drive.mjs` covers that half: it drives a
real Chromium over the DevTools protocol, dependency-free, in the same style as
`tools/pwa-check.mjs`.

It does two jobs.

| Job                                               | Command                                                   |
| ------------------------------------------------- | --------------------------------------------------------- |
| Watch the IRC WebSocket at frame level            | `node tools/browser-drive.mjs --url=… --stay=60000`       |
| Run a UI scenario with assertions and screenshots | `node tools/browser-drive.mjs tools/scenarios/<name>.mjs` |

## Setup

```sh
corepack yarn build                       # public/ is what gets served
python3 -m http.server -d public 8000 &   # or an nginx container over public/
tools/nefarious-dev/run.sh -d             # dev ircd, when IRC is involved
```

`public/` is gitignored and shared across branches, so **it does not change
when you switch branches** — rebuild after a checkout or you test the wrong
code. Screenshots go to `tmp/browser-drive/<timestamp>/` (also gitignored).

Chromium comes from `$CHROME_BIN` or `chromium`; `--chrome=` overrides. The
tool passes `--ignore-certificate-errors` because the dev ircd's certificate is
self-signed.

## Wire watching

With no scenario the tool opens the URL, logs everything, and exits after
`--stay` ms. Query parameters only **pre-fill** the connect form — a URL can
no longer auto-connect (`docs/projects/irc-link-new-server-dialog.md`) — so to
watch a live connection either click Connect yourself (`--headful`), run
`tools/scenarios/link-approval.mjs`, or reuse a `--profile` whose saved
networks already match the link, which connects without the form.

```sh
node tools/browser-drive.mjs --headful --stay=60000 --max-frame=80 \
  --url='http://localhost:8000/?host=localhost&port=8443&tls=true&nick=probe&join=%23seance'
```

```
ws open [664.29] wss://localhost:8443/
ws upgrade [664.29] headerBytes≈535
      Sec-WebSocket-Protocol: text.ircv3.net, binary.ircv3.net
      …
ws handshake [664.29] 101 Switching Protocols protocol=text.ircv3.net
ws → [664.29] text bytes=10 "CAP LS 302"
ws ← [664.29] text bytes=498 ":irc.seance.test CAP * LS * :account-notify account-tag…"
```

This is the view `tools/irc-ws-probe.mjs` cannot give you: that probe is a Node
client, so it shows what the _server_ says, not how _Chrome_ frames what it
sends. All three nefarious2 WebSocket bugs this project has hit are visible
here and nowhere else:

- **#97** — pre-101 auth notices corrupt the handshake. Watch the `ws handshake`
  line and its status; a broken one never reaches 101.
- **#98** — an inbound frame of **>= 528 bytes** kills the connection. Look for
  a large `bytes=` immediately before `ws close`. This is why
  `MAX_LINE_BYTES = 500` exists in `client/js/irc/message.ts`; watch the frames
  before ever raising it.
- **#99** — an upgrade request of **>= 512 bytes** hangs. That is the
  `headerBytes≈` figure, and the run above shows **535** — a browser genuinely
  cannot get under the limit, which is exactly why the server had to be fixed.

All three are fixed upstream (PR #101, 2026-08-28), so against a current ircd
you are confirming they stay fixed; against an older build, this is how you
recognise them.

`--headful` shows the browser, `--devtools` opens DevTools with it, `--keep`
leaves it running afterwards, `--no-ws` silences frames, `--quiet` drops
everything but failures and scenario output. The viewport is 1280×900 unless
`--width=`/`--height=` say otherwise; `--mobile` adds touch emulation and the
mobile viewport flag, so `--width=390 --height=844 --mobile` is a phone (the
`max-width: 768px` layout, off-canvas sidebar and user list). Without
`--mobile` the run declares a mouse (`--blink-settings` hover type 2, pointer
type 4): a headless Chromium with no input device answers `(hover: none)` and
`(pointer: none)`, which is neither a desktop nor a phone, and the
`@media (hover: none)` rules — the message action toolbar's touch mode, say —
would otherwise apply to a run that hovers.

## Scenarios

A scenario is a `.mjs` module in `tools/scenarios/` whose default export is
`async (page) => {…}`. It may also export `url` as its default target;
`--url=` overrides. The process exits non-zero if any check failed, so a
scenario doubles as a smoke check.

A WebSocket frame error is normally counted as a failure of its own, because
one usually means the client sent something the browser or the ircd would not
carry. A scenario that **deliberately drops a connection** is the exception:
the ircd's closing line lands after the browser has begun the close handshake,
so `Data frame received after close` arrives every run. Such a scenario says so
with `export const allowWsFrameErrors = /after close/` (a RegExp, or `true` for
all of them); matching errors are still printed, marked `(expected)`, but do
not fail the run. `sign-in.mjs`, whose subject is a refused login, is the
example.

A page under the driver is kept **attended**: a synthetic `pointermove` is
dispatched every 10 s, because a theme's scene rests 15 s into a window
without the focus — which a headless page is (`document.hasFocus()` is false)
— or after two minutes without input (`themeScene.ts` `createAttention`), and
most scenarios read it running. Focus emulation is left off on purpose: it
would change what `hasFocus()` tells the notification and AWAY paths. A
scenario about the rest exports `sceneRest = true` and drives the focus and
input itself (`scene-rest.mjs`).

```js
export const url = "http://localhost:8000/";
// export const allowWsFrameErrors = /after close/;  // only if it disconnects

export default async function run(page) {
  await page.goto(page.url, {waitForSelector: "#connect form"});
  page.check("form is there", (await page.count("#connect form")) === 1);
  await page.screenshot("connect");
}
```

### The `page` API

| Call                                       | Notes                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `goto(url, {waitForSelector})`             | navigate                                                                               |
| `evaluate(expr)`                           | expression string, evaluated in the page, returned by value                            |
| `waitFor(expr, {timeout, label})`          | polls `!!(expr)` every 150 ms; `label` makes the timeout message legible               |
| `count(selector)`                          | `querySelectorAll(...).length`                                                         |
| `rect(selector, index)`                    | bounding box, or `null`                                                                |
| `click(selector, index)`                   | **real** mouse events at the element's centre                                          |
| `hover(selector, index)`                   | real `mouseMoved`                                                                      |
| `fill(selector, value)`                    | native setter + `input`/`change`, so Vue notices                                       |
| `addInitScript(source)`                    | runs in every new document before page scripts; fakes a browser API                    |
| `screenshot(name, {selector, pad, clip})`  | PNG into `page.outDir`                                                                 |
| `check(label, ok)`                         | records a failure instead of throwing                                                  |
| `sleep(ms)`                                |                                                                                        |
| `consoleLogs`, `consoleErrors`, `wsFrames` | collected since launch; a frame has `dir`, `requestId` (one per socket), `payloadData` |
| `send(method, params)`                     | raw CDP, for anything not wrapped                                                      |
| `expectWsErrors`                           | set true while dials are refused on purpose (a failed dial is otherwise a failure)     |

To take the connection away from under the page — a phone's radio going off —
connect through `tools/scenarios/lib/irc-proxy.mjs`: `startProxy({port, target})`
gives `cut()` (drop every proxied socket without a word), `refuse()` /
`accept()` (every new dial dropped at once, or let through) and `close()`.
`reconnect-after-backoff.mjs` and `disconnected-channel.mjs` are built on it.

To use a cap the testnet ircd leaves off — nefarious2 gates several behind
feature flags that default to off, `CAP_draft_read_marker` among them, and
the rig's conf only sets a few — `tools/scenarios/lib/rig-feature.mjs`
`rigFeature(feature, value)` logs in as the rig's oper and `SET`s it at
runtime, returning whether the cap was in `CAP LS` before and after so the
scenario restores only what it changed. A flip sends `CAP NEW` / `CAP DEL`
to every cap-notify client on the rig, so keep the window short.
`push-mark-read.mjs` is the model.

### Rules that keep a scenario honest

1. **Use `click`, never `evaluate("el.click()")`.** It dispatches real pointer
   events. Hover-only affordances — the media preview toolbar — do not appear
   for a synthetic click, so a synthetic-click test passes against a UI that is
   broken for actual users.
2. **Assert absence, not only presence.** For anything privacy-shaped the claim
   is that something is _not_ in the DOM and _not_ fetched. Check the element
   count is 0 _and_ that the URL is absent from
   `performance.getEntriesByType("resource")`.
3. **Compare against the exact URL.** A blanket "no image was loaded" check is
   always false — the app loads its own logo and icons from the same origin.
   `media-preview-reveal.mjs` reads the link out of the message and tests for
   that one.
4. **Do not trust scrollback.** The dev channel keeps messages from earlier
   runs, some pointing at servers that are no longer up. Seed what you need and
   target the newest preview, not index 0. Getting this wrong produces a
   convincing false failure: an old preview showing "Couldn't load this image"
   looks exactly like a bug you just introduced.
5. **Never reuse a profile** unless you mean to. `settings`,
   `thelounge.networks` and `thelounge.media.trusted` survive in one, so a
   trusted host from the previous run makes a "first visit" assertion lie. The
   throwaway profile is the default; `--profile=` opts out.
6. **Look at the screenshots**, with an image-capable reader. Assertions confirm
   what you thought to check; the picture shows the layout problem you did not.
7. End with `page.check("no console errors", page.consoleErrors.length === 0)`.
8. **A cold load on a route is `history.replaceState` + `Page.reload`**, what F5
   does (`reload-on-settings.mjs` `coldLoad`). `goto` to a URL that differs
   from the current one only by its `#` fragment is a same-document navigation
   — the router moves, nothing boots — and a hop through `about:blank` swaps
   renderer processes, which on a busy box loses the DevTools reply to a poll
   in flight: `send` has no timeout, so the driver hangs for good (renderer
   idle, browser-side calls answered, `Runtime.evaluate` never). Poll with a
   marker set on the old window and tolerate `evaluate` errors while the
   document is being replaced.

### Seeding

```sh
node tools/scenarios/seed-media.mjs                                  # dev ircd, #seance
node tools/scenarios/seed-media.mjs ws://127.0.0.1:18067/ '#seance'   # e-testnet
node tools/scenarios/seed-media.mjs wss://localhost:8443/ '#seance' https://media.invalid/x.mp3
```

Posts a media link with a unique query string so each run is distinguishable
from the scrollback. The dev ircd has no services, so there are no accounts and
no `account-tag`: anything account-shaped (SASL, `draft/persistence`, media
trusted by account) needs the e-testnet described in
`docs/resources/nefarious2-dev.md`.

## What this is not

It is a debugging instrument and a smoke check, not a test framework. There is
no runner, no parallelism, no retries, and nothing here runs in CI.

If the job grows into a real UI suite — many flows, retries, CI gating — bring
in **Playwright** rather than growing `browser-drive.mjs` into a worse version
of it. Playwright's auto-waiting and trace viewer beat anything reasonable to
hand-roll. Two caveats worth knowing before you switch:

- Playwright's WebSocket API surfaces frame **payloads** only — no opcode, no
  handshake request headers — so the byte-level view above still needs a raw
  CDP session even inside Playwright. Keep this tool for that.
- Cheaper than either, for component behaviour: `@vue/test-utils` with
  happy-dom under mocha would cover "veiled by default, revealed on click"
  without a browser at all. That needs a carve-out from the store/DOM-free
  convention (a separate mocha project, or `test/components/`).

## See also

- `tools/irc-ws-probe.mjs` — Node-side CAP/NICK/USER probe; the server's view.
- `tools/pwa-check.mjs` — Chrome's own installability verdict.
- `docs/resources/nefarious2-websocket.md` — the framing rules and the bugs.
- `.claude/skills/browser-check/` — the same procedure as a skill.
