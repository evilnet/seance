// A deploy shows up as "Reload to update" in a window that is still open,
// and never in a window that has just loaded — end to end in a real browser
// (client/service-worker.js announceBuild, client/js/pwa.ts, build.ts,
// Windows/Help.vue).
//
//   NODE_ENV=production corepack yarn build
//   node tools/browser-drive.mjs tools/scenarios/update-signal.mjs
//
// No ircd is involved: the connect form is all the page needs to show. The
// scenario serves its own copy of public/ (so that what is deployed can
// change under the running page) and stands in for a new build the way one
// differs from the last as far as the browser is concerned: the build token
// in service-worker.js (the cache name), index.html (`?v=`) and js/bundle.js
// (process.env.SEANCE_BUILD) is replaced. A build without NODE_ENV=production
// carries the token `dev` everywhere, which by design is never an update, so
// the scenario refuses one.
//
// The update check is asked for through the registration, as the foreground
// hooks do (pwa.ts checkForUpdate), whose five-minute throttle would
// otherwise hold the scenario.

import {createServer} from "node:http";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, extname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".map": "application/json",
	".png": "image/png",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".wav": "audio/wav",
};

/** The files a build token is stamped into (webpack.config.ts). */
const TOKENED = ["service-worker.js", "index.html", "js/bundle.js"];

const NOTIFIED = `document.querySelectorAll("#footer .help.notified").length`;
const BUNDLE_SRC = `document.querySelector('script[src*="js/bundle.js"]').getAttribute("src")`;

/** A no-store static server for `dir`, on an ephemeral port. */
function serve(dir) {
	const server = createServer((req, res) => {
		let file = join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));

		if (existsSync(file) && statSync(file).isDirectory()) {
			file = join(file, "index.html");
		}

		if (!existsSync(file)) {
			res.writeHead(404);
			res.end();
			return;
		}

		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"cache-control": "no-store",
		});
		res.end(readFileSync(file));
	});

	return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

function tokenOf(dir) {
	const m = /const cacheName\s*=\s*"([^"]+)"/.exec(
		readFileSync(join(dir, "service-worker.js"), "utf8")
	);

	if (!m) {
		throw new Error("no cacheName in service-worker.js — is public/ a build?");
	}

	return m[1];
}

/** Another ten-hex token: the first digit stepped on. */
function bump(token) {
	const digit = (parseInt(token[0], 16) + 1) % 16;
	return digit.toString(16) + token.slice(1);
}

/** Deploy a "new build": the token replaced wherever webpack stamps it. */
function retoken(dir, from, to) {
	const bare = new RegExp(`(?<![0-9a-f])${from}(?![0-9a-f])`, "g");

	for (const name of TOKENED) {
		const file = join(dir, name);
		const before = readFileSync(file, "utf8");
		const after = before.replace(bare, to);

		if (after === before) {
			throw new Error(`${name} does not carry the token ${from}`);
		}

		writeFileSync(file, after);
	}
}

export default async function run(page) {
	const dir = mkdtempSync(join(tmpdir(), "seance-update-signal-"));
	cpSync(PUBLIC, dir, {recursive: true});
	const server = await serve(dir);
	const base = `http://127.0.0.1:${server.address().port}/`;

	/** Poll an expression that may resolve to a promise (waitFor cannot). */
	const until = async (expr, timeout, label) => {
		const started = Date.now();

		for (;;) {
			try {
				if (await page.evaluate(expr)) {
					return true;
				}
			} catch {
				// the document may be on its way out
			}

			if (Date.now() - started > timeout) {
				console.log(`  timed out after ${timeout}ms waiting for ${label}`);
				return false;
			}

			await page.sleep(150);
		}
	};

	/** Wait out a reload started by `trigger`, then for the app to be up again. */
	const reloaded = async (trigger) => {
		await page.evaluate(`(() => { window.__reloading = true; })()`);
		await trigger();
		return until(
			`!window.__reloading && !!document.querySelector("#connect form, #help")`,
			20000,
			"the page to come back"
		);
	};

	const runsBuild = async (token, label) => {
		const src = await page.evaluate(BUNDLE_SRC);
		page.check(`${label} runs build ${token}`, src.includes(`v=${token}`));
	};

	try {
		const tokenA = tokenOf(dir);

		if (tokenA === "dev") {
			throw new Error(
				"public/ is a development build (token `dev`, never an update): NODE_ENV=production corepack yarn build"
			);
		}

		console.log(`  serving ${base} — build ${tokenA}`);

		await page.goto(base, {waitForSelector: "#connect form"});
		await page.waitFor("navigator.serviceWorker.controller !== null", {
			timeout: 15000,
			label: "the first worker to control the page",
		});
		// Its announce names the page's own build.
		await page.sleep(500);
		await runsBuild(tokenA, "a first load");
		page.check("a first load shows no update", (await page.evaluate(NOTIFIED)) === 0);

		// A deploy under the open window: a worker of another build installs
		// when the app next asks, and tells the page.
		const tokenB = bump(tokenA);
		retoken(dir, tokenA, tokenB);
		console.log(`  deployed build ${tokenB} under the open window`);
		await page.evaluate(
			`navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true)`
		);
		page.check(
			"a window left open is told about the deploy",
			await until(`${NOTIFIED} === 1`, 15000, "the Help icon to light up")
		);
		await page.screenshot("update-available-icon");

		await page.click("#footer .help");
		await page.waitFor(`document.querySelector("#help .update-banner-reload")`, {
			timeout: 5000,
			label: "Help to offer Reload to update",
		});
		await page.screenshot("update-available-help");

		// Reload to update: the page comes back as the new build, quiet.
		page.check(
			"Reload to update reloads",
			await reloaded(() => page.click("#help .update-banner-reload"))
		);
		await page.waitFor("navigator.serviceWorker.controller !== null", {
			timeout: 15000,
			label: "the worker to control the reloaded page",
		});
		await page.sleep(1000);
		await runsBuild(tokenB, "after Reload to update the page");
		page.check("the updated page shows no update", (await page.evaluate(NOTIFIED)) === 0);

		// The false positive of old: a deploy followed by a plain reload. The
		// page loads as the new build through the previous worker (network
		// first), then the new worker installs and claims it — and it is
		// what the page already runs.
		const tokenC = bump(tokenB);
		retoken(dir, tokenB, tokenC);
		console.log(`  deployed build ${tokenC}, then a plain reload`);
		page.check(
			"a plain reload comes back",
			await reloaded(async () => {
				await page.evaluate(`(() => { history.replaceState(null, "", "/"); })()`);
				await page.send("Page.reload");
			})
		);
		page.check(
			"the new worker took over",
			await until(
				`caches.keys().then((names) => names.includes("${tokenC}") && !names.includes("${tokenB}"))`,
				15000,
				"the new worker's cache to replace the old"
			)
		);
		await page.sleep(1000);
		await runsBuild(tokenC, "after a deploy and a plain reload the page");
		page.check(
			"a page loaded after a deploy shows no update",
			(await page.evaluate(NOTIFIED)) === 0
		);
		await page.screenshot("fresh-after-deploy");

		page.check("no console errors", page.consoleErrors.length === 0);
	} finally {
		server.close();
		rmSync(dir, {recursive: true, force: true});
	}
}
