// What the translation UI says this device can run, and why not, on the
// real device probe (capability.ts) over a stand-in for WebGPU: headless
// has no GPU, so an init script defines `navigator.gpu` (or takes it away)
// with an adapter that reports the features and limits of six devices:
//
//   noWebgpu  no `navigator.gpu` at all
//   noF16     an adapter without shader-f16
//   lowLimits shader-f16 and 2 GiB, but WebGPU's default 8 storage buffers
//             per shader stage, below WebLLM's floor of 10 (GPU_LIMITS)
//   binds128  shader-f16, 128 MiB in one storage binding (a phone): the 1.7B
//             runs as its small-buffer build, the 4B does not
//   binds160  160 MiB: the 1.7B fits, the 4B does not
//   desktop   2 GiB: everything runs
//   phone     the desktop's adapter on a phone (`userAgentData.mobile`):
//             the 1.7B runs, the 4B cannot -- too large for a phone's page
//
// For each, after a cold load with a fresh profile's storage: Settings →
// Translation's device line ("This device has a GPU and a CPU." / "… a CPU
// only."), then each model family's Run on (Auto / GPU / CPU, a radiogroup):
// a device that cannot run the family is a disabled radio with the reason as
// visible text and as its description -- the language model's GPU on
// noWebgpu says WebGPU, OPUS-MT's and NLLB-200's GPU says this version has
// no GPU copy wherever the device itself would not say why first (this build
// ships them CPU only: models.ts CatalogOptions `seq2seqGpu`), the language
// model's CPU is open everywhere -- and under Auto the line saying what Auto
// picks here (the CPU for OPUS-MT and NLLB-200, the GPU can't run them);
// then one line per copy (none on the GPU for OPUS-MT and NLLB-200): a GPU copy's Download
// is disabled exactly where it cannot run and is described by that reason,
// and "In use" marks a language model only where one can run. Under
// --mobile every device is a phone (`userAgentData.mobile`): the 4B is
// too large for its page and OPUS-MT's Auto picks the CPU. The composer's
// translate dialog, opened on the
// same language twice (the cleanup pass, LLM-only), shows the confirm
// disabled with "Correcting a message needs the GPU model." and the reason
// where the GPU model cannot run, and "Correct" enabled where it can, and
// German as the target is on offer everywhere (the CPU models serve it);
// the channel panel greys the user's own language under "Send my messages
// in" with the same two sentences where the cleanup pass cannot run.
// Then, on the desktop device, the switches: the language model off leaves
// its Run on and its Downloads open (a download ahead of use) and makes the
// cleanup pass say so; both off puts the
// panel's notice up ("Translation can't run here right now." and both
// switches named), disables the reading switch's On, disables the message toolbar's
// Translate with the reason as its description, and disables German in the
// composer's dialog. On noWebgpu, the CPU models off is the one switch named.
//
// NLLB-200 (CC-BY-NC-4.0) is off until switched on, its licence line under
// the switch on every device, its Run on still open where it can run, and on
// noWebgpu English -> Japanese (no OPUS pair) is disabled in the composer's
// dialog with "This needs NLLB-200, which is switched off …" until the switch
// is turned on. The GPU model select greys a model this GPU cannot bind
// (binds128, binds160: the 4B, with a hint naming it and the buffer numbers) and no
// other. Last, on the desktop device on a connection that saves data (so no
// download is a quiet one, service.ts QUIET_DOWNLOAD_BYTES): a channel with
// several German lines switched to reading asks nothing -- reading never
// interrupts -- and every line offers the download instead, "Needs a <size>
// download · Download", its title naming the model; nothing pauses, nothing
// is remembered, and every copy line still says "Not downloaded".
//
// Not on the fake engine: ?fakeTranslate replaces the probe with its own
// answer. A production build is fine; no model is ever downloaded.
//
//   NODE_ENV=production pnpm build
//   python3 -m http.server -d public 8041 &
//   SEANCE_HTTP=http://localhost:8041/ CHROME_BIN=/seance/tmp/chrome-pw.sh \
//     node tools/browser-drive.mjs tools/scenarios/translate-capability.mjs
//   … --mobile --width=390 --height=844
//   … --device=binds128          (one device only)
//
// Needs the dev ircd's plain-WS port on 127.0.0.1:8067 (SEANCE_IRC_WS for
// the listener that posts the line the toolbar is checked on).

import {readFileSync} from "node:fs";
import {TRANSLATION_ON, closeTranslationPanel, openTranslationPanel} from "./lib/translation.mjs";

const RUN = Date.now().toString(36);
const BASE = process.env.SEANCE_HTTP || "http://localhost:8041/";
const IRCD = process.env.SEANCE_IRC_WS || "ws://127.0.0.1:8067/";
const CHANNEL = "#seance-capability";
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));
const MOBILE = process.argv.includes("--mobile");
/**
 * JS source: the language other than English the open channel's newest 60
 * lines from others were placed in most (recent.ts `recentLanguages`), or "".
 */
const RECENT_FOREIGN = `(() => {
	const store = document.getElementById("app").__vue_app__.config.globalProperties.$store;
	const messages = store.state.activeChannel.channel.messages;
	const counts = new Map();
	let looked = 0;

	for (let i = messages.length - 1; i >= 0 && looked < 60; i--) {
		const m = messages[i];

		if (m.self || (m.type !== "message" && m.type !== "action")) {
			continue;
		}

		looked++;

		const e = store.state.translations[m.id];

		if (e && e.from && e.status !== "dropped") {
			counts.set(e.from, (counts.get(e.from) || 0) + 1);
		}
	}

	const ranked = [...counts.entries()]
		.filter(([code]) => code !== "en")
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

	return ranked.length ? ranked[0][0] : "";
})()`;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const SMALL = "Qwen3-1.7B-q4f16_1-MLC";
const LARGE = "Qwen3-4B-q4f16_1-MLC";
const NLLB = "Xenova/nllb-200-distilled-600M";
// models.ts LLM_CHOICES largestBufferBytes (the 4B has no small-buffer build).
const NEEDS = {[SMALL]: 155_582_464, [LARGE]: 194_478_080};
// OPUS-MT and NLLB-200 have no GPU copy in this build (models.ts
// CatalogOptions `seq2seqGpu`): where the device itself is no reason, that
// is what their GPU choice says.
const NO_GPU_COPY = () => EN["translate.why.noGpuCopy"];
// The 1.7B's CPU copy (models.ts CPU_LLM_COPY).
const SMALL_CPU_SIZE = 1_107_409_472;

