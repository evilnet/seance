# Notifications: best possible, on every platform

_Noted 2026-08-27. Status: exploration → plan. Supersedes plan item D.11
(web push) in `initial_conversion.md`. Related: `docs/resources/pwa.md`,
`connecting-status-stuck.md`, the Capacitor/Electron READMEs in `shells/`._

## Goal

Figure out what "great notifications" can mean for a bouncer-less web IRC
client on desktop, Android and iOS — including push while the app is not
running — and do everything that is feasible: grouping of repeated messages,
snoozing / do-not-disturb, per-channel levels, badges, sane click-through,
cross-device dismissal.

## Where we are

- **Per network, default on.** `client/js/socket-events/msg.ts`
  `notifyMessage()` fires on highlights (or every message with
  `notifyAllMessages`) when the tab is unfocused or another channel is
  active, skipping `channel.muted` (`client/js/mute.ts`) **and networks
  whose saved `notifyEnabled` flag is `false`** (the "Browser notifications
  for this network" checkbox in the network editor, default enabled —
  `notifyEnabledOf()`; the old global `desktopNotifications` checkbox was
  removed 2026-09-03 and a one-time migration stamps networks
  `notifyEnabled: false` when it was off). The gate sits before the
  delivery split, so both paths honour it. It plays `pop` and, with
  notification permission granted, posts
  `{type: "notification", chanId, title, body, timestamp}` to the service
  worker (`client/service-worker.js` `showNotification`) or falls back to
  `new Notification()`. Toggling the per-network checkbox on is the user
  gesture that asks for the permission (only while still "default").
- **Grouping today** = the notification `tag` is `chan-<id>`: a new
  notification for the same channel closes and replaces the previous one. No
  count, no "3 messages from alice", no batching window.
- **Click** → `notificationclick` focuses/opens the app and posts
  `{type: "open", channel: "chan-<id>"}` → `router.ts` switches channel. Ids
  come from `client/js/irc/ids.ts` and are **session-local**, so a
  notification that outlives the page (push, or a closed PWA window) cannot
  address a channel by id.
- **No push.** `client/js/webpush.ts` is a stub (`pushNotificationState: "unsupported"`); the worker has no `push` handler. The old TheLounge relay
  (`attic/server/plugins/webpush.ts`) is gone with the server.
- **Settings** (`client/components/Settings/Notifications.vue`,
  `client/js/settings.ts`): `notification` (sound), `notifyAllMessages`,
  `highlightMessages` (the visual highlight bar on messages that mention
  you, default on), `highlights`, `highlightExceptions`, plus per-channel
  mute in the context menu. Browser-notification enrollment is per network
  (the editor checkbox); the panel keeps the browser-level diagnostics
  (blocked / no-HTTPS / unsupported) and a pointer to the network settings.
  No badge, no schedule, no levels.
- **Read markers exist** (`draft/read-marker`, `handlers/markread.ts`, plan
  D.7 done 2026-08-25): the cross-device "already read" signal we need for
  dismissing notifications is available.

## The three delivery layers

1. **Live connection (app open or backgrounded but alive).** Desktop
   browsers, the PWA window, Electron: the WebSocket stays up, the page
   decides what to notify. Everything here is client-side work.
2. **Web Push (app closed, or mobile OS killed the socket).** The push
   service (FCM / Apple / Mozilla) wakes the service worker with an encrypted
   payload. Needs a sender: with no bouncer, that must be **the ircd**.
3. **Native push in the shells.** Capacitor iOS/Android WebViews have no
   Push API; they need APNs/FCM via a native plugin and something that
   translates Web Push (RFC 8030) into APNs/FCM — see "Shells" below.

## Server side: IRCv3 `draft/webpush` and nefarious2

