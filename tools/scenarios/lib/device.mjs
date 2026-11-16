// A second device for a scenario: another Chromium with a profile of its
// own, so its localStorage, IndexedDB and service worker are its own, as a
// phone's are beside a desktop's. tools/browser-drive.mjs drives one page
// over one DevTools socket; this starts another browser and hands back the
// part of the same page API a two-device scenario needs (evaluate, goto,
// waitFor, click, fill, count, addInitScript, grantPermissions, send).
//
//   const b = await startDevice({chrome: process.env.CHROME_BIN});
//   await b.goto(url, {waitForSelector: "#connect form"});
//   …
//   await b.close();
//
// openTab(page) is the same API on a second tab of the driver's own browser
// instead: one profile, so the two share localStorage and each sees the
// other's writes as `storage` events, as two tabs of one browser (or the
// installed app beside a browser tab) do.
//
//   const b = await openTab(page);
//   await b.goto(page.url, {waitForSelector: "#connect form"});
//   …
//   await b.close();
//
// Clicks are real mouse events at the element's centre, as browser-drive's
// are. Page exceptions and console errors are collected in `consoleErrors`.

import {spawn} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsString = (s) => JSON.stringify(String(s));

export async function startDevice({
	chrome = process.env.CHROME_BIN || "chromium",
	name = "device-b",
	width = 1280,
	height = 900,
	timeout = 20000,
	// Print this device's IRC WebSocket lines as they pass (they are always
	// kept in `wsFrames`); SEANCE_DEVICE_FRAMES=1 turns it on for any scenario.
	logFrames = process.env.SEANCE_DEVICE_FRAMES === "1",
} = {}) {
	const profile = mkdtempSync(join(tmpdir(), `seance-${name}-`));
	const proc = spawn(
		chrome,
		[
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-dev-shm-usage",
			"--ignore-certificate-errors",
			`--window-size=${width},${height}`,
			"--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
			// Port 0: Chromium picks a free one and writes it to
			// DevToolsActivePort, so this never attaches to another browser.
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"about:blank",
		],
		{stdio: "ignore"}
	);
	let exited = false;
	proc.on("exit", () => {
		exited = true;
	});

	// A start-up that fails must not leave the browser and its profile behind.
	const abandon = (error) => {
		try {
			proc.kill();
		} catch {
			// already gone
		}

		rmSync(profile, {recursive: true, force: true});
		throw error;
	};

	let target;
	let port = 0;

	for (let i = 0; i < 100 && !target; i++) {
		if (exited) {
			abandon(new Error(`${name}: ${chrome} exited before DevTools came up`));
		}

		try {
			port ||= Number(
				readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]
			);
			const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			target = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
		} catch {
			// not listening yet
		}

		if (!target) {
			await sleep(100);
		}
	}

	if (!target) {
		abandon(new Error(`${name}: no DevTools target (port ${port || "unknown"})`));
	}

	try {
		return await attach(target, {
			name,
			width,
			height,
			timeout,
			logFrames,
			async release() {
				if (!exited) {
					proc.kill();
				}

				await sleep(300);

				try {
					rmSync(profile, {recursive: true, force: true});
				} catch {
					// still being written; it is under $TMPDIR
				}
			},
		});
	} catch (e) {
		abandon(e);
	}
}

/** A second tab in the driver's browser (see the top of this file). */
export async function openTab(
	page,
	{
		name = "tab-b",
		width = 1280,
		height = 900,
		timeout = 20000,
		logFrames = process.env.SEANCE_DEVICE_FRAMES === "1",
	} = {}
) {
	// A window of its own, so neither tab is a hidden background tab.
	const {targetId} = await page.send("Target.createTarget", {
		url: "about:blank",
		newWindow: true,
	});

	return attach(`ws://127.0.0.1:${page.devtoolsPort}/devtools/page/${targetId}`, {
		name,
		width,
		height,
		timeout,
		logFrames,
		async release() {
			await page.send("Target.closeTarget", {targetId}).catch(() => {});
		},
	});
}

