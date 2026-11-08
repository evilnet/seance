// Raw TCP/TLS IRC connections for the page (client/js/irc/shellSocket.ts),
// for networks with no WebSocket listener. The page's WsTransport keeps its
// whole connection policy; this only moves lines: CRLF framing out, lines
// split and decoded in, TLS against Mozilla's roots (webpki-roots).
//
// Unlike the shell's other calls this does something a web page cannot, so
// every limit is enforced here, not trusted to the page, to keep it an IRC
// client and not a general one for whatever listens on the LAN:
// - ports on the Fetch spec's bad-ports list (SMTP, POP, IMAP, …) are refused;
// - a sent line may not be empty or hold CR, LF or NUL;
// - until the server has said something that looks like IRC, only the
//   registration commands may be sent, and a first line that does not look
//   like IRC (an HTTP status, a Redis `-ERR`) closes the socket;
// - lines, queues and writes are capped; at most MAX_SOCKETS at once, and
//   MAX_OPENS a minute (no scanning the LAN through it).
//
// `Socket.open {id, page, host, port, tls}` → events `open {id}`, `lines
// {id, lines}` (one per read), `close {id, code, reason}`: 1000 when the
// server ended the connection, FINAL (4001) for a failure a retry cannot
// mend (an untrusted certificate, a server that is not IRC), 1006 for any
// other. `Socket.send {id,
// lines}`, once open. `Socket.close {id}`: the queued lines are written (a
// QUIT gets out), the socket shut, and no event follows. A page load closes
// every socket, and an open from the page before it (`page`, a token per
// page load) is refused.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::ShellError;

const PLUGIN: &str = "Socket";
const MAX_SOCKETS: usize = 16;
/// Opens allowed per OPEN_WINDOW: enough for every network's quick retries
/// after a network change, too few for the page to scan a LAN with.
const MAX_OPENS: usize = 30;
const OPEN_WINDOW: Duration = Duration::from_secs(60);
/// Queued outbound lines per socket; past it the socket is closed.
const SEND_QUEUE: usize = 512;
/// A sent line, before CRLF. The page caps lines at 500 bytes already.
const MAX_SEND_LINE: usize = 4096;
/// A received line; an ircd's own limit is 8191 + 512 bytes of tags.
const MAX_LINE: usize = 16 * 1024;
const ADDRESS_TIMEOUT: Duration = Duration::from_secs(5);
const DIAL_DEADLINE: Duration = Duration::from_secs(20);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const PAGE_GONE_GRACE: Duration = Duration::from_secs(1);
/// One write; a server that stops reading must not hold the socket forever.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// What may be sent before the server has said anything IRC-like. PING is
/// the page's liveness probe, QUIT a disconnect before any reply.
const REGISTRATION: &[&str] = &[
    "CAP",
    "PASS",
    "NICK",
    "USER",
    "AUTHENTICATE",
    "PING",
    "QUIT",
];

/// The Fetch spec's bad ports (https://fetch.spec.whatwg.org/#port-blocking),
/// less the IRC ones on it (6665–6669, 6679, 6697).
const BAD_PORTS: &[u16] = &[
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
    102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427,
    465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
    993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 10080,
];

/// A live socket: its queue of lines to write — dropping the sender is how
/// a socket is closed, its task drains what is queued and ends — and what
/// its task has seen.
struct Entry {
    tx: mpsc::Sender<String>,
    /// Connected (the page may send).
    open: Arc<AtomicBool>,
    /// The server's first line looked like IRC (any command may be sent).
    greeted: Arc<AtomicBool>,
}

#[derive(Default)]
struct State {
    sockets: HashMap<String, Entry>,
    /// The token of the page load that is opening sockets.
    page: Option<String>,
    /// Tokens of earlier page loads, whose late opens are refused.
    retired: HashSet<String>,
    /// The page before a reload's sockets, for PAGE_GONE_GRACE: WebKit
    /// starts the new load before the old page's `pagehide`, whose QUIT
    /// must still get out. They are closed nowhere but here; what they
    /// still read reaches no page route.
    retiring: HashMap<String, Entry>,
    /// When the last MAX_OPENS opens were accepted.
    opens: VecDeque<Instant>,
}

