# X3 services on the wire

What X3 (AfterNET's services: O3, AuthServ, ChanServ, Global) sends and
accepts, as a client that wants to parse its output and drive it from forms
needs to know it. Compiled 2026-10-10 from the source checkout at
`~/afternet/e-testnet/x3` (X3 2.0, srvx 1.3 lineage) and that testnet's
`data/x3.conf`. Line numbers refer to `src/` there. The design that uses
this is `docs/projects/oper-tools.md` (services support).

Nothing here is standard across networks: bot nicks, channel names and
which log lines go to which channel are all per-network config. The client
asks for them in the network's "Services support" section and assumes
nothing.

## 1. How every line goes out

- Replies to a user (`reply()`): **NOTICE** from the bot, unless the
  account has the `p` flag or the user is no_notice, then PRIVMSG.
- `send_channel_notice`: NOTICE. `send_channel_message` and the `irc:` log
  target: **PRIVMSG**.
- `$`-codes are expanded over the already-formatted text, user data
  included: `$b` bold, `$u` underline, `$k` colour, `$o` reset, `$r`
  reverse; `$S` sender nick, `$O`/`$N`/`$C`/`$X` the service nicks, `$s`
  server, `$$` literal. Channel lines always get the control characters;
  replies only if the account has MIRC_COLOR (default on).
- One line, cut at 450 characters at a word boundary; a `\n` ends it.
- Durations in: units `y M w d h m s` (case-sensitive), combinable
  (`1d12h`), a bare number is seconds; anything else is invalid (0).
- Intervals out: at most two units, `"%d%s"` joined by `", "` (`1d, 3h`),
  never "ago"; zero is `0 seconds`.
- Booleans: `true`/`1`/`yes`, `false`/`0`/`no`.

## 2. Recognising X3

- Bot nicks: `services/<svc>/nick`. Example config: AuthServ, O3, X3,
  Global; the testnet: AuthServ, O3, ChanServ, Global.
- Realname: `services/<svc>/description`, else the defaults `Oper Services`, `Nick Services`, `Channel Services`, `Global Services`,
  `Anti Spam Services`. Ident is the nick, host is `server/hostname`.
- User modes: `services/<svc>/modes`, default `+oik`; `k` marks a service.
- CTCP VERSION to any bot: `\x01VERSION X3 2.0+[release]\x01` (a git build
  says `+[git:<describe>]`). `/msg <bot> VERSION`: `$bX3 2.0+[release]$b (Based on srvx 1.3.x), Built: …`. `/VERSION <services server>` gives 351
  `x3 2.0+[release] <server>`.
- A non-oper messaging O3: `$bO3$b is a privileged service.`

## 3. The snoop feed (mod-snoop)

Config `modules/snoop`: `channel` (required), `channel_modes` (default
`+sntim`), `bot` (the sending bot; testnet `O3`), `show_bursts` (default
0). Testnet channel `#MrSnoopy`.

Every line is a PRIVMSG from the bot: `[HH:MM:SS] ` (X3 host local time)
then a bold keyword. Formats (mod-snoop.c:69-281):

| Line                             | Format                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nick change                      | `$bNICK$b change <old> -> <new>`                                                                                                                                                                                                                                                                                                                  |
| join                             | `$bJOIN$b <#chan> by <nick>`; `$bCREATE$b <#chan> by <nick>` when first in                                                                                                                                                                                                                                                                        |
| part                             | `$bPART$b <#chan> by <nick> (<reason>)` (never for a quitting user)                                                                                                                                                                                                                                                                               |
| kick                             | `$bKICK$b <victim> from <#chan> by <kicker\|some server>`                                                                                                                                                                                                                                                                                         |
| connect                          | `$bNICK$b <nick> <ident>@<realhost> (<account>) [<ip>] on <server>` — no realname; `()` when not authed                                                                                                                                                                                                                                           |
| kill by X3                       | `$bKILL$b <nick> (<ident>@<host>, on <server>) by <killer> (<reason>)`                                                                                                                                                                                                                                                                            |
| quit, and kills from the network | `$bQUIT$b <nick> (<ident>@<host>, on <server>) (<reason>)`                                                                                                                                                                                                                                                                                        |
| auth                             | `$bAUTH$b <nick> as <account>` (not for accounts stamped at connect)                                                                                                                                                                                                                                                                              |
| umode                            | `$bUMODE$b <nick> <modes>` (skipped for one-character changes); AfterNET's X3 appends `<cloaked host> <cloaked IP>` when `+x` is among the modes, e.g. `UMODE clonebot7 +xzCc AN-1A2B3C4D.example.net ABCDEF.123456.7890AB.CDEF01.IP` (the values made up; seen 2026-10-11) — the client keeps them as `cloak`/`cloakIp`, never as the host or IP |
| oper-up                          | `$bOPER$b <nick>!<ident>@<host> [<ip>] on <server>`                                                                                                                                                                                                                                                                                               |
| channel mode                     | `$bMODE$b <#chan> <modes>[ <arg>…] by <setter>`                                                                                                                                                                                                                                                                                                   |

Quirks: joins, connects and auths are suppressed during bursts; for a
connecting user the UMODE/OPER lines come **before** the NICK line; the
MODE line's parameter collection mishandles `-l`.

Regex: `^\[\d\d:\d\d:\d\d\] \x02(NICK|CREATE|JOIN|PART|KICK|QUIT|KILL|AUTH|UMODE|OPER|MODE)\x02 `.

## 4. The audit log: what opers made services do

**No service posts a "G-line added by …" report.** For GLINE, UNGLINE,
SHUN, BLOCK, CLEARBANS, CLEARMODES, REHASH, TRACE actions, OREGISTER, OSET,
GOD and every other command, the only channel output is the audit line the
command framework writes after a successful command (modcmd.c:814-831;
`nolog` commands excepted: INFO, PEEK, EVENTS, LAST, SEARCH, UNVISITED).
Failed commands (e.g. an invalid GLINE) write nothing.

- **Severity:** `override` when a channel command only succeeded through
  god mode (and ChanServ adduser/clvl/deluser/wipeinfo/suspend/unsuspend
  under override); `staff` for every O3 command (they are all `+oper`),
  `+helping` commands, GOD itself; `command` otherwise.
- **Facility:** `OpServ`, `ChanServ`, `NickServ`, `x3` (modcmd, e.g. god).
- **Destination:** the `logs` config section, per facility and severity.
  Example and testnet: `"*.override,error,fatal" "irc:#TheOps"`,
  `"*.staff" "irc:#MrSnoopy"` (so the testnet's snoop channel also carries
  staff lines). X3 does **not** tag an override in words; the channel it
  went to is the only signal.
- **Wire text** (log.c:995-1004): a PRIVMSG **from the bot that ran the
  command**, `(<#chan>) [<nick>!<ident>@<host>:<account>]: <command args>`
  — empty `()` when there is no channel (the normal case for O3), no
  `:account` when not authed, the command as typed with its case, the
  channel argument moved into the prefix: `() [Rubin!~r@h:rubin]: gline *@1.2.3.4 1h spamming`, `(#foo) [n!i@h:acct]: clearbans`, `() [..]: god on`, `() [..]: addalert foo notice nick bar*`. `stats x` is logged as
  `stats x`. OREGISTER masks the password; **OSET PASSWORD does not**.
- Regex: `^\((#\S*)?\) \[[^!\]]+![^@\]]+@[^\]:]+(:[^\]]+)?\]: `.
- Non-audit module logs to an `irc:` target are PRIVMSGs from O3:
  `<Facility> <severity>: <message>` (severities replay, debug, command,
  info, override, staff, warning, error, fatal).

## 5. O3's own channels (all NOTICE from O3)

Config `services/opserv`: `alert_channel` (`+tns`), `debug_channel`
(`+tinms`), `staff_auth_channel` (`+timns`). Testnet: `#TheOps`, `#TheOps`,
`#OperServ`.

- Alert, reaction NOTICE, to the alert's `target` or the alert channel:
  `Alert $b<name>$b triggered by user $b<nick>$b!<ident>@<host> (<reason>).`
  Reason defaults to the alert name. **Only NOTICE alerts post anything;
  GLINE/KILL/SHUN alerts are silent on IRC.**
- `Warning: Possible new-user flood.`
- `Warning: Possible join flood in <#chan> (currently <n> users[; channel moderated]).`
- debug: `Found $b<nick>$b in bad-word channel $b<#chan>$b; removing the user.`
- staff auth: `<nick> [<ident>@<host>/<ip>] authed to <OPER|NETWORK HELPER|SUPPORT HELPER> account <account>`
  (`[<ident>@<host>]` without a valid IP).
- Global NOTICEs to each oper/helper nick individually (not a channel):
  `<x> is changing the DefCon level to <n>`, `<acct> unregistered account <acct>.`, `<chan> registered to <acct> by <acct>.`, `<chan> suspended by …`, `<chan> ownership transferred to … by …`, `… renamed account … to …`.

## 6. God mode

`/msg ChanServ GOD [on|off]` (`+oper,+networkhelper`); sets account flag
`g`, times out after `god_timeout` (default 15m; testnet 30m) with
`Security override expired.` Replies: `Security override has been enabled.` / `disabled.` / `You already have security override enabled.`/`disabled.` No dedicated report: GOD is a staff audit line, and
commands that needed it are override audit lines (§4).

## 7. O3 commands the client drives

### Alerts

`ADDALERT <name> <reaction> [expire <duration>] <criteria…>` (level 800;
reactions GLINE/SHUN/TEMPSHUN/TRACK/KILL need 900, SVSJOIN/SVSPART/VERSION/
MARK 999; NOTICE/NOTICEUSER/MSGUSER at the base level). Replies: `Added alert named $b<name>$b.`; `Unknown alert reaction $b<r>$b.`; `An alert named $b<name>$b already exists.` then `Unable to add alert. Check syntax, required parts, and access` (two spaces); any criteria error's message
then that same line.

`DELALERT <name>…` (800): `Removed alert named $b<name>$b.` /
`No alert named $b<name>$b could be found.`

There is no LISTALERT: `STATS ALERTS [filter]` (filter = glob on the
criteria text, or an owner, or a name): header `$bCurrent $O alerts matching '$b<f>$b'$b`, dashes, `Name Action (by Oper)`,
dashes, per alert `$b%-20s$b %-6s (by <owner>)` then optional
` $uExpires:$u: <%Y-%m-%d %H:%M:%S %z>`, ` $uCriteria$u: <raw>`,
` $uTriggered$u: <interval|Never>`; footer
`----------------End of Alerts-----------------`.

Alerts are checked on every connect and join, on nick change (alerts with
a nick mask), on auth (alerts with `account`), on a CTCP VERSION reply to
O3. Reactions other than NOTICE skip opers unless `abuse opers`, and
trusted IPs unless `abuse trusted`. GLINE reacts on `*@<ip>` (issuer the
alert owner, `duration` or `block_gline_duration`), SHUN on `*@<host>`.

### Criteria (shared by ADDALERT and TRACE; opserv.c:5334-5727)

Keywords are case-insensitive; every one but `log` takes a value; glob
matching unless `regex yes`; `*` values are ignored.

| Keyword                                                                  | Value                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `mask`                                                                   | `nick!user@host` (sets nick, ident, host)                          |
| `nick`, `ident`, `info`                                                  | glob, or `&nick`/`&ident`/`&info` to compare the user's own fields |
| `host`                                                                   | glob on the hostname                                               |
| `ip`                                                                     | `1.2.3.4`, `1.2.*`, `1.2.3.0/24`, IPv6/bits                        |
| `server`                                                                 | glob on the uplink                                                 |
| `version`                                                                | glob on the stored CTCP VERSION reply                              |
| `account`                                                                | glob; implies authed (with `authed no`: error)                     |
| `authed`                                                                 | bool                                                               |
| `marked`                                                                 | glob on marks; `mark` (MARK reaction only) `[A-Za-z0-9-]{1,200}`   |
| `channel`                                                                | `[@%+-]*#chan`, up to 20 times (prefixes only apply to TRACE)      |
| `numchannels`                                                            | N (exact)                                                          |
| `nickage` / `linked`                                                     | `<N`, `<=N`, `>N`, `>=N`, N (nick timestamp)                       |
| `last`                                                                   | interval (nick timestamp within)                                   |
| `access`                                                                 | `<n`, `<=n`, `=n`, `>n`, `>=n`, n (≥)                              |
| `clones`                                                                 | N (minimum clients from one IP)                                    |
| `modes`                                                                  | e.g. `+o-i`                                                        |
| `regex`, `info_space`, `silent` (needs level ≥ 700), `checkrestrictions` | bool                                                               |
| `duration`                                                               | interval — the G-line/shun length, **not** connect time            |
| `limit`                                                                  | N (default 250)                                                    |
| `chantarget`                                                             | `#chan` (SVSJOIN/SVSPART)                                          |
| `target` / `notice_target`                                               | `#chan` for the NOTICE reaction                                    |
| `abuse`                                                                  | `opers` or `trusted`                                               |
| `depth`                                                                  | N (DOMAINS)                                                        |
| `reason`                                                                 | the rest of the line; must be last                                 |

There are no `min_channels`/`max_channels`. Errors: `$b<x>$b is an invalid search criteria.`, `$b<x>$b requires more parameters.`, `$b<x>$b is an invalid IRC hostmask.`, `$b<x>$b is not a valid IP address`, `$b<x>$b is an invalid binary value.`, `Invalid regex: …`.

### TRACE

`TRACE <action> <criteria…>` (level 100; gline/shun/tempshun/gag/kill 600;
version/svsjoin/svspart/mark 999). PRINT: `The following users were found:`, dashes, `Nick User@Host (Account)`, dashes, per
user `%-15s\002 \002%10s\002@\002%s (%s)` (no ` (acct)` when not authed;
literal bold bytes), footer `------------ Found %4u matches -----------`.
Other actions: `There were %4u matches` (skipped opers/trusted included).
No match: `Nothing matched the criteria of your search.` Default reasons:
`G-line requested by <acct>.`, `Shun requested by <acct>.`, `Kill requested by <nick>.`

### Bans

- `GLINE <user@host|#chan> <duration> <reason>` (600). Mask must contain
  `@`, host part `[A-Za-z0-9.\-?*:]` — **no CIDR**. Replies: `G-line issued for $b<mask>$b.`; `Invalid G-line '<m>'.`; `Gline <m>? Now $bthat$b would be smooth.` (too-wide masks); `Invalid time span '<d>'.`
  Re-adding extends the expiry.
- `BLOCK <nick> [duration] [reason]` (100): G-line `*@<ip>`, default
  `block_gline_duration` / `G-line requested by <acct>.`; a custom duration
  needs GLINE access. Errors include `$b<n>$b is on a trusted ip. …`,
  `G-lining $b<n>$b (*@<ip>) would also hit the IRC operator $b<o>$b.`
- `UNGLINE <mask>` (600): `G-line removed for $b<m>$b.` or
  `Unknown/expired G-line removed for $b<m>$b.` — always succeeds.
- `REFRESHG [server]`, `GSYNC [server]`.
- SHUN / SBLOCK (`*@<host>`) / UNSHUN / SSYNC mirror these with "Shun".
  REFRESHS is broken (unregistered message keys; the oper gets no reply).
- `STATS GLINES [mask]`: `There are <n> glines active on the network.` or
  `<mask> (issued <interval> by <issuer>, expires <interval|never>): <reason>`
  or `$b<m>$b is not a known G-line.` `STATS SHUNS` likewise.
- `GTRACE <print|count|ungline> <criteria>` with `mask|host [exact|subset| superset] <m>`, `limit`, `reason`, `issuer`, `after`, `before`: `The following glines were found:`, lines as STATS, footer `-----------Found $b%3u$b Matches------------`.
- Automatic clone G-lines: issuer O3, `*@<ip>`, `clone_gline_duration`,
  reason `Excessive connections from a single host.`, sent silent.

On the wire a G-line goes out as `<srv> GL * +<mask> <secs> <now> :<issuer> <reason>` (`:AUTO <issuer> <reason>` when silent); the ircd's own server
notice about it names the issuer the client sees.

### WHOIS and CHANINFO

`WHOIS <nick>` lines in order (conditional in brackets): `Nick :`,
`Host : <ident>@<host>`, [`Fakehost :`], `Crypt Host :`,
`Crypt IP :`, `Real IP :`, GeoIP [`Country :`, `Country Code
:`, `City :`, `Region/State :`, `Postal Code :`, `Latitude :`,
`Longitude :`, `Map :`, `DMA Code :`, `Area Code :`, or
just `Country :`], [`Version :`], [`Cert f/print :`], [`Mark
:`], [`Marks :` — buggy, lists the asker's marks], `No_notices : YES|NO`, [`Modes : +<m> [(gagged)] [(registered account)] `],
`Info :`, `Numnick :`, `Server :`, `Account : <acct>|Not authenticated`, `IRCd Privs : <names> `, `Nick Age : <interval>`, [`Channels : @#a +#b … ` repeated, or `Channel list
omitted for your sanity.` over 50]. Labels are padded to 13 characters
before the colon. Unknown nick: `User with nick $b<n>$b does not exist.`

`CHANINFO <#chan> [users]`: `<#chan> Information`, `Created on: <%a %b %d %H:%M:%S %Y> (<unix>)` (UTC), `Modes: <m>[; bad-word channel]`, `Topic (set by <n>, <date>): <t>` or `Topic: (none / not gathered)`, [`Bans
(<n>):` then `<mask> by <setter> (<date>)` each], [`Exempts (<n>):` …],
then either `<n> users ("/msg O3 chaninfo <#chan> users" for the list)`
(≥50 members without `users`) or `Users (<n>):` with ` @<nick>[:<oplevel>] (<ident>@<host>)`, ` %<nick> (…)`, ` +<nick> (…)`, ` <nick> (…)`.
Unknown channel: `The channel name you specified does not exist.`

## 8. AuthServ

`ACCOUNTINFO <account|nick>` lines in order: `$bAccount Information for <a>$b`, dashes, `Registered on: <ctime>`, `Last seen: <interval>` or `Last seen: Right now!`, `Infoline: …`, [`On vacation.`], then for staff
[`Do-not-register (by <x>): <reason>`] — a viewer below level 900 who is
outranked gets `$b<a>$b outranks you (command has no effect).` and
nothing more; a non-staff viewer of someone else's account gets the end
line and stops — [`Karma: <n>` for +o], [`Email address: <addr>|Set.|Not
set.`], [cookie lines], `Flags: +<SphgscfnHbxI>` or `None`, [`Opserv
level: <n> `], [`Epithet: …`], [`Note (by <x> on <%b %d %Y>): … `],
[`Fake host: …`], `Last quit hostmask: <mask|Unknown>`, [`Nickname(s):`],
`Hostmask(s): …`, `Client Certificate Fingerprints(s): …`, `Ignore(s): …`,
`Channel(s): Owner:#a Op:#b …` (`-` prefix when suspended), [`Current
nickname(s): …`], `----------End of Account Info-----------`. Lists are
split into 400-byte chunks repeating the prefix.

`SEARCH <print|count|unregister|set> <criteria>` (level 100): `limit`,
`flags`, `registered <op><interval>`, `seen`, `nickmask`, `hostmask [exact|subset|superset|lastquit|lastauth] <m>`, `accountmask`, `email`,
`title`, `access`, `karma`. Output `The following accounts were found:`,
`Match: <a>` each, footer `-----------Found $b%3u$b Matches------------`.

Opers with god mode: `OREGISTER`, `OUNREGISTER` (also a Global notice
`<acct> unregistered account <acct>.`), `OSET` — all audited at staff level.

## 9. ChanServ output the client reads

`INFO <#chan>`: `$bInformation About <#chan>$b`, dashes, for Op+ `$bDefault Topic: $b…`, `$bMode Lock: $b…`, notes `$b<name>:<pad>$b…`,
`$bRecord Visitors: $b<n>`, `$bOwner: $b<a>` (per owner),
`$bTotal User Count: $b<n>`, `$bLamer Count: $b<n>`,
`$bVisited: $b<interval> ago.`, `$bRegistered: $b<interval> ago.`, `$bRegistrar: $b<a>`, staff do-not-register
and suspension lines, ownership history, `---------------End of Info--------------`. Labels are padded to 21 characters.

`PEEK <#chan>` (Op+): `$bStatus of <#chan>$b`, dashes, `$bTopic: $b…`, `$bModes: $b…`, `$bTotal users: $b<n>`, `$bOps:$b` then a
table of nicks (or `$bOps: $bNone present`),
`-------------End of Status--------------`.

`EVENTS <#chan> [limit [pattern]]` (Manager+): `$bChannel Events for <#chan>$b`, dashes, per entry the raw audit text `[HH:MM:SS MM/DD/YYYY] (ChanServ:<#chan>) [nick!ident@host:acct]: <command>` as NOTICE (normal
commands only, never override or staff entries; in-memory, ~10 minutes),
footer as SEARCH.

## 10. Known server-side bugs met while reading

- WHOIS `Marks` lists the requesting oper's marks, not the target's.
- REFRESHS replies with unregistered message keys (no reply; an error log
  line instead).
- `GTRACE UNSHUN` is registered where `STRACE UNSHUN` was meant.
- `LASTMOD` in the GTRACE help is not implemented.
- The snoop MODE line's `-l` handling eats a parameter.
- OSET PASSWORD puts the plaintext password in the audit line.