const DEVICES = {
	noWebgpu: {
		gpu: null,
		runs: {[SMALL]: false, [LARGE]: false},
		why: () => EN["translate.why.noWebgpu"],
		// NLLB-200's and OPUS-MT's GPU choice: null = it runs there. The
		// device's own reason comes before the missing copy (models.ts gpuBlock).
		seq2seqGpu: () => EN["translate.why.noWebgpu"],
		nllbGpu: () => EN["translate.why.noWebgpu"],
	},
	noF16: {
		gpu: {f16: false, max: 2 * GiB},
		runs: {[SMALL]: false, [LARGE]: false},
		why: () => EN["translate.why.noF16"],
		seq2seqGpu: () => EN["translate.why.noF16"],
		nllbGpu: () => EN["translate.why.noF16"],
	},
	lowLimits: {
		gpu: {f16: true, max: 2 * GiB, storageBuffers: 8},
		runs: {[SMALL]: false, [LARGE]: false},
		why: () => EN["translate.why.gpuLimits"],
		// WebLLM's shader floors are the language model's alone.
		seq2seqGpu: NO_GPU_COPY,
		nllbGpu: NO_GPU_COPY,
	},
	binds128: {
		gpu: {f16: true, max: 128 * MiB},
		runs: {[SMALL]: true, [LARGE]: false},
		why: (id) => needsBuffer(NEEDS[id], 128 * MiB),
		seq2seqGpu: NO_GPU_COPY,
		nllbGpu: NO_GPU_COPY,
	},
	binds160: {
		gpu: {f16: true, max: 160 * MiB},
		runs: {[SMALL]: true, [LARGE]: false},
		why: (id) => needsBuffer(NEEDS[id], 160 * MiB),
		seq2seqGpu: NO_GPU_COPY,
		nllbGpu: NO_GPU_COPY,
	},
	desktop: {
		gpu: {f16: true, max: 2 * GiB},
		runs: {[SMALL]: true, [LARGE]: true},
		why: () => "",
		seq2seqGpu: NO_GPU_COPY,
		nllbGpu: NO_GPU_COPY,
	},
	// The desktop's GPU on a phone (`userAgentData.mobile`): the 4B is too
	// large for a phone's page whatever the GPU binds (models.ts
	// tooLargeForPhone), the 1.7B runs and is the default.
	phone: {
		gpu: {f16: true, max: 2 * GiB},
		mobile: true,
		runs: {[SMALL]: true, [LARGE]: false},
		why: (id) => (id === LARGE ? EN["translate.why.phoneMemory"] : ""),
		seq2seqGpu: NO_GPU_COPY,
		nllbGpu: NO_GPU_COPY,
	},
};

/**
 * A device as this run sees it: under --mobile every device is a phone, so
 * the desktop's GPU is the phone's (the 4B too large for the page).
 */
function deviceFor(name) {
	const device = DEVICES[name];

	return MOBILE && name === "desktop" ? {...DEVICES.phone, gpu: device.gpu} : device;
}

/** friendlysize.ts under the English locale. */
function size(bytes) {
	const units = ["Bytes", "KiB", "MiB", "GiB", "TiB"];
	const i = bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(1024)) : 0;
	const n = new Intl.NumberFormat("en", {maximumFractionDigits: 1, useGrouping: false});

	return `${n.format(bytes / Math.pow(1024, i))} ${units[i]}`;
}

function needsBuffer(needed, limit) {
	return EN["translate.model.needsBuffer"]
		.replace("{needed}", size(needed))
		.replace("{limit}", size(limit));
}

// The stand-in, read from storage at every document start: the probe runs
// once per page, so each device is a cold load with its key set.
const GPU_STUB = `(() => {
	let device = null;
	try { device = JSON.parse(localStorage.getItem("seance.test.gpu") || "null"); } catch (e) {}
	if (!device) { return; }
	const gpu = device.gpu === null ? undefined : {
		requestAdapter: async () => ({
			features: new Set(device.gpu.f16 ? ["shader-f16"] : []),
			limits: {
				maxBufferSize: device.gpu.max,
				maxStorageBufferBindingSize: device.gpu.max,
				maxStorageBuffersPerShaderStage: device.gpu.storageBuffers ?? 10,
				maxComputeWorkgroupStorageSize: 32768,
			},
		}),
	};
	Object.defineProperty(Navigator.prototype, "gpu", {configurable: true, get: () => gpu});
	if (device.mobile) {
		const data = {mobile: true, platform: "Android", brands: []};
		Object.defineProperty(Navigator.prototype, "userAgentData", {configurable: true, get: () => data});
	}
})();`;

const ROW = (id) => `.translate-model[data-model=${JSON.stringify(id)}]`;
const COPY = (id, device) => `${ROW(id)} .translate-copy[data-device="${device}"]`;
const RADIO = (setting, value) => `input[name="${setting}"][value="${value}"]`;
const FAMILY = (family) => `.translate-family[data-family="${family}"]`;
const SETTING = {
	llm: "translateLlmDevice",
	opus: "translateOpusDevice",
	nllb: "translateNllbDevice",
};
const text = (selector) =>
	`((document.querySelector(${JSON.stringify(selector)}) || {}).textContent || "").trim()`;
const PICKER = ".language-sheet";

/** A second user who says one line in the channel, for the toolbar. */
function speaker(nick, line) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("speaker never joined")), 20000);

		ws.onopen = () => {
			ws.send(`NICK ${nick}`);
			ws.send(`USER ${nick} 0 * :seance capability speaker`);
		};
		ws.onmessage = (ev) => {
			const msg = String(ev.data);

			if (msg.startsWith("PING")) {
				ws.send(msg.replace("PING", "PONG"));
			} else if (/ 001 /.test(msg)) {
				ws.send(`JOIN ${CHANNEL}`);
			} else if (new RegExp(`^(?:@\\S+ )?:${nick}\\S* JOIN`).test(msg)) {
				clearTimeout(timer);
				ws.send(`PRIVMSG ${CHANNEL} :${line}`);
				resolve({quit: () => ws.send("QUIT :done")});
			}
		};
		ws.onerror = () => reject(new Error("speaker socket error"));
	});
}