#[derive(Default)]
pub struct Sockets(Mutex<State>);

impl Sockets {
    /// A page load: the old page's sockets go with it, after a grace for
    /// the QUIT its `pagehide` sends.
    pub fn close_all(&self, app: &AppHandle) {
        let mut state = self.0.lock().unwrap();
        let old: Vec<String> = state.sockets.keys().cloned().collect();
        let sockets = std::mem::take(&mut state.sockets);
        state.retiring.extend(sockets);

        if let Some(page) = state.page.take() {
            state.retired.insert(page);
        }

        if old.is_empty() {
            return;
        }

        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(PAGE_GONE_GRACE).await;
            let sockets = app.state::<Sockets>();
            let mut state = sockets.0.lock().unwrap();

            for id in old {
                state.retiring.remove(&id);
            }
        });
    }
}

fn refuse(message: impl Into<String>) -> ShellError {
    ShellError {
        message: message.into(),
        code: "refused".into(),
    }
}

fn str_option<'a>(options: &'a Value, key: &str) -> Option<&'a str> {
    options.get(key).and_then(Value::as_str)
}

pub fn call(app: &AppHandle, method: &str, options: &Value) -> Result<Value, ShellError> {
    let sockets = app.state::<Sockets>();
    let id = str_option(options, "id")
        .filter(|id| !id.is_empty() && id.len() <= 64)
        .ok_or_else(|| refuse("no socket id"))?
        .to_owned();

    match method {
        "open" => {
            let page = str_option(options, "page")
                .filter(|p| !p.is_empty() && p.len() <= 64)
                .ok_or_else(|| refuse("no page token"))?
                .to_owned();
            let host = str_option(options, "host")
                .map(clean_host)
                .unwrap_or_default();
            let port = options.get("port").and_then(Value::as_u64).unwrap_or(0);
            let tls = options.get("tls").and_then(Value::as_bool).unwrap_or(false);

            if host.is_empty() || host.len() > 255 {
                return Err(refuse("no host"));
            }

            let port = u16::try_from(port)
                .ok()
                .filter(|p| port_allowed(*p))
                .ok_or_else(|| refuse(format!("port {port} is not allowed")))?;
            let (tx, rx) = mpsc::channel(SEND_QUEUE);
            let open = Arc::new(AtomicBool::new(false));
            let greeted = Arc::new(AtomicBool::new(false));

            {
                let mut state = sockets.0.lock().unwrap();

                // An open the page before a reload sent, handled after it.
                if state.retired.contains(&page) {
                    return Err(refuse("the page that opened this is gone"));
                }

                state.page = Some(page);

                if state.sockets.contains_key(&id) {
                    return Err(refuse("socket id in use"));
                }

                if state.sockets.len() >= MAX_SOCKETS {
                    return Err(refuse("too many connections"));
                }

                let now = Instant::now();

                while state
                    .opens
                    .front()
                    .is_some_and(|at| now.duration_since(*at) >= OPEN_WINDOW)
                {
                    state.opens.pop_front();
                }

                if state.opens.len() >= MAX_OPENS {
                    return Err(refuse("too many connections opened; trying again shortly"));
                }

                state.opens.push_back(now);

                // In the map before the task starts: a close that comes
                // while it dials finds it, and the dial is abandoned.
                state.sockets.insert(
                    id.clone(),
                    Entry {
                        tx: tx.clone(),
                        open: open.clone(),
                        greeted: greeted.clone(),
                    },
                );
            }

            let task = Task {
                app: app.clone(),
                id,
                marker: tx.downgrade(),
                open,
                greeted,
            };
            drop(tx);
            tauri::async_runtime::spawn(task.run(host, port, tls, rx));
            Ok(json!({}))
        }
        "send" => {
            let lines = options
                .get("lines")
                .and_then(Value::as_array)
                .ok_or_else(|| refuse("no lines"))?;
            let (tx, greeted) = {
                let state = sockets.0.lock().unwrap();
                let entry = state
                    .sockets
                    .get(&id)
                    .or_else(|| state.retiring.get(&id))
                    .ok_or_else(|| refuse("no such socket"))?;

                if !entry.open.load(Ordering::SeqCst) {
                    return Err(refuse("not connected yet"));
                }

                (entry.tx.clone(), entry.greeted.load(Ordering::SeqCst))
            };

            for line in lines {
                let line = line.as_str().ok_or_else(|| refuse("a line is not text"))?;
                let checked = check_send_line(line).and_then(|()| {
                    if greeted || is_registration(line) {
                        Ok(())
                    } else {
                        Err("only registration before the server has answered")
                    }
                });

                if let Err(reason) = checked {
                    end_socket(app, &id, None, 1006, reason);
                    return Err(refuse(reason));
                }

                if tx.try_send(line.to_owned()).is_err() {
                    end_socket(app, &id, None, 1006, "send queue full");
                    return Err(refuse("send queue full"));
                }
            }

            Ok(json!({}))
        }
        "close" => {
            let mut state = sockets.0.lock().unwrap();
            state.sockets.remove(&id);
            state.retiring.remove(&id);
            Ok(json!({}))
        }
        _ => Err(ShellError {
            message: format!("{PLUGIN}.{method} is not implemented"),
            code: "unimplemented".into(),
        }),
    }
}

