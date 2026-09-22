#!/usr/bin/env node
/* eslint-disable no-console */
// Drive a real Chromium against a Seance build and watch what it does.
//
//   node tools/browser-drive.mjs [scenario.mjs] [--url=…] [options]
//
// Two jobs, both dependency-free (Node's global fetch/WebSocket speaking the
// DevTools protocol, like tools/pwa-check.mjs):
//
//  1. **Wire watching.** With no scenario, it opens the URL and prints every
//     WebSocket frame the browser sends and receives, with byte lengths, plus
//     the handshake headers, console errors and page exceptions. This is the
//     view you cannot get from `tools/irc-ws-probe.mjs`: what *Chrome itself*
//     puts on the wire, framing and all. nefarious2's WebSocket bugs are
//     size- and handshake-shaped (#97 pre-101 notices, #98 inbound frames
//     >= 528 bytes, #99 upgrade requests >= 512 bytes), so `bytes=` on every
//     line is the number that usually matters.
//
//  2. **Scenarios.** A scenario is a `.mjs` module whose default export is
//     `async (page) => {…}`; see `tools/scenarios/` for committed ones and
//     `docs/resources/browser-testing.md` for the API and the recipes. It
//     clicks, waits, asserts and takes screenshots, and exits non-zero when
//     anything fails, so it also works as a smoke check.
//
// Examples:
//   # watch the IRC WebSocket of a live connect, 60 s
//   node tools/browser-drive.mjs --url='http://localhost:8000/?host=localhost&port=8443&tls=true&nick=probe&join=%23seance' \
//     --stay=60000
//
//   # run a committed scenario, screenshots into tmp/browser-drive/
//   node tools/browser-drive.mjs tools/scenarios/media-preview-reveal.mjs
//
// Options:
//   --url=<url>       page to open (a scenario may set its own default)
//   --stay=<ms>       with no scenario, how long to watch (default 30000)
//   --out=<dir>       screenshot directory (default tmp/browser-drive/<run>)
//   --headful         show the browser instead of running headless
//   --devtools        headful + open DevTools (implies --headful)
//   --keep            leave the browser running when the scenario ends
//   --no-ws           do not log WebSocket frames
//   --quiet           only log failures, frame errors and scenario output
//   --max-frame=<n>   truncate logged frame payloads (default 200 chars)
//   --chrome=<bin>    Chromium binary (default $CHROME_BIN or "chromium")
//   --timeout=<ms>    default wait timeout inside a scenario (default 20000)
//   --profile=<dir>   reuse a profile dir instead of a throwaway one
//   --width=<px>      viewport width (default 1280); --height=<px> (default 900)
//   --mobile          emulate a touch device (mobile viewport, no hover); without it
//                     the run answers (hover: hover) and (pointer: fine) like a desktop
//
// A throwaway profile is the default on purpose: localStorage (saved
// networks, settings, `thelounge.media.trusted`) survives inside one profile,
// so reusing it silently changes what a "first visit" does.

