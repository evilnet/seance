# Settings that follow the account

Design chosen 2026-11-24, built 2026-11-25 in `client/js/sync/` (§ The
code). Settings and the user's lists
are kept per device (localStorage), and since #323 the copies of the app on
one device (two tabs, the installed app and a tab) keep `settings` in step.
This carries them between devices: one network is the user's sync home, and
what the user chose follows the account to every device that signs in
there. The obvious case is a branded build with one server (AfterNET's),
where that network is the home.

## The shape: an encrypted file on the upload host, a pointer in metadata

- **The file**: everything that roams, as one gzipped JSON document (close to
  the backup envelope, `helpers/settingsBackup.ts`, which already gzips with
  `CompressionStream`), encrypted with AES-GCM (WebCrypto, no dependency) and
  uploaded to the home network's `draft/FILEHOST` the way an avatar is
  (`upload.ts` `uploadFilehost`: `TOKEN GENERATE FILEHOST` with no channel, a
  raw POST, `201` and `Location`). A network without a `draft/FILEHOST`
  cannot be a home. A typical account's document is a few thousand bytes.
- **The pointer**: one private metadata key, `seance/sync`, holding
  `<version> <url> <key> <changedAt>`: the format's version (`1`), the file's
  URL, the key it was encrypted with (32 random bytes, base64url, fresh for
  every upload) and when it was written.
  The URL may take what the 300-byte value leaves (about 240 bytes). Written
  with `IrcClient.metadataSetLine`, so a server whose profile cannot keep a
  key private (`privateMetadata`) gets no sync at all.
- **Who can read it**: the account, through its private metadata, and IRC
  operators, who can read another user's metadata. Not the upload host, and
  not anyone who comes across the URL. That is the exposure `seance/presence`,
  `seance/mode` and `seance/closed` already have.

A fresh key per upload makes a pointer enough to read that one version and
nothing more: there is no key to keep, rotate or lose.

The server side is one key per account, inside nefarious2's
`max-keys=20,max-value-bytes=300` (five are used: `draft/webpush/mute`,
`seance/presence`, `seance/mode`, `seance/closed`, `avatar`). No ircd
change is needed.

### Reading

The pointer is subscribed with the other shared keys and comes back in the
burst of the account's own keys that nefarious2 sends after registration,
so a connect costs no extra line. A device keeps the last pointer it
applied and fetches only a different one (`fetch()` the URL, decrypt,
gunzip, merge).

Live changes come as the key's notification, the path `seance/presence`
already takes between two devices (browser check
`tools/scenarios/presence-shared.mjs`). nefarious2 sends a private key's
notification with the visibility `private`, and only to the account's own
sessions, under the nick of the session that set it (`m_metadata.c`,
`metadata_notify_subscribers`). So a notification is ours when it says
`private` or names our own nick (`handlers/metadata.ts` `ours`): another
device logged in under another nick, not sharing a bouncer session, is
heard too. Someone else's public key of the same name names their nick and
is ignored. A connection that logs in or out after registration (a 900
or 901 from a SASL exchange after 001; nefarious2 sends neither for a
login through services) forgets the pointer it read, and a login
subscribes and reads the account's keys as registration does
(`IrcClient.onAccountChanged`). A write the server refuses
(`FAIL METADATA … seance/sync` while our SET is out: a full key list; or
nefarious2's `RATE_LIMITED`, `VALUE_INVALID` and `INTERNAL_ERROR`, which
name no key) is read again, and a refused read is asked again 30 s later; when the old value comes back the tab
that wrote waits longer before it uploads again, doubling from a minute up
to an hour, so a server that refuses every write is not sent a file every
five minutes.

### What a device accepts

Whoever can write the account's keys can aim the pointer anywhere: the
account, and IRC operators. Decided 2026-11-25:

- **Size.** A device stops downloading past 1 MB and stops unpacking past
  4 MB (200 aliases at their longest are about 400 KB unpacked; the host
  takes 25 MiB). A file over either is ignored, the device keeps what it
  has and says so once in the home network's window. A device does not
  upload a file over the limit either, and says the same.
- **Where from.** Only an `https` URL on the home network's own file host
  (`draft/FILEHOST`, the host avatars already load from unasked,
  `avatars/policy.ts` `filehostHost`). A pointer to anywhere else is
  ignored with the same notice, so nobody can send the account's devices
  to a site of their choosing. Plain `http` passes only where the file
  host itself is plain `http`, which a client takes on an unencrypted
  connection alone (a development server). If the network moves its file host, old
  pointers stop passing; every device still holds its entries, and the
  next change uploads to the new host.
- **Which version.** The pointer's first word, and a field of the
  document, name the format's version. A device that meets a newer one
  than it knows does not read the file and does not upload: it keeps what
  it has and says once that sync waits on this device for an update of
  the app, so an old build never writes back a file it misread. A new
  entry is not a new version (an unknown entry is kept as received, § The
  merge); only a change to the document's shape is.

### Writing

A change waits until changes stop for a few seconds (one edit session, one
file). The device then merges with the file the pointer names if it has not
applied it yet, uploads the result and sets the pointer. The `TOKEN` and
`SET` lines go through `IrcClient.background`, never the connect path.

Uploads are spaced for the whole account (decided 2026-11-25). A change
after a quiet spell goes out about ten seconds after the last one. After
any upload, this device's or another's (each sees the pointer change), the
next waits until 5 minutes have passed, and what changed meanwhile goes
together. That is at most 12 of the account's 30 uploads an hour (§ The
upload host), the rest left for pictures and avatars; a 429 is waited out
for the time it names. A change waiting its turn is in the device's storage
with its time already, so it goes out later, after a restart too.

