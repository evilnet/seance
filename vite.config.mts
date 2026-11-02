// The app build: client/js/vue.ts into public/, with fixed names for the
// lazy chunks, a content-hashed entry, and the static files copied and
// stamped beside it. The service worker's push module is vite.push.config.mts,
// built after each app build (pushWorker below). Background:
// docs/projects/vite-8-sweep.md.
import * as path from "path";
import {globSync, readFileSync, statSync} from "fs";
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
} from "./scripts/build-info.mts";

import fengariBudget from "./scripts/fengari-match-budget.js";

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

type Copy = {
	from: string;
	to: (file: string) => string;
	transform?: (content: string) => string;
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
];

const rootIgnore =
	/(^index\.html|^service-worker\.js|^manifest\.webmanifest|\.d\.ts|^tsconfig\.json)$/;

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
		generateBundle(_options, bundle) {
			// The entry is content-hashed and loaded without `?v=`: lazy
			// chunks import shared code from it by its plain file name, and a
			// page that loaded `bundle.js?v=…` would evaluate a second copy of
			// the app for them (a second socket per network). index.html and
			// the service worker's shell list are stamped with its name.
			// The entry's static imports (Rolldown's runtime chunk) are part of
			// the shell too: the offline cold start needs them precached.
			const entry = Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry);
			const entryName = entry?.type === "chunk" ? entry.fileName : "js/bundle.js";
			const shell = [entryName, ...(entry?.type === "chunk" ? entry.imports : [])];
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

// The lazy chunks have fixed names, which the licence notices and
// test/tests/build.ts key on. Rolldown names a chunk after its module
// (luaEditor, scene, dist), so a few are renamed by module.
const chunkNames: [RegExp, string][] = [
	[/[\\/]flourite[\\/]/, "flourite"],
	[/[\\/]scenes[\\/]psng[\\/]scene\.ts$/, "scene-ps"],
	[/[\\/]helpers[\\/]luaEditor\.ts$/, "code-editor"],
	[/[\\/]eruda[\\/]/, "eruda"],
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
		fengariMatchBudget(),
		staticFiles(),
		pushWorker(),
	],
	build: {
		outDir: "public",
		emptyOutDir: true,
		sourcemap: true,
		// The entry is ~1.3 MB; nothing to act on in a warning about it.
		chunkSizeWarningLimit: 2000,
		cssCodeSplit: false,
		modulePreload: {polyfill: false},
		rolldownOptions: {
			input: {bundle: path.resolve(root, "client/js/vue.ts")},
			output: {
				entryFileNames: "js/bundle-[hash].js",
				chunkFileNames: (chunk) => `js/${chunkName(chunk)}.js`,
				assetFileNames: (asset) =>
					asset.names.some((n) => n.endsWith(".css"))
						? "css/style.css"
						: "[name][extname]",
				postBanner: (chunk) => chunkNotices[`js/${chunkName(chunk)}.js`] ?? "",
			},
		},
	},
});
