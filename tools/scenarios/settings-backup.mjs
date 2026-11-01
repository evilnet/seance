// Settings → General → Backup, end to end in a real browser: the download
// is a gzipped `.seance-settings` file holding the covered localStorage
// entries (passwords stripped unless the box is ticked), and restoring a
// file replaces those entries and reloads with them applied
// (client/js/helpers/settingsBackup.ts, Settings/General.vue).
//
//   corepack yarn build && python3 -m http.server -d public 8031 &
//   node tools/browser-drive.mjs tools/scenarios/settings-backup.mjs
//
// The default target is a plain-WS ircd on 127.0.0.1:8067 (the dev ircd's
// ws:// port). The download never touches the disk: `URL.createObjectURL`
// is wrapped to keep the blob, which the scenario reads back in the page.

const RUN = Date.now().toString(36);
const NICK = `bk${RUN}`;
const BASE = "http://localhost:8031/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance`;

const SECTION = ".settings-backup";
const DOWNLOAD = `${SECTION} .btn:nth-of-type(1)`;
const PASSWORDS = `${SECTION} input[type="checkbox"]`;

// Reads the last captured download: gunzip, parse, hand the JSON back.
const READ_DOWNLOAD = `(async () => {
	const blob = window.__lastDownload?.blob;
	if (!blob) return null;
	const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
	const gz = head[0] === 0x1f && head[1] === 0x8b;
	const text = gz
		? await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text()
		: await blob.text();
	return {gz, name: window.__lastDownload.name, size: blob.size, backup: JSON.parse(text)};
})()`;

async function openGeneral(page) {
	// Settings is a modal and a restore's reload stays on /settings (router.ts
	// onStandalonePage), so the tab may already be open — and the footer button
	// is behind the backdrop there, where a click lands on #settings itself
	// (Windows/Settings.vue @click.self) and CLOSES the window instead.
	if (!(await page.evaluate(`!!document.querySelector(${JSON.stringify(SECTION)})`))) {
		await page.click(`#footer button.settings`);
		await page.waitFor(`!!document.querySelector(${JSON.stringify(SECTION)})`, {
			label: "general tab with the backup section",
		});
	}

	await page.evaluate(
		`document.querySelector(${JSON.stringify(SECTION)}).scrollIntoView({block: "end"})`
	);
}

