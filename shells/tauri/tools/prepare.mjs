// `pnpm prepare-app`: the production SPA at the repository root (public/), then
// the icons made from it (icons.mjs). Tauri runs this before `tauri dev` and
// `tauri build` (tauri.conf.json's beforeDevCommand / beforeBuildCommand), so
// the binary never compiles in a stale public/. NODE_ENV is set here rather
// than in the command line, which Windows' cmd would not parse.

import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";

// The root's dependencies must match its lockfile: after a rebase that
// changed them, the build run from here used the old ones (pnpm installs
// before a top-level run, but did not for this one) and made a bundle that
// throws on load ("Class extends value undefined"). pnpm keeps the lockfile it installed
// from in node_modules/.pnpm/lock.yaml. Not installed for you: run pnpm
// install in this checkout (or any make target, which does).
const read = (file) => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
};

if (read("../../pnpm-lock.yaml") !== read("../../node_modules/.pnpm/lock.yaml")) {
	console.error(
		"prepare-app: the repository root's node_modules does not match its pnpm-lock.yaml; run `pnpm install` there first."
	);
	process.exit(1);
}

execFileSync("pnpm", ["--dir", "../..", "build"], {
	stdio: "inherit",
	shell: process.platform === "win32",
	env: {...process.env, NODE_ENV: "production"},
});

await import("./icons.mjs");
