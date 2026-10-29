#!/usr/bin/env python3
"""Single-port host for the Seance SPA: static files from public/ and a
WebSocket reverse proxy in front of the ircd, on the same port.

HTTPS is the default: a self-signed certificate (generated on first run,
SAN covering localhost and every address the machine answers to) makes
the origin a secure context from other devices too — which WebGPU needs,
so the translation models unlock on a plain HTTP LAN address only after
this switch. Browsers show the usual self-signed warning once; accepting
it is enough. --http opts out, --cert/--key bring your own certificate.

A plaintext request on the TLS port (a mistyped http:// URL) is answered
with a 301 to its https:// equivalent instead of a dead connection.

Regenerating the certificate (delete tmp/serve/) locks out browsers that
hold a service worker for this origin: worker fetches cannot show the
"proceed anyway" interstitial, so every navigation fails with ERR_FAILED
until the worker is unregistered (chrome://serviceworker-internals).
Reusing the cert — the default — is what keeps that from happening.

The browser dials the app's origin (ws://<this-host>:8000/); any request
carrying `Upgrade: websocket` is proxied — handshake first, then a raw
bidirectional byte pipe — to the upstream ircd WebSocket (default
ws://127.0.0.1:8067, nefarious2's plain WS port). Frames are never parsed:
IRC line framing, the text.ircv3.net subprotocol, permessage-deflate and
ping/pong all survive as opaque bytes. Everything else is served from
public/, with the MIME types the SPA and the ORT loader need (.mjs as
text/javascript, .wasm as application/wasm — Python's default map serves
.mjs as octet-stream and the WASM backend's dynamic import then fails
with "no available backend found").

Usage:
    python3 tools/serve.py [--port 8000] [--bind 0.0.0.0] [--dir public]
                           [--upstream ws://127.0.0.1:8067]
                           [--verify-tls] [--verbose]

The upstream may be wss:// (self-signed dev certificates are accepted
unless --verify-tls is given). With no ircd listening on the upstream,
static hosting still works and WebSocket dials fail with a 502.

Note: http://127.0.0.1 is a browser secure context, so the service worker
and the install prompt work there; over a LAN address without TLS they
do not (basic chat still works).
"""

import argparse
import http.server
import selectors
import socket
import ssl
import subprocess
import sys
import threading

# --- configuration (filled by main()) -------------------------------------

STATIC_DIR = "public"
UPSTREAM_SCHEME = "ws"
UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = 8067
UPSTREAM_VERIFY_TLS = False
VERBOSE = False


