# Push subscription, phase 1: `draft/webpush` REGISTER round-trip

_Noted 2026-09-01. Status: **implemented 2026-09-01** (branch
`feat/webpush-subscribe`): M2–M8 as planned below, the probe at
`tools/webpush-probe.mjs` and the live test at `test/irc/webpush.live.ts` (M1),
unit tests at `test/irc/webpush.ts` (M9), and the browser scenario at
`tools/scenarios/webpush-subscribe.mjs` — all green against the testnet ircd.
One deviation from the text below: the Settings toggle ships **enabled**
(what the verification checklist requires), with the phase-2 caveat that a
push arriving before the worker has a `push` handler would be undeliverable.
Scope: **subscription only** — the client subscribes via the browser Push API
and registers the subscription with the ircd per the draft spec. Delivery
(the service-worker `push` handler) is phase 2 and keeps its plan in
`notifications.md`._

_Live-cycle findings 2026-09-02 (first real trigger attempt, testnet ircd):_

- **The client must send `PERSISTENCE SET ON`** after SASL (same flush as the
  ATTACH): it is the opt-in that _creates_ the server's bouncer session and
  turns its hold on. Without it no session ever exists — regardless of
  `PERSISTENCE STATUS DEFAULT ON` — and a disconnected client can never be
  pushed to. Implemented in `client.ts`/`persistence.ts`; the ack + STATUS
  are swallowed during registration.
- **The server needs `"BOUNCER_ENABLE" = "TRUE"`** — the feature defaults
  off, and with it off `bounce_should_hold` returns NULL before anything
  else is consulted (no session is ever created). testnet's conf now sets
  it; production needs the same.
- **nefarious2 bug found and fixed** (testnet submodule, commit `34d377e`):
  `parse_keys` passed the exact value length to `ircd_strncpy`, which copies
  len-1 chars — browser keys (87-char p256dh, 22-char auth) were stored one
  char short, decoded to 64 bytes, failed the 65-byte check, and every push
  silently skipped in `notify_iter_cb`. Pushes were stored correctly and
  never sent. Upstream-candidate commit in `testnet/nefarious`.
- **Notification actions and merging** (all covered by
  `test/tests/service-worker.ts`): Reply (inline text on desktop; a
  deep-linking button elsewhere) and Mark read (since 2026-09-07; Mute 30m
  before that, see § Mark read replaces Mute 30m) both fall back to a
  throwaway SASL connection the worker opens from the stashed credentials
  — reply sends `PRIVMSG`, Mark read sends `MARKREAD` under
  `draft/read-marker`.
  Same-target pushes merge into one notification whose body combines the
  recent messages with middle-ellipsis truncation; the `t:"read"` relay
  closes a target's notification once another device has read past it.
- **The worker handles nefarious2's tiered JSON payloads** (`{"t":"msg",…}`
  for PMs, `{"t":"hl",…}` for channel messages mentioning the account's
  nick, `{"t":"read",…}` to close what another device already read
  - `text` on the `full` tier — the server DEFAULT since d7dedfb (the
    payload is encrypted server-to-device, so there is nothing to leak;
    accounts can still opt down with `METADATA \* SET draft/webpush/payload
    - :route|ping`under`draft/metadata-2`), falling back to the spec's
      raw IRC line.
  - the spec-shaped raw line (the `full` tier now): parsed by
    `client/js/push/line.ts`, stripped by `push/strip.ts` (IRC formatting
    always, Markdown when the mirrored setting is on), merged and
    reassembled by `push/merge.ts`; `tools/push-line-check.mjs` drives the
    real worker with synthetic lines. A new message re-alerts through
    `renotify`; later lines of a multiline message update the same
    notification silently (tag replacement, no re-alert). The worker's
    mocha suite (`test/tests/service-worker.ts`) exercises the real
    module.
- The whole chain was verified to the edge of the sandbox: session HELD →
  PM → all server gates pass (flag/HOLDING/subscription/cooldown) → push
  emitted → FCM accepted a correctly-signed aes128gcm push for this
  browser's subscription (201 Created, direct-post test). The final
  FCM→headless-browser delivery could not be observed in this sandbox
  (headless Chrome's FCM socket + a test profile degraded by repeated
  subscribe/unsubscribe cycles); the same cycle in a headed browser is the
  remaining manual check.

