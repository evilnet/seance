# Push subscriptions per network

_Design, 2026-09-05. Branch `push-per-network` off `push-notifications`.
Status at the end of this document._

## The problem

A browser holds **one push subscription per service-worker registration**,
bound to the `applicationServerKey` it was created with. Seance registered one
worker (scope `./`) and kept one subscription in `thelounge.push`, keyed by
VAPID key, shared by every network announcing that key. Two enabled networks
announcing **different** keys (two ircds, each with its own key — confirmed in
use on 2026-09-05) therefore take the subscription from each other on every
connect: whichever network connects sees a stored subscription made for the
other key, reports it stale, and the renewal (prompted, or silent under
_Naive_) re-creates the subscription for its own key, unregistering the other
network's endpoint. Only one network ever has working push, and the renew
prompt ping-pongs. Nothing in nefarious2 changes for this (per
`feedback`: fix it in the client).

## The design

**One service-worker registration per push-enabled network**, each with its
own subscription against that network's key.

- **Registration.** `webpush.ts` registers the same `service-worker.js` again
  with scope `push/<uuid>/` (relative to the app base, so a deploy under a
  sub-path works) for every network it subscribes. The root registration
  (`./`, `pwa.ts`) keeps the offline shell and the in-page notification relay;
  it no longer holds a push subscription. `navigator.serviceWorker.ready` is
  the root's; a per-network registration is awaited through its own
  `installing`/`waiting` worker reaching `activated`.
