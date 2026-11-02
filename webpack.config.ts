import * as webpack from "webpack";
import * as path from "path";
import CopyPlugin from "copy-webpack-plugin";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import {VueLoaderPlugin} from "vue-loader";
import babelConfig from "./babel.config.cjs";
import {
	buildIdentity,
	version,
	branding,
	brandHtml,
	withThemePairs,
	brandManifest,
	chunkNotices,
} from "./scripts/build-info";
const noticePlugin = new webpack.BannerPlugin({
	raw: true,
	test: /^js\/(highlighter|flourite|katex|code-editor)\.js$/,
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
		fallback: {
			fs: false,
			path: false,
			os: false,
			crypto: false,
			readline: false,
			child_process: false,
		},
	},
	module: {
		rules: [
			{
				// A step budget on Lua's pattern matcher (Josephur/seance#23).
				test: /fengari[\\/]src[\\/]lstrlib\.js$/,
				use: {loader: path.resolve(__dirname, "scripts/fengari-match-budget.js")},
			},
			{
				test: /\.vue$/,
				use: {
					loader: "vue-loader",
					options: {
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
			},
		},
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
			"process.env.SEANCE_TRACK": JSON.stringify(buildIdentity.track),
			"process.env.SEANCE_BRANCH": JSON.stringify(buildIdentity.branch ?? ""),
			"process.env.SEANCE_BUILD": JSON.stringify(buildToken),
			"process.env.FENGARICONF": "undefined",
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
					// Copied rather than bundled (it runs before the bundle
					// loads), so the light/dark pairs it needs to pick the
					// theme are written in here from the list the app reads.
					transform: (content: Buffer) => withThemePairs(content.toString()),
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
						return content
							.toString()
							.replace("__HASH__", buildToken)
							.replace('"__APP_NAME__"', JSON.stringify(branding.appName));
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
	],
};

// The service worker's push module (client/js/push/*), bundled for a
// worker and loaded with `importScripts("js/push.js")` — its own
// configuration so the app's chunking cannot pull its dependencies
// (linkify-it, emoji-regex) into a chunk a worker cannot load. `dependencies` runs it after the app build (whose
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
