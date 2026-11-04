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

	it("font awesome files are copied", function () {
		expect(fs.existsSync(path.join(publicFolder, "fonts", "fa-solid-900.woff"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "fonts", "fa-solid-900.woff2"))).to.be.true;
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
	});

	it("lazy chunks carry a content hash in their names", function () {
		// A chunk imports the entry by its hashed name. Under a fixed name, a
		// page left open across a deploy would fetch the new build's chunk and
		// run the new entry beside its own (vite.config.mts chunkFileNames).
		const unhashed = fs
			.readdirSync(path.join(publicFolder, "js"))
			.filter((f) => f.endsWith(".js"))
			.filter((f) => !["loading-error-handlers.js", "push.js"].includes(f))
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
		const chunk = fs
			.readdirSync(js)
			.find((f) => /^fengari.*\.js$/.test(f) && !f.endsWith(".map"));
		expect(chunk, "a fengari chunk is built").to.be.a("string");
		const source = fs.readFileSync(path.join(js, chunk as string), "utf8");
		// scripts/fengari-match-budget.js; the message survives minification.
		expect(source).to.include("pattern too complex (step limit)");
	});
});
