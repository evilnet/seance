// The app build: client/js/vue.ts into public/, with content-hashed entry
// and lazy chunks, and the static files copied and stamped beside it. The
// service worker's push module is vite.push.config.mts and the translation
// worker vite.translate.config.mts, each built after every app build
// (pushWorker and translateWorker below). Background:
// docs/projects/vite-8-sweep.md.
import * as path from "path";
import {globSync, mkdirSync, readFileSync, statSync, writeFileSync} from "fs";
import {build, defineConfig, minifySync, type Plugin} from "vite";
import vue from "@vitejs/plugin-vue";
import {
	branding,
	brandHtml,
	withThemePairs,
	brandManifest,
	chunkNotices,
	buildToken,
	defines,
	withAvailableLocales,
} from "./scripts/build-info.mts";

import fengariBudget from "./scripts/fengari-match-budget.js";
import instrument from "./tools/i18n/instrument-loader.mjs";

const root = import.meta.dirname;
const isProduction = process.env.NODE_ENV === "production";

// The browsers the bundle is built for (build.target, resolved), which the
// copied scripts are minified for too.
let scriptTarget: string[] = [];

// A step budget on Lua's pattern matcher (Josephur/seance#23).
function fengariMatchBudget(): Plugin {
	return {
		name: "seance:fengari-match-budget",
		transform: {
			filter: {id: /fengari[\\/]src[\\/]lstrlib\.js$/},
			handler(code) {
				return {code: fengariBudget.patch(code), map: null};
			},
		},
	};
}

// Development only: the dynamic-label instrument (tools/i18n/
// instrument-loader.mjs). Renames t()/tCount() calls whose key argument is
// not a string literal to __tDyn/__tDynC, so the runtime warning belongs to
// the call site — how the label was built — not to whether the lookup
// resolves. Before the Vue plugin, so a .vue file arrives whole (the
// instrument scans its <script> blocks). Production never transforms and
// never carries the globals.
function i18nInstrument(): Plugin {
	return {
		name: "seance:i18n-instrument",
		enforce: "pre",
		apply: () => !isProduction,
		transform: {
			filter: {id: {include: /[\\/]client[\\/].*\.(ts|vue)$/, exclude: /node_modules/}},
			handler(code, id) {
				return {code: instrument.call({resourcePath: id}, code), map: null};
			},
		},
	};
}

type Copy = {
	from: string;
	to: (file: string) => string;
	transform?: (content: string) => string;
	/** Files the glob matches that are not copied. */
	skip?: (file: string) => boolean;
};

const base = (file: string) => path.basename(file);

const copies: Copy[] = [
	{
		from: "node_modules/@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff*",
		to: (f) => `fonts/${base(f)}`,
	},
	{from: "node_modules/katex/dist/katex.min.css", to: () => "css/katex.min.css"},
	{from: "node_modules/katex/dist/fonts/*.woff2", to: (f) => `css/fonts/${base(f)}`},
	{
		from: "client/js/loading-error-handlers.js",
		to: (f) => `js/${base(f)}`,
		transform: withThemePairs,
	},
	// Before first paint, ahead of the stylesheet: the stored or system
	// language sets <html lang> and the direction. A file rather than an
	// inline script because a CSP refuses those (the Tauri shell's does);
	// the locale list is written in here.
	{
		from: "client/js/prepaint.js",
		to: (f) => `js/${base(f)}`,
		transform: withAvailableLocales,
	},
	{
		from: "client/index.html",
		to: () => "index.html",
		transform: (c) => brandHtml(c.replace(/__HASH__/g, buildToken)),
	},
	{
		from: "client/manifest.webmanifest",
		to: () => "manifest.webmanifest",
		transform: brandManifest,
	},
	{
		from: "client/service-worker.js",
		to: () => "service-worker.js",
		transform: (c) =>
			c
				.replace("__HASH__", buildToken)
				.replace('"__APP_NAME__"', JSON.stringify(branding.appName)),
	},
	{from: "client/audio/*", to: (f) => `audio/${base(f)}`},
	{from: "client/img/*", to: (f) => `img/${base(f)}`},
	{from: "client/themes/*.css", to: (f) => `themes/${base(f)}`},
	{from: "client/themes/ps/*", to: (f) => `themes/ps/${base(f)}`},
	// The compiled locale catalogs, for the service worker's notifications:
	// the worker composes its copy through the same i18n runtime
	// (client/js/push/i18n.ts), but a classic service worker may only
	// importScripts while it installs, so the overlay is fetched same-origin
	// from <app>/locales/<tag>.json at push time. en.json also ships inside
	// js/push.js (core.ts imports it statically); these copies serve every
	// other tag. The qqx rig never ships in production (the runtime cannot
	// select it there anyway). tags.json is the build's own input
	// (prepaint.js's locale list); nothing fetches it, and its copy would
	// name qqx.
	{
		from: "client/locales/*.json",
		to: (f) => `locales/${base(f)}`,
		skip: (f) => base(f) === "tags.json" || (isProduction && base(f) === "qqx.json"),
	},
];

