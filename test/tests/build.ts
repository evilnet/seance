import {expect} from "chai";
import fs from "fs";
import path from "path";

describe("public folder", function () {
	const publicFolder = path.join(process.cwd(), "public");

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
		expect(fs.existsSync(path.join(publicFolder, "js", "bundle.js"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "js", "bundle.vendor.js"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "js", "push.js"))).to.be.true;
	});

	it("style files are built", function () {
		expect(fs.existsSync(path.join(publicFolder, "css", "style.css"))).to.be.true;
		expect(fs.existsSync(path.join(publicFolder, "css", "style.css.map"))).to.be.true;

		for (const theme of [
			"coffee",
			"creama",
			"cobalt",
			"frost",
			"molokai",
			"princess",
			"princess_",
			"keeki",
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
			expect(contents.includes("sourceMappingURL")).to.be.true;

			done();
		});
	});

	it("javascript map is created", function () {
		expect(fs.existsSync(path.join(publicFolder, "js", "bundle.js.map"))).to.be.true;
	});

	it("loading-error-handlers.js is copied", function () {
		expect(fs.existsSync(path.join(publicFolder, "js", "loading-error-handlers.js"))).to.be
			.true;
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
		expect(manifest.protocol_handlers.map((p) => p.protocol)).to.have.members(["web+irc"]);

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
			expect(contents.includes('"index.html"')).to.be.true;
			expect(contents.includes('"manifest.webmanifest"')).to.be.true;
			// ...and the bundle, so an installed app opens offline right away
			expect(contents.includes("js/bundle.js?v=")).to.be.true;
			expect(contents.includes("css/style.css?v=")).to.be.true;
			expect(contents.includes('addEventListener("notificationclick"')).to.be.true;

			// Nothing is left that expects the old Node server
			expect(contents.includes("socket.io")).to.be.false;
			expect(contents.includes("uploads")).to.be.false;
			expect(contents.includes("storage")).to.be.false;

			// Web Push (draft/webpush, phase 2 slice 0): the push handler is
			// back — the ircd delivers raw lines now (push-subscription.md).
			expect(contents.includes('addEventListener("push"')).to.be.true;

			done();
		});
	});

	it("index.html, the service worker and the bundle carry one build token", function () {
		// The page compares the token baked into its bundle with the one a
		// newly activated worker announces (its cache name); the asset URLs
		// carry it too so the precache keys match the page's requests.
		const html = fs.readFileSync(path.join(publicFolder, "index.html"), "utf8");
		const worker = fs.readFileSync(path.join(publicFolder, "service-worker.js"), "utf8");
		const bundle = fs.readFileSync(path.join(publicFolder, "js", "bundle.js"), "utf8");

		// Minified in a production build (`const cacheName="…"`).
		const inWorker = /const cacheName\s*=\s*"([^"]+)"/.exec(worker);
		expect(inWorker, "cacheName in service-worker.js").to.not.be.null;
		const token = inWorker![1];
		expect(token).to.match(/^(dev|[0-9a-f]{10})$/);

		const inHtml = [...html.matchAll(/\?v=([^"&]+)"/g)].map((m) => m[1]);
		expect(inHtml).to.not.be.empty;
		expect(new Set(inHtml)).to.deep.equal(new Set([token]));

		expect(bundle.includes(`"${token}"`), "the bundle carries the token").to.be.true;
	});
});
