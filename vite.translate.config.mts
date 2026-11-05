// The translation worker, js/translate-worker.js (client/js/translate/
// worker-entry.ts), built by vite.config.mts once the app is written: a
// build of its own, as the push module's is, so the app's chunks never pull
// WebLLM and transformers.js in and the worker shares no chunk with the app.
// A classic script (IIFE): the page starts it with
// `new Worker("js/translate-worker.js?v=<build>")` (translate/index.ts).
// The ONNX Runtime wasm files transformers.js loads at run time are copied
// next to it into js/ort/ so a deploy needs no CDN; seq2seq.real.ts points
// the library there. Background: docs/resources/translation.md § The worker.
import * as path from "path";
import {existsSync, globSync, readFileSync, realpathSync} from "fs";
import {createRequire} from "module";
import {defineConfig, type Plugin} from "vite";
import {chunkNotices, defines} from "./scripts/build-info.mts";

const root = import.meta.dirname;

/**
 * A package's directory, looked up from `from` as Node would (real paths,
 * so a package pnpm links in from its store finds its own dependencies).
 * pnpm links only direct dependencies into node_modules/: onnxruntime-web
 * is transformers.js's, so it is found from there, the version the worker
 * actually bundles.
 */
function packageDir(name: string, from = root): string {
	for (const dir of createRequire(path.join(from, "package.json")).resolve.paths(name) ?? []) {
		if (existsSync(path.join(dir, name, "package.json"))) {
			return realpathSync(path.join(dir, name));
		}
	}

	throw new Error(`translation worker: no package directory for ${name} from ${from}`);
}

const transformersDir = packageDir("@huggingface/transformers");
const ortDir = packageDir("onnxruntime-web", transformersDir);
const wllamaDir = packageDir("@wllama/wllama");

// transformers.js and onnxruntime-web use `import.meta` for module identity
// and to resolve their wasm files. An IIFE has no `import.meta` (the bundler
// would leave an empty object, and `new URL(…, undefined)` throws on load),
// and neither use is wanted: seq2seq.real.ts sets ORT's wasmPaths to js/ort/
// before any model loads, and module identity means nothing once bundled.
// Replaced before Vite's own `new URL(…, import.meta.url)` asset detection
// sees them, so it does not emit the wasm/mjs files those expressions name
// as hashed assets at the root of public/ either.
const STUB_URL = '"file:///transformers.web.js"';

function importMetaStub(): Plugin {
	return {
		name: "seance:translate-import-meta",
		enforce: "pre",
		transform: {
			filter: {
				id: /[\\/]node_modules[\\/].*(@huggingface[\\/]transformers|onnxruntime-web)[\\/].*\.m?js$/,
			},
			handler(code) {
				return {
					code: code
						.replace(/import\.meta\.url/g, STUB_URL)
						.replace(/import\.meta(?=[\s.,)\];]|$)/g, `({url: ${STUB_URL}})`),
					map: null,
				};
			},
		},
	};
}

/** `from` is a glob under `cwd` (the repository root unless named). */
type Asset = {from: string; cwd?: string; to: (file: string) => string};

const assets: Asset[] = [
	// Only the pair the aliased wasm-only ORT bundle references (grepped from
	// node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs).
	{
		from: "dist/ort-wasm-simd-threaded.{mjs,wasm}",
		cwd: ortDir,
		to: (f) => `js/ort/${path.basename(f)}`,
	},
	// The CPU language model's library (engines/cpuLlm.real.ts): wllama's
	// wasm, next to the worker, which resolves it against its own location.
	// Since 3.x it is one build for one thread and for many (the library
	// starts pthreads from a blob worker when the worker is cross-origin
	// isolated and asked for more than one thread), so there is no
	// multi-thread file to copy.
	{
		from: "esm/wasm/wllama.wasm",
		cwd: wllamaDir,
		to: () => "js/wllama.wasm",
	},
	// The GPU models' libraries of our own (tools/translate-split/): the
	// 1.7B's small-buffer build, which WebLLM fetches from public/models/ by
	// an absolute URL the worker resolves against its own location (models.ts
	// QWEN3_1_7B_SPLIT_LIB). Under models/, so the service worker never
	// caches it (`excludedPathsFromCache`), nor precaches it (its shell list
	// is explicit); WebLLM keeps it in its own "webllm/wasm" cache.
	{from: "client/models/*.wasm", to: (f) => `models/${path.basename(f)}`},
];

function workerAssets(): Plugin {
	return {
		name: "seance:translate-assets",
		generateBundle() {
			for (const asset of assets) {
				const cwd = asset.cwd ?? root;
				const files = globSync(asset.from, {cwd});

				if (files.length === 0) {
					throw new Error(`translation worker: nothing matches ${asset.from} in ${cwd}`);
				}

				for (const file of files) {
					this.emitFile({
						type: "asset",
						fileName: asset.to(file),
						source: readFileSync(path.join(cwd, file)),
					});
				}
			}
		},
	};
}

export default defineConfig({
	root,
	base: "./",
	publicDir: false,
	define: defines,
	resolve: {
		// transformers.js imports the WebGPU ORT bundle unconditionally; alias
		// it to the smaller wasm-only bundle so the WebGPU backend (and the
		// jsep wasm/mjs pair only it references) never enters the worker. The
		// alias stays: this build has no WebGPU backend for OPUS-MT and
		// NLLB-200, so the shipped catalog gives them no GPU copy (models.ts
		// CatalogOptions `seq2seqGpu`). Shipping one means dropping this alias
		// and shipping the jsep wasm, which changes the CPU path too
		// (docs/projects/translation-devices.md § Not in this build).
		alias: {"onnxruntime-web/webgpu": "onnxruntime-web/wasm"},
	},
	plugins: [importMetaStub(), workerAssets()],
	build: {
		outDir: "public",
		emptyOutDir: false,
		sourcemap: true,
		copyPublicDir: false,
		// WebLLM and transformers.js are most of it; nothing to act on.
		chunkSizeWarningLimit: 8000,
		rolldownOptions: {
			input: path.resolve(root, "client/js/translate/worker-entry.ts"),
			output: {
				format: "iife",
				entryFileNames: "js/translate-worker.js",
				// Every file the worker needs is emitted by name (workerAssets
				// above). One the bundler emits by itself -- the ORT pair, were
				// importMetaStub ever to stop catching their `new URL(…,
				// import.meta.url)` -- lands in js/, where test/tests/build.ts
				// looks for strays, never in a public/assets/ nothing checks.
				assetFileNames: "js/[name]-[hash][extname]",
				postBanner: chunkNotices["js/translate-worker.js"],
			},
		},
	},
});
