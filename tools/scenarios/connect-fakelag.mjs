// The connect burst against nefarious2's fake lag, measured from what the
// page actually sends.
//
//   corepack yarn build && python3 -m http.server -d public 8047 &
//   node tools/browser-drive.mjs tools/scenarios/connect-fakelag.mjs --no-ws
//
// Needs the dev ircd (tools/nefarious-dev/run.sh). `SEANCE_PORT` (default
// 8047) is where `public/` is served, `SEANCE_FAKELAG_CHANNELS` (default 12)
// how many channels to autojoin, `SEANCE_FAKELAG_WAIT` (ms, default 30000)
// how long to watch each connect — the fresh one longer, until every
// channel has its history (at most 20 + 4·N s).
//
// The page's WebSocket is wrapped to timestamp every line, and the server's
// clock is replayed over them exactly as parse.c and s_bsd.c keep it: each
// command after 001 adds 2 s + 1 s per 120 bytes, and the clock is pulled up
// to now on every read. The server stops reading at 10 s ahead, so the peak
// is what the user feels: a line typed while the clock is at 8 s is read 2 s
// later than it was sent. Before irc/fakelag.ts the catch-up held it at ~10 s
// for the whole catch-up (two commands every 4 s drain exactly as fast as
// they are charged); now background work only goes out under 4 s, and the
// one burst that can push it higher is the JOIN with the open channel's
// history pipelined behind it (6 s).
//
// With `SEANCE_FAKELAG_TYPE=<ms>` it also types a line that often and
// reports each one's send → echo time; the clock checks below are about
// background work and will fail with typing on, since typed lines count.
//
// Checks, on a fresh connect and on a reconnect of the same page:
//   * the peak stays at or under 6 s (8 s with the open channel's walk-back
//     page), and once the burst is over at or
//     under the background budget (4 s);
//   * every autojoined channel gets its history in the end (fresh connect);
//   * the reconnect asks for no marker the server has already answered;
//   * each connect asks one `CHATHISTORY TARGETS`, and a reconnect still
//     fetches every channel, the quiet ones last;
//   * after a helper writes to one channel while the page is offline, that
//     channel is the first one the reconnect fetches.

const PORT = process.env.SEANCE_PORT || "8047";
// The ircd's WebSocket (TLS) and plain ports. The dev ircd's image turns
// fake lag off for users (`fakelagfactor = 0` in base.conf-dist), so it
// shows what the client sends but never the delay: point these at a copy
// with those lines removed to see the server hold lines back for real.
const IRC_PORT = process.env.SEANCE_IRC_PORT || "8443";
const PLAIN_PORT = Number(process.env.SEANCE_IRC_PLAIN_PORT || 6667);
const N = Number(process.env.SEANCE_FAKELAG_CHANNELS || 12);
const WAIT = Number(process.env.SEANCE_FAKELAG_WAIT || 30000);
const CHANS = Array.from({length: N}, (_, i) => `#lag${i}`);
const NICK = "lag" + Date.now().toString(36).slice(-5);

export const url =
	`http://localhost:${PORT}/?host=localhost&port=${IRC_PORT}&tls=true&nick=${NICK}&join=` +
	encodeURIComponent(CHANS.join(","));

const WRAP = `(() => {
  const t0 = performance.timeOrigin;
  const log = (window.__wire = []);
  const socks = (window.__socks = []);
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(url, ...rest) {
      // While the scenario holds the page "offline", every dial fails.
      super(window.__offline ? "ws://127.0.0.1:9/" : url, ...rest);
      socks.push(this);
      this.addEventListener("message", (e) => {
        for (const l of String(e.data).split(/\\r?\\n/)) if (l) log.push({t: t0 + performance.now(), d: "in", l});
      });
    }
    send(data) {
      for (const l of String(data).split(/\\r?\\n/)) if (l) log.push({t: t0 + performance.now(), d: "out", l});
      return super.send(data);
    }
  };
})();`;

/** Replay the server's clock over the captured lines. */
function replay(wire) {
	let since = null;
	let registered = null;
	const out = [];

	for (const x of wire) {
		const now = x.t / 1000;

		if (x.d === "in" && registered === null && / 001 /.test(x.l)) {
			registered = now;
			since = now;
		}

		if (x.d !== "out" || registered === null) {
			continue;
		}

		since = Math.max(since, now) + 2 + Math.floor((Buffer.byteLength(x.l) + 2) / 120);
		out.push({at: now - registered, ahead: since - now, line: x.l});
	}

	return out;
}