**Sync now** (added 2026-11-26), a button under the switch while the home
is connected, is the user's way past that pacing: someone who turned sync
on and then favorited three channels waited the five minutes, and a second
device joining meanwhile saw none of them. It reads the pointer again
(`METADATA * GET seance/sync`, sent at once: the user is waiting), takes
what another device sent, and uploads what this device holds without the
quiet spell, the spacing or a wait an earlier refusal set, from whichever
tab it was pressed in. One upload for one press; a refusal (a 429 too) is
said next to the button and the retry is left to the timer
(`SyncEngine.syncNow`).

One upload at a time for a device. Two tabs, or the installed app and a
tab, share the device's storage, so each sees the other's change and each
would upload it. A tab whose home is connected uploads while it holds a Web
Lock (`navigator.locks`, `ifAvailable`), taken for the upload alone and
checked again once held: a tab finding it taken looks again a little
later, by which time the shared state says the change went; Sync now
waits for the lock instead. (The first
version held the lock for a tab's whole life, so a tab whose home was
offline, or that the browser had suspended, kept every other tab from
uploading.) A browser without it lets every tab upload: the files are the
same, and the cost is an upload each.

Each tab reads the pointer on its own connection while sharing the stored
state. A value its connection still says after another tab took a newer one
is not news: a tab acts on a pointer only when its own connection's value
changed since it last acted (`SyncEngine` `handled`), so two tabs whose
connections disagree for a moment do not trade the stored pointer, with a
download each time, until both have heard.

### Retention

PASTE's `filehost.php` deletes a file after 30 days. Whichever device is
connected uploads the document again a week before (half the keep, if
shorter; never with `retentionDays` 0), the rule avatars follow
(`avatars/own.ts` `refreshDue`, `avatars.retentionDays`), and sets its wake
for that time. Every device keeps
everything it has, so a file that expired while no device connected is
uploaded again by the next one that does; only a device signing in for the
first time in that gap starts empty, and the settings backup file restores
it. Old versions are left to expire.

## The home: one per device

Decided 2026-11-25. A device has at most one sync home. Which network it is
is kept on the device and never roams.