class SpaHandler(http.server.SimpleHTTPRequestHandler):
    """Static files, plus a WebSocket passthrough on Upgrade requests."""

    protocol_version = "HTTP/1.1"
    server_version = "seance-serve/1.0"
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".woff2": "font/woff2",
        ".webmanifest": "application/manifest+json",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def setup(self):
        """Classify and wrap the connection in this connection's own thread.

        A plaintext request on the TLS port is a mistyped scheme: it is
        flagged for the 301 redirect instead of wrapped. A handshake that
        goes nowhere (a port forward's probe that connects and sends
        nothing) raises here and costs this thread only — doing this work
        on the accept loop let one silent probe stall every new
        connection, which read as the whole site being down.
        """
        ctx = getattr(self.server, "tls_context", None)

        if ctx is None:
            return super().setup()

        # self.request is the accepted socket; self.connection does not
        # exist until the base setup() runs.
        sock = self.request
        sock.settimeout(10)

        try:
            first = sock.recv(5, socket.MSG_PEEK)
        except (OSError, ssl.SSLError):
            first = b""

        if first[:4] in PLAIN_HTTP_PREFIXES:
            self.is_plain_http_connection = True
        else:
            try:
                sock = ctx.wrap_socket(sock, server_side=True)
            except (ssl.SSLError, OSError):
                raise

        sock.settimeout(None)
        # Both, because the base setup() resets connection from request.
        self.request = self.connection = sock
        return super().setup()

    def log_message(self, fmt, *args):
        if VERBOSE:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        # The isolation headers the deploy docs recommend (branding.md §
        # Translation, Threads): multi-threaded WebAssembly for the CPU
        # models, which the browser only allows on a cross-origin-isolated
        # page. `credentialless` spares every cross-origin resource the app
        # loads (link previews, media) the CORP header that `require-corp`
        # would demand. WebGPU does not need these; the CPU speed does.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        # `no-cache` (revalidate every time, not "never store"): without it a
        # browser heuristic-caches assets for hours off Last-Modified, and a
        # dev build's constant `?v=dev` token means a rebuild never changes
        # the URL — the user stares at a stale app and sees "no difference".
        # Revalidation is cheap: SimpleHTTPRequestHandler answers
        # If-Modified-Since with 304 when the file is unchanged.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self.proxy_websocket()
            return

        if self.path in ("/seance-serve.pem", "/seance-serve.crt"):
            self.send_response(200)
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            body = open(CERT_PATH, "rb").read()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        super().do_GET()

    def do_HEAD(self):
        super().do_HEAD()

    def handle(self):
        # A plaintext request on the TLS port (setup flagged it): read the
        # head here — requestline does not exist before the base handler's
        # own parse — then either serve the certificate (public information;
        # fetching it is how a device installs it as a trusted CA) or
        # redirect to https:// with the path and Host carried over.
        if getattr(self, "is_plain_http_connection", False):
            try:
                self.connection.settimeout(5)
                head = b""

                while b"\r\n\r\n" not in head and len(head) < 8192:
                    chunk = self.connection.recv(4096)

                    if not chunk:
                        break

                    head += chunk

                line = head.split(b"\r\n", 1)[0].decode("latin-1")
                parts = line.split(" ")
                path = parts[1] if len(parts) >= 2 else "/"
                host = ""

                for row in head.split(b"\r\n")[1:]:
                    if row.lower().startswith(b"host:"):
                        host = row.split(b":", 1)[1].strip().decode("latin-1")
                        break

                if not host:
                    host = self.connection.getsockname()[0]

                if path in ("/seance-serve.pem", "/seance-serve.crt"):
                    body = open(CERT_PATH, "rb").read()
                    self.connection.sendall(
                        b"HTTP/1.1 200 OK\r\n"
                        b"Content-Type: application/x-x509-ca-cert\r\n"
                        b"Content-Length: " + str(len(body)).encode() + b"\r\n"
                        b"Connection: close\r\n\r\n" + body
                    )
                else:
                    self.connection.sendall(
                        (
                            f"HTTP/1.1 301 Moved Permanently\r\n"
                            f"Location: https://{host}{path}\r\n"
                            f"Content-Length: 0\r\n"
                            f"Connection: close\r\n\r\n"
                        ).encode("latin-1")
                    )
            except OSError:
                pass
            finally:
                try:
                    self.connection.close()
                except OSError:
                    pass

            self.close_connection = True
            return

        return super().handle()

    # -- the WebSocket reverse proxy ----------------------------------------

    def proxy_websocket(self):
        """Relay the upgrade handshake to the upstream, then pipe bytes."""
        self.close_connection = True
        try:
            upstream = socket.create_connection((UPSTREAM_HOST, UPSTREAM_PORT), timeout=5)
        except OSError as err:
            self.log_error("upstream %s://%s:%d down: %s",
                           UPSTREAM_SCHEME, UPSTREAM_HOST, UPSTREAM_PORT, err)
            body = b"upstream ircd unreachable"
            self.wfile.write(
                b"HTTP/1.1 502 Bad Gateway\r\n"
                b"Content-Type: text/plain; charset=utf-8\r\n"
                b"Content-Length: " + str(len(body)).encode() + b"\r\n"
                b"Connection: close\r\n\r\n" + body
            )
            return

        upstream.settimeout(10)
        try:
            if UPSTREAM_SCHEME == "wss":
                ctx = ssl.create_default_context()
                if not UPSTREAM_VERIFY_TLS:
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                upstream = ctx.wrap_socket(upstream, server_hostname=UPSTREAM_HOST)

            # Re-emit the client's handshake verbatim (the browser's
            # Sec-WebSocket-* headers, the text.ircv3.net subprotocol and
            # any extension offers all ride along untouched).
            head = self.requestline + "\r\n"
            for key, value in self.headers.items():
                head += f"{key}: {value}\r\n"
            head += "\r\n"
            upstream.sendall(head.encode("latin-1"))

            # Anything buffered behind the handshake head (browsers send
            # nothing yet, but do not lose a byte if one ever arrives). The
            # peek must not block waiting for a byte that may never come:
            # flip the socket non-blocking around it.
            self.connection.setblocking(False)
            try:
                extra = self.rfile.peek()
            except (BlockingIOError, OSError):
                extra = b""
            finally:
                self.connection.setblocking(True)
            if extra:
                upstream.sendall(extra)

            # The upstream's 101 (or its rejection) goes back verbatim.
            response = b""
            while b"\r\n\r\n" not in response:
                chunk = upstream.recv(4096)
                if not chunk:
                    break
                response += chunk
                if len(response) > 65536:
                    break
            marker = response.find(b"\r\n\r\n")
            head_bytes = response if marker == -1 else response[: marker + 4]
            tail = b"" if marker == -1 else response[marker + 4 :]
            self.wfile.write(head_bytes)
            if tail:
                self.wfile.write(tail)

            status = head_bytes.split(b"\r\n", 1)[0]
            self.log_message("ws upgrade -> %s://%s:%d %s",
                             UPSTREAM_SCHEME, UPSTREAM_HOST, UPSTREAM_PORT,
                             status.decode("latin-1", "replace"))
            if b" 101 " not in head_bytes.split(b"\r\n", 1)[0]:
                return  # rejected; whatever head the upstream sent is relayed
        except OSError as err:
            self.log_error("ws handshake relay failed: %s", err)
            try:
                upstream.close()
            except OSError:
                pass
            return

        upstream.settimeout(None)
        self.connection.settimeout(None)
        self.pipe(self.connection, upstream)

    @staticmethod
    def pipe(client, upstream):
        """Bidirectional byte pipe until either side closes."""
        sel = selectors.DefaultSelector()
        peers = {
            client.fileno(): (client, upstream),
            upstream.fileno(): (upstream, client),
        }
        for sock in peers:
            sel.register(sock, selectors.EVENT_READ)
        try:
            while True:
                for key, _ in sel.select():
                    src, dst = peers[key.fd]
                    try:
                        data = src.recv(65536)
                    except OSError:
                        return
                    if not data:
                        return
                    try:
                        dst.sendall(data)
                    except OSError:
                        return
        finally:
            for sock in {client, upstream}:
                try:
                    sock.close()
                except OSError:
                    pass
            sel.close()