export default async function run(page) {
	// Keep every download in the page instead of on disk: the button builds
	// an <a download> from an object URL, so wrapping createObjectURL is
	// enough to catch the blob, and a no-op anchor click keeps Chromium from
	// saving anything.
	await page.addInitScript(`
		const real = URL.createObjectURL.bind(URL);
		URL.createObjectURL = (blob) => {
			window.__lastDownload = {blob, name: null};
			return real(blob);
		};
		document.addEventListener("click", (e) => {
			const a = e.target.closest?.("a[download]");
			if (a && window.__lastDownload) {
				window.__lastDownload.name = a.download;
				e.preventDefault();
			}
		}, true);
	`);

	// A ?host link only pre-fills the connect form; connect for real with
	// the password remembered so the file has something to strip.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click('#connect input[name="autoconnect"]');
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`!!document.querySelector("#form #input")`, {
		timeout: 20000,
		label: "chat input up",
	});
	// Plant a password and a mute straight into storage: the connect form
	// needs SASL set up for the password field and the dev ircd has no
	// services, but the backup only cares what the keys hold.
	await page.evaluate(`(() => {
		const nets = JSON.parse(localStorage.getItem("thelounge.networks"));
		nets[0].saslPassword = "hunter2";
		nets[0].rememberPassword = true;
		localStorage.setItem("thelounge.networks", JSON.stringify(nets));
		localStorage.setItem("thelounge.muted", JSON.stringify([nets[0].uuid + "/#seance"]));
		localStorage.setItem("thelounge.ignore." + nets[0].uuid, JSON.stringify([{nick: "spam", ident: "*", hostname: "*", when: 1}]));
	})()`);

	await openGeneral(page);
	await page.screenshot("general-backup");
	page.check("two buttons", (await page.count(`${SECTION} .btn`)) === 2);
	page.check(
		"passwords box off",
		!(await page.evaluate(`document.querySelector(${JSON.stringify(PASSWORDS)}).checked`))
	);

	// 1. Download without passwords.
	await page.click(DOWNLOAD);
	await page.waitFor(`!!window.__lastDownload?.name`, {label: "download made"});
	let dl = await page.evaluate(READ_DOWNLOAD);
	console.log(`  download: ${dl.name}, ${dl.size} bytes, gzip=${dl.gz}`);
	page.check("file is gzipped", dl.gz);
	page.check("file extension", dl.name.endsWith(".seance-settings"));
	// Version 2 since the per-channel translation state joined the covered
	// keys (settingsBackup.ts KEY_SINCE).
	page.check("envelope", dl.backup.format === "seance-settings" && dl.backup.version === 2);
	const keys = Object.keys(dl.backup.entries).sort();
	console.log(`  keys: ${keys.join(", ")}`);
	page.check("settings carried", keys.includes("settings"));
	page.check("networks carried", keys.includes("thelounge.networks"));
	page.check("mutes carried", keys.includes("thelounge.muted"));
	page.check(
		"ignore list carried",
		keys.some((k) => k.startsWith("thelounge.ignore."))
	);
	page.check("no push or sts", !keys.some((k) => /^thelounge\.(push|sts|state)/.test(k)));
	page.check(
		"password stripped",
		dl.backup.entries["thelounge.networks"][0].saslPassword === undefined &&
			dl.backup.entries["thelounge.networks"][0].rememberPassword === false
	);

	// 2. With passwords.
	await page.evaluate(`window.__lastDownload = null`);
	await page.click(PASSWORDS);
	await page.click(DOWNLOAD);
	await page.waitFor(`!!window.__lastDownload?.name`, {label: "second download made"});
	dl = await page.evaluate(READ_DOWNLOAD);
	page.check(
		"password kept when asked",
		dl.backup.entries["thelounge.networks"][0].saslPassword === "hunter2"
	);

	// 3. Restore a file: the last download, with the theme and the nick
	// changed and the mute dropped, fed through the file input as a File
	// (a synthetic change event is the only way in headlessly). The dialog
	// is a real click; the reload that follows brings the new state up.
	const uuid = dl.backup.entries["thelounge.networks"][0].uuid;
	await page.evaluate(`(async () => {
		const backup = ${JSON.stringify(dl.backup)};
		backup.entries.settings.theme = "day";
		backup.entries["thelounge.networks"][0].nick = ${JSON.stringify(NICK + "r")};
		delete backup.entries["thelounge.muted"];
		const bytes = new TextEncoder().encode(JSON.stringify(backup));
		const gz = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
		const file = new File([gz], "friend.seance-settings");
		const dt = new DataTransfer();
		dt.items.add(file);
		const input = document.querySelector(${JSON.stringify(SECTION)} + ' input[type="file"]');
		input.files = dt.files;
		input.dispatchEvent(new Event("change", {bubbles: true}));
	})()`);
	await page.waitFor(`!!document.querySelector("#confirm-dialog-overlay.opened")`, {
		label: "confirm dialog",
	});
	const text = await page.evaluate(
		`document.querySelector("#confirm-dialog .confirm-text p").textContent`
	);
	console.log(`  dialog: ${text}`);
	page.check("dialog names the file", text.includes("friend.seance-settings"));
	page.check("dialog warns of passwords", text.includes("passwords"));
	await page.screenshot("restore-dialog");

	// Cancel first: nothing changes.
	await page.click("#confirm-dialog .btn-cancel");
	await page.waitFor(`!document.querySelector("#confirm-dialog-overlay.opened")`, {
		label: "dialog closed",
	});
	page.check(
		"cancel leaves storage alone",
		(await page.evaluate(`JSON.parse(localStorage.getItem("settings") ?? "{}").theme`)) !==
			"day"
	);

	// Again, and confirm.
	await page.evaluate(`(async () => {
		const backup = ${JSON.stringify(dl.backup)};
		backup.entries.settings.theme = "day";
		backup.entries["thelounge.networks"][0].nick = ${JSON.stringify(NICK + "r")};
		delete backup.entries["thelounge.muted"];
		const file = new File([JSON.stringify(backup)], "friend.seance-settings");
		const dt = new DataTransfer();
		dt.items.add(file);
		const input = document.querySelector(${JSON.stringify(SECTION)} + ' input[type="file"]');
		input.files = dt.files;
		input.dispatchEvent(new Event("change", {bubbles: true}));
	})()`);
	await page.waitFor(`!!document.querySelector("#confirm-dialog-overlay.opened")`, {
		label: "confirm dialog again",
	});
	// A reload on Settings stays on Settings (router.ts onStandalonePage), so
	// "back" is the section reappearing on a fresh document.
	await page.evaluate(`window.__beforeReload = true`);
	await page.click("#confirm-dialog .btn-danger");
	await page.waitFor(
		`!window.__beforeReload && !!document.querySelector(${JSON.stringify(SECTION)})`,
		{timeout: 30000, label: "back after the reload"}
	);
	await page.sleep(500);
	page.check(
		"theme restored",
		(await page.evaluate(`JSON.parse(localStorage.getItem("settings")).theme`)) === "day"
	);
	page.check(
		"theme applied",
		(
			await page.evaluate(`document.getElementById("theme")?.getAttribute("href") ?? ""`)
		).includes("day")
	);
	page.check(
		"network nick restored",
		(await page.evaluate(`JSON.parse(localStorage.getItem("thelounge.networks"))[0].nick`)) ===
			NICK + "r"
	);
	page.check(
		"mute dropped",
		(await page.evaluate(`localStorage.getItem("thelounge.muted")`)) === null
	);
	page.check(
		"ignore list restored",
		(await page.evaluate(
			`localStorage.getItem("thelounge.ignore." + ${JSON.stringify(uuid)})`
		)) !== null
	);
	await page.screenshot("after-restore");

	// 4. A file that is not a backup is refused in place.
	await openGeneral(page);
	await page.evaluate(`(() => {
		const file = new File(["hello"], "notes.txt");
		const dt = new DataTransfer();
		dt.items.add(file);
		const input = document.querySelector(${JSON.stringify(SECTION)} + ' input[type="file"]');
		input.files = dt.files;
		input.dispatchEvent(new Event("change", {bubbles: true}));
	})()`);
	await page.waitFor(`!!document.querySelector(${JSON.stringify(SECTION)} + " [role=alert]")`, {
		label: "bad file reported",
	});
	console.log(
		`  error: ${await page.evaluate(
			`document.querySelector(${JSON.stringify(SECTION)} + " [role=alert]").textContent`
		)}`
	);
	page.check(
		"no dialog for a bad file",
		(await page.count("#confirm-dialog-overlay.opened")) === 0
	);
	await page.evaluate(
		`document.querySelector(${JSON.stringify(
			SECTION
		)} + " [role=alert]").scrollIntoView({block: "end"})`
	);
	await page.screenshot("bad-file");

	page.check("no console errors", page.consoleErrors.length === 0);
}