- The first device: Settings has a switch on the network, "Sync settings
  with this account". Switching it on makes that network the home and
  uploads what the device holds.
- Every other device learns by itself. nefarious2 sends an account all of
  its own keys after registration, subscribed or not, so a device with no
  home that sees a `seance/sync` pointer asks once: use the account's
  settings here, not now, or never on this device. A yes makes that network
  the home and the device joins (§ A device joining). "Not now" lasts until
  the app is started again; "never" is kept on the device, and the switch
  still turns sync on.
- Switching it off stops sync on that device (and the offer is not made
  again on that page) and deletes its copy of the
  entries' times. The account's file and pointer stay for its other
  devices. Removing the home network from a device (signing out of a
  branded build) switches it off first, so the lists that go with the
  network are not uploaded as removals.
- Switching it on for another network while a home is set asks whether to
  move the home there; there are never two.
- The device remembers the account it syncs with. Signed in at the home as
  another account, it stops syncing and asks whether to sync with that one
  instead: a no leaves sync paused until the first account is back, a yes
  joins the other account's file. Otherwise one account's aliases, ignore
  list and oper notes would be uploaded into another's.

## The merge: the newest choice for each entry

Two devices that save at once each upload a file, and the pointer written
last wins. So every entry (a setting, an alias, a mute, a favorite, …)
carries the time it was chosen (`changedAt`, device milliseconds, as
`seance/presence` does), and a device that reads a file merges it entry by
entry:

- the newer `changedAt` wins;
- a device dates a change with its clock, or one millisecond past the
  newest `changedAt` it holds if that is later (decided 2026-11-25): a
  change made after seeing a value beats it, however slow the device's
  clock;
- a removed entry stays as a removal marker with its time, so a device that
  has not heard of the removal does not bring the entry back. A marker is
  kept 90 days (decided 2026-11-25);
- if the merged result differs from the file, the device uploads it and sets
  the pointer. Only a device holding something newer writes, so the devices
  agree after at most one extra round and never trade writes back and forth;
- an entry this build does not know is kept and written back as received, so
  an older build never deletes a newer build's settings. The device's copy
  marks it as never taken (`u`); once an update of the app knows it, the
  device takes it, rather than reading its own default as a choice made
  then;
- nothing dated more than a minute after this device's clock is taken (the
  rule the presence keys use). The rest of the file is taken; such an
  entry, if it is newer than the device's, is kept in the device's copy as
  received (`d`), passed on in its uploads, and taken once its time is
  within the minute (the engine wakes for it), so it is neither lost nor
  left out of the next file. An entry dated more than a day ahead is not
  taken at all.

