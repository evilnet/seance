# nefarious2: the IRC-operator surface on the wire

_Compiled 2026-10-09 from `ircv3.2-upgrade` at `346a1c0` by reading the source and from captures against the dev rig (`tools/nefarious-dev`, oper `seanceop`). The relevant code was re-checked against `8453087` where it matters. "(live)" marks lines seen on the wire; everything else is read from the code. Paths are relative to `tmp/nefarious2/`. What Seance should do with all this is `docs/projects/oper-tools.md`._

## 1. The envelope

- **Numerics** go through `send_reply()` (`ircd/ircd_reply.c:88`): `[@batch=<id>|@label=<l>][;time=…] :<server> NNN <me> …`. The server name is always the real one (never HIS_SERVERNAME). Every numeric carries the label when the request had one, the first and all later lines alike.
- **`labeled-response` batches.** With both `labeled-response` and `batch` negotiated and a labeled request, these commands open `BATCH +<id> labeled-response` around their whole reply (`labeled_batch_start()`, `ircd/send.c:4154`; closed by `parse.c:1734` after the handler returns):
  - STATS, CHECK, TRACE, MAP, LINKS, LUSERS, ADMIN, INFO, VERSION
  - WHO, WHOIS, WHOWAS, NAMES, LIST, MOTD, OPERMOTD, RULES, HELP, IRCOPS
  - SILENCE, WATCH, MONITOR, a MODE query
