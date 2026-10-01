import * as webpack from "webpack";
import * as path from "path";
import CopyPlugin from "copy-webpack-plugin";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import {VueLoaderPlugin} from "vue-loader";
import babelConfig from "./babel.config.cjs";
import {execFileSync} from "child_process";
import {createHash} from "crypto";
import {readFileSync} from "fs";

// What a build is, for the Help window and for telling one build from the
// next (docs/resources/pwa.md § Updates).
interface BuildIdentity {
	/** What Help shows: `5.0.2` for a release, `5.0.2-e5ed5af2` past one. */
	version: string;
	/** The release this build is, or follows: the tag without its `v`. */
	release: string;
	/** Short sha of HEAD, or null outside a git checkout. */
	commit: string | null;
	/**
	 * The build token: `?v=` on the asset URLs, the service worker's cache
	 * name, `process.env.SEANCE_BUILD` in the bundle. Two builds of different
	 * commits never share one, which is what makes a deploy detectable — the
	 * browser only installs a new worker when the script's bytes change, and
	 * the page only offers "Reload to update" when the worker's token is not
	 * its own. Rebuilding the same clean commit gives the same token; a dirty
	 * tree or no git at all makes every build distinct.
	 */
	build: string;
}

function resolveBuild(): BuildIdentity {
	const git = (...args: string[]): string | null => {
		try {
			return execFileSync("git", args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return null;
		}
	};

	const commit = git("rev-parse", "--short=8", "HEAD");
	const dirty = commit !== null && git("status", "--porcelain", "--untracked-files=no") !== "";
	// The release workflow names the build after the tag it checks out;
	// otherwise the nearest tag names the release the build follows. The tag
	// is the only source of a version — package.json carries none — so a
	// checkout without tags (a shallow clone, no git) is "dev" plus its
	// commit.
	const releaseVersion = process.env.SEANCE_VERSION?.trim().replace(/^v/, "");
	const nearestTag = git("describe", "--tags", "--abbrev=0")?.replace(/^v/, "");
	const release = releaseVersion || nearestTag || "dev";
	const version = releaseVersion || (commit ? `${release}-${commit}` : release);
	const identity = commit
		? `${version}@${commit}${dirty ? `+${Date.now()}` : ""}`
		: `${version}@${Date.now()}`;
	const build = createHash("sha256").update(identity).digest("hex").substring(0, 10);

	return {version, release, commit, build};
}

const buildIdentity = resolveBuild();
const version = buildIdentity.version;

// Build-time branding. `client/config.json` is the same file the app fetches
// at runtime (copied to `public/config.json`); the values below only feed the
// parts of index.html and the manifest that exist before any script runs.
// See docs/resources/branding.md.
interface BuildBranding {
	appName: string;
	shortName: string;
	description: string;
	themeColor: string;
}

function readBranding(): BuildBranding {
	let raw: Record<string, unknown> = {};

	try {
		raw = JSON.parse(readFileSync(path.resolve(__dirname, "client/config.json"), "utf8"));
	} catch (e: any) {
		throw new Error(`client/config.json is missing or not valid JSON: ${e.message}`);
	}

	const str = (value: unknown, fallback: string): string =>
		typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;

	const appName = str(raw.appName, "Seance");

	return {
		appName,
		shortName: str(raw.shortName, appName),
		description: str(raw.description, "IRC client"),
		themeColor: str(raw.themeColor, "#1a1816"),
	};
}

const branding = readBranding();

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function brandHtml(content: string): string {
	return content
		.replace(/__APP_NAME__/g, escapeHtml(branding.appName))
		.replace(/__THEME_COLOR__/g, escapeHtml(branding.themeColor));
}

function brandManifest(content: string): string {
	const manifest = JSON.parse(content);
	manifest.name = branding.appName;
	manifest.short_name = branding.shortName;
	manifest.description = branding.description;
	manifest.theme_color = branding.themeColor;
	manifest.background_color = branding.themeColor;
	return JSON.stringify(manifest, null, "\t") + "\n";
}

// Third-party notices for the lazily loaded chunks. Prism's core carries a
// `@license` comment terser extracts by itself, but not its copyright line, and
// flourite's build carries nothing at all — so state both, in a `/*!` banner
// that ends up in the chunk's `.LICENSE.txt`. All are MIT; see
// docs/projects/markdown-messages.md.
const chunkNotices: Record<string, string> = {
	"js/highlighter.js":
		"/*! prismjs 1.30.0 (and the js/prism-*.js grammar chunks) | MIT | " +
		"Copyright (c) 2012 Lea Verou | https://github.com/PrismJS/prism */\n",
	"js/flourite.js":
		"/*! flourite 1.3.0 | MIT | Copyright (c) 2015 Toni Sučić, " +
		"Copyright (c) 2024 Teknologi Umum | https://github.com/teknologi-umum/flourite */\n",
	"js/katex.js":
		"/*! katex 0.16.22 | MIT | Copyright (c) 2013-2024 Khan Academy and other contributors | https://katex.org */\n",
};

const noticePlugin = new webpack.BannerPlugin({
	raw: true,
	test: /^js\/(highlighter|flourite|katex)\.js$/,
	banner: ({filename}) => chunkNotices[filename] ?? "",
});

const tsCheckerPlugin = new ForkTsCheckerWebpackPlugin({
	typescript: {
		diagnosticOptions: {
			semantic: true,
			syntactic: true,
		},
		build: true,
	},
});

const vueLoaderPlugin = new VueLoaderPlugin();

const miniCssExtractPlugin = new MiniCssExtractPlugin({
	filename: "css/style.css",
});

const isProduction = process.env.NODE_ENV === "production";

// The token the built files carry (see BuildIdentity.build). A development
// build is always `dev`: nothing is cached and no update is ever detected.
const buildToken = isProduction ? buildIdentity.build : "dev";

// Shared by the app and the service-worker push chunk below. A factory, not
// a shared object: the development branch below mutates a rule's
// `use.options` in place (adding the istanbul plugin), and `config` and
// `pushConfig` must each get their own copy or that mutation would leak
// into the push chunk's rule too.
function makeTsRule() {
	return {
		test: /\.ts$/i,
		include: [path.resolve(__dirname, "client"), path.resolve(__dirname, "shared")],
		exclude: path.resolve(__dirname, "node_modules"),
		use: {
			loader: "babel-loader",
			options: {...babelConfig},
		},
	};
}

const config: webpack.Configuration = {
	name: "app",
	mode: isProduction ? "production" : "development",
	entry: {
		"js/bundle.js": [path.resolve(__dirname, "client/js/vue.ts")],
	},
	devtool: "source-map",
	output: {
		// Clean the output directory before emit — except the service worker's
		// push chunk, which the second configuration below emits into the same
		// tree (and runs after this one; see `dependencies`).
		clean: {keep: /^js\/push\.js(\.map|\.LICENSE\.txt)?$/},
		path: path.resolve(__dirname, "public"),
		filename: "[name]",
		// Lazily loaded chunks (the highlighter, its Prism grammars, the
		// language guesser). `filename` carries the `js/` prefix in the entry
		// name, so chunks have to say it here.
		chunkFilename: "js/[name].js",
		// Not "/": a deploy may live under a subpath (https://host/chat/), and
		// an absolute public path would send every `import()` to /js/… . "auto"
		// derives it from the running script's own URL, undoing the entry's
		// `js/` depth, so a chunk resolves to <page dir>/js/<name>.js wherever
		// the tree is served from. Everything else (index.html, the service
		// worker's precache list) is already scope-relative.
		publicPath: "auto",
	},
	performance: {
		hints: false,
	},
	resolve: {
		extensions: [".ts", ".js", ".vue"],
	},
	module: {
		rules: [
			{
				test: /\.vue$/,
				use: {
					loader: "vue-loader",
					options: {
						compilerOptions: {
							preserveWhitespace: false,
						},
						appendTsSuffixTo: [/\.vue$/],
					},
				},
			},
			makeTsRule(),
			{
				test: /\.css$/,
				use: [
					{
						loader: MiniCssExtractPlugin.loader,
						options: {
							esModule: false,
						},
					},
					{
						loader: "css-loader",
						options: {
							url: false,
							importLoaders: 1,
							sourceMap: true,
						},
					},
					{
						loader: "postcss-loader",
						options: {
							sourceMap: true,
						},
					},
				],
			},
		],
	},
	optimization: {
		splitChunks: {
			cacheGroups: {
				// Webpack's own async vendor split would put Prism and its
				// language table in a chunk named after a number, which is a
				// stale-cache hazard (ids move between builds) for no gain:
				// the highlighter chunk is their only consumer.
				defaultVendors: false,
				commons: {
					// eruda (development-only devtools) stays its own lazy chunk,
					// loaded on first click; see client/js/devtools.ts.
					test: /[\\/]node_modules[\\/](?!eruda[\\/])/,
					name: "js/bundle.vendor.js",
					// Initial chunks only: with "all", the dependencies of a
					// lazily loaded chunk (Prism and its ~300 grammars) are
					// hoisted into the vendor bundle, which is the opposite of
					// what importing them on demand is for.
					chunks: "initial",
				},
			},
		},
	},
	externals: {
		json3: "JSON", // socket.io uses json3.js, but we do not target any browsers that need it
	},
	plugins: [
		tsCheckerPlugin,
		vueLoaderPlugin,
		noticePlugin,
		new webpack.DefinePlugin({
			__VUE_PROD_DEVTOOLS__: false,
			__VUE_OPTIONS_API__: false,
			"process.env.SEANCE_VERSION": JSON.stringify(version),
			"process.env.SEANCE_RELEASE": JSON.stringify(buildIdentity.release),
			"process.env.SEANCE_COMMIT": JSON.stringify(buildIdentity.commit ?? ""),
			"process.env.SEANCE_BUILD": JSON.stringify(buildToken),
		}),
		miniCssExtractPlugin,
		new CopyPlugin({
			patterns: [
				{
					from: path
						.resolve(
							__dirname,
							"node_modules/@fortawesome/fontawesome-free/webfonts/fa-solid-900.woff*"
						)
						.replace(/\\/g, "/"),
					to: "fonts/[name][ext]",
				},
				{
					// KaTeX's stylesheet and fonts, for the math spans: static
					// files the first span links
					// (client/js/helpers/ircmessageparser/math.ts injects the
					// `<link>`), never part of css/style.css — css-loader runs
					// with `url: false`, so importing it through webpack would
					// strand the fonts. The stylesheet references `fonts/`
					// relative to itself, so the fonts land beside it under css/.
					from: path.resolve(__dirname, "node_modules/katex/dist/katex.min.css"),
					to: "css/katex.min.css",
				},
				{
					from: path.resolve(__dirname, "node_modules/katex/dist/fonts/*.woff2"),
					to: "css/fonts/[name][ext]",
				},
				{
					from: path.resolve(__dirname, "./client/js/loading-error-handlers.js"),
					to: "js/[name][ext]",
				},
				{
					from: path.resolve(__dirname, "./client/*").replace(/\\/g, "/"),
					to: "[name][ext]",
					globOptions: {
						ignore: [
							"**/index.html",
							"**/service-worker.js",
							"**/manifest.webmanifest",
							"**/*.d.ts",
							"**/tsconfig.json",
						],
					},
				},
				{
					from: path.resolve(__dirname, "./client/index.html"),
					to: "[name][ext]",
					transform(content) {
						return brandHtml(content.toString().replace(/__HASH__/g, buildToken));
					},
				},
				{
					from: path.resolve(__dirname, "./client/manifest.webmanifest"),
					to: "[name][ext]",
					transform(content) {
						return brandManifest(content.toString());
					},
				},
				{
					from: path.resolve(__dirname, "./client/service-worker.js"),
					to: "[name][ext]",
					transform(content) {
						return content.toString().replace("__HASH__", buildToken);
					},
				},
				{
					from: path.resolve(__dirname, "./client/audio/*").replace(/\\/g, "/"),
					to: "audio/[name][ext]",
				},
				{
					from: path.resolve(__dirname, "./client/img/*").replace(/\\/g, "/"),
					to: "img/[name][ext]",
				},
				{
					from: path.resolve(__dirname, "./client/themes/*").replace(/\\/g, "/"),
					to: "themes/[name][ext]",
				},
				{
					// The ps theme's fonts, licences and animal files,
					// referenced relative to the stylesheet as ps/<file>.
					from: path.resolve(__dirname, "./client/themes/ps/*").replace(/\\/g, "/"),
					to: "themes/ps/[name][ext]",
				},
			],
		}),
		// socket.io uses debug, we don't need it
		new webpack.NormalModuleReplacementPlugin(
			/debug/,
			path.resolve(__dirname, "scripts/noop.js")
		),
	],
};

// The service worker's push module (client/js/push/*), bundled for a
// worker and loaded with `importScripts("js/push.js")` — its own
// configuration so the app's vendor cache group cannot pull its
// dependencies (linkify-it, emoji-regex) into js/bundle.vendor.js, which
// a worker cannot load. `dependencies` runs it after the app build (whose
// `clean` would otherwise race its output).
const pushConfig: webpack.Configuration = {
	name: "push",
	dependencies: ["app"],
	mode: isProduction ? "production" : "development",
	target: "webworker",
	entry: {
		"js/push.js": [path.resolve(__dirname, "client/js/push/worker-entry.ts")],
	},
	devtool: "source-map",
	output: {
		path: path.resolve(__dirname, "public"),
		filename: "[name]",
		publicPath: "auto",
		clean: false,
	},
	performance: {
		hints: false,
	},
	resolve: {
		extensions: [".ts", ".js"],
	},
	module: {
		rules: [makeTsRule()],
	},
	optimization: {
		splitChunks: false,
		runtimeChunk: false,
	},
};

export default (env: any, argv: any) => {
	if (argv.mode === "development") {
		config.target = "node";
		config.devtool = "eval";
		config.stats = "errors-only";
		config.output!.path = path.resolve(__dirname, "test/public");
		config.entry!["testclient.js"] = [path.resolve(__dirname, "test/client/index.ts")];

		// Add the istanbul plugin to babel-loader options
		for (const rule of config.module!.rules!) {
			// @ts-expect-error Property 'use' does not exist on type 'RuleSetRule | "..."'.
			if (rule.use.loader === "babel-loader") {
				// @ts-expect-error Property 'use' does not exist on type 'RuleSetRule | "..."'.
				rule.use.options.plugins = ["istanbul"];
			}
		}

		// `optimization.splitChunks` is incompatible with a `target` of `node`. See:
		// - https://github.com/zinserjan/mocha-webpack/issues/84
		// - https://github.com/webpack/webpack/issues/6727#issuecomment-372589122
		config.optimization!.splitChunks = false;

		// Disable plugins like copy files, it is not required
		config.plugins = [
			tsCheckerPlugin,
			vueLoaderPlugin,
			miniCssExtractPlugin,
			// Client tests that require Vue may end up requireing socket.io
			new webpack.NormalModuleReplacementPlugin(
				/js(\/|\\)socket\.js/,
				path.resolve(__dirname, "scripts/noop.js")
			),
		];

		return config;
	}

	return [config, pushConfig];
};
