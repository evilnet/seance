import {expect} from "chai";
import fs from "fs";
import path from "path";
import {THEME_PAIRS} from "../../client/js/helpers/themeAppearance";

describe("public folder", function () {
	const publicFolder = path.join(process.cwd(), "public");
	// The entry is content-hashed (vite.config.mts: lazy chunks import it by
	// name, so it cannot carry `?v=`).
	const entry = () =>
		fs.readdirSync(path.join(publicFolder, "js")).find((f) => /^bundle-[\w-]+\.js$/.test(f));
	// Whether minified code holds the string literal `text`: Oxc may write a
	// string with backticks rather than double quotes.
	const hasString = (code: string, text: string) =>
		code.includes(`"${text}"`) || code.includes(`\`${text}\``);
	// A lazy chunk by its name (vite.config.mts chunkFileNames: `<name>.<hash>.js`).
	const chunk = (name: string) =>
		fs
			.readdirSync(path.join(publicFolder, "js"))
			.find((f) => new RegExp(`^${name}\\.[\\w-]{8}\\.js$`).test(f));
	const read = (...parts: string[]) => fs.readFileSync(path.join(publicFolder, ...parts), "utf8");
	// The build token the service worker carries: `dev` for a development
	// build (scripts/build-info.mts buildToken), a hash for a production one.
	const productionBuild = () =>
		read("service-worker.js").match(/const cacheName\s*=\s*["`]([^"`]+)["`]/)?.[1] !== "dev";
	/** Every file under `dir` (relative to public/), recursively, as /-separated paths. */
	const walk = (dir = ""): string[] =>
		fs.readdirSync(path.join(publicFolder, dir), {withFileTypes: true}).flatMap((dirent) => {
			const rel = dir ? `${dir}/${dirent.name}` : dirent.name;

			return dirent.isDirectory() ? walk(rel) : [rel];
		});

	it("font awesome files are copied", function () {
		expect(fs.existsSync(path.join(publicFolder, "fonts", "fa-solid-900.woff"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "fonts", "fa-solid-900.woff2"))).to.be.true;
	});

	it("no TypeScript config is copied into the deploy", function () {
		// client/'s root files are copied (vite.config.mts staticFiles) except
		// the ones rootIgnore names: tsconfig.json and every tsconfig.*.json
		// beside it (tsconfig.worker.json) are the build's, not the site's.
		expect(walk().filter((file) => /(^|\/)tsconfig[^/]*\.json$/.test(file))).to.deep.equal([]);
	});

	it("a production build carries no in-page fake translation engine", function () {
		// fakePort.ts (and worker.ts, which only the fake and the real worker
		// import) is reached behind `?fakeTranslate` on a development build
		// only (translate/index.ts): a production build neither bundles it
		// into a page script nor emits a chunk for it. The string survives
		// minification; the module names in a page script's sourcemap are
		// what minification cannot hide.
		if (!productionBuild()) {
			this.skip();
		}

		const js = fs.readdirSync(path.join(publicFolder, "js"));

		for (const file of js.filter((f) => f.endsWith(".js"))) {
			expect(read("js", file).includes("__seanceTranslateFake"), file).to.be.false;
		}

		expect(js.filter((f) => /^fakePort\b/.test(f))).to.deep.equal([]);

		for (const map of js.filter(
			(f) => f.endsWith(".js.map") && f !== "translate-worker.js.map"
		)) {
			const sources = (JSON.parse(read("js", map)) as {sources: string[]}).sources;

			expect(
				sources.filter((src) => /translate\/(fakePort|worker)\.ts$/.test(src)),
				map
			).to.deep.equal([]);
		}
	});

	it("files in root folder are copied", function () {
		expect(fs.existsSync(path.join(publicFolder, "favicon.ico"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "robots.txt"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "service-worker.js"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "manifest.webmanifest"))).to.be.true;
	});

	it("branding config.json is copied and parses", function () {
		const file = path.join(publicFolder, "config.json");
		expect(fs.existsSync(file)).to.be.true;

		const config = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(config).to.be.an("object");
		expect(config.appName).to.be.a("string").that.is.not.empty;
	});

	it("index HTML and manifest carry the build-time branding", function () {
		const config = JSON.parse(fs.readFileSync(path.join(publicFolder, "config.json"), "utf8"));
		const html = fs.readFileSync(path.join(publicFolder, "index.html"), "utf8");
		const manifest = JSON.parse(
			fs.readFileSync(path.join(publicFolder, "manifest.webmanifest"), "utf8")
		);

		expect(html.includes("__APP_NAME__")).to.be.false;
		expect(html.includes("__THEME_COLOR__")).to.be.false;
		// No inline script: a Content-Security-Policy refuses those (the
		// Tauri shell's does, shells/tauri/src-tauri/tauri.conf.json), so
		// everything that runs before the bundle is a file — the pre-paint
		// language script is js/prepaint.js.
		expect(/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), "an inline <script>").to.be.false;
		expect(html).to.match(/<script src="js\/prepaint\.js\?v=[^"]+"><\/script>/);
		// Substituted at build from client/locales/tags.json for the pre-paint
		// script; a leftover token would break the language resolution.
		const prepaint = fs.readFileSync(path.join(publicFolder, "js", "prepaint.js"), "utf8");
		expect(prepaint.includes("__AVAILABLE_LOCALES__")).to.be.false;
		// The minifier may write the strings with backticks.
		expect(prepaint).to.match(/["`]en(,[a-zA-Z-]+)*["`]\.split\(["`],["`]\)/);
		expect(html.includes(`<title>${config.appName}</title>`)).to.be.true;
		expect(html.includes("The Lounge")).to.be.false;
		expect(manifest.name).to.equal(config.appName);
		expect(manifest.short_name).to.be.a("string").that.is.not.empty;
	});

	it("index HTML carries the no-referrer meta tag", function () {
		const html = fs.readFileSync(path.join(publicFolder, "index.html"), "utf8");

		expect(html).to.include('<meta name="referrer" content="no-referrer"');
	});

	it("audio files are copied", function () {
		expect(fs.existsSync(path.join(publicFolder, "audio", "pop.wav"))).to.be.true;
	});

	it("index HTML file is copied with cache bust applied", function (done) {
		expect(fs.existsSync(path.join(publicFolder, "index.html.tpl"))).to.be.false;

		fs.readFile(path.join(publicFolder, "index.html"), "utf8", function (err, contents) {
			expect(err).to.be.null;

			expect(contents.includes('<div id="app"></div>')).to.be.true;
			expect(contents.includes("__HASH__")).to.be.false;

			done();
		});
	});

	it("javascript files are built", function () {
		expect(entry(), "js/bundle-<hash>.js").to.be.a("string");
		expect(fs.existsSync(path.join(publicFolder, "js", "push.js"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "js", "translate-worker.js"))).to.be.true;
	});

	it("the language identifiers are their own chunk and carry their notices", function () {
		// detect.ts imports lid.real.ts on the first line it has to place; the
		// notice is scripts/build-info.mts chunkNotices, keyed by the chunk's
		// name (vite.config.mts chunkNames gives it its name). The model and
		// the wasm are files beside it, fetched from the app's origin.
		const lid = chunk("lid");

		expect(lid, "js/lid.<hash>.js").to.be.a("string");
		expect(read("js", lid!)).to.match(/^\/\*!\n \* eld 2\.1\.1 /);
		expect(read("js", lid!)).to.include(
			"lid.176.ftz language identification model | CC-BY-SA-3.0"
		);
		// ELD's n-gram table rides in the chunk, never the entry.
		expect(read("js", entry()!).includes("setLanguageSubset")).to.be.false;
		expect(fs.existsSync(path.join(publicFolder, "js", "lid", "lid.176.ftz"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "js", "lid", "fastText.common.wasm"))).to.be
			.true;
	});

	it("the locale catalogs are copied for the push worker, and the lazy ones are chunks", function () {
		// The push worker fetches <app>/locales/<tag>.json (client/js/push/
		// i18n.ts); the page imports each overlay as a chunk of its own
		// (client/js/i18n/index.ts). tags.json is the build's own input and
		// never ships; the qqx rig only in a development build.
		const tags = JSON.parse(
			fs.readFileSync(path.join(process.cwd(), "client", "locales", "tags.json"), "utf8")
		) as string[];
		const copied = fs.readdirSync(path.join(publicFolder, "locales"));
		const token = read("service-worker.js").match(
			/const cacheName\s*=\s*["`]([^"`]+)["`]/
		)?.[1];
		const production = token !== "dev";
		const shipped = tags.filter((tag) => !(production && tag === "qqx"));

		expect(copied.sort()).to.deep.equal(shipped.map((tag) => `${tag}.json`).sort());
		expect(copied).to.not.include("tags.json");

		for (const tag of shipped.filter((t) => t !== "en")) {
			expect(chunk(tag), `js/${tag}.<hash>.js`).to.be.a("string");
		}

		expect(chunk("tags")).to.equal(undefined);
		expect(chunk("en")).to.equal(undefined);

		if (production) {
			expect(chunk("qqx"), "no qqx chunk in a production build").to.equal(undefined);
		}
	});

	it("the translation worker is self-contained and the ORT wasm files are copied", function () {
		const worker = fs.readFileSync(
			path.join(publicFolder, "js", "translate-worker.js"),
			"utf8"
		);

		// A classic script with nothing of the app's in it: no import of the
		// entry, of Rolldown's runtime or of any other chunk.
		expect(worker).to.not.match(/\bimport\s*[{*\w][^;]*\bfrom\s*["`']/);
		expect(worker).to.not.include("rolldown-runtime");
		expect(worker).to.not.match(/bundle-[\w-]+\.js/);

		const ort = fs.readdirSync(path.join(publicFolder, "js", "ort"));

		expect(ort.some((name) => name.endsWith(".wasm"))).to.be.true;
		expect(ort.some((name) => name.endsWith(".mjs"))).to.be.true;

		// The worker bundles only the wasm ORT backend (device: "wasm"); the
		// WebGPU backend transformers.js otherwise imports unconditionally
		// is aliased away, and js/ort/ holds only the pair its bundle names.
		expect(ort.sort()).to.deep.equal([
			"ort-wasm-simd-threaded.mjs",
			"ort-wasm-simd-threaded.wasm",
		]);

		// Nothing the bundler's `new URL(…, import.meta.url)` asset detection
		// would otherwise emit (the ORT wasm binary and its loader, hashed)
		// leaks into the deploy tree, where nothing serves or cleans it up:
		// vite.translate.config.mts stubs those expressions out.
		const stray = (dir: string) =>
			fs
				.readdirSync(path.join(publicFolder, dir))
				.filter((name) => /\.(wasm|mjs)$/.test(name) && name !== "wllama.wasm");

		expect(stray(".")).to.deep.equal([]);
		expect(stray("js")).to.deep.equal([]);
		expect(worker).to.not.match(/import\.meta/);

		// And nowhere else: a wasm or an ES module outside the places that
		// hold them on purpose (js/ort/, js/lid/, js/wllama.wasm, models/) is one the
		// bundler emitted on its own -- under the worker build's
		// assetFileNames (js/), or Vite's default assets/ if that ever went.
		expect(fs.existsSync(path.join(publicFolder, "assets")), "public/assets/").to.be.false;
		expect(
			walk().filter(
				(file) =>
					/\.(wasm|mjs)$/.test(file) &&
					!file.startsWith("js/ort/") &&
					!file.startsWith("js/lid/") &&
					!file.startsWith("models/") &&
					file !== "js/wllama.wasm"
			)
		).to.deep.equal([]);
	});

	it("the translation worker carries its libraries' licence notices", function () {
		// Two `/*!` blocks, one per licence (scripts/build-info.mts
		// chunkNotices): transformers.js and WebLLM ship no notice of their
		// own and Apache-2.0 § 4 asks for one; wllama, llama.cpp/ggml (in
		// js/wllama.wasm, which can carry no comment) and ONNX Runtime Web,
		// whose own notice the minifier drops, are MIT.
		const head = read("js", "translate-worker.js").slice(0, 2000);

		expect(head).to.match(/^\/\*!\n \* @huggingface\/transformers 4\.2\.0 /);
		expect(head).to.include("@mlc-ai/web-llm 0.2.85");
		expect(head).to.include("Apache License, Version 2.0");
		expect(head).to.include("@wllama/wllama 3.8.1");
		expect(head).to.include("llama.cpp and ggml");
		expect(head).to.include("onnxruntime-web");
		expect(head).to.include("MIT License");
	});

	it("the 1.7B's small-buffer model library is copied under models/", function () {
		// tools/translate-split/'s build, which WebLLM fetches by URL
		// (models.ts QWEN3_1_7B_SPLIT_LIB); under models/, which the service
		// worker neither caches nor precaches.
		const ours = fs.readdirSync(path.join(process.cwd(), "client", "models"));

		expect(fs.readdirSync(path.join(publicFolder, "models")).sort()).to.deep.equal(
			ours.filter((name) => name.endsWith(".wasm")).sort()
		);
	});

	it("the CPU language model's library is in the worker once, and its wasm beside it", function () {
		const worker = fs.readFileSync(
			path.join(publicFolder, "js", "translate-worker.js"),
			"utf8"
		);
		// wllama's own worker, which it carries as one string literal.
		// A development build also carries the library's source once more,
		// unminified and indented, so only the string literal is counted
		// (a quote right before the code).
		const marker = "var Module=typeof Module";
		const literal = /['"`]var Module=typeof Module/g;

		expect(worker.match(literal)?.length).to.equal(1);
		expect(fs.existsSync(path.join(publicFolder, "js", "wllama.wasm"))).to.be.true;

		// Only the worker loads it: no chunk of the page carries it.
		for (const file of fs.readdirSync(path.join(publicFolder, "js"))) {
			if (file.endsWith(".js") && file !== "translate-worker.js") {
				expect(read("js", file).includes(marker), file).to.be.false;
			}
		}
	});

	it("lazy chunks carry a content hash in their names", function () {
		// A chunk imports the entry by its hashed name. Under a fixed name, a
		// page left open across a deploy would fetch the new build's chunk and
		// run the new entry beside its own (vite.config.mts chunkFileNames).
		const unhashed = fs
			.readdirSync(path.join(publicFolder, "js"))
			.filter((f) => f.endsWith(".js"))
			.filter(
				(f) =>
					![
						"loading-error-handlers.js",
						"prepaint.js",
						"push.js",
						"translate-worker.js",
					].includes(f)
			)
			.filter((f) => !/^bundle-[\w-]+\.js$/.test(f) && !/^[\w-]+\.[\w-]{8}\.js$/.test(f));
		expect(unhashed).to.deep.equal([]);
	});

	it("style files are built", function () {
		expect(fs.existsSync(path.join(publicFolder, "css", "style.css"))).to.be.true;

		for (const theme of [
			"coffee",
			"creama",
			"cobalt",
			"frost",
			"molokai",
			"princess",
			"princess_",
			"keeki",
			"keekiblush",
			"sandrof",
			"oikarinen",
			"bourbaki",
			"gates",
			"mardam",
			"zelenzy",
			"panasync",
			"day",
			"morning",
		]) {
			expect(fs.existsSync(path.join(publicFolder, "themes", `${theme}.css`))).to.be.true;
		}
	});

	it("style files contain expected content", function (done) {
		fs.readFile(path.join(publicFolder, "css", "style.css"), "utf8", function (err, contents) {
			expect(err).to.be.null;

			expect(contents.includes("var(--body-color)")).to.be.true;
			expect(contents.includes("url(../fonts/fa-solid-900.woff2)")).to.be.true;
			expect(contents.includes(".tooltipped{position:relative}")).to.be.true;

			done();
		});
	});

	it("javascript map is created", function () {
		expect(fs.existsSync(path.join(publicFolder, "js", `${entry()}.map`))).to.be.true;
	});

	it("loading-error-handlers.js is copied", function () {
		expect(fs.existsSync(path.join(publicFolder, "js", "loading-error-handlers.js"))).to.be
			.true;
	});

	it("loading-error-handlers.js carries the light/dark theme pairs", function () {
		const contents = fs.readFileSync(
			path.join(publicFolder, "js", "loading-error-handlers.js"),
			"utf8"
		);
		expect(contents).not.to.include("__THEME_PAIRS__");
		const pairs = JSON.stringify(THEME_PAIRS);
		expect(contents.includes(pairs) || contents.includes(pairs.replace(/"/g, "`"))).to.be.true;
	});

	it("manifest carries the installed-app fields Chrome needs", function () {
		type Icon = {src: string; sizes: string; purpose: string};
		const manifest = JSON.parse(
			fs.readFileSync(path.join(publicFolder, "manifest.webmanifest"), "utf8")
		) as {
			start_url: string;
			scope: string;
			display: string;
			launch_handler: unknown;
			protocol_handlers: {protocol: string; url: string}[];
			icons: Icon[];
		};

		expect(manifest.start_url).to.equal("./");
		expect(manifest.scope).to.equal("./");
		expect(manifest.display).to.equal("standalone");
		// Launches while a window is open reuse it instead of reloading it
		expect(manifest.launch_handler).to.deep.equal({client_mode: "focus-existing"});
		// web+irc:// links open in the installed app via ?uri= (a web app can
		// only claim web+… schemes; irc:/ircs: would promise TCP we cannot do)
		expect(manifest.protocol_handlers.map((p) => p.protocol)).to.have.members([
			"web+irc",
			"web+ircs",
		]);

		for (const handler of manifest.protocol_handlers) {
			expect(handler.url).to.equal("./?uri=%s");
		}

		// 192 + 512 png icons with purpose "any" (no mixed "maskable any")
		const png = (size: string, purpose: string): Icon | undefined =>
			manifest.icons.find((i) => i.sizes === size && i.purpose === purpose);
		expect(png("192x192", "any")).to.exist;
		expect(png("512x512", "any")).to.exist;
		expect(png("192x192", "maskable")).to.exist;
		expect(png("512x512", "maskable")).to.exist;
		expect(manifest.icons.some((i) => i.purpose.includes(" "))).to.be.false;

		for (const icon of manifest.icons) {
			expect(fs.existsSync(path.join(publicFolder, icon.src))).to.be.true;
		}
	});

	it("service worker has cacheName set", function (done) {
		fs.readFile(path.join(publicFolder, "service-worker.js"), "utf8", function (err, contents) {
			expect(err).to.be.null;

			expect(contents.includes("const cacheName")).to.be.true;
			expect(contents.includes("__HASH__")).to.be.false;

			done();
		});
	});

	it("service worker precaches the app shell and has no server-side hooks", function (done) {
		fs.readFile(path.join(publicFolder, "service-worker.js"), "utf8", function (err, contents) {
			expect(err).to.be.null;

			// Offline shell: index.html and the manifest are precached on install
			expect(hasString(contents, "index.html")).to.be.true;
			expect(hasString(contents, "manifest.webmanifest")).to.be.true;
			// ...and the bundle, so an installed app opens offline right away
			expect(hasString(contents, `js/${entry()}`)).to.be.true;
			// ...and what the entry imports statically (Rolldown's runtime).
			const runtime = fs
				.readdirSync(path.join(publicFolder, "js"))
				.find((f) => /^rolldown-runtime\.[\w-]+\.js$/.test(f));
			expect(runtime, "js/rolldown-runtime.<hash>.js").to.be.a("string");
			expect(hasString(contents, `js/${runtime}`)).to.be.true;
			expect(contents.includes("css/style.css?v=")).to.be.true;
			expect(contents).to.match(/addEventListener\(["`]notificationclick["`]/);

			// Nothing is left that expects the old Node server: no socket.io and
			// none of its paths (the old worker kept `storage/` and `uploads/`
			// out of its cache, spelled `socket\.io|storage|uploads` in a regex).
			// The bare words are fair game: the push code's comments talk about
			// the browser's storage.
			expect(contents).not.to.match(/socket\\?\.io/);
			expect(contents).not.to.match(/\b(?:storage|uploads)[/|]/);

			// Web Push (draft/webpush, phase 2 slice 0): the push handler is
			// back — the ircd delivers raw lines now (push-subscription.md).
			expect(contents).to.match(/addEventListener\(["`]push["`]/);

			done();
		});
	});

	it("index.html, the service worker and the bundle carry one build token", function () {
		// The page compares the token baked into its bundle with the one a
		// newly activated worker announces (its cache name); the asset URLs
		// carry it too so the precache keys match the page's requests.
		const html = fs.readFileSync(path.join(publicFolder, "index.html"), "utf8");
		const worker = fs.readFileSync(path.join(publicFolder, "service-worker.js"), "utf8");
		const bundle = fs.readFileSync(path.join(publicFolder, "js", entry()!), "utf8");

		// Minified in a production build (`const cacheName="…"`, or with
		// backticks).
		const inWorker = /const cacheName\s*=\s*["`]([^"`]+)["`]/.exec(worker);
		expect(inWorker, "cacheName in service-worker.js").to.not.be.null;
		const token = inWorker![1];
		expect(token).to.match(/^(dev|[0-9a-f]{10})$/);

		const inHtml = [...html.matchAll(/\?v=([^"&]+)"/g)].map((m) => m[1]);
		expect(inHtml).to.not.be.empty;
		expect(new Set(inHtml)).to.deep.equal(new Set([token]));

		// Oxc's minifier may write the string as a template literal.
		expect(hasString(bundle, token), "the bundle carries the token").to.be.true;
	});

	it("the Lua chunk carries the pattern step budget", function () {
		const js = path.join(publicFolder, "js");
		const luaChunk = fs
			.readdirSync(js)
			.find((f) => /^fengari.*\.js$/.test(f) && !f.endsWith(".map"));
		expect(luaChunk, "a fengari chunk is built").to.be.a("string");
		const source = fs.readFileSync(path.join(js, luaChunk as string), "utf8");
		// scripts/fengari-match-budget.js; the message survives minification.
		expect(source).to.include("pattern too complex (step limit)");
	});
});
