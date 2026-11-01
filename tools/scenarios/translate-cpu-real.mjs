// The CPU tier against the *real* engine: transformers.js, ONNX Runtime and
// weights fetched from Hugging Face — not the in-page fake. It is the only
// check that the seq2seq models actually create an ORT session (the q8 QDQ
// weights need `graphOptimizationLevel: "basic"`; see seq2seq.real.ts), so
// run it after anything that touches the worker, the engines or the router.
//
// Steps: the GPU tier is switched off in settings before the page boots, so
// every route falls to a CPU model; Settings → Translation downloads
// Xenova/opus-mt-en-de and its CPU copy must read "Downloaded · <size>"; then the page
// connects to the dev ircd and translates an English sentence into German
// through the dev console hook (`window.seanceTranslate`), which must come
// back non-empty and different from the input. With SEANCE_REAL_MODELS=all
// it also translates into Polish, which routes to NLLB — a ~600 MB download
// on a cold profile, so it is opt-in.
//
// **Opt-in**: it needs the network and downloads weights, so it is not part
// of the fake-engine suite and skips unless SEANCE_REAL_MODELS is set.
//
//   corepack yarn build                     # NODE_ENV unset (see below)
//   python3 -c 'import http.server as h, mimetypes as m, functools; m.add_type("text/javascript", ".mjs"); m.add_type("application/wasm", ".wasm"); h.test(functools.partial(h.SimpleHTTPRequestHandler, directory="public"), h.ThreadingHTTPServer, port=8021)' &
//   SEANCE_REAL_MODELS=1 CHROME_BIN=/seance/tmp/chrome-pw.sh \
//     node tools/browser-drive.mjs tools/scenarios/translate-cpu-real.mjs
//   SEANCE_REAL_MODELS=all … tools/scenarios/translate-cpu-real.mjs   # + NLLB
//
// **The static server must know .mjs.** The worker loads ONNX Runtime with a
// dynamic import() of js/ort/ort-wasm-simd-threaded.mjs, and a browser
// refuses a module served as application/octet-stream — which is what
// `python3 -m http.server` does where the system MIME table has no .mjs
// entry. The tab then reports "no available backend found" and every model
// fails to load. Serve .mjs as text/javascript and .wasm as
// application/wasm (the one-liner above does both).
//
// NODE_ENV must be unset for the build: `window.seanceTranslate` is behind
// BUILD === "dev" and a production build drops it. Note there is no
// ?fakeTranslate here — the point is the real engine.
//
// Needs the dev ircd's plain-WS port on 127.0.0.1:8067. browser-drive uses a
// throwaway profile, so the weights are fetched fresh on every run (OPUS
// en-de is ~5 s on a good link; NLLB is the reason "all" is separate).

const RUN = Date.now().toString(36);
const BASE = process.env.SEANCE_BASE || "http://localhost:8021/";
const OPUS = "Xenova/opus-mt-en-de";
const NLLB = "Xenova/nllb-200-distilled-600M";
const ENGLISH = "please keep the timestamps in the log too, I need the ordering";

const DOWNLOAD_TIMEOUT = 900000;
const TRANSLATE_TIMEOUT = 900000;
/** How long to wait for the model host after the connect burst (see below). */
const NETWORK_TIMEOUT = 120000;

const ROW = (id) => `.translate-model[data-model="${id}"]`;
const STATE = (id) =>
	`document.querySelector('${ROW(
		id
	)} .translate-copy[data-device="cpu"] .translate-copy-state')?.textContent.trim()`;
const STORE = `document.getElementById("app").__vue_app__.config.globalProperties.$store.state`;
// The CPU copy's view: the store lists one view per copy.
const VIEW = (id) =>
	`(() => { const m = ${STORE}.translation.models.find((v) => v.ref.id === ${JSON.stringify(
		id
	)} && v.device === "cpu"); return m ? {status: m.status, cached: m.cached, fraction: m.fraction, error: m.error} : null; })()`;
