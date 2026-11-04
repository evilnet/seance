// Profile the reaction picker: open cost, DOM weight, hover and search cost,
// under CPU throttling (SEANCE_CPU, default 4 — Chrome's stand-in for a
// mid-range Android; 6 for a cheap one). Prints numbers, asserts nothing but
// the console: it is for comparing before and after a change, not for CI.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/reaction-picker-profile.mjs
//   SEANCE_CPU=6 node tools/browser-drive.mjs tools/scenarios/reaction-picker-profile.mjs
//
// For the record (2026-09-19, 4×): every catalog group rendered as buttons
// was 1924 nodes, open 180 ms, one 109 ms task; rendering groups as they
// scroll into view (ReactionPicker.vue `rendered`) is 220 nodes, 93 ms, no
// long task. Throttling slows the main thread only — it does not model
// Android rasterising every emoji glyph in the DOM, which the same change
// also removes. `SEANCE_CV=<css>` injects a stylesheet before the picker
// opens, for trying a CSS-only idea. The warm reopen runs under the sampling
// profiler, which inflates its wall-clock figure; read its long tasks and
// its top self-time list instead.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const IRCD = "wss://localhost:8443/";
const CHANNEL = "#seance";
const PORT = process.env.SEANCE_PORT ?? "8000";
const CPU = Number(process.env.SEANCE_CPU ?? 4);

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=pickprof&join=%23seance`;

const PICKER = "body > .reaction-picker";

function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};
	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :profile`);
	};
	ws.onmessage = (ev) => {
		const line = String(ev.data);
		if (line.startsWith("PING")) return ws.send(`PONG${line.slice(4)}`);
		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");
		if (params[1] === "001") ws.send(`JOIN ${CHANNEL}`);
		else if (params[1] === "JOIN" && params[0].includes(nick)) onJoin();
		else if (params[1] === "433") ws.send(`NICK ${nick}${Math.floor(Math.random() * 1000)}`);
	};
	return {
		joined: new Promise((resolve, reject) => {
			onJoin = resolve;
			setTimeout(() => reject(new Error("never joined")), 20000);
		}),
		say: (t) => ws.send(`PRIVMSG ${CHANNEL} :${t}`),
		quit: () => ws.send("QUIT"),
	};
}

// Long tasks observer + paint marks, installed before the picker opens.
const INSTRUMENT = `(() => {
	window.__lt = [];
	new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({start: e.startTime, dur: e.duration}); })
		.observe({type: "longtask", buffered: true});
	window.__frames = [];
	let last = performance.now();
	const tick = (t) => { window.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
	requestAnimationFrame(tick);
})()`;

const nodes = (page) => page.evaluate(`document.querySelectorAll("${PICKER} *").length`);
const longTasks = (page, since) =>
	page.evaluate(
		`(() => { const l = window.__lt.filter((t) => t.start >= ${since}); return {n: l.length, total: Math.round(l.reduce((s, t) => s + t.dur, 0)), max: Math.round(Math.max(0, ...l.map((t) => t.dur)))}; })()`
	);
const now = (page) => page.evaluate(`performance.now()`);
const worstFrames = (page, since) =>
	page.evaluate(
		`(() => { const f = window.__frames.slice(${since}); f.sort((a,b)=>b-a); return {n: f.length, worst: f.slice(0,3).map(Math.round), over50: f.filter((d)=>d>50).length}; })()`
	);
