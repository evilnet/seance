// The 1.7B's small-buffer build (docs/resources/translation.md § Phones and
// small GPUs), on the real device probe over a stand-in for WebGPU (headless
// has no GPU: an init script defines the page's `navigator.gpu`, as
// translate-capability.mjs does) and on the app served under a subpath, as
// Pages serves it. Three devices, each a cold load of Settings → Translation:
//
//   phone     shader-f16 and WebGPU's 128 MiB binding (an Adreno 7xx)
//   switched  a 2 GiB desktop GPU with the test switch at 128 MiB
//             (localStorage thelounge.state.gpuTestLimitMiB)
//   desktop   the same GPU, no switch
//
// On the first two the 1.7B's GPU copy line can download, with the line naming the
// small-buffer build and its 74.2 MiB largest buffer, the device line says
// 128 MiB (and, switched, that a test setting holds it there), the 4B says
// it cannot with its own numbers, and Download is enabled. Download on the
// phone must fetch the pinned revision's manifest and seed the rewritten one
// (part0/part1, the split mark) under WebLLM's key in "webllm/model", read the
// model's config from the pinned revision, and fetch the library from the
// app's own subpath URL (the server's log, and WebLLM's "webllm/wasm" key) —
// and no weight shard: the worker has no WebGPU here, so WebLLM stops at its
// device check, after the library and before the weights. On the desktop
// nothing of the build is fetched or seeded and the copy line carries no build line;
// its Download reads the model's own resolve/main/ config instead.
//
// No ircd and no model run. Serve public/ under a subpath with a request log
// (127.0.0.1, not localhost: WebLLM never caches a library whose URL says
// "localhost"):
//
//   NODE_ENV=production corepack yarn build
//   mkdir -p $SITE/seance && ln -s $PWD/public $SITE/seance/develop
//   python3 -m http.server -d $SITE -b 127.0.0.1 8063 2> $SITE/requests.log &
//   SEANCE_HTTP=http://127.0.0.1:8063/seance/develop/ SEANCE_SERVER_LOG=$SITE/requests.log \
//     CHROME_BIN=/seance/tmp/chrome-pw.sh node tools/browser-drive.mjs \
//     tools/scenarios/translate-small-gpu.mjs --no-ws
//   … --mobile --width=390 --height=844
//
// Needs the network: the manifest and the config come from huggingface.co.

import {readFileSync} from "node:fs";

const BASE = process.env.SEANCE_HTTP || "http://127.0.0.1:8063/seance/develop/";
const LOG = process.env.SEANCE_SERVER_LOG || null;
const EN = JSON.parse(readFileSync("client/locales/en.json", "utf8"));

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const SMALL = "Qwen3-1.7B-q4f16_1-MLC";
const SPLIT = "Qwen3-1.7B-q4f16_1-MLC-split";
const LARGE = "Qwen3-4B-q4f16_1-MLC";
const PINNED =
	"https://huggingface.co/mlc-ai/Qwen3-1.7B-q4f16_1-MLC/resolve/80b3abcec6c3b3f5355dc0cc99cc4fb578f192bc/";
const MAIN = `https://huggingface.co/mlc-ai/${SMALL}/resolve/main/`;
const LIB = "models/qwen3-1.7b-q4f16_1-split-c4939e7d.wasm";
const SPLIT_BYTES = 77_791_232;
const LARGE_BYTES = 194_478_080;
const TEST_KEY = "thelounge.state.gpuTestLimitMiB";

const DEVICES = {
	phone: {gpu: {f16: true, max: 128 * MiB}, cap: null, split: true},
	switched: {gpu: {f16: true, max: 2 * GiB}, cap: "128", split: true},
	desktop: {gpu: {f16: true, max: 2 * GiB}, cap: null, split: false},
};

/** friendlysize.ts under the English locale. */
function size(bytes) {
	const units = ["Bytes", "KiB", "MiB", "GiB", "TiB"];
	const i = bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(1024)) : 0;
	const n = new Intl.NumberFormat("en", {maximumFractionDigits: 1, useGrouping: false});

	return `${n.format(bytes / Math.pow(1024, i))} ${units[i]}`;
}

