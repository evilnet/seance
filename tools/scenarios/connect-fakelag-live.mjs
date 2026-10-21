// PR #121's live check: a real network's account, a fresh connect, then a
// dropped socket and the page's own reconnect, typing a line every
// SEANCE_FAKELAG_TYPE ms (0: none) and measuring send → echo. Prints, per
// phase, the clock our side reckons (`replay`, the ircu rule), the history
// fetches and when they went out, the history batches, whether our user
// modes were volunteered, and the interesting part of the wire.
//
//   SEANCE_LIVE_HOST=irc.example.net/path SEANCE_LIVE_PORT=443 \
//   SEANCE_SASL_ACCOUNT=acct SEANCE_SASL_PASSWORD=… \
//   SEANCE_JOIN='#test,#test2' SEANCE_TYPE_CHAN='#test' \
//     node tools/browser-drive.mjs tools/scenarios/connect-fakelag-live.mjs
//
// The password only ever comes from the environment; the AUTHENTICATE line
// is redacted from the output. Type only into a channel set aside for
// testing (SEANCE_TYPE_CHAN, default the first of SEANCE_JOIN): every line
// is really sent. A real network throttles reconnects from one address
// (nefarious2's IPcheck: about six dials in a few minutes), so space runs
// at least four minutes apart. To test an alias attach instead of a held
// session's revive, hold a second connection of the account open first:
// `node tools/fakelag-probe.mjs wss://… --count=0 --hold=200000`.
//
// Server-side numbers (what the server actually charged) come from
// tools/fakelag-probe.mjs; this scenario's clock is our own bookkeeping.

const PORT = process.env.SEANCE_PORT || "8047";
const HOST = process.env.SEANCE_LIVE_HOST;
const IRC_PORT = process.env.SEANCE_LIVE_PORT || "443";
const ACCOUNT = process.env.SEANCE_SASL_ACCOUNT;
const PW = process.env.SEANCE_SASL_PASSWORD;
const NICK = process.env.SEANCE_LIVE_NICK || ACCOUNT;
const WAIT = Number(process.env.SEANCE_FAKELAG_WAIT || 45000);
const TYPE = Number(process.env.SEANCE_FAKELAG_TYPE ?? 4000);
const JOIN = process.env.SEANCE_JOIN || "";
const CHAN = process.env.SEANCE_TYPE_CHAN || JOIN.split(",")[0];
const TAG = "t" + Date.now().toString(36).slice(-4);

export const url =
	`http://localhost:${PORT}/?host=${encodeURIComponent(HOST ?? "")}` +
	`&port=${IRC_PORT}&tls=true&nick=${encodeURIComponent(NICK ?? "")}&join=${encodeURIComponent(
		JOIN
	)}`;

