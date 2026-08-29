# nefarious2 WebSocket binding

Status of plan item 0.1 (see `docs/projects/initial_conversion.md`). Written 2026-08-24 from source, not from a live server.

## Headline

**The nefarious2 `master` branch has no WebSocket support.** Neither the local checkout at `/home/rubin/src/nefarious2` (master, `0487306`, plus `rubin-dockerify`) nor upstream `evilnet/nefarious2` master (`919e035`, 2026-05-29) contains any HTTP-upgrade or WebSocket code. Issue [#62 "WebSockets Support"](https://github.com/evilnet/nefarious2/issues/62) has been open since 2020-12-30.

**The implementation exists on the upstream branch `ircv3.2-upgrade`** (MrLenin). It was submitted as [PR #84 "feat: IRCv3.2+ capability implementations"](https://github.com/evilnet/nefarious2/pull/84) on 2026-01-01, and closed _unmerged_ on 2026-01-21, but the branch is still pushed to the `evilnet` remote and has kept moving:

| Ref                                      | Head      | Date       | Notes                                                                          |
| ---------------------------------------- | --------- | ---------- | ------------------------------------------------------------------------------ |
| `evilnet/nefarious2` `master`            | `919e035` | 2026-05-29 | No WS, no IRCv3.2 caps                                                         |
| `evilnet/nefarious2` `ircv3.2-upgrade`   | `3868b34` | 2026-06-28 | 540 commits ahead of master; identical to `MrLenin/nefarious2:ircv3.2-upgrade` |
| `MrLenin/nefarious2` `ircv3.2-hardening` | `177caf7` | 2026-07-29 | 71 commits ahead of `ircv3.2-upgrade`; presumably the next thing to land       |

The branch bundles far more than WebSocket: CAP 302, `message-tags`, `server-time`, `batch`, `labeled-response`, `draft/chathistory` (RocksDB-backed), `draft/metadata-2`, a bouncer mode, SASL via Keycloak, etc. It is a large divergence from master and requires extra build deps (librocksdb, libzstd, libcmocka, libkc). **Seance must target this branch (or its successor), not master** — nothing in the plan's required CAP list beyond the four ircu-era caps exists on master.

A shallow clone of the branch used for this write-up is at `/tmp/claude-1000/-home-rubin-src-seance/c805fdb5-4a0f-45ed-ba8a-2e6262e93a31/scratchpad/nef-ircv3` (scratch; will disappear). Line numbers below marked **[br]** refer to `ircv3.2-upgrade@3868b34`; those marked **[master]** refer to the local master checkout.

## WebSocket transport (as implemented on `ircv3.2-upgrade`)

Core files: `include/websocket.h` (77 lines), `ircd/websocket.c` (682 lines), plus integration in `ircd/s_bsd.c`, `ircd/packet.c`, `ircd/listener.c`, `ircd/ircd_parser.y`.

### Listener configuration (`ircd.conf`)

```
Port {
     port = 8443;
     ssl = yes;
     websocket = yes;       # yes | no | autodetect
};
```

- Grammar: `ircd/ircd_parser.y:1122-1134` **[br]**. `websocket = autodetect;` makes the port sniff the first 4 bytes for `GET ` and fall back to plain IRC otherwise (`ircd/s_bsd.c:1032-1062`). `paste` and `websocket` cannot share a port (`ircd_parser.y:1008-1011`).
- Listener flags `LISTEN_WEBSOCKET` / `LISTEN_WEBSOCKET_AUTO`: `include/listener.h:57-60`.
- Feature flags (`ircd/ircd_features.c:1267-1269`): `WEBSOCKET` (bool, **default TRUE**), `DRAFT_WEBSOCKET` (alias), `WEBSOCKET_ORIGIN` (string, **default empty = allow all origins**).
- The docker template on the branch already opens `8443 ssl websocket` (`tools/docker/base.conf-dist:122-127`).

### URL shape

- **Path is ignored.** The handshake parser only checks that the request starts with `GET ` (`ircd/websocket.c:139`); it never looks at the request-target or `Host`. So `wss://host:8443/`, `/irc`, `/anything` all work. Pick `/` and keep a configurable path in the client anyway for reverse-proxy setups.
- Required request headers (`websocket.c:149-179`, `:219`): `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`. Browsers always send these.
- **Subprotocol** (`websocket.c:184-195`, `:232-254`): recognises `text.ircv3.net` and `binary.ircv3.net`, picks whichever appears first in the client's `Sec-WebSocket-Protocol` list. If the client offers neither, the server omits `Sec-WebSocket-Protocol` from the 101 and auto-detects text/binary from the first data frame (`:423-429`, `s_bsd.c:1206-1213`). **Seance should offer `["text.ircv3.net", "binary.ircv3.net"]` in that order** and check `ws.protocol` after open.
- **Origin** (`websocket.c:256-341`): if `WEBSOCKET_ORIGIN` is empty or `*`, anything (including no Origin header) is accepted. Otherwise the value is a space/comma separated list of exact origins or `*.suffix` wildcards; a missing Origin header is rejected; rejection is an HTTP `403 Origin forbidden` before close. Networks deploying Seance will set this to their web origin; native/Electron builds send no Origin, so ops must leave it empty or the browser origin list must include whatever the packaged app sends.

### TLS

- Compile time: `websocket_handshake()` is a hard `return -1` when the ircd is built without OpenSSL (`websocket.c:351`, `:438-441`) because SHA-1/Base64 come from OpenSSL. So the ircd must be built with `USE_SSL`, but
- Run time: WebSocket works on **both** `ssl = yes` and plain ports — the handshake and frame writers branch on `cli_socket(cptr).ssl` (`websocket.c:398-412`, `s_bsd.c:398-416`). `ws://` on a plain port is fine for local dev; production is `wss://`.
- Certificate: standard `SSL_CERTFILE`/`SSL_KEYFILE` features (`doc/readme.features:1666-1672`). Self-signed for dev; see `nefarious2-dev.md`.
- `sts` cap is defined but `CAPFL_PROHIBIT` and default-off (`include/capab.h`, `ircd_features.c:1307`); `STS_PORT` default 6697 (`:1308`). Not relevant over WS.
- **Client-certificate request breaks Chromium** (found 2026-08-27 against Fractal:9998, fixed by PR #101): `ssl_init_server_ctx()` sets `SSL_VERIFY_PEER` for certfp, so every TLS listener sends a CertificateRequest. Firefox continues without a cert; **Chrome/Edge cancel JS-initiated WebSocket handshakes outright** ("WebSocket opening handshake was canceled") because there is no certificate picker for WebSockets. Upstream PR #101 fixes both port kinds: `websocket = yes` listeners never send the request (per-connection `SSL_set_verify(SSL_VERIFY_NONE)`, the paste listener's existing workaround), and `websocket = autodetect` listeners use an OpenSSL ≥ 1.1.1 ClientHello callback to spot browsers by their ALPN extension (browsers always send `http/1.1`; native IRC clients essentially never send ALPN) and skip the request only for those handshakes — certfp keeps working for IRC clients sharing the port. Dev testbed: port 8444 is `ssl = yes; websocket = autodetect;` (`openssl s_client -connect localhost:8444` sees the CertificateRequest, `-alpn http/1.1` does not). Note the config keyword is `autodetect`, not `auto`.

### Framing rules

Server to client (`ircd/s_bsd.c:328-430`):

- The sendq is split on `\r\n`; **each IRC line becomes one WebSocket message, CRLF stripped** (`:354-378`). Matches the IRCv3 spec.
- Text mode (subprotocol `text.ircv3.net` or auto-detected text): payload is validated as UTF-8 and invalid bytes are replaced with U+FFFD before sending (`:380-386`). Binary mode sends raw bytes.
- Server frames are unmasked, FIN set, single fragment (`websocket.c:574-608`). Max line = `FULL_MSG_SIZE` = 8191 tag bytes + 512 (`include/ircd_defs.h:108-112`).
- **Nothing is sent until the handshake completes** (`s_bsd.c:322-325`); output is queued.

Client to server (`ircd/s_bsd.c:1118-1260`, `websocket.c:460-565`):

- Frames MUST be masked (browsers do this), RSV bits must be 0, reserved opcodes and control frames > 125 bytes are protocol errors → disconnect with `WebSocket frame error`.
- The server appends `\n` to each data payload before pushing it into the normal line parser (`s_bsd.c:1243-1246`), so **do not send CRLF**; a trailing CRLF is tolerated (last byte already `\n`). Several lines in one frame would technically parse but violates the spec — send one line per `ws.send()`.
- Fragmented messages (FIN=0 + continuation) are reassembled up to 16384 bytes (`:1178-1200`).
- Text frames with invalid UTF-8 are sanitised to U+FFFD, not rejected (`:1233-1240`); reassembled fragments with invalid UTF-8 _are_ rejected (`:1193-1197`).
- After decode, `recv_classify()` enforces client caps of tags ≤ 4095 bytes and message ≤ `FULL_MSG_SIZE` (`include/recv_classify.h:25-37`); overrun = `Excess Flood` disconnect.
- **Bug to report upstream — inbound frame size is capped at 527 bytes.** `websocket_decode_frame()` allows up to `WS_MAX_PAYLOAD` (16384, `websocket.c:67`) but is called with a stack buffer `ws_payload[BUFSIZE + 16]` = 528 bytes (`s_bsd.c:1126`) and rejects any frame whose payload length ≥ buffer size (`websocket.c:551-554`). Any single frame or fragment of ≥ 528 bytes therefore kills the connection with `WebSocket frame error`. Browsers do not let a page control fragmentation, so **Seance must keep every outbound line under ~500 bytes** (tags included) until this is fixed. Ordinary PRIVMSG/TAGMSG lines fit, and a `draft/multiline` batch is one ordinary line per message line, so it fits too; big client-tag payloads will not.
- WS-level PING from the client is answered with PONG; CLOSE is echoed with the same status code (`websocket.c:637-682`). The server never initiates WS pings — liveness is IRC `PING` as usual, plus whatever keepalive the client wants.

### What the client should implement

1. `new WebSocket(url, ["text.ircv3.net", "binary.ircv3.net"])`; `binaryType = "arraybuffer"`; treat a binary frame as UTF-8 anyway.
2. One IRC line per `send()`, no CRLF, length-guarded at ~500 bytes for now.
3. On `message`, strip any trailing CR/LF defensively and hand the line to the parser. Do not assume one line per frame on the inbound side either (cheap to split).
4. Reconnect logic is the client's job; the server has no resume token outside the `draft/bouncer` / `draft/persistence` caps on this branch, which are out of scope for phase 0.

## CAP set

### Master (local checkout)

`include/capab.h:42-49` / `ircd/m_cap.c:58-67` **[master]** advertise exactly: `multi-prefix`, `userhost-in-names`, `extended-join`, `away-notify`, `account-notify`, `sasl`, `tls` (if built with SSL). There is no CAP 302 handling: `cap_ls()` ignores its argument (`m_cap.c:212-218`), so `CAP LS 302` returns a single unversioned line with no values and no `*` continuation. `cap-notify`, `CAP NEW/DEL` do not exist.

### `ircv3.2-upgrade` branch

`include/capab.h` enum and `ircd/m_cap.c:321-356` **[br]**; runtime enable flags `ircd/ircd_features.c:1178-1210`, `:1302-1307`. CAP 302 is implemented (`m_cap.c:498-600`) with values for `sasl` (mechanism list), `draft/multiline`, `draft/webpush`, `draft/chathistory` (bare integer), `sts`.

| CAP                              | master | `ircv3.2-upgrade`                                   | Evidence [br]                                                             | Seance                                                                                                                     |
| -------------------------------- | ------ | --------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `multi-prefix`                   | yes    | yes (default on)                                    | `m_cap.c:322`, `ircd_features.c:1178`                                     | require                                                                                                                    |
| `userhost-in-names`              | yes    | yes (default on)                                    | `m_cap.c:323`, `ircd_features.c:1179`                                     | require                                                                                                                    |
| `extended-join`                  | yes    | yes (default on)                                    | `m_cap.c:324`, `ircd_features.c:1180`                                     | require                                                                                                                    |
| `away-notify`                    | yes    | yes (default on)                                    | `m_cap.c:325`, `ircd_features.c:1181`                                     | require                                                                                                                    |
| `account-notify`                 | yes    | yes (default on)                                    | `m_cap.c:326`, `ircd_features.c:1182`                                     | request (not in plan list, but needed to track logins)                                                                     |
| `sasl`                           | yes    | yes; 302 value = mech list                          | `m_cap.c:327`, `:522-526`; `ircd/m_authenticate.c`                        | request; PLAIN at least. On master SASL is relayed to services (X3/iauthd), so a services link is needed for it to succeed |
| `cap-notify`                     | no     | yes (default on)                                    | `m_cap.c:328`, `ircd_features.c:1184`, `capab.h` `send_cap_notify`        | request                                                                                                                    |
| `server-time`                    | no     | yes (default on)                                    | `m_cap.c:329`, `ircd_features.c:1185`                                     | require                                                                                                                    |
| `echo-message`                   | no     | yes (default on)                                    | `m_cap.c:330`, `ircd_features.c:1186`                                     | require                                                                                                                    |
| `account-tag`                    | no     | yes (default on)                                    | `m_cap.c:331`, `ircd_features.c:1187`                                     | require                                                                                                                    |
| `chghost`                        | no     | yes (default on)                                    | `m_cap.c:332`, `ircd_features.c:1188`                                     | require                                                                                                                    |
| `invite-notify`                  | no     | yes (default on)                                    | `m_cap.c:333`, `ircd_features.c:1189`                                     | request (nice-to-have)                                                                                                     |
| `labeled-response`               | no     | yes (default on)                                    | `m_cap.c:334`, `ircd_features.c:1190`                                     | require                                                                                                                    |
| `batch`                          | no     | yes (default on)                                    | `m_cap.c:335`, `ircd_features.c:1191`, `ircd/m_batch.c`                   | require                                                                                                                    |
| `setname`                        | no     | yes (default on)                                    | `m_cap.c:336`, `ircd_features.c:1192`, `ircd/m_setname.c`                 | require                                                                                                                    |
| `standard-replies`               | no     | yes (default on)                                    | `m_cap.c:337`, `ircd_features.c:1194`                                     | request; parse FAIL/WARN/NOTE                                                                                              |
| `message-tags`                   | no     | yes (default on)                                    | `m_cap.c:338`, `ircd_features.c:1195`, `ircd/m_tagmsg.c`                  | require                                                                                                                    |
| `no-implicit-names` (+ `draft/`) | no     | yes (default on)                                    | `m_cap.c:339-340`, `ircd_features.c:1197`                                 | optional                                                                                                                   |
| `draft/extended-isupport`        | no     | yes (default on)                                    | `m_cap.c:341`, `ircd/m_isupport.c`                                        | optional                                                                                                                   |
| `draft/pre-away`                 | no     | yes (default on)                                    | `m_cap.c:342`, `ircd_features.c:1200`                                     | optional                                                                                                                   |
| `draft/multiline`                | no     | yes (default on); 302 value `max-bytes=,max-lines=` | `m_cap.c:343`, `:527-531`, `ircd/m_batch.c`                               | **requested**; one line per frame, so the 500-byte cap still holds (`client/js/irc/multiline.ts`)                          |
| `draft/chathistory`              | no     | yes (default on); 302 value = int                   | `m_cap.c:344`, `:537-541`, `ircd/m_chathistory.c`, `ircd_features.c:1202` | request; degrade gracefully. ISUPPORT `CHATHISTORY=<n>` and `MSGREFTYPES=timestamp,msgid` (`s_user.c:3307-3308`)           |
| `draft/event-playback`           | no     | yes (**default off**)                               | `m_cap.c:345`, `ircd_features.c:1203`                                     | request if offered                                                                                                         |
| `draft/message-redaction`        | no     | yes (default off)                                   | `m_cap.c:346`, `ircd_features.c:1204`, `ircd/m_redact.c`                  | optional                                                                                                                   |
| `draft/account-registration`     | no     | yes (default off)                                   | `m_cap.c:347`, `ircd_features.c:1205`, `ircd/m_register.c`                | optional                                                                                                                   |
| `draft/read-marker`              | no     | yes (default off)                                   | `m_cap.c:348`, `ircd_features.c:1207`, `ircd/m_markread.c`                | optional                                                                                                                   |
| `draft/channel-rename`           | no     | yes (default off)                                   | `m_cap.c:349`, `ircd_features.c:1208`, `ircd/m_rename.c`                  | optional                                                                                                                   |
| `draft/metadata-2`               | no     | yes (default off; docker conf turns on)             | `m_cap.c:350`, `ircd_features.c:1209`, `ircd/m_metadata.c`                | optional                                                                                                                   |
| `draft/webpush`                  | no     | yes (default off; needs VAPID from services)        | `m_cap.c:351`, `:532-536`, `ircd/m_webpush.c`                             | later; replaces TheLounge's server-side webpush                                                                            |
| `draft/bouncer`                  | no     | yes (default on)                                    | `m_cap.c:352`, `ircd_features.c:1302`, `ircd/m_bouncer.c`                 | not requested; see § Session persistence                                                                                   |
| `draft/persistence`              | no     | yes (default on)                                    | `m_cap.c:353`, `ircd_features.c:1303`, `ircd/m_persistence.c`             | **requested**; see § Session persistence                                                                                   |
| `tls`                            | yes    | yes                                                 | `m_cap.c:355`; STARTTLS `ircd/m_starttls.c` (also on master)              | never over WS                                                                                                              |
| `sts`                            | no     | yes (prohibited, default off)                       | `m_cap.c:356`, `ircd_features.c:1307`                                     | ignore                                                                                                                     |

Every cap in the plan's list (`server-time`, `message-tags`, `account-tag`, `echo-message`, `away-notify`, `chghost`, `extended-join`, `multi-prefix`, `userhost-in-names`, `setname`, `cap-notify`, `batch`, `labeled-response`, `draft/chathistory`, `draft/event-playback`) is present on the branch. Only `draft/event-playback` is off by default and must be enabled in `Features {}`. All caps are individually toggleable via `"CAP_<name>" = "TRUE|FALSE"` features and, when toggled at rehash, trigger `CAP NEW`/`CAP DEL` to `cap-notify` clients (`m_cap.c:56-160`) — so the client must handle caps disappearing at runtime.

## nefarious2 quirks the client must tolerate

nefarious2 is an ircu2 (P10) descendant with Asuka/QuakeNet, Unreal and Nefarious-specific additions. Everything below applies to master unless marked [br]; the branch is a superset.

### ISUPPORT (005)

`init_isupport()` in `ircd/s_user.c:2466-2532` **[master]**, `:3200-3316` **[br]**; `ircd/ircd_features.c` re-emits some tokens on rehash. The 005 lines are rebuilt lazily, 13 tokens per line (`build_isupport_lines`, `s_user.c:2395-2460`).

| Token                                                                                                                               | Notes                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHOX`                                                                                                                              | Extended WHO (`WHO mask %fields,querytype`), reply numeric **354**. See `doc/readme.who`. Use `WHO #chan %tcuihnfar,<token>` to get account names.                                                                                                         |
| `WALLCHOPS`, `WALLHOPS`, `WALLVOICES`                                                                                               | `@#chan`, `%#chan`, `+#chan` targets. Also `STATUSMSG=@+` or `@%+`.                                                                                                                                                                                        |
| `USERIP`, `CPRIVMSG`, `CNOTICE`                                                                                                     | ircu commands. `CPRIVMSG nick #chan :msg` bypasses target throttling — useful for a client that may hit `ERR_TARGETTOOFAST` (439).                                                                                                                         |
| `NAMESX`, `UHNAMES`                                                                                                                 | Legacy names for `multi-prefix` / `userhost-in-names`; ignore, use CAP.                                                                                                                                                                                    |
| `SILENCE=n`, `WATCH=n`                                                                                                              | ircu SILENCE (numerics 271/272/511) and WATCH; branch adds `MONITOR=n` (`s_user.c:3233` [br], `ircd/m_monitor.c`). Master has **no MONITOR**.                                                                                                              |
| `MODES`, `MAXCHANNELS`, `MAXBANS`, `NICKLEN`, `MAXNICKLEN`, `TOPICLEN`, `AWAYLEN`, `KICKLEN`, `CHANNELLEN`, `MAXCHANNELLEN`         | Both `NICKLEN` (runtime) and `MAXNICKLEN` (compile-time) are sent; honour `NICKLEN`.                                                                                                                                                                       |
| `CHANTYPES=#` or `#&`                                                                                                               | `&` only if `LOCAL_CHANNELS`.                                                                                                                                                                                                                              |
| `PREFIX=(ov)@+` or `(ohv)@%+`                                                                                                       | Halfops are a feature flag (`HALFOPS`).                                                                                                                                                                                                                    |
| `BOT=B`                                                                                                                             | Bot usermode is `+B`; WHOIS shows 335.                                                                                                                                                                                                                     |
| `CHANMODES=b[e],[A]k[U],Ll,aCcDdiMmNnOpQRrSsTtZz`                                                                                   | Built at `s_user.c:2480-2483` [master]. `A`/`U` (apass/upass) only with `OPLEVELS`. `L` = redirect, `l` = limit, `D`/`d` = delayed join, `z` persistent, `Z` SSL-only, `T` no multi-target, `S` strip colours, `Q` no quit/part msgs. See `doc/modes.txt`. |
| `EXCEPTS=e`, `MAXEXCEPTS`                                                                                                           | Only if `EXCEPTS` feature.                                                                                                                                                                                                                                 |
| `EXTBANS=~,acjnqr` [master] / **`EXTBAN=~,...`** [br]                                                                               | Token name **changed** between master (`s_user.c:2519`) and branch (`s_user.c:3274`). Format `~<type>:<value>`, nestable (`~q:~a:account`). See `doc/extendedbans.txt`. Parse both spellings.                                                              |
| `CASEMAPPING=rfc1459`                                                                                                               |                                                                                                                                                                                                                                                            |
| `NETWORK=<name>`, `MAXLIST=b:n[,e:n]`, `ELIST=CT`                                                                                   |                                                                                                                                                                                                                                                            |
| `TARGMAX=...`, `UTF8ONLY`, `draft/ICON=<url>`, `CLIENTTAGDENY=...`, `CHATHISTORY=<n>`, `MSGREFTYPES=timestamp,msgid`, `VAPID=<key>` | Branch only (`s_user.c:3280-3316` [br], `m_webpush.c:631`).                                                                                                                                                                                                |

No `LINELEN`, no `MAXTARGETS`, no `INVEX`, no `SAFELIST`. Do not assume `NICKLEN`-free clients.

### Numerics

`include/numeric.h` / `ircd/s_err.c` **[master]**. Non-RFC numerics the client will actually see:

| Numeric     | Name                                                                                | Format (`s_err.c`)                                                                                        | When                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 008         | `RPL_SNOMASK`                                                                       | `%u :: Server notice mask (%#x)`                                                                          | Oper snomask                                                                                               |
| 010         | `RPL_BOUNCE`                                                                        | `%s %u :Please use this Server/Port instead`                                                              | Redirect; ignore                                                                                           |
| 015-017     | `RPL_MAP*`                                                                          |                                                                                                           | `/MAP`                                                                                                     |
| 030-032     | `RPL_APASSWARN_*`                                                                   | Long multi-sentence warnings                                                                              | Channel +A/+U (oplevels)                                                                                   |
| 270         | `RPL_PRIVS`                                                                         |                                                                                                           | Oper privs                                                                                                 |
| 271/272     | `RPL_SILELIST` / end                                                                |                                                                                                           | `/SILENCE`                                                                                                 |
| 286-292     | `RPL_CHKHEAD`, `RPL_CHANUSER`, `RPL_DATASTR`, `RPL_ENDOFCHECK`, `ERR_SEARCHNOMATCH` | free text                                                                                                 | Oper `/CHECK` output; treat 290 as plain text                                                              |
| 310         | `RPL_WHOISSERVICE`                                                                  | `%s :%s`                                                                                                  | WHOIS of a +k service                                                                                      |
| 316         | `RPL_WHOISPRIVDEAF`                                                                 | `%s :does not accept private messages`                                                                    | WHOIS of +D                                                                                                |
| 320         | `RPL_WHOISSPECIAL`                                                                  | `%s :%s`                                                                                                  | Free-text WHOIS line (also used for +r "is a registered nick")                                             |
| 325         | `RPL_WHOISWEBIRC`                                                                   | `%s :is connected via %s`                                                                                 |                                                                                                            |
| 330         | `RPL_WHOISACCOUNT`                                                                  | `%s %s :is logged in as`                                                                                  | Standard                                                                                                   |
| 333         | `RPL_TOPICWHOTIME`                                                                  |                                                                                                           | Standard                                                                                                   |
| 335         | `RPL_WHOISBOT`                                                                      | `%s :is a bot`                                                                                            | +B                                                                                                         |
| 338         | `RPL_WHOISACTUALLY`                                                                 | `%s %s@%s %s :Actual user@host, Actual IP`                                                                | Opers / self                                                                                               |
| 339         | `RPL_WHOISMARKS`                                                                    | `%s :is marked: %s`                                                                                       | Nefarious marks                                                                                            |
| 343         | `RPL_WHOISKILL`                                                                     |                                                                                                           |                                                                                                            |
| 345         | `RPL_ISSUEDINVITE`                                                                  |                                                                                                           | ircu invite ack                                                                                            |
| 348/349     | `RPL_EXCEPTLIST` / end                                                              |                                                                                                           | +e list                                                                                                    |
| **354**     | `RPL_WHOSPCRPL`                                                                     | `%s` (fields per `%` spec)                                                                                | WHOX reply — parse by the field order you requested                                                        |
| 355         | `RPL_DELNAMREPLY`                                                                   | like 353                                                                                                  | NAMES of delayed-join (+D) members                                                                         |
| 386-388     | `RPL_IRCOPS*`                                                                       |                                                                                                           | `/IRCOPS`                                                                                                  |
| **396**     | `RPL_HOSTHIDDEN`                                                                    | `%s :is now your%s host`                                                                                  | After `MODE +x` / login; **the client's own displayed host changes**                                       |
| 410         | `ERR_UNKNOWNCAPCMD`                                                                 | `%s :Unknown CAP subcommand`                                                                              | Unknown CAP subcommand. Note that on master the `302` argument to `CAP LS` is simply ignored, not rejected |
| 437/438/439 | `ERR_BANNICKCHANGE`, `ERR_NICKTOOFAST`, `ERR_TARGETTOOFAST`                         |                                                                                                           | ircu throttles; 439 means "wait N seconds" — the client should retry or use CPRIVMSG                       |
| 469         | `ERR_SSLONLYCHAN`                                                                   | `%s :Cannot join channel (+Z)`                                                                            |                                                                                                            |
| 470         | `ERR_OPERONLYCHAN`                                                                  |                                                                                                           |                                                                                                            |
| 477         | `ERR_NEEDREGGEDNICK`                                                                | `%s :Cannot join channel (+r): this channel requires authentication -- you can obtain an account from %s` |                                                                                                            |
| 480         | `ERR_ADMINONLYCHAN`                                                                 |                                                                                                           |                                                                                                            |
| 484         | `ERR_ISCHANSERVICE`                                                                 | `%s %s :Cannot kill, kick or deop %s`                                                                     |                                                                                                            |
| 485         | `ERR_COMMONCHANSONLY`                                                               | `%s :You must share at least one channel with this user in order to %s them`                              | Target is +q                                                                                               |
| 486         | `ERR_ACCOUNTONLY`                                                                   | `%s :You need to login to services to %s %s`                                                              | Target is +R                                                                                               |
| 487         | `ERR_PRIVDEAF`                                                                      | `%s :%s to '%s' not delivered: User does not accept private messages`                                     | Target is +D                                                                                               |
| 488         | `ERR_EXCEPTLISTFULL`                                                                |                                                                                                           |                                                                                                            |
| 490         | `ERR_LINKSET`                                                                       |                                                                                                           | +L redirect                                                                                                |
| 511         | `ERR_SILELISTFULL`                                                                  |                                                                                                           |                                                                                                            |
| 512         | `ERR_TOOMANYWATCH`                                                                  |                                                                                                           |                                                                                                            |
| 517         | `ERR_DISABLED`                                                                      |                                                                                                           | Command disabled by feature                                                                                |
| 524         | `ERR_QUARANTINED`                                                                   |                                                                                                           | Channel is quarantined                                                                                     |
| 530/531     | `ERR_BADHOSTMASK`, `ERR_HOSTUNAVAIL`                                                |                                                                                                           | SETHOST                                                                                                    |
| 532         | `ERR_SSLCLIFP`                                                                      |                                                                                                           | Cert fingerprint mismatch                                                                                  |
| 546-552     | Z-line and link errors                                                              |                                                                                                           | Oper / +L                                                                                                  |
| 560/561     | `ERR_NOTLOWEROPLEVEL`, `ERR_NOTMANAGER`                                             |                                                                                                           | Oplevels                                                                                                   |
| 616         | `RPL_WHOISSSLFP`                                                                    | `%s :has client certificate fingerprint %s`                                                               |                                                                                                            |
| 670/691     | `RPL_STARTTLS` / `ERR_STARTTLS`                                                     |                                                                                                           | Never over WS                                                                                              |
| 671         | `RPL_WHOISSSL`                                                                      | `%s :is connected via SSL`                                                                                | Not 275                                                                                                    |
| 900-904     | `RPL_LOGGEDIN` etc.                                                                 | Standard SASL numerics                                                                                    |                                                                                                            |

Branch additions include `FAIL`/`WARN`/`NOTE` (standard-replies), `BATCH`, `CHATHISTORY`, `TAGMSG`, `SETNAME`, `MONITOR` numerics (730-734), `MARKREAD`, `METADATA` (760s), `REDACT`, `RENAME`, `REGISTER`/`VERIFY`. The client's numeric table should fall through to "show as raw server message in the server buffer" for anything unknown rather than dropping it.

### Modes and identity

- **Host cloaking (`+x`).** `HOST_HIDING` default TRUE, `HIDDEN_HOST` suffix (`doc/readme.features:232-244`), `HOST_HIDING_STYLE` 1 = `account.users.<network>`, 2 = hashed host (`:1551`), plus `+C`/`+c` cloak modes, `+f`/`+h` fakehost/sethost (`doc/modes.txt`). The docker template sets `usermode = "x"` on the Users class, so **the client's own host will change after registration and again on services login**; expect `396` and, with `chghost`, `CHGHOST` for others. On master without `chghost`, other users' host changes are invisible (or, with `HIDDEN_HOST_QUIT`, appear as a QUIT `Registered` + rejoin — `readme.features:1511-1528`). Keep the user's own `nick!user@host` updated from `396`/`CHGHOST`, not from the `001` line.
- **Accounts.** `+r` = logged in. `RPL_WHOISACCOUNT` 330, `ACCOUNT` messages with `account-notify`, `extended-join` carries the account. Account names may carry a `:timestamp` suffix on the P10 side but are clean on the client side. `ERR_NEEDREGGEDNICK` 477 is the "+r channel" error; `ERR_ACCOUNTONLY` 486 the "+R user" error.
- **User modes** the UI may want to surface: `+B` bot, `+D`/`+d` deaf, `+R` registered-only PMs, `+q` common-channels-only, `+z` SSL, `+I` hide idle, `+W` whois-notice, `+p` hide channels, `+f`/`+h` fake host, `+C`/`+c` cloak. Full list `doc/modes.txt`.
- **Channel modes** beyond RFC: `+A`/`+U` oplevel passwords, `+D`/`+d` delayed join (members appear in `355` and get a late JOIN when they speak — the client must add users on JOIN it did not expect), `+L` redirect (`490`), `+M` reg-moderated, `+N` no notices, `+O`/`+a` oper/admin only, `+Q` hide quit/part, `+R` registered channel, `+r` reg-only, `+S` strip, `+T` no multitarget, `+Z` SSL-only, `+z` persistent, `+C` no CTCP, `+c` no colour. `+h` halfop only if `HALFOPS`.
- **Oplevels.** With `OPLEVELS`, `MODE` and WHOX `o` field carry numeric op levels (0-999). A `+o` with oplevel shows as normal `@` in NAMES.
- **Extended bans** `~a:`, `~c:`, `~r:`, `~m:`, `~M:`, `~j:`, actions `~q:`/`~n:`, nestable. Ban lists (367) will contain these; don't try to hostmask-parse them.
- **Throttling.** ircu target-change throttling (`439`), nick-change throttling (`438`), and `fakelag` in Class blocks. The client should not fire bursts of `WHO`/`PRIVMSG` to many targets on connect.
- **P10 leakage.** `KILL` reasons and some `QUIT` reasons embed `servername!nick (reason)` paths. `RPL_WHOISACTUALLY` 338 is sent to opers only.
- **Case mapping** is `rfc1459` (`[]\~` fold to `{}|^`). Channel/nick comparisons must use it.
- **CAP on master:** `CAP LS 302` gets an unversioned answer; `CAP REQ` of an unknown cap NAKs the _whole_ request (`m_cap.c:236-242` [master]) — request caps one per `CAP REQ` or only request what LS offered.

## Prototype status

Run 2026-08-24 against `nefarious2:ircv3` built from `ircv3.2-upgrade@3868b34` with `tools/nefarious-dev/run.sh` (see `nefarious2-dev.md`).

### `wss://localhost:8443/` — works

`node tools/irc-ws-probe.mjs wss://localhost:8443/ seance2 --insecure`:

```
(node:182139) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification.
(Use `node --trace-warnings ...` to show where the warning was created)
-- open (subprotocol: text.ircv3.net)
>> CAP LS 302
>> NICK seance2
>> USER seance2 0 * :Seance WS probe
<< NOTICE * :*** Looking up your hostname
<< NOTICE * :*** Checking Ident
<< NOTICE * :*** No ident response
<< NOTICE * :*** Couldn't look up your hostname
<< :irc.seance.test CAP * LS * :multi-prefix userhost-in-names extended-join away-notify account-notify cap-notify server-time echo-message account-tag chghost invite-notify labeled-response batch setname standard-replies message-tags no-implicit-names draft/no-implicit-names draft/extended-isupport draft/pre-away draft/multiline=max-bytes=16384,max-lines=100 draft/chathistory=100 draft/event-playback draft/metadata-2=before-connect,max-subs=50,max-keys=20,max-value-bytes=300 draft/bouncer draft/persistence
<< :irc.seance.test CAP * LS : tls
>> CAP END
<< :irc.seance.test 001 seance2 :Welcome to the SeanceDev IRC Network, seance2
-- registered
<< :irc.seance.test 002 seance2 :Your host is irc.seance.test, running version u2.10.12.14+Nefarious(2.0.0)
<< :irc.seance.test 003 seance2 :This server was created Tue Aug 25 2026 at 04:58:23 UTC
<< :irc.seance.test 004 seance2 irc.seance.test u2.10.12.14+Nefarious(2.0.0) abdgiknoqswxyzBDHLMNORWXY abCcDdhHikLlMmNnOopPQRrSsTtvZz bkLlov
<< :irc.seance.test 005 seance2 WHOX WALLCHOPS WALLHOPS WALLVOICES USERIP CPRIVMSG CNOTICE NAMESX UHNAMES SILENCE=25 WATCH=128 MONITOR=128 MODES=6 :are supported by this server
<< :irc.seance.test 005 seance2 MAXCHANNELS=20 MAXBANS=50 NICKLEN=15 MAXNICKLEN=30 TOPICLEN=250 AWAYLEN=250 KICKLEN=250 CHANNELLEN=200 MAXCHANNELLEN=200 CHANTYPES=#& PREFIX=(ov)@+ STATUSMSG=@+ BOT=B :are supported by this server
<< :irc.seance.test 005 seance2 CHANMODES=b,k,Ll,aCcDdHiMmNnOPpQRrSsTtZz CASEMAPPING=rfc1459 NETWORK=SeanceDev MAXLIST=b:50 ELIST=CT TARGMAX=PRIVMSG:20,NOTICE:20,JOIN:,PART: CHATHISTORY=100 MSGREFTYPES=timestamp,msgid :are supported by this server
<< :irc.seance.test NOTICE seance2 :You are connected to irc.seance.test with TLSv1.3-TLS_AES_256_GCM_SHA384-256bits
<< :irc.seance.test 251 seance2 :There are 1 users and 0 invisible on 1 servers
<< :irc.seance.test 255 seance2 :I have 1 clients and 0 servers
<< :irc.seance.test 265 seance2 :Current local users: 1 Max: 1
<< :irc.seance.test 266 seance2 :Current global users: 1 Max: 1
<< :irc.seance.test NOTICE seance2 :Highest connection count: 1 (1 clients)
<< :irc.seance.test 422 seance2 :MOTD File is missing
<< :irc.seance.test NOTICE seance2 :on 2 ca 5(4) ft 10(10) tr
<< :seance2!seance2@172.17.0.1 MODE seance2 +xz
>> QUIT :probe done
<< ERROR :Closing Link: seance2 by seance2 (Quit: probe done)
-- closed (1006 )
```

Every cap in the plan's list is advertised (`draft/event-playback` because `local.conf` turns it on). `CAP LS` is split across two frames with the `*` continuation marker, so the client's CAP accumulator must handle that. The trailing `closed (1006)` is the server dropping TCP after `QUIT` without sending a WebSocket Close frame — harmless, but the client should treat 1006-after-QUIT as a clean exit rather than a reconnectable failure.

`--binary` on the TLS port was not exercised separately; the plain-port attempt below failed before subprotocol selection.

### `ws://localhost:8067/` (plain port, `websocket = yes`) — **broken upstream**

Node's HTTP parser rejects the upgrade with `Parse Error: Expected HTTP/, RTSP/ or ICE/`. Raw exchange (`printf 'GET / HTTP/1.1 ... Upgrade: websocket ...' | nc 127.0.0.1 8067`):

```
NOTICE * :*** Looking up your hostname
NOTICE * :*** Checking Ident
NOTICE * :*** No ident response
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
Sec-WebSocket-Protocol: text.ircv3.net
```

The ident/DNS progress notices are written to the socket **before** the HTTP 101 response, as bare IRC lines. Cause: `s_auth.c:164-169` `sendheader()` writes straight to the fd with `ssl_send()`/`send()`, bypassing the MsgQ, so the guard in `s_bsd.c:318-325` that holds all output while `IsWSNeedHandshake` is set never sees them. On the TLS port the same notices happen to land after the 101 (presumably because `ssl_send` cannot write until the TLS handshake completes), which is why `wss://` works. No browser will accept a 101 preceded by garbage, so **plain-text WebSocket is unusable until this is fixed upstream**; dev must use `wss://` with a trusted local cert. Fix is on the ircd side: route `sendheader` through the MsgQ (or drop the notices for WS clients until the handshake completes).

### Upgrade requests ≥ 512 bytes are never answered — **blocks every real browser**

Found during phase C headless verification (2026-08-24). A handcrafted upgrade request of 500 bytes gets `101`; 512 and 528 bytes hang until the registration timeout. Chromium's real upgrade request is ~553 bytes (`User-Agent`, `Accept-*`, `Origin`, `Sec-WebSocket-Extensions`, `Sec-Fetch-*`), so no browser can connect even over `wss://`; Node's ~200-byte request is why the CLI probes worked. Through a local TLS proxy that strips those headers (553 → 211 bytes) the SPA works end to end. Likely cause: the handshake is only attempted when `\r\n\r\n` lands inside the 512-byte `BUFSIZE` input buffer. Filed as [evilnet/nefarious2#99](https://github.com/evilnet/nefarious2/issues/99). Also observed there: the TLS listener requests a client certificate, which headless Chromium answers with `ERR_SSL_CLIENT_AUTH_CERT_NEEDED` (interactive browsers may show a cert picker) — noted in the issue, not necessarily a bug.

### 528-byte inbound frame cap — **confirmed**

A registered client sending a single 600-byte `PRIVMSG` frame over `wss://` gets `ERROR :Closing Link: bigframe by irc.seance.test (WebSocket frame error)` and a 1006 close; a 400-byte frame is delivered normally. Matches the analysis under "Framing rules" above.

## Local fix branch (2026-08-25)

`seance/websocket-fixes` in `tmp/nefarious2` (4 commits on top of `ircv3.2-upgrade@3868b34`; series exported to `tmp/nefarious2-fixes.patch`). **Pushed 2026-08-25 as [evilnet/nefarious2#100](https://github.com/evilnet/nefarious2/pull/100)** (base `ircv3.2-upgrade`, reviewer MrLenin), and **merged 2026-08-28** together with the client-cert follow-up as [#101](https://github.com/evilnet/nefarious2/pull/101) (`fceb160`). The branch is history: `tmp/nefarious2` now tracks stock `ircv3.2-upgrade` (at `3ab3038`, 2026-08-28) and `nefarious2:ircv3-fixed` is only a tag alias for the same stock build, kept so `tools/nefarious-dev/run.sh`'s default still resolves. The sections below are kept for the reasoning.

| Issue | Fix                                                                                                                                                                              | Verified                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| #97   | `s_auth.c` `sendheader()` goes through `sendrawto_one()`+`send_queued()` so the WS handshake hold applies (the TLS port only worked because `ssl_send()` already used the MsgQ). | `nc` shows `101` first; `irc-ws-probe.mjs ws://localhost:8067/` reaches `001`.                                                      |
| #98   | Decode buffer sized to `WS_MAX_PAYLOAD`; receive loop feeds the full 60 KB `readbuf` through the per-connection frame buffer; frames over 16 KB get Close `1009`.                | 600 B and 2000 B single frames accepted; 17 KB → 1009.                                                                              |
| #99   | `websocket_handshake_feed()` accumulates the request on the heap (cap 8 KB), autodetect preserved, bytes after `\r\n\r\n` kept.                                                  | 600/2000-byte padded requests → `101`; **headless Chromium's real 554-byte request connects directly**; `transport.live.ts` passes. |

Plus 12 cmocka cases in `ircd/test/websocket_cmocka.c`. Two things learned on the way:

- The branch's `recv_classify.c:46` caps every client's message _body_ at 512 bytes — a 600-byte plain `PRIVMSG` is killed as "Excess Flood: message region too large" on TCP and WS alike. That is the branch's normal over-length treatment (not a transport bug) but is stricter than `draft/multiline` and long client tags need; worth raising upstream separately. Seance keeps `MAX_LINE_BYTES = 500`.
- The TLS listener used to request a client certificate (`SSL_VERIFY_PEER|SSL_VERIFY_CLIENT_ONCE`, optional unless `SSL_REQUIRECLIENTCERT`), which headless Chromium aborted on with `ERR_SSL_CLIENT_AUTH_CERT_NEEDED`. **Fixed in the same merge (#101):** dedicated WebSocket ports no longer ask for one and `websocket=autodetect` ports use ALPN to spot browsers, so automated browser runs no longer need a pass-through TLS proxy. A pre-existing unrelated cmocka failure (`ircd_string_cmocka` `test_ircd_strncpy_truncation`) is masked by the Makefile's `| tee`.

## Read markers (`draft/read-marker`), observed 2026-08-25

Off by default (`CAP_draft_read_marker`); the dev config enables it. Unauthenticated client: the fetch after JOIN answers `MARKREAD #chan timestamp=*` (note `timestamp=*`, not a bare `*`); a `MARKREAD #chan timestamp=<t>` set is accepted and stored per session but **not echoed back** because `m_markread.c` `notify_local_clients()` skips clients with an empty account (the ephemeral-path comment says otherwise) — a later fetch does return it, and an older set is answered with the stored newer value. Account-anchored sessions should get the spec's echo/broadcast (untested: no services). Candidate for a small upstream report.

## REDACT / TAGMSG / client tags, observed 2026-08-26

Verified against the dev image with two throwaway nicks (`ws://localhost:8067/`, caps `message-tags server-time echo-message batch labeled-response standard-replies draft/chathistory draft/message-redaction draft/event-playback`). What Seance does with each is in `docs/resources/bus-contract.md` §1.4.

- **msgids** are 14 characters of P10 base64 — the alphabet includes `[` and `]` (`ABAAAAAaA8Iz[f`, `ABAACAAaA8Iz[a`); never assume `[A-Za-z0-9]`. nefarious2 reuses msgids after a restart, which is why poxchat keys its dedup on (msgid, time).
- **Replies.** `+draft/reply=<msgid>` (what poxchat sends and reads) and the ratified `+reply` are both accepted and relayed unchanged, on PRIVMSG and TAGMSG alike. Seance sends `+draft/reply`, reads both.
- **Reactions** are `@+draft/react=<text>;+draft/reply=<msgid> TAGMSG <target>`, removal `+draft/unreact=<text>`. Tag values go through the message-tags escapes (`a\sb\:c` came back as sent). The echo (with `echo-message`) and the relay both add `msgid` and `time`. `+typing=active` TAGMSGs are relayed with a msgid too but are **not** stored. Channel TAGMSGs are stored and come back inside `chathistory` batches with `batch;time;msgid` plus the client tags; a TAGMSG to a nick is delivered but never stored.
- **Typing notifications** (`+typing=active|paused|done` on TAGMSG, needs only `message-tags`) are relayed to channel members and query partners like any client tag — with `msgid` and `time` added, and echoed back to the sender with `echo-message` — but a typing-only TAGMSG is **never stored**: nothing comes back in `chathistory` for it (a TAGMSG that also carries a reaction is stored as a reaction). Seance sends `@+typing=<state> TAGMSG <target>` from `IrcClient.typing()`, at most one per target every 3 s (`active` repeated while typing continues, `paused`/`done` once per transition, no `done` after a PRIVMSG), and turns inbound ones from other users into the `typing` bus event (bus-contract §1.5); replayed or own-echo typing tags are dropped.
- **REDACT** needs `CAP_draft_message_redaction` (default `FALSE`; `tools/nefarious-dev/local.conf` turns it on) and the client must have negotiated `draft/message-redaction` to _receive_ REDACT lines. `REDACT <channel> <msgid> [:reason]`, channels only. The live line is `:nick!user@host REDACT #chan <msgid> [:reason]` with **no tags at all** (no `time`, no `msgid`), sent to every member with the cap including the author (who only sees it with `echo-message`). Redacting the same msgid again is accepted and relayed again. Inside `chathistory` batches the REDACT line comes back tagged (`batch;time;msgid`, its own msgid) after the point where the deleted message was, and the deleted message itself is no longer replayed.
- **Errors** are standard replies: `FAIL REDACT REDACT_FORBIDDEN #chan <msgid> :You are not authorized to redact this message` (someone else's message; the author may within `REDACT_WINDOW`/logged in, chanops within the window, opers always), `FAIL REDACT INVALID_TARGET <nick> :Cannot redact from this target` (not a channel), `FAIL REDACT UNKNOWN_MSGID #chan <msgid> :Message not found`, plus `DISABLED` and `REDACT_WINDOW_EXPIRED` from `m_redact.c`. `REDACT #chan` without a msgid is numeric `461 REDACT :Not enough parameters`.
- **Edits** do not exist on the wire. Seance's emulation (REDACT with reason `edited`, then a PRIVMSG tagged `+seance/edit=<old msgid>`) relies on the server relaying unknown `+`-prefixed client tags — it does, live and in history (`@…;+seance/edit=ABAAAAAaA8Iz[f :… PRIVMSG #seance :hello from alice (edited)`).

Transcript excerpt (bob reacting to alice's message, alice deleting it, carol replaying):

```
lbob   >> @+draft/react=👍;+draft/reply=ABAAAAAaA8Iz[f TAGMSG #seance
lalice << @+draft/react=👍;+draft/reply=ABAAAAAaA8Iz[f;msgid=ABAAAAAaA8Iz[g;time=2026-08-26T03:38:20.291Z :lbob!lbob@172.17.0.1 TAGMSG #seance
lbob   >> REDACT #seance ABAAAAAaA8Iz[f :not mine
lbob   << @time=2026-08-26T03:38:22.601Z FAIL REDACT REDACT_FORBIDDEN #seance ABAAAAAaA8Iz[f :You are not authorized to redact this message
lalice >> REDACT #seance ABAAAAAaA8Iz[f :edited
lalice << :lalice!lalice@172.17.0.1 REDACT #seance ABAAAAAaA8Iz[f :edited
lbob   << :lalice!lalice@172.17.0.1 REDACT #seance ABAAAAAaA8Iz[f :edited
lcarol << @batch=hist7AAF;time=2026-08-26T03:38:20.292Z;msgid=ABAAAAAaA8Iz[g;+draft/react=👍;+draft/reply=ABAAAAAaA8Iz[f :lbob!lbob@172.17.0.1 TAGMSG #seance
lcarol << @batch=hist7AAF;time=2026-08-26T03:38:23.204Z;msgid=ABAAAAAaA8Iz[n :lalice!lalice@172.17.0.1 REDACT #seance ABAAAAAaA8Iz[f :edited
```

## Fake lag / flood penalty, measured 2026-08-27

ircu-family throttling applies to WebSocket clients exactly as to TCP ones. `ircd/parse.c` (~L1620) charges every command from a non-oper `lag = lagmin + len / lagfactor` seconds onto `cli_since` (defaults `2 + len/120`; `MFLG_SLOW` commands always), and `ircd/s_bsd.c` (~L1339) stops reading the socket while `cli_since - CurrentTime >= 10` (opers / `IsTrusted` exempt). Multiline batches are charged once at `BATCH -` instead of per line. The clock is reset when registration completes (`ircd/s_auth.c:1483`), so the CAP/NICK/USER/SASL exchange itself is free and only costs round trips — Seance pipelines it (`caps.ts`). So a client gets roughly five commands "for free" and is then held to one every 2 s; a burst of 65 commands (what Seance used to send for 15 autojoined channels) silenced the server for ~90 s and every later line, including the user's first message, waited behind it. Exceeding the recvq while held is "Excess Flood". Seance now sends one multi-target `JOIN`, no `MODE` on join, and paces history/marker fetches one channel per 4 s (`client/js/irc/catchup.ts`; `docs/projects/connect-burst.md`). Worth asking upstream whether read-only fetches (`CHATHISTORY`, `MARKREAD` query) could carry a smaller charge.

## Session persistence (`draft/persistence`), read from source 2026-08-27

The branch has a built-in bouncer (`ircd/bouncer_session.c`, `m_bouncer.c`, `m_persistence.c`): with `BOUNCER_ENABLE` (default off; AfterNET has it on) a logged-in user's session is _held_ when the connection drops (`BOUNCER_DEFAULT_HOLD`, `BOUNCER_SESSION_HOLD` 4 h) and the next connection with the same account resumes it (`BOUNCER_AUTO_RESUME`). Accounts only, so nothing of this can be exercised against the dev ircd (no services); the behaviour below was seen live on AfterNET and read from the code.

- **Status at registration.** With the cap active and an account, `:server PERSISTENCE STATUS ON|OFF` is sent between 005 and the MOTD end (`s_user.c:731`, `:557` for a revived ghost, `bouncer_session.c:7475` for an alias; `m_persistence.c` `persistence_send_status`). `ON` = the session is held across drops. The client also gets `PERSISTENCE STATUS|GET|SET ON|OFF|DEFAULT|PROFILE …` as commands.
- **Restoration burst.** After the MOTD end (`s_user.c:574`/`:785`, `bouncer_session.c:7492`), `bounce_send_channel_state()` (`bouncer_session.c:9891`) replays every channel the session is still in: `BATCH +ref draft/persistence` (only when `batch` is active), then per channel `@time=<original join>;msgid=<join msgid> :nick!user@host JOIN #chan [account :realname]`, 332 + 333 if there is a topic, `MARKREAD`, NAMES (353/366 unless `no-implicit-names`), and `BATCH -ref`. The JOIN carries the _original_ join time, days old after a long hold.
- **A reattach can send the burst twice** (observed 2026-08-28): the resume replays the channel state, then — when another connection of the account holds the session — `bounce_setup_local_alias()` sends `NOTE BOUNCER ALIAS_ATTACHED` and `bounce_send_channel_state()` again, seconds later. A client cannot tell from the wire which burst is which, so Seance dedupes on content instead (unchanged topic, membership already held).
- **A JOIN for a channel already restored.** Resumed as the primary, `m_join.c:149` ignores it silently. Attached as an _alias_ — another connection of the account (the desktop) is the primary — `m_join.c:497-530` ("M4b") answers with a synthetic 332/333/NAMES burst, which is why the topic showed a third time.
- **Missed messages.** Clients without `draft/chathistory` get an automatic replay (`replay_start_bouncer`); with the cap the server leaves it to the client (`CHATHISTORY AFTER`, which is what catchup.ts does off the restored JOIN).
- **`PERSISTENCE STATUS` takes two arguments** since `7a47da1`: `STATUS <client-setting> <effective>`, the first `ON|OFF|DEFAULT` (what the user asked for), the second `ON|OFF` (what the server will actually do — `94e4fbf` makes it consult the real hold decision, so a bouncer-class connection reports `DEFAULT ON`). Read the _last_ parameter; older builds send the effective state alone. `PERSISTENCE SET <value>` is only an ack — a STATUS follows it.
- **A single reconnect never sends the channel-state burst twice from the server's own paths.** The three call sites of `bounce_send_channel_state()` — ghost revive (`s_user.c:587`), plain resume (`:812`, gated on `auto_resumed == 1`) and alias attach (`bouncer_session.c:7582`) — are mutually exclusive by control flow within one `register_user()`. A second burst therefore means either our own JOIN into a channel the session already holds (the alias answer in `m_join.c`), or a second connection. What _can_ repeat a channel later is `bounce_sync_alias_join()` (`bouncer_session.c:6254`): when the primary joins a channel after an alias was set up, the alias gets an **unbatched** JOIN/332/333/MARKREAD/353/366 for it, carrying the primary's JOIN msgid.
- **`MARKREAD` inside the `draft/persistence` batch is not tagged** with `@batch` (`m_markread.c` uses `sendrawto_one`), so it is processed live, before the batch closes.
- **`PERSISTENCE ATTACH <profile> [<msgid>]`** (`9bc57d4`, `m_persistence.c` `persistence_cmd_attach`) pins the connection's persistence profile and, with the optional second argument, hands the server the client's globally newest last-seen msgid as a catch-up anchor. Feature-detect on the `attach-cursor` token in the CAP 302 value: `draft/persistence=attach,detach,list,attach-cursor` (`ircd.c:1315`, a static inventory — unknown tokens must be tolerated). Constraints, all enforced server-side:
  - **registration-only** — `IsUser()` gets `FAIL PERSISTENCE INVALID_PARAMETERS ATTACH :PERSISTENCE ATTACH is only valid during registration`. The command table lets unregistered clients through explicitly (`parse.c`, `m_persistence` in the UNREG slot);
  - **account-only** — without SASL success, `FAIL PERSISTENCE ACCOUNT_REQUIRED ATTACH :You must SASL-authenticate before PERSISTENCE ATTACH`. So the window is exactly SASL-success → `CAP END`;
  - profile `default` always exists implicitly (`persistence_profile.c` `persistence_profile_exists`); anything else needs a `PROFILE CREATE` first, else `FAIL PERSISTENCE INVALID_PARAMETERS ATTACH <name> :No such profile`;
  - the msgid must fit `con_attach_cursor[64]`, i.e. **≤ 63 bytes**, else `FAIL PERSISTENCE INVALID_PARAMETERS ATTACH <name> :Cursor msgid too long`.
- **Success is `:<server> PERSISTENCE ATTACH <profile>`** (`send_persistence_reply`, the same shape as the STATUS/SET replies) — no numeric, no echo of the cursor. Seance sends `PERSISTENCE ATTACH default <msgid>` immediately before `CAP END` in the same flush; see `client/js/irc/persistence.ts`.
- **What the cursor changes.** At revive (`s_user.c:812`), post-registration resume and alias attach (`bouncer_session.c:7597`) the auto-replay is normally skipped for clients holding `draft/chathistory` — `|| cli_attach_cursor(sptr)[0]` turns it back on, so a chathistory-capable client that offered a cursor gets the server-driven replay too (it deduplicates by msgid). `replay_start_catchup` (`replay.c:784`) resolves the msgid through the global index to a `sec.msec` timestamp and calls `replay_start_bouncer_at`; an unknown/evicted msgid is **not** an ATTACH failure — it comes later as `FAIL PERSISTENCE CURSOR_UNKNOWN <msgid> :Cursor msgid not found; replaying from last activity` and the replay runs from the server's own derived since-time anyway.
- **The catch-up replay an ATTACH cursor triggers** is nested: an outer `BATCH +<id> evilnet.github.io/bouncer-replay` (gated on the `batch` cap and emitted lazily on the first inner batch, so an empty replay sends no wrapper) containing one inner `BATCH +<id> chathistory <target>` per channel and then per PM counterparty, messages tagged `@batch/@time/@msgid/@account`; the outer close is followed by a plain `NOTICE … :Session resumed. Replayed N message(s) from M channel(s)…` — or `…You are in N channel(s). No missed messages.` when nothing was replayed. That NOTICE is deliberately sent **after** `BATCH -<outer>` (`replay.c:602`) and is the only end marker: no numeric, no `draft/chathistory-end` on these batches. Inner-batch openers carry a stray trailing `;` in their tag (`@batch=<outer>; :server BATCH …`, `replay.c:195`) — our parser tolerates it; the inner close is `@batch=<outer> :server BATCH -<inner>` without one.
- **The replay is capped per target, not in total, and never says it truncated.** `replay_next_channel` / `replay_next_pm` each ask `history_query_latest_after` for at most `FEAT_BOUNCER_AUTO_REPLAY_LIMIT` (default 100, floor 100 if the feature is ≤ 0) messages, PM counterparties are enumerated 50 at a time, and per channel a `draft/read-marker` newer than the cursor wins over it (a channel read on another device replays less). Nothing on the wire distinguishes a complete replay from a truncated one.
- **Fake lag has a post-registration grace** since `a1215e6`: `cli_since` starts `FEAT_POSTREG_GRACE` seconds (default 20 → ~15 commands) in surplus, on all three welcome paths, for authenticated clients (`9c9c89a`). Credit, not exemption.
- **Verified live 2026-08-29** against the AfterNET e-testnet (nefarious2 `3ab3038`, `BOUNCER_ENABLE`/`BOUNCER_AUTO_REPLAY` on, `BOUNCER_AUTO_REPLAY_LIMIT` unset → 100, chathistory store on) with `tools/`-external probes in `~/afternet/e-testnet/tmp-cursor-probe.mjs` and `test/irc/attach-cursor.live.ts`. Everything above holds on the wire, verbatim:

  ```
  >> PERSISTENCE ATTACH default BjAAAAAaBKI5o[
  >> CAP END
  << :irc.testnet.loxxin.net PERSISTENCE ATTACH default          (before 001)
  << :irc.testnet.loxxin.net BATCH +AAC0 draft/persistence       (JOIN, 332, 333, 353, 366)
  << :irc.testnet.loxxin.net MARKREAD #seance timestamp=*        (untagged, inside the burst)
  << :irc.testnet.loxxin.net BATCH -AAC0
  << :irc.testnet.loxxin.net BATCH +hist2AAC evilnet.github.io/bouncer-replay
  << @batch=hist2AAC; :irc.testnet.loxxin.net BATCH +hist1AAC chathistory #seance
  << @batch=hist1AAC;time=…;msgid=…;account=seance2 :seance2!… PRIVMSG #seance :gap one
  << @batch=hist2AAC :irc.testnet.loxxin.net BATCH -hist1AAC
  << @batch=hist2AAC; :irc.testnet.loxxin.net BATCH +hist3AAC chathistory seance2
  << @batch=hist2AAC :irc.testnet.loxxin.net BATCH -hist3AAC
  << :irc.testnet.loxxin.net BATCH -hist2AAC
  << :irc.testnet.loxxin.net NOTICE seance1 :Session resumed. Replayed 4 message(s) from 1 channel(s) and 1 PM(s).
  ```

  The replay starts strictly _after_ the cursor; PM counterparties get their own inner batch named after the nick. With a bogus msgid the `FAIL PERSISTENCE CURSOR_UNKNOWN <msgid> :Cursor msgid not found; replaying from last activity` arrives **between** the `draft/persistence` batch and the replay wrapper, and the replay then runs from the session's own start — including replayed JOIN/QUIT events (`draft/event-playback`) and messages the client already holds, which is what the msgid dedupe in history.ts is for. Nothing missed gives no wrapper at all and only `NOTICE … :Session resumed. You are in 1 channel(s). No missed messages.`. Holding `draft/chathistory` and sending no cursor still skips the replay entirely.

- **`PERSISTENCE LIST` does not exist** even though the CAP 302 value advertises it: `FAIL PERSISTENCE INVALID_PARAMETERS LIST :Unknown PERSISTENCE subcommand` (the token list in `ircd.c` is a static inventory). Only `ATTACH`, `DETACH`, `SET`, `STATUS`, `GET` and `PROFILE` answer.
- Seance's side: `client/js/irc/persistence.ts` (request the cap, hold the autojoin back after `STATUS ON` until the batch — or 1 s — is in, apply the batch as state only, offer the `attach-cursor` after SASL and take the replay as new messages) and `Channel.rejoining` for the non-persistence re-join. See `docs/projects/seamless-reconnect.md`.

## Bouncer ghost revive loses the WebSocket flag — **blocks every browser** (2026-08-29)

On a server with `BOUNCER_ENABLE`, a SASL login completes through `bounce_revive_ghost()` (`ircd/bouncer_session.c`): the new connection's fd (and SSL object) are transplanted onto the account's persisted "ghost" `struct Client`, and the temp client is freed — `Bouncer: reviving ghost seance1 with socket from temp seance1 (fd 57)` in the debug log. The function transfers the fd, IP, sockhost, listener, confs and `FLAG_SSL`, but **not `FLAG_WEBSOCKET`**, which `websocket.c:412` only ever sets on the temp client. `send_queued()` (`ircd/s_bsd.c:331`) frames output only `if (IsWebSocket(cptr))`, so whenever the ghost was last created by a _non_-WebSocket login, everything from 001 onward is written to the WebSocket as raw IRC text.

Symptom, reproducible with plain `node`:

```
>> CAP END
<< [len=92] @time=… :irc… 903 * :SASL authentication successful
!!! BAD FRAME HEADER b0=0x40   ("@" of "@time=…001…Welcome")
```

undici / Node's global `WebSocket` (and every browser) aborts with `Expected RSV1 to be clear.` and close code 1006 — 0x40 is the RSV1 bit. Seance then reconnects forever, one aborted registration per attempt. It is per account and sticky: once _one_ plain-TCP login for the account has created the ghost, every later WebSocket login for it is broken until the session is destroyed (a clean `QUIT`/close **plus** `PERSISTENCE SET OFF`, or letting `BOUNCER_SESSION_HOLD` expire) and the next login is a WebSocket one. Non-SASL WebSocket clients never hit it (no account, no ghost). Not to be confused with the fixed #97/#98/#99 — this one is in the bouncer, not the WS layer.

Practical consequence for testing: never log an account in over plain TCP if a browser/Seance is going to use it over `ws://`; `test/irc/attach-cursor.live.ts` resets the held session over a WebSocket for exactly this reason.

## Open questions for the ircd side

1. ~~Which branch?~~ Decided 2026-08-24: Seance targets `ircv3.2-upgrade` (and `ircv3.2-hardening` as it lands). Still open: will it merge to `master`, and should we pin a tag? `ghcr.io/evilnet/nefarious2:latest` referenced by the compose example does not exist on GHCR (checked 2026-08-24); we build locally.
2. ~~Report the 527-byte inbound frame cap~~ Filed as [evilnet/nefarious2#98](https://github.com/evilnet/nefarious2/issues/98) (label `ircv3-upgrade`, assigned MrLenin).
   2b. ~~Report the ≥512-byte upgrade hang~~ Filed as [evilnet/nefarious2#99](https://github.com/evilnet/nefarious2/issues/99). Fix for all three: [PR #100](https://github.com/evilnet/nefarious2/pull/100).
   2a. ~~Report the plain-port handshake corruption~~ Filed as [evilnet/nefarious2#97](https://github.com/evilnet/nefarious2/issues/97) (label `ircv3-upgrade`, assigned MrLenin).
3. Confirm `WEBSOCKET_ORIGIN` policy for packaged (non-browser) clients that send no Origin.
4. `draft/event-playback` default is off; ask for it to be enabled on the dev/test server.
5. Report the bouncer ghost revive dropping `FLAG_WEBSOCKET` (see the section above) — it makes any account that has ever logged in over plain TCP unusable from a browser on a bouncer-enabled server.
