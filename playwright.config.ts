import {defineConfig} from "@playwright/test";

// End-to-end cover for the built SPA. The suite in `test/e2e` drives `public/`
// in a real browser against a real ircd (the web server below serves the tree
// as it finds it, so `yarn test:e2e` runs `webpack` first) and the tests skip
// themselves unless SEANCE_E2E_IRC_URL names a server — see
// `test/e2e/markdown.spec.ts`.
export default defineConfig({
	testDir: "test/e2e",
	// Generous: a live connection registers, joins and waits for the echo of
	// every line it sends.
	timeout: 90_000,
	// A message has to reach the ircd and come back before it can be asserted
	// on; five seconds is not always enough on a busy network.
	expect: {timeout: 20_000},
	// The tests talk to a public IRC network — one connection at a time, and
	// no retry storm when something goes wrong.
	workers: 1,
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL: "http://127.0.0.1:8000",
		// The install guide (InstallGuide.vue) opens over a fresh profile in
		// Chromium; the specs start with it dismissed.
		storageState: "test/e2e/storage-state.json",
		// No sandbox because CI images run as root in a container; certificate
		// errors are ignored so the suite can also be pointed at the
		// self-signed dev ircd (`tools/nefarious-dev`).
		launchOptions: {
			args: ["--no-sandbox", "--disable-gpu", "--ignore-certificate-errors"],
		},
		ignoreHTTPSErrors: true,
	},
	webServer: {
		command: "python3 -m http.server -d public 8000",
		url: "http://127.0.0.1:8000/",
		reuseExistingServer: true,
	},
});