import {spawn} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {isAbsolute, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
const opt = (name, fallback) => {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const scenarioPath = argv.find((a) => !a.startsWith("--"));

const chromeBin = opt("chrome", process.env.CHROME_BIN || "chromium");
const headful = flags.has("--headful") || flags.has("--devtools");
const logWs = !flags.has("--no-ws");
const quiet = flags.has("--quiet");
const maxFrame = Number(opt("max-frame", "200"));
const defaultTimeout = Number(opt("timeout", "20000"));
const stayMs = Number(opt("stay", "30000"));
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(opt("out", join("tmp", "browser-drive", runId)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (...a) => (quiet ? undefined : console.log(...a));

// ---------------------------------------------------------------- chromium

const port = 9222 + Math.floor(Math.random() * 1000);
const ownProfile = opt("profile", null) === null;
const profile = ownProfile
	? mkdtempSync(join(tmpdir(), "seance-browser-drive-"))
	: resolve(opt("profile", ""));

const chrome = spawn(
	chromeBin,
	[
		headful ? "--new-window" : "--headless=new",
		flags.has("--devtools") ? "--auto-open-devtools-for-tabs" : "--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		// The dev ircd and the dev web server use self-signed certificates.
		"--ignore-certificate-errors",
		"--window-size=1280,900",
		// A headless Chromium with no input device answers `(hover: none)` and
		// `(pointer: none)`, which is neither a desktop nor a phone: the
		// `@media (hover: none)` rules (the message action toolbar's touch
		// mode, say) would apply to a run that hovers with a mouse. Without
		// --mobile, say what a desktop says: hover type 2 = hover, pointer
		// type 4 = fine (the touch emulation of --mobile overrides these).
		...(flags.has("--mobile")
			? []
			: [
					"--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
			  ]),
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"about:blank",
	],
	{stdio: "ignore"}
);

let chromeExited = false;
chrome.on("exit", () => {
	chromeExited = true;
});

function cleanup() {
	if (flags.has("--keep")) {
		note(`\nbrowser left running (pid ${chrome.pid}); profile ${profile}`);
		return;
	}

	if (!chromeExited) {
		chrome.kill();
	}

	if (ownProfile) {
		try {
			rmSync(profile, {recursive: true, force: true});
		} catch {
			// a browser still writing to it; harmless, it is under $TMPDIR
		}
	}
}

async function devtoolsTarget() {
	for (let i = 0; i < 100; i++) {
		if (chromeExited) {
			throw new Error(`${chromeBin} exited before DevTools came up`);
		}

		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			const page = targets.find((t) => t.type === "page");

			if (page?.webSocketDebuggerUrl) {
				return page.webSocketDebuggerUrl;
			}
		} catch {
			// not listening yet
		}

		await sleep(100);
	}

	throw new Error(`no DevTools target from ${chromeBin} on port ${port}`);
}

// ------------------------------------------------------------ cdp plumbing

const pending = new Map();
const consoleLogs = [];
const wsFrames = [];
const failures = [];
/**
 * Frame errors a scenario has declared expected (`allowWsFrameErrors`): true
 * for all of them, or a RegExp matched against the message. A scenario that
 * deliberately drops a connection sees one every run — the ircd's closing
 * line arrives after the browser has begun the close handshake — and that is
 * the path under test, not a defect.
 */
let allowWsFrameErrors = null;
let socket;
let nextId = 0;

const send = (method, params = {}) =>
	new Promise((res, rej) => {
		const id = ++nextId;
		pending.set(id, {res, rej});
		socket.send(JSON.stringify({id, method, params}));
	});

const opcodeName = (op) =>
	({0: "cont", 1: "text", 2: "binary", 8: "close", 9: "ping", 10: "pong"}[op] ?? `op${op}`);

function frameLine(dir, requestId, response) {
	const payload = response.payloadData ?? "";
	// payloadData is base64 for binary frames, a JS string for text ones.
	const bytes =
		response.opcode === 2 || response.opcode === 8
			? Buffer.from(payload, "base64").length
			: Buffer.byteLength(payload, "utf8");
	const shown = payload.length > maxFrame ? `${payload.slice(0, maxFrame)}…` : payload;

	return `ws ${dir} [${requestId.slice(-6)}] ${opcodeName(
		response.opcode
	)} bytes=${bytes} ${JSON.stringify(shown)}`;
}

function onEvent(msg) {
	const {method, params} = msg;

	if (method === "Runtime.consoleAPICalled") {
		const text = (params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");
		consoleLogs.push({type: params.type, text});

		if (["error", "warning", "assert"].includes(params.type)) {
			console.log(`console.${params.type} ${text}`);
		} else {
			note(`console.${params.type} ${text}`);
		}

		return;
	}

	if (method === "Runtime.exceptionThrown") {
		const d = params.exceptionDetails;
		const text = d.exception?.description ?? d.text;
		consoleLogs.push({type: "exception", text});
		console.log(`page exception ${text}`);
		return;
	}

	if (!logWs) {
		return;
	}

	switch (method) {
		case "Network.webSocketCreated":
			note(`ws open [${params.requestId.slice(-6)}] ${params.url}`);
			break;
		case "Network.webSocketWillSendHandshakeRequest": {
			const h = params.request.headers ?? {};
			const size = Object.entries(h).reduce(
				(n, [k, v]) => n + k.length + String(v).length + 4,
				0
			);
			// Bug #99: nefarious2 hung on upgrade requests >= 512 bytes.
			note(`ws upgrade [${params.requestId.slice(-6)}] headerBytes≈${size}`);
			note(
				Object.entries(h)
					.map(([k, v]) => `      ${k}: ${v}`)
					.join("\n")
			);
			break;
		}
		case "Network.webSocketHandshakeResponseReceived": {
			const r = params.response;
			note(
				`ws handshake [${params.requestId.slice(-6)}] ${r.status} ${r.statusText} ` +
					`protocol=${
						r.headers?.["sec-websocket-protocol"] ??
						r.headers?.["Sec-WebSocket-Protocol"] ??
						"-"
					}`
			);
			break;
		}
		case "Network.webSocketFrameSent":
			wsFrames.push({dir: "out", requestId: params.requestId, ...params.response});
			note(frameLine("→", params.requestId, params.response));
			break;
		case "Network.webSocketFrameReceived":
			wsFrames.push({dir: "in", requestId: params.requestId, ...params.response});
			note(frameLine("←", params.requestId, params.response));
			break;
		case "Network.webSocketFrameError": {
			// A scenario that refuses dials on purpose sets `page.expectWsErrors`
			// for the stretch, or exports `allowWsFrameErrors` for the whole run.
			const expected =
				page.expectWsErrors ||
				allowWsFrameErrors === true ||
				(allowWsFrameErrors instanceof RegExp &&
					allowWsFrameErrors.test(params.errorMessage));

			if (!expected) {
				failures.push(`ws frame error: ${params.errorMessage}`);
			}

			console.log(
				`ws ERROR [${params.requestId.slice(-6)}] ${params.errorMessage}${
					expected ? " (expected)" : ""
				}`
			);
			break;
		}
		case "Network.webSocketClosed":
			console.log(`ws close [${params.requestId.slice(-6)}]`);
			break;
		default:
			break;
	}
}

// --------------------------------------------------------------- page api

async function evaluate(expression) {
	const r = await send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});

	if (r.exceptionDetails) {
		throw new Error(
			`evaluate failed: ${
				r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
			}`
		);
	}

	return r.result.value;
}

const jsString = (s) => JSON.stringify(String(s));

async function rect(selector, index = 0) {
	return evaluate(
		`(() => {
			const el = document.querySelectorAll(${jsString(selector)})[${Number(index)}];
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return {x: r.x, y: r.y, width: r.width, height: r.height};
		})()`
	);
}

async function waitFor(expression, {timeout = defaultTimeout, label} = {}) {
	const started = Date.now();

	for (;;) {
		if (await evaluate(`!!(${expression})`)) {
			return true;
		}

		if (Date.now() - started > timeout) {
			throw new Error(`timed out after ${timeout}ms waiting for ${label ?? expression}`);
		}

		await sleep(150);
	}
}

const count = (selector) => evaluate(`document.querySelectorAll(${jsString(selector)}).length`);

async function pointAt(selector, index) {
	let r = await rect(selector, index);

	if (!r || (r.width === 0 && r.height === 0)) {
		throw new Error(`no visible element for ${selector}[${index}]`);
	}

	// A real pointer can only reach what is on screen: scroll a target that
	// is off the viewport into it first (a scaled-up UI puts a form's buttons
	// below the fold), then measure again.
	const {w, h} = await evaluate(`({w: innerWidth, h: innerHeight})`);

	if (r.y < 0 || r.y + r.height > h || r.x < 0 || r.x + r.width > w) {
		await evaluate(
			`document.querySelectorAll(${jsString(
				selector
			)})[${index}]?.scrollIntoView({block: "center", inline: "center"})`
		);
		r = await rect(selector, index);
	}

	return {x: r.x + r.width / 2, y: r.y + r.height / 2};
}

async function hover(selector, index = 0) {
	const {x, y} = await pointAt(selector, index);
	await send("Input.dispatchMouseEvent", {type: "mouseMoved", x, y});
}

async function click(selector, index = 0) {
	const {x, y} = await pointAt(selector, index);
	// Real pointer events: :hover-only affordances (the preview toolbar) never
	// appear for a synthetic el.click().
	await send("Input.dispatchMouseEvent", {type: "mouseMoved", x, y});
	await send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x,
		y,
		button: "left",
		buttons: 1,
		clickCount: 1,
	});
	await send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x,
		y,
		button: "left",
		buttons: 0,
		clickCount: 1,
	});
	await sleep(50);
}

