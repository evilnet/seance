# Running nefarious2 locally for Seance development

Plan item 0.3a. Executed 2026-08-24: the Docker route below works and is what `tools/nefarious-dev/run.sh` automates.

## Which source to run

Seance needs the WebSocket + IRCv3.2 work, which is **not on `master`** — it is on the upstream branch `ircv3.2-upgrade` (see `nefarious2-websocket.md`). The local checkout at `/home/rubin/src/nefarious2` tracks `master` and has a small uncommitted typo-fix diff (`include/numeric.h`, `ircd/m_help.c`, `ircd/s_err.c`) plus an untracked `CLAUDE.md`; leave those alone. Fetch the branch into that checkout (or a separate worktree) when ready:

```sh
cd /home/rubin/src/nefarious2
git fetch origin ircv3.2-upgrade
git worktree add ../nefarious2-ircv3 origin/ircv3.2-upgrade
```

## Option A: Docker (recommended) — automated by `tools/nefarious-dev/run.sh`

The native build needs `librocksdb-dev` (a hard `configure` requirement on the branch) which is not installed here, so Docker is the path. The branch's `Dockerfile` is multi-stage, runs the cmocka unit tests during the build, and pulls a prebuilt `ghcr.io/evilnet/libkc:sha-10aa335` (the `latest` tag does not exist; the pinned one does).

```sh
# once (~5 min): the checkout in tmp/ is gitignored
git clone --branch ircv3.2-upgrade https://github.com/evilnet/nefarious2.git tmp/nefarious2
(cd tmp/nefarious2 && docker build -t nefarious2:ircv3 .)
docker tag nefarious2:ircv3 nefarious2:ircv3-fixed   # alias the run.sh default expects

# every time
tools/nefarious-dev/run.sh        # foreground, debug level 5, Ctrl-C to stop
tools/nefarious-dev/run.sh -d     # detached; docker logs -f nefarious-dev
```

What the script does:

- Bind-mounts `tools/nefarious-dev/ircd.conf` **over the image's own `ircd.conf`**. The image's file `include`s `linesync.conf` and `gitsync/gitsync.conf`; the latter is never created in a standalone container and a missing include is a fatal parse error (`ircd_lexer.l:366-371`). Ours includes only `base.conf` and `local.conf`.
- Bind-mounts `tools/nefarious-dev/local.conf` (test oper, plain WS port, features — see below).
- Generates `tmp/nefarious-dev/ircd.pem` once with a SAN for `localhost`/`127.0.0.1`/`irc.seance.test` so it can be trusted by a browser, and mounts it read-only.
- Publishes on 127.0.0.1 only: `6667` plain IRC, `6697` IRC/TLS, `8067` `ws://`, `8443` `wss://`. (`8080` was the original choice but another container on this host already owns it.)
- Sets `IRCD_GENERAL_NAME=irc.seance.test`, network name `SeanceDev`.

Gotchas found on first run:

