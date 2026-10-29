import {expect} from "chai";
import {readFileSync} from "fs";

// shells/electron/main.js serves public/ with its own Content-Security-Policy
// and MIME table on every response; nothing in the suite runs Electron, so
// the two are read off the source.
describe("Electron shell (shells/electron/main.js)", function () {
	const source = readFileSync("shells/electron/main.js", "utf8");

	function directive(name: string): string[] {
		const csp = /const CSP = \[([\s\S]*?)\]\.join/.exec(source)?.[1] ?? "";
		const line = /"([^"]*)"/g;
		let match: RegExpExecArray | null;

		while ((match = line.exec(csp)) !== null) {
			const [head, ...sources] = match[1].split(" ");

			if (head === name) {
				return sources;
			}
		}

		return [];
	}

	it("lets the translation worker compile WebAssembly and nothing more", function () {
		// Every translation engine compiles WebAssembly in js/translate-worker.js
		// (ONNX Runtime, WebLLM's model library and tokenizer); without this
		// Chromium refuses the compile and no model ever loads in the app.
		const scripts = directive("script-src");
		expect(scripts).to.include("'self'");
		expect(scripts).to.include("'wasm-unsafe-eval'");
		// The page has no inline script for a nonce or a hash to admit
		// (test/tests/build.ts pins that), and nothing needs eval.
		expect(scripts).to.not.include("'unsafe-inline'");
		expect(scripts).to.not.include("'unsafe-eval'");
	});

	it("lets the translation worker and the CPU language model's blob: workers start", function () {
		// js/translate-worker.js and ONNX Runtime's thread workers are 'self';
		// wllama (engines/cpuLlm.real.ts) starts its proxy worker from a
		// blob: URL, even single-threaded, and its pthreads from that worker.
		const workers = directive("worker-src");
		expect(workers).to.include("'self'");
		expect(workers).to.include("blob:");
	});

	it("serves .wasm as application/wasm", function () {
		// Under nosniff an octet-stream wasm cannot compile streaming.
		expect(source).to.match(/"\.wasm": "application\/wasm"/);
		expect(source).to.match(/X-Content-Type-Options", "nosniff"/);
	});
});