/** Set an input's value the way Vue notices (native setter + input event). */
async function fill(selector, value) {
	await evaluate(
		`(() => {
			const el = document.querySelector(${jsString(selector)});
			if (!el) throw new Error("no element " + ${jsString(selector)});
			const proto = el instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${jsString(value)});
			el.dispatchEvent(new Event("input", {bubbles: true}));
			el.dispatchEvent(new Event("change", {bubbles: true}));
		})()`
	);
}

async function goto(url, {waitForSelector} = {}) {
	await send("Page.navigate", {url});

	if (waitForSelector) {
		await waitFor(`document.querySelector(${jsString(waitForSelector)})`, {
			label: waitForSelector,
		});
	}
}

async function screenshot(name, {selector, pad = 24, clip} = {}) {
	mkdirSync(outDir, {recursive: true});

	let box = clip;

	if (!box && selector) {
		const r = await rect(selector);

		if (r) {
			box = {
				x: Math.max(0, r.x - pad),
				y: Math.max(0, r.y - pad),
				width: Math.min(1280, r.width + pad * 2),
				height: r.height + pad * 2,
			};
		}
	}

	const params = {format: "png"};

	if (box) {
		params.clip = {...box, scale: 1};
	}

	const shot = await send("Page.captureScreenshot", params);
	const file = join(outDir, `${name}.png`);
	writeFileSync(file, Buffer.from(shot.data, "base64"));
	console.log(`shot ${file}`);
	return file;
}