const frameCount = (page) => page.evaluate(`window.__frames.length`);

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`window.localStorage.removeItem("thelounge.reactions.recent")`);
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

	const token = `prof-${Date.now().toString(36)}`;
	const talker = speaker("proftalk");
	await talker.joined;
	talker.say(`profile this, ${token}`);
	await page.waitFor(
		`Array.from(document.querySelectorAll("#chat .msg .content")).some((c) => c.textContent.includes(${JSON.stringify(
			token
		)}))`,
		{timeout: 10000}
	);
	await page.sleep(500);
	const MSG = `#${await page.evaluate(
		`Array.from(document.querySelectorAll("#chat .msg")).find((m) => m.textContent.includes(${JSON.stringify(
			token
		)})).id`
	)}`;

	const msgCount = await page.count("#chat .msg");
	const toolbars = await page.count("#chat .msg-actions");
	const toolbarNodes = await page.evaluate(
		`document.querySelectorAll("#chat .msg-actions *").length`
	);
	console.log(
		`scrollback: ${msgCount} rows, ${toolbars} toolbars mounted (${toolbarNodes} nodes hidden)`
	);

	if (process.env.SEANCE_CV) {
		await page.evaluate(
			`document.head.appendChild(Object.assign(document.createElement("style"), {textContent: ${JSON.stringify(
				process.env.SEANCE_CV
			)}}))`
		);
		console.log("injected CSS:", process.env.SEANCE_CV);
	}
	await page.evaluate(INSTRUMENT);
	await page.send("Emulation.setCPUThrottlingRate", {rate: CPU});
	console.log(`CPU throttle ${CPU}x`);

	// --- cold open: chunk not yet fetched (hover preloads it, so hover the row, not the button)
	await page.hover(MSG);
	await page.sleep(150);
	const t0 = await now(page);
	const f0 = await frameCount(page);
	await page.click(`${MSG} .msg-action-react`);
	await page.waitFor(`document.querySelector(${JSON.stringify(PICKER)})`, {timeout: 5000});
	const tShell = await now(page);
	await page.waitFor(`document.querySelectorAll(".reaction-picker-section").length >= 10`, {
		timeout: 15000,
	});
	const tCatalog = await now(page);
	await page.sleep(400);
	const tSettled = await now(page);
	console.log(
		`cold open: shell +${Math.round(tShell - t0)}ms, catalog rendered +${Math.round(
			tCatalog - t0
		)}ms, nodes=${await nodes(page)}, options=${await page.count(".reaction-picker-option")}`
	);
	console.log(`  long tasks during open:`, JSON.stringify(await longTasks(page, t0)));
	console.log(`  frames:`, JSON.stringify(await worstFrames(page, f0)));

	// --- hover cost: sweep the pointer across the visible grid
	const grid = await page.rect(".reaction-picker-list");
	const tH = await now(page);
	const fH = await frameCount(page);
	for (let i = 0; i < 12; i++) {
		await page.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: grid.x + 20 + i * 24,
			y: grid.y + 60,
		});
		await page.sleep(40);
	}
	await page.sleep(300);
	console.log(
		`hover sweep (12 cells): long tasks`,
		JSON.stringify(await longTasks(page, tH)),
		"frames",
		JSON.stringify(await worstFrames(page, fH))
	);

	// --- search: one keystroke
	await page.click(".reaction-picker-input");
	const tS = await now(page);
	const fS = await frameCount(page);
	await page.send("Input.insertText", {text: "s"});
	await page.waitFor(
		`document.querySelector(".reaction-picker-heading").textContent.startsWith("Search")`,
		{timeout: 5000}
	);
	const tS1 = await now(page);
	await page.sleep(300);
	console.log(
		`search "s": results +${Math.round(tS1 - tS)}ms, options=${await page.count(
			".reaction-picker-option"
		)}, long tasks`,
		JSON.stringify(await longTasks(page, tS)),
		"frames",
		JSON.stringify(await worstFrames(page, fS))
	);

	// --- clear: back to full catalog
	const tC = await now(page);
	await page.click(".reaction-picker-clear");
	await page.waitFor(`document.querySelectorAll(".reaction-picker-section").length >= 10`, {
		timeout: 5000,
	});
	const tC1 = await now(page);
	await page.sleep(300);
	console.log(
		`clear: full grid back +${Math.round(tC1 - tC)}ms, long tasks`,
		JSON.stringify(await longTasks(page, tC))
	);

	// --- warm reopen: chunk cached
	await page.send("Input.dispatchKeyEvent", {
		type: "rawKeyDown",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
	});
	await page.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
	});
	await page.waitFor(`!document.querySelector(${JSON.stringify(PICKER)})`, {timeout: 3000});
	await page.sleep(300);
	await page.hover(MSG);
	await page.sleep(150);
	const t1 = await now(page);
	const f1 = await frameCount(page);
	await page.send("Profiler.enable");
	await page.send("Profiler.setSamplingInterval", {interval: 200});
	await page.send("Profiler.start");
	await page.click(`${MSG} .msg-action-react`);
	await page.waitFor(`document.querySelectorAll(".reaction-picker-section").length >= 10`, {
		timeout: 15000,
	});
	const t1c = await now(page);
	await page.sleep(400);
	const {profile} = await page.send("Profiler.stop");
	// Self time per function, then roll up by "where it lives".
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const self = new Map();
	const dt = profile.timeDeltas;
	for (let i = 0; i < profile.samples.length; i++) {
		self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (dt[i] ?? 0) / 1000);
	}
	const label = (n) => {
		const f = n.callFrame;
		const file = (f.url || "").split("/").pop();
		return `${f.functionName || "(anon)"}@${file}:${f.lineNumber}`;
	};
	const total = [...self.values()].reduce((a, b) => a + b, 0);
	const top = [...self.entries()]
		.map(([id, ms]) => [label(byId.get(id)), ms])
		.sort((a, b) => b[1] - a[1])
		.slice(0, 15);
	console.log(`cpu profile: ${Math.round(total)}ms sampled JS/idle; top self-time:`);
	for (const [l, ms] of top) console.log(`   ${Math.round(ms).toString().padStart(5)}ms  ${l}`);
	console.log(
		`warm reopen: catalog rendered +${Math.round(t1c - t1)}ms, long tasks`,
		JSON.stringify(await longTasks(page, t1)),
		"frames",
		JSON.stringify(await worstFrames(page, f1))
	);

	await page.screenshot("picker-profiled");
	talker.quit();
	await page.send("Emulation.setCPUThrottlingRate", {rate: 1});
	page.check("no console errors", page.consoleErrors.length === 0);
}
