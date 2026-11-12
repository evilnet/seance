// Channel bans (docs/resources/client-features.md § Channel bans): the address
// in a quit line opens a menu whose Ban… opens the dialog, the dialog suggests
// masks and says who they catch, Ban sets it and kicks, the Bans window shows
// it live, searches on the device (a pasted address finds the ban that catches
// it), unbans with an Undo, edits with one line, and clears what a search left.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/channel-bans.mjs
//   node tools/browser-drive.mjs tools/scenarios/channel-bans.mjs --mobile --width=390 --height=844
//
// SEANCE_IRC_HOST / SEANCE_IRC_PORT (plain ws://) point it at another ircd;
// SEANCE_URL at another copy of public/.

const HOST = process.env.SEANCE_IRC_HOST ?? "127.0.0.1";
const PORT = process.env.SEANCE_IRC_PORT ?? "8067";
const RUN = Date.now().toString(36).slice(-5);
const NICK = `ban${RUN}`;
const HOME = `#ban${RUN}`;
const BASE = process.env.SEANCE_URL ?? "http://localhost:8000/";

export const url = `${BASE}?host=${HOST}&port=${PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	HOME
)}`;

/** A plain client: joins, may set bans, may quit. */
function bot(nick, {join, op} = {}) {
	const ws = new WebSocket(`ws://${HOST}:${PORT}/`, ["text.ircv3.net"]);
	let onReady = () => {};

	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :seance ban bot`);
	};
	ws.onmessage = ({data}) => {
		const line = String(data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
		} else if (/ 376 | 422 /.test(line)) {
			ws.send(`JOIN ${join}`);
			setTimeout(() => onReady(), op ? 2500 : 1200);
		}
	};

	return {
		ready: new Promise((resolve, reject) => {
			onReady = resolve;
			setTimeout(() => reject(new Error(`${nick} never registered`)), 20000);
		}),
		send: (line) => ws.send(line),
		quit: () => ws.send("QUIT :Ping timeout"),
	};
}

const count = (page, selector) =>
	page.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const text = (page, selector) =>
	page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? ""`);
const texts = (page, selector) =>
	page.evaluate(
		`[...document.querySelectorAll(${JSON.stringify(
			selector
		)})].map((e) => e.textContent.trim())`
	);
const sent = (page, since, re) =>
	page.wsFrames
		.slice(since)
		.filter((f) => f.dir === "out" && re.test(f.payloadData ?? ""))
		.map((f) => f.payloadData);

/** A chat command, as typed. */
const type = (page, line) =>
	page.evaluate(`(() => {
		const input = document.querySelector("#input");
		input.value = ${JSON.stringify(line)};
		input.dispatchEvent(new Event("input", {bubbles: true}));
		document.querySelector("#form").requestSubmit();
	})()`);