Spec: [ircv3-specifications#471](https://github.com/ircv3/ircv3-specifications/pull/471)
(`extensions/webpush.md` on the `webpush` branch). Capability `draft/webpush`.

- `WEBPUSH REGISTER <endpoint> <keys>` (keys = `p256dh` + `auth` from
  `PushSubscription.toJSON()`), `WEBPUSH UNREGISTER <endpoint>`; success is
  echoed back. Re-registering the same endpoint replaces the subscription.
- VAPID public key advertised in ISUPPORT (spec: `VAPIDPUBKEY`; nefarious2's
  doc/code uses `VAPID=<key>` — **verify which name the branch emits**,
  `s_user.c` / `m_webpush.c:631`). The key is stable for the life of a TCP
  connection.
- Each push carries **one raw IRC line** (no CRLF, tags may be dropped to fit
  4 KB, first line of multiline only), encrypted per RFC 8291 `aes128gcm`.
  The server chooses which messages to push ("server-defined subset").
- `FAIL WEBPUSH INVALID_ENDPOINT | INVALID_KEYS | MAX_REGISTRATIONS | INTERNAL_ERROR`.
- Implementations: soju, Ergo, Igloo (servers); goguma (Android),
  gamja (web PoC); **pushgarden** (Web Push → FCM relay) for native apps.

nefarious2 `ircv3.2-upgrade` (`tmp/nefarious2/ircd/m_webpush.c`,
`webpush.c`, `webpush_store.c`; checkout at `21ec6d2`):

- Cap is **default off** (`FEAT_CAP_draft_webpush`); needs
  `FEAT_WEBPUSH_DB` (LMDB path) and a VAPID private key
  (`FEAT_WEBPUSH_VAPID_PRIVKEY`, or generated/shared via services). The
  dev conf in `tools/nefarious-dev/` sets none of this yet.
- `WEBPUSH REGISTER` **requires a logged-in account**
  (`FAIL WEBPUSH ACCOUNT_REQUIRED`, non-spec code; also `INVALID_PARAMS`).
  Subscriptions are stored per **account**, not per connection, and synced
  network-wide over P10 (`WP V/R/U/B`). So push needs services + SASL — fine
  for a network's own client, but the dev ircd has no services.

  > **Update 2026-08-28:** the missing trigger has landed upstream —
  > `webpush_notify_pm()` (`414b147`, v1) and `webpush_notify_channel()`
  > (`9fbcb3b`, v2, case-mapped word-boundary nick match with a per
  > account/channel cooldown), both called from `ircd/ircd_relay.c`, with the
  > payload tier taken from the account's `draft/webpush/payload` metadata
  > (`ping` / `route` (default) / `full`). Pushes actually flow now, so the
  > "no caller" blocker below is resolved and D.11 can start; the client work
  > (VAPID key handling, `WEBPUSH REGISTER`, service-worker `push` handler)
  > is unchanged.
  >
  > **Update 2026-09-01:** phase 1 (subscription via `draft/webpush`) is
  > researched and verified end-to-end against the testnet ircd — spec,
  > server inventory, wire transcript and the implementation plan live in
  > [`push-subscription.md`](push-subscription.md).

- Delivery exists (`webpush_notify_account()` iterates the account's
  subscriptions, prunes HTTP 410), **but nothing calls it**: as of this
  checkout there is no hook in PRIVMSG/NOTICE/INVITE delivery. Registration
  works, no push is ever sent. That trigger is the first piece of server work
  and a natural follow-up PR after #100 (WebSocket fixes). Proposed policy,
  to agree with MrLenin:
  - push on PMs, highlights (server-side mention = nick in text; the client's
    custom `highlights` list can't be known server-side unless sent — the
    `draft/metadata-2` cap on the branch could carry it) and INVITE;
  - only when the account has **no connected session**, or every session is
    away (`away-notify` semantics) — otherwise the live layer handles it;
  - honour a per-subscription or per-account mute list (channel + until) so
    that snooze/DND work while the app is closed (not in the spec; could
    ride on `METADATA` or a `WEBPUSH` extension);
  - rate limit per account/endpoint; include `msgid`/`time` tags in the
    pushed line so the worker can dedupe against chathistory on open.

## Platform matrix (what the browser lets us do)

| Capability                                     | Desktop Chrome/Edge (incl. PWA)        | Firefox desktop | Android Chrome (PWA)  | iOS/iPadOS home-screen web app                                                                           | Electron shell        | Capacitor shells                                                                               |
| ---------------------------------------------- | -------------------------------------- | --------------- | --------------------- | -------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Notification API while page alive              | yes                                    | yes             | yes                   | yes (installed only)                                                                                     | native via Electron   | iOS: `@capacitor/local-notifications`; Android: the shell's push service (`NativePush` `show`) |
| Web Push (`PushManager`)                       | yes                                    | yes             | yes                   | yes since 16.4, **only when installed to Home Screen**; permission must be requested from a user gesture | **no** push service   | no (need APNs/FCM)                                                                             |
| Notification `actions` (buttons, inline reply) | yes (`type: "text"` inline)            | no actions      | yes                   | **no**                                                                                                   | limited (macOS reply) | native                                                                                         |
| `tag` replace / `renotify` / `silent`          | yes                                    | tag yes         | yes                   | tag yes; `renotify`/`silent` unreliable                                                                  | n/a                   | native grouping/channels                                                                       |
| Badging API (`setAppBadge`)                    | yes (taskbar/dock)                     | no              | yes (launcher)        | yes since 16.4                                                                                           | `app.setBadgeCount`   | native                                                                                         |
| Scheduled/snoozed notifications                | **no** (Notification Triggers removed) | no              | no                    | no                                                                                                       | timers (app runs)     | native scheduling                                                                              |
| Must show a notification on every push         | yes (`userVisibleOnly`)                | yes             | yes                   | yes; repeated silent pushes revoke permission                                                            | n/a                   | n/a                                                                                            |
| Install prompt                                 | `beforeinstallprompt`                  | manual          | `beforeinstallprompt` | manual Share → Add to Home Screen only                                                                   | n/a                   | store                                                                                          |

Notes: iOS suspends the WebSocket seconds after backgrounding, so on iPhone
layer 2 is the _only_ way to be notified; Android is friendlier but Doze
still kills the socket. Apple announced then reversed removing Home Screen
web apps in the EU (iOS 17.4, 2024) — verify current behaviour per region
before promising iOS push to an EU network. Sources:
[MagicBell iOS PWA limits](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide),
[PWA push on iOS 2026](https://webscraft.org/blog/pwa-pushspovischennya-na-ios-u-2026-scho-realno-pratsyuye?lang=en),
[PWAs in 2026 iOS vs Android](https://blog.codercops.com/blog/progressive-web-apps-2026),
[MobiLoud iOS PWA guide](https://www.mobiloud.com/blog/progressive-web-apps-ios).

## Feature wishlist and feasibility

| Feature                                      | Live layer                                                                                                                                                                                   | Push layer                                                                                                                                                                             | Verdict                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Group repeated messages                      | Keep `tag` per target; in the worker read `getNotifications({tag})` and merge: "alice, bob in #chan (3 new)" with the last 2-3 lines as body; 1-2 s batching window before showing           | Same code path — the worker is the one place that renders both                                                                                                                         | do                                   |
| Per-sender grouping in PMs                   | tag `pm-<network>-<nick>`                                                                                                                                                                    | same                                                                                                                                                                                   | do                                   |
| Snooze / mute for N minutes / DND schedule   | State `{target?: string, until: number}` in IndexedDB (the worker cannot read localStorage) mirrored from settings; the page and the worker both consult it; timers in the page to expire it | The worker must still show _something_ on each push, so: while snoozed, `WEBPUSH UNREGISTER` (and re-register when it ends) or push a server-side mute — needs the server policy above | do (live); push needs server support |
| Per-channel levels (all / highlights / none) | extend `mute.ts` to a level enum; UI in the channel context menu and Settings                                                                                                                | needs to reach the server to matter while closed                                                                                                                                       | do                                   |
| App badge with unread highlight count        | `navigator.setAppBadge(n)` from `mentions.ts` / unread counters; clear on read                                                                                                               | worker increments/decrements the badge on push and on `notificationclose`                                                                                                              | do                                   |
| Actions: Mark read, Reply, Mute 1 h          | Buttons on Chrome/Android; "Reply" inline text → `input` when the page is alive, else open the app with the draft prefilled; "Mark read" sends `MARKREAD`                                    | Worker has no IRC socket: queue the action (IndexedDB) and let the page apply it on next open; iOS has no actions at all                                                               | do, degrade gracefully               |
| Cross-device dismissal                       | On `markread` for a target (another device read it), `getNotifications({tag})` → close                                                                                                       | Server pushes `MARKREAD` lines too (server-defined subset) so the worker can close notifications while the app is closed                                                               | do                                   |
| Click deep link that survives restart        | Route by **network uuid + target name**, not session id: add `#/net/<uuid>/<target>` (and keep `#/chan-<id>`); notification `data` carries `{network, target, msgid}`                        | required — ids don't exist yet when a push arrives                                                                                                                                     | do first                             |
| Custom sounds                                | page can play any audio; web notifications ignore `sound`                                                                                                                                    | no                                                                                                                                                                                     | page only                            |
| Vibration pattern                            | `vibrate` on Android                                                                                                                                                                         | same                                                                                                                                                                                   | trivial                              |
| Quiet when active elsewhere                  | already: unfocused/other channel only; add "another _device_ is active" using `away-notify` + our own MARKREAD echoes                                                                        | the server-side "no session or all away" rule                                                                                                                                          | do                                   |
| Presence/typing-aware suppression            | skip a notification if the user is typing in that channel                                                                                                                                    | n/a                                                                                                                                                                                    | nice                                 |

## Client-side push design (layer 2)

- **Subscribe** after SASL login succeeds and `draft/webpush` is negotiated:
  `registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: <VAPID from ISUPPORT>})`, then
  `WEBPUSH REGISTER <endpoint> p256dh=<...>,auth=<...>` (exact `<keys>`
  syntax per the spec text). Re-register on every connect (cheap, refreshes
  expiry), on `pushsubscriptionchange`, and when the VAPID key changes.
  `WEBPUSH UNREGISTER` on explicit logout / disabling push / removing the
  network. Persist `{endpoint, network uuid}` in `thelounge.push`.
- **Worker `push` handler**: decrypting is done by the browser; the event
  data is the IRC line. Parse it with `client/js/irc/message.ts` — the
  parser has no DOM/store deps, so give the worker its own webpack entry
  (`client/service-worker.ts`, sharing `message.ts` + a tiny render module)
  instead of the hand-copied JS it is today. Map `PRIVMSG`/`NOTICE`/`INVITE`/
  `MARKREAD` to show/close notifications; anything else → ignore (still
  must show something? no — Chrome only requires a notification when the
  push _should_ be user-visible; log and skip is tolerated occasionally, but
  don't make the server push things the worker will drop).
- **Dedup on open**: the page replays chathistory on connect; notifications
  for msgids already marked read (`MARKREAD` timestamp) are closed on boot.
- **Permission UX**: ask only from a user gesture on a "Enable notifications
  on this device" button (iOS is strict); explain the Home-Screen requirement
  on iOS; show `pushNotificationState` (`unsupported` / `not-installed` /
  `denied` / `subscribed`) in Settings → Notifications.
- **Multi-network**: one push subscription per browser profile (the endpoint
  is per SW registration), registered with each network the user logs in to;
  the pushed IRC line has no network marker — include the network in the
  `WEBPUSH` registration or tag the notification by the server-name in the
  line's prefix. Open question for the spec.

## Shells

- **Electron**: no push service, but the app process keeps the socket open;
  layer 1 is enough. Use `Notification` + `app.setBadgeCount`, and macOS
  reply actions via the shell's `main.js`.
- **Capacitor**: `@capacitor/push-notifications` gives an FCM/APNs token, but
  the ircd speaks Web Push. Options: (a) run **pushgarden**-style relay
  (Web Push endpoint that forwards to FCM/APNs) — a small piece of network
  infrastructure, contrary to the bouncer-less goal but tiny and stateless;
  (b) extend nefarious2 to talk FCM/APNs directly (bigger, vendor-specific);
  (c) accept "installed PWA" as the mobile story and keep Capacitor for
  stores only. Leaning (c) + (a) if a network wants store apps with push.

## Plan

1. **Live-layer polish** (no server dependency): stable deep links by
   network/target, grouping + batching in the worker, badge, per-channel
   levels, snooze/DND in IndexedDB, actions on Chrome/Android, cross-device
   close on `markread`, worker built from TypeScript with the shared parser.
2. **Web push**: agree the server trigger policy with MrLenin and land it in
   nefarious2 (`webpush_notify_account` callers + away/no-session rule +
   mute list); add VAPID + LMDB to the dev ircd (`tools/nefarious-dev/`) —
   needs services for accounts, so either bring up X3 in the dev compose or
   patch a dev-only "no account required" feature flag; client subscribe /
   register lifecycle; worker `push` handler; Settings UX; iOS install hint.
   Live test in `test/irc/webpush.live.ts` against the dev ircd (registration
   round-trip; actual delivery needs a real push service, so a manual check
   on a real phone).
3. **Shells**: decide (a)/(c) above once the PWA path works on a real Android
   and iPhone.

## Open questions

- Exact `WEBPUSH REGISTER <keys>` encoding and the ISUPPORT token name in the
  spec vs nefarious2 (`VAPIDPUBKEY` vs `VAPID`).
- Should the server push to accounts with a _connected but away_ session, or
  only with no session? (Desktop left on at home vs phone in pocket.)
- Where do highlight words live for server-side matching — `METADATA`?
- How much of the message body to put in a notification on a locked phone
  (privacy setting: "show sender only").
- EU iOS behaviour at the time we ship.
