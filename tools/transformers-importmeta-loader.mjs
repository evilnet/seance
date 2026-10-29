// Webpack loader for the ML dists (transformers.js, onnxruntime-web) in the
// translation worker bundle.
//
// Both dists use `import.meta` — for module identity and wasm-path
// resolution. Webpack rewrites those references into an import.meta shim
// whose `main` property is `__webpack_require__.c[__webpack_require__.s] ===
// __webpack_module__` — but in a production build the module parameter is
// marked unused (`__unused_webpack_module`) while the shim still names
// `__webpack_module__`, which is therefore unbound at runtime. The worker
// dies on load with "Uncaught ReferenceError: __webpack_module__ is not
// defined" before doing anything (webpack#17127 class).
//
// Neither use is wanted here: wasm paths are overridden by
// seq2seq.real.ts (wasmPaths → js/ort/), and module identity means nothing
// once bundled. This loader replaces the expressions with a stub, so
// webpack never generates the shim at all.
//
//   import.meta.url  → "file:///transformers.web.js"
//   import.meta      → ({ url: "file:///transformers.web.js" })

const STUB_URL = '"file:///transformers.web.js"';
const STUB_OBJECT = "({url: " + STUB_URL + "})";

export default function (source) {
	return source
		.replace(/import\.meta\.url/g, STUB_URL)
		.replace(/import\.meta(?=[\s.,)\];]|$)/g, STUB_OBJECT);
}