const WRAP = `(() => {
  const t0 = performance.timeOrigin;
  const log = (window.__wire = []);
  const socks = (window.__socks = []);
  const Orig = window.WebSocket;
  window.WebSocket = class extends Orig {
    constructor(url, ...rest) {
      super(url, ...rest);
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
		if (x.d !== "out" || registered === null) continue;
		since = Math.max(since, now) + 2 + Math.floor((Buffer.byteLength(x.l) + 2) / 120);
		out.push({at: now - registered, ahead: since - now, line: x.l});
	}
	return {out, registered};
}

const redact = (l) => l.replace(/^(AUTHENTICATE) (?!PLAIN|\+$)\S+/, "$1 <redacted>");

async function watch(page, label) {
	const start = Date.now();
	let n = 0;
	while (TYPE > 0 && Date.now() - start + TYPE < WAIT) {
		await page.sleep(TYPE);
		if (await page.evaluate(`!!document.querySelector("#push-prompt[data-armed]")`)) {
			await page.click("#pushPromptNo");
			await page.sleep(700);
		}
		const ph = await page.evaluate(`document.querySelector("#input")?.placeholder || ""`);
		if (!ph.endsWith(" " + CHAN)) {
			const row = `#sidebar .channel-list-item[data-name="${CHAN}"]`;
			if (await page.evaluate(`!!document.querySelector(${JSON.stringify(row)})`)) {
				await page.click(row);
				await page.sleep(500);
				continue;
			}
			console.log(`${label}: composer not on ${CHAN} ("${ph}"), not typing`);
			continue;
		}
		n++;
		await page.fill("#input", `${TAG} ${label} ${n}`);
		await page.click("#submit");
	}
	await page.sleep(Math.max(0, WAIT - (Date.now() - start)));

	const wire = await page.evaluate("window.__wire");
	const {out, registered} = replay(wire);
	const t0 = wire[0]?.t ?? 0;

	// Typed delays.
	const sentAt = new Map();
	const typed = [];
	for (const x of wire) {
		const m = new RegExp(` PRIVMSG \\S+ :(${TAG} ${label} \\d+)$`).exec(x.l);
		if (!m) continue;
		if (x.d === "out") sentAt.set(m[1], x.t);
		else if (sentAt.has(m[1]) && !/^@\S*batch=/.test(x.l)) {
			typed.push(((x.t - sentAt.get(m[1])) / 1000).toFixed(2));
			sentAt.delete(m[1]);
		}
	}
	const peak = Math.max(0, ...out.map((s) => s.ahead));
	const late = out.filter((s) => s.at > 1 && !/ PRIVMSG \S+ :t/.test(s.line));
	console.log(
		`\n=== ${label}: 001 at +${
			registered ? ((registered * 1000 - t0) / 1000).toFixed(2) : "never"
		} s after first frame`
	);
	console.log(
		`${label}: ${out.length} commands after 001, model peak ${peak.toFixed(
			1
		)} s ahead (typed lines included)`
	);
	console.log(
		`${label}: typed echoes ${typed.join(", ") || "none"}; unechoed ${
			[...sentAt.keys()].join(", ") || "none"
		}`
	);
	console.log(
		`${label}: background peak after 1 s (typed excluded from filter only) ${Math.max(
			0,
			...late.map((s) => s.ahead)
		).toFixed(1)}`
	);
	// Catch-up wall time: each CHATHISTORY sent, relative to 001.
	const hist = out.filter((s) =>
		/^(@\S+ )?CHATHISTORY (LATEST|AFTER|BEFORE|AROUND|BETWEEN) /.test(s.line)
	);
	console.log(
		`${label}: history fetches ` +
			(hist
				.map(
					(s) =>
						`${s.line
							.replace(/^@\S+ /, "")
							.split(" ")
							.slice(1, 3)
							.join(" ")} +${s.at.toFixed(1)}`
				)
				.join(", ") || "none")
	);
	const batchEnds = wire.filter(
		(x) =>
			x.d === "in" && / BATCH \+\S+ (chathistory|evilnet.github.io\/bouncer-replay)/.test(x.l)
	);
	console.log(
		`${label}: history batches opened at ` +
			(batchEnds
				.map(
					(x) =>
						`+${(x.t / 1000 - registered).toFixed(1)}${
							/bouncer-replay/.test(x.l) ? " (replay)" : ""
						}`
				)
				.join(", ") || "none")
	);
	const umode = wire.find(
		(x) =>
			x.d === "in" &&
			new RegExp(` MODE ${NICK.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} :?\\+`).test(x.l) &&
			registered &&
			x.t / 1000 > registered
	);
	console.log(
		`${label}: own MODE volunteered after 001: ${
			umode ? "+" + (umode.t / 1000 - registered).toFixed(2) + " " + umode.l.slice(-30) : "no"
		}`
	);
	console.log(`--- ${label} wire (in-lines filtered to interesting ones)`);
	const interesting =
		/ (001|451|421|ERROR|FAIL|WARN|NOTE|PERSISTENCE|MARKREAD|CHATHISTORY|BATCH|90[0-9]|ACK|WEBPUSH|AWAY|CAP|404|Excess)/;
	for (const x of wire) {
		if (x.d === "in" && !interesting.test(" " + x.l)) continue;
		if (x.d === "in" && /^@\S*batch=\S+ :\S+ PRIVMSG/.test(x.l)) continue;
		console.log(
			`  ${((x.t - t0) / 1000).toFixed(2).padStart(6)} ${
				x.d === "out" ? ">>" : "<<"
			} ${redact(x.l).slice(0, 170)}`
		);
	}
	return {wire, out, typed, unechoed: [...sentAt.keys()]};
}

export default async function run(page) {
	if (!HOST || !ACCOUNT || !PW || !JOIN) {
		throw new Error(
			"set SEANCE_LIVE_HOST, SEANCE_SASL_ACCOUNT, SEANCE_SASL_PASSWORD and SEANCE_JOIN"
		);
	}

	await page.addInitScript(WRAP);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector('#connect input[name="sasl"]').click(), 1`);
	await page.sleep(300);
	await page.fill('#connect input[name="saslAccount"]', ACCOUNT);
	await page.fill('#connect input[name="saslPassword"]', PW);
	await page.click("#connect button[type=submit]");
	const fresh = await watch(page, "fresh");
	page.check("fresh: registered", fresh.out.length > 0);
	page.check(
		`fresh: every typed line echoed (${fresh.unechoed.length} missing)`,
		fresh.unechoed.length === 0
	);

	// Drop the socket; the page reconnects on its own (one more dial).
	await page.evaluate("window.__wire.length = 0, window.__socks.at(-1).close(), 1");
	const again = await watch(page, "reconnect");
	page.check("reconnect: registered", again.out.length > 0);
	page.check(
		`reconnect: every typed line echoed (${again.unechoed.length} missing)`,
		again.unechoed.length === 0
	);
	const targets = (s) => s.out.filter((x) => /^(@\S+ )?CHATHISTORY TARGETS /.test(x.line)).length;
	page.check(`fresh: one TARGETS (${targets(fresh)})`, targets(fresh) === 1);
	page.check(
		`reconnect: no TARGETS, the ATTACH cursor covers it (${targets(again)})`,
		targets(again) === 0
	);
	const e451 = (s) => s.wire.filter((x) => x.d === "in" && / 451 /.test(x.l)).length;
	page.check(
		`no 451 Register first (${e451(fresh)} / ${e451(again)})`,
		e451(fresh) + e451(again) === 0
	);
	await page.screenshot("end");
	// Leave cleanly so the held session is not left flapping.
	await page.fill("#input", "/quit");
	await page.click("#submit");
	await page.sleep(1500);
}