/// Close a socket the page did not ask to close, and tell the page why.
/// `owner`: the socket's own task ending it (the server, the network), which
/// says nothing if the page closed it meanwhile or a newer page owns the id.
/// None: the shell refusing a send; a page that is gone hears nothing.
fn end_socket(
    app: &AppHandle,
    id: &str,
    owner: Option<&mpsc::Sender<String>>,
    code: u16,
    reason: &str,
) {
    let sockets = app.state::<Sockets>();
    let mut state = sockets.0.lock().unwrap();

    if owner.is_none() {
        state.retiring.remove(id);
    }

    let ours = state
        .sockets
        .get(id)
        .is_some_and(|entry| owner.map_or(true, |tx| entry.tx.same_channel(tx)));

    if ours {
        state.sockets.remove(id);
        drop(state);
        crate::emit(
            app,
            PLUGIN,
            "close",
            json!({"id": id, "code": code, "reason": reason}),
            false,
        );
    }
}

trait Stream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Stream for T {}

/// One socket's task: dial, then move lines both ways until either side ends.
struct Task {
    app: AppHandle,
    id: String,
    /// Recognises our map entry; it stops upgrading once the page closed us.
    marker: mpsc::WeakSender<String>,
    open: Arc<AtomicBool>,
    greeted: Arc<AtomicBool>,
}

impl Task {
    async fn run(self, host: String, port: u16, tls: bool, mut rx: mpsc::Receiver<String>) {
        let dial = tokio::time::timeout(DIAL_DEADLINE, dial(&host, port, tls));
        let stream = tokio::select! {
            result = dial => match result {
                Ok(Ok(stream)) => stream,
                Ok(Err((code, reason))) => return self.end(code, &reason),
                Err(_) => return self.end(1006, "connect timed out"),
            },
            // Closed by the page while dialling (`send` refuses lines until
            // open, so nothing but the close can arrive): give up quietly.
            _ = rx.recv() => return,
        };

        self.open.store(true, Ordering::SeqCst);
        crate::emit(&self.app, PLUGIN, "open", json!({ "id": self.id }), false);
        let (mut reader, mut writer) = tokio::io::split(stream);
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 16 * 1024];

