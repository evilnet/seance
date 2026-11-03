// `pnpm prepare-app`: the production SPA at the repository root (public/), then
// the icons made from it (icons.mjs). Tauri runs this before `tauri dev` and
// `tauri build` (tauri.conf.json's beforeDevCommand / beforeBuildCommand), so
// the binary never compiles in a stale public/. NODE_ENV is set here rather
// than in the command line, which Windows' cmd would not parse.

import {execFileSync} from "node:child_process";

execFileSync("pnpm", ["--dir", "../..", "build"], {
	stdio: "inherit",
	shell: process.platform === "win32",
	env: {...process.env, NODE_ENV: "production"},
});

await import("./icons.mjs");
