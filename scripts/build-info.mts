// What vite.config.mts, vite.push.config.mts and vite.translate.config.mts
// share: the build's identity and its `process.env.*` defines, the deploy's
// branding, the text transforms applied to the files copied into public/,
// and the licence banners of the lazy chunks and the translation worker.
import * as path from "path";
import {execFileSync} from "child_process";
import {createHash} from "crypto";
import {readFileSync} from "fs";
import {readAvailableLocales} from "../tools/i18n/available-locales.ts";

const root = path.resolve(import.meta.dirname, "..");

// What a build is, for the Help window and for telling one build from the
// next (docs/resources/pwa.md § Updates).
export interface BuildIdentity {
	/** What Help shows: `5.0.2` for a release, `5.0.2-e5ed5af2` past one. */
	version: string;
	/** The release this build is, or follows: the tag without its `v`. */
	release: string;
	/** Short sha of HEAD, or null outside a git checkout. */
	commit: string | null;
	/**
	 * Which build this is, as the Pages workflow names it: `release`,
	 * `develop` or `pr<N>`. Empty for a build made anywhere else.
	 */
	track: string;
	/** The branch a build made anywhere else was made from; null when detached. */
	branch: string | null;
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

export function resolveBuild(): BuildIdentity {
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
	// The Pages workflow names the build (SEANCE_VERSION: `5.0.2`,
	// `5.0.2-e5ed5af2`, `5.0.2-pr142.e5ed5af`) and the release it is or
	// follows (SEANCE_RELEASE), since its shallow checkout has no tags;
	// otherwise the nearest tag names the release the build follows. The tag
	// is the only source of a version — package.json carries none — so a
	// checkout without tags (a shallow clone, no git) is "dev" plus its
	// commit.
	const env = (name: string) => process.env[name]?.trim().replace(/^v/, "") || "";
	const releaseVersion = env("SEANCE_VERSION");
	const nearestTag = git("describe", "--tags", "--abbrev=0")?.replace(/^v/, "");
	const release = env("SEANCE_RELEASE") || releaseVersion || nearestTag || "dev";
	const version = releaseVersion || (commit ? `${release}-${commit}` : release);
	const identity = commit
		? `${version}@${commit}${dirty ? `+${Date.now()}` : ""}`
		: `${version}@${Date.now()}`;
	const build = createHash("sha256").update(identity).digest("hex").substring(0, 10);
	const track = process.env.SEANCE_TRACK?.trim() || "";
	const branch = track ? null : git("symbolic-ref", "--short", "-q", "HEAD") || null;

	return {version, release, commit, track, branch, build};
}

export const buildIdentity = resolveBuild();
export const version = buildIdentity.version;

const isProduction = process.env.NODE_ENV === "production";

/** The token that marks one deploy; `dev` (never an update) outside production. */
export const buildToken = isProduction ? buildIdentity.build : "dev";

/** What `process.env.*` reads in client code are replaced with. */
export const defines = {
	"process.env.NODE_ENV": JSON.stringify(isProduction ? "production" : "development"),
	"process.env.SEANCE_VERSION": JSON.stringify(version),
	"process.env.SEANCE_RELEASE": JSON.stringify(buildIdentity.release),
	"process.env.SEANCE_COMMIT": JSON.stringify(buildIdentity.commit ?? ""),
	"process.env.SEANCE_TRACK": JSON.stringify(buildIdentity.track),
	"process.env.SEANCE_BRANCH": JSON.stringify(buildIdentity.branch ?? ""),
	"process.env.SEANCE_BUILD": JSON.stringify(buildToken),
	"process.env.FENGARICONF": "undefined",
};

// Build-time branding. `client/config.json` is the same file the app fetches
// at runtime (copied to `public/config.json`); the values below only feed the
// parts of index.html and the manifest that exist before any script runs.
// See docs/resources/branding.md.
export interface BuildBranding {
	appName: string;
	shortName: string;
	description: string;
	themeColor: string;
}

function readBranding(): BuildBranding {
	let raw: Record<string, unknown> = {};

	try {
		raw = JSON.parse(readFileSync(path.resolve(root, "client/config.json"), "utf8"));
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

export const branding = readBranding();

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function brandHtml(content: string): string {
	return content
		.replace(/__APP_NAME__/g, escapeHtml(branding.appName))
		.replace(/__THEME_COLOR__/g, escapeHtml(branding.themeColor));
}

// The light/dark theme pairs (client/js/helpers/themeAppearance.ts), for the
// early loader, which cannot import them.
const themePairs = readFileSync(path.resolve(root, "client/js/helpers/themePairs.json"), "utf8");

export function withThemePairs(content: string): string {
	const marker = '"__THEME_PAIRS__"';

	if (!content.includes(marker)) {
		throw new Error(`loading-error-handlers.js has lost its ${marker} marker`);
	}

	return content.replace(marker, JSON.stringify(JSON.parse(themePairs)));
}

// The locales this build ships, for the pre-paint language resolution
// (client/js/prepaint.js): `client/locales/tags.json` is generated by
// `pnpm i18n:compile`, which `pnpm build` runs before Vite. The generated
// file depends on no build mode (tools/i18n/compile.ts), so the dev-only rig
// is dropped for a production build by the reader itself — the pre-paint
// script is baked at build time and can check nothing at runtime, unlike the
// selector and activate(), which fold on NODE_ENV themselves. What it does
// is pinned by test/tests/i18n-toolchain.ts.
const availableLocales = readAvailableLocales(
	path.resolve(root, "client/locales/tags.json"),
	isProduction
).join(",");

/** Inside the pre-paint script's quoted string: a bare comma-joined tag list. */
export function withAvailableLocales(content: string): string {
	const marker = '"__AVAILABLE_LOCALES__"';

	if (!content.includes(marker)) {
		throw new Error(`prepaint.js has lost its ${marker} marker`);
	}

	return content.replace(marker, JSON.stringify(availableLocales));
}

export function brandManifest(content: string): string {
	const manifest = JSON.parse(content);
	manifest.name = branding.appName;
	manifest.short_name = branding.shortName;
	manifest.description = branding.description;
	manifest.theme_color = branding.themeColor;
	manifest.background_color = branding.themeColor;
	return JSON.stringify(manifest, null, "\t") + "\n";
}

// Third-party notices for the lazily loaded chunks, as a `/*!` banner at the
// top of each (vite.config.mts postBanner), keyed by the chunk's name without
// its hash. The minifier drops Prism's own `@license` comment, and flourite's
// build carries none at all. The markdown chunks are MIT (see
// docs/projects/markdown-messages.md); so is CodeMirror, the
// script editor's (client/js/helpers/luaEditor.ts); the translation worker
// (vite.translate.config.mts) carries two Apache-2.0 libraries and four MIT
// ones (docs/resources/translation.md § Licences).
export const chunkNotices: Record<string, string> = {
	"js/highlighter.js":
		"/*! prismjs 1.30.0 (and the js/prism-*.js grammar chunks) | MIT | " +
		"Copyright (c) 2012 Lea Verou | https://github.com/PrismJS/prism */\n",
	"js/flourite.js":
		"/*! flourite 1.3.0 | MIT | Copyright (c) 2015 Toni Sučić, " +
		"Copyright (c) 2024 Teknologi Umum | https://github.com/teknologi-umum/flourite */\n",
	"js/katex.js":
		"/*! katex 0.19.1 | MIT | Copyright (c) 2013-2024 Khan Academy and other contributors | https://katex.org */\n",
	"js/code-editor.js":
		"/*! CodeMirror 6 (@codemirror/state, view, language, commands, legacy-modes, streamparser; @lezer/common, " +
		"highlight, lr; style-mod, w3c-keyname, crelt, @marijn/find-cluster-break) | MIT | " +
		"Copyright (C) 2016-2021 Marijn Haverbeke and others | https://codemirror.net */\n",
	// The language identifiers' chunk (client/js/translate/lid.real.ts): ELD
	// and the fastText binding. lid.176.ftz and fastText.common.wasm are
	// files beside it that can carry no comment, so their notices are here.
	"js/lid.js":
		"/*!\n" +
		" * eld 2.1.1 | Copyright 2023 Nito T.M. | " +
		"https://github.com/nitotm/efficient-language-detector-js\n" +
		" * Licensed under the Apache License, Version 2.0: " +
		"https://www.apache.org/licenses/LICENSE-2.0\n" +
		" * fasttext.wasm.js 1.0.0 | MIT | Copyright (c) 2023 Yuns | " +
		"https://github.com/yunsii/fasttext.wasm.js\n" +
		" * fastText (compiled into fastText.common.wasm) | MIT | " +
		"Copyright (c) 2016-present, Facebook, Inc. | https://github.com/facebookresearch/fastText\n" +
		" * lid.176.ftz language identification model | CC-BY-SA-3.0 | " +
		"Facebook, Inc. | https://fasttext.cc/docs/en/language-identification.html | " +
		"https://creativecommons.org/licenses/by-sa/3.0/\n" +
		" */\n",
	// The translation worker. The two Apache-2.0 libraries ship their builds
	// without a notice, and Apache-2.0 § 4 asks a redistribution to carry the
	// licence. The MIT ones neither: wllama, llama.cpp/ggml (which it
	// compiles into js/wllama.wasm, a file that can carry no comment) and
	// ONNX Runtime Web, whose own `/*!` notice the minifier does not keep.
	// One `/*!` block per licence, the packages it covers inside it.
	"js/translate-worker.js":
		"/*!\n" +
		" * @huggingface/transformers 4.2.0 | Copyright Hugging Face | " +
		"https://github.com/huggingface/transformers.js\n" +
		" * @mlc-ai/web-llm 0.2.85 | https://github.com/mlc-ai/web-llm\n" +
		" * Both licensed under the Apache License, Version 2.0: " +
		"https://www.apache.org/licenses/LICENSE-2.0\n" +
		" */\n" +
		"/*!\n" +
		" * @wllama/wllama 3.8.1 | Copyright (c) 2024 Xuan Son NGUYEN | " +
		"https://github.com/ngxson/wllama\n" +
		" * llama.cpp and ggml, compiled into js/wllama.wasm | " +
		"Copyright (c) 2023-2024 The ggml authors | https://github.com/ggml-org/llama.cpp\n" +
		" * onnxruntime-web | Copyright (c) Microsoft Corporation | " +
		"https://github.com/microsoft/onnxruntime\n" +
		" * All licensed under the MIT License: https://opensource.org/licenses/MIT\n" +
		" */\n",
};