export default async function run(page) {
	// Translation ships switched off (settings.ts translationEnabled).
	await page.addInitScript(TRANSLATION_ON);
	await page.addInitScript(GPU_STUB);

	const only = page.opt("device", null);
	const names = only ? [only] : Object.keys(DEVICES);
	let first = true;

	const coldLoad = async (name, index) => {
		const nick = `cap${RUN}${index}`;
		const path = `/?host=127.0.0.1&port=8067&tls=false&nick=${nick}&join=${encodeURIComponent(
			CHANNEL
		)}`;
		const device = JSON.stringify({
			gpu: DEVICES[name].gpu,
			mobile: !!DEVICES[name].mobile || MOBILE,
		});

		if (first) {
			first = false;
			await page.goto(new URL(path, BASE).href, {waitForSelector: "#app"});
			await page.evaluate(
				`(() => { localStorage.clear(); localStorage.setItem("seance.test.gpu", ${JSON.stringify(
					device
				)}); })()`
			);
		} else {
			await page.evaluate(
				`(() => { localStorage.clear(); localStorage.setItem("seance.test.gpu", ${JSON.stringify(
					device
				)}); })()`
			);
		}

		// F5 with the device's key set (browser-testing.md trap 8).
		await page.evaluate(
			`(() => { window.__coldLoad = true; history.replaceState(null, "", ${JSON.stringify(
				path
			)}); })()`
		);
		await page.send("Page.reload");
		const started = Date.now();

		for (;;) {
			try {
				if (
					await page.evaluate(
						`!window.__coldLoad && [...document.querySelectorAll("#chat .header .title")].some((el) => el.textContent.includes(${JSON.stringify(
							CHANNEL
						)}))`
					)
				) {
					break;
				}
				// A link to a server never approved asks first (link-approval.mjs).
				if (
					await page.evaluate(
						`!window.__coldLoad && !!document.querySelector("#connect .connect-link-notice")`
					)
				) {
					await page.click("#connect button[type=submit]");
					await page.sleep(500);
				}
			} catch {
				// the document is being replaced
			}

			if (Date.now() - started > 30000) {
				throw new Error(`${name}: never joined ${CHANNEL} after the cold load`);
			}

			await page.sleep(200);
		}
	};

	const openSettings = async () => {
		await page.evaluate(`location.hash = "#/settings/translation"`);
		await page.waitFor(`document.querySelectorAll(".translate-copy").length >= 3`, {
			label: "copy lines",
		});
		// The probe has answered once the device line is up.
		await page.waitFor(`!!document.querySelector(".translate-device")`, {
			label: "probe answered",
		});
	};

	const closeSettings = async () => {
		await page.click(".settings-modal-done");
		await page.waitFor(`!document.querySelector(".settings-modal")`, {
			label: "settings closed",
		});
	};

	const setSwitch = async (name, on) => {
		const current = await page.evaluate(
			`document.querySelector('input[name="${name}"]').checked`
		);

		if (current !== on) {
			// A real click lands at the element's centre: bring it on screen first.
			await page.evaluate(
				`document.querySelector('input[name="${name}"]').scrollIntoView({block: "center"})`
			);
			await page.sleep(100);
			await page.click(`input[name="${name}"]`);
			await page.waitFor(
				`document.querySelector('input[name="${name}"]').checked === ${on}`,
				{label: `${name} ${on}`}
			);
		}
	};

	/** A finger on `selector` for `hold` ms: a tap, or a long press. */
	const finger = async (selector, hold) => {
		const r = await page.evaluate(
			`(() => { const b = document.querySelector(${JSON.stringify(
				selector
			)}).getBoundingClientRect(); return {x: b.x + Math.min(b.width / 2, 40), y: b.y + b.height / 2}; })()`
		);
		const points = [{x: r.x, y: r.y, radiusX: 12, radiusY: 12, force: 1}];

		await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: points});
		await page.sleep(hold);
		await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
		await page.sleep(250);
	};

	const openPicker = async () => {
		await page.waitFor(`!!document.querySelector("#translate-once:not([disabled])")`, {
			label: "composer translate button enabled",
		});
		await page.click("#translate-once");
		await page.waitFor(`!!document.querySelector(${JSON.stringify(PICKER)})`, {
			label: "translate dialog open",
		});
	};

	// A row of the sheet's "They read" list, read without picking it: a
	// row that runs would apply at once. A blocked one is tapped, which
	// leaves the sheet up with the reason under the list.
	const rowState = async (code) => {
		const row = `${PICKER} .language-sheet-row[data-code="${code}"]`;
		const state = await page.evaluate(`(() => {
			const row = document.querySelector('${row}');
			return {
				disabled: row.classList.contains("blocked"),
				status: (row.querySelector(".language-sheet-status") || {}).textContent?.trim() || "",
				underHeading: (() => {
					const items = [...document.querySelectorAll("${PICKER} .language-sheet-list > li")];
					const heading = items.findIndex((li) => li.classList.contains("language-sheet-section"));
					return heading >= 0 && items.indexOf(row.closest("li")) > heading;
				})(),
			};
		})()`);

		if (!state.disabled) {
			return {
				...state,
				lead: "",
				why: "",
				live: await page.evaluate(
					`document.querySelector("${PICKER} .language-sheet-hint")?.getAttribute("aria-live") ?? null`
				),
			};
		}

		await page.evaluate(`document.querySelector('${row}').scrollIntoView({block: "nearest"})`);
		await page.click(row);
		await page.sleep(100);

		const hint = await page.evaluate(`(() => {
			const hint = document.querySelector("${PICKER} .language-sheet-hint");
			return {
				lead: ((hint && hint.querySelector(".language-sheet-blocked")) || {}).textContent?.trim() || "",
				why: ((hint && hint.querySelector(".language-sheet-why")) || {}).textContent?.trim() || "",
				live: hint ? hint.getAttribute("aria-live") : null,
			};
		})()`);

		return {...state, ...hint};
	};
	const openedOnCode = () =>
		page.evaluate(
			`document.querySelector('${PICKER} .language-sheet-side[data-side="to"]').dataset.code`
		);

	const closePicker = async () => {
		await page.evaluate(
			`document.querySelector(".language-sheet").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))`
		);
		await page.waitFor(`!document.querySelector(${JSON.stringify(PICKER)})`, {
			label: "dialog closed",
		});
	};

	const openPanel = () => openTranslationPanel(page);
	const closePanel = () => closeTranslationPanel(page);

	const panelState = () =>
		page.evaluate(`(() => {
			const select = document.querySelector('.translation-panel select[name="translateWrite"]');
			const note = document.getElementById("translation-panel-write-note");
			const banner = document.getElementById("translation-panel-blocked");
			const on = [...document.querySelectorAll(".translation-panel-segment")].find((b) => b.getAttribute("aria-checked") === "false" && b.closest('[role="radiogroup"]') && b.parentElement.previousElementSibling);
			return {
				enDisabled: [...select.options].find((o) => o.value === "en").disabled,
				deDisabled: [...select.options].find((o) => o.value === "de").disabled,
				note: note ? note.textContent.replace(/\\s+/g, " ").trim() : "",
				noteDescribes: !note || select.getAttribute("aria-describedby") === note.id,
				banner: banner ? banner.textContent.replace(/\\s+/g, " ").trim() : "",
				bannerRole: banner ? banner.getAttribute("role") : null,
			};
		})()`);

	const readOnSegment = `[...document.querySelectorAll(".translation-panel-section")][0].querySelectorAll(".translation-panel-segment")[1]`;

	for (const [index, name] of names.entries()) {
		const device = DEVICES[name] && deviceFor(name);

		if (!device) {
			throw new Error(`unknown --device=${name}`);
		}

		page.check(`--- ${name}`, true);
		await coldLoad(name, index);

		// 1. Settings → Translation: the device line, each family's Run on
		// and Auto line, and one line per copy.
		await openSettings();

		const mobile = !!DEVICES[name].mobile || MOBILE;
		const deviceLine = await page.evaluate(text(".translate-device-has"));
		const hasGpu = DEVICES[name].gpu !== null;

		page.check(
			`${name}: the device line says ${
				hasGpu ? "a GPU and a CPU" : "a CPU only"
			} (${deviceLine})`,
			deviceLine === EN[hasGpu ? "translate.capability.gpu" : "translate.capability.cpu"]
		);

		/** A family's Run on: each radio's state and reason, and the Auto line. */
		const runOn = (family) =>
			page.evaluate(`(() => {
				const group = document.querySelector(${JSON.stringify(FAMILY(family))} + " [role=radiogroup]");
				const radios = {};
				for (const value of ["auto", "gpu", "cpu"]) {
					const input = document.querySelector(${JSON.stringify(
						`input[name="${SETTING[family]}"]`
					)} + '[value="' + value + '"]');
					const described = input && input.getAttribute("aria-describedby");
					const reason = described ? document.getElementById(described) : null;
					const why = reason ? reason.textContent.trim() : "";
					// Visible text, not a tooltip: rendered, and not inside the radio's own label.
					const shown = reason && reason.getClientRects().length > 0 && !reason.closest("label") ? why : "";
					radios[value] = input ? {disabled: input.disabled, checked: input.checked, why, shown} : null;
				}
				return {
					group: !!group && !!group.getAttribute("aria-labelledby"),
					radios,
					auto: ((document.querySelector(${JSON.stringify(
						FAMILY(family)
					)} + " .translate-auto")) || {}).textContent?.trim() || "",
				};
			})()`);
		const autoSays = (family, verdicts) => {
			const order =
				family === "llm"
					? ["gpu"]
					: family === "nllb"
					? verdicts.gpu === null
						? ["gpu", "cpu"]
						: ["cpu"]
					: mobile
					? ["cpu", "gpu"]
					: ["gpu", "cpu"];
			const pick = order.find((d) => verdicts[d] === null);

			if (pick === "gpu") {
				// The 1.7B on a 128 MiB binding runs its small-buffer build.
				return EN[
					family === "llm" && name === "binds128"
						? "translate.settings.autoPicksGpuSmallBuild"
						: "translate.settings.autoPicksGpu"
				];
			}

			if (pick === "cpu") {
				// The GPU could run it (OPUS-MT on a phone), or it cannot.
				return EN[
					verdicts.gpu === null
						? "translate.settings.autoPicksCpu"
						: family === "nllb"
						? "translate.settings.autoPicksCpuNoGpuNllb"
						: "translate.settings.autoPicksCpuNoGpuOpus"
				];
			}

			// Nothing runs: the first device's reason, said once (the disabled
			// choice is described by this line, not by a second copy of it).
			return verdicts[order[0]];
		};
		const families = {
			llm: {gpu: device.runs[SMALL] ? null : device.why(SMALL), cpu: null},
			opus: {gpu: device.seq2seqGpu ? device.seq2seqGpu() : null, cpu: null},
			nllb: {gpu: device.nllbGpu ? device.nllbGpu() : null, cpu: null},
		};

		for (const [family, verdicts] of Object.entries(families)) {
			const state = await runOn(family);

			page.check(`${name}: ${family}'s Run on is a labelled radiogroup`, state.group);
			page.check(
				`${name}: ${family}'s Run on starts on Auto, which is open`,
				!!state.radios.auto && state.radios.auto.checked && !state.radios.auto.disabled
			);

			for (const d of ["gpu", "cpu"]) {
				const radio = state.radios[d];
				const why = verdicts[d];

				page.check(
					`${name}: ${family}'s ${d.toUpperCase()} is ${
						why ? `disabled: "${why}"` : "open"
					} (${
						radio ? (radio.disabled ? `disabled: ${radio.why}` : "open") : "missing"
					})`,
					!!radio &&
						radio.disabled === !!why &&
						(why ? radio.why === why && radio.shown === why : radio.why === "")
				);
			}

			const auto = autoSays(family, verdicts);

			page.check(
				`${name}: ${family}'s Auto line is "${auto}" (${state.auto})`,
				state.auto === auto
			);
		}

		for (const id of [SMALL, LARGE]) {
			const runs = device.runs[id];
			const state = await page.evaluate(`(() => {
				const line = document.querySelector(${JSON.stringify(COPY(id, "gpu"))});
				const button = line && line.querySelector(".translate-copy-download");
				const described = button && button.getAttribute("aria-describedby");
				const named = button && button.getAttribute("aria-labelledby");
				const label = (id) => (document.getElementById(id) || {}).textContent?.replace(/\\s+/g, " ").trim();
				return {
					line: !!line,
					name: named ? named.split(" ").map(label).join(" ") : "",
					modelName: document.querySelector(${JSON.stringify(
						ROW(id)
					)} + " .translate-model-name > span:first-child").textContent.replace(/\\s+/g, " ").trim(),
					state: line ? line.querySelector(".translate-copy-state").textContent.trim() : "",
					disabled: button ? button.disabled : null,
					describedBy: described ? label(described) : "",
					cpuLine: !!document.querySelector(${JSON.stringify(COPY(id, "cpu"))}),
					cpuDisabled: (document.querySelector(${JSON.stringify(
						COPY(id, "cpu")
					)} + " .translate-copy-download") || {}).disabled ?? null,
				};
			})()`);

			page.check(
				`${name}: ${id}'s GPU copy says it is not downloaded (${state.state})`,
				state.line &&
					state.state.startsWith(EN["translate.model.copyNotDownloaded"].split(" ·")[0])
			);
			page.check(
				`${name}: ${id}'s GPU Download is ${
					runs ? "enabled" : `disabled, described by "${device.why(id)}"`
				} (${state.disabled ? `disabled: ${state.describedBy}` : "enabled"})`,
				state.disabled === !runs && (runs || state.describedBy === device.why(id))
			);
			page.check(
				`${name}: ${id}'s GPU Download is named for its model and device (${state.name})`,
				state.name ===
					`${EN["translate.model.download"]} ${state.modelName} ${EN["translate.device.gpu"]}`
			);
			// Only the 1.7B has a CPU copy; it can be downloaded everywhere here.
			page.check(
				`${name}: ${id} ${
					id === SMALL ? "has an open CPU copy line" : "has no CPU copy line"
				}`,
				id === SMALL ? state.cpuLine && state.cpuDisabled === false : !state.cpuLine
			);
		}

		// "In use" only on a language model that can run here.
		const inUse = await page.evaluate(
			`[...document.querySelectorAll(".translate-model-in-use")].map((el) => el.closest(".translate-model").dataset.model).join(",")`
		);
		const expectInUse = device.runs[SMALL] && !device.runs[LARGE] ? SMALL : undefined;

		page.check(
			`${name}: "In use" is on ${
				expectInUse ?? (device.runs[SMALL] ? "a language model" : "no row")
			} (${inUse || "none"})`,
			expectInUse
				? inUse === expectInUse
				: device.runs[SMALL]
				? inUse === SMALL || inUse === LARGE
				: inUse === ""
		);

		const nllb = await page.evaluate(`(() => {
			const input = document.querySelector('input[name="translateNllb"]');
			return {
				switchOn: input.checked,
				licence: (document.getElementById(input.getAttribute("aria-describedby")) || {}).textContent?.trim() || "",
				cpuOpen: (document.querySelector(${JSON.stringify(
					COPY(NLLB, "cpu")
				)} + " .translate-copy-download") || {}).disabled === false,
			};
		})()`);

		page.check(
			`${name}: NLLB-200 is off until switched on, its licence named, its CPU Download open (${nllb.licence})`,
			!nllb.switchOn && nllb.licence === EN["translate.settings.nllbLicence"] && nllb.cpuOpen
		);

		// No GPU copy of OPUS-MT or NLLB-200 to download in this build.
		const seq2seqCopies = await page.evaluate(`(() => ({
			nllb: [...document.querySelectorAll(${JSON.stringify(
				`${ROW(NLLB)} .translate-copy`
			)})].map((el) => el.dataset.device).join(","),
			opus: [...document.querySelectorAll(${JSON.stringify(
				`${FAMILY("opus")} .translate-copy, ${FAMILY("opus")} .translate-opus-device`
			)})].map((el) => el.dataset.device).filter((d, i, all) => all.indexOf(d) === i).join(","),
		}))()`);

		page.check(
			`${name}: OPUS-MT and NLLB-200 list a CPU copy alone (OPUS ${seq2seqCopies.opus}, NLLB ${seq2seqCopies.nllb})`,
			seq2seqCopies.nllb === "cpu" && seq2seqCopies.opus === "cpu"
		);

		// The language model select: a model this GPU cannot bind is greyed, with why.
		const select = await page.evaluate(`(() => {
			const s = document.querySelector('select[name="translateLlmModel"]');
			const hint = document.getElementById("translate-llm-unfit");
			return {
				disabled: [...s.options].filter((o) => o.disabled).map((o) => o.value),
				hint: hint ? hint.textContent.replace(/\\s+/g, " ").trim() : "",
				described: s.getAttribute("aria-describedby"),
			};
		})()`);
		const unfit = device.runs[SMALL] && !device.runs[LARGE] ? [LARGE] : [];

		page.check(
			`${name}: the language model select greys ${unfit.join(", ") || "nothing"} (${
				select.disabled.join(", ") || "nothing"
			}${select.hint ? `: ${select.hint}` : ""})`,
			JSON.stringify(select.disabled) === JSON.stringify(unfit) &&
				(unfit.length
					? select.hint.includes(
							EN["translate.settings.gpuModelUnfit"].replace("{model}", "Qwen3 4B")
					  ) &&
					  select.hint.includes(device.why(LARGE)) &&
					  select.described === "translate-llm-unfit"
					: select.hint === "" && !select.described)
		);

		if (unfit.length) {
			await page.evaluate(
				`document.querySelector('select[name="translateLlmModel"]').scrollIntoView({block: "center"})`
			);
			await page.screenshot(`${name}-gpu-select`);
		}

		for (const family of ["llm", "opus", "nllb"]) {
			await page.evaluate(
				`document.querySelector(${JSON.stringify(
					FAMILY(family)
				)}).scrollIntoView({block: "start"})`
			);
			await page.screenshot(`${name}-settings-${family}`);
		}
		await closeSettings();

		// 2. The composer's dialog: what it opens on, the cleanup pass, German.
		await openPicker();

		const llm = device.runs[SMALL];
		const openedOn = await openedOnCode();
		const opened = openedOn ? await rowState(openedOn) : {disabled: false};

		// No earlier pick: a language the channel has been written in lately
		// (earlier runs' lines are in its history, and reading places them),
		// else the cleanup pass where the GPU model runs, else nothing
		// preselected -- never a disabled dialog, and never the first
		// language on the list passed off as a setting (outgoing.ts
		// `onceTargetDefault`, recent.ts `recentLanguages`).
		const recent = String(await page.evaluate(RECENT_FOREIGN));

		page.check(
			`${name}: the dialog opens on ${
				recent
					? `the channel's recent ${recent}`
					: llm
					? "the cleanup pass"
					: "no preselection"
			} (${openedOn || "none"}, ${opened.disabled ? "disabled" : "enabled"})`,
			!opened.disabled && openedOn === (recent || (llm ? "en" : ""))
		);
		await page.screenshot(`${name}-composer-opened`, {selector: PICKER, pad: 8});
		const same = await rowState("en");

		page.check(`${name}: the sheet's hint is a polite live region`, same.live === "polite");

		if (llm) {
			page.check(
				`${name}: the cleanup pass is on offer ("${same.status}")`,
				!same.disabled && same.status === EN["translate.sheet.corrects"]
			);
		} else {
			page.check(
				`${name}: the cleanup pass is disabled with its reason (${same.lead} / ${same.why})`,
				same.disabled &&
					same.underHeading &&
					same.lead === EN["translate.picker.sameLanguageNeedsGpu"] &&
					same.why === device.why(SMALL)
			);
		}

		await page.screenshot(`${name}-composer-same`, {selector: PICKER, pad: 8});

		const german = await rowState("de");

		page.check(
			`${name}: German is on offer (CPU models serve it)`,
			!german.disabled && german.lead === ""
		);
		await closePicker();

		// 3. The panel: the user's own language under "Send my messages in".
		await openPanel();

		const panel = await panelState();
		const focus = await page.evaluate(`(() => {
			const a = document.activeElement;
			return a ? {role: a.getAttribute("role"), checked: a.getAttribute("aria-checked"), text: a.textContent.trim()} : null;
		})()`);

		page.check(
			`${name}: the panel opens on the reading switch's checked choice (${JSON.stringify(
				focus
			)})`,
			!!focus && focus.role === "radio" && focus.checked === "true"
		);

		if (MOBILE) {
			// The sheet is modal: Tab and Shift+Tab stay inside it, walking
			// its controls and wrapping last -> first (and first -> last
			// under Shift) -- not merely never leaving, which a Tab that
			// moved nothing would pass too.
			const TABBABLE = `[...document.querySelector(".translation-panel").querySelectorAll("button, select, input, textarea, a[href], [tabindex]")].filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0)`;
			const count = await page.evaluate(`${TABBABLE}.length`);
			const forward = [];
			const backward = [];
			const outside = [];

			for (let i = 0; i < 2 * count + 4; i++) {
				const shift = i >= count + 2;

				await page.send("Input.dispatchKeyEvent", {
					type: "rawKeyDown",
					key: "Tab",
					code: "Tab",
					windowsVirtualKeyCode: 9,
					modifiers: shift ? 8 : 0,
				});
				await page.send("Input.dispatchKeyEvent", {
					type: "keyUp",
					key: "Tab",
					code: "Tab",
					windowsVirtualKeyCode: 9,
					modifiers: shift ? 8 : 0,
				});

				const at = await page.evaluate(
					`(() => { const a = document.activeElement; if (!a || !a.closest(".translation-panel")) { return a ? a.tagName + "." + a.className : "none"; } return ${TABBABLE}.indexOf(a); })()`
				);

				if (typeof at === "string") {
					outside.push(at);
				} else {
					(shift ? backward : forward).push(at);
				}
			}

			const wraps = (steps, from, to) =>
				steps.some((value, i) => i > 0 && steps[i - 1] === from && value === to);

			page.check(
				`${name}: Tab stays inside the sheet (${outside.join(", ") || "always inside"})`,
				outside.length === 0
			);
			page.check(
				`${name}: Tab walks the sheet's ${count} controls and wraps both ways (${forward.join(
					","
				)} / ${backward.join(",")})`,
				count > 3 &&
					new Set(forward).size === count &&
					wraps(forward, count - 1, 0) &&
					wraps(backward, 0, count - 1)
			);
		}

		page.check(
			`${name}: no notice in the panel (something runs)`,
			panel.banner === "" && !panel.deDisabled
		);
		page.check(
			`${name}: the own language is ${llm ? "on offer" : "greyed, with the reason"} (${
				panel.note
			})`,
			llm
				? !panel.enDisabled && panel.note === ""
				: panel.enDisabled &&
						panel.note.includes(
							EN["translate.panel.ownLanguageNeedsGpu"].replace(
								"{language}",
								"English"
							)
						) &&
						panel.note.includes(device.why(SMALL)) &&
						panel.noteDescribes
		);
		await page.screenshot(`${name}-panel`);
		await closePanel();

		// NLLB-200's opt-in: English to Japanese has no OPUS pair, and this
		// device runs no GPU model, so only NLLB could take it.
		if (name === "noWebgpu") {
			const japanese = EN["translate.pair.unavailable"]
				.replace("{from}", "English")
				.replace("{to}", "Japanese");

			await openPicker();

			const off = await rowState("ja");

			page.check(
				`noWebgpu, NLLB off: Japanese is disabled, NLLB named (${off.lead} / ${off.why})`,
				off.disabled && off.lead === japanese && off.why === EN["translate.why.nllbOff"]
			);
			await page.screenshot("noWebgpu-nllb-off-composer", {selector: PICKER, pad: 8});
			await closePicker();
			await openSettings();
			await setSwitch("translateNllb", true);

			const row = await page.evaluate(`(() => ({
				auto: (document.querySelector(${JSON.stringify(
					FAMILY("nllb")
				)} + " .translate-auto") || {}).textContent?.trim() || "",
				open: (document.querySelector(${JSON.stringify(
					COPY(NLLB, "cpu")
				)} + " .translate-copy-download") || {}).disabled === false,
			}))()`);

			page.check(
				`noWebgpu, NLLB on: Auto runs it on the CPU, its Download open (${row.auto})`,
				row.auto === EN["translate.settings.autoPicksCpuNoGpuNllb"] && row.open
			);
			await closeSettings();
			await openPicker();

			const on = await rowState("ja");

			page.check(
				`noWebgpu, NLLB on: Japanese is on offer (${on.lead || "enabled"})`,
				!on.disabled && on.lead === ""
			);
			await closePicker();
		}

		// 4. The switches.
		if (name === "noWebgpu") {
			await openSettings();
			// NLLB-200 counts while it is on (router.ts translationBlock):
			// back off first, so OPUS-MT's switch is the one named.
			await setSwitch("translateNllb", false);
			await setSwitch("translateCpu", false);
			await closeSettings();
			await openPanel();

			const off = await panelState();

			page.check(
				`noWebgpu, CPU models off: the notice names the CPU switch (${off.banner})`,
				off.banner.includes(EN["translate.unavailable.lead"]) &&
					off.banner.includes(EN["translate.why.cpuOff"]) &&
					off.bannerRole === "status"
			);
			await page.screenshot("noWebgpu-cpu-off-panel");
			await closePanel();
		}

		if (name === "desktop") {
			await openSettings();
			await setSwitch("translateLlm", false);

			// Off is not "can't": its Run on and its Downloads stay open (a
			// download ahead of use), and no reason is shown for the switch.
			const rows = await page.evaluate(`(() => ({
				gpu: !document.querySelector(${JSON.stringify(RADIO("translateLlmDevice", "gpu"))}).disabled,
				cpu: !document.querySelector(${JSON.stringify(RADIO("translateLlmDevice", "cpu"))}).disabled,
				downloads: ${JSON.stringify(
					[COPY(SMALL, "gpu"), COPY(SMALL, "cpu")].concat(
						device.runs[LARGE] ? [COPY(LARGE, "gpu")] : []
					)
				)}.every((sel) => document.querySelector(sel + " .translate-copy-download").disabled === false),
				auto: (document.querySelector(${JSON.stringify(
					FAMILY("llm")
				)} + " .translate-auto") || {}).textContent?.trim() || "",
			}))()`);

			page.check(
				`desktop, the language model off: Run on and the Downloads stay open (${JSON.stringify(
					rows
				)})`,
				rows.gpu &&
					rows.cpu &&
					rows.downloads &&
					rows.auto === EN["translate.settings.autoPicksGpu"]
			);
			await page.evaluate(
				`document.querySelector(${JSON.stringify(
					FAMILY("llm")
				)}).scrollIntoView({block: "start"})`
			);
			await page.screenshot("desktop-gpu-off-settings");
			await closeSettings();
			await openPicker();

			// The GPU model off: the sheet no longer opens on the cleanup pass.
			const openedOff = await openedOnCode();

			page.check(
				`desktop, GPU off: the sheet opens on a pair that runs, or none (${
					openedOff || "none"
				})`,
				openedOff === "" || (openedOff !== "en" && !(await rowState(openedOff)).disabled)
			);

			const polish = await rowState("en");

			page.check(
				`desktop, GPU off: the cleanup pass names the switch (${polish.why})`,
				polish.disabled &&
					polish.lead === EN["translate.picker.sameLanguageNeedsGpu"] &&
					["Qwen3 1.7B", "Qwen3 4B"].some(
						(model) =>
							polish.why === EN["translate.why.llmOff"].replace("{model}", model)
					)
			);
			await closePicker();

			// Reading is on: what it has under way finishes first, so the
			// switch below finds the engine idle and takes effect at once
			// (service.ts setSettings → afterEngineIdle).
			await page.waitFor(
				`!Object.values(document.getElementById("app").__vue_app__.config.globalProperties.$store.state.translations).some((e) => e.status === "pending")`,
				{timeout: 60000, label: "reading has nothing under way"}
			);
			await openSettings();
			await setSwitch("translateCpu", false);
			await closeSettings();

			// Both off: a line from someone else, for the toolbar. It comes
			// after the switch: reading is on, and a line queued while
			// OPUS-MT was still on finishes there by design. Earlier runs'
			// copies are in the channel's history: wait for a new one.
			const HELLOS = `[...document.querySelectorAll("#chat .msg:not(.self)")].filter((m) => m.textContent.includes("Hallo zusammen")).length`;
			const hellosBefore = Number(await page.evaluate(HELLOS));
			const other = await speaker(`cs${RUN}`, "Hallo zusammen, wie geht es euch heute?");

			await page.waitFor(`${HELLOS} > ${hellosBefore}`, {label: "the speaker's line"});

			// The row by its id: once read, its text is the translation's.
			const helloId = String(
				await page.evaluate(
					`[...document.querySelectorAll("#chat .msg:not(.self)")].filter((m) => m.textContent.includes("Hallo zusammen")).pop().id`
				)
			);
			const HELLO = `document.getElementById(${JSON.stringify(helloId)})`;

			// Reading settles the line (work under way when the switches went
			// off finishes), and the toolbar's Translate is on offer again.
			await page.waitFor(`!!${HELLO}?.querySelector(".msg-action-translate")`, {
				timeout: 30000,
				label: "the line's toolbar offers Translate",
			});

			// Under --mobile the toolbar is a finger's: a long press opens it
			// and marks the last pointer a touch (helpers/inputModality.ts).
			if (MOBILE) {
				await page.evaluate(`${HELLO}.setAttribute("data-cap-target", "1")`);
				await finger("[data-cap-target] .content", 700);
			}

			const toolbar = await page.evaluate(`(() => {
				const msg = ${HELLO};
				const b = msg && msg.querySelector(".msg-action-translate");
				const described = b && b.getAttribute("aria-describedby");
				return b ? {disabled: b.disabled, ariaDisabled: b.getAttribute("aria-disabled"), title: b.title, described: described ? (document.getElementById(described) || {}).textContent?.trim() : ""} : null;
			})()`);

			// Under a finger it stays tappable (aria-disabled) and the tap opens
			// the panel, since no tooltip shows there; under a mouse, disabled.
			page.check(
				`desktop, both off: the toolbar's Translate is ${
					MOBILE ? "aria-disabled" : "disabled"
				}, described by the reason (${JSON.stringify(toolbar)})`,
				!!toolbar &&
					(MOBILE
						? !toolbar.disabled && toolbar.ariaDisabled === "true"
						: toolbar.disabled) &&
					toolbar.described === EN["translate.why.allOff"] &&
					toolbar.title === EN["translate.why.allOff"]
			);

			if (!MOBILE) {
				// The speaker's line by its id: the list's last element of its
				// type need not be a message.
				await page.evaluate(`${HELLO}.setAttribute("data-cap-target", "1")`);
				await page.hover("[data-cap-target]");
				await page.screenshot("desktop-both-off-toolbar", {
					selector: "[data-cap-target]",
					pad: 40,
				});
			} else {
				// The tap a finger makes: the panel opens with the reason.
				await finger("[data-cap-target] .msg-action-translate", 60);
				await page.waitFor(`!!document.querySelector(".translation-panel")`, {
					label: "the toolbar's tap opened the panel",
				});

				const tapped = await panelState();

				page.check(
					`desktop, both off: the toolbar's tap opens the panel with the reason (${tapped.banner})`,
					tapped.banner.includes(EN["translate.why.allOff"])
				);
				await page.screenshot("desktop-both-off-toolbar-tap");
				await closePanel();
			}

			// The channel menu's panel gives the reason, not a reading that fails.
			await openPanel();

			const off = await panelState();
			const onSegment = await page.evaluate(
				`(() => { const b = ${readOnSegment}; return {checked: b.getAttribute("aria-checked") === "true", described: b.getAttribute("aria-describedby")}; })()`
			);
			const reading = await page.evaluate(
				`JSON.parse(localStorage.getItem("thelounge.translate") || "{}")`
			);

			page.check(
				`desktop, both off: the notice says both switches (${off.banner})`,
				off.banner.includes(EN["translate.unavailable.lead"]) &&
					off.banner.includes(EN["translate.why.allOff"])
			);
			page.check(
				// Reading is on unless excluded: On is the checked choice, so it
				// is not disabled, and the notice says why nothing is read.
				`desktop, both off: reading's On is described by the notice`,
				onSegment.checked && onSegment.described === "translation-panel-blocked"
			);
			page.check(
				`desktop, both off: the conversation is not excluded`,
				!JSON.stringify(reading).includes('"exclude":true')
			);
			page.check(
				`desktop, both off: every language is greyed under "Send my messages in"`,
				off.enDisabled && off.deDisabled
			);
			await page.screenshot("desktop-both-off-panel");
			await closePanel();

			await openPicker();

			const blocked = await rowState("de");

			page.check(
				`desktop, both off: German in the dialog is disabled with the reason (${blocked.lead} / ${blocked.why})`,
				blocked.disabled &&
					blocked.lead ===
						EN["translate.pair.unavailable"]
							.replace("{from}", "English")
							.replace("{to}", "German") &&
					blocked.why === EN["translate.why.allOff"]
			);
			await page.screenshot("desktop-both-off-composer", {selector: PICKER, pad: 8});
			await closePicker();
			other.quit();
		}
	}

	if (!only || only === "desktop") {
		await consentStage(names.length);
	}

	page.check(
		`no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
		page.consoleErrors.length === 0
	);

	/**
	 * Downloads on the desktop device: nothing is downloaded, and the
	 * connection saves data, so reading's first route of a channel's lines
	 * needs a download nobody agreed to. It must ask nothing, offer it on
	 * every line with the model named, and pause nothing.
	 */
	async function consentStage(index) {
		page.check("--- consent", true);
		// Nothing downloaded: reading is on in every conversation, so the
		// stages before this one read the channel's German lines and left
		// OPUS-MT's copy in the cache (seq2seq.real.ts CACHE_NAME), which a
		// cold load's localStorage.clear() does not touch.
		await page.evaluate(`caches.delete("transformers-cache")`);
		await page.addInitScript(
			`Object.defineProperty(Navigator.prototype, "connection", {configurable: true, get: () => ({saveData: true, type: "wifi"})});`
		);
		await coldLoad("desktop", index);

		const lines = [
			"Guten Morgen, habt ihr den Bericht schon gelesen?",
			"Ich finde, wir sollten das morgen besprechen.",
			"Das Wetter ist heute wirklich schön.",
			"Kann jemand mir bei der Konfiguration helfen?",
		];
		const speakers = [];

		for (const [i, text] of lines.entries()) {
			speakers.push(await speaker(`cq${RUN}${i}`, text));
		}

		await page.waitFor(
			`${JSON.stringify(
				lines
			)}.every((line) => [...document.querySelectorAll("#chat .msg:not(.self)")].some((m) => m.textContent.includes(line)))`,
			{label: "the German lines", timeout: 20000}
		);
		// Count every question the dialog is opened with, from now on.
		// The overlay stays in the page and takes "opened" while a question
		// is up (ConfirmDialog.vue): each time it does is one question.
		await page.evaluate(`(() => {
			window.__questions = [];
			const overlay = document.getElementById("confirm-dialog-overlay");
			let open = false;
			new MutationObserver(() => {
				const now = overlay.classList.contains("opened");
				if (now && !open) { window.__questions.push(overlay.querySelector(".confirm-text-title").textContent.trim()); }
				open = now;
			}).observe(overlay, {attributes: true, attributeFilter: ["class"], childList: true, subtree: true});
		})()`);

		// Reading is on unless excluded; the panel's On leaves it so.
		await openPanel();
		await page.evaluate(`${readOnSegment}.click()`);
		await closePanel();

		// The language model's copy is the GPU's (a reason names its device).
		// Which GPU model the device default picked: the 4B on a desktop with
		// the memory for it.
		const sizeOf = {
			[EN["translate.model.llm"].replace("{name}", "Qwen3 1.7B")]: 984_000_000,
			[EN["translate.model.llm"].replace("{name}", "Qwen3 4B")]: 2_280_000_000,
		};
		// Each line's newest copy: the channel's history holds earlier runs'
		// copies above the screen, which reading leaves alone (onScreen.ts).
		const OFFERS = `${JSON.stringify(
			lines
		)}.map((line) => [...document.querySelectorAll("#chat .msg:not(.self)")].reverse().find((m) => m.textContent.includes(line))).map((m) => { const r = m && m.querySelector('.msg-translation[data-status="failed"] .msg-translation-offer'); return r ? {text: r.textContent.replace(/\\s+/g, " ").trim(), title: r.title} : null; })`;

		await page.waitFor(`${OFFERS}.every((r) => r)`, {
			label: "every line offers its download",
			timeout: 30000,
		});
		await page.sleep(1500);

		const offers = await page.evaluate(OFFERS);
		const reasons = Object.entries(sizeOf).map(([model, bytes]) => ({
			text: `${EN["translate.line.needsDownload"].replace("{size}", size(bytes))} ${
				EN["translate.line.download"]
			}`,
			title: EN["translate.why.downloadGpu"]
				.replace("{model}", model)
				.replace("{size}", size(bytes)),
		}));
		const after = await page.evaluate(`(() => ({
			count: window.__questions.length,
			open: !!document.querySelector("#confirm-dialog-overlay.opened"),
			paused: !!document.getElementById("app").__vue_app__.config.globalProperties.$store.state.translation.paused,
			consent: localStorage.getItem("thelounge.state.translateConsent"),
		}))()`);

		page.check(
			`consent: every line offers the language model's download (${offers[0]?.text} / ${offers[0]?.title})`,
			offers.every(
				(r) => r && reasons.some((want) => want.text === r.text && want.title === r.title)
			)
		);
		page.check(
			`consent: nothing asked, nothing remembered (${after.count}, ${after.consent})`,
			after.count === 0 && !after.open && after.consent === null
		);
		page.check(`consent: no pause (${after.paused})`, !after.paused);
		await page.screenshot("consent-offers");

		// Nothing was downloaded, or is: every model row still says so.
		await openSettings();

		const rows = await page.evaluate(
			`[...document.querySelectorAll(".translate-copy")].map((line) => line.dataset.status + ":" + line.dataset.cached + ":" + line.querySelector(".translate-copy-state").textContent.trim().split(" ·")[0])`
		);
		const idle = `idle:false:${EN["translate.model.copyNotDownloaded"].split(" ·")[0]}`;

		page.check(
			`consent: no copy downloaded or downloading (${[...new Set(rows)].join(", ")})`,
			rows.length > 3 && rows.every((row) => row === idle)
		);
		await closeSettings();

		for (const s of speakers) {
			s.quit();
		}
	}
}
