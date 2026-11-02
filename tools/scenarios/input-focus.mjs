// Opening a conversation puts the caret in the message input
// (ChatInput.vue `focusForTyping`), except on a touch-primary device where
// focusing would raise the on-screen keyboard. What `pnpm test` cannot see:
// which element actually holds focus after the conversation opened through
// every way in — a *real* click on a sidebar row when the input did NOT
// already have it (the user clicked into the scrollback first), Alt+Up, the
// Jump-to box (click on a result, Enter), the lobby's join form, a click on
// a row from the settings page, the channel that opens first after
// connecting, and the remembered conversation after a cold load.
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/input-focus.mjs
//   node tools/browser-drive.mjs tools/scenarios/input-focus.mjs --mobile --width=390 --height=844

const RUN = Date.now().toString(36);
const NICK = `if${RUN}`;
const BASE = "http://localhost:8001/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance,%23seance2`;

const ROW = (name) => `.channel-list-item[data-name="${name}"]`;
const ACTIVE_ROW = `(document.querySelector('.channel-list-item.active')?.dataset.name ?? "")`;
const FOCUSED = `(() => {
	const el = document.activeElement;
	if (!el || el === document.body) return "body";
	return el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + String(el.className).trim().replace(/\\s+/g, ".");
})()`;