// client/'s own root files that are not the site's: the three stamped by
// `copies`, the type declarations and every TypeScript config
// (tsconfig.json, tsconfig.worker.json, …).
const rootIgnore =
	/(^index\.html|^service-worker\.js|^manifest\.webmanifest|\.d\.ts|^tsconfig(\.[\w-]+)?\.json)$/;

// The copied scripts (the service worker, the loading-error handlers) run
// as they are, outside the bundle; a production build minifies them like
// the bundle, as classic scripts, so their top-level names stay as written.
function minifyScript(fileName: string, content: string | Buffer): string {
	const result = minifySync(fileName, content.toString(), {
		module: false,
		compress: {target: scriptTarget},
	});

	if (result.errors.length) {
		throw new Error(`minifying ${fileName}: ${result.errors[0].message}`);
	}

	return result.code;
}

// The static tree (fonts, KaTeX's stylesheet, themes, images, the stamped
// index.html, manifest and service worker), as emitted assets.
function staticFiles(): Plugin {
	return {
		name: "seance:static-files",
		configResolved(config) {
			const target = config.build.target;
			scriptTarget = target === false ? [] : [target].flat();
		},
		// Nothing imports these files, so `pnpm watch` would not see them
		// change without being told.
		buildStart() {
			for (const pattern of ["client/*", ...copies.map((c) => c.from)]) {
				for (const file of globSync(pattern, {cwd: root})) {
					this.addWatchFile(path.join(root, file));
				}
			}
		},
		generateBundle(_options, bundle) {
			// The entry is content-hashed and loaded without `?v=`: lazy
			// chunks import shared code from it by its plain file name, and a
			// page that loaded `bundle.js?v=…` would evaluate a second copy of
			// the app for them (a second socket per network). index.html and
			// the service worker's shell list are stamped with its name.
			// The entry's static imports (Rolldown's runtime chunk) are part of
			// the shell too: the offline cold start needs them precached.
			const entry = Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry);

			if (entry?.type !== "chunk") {
				throw new Error("no entry chunk to stamp into index.html");
			}

			const entryName = entry.fileName;
			const shell = [entryName, ...entry.imports];
			const stampEntry = (text: string) =>
				text
					.replace(/js\/bundle\.js\?v=__HASH__/g, entryName)
					// The worker's source spells it as a template literal.
					.replace(
						// eslint-disable-next-line no-template-curly-in-string
						"`js/bundle.js?v=${cacheName}`",
						shell.map((f) => JSON.stringify(f)).join(",\n\t")
					);
			const emit = (fileName: string, source: string | Uint8Array) =>
				this.emitFile({type: "asset", fileName, source});

			for (const file of globSync("client/*", {cwd: root})) {
				const name = base(file);

				if (!rootIgnore.test(name) && statSync(path.join(root, file)).isFile()) {
					emit(name, readFileSync(path.join(root, file)));
				}
			}

			for (const copy of copies) {
				for (const file of globSync(copy.from, {cwd: root})) {
					if (copy.skip?.(file)) {
						continue;
					}

					const abs = path.join(root, file);
					const content = copy.transform
						? copy.transform(stampEntry(readFileSync(abs, "utf8")))
						: readFileSync(abs);
					const to = copy.to(file);
					emit(
						to,
						isProduction && to.endsWith(".js") ? minifyScript(to, content) : content
					);
				}
			}
		},
	};
}

// The service worker's push module (vite.push.config.mts), built once the
// app is written: a build of its own, so no chunk is shared with the app.
// Built from here rather than by a second command because a watch rebuild
// of the app clears files it did not write from public/, js/push.js
// included.
function pushWorker(): Plugin {
	return {
		name: "seance:push-worker",
		// The worker's own modules are not in the app's graph; watching them
		// makes `pnpm watch` rebuild (and so rebuild the worker) when they
		// change.
		buildStart() {
			for (const file of globSync("client/js/push/*.ts", {cwd: root})) {
				this.addWatchFile(path.join(root, file));
			}
		},
		closeBundle: {
			sequential: true,
			async handler() {
				await build({
					configFile: path.join(root, "vite.push.config.mts"),
					logLevel: "warn",
				});
			},
		},
	};
}

