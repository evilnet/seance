# Settings backup

Settings → General → Backup and restore lets a person download everything they have set
up in this browser as one file and restore it on another device or hand it
to a friend who wants the same setup. Code: `client/js/helpers/settingsBackup.ts`
(Vue-free, `test/helpers/settingsBackup.ts`) and the Backup section of
`client/components/Settings/General.vue`. Browser check:
`tools/scenarios/settings-backup.mjs`.

## The file

`<app>-<YYYY-MM-DD>.seance-settings`: gzip of a JSON envelope.

```json
{
  "format": "seance-settings",
  "version": 1,
  "exportedAt": "2026-09-09T10:00:00.000Z",
  "app": "Seance",
  "platform": "web",
  "entries": {
    "settings": {"theme": "creama", "...": "..."},
    "thelounge.networks": [{"uuid": "…", "host": "…", "...": "..."}],
    "thelounge.ignore.<uuid>": []
  }
}
```

`entries` maps localStorage keys to their parsed values. Compression is the
browser's own `CompressionStream("gzip")`, so there is no dependency; a
browser without it writes plain JSON, and the loader accepts either (it sniffs
the gzip magic). `version` is bumped when a restore would need a migration; a
file from a newer version is refused with a message.

## What is in it

| Key                            | What                                       |
| ------------------------------ | ------------------------------------------ |
| `settings`                     | the settings object (the store's live one) |
| `thelounge.networks`           | saved networks                             |
| `thelounge.networks.collapsed` | collapsed networks in the sidebar          |
| `thelounge.sort.networks`      | network order                              |
| `thelounge.sort.channels`      | channel order per network                  |
| `thelounge.muted`              | muted channels                             |
| `thelounge.media.trusted`      | trusted media hosts / channels / accounts  |
| `thelounge.reactions.recent`   | the reaction picker's recents              |
| `thelounge.aliases`            | command aliases (Settings → Aliases)       |
| `thelounge.ignore.<uuid>`      | ignore list per network                    |

Left out on purpose: `thelounge.sts` (a cache), `thelounge.push*` (this
device's push subscriptions, bound to its service worker registration),
`thelounge.mentions` (a log), `thelounge.state.*` (where the UI was last).
The restore never writes a key outside the list above, whatever the file
holds.

**Passwords.** The saved networks' `saslPassword` is stripped unless
"Include network passwords" is ticked (the stripped entries get
`rememberPassword: false`, so the connect form asks again). The file is not
encrypted; the checkbox's tooltip says so. The restore dialog says when the
file it is about to apply carries passwords.

**Where it was made.** `platform` is `web`, `ios` or `android`
(`helpers/platformDefaults.ts` `currentPlatform`). Two settings default
differently by platform — `matchSystemTextSize` and `matchSystemAppearance`
are on in the native shells and off on the web — and the file carries the
live settings, defaults included, so without it a web backup restored in a
shell would switch following the system off there. A restore on another
platform gives such a setting that platform's default when the file's value
is just the default of the platform it was made on, and keeps it when it
differs (the person chose it). Turning one on follows the upgrade
migration's rule (`overridesChoice` in `helpers/settingsMigration.ts`): a
`fontSize` other than the default keeps `matchSystemTextSize` off, and a
theme other than the restoring deploy's default that has a light/dark
partner keeps `matchSystemAppearance` off, since following the system would
override what the person picked; an unpaired theme changes nothing, so
appearance follows the system. Between two shells, where both defaults are
on, the file's value is kept as it is. The key is written either way: a settings
object without it reads as one saved before the setting existed, and the
upgrade migration (`helpers/settingsMigration.ts`) would decide instead. A
file without `platform` (made before it was recorded) is restored as it is.
Adding the field did not bump `version`: an older build reads the file as
before and ignores it.

**Settings are always complete.** `store-settings.ts` writes the `settings`
key only once a setting has been changed, so the tab passes the store's live
settings object in (`collectBackup({settings})`) and a fresh profile's backup
still carries every setting.

## Restoring

Choosing a file decodes and validates it, then asks through the app's confirm
dialog (naming the file, the number of networks and whether it carries
passwords). On confirm, `applyBackup` removes every covered key
present in storage and writes the file's (the platform-dependent settings
rebased as above), and the page reloads — that is how
every module re-reads its storage (the settings store, `saved-networks.ts`,
`sort.ts`, `mute.ts`, `ignore.ts`, `mediaTrust.ts` all load at boot). Nothing
runs between the writes and the reload, so in-memory state cannot overwrite
the file's entries. A reload on Settings stays on Settings (`router.ts`
`onStandalonePage`); autoconnect networks come back on their own.