const key = async (page, key, code, vk, modifiers = 0) => {
	for (const type of ["rawKeyDown", "keyUp"]) {
		await page.send("Input.dispatchKeyEvent", {
			type,
			key,
			code,
			windowsVirtualKeyCode: vk,
			nativeVirtualKeyCode: vk,
			modifiers,
		});
	}
};

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});

	const touch = await page.evaluate(
		`window.matchMedia("(hover: none) and (pointer: coarse)").matches`
	);
	const want = touch ? "body" : "#input";
	console.log(
		`touch-primary device: ${touch} → after opening a conversation focus should be on ${want}`
	);

	await page.click('#connect input[name="autoconnect"]');
	// On a phone the submit is below the fold.
	await page.evaluate(
		`document.querySelector("#connect button[type=submit]").scrollIntoView({block: "center"})`
	);
	await page.click("#connect button[type=submit]");
	await page.waitFor(`document.querySelector('${ROW("#seance2")}')`, {
		timeout: 30000,
		label: "#seance2 in the sidebar",
	});
	await page.waitFor(`document.querySelector('#input')`, {
		timeout: 30000,
		label: "the message input",
	});
	await page.sleep(500);

	const opened = await page.evaluate(ACTIVE_ROW);
	const focusedAfterOpen = await page.evaluate(FOCUSED);
	console.log(`after connect: open=${opened} focused=${focusedAfterOpen}`);
	page.check(`first conversation after connect: focus on ${want}`, focusedAfterOpen === want);

	// Take focus away first, as a click into the scrollback does, so the
	// next assertion is about the switch and not about focus left behind.
	const dropFocus = async () => {
		await page.evaluate(`document.activeElement && document.activeElement.blur()`);
		const now = await page.evaluate(FOCUSED);
		page.check("focus dropped to body before the switch", now === "body");
	};

	const theOther = async () =>
		(await page.evaluate(ACTIVE_ROW)) === "#seance" ? "#seance2" : "#seance";

	const switchTo = async (name, how, label) => {
		await dropFocus();
		await how(name);
		await page.waitFor(`${ACTIVE_ROW} === ${JSON.stringify(name)}`, {
			timeout: 10000,
			label: `${name} to open`,
		});
		await page.sleep(300);
		const focused = await page.evaluate(FOCUSED);
		console.log(`${label} → ${name}: focused=${focused}`);
		page.check(`${label} → ${name}: focus on ${want}`, focused === want);
	};

	// On a phone the sidebar is an overlay that a row click closes (and a
	// click on the open row does not): open it only when it is closed.
	const openSidebar = async () => {
		if (touch && !(await page.evaluate(`!!document.querySelector(".menu-open")`))) {
			await page.click("button.lt");
			await page.sleep(300);
		}
	};

	const byClick = async (name) => {
		await openSidebar();
		await page.click(ROW(name));
	};

	await switchTo(await theOther(), byClick, "sidebar click");
	await page.screenshot("after-click");
	await switchTo(await theOther(), byClick, "sidebar click back");

	// The row of the conversation already open: no route change, still
	// "select this channel" — the caret must land in the input all the same.
	await switchTo(await page.evaluate(ACTIVE_ROW), byClick, "sidebar click on the open row");

	// The lobby has an input too (commands), and its row is the network
	// header: the same rules apply to it, opened and re-clicked.
	const lobby = `.channel-list-item[data-type="lobby"]`;
	const network = await page.evaluate(`document.querySelector('${lobby}').dataset.name`);
	const byLobbyClick = async () => {
		await openSidebar();
		await page.click(`${lobby} .lobby-title`);
	};
	await switchTo(network, byLobbyClick, "lobby click");
	await switchTo(network, byLobbyClick, "lobby click on the open row");
	await switchTo("#seance", byClick, "sidebar click");

	if (!touch) {
		// From #seance: Alt+Down is #seance2, Alt+Up from there is #seance
		// again (Alt+Up from the first channel would land on the lobby).
		await switchTo(
			await theOther(),
			() => key(page, "ArrowDown", "ArrowDown", 40, 1),
			"Alt+Down"
		);
		await switchTo(await theOther(), () => key(page, "ArrowUp", "ArrowUp", 38, 1), "Alt+Up");

		// Jump to…: the results never list the open conversation, so the
		// other one is what comes up.
		const jumpTo = async (name) => {
			await page.click("#channel-search-input");
			await page.fill("#channel-search-input", name);
			await page.waitFor(
				`document.querySelectorAll('.jump-to-results .channel-list-item').length > 0`,
				{
					timeout: 5000,
					label: "jump-to results",
				}
			);
		};
		await switchTo(
			await theOther(),
			async (name) => {
				await jumpTo(name);
				await page.click(".jump-to-results .channel-list-item");
			},
			"jump-to result click"
		);
		await switchTo(
			await theOther(),
			async (name) => {
				await jumpTo(name);
				await key(page, "Enter", "Enter", 13);
			},
			"jump-to Enter"
		);

		// The lobby's join form: a channel the user asked for opens on its JOIN.
		await switchTo(
			`#seance3-${RUN}`,
			async (name) => {
				await page.click('.channel-list-item[data-type="lobby"] .add-channel');
				await page.waitFor(`document.querySelector('.join-form input[name="channel"]')`, {
					timeout: 5000,
					label: "the join form",
				});
				await page.fill('.join-form input[name="channel"]', name);
				await page.click('.join-form button[type="submit"]');
			},
			"join form"
		);

		// From a page that is not a conversation the chat mounts afresh:
		// settings is a modal over the whole app, so the way out is its
		// Done button (or Escape/backdrop), which returns to the
		// conversation it covered — and that conversation must come back
		// with the caret in its input.
		const covered = await page.evaluate(ACTIVE_ROW);
		await switchTo(
			covered,
			async () => {
				await page.click("#sidebar button.settings");
				await page.waitFor(`document.querySelector('#settings')`, {
					timeout: 5000,
					label: "the settings page",
				});
				await page.click(".settings-modal-done");
			},
			"Done from settings"
		);
	}

	// A query opened from the user list's context menu — the menu gives
	// focus back to what had it when it closes, and the conversation
	// opens after that. Needs another user in #seance (tmp/chan-listen.mjs
	// or anyone); skipped when there is none.
	if (!touch) {
		const others = `Array.from(document.querySelectorAll('.userlist .user')).map((el) => el.textContent.trim().replace(/^[~&@%+]/, ""))`;
		const buddy = await page.evaluate(
			`${others}.find((n) => n !== ${JSON.stringify(NICK)}) ?? ""`
		);
		if (buddy) {
			await switchTo(
				buddy,
				async (name) => {
					await page.click(`.userlist .user[data-name="${name}"]`);
					await page.waitFor(
						`document.querySelector('#context-menu .context-menu-action-query')`,
						{
							timeout: 5000,
							label: "the user's context menu",
						}
					);
					await page.click("#context-menu .context-menu-action-query");
				},
				"query from the user list"
			);
		} else {
			console.log("nobody else in #seance: query-from-user-list flow skipped");
		}
	}

	// A cold load (what F5 does) with the network on autoconnect: the
	// remembered conversation opens by itself, nobody clicked anything.
	const remembered = await page.evaluate(ACTIVE_ROW);
	console.log(
		`before the cold load: active=${remembered} stored=${await page.evaluate(
			'localStorage.getItem("thelounge.state.lastChannel")'
		)}`
	);
	await page.evaluate(
		`(() => { window.__coldLoad = true; history.replaceState(null, "", "/"); })()`
	);
	await page.send("Page.reload");
	const started = Date.now();
	for (;;) {
		try {
			if (
				await page.evaluate(
					`!window.__coldLoad && ${ACTIVE_ROW} === ${JSON.stringify(remembered)}`
				)
			) {
				break;
			}
		} catch {
			// the document is being replaced
		}
		if (Date.now() - started > 20000) {
			break;
		}
		await page.sleep(150);
	}
	await page.sleep(1000);
	const landedOn = await page.evaluate(ACTIVE_ROW);
	const focusedAfterReload = await page.evaluate(FOCUSED);
	console.log(
		`after a cold load: active=${landedOn} focused=${focusedAfterReload} (remembered ${remembered})`
	);
	// Where it lands is last-channel.mjs / reload-on-settings.mjs's claim;
	// here only that whatever opened got the caret.
	page.check(
		`conversation shown after a cold load: focus on ${want}`,
		focusedAfterReload === want
	);
	await page.screenshot("after-reload");

	page.check("no console errors", page.consoleErrors.length === 0);
	if (page.consoleErrors.length) {
		console.log(page.consoleErrors);
	}
}