- **Forwarded commands keep their label.** `ircd/forwarded_label.c` correlates a command sent on to another server by its terminal numeric: WHOIS 318, STATS 219, LINKS 365, INFO 374, MOTD 376/422, TRACE 262, ADMIN 259, VERSION 351, TIME 391, LUSERS 266, RULES 309, OPERMOTD 537, WHOWAS 369, NAMES 366. CHECK is not in that table, so a remote `CHECK` comes back unlabeled; bracket it by 286…291 instead.
- **Untagged replies** ([evilnet/nefarious2#119](https://github.com/evilnet/nefarious2/issues/119), [#120](https://github.com/evilnet/nefarious2/issues/120)): `sendcmdto_one()` to a client adds no tags at all, and neither do the hand-built `msgq_make(rpl_str(…))` replies. The effects:
  - Inside a labeled batch, NOTICE lines carry no `@batch` (live: the `STATS` help list, `STATS w`, VERSION's `Headers:`/`Library:`/`GeoIP`/`MaxMindDB` lines, LUSERS' `Highest connection count:`). They do arrive between `BATCH +` and `BATCH -`.
  - `USERHOST` 302, `USERIP` 340, `ISON` 303 and `PRIVS` 270 come unlabeled, followed by `@label=… ACK` (live).
  - NOTICE-only commands answer with unlabeled NOTICEs plus an ACK: CONNECT, UPING, ASLL, GITSYNC, SETTIME, HISTORY, MKPASSWD, HASH, and an oper's PONG.
- **No tags whatsoever** on server notices, WALLOPS/WALLUSERS/DESYNCH, the `+W` "did a /whois on you" notice, or one's own MODE echoes (live: `:opr!opr@172.17.0.1 MODE opr +owsg`). None of them carries `time`, so the client stamps them itself.
- **Fake lag.** Opers pay it only for `MFLG_SLOW` commands. GLINE, SHUN, ZLINE and SETHOST are not slow; KILL, OPMODE, JUPE, TEMPSHUN, REMOVE and the info commands are.
- **Silent success.** GLINE, SHUN, ZLINE, JUPE, KILL, OPMODE, CLEARMODE, REMOVE, TEMPSHUN and `SETHOST undo` send the oper no numeric when they work; a labeled request gets a bare `ACK`. The confirmation is the snotice (if the snomask has the bit) or a re-list.

## 2. Identifying the server

| Line  | Live                                                                                                           | Notes                                                                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 002   | `:Your host is irc.seance.test, running version u2.10.12.14+Nefarious(2.0.0)`                                  |                                                                                                                                                                                                                        |
| 004   | `irc.seance.test u2.10.12.14+Nefarious(2.0.0) abdgiknoqswxyzBDHLMNORWXY abCcDdhHikLlMmNnOopPQRrSsTtvZz bkLlov` | Five middle params. The umode list is wrong: it advertises `n` and `N`, which do not exist, and omits `p I r h f c C` (`include/client.h:119`).                                                                        |
| 351   | `u2.10.12.14+Nefarious(2.0.0)+[].5 irc.seance.test :B27ADMRUZ6`                                                | `<version>+[<git describe>].<debuglevel> <server> :<serveropts>`. Opts: A asserts, D DEBUGMODE, H hub, Z TLS, 6 IPv6, B buffer pool, M idle-from-msg, R reliable clock, U poll engine. `[]` is empty on Docker builds. |
| ISNEF | `371 <me> :NI u2.10.12.14+Nefarious(2.0.0) []`                                                                 | Nefarious-only command.                                                                                                                                                                                                |

- **The version string is identical on `master` and `ircv3.2-upgrade`.** Tell them apart with:
  - ISUPPORT tokens only on the branch: MONITOR, TARGMAX, CHATHISTORY, MSGREFTYPES, `evilnet/CHATHISTORYRETENTION`, EXTBAN (master spells it EXTBANS), VAPID, `draft/FILEHOST`, UTF8ONLY, CLIENTTAGDENY, ACCOUNTEXTBAN.
  - 004 user modes `b y M Y` and channel modes `H P`.
  - Caps `draft/persistence` and `draft/oper-tag`.
- **ircu-family markers:** WHOX, WALLCHOPS, WALLVOICES, USERIP, CPRIVMSG, CNOTICE, SILENCE, MAXNICKLEN, MAXCHANNELLEN.
- **Nefarious markers (master too):** WALLHOPS, BOT=B, NAMESX, UHNAMES, WATCH.

## 3. Becoming and being an oper

### OPER

```
>> OPER seanceop seance                                          (live)
<< :opr!opr@172.17.0.1 MODE opr +x
<< :opr!opr@172.17.0.1 MODE opr +owsg
<< @time=… :irc.seance.test 381 opr :You are now an IRC Operator
<< :irc.seance.test NOTICE * :*** Notice -- opr (opr@172.17.0.1) is now a global operator (O)
```

**Syntax.**

- `OPER <name> <password>`.
- Remote form: `OPER <server> <name> <password>`. Needs REMOTE_OPER (default on) and PRIV_REMOTE on the target.
- OPER while already opered just returns 381.
- Password checks (bcrypt, PBKDF2) may be asynchronous, so 381 can arrive late; a second OPER meanwhile gets `NOTICE :OPER authentication already in progress`.

**Authentication.**

- An Operator block may require an `sslfp` in addition to the password.
- There is **no SASL, account or certfp auto-oper**.
- The only grant without OPER is a bouncer session reviving or promoting an alias: the grant is reapplied silently, with no 381.

**Success order** (`m_oper.c` `do_oper`):

1. Privileges set.
2. `+o` (global) or `+O` (local), plus `+a` for ADMIN, plus `+w +s +g`.
3. The block's `usermode` applied, possibly with 008.
4. 381.
5. Host re-hide, autojoin, swhois.
6. The OLDSNO "is now a … operator" snotice.
7. OPERMOTD, if FEAT_OPERMOTD is on (default off).

A plain OPER that leaves the default snomask sends no 008.

**Failures.** Each also sends an OLDREALOP snotice.

| Numeric | Format                                       | Cause                                   |
| ------- | -------------------------------------------- | --------------------------------------- |
| 491     | `:No Operator block for your host`           | no block, no remote priv, attach failed |
| 464     | `:Password Incorrect`                        | wrong password                          |
| 532     | `:SSL certificate fingerprint did not match` | certfp mismatch                         |
| 461     | —                                            | too few params                          |

**Levels.**

| Level   | Mode | Meaning                                                                                          |
| ------- | ---- | ------------------------------------------------------------------------------------------------ |
| local   | `+O` | not PROPAGATE; local privilege defaults; never KILL, GLINE, JUPE, SHUN, ZLINE, OPMODE or BADCHAN |
| global  | `+o` | PROPAGATE; DISPLAY forced on                                                                     |
| admin   | `+a` | PRIV_ADMIN                                                                                       |
| service | `+k` | PRIV_SERVICE                                                                                     |

**De-opering.** After `-o` the privileges go, but `+s`, `+w` and `+g` remain.

### PRIVS

- **Syntax.** `PRIVS [nick…]`. Opers only (481 otherwise).
- **Reply.** `270 <me> <target> :<PRIV …>` (live). One line, **truncated near 510 bytes**: all 51 names are about 489 characters plus the prefix. It is untagged and followed by an ACK (#120).
- A remote target is answered by that user's server.
- A server-side change sends `NOTICE <nick> :Your privileges were modified`.
- **The dev oper's privileges** (live, from CHECK):
  ```
  CHAN_LIMIT SHOW_INVIS SHOW_ALL_INVIS KILL LOCAL_KILL REHASH RESTART DIE JUPE LOCAL_JUPE OPMODE WHOX SEE_CHAN PROPAGATE DISPLAY SEE_OPERS WIDE_GLINE LIST_CHAN FORCE_OPMODE CHECK WIDE_SHUN REMOTEREHASH WIDE_ZLINE TEMPSHUN GITSYNC
  ```
  It lacks GLINE/LOCAL_GLINE, SHUN/LOCAL_SHUN and ZLINE/LOCAL_ZLINE, so those commands answer 481 on the rig. It also lacks SET and REMOVE, which no default set includes. To test bans, the rig's Operator block needs them granted explicitly.

| Privilege                                                                       | Gates                                                                         |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| CHAN_LIMIT                                                                      | no channel limit                                                              |
| MODE_LCHAN / WALK_LCHAN / DEOP_LCHAN                                            | modes on, override-join, can't be deopped on `&` channels                     |
| SHOW_INVIS / SHOW_ALL_INVIS / UNLIMIT_QUERY                                     | see invisible users in WHO; no WHO result cap                                 |
| KILL / LOCAL_KILL                                                               | KILL a remote / a local victim (strict: KILL does not cover local)            |
| REHASH / REMOTEREHASH                                                           | REHASH and STORE; remote REHASH                                               |
| RESTART / DIE / GITSYNC / SET                                                   | those commands (SET also covers RESET)                                        |
| GLINE / LOCAL_GLINE / WIDE_GLINE                                                | global / local / forced-wide G-lines                                          |
| SHUN / LOCAL_SHUN / WIDE_SHUN, ZLINE / LOCAL_ZLINE / WIDE_ZLINE                 | same for shuns and Z-lines                                                    |
| JUPE / LOCAL_JUPE                                                               | server jupes                                                                  |
| OPMODE / LOCAL_OPMODE, FORCE_OPMODE / FORCE_LOCAL_OPMODE, APASS_OPMODE          | OPMODE/CLEARMODE; the `!` quarantine override; +A/+U                          |
| BADCHAN (never checked) / LOCAL_BADCHAN                                         | channel G-lines                                                               |
| WHOX / SEE_CHAN / LIST_CHAN                                                     | `WHO … x`; secret channels in WHO x and LIST                                  |
| PROPAGATE / DISPLAY / SEE_OPERS                                                 | global oper; shown as oper (313, WHO `*`, `draft/oper` tag); see hidden opers |
| CHECK                                                                           | CHECK (otherwise **517**, not 481)                                            |
| WHOIS_NOTICE / HIDE_OPER / HIDE_CHANNELS / HIDE_IDLE / XTRAOP / SERVICE / ADMIN | may set `+W` / `+H` / `+p` / `+I` / `+X` / `+k` / `+a`                        |
| REMOTE                                                                          | target of a remote OPER                                                       |
| TEMPSHUN / REMOVE / FREEFORM                                                    | TEMPSHUN; REMOVE; SETHOST to any host                                         |

### User modes (`s_user.c:1117-1148`)

- **221.** `221 <me> +<modes>` (live `+owsgx`). It omits `r c C f h`.
- `s` and `O` are local modes and are not propagated.

| Mode                  | Meaning                                                       | Who may set it (defaults)               |
| --------------------- | ------------------------------------------------------------- | --------------------------------------- |
| o / O / a             | global / local oper / admin                                   | OPER only                               |
| i                     | invisible                                                     | anyone                                  |
| w                     | WALLOPS                                                       | anyone, unless WALLOPS_OPER_ONLY        |
| s                     | server notices (with snomask)                                 | opers (HIS_SNOTICES_OPER_ONLY)          |
| g                     | DESYNCH wallops                                               | opers (HIS_DEBUG_OPER_ONLY)             |
| d                     | deaf                                                          | anyone                                  |
| k                     | network service                                               | PRIV_SERVICE                            |
| x                     | hidden host                                                   | +x anyone; -x usually not               |
| p                     | hide channels in WHOIS                                        | anyone (DERESTRICT_HIDECHANS)           |
| q                     | PMs only from common channels                                 | anyone                                  |
| B / D / R / L         | bot / no PMs / PMs from logged-in users only / no +L redirect | anyone                                  |
| H / I / W / X         | hide oper / hide idle / whois notices / xtraop                | feature + privilege, all off by default |
| z / r / h / f / C / c | TLS / account / sethost / fakehost / cloak host / cloak IP    | server-set                              |
| M / Y / y / b         | multiline expand / no storage / PM opt-out / bouncer hold     | anyone                                  |

## 4. Snomasks

### Bits (`include/client.h:1623-1642`)

The values never change; clients depend on them.

|    dec | hex     | name       | What sends on it                                                                                                                   | User default | Oper default | Oper only | Volume                    |
| -----: | ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | :----------: | :----------: | :-------: | ------------------------- |
|      1 | 0x1     | OLDSNO     | oper-ups, server links, ERROR, SQUIT, clock, rehash, GitSync, bouncer, collisions, WEBPUSH, SSL reload, sendq, every CRIT log line |              |      ✔       |           | low–med, bursty on splits |
|      2 | 0x2     | SERVKILL   | KILL from a server                                                                                                                 |              |              |           | low–med                   |
|      4 | 0x4     | OPERKILL   | KILL from a user; K-line active; rehash-time G/Z-line active                                                                       |      ✔       |      ✔       |           | low                       |
|      8 | 0x8     | HACK2      | desyncs (bounced modes and kicks)                                                                                                  |              |      ✔       |           | low, bursty               |
|     16 | 0x10    | HACK3      | server MODEs (BOUNCE or HACK(3))                                                                                                   |              |              |           | low–med                   |
|     32 | 0x20    | UNAUTH     | unauthorized connections, SASL-required rejections                                                                                 |              |              |           | med                       |
|     64 | 0x40    | TCPCOMMON  | accept/TLS errors                                                                                                                  |              |              |           | med–high                  |
|    128 | 0x80    | TOOMANY    | too many connections (rate-limited)                                                                                                |              |              |           | low                       |
|    256 | 0x100   | HACK4      | services/U-line modes and kicks, OPMODE, CLEARMODE, OPER JOIN                                                                      |              |              |           | high with services        |
|    512 | 0x200   | GLINE      | G-line/shun/Z-line/BADCHAN changes, "… active for", temp shuns, DNSBL                                                              |      ✔       |      ✔       |           | med                       |
|   1024 | 0x400   | NETWORK    | net junction/break, burst, JUPE, drift, IAuth log lines                                                                            |      ✔       |      ✔       |           | low                       |
|   2048 | 0x800   | IPMISMATCH | IP# mismatch                                                                                                                       |              |              |           | med                       |
|   4096 | 0x1000  | THROTTLE   | **nothing sends on it**                                                                                                            |              |      ✔       |           | none                      |
|   8192 | 0x2000  | OLDREALOP  | failed OPER attempts                                                                                                               |              |              |     ✔     | low                       |
|  16384 | 0x4000  | CONNEXIT   | client connect/exit (needs CONNEXIT_NOTICES)                                                                                       |              |              |     ✔     | very high                 |
|  32768 | 0x8000  | AUTO       | line changes whose reason starts "AUTO"                                                                                            |              |              |           | depends on services       |
|  65536 | 0x10000 | DEBUG      | DEBUGMODE builds only; stripped otherwise                                                                                          |              |              |           | n/a                       |
| 131072 | 0x20000 | NICKCHG    | nick changes (needs CONNEXIT_NOTICES)                                                                                              |              |              |           | high                      |
| 262144 | 0x40000 | AUTH       | IAuth                                                                                                                              |              |              |     ✔     | low–high                  |
| 524288 | 0x80000 | WEBIRC     | WEBIRC host change (needs CONNEXIT_NOTICES), bad WEBIRC attempts, anything sent with SNO_ALL                                       |              |              |           | med–high                  |

### Composite masks

| Name            | Value                                     |
| --------------- | ----------------------------------------- |
| SNO_ALL         | 0xeffff = 983039 (0xfffff with DEBUGMODE) |
| SNO_USER        | 0xa9fff = 696319                          |
| SNO_DEFAULT     | 0x604 = 1540                              |
| SNO_OPERDEFAULT | 0x160d = 5645                             |
| SNO_OPER        | 0x46000 = 286720                          |

The runtime defaults are features (`SNOMASK_DEFAULT`, `SNOMASK_OPERDEFAULT`), so read them with `GET`; don't hard-code them.

### Setting and reading

`MODE <me> +s <arg>` (`s_user.c:2969-3003`). The argument goes through `atoi`, so **decimal only**: `0x605` is 0, which clears the mask and drops +s.

| Form             | Effect              |
| ---------------- | ------------------- |
| `+s N`           | set absolute        |
| `+s +N`          | OR in               |
| `+s -N`          | remove              |
| `-s N`           | remove              |
| `+s all`         | SNO_ALL             |
| bare `+s` / `-s` | feature default / 0 |

- The result is ANDed with SNO_ALL (opers) or SNO_USER.
- A zero result drops +s; `-s <bits>` that leaves bits behind keeps +s.

**008.** `008 <me> <decimal> :: Server notice mask (<hex>)`; the params are `[me, "5645", ": Server notice mask (0x160d)"]` (live).

- After an explicit numeric argument with a non-zero result, 008 is sent.
- **`MODE <me> +s +0` is a safe read**: it changes nothing and answers with a labeled 008 (live).
- A bare `MODE <me>` includes 008 only when the mask differs from the default.

**Whether connect/exit notices exist at all.** `GET CONNEXIT_NOTICES` → `284 <me> :Boolean value of CONNEXIT_NOTICES: FALSE` (live). Any oper may GET.

**Delivery picks one bit.** A notice goes only to opers holding the **highest bit set in the mask it was sent with** (`send.c:3418-3422`). Consequences:

- "Config parse error" is sent with SNO_ALL, so only WEBIRC (0x80000) subscribers see it.
- A rehash's "G-line active" is sent on OPERKILL, not GLINE (`s_conf.c:1456`: the `found_g > -1` test is never true).

**Config.** `snomask = …;` in Class and Operator blocks; at OPER the two are ORed and added to the current mask.

## 5. Server notices

**Envelope.** `:<server> NOTICE * :*** Notice -- <text>` (`send.c:3431`, live).

- The target is `*`.
- There are **no tags**: no time, msgid or label.
- Pre-registration notices also use `NOTICE * :*** …` but lack `Notice -- `, so anchor on `^\*\*\* Notice -- `.

**Global notices**, marked (G) below, are relayed network-wide as `SNO`. A remote copy carries the **originating server** as its prefix.

**Reaching the client.**

- Every connection of a bouncer session gets them (the snomask is mirrored), but **nothing is stored or replayed**.
- `SMO` (sent by services) reaches every +o/+O user whatever their snomask, in the same shape.

**Conventions.**

- `nick[ident@ip]` is a local client (ident empty without identd).
- `<ABAAB>` is a P10 numnick.
- Expiries are absolute Unix seconds.
- Under HIS_SNOTICES (default on), the "who" in line notices is the oper's nick.

| Bit                                      | Pattern                                                                                                                                                                                                                                                                                                                                        | Source                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| CONNEXIT                                 | `Client connecting: <nick> (<user>@<realhost>) [<ip>] {<class>} [<realname>] <<numnick>>` (G). The realname may contain brackets; anchor on the trailing ` <XXXXX>$`.                                                                                                                                                                          | s_user.c:826                                  |
| CONNEXIT                                 | `Client exiting: <nick> (<user>@<realhost>) [<quit reason>] [<ip>] <<numnick>>` (G)                                                                                                                                                                                                                                                            | s_misc.c:852                                  |
| NICKCHG                                  | `Nick change: From <old> to <new> [<user>@<realhost>] <<numnick>>` (G)                                                                                                                                                                                                                                                                         | s_user.c:1425                                 |
| OPERKILL/SERVKILL                        | `Received KILL message for <victim> from <killer> Path: <inpath>!<path> (<reason>)` (live)                                                                                                                                                                                                                                                     | m_kill.c:122                                  |
| OPERKILL/GLINE                           | `G-line active for <nick[user@ip]>`, `K-line active for …`, `Z-line active for …`, `Shun active for …` (G)                                                                                                                                                                                                                                     | gline.c:259, zline.c:190, shun.c:323          |
| OLDSNO                                   | `<nick> (<user>@<realhost>) is now a <global\|local> operator (<O\|o>)` (G, live). `O` = global, `o` = local, the reverse of the umode letters.                                                                                                                                                                                                | m_oper.c:347                                  |
| OLDSNO                                   | `Link with <srv> established.` · `Link with <srv> canceled: <why>` · `<Local\|Remote> SQUIT by <oper> [<srv>]:` · `Received SQUIT <srv> from <who> :` · `ERROR :from <srv> -- <text>` · `No response from <srv>, closing link` · `Connection to <srv> activated.` · `Max SendQ limit exceeded for <x>: <n> > <m>`                              | s_serv.c, s_misc.c, m_error.c, ircd.c, send.c |
| OLDSNO                                   | `<nick> is rehashing Server config file` · `<nick> [<srv>] is remotely rehashing Server config file` · `Restarting server: <why>` · `SETTIME from <x>, clock is set <n> seconds <dir>` · `Nick collision on …` · `GitSync…` · `WEBPUSH: …` · `Bouncer …`                                                                                       | various                                       |
| HACK2/3/4                                | `^(?:BOUNCE or )?HACK\((\d)\): (\S+) MODE (\S+) (.*) \[(\d+)\]$`. The bracket is the channel TS. OPMODE and CLEARMODE produce HACK(4) (live: `HACK(4): opr MODE #seance +m [1791564392]`).                                                                                                                                                     | channel.c:2753-2779                           |
| HACK2/4                                  | `HACK: <x> KICK <chan> <victim> <reason>` (same text for both) · `OPER JOIN: <x> JOIN <chan> (overriding +<c>)` · `Deop of +k user on <chan> by <x>`                                                                                                                                                                                           | m_kick.c, m_join.c, channel.c                 |
| GLINE (AUTO if the reason starts "AUTO") | `<who> adding [deactivated ]<local\|global> <GLINE\|BADCHAN\|SHUN\|ZLINE> for <mask>, expiring at <ts>: <reason>`                                                                                                                                                                                                                              | gline.c:577, shun.c:618, zline.c:406          |
| GLINE                                    | `<who> activating global <TYPE> for <mask>, expiring at <ts>: <reason>` · `<who> <removing local\|removing global\|deactivating global> <TYPE> for <mask>, expiring at <ts>: <reason>` · `<who> modifying global <TYPE> for <mask>:<changes>` · `<who> removing local <TYPE> for <mask>` · `<who> force removing <TYPE> for <mask> (<reason>)` | gline.c, shun.c, zline.c                      |
| GLINE                                    | `Temporary shun <applied to\|removed from> <nick> (<reason>)` (G) · `DNSBL blocked [anonymous ]connection from <nick> (<ident>@<host>) [<ip>]`                                                                                                                                                                                                 | m_tempshun.c, s_auth.c:680                    |
| NETWORK                                  | `Net junction: <uplink> <server>` · `Net break: <uplink> <server> (<reason>)` · `Completed net.burst from <srv>.` · `<srv> acknowledged end of net.burst.` · `Timestamp drift from <srv> (<n>s); issuing SETTIME to correct this`                                                                                                              | s_serv.c, s_misc.c, m_endburst.c, m_create.c  |
| NETWORK                                  | `<who> adding [local ]JUPE for <srv>, expiring at <ts>: <reason>` (live) · `… activating JUPE …` · `… <removing local\|deactivating> JUPE …`                                                                                                                                                                                                   | jupe.c:156-271                                |
| OLDREALOP                                | `Failed [remote ]OPER attempt by <nick> (<user>@<host>) (<no operator block\|no remote oper priv\|SSL fingerprint mismatch\|password mis-match\|password mismatch\|attach failed after async>)` (G)                                                                                                                                            | m_oper.c                                      |
| UNAUTH                                   | `Unauthorized connection from <x>.` · `Connection from <x> rejected: class <c> requires SASL but services unavailable.`                                                                                                                                                                                                                        | s_auth.c                                      |
| TOOMANY                                  | `Too many connections in class <c> for <x>.` · `Too many connections from same IP for <x>.`                                                                                                                                                                                                                                                    | s_auth.c                                      |
| IPMISMATCH                               | `IP# Mismatch: <a> != <b>[<c>]`                                                                                                                                                                                                                                                                                                                | s_auth.c:1349                                 |
| TCPCOMMON                                | `Unable to accept connection: <err>` · `SSL Error for client <x>: <err>` · `SSL Error for connection attempt: <err>`                                                                                                                                                                                                                           | listener.c, ssl.c                             |
| WEBIRC                                   | `WEBIRC Client host: from <a> [<ip>] to <b> [<ip>]` · `WEBIRC Attempt with invalid <password\|parameters\|IP address\|host name> from <x> [<ip>]` · `WEBIRC Attempt unauthorized from <x> [<ip>]` (G) · `Config parse error in file <f> on line <n>: <msg>`                                                                                    | m_webirc.c, s_conf.c:1292                     |
| AUTH                                     | IAuth free text, `IAuth circuit breaker OPEN\|CLOSED: …`, `iauth version <v> running.`, …                                                                                                                                                                                                                                                      | s_auth.c                                      |
| (log)                                    | `^(SYSTEM\|CONFIG\|OPERMODE\|GLINE\|JUPE\|WHO\|NETWORK\|OPERKILL\|SERVKILL\|USER\|OPER\|RESOLVER\|SOCKET\|IAUTH\|DEBUG) \[(CRIT\|ERROR\|WARNING\|NOTICE\|TRACE\|INFO\|DEBUG)\]: (.*)$`                                                                                                                                                         | ircd_log.c:398-476                            |

**Log-derived lines.** These go out on the subsystem's default bit: CONFIG→OLDSNO, OPERMODE→HACK4, GLINE→GLINE, JUPE/NETWORK/IAUTH→NETWORK, OPER→OLDREALOP. CRIT always goes to OLDSNO.

**Related, but not a snotice.** `:server NOTICE <nick> :*** Notice -- <x> (<user>@<host>) did a /whois on you.` is addressed to the nick and sent to +W opers.

## 6. WALLOPS and friends

| Kind                              | Wire                                                                        | Received by                                  | Sent by                                    |
| --------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| WALLOPS                           | `:<nick!u@h> WALLOPS :* <text>`                                             | +w opers (HIS_WALLOPS); the sender too if +w | any oper                                   |
| WALLUSERS                         | `:<nick!u@h> WALLOPS :$ <text>`: the **same command** with a `$ ` prefix    | every +w user                                | any oper                                   |
| DESYNCH                           | `:<server> WALLOPS :<text>`, no prefix (mostly `Protocol Violation from …`) | +g users                                     | servers                                    |
| server WALLOPS                    | `:<server> WALLOPS :* Remote CONNECT <srv> <port> from <oper>`              | +w                                           | servers                                    |
| WALLCHOPS / WALLHOPS / WALLVOICES | `NOTICE @#chan :@ text` / `%#chan :% text` / `+#chan :+ text`               | members with that status                     | **any member who can speak**, not just ops |

None of these carries tags.

## 7. CHECK (`ircd/m_check.c`)

**Syntax.** `CHECK [<server|nick>] <#chan|nick|server|hostmask> [-flags]`.

- **Gating.** PRIV_CHECK, else `517 CHECK :Command disabled.`
- **Remote form.** Taken when there are 4+ params, or 3 with the second not starting with `-`. `CHECK nick nick` runs it on the target's own server, which is what shows the local-only fields. A remote CHECK comes back unlabeled.
- **Resolution order.** Channel, then user, then exact server name, then hostmask search.
- **Hostmask normalisation.** A bare word becomes `*!*@word`, `user@host` becomes `*!user@host`. An IP-ish host (v4/v6, `/bits`, `1.2.*`) is matched as CIDR against the real IP.

**Flags** (letters combined in one `-` argument):

| Flag | Effect                            |
| ---- | --------------------------------- |
| `c`  | channels per hostmask hit         |
| `i`  | IPs instead of hosts              |
| `o`  | channel: ops only, no ban section |
| `u`  | channel: totals only              |
| `b`  | bouncer machine-readable lines    |

**Numerics.**

| Numeric | Name              | Format                                                                                | Use                                              |
| ------- | ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 286     | RPL_CHKHEAD       | `:Information for <user\|channel\|server\|host> <x>`                                  | header                                           |
| 290     | RPL_DATASTR       | `:<text>`                                                                             | every body line, blank separators (` `) included |
| 287     | RPL_CHANUSER      | `: <oplvl:3> <clones:2> <zombie><status><nick> (<user>@<host>) (<gecos>^O) <account>` | channel member row                               |
| 291     | RPL_ENDOFCHECK    | `: `                                                                                  | end                                              |
| 292     | ERR_SEARCHNOMATCH | `:CHECK <target> No matching record(s) found`                                         | no match                                         |

**Framing.** `290 " "`, `286`, `290 " "`, body, `291 " "` (live).

**Body lines.**

- Lines are `<right-aligned label>:: <value>`. The widths vary (15 for user and server cards, 16 for channels, others in the bouncer block), so **parse with** `^\s*(.+?)::(?: (.*))?$`, not by column.
- Real Name ends in `\x0f`.
- Times are `ctime()` in the **server's** timezone (`Fri Oct 9 16:45:37 2026`).
- `Data sent: 0.261 Kb`: the part after the dot is a byte remainder 0–1023, **not a decimal fraction**.

**User card** (live; extra fields from the code):

```
           Nick:: victim (ABAAE)
      Signed on:: Fri Oct  9 16:46:35 2026
      Timestamp:: Fri Oct  9 16:46:35 2026 (1791564395)
  User/Hostmask:: victim@172.17.0.1              (only when +x)
 Real User/Host:: victim@172.17.0.1 (172.17.0.1)
      Real Name:: Real Name of victim
         Status:: Client | IRC Operator | IRC Administrator | Local IRC Operator | Network Service
         Opered:: Local O:Line as seanceop       (opers)
          Class:: Users
     Privileges:: … (wrapped ~70 chars, repeated label)
   Capabilities:: … (wrapped, repeated label)
   Connected to:: irc.seance.test
     Session ID:: AaEhjzU9cAGlgnpaKNwfig
       Umode(s):: +x [account[:ts]] [sethost] [fakehost] [cloakhost] [cloakip]
     Channel(s):: @#seance +#help *#ops          (prefixes - < @ + * !)
       Idle for:: 0 days, 00:00:04
   Away message:: gone fishing
          Ports:: 47604 -> 6667 (client -> server)
      Data sent:: 0.176 Kb (7 protocol messages)
  Data received:: 3.305 Kb (28 protocol messages)
  receiveQ size:: 0 bytes (max. 1024 bytes)
     sendQ size:: 0 bytes (max. 160000 bytes)
```

- **Optional lines:** Connect host/ip (WEBIRC), Country/Continent (GeoIP), Bouncer Alias, Marks, CTCP Version, SWHOIS, WebIRC, Kill, SSL Fingerprint, SSL Ciphers, Exemptions.
- **Bouncer block:** Session state/ID/name, Managing server, Connections, Primary, Alias rows, Hold override, Session totals, a Primary sub-block, `[i]` alias rows, Connection History rows. Bug: the two times on a history row are always identical, because one static ctime buffer is used twice.
- **Local-only fields:** Signed on, Opered, Class, Capabilities, Idle, Ports, Data and queues appear only when the answering server holds the user.

**Channel card** (live):

- Creation time, `Topic` (`<none>`) plus `Set by`, `Channel mode(s)` (real key shown to global opers).
- `Users (@ = op, + = voice, < = delayed, ~ = alias)`, then the 287 rows. Parse rows with `^ (.{3}) (.{2}) (.)(.)(\S+) \((\S+?)@(\S+)\) \((.*)\x0f\) (\S*)$`.
- `Total users:: N (O ops, V voiced, C clones, A authed, D delayed, L aliases)`.
- `Bans on channel::` then `[n] - <mask> - Set by <who>, on <ctime>` rows, or `<none>`.

**Server card:** Connected at, Server name, NOOP, SSL, Numeric, Users, Status, Class, `Downlinks::` rows `[n] - <flag><name>`.

**Hostmask search:**

- Header `No. Nick User Host`, then rows `%-4d %-32s%-12s%s`. With `-c`, each row is followed by ` on channels: …` and a blank line.
- Ends with `Matching records found:: N`.
- Past MAX_CHECK_OUTPUT (1000): `More than 1001 results, truncating...`, then a 291, then **a second footer and 291**. Stop at the first 291.

## 8. WHOIS, WHOWAS, WHO, USERHOST/USERIP

**WHOIS as seen by an oper.** 307, 344, 378, 379 and 569 do not exist on this branch; 275/276 are STATS lines and 310 means "network service".

| Numeric                     | Format                                                              | When                                                                                                       |
| --------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 311                         | `<nick> <user> <visiblehost> * :<realname>`                         | always                                                                                                     |
| 319                         | `<nick> :<chans>`                                                   | opers see +p users' channels; `*` marks ones not normally visible                                          |
| 312                         | `<nick> <server> :<info>`                                           | opers always see the real server                                                                           |
| 313                         | `<nick> :is an IRC Operator` / `:is an IRC Administrator`           | SeeOper                                                                                                    |
| 330                         | `<nick> <account> :is logged in as`                                 |                                                                                                            |
| 338                         | `<nick> <user>@<realhost> <ip> :Actual user@host, Actual IP` (live) | **opers or self, and only if the target is +x**. Otherwise use USERIP, WHO `%i` or CHECK.                  |
| 339                         | `<nick> :is marked: <a, b>`                                         | marks; not oper-gated                                                                                      |
| 343                         | `<nick> :is Kill listed on <x>`                                     | kill-mark                                                                                                  |
| 616                         | `<nick> :has client certificate fingerprint <fp>`                   | TLS and a fingerprint                                                                                      |
| 672                         | `<nick> :is connected via WebSocket (origin: <o>)`                  | **opers only**                                                                                             |
| 325                         | `<nick> :is connected via <webirc desc>`                            |                                                                                                            |
| 320                         | `<nick> :<text>`                                                    | three meanings: +R line, SWHOIS, and (opers/self) `has a bouncer session[ with N connections\| (holding)]` |
| 317                         | `<nick> <idle> <signon> :seconds idle, signon time`                 | opers always, when the target is local to the answering server (use `WHOIS nick nick`)                     |
| 316 / 335 / 671 / 760 / 301 | deaf to PMs / bot / TLS / metadata / away                           |                                                                                                            |

**WHOWAS** (`WHOWAS <nick>[,…] [count] [server]`; the server form is oper-only):

- Rows: 314, then 338 (opers; only if the user was +x), then 312 (logoff time as info), then 301.
- Ends with 406 per miss, then 369.

**WHO** (`WHO <mask> [<flags>[%<fields>[,<token>]]]`):

- **Flags.**
  - `x`: oper with PRIV_WHOX; shows invisible users and secret channels; logged.
  - `o`: opers only.
  - `d`: delayed-join members.
  - Match fields: `n u h i s r a m`. `h` and `i` match the real host and IP of +x users for opers.
- **Field order.** WHOX fields always come back in the fixed order `t c u i h s n f d l a o m r`. `i` is the real IP for opers; `h` is always the visible host.
- **Flags column.** `H`/`G`, `*` (oper), prefixes, `d`; for opers also `i w g` (umodes); then `x z B`.
  - Live: `354 opr 77 #seance opr 172.17.0.1 172.17.0.1 irc.seance.test opr H*@wgx 0 13 0 999 :Real Name of opr`.
- **Oper query.** `%tcuihsnfdlaomr,<tok>`. Seance's current `%tcuhsnfdar` lacks `i l m`, and because the order is fixed, adding them moves columns.
- **Limits.** Results are capped at `2048/(nfields+4)` rows unless the oper has UNLIMIT_QUERY (416 past the cap). Bouncer aliases are skipped.

**USERHOST 302 / USERIP 340.**

- Items are `nick[*]=<+|->user@<host|ip>` (`*` = oper, `-` = away). At most 5 nicks per call; unknown nicks are dropped silently.
- Untagged, followed by an ACK.
- Opers get the real host (USERHOST, despite the source comment saying otherwise) and the real IP (USERIP).

## 9. STATS

**Syntax.** `STATS <letter|longname> [<server> [<filter>]]`.

- A filter needs the server argument: `STATS k irc.seance.test *@1.2.3.4`.
- With no selector, or an unknown one, you get the help list: one NOTICE per entry, `<c> (<longname>) - <description>` (a space for long-name-only entries), sorted by long name, untagged (#119). Then `219 * :End of /STATS report`.
- **Every** reply ends `219 <selector as typed> :End of /STATS report`.

**Gating.**

- Non-opers can use only `u`, `w` and the help list by default.
- Any server argument from a non-oper → 481 (HIS_REMOTE).
- The seven nefarious long-name entries (`A`/chathistoryads, chathistory, metadata, webpush, authtoken, dnsbl, gitsync) crashed the server when a non-oper asked, before `ead82a8`. They are oper-only from that commit on. The rig image predates it, so don't send them unopered there.

| Sel                                                                                               | Shows                                                | Numeric: row format                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `g`/`G` glines                                                                                    | G-lines (no scope, no BADCHANs; use `GLINE` instead) | 247 `G <user>[@host] <expire> <lastmod> <lifetime> <state><+\|-> :<reason>`                                                                                                       |
| `S` shuns                                                                                         | shuns                                                | 542, same layout with `S`                                                                                                                                                         |
| `Z` zlines                                                                                        | Z-lines                                              | 546 `Z <ipmask> <expire> <lastmod> <lifetime> <state><+\|-> :<reason>`                                                                                                            |
| `J` jupes                                                                                         | nick jupes                                           | 222 `J <nick>`                                                                                                                                                                    |
| `k`/`K` klines                                                                                    | Kill blocks                                          | 216 `<K\|k> <user>@<host> "<reason>" "<realmask>" "<versionmask>" <cc> <continent> 0 0`. The filtered path is broken (5 args for 8).                                              |
| `o`/`O` operators                                                                                 | Operator blocks                                      | 243 `<O\|o> <user>@<host> * <opername> <class>` (live: `O *@* * seanceop Opers`)                                                                                                  |
| `p`/`P` ports                                                                                     | listeners                                            | 217 `P <port> <conns> <flags> <active\|disabled> <bindip>`. Flags: S/C server/client, H hidden, E TLS, 4, 6, W websocket, A autodetect, P paste. Live: `P 8443 0 CE46W active *`. |
| `y`/`Y` classes                                                                                   | connection classes                                   | 218 `Y <class> <pingfreq> <connfreq> <maxlinks> <sendq> <recvq> <links>` (live)                                                                                                   |
| `l` links                                                                                         | per-connection traffic                               | 211 header `Connection SendQ SendM SendKBytes RcveM RcveKBytes :Open since`, then `<name> <sendq> <sm> <skb> <rm> <rkb> :<secs>`                                                  |
| `u` uptime                                                                                        | uptime, max connections                              | 242 `:Server Up D days, H:MM:SS`, 250 `:Highest connection count: N (M clients)` (live)                                                                                           |
| `m` commands                                                                                      | command counts                                       | 212 `<CMD> <count> <bytes>`                                                                                                                                                       |
| `c` connect                                                                                       | Connect blocks                                       | 213 `C <name> * <host> <port> <max> <hublimit> <class>`                                                                                                                           |
| `i`/`I` access                                                                                    | Client blocks                                        | 215 `I [user@]host <max> [0]<ipmask\|*> <port> <class>`                                                                                                                           |
| `E` excepts                                                                                       | Except blocks                                        | 223 `E <user>@<host> * <flags>`                                                                                                                                                   |
| `f` / `F` features                                                                                | changed / all features                               | 238 `<F\|f> <NAME> <value>` (`F` set in config, `f` default) and `F LOG …`                                                                                                        |
| `q`/`Q` quarantines                                                                               | quarantined channels                                 | 228 `Q <chan> :<reason>`                                                                                                                                                          |
| `s` spoofhosts                                                                                    | SpoofHost blocks                                     | 245 `<idx> <auto\|oper\|user> <spoofhost> <user>@<host>`                                                                                                                          |
| `W` webirc                                                                                        | WebIRC blocks                                        | 220 `W <user>@<host> * <ident\|(none)> <flags> :<desc>`                                                                                                                           |
| `U` uworld                                                                                        | service servers                                      | 248 `U <server>`                                                                                                                                                                  |
| `v` / `V` vservers                                                                                | server list, human / machine                         | 236. Parse `V`: `<name> <uplink> <flags6> <hops> <num> <numint> <lag> <rtt> <up> <down> <clients> <maxmask> P<proto> <linkts> :<info>`                                            |
| `T` motds                                                                                         | per-host MOTDs                                       | 246 `T <hostmask> <path>`                                                                                                                                                         |
| `R` mappings                                                                                      | service pseudo-commands                              | 276 (padded header row + rows)                                                                                                                                                    |
| `d` / `D` crules                                                                                  | routing rules                                        | 275 `<D\|d> <mask> <rule>`                                                                                                                                                        |
| `L` modules                                                                                       | crypt mechanisms                                     | 241 (header + rows)                                                                                                                                                               |
| `e` engine                                                                                        | event engine                                         | 237 `<engine> :Event loop engine`                                                                                                                                                 |
| `a` nameservers                                                                                   | resolvers                                            | 226 `<ip>`                                                                                                                                                                        |
| `w` userload                                                                                      | load averages                                        | **NOTICEs** (untagged): a header, then three rows (local clients, total clients, total connections) (live)                                                                        |
| `j`, `r`, `t`, `x`, `z`, iauth, iauthconf                                                         | free text                                            | 249 `:<text>`                                                                                                                                                                     |
| `A` chathistoryads, chathistory `H`, metadata `M`, webpush `W`, authtoken `A`, dnsbl `D`, gitsync | nefarious subsystems                                 | 249 `<tag> :<text>`. The first line is a title; the rest are ` Key: value` lines, so they read as a definition list.                                                              |
| webhook                                                                                           | Keycloak webhook listener (new at `8453087`)         | 249                                                                                                                                                                               |

## 10. TRACE, MAP, LINKS and other info

**TRACE** (opers only under HIS_TRACE; batch):

| Numeric | Format                                                                             |
| ------- | ---------------------------------------------------------------------------------- |
| 200     | `Link <ver>.<dbg> <target> <next>`                                                 |
| 201     | `Try. <class> <name>`                                                              |
| 202     | `H.S. <class> <name>`                                                              |
| 203     | `???? <class> <name>`                                                              |
| 204     | `Oper <class> <nick>[<ident>@<ip>] <idle>` (live: `Oper Opers opr[@172.17.0.1] 0`) |
| 205     | `User <class> <nick>[<ident>@<ip>] <idle>`                                         |
| 206     | `Serv <class> <n>S <n>C <name> <by>!<user>@<host> <secs> <age>`                    |
| 209     | `Class <class> <links>` (live)                                                     |
| 262     | `:End of TRACE`                                                                    |

**MAP** (non-opers under HIS_MAP get the NOTICE `/MAP has been disabled. Visit <url>` only):

- 015 `:<prompt><flag><server> <lag> [<n> clients]` (live: `irc.seance.test [1 clients]`; the local server's lag is empty, hence two spaces).
- The prompt is two characters per level: `|-` or `` `- `` for the entry, `| ` or two spaces for ancestors.
- The flag is `*` (bursting) or `!` (awaiting EOB ack).
- 016 `--> *more*` past depth 30; 017 `:End of /MAP`.

**LINKS:**

- 364 `<server> <uplink> :<hops> P<proto> <info>` (live: `irc.seance.test irc.seance.test :0 P10 Seance dev`), then 365.
- Under HIS_LINKS a non-oper gets 365 plus a NOTICE.

**Other commands:**

| Command      | Reply                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| LUSERS       | 251, 252, 254, 255, 265, 266 (all live) plus the `Highest connection count` NOTICE. 252/253/254 appear only if non-zero.                          |
| IRCOPS       | 386 `:<net> IRC Operators:`, 387 `:[A\|O] <nick>[ (AWAY)] [<server>] - Idle: <n>` (live), 388 `:Total: N IRCop[s] connected`                      |
| ADMIN        | 256, 257, 258, 259 (live)                                                                                                                         |
| INFO         | 371 lines, 374 end                                                                                                                                |
| TIME         | 391 `<server> <unixts> <offset> :<date>`                                                                                                          |
| VERSION      | 351 plus untagged library NOTICEs (opers) plus the 005 block                                                                                      |
| OPERMOTD     | 535/536/537, 568 missing; `517 OPERMOTD :Command disabled.` by default                                                                            |
| GET          | 284 `:Boolean value of X: TRUE` / `:Integer value of X: N` / `:String value of X: …` / `:String value for X not set`. 493 for an unknown feature. |
| RPING        | the reply is a command: `:<start> RPONG <me> <server> <ms> :<text>`                                                                               |
| UPING / ASLL | untagged NOTICEs (`UPING Stats: sent N recvd N ; min/avg/max = a/b/c ms`, `AsLL for <srv> -- RTT: …`)                                             |
| HELP         | 704/705/706 in a batch. **Empty for most oper commands** (live: `705 opr GLINE :GLINE `), so the client must ship its own help.                   |

## 11. Bans

### Common to GLINE, SHUN, ZLINE and JUPE

- **Success is silent.** The snotice (GLINE bit 0x200; NETWORK 0x400 for JUPE) or a re-list is the only confirmation.
- **No setter or creation time is stored**, so the setter is known only from a captured snotice.
- **Durations.**
  - Plain digits are relative seconds.
  - Anything else goes through `ParseInterval`: `y`, `M` (31 days), `w`, `d`, `h`, `m` (minutes), `s`, compounds allowed (`1d2h30m`). Unknown characters count ×0 and never error.
  - **The maximum is 7 days (604800 s)**. Beyond it: `515 <abs ts> :Bad expire time`.
  - Remote JUPE durations are `atoi`'d, so send plain seconds.
- **The reason must be a trailing parameter.** The parser takes expire = `parv[parc-2]` and reason = `parv[parc-1]`.
- **Removing a local entry still needs dummy expire and reason:** `GLINE -mask 1 :x`.
  - Live: a bare `GLINE -*@10.9.8.7` → `461 GLINE :Not enough parameters`.
- **Listing** (no batch; each line is labeled; live for the empty case):

| Command | Rows                                                                                                                                                                                                                                                                        | End                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `GLINE` | 280 RPL_GLIST `<user>[@host] <expire> <lastmod> <lifetime> <scope> <state><+\|-> :<reason>`. Scope = a server name for a local entry, `*` for a global one. State token: `+ - >+ >- <+ <-`; effective = (`+` and not `<`) or `>`. User G-lines newest first, then BADCHANs. | 281 `:End of G-line List` |
| `SHUN`  | 280 (same layout)                                                                                                                                                                                                                                                           | 545 `:End of Shun List`   |
| `ZLINE` | 548 `<ipmask> <expire> <lastmod> <lifetime> <scope> <state><+\|-> :<reason>`                                                                                                                                                                                                | 549 `:End of Z-line List` |
| `JUPE`  | 282 `<server> <expire> <scope> <+\|-> :<reason>`                                                                                                                                                                                                                            | 283 `:End of Jupe List`   |

- **Single-mask queries.** `GLINE <mask>` returns the first stored entry whose pattern matches the string sent; CIDR containment is not evaluated. A miss returns the error alone (521 / 543 / 547 / 514), with no end numeric.

### GLINE forms (oper)

**General form.** `GLINE [[!][+|-|>|<]<mask> [<target>] [<expire> [:<reason>]]]`.

- `!` (force) works only with PRIV_WIDE_GLINE; otherwise it is stripped silently.
- Non-opers may _query_ (`GLINE <mask>`).

| Form                                          | Meaning                                                          | Privilege          |
| --------------------------------------------- | ---------------------------------------------------------------- | ------------------ |
| `GLINE +mask * <exp> :<reason>`               | add global (or activate and update an existing one)              | GLINE              |
| `GLINE -mask * <exp> :<reason>`               | deactivate globally (creates a deactivated entry if none exists) | GLINE              |
| `GLINE mask * <exp> [:<reason>]`              | modify expiry/reason                                             | GLINE              |
| `GLINE +mask * ` / `GLINE -mask *`            | activate / deactivate an existing entry                          | GLINE              |
| `GLINE +mask <exp> :<reason>`                 | add local (this server)                                          | LOCAL_GLINE        |
| `GLINE ±mask <server> <exp> :<reason>`        | local on `<server>`                                              | GLINE when remote  |
| `GLINE >mask [<server>]` / `<mask [<server>]` | locally activate / deactivate a global entry                     | LOCAL_GLINE (here) |

**Opers have no global delete.** A deactivated entry lives until its lifetime ends; `REMOVE gline <mask> :<reason>` frees it (PRIV_REMOVE, no reply at all).

**Masks.**

- `user@host`, or a bare host meaning `*@host`. The host can be a name, an IP or a CIDR.
- `$R<realname>` and `$V<ctcp version>`.
- `#chan` / `&chan` for BADCHAN. A wildcard BADCHAN never blocks a JOIN; only the literal name does.
- **No `$A` (account) and no `nick!` part.**

**Width rules** (`gline_checkmask`). Any wildcard in the host, or CIDR below /32 (/128), needs `!` plus WIDE_GLINE, else `520 <mask> :Mask is too wide`. Always rejected:

- a hostname with fewer than 2 dots;
- a wildcard in the last two labels;
- an IP mask with fewer than 16 fixed bits.

A mask matching ≥ GLINEMAXUSERCOUNT (20) users → `519 <n> :Too many users affected by mask` unless forced.

**Errors.**

| Numeric | Format                                           |
| ------- | ------------------------------------------------ |
| 461     | `GLINE :Not enough parameters`                   |
| 481     | `:Permission Denied: Insufficient privileges`    |
| 402     | `<target> :No such server`                       |
| 515     | `:Bad expire time`                               |
| 517     | `GLINE :Command disabled.` (CONFIG_OPERCMDS off) |
| 518     | `:Mask is too long`                              |
| 519     | `<n> :Too many users affected by mask`           |
| 520     | `<mask> :Mask is too wide`                       |
| 521     | `<mask> :No such gline`                          |

**What the victim sees.** `465 <nick> :<reason>`, then quit `G-lined (<reason>)`.

### SHUN, ZLINE, JUPE, TEMPSHUN

- **SHUN.**
  - Same forms as GLINE, but no BADCHAN.
  - Privileges SHUN / LOCAL_SHUN / WIDE_SHUN; not found → `543 :No such shun`.
  - The victim is not disconnected: every command is dropped silently except NICK, QUIT, PART, PING, PONG, ADMIN and CAP. They are told nothing by default (HIS_SHUN_REASON is on).
- **ZLINE.**
  - IP masks only (`550 :zline masks must contain an IP address.`); privileges ZLINE / LOCAL_ZLINE / WIDE_ZLINE; not found → 547.
  - **Every** set, remove or modify first sends `NOTICE :Use of Z-line is deprecated. Please use G-line instead.` (live, before the privilege check).
- **JUPE** (servers).
  - `JUPE ±<server> * <exp> :<reason>` = global (PRIV_JUPE).
  - `JUPE ±<server> <exp> :<reason>` = local. That form **checks no privilege** at all, only CONFIG_OPERCMDS.
  - An existing jupe ignores expiry and reason; only `+`/`-` changes it.
  - Not found → `514 :No such jupe`.
  - There is no STATS letter for server jupes (`STATS J` is nick jupes).
- **TEMPSHUN.**
  - `TEMPSHUN [+|-]<nick> [:<reason>]`: a per-connection flag, no duration, **no list command**.
  - PRIV_TEMPSHUN is checked before the parameter count.
  - Snotice `Temporary shun applied to <nick> (<reason>)`.

## 12. Acting on users and channels

- **KILL.**
  - `KILL <nick> :<reason>`: the **reason is mandatory** (461 otherwise; the HELP text is wrong).
  - Errors: 401; 481 (PRIV_KILL for a remote victim, PRIV_LOCAL_KILL for a local one); `483 :You cant kill a server!`; `484 <nick> KILL :Cannot kill, kick or deop <a network service|an IRC operator>`.
  - A nick changed in the last 15 s is followed: `NOTICE :Changed KILL <old> into <new>`.
  - Silent success; the snotice is the confirmation (live).
  - The victim sees `:<oper> KILL <victim> :<oper> (<reason>)`.
- **OPMODE.**
  - `OPMODE [!]<chan> <modes> [args]`. The oper need not be on the channel. The channel sees `:*.Nefarious MODE …` (live).
  - Errors: 517, 461, 481, 403, `524 <chan> :Channel is quarantined : <reason>` (needs `!` plus FORCE_OPMODE), 561 for +A/+U without APASS_OPMODE.
  - HACK(4) snotice.
- **CLEARMODE.**
  - `CLEARMODE [!]<chan> [<chars>]`; the default chars are `ovpsmikblL`.
  - Bug: `Q` clears +N. It cannot clear z H P R A U.
- **JOIN `&chan OVERRIDE`.** With PRIV_WALK_LCHAN; produces a HACK(4).
- **SETHOST.**
  - Oper form `SETHOST <ident> <host> [<password>]` or `SETHOST undo`. It acts on **one's own** host only; FREEFORM allows any host.
  - Errors 530 / 531 / 464; success `396 <host> :is now your hidden host`.
- **Mass messages.** `PRIVMSG|NOTICE $<servermask> :…` or `$@<hostmask> :…`.
  - Errors: `413 :No toplevel domain specified` (no dot), `414 :Wildcard in toplevel Domain`.
  - There is no `$#` form.

## 13. Server administration

| Command              | Syntax / replies                                                                                                                                                                                                                   | Privilege                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| REHASH               | `REHASH [m\|l\|a\|s\|q] [<server>]` (MOTD cache, logs, IAuth, TLS certs, rehash without restarting the resolver) → `382 <conf> :Rehashing` or `:Flushing MOTD cache` etc. A remote target with NETWORK_REHASH=0 drops it silently. | REHASH (+ REMOTEREHASH)                       |
| RESTART / DIE        | `RESTART [<pass>]` / `DIE [<pass>]`, local only; DIE notices every user                                                                                                                                                            | RESTART / DIE                                 |
| SET / RESET / GET    | `GET <FEATURE>`, `SET <FEATURE> [<value>]`, `RESET <FEATURE>`; names are uppercase and case-sensitive → 284. Errors 493 / 494 / 495-497.                                                                                           | SET (in no default set); GET any oper         |
| CONNECT              | `CONNECT <mask> [<port>] [<remote>]` → untagged NOTICEs (`*** Connecting to <srv>.`, `Connect: Host <x> not listed in ircd.conf`, …)                                                                                               | any oper; the remote form needs a global oper |
| SQUIT                | `SQUIT <mask> [:<comment>]`; 402 / 461                                                                                                                                                                                             | any oper (local opers: direct links only)     |
| SETTIME              | `SETTIME <ts> [<mask>]`; with RELIABLE_CLOCK (the default) changes nothing and says so                                                                                                                                             | global oper                                   |
| UPING / RPING / ASLL | see section 10                                                                                                                                                                                                                     | any oper                                      |
| GITSYNC              | `GITSYNC [<srv>\|*] force\|status\|pubkey [pem]\|hostkey [reset]` → untagged NOTICEs                                                                                                                                               | GITSYNC                                       |
| STORE                | `STORE <DEFRAG\|SYNC\|GC\|INFO> [history\|metadata\|all]` → 249 `X :…`                                                                                                                                                             | REHASH                                        |
| CLOSE                | closes all unregistered connections → 362 per connection (names the oper, a bug), 363                                                                                                                                              | any oper                                      |
| XQUERY               | `XQUERY <srvmask> <routing> :<msg>` → `:<srv> XREPLY <me> <routing> :<reply>`; non-opers are ignored silently                                                                                                                      | any oper                                      |
| BOUNCER ORESET       | `BOUNCER ORESET <account> [<sessid>]` → `NOTE BOUNCER SESSION_RESET` plus an OLDSNO snotice. `BOUNCER LISTSESSIONS *` → 780 rows / 782.                                                                                            | any oper                                      |
| MKPASSWD             | `MKPASSWD <pass> [DES\|MD5\|SMD5\|PLAIN]` → NOTICE that **echoes the plaintext**; open to everyone; no bcrypt                                                                                                                      | —                                             |

**Server or services only** (opers get no reply): SVSNICK, SVSJOIN, SVSPART, SVSMODE, SVSQUIT, SVSNOOP, SVSIDENT, SVSINFO, SWHOIS, FAKE, SNO, SMO, MARK, ACCOUNT, DESTRUCT, DESYNCH, XREPLY. There are no SA\* commands.

**`draft/oper-tag`** (default on). Messages from displayed opers (DISPLAY and not +H) carry `draft/oper`, or `draft/oper=<opername>` with OPERTAG_VALUE. It marks messages only, not snotices.

## 14. Server-side bugs

- **Filed:**
  - [#119](https://github.com/evilnet/nefarious2/issues/119): NOTICEs inside a labeled batch carry no `@batch`.
  - [#120](https://github.com/evilnet/nefarious2/issues/120): USERHOST, USERIP, ISON and PRIVS go out untagged and are followed by an ACK.
  - [#121](https://github.com/evilnet/nefarious2/issues/121): a held bouncer session that is revived or attached never has its user modes sent, so a client cannot know it is +o until it asks (`/umode`).
- **Fixed upstream:** `ead82a8`, the non-oper STATS abort on the seven long-name entries.
- **Confirmed in the source at `8453087`, not filed:**
  - `STATS k <server> <mask>` passes 5 arguments to the 8-field 216 format (`s_stats.c:287`).
  - WATCH parses the sender's nick (`parv[0]`) as a token, so a nick starting with `C` clears the list on every WATCH.
- **Read in the code, not re-checked at the head:**
  - PRIVS is truncated near 510 bytes.
  - 004 advertises the wrong user modes.
  - Highest-bit snotice delivery: config parse errors reach only WEBIRC subscribers; rehash G/Z-line hits go to OPERKILL.
  - SNO_THROTTLE is dead.
  - CHECK prints the same time twice on connection history rows and sends 291 twice when truncated.
  - CLOSE's 362 names the oper.
  - `CLEARMODE Q` clears +N.
  - A wildcard BADCHAN never blocks a join.
  - The local JUPE form checks no privilege.
  - Ban records have no setter or creation time.
  - HELP is empty for most oper commands, and KILL's help text marks the reason optional.
  - Oper PING replaces an origin that equals another user's nick with your own. Seance's transport probe is `PING :probe`; any reply counts, so it is harmless.
