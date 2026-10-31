// Evaluated in the shell's page by a debug build (`--drive=<file>`, src/lib.rs)
// once it has loaded: connect to the dev ircd, join #seance, say one line,
// open Settings, then wait for a web+irc: link from a second launch. At each
// step it asks the shell for a snapshot (Smoke.snapshot) and the harness
// (shots-macos.sh, linux/run.sh) collects it. __HOST__ and __OUT__ are
// filled in by the harness. Needs the dev ircd on ws://__HOST__:8067 and the
// guest (guest.mjs) in #seance.
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	const until = async (fn, label, timeout = 30000) => {
		const start = Date.now();

		while (Date.now() - start < timeout) {
			const value = fn();

			if (value) {
				return value;
			}

			await sleep(100);
		}

		throw new Error("timeout: " + label);
	};

	const set = (selector, value) => {
		const el = document.querySelector(selector);

		if (el.type === "checkbox") {
			if (el.checked !== value) {
				el.click();
			}
		} else {
			el.value = value;
			el.dispatchEvent(new Event("input", {bubbles: true}));
		}
	};

	const shell = window.seanceShell;
	const report = (stage, out) => shell.call("Smoke", "report", {stage, out});

	const shot = async (name) => {
		await shell.call("Smoke", "snapshot", {path: "__OUT__/" + name + ".tiff"});
		await sleep(1500);
	};

	try {
		await until(() => document.querySelector("#connect input[name=host]"), "connect form");
		set("#connect input[name=host]", "__HOST__");
		set("#connect input[name=tls]", false);
		await sleep(100);
		set("#connect input[name=port]", "8067");
		set("#connect input[name=nick]", "ghost");
		set("#connect input[name=join]", "#seance");
		await sleep(500);
		await shot("1-connect");

		document.querySelector("#connect button[type=submit]").click();
		const row = await until(
			() => document.querySelector('.channel-list-item[data-name="#seance"]'),
			"channel row"
		);
		row.click();
		await until(
			() =>
				[...document.querySelectorAll("#chat .msg")].some((m) =>
					m.textContent.includes("alice")
				),
			"the guest",
			40000
		);
		const input = await until(() => document.querySelector("#input"), "input");
		input.value = "Hello from the Tauri shell 👻";
		input.dispatchEvent(new Event("input", {bubbles: true}));
		document.querySelector("#submit").click();
		await until(
			() =>
				[...document.querySelectorAll("#chat .msg.self")].some(
					(m) => m.textContent.includes("Tauri shell") && !m.classList.contains("pending")
				),
			"own echo"
		);
		await sleep(1500);
		await shot("2-channel");

		location.hash = "#/settings/appearance";
		await until(() => document.querySelector("#settings"), "settings");
		await sleep(1200);
		await shot("3-settings");
		[...document.querySelectorAll("#settings button")]
			.find((b) => /done/i.test(b.textContent))
			?.click();
		await sleep(800);

		// The harness launches the app again with a web+irc: link: it must
		// reach this page as App.appUrlOpen, with no reload.
		window.__seanceWalkthrough = 1;
		await report("ready-for-link", 1);
		await until(
			() =>
				location.hash.includes("fromLink=1") &&
				document.querySelector("#connect .connect-link-notice"),
			"link dialog",
			20000
		);
		await sleep(800);

		if (window.__seanceWalkthrough !== 1) {
			throw new Error("the link reloaded the page");
		}

		await shot("4-link");
		await report("done", "ok");
	} catch (e) {
		await report("done", "FAIL " + e.message);
	}
})();
