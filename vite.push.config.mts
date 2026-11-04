// The service worker's push module, js/push.js, built by vite.config.mts
// once the app is written. A classic script (IIFE), because the worker
// loads it with importScripts; its own build so no chunk is shared with
// the app.
import * as path from "path";
import {defineConfig} from "vite";
import {defines} from "./scripts/build-info.mts";

export default defineConfig({
	root: import.meta.dirname,
	base: "./",
	publicDir: false,
	define: defines,
	build: {
		outDir: "public",
		emptyOutDir: false,
		sourcemap: true,
		copyPublicDir: false,
		rolldownOptions: {
			input: path.resolve(import.meta.dirname, "client/js/push/worker-entry.ts"),
			output: {format: "iife", entryFileNames: "js/push.js"},
		},
	},
});