/** The page API over one DevTools page target; `release` runs on close(). */
async function attach(target, {name, width, height, timeout, logFrames, release}) {
	const socket = new WebSocket(target);

	await new Promise((res, rej) => {
		socket.onopen = res;
		socket.onerror = () => rej(new Error(`${name}: could not attach to DevTools`));
	});

	const pending = new Map();
	const consoleErrors = [];
	const wsFrames = [];
	let nextId = 0;

	socket.onmessage = (ev) => {
		const msg = JSON.parse(ev.data);

		if (msg.id && pending.has(msg.id)) {
			const {res, rej} = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
		} else if (
			msg.method === "Network.webSocketFrameSent" ||
			msg.method === "Network.webSocketFrameReceived"
		) {
			const out = msg.method === "Network.webSocketFrameSent";
			const line = String(msg.params.response?.payloadData ?? "").replace(/\r?\n$/, "");
			wsFrames.push({dir: out ? "out" : "in", at: Date.now(), line});

			if (logFrames) {
				console.log(`${name} ws ${out ? "→" : "←"} ${line.slice(0, 200)}`);
			}
		} else if (msg.method === "Runtime.exceptionThrown") {
			const d = msg.params.exceptionDetails;
			consoleErrors.push(d.exception?.description ?? d.text);
			console.log(`${name}: page exception ${consoleErrors[consoleErrors.length - 1]}`);
		} else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
			const text = (msg.params.args ?? []).map((a) => a.value ?? a.description).join(" ");
			consoleErrors.push(text);
			console.log(`${name}: console.error ${text}`);
		}
	};

	const send = (method, params = {}) =>
		new Promise((res, rej) => {
			const id = ++nextId;
			pending.set(id, {res, rej});
			socket.send(JSON.stringify({id, method, params}));
		});

	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});

		if (r.exceptionDetails) {
			throw new Error(
				`${name}: evaluate failed: ${
					r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
				}`
			);
		}

		return r.result.value;
	};

	const waitFor = async (expression, {timeout: limit = timeout, label} = {}) => {
		const started = Date.now();

		for (;;) {
			if (await evaluate(`!!(${expression})`)) {
				return true;
			}

			if (Date.now() - started > limit) {
				throw new Error(
					`${name}: timed out after ${limit}ms waiting for ${label ?? expression}`
				);
			}

			await sleep(150);
		}
	};

	const goto = async (url, {waitForSelector} = {}) => {
		await send("Page.navigate", {url});

		if (waitForSelector) {
			await waitFor(`document.querySelector(${jsString(waitForSelector)})`, {
				label: waitForSelector,
			});
		}
	};

	const click = async (selector) => {
		await evaluate(
			`document.querySelector(${jsString(selector)})?.scrollIntoView({block: "center"})`
		);
		const r = await evaluate(`(() => {
			const el = document.querySelector(${jsString(selector)});
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return {x: b.x + b.width / 2, y: b.y + b.height / 2};
		})()`);

		if (!r) {
			throw new Error(`${name}: no element ${selector}`);
		}

		await send("Input.dispatchMouseEvent", {type: "mouseMoved", x: r.x, y: r.y});
		await send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: r.x,
			y: r.y,
			button: "left",
			buttons: 1,
			clickCount: 1,
		});
		await send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: r.x,
			y: r.y,
			button: "left",
			buttons: 0,
			clickCount: 1,
		});
		await sleep(50);
	};

	const fill = (selector, value) =>
		evaluate(`(() => {
			const el = document.querySelector(${jsString(selector)});
			if (!el) throw new Error("no element " + ${jsString(selector)});
			const proto = el instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${jsString(value)});
			el.dispatchEvent(new Event("input", {bubbles: true}));
			el.dispatchEvent(new Event("change", {bubbles: true}));
		})()`);

	await send("Page.enable");
	await send("Runtime.enable");
	await send("Network.enable");
	await send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	// As browser-drive does for its own page: no install guide.
	await send("Page.addScriptToEvaluateOnNewDocument", {
		source: 'try { localStorage.setItem("thelounge.state.installGuide", "dismissed"); } catch (e) {}',
	});

	return {
		name,
		send,
		evaluate,
		waitFor,
		goto,
		click,
		fill,
		sleep,
		count: (selector) => evaluate(`document.querySelectorAll(${jsString(selector)}).length`),
		addInitScript: (source) => send("Page.addScriptToEvaluateOnNewDocument", {source}),
		grantPermissions: (permissions, origin) =>
			send("Browser.grantPermissions", {permissions, ...(origin ? {origin} : {})}),
		consoleErrors,
		wsFrames,
		async close() {
			try {
				socket.close();
			} catch {
				//
			}

			await release();
		},
	};
}