        loop {
            tokio::select! {
                read = reader.read(&mut chunk) => match read {
                    Ok(0) => return self.end(1000, "the server closed the connection"),
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);

                        match take_lines(&mut buf) {
                            Ok(lines) if lines.is_empty() => {}
                            Ok(lines) => {
                                if !self.greeted.load(Ordering::SeqCst) {
                                    if !looks_like_irc(&lines[0]) {
                                        return self.end(FINAL, "the server does not speak IRC");
                                    }

                                    self.greeted.store(true, Ordering::SeqCst);
                                }

                                crate::emit(&self.app, PLUGIN, "lines", json!({"id": self.id, "lines": lines}), false);
                            }
                            Err(reason) => return self.end(1006, reason),
                        }
                    }
                    // Most ircds drop the connection without TLS's close_notify.
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        return self.end(1000, "the server closed the connection")
                    }
                    Err(e) => return self.end(1006, &e.to_string()),
                },
                line = rx.recv() => {
                    // Closed by the page (or a page load) once our marker is
                    // dead: whatever is still queued (a QUIT) gets the drain's
                    // time, all of it, then the socket is shut, quietly.
                    let Some(line) = line else {
                        return drain(&mut writer, Vec::new()).await;
                    };

                    if self.marker.upgrade().is_none() {
                        let mut rest = vec![line];

                        while let Ok(more) = rx.try_recv() {
                            rest.push(more);
                        }

                        return drain(&mut writer, rest).await;
                    }

                    match tokio::time::timeout(WRITE_TIMEOUT, write_line(&mut writer, line)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => return self.end(1006, &e.to_string()),
                        Err(_) => return self.end(1006, "the server stopped reading"),
                    }
                }
            }
        }
    }

    /// The socket ended on its own: tell the page, unless it closed us.
    fn end(&self, code: u16, reason: &str) {
        if let Some(tx) = self.marker.upgrade() {
            end_socket(&self.app, &self.id, Some(&tx), code, reason);
        }
    }
}

async fn write_line<W: AsyncWrite + Unpin>(writer: &mut W, line: String) -> std::io::Result<()> {
    let mut bytes = line.into_bytes();
    bytes.extend_from_slice(b"\r\n");
    writer.write_all(&bytes).await
}

/// Write what is left, flush and shut down, all within DRAIN_TIMEOUT.
async fn drain<W: AsyncWrite + Unpin>(writer: &mut W, lines: Vec<String>) {
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
        for line in lines {
            if write_line(writer, line).await.is_err() {
                return;
            }
        }

        let _ = writer.flush().await;
        let _ = writer.shutdown().await;
    })
    .await;
}

/// A close code of the application range (as WebSocket's 4000–4999): the
/// page does not retry it, since the next dial would fail the same way.
const FINAL: u16 = 4001;

/// Dial `host`; a failure is its close code and reason.
async fn dial(host: &str, port: u16, tls: bool) -> Result<Box<dyn Stream>, (u16, String)> {
    let addrs: Vec<_> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| (1006, format!("cannot resolve {host}: {e}")))?
        .collect();
    let mut last = format!("{host} has no address");
    let mut tcp = None;

    // One address at a time, each with its own timeout: a dead IPv6 route
    // must not use up the whole wait before IPv4 is tried.
    for addr in addrs {
        match tokio::time::timeout(ADDRESS_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => {
                tcp = Some(stream);
                break;
            }
            Ok(Err(e)) => last = e.to_string(),
            Err(_) => last = format!("{addr} timed out"),
        }
    }

    let tcp = tcp.ok_or((1006, last))?;
    let _ = tcp.set_nodelay(true);

    if !tls {
        return Ok(Box::new(tcp));
    }

    let name = rustls::pki_types::ServerName::try_from(host.to_owned())
        .map_err(|_| (FINAL, format!("{host} is not a valid TLS server name")))?;
    let stream = tls_connector()
        .map_err(|reason| (1006, reason))?
        .connect(name, tcp)
        .await
        .map_err(tls_failure)?;
    Ok(Box::new(stream))
}

/// A failed handshake, in words a user can act on. A certificate that is
/// not trusted now will not be on the next dial: final.
fn tls_failure(e: std::io::Error) -> (u16, String) {
    let detail = e.to_string();

    match e
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    {
        Some(rustls::Error::InvalidCertificate(cert)) => {
            use rustls::CertificateError as C;
            // The plain reason, not rustls's debug text (`Other(OtherError(…))`).
            let why = match cert {
                C::Expired | C::ExpiredContext { .. } => ": it has expired",
                C::NotValidForName | C::NotValidForNameContext { .. } => {
                    ": it is for a different name"
                }
                C::UnknownIssuer => ": it is signed by an unknown authority",
                // The device's clock may be what is wrong: worth retrying.
                C::NotValidYet | C::NotValidYetContext { .. } => {
                    return (
                        1006,
                        "the server's certificate is not valid yet: is this device's clock right?"
                            .into(),
                    );
                }
                _ => ": it may be self-signed",
            };
            (
                FINAL,
                format!("the server's certificate is not trusted{why}"),
            )
        }
        _ => (1006, format!("TLS failed: {detail}")),
    }
}