- `Operator {}` blocks must carry `local = no;` (or `yes`) or the config fails with `... have no LOCAL setting`.
- The WebSocket fixes (#97/#98/#99) and the client-cert/ALPN follow-up were merged upstream on 2026-08-28 (PR [#101](https://github.com/evilnet/nefarious2/pull/101), `fceb160`), so **a stock build of current `ircv3.2-upgrade` needs no patch**. There is now only one image: `nefarious2:ircv3`, built from stock `ircv3.2-upgrade`, and `nefarious2:ircv3-fixed` is just an alias tag for it (`docker tag nefarious2:ircv3 nefarious2:ircv3-fixed`) so that the script default and older notes keep working. Rebuilt 2026-08-28 from `3ab3038`. The old distinction only matters for an image built from a checkout older than `fceb160` — with such a pre-merge stock image, plain `ws://` on 8067 does not work and no real browser can connect at all.

How the container config is assembled (`tools/docker/dockerentrypoint.sh`, `tools/docker/ircd.conf`):

- `base.conf-dist` is templated with the `IRCD_*` env vars into `base.conf`. It already contains `General`, `Admin`, `Class` blocks (`Users` class has `usermode = "x"`, so everyone gets a cloaked host), an open `Client { ip = "*"; host = "*"; }` block, client ports `6667`, `7000`, `16667`, SSL `6697`, `9998`, server port `4497`, and a **WebSocket port `8443 ssl websocket`** (`tools/docker/base.conf-dist:122-127`). Its `Features {}` enables `CAP_draft_chathistory`, `CAP_draft_metadata_2`, `CHATHISTORY_PRIVATE`.
- The default `CMD` runs `ircd -n -x 5 -f ircd.conf` (foreground, debug level 5); every WebSocket frame shows up as `Debug((DEBUG_DEBUG, "WebSocket ..."))` lines, which is what we want while bringing up the client.

## Option B: native build

Prereqs (Debian/Ubuntu): `build-essential libssl-dev autoconf automake flex byacc gawk`, and for the branch also `librocksdb-dev libzstd-dev libcmocka-dev libmaxminddb-dev pkg-config` plus libkc (Keycloak SASL; `--enable-keycloak` is optional, skip it locally).

```sh
cd /home/rubin/src/nefarious2-ircv3
autoreconf -fi
./configure --prefix=$HOME/nefarious-dev --enable-debug --with-maxcon=1024 \
            --with-rocksdb=/usr --with-zstd=/usr
make -j"$(nproc)"
make install                      # binaries to ~/nefarious-dev/bin, lib dir ~/nefarious-dev/lib
cp doc/example.conf ~/nefarious-dev/lib/ircd.conf   # then trim; see below
tools/makepem/makepem ~/nefarious-dev/lib            # or the openssl one-liner above -> ircd.pem
~/nefarious-dev/bin/ircd -n -x 9 -f ~/nefarious-dev/lib/ircd.conf
```

`ircd` must not run as root; `-n` keeps it in the foreground. `doc/example.conf` is 1000+ lines; the docker `base.conf-dist` is a much better starting point for a single-server dev box.

## Minimal `local.conf` additions for Seance

```
# Test operator (password "seance"). $PLAIN$ is the unhashed form used in doc/example.conf;
# for a hashed one run `ircd/umkpasswd -m native seance` (`-l` lists mechanisms).
Operator {
     name = "seanceop";
     host = "*@*";
     password = "$PLAIN$seance";
     class = "Opers";
     local = no;
};

# Plain-text WebSocket for browser dev without cert hassle
Port {
     port = 8067;
     websocket = yes;
};

Features {
     "NETWORK" = "SeanceDev";
     "HIDDEN_HOST" = "users.seance.test";
     # Allow any Origin while developing (the default); tighten later:
     # "WEBSOCKET_ORIGIN" = "http://localhost:9000 https://app.seance.test";
     "CAP_draft_event_playback" = "TRUE";      # off by default on the branch
     "CHATHISTORY_REQUIRE_AUTH" = "FALSE";     # let unauthenticated dev clients pull history
};
```

Notes:

- `websocket = yes` works on non-SSL ports as long as the ircd was **built** with OpenSSL (`websocket.c:438-441`). Use `ws://localhost:8067/` from the built SPA and skip certificate trust entirely (works with any image built from `ircv3.2-upgrade` at `fceb160` or later; images built before that merge have upstream #97). The path is ignored by the server.
- `Port { ... ssl = yes; websocket = yes; }` is what production looks like; test it too, see TLS below.
- Password hashing: `ircd/umkpasswd` builds alongside `ircd` (`umkpasswd -l` lists mechanisms, `-m native <password>` produces the default hashed form). `$PLAIN$<password>` is accepted as-is, per `doc/example.conf:846`.
- No services (X3) means no SASL, no account login, no `+r`. That is acceptable for phase 0/C; `~/src/x3` exists locally if account-tag/chathistory-auth paths need exercising later.

## Suggested test identities

| Thing         | Value                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- |
| Server name   | `irc.seance.test`                                                                             |
| Network (005) | `SeanceDev`                                                                                   |
| Test nick     | `seance1` (`seance2` for a second tab; the probe defaults to `seance-probe`)                  |
| Test channel  | `#seance`                                                                                     |
| Oper          | `seanceop` / `seance`                                                                         |
| WS (plain)    | `ws://localhost:8067/` (fixed image only — stock image has upstream #97)                      |
| WS (TLS)      | `wss://localhost:8443/`                                                                       |
| Legacy TCP    | `localhost:6667` (for cross-checking with a normal client such as hexchat in `~/src/hexchat`) |

## TLS expectations for `wss://`

- The ircd's `ircd.pem` is a self-signed cert with `CN=<IRCD_GENERAL_NAME>` and no SAN. Modern browsers reject certs without a SAN outright, so for `wss://localhost:8443/` generate a proper dev cert instead of relying on the entrypoint's one-liner:

  ```sh
  mkcert -install                       # once; installs a local CA in the browser trust store
  mkcert -cert-file ircd.crt -key-file ircd.key localhost 127.0.0.1 ::1 irc.seance.test
  cat ircd.crt ircd.key > ircd.pem      # nefarious reads cert+key from one PEM via SSL_CERTFILE
  ```

  or with plain openssl, add `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"` and import the cert into the browser/OS trust store manually.

- A browser will not show a cert-error interstitial for a WebSocket; a rejected cert just surfaces as a generic `close` (code 1006) with nothing useful in the console. Open `https://localhost:8443/` in a tab first: the ircd will answer with a WebSocket-handshake failure and drop the connection, but the browser will have shown (and let you accept) the certificate along the way.
- `node tools/irc-ws-probe.mjs wss://localhost:8443/ seance-probe --insecure` skips verification for CLI testing.
- In production the cert is a real one (`tools/letsencrypt/` in the ircd repo has a renewal hook) and `WEBSOCKET_ORIGIN` should list the web app's origin.

## Sanity checklist once it is running

Results 2026-08-24 (transcripts in `nefarious2-websocket.md`, "Prototype status"):

1. `node tools/irc-ws-probe.mjs ws://localhost:8067/ seance-probe` — **fails** (`Parse Error: Expected HTTP/`): ident/DNS notices precede the HTTP 101 on plain ports. Upstream bug.
2. `node tools/irc-ws-probe.mjs wss://localhost:8443/ seance-probe --insecure` — **works**: `CAP * LS` with the full cap set, then `001`.
3. `--binary` — not yet exercised on the TLS port.
4. 600-byte `PRIVMSG` in one frame over `wss://` — **disconnects** with `WebSocket frame error`; 400 bytes is fine. Confirms the 528-byte cap.

## When logins hang at "904 SASL request timed out"

The IAuth chain (`iauth-tee.mjs` → `iauthd-ts`, both node children of the
ircd) can die on its own — it did on 2026-09-03 after ~11 h uptime. The
ircd keeps accepting sockets, CAP LS/ACK still work, SASL succeeds
server-side in the tee log's last entries, then every client gets
`904 * :SASL authentication failed: request timed out` and no 001. The
app shows "closed during IRC registration (connection lost)" in a
reconnect loop.

Diagnose: `pgrep -af "iauth-tee|iauthd-ts"` — if only the ircd remains
(or the tee log `tmp/testnet-run/iauth-tee.log` stops growing while
probes still connect), the chain is dead. There is no restart-without-ircd
path; the children are spawned at ircd boot.

Fix = the standard restart with the ownership pre-flight (files created
by root/`node` are unwritable for the `ircrun` user; an unwritable
iauth-tee.log or pid file kills the chain/boot silently):

```sh
pkill -f "^/seance/tmp/testnet-run/ircd-install/bin/ircd"
chown -R ircrun:ircrun /seance/tmp/testnet-run/{conf,history,webpush} \
  /seance/tmp/testnet-run/{iauth-tee.log,ircd.log,ircd-fg.log,ircd.out}
su -s /bin/sh ircrun -c 'cd /seance/tmp/testnet-run/conf && \
  setsid nohup /seance/tmp/testnet-run/ircd-install/bin/ircd \
  -f ircd-docker.conf >> /seance/tmp/testnet-run/ircd-fg.log 2>&1 &'
```

Verify: the two node children appear in `ps`, then a probe registers
(`tools/irc-ws-probe.mjs` shows caps; a SASL probe reaches `903`/`001`).
Remember clients auto-reconnect, so tabs recover on their own once the
chain is back — unless another session of the same account beat them to
it. One session per account is structural (the session owns the delivery
stream and the catch-up cursor); a second connection attaches as an
**alias** to it — that attach requires TLS unless
`"BOUNCER_REQUIRE_TLS" = "FALSE"` is set, which the testnet now does
(with `BOUNCER_MAX_SESSIONS = 5`), so multiple tabs on one identity
coexist as aliases and share the session. To give a tab its own stream
instead, use a second test identity.

## The native testnet rig after a sandbox reset (2026-09-04)

The sandbox was rebuilt: `/tmp` wiped, apt packages gone, no `ircrun`
user, no system Chromium. `/seance/tmp` survived. What it took to come
back, in order:

- `apt-get install gawk flex byacc libssl-dev librocksdb-dev libzstd-dev libcurl4-openssl-dev libjansson-dev libcmocka-dev libmaxminddb-dev gdb`
  (apt has network). `configure` wants flex; `config.status` wants gawk;
  `make clean` deletes the byacc/flex outputs.
- `cd testnet/nefarious && touch config.status && make clean && make -j8`.
  The touch skips the configure re-run (the old config already has libkc);
  the clean is **not optional**: `ircd/Makefile.in` carries no dependency
  info for some objects (`metadata.o`), so after a header change a partial
  `make` links stale objects and the ircd aborts at boot with
  `feature_bool: features[feat].feat == feat` — gdb shows the enum names
  off by one between objects.
- Install and run as the current user (`ircrun` is gone; the files are
  ours): copy `ircd/ircd` to `tmp/testnet-run/ircd-install/bin/ircd.<stamp>`,
  re-point the `ircd` symlink, delete a stale `conf/ircd.pid`, then
  `cd tmp/testnet-run/conf && setsid nohup ../ircd-install/bin/ircd -f ircd-docker.conf >> ../ircd-fg.log 2>&1 &`.
  Never `pkill -f` a pattern that also appears in the shell command you
  are running (it kills that shell); anchor it:
  `pkill -f "^/seance/tmp/testnet-run/ircd-install/bin/ircd"`,
  `pkill -f "^node tmp/dev-origin"`.
- Certificates live in `/seance/tmp/certs/` now (`ca.crt`/`ca.key`,
  `dev-cert.pem`/`dev-cert.key`; SAN `localhost, 127.0.0.1, 10.0.0.41, 172.22.0.3, irc.testnet.local`), and `tmp/dev-origin.mjs` reads them
  there and serves the CA at `https://<host>:8000/ca.crt`. **The old CA key
  is gone**: every phone that trusted the previous CA has to download and
  install the new `ca.crt` before its browser will register the service
  worker or subscribe to push again.
- Chromium is Playwright's only: `tmp/chrome-pw.sh` wraps it with
  `--no-sandbox --ignore-certificate-errors`. Harnesses:
  `tmp/sw-reply-probe2.mjs <mode>` drives the real service worker over the
  DevTools protocol (reply-page, reply-held, reply-queue, click, deeplink,
  reconnect); `tmp/chan-listen.mjs` and `tmp/names-probe.mjs` watch
  `#seance`; `tmp/sasl-transcript.mjs account pass nick [caps]` prints a
  registration transcript; the dev-origin's `POST /__drop` drops every
  proxied socket.
- The server caps an account at `WEBPUSH_MAX_REGISTRATIONS` (10) push
  endpoints and answers `FAIL WEBPUSH MAX_REGISTRATIONS`; fresh Chromium
  profiles against one test account use them up.

## The watchdogs

`tools/serve-watchdog.sh` and `tools/ircd-watchdog.sh` keep the two
long-running dev processes up (a pidfile makes a second launch a no-op, and
each restarts its child in a loop). They were written against this machine's
paths; every one of them is now an environment variable whose default is
that value, so another checkout, another port or another build directory
needs no edit:

| Variable             | Default                       | What it is                                            |
| -------------------- | ----------------------------- | ----------------------------------------------------- |
| `SEANCE_DIR`         | `/seance`                     | The checkout `tools/serve.py` is run from             |
| `SERVE_PID`          | `/tmp/serve-8000.pid`         | Pidfile guarding the single `serve.py`                |
| `SERVE_PORT`         | `8000`                        | Port `serve.py` listens on                            |
| `SERVE_SAN`          | `10.0.0.41`                   | Address the self-signed certificate is issued for     |
| `SERVE_LOG`          | `/tmp/serve-8000.log`         | `serve.py`'s stdout and stderr                        |
| `IRCD_PID`           | `/tmp/ircd-6667.pid`          | Pidfile guarding the single ircd                      |
| `NEFARIOUS_DIR`      | `/seance/tmp/nefarious2/ircd` | The built ircd (the directory holding the binary)     |
| `NEFARIOUS_CONF_DIR` | `/seance/tmp/nefarious-dev`   | Run directory: `ircd.conf`, state, the agent's socket |
| `IRCD_LOG`           | `/tmp/ircd.log`               | The ircd's stdout and stderr                          |

`tools/iauth-agent.py` (the SASL agent the ircd spawns, one fixed
credential, no services package) reads three of its own:

| Variable          | Default          | What it is                                              |
| ----------------- | ---------------- | ------------------------------------------------------- |
| `IAUTH_TEST_USER` | `pushtest1`      | The account it accepts                                  |
| `IAUTH_TEST_PASS` | `pushtest1-pass` | That account's password                                 |
| `IAUTH_DEBUG_LOG` | _unset_          | Where to trace the wire. **Unset means no log at all.** |

The trace used to be written unconditionally to `/tmp/iauth-debug.log`: the
agent lives as long as the ircd and every SASL exchange went into it, on a
machine where nothing rotated it. Set `IAUTH_DEBUG_LOG` when a login is
being debugged, and unset it again afterwards.