// Everything the ledger wants to see when a model will not load: the probe's
// verdict, the worker's own error, and every row's status and error text.
const SLICE = `(() => { const s = ${STORE}; return {capability: s.translation.capability, workerError: s.translation.workerError, paused: s.translation.paused, settings: {llm: s.settings.translateLlm, cpu: s.settings.translateCpu, to: s.settings.translateTo}, models: s.translation.models.map((m) => ({id: m.ref.id, device: m.device, status: m.status, cached: m.cached, error: m.error}))}; })()`;

export const url = BASE;

/**
 * Waits until the page itself can fetch from the model host. `page.waitFor`
 * cannot do this: it wraps its expression in `!!(…)`, and `!!aPromise` is
 * true before the request has even left, so the poll is written out here.
 */
async function networkReady(page) {
	const started = Date.now();

	for (;;) {
		const ok = await page.evaluate(
			`fetch(${JSON.stringify(
				`https://huggingface.co/${OPUS}/resolve/main/config.json`
			)}, {cache: "no-store"}).then((r) => r.ok, () => false)`
		);

		if (ok) {
			console.log(
				`the model host is reachable (${Math.round((Date.now() - started) / 1000)} s)`
			);

			return;
		}

		if (Date.now() - started > NETWORK_TIMEOUT) {
			throw new Error(
				`huggingface.co unreachable from the page after ${NETWORK_TIMEOUT / 1000} s`
			);
		}

		await page.sleep(2000);
	}
}

/** Runs the dev console hook and returns {result, error, seconds, chunks}. */
async function translate(page, text, to, from, {timeout, label}) {
	const started = Date.now();

	await page.evaluate(
		`(() => { window.__cpu = {log: []}; window.seanceTranslate(${JSON.stringify(
			text
		)}, ${JSON.stringify(to)}, ${JSON.stringify(
			from
		)}, (t, done) => window.__cpu.log.push([done, t])).then((t) => { window.__cpu.result = t; }, (e) => { window.__cpu.error = String((e && (e.stack || e.message)) || e); }); return "started"; })()`
	);
	await page.waitFor(`window.__cpu.result !== undefined || window.__cpu.error !== undefined`, {
		timeout,
		label,
	});

	const out = await page.evaluate(
		`({result: window.__cpu.result, error: window.__cpu.error, chunks: window.__cpu.log.length})`
	);

	return {...out, seconds: Math.round((Date.now() - started) / 1000)};
}

export default async function run(page) {
	const level = process.env.SEANCE_REAL_MODELS ?? "";

	if (level !== "1" && level !== "all") {
		console.log(
			"SKIPPED: translate-cpu-real needs the real engines (network + weight downloads).\n" +
				"         Run it with SEANCE_REAL_MODELS=1 (OPUS en→de) or =all (also NLLB en→pl)."
		);

		return;
	}

	// The GPU tier off before the first boot: headless Chromium has no WebGPU
	// here anyway, but a device that has one must still take the CPU path.
	// addInitScript applies to every later navigation, so both loads get it.
	await page.addInitScript(
		`try { localStorage.setItem("settings", JSON.stringify({translateLlm: false, translateTo: "en"})); } catch (e) {}`
	);

	// ---- Settings → Translation: download a real OPUS model ---------------
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click(`#footer button.settings`);
	await page.waitFor(`!!document.querySelector(".settings-menu button.translation")`, {
		label: "settings open",
	});
	await page.click(`.settings-menu button.translation`);
	await page.waitFor(`document.querySelectorAll(".translate-copy").length >= 3`, {
		label: "copy lines rendered",
	});
	await page.waitFor(
		`!!document.querySelector('${ROW(
			OPUS
		)} .translate-copy[data-device="cpu"] .translate-copy-download')`,
		{label: "the OPUS pair's CPU Download"}
	);

	const downloadStarted = Date.now();

	await page.click(`${ROW(OPUS)} .translate-copy[data-device="cpu"] .translate-copy-download`);
	// "ready" or "failed" — a failed load keeps its reason on the view, which
	// is what the run prints when this check goes red.
	await page.waitFor(
		`(() => { const v = ${VIEW(
			OPUS
		)}; return !!v && (v.status === "ready" || v.status === "failed"); })()`,
		{timeout: DOWNLOAD_TIMEOUT, label: "the OPUS download settled"}
	);

	const downloadSeconds = Math.round((Date.now() - downloadStarted) / 1000);
	const view = await page.evaluate(VIEW(OPUS));

	console.log(`OPUS download (${downloadSeconds} s):`, JSON.stringify(view));
	await page.screenshot("cpu-real-downloaded");
	page.check(
		`${OPUS} downloaded and loaded`,
		(await page.evaluate(STATE(OPUS)))?.startsWith("Downloaded ·") && view.error === null
	);

	if (view.status !== "ready") {
		console.log("store:", JSON.stringify(await page.evaluate(SLICE)));
	}

	// ---- The dev ircd, then a real translation ----------------------------
	await page.goto(
		`${BASE}?host=127.0.0.1&port=8067&tls=false&nick=cpu${RUN}&join=%23seance-translate`,
		{
			waitForSelector: "#connect form",
		}
	);
	// The link-approval form: a URL never connects on its own.
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector("#form #input")`, {
		timeout: 30000,
		label: "the channel view",
	});
	await page.waitFor(`typeof window.seanceTranslate === "function"`, {
		timeout: 10000,
		label: "the dev console hook (a dev build only)",
	});
	// The seconds right after the socket opens are not a fair moment to ask
	// for a model. Measured here: a plain `fetch` of huggingface.co from the
	// page answers 200 before Connect, throws "Failed to fetch" straight
	// after it, and answers 200 again ten seconds later, while same-origin
	// requests and other hosts keep working throughout. A downloaded model
	// is not offline-proof either -- transformers.js still probes for the
	// optional files it did not cache, and that fetch has to complete -- so
	// a load that lands in the window fails and `service.ts` marks the
	// candidate down for the whole session, which no retry here can undo
	// (only Settings' download clears it). So wait until the page can
	// actually reach the model host again, and only then ask: a run that
	// goes red then is the engine's doing, not the moment's.
	await networkReady(page);

	const de = await translate(page, ENGLISH, "de", "en", {
		timeout: TRANSLATE_TIMEOUT,
		label: "the English → German translation",
	});

	console.log(
		`en→de (${de.seconds} s, ${de.chunks} chunks):`,
		JSON.stringify(de.result ?? de.error)
	);

	if (de.error) {
		console.log("store:", JSON.stringify(await page.evaluate(SLICE)));
	}

	page.check(
		"en→de came back from a CPU model",
		typeof de.result === "string" && de.result.trim().length > 0 && de.result !== ENGLISH
	);
	page.check("en→de threw nothing", de.error === undefined);
	page.check(
		"the route stayed on the CPU tier",
		(await page.evaluate(`${STORE}.translation.capability?.tier`)) === "cpu"
	);
	await page.screenshot("cpu-real-translated");

	// ---- NLLB, opt-in: a ~600 MB download on a throwaway profile ----------
	if (level === "all") {
		const pl = await translate(page, ENGLISH, "pl", "en", {
			timeout: TRANSLATE_TIMEOUT,
			label: "the English → Polish translation (NLLB may download first)",
		});

		console.log(
			`en→pl (${pl.seconds} s, ${pl.chunks} chunks):`,
			JSON.stringify(pl.result ?? pl.error)
		);
		console.log("NLLB view:", JSON.stringify(await page.evaluate(VIEW(NLLB))));

		if (pl.error) {
			console.log("store:", JSON.stringify(await page.evaluate(SLICE)));
		}

		page.check(
			"en→pl came back from NLLB",
			typeof pl.result === "string" && pl.result.trim().length > 0 && pl.result !== ENGLISH
		);
	}

	console.log("models:", JSON.stringify((await page.evaluate(SLICE)).models));
	page.check("no console errors", page.consoleErrors.length === 0);
}