/// Built once: Mozilla's roots on the ring provider.
fn tls_connector() -> Result<tokio_rustls::TlsConnector, String> {
    static CONFIG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    let config = CONFIG.get_or_init(|| {
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map(|builder| Arc::new(builder.with_root_certificates(roots).with_no_client_auth()))
        .map_err(|e| e.to_string())
    });
    config.clone().map(tokio_rustls::TlsConnector::from)
}

/// `[::1]` → `::1`; anything else as given, trimmed.
fn clean_host(host: &str) -> String {
    let host = host.trim();
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
        .to_owned()
}

fn port_allowed(port: u16) -> bool {
    !BAD_PORTS.contains(&port)
}

fn check_send_line(line: &str) -> Result<(), &'static str> {
    if line.is_empty() {
        Err("an empty line")
    } else if line.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) {
        Err("a line may not hold CR, LF or NUL")
    } else if line.len() > MAX_SEND_LINE {
        Err("line too long")
    } else {
        Ok(())
    }
}

/// The command of a line the page sends (no tags or prefix from a client).
fn command_of(line: &str) -> &str {
    line.split(' ').next().unwrap_or("")
}

fn is_registration(line: &str) -> bool {
    let command = command_of(line);
    REGISTRATION.iter().any(|c| c.eq_ignore_ascii_case(command))
}

/// A server's first line: tags, a prefix (an ircd prefixes its numerics),
/// or a command an ircd sends unprompted. An HTTP status line, a Redis
/// `-ERR` or an SMTP `220` greeting is none of these.
fn looks_like_irc(line: &str) -> bool {
    if line.starts_with('@') || line.starts_with(':') {
        return true;
    }

    // Without a prefix, only what a server says before it knows us, and
    // with a parameter: a bare `ERROR` is memcached's answer to anything.
    let command = command_of(line);
    let has_param = line
        .split_once(' ')
        .is_some_and(|(_, rest)| !rest.trim().is_empty());
    has_param
        && ["PING", "NOTICE", "ERROR"]
            .iter()
            .any(|c| c.eq_ignore_ascii_case(command))
}

/// The complete lines in `buf` (LF-terminated, a trailing CR stripped, empty
/// ones dropped), decoded; the unterminated rest stays in `buf`. A line over
/// MAX_LINE, finished or not, is an error.
fn take_lines(buf: &mut Vec<u8>) -> Result<Vec<String>, &'static str> {
    let mut lines = Vec::new();
    let mut start = 0;

    while let Some(at) = buf[start..].iter().position(|&b| b == b'\n') {
        let end = start + at;
        let mut line = &buf[start..end];

        if let [rest @ .., b'\r'] = line {
            line = rest;
        }

        if line.len() > MAX_LINE {
            return Err("line too long");
        }

        if !line.is_empty() {
            lines.push(decode(line));
        }

        start = end + 1;
    }

    buf.drain(..start);

    // The rest may still end in the CR of a CRLF split across reads.
    if buf.len() > MAX_LINE + 1 {
        return Err("line too long");
    }

    Ok(lines)
}

