# Settings that follow the account

An idea, 2026-11-15; nothing is built. Settings are kept per device
(localStorage, `settings`), and since #323 the copies of the app on one device
(two tabs, the installed app and a tab) keep them in step. The idea is the
same between devices: one network is the user's sync home, and Seance's
settings follow the account to every device that signs in there. The
obvious case is a branded build with one server (AfterNET's), where that
network is the home.

## Where it lives: private account metadata

`draft/metadata-2` keeps per-account keys on the server. Seance already
shares state between devices this way on nefarious2: `seance/presence` and
`seance/mode` (shared-presence-modes.md), `seance/closed`
(closed-queries.md) and `draft/webpush/mute` (do-not-disturb.md). Settings
would be more keys of the same kind, written with
`METADATA * SET <key> private :<value>`, subscribed with the others and
read in the same registration burst.

What the server allows:

- nefarious2 offers `max-keys=20,max-value-bytes=300` per account. Four
  keys are taken, so settings get about 16 keys of 300 bytes. A value also
  has to fit one line (`MAX_LINE_BYTES = 500`, tags included), so more keys
  is the lever, not longer values.
- nefarious2's limits are the features `METADATA_MAX_KEYS` and
  `METADATA_MAX_VALUE_BYTES`, but `m_cap.c` advertises the cap value as a
  fixed string. Raising the feature changes nothing a client is told; that
  needs an ircd change first.
- `private` hides a key from other users, not from IRC operators, who can
  read and set another user's metadata. Settings may live there;
  conversations may not.

## The merge: the newest choice for each setting

Settings have to share keys, and the server keeps each key's value whole:
the last `SET` wins. Two devices changing different settings in the same
key at once would undo each other, the same lost update #323 fixed between
tabs. So each setting carries the time it was chosen (`changedAt`, device
milliseconds, as `seance/presence` does), and a device that receives a
value merges it setting by setting:

- the newer `changedAt` wins;
- if the merged result differs from what the server holds, the device
  writes it back. Only a device holding something newer writes, so the
  devices agree after at most one extra write and never trade writes back
  and forth;
- a setting this build does not know is kept and written back as received,
  so an older build never deletes a newer build's settings;
- nothing dated more than a minute after this device's clock is taken (the
  rule the presence keys use).

That is a last-writer-wins map, one of the simplest CRDTs. It needs no
library; it is `helpers/settingsSync.ts` (#323) with a time per setting.

Writes are rare and nobody waits for them, so they go through
`IrcClient.background`, never the connect path.

## Open: which settings roam

This is the real design question. Each setting would be marked in
`client/js/settings.ts`, which still carries TheLounge's `sync` field
(nothing reads it today, since there is no server):

- `sync: "always"` there now: `highlights`, `highlightExceptions`,
  `awayMessage`. Likely roam. A long highlight list may need a key of its
  own, or several.
- `sync: "never"` there now: `notification`. Per device.
- Probably roam: `theme`, `locale`, message display choices.
- Probably per device: the UI scale and font size, `keepConnected`, motion,
  translation's device and model choices.

Also open: what happens when the user marks a second network as a home, or
signs in at a home with a different account.

## Considered and dropped

- **A CRDT library** (Yjs, Automerge, Loro): their strength, many people
  editing the same text, is unused here; documents in their binary format
  would replace readable values; and they bring no transport, so the server
  would still carry them.
- **Messages to oneself as a change log** (a `PRIVMSG` or `TAGMSG` to the
  user's own nick, replayed with `CHATHISTORY AFTER`): the server orders the
  changes, so device clocks would not matter. But history expires (nefarious2
  `CHATHISTORY_RETENTION`, 7 days by default), so devices would have to post
  full snapshots, which is the key-value state again; and every client on
  the account would show the lines and have to filter them.
- **A secret channel as the log**: someone else can take the name, it needs
  services to lock it, every device spends a JOIN on the connect path, and
  its members and the opers can read it.

## Not part of this

- Private conversations between devices are the server's private history
  (`draft/chathistory`). The query log (`irc/querylog.ts`) stays on the
  device.
- Between tabs on one device: localStorage (#323 for settings, BUG-120 in
  locke_bugs.md for the query log).