# The first four bytes of the HTTP methods a mistyped http:// URL sends; a
# TLS ClientHello begins 0x16 0x03 and never matches.
PLAIN_HTTP_PREFIXES = (b"GET ", b"HEAD", b"OPTI", b"POST", b"PUT ", b"DELE", b"PATC")


class ThreadingSpaServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, *args, tls_context: ssl.SSLContext | None = None, **kwargs):
        self.tls_context = tls_context
        super().__init__(*args, **kwargs)

    def get_request(self):
        sock, addr = self.socket.accept()

        if VERBOSE:
            sys.stderr.write(f"accepted connection from {addr[0]}:{addr[1]}\n")

        return sock, addr


# --- the self-signed certificate ------------------------------------------

CERT_PATH = "tmp/serve/seance-serve.pem"
KEY_PATH = "tmp/serve/seance-serve-key.pem"


def local_addresses() -> list[str]:
    """Every address this host probably answers to, for the cert's SAN."""
    names = ["localhost"]
    try:
        out = subprocess.run(
            ["hostname", "-I"], capture_output=True, text=True, timeout=5
        ).stdout.split()
        names.extend(out)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        # The address a connection to the outside world would leave from —
        # the one a phone on the same network dials.
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            names.append(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass
    names.append(socket.gethostname())
    seen: list[str] = []

    for name in names:
        if name and name not in seen:
            seen.append(name)

    return seen


def ensure_certificate(extra_sans: list[str] | None = None) -> tuple[str, str]:
    """A self-signed cert with a wide SAN, generated once and reused."""
    import os

    if os.path.exists(CERT_PATH) and os.path.exists(KEY_PATH):
        return CERT_PATH, KEY_PATH

    os.makedirs(os.path.dirname(CERT_PATH), exist_ok=True)
    san = ",".join(
        (f"IP:{addr}" if addr.replace(".", "").isdigit() else f"DNS:{addr}")
        for addr in ([*local_addresses(), "127.0.0.1", *(extra_sans or [])])
        if addr
    )
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            KEY_PATH,
            "-out",
            CERT_PATH,
            "-days",
            "3650",
            "-nodes",
            "-subj",
            "/CN=seance-serve",
            "-addext",
            f"subjectAltName={san}",
        ],
        check=True,
        capture_output=True,
    )
    sys.stderr.write(f"seance-serve: self-signed certificate written to {CERT_PATH}\n")
    return CERT_PATH, KEY_PATH


