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
`--stay` ms. Note `autoconnect=1`: without it the query parameters only
pre-fill the connect form and no socket is ever opened.

```sh
node tools/browser-drive.mjs --stay=60000 --max-frame=80 \
  --url='http://localhost:8000/?host=localhost&port=8443&tls=true&nick=probe&join=%23seance&autoconnect=1'
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
everything but failures and scenario output.

## Scenarios

A scenario is a `.mjs` module in `tools/scenarios/` whose default export is
`async (page) => {…}`. It may also export `url` as its default target;
`--url=` overrides. The process exits non-zero if any check failed, so a
scenario doubles as a smoke check.

```js
export const url = "http://localhost:8000/";

export default async function run(page) {
  await page.goto(page.url, {waitForSelector: "#connect form"});
  page.check("form is there", (await page.count("#connect form")) === 1);
  await page.screenshot("connect");
}
```

What is in `tools/scenarios/` today:

| Scenario                   | Claim it checks                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `activity-pulse.mjs`       | the sidebar icon pulses for a message and nothing else                                   |
| `media-preview-reveal.mjs` | a media link stays veiled until it is clicked, and nothing is fetched before that        |
| `multiline.mjs`            | a three-line message is one bubble over three lines, sent as one `draft/multiline` batch |
| `seed-media.mjs`           | not a scenario — posts a media link for the one above (see Seeding)                      |

### The `page` API

| Call                                       | Notes                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `goto(url, {waitForSelector})`             | navigate                                                                 |
| `evaluate(expr)`                           | expression string, evaluated in the page, returned by value              |
| `waitFor(expr, {timeout, label})`          | polls `!!(expr)` every 150 ms; `label` makes the timeout message legible |
| `count(selector)`                          | `querySelectorAll(...).length`                                           |
| `rect(selector, index)`                    | bounding box, or `null`                                                  |
| `click(selector, index)`                   | **real** mouse events at the element's centre                            |
| `hover(selector, index)`                   | real `mouseMoved`                                                        |
| `fill(selector, value)`                    | native setter + `input`/`change`, so Vue notices                         |
| `screenshot(name, {selector, pad, clip})`  | PNG into `page.outDir`                                                   |
| `check(label, ok)`                         | records a failure instead of throwing                                    |
| `sleep(ms)`                                |                                                                          |
| `consoleLogs`, `consoleErrors`, `wsFrames` | collected since launch                                                   |
| `send(method, params)`                     | raw CDP, for anything not wrapped                                        |

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