That is a last-writer-wins map, one of the simplest CRDTs. It needs no
library; it is `helpers/settingsSync.ts` (#323) with a time per entry and the
lists added.

The order of a list (the favorites, the networks, each network's channels)
is one entry: the names in sequence, with one time (decided 2026-11-25).
What is in a list still merges entry by entry; of two reorders made at
once, the later one wins whole. A name the order does not hold sorts after
those it does.

### A device joining

Decided 2026-11-25. Until a device syncs, nothing on it records when a
choice was made, so its entries have no time to compare. When it joins an
account that already has a file, the account wins:

- where both hold an entry, the device takes the account's;
- an entry only the device holds (an alias, a mute, a favorite) is added,
  dated at the join, and reaches the other devices;
- an entry the account removed stays removed, though the device still
  holds it.

The first device of an account has no file to compare with: everything it
holds that is not a default goes up, dated at the join. The switch reads
the pointer again before it decides which (`sync/index.ts` `turnOn`): the
pointer read at connect may be older than another device switching sync
on, and a device taking itself for the first would date everything it holds
at now and win over the account. A device that has not joined and finds a
pointer it will not read (damaged, too large, on another host) says so and
joins as if the account's file were gone, so the switch does not stay on
doing nothing; but what it holds goes up dated as the oldest of choices
(time 1), so a device that can read the account's own file keeps its side
and its next upload puts it back.

A device that last synced more than 90 days ago joins again by the same
rule: the markers for what was removed meanwhile may be gone, and by its
own dates it would bring those entries back.

## What roams

Decided 2026-11-24:

- **Roams**: the settings (`client/js/settings.ts`, § The settings below
  says which), command aliases (`thelounge.aliases`), mutes (`thelounge.muted`),
  favorites (`thelounge.favorites`), ignore lists (`thelounge.ignore.*`), the
  network and channel order (`thelounge.sort.networks`, the saved networks'
  `channelOrder`), trusted media hosts, channels and accounts
  (`thelounge.media.trusted`) and trusted avatar people (`thelounge.avatars`).
- **Per-channel translation** (`thelounge.translate`, decided 2026-11-25):
  the choices roam (`exclude`, `write`, `writeFrom`, `formality`,
  `noSuggest`); the learnt `terms`, which hold short lines sent in private,
  and `once`, the translate button's last language, stay on the device.
  The switch itself (`translationEnabled`) is each device's own, so the
  choices that arrive wait there until that device has it on.
- **The do-not-disturb schedule** (`thelounge.dnd`'s daily window, decided
  2026-11-25) roams. Its manual switch and the global mode are shared
  already, through `draft/webpush/mute` and `seance/mode`, and stay there.
- **Oper preferences** (`thelounge.oper`, decided 2026-11-25) roam whole:
  the notice routes, the temporary ones, the snomask and the investigation
  notes. The notes are the oper's remarks about channels, IP addresses and
  accounts, and the network's other operators can read the file's key.
- **The home's saved network, but how to reach it** (added 2026-11-27):
  its display name, nick, autojoin channels, commands on connect and
  services support (the network form's package, bots and report and snoop
  channels) roam, so an oper who set services support on one device no
  longer finds it unset on the others. What stays on the device: the
  server, port, TLS and transport (the home's connection is how a device
  reads the file at all), the SASL mechanism, account and password, the
  server password and whether passwords are kept (the file's key is in a
  metadata key the network's operators can read), trusted certificates,
  autoconnect, the push and notification switches (each device's own
  subscription and permission), and the bookkeeping (history cursor, last
  use, the bouncer fields). A device that has not saved the home has
  nowhere to keep them. The connection takes the services support and the
  name at once and the channels at its next registration
  (`manager.reloadSavedNetworks`); a nick that arrives is used from the
  next launch, since sending `NICK` for a choice made elsewhere is not the
  device's to do. A change is heard through `onSavedNetworksChange`, not as
  a write to the key, which the history cursor rewrites with every message.
  Another network's saved entry waits for the network-name mapping (§ Open).
- **Stays on the device**: the rest of the saved network list
  (`thelounge.networks`, which holds passwords), Lua scripts and their data (`thelounge.scripts`,
  `thelounge.script_storage.*`), and the recently used reactions
  (`thelounge.reactions.recent`, decided 2026-11-25: they change with every
  reaction, and each change would be an upload), and what is folded shut in
  the sidebar (`thelounge.favorites.collapsed`,
  `thelounge.networks.collapsed`, decided 2026-11-25: screen layout).
- `userStyles` is not needed; size is no longer a reason to leave it out.
- **The first version carries the home network's entries** (§ Open): its
  mutes, favorites and their order, ignore list, channel order, trusted
  media channels and accounts, trusted avatar people, oper preferences,
  the saved network's name, nick, channels, commands and services support,
  and per-channel translation choices. Trusted media hosts belong to no network
  and roam whole. The order of the networks is a list of each device's own
  uuids and does not roam yet. The entry ids and their values are the table
  at the top of `sync/entries.ts`.

An alias is a command, and may stand in for a built-in one (`msg`). A synced
alias comes from whoever can write the account's `seance/sync` key: the
account, and IRC operators, who can set another user's metadata. So every
alias that sync adds, changes or removes is said in the home network's
window (decided 2026-11-25), a line with nothing to answer, so that one the
user did not make is seen.
The home's commands on connect and its autojoin channels run or join at
every registration and come from the same writers, so a change to either is
said the same way, with the new list (added 2026-11-27).

### The settings

Decided 2026-11-25, the debatable ones one by one. Each setting would be
marked in `client/js/settings.ts`, which still carries TheLounge's `sync`
field (nothing reads it today). Only a setting the user has chosen roams;
one still at its default stays out of the file, so every device keeps its
own platform's default (as the backup restore does,
`helpers/platformDefaults.ts`): a clock nobody set stays 12-hour on one
device and 24-hour on another. Once chosen, a setting stays in the file:
choosing the default again is a choice, and roams as that value. The same
holds for the do-not-disturb schedule and a channel's translation choices.

A value a device cannot hold (a theme its build does not ship, an alias it
finds invalid) is skipped there and kept in the file as received: the
device notes what it holds instead (`l` on the entry in its own copy,
`sync/document.ts` `reconcile`), so the difference is not read as a change
made on that device and uploaded over the other devices' value.

- **Roams (29)**: `autocomplete`, `nickPostfix`, `coloredNicks`,
  `highlightMessages`, `highlights`, `highlightExceptions`, `awayMessage`,
  `locale`, `markdown`, `motd`, `showSeconds`, `use12hClock`,
  `statusMessages`, `translateInto`, `translateAlsoRead`,
  `translateFormality`, `ownMessages`, `theme`, `messageLayout`,
  `psGroupMessages`, `psWords`, `media`, `mediaReveal`, `avatarLoad`,
  `uploadCanvas`, `sendTypingNotifications`, `searchEnabled`,
  `notifyAllMessages`, `pushKeyChange`.
- **Stays on the device (20)**: the UI scale and text (`fontSize`,
  `matchSystemTextSize`, `matchSystemAppearance`), the notification sound
  (`notification`: whether a device may make noise depends on where it
  is), what the device keeps (`keepConnected`, `keepPrivateConversations`:
  switching the second off deletes the stored conversations), what its
  hardware runs (`translationEnabled`, `translateLlm`, `translateCpu`,
  `translateNllb`, `translateSystem`, `translatePrefer`,
  `translateLlmDevice`, `translateOpusDevice`, `translateNllbDevice`,
  `translateLlmModel`, `psAnimation`, `psPauseWhenAway`), and what does not
  roam anyway (`userStyles`, `enableScripting`).
- **Neither (2)**: `links` and `advanced`, which nothing reads any more.

## Applying what arrives

A change from another device is written to this device's localStorage, and
the running app takes it from there (`sync/reload.ts` `reloadStored`, called
with the keys an apply wrote). Settings are written through the settings
store (`settings/update`), which applies each one. The stores read their
key again:

| Store                                                 | Reload                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| mutes (`mute.ts`)                                     | `reloadMutes`: every conversation shown takes its stored flag, and the push worker its copy                                     |
| ignore lists (`ignore.ts`)                            | `reloadIgnoreLists`: each cached `IgnoreList` reloads and mirrors to the push worker                                            |
| trusted media (`helpers/mediaTrust.ts`)               | `reloadTrustedMedia`                                                                                                            |
| avatar choices (`avatars/prefs.ts`)                   | `reloadAvatarPrefs`                                                                                                             |
| channel order (`sort.ts`)                             | `applyStoredChannelOrder` on every network                                                                                      |
| per-channel translation (`translate/channelStore.ts`) | the store's `translateChannelsLoaded`                                                                                           |
| aliases (`helpers/aliases.ts`)                        | read from storage where they are used; Settings → Aliases follows through `onAliasesReloaded` and keeps a row still being typed |
| favorites (`favorites.ts`)                            | `reloadFavorites`                                                                                                               |
| do not disturb (`dnd.ts`)                             | `reloadDnd`                                                                                                                     |
| oper preferences (`irc/operprefs.ts`)                 | none: read from storage where they are used                                                                                     |

The same reloads run on the `storage` event (`followOtherTabs`), so two tabs
stay in step for these stores too; favorites and do not disturb already
listened for it themselves.

## Open

- **A network that is the same on every device.** Mutes, favorites, ignore
  lists, the trust lists and the orders are keyed by the saved network's
  uuid, which each device makes for itself, and the network list does not
  roam. The first version carries the home network's entries only (decided
  2026-11-25): "the home" is the same network on every device, so they need
  no name, and what belongs to another network stays on the device. For the
  others, later, proposed: keep the uuid on the device (it keys the
  conversation store, the ignore lists, the push mirrors and more, so
  changing it is a migration across all of them) and translate at the
  file's edge. Writing,
  each entry's uuid becomes the network's ISUPPORT `NETWORK=` name, which
  each saved network would remember once it has connected (it is read live
  today, `isupport.ts`, never kept); reading, the name becomes this device's
  uuid for it. An entry for a network this device does not have is kept as
  received and applies once a network of that name connects. The home's own
  entries need no name at all.

## The upload host

PASTE's `filehost.php`, read in its source and asked at
`paste.boxlabs.uk/filehost` on 2026-11-24:

- **It lists the upload's type.** The encrypted document is
  `application/octet-stream`, which `Accept-Post` (`FILEHOST_ACCEPT`) has
  listed since 2026-11-26, after `image/*`, `video/*`, `text/*` and
  `audio/*` (read with `OPTIONS /filehost` at 18:25 GMT); before that it
  listed the first three only and the upload was a 415.
  No upload of a settings file has been made there yet. A type outside
  image, video and audio must match what the content sniffs as, which
  encrypted bytes do.
  Base64 as `text/plain` is no
  way round: the host takes it, but as a paste on the site, whose raw URL
  (`/raw/<id>`, `paste.php`) is served without
  `Access-Control-Allow-Origin`, so the page cannot read it back.
- A stored file is served with `Access-Control-Allow-Origin: *`, so
  `fetch()` can read it.
- An account gets 30 uploads an hour (`FILEHOST_PER_HOUR`, the default),
  pictures and avatars included, and a 429 with `Retry-After: 600` past it.
  Sync has to space its uploads well inside that and wait a 429 out.
- A file is kept 30 days (`FILEHOST_RETAIN_DAYS`, the default). The host
  records the account, the network and the IP address of each upload.

AfterNET's `draft/FILEHOST` names this host
(`https://paste.boxlabs.uk/filehost`, read from its 005 on 2026-11-25). Where a
host refuses the type, a device says once in the home
network's window that the file host did not take the settings file, and
tries again every hour (`sync/engine.ts` `REFUSED_RETRY_MS`); nothing is
lost meanwhile, each device keeps its entries and their times.

## The code

- `client/js/sync/document.ts`: the document, the merge, the join, dating
  a device's changes (`diff`). Pure.
- `client/js/sync/file.ts`: the pointer (`SYNC_KEY`, `parsePointer`,
  `formatPointer`), gzip and AES-GCM (`seal`, `open`), the size limits, which
  URL a device fetches (`acceptableUrl`), `download` and `upload`.
- `client/js/sync/entries.ts`: each roaming store read into entries and
  written back from them, validating what arrives (`collect`, `apply`).
- `client/js/sync/state.ts`: what a device remembers
  (`thelounge.state.sync`: the home, the account, the pointer applied, when
  it may upload next; `thelounge.state.sync.entries`: its copy of the
  document). Neither is in a settings backup.
- `client/js/sync/engine.ts`: `SyncEngine`, one run at a time: read the
  pointer's file, join or merge, apply, upload when due. Everything outside
  it is a `SyncHost`, so it runs under mocha.
- `client/js/sync/index.ts`: the page's host: the settings port, the
  dialogs, the notices, the upload's Web Lock, and what asks for a run (the pointer,
  a write to a roaming store through `localStorage.ts` `onStorageWrite`,
  another tab's write to the sync state, the wake timer).
  `client/js/sync/reload.ts`: § Applying what arrives.
- IRC side: `IrcClient.syncPointer` (undefined until this connection read
  it), `onSyncPointer` → the bus event `sync:pointer`, `writeSyncPointer`
  and `backgroundToken` (both through `IrcClient.background`); the key rides
  in the `METADATA * SUB` and login `GET` lines the shared keys already use;
  `handlers/metadata.ts` takes a notification that says `private` or names
  our own nick, and a reply only for our own nick.
- UI: `components/Settings/SyncSwitch.vue`, under each network in Settings
  → Networks and on the single network of a branded build
  (`Settings/Account.vue`).
- Which settings roam: `sync: true` in `client/js/settings.ts`.
- Tests: `test/sync/` (document, file, entries, engine) and
  `test/irc/settingsSync.ts` (the pointer on the wire, the device state,
  the 29 marked settings). Browser check, two devices against a scripted
  ircd and a stand-in file host: `tools/scenarios/settings-sync.mjs`.

## Considered and dropped

- **Copies a device keeps of what it held before each sync**, to undo one
  (decided against, 2026-11-25): a mistake or a merge bug reaches every
  device, and the way back is a settings backup file the user exported by
  hand.
- **Settings packed into numbered metadata keys**: the settings fit (669
  bytes in a compact encoding, 3 keys), the lists do not (an alias may be
  2,000 bytes, and there may be 200); a list across two keys tears when two
  devices write at once; and every key is a subscription in the connect
  flush.
- **One metadata key per entry**, with `max-keys` raised to 500 (offered by
  the nefarious2 developers): the server's last write per key would be the
  merge, but a new entry's key is one nobody subscribed to (it needs prefix
  subscriptions); every server keeps every logged-in account's whole
  metadata in memory (`metadata_load_account`, remote users included: about
  20,000 bytes for a typical account, 210,000 at 500 full keys); every
  connect replays every key (`metadata_burst_self_to_client`); names must be
  hashed into the key alphabet; values still stop at 300 bytes; and a first
  upload is about 130 `SET` lines at about 3 s of fake lag each.