const fill = (template, vars) =>
	Object.entries(vars).reduce((text, [k, v]) => text.replace(`{${k}}`, v), template);

// The page's GPU, read from storage at every document start (the probe runs
// once per page, so each device is a cold load). The worker keeps the real
// one: none, under --disable-gpu.
const GPU_STUB = `(() => {
	let device = null;
	try { device = JSON.parse(localStorage.getItem("seance.test.gpu") || "null"); } catch (e) {}
	if (!device) { return; }
	const gpu = {
		requestAdapter: async () => ({
			features: new Set(device.gpu.f16 ? ["shader-f16"] : []),
			limits: {
				maxBufferSize: device.gpu.max,
				maxStorageBufferBindingSize: device.gpu.max,
				maxStorageBuffersPerShaderStage: 10,
				maxComputeWorkgroupStorageSize: 32768,
			},
		}),
	};
	Object.defineProperty(Navigator.prototype, "gpu", {configurable: true, get: () => gpu});
})();`;

const ROW = (id) =>
	`.translate-model[data-model=${JSON.stringify(id)}] .translate-copy[data-device="gpu"]`;
const textOf = (selector) =>
	`((document.querySelector(${JSON.stringify(selector)}) || {}).textContent || "").trim()`;

/** Every key of every "webllm/*" cache, by scope. */
const CACHE_KEYS = `(async () => {
	const out = {};
	for (const name of await caches.keys()) {
		if (!name.startsWith("webllm/")) continue;
		const cache = await caches.open(name);
		out[name] = (await cache.keys()).map((r) => r.url);
	}
	return out;
})()`;

const CLEAR_CACHES = `(async () => {
	for (const name of await caches.keys()) {
		if (name.startsWith("webllm/")) await caches.delete(name);
	}
	return true;
})()`;

/** The seeded manifest under the build's key: its embedding records and its mark. */
const SEEDED = `(async () => {
	const cache = await caches.open("webllm/model");
	const hit = await cache.match(${JSON.stringify(PINNED + "tensor-cache.json")});
	if (!hit) return null;
	const body = await hit.json();
	const records = body.records.flatMap((s) => s.records.map((r) => ({...r, shard: s.dataPath})));
	return {
		mark: (body.metadata || {}).SeanceEmbeddingSplit,
		embed: records.filter((r) => r.name.startsWith("model.embed_tokens.")).map((r) => [r.name, r.shape, r.shard, r.byteOffset, r.nbytes]),
		largest: Math.max(...records.map((r) => r.nbytes)),
		count: records.length,
	};
})()`;

/** The viewport, with `selector` scrolled to its middle (a list taller than the screen shoots blank). */
async function shoot(page, name, selector) {
	await page.evaluate(
		`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block: "center"})`
	);
	await page.sleep(300);
	await page.screenshot(name);
}

function requestLog() {
	if (!LOG) {
		return null;
	}

	try {
		return readFileSync(LOG, "utf8");
	} catch {
		return null;
	}
}

