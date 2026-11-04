---
name: browser-check
description: Verify a Seance change in a real browser, or debug the IRC WebSocket at frame level (nefarious2 handshake/framing bugs). Use when a change touches client/components/, client/css/, the store or the transport and "it builds and the unit tests pass" is not evidence that it works — or when a connection dies, hangs or reconnects in a loop and you need to see the bytes Chrome actually sent. Not for pure logic changes under client/js/irc/, which test/irc/ already covers.
---

# Checking Seance in a real browser

The mocha suite (`pnpm test`) never mounts a Vue component, never
opens a socket from a browser and never touches the DOM — by design, since
modules under mocha must stay free of store/DOM imports. So nothing in CI or
in `pnpm test` can tell you whether a component renders, whether a click does
what you meant, or what Chrome puts on the wire. `tools/browser-drive.mjs`
is that missing half. Read `docs/resources/browser-testing.md` for the full
API; this is the working procedure.

## Decide which job you have

| You want to know | Do this |
| --- | --- |
| Does this UI change actually work? | Write or extend a scenario (below) |
| Why does the connection die/hang/loop? | Wire watching (below) — no scenario |
| Does the built tree still boot? | `node tools/browser-drive.mjs --url=http://localhost:8000/ --stay=5000` |
| Is the deploy installable as a PWA? | `tools/pwa-check.mjs` instead |
| What does the *server* send? | `tools/irc-ws-probe.mjs` instead — it has no browser, so it cannot show framing |

## Always do this first

```sh
pnpm build                              # public/ is what gets served
python3 -m http.server -d public 8000 &          # or use a running container
tools/nefarious-dev/run.sh -d                    # dev ircd, if IRC is involved
```

`public/` is gitignored and shared by every branch, so **it does not change
when you switch branches** — rebuild after a checkout or you will test the
wrong code. Screenshots land in `tmp/browser-drive/<timestamp>/` (also
gitignored).

## Wire watching

```sh
node tools/browser-drive.mjs --stay=60000 \
  --url='http://localhost:8000/?host=localhost&port=8443&tls=true&nick=probe&join=%23seance'
```

Prints the upgrade request headers with their byte total, the handshake
response, then every frame in both directions with `bytes=` and opcode. The
three nefarious2 bugs this repo has hit are all visible here and nowhere
else:

- **#97** — junk before the 101 corrupts the handshake: look at the handshake
  line and its status.
- **#98** — an inbound frame of **>= 528 bytes** kills the connection: look
  for a large `bytes=` immediately before `ws close`.
- **#99** — an upgrade request of **>= 512 bytes** hangs: `headerBytes≈` on
  the `ws upgrade` line. Browsers send ~550 and cannot be told not to.

`MAX_LINE_BYTES = 500` in `client/js/irc/message.ts` exists because of #98;
if you are ever tempted to raise it, watch the frames first.

Add `--headful` to see the browser, `--devtools` to get DevTools open, and
`--keep` to leave it running after the run.

## Scenarios

A scenario is a `.mjs` module in `tools/scenarios/` whose default export is
`async (page) => {…}`, optionally exporting a default `url`. Run it:

```sh
node tools/browser-drive.mjs tools/scenarios/media-preview-reveal.mjs
```

The API is small: `goto`, `waitFor`, `click`, `hover`, `fill`, `count`,
`rect`, `evaluate`, `screenshot`, `check`, `sleep`, plus `consoleErrors` and
`wsFrames`. `check(label, ok)` records a failure instead of throwing, so one
run reports every problem; the process exits non-zero if any failed, so a
scenario doubles as a smoke check.

Rules that keep scenarios honest:

1. **Use `click`, not `evaluate("el.click()")`.** It dispatches real mouse
   events. Hover-only affordances (the media preview toolbar) never appear
   for a synthetic click, so a synthetic-click test would pass against a
   broken UI.
2. **Assert absence, not just presence.** For anything privacy-shaped, the
   claim is that something is *not* in the DOM and *not* fetched — check the
   element count is 0 and `performance.getEntriesByType("resource")` is
   empty, not merely that a placeholder is visible.
3. **Never reuse a profile** unless you mean to. localStorage (`settings`,
   `thelounge.networks`, `thelounge.media.trusted`) survives within one, so a
   trusted host from the last run silently makes a "first visit" test lie.
   The default throwaway profile handles this; `--profile=` opts out.
4. **Screenshot each state and actually look at it** with the Read tool.
   Assertions confirm what you thought to check; the picture shows the
   layout bug you did not.
5. `page.check("no console errors", page.consoleErrors.length === 0)` at the
   end of every scenario.

## Seeding

Scenarios that need channel content should not depend on scrollback that may
not exist. Post it first:

```sh
node tools/scenarios/seed-media.mjs                    # dev ircd, #seance
node tools/scenarios/seed-media.mjs ws://127.0.0.1:18067/ '#seance'   # e-testnet
```

The dev ircd has no services, so there are no accounts and no `account-tag`.
Anything account-shaped (SASL, `draft/persistence`, media trusted by account)
needs the e-testnet at `~/afternet/e-testnet` — ports 16667/16697/18067/18443,
SASL `seance1`/`seancepass1`.

## When to reach for Playwright instead

This tool is a debugging instrument, not a test framework. If the job grows
into a real suite — many flows, retries, parallelism, CI gating — bring in
Playwright rather than growing `browser-drive.mjs` into a worse version of
it. Frame-level WebSocket inspection is the one thing Playwright does not
expose directly (no opcode, no handshake headers), so keep this for that.
