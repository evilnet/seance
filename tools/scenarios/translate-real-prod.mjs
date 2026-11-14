// Real models through a *production* build's translation worker -- the
// Rolldown IIFE `js/translate-worker.js` -- which no other check loads:
// translate-cpu-real.mjs needs a development build (its console hook) and
// the dev ircd. What this exercises is the worker bundle itself: ONNX
// Runtime's dynamic import() of js/ort/ort-wasm-simd-threaded.mjs and the
// wasmPaths override (the code vite.translate.config.mts's import.meta stub
// touches), ORT's thread workers on a cross-origin-isolated page, and
// wllama's blob: worker for the CPU language model.
//
// 1. The app, as shipped: translation switched on (lib/translation.mjs),
//    the page reloaded once so the service worker controls it and it is
//    cross-origin isolated, then Settings → Translation downloads the
//    OPUS-MT en-it pair's CPU copy through the app's own service and
//    worker (a load creates the ORT session). Translation is then
//    switched off, which takes the app's worker down with its model.
// 2. Two workers of our own, `new Worker("js/translate-worker.js")`,
//    speaking the protocol (client/js/translate/protocol.ts) with the
//    catalog the app builds (models.ts `buildCatalog`, run here through
//    tsx): the OPUS pair (now in Cache Storage) translates one line, then
//    the 1.7B's CPU copy (wllama, a 1.1 GB GGUF) translates the same line.
//    The page-side service and router are not in this half: they are the
//    app bundle, which part 1 and every other scenario run.
//
// **Opt-in** (SEANCE_REAL_MODELS=1): it downloads ~100 MB from
// huggingface.co, and 1.1 GB unless SEANCE_MODEL_MIRROR names a mirror that
// holds `unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf` (docs/resources/
// branding.md § Translation, mirror layout) -- same origin, or with CORS.
//
//   NODE_ENV=production pnpm build
//   mkdir -p site/mirror/unsloth/Qwen3-1.7B-GGUF && ln -s $PWD/public site/app
//   ln -s /path/to/Qwen3-1.7B-Q4_K_M.gguf site/mirror/unsloth/Qwen3-1.7B-GGUF/
//   python3 -c 'import http.server as h, mimetypes as m, functools; m.add_type("text/javascript", ".mjs"); m.add_type("application/wasm", ".wasm"); h.test(functools.partial(h.SimpleHTTPRequestHandler, directory="site"), h.ThreadingHTTPServer, port=8021)' &
//   SEANCE_REAL_MODELS=1 SEANCE_HTTP=http://localhost:8021/app/ \
//     SEANCE_MODEL_MIRROR=http://localhost:8021/mirror CHROME_BIN=/seance/tmp/chrome-pw.sh \
//     node tools/browser-drive.mjs tools/scenarios/translate-real-prod.mjs
//
// Serve .mjs as text/javascript and .wasm as application/wasm (the one-liner
// does), or ORT reports "no available backend found".

import {execFileSync} from "node:child_process";
import {TRANSLATION_ON} from "./lib/translation.mjs";

const BASE = process.env.SEANCE_HTTP || "http://localhost:8021/app/";
const MIRROR = process.env.SEANCE_MODEL_MIRROR || null;
const OPUS = "Xenova/opus-mt-en-it";
const ENGLISH = "please keep the timestamps in the log too, I need the ordering";
const OPUS_TIMEOUT = 15 * 60 * 1000;
const LLM_TIMEOUT = 30 * 60 * 1000;

export const url = BASE;