- **The worker knows its network.** `self.registration.scope` ending in
  `/push/<uuid>/` makes it a **push-only** worker for that uuid
  (`networkFromScope`, Vue-free in `client/js/helpers/pushStore.ts`, shared by
  the page). A push-only worker skips the shell precache, the cache cleanup on
  activate and the `fetch` handler (nothing lives under its scope), attributes
  every push to its network (today's worker guessed `stash.networks[0]`),
  renews its own subscription on `pushsubscriptionchange` with its network's
  key and credentials, and deep-links to the **app URL** (its scope minus
  `push/<uuid>/`), not its scope.
- **Storage.** `thelounge.push` becomes `{[network uuid]: {vapid, endpoint, keys}}`. The old shape (`{[vapid]: {endpoint, keys}}`) is recognised
  (`parseStoredSubscriptions`) and migrated: its endpoints are kept in
  `thelounge.push.legacy` and `WEBPUSH UNREGISTER`ed from each connecting
  network that announces their key (then dropped), and the root
  registration's subscription is unsubscribed once. The per-network
  subscriptions are then created the normal way — silently when notification
  permission is already granted, which it is on a device that had subscribed.
- **Reconciling with the browser.** At boot the page compares each stored
  entry with its registration's live subscription: no registration or no
  subscription → the entry goes (the device lost it; the next connect
  re-subscribes silently under a granted permission); a different endpoint
  (the worker renewed it) → the entry is updated. `autoRegister` waits for
  that pass so it never re-registers a dead endpoint.
- **Decisions become per network.** `autoRegister(uuid, vapid)` re-REGISTERs
  the entry when its `vapid` matches. `maybePrompt(uuid)`: a "not now"
  answered in this page for that network, kind and key → nothing, even once
  permission has been granted since (by another network's Yes); no entry →
  the subscribe prompt (or a silent subscribe when permission is granted;
  `thelounge.push.neverAsk` still device-wide); entry for another key → the
  `pushKeyChange` policy (Wary prompt / Naive renew / Suspicious nothing).
  The prompt is one at a time: a network that wants it while it is open, or
  while the subscribe a Yes started is in flight (the browser's permission
  dialog; held at most a minute, `PROMPT_HOLD_MAX_MS`), waits, and once the
  prompt is free again the waiting networks that are still connected get
  their turn (`scheduleHandoff`). A silent subscribe asks nothing and never
  waits. A prompt whose network disconnects closes unanswered; one that has
  just opened takes no answer for 450 ms (`PROMPT_ARM_MS`: a double-click's
  second click), and a held Escape's repeats answer nothing. Switching a
  network's push off while it subscribes waits for that run, which stops
  short of storing or registering, then unsubscribes. `subscribe(uuid)`
  creates that network's registration and subscription, unregisters the endpoint it replaces on that network, and
  REGISTERs the new one (plus the payload metadata) on that network only.
  `unsubscribe(uuid)` drops the subscription, tells the network, deletes the
  entry and unregisters the worker; turning push off for a network in its
  settings does exactly that (the old "drop the browser subscription when the
  last network goes off" is now the natural case). `networkPushInfo(uuid)`
  keeps its shape; `stale` means "entry for another key". The stash lists
  each network's `vapid`; `stash.vapid` stays for the root worker.
- **Notifications across registrations.** Each worker's notifications live
  on its registration, so the page's "app opened" cleanup closes `push-*`
  notifications on every registration (`getRegistrations()`), and the app
  badge is summed through one IndexedDB document (`badge`: scope → count)
  that each worker updates and the page resets.
- **Two networks, same key.** Each gets its own subscription. That is two
  endpoints on the device — fine for two accounts (no duplicate delivery);
  two entries for the same ircd _and_ account would be notified twice, which
  was true of the old design's re-subscribe races too and is a configuration
  nobody needs.
- **Not changed.** The bus contract (`webpush:*` events are already per
  network), the `draft/webpush` wire, the push module (`client/js/push/*`),
  the prompts and the `pushKeyChange` setting, the Edit-network Renew button
  (now truly per network), the sidebar bell.

## Verification

- `test/helpers/pushStore.ts`: scope ↔ uuid, stored-shape parsing (new,
  legacy, garbage), staleness per entry.
- `tools/scenarios/push-per-network.mjs` (faked Push API, per scope): two
  networks (two testnet accounts) get two registrations and two REGISTERs; a
  simulated rotation on one prompts for that one, and renewing it leaves the
  other's subscription and endpoint alone; a legacy `thelounge.push` migrates
  (root unsubscribed, legacy endpoint UNREGISTERed, per-network subscriptions
  created silently); push off for one network unsubscribes only it.
- `tools/scenarios/push-renew.mjs` keeps covering the rotation policies on one
  network with the per-scope fake.

## Status

Landed 2026-09-05 on `push-per-network` (merged into `push-notifications`):

- `client/js/push/scope.ts` (`pushScopePath`, `networkFromScope`,
  `appUrlFromScope`; exported to the worker through `self.seancePush`) and
  `client/js/helpers/pushStore.ts` (`parseStoredSubscriptions` with the
  legacy shape, `entryStale`, `anyStale`), both mocha-tested.
- `client/service-worker.js`: `scopeNetwork` / `pushOnly` / `appUrl`; a
  push-only worker skips the shell precache, the cache sweep and `fetch`,
  attributes pushes to its network, renews on `pushsubscriptionchange` with
  its network's key and credentials (asking the page for that network
  otherwise), deep-links to the app URL, and files its notification count
  under its scope in the `badge` document.
- `client/js/webpush.ts` rewritten on per-network entries: registrations on
  demand (`ensureRegistration`, awaited to `activated`), the boot-time sync
  with the browser, the legacy migration (`thelounge.push.legacy`, the root
  subscription dropped), `subscribe(uuid)` / `unsubscribe(uuid)` /
  `renew(uuid)`, per-network `autoRegister`/`maybePrompt`, the stash with a
  `vapid` per network, the app-opened sweep over every registration.
- `tools/browser-drive.mjs` frames carry `requestId`, so a scenario can tell
  two connections apart; the fake Push API is per registration
  (`tools/scenarios/lib/fake-push.mjs`).
- Verified: `push-renew.mjs` (28 checks) and `push-per-network.mjs`
  (22 checks: two registrations and REGISTERs on their own sockets, an
  isolated renewal, the legacy migration, a single-network push-off) against
  the testnet ircd; `yarn test` green.
- Open: the sidebar bell and Settings state are unchanged in shape; the
  root worker still carries the push handler for a device that has not
  migrated yet (harmless once it has: no subscription there).