/** Assert without aborting: collects failures so one run reports them all. */
/** Run `source` in every new document before any page script (CDP
 * Page.addScriptToEvaluateOnNewDocument): the place to stand in for a
 * browser API headless cannot provide — the Push API, say — ahead of the
 * app's boot-time connect. Call before `goto`; it applies to every later
 * navigation and reload. */
async function addInitScript(source) {
	await send("Page.addScriptToEvaluateOnNewDocument", {source});
}

/** Pre-answers the install guide's "don't show this again" (helpers/installGuide.ts). */
const DISMISS_INSTALL_GUIDE =
	'try { localStorage.setItem("thelounge.state.installGuide", "dismissed"); } catch (e) {}';

/** Browser.grantPermissions, for testing notification-driven flows. */
async function grantPermissions(permissions, origin) {
	await send("Browser.grantPermissions", {
		permissions,
		...(origin ? {origin} : {}),
	});
}

function check(label, ok) {
	if (ok) {
		note(`  ok  ${label}`);
	} else {
		failures.push(label);
		console.log(`  FAIL ${label}`);
	}

	return !!ok;
}

const page = {
	send,
	evaluate,
	goto,
	waitFor,
	rect,
	count,
	click,
	hover,
	fill,
	addInitScript,
	/** Pre-grant browser permissions (e.g. notifications) for this page, so
	 * flows that need a user gesture can be exercised headlessly:
	 * `await page.grantPermissions(["notifications"])`. */
	grantPermissions,
	screenshot,
	check,
	sleep,
	/** While true, a failed WebSocket dial is logged but not counted as a
	 * failure — for a scenario that refuses connections on purpose to watch
	 * the reconnect schedule. Set it back to false before the part of the
	 * run where a dial is expected to succeed. */
	expectWsErrors: false,
	get consoleLogs() {
		return consoleLogs;
	},
	get wsFrames() {
		return wsFrames;
	},
	/** Console errors and page exceptions seen so far. */
	get consoleErrors() {
		return consoleLogs.filter((l) => l.type === "error" || l.type === "exception");
	},
	outDir,
	url: opt("url", null),
	flags,
	opt,
};