const clickItem = (page, cls) => page.click(`#context-menu .context-menu-${cls}`);

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${HOME}"]')`, {
		timeout: 30000,
		label: `${HOME} in the sidebar`,
	});
	await page.sleep(1500);
	await page.evaluate(`document.querySelector("#chat .show-more-button")?.click()`);

	// Status lines one by one, or the quit folds into "1 user has quit".
	await page.evaluate(`(() => {
		const root = document.querySelector("[data-v-app]");
		const store = root.__vue_app__.config.globalProperties.$store;
		store.dispatch("settings/update", {name: "statusMessages", value: "shown", sync: false});
	})()`);

	const gone = bot(`gone${RUN}`, {join: HOME});
	const stays = bot(`stay${RUN}`, {join: HOME});
	const helper = bot(`help${RUN}`, {join: HOME});
	await Promise.all([gone.ready, stays.ready, helper.ready]);
	await type(page, `/op help${RUN}`);
	await page.sleep(500);

	// A nick's menu has Ban… next to Kick, on a network with no half-ops too.
	await page.click(`.msg[data-type="join"] .user[data-name="stay${RUN}"]`);
	await page.waitFor(`document.querySelector("#context-menu")`, {label: "the nick's menu"});
	page.check(
		"a nick's menu has Kick and Ban",
		(await count(page, "#context-menu .context-menu-action-kick")) === 1 &&
			(await count(page, "#context-menu .context-menu-action-ban")) === 1
	);
	await clickItem(page, "action-ban");
	await page.waitFor(`document.querySelector("#ban-dialog .oper-chip")`, {
		timeout: 10000,
		label: "the nick's dialog",
	});
	page.check(
		"the nick's address came with the line",
		(await page.evaluate(`document.querySelector("#ban-mask").value`)).startsWith("*!*@")
	);
	await page.click("#ban-dialog .oper-cancel");
	await page.waitFor(`!document.querySelector("#ban-dialog")`, {label: "Cancel closes it"});

	// 1. The address in a quit line.
	gone.quit();
	await page.waitFor(`document.querySelector('.msg[data-type="quit"] .host-address')`, {
		timeout: 10000,
		label: "the quit line",
	});
	const address = await text(page, '.msg[data-type="quit"] .host-address');
	page.check("the quit line shows user@host", /^.+@.+$/.test(address));
	await page.screenshot("1-quit-line");

	await page.click('.msg[data-type="quit"] .host-address');
	await page.waitFor(`document.querySelector("#context-menu")`, {label: "the address menu"});
	page.check(
		"the menu leads with the address",
		(await text(page, "#context-menu .context-menu-oper-target")) === address
	);
	page.check(
		"an op is offered Ban from the channel",
		(await text(page, "#context-menu .context-menu-action-ban")).includes(HOME)
	);
	page.check(
		"everyone gets Copy",
		(await count(page, "#context-menu .context-menu-oper-copy")) === 1
	);
	await page.screenshot("2-address-menu");

	// 2. The dialog, for someone who has left.
	const host = address.slice(address.lastIndexOf("@") + 1);
	await clickItem(page, "action-ban");
	await page.waitFor(`document.querySelector("#ban-dialog")`, {label: "the dialog"});
	await page.waitFor(`document.querySelector("#ban-dialog .oper-action-preview")`, {
		timeout: 10000,
		label: "who it catches",
	});
	page.check(
		"the likeliest mask is filled in",
		(await page.evaluate(`document.querySelector("#ban-mask").value`)) === `*!*@${host}`
	);
	page.check(
		"the chips start from the address and include the nick",
		(await texts(page, "#ban-dialog .oper-chip")).includes(`gone${RUN}!*@*`)
	);
	await page.screenshot("3-dialog");

	await page.fill("#ban-mask", `stay${RUN}!*@*`);
	await page.sleep(200);
	page.check(
		"typing keeps the preview right",
		(await text(page, "#ban-dialog .oper-action-preview")).includes(`stay${RUN}`)
	);
	page.check(
		"the kick switch comes on when someone matches",
		await page.evaluate(`document.querySelector("#ban-dialog input[type=checkbox]").checked`)
	);
	await page.fill("#ban-reason", "Flooding the channel");
	await page.screenshot("4-dialog-match");

	await page.fill("#ban-mask", "*!*@*");
	await page.sleep(200);
	page.check(
		"a mask that catches us says so",
		(await texts(page, "#ban-dialog .oper-action-preview")).some((t) => t.includes("ban you"))
	);
	await page.fill("#ban-mask", `stay${RUN}!*@*`);
	await page.sleep(200);

	const before = page.wsFrames.length;
	await page.click("#ban-dialog .ban-dialog-submit");
	await page.waitFor(`!document.querySelector("#ban-dialog")`, {
		timeout: 12000,
		label: "the dialog closes",
	});
	page.check(
		"the ban went out, then the kick with its reason",
		sent(page, before, /MODE .* \+b stay/).length === 1 &&
			sent(page, before, /KICK .* :Flooding the channel/).length === 1
	);
	await page.waitFor(`document.querySelector('.msg[data-type="kick"]')`, {
		timeout: 8000,
		label: "the kick shows in the channel",
	});
	page.check(
		"the ban shows in the channel as well",
		(await count(page, '.msg[data-type="mode"]')) >= 1
	);

	// 3. The window, from the channel's own command.
	await type(page, "/banlist");
	await page.waitFor(`document.querySelector("#ban-browser .ban-row")`, {
		timeout: 10000,
		label: "the Bans window",
	});
	await page.sleep(300);
	page.check(
		"the ban is listed, and we set it",
		(await text(page, "#ban-browser .ban-row-mask bdi")) === `stay${RUN}!*@*` &&
			(await text(page, "#ban-browser .ban-row-meta")).includes(NICK)
	);
	page.check(
		"the limit shows",
		/1 of 50/.test(await text(page, "#ban-browser .browse-section-head"))
	);
	await page.screenshot("5-window");

	// 4. Add from the window; other people's changes arrive by themselves.
	await page.click("#ban-browser .ban-add");
	await page.waitFor(`document.querySelector("#ban-dialog")`, {label: "the empty dialog"});
	page.check(
		"no mask is suggested from nothing",
		(await count(page, "#ban-dialog .oper-chip")) === 0
	);
	await page.fill("#ban-mask", "*!*@*.spam.example.net");
	await page.waitFor(`document.querySelector("#ban-dialog .ban-dialog-submit:not([disabled])")`, {
		label: "Ban is ready",
	});
	await page.click("#ban-dialog .ban-dialog-submit");
	await page.waitFor(`document.querySelectorAll("#ban-browser .ban-row").length === 2`, {
		timeout: 8000,
		label: "the new ban lands",
	});
	await page.waitFor(`!document.querySelector("#ban-dialog")`, {label: "the dialog closes"});

	// 5. Search on the device: a word, and an address that a ban catches.
	const quiet = page.wsFrames.length;
	await page.fill("#ban-browser .browse-query input", "spam");
	await page.sleep(200);
	page.check("a word finds its ban", (await count(page, "#ban-browser .ban-row")) === 1);
	await page.fill("#ban-browser .browse-query input", "someone@x.spam.example.net");
	await page.sleep(200);
	page.check(
		"a pasted address finds the ban that catches it",
		(await text(page, "#ban-browser .ban-row-mask bdi")) === "*!*@*.spam.example.net"
	);
	await page.screenshot("6-search");
	await page.fill("#ban-browser .browse-query input", "nothinglikeit");
	await page.sleep(200);
	page.check(
		"no match says so",
		(await text(page, "#ban-browser .browse-center")).includes("nothinglikeit")
	);
	page.check("searching asked the server nothing", sent(page, quiet, /./).length === 0);
	await page.click("#ban-browser .browse-clear");
	await page.sleep(200);

	// 6. A covered ban is called out before it is sent.
	await page.click("#ban-browser .ban-add");
	await page.waitFor(`document.querySelector("#ban-dialog")`, {label: "the dialog again"});
	await page.fill("#ban-mask", "*!*@a.spam.example.net");
	await page.sleep(300);
	page.check(
		"a covered ban is called out and cannot be sent",
		(await text(page, "#ban-dialog")).includes("Already covered by") &&
			(await page.evaluate(
				`document.querySelector("#ban-dialog .ban-dialog-submit").disabled`
			))
	);
	await page.screenshot("7-covered");

	// 7. Edit, from there: the old ban goes and the new comes on one line.
	await page.click("#ban-dialog .ban-dialog-link");
	await page.waitFor(`document.querySelector("#ban-dialog .ban-dialog-remove")`, {
		label: "the edit dialog",
	});
	page.check(
		"the link opens that ban, who set it above the mask",
		(await page.evaluate(`document.querySelector("#ban-mask").value`)) ===
			"*!*@*.spam.example.net" && (await text(page, "#ban-dialog")).includes("Set by")
	);
	page.check(
		"Save waits for a change",
		await page.evaluate(`document.querySelector("#ban-dialog .ban-dialog-submit").disabled`)
	);
	await page.screenshot("8-edit");
	await page.fill("#ban-mask", "*!*@*.ham.example.net");
	await page.waitFor(`document.querySelector("#ban-dialog .ban-dialog-submit:not([disabled])")`, {
		label: "Save is ready",
	});
	const edit = page.wsFrames.length;
	await page.click("#ban-dialog .ban-dialog-submit");
	await page.waitFor(`!document.querySelector("#ban-dialog")`, {
		timeout: 8000,
		label: "the edit lands",
	});
	page.check(
		"an edit is one MODE line, the old ban first",
		sent(page, edit, /MODE .* -b\+b \*!\*@\*\.spam\.example\.net \*!\*@\*\.ham\.example\.net/)
			.length === 1
	);
	page.check(
		"the row changed",
		(await texts(page, "#ban-browser .ban-row-mask bdi")).includes("*!*@*.ham.example.net")
	);

	// 8. Unban, and Undo.
	await page.fill("#ban-browser .browse-query input", "ham");
	await page.sleep(200);
	await page.click("#ban-browser .ban-row-unban");
	await page.waitFor(`document.querySelector("#ban-browser .ban-notice-undo")`, {
		timeout: 8000,
		label: "the Undo",
	});
	await page.fill("#ban-browser .browse-query input", "");
	await page.sleep(200);
	page.check("Unban took the row", (await count(page, "#ban-browser .ban-row")) === 1);
	await page.screenshot("9-undo");
	await page.click("#ban-browser .ban-notice-undo");
	await page.waitFor(`document.querySelectorAll("#ban-browser .ban-row").length === 2`, {
		timeout: 8000,
		label: "Undo puts it back",
	});

	// 9. A row's menu.
	await page.evaluate(`(() => {
		const row = document.querySelector("#ban-browser .ban-row");
		const box = row.getBoundingClientRect();
		row.dispatchEvent(new MouseEvent("contextmenu", {
			bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 10,
		}));
	})()`);
	await page.waitFor(`document.querySelector("#context-menu")`, {label: "a row's menu"});
	page.check(
		"a row's menu edits, unbans and copies",
		(await count(page, "#context-menu .context-menu-edit")) === 1 &&
			(await count(page, "#context-menu .context-menu-action-unban")) === 1 &&
			(await count(page, "#context-menu .context-menu-oper-copy")) === 1
	);
	await clickItem(page, "oper-target");
	await page.sleep(200);

	// 10. Unban everything shown, asked once.
	const all = page.wsFrames.length;
	await page.click("#ban-browser .ban-unban-all");
	await page.waitFor(`document.querySelector("#confirm-dialog")`, {label: "the question"});
	await page.screenshot("10-unban-all");
	await page.click("#confirm-dialog .btn-danger");
	await page.waitFor(`!document.querySelector("#ban-browser .ban-row")`, {
		timeout: 12000,
		label: "the list empties",
	});
	page.check("the masks went in one line", sent(page, all, /MODE .* -bb /).length === 1);
	await page.sleep(300);
	page.check(
		"an empty list says so and offers to add",
		(await text(page, "#ban-browser .browse-center")).includes("No bans in") &&
			(await count(page, "#ban-browser .browse-center .oper-btn")) === 1
	);
	await page.screenshot("11-empty");

	// 11. Another op's ban arrives by itself, while the window is open.
	const quietAgain = page.wsFrames.length;
	helper.send(`MODE ${HOME} +b live!*@*`);
	await page.waitFor(`document.querySelector("#ban-browser .ban-row")`, {
		timeout: 8000,
		label: "another op's ban",
	});
	page.check(
		"it names who set it, unasked",
		(await text(page, "#ban-browser .ban-row-meta")).includes(`help${RUN}`) &&
			sent(page, quietAgain, /MODE/).length === 0
	);
	await page.screenshot("12-live");
	stays.quit();
	helper.quit();
}