export default async function run(page) {
	await page.addInitScript(GPU_STUB);
	await page.goto(BASE, {waitForSelector: "#app"});

	const coldLoad = async (name) => {
		const device = DEVICES[name];

		await page.evaluate(
			`(() => {
				localStorage.clear();
				localStorage.setItem("thelounge.state.installGuide", "dismissed");
				localStorage.setItem("seance.test.gpu", ${JSON.stringify(JSON.stringify(device))});
				${
					device.cap
						? `localStorage.setItem(${JSON.stringify(TEST_KEY)}, ${JSON.stringify(
								device.cap
						  )});`
						: ""
				}
			})()`
		);
		await page.evaluate(CLEAR_CACHES);
		await page.evaluate(
			`(() => { window.__coldLoad = true; history.replaceState(null, "", location.pathname + "#/settings/translation"); })()`
		);
		await page.send("Page.reload");
		await page.waitFor(
			`!window.__coldLoad && document.querySelectorAll(".translate-copy").length >= 3`,
			{
				label: `${name}: copy lines`,
				timeout: 30000,
			}
		);
		await page.waitFor(`!!document.querySelector(".translate-device")`, {
			label: `${name}: probe answered`,
		});
	};

	const rows = async (name) => {
		const device = DEVICES[name];
		const small = ROW(SMALL);
		const large = ROW(LARGE);
		const limit = device.cap ? 128 * MiB : device.gpu.max;

		page.check(
			`${name}: device line says ${size(limit)}`,
			(await page.evaluate(textOf(".translate-device-limit"))) ===
				fill(EN["translate.capability.bufferLimit"], {size: size(limit)})
		);

		const testLine = await page.evaluate(textOf(".translate-device-test-limit"));

		page.check(
			`${name}: the test switch's line ${device.cap ? "is shown" : "is absent"}`,
			device.cap
				? testLine ===
						fill(EN["translate.capability.testLimit"], {
							size: size(128 * MiB),
							key: TEST_KEY,
						})
				: testLine === ""
		);
		page.check(
			`${name}: the 1.7B runs here: its GPU Download is enabled`,
			(await page.evaluate(
				`!!document.querySelector(${JSON.stringify(
					small + " .translate-copy-download:not([disabled])"
				)})`
			)) === true
		);

		const buildLine = await page.evaluate(textOf(`${small} .translate-model-small-build`));
		const buildId = await page.evaluate(
			`(document.querySelector(${JSON.stringify(
				small + " .translate-model-small-build"
			)}) || {dataset: {}}).dataset.build || ""`
		);

		if (device.split) {
			page.check(
				`${name}: the 1.7B row names the small-buffer build and its ${size(SPLIT_BYTES)}`,
				buildLine ===
					fill(EN["translate.model.smallBufferBuild"], {size: size(SPLIT_BYTES)}) &&
					buildId === SPLIT
			);
			page.check(
				`${name}: the 4B cannot, with its own numbers`,
				(await page.evaluate(
					`!!document.querySelector(${JSON.stringify(
						large + " .translate-copy-download[disabled]"
					)})`
				)) &&
					(await page.evaluate(textOf(`${large} .translate-copy-why`))) ===
						fill(EN["translate.model.needsBuffer"], {
							needed: size(LARGE_BYTES),
							limit: size(128 * MiB),
						})
			);
		} else {
			page.check(`${name}: no build line on the 1.7B row`, buildLine === "");
			page.check(
				`${name}: the 4B runs too`,
				(await page.evaluate(
					`!!document.querySelector(${JSON.stringify(
						large + " .translate-copy-download:not([disabled])"
					)})`
				)) === true
			);
		}

		// The copy's size is the model's download either way.
		page.check(
			`${name}: the 1.7B's size is the model's own download`,
			(await page.evaluate(textOf(`${small} .translate-copy-state`))) ===
				fill(EN["translate.model.copyNotDownloaded"], {size: size(984_000_000)})
		);
	};

	/** Download the 1.7B, and wait for the load to stop (no WebGPU in the worker). */
	const download = async (name) => {
		await page.click(`${ROW(SMALL)} .translate-copy-download`);
		await page.waitFor(
			`["failed", "ready"].includes(document.querySelector(${JSON.stringify(
				ROW(SMALL)
			)}).dataset.status)`,
			{label: `${name}: the load stopped`, timeout: 120000}
		);

		return page.evaluate(textOf(`${ROW(SMALL)} .translate-copy-state`));
	};

	// ------------------------------------------------------------- phone
	await coldLoad("phone");
	await rows("phone");
	await shoot(page, "phone-settings", ROW(SMALL));

	const logBefore = requestLog()?.length ?? 0;
	const phoneState = await download("phone");

	console.log(`  phone: the row after the load: ${phoneState}`);

	const seeded = await page.evaluate(SEEDED);

	page.check("phone: the rewritten manifest is seeded under the pinned key", seeded !== null);

	if (seeded) {
		page.check("phone: it carries the split mark", seeded.mark === "v1:151936@75968");
		page.check(
			"phone: its embedding records are the four halves, byte ranges of the published shards",
			JSON.stringify(seeded.embed) ===
				JSON.stringify([
					[
						"model.embed_tokens.part0.q_weight",
						[75968, 256],
						"params_shard_0.bin",
						0,
						SPLIT_BYTES,
					],
					[
						"model.embed_tokens.part1.q_weight",
						[75968, 256],
						"params_shard_0.bin",
						SPLIT_BYTES,
						SPLIT_BYTES,
					],
					[
						"model.embed_tokens.part0.q_scale",
						[75968, 64],
						"params_shard_1.bin",
						0,
						9_723_904,
					],
					[
						"model.embed_tokens.part1.q_scale",
						[75968, 64],
						"params_shard_1.bin",
						9_723_904,
						9_723_904,
					],
				])
		);
		page.check(`phone: its largest record is ${SPLIT_BYTES}`, seeded.largest === SPLIT_BYTES);
		console.log(`  phone: seeded ${seeded.count} records, largest ${seeded.largest}`);
	}

	const phoneKeys = await page.evaluate(CACHE_KEYS);
	const all = Object.values(phoneKeys).flat();
	const libUrl = new URL(LIB, BASE).href;

	console.log(`  phone: cache keys ${JSON.stringify(phoneKeys)}`);
	page.check(
		"phone: the model's config came from the pinned revision",
		(phoneKeys["webllm/config"] ?? []).includes(PINNED + "mlc-chat-config.json")
	);
	page.check(
		`phone: WebLLM keeps the library under the app's own subpath URL (${libUrl})`,
		(phoneKeys["webllm/wasm"] ?? []).includes(libUrl)
	);
	page.check(
		"phone: nothing of resolve/main/ was fetched",
		!all.some((url) => url.startsWith(MAIN))
	);
	page.check(
		"phone: no weight shard was fetched (WebLLM stopped at its device check)",
		!all.some((url) => /params_shard_/.test(url))
	);

	const log = requestLog();

	if (log !== null) {
		const fresh = log.slice(logBefore);
		const path = new URL(LIB, BASE).pathname;

		page.check(
			`phone: the server served the library at ${path}`,
			fresh.includes(`"GET ${path} HTTP/1.1" 200`)
		);
		page.check(
			"phone: nothing asked for the library at the origin's root",
			!fresh.includes(`"GET /${LIB} `)
		);
	} else {
		console.log("  (no SEANCE_SERVER_LOG: the server-side check is skipped)");
	}

	await shoot(page, "phone-after-download", ROW(SMALL));

	// ---------------------------------------------------------- switched
	await coldLoad("switched");
	await rows("switched");
	await shoot(page, "switched-settings", ".translate-device");

	// ----------------------------------------------------------- desktop
	await coldLoad("desktop");
	await rows("desktop");

	const desktopState = await download("desktop");

	console.log(`  desktop: the row after the load: ${desktopState}`);

	const desktopKeys = await page.evaluate(CACHE_KEYS);
	const desktopAll = Object.values(desktopKeys).flat();

	console.log(`  desktop: cache keys ${JSON.stringify(desktopKeys)}`);
	page.check(
		"desktop: the model's own config, from resolve/main/",
		(desktopKeys["webllm/config"] ?? []).includes(MAIN + "mlc-chat-config.json")
	);
	page.check(
		"desktop: nothing of the small-buffer build was fetched or seeded",
		!desktopAll.some((url) => url.startsWith(PINNED) || url.includes("/models/qwen3-1.7b"))
	);
	page.check(
		"desktop: no weight shard was fetched",
		!desktopAll.some((url) => /params_shard_/.test(url))
	);

	await page.evaluate(CLEAR_CACHES);
	page.check("no console errors", page.consoleErrors.length === 0);

	if (page.consoleErrors.length) {
		console.log(JSON.stringify(page.consoleErrors.slice(0, 5), null, 1));
	}
}