Sources: [ircv3-specifications PR #471](https://github.com/ircv3/ircv3-specifications/pull/471)
(`extensions/webpush.md`, the `draft/webpush` cap), the nefarious2
`ircv3.2-upgrade` branch (`testnet/nefarious`), and a verified wire-level
round-trip (transcript below).

## What the draft spec requires (PR #471, `draft/webpush`)

- Capability `draft/webpush` (unprefixed `webpush` is forbidden until final).
- The server advertises its VAPID public key in a **`VAPID` ISUPPORT token**
  (URL-safe base64 P-256 ECDSA point, stable for the connection).
- `WEBPUSH REGISTER <endpoint> <keys>` — `<keys>` is message-tag encoded:
  `p256dh=<urlb64>;auth=<urlb64>` (client ECDH P-256 public key + 16-byte
  auth secret — i.e. exactly `PushSubscription.toJSON()`'s keys). Registers
  are idempotent per endpoint (re-REGISTER replaces). Clients SHOULD renew
  (identical REGISTER) periodically and on `pushsubscriptionchange`.
- Success reply: echo `WEBPUSH REGISTER <endpoint>`. `UNREGISTER` likewise
  echoes and MUST silently succeed for unknown endpoints.
- Errors via standard replies: `FAIL WEBPUSH INVALID_PARAMS|INTERNAL_ERROR| MAX_REGISTRATIONS <command> <endpoint> <message>`.
- The pushed payload (phase 2) is one raw IRC line, encrypted aes128gcm
  (RFC 8291) under the client's p256dh key, VAPID-signed (RFC 8292). The
  server's `full` tier does exactly that since the spec-shaped payload
  work (`docs/projects/push-payload-multiline.md`): `@msgid;time;account :nick!user@host PRIVMSG target :text`, a multiline message as one push
  per line in `draft/multiline`'s fallback form (`batch=<base msgid>` on
  every line, the msgid on the first line only, `time` and `account` on
  every line) with a
  vendor ordering tag `evilnet.github.io/line=<i>/<sent>/<total>` (an
  addition the drafts do not mention: push delivery has no ordering
  guarantee, and the payload is still one IRC message), and the read relay
  as `:server MARKREAD target timestamp=…`.
  The `route`/`ping` opt-down tiers stay JSON; they carry no message.

## What nefarious2 `ircv3.2-upgrade` implements

Inventory (all verified by reading the source; branch head `451769d`, merged into `push-notifications` on 2026-09-02):

- **Cap + values** — `draft/webpush` in `capab.h`/`m_cap.c`; the CAP 302
  value is `vapid=<key>` when a VAPID key is available, absent otherwise.
  The same key goes out as ISUPPORT `VAPID=<key>` (`add_isupport_s` in
  `m_webpush.c` `webpush_setup()`); a `CAP NEW`/`CAP DEL` fires when the key
  appears/disappears. Note the ISUPPORT token reaches _every_ client, not
  only `draft/webpush`-enabled ones (minor spec deviation, harmless).
- **Command** — `m_webpush.c`: `WEBPUSH REGISTER <endpoint> <keys>` /
  `WEBPUSH UNREGISTER <endpoint>`, gated on `CapActive(CAP_DRAFT_WEBPUSH)`
  and `IsAccount(sptr)`. Failure codes actually sent: `INVALID_PARAMS`
  (bad keys / endpoint / unknown subcommand / missing cap),
  `ACCOUNT_REQUIRED` (non-spec code), `INTERNAL_ERROR` (store down).
  `MAX_REGISTRATIONS` is never sent (no limit implemented yet) — the client
  should still understand it.
- **Endpoint validation** — HTTPS-only, ≤ 512 bytes, and a hardcoded
  loopback/RFC1918/ULA blocklist (`is_valid_endpoint`). Real FCM/Mozilla
  push-service endpoints pass.
- **Keys parsing** — `p256dh=...;auth=...` split on `;`. **Quirk:** lengths
  are checked with `>=` against `WEBPUSH_MAX_P256DH = 128` /
  `WEBPUSH_MAX_AUTH = 32` _characters_. A 32-char auth string therefore
  FAILS (`INVALID_KEYS` behaviour via `INVALID_PARAMS`); the browser's real
  values (88-char p256dh, 22-char auth) fit with room to spare.
- **Storage + delivery** — subscriptions persist per **account** in the
  db\_\* store (`webpush_store.c`, RocksDB-backed via the branch's db
  abstraction; the "LMDB" comments predate it). Trigger paths
  (`webpush_notify_pm` v1, `webpush_notify_channel` v2, account metadata
  `draft/webpush/payload` = ping/route/full) landed 2026-08-28 and are
  phase-2 material. Delivery prunes HTTP 410 endpoints.
- **Stale-subscription sweep** (2026-09-02) — every REGISTER stamps an
  arming timestamp onto the stored record (`endpoint|p256dh|auth|armed`;
  the S2S `WP` wire format stays 3-field and receivers stamp receipt
  time). A maintenance sweep at boot and then hourly (`webpush_sweep` in
  `m_webpush.c`, the IPcheck `TT_PERIODIC` pattern) removes records not
  re-armed within `FEAT_WEBPUSH_EXPIRE` seconds (default 180 days; `0`
  disables), logging `WEBPUSH: expired N subscription(s)` at INFO.
  Records from before the timestamp field are never swept — the client
  stamps them on its next login (seance re-registers on every load), so
  a swept device simply recovers on its next app start; a device that
  stays connected without reloading longer than the window silently
  loses pushes until it reconnects.
- **VAPID provisioning** — priority order: `WEBPUSH_VAPID_PRIVKEY` feature →
  persisted key in the store → auto-generate + persist. No services (X3)
  involvement despite the stale "from services" comment in `m_cap.c`.
- **Boot wiring** — the whole subsystem only comes up when feature
  `CAP_draft_webpush` is TRUE (default **off**); the store path is the
  `WEBPUSH_DB` feature (default `webpush` under DPATH).

### Wire behaviour verified by probe (`tmp/webpush-register-probe.mjs`)

Against the testnet ircd (below), with SASL PLAIN account `testaccount`:

```
CAP LS 302   →  ... draft/webpush=vapid=BLB6-4OioBPa__W4w93qeXLpdHYwSr8xONZjy_... draft/bouncer ...
CAP REQ :sasl draft/webpush → ACK
AUTHENTICATE PLAIN → + → 900 / 903 (account testaccount)
005 ... VAPID=BLB6-4OioBPa__W4w93qeXLpdHYwSr8xONZjy_...
WEBPUSH REGISTER https://push.example.com/send/... p256dh=<88>;auth=<22>
             →  WEBPUSH REGISTER https://push.example.com/send/...        ✓ echo
WEBPUSH REGISTER ... p256dh=<88>              (no auth)
             →  FAIL WEBPUSH INVALID_PARAMS REGISTER :Invalid keys format …
WEBPUSH REGISTER http://127.0.0.1/x ...
             →  FAIL WEBPUSH INVALID_PARAMS REGISTER :Invalid push endpoint …
WEBPUSH UNREGISTER <endpoint> (never registered)
             →  WEBPUSH UNREGISTER <endpoint>                             ✓ echo
WEBPUSH REGISTER ... (not logged in)
             →  FAIL WEBPUSH ACCOUNT_REQUIRED REGISTER :…
```

Two extra findings that shape the client:

- **A `WEBPUSH REGISTER` sent between 903 and `CAP END` is silently
  dropped** (no echo, no FAIL, no state). Registration commands must go out
  **after 001** — i.e. from `onRegistered()`, not from the SASL `beforeEnd`
  hook.
- The `sasl=PLAIN` mechanism list and the `VAPID` ISUPPORT token are
  advertised even without X3: iauthd-ts (the IAuth program) does SASL
  itself, so **accounts do not require services**.

### The payload-encryption roundtrip (`tmp/push-roundtrip.mjs`, `tmp/wpcrypto*`)

FCM accepts any octet-stream, so a broken server-side encryptor is
invisible in the delivery logs: FCM answers 2xx and the browser silently
discards what it cannot decrypt (no push event, no error anywhere).
After "posting to FCM succeeded but nothing ever showed on any device"
persisted across every other fix, the decisive test was a **local
crypto roundtrip**:

1. Generate a P-256 keypair + auth secret locally, `WEBPUSH REGISTER`
   them under an HTTPS endpoint the ircd can dial (`https:// irc.testnet.local:9099/` — a hostname, because the endpoint validator
   blocks IP literals; `/etc/hosts` maps it to 127.0.0.1 and the system
   CA store trusts the dev cert so libcurl connects).
2. Arm the hold (`PERSISTENCE SET ON`), `QUIT`, then PM the ghost from a
   second (SASL'd — anonymous loopback clients can stall in iauthd
   post-restart) connection.
3. The listener captures the exact POSTed `aes128gcm` body; the script
   decrypts it with the private key (RFC 8291 derivation, AAD empty per
   RFC 8188 §2.2 — "The additional data passed to each invocation of
   AEAD_AES_128_GCM is a zero-length octet sequence") and verifies the
   VAPID JWT signature against the announced key.
4. `tmp/wpcrypto.c` + `tmp/wpcrypto-diff.mjs` diff **every intermediate**
   (base64url decode, ECDH, ikm, cek, nonce) between the ircd's
   verbatim primitives and a reference implementation.

This caught the bug that explained every symptom: `webpush_encrypt`
declared its HKDF info strings with an explicit trailing `\0` **on top
of the implicit string terminator**, so `sizeof()` was one byte longer
than RFC 8291's info (29/25 instead of 28/24). The derived CEK and
nonce were unique garbage — no browser could decrypt anything. The IKM
derivation was unaffected (fixed 144-byte buffer, not a string
literal), which is why REGISTER, ECDH and the envelope all looked
healthy. Fixed in nefarious2 `72fdd37`; the whole chain (REGISTER →
hold → notify → parse → encrypt → VAPID → POST → decrypt) now verifies
end-to-end against reference crypto.

## The test environment (testnet, built and running natively)

`testnet/` ships as Docker Compose (nefarious + X3 + keycloak) but pins the
nefarious submodule to **master**, which has neither the WebSocket support
nor the webpush work — the submodule must move to `ircv3.2-upgrade` for any
of this (seance's target branch; the master pin `b265ced` is an ancestor, so
nothing is lost). In this sandbox Docker cannot run at all (no CAP_NET_ADMIN,
no overlay mounts), so the ircd was built and run **natively** instead; the
X3/keycloak containers are simply not needed for subscription work because
iauthd-ts handles SASL.

What was set up (all in gitignored scratch, reproducible):

```sh
cd /seance/testnet/nefarious
git checkout ircv3.2-upgrade            # submodule was pinned to master
autoreconf -fi
./configure --prefix=/seance/tmp/testnet-run/ircd-install \
    --with-dpath=/seance/tmp/testnet-run/conf \
    --with-maxcon=4096 --with-rocksdb=/usr --with-zstd=/usr --enable-keycloak
make -j && make install
(cd tools/iauthd-ts && npm ci && npm run build)   # IAuth program (SASL)
/seance/tmp/testnet-run/setup.sh        # assembles the conf dir (see below)
su ircrun -c 'cd /seance/tmp/testnet-run/conf && \
   /seance/tmp/testnet-run/ircd-install/bin/ircd -f ircd-docker.conf'
```

`/seance/tmp/testnet-run/setup.sh` derives the runtime config from testnet's
own files with a handful of edits, each of which is a documented trap:

- `base.conf` = `tools/docker/base.conf-dist` with the `%VAR%` substitution
  the Docker entrypoint would have done.
- `ircd.conf` = `testnet/data/ircd.conf`, plus:
  - the **second** duplicate `IAuth` block commented out (only one parses),
    and the program path pointed at `iauthd-ts/dist/index.js` (`tsconfig`
    outDir is `dist/`; the stock conf's `iauthd-ts/index.js` assumes a
    docker layout that flattens it);
  - static SASL users enabled as **`#IAUTH SASLDB <path>`** — iauthd-ts
    only reads `^#IAUTH <directive>` lines, which the ircd treats as
    comments; the stock `#DISABLED# SASLDB` form is invisible to _both_
    parsers, and the active keycloak provider line must be double-`#`
    commented to disable;
  - the X3 `Port`/`Connect` blocks commented out (no services running);
  - appended `Port { port = 8067; websocket = yes; }` and
    `Port { port = 8443; ssl = yes; websocket = yes; }` (the compose config
    has no WebSocket ports at all), and a `Features` block with
    `"CAP_draft_webpush" = "TRUE"`, `"WEBPUSH_DB" = ".../webpush"`, the
    usual IPCHECK clone-limit relaxations for reconnect-heavy testing, and
    (2026-09-03, multi-tab) `"BOUNCER_REQUIRE_TLS" = "FALSE"` +
    `"BOUNCER_MAX_SESSIONS" = "5"`: one session per account is structural,
    so a second tab with the same identity attaches as an **alias** to the
    live session — but the alias attach is refused for plaintext sockets
    while the (default-on) `BOUNCER_REQUIRE_TLS` holds. With TLS off,
    `NOTE BOUNCER ALIAS_ATTACHED` announces the attach; the tabs share the
    session's delivery stream (read markers included).
- `ircd-docker.conf` (the three `include`s), a self-signed `ircd.pem`, the
  `saslusers` file (`testaccount:mypassword`), and empty store dirs.
- The ircd refuses to run as root: it runs as user `ircrun`.

`tools/irc-ws-probe.mjs` shows the cap advertisement; the full REGISTER
round-trip probe lives at `tmp/webpush-register-probe.mjs` (promote it to
`tools/webpush-probe.mjs` as part of M1 below).

The seance client was then verified against this ircd in a real Chromium
(`tools/browser-drive.mjs`, `--chrome` wrapper adding `--no-sandbox` because
the sandbox runs as root):

```
http://127.0.0.1:8000/?host=127.0.0.1&port=8067&tls=false&nick=seance1
  &join=%23seance&sasl=plain&saslAccount=testaccount&saslPassword=mypassword
  &autoconnect=1
→ ws://127.0.0.1:8067/ handshake (text.ircv3.net), CAP LS 302, ACK,
  SASL PLAIN → 900/903, 001, PERSISTENCE STATUS DEFAULT ON,
  JOIN #seance, CHATHISTORY LATEST, MODE, names — screenshot taken
```

## Implementation plan (seance client)

Design baseline: `notifications.md` § "Client-side push design". One browser
`PushSubscription` per profile (the endpoint belongs to the service-worker
registration); the _same_ endpoint+keys get REGISTERed with every network
whose account we are logged in to. All state changes flow through
`client/js/webpush.ts`; no component touches the IRC layer directly.

**M1 — probe + fixtures (no product code).** Promote
`tmp/webpush-register-probe.mjs` → `tools/webpush-probe.mjs` (SASL +
REGISTER/UNREGISTER round-trip, `--insecure` for wss). Add a live mocha file
`test/irc/webpush.live.ts` (gated on `SEANCE_IRC_URL`, one-at-a-time rule
per CLAUDE.md) asserting the echo/FAIL behaviour — this is the acceptance
test for everything below.

**M2 — capability negotiation.** `client/js/irc/caps.ts`: add
`"draft/webpush"` to `SEANCE_CAPS.wanted`, with an `accept` hook entry
requesting it only when the CAP 302 value parses as `vapid=<urlb64>` (the
server lists the cap without a value when no key exists; requesting anyway
is useless). Store the advertised key on the client (see M4). NB: the
negotiator's `accept` is also consulted on NAK-retry; keep it pure.

**M3 — ISUPPORT.** `client/js/irc/isupport.ts`: typed accessor
`get vapid(): string | undefined` reading the `VAPID` token (spec source of
truth after registration; cross-check against the cap value — prefer
whichever is present, they are the same key on this branch).

**M4 — client lifecycle.** `client/js/irc/client.ts`:

- `onRegistered()` (post-001, the only correct point — see the probe
  finding): if `draft/webpush` is enabled and the store has a subscription
  for this network, send `WEBPUSH REGISTER`. Sent in `autojoin()`'s flush —
  one extra line against the ~2 s/command fake lag is fine, and
  re-registering on every connect satisfies the spec's renewal advice for
  free.
- New methods `webpushRegister(endpoint, keys)` /
  `webpushUnregister(endpoint)` building the lines (`formatLine`-style,
  mindful of `MAX_LINE_BYTES = 500`: a 500-byte cap must never split a
  REGISTER — guard and refuse before sending).

**M5 — inbound handlers.** New `client/js/irc/handlers/webpush.ts`
(`{WEBPUSH: handler}` → one entry in `handlers/index.ts` `modules`) handling
both echoes: dispatch a bus event `webpush:state {network, endpoint, ok, reason?}`. Extend `handlers/standard-replies.ts` so `FAIL WEBPUSH …`
(`INVALID_PARAMS`, `ACCOUNT_REQUIRED`, `INTERNAL_ERROR`,
`MAX_REGISTRATIONS`) routes to the same event instead of falling into the
generic FAIL path — follow the `REDACT`/`CHATHISTORY` precedent there. The
`ACCOUNT_REQUIRED` code is non-spec but real; map it to a distinct reason.

**M6 — bus contract.** `shared/types/socket-events.d.ts`
(`ClientToServerEvents`): `webpush:register {network: string; endpoint: string; keys: {p256dh: string; auth: string}}` and `webpush:unregister {network: string; endpoint: string}`. Wire them in `client/js/irc/bus.ts`
(`bus.handle(...)` → look up the client by uuid → M4 methods), exactly like
`network:*`. Update `docs/resources/bus-contract.md` (§ client→server
events) — the IRC layer dispatches against that contract.

**M7 — `client/js/webpush.ts` (replaces the stub).** The state machine:

- `pushNotificationState`: `unsupported` (no `PushManager`/no SW/ insecure
  context — Electron and Capacitor shells included, per the platform
  matrix) / `not-installed` (iOS: PWA not on the Home Screen) / `denied` /
  `blocked` (server refused) / `stale` (stored subscription made against a
  key no connected server announces — see § VAPID rotation) / `subscribed` /
  `unsubscribed`. The store already has the field (`store.ts`).
- `subscribe(networks)` — user-gesture entry point (Settings button):
  `Notification.requestPermission()` → `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapid)})`
  → persist `{endpoint, keys, vapid}` under `thelounge.push` (localStorage;
  keys stay `thelounge.*` per convention) → emit `webpush:register` for each
  logged-in network advertising the cap. The VAPID key comes from the
  network's negotiated cap/ISUPPORT; refuse to subscribe against a network
  whose server did not advertise one.
- `unsubscribe()` — `pushManager.unsubscribe()` + `webpush:unregister` to
  every network it was registered with. Note the endpoint is shared across
  networks: only unsubscribe from the _push service_ after the last network
  dropped it (per-account removal on the server is independent).
- Re-subscribe triggers: VAPID key change observed on a later connect
  (`pushsubscriptionchange` has no ircd trigger — the ISUPPORT comparison on
  reconnect is our detection), and the daily renewal recommended by the
  spec is covered by the on-connect re-REGISTER (M4).
- The SW itself needs no changes in phase 1 (the `push` handler is phase
  2); `userVisibleOnly` means the first real push will show a notification,
  so do not subscribe users before the worker can render one — phase 1
  ships the subscription UI **behind the existing disabled button**, enabled
  in phase 2. (Revisit if we want phase 1 user-testable in the wild.)

**M8 — Settings UX.** `client/components/Settings/Notifications.vue`: the
"Subscribe to push notifications" button (today hardcoded `disabled`)
becomes driven by `pushNotificationState` + per-network capability (server
supports `draft/webpush`?). Status text per state; the iOS Home-Screen hint
from the matrix. No new settings keys yet (`desktopNotifications` is the
in-app layer, independent).

**M9 — tests.** `test/irc/webpush.ts` (FakeTransport + `sinon.spy(socket, "dispatch")`, honouring the root-level spy convention in `test/irc/client.ts`):
cap acceptance/rejection of the `vapid=` value; REGISTER line shape and the
500-byte guard; echo/FAIL dispatch, including `ACCOUNT_REQUIRED`;
on-register/off-register lifecycle around `onRegistered()`. Run with
`SEANCE_IRC_URL` set: `test/irc/webpush.live.ts` from M1.

## Per-network push settings (2026-09-02)

Push settings moved out of the system-wide Settings screen into **network
settings**: some servers support `draft/webpush`, others do not, and the
choices are independent per network. The one browser subscription is shared
(security-origin + service-worker registration); per-network flags only
decide _who gets told about it_:

- **The flag.** `SavedNetwork.pushEnabled` (`client/js/irc/saved-networks.ts`),
  persisted in `thelounge.networks`. Missing flag = enabled, so entries from
  before the flag existed read enabled — no migration. Only an explicit
  `false` opts a network out (helper `pushEnabledOf`, unit-tested in
  `test/irc/saved-networks.ts`).
- **The form.** "Push notifications for this network" checkbox in
  `NetworkForm.vue` (the Edit-network window) and in the Connect
  (add-network) form, saved through the normal `network:edit` /
  `createNetwork` paths. New networks default to enabled on both - the
  flag means "register when the server supports it", which is what nearly
  everyone wants; the checkbox is where you opt a network out up front.
- **The gate.** `client/js/webpush.ts` reads the flag at every per-network
  touchpoint: `autoRegister` (no REGISTER on connect), `subscribe` (no
  registration loop membership, and the "at least one account" guard only
  counts enabled networks), `setSnooze` (mute metadata only to enabled
  networks), the connect-time prompt (only offered for enabled networks),
  and the SW stash (`writeStash` — a disabled network's credentials are
  dropped from quick-reply/renewal). `webpush.onNetworkSaved()` — called
  from NetworkEdit after `network:edit` — reacts to toggles: off sends
  `WEBPUSH UNREGISTER` for that network immediately, and when the last
  enabled push-capable network goes off, drops the browser subscription
  entirely; on re-registers the stored subscription (immediately when
  connected, else via the next `webpush:available`).
- **Settings → Notifications** keeps only what is genuinely browser-global:
  the diagnostics (permission, iOS install hint, unsupported browser,
  server-refused) and the account-wide snooze, plus a hint pointing at the
  network settings (2026-09-03: the read-only Settings list and the status
  dot were removed; an editor status line was added the same day and then
  dropped as redundant — the **sidebar bell** is the per-network status
  indicator). The editor also gained the per-network **browser
  notifications** checkbox (default on, not gated on authentication;
  toggling it on is the gesture for the Notification permission ask) —
  see `docs/projects/notifications.md`.
- **Scenarios.** `tools/scenarios/push-network-setting.mjs` drives the
  checkbox ↔ storage ↔ editor-status round-trip headlessly;
  `tools/scenarios/ui-cleanup.mjs` asserts the Settings panel keeps only
  the hint/snooze/warnings (no rows, no status dot, no global toggle).

The register/unregister, subscription map and stash behaviour are unchanged
for every network that does not explicitly opt out — the flag gates
delivery per network, it does not fragment the subscription.

## Pushing to attached sessions: the idle gate + the seen ring (2026-09-03)

The classic policy pushes only **HOLDING** sessions — no client attached.
Users who leave a client permanently connected but backgrounded never
hold, so they never get pushes, and their attached desktop also **blocked
pushes to their other devices** (the session is per account, so one live
socket suppressed the account-wide push). Two coordinated halves fix that;
both must ship together:

- **Server: `FEAT_WEBPUSH_IDLE`** (seconds; `0` = off, the default). When a
  message targets an **attached** session, `m_webpush.c`
  (`webpush_attached_idle_ok` → the pure `webpush_idle_permits` in
  `webpush_idle.c`) opens the gate once the session's `hs_last_active` is
  at least that old. The signal is deliberately coarse: `hs_last_active` is
  bumped at attach and on every PRIVMSG the account sends
  (`bounce_record_activity`), and NOT by PING/PONG keepalives
  (`IDLE_FROM_MSG` keeps `parse.c` out), so keepalive-only connections age
  out. An actively-chatting session never crosses the threshold. Unit
  tests: `ircd/test/webpush_idle_cmocka.c`.
- **Client: the "seen" ring** (`client/js/push-seen.ts` +
  `service-worker.js`). A live page that received a message over its own
  WebSocket records the msgid into an IndexedDB ring (last 200, key `seen`
  in the `seance-push` DB); the worker's push handler drops any
  `t:"msg"/"hl"` push whose msgid is already there — the page owns its
  notifications, its own rules decide what the user sees. `t:"read"`
  closes are never deduped, and the raw-line fallback carries no msgid so
  it never dedups. Recorded subset = what the server can push: PMs
  (QUERY channels) and channel highlights. A frozen page writes nothing —
  which is exactly when the push must show. Unit tests: the SW harness in
  `test/tests/service-worker.ts`.

Net effect: focused tab → local notifications only (pushes deduped away);
backgrounded-but-alive tab → local notification, FCM duplicate silently
dropped; frozen or closed tab → the push shows; and the always-connected
desktop stops blocking pushes to the user's phone.

Verified live against testnet (FEAT_WEBPUSH_IDLE 60): an attached, silent
for 76s session — which answered server PINGs the whole time, proving
keepalives don't reset the clock — gets `WebPush: idle gate: state=attached age=76` and the push pipeline runs (`notify_pm entry` → `notify_account` →
delivery attempt). The gate line is permanent: it explains in the log why
any push did or did not fire.

Sidebar bell states (the per-network status indicator): solid **green**
bell = subscribed; **muted** bell = enabled, not subscribed (the shipped
font is FA5 solid-only, so the outline variant does not exist — the colour
separates the states); **bell-slash** = notifications off for the network.

### The dropped duplicate is a silent push (2026-10-01)

"FCM duplicate silently dropped" above was the bug. Chrome enforces
`userVisibleOnly` per **service-worker registration**: when a push event
ends, it counts the visible notifications of the registration the push
arrived on, and a push that leaves none (and has no visible tab of the
site) spends silent-push budget; once that is gone Chrome shows its own
"This site has been updated in the background"
(`push_messaging_notification_manager.cc` `DidCountVisibleNotifications`;
hiding one does not count either). Since pushes moved to one registration
per network (`push/<uuid>/`, 2026-09-05) the page's own notification sat on
the **root** registration, so every push the seen ring dropped was silent —
and with `AWAY *` for an unfocused or hidden page (2026-09-11) the server
pushes exactly while a desktop page keeps running in the background. Seen on
Windows, not Android: a hidden Android page freezes, records nothing, and
its pushes show.

The fix: for a network this device is subscribed on, the page hands its
notification to that network's push worker with the message itself
(`socket-events/msg.ts` → `webpush.pushWorkerFor(uuid)`, the `notification`
message gaining `message: {msgid, from, text, time, notice}`), and the
worker shows it exactly as the push would be shown (`showMessage`, the
push path's own code: tag `push-<target>`, merged by msgid, Mark read and
Reply, in the same queue as the pushes). The push for the same message
then finds a notification on its own registration; one that lands first is
merged into rather than shown twice. Invites, messages without a msgid and
networks without a subscription keep the root path. A push-only worker
from before this shows such a payload the per-channel way — still on its
own registration. The page also closes what it put there: the server's read
push only follows a message it pushed, so a notification the page showed
while the account was attended would otherwise outlive the read and come
back counted in the next push. Opening a conversation, the window coming
back to an open one, and another session reading one to the end
(`markread` with nothing unread) send `{type: "read", target}` to the
network's push worker (`webpush.ts` `readOnWorker`), which closes through
`closeForTarget` — a message, not a push, so it costs no budget. It
compares targets the way IRC does (rfc1459 folding, ASCII only — the
worker's `sameName`), since the open conversation and the notification
need not spell the target alike; read relays get the same comparison.

The page's copy takes the push's shape whatever the message, so the two
merge by msgid: a private NOTICE that highlights (shown in the lobby) is
keyed on its sender like the pushed one — a click opens a query with them,
Reply answers them — no longer on the lobby.

Left as it was:

- A read relay that closes the last notification is still silent (the gate
  in nefarious2 2f51539 keeps that to one per pushed conversation, as on
  Android).
- **A muted conversation is still silent.** `socket-events/msg.ts` records
  every highlight and query message as seen, muted or not, while
  `notifyMessage` shows nothing for a muted channel; the ircd does not know
  about the client's mutes (`thelounge.muted`), pushes anyway, and the
  worker drops the push as seen. Letting it through would notify a muted
  channel whenever a desktop page is in the background, so the follow-up is
  on the server's side: write the mutes into the account's
  `draft/webpush/mute` metadata (`target:until;…`, which the ircd already
  enforces, `ircd/webpush_mute.c`). That makes a mute account-wide (the
  phone stops too), and has to merge with `setSnooze`, which today writes
  the whole key as `*:<until>`, and with mutes set on other devices.

Harness: "service worker page notifications on a push worker"; browser
check: `tools/scenarios/push-page-notification.mjs` (seeded subscription on
the faked Push API, a bot's PM over a real ircd).

## Replying from a notification, and opening it (2026-09-04)

Reported from a phone: a reply typed into a push notification never went
out, and tapping a notification opened the app on whatever it last showed.
Root causes, each confirmed against the testnet ircd and all fixed:

- **The reply never opened a connection.** The worker only sent when the
  page had stashed a remembered password, and otherwise silently opened the
  app and dropped the text. The ircd's SASL chain log records every nick it
  sees, and the worker's fixed nick `seance-sw` appears in none of the
  user's sessions — the failure was upstream of the socket.
- **A fixed nick collides with its own ghost.** nefarious2's bouncer holds
  a QUIT'd account session as a ghost that keeps its nick, so the second
  reply ever sent as `seance-sw` gets `433`, which the worker did not
  handle — a 10 s timeout, then nothing.
- **A channel PRIVMSG fired at 001 races the bouncer's replay.** Logging in
  as the account attaches the connection to the account's session (an
  alias while the app is connected elsewhere, a resume of the held session
  otherwise); the session's `JOIN`s are replayed right _after_ 001, and a
  PRIVMSG sent at 001 came back `404 Cannot send to channel` in one run out
  of five. A PM has no such race.
- **Clicks could not name a conversation.** Channel ids are session-local;
  a notification that outlived the page could only open the app root.

What ships (`client/service-worker.js`, `test/tests/service-worker.ts`,
`client/js/webpush.ts`, `router.ts`, `helpers/pendingTarget.ts`):

- **A reply is never lost.** Three senders, tried in order: an open page
  (any window, posted with a `MessageChannel`; a frozen page never answers
  and is given 2.5 s), the worker's own throwaway connection when the
  password is stashed, and otherwise the IndexedDB `outbox` plus opening
  the app on the conversation — the page drains the outbox on
  `webpush:available` (post-001) through the new `send` bus emit
  (bus-contract §2.1). A Reply button without text (no inline field) opens
  the conversation.
- **The throwaway connection** uses a random `seance-xxxxxx` nick, retries
  another on `433`/`436`/`437`, fails fast on `CAP NAK`/`ERROR`/close, waits
  for its own `JOIN` of the target (or the `Session resumed` notice, or a
  1.5 s settle) before a channel PRIVMSG, retries once on `404`, splits
  long text into frame-sized lines, and only then `QUIT`s. Renewal after
  `pushsubscriptionchange` sends `WEBPUSH REGISTER` after 001 (the
  pre-`CAP END` window it used before is silently dropped — see above).
- **The stash is rewritten on every connect** (`autoRegister`) and on every
  network save, for every push-enabled network that announced a key: uuid,
  host, port, tls, account — the password only when remembered. That is what
  lets the worker deep-link and relay without a login, and log in when it
  may.
- **Deep links by network + target.** Every notification carries
  `data.network`/`data.target` (page notifications get them from `msg.ts`;
  push notifications from the stash). A click posts `{type: "open", network, target}`
  to an open page or opens `#/net/<uuid>/<target>`; the route resolves to
  the channel when it exists, else remembers the pair (60 s TTL) and lands
  on the network (or the connect form, whose autoconnect brings it up) —
  `socket-events/join.ts` switches when that join arrives and holds the
  view still meanwhile, `network.ts` opens a `/query` for a nick target.

Verified in a real Chromium against the rig (`tmp/sw-reply-probe2.mjs`,
all six modes; a listener in `#seance` confirmed every delivery): page relay
acked in 5 ms with no throwaway socket; held session → worker connection →
delivered in 744 ms, the JOIN replay observed at 136 ms; queued reply
delivered by the reopened page 1.4 s after it booted, outbox emptied; click
moved an open page from Settings to `#seance`; a cold start on the deep link
landed on `#seance` 313 ms after boot.

Two facts about the server worth keeping: a resumed or attached
connection is renamed to the session's nick (`001 <session-nick>`), so the
worker must read its nick from 001; and `WEBPUSH_MAX_REGISTRATIONS`
(default 10) now refuses an eleventh device with
`FAIL WEBPUSH MAX_REGISTRATIONS` — fresh browser profiles against one test
account hit it quickly.

### Foreground reconnect (same day)

`docs/projects/seamless-reconnect.md` round six. A frozen tab thawing
took 2.0 s to be registered again; now 0.2 s: `transport.ts` retries at
once (no backoff) when a connection that was stable for 30 s drops, or
when the socket dies while a probe is in flight (the foreground poke runs
before the OS delivers the close), backing off only if that retry fails
too; `probe()` takes the poke's shorter 4 s deadline; a dial stuck in
CONNECTING is abandoned after 15 s and redialled at foreground time after
3 s; `foreground.ts` also listens for `resume` (Page Lifecycle thaw) and
`focus`. Measured with `tmp/sw-reply-probe2.mjs reconnect` (freeze via
DevTools, drop the socket at the dev-origin's `POST /__drop`, thaw).

Open: two `You are not connected…` lobby lines appear at the moment of the
redial (something sends twice during the ~5 ms before the new socket
opens); pre-existing, cosmetic, not yet attributed.

## A reply is one reply, and answers its message (2026-09-05)

Reported: replying to a channel push shows an immediate second
notification, as if the reply re-triggered it; merged notifications seemed
to add to what was there rather than replace it. Also asked for: the reply
should be an IRCv3 reply, and Mute 30m should sit left of Reply (a thumb on
a phone reaches the right edge). Findings against the rig, all with the
real worker driven over DevTools (`tmp/`-style probes kept in the job
scratch: `sw-reply-dup-probe.mjs` page/held/frozen/thaw, and a push oracle
`push-reply-oracle.mjs` that registers a local endpoint and decrypts what
the ircd POSTs after the account replies):

- **The server never pushes the reply back.** `webpush_hl_account` skips
  the sender's own account ("no self-highlights via own aliases"), so a
  reply sent from a resumed held session, from an alias, or from the live
  page produces no POST — measured 0 further pushes in every mode, with or
  without a `+draft/reply` tag (the ircd relays the tag unchanged).
- **The page could send the relayed reply a second time.** The worker
  posts the reply to an open page and waits 2.5 s; a frozen page (Android
  in the background, DevTools `Page.setWebLifecycleState`) answers
  nothing, so the worker sends over its own connection — and when the page
  thaws it still processes the queued message and sends the same reply
  again. On the rig only a socket the freeze had killed stopped the second
  copy (the channel got `Not sent (connection lost)`); on a phone whose
  socket survives a short freeze it would have gone out twice.
- **Every open window sent the reply.** `replyViaPage` posted to all
  window clients at once and each page's `sendReplyNow` sent it: two
  windows, two copies.
- **A push delivered twice grew the body.** A plain message was appended
  again by `addMessage` (only batch lines were idempotent), counted, and
  re-alerted; and once the user had answered — the notification closed —
  the worker had no memory of it, so a redelivery (push services promise
  at-least-once, the ircd may retry, and a root and a per-network worker
  share the store) showed the message afresh. This is the one path that
  matches "adding more of it" and could not be reproduced without a real
  push service.

What ships (`client/service-worker.js`, `client/js/push/merge.ts`,
`client/js/irc/bus.ts`, `client/js/webpush.ts`, `shared/types/socket-events.d.ts`;
tests in `test/tests/service-worker.ts`, `test/push/merge.ts`, `test/irc/client.ts`):

- **IRCv3 reply.** The notification's newest message is what a typed reply
  answers: `replyTo` (its msgid; a batch entry's is the message's) rides
  the page relay and the outbox entry, the `send` bus emit gains `replyTo`
  and `bus.ts` puts `+draft/reply=<msgid>` on the PRIVMSG (every chunk),
  and the throwaway connection asks for `message-tags` when CAP LS offers
  it (LS continuation lines are accumulated; a NAK of the pair falls back
  to `sasl` alone) and prefixes `@+draft/reply=<msgid> ` when ACKed.
- **One page at a time, with a deadline.** `replyViaPage` asks the
  visible/focused window first and the others only if it says no or stays
  silent; the message carries `deadline` (epoch ms, the end of the
  worker's wait) and `webpush.ts` answers `{ok: false}` without sending
  when it receives the message after that — the worker has already sent
  or queued it (bus-contract §2.2).
- **The worker remembers what it showed.** After `showNotification` the
  msgid (a batch line as `<batch>#<index>`, the batch reference being the
  base msgid every pushed line of a multiline message carries, since only
  its first line has the msgid) goes into the same IndexedDB `seen` ring
  the page writes (`idbAppend`, one read-modify-write transaction, capped
  like push-seen.ts), and the push handler drops a push whose msgid, batch
  reference or line key is there; `addMessage` is idempotent by msgid for
  plain messages too, and a plain duplicate the ring lost is not re-shown.
  The page's rule is unchanged: the batch msgid it saw on the opener is the
  reference on every line, so every line is blocked whichever arrives
  first.
- **Actions:** `[Mute 30m, Reply]` (Mark read took Mute's slot on
  2026-09-07, see § Mark read replaces Mute 30m).

Verified on the rig with the probes above: page relay acked in 8 ms and the
page sent `@+draft/reply=…;label=s1 PRIVMSG`; held session → throwaway
`@+draft/reply=<msgid> PRIVMSG` delivered once in 744 ms; frozen page with
the password stashed → throwaway sent it, the thawed page sent nothing (no
`Not sent` line, the listener saw one copy); frozen page without a stash →
outbox entry with `replyTo`, sent once with the tag by the reopened page.

Not changed, worth knowing: a thawed page whose socket survived a freeze
processes the buffered highlights live; on the rig (1.5 s freeze, socket
kept) it posted no notification of its own for them. Whether Enter submits
the inline reply is the platform's notification UI, not the page's: the
Notifications API only lets the worker declare a `text` action with a
title and placeholder.

## Mark read replaces Mute 30m (2026-09-07)

Asked: Mute 30m had no value next to Reply (the OS mutes a site or app
well enough); what else could that slot do? Chosen: **Mark read** — the
second action Slack, Discord, Teams and WhatsApp settled on, and the
natural complement of Reply: "seen, no answer needed".

- **What it does.** Sets the account's read marker for the conversation at
  the notification's newest message (`data.time`; the click's time when the
  push carried none). nefarious2 stores it, echoes it to the account's
  sessions and relays it to every push subscription (`m_markread.c` →
  `webpush_notify_read`), and the worker already closes the matching
  notification on that relay — so one tap on the phone clears the
  notification on the laptop too, and the app opens with `firstUnread` in
  the right place through the normal inbound `MARKREAD` handler.
- **Three roads, like a reply** (`handleMarkRead`): an open page first
  (`{type: "markread", network, target, time, deadline}` over a
  `MessageChannel`, one page at a time, the visible one first; the page
  answers through the new `markread` bus emit → `IrcClient.markRead` →
  `handlers/markread.ts` `markReadAt`, which sends at once and moves the
  channel's own marker forward so the debounced path never follows with an
  older one — a query with no window still gets its marker), then the
  worker's throwaway connection (`swMarkRead`: `draft/read-marker` in its
  `CAP REQ` — `swIrcOpen` now takes the optional caps to ask for,
  `message-tags` for a reply — and `MARKREAD` sent at 001, since no channel
  membership is involved nothing races the bouncer's JOIN replay; the echo
  at our timestamp or 600 ms of silence is success, a `FAIL MARKREAD`, a
  421 or a server without the cap is not), then the outbox (an entry with
  `type: "markread"`; the page's `drainOutbox` sends entries by `type`, and
  an entry without one is a reply from an earlier build). A marker is
  nothing to type, so the last road does **not** open the app.
- **The notification closes locally whatever happened**, and the badge is
  recounted: the tap is never a no-op.
- **Removed:** `swMute`, `mergeMuteEntry`, the `mute30` action and the
  harness's mute-list scripting. Settings' account-wide snooze
  (`webpush.setSnooze`, page-side metadata) is untouched.
- **What the OS cannot do instead:** an OS mute is per site or app, never
  per channel across devices — the one thing Mute 30m did that nothing else
  does. Judged not worth the slot.
- **Platforms:** Chrome shows two actions, Firefox none, iOS none for web
  push — Mark read exists on Chrome desktop and Android only, like Reply.
- Tests: `test/tests/service-worker.ts` § service worker mark read (the
  throwaway at the notification's time, a channel at 001, the click time
  without a `time` tag, page first, a frozen page, the outbox without a
  login, without the cap, on a FAIL) and `test/irc/markread.ts` § a marker
  asked for by the page (undebounced send, a query without a window,
  nothing without the cap).
- Browser: `tools/scenarios/push-mark-read.mjs` — the page's road against
  the rig (relay → `{ok: true}` → `MARKREAD` on the wire → the server's
  echo; a query with no window; a stale deadline refused; an outbox entry
  drained on the next visit and the outbox emptied). **nefarious2 defaults
  `CAP_draft_read_marker` to off and the rig's conf does not set it**, so
  the scenario switches it on for the run through the rig's oper
  (`tools/scenarios/lib/rig-feature.mjs`, `SET CAP_draft_read_marker TRUE`)
  and back off after; with the feature off no client gets the cap and the
  page never sends a marker. A throwaway probe of `swMarkRead` against the
  rig (2026-09-07) showed `CAP REQ :sasl draft/read-marker` acknowledged,
  the marker sent at 001 ahead of the bouncer's replay, the volunteered
  `MARKREAD #seance timestamp=*` ignored and the true echo 100 ms after the
  dial. The server clamps a marker dated in the future to its own clock.
- On a deploy whose ircd leaves the feature off, the tap still closes the
  notification: the throwaway sees no cap, the entry goes to the outbox,
  and the page consumes it on the next connect without sending (connected
  is enough — there is nothing better to do with it later).

## Verification checklist (phase 1 done = all of these)

1. `corepack yarn test` green (lint + mocha).
2. `node tools/webpush-probe.mjs ws://127.0.0.1:8067/` prints the full
   echo/FAIL transcript above.
3. Live mocha: `SEANCE_IRC_URL=ws://127.0.0.1:8067/ … test/irc/webpush.live.ts`.
4. `tools/browser-drive.mjs` scenario: Settings → subscribe → frames show
   `WEBPUSH REGISTER` → echo → state `subscribed`; reload reconnects and
   re-REGISTERs; toggling off sends `UNREGISTER` and the echo lands.
5. Manual on a real browser+account (FCM endpoint, needs https or
   localhost): subscription endpoint is a real `https://fcm.googleapis.com/…`
   URL, ircd accepts it (check the store grows), no 410 path touched.

## Deliberately out of scope (phase 2+, tracked in `notifications.md`)

- The service-worker `push` handler + worker-built-from-TS webpack entry,
  grouping/badging/actions; payload tier (`draft/webpush/payload` account
  metadata via `draft/metadata-2`, which the branch also offers);
  server-side mute/snooze semantics; `pushgarden`-style relay for the
  Capacitor shells. _VAPID rotation UX (the server keeps one key per ircd;
  rotation invalidates every subscription) landed 2026-09-05 — see § VAPID
  rotation below._

## Open questions

- Multi-network endpoint sharing vs. per-network privacy: one endpoint
  registered with N networks means each server can push the same device.
  Fine for a single-network rebrand (this repo's goal); revisit if seance
  ever connects to third-party networks.
- Should the client set the account's `draft/webpush/payload` metadata
  (`METADATA SET`) from a Settings choice, or leave the server default
  (`route`)? Phase 2 decision.
- `FAIL WEBPUSH MAX_REGISTRATIONS` is currently unreachable server-side
  (no limit implemented); if a limit lands upstream, wire our handling to
  it and re-check.
- Upstream niceties worth a nefarious2 PR: the `>=` key-length quirk, the
  stale "from services" comment, and the silently-dropped pre-registration
  REGISTER (a `FAIL` would have saved a probe iteration).

## Endpoint hygiene without a device list (2026-09-05)

Push subscriptions are per account, and a device leaks an endpoint whenever
its browser subscription is recreated (a VAPID rotation, a re-subscribe), so
an account can accumulate stale endpoints — the cause of duplicate
notifications on a phone. A prior iteration added a non-draft `LIST`
subcommand and a Settings panel to view and clear every subscription on the
account, but that subcommand is not part of `draft/webpush`; a draft-only
server refuses it with a generic `FAIL WEBPUSH INVALID_PARAMS`, which the
client's generic failure path then read as the push subscription itself
being blocked — a false alarm every time the Notifications settings page
opened. That panel, its bus events, its reply parsing in
`handlers/webpush.ts`, and the client accessor methods behind it have all
been removed.

The client now relies only on the draft's `REGISTER`/`UNREGISTER <endpoint>`
for hygiene: it re-sends `REGISTER` on every connect (the draft's renewal
mechanism), it `UNREGISTER`s the endpoint its own browser replaced whenever
a subscription is recreated (`subscribe(uuid)` unregisters the endpoint it replaces, in
`webpush.ts`), and the server expires whatever a device stops renewing.
There is no client-side way to view or clear another device's registration.

## VAPID rotation: the renew prompt (2026-09-05)

A browser holds **one** push subscription per service-worker registration,
bound to the `applicationServerKey` it was created with. When the server
rotates its VAPID key, the stored subscription (`thelounge.push`, keyed by
VAPID key) matches nothing the server announces, and
`PushManager.subscribe()` with the new key is refused outright:

```
InvalidStateError: Registration failed - A subscription with a different
applicationServerKey (or gcm_sender_id) already exists; to change the
applicationServerKey, unsubscribe then resubscribe.
```

Before this change `autoRegister` tried to "silently mint a fresh one" on
that connect, hit exactly that error, logged `[webpush] renewal after VAPID rotation failed` to the console, and left the device without pushes while
Settings still said subscribed — a silent failure. Now:

- **`client/js/helpers/pushKeys.ts`** (Vue-free, `test/helpers/pushKeys.ts`):
  `decodeApplicationServerKey` (the base64url decoder that used to live in
  `webpush.ts`), `sameApplicationServerKey` (byte comparison against
  `PushSubscription.options.applicationServerKey`); the staleness decision
  is per network in `helpers/pushStore.ts` (`entryStale`/`anyStale`: an
  entry made against another key than the one its server announces; false
  while nothing is stored or nothing is announced yet) since subscriptions
  became per network (`push-per-network.md`).
- **The mechanical fix.** `pushSubscription()` looks at the browser's existing
  subscription first and unsubscribes it when its key differs, then
  subscribes — what the error message asks for. The caller
  (`subscribe(uuid)`) unregisters the endpoint that was replaced from that
  network, so the account does not keep pushing to a dead endpoint.
- **Never silently.** The rotation branch in `autoRegister` is gone;
  `autoRegister` only re-REGISTERs a stored subscription that matches the
  announced key. `maybePrompt` opens the connect-time prompt in its **`renew`
  variant** (`PushPrompt.vue`, `#push-prompt.renew`, "Renew push
  notifications?") when a subscription is stored but none was made against
  the key this network announces — regardless of the permission state,
  because a renewal changes which endpoint the server pushes to and is worth a
  "yes". _Yes_ runs `subscribe(vapid)` with the prompting network's key
  (old browser subscription dropped, old endpoint unregistered everywhere,
  new one registered, `thelounge.push` re-keyed). _No_ closes it; the next
  connect asks again. Both prompt variants **name the network that asked**
  (display name or ISUPPORT `NETWORK`, `host:port`, SASL account —
  `pushPrompt.network`): a deploy may span several networks, and the
  renewal concerns one server's key. _Never_ flips the **`pushKeyChange`
  setting** to `ignore` (below), so the choice is visible and reversible in
  Settings; it is separate from the subscribe prompt's
  `thelounge.push.neverAsk`, because declining to be asked about subscribing
  says nothing about a subscription the user later made on purpose, and the
  other way round. Nothing is unsubscribed on _Never_.
- **The `pushKeyChange` setting** (`client/js/settings.ts`, default `ask`;
  `keyChangePolicy` in `helpers/pushKeys.ts` normalises anything else to
  `ask`) — Settings → Notifications, "When a server's push identity (its key)
  changes": **Wary** (`ask`, the renew prompt), **Naive** (`trust`: renew
  on the spot when permission is granted, no question — the working version
  of what the old silent branch tried; falls back to the prompt when
  permission is not granted, since `requestPermission()` needs a gesture),
  **Suspicious** (`ignore`: leave it; push from that server stays off until
  renewed from the network's settings).
- **Visible in Settings, renewed per network.** `refreshState` reports
  **`stale`** (before the "stored means subscribed" rule) whenever any
  connected network's entry is stale; Settings → Notifications shows the explanation
  instead of the snooze row and points at the network's settings, so the
  problem stays visible after _Never_ and has a way out. The **Renew** button
  is in the Edit-network form (`#pushRenew` → `webpush.renew(uuid)` →
  `subscribe(<that network's key>)`), shown when `networkPushInfo(uuid).stale`
  — a subscription is stored but not for the key this network announces. Per
  network on purpose: with two networks announcing different keys, only that
  network's key is the right one to subscribe against. The sidebar bell was
  already honest (`networkPushInfo().subscribed` checks the announced key).
- **Scenario.** `tools/scenarios/push-renew.mjs` drives it in a real browser
  against the testnet ircd: headless Chromium has no push service, so an init
  script (`page.addInitScript`, new in `tools/browser-drive.mjs`) stands in
  for Chrome's Push API — one subscription per registration, `subscribe()`
  with a different key throws the `InvalidStateError` above until the old one
  is unsubscribed. It checks the silent subscribe with permission granted,
  the renew prompt after a simulated rotation (the stored map and the fake
  browser subscription re-keyed to a key the server never announced), _No_ →
  Settings stale → Renew in Edit network, _Never_ → setting `ignore`, no prompt on the next
  connect and the radio selected in Settings, _Yes_ (back on `ask`), the
  `UNREGISTER old` / `REGISTER new` pairs on the wire, that the connect after
  a renewal re-REGISTERs the new endpoint without asking again, and `trust`
  renewing a rotation on its own; it ends by turning
  push off for the network so the account keeps none of its fixed fake
  endpoints (`https://push.invalid/push-renew/e1..4`).

**Resolved the same day**: two enabled networks announcing **different**
keys used to share the one browser subscription and take it from each other
on every connect (confirmed in use on 2026-09-05: two connections, both
subscribed, the prompt swapping between them). Subscriptions are now per
network — one service-worker registration per network, each with its own
subscription and key — see `docs/projects/push-per-network.md`.