def main():
    global STATIC_DIR, UPSTREAM_SCHEME, UPSTREAM_HOST, UPSTREAM_PORT
    global UPSTREAM_VERIFY_TLS, VERBOSE

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="0.0.0.0", help="interface to bind (default: all)")
    parser.add_argument("--dir", default="public", help="static root (default: public)")
    parser.add_argument("--http", action="store_true",
                        help="serve plain HTTP instead of HTTPS")
    parser.add_argument("--cert", default=None, help="TLS certificate (default: generated)")
    parser.add_argument("--key", default=None, help="TLS key (default: generated)")
    parser.add_argument(
        "--san",
        action="append",
        default=[],
        help="extra subjectAltName for the generated certificate (repeatable, e.g. --san 10.0.0.41)",
    )
    parser.add_argument("--upstream", default="ws://127.0.0.1:8067",
                        help="ircd WebSocket to proxy (default ws://127.0.0.1:8067)")
    parser.add_argument("--verify-tls", action="store_true",
                        help="verify a wss:// upstream's certificate (default: accept self-signed)")
    parser.add_argument("--verbose", action="store_true", help="log static requests too")
    args = parser.parse_args()

    STATIC_DIR = args.dir
    VERBOSE = args.verbose
    UPSTREAM_VERIFY_TLS = args.verify_tls

    scheme, _, rest = args.upstream.partition("://")
    if scheme not in ("ws", "wss") or not rest:
        parser.error("--upstream must be ws://host:port or wss://host:port")
    UPSTREAM_SCHEME = scheme
    host, _, port = rest.rpartition(":")
    bracketed = host.startswith("[") and host.endswith("]")
    UPSTREAM_HOST = host[1:-1] if bracketed else (host or "127.0.0.1")
    try:
        UPSTREAM_PORT = int(port)
    except ValueError:
        parser.error("--upstream port must be an integer")

    if args.http:
        server = ThreadingSpaServer((args.bind, args.port), SpaHandler)
    else:
        if args.cert and args.key:
            cert, key = args.cert, args.key
        else:
            cert, key = ensure_certificate(args.san)

        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        # The context goes to the server: each accepted socket is wrapped in
        # its own thread, so a bad handshake cannot stall the accept loop.
        server = ThreadingSpaServer((args.bind, args.port), SpaHandler, tls_context=ctx)

    sys.stderr.write(
        f"seance-serve: {'https' if not args.http else 'http'}://{args.bind}:{args.port}/ "
        f"(static: {STATIC_DIR}), ws proxy -> {args.upstream}\n"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
