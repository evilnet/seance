# Oper tools: IRC operation as a first-class activity

_Proposal, 2026-10-09; revised the same day with rubin's feedback. Status: phases 0 and 1 built (branch `feat/oper-tools`, see "Built" below); phases 2 and 3 to do. The wire facts behind it are in `docs/resources/nefarious2-oper.md`, compiled from the nefarious2 `ircv3.2-upgrade` source and live captures against the dev rig._

## The goal

An IRC operator opens Seance and finds that it already understands their job:

- the server notices that matter show up where they are, styled and actionable, and the routine ones stay out of the way in the network window;
- the snomask is a set of switches instead of a decimal they have to compute;
- `/check` is a card instead of 40 lines of `Label:: value`;
- a G-line list they can sort, edit and extend, with a preview of who a new ban would hit;
- "kill / gline / shun" is one tap away from any nick, IP or server notice.

Start with nefarious2 and keep the dialect behind an interface, so Solanum, UnrealIRCd, InspIRCd or Ergo can be added as profiles later.

## What happens today

- **Command output is raw.** STATS, TRACE, MAP, LINKS, CHECK, PRIVS, GLINE lists and the rest have no handler. They fall through to `handlers/index.ts` `unhandled` and render as `COMMAND params…` lines in the active tab.
  - NOTICE-carried output (the STATS help list, `STATS w`, CONNECT, UPING, GITSYNC) lands in the lobby as plain notices.
  - Two server bugs make even the batch boundaries unreliable: [#119](https://github.com/evilnet/nefarious2/issues/119) and [#120](https://github.com/evilnet/nefarious2/issues/120), filed 2026-10-09.
- **Server notices all go to the lobby.** They arrive as `:server NOTICE * :*** Notice -- …` with no tags, and `privmsg.ts` routes a server NOTICE to `*` into the lobby with unread. The important ones (a G-line someone just set, a net break, a failed OPER) are buried among the routine ones, and nothing categorises or timestamps them (the server sends no `time`).
- **WALLOPS go to the active tab as one plain line.** They carry the raw `* ` / `$ ` prefix, so WALLOPS, WALLUSERS and DESYNCH look the same.
- **WHOIS misses most oper detail.** It shows 313 and 338, but not 672 (WebSocket origin), 339 (marks), 343 (kill-listed), 616 (cert fingerprint), 325 (WebIRC) or the bouncer-session 320.
- **The client keeps no oper state.** It doesn't know it is opered, which privileges it holds or what its snomask is, so nothing can be offered or gated.

## Principles

1. **No dedicated windows.** Either something is important, and it shows in the window the user is looking at, or it isn't, and it goes to the network window. Oper notices, WALLOPS and command results all follow that one rule. There are no "Server Notices", "Wallops" or "Bans" tabs. Controls live in one modal (below).
2. **Detect, don't assume.** A server profile is chosen from 002/004/351 and ISUPPORT. Unknown servers get the generic ircu behaviour and raw rendering, never a broken table.
3. **Correlate by label, render by kind.** Every oper request goes out with a `labeled-response` label. nefarious2 wraps STATS, CHECK, TRACE, MAP, LINKS, WHO, WHOIS, INFO and others in a labeled batch, including commands forwarded to another server. So the client gets the whole reply as one unit, in the tab that asked, and hands it to one renderer.
4. **Gate by privilege, never remove the escape hatch.** Controls appear only for privileges the oper holds (from PRIVS). `/quote` and typed commands always work, and output nobody parses still renders raw.
5. **Silent success is not success.** GLINE, SHUN, ZLINE, JUPE, KILL, OPMODE, CLEARMODE and REMOVE answer success with nothing, or a bare ACK. Every action shows _pending_ until its server notice arrives or a re-list confirms it.
6. **Preview before harm, confirm before damage.** A ban form shows the users it matches before it is sent. Typed confirmation guards DIE, RESTART and SQUIT.
7. **Same rules as the rest of Seance.**
   - Sizing in `rem`, and container queries for layout.
   - Usable on a phone.
   - Parsers Vue-free, so mocha covers them (CLAUDE.md conventions).

## Architecture

### 1. Server profiles (`client/js/irc/profiles/`)

A `ServerProfile` is chosen once per connection after 004/005 and re-checked on `draft/extended-isupport` updates.

```ts
interface ServerProfile {
  id: "nefarious2" | "ircu" | "generic";
  match(info: {version: string; isupport: ISupport; caps: Caps}): number; // score
  snomask: SnomaskModel; // bits (ircu) or letters (charybdis/unreal/inspircd)
  classifyNotice(text: string, origin: string): SnoticeEvent | undefined;
  noticeRoutes: Record<SnoticeKind, Route>; // the default routing table (feature 1)
  stats: StatsCatalog; // letter -> {title, columns, parseRow}
  parseCheck(lines: IrcMessage[]): CheckReport;
  bans: BanType[]; // gline/shun/zline/jupe here; kline/dline/xline/resv elsewhere
  commands: OperCommandSpec[]; // syntax, privilege, help text (the server's HELP is empty)
}
```

- **nefarious2** is picked by `+Nefarious(` in the version.
- **The branch** is told from `master` by ISUPPORT (`MONITOR`, `CHATHISTORY`, `evilnet/…`) or the `draft/persistence` cap, because the version string is identical on both.
- **`ircu`** covers the plain ircu family (WHOX, USERIP, SILENCE).
- **`generic`** is everything else: raw rendering plus the universal bits (WALLOPS, KILL, 381).
- The whole profile is data and pure functions, so it lives under mocha with fixtures taken from the captures.

### 2. Oper state on `IrcClient`

A new `OperState` is fed by the handlers and announced on the bus:

| Field      | Source                                                     | Notes                                                                                                                                       |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`    | own MODE `+o`/`+O`/`+a`/`+k` whoever sets it, 221, `381`   | `none`, `local`, `global`, `admin`, `service`. After `-o`, keep tracking `+s/+w/+g`; the server leaves them on.                             |
| `privs`    | `PRIVS` as soon as `+o`/`+O` lands (270)                   | Tolerate the reply's truncation near 510 bytes and the untagged 270 plus ACK (#120). On `NOTICE :Your privileges were modified`, ask again. |
| `snomask`  | `008`; read with `MODE <me> +s +0` (verified live)         | Decimal; the server ignores hex.                                                                                                            |
| `features` | `GET CONNEXIT_NOTICES`, `GET SNOMASK_OPERDEFAULT`, … (284) | Tells the UI which categories can actually arrive.                                                                                          |
| `umodes`   | 221 / MODE                                                 |                                                                                                                                             |

The store gets `network.oper` through a new `oper:state` bus event. Everything oper-only in the UI keys off it.

- **The mode is the signal, not 381.** On AfterNET, opers are granted by services (X3) on SASL login, so there may be no `OPER` and no 381; a bouncer resume reapplies oper silently too. Oper state therefore keys off the own-mode change, whoever sets it — a MODE line or a 221 — and X3's oper-up notice is classified like any other. A held bouncer session resumed or attached gets its modes in silence today ([evilnet/nefarious2#121](https://github.com/evilnet/nefarious2/issues/121), still open), and on a phone that is every return from another app: the OS kills the socket, the bouncer holds the session, the attach brings no `+o`, and the client — which forgets its oper state on every close — showed "You are not an IRC operator" until a `/umode`. So, as a stopgap until the server sends the modes (rubin, 2026-10-11): `OperPrefs.wasOper` remembers a network that was opered, and a registration that ends with no mode seen sends one `MODE <me>` and takes the 221; a network never opered sends nothing. Taken out when #121 lands. A page cold-started after Android discarded it reopens on the last conversation, not the panel; that is left as it is.
- **No oper-on-connect in Seance.** SASL-driven oper covers it, and anyone who insists on `/oper` can put it in the network's existing on-connect commands. Seance stores no OPER password.

### 3. Request/response correlation (`client/js/irc/request.ts`)

`client.request(line, {expect})` returns a `Promise<ReplyUnit>`. This is the "exact correlation" that `docs/projects/reply-routing.md` parked under _Future_.

- The line goes out with `@label=r<n>`, and the `labeled-response` batch type is registered with `registerBatchHandler`.
- **A batch** is delivered whole. Because of #119, untagged NOTICEs that arrive between `BATCH +` and `BATCH -` are taken into the open labeled batch.
- **A single labeled line** (008, 284, an error) resolves alone.
- **An `ACK`** resolves with "no output". Because of #120, an ACK that follows an untagged 270/302/303/340 in the same tick resolves with that line.
- **Without a label** (a remote CHECK, or a server without the cap), fall back to the terminal-numeric table from `forwarded_label.c`: STATS 219, TRACE 262, LINKS 365, CHECK 291, GLINE 281, and so on.
- **The asking tab** is recorded with the request, so the result lands exactly there. That also fixes the reply-routing wart where a `showInActive` message moves back to the lobby on reload.

### 4. Results as structured messages

A new `MessageType.REPORT` carries `{kind, request, data, raw}`. A `MessageTypes/report.vue` dispatches on `kind` to a renderer, and `raw` is always available behind a "raw" toggle and in "copy". Each card has:

- a header naming what was asked;
- **Refresh**, which re-runs the request;
- **Open in oper panel**, for the kinds the modal manages (a `STATS g` or `GLINE` card opens the Bans tab);
- a collapse control, since a G-line table can be long.

Kinds for nefarious2: `stats:<letter>`, `check:user|channel|server|hostmask`, `trace`, `map`, `links`, `lusers`, `ircops`, `privs`, `admin`, `version`, `glist`, `zlist`, `jupelist`, `features`, `userip`, `who-oper`.

The bus contract gains the type and a `shared/types/msg.ts` shape per kind.

A classified server notice is its own type, `MessageType.SNOTICE`: `{kind, category, fields, text, origin}`. It renders as a compact line with a category badge, with the nick, IP, mask and server as chips (feature 1).

### 5. Routing: important to the active window, routine to the network window

Server notices, WALLOPS and anything else server-volunteered pass through one function. It picks the destination from the event's kind:

- **`active`**: shown in the window the user is looking at. Stored in the network's lobby with `showInActive`, the mechanism `/whois` replies already use. Raises the network's unread like a NOTICE does today.
- **`network`**: stored and shown in the lobby only, with **no unread**. Routine lines must not keep lighting the network up.
- **`off`**: dropped. The oper chose not to see this kind.

The profile supplies a default route per kind (feature 1). The oper overrides any kind in the oper panel, and the override is stored per saved network. A notification rule ("notify me on this pattern") promotes a matching line to `active` and raises a notification.

### 6. The oper panel: a button on the network, a modal like Settings

**The button.** A new tool in the network header's `.lobby-tools`, right of the join `+`. It is a FontAwesome solid (shield/user-shield), the same ~13px glyph size as its neighbours (`tools/scenarios/network-panel.mjs` measures the ink spacing). It shows **only while that network is opered**, so non-opers never see it.

**Room for it** (computed from `style.css`, to be confirmed in the browser):

- The sidebar is `7rem + 108px`, and each tool is a 1.5rem box with a 0.25rem gap.
- So a fifth tool leaves the nick `108px − 3.75rem` instead of `108px − 2rem`.

| Font step           | Nick space, 4 tools | Nick space, 5 tools                           |
| ------------------- | ------------------- | --------------------------------------------- |
| medium              | 76px                | 48px                                          |
| large (the default) | 68px                | 33px (about 4 characters before the ellipsis) |
| xlarge              | 56px                | 10px                                          |
| huge                | 40px                | −20px (the toolbar overflows)                 |

**Fitting it.**

- The nick already yields first (it ends in an ellipsis).
- At the top steps, make `.lobby-status` an inline-size container and tighten the tool boxes and gaps there, rather than clipping a tool.
- An "Oper panel…" item in the network's context menu is the fallback entry that never runs out of room.

**The modal.** It reuses the Settings shell (`Windows/Settings.vue`'s pane, backdrop, tab strip, Done footer, Escape to close, full-screen at ≤768px). Its own route is `/oper/:networkUuid/:tab`, so it is a standalone page: `onStandalonePage()` holds, a deep link or reload reopens it, and Done is `leavePage()`. The title names the network ("Oper — AfterNET").

**Tabs**, each shown only if the oper holds a relevant privilege:

| Tab         | Contents                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Notices** | the snomask switchboard and the per-kind routing (feature 2); notification rules; a searchable list of recent notices from an in-memory ring |
| **Modes**   | oper status and privileges (PRIVS as chips); the oper umodes `+w +g +W +H +I +X +p +D +R +q`, each gated by privilege and feature            |
| **Bans**    | the ban manager (feature 7)                                                                                                                  |
| **Users**   | the oper WHO search (feature 9)                                                                                                              |
| **Network** | the server tree (feature 8)                                                                                                                  |
| **Server**  | the dashboard and admin actions (feature 11)                                                                                                 |

The modal covers the app (that is the Settings pattern). Results that belong in a conversation — CHECK, STATS, WHOIS — still land inline in the active window.

## Features, ranked

### Tier 1: makes an oper switch clients

**1. Server notices, routed by importance.**

- **Classifier.** The nefarious profile matches each line against the catalogue (reference §5: about 80 patterns, log-derived lines first). Each event gets:

  - a kind (`gline.add`, `kill.oper`, `net.break`, `client.connect`, …);
  - the category, i.e. the snomask bit it travels on;
  - extracted fields: nick, user, real host, IP, class, realname, numnick, oper, mask, expiry, reason, server.

  Lines it cannot classify are kept as plain `SNOTICE` text with kind `unknown`.

- **Time and origin.** Stamped locally, since the server sends no time. The origin server comes from the prefix, which global notices carry.
- **Default routes** (the oper can change any of them):

| Route       | Kinds                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **active**  | Ban changes by anyone: G-line/shun/Z-line/BADCHAN add, activate, deactivate, modify, remove, force-remove; JUPE changes; temp-shun applied/removed |
| **active**  | KILLs by an oper                                                                                                                                   |
| **active**  | Opers coming up, failed OPER attempts, BOUNCER ORESET                                                                                              |
| **active**  | Net break, net junction, SQUIT, links established or cancelled, `ERROR from`, `No response from … closing link`, SendQ exceeded on a server link   |
| **active**  | Rehash (local and remote), restart, clock changes and timestamp drift, config parse errors, GitSync failures, TLS reload failures                  |
| **active**  | WEBIRC unauthorized or invalid attempts                                                                                                            |
| **active**  | Log lines at CRIT, ERROR or WARNING                                                                                                                |
| **active**  | Burst alerts (below)                                                                                                                               |
| **network** | Client connecting / exiting, nick changes, WEBIRC host changes                                                                                     |
| **network** | "G-line / Shun / Z-line / K-line active for …" hits                                                                                                |
| **network** | Server kills and nick collisions                                                                                                                   |
| **network** | HACK(2/3/4) mode and kick notices (mostly services)                                                                                                |
| **network** | Unauthorized connections, too many connections, IP mismatches, TLS handshake errors, DNSBL blocks                                                  |
| **network** | IAuth chatter, net.burst progress, bouncer housekeeping, INFO/NOTICE log lines                                                                     |
| **network** | Anything unclassified                                                                                                                              |

- **The line itself.**
  - A category badge, then the event in plain words ("**rubin** added a global G-line on `*@203.0.113.7` for 1d: spam").
  - Chips for the nick, IP, mask and server. Each chip carries the act-on-user menu (feature 6); an IP chip offers CHECK / WHO / G-line.
  - Long notices collapse to one line.
- **Burst detection.** N `Client connecting` from one /24, ident or realname pattern within T seconds produces one synthesized **active** line: "12 connections from 203.0.113.0/24 in 30 s". Its G-line button opens the ban form pre-filled and previewed. This only works if the oper subscribes to connect notices, which in turn need `CONNEXIT_NOTICES` on the server.
- **Kept on the device.** Server notices and WALLOPS are never replayed by the server, and an installed PWA on Android is discarded whenever the user switches away. So everything held only in memory is gone on the way back: the lobby's routine lines, the important lines shown in channels, the recent list.
  - **Where.** Classified notices and WALLOPS are written to IndexedDB per network, through a debounced writer like `querylog.ts`'s. localStorage is not big enough: the query log already takes up to 300k characters per network there.
  - **How much.** A cycle, not an archive: the newest ~2 000 lines or 24 hours per network, whichever is smaller.
  - **On page load**, the lobby gets them back as one history page, before the network connects, the way `querylog.ts` brings logged queries back. Lines that were routed to the active window come back in the lobby, where they are stored.
  - **Searchable.** The same store backs a searchable, filterable list in the oper panel's Notices tab ("what did that say ten minutes ago").
  - **Housekeeping.** Removing the network deletes its store. The settings backup never carries it, as with `thelounge.querylog.*`. A gap while disconnected stays a gap.

**2. Snomask switchboard** (oper panel → Notices). This is the "binary masking" request.

- **Layout.** One row per snomask bit:

  - its name, a plain-English description, a volume badge, and default/oper-only markers;
  - a switch that flips the bit;
  - under the bit, the notice kinds that travel on it, each with its route selector (Active / Network / Off).

  Subscription (what the server sends) and routing (where it shows) are separate on purpose: the GLINE bit carries both the important "added a G-line" and the noisy "G-line active for".

- **Mask readout.** The decimal and hex values update live.
- **Presets.** Default (`SNOMASK_DEFAULT`), Oper default, Everything, Quiet, Ban watch (GLINE + AUTO + OPERKILL), Linking (NETWORK + OLDSNO), plus custom presets saved per network.
- **Honest switches.**
  - THROTTLE is greyed out: nothing sends on it.
  - DEBUG is greyed out on non-debug builds (351 serveropts without `D`).
  - CONNEXIT, NICKCHG and the WEBIRC host-change notices say "silent on this server" when `GET CONNEXIT_NOTICES` is FALSE.
  - The highest-bit delivery quirk is noted where it bites; for example, config parse errors reach only WEBIRC subscribers.
- **Apply.** It sends `MODE <me> +s <decimal>` and reads the effective mask back from 008. The server strips bits the user may not hold, and the switches show what it kept.
- **Remember.** The chosen mask is stored per saved network and re-applied after each oper-up.

**3. WALLOPS, routed the same way.**

- **Kinds.** `* ` → WALLOPS, `$ ` → WALLUSERS, no prefix from a server → DESYNCH. Each gets its own badge, with the prefix stripped.
- **Default routes.**
  - WALLOPS, WALLUSERS and server-sent WALLOPS (`Remote CONNECT …`): **active**.
  - DESYNCH (`Protocol Violation from …`, sent to +g): **network**.
  - All of them overridable in the Notices tab.
- **Sending.** `/wallops` and `/wallusers` stay typed commands. Their echo (the sender gets one with +w) confirms delivery.
- **Channel variants.** WALLCHOPS, WALLHOPS and WALLVOICES (`NOTICE @#chan :@ text`) render in their channel with an "ops only" marker. Today they look like an ordinary notice from the sender.

**4. CHECK as cards.** These render inline in the active window. CHECK can be run from `/check`, the user menu, a notice chip, or a WHO row.

- **User card**, in sections:
  - identity: nick and numnick, real and visible host, IP, realname, class, account, umodes;
  - connection: signed on, idle, ports, TLS cipher and fingerprint, WebSocket origin from WHOIS, WebIRC gateway;
  - channels, as chips with their prefixes;
  - traffic: bytes and queues, with the "Kb" remainder field handled correctly;
  - oper: status, O-line, privileges as chips;
  - bouncer session: state, primary and aliases, connection history.
- Times are parsed from the server's `ctime` format and shown as relative ("idle 4m").
- **Channel card.** Topic, modes, a members table (clone groups highlighted, status coloured, account shown), bans with setter and age, and totals.
- **Server card.** Numeric, users/capacity, status, downlinks.
- **Hostmask search.** A table, with each user's channels when `-c` is given, and a truncation warning past 1 000 rows.
- Every row has the act-on-user menu.
- For a remote user the client sends `CHECK nick nick`, because only the user's own server knows idle time, ports and traffic.

**5. STATS, done properly** (inline in the active window).

- **Picker.** `/stats` with no letter gives a picker built from the server's help list (#119 tolerated), with descriptions. Letters the oper cannot use are greyed out.
- **Typed tables** for the high-value letters:
  - `g` / `S` / `Z`: bans, with expiry countdowns and active-state chips;
  - `o`: opers;
  - `p`: ports, with flag badges (TLS, WS, autodetect, v4/v6, paste);
  - `y`: classes;
  - `l`: link traffic, sortable and humanised;
  - `u`: uptime;
  - `m`: command counts as bars;
  - `c` / `i` / `k` / `E` / `s` / `W` / `T` / `q` / `J`: config views;
  - `f` / `F`: a searchable feature table;
  - `V`: a server table;
  - the nefarious subsystems (chathistory `H`, metadata `M`, webpush `W`, dnsbl `D`, authtoken `A`, webhook, gitsync), as definition lists, since their lines are `Key: value`.
- Anything else renders monospace.

**6. Act on a user.** When opered, the nick context menu (`helpers/contextMenu.ts`), the whois card, the notice chips and the CHECK rows gain:

- Check, oper WHOIS;
- Kill…;
- G-line… / Shun… / Z-line… / Temp-shun;
- Find clones (`CHECK *@<ip>`);
- WHO by IP;
- Copy real host or IP.

The kill and ban dialog:

- is pre-filled from what the client knows (338, CHECK, `WHO %i`);
- suggests masks: `*@<ip>`, `*@<ip>/24`, `<user>@<host>`, `*@<host>`;
- has duration and reason fields;
- previews the matches (feature 7).

nefarious2 rejects a KILL without a reason, so the dialog requires one.

**7. Ban manager** (oper panel → Bans). Sub-views for:

- G-lines, from `GLINE` (which includes scope and BADCHANs; `STATS g` has neither);
- Shuns, Z-lines and server Jupes;
- nick jupes (`STATS J`);
- K-lines (`STATS k`, from config);
- quarantines (`STATS q`).

Details:

- **Columns.** Mask, type, scope (global or a server), effective state (decoded from `+ - >+ >- <+ <-`), expires (countdown), lifetime, reason.
- **Setter column.** The server stores no setter or creation time, so this column is filled from the notices this client saw (`<who> adding global GLINE for <mask>…`) and is marked as such.
- **Add/edit form** (mask builder):
  - mask types: `user@host`, CIDR, `$R` realname, `$V` CTCP version, `#channel` BADCHAN;
  - a duration picker in the server's own units, capped at the 7-day maximum;
  - reason templates;
  - scope: global, this server, or a named server;
  - a force (`!`) box, shown only with WIDE\_\*;
  - client-side validation mirroring `gline_checkmask`: wildcards need force, never `*.com`, nothing wider than /16, under 2 dots refused. The oper sees why before the server answers 520.
- **Impact preview.** Before sending, run `CHECK <mask>` (or `WHO <mask> x%…` for `$R`) and show "matches 3 users: …". Over GLINEMAXUSERCOUNT (20), warn that the ban needs force.
- **Row actions.**
  - Activate or deactivate globally.
  - Activate or deactivate locally (`>` / `<`).
  - Change expiry or reason.
  - Remove a local entry (the dummy-arguments trap handled).
  - Force-remove (`REMOVE`, PRIV_REMOVE only).
- **Confirmation.** Every action is pending until its notice arrives or a re-list confirms it (principle 5). Errors 515, 518, 519, 520 and 521 get human wording.
- **Live updates.** Other opers' changes, seen as notices, update the table.

### Tier 2: makes them tell other opers

**8. Network** (oper panel tab).

- MAP as a real tree (indent parsed, lag and client bars, bursting and EOB-ack flags), joined with LINKS and `STATS V` (RTT, up/down, protocol, link age).
- Per-server actions: RPING, UPING, ASLL, CONNECT, and SQUIT behind typed confirmation.
- Net break and net junction notices update the tree.

**9. Oper user search** (oper panel → Users).

- A search form over `WHO <mask> x%tcuihsnfdlaomr,<tok>`: by nick, user, host, real IP or CIDR, realname, account, mark or server.
- Results go in an extended WHO table with IP, idle, marks and the oper flags (`i w g`); the existing `who.vue` grows the extra columns.
- Every row has the act-on-user menu.

**10. Oper WHOIS.** The existing whois card adds:

- 338, 672, 339, 343, 616 and 325;
- the bouncer 320 (one of three meanings 320 carries, told apart by its text);
- a Check button.

**11. Server** (oper panel tab).

- **Cards**, with a refresh interval:
  - uptime and connection count (`STATS u`);
  - load (`STATS w`);
  - traffic (`STATS t`);
  - memory (`STATS z`);
  - the nefarious subsystems: chathistory storage state, webpush delivery counters, DNSBL hit rates, metadata, authtoken.
- **Feature browser** over `STATS F`, with inline `SET` / `RESET` (PRIV_SET).
- **Maintenance:** the REHASH variants (`m l a s q`, and remote), GITSYNC status and force, STORE INFO / DEFRAG / GC.
- **RESTART and DIE** behind typed confirmation of the server name.

**12. Command help and completion.** nefarious2's `HELP` is empty for almost every oper command (verified: `705 GLINE :GLINE `). The profile therefore ships syntax, argument hints and privilege requirements for each command. These feed:

- composer autocompletion, with `/stats ` offering letters with descriptions;
- an Oper section in the Help window.

### Tier 3: "it supports _everything_"

- **Raw console**, an oper-panel tab: the line stream in both directions with tags shown, and a send box. Transport-level and opt-in.
- **Channel oper tools**, in the channel menu:
  - Check channel;
  - OPMODE, the mode editor sending OPMODE, with `!` for quarantined channels;
  - CLEARMODE as a checklist, working around the bug where `Q` clears `+N`;
  - BADCHAN G-line;
  - `JOIN &chan OVERRIDE`.
- **Mass message.** `PRIVMSG $<servermask>` / `$@<hostmask>`, with a target preview and confirmation.
- **Oper badges.** Request `draft/oper-tag` and show a badge on messages from displayed opers. Cheap, and useful to non-opers too.
- **Bouncer admin.** `BOUNCER LISTSESSIONS *` as a table, ORESET with confirmation.
- **Oper aliases.** Preset aliases (`/gl`, `/kl`, `/ck`) on top of the existing alias system.

## Asking the server for better (parked)

_Parked 2026-10-09: ship the client against the server as it is (regex classifier), then come back to these._ We maintain nefarious2's branch too, so some client workarounds are cheaper to remove at the source:

1. **Structured server notices.** A cap such as `evilnet.github.io/snotice` would tag every server notice with its snomask bit, the server time and an event name, carrying the extracted fields as tags or a JSON payload.
   - UnrealIRCd's `unrealircd.org/json-log` is the prior art.
   - It would turn the classifier from about 80 regexes into a lookup, and survive any change to the wording.
   - It should also deliver notices to the nick rather than `*`, so they can be labeled and batched.
2. **Fix [#119](https://github.com/evilnet/nefarious2/issues/119) and [#120](https://github.com/evilnet/nefarious2/issues/120)** (filed).
3. **Positive acknowledgements for bans and kills** instead of silence, e.g. `NOTE GLINE ADDED <mask> <expire>`.
4. **Setter and creation time on ban records**, carried in RPL_GLIST and RPL_ZLIST.
5. **PRIVS split across lines** instead of truncated at 510 bytes, and a **004** that lists the real user modes.
6. **Snotice delivery to every bit in the mask**, not just the highest.
7. **The smaller bugs** in the reference §14: STATS k, WATCH own-nick, CLOSE, CLEARMODE Q, CHECK's double 291.
8. **Label forwarding for a remote CHECK.**

None of these blocks the client; each removes a workaround.

## Other ircds

Each would be a profile, with the same shape. What differs:

| ircd                | Differences                                                                                                                                          | Note                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Solanum / charybdis | snomasks are letters (`+s +cCfkn…`); bans are KLINE/DLINE/XLINE/RESV with UN- forms; TESTLINE / TESTMASK for impact preview; different STATS letters |                                                               |
| UnrealIRCd          | the TKL family (gline, kline, zline, gzline, shun, spamfilter, eline)                                                                                | its JSON log tag would make its notice classifier the easiest |
| InspIRCd            | a CHECK module with its own numerics; X-line types                                                                                                   |                                                               |
| Ergo                | its own oper commands (UBAN, DEFCON, SA-commands)                                                                                                    |                                                               |

Profiles are detected from 004 (`solanum-`, `UnrealIRCd-`, `InspIRCd-`, `ergo-`).

**None of these is on our roadmap.** The `ServerProfile` interface and the nefarious2 profile are the template; a profile for another ircd is left to a user of that ircd to contribute as a PR. Unreal is the likeliest first: its JSON log tag makes it the easiest.

What a contribution needs:

- the same source reading this proposal got for nefarious2;
- fixtures captured from a real server;
- no changes outside `client/js/irc/profiles/`.

## Phasing

| Phase              | Scope                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Foundations** | profile detection; `OperState`; `request.ts` correlation; `MessageType.REPORT` and `SNOTICE` with raw fallbacks; the routing function; fixtures from the captures                                                                                                                                                           |
| **1. The core**    | classifier and default routes for server notices and WALLOPS; the IndexedDB notice store and its restore on page load; the oper button and modal shell with the Notices (switchboard and routing) and Modes tabs; CHECK cards; STATS tables for g S Z o p y u l m F; oper WHOIS; act-on-user menu with kill and ban dialogs |
| **2. Management**  | _Superseded by the revised plan below (2026-10-10)._                                                                                                                                                                                                                                                                        |
| **3. Reach**       | _Superseded by the revised plan below (2026-10-10)._                                                                                                                                                                                                                                                                        |

## Built (phases 0 and 1, 2026-10-09)

**Foundations.**

- Server profiles (`client/js/irc/profiles/`): `nefarious2`, detected by `+Nefarious(` in 004, and the `generic` fallback.
- `OperState` (`irc/oper.ts`), dispatched as `oper:state`; a `+o` that lands before 001 is followed up after registration, and `Your privileges were modified` re-fetches PRIVS.
- `irc/request.ts`, with the #119/#120 tolerance.
- `MessageType.REPORT` and `SNOTICE`.
- The routing function (`irc/snotice.ts`).
- The IndexedDB notice log with its restore on page load (`irc/noticelog.ts`).
- Per-network preferences (`irc/operprefs.ts`, `thelounge.oper`, in the settings backup).

**The core.**

- **Notices.** 67 classified nefarious2 notice kinds with default routes and plain-words templates; WALLOPS, WALLUSERS, server WALLOPS and DESYNCH told apart.
- **The oper panel.** The shield and the modal, with the Notices tab (snomask switchboard, per-kind routes, the searchable log) and the Modes tab (privileges, user modes).
- **Reports.** CHECK cards (user, channel, server, host search) and typed STATS tables for most selectors (the free-text ones and `v` render as lines).
- **Oper WHOIS:** 672, 339, 343, 325, 616 and the bouncer 320, plus a Check button.
- **The nick menu** gains Check / Kill… / G-line… / Shun… / Z-line… / Find clones. IP, host and mask chips carry the same actions.
- **The kill and ban dialog**: mask suggestions from USERIP/USERHOST, the width rules checked client-side, a CHECK preview of the matches, and confirmation by listing the ban back.

**Different from the plan.**

- **The menu's Check is `CHECK nick`, not `CHECK nick nick`.** nefarious2 does not forward the label for a remote CHECK, so the card would wait for an answer it never recognises. Typed `/check nick nick` still works; its reply renders raw.
- **The ban tools are nefarious2-only** for now (`profile === "nefarious2"`); KILL and Check are offered on any profile.
- **A G-line or shun is offered when either the server or the oper service would take it** (`helpers/operMenu.ts` `canBan`). A services-opered user on AfterNET holds exactly X3's `auto_oper_privs` — the server clears the set when services set `+o`, then adds what X3 sends — and that list has `WIDE_GLINE` but neither `GLINE` nor `SHUN`, so PRIVS says no while O3 takes the ban (the dialog already sends it there). Gating on PRIVS alone hid G-line… from the nick menu and the user card for every AfterNET oper (2026-10-13). Z-line has no services route and keeps the server's privilege as its gate.
- **The rig grants its oper the ban privileges.** `tools/nefarious-dev/local.conf` grants gline, shun, zline, remove and set explicitly, and turns on `CONNEXIT_NOTICES`.

**Not yet**: see "Revised plan" below, which replaces phases 2 and 3.

**Step 1 of the revised plan (2026-10-10): the panel restructured.** The
Notices and Modes tabs are gone; the panel is Opers, Alerts and Me, and the
shield opens Opers (old `/notices` and `/modes` links land on Alerts and
Me).

- **Opers** (`Oper/OperActivity.vue`, `helpers/operActivity.ts`): the
  notice log rolled up. A period (today, 24 h, since reload) and a By oper
  / By kind switch (remembered in `thelounge.oper.activityView`). By oper:
  one row per actor who did anything, busiest first, `alice · 13 actions · 21:14`, an outlying total amber (over three times the others' median and
  at least five); open for `12 G-lines 21:02 – 21:14`; open again for the
  notices. The servers' own actions (a server's kill, a ban hit, a
  temporary shun) are one "servers" row; a services row exists in the code
  (`isServiceActor`) but nobody is a service until step 2's setting. By
  kind: G-lines, kills, channel modes via OPMODE and services, opers coming
  up, jupes, server links and splits, rehashes and restarts, WALLOPS, then
  a closed "Everything else" with the plumbing (connects, bursts, log
  lines, …), each opening straight to its timeline with who did each one.
  The badge on every timeline row is the route menu (below).
- **Alerts** (`Oper/OperAlerts.vue`, `helpers/operAlerts.ts`,
  `irc/profiles/nefarious/alerts.ts`): twelve plain-words lines in two
  sections, each a Here / Network / Off control over its kinds (kept in
  step; the control shows the first kind's route). Here asks how long —
  today, 3 days, a week, until I change it — and a temporary choice is
  `OperPrefs.temporary` (`irc/operprefs.ts`: `routeFor` honours it until
  it lapses, then puts back what was stored before; lapsed entries are
  swept on the tab's mount and on the way past). The pressed button turns
  amber with "2 more days" beside it. Off is quiet on the wire too: once
  every kind on a server bit is off the bit is cleared, and a kind back on
  sets it (`reconcileMask`, only the changed kinds' bits, never a dead or
  debug-only one). "Everything else · N kinds" folds the twenty kinds
  nobody cares about, one per line; "Raw mask and presets" folds the old
  readout, the presets and the bits as plain checkboxes (dead and debug
  bits hidden unless set). A profile without `alertLines` gets one line
  per kind under the fold.
- **Me** (`Oper/OperMe.vue`): `Global operator · +owsgx · nefarious2`,
  the privileges as chips in a fold (open up to 12), the user modes as a
  grid with the explanation as the tooltip and read out to a screen reader.
- **The badge opens the route menu** (`Oper/NoticeBadge.vue`,
  `helpers/operMenu.ts` `noticeRouteItems`): the kind by name, Show here
  for today / 3 days / a week / until I change it, Show in the network
  window, Show nowhere (the current one checked), and "Stop receiving
  server events notices" (clears the bit) or "Stop receiving WALLOPS (-w)".
  Every change goes through `applyNoticeRoute` and the `oper:routes`
  eventbus event, which the Alerts tab re-reads on.
- Tests: `test/helpers/operActivity.ts`, `test/helpers/operAlerts.ts`,
  `test/irc/oper.ts` (temporary routes). The browser scenario covers the
  three tabs at both widths and the badge → menu → Alerts round trip.
- Decided along the way: the "hot" count needs at least one other oper to
  compare against (a lone oper is never amber); `reconcileMask` touches
  only the bits of the kinds just changed, so a line about bans never
  switches CONNEXIT on; a temporary route's revert point is the permanent
  choice at the time it was made, and a second temporary keeps the first's.

**Step 2 of the revised plan (2026-10-10): services support.** A
per-network setting, the X3 parsers, the feed into the Opers rollup, bans
through O3, and the grey lines when a channel is missing. Wire facts:
`docs/resources/x3-services.md`.

- **The setting** (`SavedNetwork.services`, `network.services`;
  `saved-networks.ts` `asServices`; in the settings backup with the rest of
  the record; live on `IrcClient.services` the moment the form saves):
  `{package: "x3", bots: {oper, account, channel, report, snoop}}`, None
  when absent. `NetworkForm.vue` grows a **Services support** section at
  the bottom, shown only once the network is connected and opered: a
  package select (None / X3), the five role fields, the help line, and a
  liveness line — one labeled WHOIS per bot (`irc/services.ts`
  `checkServices`; a 311 is online, a 310/313 "service" or one of X3's
  default realnames looks like X3) worded by `describeServiceCheck`:
  "✓ O3, AuthServ and ChanServ are online and look like X3.", "AuthServ
  isn't online (no such nick).", "Couldn't check: the network is not
  connected." Picking X3 fills the empty fields only.
- **The X3 profile** (`irc/services/x3/index.ts`, the interface in
  `irc/services/types.ts`, the registry `irc/services/index.ts`): the
  snoop regex and every keyword's fields (the connect form of NICK is
  keyword `connect`, the nick change `nick`); the audit regex with the
  command lowercased and a coarse kind (gline / ungline / block / refreshg /
  shun / sblock / unshun and a TRACE with a ban action → glines, TRACE kill
  → kills, ChanServ's channel commands → modes, god → opers, addalert /
  delalert → alerts, rehash / die / restart → rehash, else other); the
  module log line; `banCommand` with `x3Duration` (`1d12h`) and
  `parseBanReply` (issued / invalid / "would be smooth" / invalid time span
  / access denied). Fixtures in `test/irc/services/x3.ts` are the
  reference's lines verbatim.
- **The feed** (`irc/servicesfeed.ts`, from the PRIVMSG handler): a line
  from any of the three bots in the snoop channel that parses as a snoop
  line, or in the report channel that parses as an audit or module-log
  line, is appended to the notice log as a `snoop` / `audit` entry
  (`x3.snoop.<keyword>`, `x3.audit.<coarse>`, `x3.log.<severity>`,
  category `SERVICES`, an audit entry's `from` the human). Not routed, not
  re-rendered, not restored into the lobby: the channel shows the line as
  it is; the entries exist for the Opers rollup and the kept feed. The
  rollup (`helpers/operActivity.ts`, now with `ActivityOptions {serviceNicks}`) credits an audit line to the person who typed it, a
  snoop OPER to that nick as an oper-up, a kill by a bot and a MODE set by
  a bot to the services row, and files every other snoop keyword under
  "Everything else" _(the snoop rules went on 2026-10-11: a snoop entry now
  counts nowhere on the tab, see below)_. "Alerts in services" is a new
  coarse kind. The tier-2 labels read in the singular ("1 oper-up", "1
  G-line", "2 channel modes").
- **Graceful degradation** (`OperActivity.vue`): with services set, one
  grey line per configured channel the client is not in — "Not in
  #operserv: what services did for opers isn't counted." with a Join
  button, "Not in #mrsnoopy: connects and joins aren't kept." without one.
  Nothing without the setting. _(Since 2026-10-11 the snoop channel is no
  longer this tab's: no line for it and nothing counted from it — see the
  entry below.)_
- **Bans through O3** (`ActionDialog.vue`, `services:ban` →
  `irc/services.ts` `servicesBan`): with X3 set, a G-line or shun goes out
  as `PRIVMSG O3 :gline <mask> <duration> <reason>`; the title and button
  say "via O3"; no CIDR among the suggestions (O3 rejects it), no scope, no
  force; the answer is O3's own NOTICE, matched by nick and shape
  (`awaitServiceReply`, 10 s) and shown in its words, "O3 did not answer."
  on silence. KILL and Z-line stay on the server. The PRIVMSG goes out
  quiet (step 4's fix: its echo opens no query window); O3's reply is
  shown where a notice lands, since it is the confirmation.
- Different from the plan: the cards asking O3 and AuthServ for what the
  server does not know are step 3's (the channel and user cards); the
  Alerts tab does not yet list the services kinds (they are not routed);
  the module-log line is kept as an `audit` entry of kind `x3.log.<severity>`
  with no human behind it.
- Tests: `test/irc/services/x3.ts`, `test/irc/services.ts`,
  `test/irc/saved-networks.ts`, `test/helpers/operActivity.ts`. The dev
  rig has no X3, so `tools/scenarios/oper-tools.mjs` checks the form (not
  there before opering, there after), the prefill, the liveness line
  reporting the bots as not online and the two "Not in …" lines with Join
  on the report one only; the feed and the O3 path are unit-tested. A
  scenario against the AfterNET e-testnet (`tools/scenarios/oper-services.mjs`)
  waits for a session with it running.

**Step 3 of the revised plan (2026-10-10): the channel card and the user
card.** One overlay (`Oper/InvestigateCard.vue`, a Settings-style pane
over the whole app; the user column is `Oper/InvestigateUser.vue`), one
data object per card (`irc/investigate.ts` `Investigation`: `start`,
`refresh`, `stop`, `lookup(nick)`, `traceCount()`, an `onChange`
callback over a plain model), Vue-free so mocha drives it with
FakeTransport.

- **Entry points.** Investigate at the top of a nick's oper menu (above
  Check, which stays), Investigate in a channel's menu — the sidebar row
  and an inline `#chan` — when opered (`helpers/operMenu.ts`
  `operChannelItems`), and `/investigate <nick|#chan>`
  (`irc/commands/investigate.ts`; bare, the current channel or query).
  Everything opens through the `oper:investigate` eventbus event. Cards
  stack: a nick in the channel card opens the user card on top and ✕ goes
  back; Escape, ✕ and the backdrop close the top one.
- **Sources and pacing.** The first three commands go out at once and the
  rest one every 2 s (`BURST`, `PACE_MS`: the fake-lag rule), the bots'
  queries one at a time on their own lane since only the order correlates
  a NOTICE with its question (`collectServiceReply` in `irc/services.ts`:
  from the line the lookup says starts the answer to the one that ends it
  or 1.5 s of quiet). Channel: `CHECK #chan` (`parseCheck` in
  `profiles/nefarious/check.ts`), `WHO #chan %tcuihsnfdlar,<token>`,
  `USERIP` five nicks at a time for anyone WHO gave no IP (a non-oper's
  255.255.255.255 counts as none); with X3, O3 `chaninfo` (created from
  the unix stamp, bans), ChanServ `info` (registered, since, owner), then
  O3 `whois` per user for country, city, version, nick age and channels —
  the first 20 (`LOOKUP_CAP`), the rest when the oper presses Look up in
  their block. User: `CHECK nick`, `WHOIS nick nick`, `USERIP nick`, then
  `STATS g`, `S`, `Z` (`parseBanRow` in `profiles/nefarious/stats.ts`;
  opers only); with X3, O3 `whois`, AuthServ `accountinfo` once an
  account is known (last quit hostmask, hostmasks), and O3
  `gtrace print host superset <host>` **only when the server listed no
  bans at all** — X3's bans are the server's, so a list that was read
  needs nothing more; `superset` because the bans wanted are the ones
  whose mask takes the host in. Every lookup's command, accept and parse
  are the profile's (`irc/services/x3/lookups.ts`, `ServicesLookups` in
  `irc/services/types.ts`; `criterion` turns a shared fact into an
  ADDALERT/TRACE word — `info` and `version` values get `?` for spaces,
  the connect age has none).
- **The kept feed does the rest** (`helpers/commonality.ts`,
  `helpers/verdict.ts`): when each user connected (the snoop connect line
  or the server's `client.connect` notice) and joined; the last hour in
  the channel (snoop join/create/part/kick/mode, consecutive joins within
  a minute folded into "a, b and c joined"; the "Not in #mrsnoopy" grey
  line when the snoop channel is configured and not joined, nothing
  without services); "seen before" over connect, exit, nick-change, ban
  hit, kill and oper-up notices and snoop connect/quit/kill/oper/auth
  lines sharing the IP, host, realname or account — grouped by nick,
  newest first, with their fate (`G-lined by rubin for 'bot group'`,
  `killed by X`) from `ban.add`, `kill.oper`, snoop kills and O3 audit
  lines; and the bans near the user — the live STATS rows whose mask
  covers them (`maskCovers`: ident and host or IP by wildcard, IPv4 CIDR,
  `$R`, `$V`), with the setter from the feed's `ban.add`, then the recent
  `ban.*` notices covering them that are not live.
- **Commonality** (`commonality()`): authed, connect age (< 15 min, < 1 h,
  < 1 d, > 1 d), realname, ident shape (per character: `r8821` → `a####`;
  the group's literal glob `r????` is the value, "r + 4 digits" the
  label), the /24 or /64, server, version; common when at least
  max(3, two thirds) share it; users sharing every fact are tinted along
  their edge, those sharing none have a dashed one.
- **Verdict** (`verdict()`): a live ban first ("Covered by a live G-line:
  _@203.0.113._ (rubin, 3 d ago)."); else another nick sharing the IP, or
  the host and the realname ("Likely the same as spamfan (Tue): same IP,
  same realname, same ident shape; G-lined then by rubin for 'bot
  group'."); else a weaker overlap said as such ("Nothing conclusive: …
  shares the realname."); else that nothing in the kept feed shares
  anything. Today's sightings carry the time, older ones the bare day.
- **The rest of the card.** "Alert on this…" emits `oper:alert-builder`
  with the facts and the criteria; nothing listens until step 4, so a
  toast says the builder is coming. Trace count (X3 only) sends
  `trace count <criteria>` and shows the number inline. Join & watch is
  the sidebar's `/join`. Note… keeps a local note in `thelounge.oper`
  (`OperPrefs.notes`, keyed by the channel name, else the IP, else the
  account, else the nick; shown at the top of the card). Refresh asks
  everything again. Raw replies shows every line received. G-line… and
  Kill… open the existing dialog with the nick and `*@ip` prefilled.
  Compare side by side asks for a nick and opens a second investigation
  as a second column (one column with tabs under 40rem of pane, a
  container query), rows whose values match tinted.
- Decided along the way: the card asks the bots even when they are not
  online (the dev rig), and each `401` is the usual "no such nick" line
  in the window — an unconfigured package should be set to None; the
  per-user WHO row's host is shown as the IP chip when the two are the
  same; a `+o` user card without CHECK (not opered) still fills from
  WHOIS and USERIP; the phone layout opens the channel card by
  `/investigate` in the scenario because the sidebar row sits under the
  drawer.
- Tests: `test/helpers/commonality.ts`, `test/helpers/verdict.ts`,
  `test/irc/investigate.ts` (a channel and a user investigation through
  FakeTransport with CHECK/WHO/STATS replies and O3/ChanServ/AuthServ
  NOTICE lines from x3-services.md, the burst and the 2 s pacing under
  sinon's clock, gtrace only on an empty list, refresh). Browser:
  `tools/scenarios/oper-tools.mjs` opens the channel card from the
  sidebar row's menu with three helpers from the rig's address (the
  common facts: not authed, the /24, the server), the stacked user card
  from a nick in it, the user card from the nick menu (the facts grid,
  "seen before" finding the other helper from the same address — and,
  since step 4's fix, never the user's own connect notice — the verdict),
  and Compare with the matching rows tinted — desktop and phone.

**Step 4 of the revised plan (2026-10-11): the alert builder, and two
fixes to step 3.** O3's `addalert` as a form (`Oper/AlertBuilder.vue`, an
overlay in the cards' frame, mounted in `App.vue`), the form logic
Vue-free in `helpers/alertBuilder.ts`, the wire side in `irc/alerts.ts`
over X3's alert lookups (`irc/services/x3/alerts.ts`, on the
`ServicesLookups` interface: `alerts`, `tracePrint`, `addAlert`,
`delAlert`).

- **The fixes.** _Seen before_ no longer lists the user themself:
  `seenBefore` drops a feed entry under the user's own nick (by the
  network's casemapping) from their own IP — or, without one, their own
  host — so their own connect, quit and auth lines are not sightings; an
  earlier session of the nick from another address still is, and the
  verdict says "the nick was seen from …" rather than "the same as". _Quiet
  lookups_: every PRIVMSG to a bot went out plain, so with `echo-message`
  its echo opened the bot's query window and the answers piled up there.
  `irc/quiet.ts` sends them with `@label=svc<n>` and `IrcClient.handleMessage`
  drops the echo carrying it (a line, an `ACK`, or a labeled batch) before
  any handler sees it; a NOTICE a `collectServiceReply` consumes (every card
  lookup, every builder lookup) is shown in no window, while one nobody
  waits for is shown as before, and `awaitServiceReply` takes a `quiet`
  option the ban path leaves off — O3's reply to a G-line is the
  confirmation. A `401` for a missing bot is still shown (and forgets the
  label). Without `labeled-response` the line goes out plain and its echo
  shows, as before.
- **Ways in.** The card's "Alert on this…" (`oper:alert-builder` with the
  facts, the channel or the nick); "New O3 alert…" on the Alerts tab and
  Edit on one of "Your O3 alerts" there — both only with
  `network.services.package === "x3"`. The fold lists `stats alerts`
  (name, reaction, owner, expiry, criteria, last fired) as `name · reaction · by owner · expires in N d` rows with Edit and Delete; Delete asks once
  inline, then `delalert <name>`, the verdict in O3's words under the
  list; the list reloads on the builder's `oper:alerts-changed`.
- **The form.** Name (`<chan>-bots` from a channel card, `<nick>-alert`
  from a user card, else empty; letters, digits and dashes; read-only on
  Edit), Reaction (notice by default; every reaction with its keyword and
  the O3 level it needs — notice/noticeuser/msguser 800, gline/shun/
  tempshun/kill 900, mark/version/svsjoin/svspart 999; svsjoin and svspart
  bring a `chantarget` row along; an option is greyed with "needs O3 level
  N" only when the oper's level is known and too low), Expires (today / 3
  days / 1 week / 1 month / never → `expire 1d 3d 1w 1M`, none for never;
  1 week by default; Edit picks the shortest option that still reaches the
  stored date). "Match users who…": one row per criterion — a switch, the
  criterion in words with O3's keyword as the tooltip, the value in
  monospace, ✕ — and "+ add" over the criteria not yet in the form
  (channel, authed, info, ident, ip, nickage, last, server, nick, host,
  version, account, clones, numchannels, modes, marked, regex,
  chantarget). The card's facts become rows (`authed`, the realname as
  `info`, the ident glob as `ident`, the /24 or an exact IP as `ip`, the
  server, the version; the connect age has no criterion); a **wide** row —
  an IP range, a nick age or `last` window, a server, two clones or
  fewer, `authed no` alone among the rows that are on — is tagged in
  amber and arrives switched off. Reason (`bot group in #chan, see <me>`
  / `see <me>`). The exact command, live: `addalert <name> <reaction> expire <dur> <criteria…> reason <reason>`, `info` and `version` values
  with spaces as `?` globs, the reason last.
- **The count line.** `trace print` with the criteria that are on, 600 ms
  after the last edit while the form is open (one in flight at a time,
  re-run when edited meanwhile), worded "Matches N users right now · none
  are opers" with the nicks under it (20, then "+N more"), amber past 25
  with "that's a lot; check the criteria", "Nothing matches right now."
  for none; the opers from the TRACE output's flags when it has any (X3
  2.0 prints none) and otherwise from one `WHO a,b,c %nf,<token>` on the
  server, the line omitted when the server cannot be asked. O3's complaint
  about a criterion is shown in its words.
- **The footer.** Add alert sends the command and waits for O3 (`Added alert named …` = success, shown and the form closes after 1.5 s; `Unknown alert reaction …`, `An alert named … already exists.` + `Unable to add alert.`, a criteria error + the same, `Access denied.` in O3's
  words; "O3 is not online (no such nick)." on a 401; "O3 did not
  answer." after 10 s); on Edit the button reads Replace alert and sends
  `delalert <name>` then `addalert …`, both verdicts reported (the add is
  skipped when the delete could not be asked). Copy command; Cancel.
  Nothing reaches O3 until Add; without X3 set, the command can be copied
  and not sent.
- **The oper's level** comes from AuthServ `accountinfo <own account>`
  (`Opserv level: N`, printed for staff), asked once per connection when
  the builder opens and the connection is logged in (`irc/alerts.ts`
  `operLevel`); unknown otherwise, and then no reaction is greyed.
- Phone layout: the builder is the page, the name/reaction/expiry stack,
  a row wraps its value under the label.
- Tests: `test/helpers/alertBuilder.ts` (rows from facts with the wide
  flags, the wide rule, command assembly with the quoting and the reason
  last, the parse-back round trip, the expiry mapping, the defaults, the
  count line), `test/irc/alerts.ts` (STATS ALERTS and TRACE PRINT from
  §7's formats verbatim, addalert's success and its two-line failures,
  delalert, replace as delete-then-add, the WHOX for the opers, the level
  from AuthServ — all quiet), `test/irc/services.ts` (the quiet echo as a
  line, an ACK and a batch; a consumed NOTICE shown nowhere, an unsolicited
  one shown; the plain line without labels), `test/helpers/verdict.ts`
  (the user's own lines left out, the earlier session kept, the verdict's
  wording). Browser: `tools/scenarios/oper-tools.mjs` opens the builder
  from the channel card — the facts as rows with the wide ones off, the
  defaults, the command assembled live and following a switch, the count
  line and Add alert both reporting O3's absence (the 401 path), Cancel —
  checks no query window was opened for a bot, and on the Alerts tab the
  New button and the folded list saying O3 is not online; desktop and
  phone.

**The snoop channel: a source and a place to click, not oper actions
(2026-10-11).** Rubin, on seeing the Opers tab fill with the snoop feed:
"When the snoop channel is defined in the network tab, you parse the
content there correctly, and let me right click on nicks and channels to
do investigations. We can leave the stream in the oper stuff for
investigate, but it doesn't need to show up as 'everything else' content,
since it isn't 'oper actions', which is what that panel is."

- **The Opers tab never counts a snoop line.** `helpers/operActivity.ts`
  `isCounted(entry)` is false for `type: "snoop"`: `actorOf` is undefined
  for one, `rollupByKind` filters them before grouping, and the rules that
  credited a snoop OPER as an oper-up and a bot's kill or mode to the
  services row are gone (`coarseKindOf` takes the entry alone now; the
  `ActivityOptions {serviceNicks}` stay for the audit lines and WALLOPS by
  a bot). `OperActivity.vue` lost its "Not in #mrsnoopy: connects and joins
  aren't kept." line — the "Not in #operserv" line with Join stays
  (`missingReport`). The cards keep saying when the snoop channel is
  missing: the channel card under Last hour here as before, and now the
  user card under Seen before ("Not in #mrsnoopy: earlier sessions aren't
  kept.", `UserModel.snoopMissing`, set with the channel card's rule in
  `startUser`).
- **AfterNET's lines parse.** Its X3 appends the cloaked host and the
  cloaked IP after the modes of a `UMODE` line when `+x` is among them,
  which the e-testnet copy the reference was read from does not; the rule
  accepts the optional pair as `cloak` / `cloakIp` — never `host` / `ip`,
  which `commonality.ts` and `verdict.ts` read from the connect, quit, kill,
  oper and auth lines and would take for a place. The format is in
  `x3-services.md` §3 and `test/irc/services/x3.ts` holds the shape with
  made-up values (two UMODEs, two connects with the empty `()` of a user
  not authed and a mixed-case server). Every other keyword's rule was run
  against the reference's shapes again; nothing else fell through.
- **The nicks a snoop line names are nicks.** `noteServicesLine` returns
  the entry it recognised — appended to the notice log for a live line
  only; a replayed one (a chathistory page after a reload, a reconnect's
  catch-up) is parsed and marked the same, since the scrollback is where an
  oper looks a nick up, but the log already has it — `snoopNicks(entry)`
  lists the `nick`, `newNick`,
  `kicker`, `killer` and `setter` fields that are not a server (a dot),
  each once, and the PRIVMSG handler passes them to `handleMessage` as a
  `FeedNote {nicks}` that are added to the message's `users` when not
  already there — so `findNames` renders them as `Username.vue` whether or
  not they are in the channel, and the nick menu (Investigate first when
  opered; `ContextMenu.vue` already stood in `{nick, modes: []}` for a nick
  outside the user list, and `operUserItems` needs only the nick) opens
  from the feed; the `#chan` in a JOIN, CREATE, PART, KICK or MODE line was
  already an `InlineChannel` with `operChannelItems`. A recognised snoop
  line is never a highlight: our own connect in the feed is the bot's
  report, not a word to us, so it raises no mention and the channel's
  unread moves as for any message in it. Audit lines are untouched.
- Tests: `test/irc/services/x3.ts` (the AfterNET shapes), `test/irc/services.ts`
  (the `users` of every keyword's line, the own-connect line without a
  highlight against the bot's chat with one, the unread and highlight
  counts, `snoopNicks`), `test/helpers/operActivity.ts` (every keyword
  counts nowhere, by oper and by kind; the audit rollup without them),
  `test/irc/investigate.ts` (the user card's `snoopMissing`). Browser:
  `tools/scenarios/oper-tools.mjs` stands a helper named `O3` in for the
  bot (the rig has no X3): it joins the configured snoop channel and posts
  the made-up AfterNET lines; the scenario checks the user card's "Not in
  #mrsnoopy" line before joining, the nicks rendered as nicks, the menu and
  Investigate from the connect line's nick (the card for a nick in no
  channel of ours, its lookups failing gracefully), the menu and
  Investigate from the JOIN line's `#chan`, no highlight on the line naming
  us, and the Opers tab with no "Not in #mrsnoopy" line and none of it in
  any row or the "Everything else" timeline — desktop and phone.

## Revised plan (rubin and Claude, 2026-10-10)

The phase-1 panel was tried on AfterNET and found busy and overwhelming:
a 20-switch snomask list with 67 route dropdowns nested under it, the
log at the bottom, every item with a paragraph. The rethink started from
what an oper actually does rather than from what the server sends, in a
back-and-forth over drawings (the mockups were published as artifacts
during the session; the decisions are recorded here).

**What rubin told us about the job.**

- Notices are a smoke detector, not reading matter: almost never looked
  at unless something is wrong or being debugged. Most of the stream is
  the network running itself. The rare kinds must land in the active
  window; the rest belong in the network window or nowhere.
- The snomask is "default and never touched" because the controls were
  unusable, not because default is right.
- Two real tasks: **watching all the opers** (not one at a time; is
  anyone making a mistake or being malicious), and **investigation**,
  which starts from a user ("is this nick the one we banned") or from a
  **channel** ("who is in there, is it command-and-control"). The usual
  steps: watch the snoop channel; `/who #chan cx`; `/check #chan`;
  `/whois nick nick`; `/check nick`; join and look; find the botmaster
  and ask nicely; else look for what the bots share and write an X3 alert
  with criteria safe for curious bystanders.
- A lot of this runs through **X3**, not the server: G-lines and alerts
  are managed in O3; `#operserv` carries what services did for opers;
  `#mrsnoopy` (X3's snoop module) is the connect/join/part/quit feed.
- Seance stays generic: nothing AfterNET-specific is assumed. Services
  support is a per-network setting.
- Phone and desktop are both first class.

**The panel, redrawn.** Three tabs, each one question:

- **Opers** — what the opers have been doing, rolled up. A period picker
  (today / 24 h / since reload) and a By oper / By kind switch. _By
  oper_: one line per oper who did anything (`alice · 13 actions · 21:14`, busiest first, an outlying total in amber); open it for
  sentences (`12 G-lines 21:02–21:14`, `1 channel mode via OPMODE`);
  open one of those for the notices themselves. Services (O3) and the
  servers get rows of their own, folded the same way. _By kind_: one line
  per kind (G-lines 22, kills 9, OPMODE modes, opers coming up, links and
  splits…), ordered by how much an oper cares, a closed "everything else
  · 1 342" row last; open a kind straight to its timeline, newest first,
  with who did each one. No counts table. Closed, the screen is five
  lines tall.
- **Alerts** — what reaches you and how loudly. Two short sections in
  plain words, _Oper actions_ (bans added or removed, ban hits, kills,
  services actions, someone opers up, failed /oper) and _The network_
  (links and splits, rehashes and restarts, WALLOPS, refused
  connections, every connect and quit), each line a three-position
  control: **Here** (the active window), **Network** (network window, no
  unread), **Off** (never; when every kind in a server family is off, the
  client also clears that snomask bit, so Off is quiet on the wire too).
  Tapping Here asks how long (today / 3 days / a week / until I change
  it); a temporary choice shows warmer with "2 more days" beside it and
  undoes itself. The ~14 kinds nobody cares about are one folded row;
  the raw mask number and the presets are another. The server's 28
  flavours of "server event" are merged into these lines in code and
  never shown individually. The same "show here for…" menu opens from a
  notice's badge in chat and in the log, so routing is changed from the
  notice that annoyed you.
- **Me** — one line of status (`Global operator · +owsgxzb`), the
  privileges as a folded chip list, the user modes as a small grid with
  the explanation on hover or long press. Rubin wonders whether a
  non-oper version belongs in Settings; circle back later.

**Services support.** A section at the bottom of the network's edit form,
shown once connected and opered there: a package picker (_None_, _X3_;
others by contribution, like ircds) and the bots by role, prefilled with
the package's conventional names when picked — oper service `O3`, account
service `AuthServ`, channel service `ChanServ`, oper report channel
`#operserv`, snoop channel `#mrsnoopy` — with a liveness check (a
`/whois` on each; X3's bots carry `+k` and answer CTCP VERSION with `X3 2.0+[…]`). With X3 selected: the snoop feed and the audit lines in the
report channel are parsed like server notices (`docs/resources/x3- services.md`) and feed Opers and Alerts, credited to the person who typed
the command rather than to the bot; the ban dialog sends through O3; the
cards ask O3 and AuthServ for what the server does not know. **Graceful
degradation**: when the client is not in the snoop or report channel,
everything shows what it can from server notices and the client's own
view, says in one grey line what the channel would add, and offers a
Join button for the report channel only (not everyone is allowed in the
snoop channel).

**The channel card** (from any channel name: a snoop line, the sidebar,
a notice, `/check #chan`): the channel's facts (created, from O3
`chaninfo`; modes and topic from `check`; registered, from ChanServ;
bans); **what most users have in common** (the card compares every user
to every other on the fields X3 can alert on — authed, connect age,
realname, ident shape, IP range, server, version — and says "8 of 9
users: not authed, connected < 15 min, realname 'irc client', ident
r + 4 digits, 203.0.113.\*", with an **Alert on this…** button); the
users as three-line blocks (nick, flags, timing; ident@host and real IP;
realname, account, country, where else they are) with the shared values
tinted so the pattern reads down the list and the odd one out stands
out by being plain; the last hour in the channel from the snoop feed,
folded; Join & watch, Note, Refresh. Wire cost: `check` + `who` +
`chaninfo`, then one O3 `whois` per user, paced for fake lag; the card
fills in facts first, countries last.

**The alert builder** (from the channel or user card's button, or empty
from the Alerts tab, or on an existing alert from `stats alerts`): O3's
`addalert` as a form. Name, reaction (notice by default; gline/kill/shun
greyed unless the O3 level allows), expiry (a week); the shared facts
arrive as criteria rows, each with its value editable in place, a switch
to leave it out and ✕ to drop it; criteria that would catch bystanders on
their own (IP range, connect age, server) are marked **wide** and arrive
switched off; an "add" row for nick, host, version, account, clones,
modes, regex; the exact command updated live; and **"Matches N users
right now · none are opers"** from a `trace print` of the same criteria
before anything is sent. Nothing reaches O3 until Add; O3's reply lands
under the form. O3 has no edit, so editing is delete and re-add in one
go.

**The user card** (from any nick or `/check nick`): who they are on one
screen (host, real IP with country and server, account, realname,
connected and nick age, client version, modes, channels; each line as
its answer arrives, "asking…" meanwhile; AuthServ's last-quit host and
hostmasks when authed); **bans near this user** (`stats glines` and O3
`gtrace` with the host as a subset, live and recently expired); **seen
before**, a local search over the kept feed for anything sharing this
IP, host, realname or account; a one-sentence verdict naming what
matched, with **Compare side by side** (two cards as two columns, the
matching rows tinted); G-line / Kill / Alert on this / Note / Raw
replies.

**Build order** (each usable on its own, on top of PR #99):

1. The panel restructure: Opers, Alerts, Me, tap-the-badge routing. Needs
   no X3. — done 2026-10-10.
2. Services support: the setting, the snoop and audit parsers, bans
   through O3. — done 2026-10-10.
3. The channel and user cards. — done 2026-10-10.
4. The alert builder. — done 2026-10-11.

All four are in "Built" above; what follows is what comes next.

The phase-2/3 list that stood here before (Bans, Users, Network and
Server tabs; burst alerts; help and completion; raw console; channel
oper tools; mass messages; oper-tag badges; bouncer admin) is not
abandoned, but none of it comes before these four.

**How to work on this with rubin** (so the next session does not repeat
the mistake): one thing at a time, drawn, with pros and cons, and a
single question; a multiple-choice prompt is not a conversation.

## Testing

- **Unit tests.** The parsers are Vue-free and run under mocha, with fixtures taken verbatim from the captures:
  - CHECK (user, channel, hostmask) and STATS rows per letter;
  - the notice classifier, plus the routing defaults and overrides;
  - snomask arithmetic, GLINE list state tokens, mask-width validation;
  - the #119/#120 tolerance in `request.ts`.
- **Dev rig changes.** The Operator block lacks GLINE, SHUN, ZLINE, REMOVE and SET (the capture got 481 for GLINE/SHUN/ZLINE). It needs:

  - those privileges, granted explicitly;
  - `CONNEXIT_NOTICES = TRUE`, so connect, exit and nick notices exist;
  - a rebuild past `ead82a8`, so a stray non-oper `STATS webpush` cannot abort the server.

  `tools/scenarios/lib/rig-feature.mjs` can flip features per scenario.

- **Multi-server.** MAP/LINKS trees, net break notices and remote CHECK need more than one server: use the AfterNET e-testnet (two or more servers with X3).
- **Browser scenarios.**
  - The oper button: present only when opered; its spacing measured by `network-panel.mjs` at every font step.
  - The modal at desktop and 390px widths.
  - Notice routing: an important notice shows in a channel; a routine one stays in the lobby without unread.
  - Snomask apply and read-back.
  - Ban add with preview.
  - A CHECK card at phone width.

## Decided (rubin, 2026-10-09)

- **No dedicated windows.** Important notices and WALLOPS go to the active window; routine ones go to the network window; everything else oper-related lives in the oper modal.
- **The oper panel** is a button right of the network's join `+` that opens a Settings-style modal. The button is **hidden when not opered**.
- **The default routing table** above ships as is; adjust it if something proves annoying.
- **Notices are kept in browser storage** (IndexedDB) and restored on page load, because an Android PWA is discarded whenever the user switches away.
- **No oper-on-connect and no stored OPER password.** Opers are granted by services on SASL login; the existing on-connect commands remain for anyone who wants `/oper`.
- **Ship the regex classifier** against the server as it is. The nefarious capability asks are parked (above), to be revisited.
- **Other ircds by contribution only.** The profile interface is the extension point; Unreal is the likeliest first PR.

## Open questions

- **How far back "seen before" should reach, and where it lives.** The
  notice log keeps about a day; ban evasion plays out over weeks. The
  default until rubin says otherwise: a week, in the browser (so per
  device). Whether the oper team needs it shared is unanswered.
- **Me for non-opers.** Whether a version of the Me tab (user modes, the
  account) belongs in Settings for everyone.
- **The X3 lines are per-network config.** X3 does not tag an override in
  words; which channel a line went to is the only signal, which is why the
  report and snoop channels are fields rather than detected.
- **The builder's "none are opers" costs a WHO.** X3 2.0's `trace print`
  prints no flags, so the opers among the matches come from one WHOX on
  the server (the first 20 nicks) after every count. If O3 ever marks
  opers in its output (or `trace print` is given a flags column), the
  WHO goes. Also unanswered: whether the oper's O3 level should be read
  from `accountinfo` on open (as now, once per connection) or offered as
  a field in Services support.