/**
 * An opered helper on the plain-IRC port, one connection for the whole run.
 * nefarious2 rations the channels a client may newly join or message
 * ("target changes", 439) and remembers the ration per address across
 * reconnects (IPcheck), so a helper per seed — 12 channels each — ran it
 * dry within a run or two and the next run's JOIN was refused for minutes.
 * One helper joins each channel once; a refusal is waited out as the
 * server says. Every wait is bounded: an ircd that never answers fails the
 * run with what it said instead of hanging it with Chrome left open.
 */
let helper = null;

async function openHelper() {
	const {connect} = await import("node:net");
	const sock = connect(PLAIN_PORT, "127.0.0.1");
	const h = {sock, buf: "", ended: null, joined: new Set()};
	sock.on("close", () => (h.ended ??= "the server closed the connection"));
	sock.on("error", (e) => (h.ended = e.message));
	let pending = "";
	sock.on("data", (d) => {
		pending += d.toString();
		const lines = pending.split(/\r?\n/);
		pending = lines.pop();

		for (const line of lines) {
			h.buf += line + "\n";

			if (line.startsWith("PING ")) {
				sock.write(`PONG ${line.slice(5)}\r\n`);
			}
		}
	});
	h.waitFor = (re, what, {from = 0, ms = 20000} = {}) =>
		new Promise((resolve, reject) => {
			const until = Date.now() + ms;
			const check = () => {
				const m = re.exec(h.buf.slice(from));

				if (m) {
					resolve(m);
				} else if (h.ended || Date.now() > until) {
					const tail = h.buf.trim().split("\n").slice(-3).join(" | ");
					reject(
						new Error(
							`seed helper: no ${what} (${
								h.ended ?? ms / 1000 + " s"
							}); last: ${tail}`
						)
					);
				} else {
					setTimeout(check, 50);
				}
			};
			check();
		});
	const nick = "seed" + Date.now().toString(36).slice(-5);
	sock.write(`NICK ${nick}\r\nUSER ${nick} 0 * :${nick}\r\n`);
	await h.waitFor(/ 001 /, "welcome");
	sock.write("OPER seanceop seance\r\n");
	await h.waitFor(/ 381 /, "OPER");
	return h;
}

