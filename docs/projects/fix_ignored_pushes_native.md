# Android push ignores the ignore list and mutes

_Noted 2026-11-15 (Locke bug sweep, BUG-127). Status: proposed fix, waiting
for someone who works on the native shells to evaluate it. No code changed._

## Symptom

On the Android app (the Tauri shell), the user `/ignore`s a troll and mutes
`#busy`, then swipes the app away. The troll PMs them and someone highlights
them in `#busy`: the phone buzzes twice, with a full notification (text and
all) for each.

With the app open, neither would alert. The page drops ignored senders, and
a muted channel alerts nothing, highlights included
(`client/js/socket-events/msg.ts:194`, `notifyMessage`: `if (channel.muted)
return false`). In a browser or PWA the same two pushes show nothing new for
the troll and a quiet, textless card for `#busy`.

Only pushes that arrive while the page is not running (or that the page did
not take) are affected. A message the page takes live and hands to
`NativePush.show` is already filtered: the page never hands over a muted or
ignored message. `NativePush.seen` already drops the push for a message the
page showed.

## Why: two push paths, and only one reads the prefs

```
                        ircd push (an IRC line)
                 ┌──────────────┴───────────────┐
        Browser / PWA                      Android shell
                 │                               │
       service worker                   PushService.java (UnifiedPush)
       (no localStorage)                 runs with no page at all
                 │                               │
   reads IndexedDB "prefs"  ◄── page mirrors     │   ✗ nothing to read
   ├ ignored sender → nothing new   mute+ignore  │
   ├ muted  → quiet, textless card               │
   └ else   → notification               show() → full notification, always
                                                 ▲
                         page also writes IndexedDB in the shell,
                         but Java can't read the WebView's IndexedDB
```

- **Browser / PWA.** The ircd's push lands in the service worker. The worker
  cannot read `localStorage`, where the ignore list (`client/js/ignore.ts`)
  and the mutes (`client/js/mute.ts`) live. So the page mirrors them into
  IndexedDB (`client/js/push-prefs.ts`, key `prefs`: `muted`, and `ignored`
  by network uuid; commit eab4a2237), and the worker checks them before it
  shows anything (`client/service-worker.js` `showMessage`, ~L2221-2291).
- **Android shell.** No service worker runs there (`client/js/pwa.ts`
  `serviceWorkerCanServe` is false in a shell). Pushes arrive through
  UnifiedPush in the native `PushService`, which runs with no page at all:
  the app may have been swiped away. It shows every PRIVMSG/NOTICE. The page
  still writes the IndexedDB mirror in the shell, but nothing reads it, and
  the native side cannot read the WebView's IndexedDB.

## Where in the code

Native (`shells/tauri/src-tauri/gen/android/app/src/main/java/chat/seance/app/`):

- `PushService.java:107-123`, `onMessage`: a PRIVMSG/NOTICE goes straight to
  `show(this, network, null, line, false)`.
- `PushService.java:156-175`, `show`: checks only `PushSeen.covers(line)`
  (this device already showed it), then merges and posts.
- `PushLine.java:78-80`: the parser keeps only the prefix's nick and drops
  `user@host`, so even the inputs an ignore mask needs are missing.
- `PushLine.java:310`, `foldName`: rfc1459 folding, already there (the
  service worker's `foldName`).
- `NativePush.kt:50-98`: the plugin's commands (`status`, `subscribe`,
  `seen`, `show`, `clear`, …). None of them takes preferences.

Page:

- `client/js/push-prefs.ts:36-65`: `mirrorPushPrefs` / `mirrorIgnoreList`,
  the one place every pref goes through. Called from `mute.ts` (`writeMuted`
  and at load), `ignore.ts` (`mirror`), `settings.ts` (markdown) and
  `i18n/index.ts` (locale).
- The bridge: `client/js/helpers/shell.ts` (`nativeCall`, `isAndroidShell`),
  wrapped for push in `client/js/helpers/nativePush.ts`.

The rules to reproduce natively:

- **Ignore:** `client/js/push/ignore.ts` `ignoredSender`, which runs
  `compareHostmask` (`client/js/irc/hostmask.ts:48-73`) over each mask.
  `*` matches any run of characters and `?` exactly one, case-insensitive,
  with no escaping. A JSON-tier push carries the nick alone (user and host
  are `""`), so there only a mask that is `*` in ident and host matches.
- **Mute:** a key `<network uuid>/<name lowercased>` (`mute.ts` `mutedKey`),
  compared to `<network>/<replyTo>` under rfc1459 folding; `replyTo` is the
  channel, or the sender for a PM. Muting a lobby stores a key per channel
  (there is no network-wide key).

## Proposed fix

Mirror to native the same `PushPrefs` object the worker already gets.

1. **Page** (`client/js/push-prefs.ts`): inside the existing queue, once
   the merged object is computed, and only when `isAndroidShell()`, also call
   `nativeCall("NativePush", "prefs", merged)`. Because it sits in that one
   place, mute, ignore and any future field reach native without further
   changes. It should not depend on the IndexedDB write succeeding.
2. **Kotlin** (`NativePush.kt`): a `"prefs"` command that stores the JSON in
   SharedPreferences (`seance.push.prefs`) and resolves.
3. **Java:**
   - `PushLine` keeps `user` and `host` from the prefix, as
     `client/js/push/line.ts` already does.
   - A small pure class `PushPrefs` reads the stored JSON and answers
     `muted(network, target)` (rfc1459 fold via `PushLine.foldName`) and
     `ignored(network, nick, user, host)` (the wildcard match above). If
     the JSON is missing or broken, nothing is muted and nobody is ignored.
   - In `PushService.onMessage`, before `show`: an ignored sender or a muted
     conversation returns without posting anything.
4. **Tests:** `PushPrefsTest.java` beside `PushLineTest` and the others
   (`app/src/test/java/chat/seance/app/`; `make android-test`), plus a
   `PushLineTest` case for `user`/`host`; a mocha test that `mirrorPushPrefs`
   calls the native command in the Android shell and not elsewhere.

Cost: one more bridge command and one small SharedPreferences entry (a list
of masks per network and a list of muted names).

## Open questions for review

- **What a muted conversation shows natively.** Proposed: nothing at all.
  The service worker shows a quiet, textless card only because WebKit
  revokes a subscription that receives pushes without a visible
  notification. UnifiedPush has no such rule, and nothing matches the page
  (a muted channel alerts nothing there). An alternative is a silent
  notification (`setSilent`) to keep the service worker's look.
- **Markdown and locale.** The same pipe would carry `markdown` and `locale`
  for free, but the native notification uses neither today. Out of scope
  here.
- **First launch.** Until the page has run once after install and mirrored,
  native has no prefs and filters nothing. The service worker has the same
  gap.
- **Verification.** CI's Android job only builds the APK (`make
android-build`) and does not run `make android-test`. The pure parts can be
  unit-tested on the JVM; the end-to-end path (app swiped away, push from an
  ignored nick and into a muted channel) needs a device.