// The translation worker (vite.translate.config.mts), built after the push
// module for the same reason: its own build, so the app's chunks never pull
// WebLLM and transformers.js in (and the worker shares no chunk with the
// app), and written after every app build because the app's empties
// public/. Under `pnpm watch` it is rebuilt only when something it is built
// from changed: its output is kept in memory and written back after an app
// rebuild that touched none of its inputs -- the modules its last build
// read (recorded from that build's output, and watched), anything under
// client/js/translate/ or client/models/, its config and build-info.mts.
// A one-off build always builds it.
function translateWorker(): Plugin {
	const configFile = path.join(root, "vite.translate.config.mts");
	const always = [
		path.join(root, "client/js/translate") + path.sep,
		path.join(root, "client/models") + path.sep,
		configFile,
		path.join(root, "scripts/build-info.mts"),
	];
	/** The last build's files (absolute path → bytes), in watch mode only. */
	let kept: Map<string, Buffer> | null = null;
	/** The modules the last build read, outside node_modules. */
	let inputs = new Set<string>();
	let dirty = true;

	return {
		name: "seance:translate-worker",
		buildStart() {
			for (const file of globSync("client/js/translate/**/*.ts", {cwd: root})) {
				this.addWatchFile(path.join(root, file));
			}

			for (const file of [configFile, ...inputs]) {
				this.addWatchFile(file);
			}
		},
		watchChange(id) {
			const file = path.resolve(id);

			if (inputs.has(file) || always.some((input) => file.startsWith(input))) {
				dirty = true;
			}
		},
		closeBundle: {
			sequential: true,
			async handler() {
				const watching = this.meta.watchMode;

				if (watching && !dirty && kept) {
					for (const [file, content] of kept) {
						mkdirSync(path.dirname(file), {recursive: true});
						writeFileSync(file, content);
					}

					this.info("translation worker unchanged: its last build written back");
					return;
				}

				const result = await build({configFile, logLevel: "warn"});

				if (!watching || !("output" in result)) {
					return;
				}

				kept = new Map();
				inputs = new Set();

				for (const item of result.output) {
					const names = [item.fileName];

					if (item.type === "chunk") {
						if (item.sourcemapFileName) {
							names.push(item.sourcemapFileName);
						}

						for (const id of item.moduleIds) {
							if (
								!id.startsWith("\0") &&
								!id.includes(`${path.sep}node_modules${path.sep}`)
							) {
								inputs.add(path.resolve(id));
							}
						}
					}

					for (const name of names) {
						const file = path.join(root, "public", name);

						kept.set(file, readFileSync(file));
					}
				}

				dirty = false;
			},
		},
	};
}

// Lazy chunks are js/<name>.<hash>.js. The hash is not optional: a chunk
// imports the entry by its hashed name, so a page left open across a deploy
// that fetched the new build's chunk under an unchanged name would run the
// new entry beside its own (a second app). With hashed names it asks for its
// own build's chunk. The licence notices key on the name; Rolldown names a
// chunk after its module (luaEditor, scene, dist), so a few are renamed.
const chunkNames: [RegExp, string][] = [
	[/[\\/]flourite[\\/]/, "flourite"],
	[/[\\/]scenes[\\/]psng[\\/]scene\.ts$/, "scene-ps"],
	[/[\\/]helpers[\\/]luaEditor\.ts$/, "code-editor"],
	[/[\\/]eruda[\\/]/, "eruda"],
	[/[\\/]translate[\\/]lid\.real\.ts$/, "lid"],
	// fastText's Emscripten glue, which its loader imports on its own.
	[/[\\/]fasttext\.wasm\.js[\\/]dist[\\/]core[\\/]/, "lid-core"],
];

function chunkName(chunk: {name: string; facadeModuleId: string | null}): string {
	const id = chunk.facadeModuleId ?? "";
	return chunkNames.find(([test]) => test.test(id))?.[1] ?? chunk.name;
}

export default defineConfig({
	root,
	base: "./",
	publicDir: false,
	define: defines,
	// primer-tooltips carries an old IE `@media (min-width: 0\\0)` hack
	// Lightning CSS refuses to minify; recovery drops that one rule.
	css: {lightningcss: {errorRecovery: true}},
	plugins: [
		vue({
			features: {optionsAPI: false, prodDevtools: false},
			// `<img src="img/…">` is a URL relative to the page, as under
			// vue-loader, not a module to import.
			template: {transformAssetUrls: false},
		}),
		i18nInstrument(),
		fengariMatchBudget(),
		staticFiles(),
		pushWorker(),
		translateWorker(),
	],
	build: {
		outDir: "public",
		emptyOutDir: true,
		sourcemap: true,
		// The entry is ~1.3 MB; nothing to act on in a warning about it.
		chunkSizeWarningLimit: 2000,
		cssCodeSplit: false,
		// A lazy chunk's static imports are the entry and Rolldown's runtime,
		// which every page has already loaded; preloading them only made Safari
		// warn that they went unused.
		modulePreload: false,
		rolldownOptions: {
			input: {bundle: path.resolve(root, "client/js/vue.ts")},
			output: {
				entryFileNames: "js/bundle-[hash].js",
				chunkFileNames: (chunk) => `js/${chunkName(chunk)}.[hash].js`,
				assetFileNames: (asset) =>
					asset.names.some((n) => n.endsWith(".css"))
						? "css/style.css"
						: // The language identifiers' model and wasm (lid.real.ts).
						asset.names.some((n) => /\.(wasm|ftz)$/.test(n))
						? "js/lid/[name][extname]"
						: "[name][extname]",
				postBanner: (chunk) => chunkNotices[`js/${chunkName(chunk)}.js`] ?? "",
			},
		},
	},
});