/** Join what the helper is not in yet, waiting out the server's target ration. */
async function helperJoin(h, chans) {
	const deadline = Date.now() + 240000;

	for (let todo = chans.filter((c) => !h.joined.has(c)); todo.length > 0; ) {
		const from = h.buf.length;
		h.sock.write(`JOIN ${todo.join(",")}\r\n`);
		const end = new RegExp(
			` 366 \\S+ \\${todo.at(-1)} | 439 \\S+ (\\S+) .*wait (\\d+) seconds`
		);
		const m = await h.waitFor(end, "JOIN", {from});
		// The rest of the list is still being answered.
		await new Promise((r) => setTimeout(r, 500));

		for (const c of todo) {
			if (new RegExp(` 366 \\S+ \\${c} `).test(h.buf.slice(from))) {
				h.joined.add(c);
			}
		}

		todo = todo.filter((c) => !h.joined.has(c));

		if (m[2] && todo.length > 0) {
			const wait = (Number(m[2]) + 1) * 1000;

			if (Date.now() + wait > deadline) {
				throw new Error(`seed helper: ${m[0].trim()} (more than the run can wait)`);
			}

			console.log(`seed helper: ${m[0].trim()}; waiting`);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
}

/**
 * The helper posts `count` lines into each of `chans` — opers are not
 * charged for PRIVMSG.
 */
async function seed(chans, count) {
	helper ??= await openHelper();
	await helperJoin(helper, chans);

	for (let i = 0; i < count; i++) {
		helper.sock.write(chans.map((c) => `PRIVMSG ${c} :busy line ${i} in ${c}\r\n`).join(""));
		// Slow enough for the server's receive queue (Excess Flood otherwise).
		await new Promise((r) => setTimeout(r, 100));
	}
}

function closeHelper() {
	helper?.sock.end("QUIT :done\r\n");
	helper = null;
}

const command = (line) =>
	line
		.replace(/^@\S+ /, "")
		.split(" ")
		.slice(0, 2)
		.join(" ");

/**
 * With `SEANCE_FAKELAG_TYPE=<ms>`, type a line into the composer that often
 * while watching. Under echo-message the echo comes back when the server
 * has read the line, so send → echo is the delay the user feels.
 */
const TYPE = Number(process.env.SEANCE_FAKELAG_TYPE || 0);

async function typeWhileWatching(page, label) {
	const start = Date.now();
	let n = 0;

	while (TYPE > 0 && Date.now() - start + TYPE < WAIT) {
		await page.sleep(TYPE);
		n++;
		await page.fill("#input", `typed ${NICK} ${label} ${n}`);
		await page.click("#submit");
	}

	await page.sleep(Math.max(0, WAIT - (Date.now() - start)));
}

function typedDelays(wire, label) {
	const delays = [];
	const sentAt = new Map();

	for (const x of wire) {
		const m = new RegExp(` PRIVMSG \\S+ :(typed ${NICK} ${label} \\d+)$`).exec(x.l);

		if (!m) {
			continue;
		}

		if (x.d === "out") {
			sentAt.set(m[1], x.t);
		} else if (sentAt.has(m[1]) && !/^@\S*batch=/.test(x.l)) {
			// The live echo: ours, outside any history batch.
			delays.push({line: m[1], wait: (x.t - sentAt.get(m[1])) / 1000});
			sentAt.delete(m[1]);
		}
	}

	return delays;
}

/** `CHATHISTORY LATEST` targets among `sent` (replayed lines). */
const latestFetched = (sent) =>
	new Set(
		sent
			.filter((s) => command(s.line) === "CHATHISTORY LATEST")
			.map((s) => s.line.split(" ")[3])
	);

/**
 * Watch for WAIT ms, then — with `until` — on until `until(sent)` holds or
 * `cap` ms have passed in all.
 */
async function watch(page, label, {until, cap = WAIT} = {}) {
	const start = Date.now();
	await typeWhileWatching(page, label);

	while (
		until &&
		!until(replay(await page.evaluate("window.__wire"))) &&
		Date.now() - start < cap
	) {
		await page.sleep(1000);
	}

	const wire = await page.evaluate("window.__wire");
	const sent = replay(wire);

	if (TYPE > 0) {
		const typed = typedDelays(wire, label);
		results[`${label}.wire`] = wire.filter((x) => / :typed /.test(x.l));
		results[`${label}.typed`] = typed;
		console.log(
			`${label}: typed lines echoed after ${typed
				.map((t) => t.wait.toFixed(1) + " s")
				.join(", ")}`
		);
	}
	const answer = wire
		.filter(
			(x) =>
				x.d === "in" &&
				/ (CHATHISTORY TARGETS |BATCH [+-]\S+ draft\/chathistory-targets)/.test(x.l)
		)
		.map((x) => x.l);
	results[`${label}.targets`] = answer;
	console.log(`${label}: TARGETS answer\n${answer.map((l) => "    " + l).join("\n")}`);
	const peak = Math.max(0, ...sent.map((s) => s.ahead));
	const late = sent.filter((s) => s.at > 1);
	const latePeak = Math.max(0, ...late.map((s) => s.ahead));
	console.log(`${label}: ${sent.length} commands after 001, peak ${peak.toFixed(1)} s ahead`);

	for (const s of sent) {
		console.log(`  +${s.at.toFixed(2)}s ahead=${s.ahead.toFixed(1)} ${s.line.slice(0, 120)}`);
	}

	// 6 s, plus the open channel's walk-back page when it has one: that page
	// goes at once while the clock is under 6 s (history.ts PAGE_NOW_LIMIT_MS).
	page.check(
		`${label}: the clock never passes 8 s ahead (peak ${peak.toFixed(1)})`,
		peak <= 8.05
	);
	page.check(
		`${label}: after the burst, background work stays within 4 s (peak ${latePeak.toFixed(1)})`,
		latePeak <= 4.05
	);
	results[label] = sent;
	return sent;
}

const results = {};

export default async function run(page) {
	try {
		await scenario(page);
	} finally {
		closeHelper();
	}
}

async function scenario(page) {
	// Every channel holds a message, as real ones do: a channel with none is
	// never in a TARGETS answer, and one left out is always fetched.
	await seed(CHANS, 1);
	await page.addInitScript(WRAP);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click("#connect button[type=submit]");
	// To the end of the catch-up, so the reconnect below can tell a quiet
	// channel from one the fresh connect never reached. The open channel at
	// once, TARGETS, then one channel per 4 s (its history and, for a guest,
	// its marker query): about 10 + 4·N s.
	const freshStart = Date.now();
	const fresh = await watch(page, "fresh", {
		until: (sent) => latestFetched(sent).size >= N,
		cap: (20 + 4 * N) * 1000,
	});
	const fetched = latestFetched(fresh);
	page.check(
		`fresh: every channel gets its history (${fetched.size} of ${N} in ${Math.round(
			(Date.now() - freshStart) / 1000
		)} s)`,
		fetched.size === N
	);

	// Drop the socket; the page reconnects on its own.
	await page.evaluate("window.__wire.length = 0, window.__socks.at(-1).close(), 1");
	// Until every channel is caught up again: the quiet ones too, last.
	const everyChannel = {until: (sent) => latestFetched(sent).size >= N, cap: (20 + 4 * N) * 1000};
	const again = await watch(page, "reconnect", everyChannel);
	const asked = again
		.filter((s) => /^MARKREAD \S+$/.test(s.line))
		.map((s) => s.line.split(" ")[1]);
	const answered = new Set(
		fresh.filter((s) => /^MARKREAD \S+$/.test(s.line)).map((s) => s.line.split(" ")[1])
	);
	// A reconnect after busy channels moved on, so the catch-up pages back
	// with CHATHISTORY BEFORE. Off by default: the dev ircd keeps only the
	// first ten or so lines of the helper's burst (measured 2026-10-19: 11
	// of 250, from an oper), so the gap never reaches a second page there.
	// `SEANCE_FAKELAG_BUSY=<lines per channel>` runs it against an ircd that
	// does not.
	const BUSY = Number(process.env.SEANCE_FAKELAG_BUSY ?? 0);

	if (BUSY > 0) {
		await page.evaluate("window.__offline = true, window.__socks.at(-1).close(), 1");
		await seed(CHANS.slice(0, 4), BUSY);
		await page.evaluate(
			"window.__wire.length = 0, window.__offline = false, dispatchEvent(new Event('online')), 1"
		);
		await watch(page, "busy");
	}

	// Nobody wrote anywhere; the reconnect still fetches every channel (a
	// quiet one by TARGETS is fetched last, not skipped).
	const backgroundFetches = (sent) =>
		sent
			.filter((s) => s.at > 1 && /^CHATHISTORY (LATEST|AFTER|BEFORE)$/.test(command(s.line)))
			.map((s) => s.line.replace(/^@\S+ /, "").split(" ")[2]);
	const targetsAsked = (sent) => sent.filter((s) => command(s.line) === "CHATHISTORY TARGETS");
	page.check(
		`fresh: one CHATHISTORY TARGETS (${targetsAsked(fresh).length})`,
		targetsAsked(fresh).length === 1
	);
	page.check(
		`reconnect: one CHATHISTORY TARGETS (${targetsAsked(again).length})`,
		targetsAsked(again).length === 1
	);
	const quietFetched = new Set(backgroundFetches(again));
	page.check(
		`reconnect: every channel behind the open one fetched (${quietFetched.size} of ${N - 1})`,
		quietFetched.size >= N - 1
	);

	// One channel written to while the page is offline: fetched first.
	const written = CHANS.at(-2);
	await page.evaluate("window.__offline = true, window.__socks.at(-1).close(), 1");
	await seed([written], 3);
	await page.evaluate(
		"window.__wire.length = 0, window.__offline = false, dispatchEvent(new Event('online')), 1"
	);
	const after = await watch(page, "written", everyChannel);
	page.check(
		`written: ${written} fetched first (${backgroundFetches(after).join(", ") || "none"})`,
		backgroundFetches(after)[0] === written
	);

	const {mkdirSync, writeFileSync} = await import("node:fs");
	mkdirSync(page.outDir, {recursive: true});
	writeFileSync(`${page.outDir}/connect-fakelag.json`, JSON.stringify(results));

	page.check(
		`reconnect: no marker asked again (${
			asked.filter((c) => answered.has(c)).join(", ") || "none"
		})`,
		asked.every((c) => !answered.has(c))
	);
}