const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store.state`;
const VIEW = (id) =>
	`(() => { const m = ${STORE}.translation.models.find((v) => v.ref.id === ${JSON.stringify(
		id
	)} && v.device === "cpu"); return m ? {status: m.status, cached: m.cached, fraction: m.fraction, error: m.error} : null; })()`;
const COPY = (id) => `.translate-model[data-model="${id}"] .translate-copy[data-device="cpu"]`;

/** The catalog the app builds (models.ts), for a deploy with or without a mirror. */
function catalog(modelBase) {
	const options = JSON.stringify({seq2seqGpu: false, ...(modelBase ? {modelBase} : {})});

	return JSON.parse(
		execFileSync(
			"npx",
			[
				"tsx",
				"-e",
				`import {buildCatalog} from "./client/js/translate/models.ts"; process.stdout.write(JSON.stringify(buildCatalog(${options}, null)));`,
			],
			{encoding: "utf8"}
		)
	);
}

/**
 * Start a worker of our own on `catalog`, load `ref`'s CPU copy, translate
 * `text`, ask for the engines' status and terminate it, recording into
 * window.__real as it goes (polled: one long evaluate is the driver's trap 8).
 */
function driveWorker({catalogJson, ref, text, from, to}) {
	return `(() => {
	const out = (window.__real = {phase: "starting", progress: 0, chunks: 0, errors: []});
	const started = performance.now();
	const worker = new Worker(new URL("js/translate-worker.js", document.baseURI));
	const catalog = ${catalogJson};
	const ref = ${JSON.stringify(ref)};

	worker.onerror = (e) => {
		out.errors.push("worker error: " + (e.message || e.type));
		out.phase = "failed";
	};
	worker.onmessage = (event) => {
		const m = event.data;

		if (m.type === "progress") {
			out.progress++;
			out.lastProgress = m.progress;
		} else if (m.type === "loaded") {
			out.loadMs = Math.round(performance.now() - started);
			out.phase = "translating";
			out.translateStarted = performance.now();
			worker.postMessage({
				type: "translate",
				ref,
				req: {
					id: 1,
					model: ref.id,
					device: "cpu",
					text: ${JSON.stringify(text)},
					from: ${JSON.stringify(from)},
					to: ${JSON.stringify(to)},
					purpose: "read",
					context: {recent: [], names: [], terms: [], voice: [], formality: "auto"},
				},
			});
		} else if (m.type === "chunk") {
			out.chunks++;
			out.text = m.chunk.text;
		} else if (m.type === "done") {
			out.translateMs = Math.round(performance.now() - out.translateStarted);
			out.phase = "status";
			worker.postMessage({type: "status"});
		} else if (m.type === "status") {
			out.status = m.engines;
			out.phase = "done";
			worker.terminate();
		} else if (m.type === "error") {
			out.errors.push(m.scope + ": " + m.message);
			out.phase = "failed";
			worker.terminate();
		}
	};
	worker.postMessage({type: "configure", catalog, ortBase: new URL("js/ort/", document.baseURI).href});
	out.phase = "loading";
	worker.postMessage({type: "load", ref, device: "cpu"});
	return "started";
})()`;
}

async function runWorker(page, label, job, timeout) {
	await page.evaluate(driveWorker(job));
	await page.waitFor(`window.__real.phase === "done" || window.__real.phase === "failed"`, {
		timeout,
		label,
	});

	const result = await page.evaluate(`JSON.parse(JSON.stringify(window.__real))`);

	delete result.translateStarted;
	console.log(`${label}:`, JSON.stringify(result));

	return result;
}

export default async function run(page) {
	if (process.env.SEANCE_REAL_MODELS !== "1") {
		console.log(
			"SKIPPED: translate-real-prod downloads real weights; run it with SEANCE_REAL_MODELS=1."
		);

		return;
	}

	await page.addInitScript(TRANSLATION_ON);

	// ---- The app, isolated -------------------------------------------------
	await page.goto(page.url, {waitForSelector: "#connect"});

	const registered = await page.evaluate(
		`Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 20000))])`
	);

	page.check("the service worker is active", registered === true);
	// The load after the worker took control is the isolated one.
	await page.evaluate(`location.reload()`);
	await page.sleep(1500);
	await page.waitFor(`!!document.querySelector("#connect")`, {label: "reloaded"});

	const env = await page.evaluate(`({
		isolated: self.crossOriginIsolated,
		controlled: !!navigator.serviceWorker.controller,
		cores: navigator.hardwareConcurrency,
		build: (document.querySelector('script[src*="prepaint"]')?.getAttribute("src") || "").split("v=")[1] || "",
	})`);

	console.log("page:", JSON.stringify(env));
	page.check("the page is cross-origin isolated (threads)", env.isolated === true);

	// ---- 1. Settings → Translation downloads the OPUS pair -----------------
	await page.evaluate(`(() => { location.hash = "#/settings/translation"; })()`);
	await page.waitFor(
		`!!document.querySelector(${JSON.stringify(`${COPY(OPUS)} .translate-copy-download`)})`,
		{
			timeout: 30000,
			label: "the OPUS pair's CPU Download",
		}
	);

	const downloadStarted = Date.now();

	await page.click(`${COPY(OPUS)} .translate-copy-download`);
	await page.waitFor(
		`(() => { const v = ${VIEW(
			OPUS
		)}; return !!v && (v.status === "ready" || v.status === "failed"); })()`,
		{timeout: OPUS_TIMEOUT, label: "the OPUS download settled"}
	);

	const view = await page.evaluate(VIEW(OPUS));
	const downloadSeconds = Math.round((Date.now() - downloadStarted) / 1000);

	console.log(`settings download of ${OPUS} (${downloadSeconds} s):`, JSON.stringify(view));
	page.check(
		`Settings downloaded and loaded ${OPUS} through the app's worker`,
		view.status === "ready" && !view.error
	);
	await page.screenshot("1-opus-downloaded");

	// Off: the app's worker goes, and its model with it.
	await page.click('#settings input[name="translationEnabled"]');
	await page.waitFor(`!document.querySelector("#settings .translate-options")`, {
		label: "translation off",
	});

	// ---- 2. Our own workers ------------------------------------------------
	const plain = catalog(null);
	const opus = await runWorker(
		page,
		"OPUS-MT en-it (ORT, wasm)",
		{
			catalogJson: JSON.stringify(plain),
			ref: plain.opus["en-it"],
			text: ENGLISH,
			from: "en",
			to: "it",
		},
		OPUS_TIMEOUT
	);

	page.check(
		"OPUS-MT en-it translated the line",
		opus.phase === "done" &&
			typeof opus.text === "string" &&
			opus.text.trim() !== "" &&
			opus.text !== ENGLISH
	);

	const mirrored = catalog(MIRROR);
	const llm = await runWorker(
		page,
		`Qwen3 1.7B on the CPU (wllama${MIRROR ? `, from ${MIRROR}` : ", from huggingface.co"})`,
		{
			catalogJson: JSON.stringify(mirrored),
			ref: mirrored.llm,
			text: ENGLISH,
			from: "en",
			to: "de",
		},
		LLM_TIMEOUT
	);

	page.check(
		"the CPU language model translated the line",
		llm.phase === "done" &&
			typeof llm.text === "string" &&
			llm.text.trim() !== "" &&
			llm.text !== ENGLISH
	);
	// The status snapshot reports threads for the seq2seq engine only
	// (worker.ts): ORT on threads says the worker script was served
	// cross-origin isolated, and wllama in the same script asks for
	// `cpuThreads` threads exactly there (cpuLlm.real.ts `threadsHere`).
	page.check(
		"ONNX Runtime ran on threads: the worker is cross-origin isolated",
		opus.status?.seq2seq?.threads === true
	);
	page.check("no console error", page.consoleErrors.length === 0);
	await page.screenshot("2-done");
	console.log("console errors:", JSON.stringify(page.consoleErrors));
}