// -------------------------------------------------------------------- run

let exitCode = 0;

try {
	socket = new WebSocket(await devtoolsTarget());
	await new Promise((res, rej) => {
		socket.onopen = res;
		socket.onerror = () => rej(new Error("could not attach to DevTools"));
	});

	socket.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);

		if (msg.id && pending.has(msg.id)) {
			const {res, rej} = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
		} else if (msg.method) {
			onEvent(msg);
		}
	};

	await send("Page.enable");
	await send("Runtime.enable");
	await send("Log.enable");

	if (logWs) {
		await send("Network.enable");
	}

	await send("Emulation.setDeviceMetricsOverride", {
		width: Number(opt("width", 1280)),
		height: Number(opt("height", 900)),
		deviceScaleFactor: 1,
		mobile: flags.has("--mobile"),
	});
	if (flags.has("--mobile")) {
		await send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
	}

	if (scenarioPath) {
		const file = isAbsolute(scenarioPath) ? scenarioPath : resolve(scenarioPath);
		const scenario = await import(pathToFileURL(file).href);
		const run = scenario.default;

		if (typeof run !== "function") {
			throw new Error(`${scenarioPath} must default-export an async function`);
		}

		if (page.url === null && typeof scenario.url === "string") {
			page.url = scenario.url;
		}

		if (scenario.allowWsFrameErrors === true || scenario.allowWsFrameErrors instanceof RegExp) {
			allowWsFrameErrors = scenario.allowWsFrameErrors;
		}

		// The install guide opens over every fresh profile in a Chromium; a
		// scenario that is not about it exports `installGuide = true` to
		// keep it — everyone else starts with it dismissed.
		if (scenario.installGuide !== true) {
			await addInitScript(DISMISS_INSTALL_GUIDE);
		}

		note(`scenario ${scenarioPath}${page.url ? ` on ${page.url}` : ""}`);
		await run(page);
	} else {
		if (!page.url) {
			throw new Error("nothing to do: pass a scenario file or --url=…");
		}

		await addInitScript(DISMISS_INSTALL_GUIDE);
		await goto(page.url);
		note(`watching ${page.url} for ${stayMs}ms (Ctrl-C to stop)`);
		await sleep(stayMs);
	}
} catch (e) {
	failures.push(e.message);
	console.error(`\nFAILED: ${e.message}`);
} finally {
	if (socket && socket.readyState === WebSocket.OPEN) {
		try {
			await screenshot(failures.length > 0 ? "failure" : "final");
		} catch {
			// the page may be gone already
		}

		socket.close();
	}

	cleanup();
}

const errors = consoleLogs.filter((l) => l.type === "error" || l.type === "exception");

if (errors.length > 0) {
	console.log(`\n${errors.length} console error(s)/exception(s):`);

	for (const e of errors) {
		console.log(`  ${e.type}: ${e.text}`);
	}
}

if (failures.length > 0) {
	console.log(`\n${failures.length} failure(s):`);

	for (const f of failures) {
		console.log(`  - ${f}`);
	}

	exitCode = 1;
} else {
	console.log("\nok");
}

process.exit(exitCode);