/// UTF-8, or Latin-1 for a line that is not (older networks and clients).
fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_crlf_and_lf_and_keeps_the_rest() {
        let mut buf = b"PING :a\r\nNOTICE x :y\n\r\n:part".to_vec();
        assert_eq!(
            take_lines(&mut buf).unwrap(),
            vec!["PING :a", "NOTICE x :y"]
        );
        assert_eq!(buf, b":part");
        buf.extend_from_slice(b"ial\r\n");
        assert_eq!(take_lines(&mut buf).unwrap(), vec![":partial"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn refuses_overlong_lines_finished_or_not() {
        let mut long = vec![b'a'; MAX_LINE + 2];
        assert!(take_lines(&mut long.clone()).is_err());
        long.truncate(MAX_LINE + 1);
        long.push(b'\n');
        assert!(take_lines(&mut long).is_err());
        let mut ok = vec![b'a'; MAX_LINE];
        ok.extend_from_slice(b"\r\n");
        assert_eq!(take_lines(&mut ok).unwrap()[0].len(), MAX_LINE);
    }

    #[test]
    fn decodes_utf8_or_latin1() {
        assert_eq!(decode("café".as_bytes()), "café");
        assert_eq!(decode(b"caf\xe9"), "café");
        assert_eq!(decode(b"\x01ACTION waves\x01"), "\u{1}ACTION waves\u{1}");
    }

    #[test]
    fn checks_sent_lines() {
        assert!(check_send_line("PRIVMSG #a :hi").is_ok());
        assert!(check_send_line("PRIVMSG #a :hi\r\nQUIT").is_err());
        assert!(check_send_line("a\0b").is_err());
        assert!(check_send_line("").is_err());
        assert!(check_send_line(&"a".repeat(MAX_SEND_LINE + 1)).is_err());
    }

    #[test]
    fn allows_irc_ports_and_refuses_bad_ones() {
        for port in [6665, 6667, 6669, 6679, 6697, 7000, 994, 443, 8067] {
            assert!(port_allowed(port), "{port}");
        }

        for port in [0, 22, 25, 110, 143, 587, 993] {
            assert!(!port_allowed(port), "{port}");
        }
    }

    #[test]
    fn lets_only_registration_out_before_the_server_answers() {
        for line in [
            "CAP LS 302",
            "NICK me",
            "USER me 0 * :me",
            "AUTHENTICATE PLAIN",
            "ping :probe",
            "QUIT :bye",
            "PASS x",
        ] {
            assert!(is_registration(line), "{line}");
        }

        for line in [
            "GET / HTTP/1.1",
            "POST /containers/create HTTP/1.1",
            "SET k v",
            "PRIVMSG #a :x",
            "Host: x",
        ] {
            assert!(!is_registration(line), "{line}");
        }
    }

    #[test]
    fn knows_an_irc_server_by_its_first_line() {
        for line in [
            ":irc.test NOTICE * :*** Looking up",
            "@time=x :s 001 me :hi",
            "NOTICE AUTH :hi",
            "PING :123",
            "ERROR :Closing link",
        ] {
            assert!(looks_like_irc(line), "{line}");
        }

        for line in [
            "HTTP/1.1 400 Bad Request",
            "-ERR unknown command",
            "+OK",
            "SSH-2.0-OpenSSH_9.6",
            "220 smtp ready ESMTP",
            "ERROR",
            "ERROR ",
            "CAP LS 302",
        ] {
            assert!(!looks_like_irc(line), "{line}");
        }
    }

    #[test]
    fn strips_ipv6_brackets() {
        assert_eq!(clean_host(" [::1] "), "::1");
        assert_eq!(clean_host("irc.example.org"), "irc.example.org");
    }

    #[tokio::test]
    async fn dials_plain_tcp_and_frames_lines() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            sock.write_all(b":srv 001 me :hi\r\n").await.unwrap();
            let mut got = vec![0u8; 64];
            let n = sock.read(&mut got).await.unwrap();
            got.truncate(n);
            got
        });
        let mut stream = dial("127.0.0.1", port, false).await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 64];
        let n = stream.read(&mut chunk).await.unwrap();
        buf.extend_from_slice(&chunk[..n]);
        assert_eq!(take_lines(&mut buf).unwrap(), vec![":srv 001 me :hi"]);
        stream.write_all(b"NICK me\r\n").await.unwrap();
        assert_eq!(server.await.unwrap(), b"NICK me\r\n");
    }

    #[tokio::test]
    async fn reports_a_refused_dial() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(dial("127.0.0.1", port, false).await.is_err());
    }

    #[test]
    fn tls_config_builds_with_ring() {
        assert!(tls_connector().is_ok());
    }
}