- **A document store built into nefarious2** (a new cap; documents with a
  revision and compare-and-set): the right model, but the most ircd work
  (values over several lines to clients, between servers and in the burst)
  and nefarious2 only.
- **Messages to oneself as a change log** (a `TAGMSG` to the own nick with a
  client tag, kept as private history; a `PRIVMSG` would show in every other
  client): the server orders the changes, but history expires
  (`CHATHISTORY_RETENTION`, 7 days by default; none where private history is
  off), so a new device needs another device online to send it the rest, and
  losing the only device loses everything after a week.
- **Devices sending each other their state live**: it works only while two
  devices are online at once, which a suspended phone rarely is.
- **A secret channel as the log**: someone else can take the name, it needs
  services to lock it, every device spends a JOIN on the connect path, and
  its members and the opers can read it.
- **An HTTP store beside the network** with its own login: a second service
  for every network to run.
- **A CRDT library** (Yjs, Automerge, Loro): their strength, many people
  editing the same text, is unused here; documents in their binary format
  would replace readable values; and they bring no transport.
- **Other keys for the file**: a passphrase typed on each device (readable by
  the user's devices alone, at a prompt per device; it could come later as an
  option), and a key from the account password (it breaks with passkey and
  OAuth sign-in and with every password change).

## Not part of this

- Private conversations between devices are the server's private history
  (`draft/chathistory`). The query log (`irc/querylog.ts`) stays on the
  device.
- Between tabs on one device: localStorage (#323 for settings, BUG-120 in
  locke_bugs.md for the query log).
