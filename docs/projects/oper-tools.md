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

- **The mode is the signal, not 381.** On AfterNET, opers are granted by services (X3) on SASL login, so there may be no `OPER` and no 381; a bouncer resume reapplies oper silently too. Oper state therefore keys off the own-mode change, whoever sets it, and on registration a saved network that was opered re-queries 221 and PRIVS.
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
| **2. Management**  | Bans tab with impact preview and the notice-fed setter column; Users tab (oper WHO); Network tab; help and completion; burst alerts                                                                                                                                                                                         |
| **3. Reach**       | Server tab and admin actions; raw console; channel oper tools; mass message; oper-tag badges; then the parked server-side asks. Other ircds' profiles by contribution.                                                                                                                                                      |

## Built (phases 0 and 1, 2026-10-09)

**Foundations.**

- Server profiles (`client/js/irc/profiles/`): `nefarious2`, detected by `+Nefarious(` in 004, and the `generic` fallback.
- `OperState` (`irc/oper.ts`), dispatched as `oper:state`.
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
- **The rig grants its oper the ban privileges.** `tools/nefarious-dev/local.conf` grants gline, shun, zline, remove and set explicitly, and turns on `CONNEXIT_NOTICES`.

**Not yet** (phases 2 and 3):

- the Bans, Users, Network and Server tabs;
- burst alerts and notification rules;
- command help and completion;
- the raw console, channel oper tools, mass messages, oper-tag badges and bouncer admin.

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

None at the moment. The next step is phase 0.
