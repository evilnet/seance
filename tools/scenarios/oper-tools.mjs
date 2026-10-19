// The oper tools end to end (docs/projects/oper-tools.md) against the dev
// ircd's oper block: opering up shows the shield in the network header;
// `/stats p` and `/check` come back as cards; an important server notice
// (another oper coming up) shows in the channel being looked at while a
// routine one (a client connecting) stays in the network window without
// unread; the oper panel's three tabs — Opers (the helper's oper-up rolled
// up by oper and by kind), Alerts (the plain-words lines, the raw mask
// folded away still switching CONNEXIT) and Me (the status line, the
// privileges); the badge on a notice opens the route menu and the Alerts
// tab shows the change; a G-line and a KILL from a nick's menu work and say
// so; and the notices come back after a reload (IndexedDB). Services
// support: the edit form's section is absent before opering and there
// after, picking X3 prefills the five fields, the liveness line says the
// bots are not online (the dev rig has no X3), and the Opers tab says
// the report channel is missing with Join — the O3 ban path needs X3 and
// is unit-tested. The snoop channel: a helper named O3 posts lines in
// AfterNET's shape into it, the nicks and the #chan they name open their
// menus and Investigate, a line naming us is no highlight, and the Opers
// tab counts none of it (2026-10-11). The cards (step 3) and
// the alert builder (step 4): the channel card's facts become criteria
// rows with the wide ones off and the command assembled live, Add alert
// reports O3's absence, Cancel closes it; the Alerts tab offers "New O3
// alert…" and the folded list says O3 is not online.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d      # local.conf grants the ban privileges
//   node tools/browser-drive.mjs tools/scenarios/oper-tools.mjs
//   node tools/browser-drive.mjs tools/scenarios/oper-tools.mjs --mobile --width=390 --height=844
//
// `SEANCE_PORT` points it at another port when 8000 is taken.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = process.env.SEANCE_IRC_WS ?? "wss://localhost:8443/";
const CHANNEL = "#seance";
const MOBILE = process.argv.includes("--mobile");
const ME = "operwatch";
const PORT = process.env.SEANCE_PORT ?? "8000";

export const url = `http://localhost:${PORT}/?host=localhost&port=8443&tls=true&nick=${ME}&join=%23seance`;

/** A helper client on the dev ircd: joins the channel, runs `onReady`. */
function helper(nick, onReady = () => {}, realname = `Oper scenario ${nick}`, channel = CHANNEL) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let ready = () => {};
	let gone = () => {};
	const send = (line) => ws.readyState === 1 && ws.send(line);

	ws.onopen = () => {
		send(`NICK ${nick}`);
		send(`USER ${nick} 0 * :${realname}`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			send(`JOIN ${channel}`);
		} else if (params[1] === "JOIN" && params[0].startsWith(`:${nick}!`)) {
			onReady(send);
			ready();
		}
	};

	ws.onclose = () => gone();

	return {
		send,
		ready: new Promise((resolve, reject) => {
			ready = resolve;
			setTimeout(() => reject(new Error(`${nick} never joined`)), 20000);
		}),
		closed: new Promise((resolve) => (gone = resolve)),
		quit: () => send("QUIT :done"),
	};
}

/** Remove the scenario's G-line on a raw oper connection (also before a run, after a crash). */
async function cleanup() {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	await new Promise((resolve) => {
		ws.onopen = () => {
			ws.send("NICK opclean");
			ws.send("USER opclean 0 * :cleanup");
		};
		ws.onmessage = (ev) => {
			const line = String(ev.data);
			if (line.startsWith("PING")) {
				ws.send(`PONG${line.slice(4)}`);
			} else if (/ 001 /.test(line)) {
				ws.send("OPER seanceop seance");
			} else if (/ 381 /.test(line)) {
				ws.send("REMOVE gline opvictim@172.17.0.1 :oper-tools scenario cleanup");
				ws.send("QUIT :done");
			}
		};
		ws.onclose = resolve;
		setTimeout(resolve, 10000);
	});
}

async function type(page, text) {
	await page.fill("#input", text);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
}

/** A real right click at the element's centre: what opens a context menu. */
async function rightClick(page, selector, index = 0) {
	const r = await page.rect(selector, index);

	if (!r) {
		throw new Error(`nothing to right-click at ${selector}`);
	}

	const x = r.x + r.width / 2;
	const y = r.y + r.height / 2;
	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x, y});
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x,
		y,
		button: "right",
		buttons: 2,
		clickCount: 1,
	});
	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x,
		y,
		button: "right",
		buttons: 0,
		clickCount: 1,
	});
	await page.sleep(100);
}

/** The user list is a side panel on a desktop and an overlay on a phone. */
async function openUserList(page) {
	if (
		!(await page.evaluate(
			`!!document.querySelector(".userlist") && document.querySelector(".userlist").offsetParent !== null`
		))
	) {
		await page.click("#chat .header .rt");
		await page.sleep(400);
	}
}

const msgs = (type) => `Array.from(document.querySelectorAll("#chat .msg[data-type='${type}']"))`;

export default async function run(page) {
	await cleanup();
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		label: "the channel row",
		timeout: 20000,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.sleep(2500);

	const shield = `.channel-list-item[data-type="lobby"] .oper-panel`;
	page.check(
		"no shield before opering",
		(await page.evaluate(`document.querySelectorAll('${shield}').length`)) === 0
	);

	// ---------------------------- the edit form: no Services support before opering
	const uuid = await page.evaluate(
		`JSON.parse(localStorage.getItem("thelounge.networks") ?? "[]")[0]?.uuid ?? ""`
	);
	page.check(`the network is saved (${uuid})`, uuid !== "");
	const openEditForm = async () => {
		await page.evaluate(`location.hash = "#/settings/networks/${uuid}"`);
		await page.waitFor(`!!document.querySelector("#connect form #connect\\\\:nick")`, {
			label: "the network's edit form",
			timeout: 10000,
		});
		await page.sleep(400);
	};
	const closeSettings = async () => {
		await page.click(".settings-modal-done");
		await page.waitFor(
			`document.querySelector("#input") && !document.querySelector("#settings")`,
			{
				label: "back in the channel",
			}
		);
	};
	await openEditForm();
	page.check(
		"no Services support section before opering",
		(await page.evaluate(`document.querySelectorAll("#label-services").length`)) === 0
	);
	await closeSettings();

	// ---------------------------------------------------------------- oper up
	await type(page, "/oper seanceop seance");
	await page.waitFor(`!!document.querySelector('${shield}')`, {
		label: "the shield",
		timeout: 15000,
	});
	await page.sleep(1500); // PRIVS, the snomask, the features

	// ---------------------------------- Services support, once opered: pick X3
	await openEditForm();
	await page.waitFor(`!!document.querySelector("#label-services")`, {
		label: "the Services support section",
	});
	await page.evaluate(`(() => {
		const select = document.querySelector("#connect\\\\:servicesPackage");
		select.value = "x3";
		select.dispatchEvent(new Event("change", {bubbles: true}));
	})()`);
	await page.waitFor(`!!document.querySelector("#connect\\\\:services-snoop")`, {
		label: "the role fields",
	});
	const roles = await page.evaluate(
		`["oper", "account", "channel", "report", "snoop"].map((r) => document.querySelector("#connect\\\\:services-" + r).value)`
	);
	page.check(
		`picking X3 prefills the five fields (${roles.join(", ")})`,
		roles.join(",") === "O3,AuthServ,ChanServ,#operserv,#mrsnoopy"
	);
	const checkLine = `document.querySelector("#connect .services-check")?.textContent.trim() ?? ""`;
	await page.waitFor(`/aren't online \\(no such nick\\)/.test(${checkLine})`, {
		label: "the liveness line, in plain words",
		timeout: 20000,
	});
	const liveness = await page.evaluate(checkLine);
	page.check(
		`the dev rig has no X3: "${liveness}"`,
		liveness === "O3, AuthServ and ChanServ aren't online (no such nick)."
	);
	await page.evaluate(
		`document.querySelector("#label-services").scrollIntoView({block: "start"})`
	);
	await page.sleep(200);
	await page.screenshot("1b-services-form", {selector: MOBILE ? "#settings" : "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(
		`(JSON.parse(localStorage.getItem("thelounge.networks") ?? "[]")[0]?.services?.package ?? "") === "x3"`,
		{label: "the services block saved"}
	);
	await closeSettings();
	if (!MOBILE) {
		await page.screenshot("1-sidebar-shield", {selector: "#sidebar"});
	}

	// ------------------------------------------------------------ /stats p
	await type(page, "/stats p");
	await page.waitFor(`${msgs("report")}.some((m) => m.querySelector(".oper-report-table"))`, {
		label: "the ports table",
		timeout: 15000,
	});
	const ports = await page.evaluate(`(() => {
		const report = ${msgs("report")}.at(-1);
		return {
			title: report.querySelector(".oper-report-title")?.textContent.trim(),
			heads: Array.from(report.querySelectorAll("th")).map((th) => th.textContent.trim()),
			rows: report.querySelectorAll("tbody tr").length,
			chips: Array.from(report.querySelectorAll(".oper-chip-static")).map((c) => c.textContent.trim()),
		};
	})()`);
	page.check(`/stats p: titled "${ports.title}"`, /port/i.test(ports.title ?? ""));
	page.check(`/stats p: a row per listener (${ports.rows})`, ports.rows >= 5);
	page.check(
		`/stats p: WebSocket flagged (${ports.chips.join(",")})`,
		ports.chips.some((c) => /websocket/i.test(c))
	);
	page.check(
		"no raw [217] lines in the channel",
		(await page.evaluate(
			`${msgs("unhandled")}.filter((m) => m.textContent.includes("217")).length`
		)) === 0
	);
	await page.screenshot("2-stats-p", {selector: "#chat"});

	// ------------------------------------------------------------- /check
	const victim = helper("opvictim");
	await victim.ready;
	await page.sleep(800);
	await type(page, "/check opvictim");
	await page.waitFor(
		`${msgs(
			"report"
		)}.some((m) => m.querySelector(".oper-report-title")?.textContent.includes("opvictim"))`,
		{
			label: "the CHECK card",
			timeout: 15000,
		}
	);
	const card = await page.evaluate(`(() => {
		const report = ${msgs("report")}.at(-1);
		return {
			sections: Array.from(report.querySelectorAll(".oper-report-section-title")).map((h) => h.textContent.trim()),
			ip: report.querySelector(".oper-chip-ip")?.textContent.trim(),
		};
	})()`);
	page.check(
		`/check: Identity and Connection sections (${card.sections.join(", ")})`,
		card.sections.includes("Identity") && card.sections.includes("Connection")
	);
	page.check(
		`/check: the real IP is a chip (${card.ip})`,
		/^\d+\.\d+\.\d+\.\d+$/.test(card.ip ?? "")
	);
	await page.screenshot("3-check-user", {selector: "#chat"});

	await type(page, `/check ${CHANNEL}`);
	await page.waitFor(
		`${msgs(
			"report"
		)}.some((m) => m.querySelector(".oper-report-title")?.textContent.includes("${CHANNEL}"))`,
		{
			label: "the channel CHECK card",
			timeout: 15000,
		}
	);
	const members = await page.evaluate(
		`${msgs("report")}.at(-1).querySelectorAll("tbody tr").length`
	);
	page.check(`/check #seance: a member row each (${members})`, members >= 2);

	// ------------------------------------------- an important notice: active
	const lobbyBadge = `document.querySelector('.channel-list-item[data-type="lobby"] .badge')?.textContent.trim() ?? ""`;
	const friend = helper("opfriend", (send) => send("OPER seanceop seance"));
	await friend.ready;
	await page.waitFor(`${msgs("snotice")}.some((m) => m.textContent.includes("opfriend"))`, {
		label: "the oper-up notice in the channel",
		timeout: 15000,
	});
	const oper = await page.evaluate(`(() => {
		const m = ${msgs("snotice")}.find((el) => el.textContent.includes("opfriend"));
		return {badge: m.querySelector(".snotice-badge")?.textContent.trim(), text: m.querySelector(".snotice-text")?.textContent.trim()};
	})()`);
	page.check(
		`the oper-up notice reads in plain words: "${oper.text}"`,
		/opfriend .* is now a global operator/.test(oper.text ?? "")
	);
	await page.screenshot("4-active-notice", {selector: "#chat"});
	friend.quit();

	// ----------------------------------------------------- the oper panel
	const openPanel = async () => {
		await page.click(MOBILE ? `#viewport .lt` : shield);
		if (MOBILE) {
			await page.sleep(400);
			await page.click(shield);
		}
		await page.waitFor(`!!document.querySelector("#oper .oper-activity")`, {
			label: "the oper panel, on Opers",
			timeout: 10000,
		});
		await page.sleep(500);
	};
	const closePanel = async () => {
		await page.click(".settings-modal-done");
		await page.waitFor(`document.querySelector("#input") && !document.querySelector("#oper")`, {
			label: "back in the channel",
		});
	};

	// Opers: the helper's oper-up is a row by oper, and "Opers coming up" by kind.
	await openPanel();

	// Services support without the report channel: one grey line with Join.
	// The snoop channel is no business of this tab (rubin, 2026-10-11): no
	// line for it, whether or not the client is in it.
	const missing = await page.evaluate(
		`Array.from(document.querySelectorAll(".oper-activity-missing")).map((p) => ({text: p.querySelector("span").textContent.trim(), join: !!p.querySelector("button")}))`
	);
	page.check(
		`the Opers tab says the report channel is missing, with Join (${missing
			.map((m) => m.text)
			.join(" | ")})`,
		missing.length === 1 &&
			missing[0].text === "Not in #operserv: what services did for opers isn't counted." &&
			missing[0].join === true
	);
	const operRow = `Array.from(document.querySelectorAll(".oper-activity .oper-rollup-row")).find((li) => li.querySelector('.oper-row-name .user[data-name="opfriend"]'))`;
	await page.waitFor(`!!${operRow}`, {label: "the oper-up row for opfriend", timeout: 10000});
	const operRowText = await page.evaluate(
		`${operRow}.querySelector(".oper-row").textContent.replace(/\\s+/g, " ").trim()`
	);
	page.check(
		`by oper: "${operRowText}"`,
		/opfriend\s*\d+ actions?\s*\d\d:\d\d/.test(operRowText)
	);
	await page.evaluate(`${operRow}.querySelector(".oper-row").click()`);
	await page.waitFor(`!!${operRow}.querySelector(".oper-tier2 .oper-row")`, {
		label: "the row opens to its kinds",
	});
	const tier2 = await page.evaluate(
		`${operRow}.querySelector(".oper-tier2 .oper-row-name").textContent.trim()`
	);
	page.check(`tier 2 reads "${tier2}"`, /^1 oper-up$/.test(tier2));
	await page.evaluate(`${operRow}.querySelector(".oper-tier2 .oper-row").click()`);
	await page.waitFor(`!!${operRow}.querySelector(".oper-timeline button.snotice-badge")`, {
		label: "the notices themselves, with their badge",
	});
	await page.screenshot("5-panel-opers", {selector: ".oper-modal"});
	await page.click(`.oper-activity-view button:nth-child(2)`);
	await page.waitFor(
		`Array.from(document.querySelectorAll(".oper-activity .oper-row-name")).some((el) => el.textContent.trim() === "Opers coming up")`,
		{label: "the by-kind row"}
	);
	page.check(
		"the view switch is remembered",
		(await page.evaluate(`localStorage.getItem("thelounge.oper.activityView")`)) === "kind"
	);
	await page.click(`.oper-activity-view button:nth-child(1)`);

	// Alerts: the raw mask folded at the bottom still switches CONNEXIT (0x4000).
	await page.click(`.settings-menu button.oper-alerts`);
	await page.waitFor(`!!document.querySelector("#oper .oper-alerts .oper-line")`, {
		label: "the alert lines",
	});
	const lines = await page.evaluate(
		`Array.from(document.querySelectorAll(".oper-alerts-section .oper-line-label")).map((l) => l.textContent.trim())`
	);
	page.check(
		`the lines are in plain words (${lines.length})`,
		lines.includes("Bans added or removed") && lines.includes("Every connect and quit")
	);
	await page.screenshot("5b-panel-alerts", {selector: ".oper-modal"});

	// With X3 set (the form above): the O3 alerts section with its New
	// button, and the folded list asking O3 — which the dev rig lacks.
	page.check(
		"the Alerts tab offers a new O3 alert",
		/^New O3 alert/.test(
			(
				await page.evaluate(`document.querySelector(".oper-o3-new")?.textContent ?? ""`)
			).trim()
		)
	);
	await page.evaluate(`document.querySelector(".oper-o3-fold").open = true`);
	await page.waitFor(
		`/not online/.test(document.querySelector(".oper-o3-fold .oper-o3-note")?.textContent ?? "")`,
		{label: "the O3 alerts list reporting O3's absence", timeout: 10000}
	);
	await page.evaluate(`document.querySelector(".oper-o3").scrollIntoView({block: "start"})`);
	await page.sleep(200);
	await page.screenshot("5d-panel-o3-alerts", {selector: ".oper-modal"});
	await page.evaluate(`document.querySelector(".oper-o3-fold").open = false`);
	await page.evaluate(`document.querySelector(".oper-raw").open = true`);
	await page.waitFor(`!!document.querySelector("#oper .oper-bits")`, {label: "the raw mask"});
	const readMask = `Number(document.querySelector(".oper-mask-readout code")?.textContent)`;
	const maskBefore = await page.evaluate(readMask);
	page.check(
		`the panel shows the server's mask (${maskBefore})`,
		Number.isInteger(maskBefore) && maskBefore > 0
	);
	const connexit = `document.querySelector('.oper-bit[data-bit="CONNEXIT"]')`;
	await page.evaluate(`${connexit}.querySelector("input").scrollIntoView({block: "center"})`);
	await page.sleep(200);
	await page.evaluate(`${connexit}.querySelector("input").click()`);
	await page.waitFor(
		`(${readMask} & 0x4000) !== 0 && !document.querySelector(".oper-mask-readout")?.textContent.includes("Applying")`,
		{
			label: "the mask with CONNEXIT, as the server reports it",
			timeout: 10000,
		}
	);
	page.check(
		"CONNEXIT is on in the mask the server reported",
		((await page.evaluate(readMask)) & 0x4000) !== 0
	);
	await page.screenshot("5c-panel-alerts-raw", {selector: ".oper-modal"});

	// Me: the status line, the privileges (folded when many), the modes grid.
	await page.click(`.settings-menu button.oper-me`);
	await page.waitFor(`!!document.querySelector(".oper-me .oper-privs")`, {
		label: "the privileges",
	});
	const privs = await page.evaluate(
		`Array.from(document.querySelectorAll(".oper-privs .oper-chip-static")).map((c) => c.textContent.trim())`
	);
	page.check(
		`the privileges are listed (${privs.length})`,
		privs.includes("GLINE") && privs.includes("CHECK")
	);
	const status = await page.evaluate(
		`document.querySelector(".oper-me-status").textContent.replace(/\\s+/g, " ").trim()`
	);
	page.check(
		`the status line: "${status}"`,
		/Global operator\s*·\s*\+\w+\s*·\s*nefarious2/.test(status)
	);
	await page.evaluate(`document.querySelector(".oper-me-privs").open = true`);
	await page.screenshot("6-panel-me", {selector: ".oper-modal"});
	await closePanel();

	// ------------------------------- the badge on a notice changes its route
	const operNotice = `${msgs("snotice")}.find((el) => el.textContent.includes("opfriend"))`;
	await page.evaluate(`${operNotice}.scrollIntoView({block: "center"})`);
	await page.sleep(200);
	await page.evaluate(`${operNotice}.querySelector("button.snotice-badge").click()`);
	await page.waitFor(
		`!!document.querySelector("#context-menu .context-menu-oper-route-network")`,
		{label: "the route menu from the badge"}
	);
	const menu = await page.evaluate(
		`Array.from(document.querySelectorAll("#context-menu li")).map((li) => li.textContent.trim()).filter(Boolean)`
	);
	page.check(
		`the menu names the kind and the choices (${menu.join(" | ")})`,
		menu[0] === "Opers coming up" &&
			menu.some((m) => /until I change it/.test(m)) &&
			menu.some((m) => /Stop receiving server events/.test(m))
	);
	await page.screenshot("6b-badge-menu");
	await page.click("#context-menu .context-menu-oper-route-network");
	await page.waitFor(`!document.querySelector("#context-menu")`, {label: "the menu closes"});
	await openPanel();
	await page.click(`.settings-menu button.oper-alerts`);
	const operUpPos = `document.querySelector('.oper-line[data-line="oper-up"] [role="radio"][aria-checked="true"]')?.textContent.trim()`;
	await page.waitFor(`${operUpPos} === "Network"`, {label: "the Alerts line on Network"});
	page.check(
		"Alerts shows 'Someone opers up' on Network after the badge menu",
		(await page.evaluate(operUpPos)) === "Network"
	);
	// Back to Here for good, through the control's own menu.
	await page.evaluate(
		`document.querySelector('.oper-line[data-line="oper-up"] [role="radio"]').click()`
	);
	await page.waitFor(
		`!!document.querySelector("#context-menu .context-menu-oper-route-active")`,
		{label: "Here asks how long"}
	);
	await page.evaluate(
		`Array.from(document.querySelectorAll("#context-menu .context-menu-oper-route-active")).find((li) => /until I change it/.test(li.textContent)).click()`
	);
	await page.waitFor(`${operUpPos} === "Here"`, {label: "the line back on Here"});
	await closePanel();

	// --------------------------------------- a routine notice: network window
	// The baseline is taken now: the O3 alerts fold above drew the server's
	// 401 for O3 into the lobby, which counts as unread as any error does.
	const badgeBeforeRoutine = await page.evaluate(lobbyBadge);
	const routine = helper("opdrive");
	await routine.ready;
	await page.sleep(1500);
	page.check(
		"the connect notice did not come to the channel",
		(await page.evaluate(
			`${msgs("snotice")}.filter((m) => m.textContent.includes("opdrive")).length`
		)) === 0
	);
	page.check(
		`the lobby's unread did not move (${badgeBeforeRoutine})`,
		(await page.evaluate(lobbyBadge)) === badgeBeforeRoutine
	);
	routine.quit();
	// opdrive sorts above opvictim: a click placed before its QUIT redraws
	// the list lands on the wrong row.
	await routine.closed;
	await page.waitFor(`!document.querySelector('.userlist .user[data-name="opdrive"]')`, {
		label: "opdrive gone from the user list",
	});

	// --------------------------------------- the snoop channel (2026-10-11)
	// The dev rig has no X3, so a helper named like the configured oper bot
	// (O3) stands in: it joins the configured snoop channel and posts lines
	// in AfterNET's shape (the values made up) — two UMODE lines with the
	// cloak pair after the modes, two connects, a JOIN, and our own connect.
	// The nicks they name render as nicks whether or not they are in the
	// channel, so the nick menu and Investigate open from the feed; the
	// #chan in the JOIN line opens the channel menu; a line naming us is no
	// highlight; and the Opers tab counts none of it.
	const snoopChannel = "#mrsnoopy";
	const overlay = "#oper-investigate-overlay";
	const closeCard = async () => {
		await page.click(`${overlay} .settings-modal-close`);
		await page.waitFor(`!document.querySelector("${overlay}.opened")`, {
			label: "the card closed",
		});
		await page.sleep(400); // the overlay fades for 0.2 s and would take the click
	};
	const openChannel = async (name) => {
		if (MOBILE) {
			await page.click("#viewport .lt");
			await page.sleep(400);
		}
		await page.click(`.channel-list-item[data-name="${name}"]`);
		await page.waitFor(
			`!!document.querySelector('.channel-list-item[data-name="${name}"].active')`,
			{
				label: `${name} open`,
			}
		);
		await page.sleep(300);
	};

	// Not yet in the snoop channel: the user card says so under Seen before.
	await type(page, "/investigate opvictim");
	await page.waitFor(`!!document.querySelector("${overlay}.opened .oper-investigate-user")`, {
		label: "the user card for opvictim",
	});
	const seenNote = await page.evaluate(
		`document.querySelector("${overlay} .oper-investigate-user .oper-activity-missing")?.textContent.replace(/\\s+/g, " ").trim() ?? ""`
	);
	page.check(
		`the user card says the snoop channel is missing ("${seenNote}")`,
		seenNote === `Not in ${snoopChannel}: earlier sessions aren't kept.`
	);
	await closeCard();

	const o3 = helper("O3", () => {}, "Oper Services", snoopChannel);
	await o3.ready;
	await type(page, `/join ${snoopChannel}`);
	await page.waitFor(
		`!!document.querySelector('.channel-list-item[data-name="${snoopChannel}"].active')`,
		{label: "the snoop channel open", timeout: 10000}
	);
	await page.sleep(800);
	const B = "\x02";
	const snoopLines = [
		`[17:07:07] ${B}UMODE${B} clonebot7 +xzCc AN-1A2B3C4D.example.net ABCDEF.123456.7890AB.CDEF01.IP`,
		`[17:07:07] ${B}NICK${B} clonebot7 probe@host12.example.net () [192.0.2.10] on Hub.Example.Org`,
		`[17:10:12] ${B}UMODE${B} probe9 +xCc AN-5E6F7A8B.example.net 0F1E2D.3C4B5A.697887.7A6B5C.IP`,
		`[17:10:12] ${B}NICK${B} probe9 probe9@host34.example.net () [198.51.100.23] on Hub.Example.Org`,
		`[17:10:40] ${B}JOIN${B} #example by probe9`,
		`[17:11:00] ${B}NICK${B} ${ME} ${ME}@host.example.net () [203.0.113.9] on Hub.Example.Org`,
	];
	for (const line of snoopLines) {
		o3.send(`PRIVMSG ${snoopChannel} :${line}`);
		await page.sleep(2500); // the rig's fake lag: a burst would be excess flood
	}
	const snoopMsgs = `Array.from(document.querySelectorAll("#chat .msg[data-type='message']")).filter((m) => /clonebot7|probe9|Hub\\.Example\\.Org/.test(m.textContent))`;
	await page.waitFor(`${snoopMsgs}.length >= ${snoopLines.length}`, {
		label: "the snoop lines in the channel",
		timeout: 20000,
	});
	const rendered = await page.evaluate(`${snoopMsgs}.map((m) => ({
		nicks: Array.from(m.querySelectorAll(".content .user")).map((u) => u.dataset.name),
		channels: Array.from(m.querySelectorAll(".content .inline-channel")).map((c) => c.textContent.trim()),
		highlight: m.classList.contains("highlight"),
	}))`);
	page.check(
		`the nicks the snoop lines name render as nicks (${rendered
			.map((r) => r.nicks.join("+") || "-")
			.join(" | ")})`,
		rendered.length === snoopLines.length &&
			rendered[0].nicks.includes("clonebot7") &&
			rendered[1].nicks.includes("clonebot7") &&
			rendered[2].nicks.includes("probe9") &&
			rendered[3].nicks.includes("probe9") &&
			rendered[4].nicks.includes("probe9")
	);
	page.check(
		`the #chan in the JOIN line is a channel (${rendered[4].channels.join(",")})`,
		rendered[4].channels.includes("#example")
	);
	page.check(
		`our own connect in the feed is a nick and no highlight (${rendered[5].nicks.join(
			","
		)}, highlight=${rendered[5].highlight})`,
		rendered[5].nicks.includes(ME) && rendered[5].highlight === false
	);
	page.check(
		"no snoop line is a highlight",
		rendered.every((r) => r.highlight === false)
	);
	await page.screenshot("14-snoop-channel", {selector: "#chat"});

	// The nick menu from the connect line (a tap on a nick opens it), and
	// Investigate on it: the user card for a nick that is in no channel of
	// ours, its lookups failing gracefully against the rig.
	await page.click(`#chat .msg .content .user[data-name="clonebot7"]`, 1);
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-oper-investigate")`, {
		label: "Investigate in the snoop nick's menu",
	});
	const nickMenu = await page.evaluate(
		`Array.from(document.querySelectorAll("#context-menu li")).map((li) => li.textContent.trim()).filter(Boolean)`
	);
	page.check(
		`the menu is clonebot7's (${nickMenu.slice(0, 3).join(" | ")})`,
		nickMenu[0] === "clonebot7" && nickMenu.includes("Investigate")
	);
	await page.screenshot("14b-snoop-nick-menu");
	await page.click("#context-menu .context-menu-oper-investigate");
	await page.waitFor(`!!document.querySelector("${overlay}.opened .oper-investigate-user")`, {
		label: "the user card from the snoop line",
	});
	await page.waitFor(
		`!/asking…/.test(document.querySelector("${overlay} .oper-investigate-user")?.textContent ?? "")`,
		{label: "the card's sources settled (the nick is not on the rig)", timeout: 30000}
	);
	const snoopCard = await page.evaluate(`(() => {
		const root = document.querySelector("${overlay}");
		return {
			title: root.querySelector(".settings-modal-header h1").textContent.replace(/\\s+/g, " ").trim(),
			missing: root.querySelectorAll(".oper-investigate-user .oper-activity-missing").length,
		};
	})()`);
	page.check(
		`the user card is clonebot7's (${snoopCard.title})`,
		/^clonebot7/.test(snoopCard.title)
	);
	page.check("in the snoop channel now: no 'Not in' line on the card", snoopCard.missing === 0);
	await page.screenshot("14c-snoop-user-card", {selector: `${overlay} .oper-investigate`});
	await closeCard();

	// The channel menu from the JOIN line's #chan, and Investigate on it.
	const exampleIndex = await page.evaluate(
		`Array.from(document.querySelectorAll("#chat .msg .content .inline-channel")).findIndex((c) => c.textContent.trim() === "#example")`
	);
	page.check("the #chan in the JOIN line is found", exampleIndex >= 0);
	await rightClick(page, `#chat .msg .content .inline-channel`, exampleIndex);
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-oper-investigate")`, {
		label: "Investigate in the snoop channel's menu",
	});
	await page.screenshot("14d-snoop-channel-menu");
	await page.click("#context-menu .context-menu-oper-investigate");
	await page.waitFor(
		`!!document.querySelector("${overlay}.opened .oper-investigate") && /#example/.test(document.querySelector("${overlay} .settings-modal-header h1")?.textContent ?? "")`,
		{label: "the channel card for #example"}
	);
	await closeCard();

	// The Opers tab: nothing of the snoop channel — no "Not in" line and no
	// row counting its lines, the "Everything else" timeline included.
	await openPanel();
	page.check(
		"no 'Not in #mrsnoopy' line on the Opers tab",
		(await page.evaluate(`document.querySelectorAll(".oper-missing-snoop").length`)) === 0
	);
	await page.click(`.oper-activity-view button:nth-child(2)`);
	const otherRow = `Array.from(document.querySelectorAll(".oper-activity .oper-rollup-row")).find((li) => li.querySelector(".oper-row-name")?.textContent.trim() === "Everything else")`;
	await page.waitFor(`!!${otherRow}`, {label: "the Everything else row (the connect notices)"});
	await page.evaluate(`${otherRow}.querySelector(".oper-row").click()`);
	await page.waitFor(`!!${otherRow}.querySelector(".oper-timeline")`, {
		label: "its timeline open",
	});
	const panelText = await page.evaluate(
		`document.querySelector(".oper-activity").textContent.replace(/\\s+/g, " ")`
	);
	page.check(
		"the snoop lines count in no row and no timeline",
		!/clonebot7|probe9|#example|Hub\.Example\.Org|UMODE/.test(panelText)
	);
	// The footer's "From the N notices kept" is the rows' total: the snoop
	// lines are not among the N either.
	const totals = await page.evaluate(`(() => {
		const rows = Array.from(document.querySelectorAll(".oper-activity .oper-rollup-row .oper-row-count")).map((el) => parseInt(el.textContent, 10) || 0);
		const foot = /From the (\\d+) notices? kept/.exec(document.querySelector(".oper-activity-foot")?.textContent ?? "");
		return {rows: rows.reduce((a, b) => a + b, 0), kept: foot ? Number(foot[1]) : -1};
	})()`);
	page.check(
		`the kept count is the rows' total (${totals.kept} kept, rows ${totals.rows})`,
		totals.kept > 0 && totals.kept === totals.rows
	);
	await page.screenshot("14e-panel-opers-by-kind", {selector: ".oper-modal"});
	await page.click(`.oper-activity-view button:nth-child(1)`);
	await closePanel();
	o3.quit();
	await o3.closed;
	await openChannel(CHANNEL);

	// ------------------------------------ the investigation cards (step 3)
	// Two more helpers from the rig's address sharing a realname with none
	// of the others but each other: with opvictim and the oper that is four
	// users, so "not authed", the /24 and the server are shared by all and
	// the realname by none (3 of 4 would do; the helpers' realnames differ).
	// CONNEXIT is on (the Alerts tab above), so their connect notices are in
	// the kept feed for "Seen before".
	const bot2 = helper("opbot2", () => {}, "irc client");
	const bot3 = helper("opbot3", () => {}, "irc client");
	await Promise.all([bot2.ready, bot3.ready]);
	await page.sleep(1500); // the connect notices land in the log
	const cardFacts = `(() => {
		const root = document.querySelector("${overlay}");
		return {
			title: root.querySelector(".settings-modal-header h1").textContent.replace(/\\s+/g, " ").trim(),
			facts: Array.from(root.querySelectorAll(".oper-facts > div")).map((row) => row.querySelector("dt").textContent.trim() + "=" + row.querySelector("dd").textContent.replace(/\\s+/g, " ").trim()),
			chips: Array.from(root.querySelectorAll(".oper-common-chip")).map((c) => c.textContent.replace(/\\s+/g, " ").trim()),
			users: Array.from(root.querySelectorAll(".oper-user-block")).map((b) => ({
				nick: b.querySelector(".oper-user-nick").textContent.trim(),
				ip: b.querySelector(".oper-chip-ip")?.textContent.trim(),
				sameAll: b.classList.contains("same-all"),
			})),
			seen: Array.from(root.querySelectorAll(".oper-seen li")).map((li) => li.textContent.replace(/\\s+/g, " ").trim()),
			verdict: root.querySelector(".oper-verdict")?.textContent.replace(/\\s+/g, " ").trim(),
			bans: root.querySelector(".oper-bans")?.textContent.replace(/\\s+/g, " ").trim(),
		};
	})()`;

	// The channel card, from the channel's context menu (the sidebar row);
	// on the phone the row is under the drawer, so the typed route instead.
	if (MOBILE) {
		await type(page, `/investigate ${CHANNEL}`);
	} else {
		await rightClick(page, `.channel-list-item[data-name="${CHANNEL}"]`);
		await page.waitFor(
			`!!document.querySelector("#context-menu .context-menu-oper-investigate")`,
			{label: "Investigate in the channel's menu"}
		);
		await page.click("#context-menu .context-menu-oper-investigate");
	}

	await page.waitFor(`!!document.querySelector("${overlay}.opened .oper-investigate")`, {
		label: "the channel card",
	});
	await page.waitFor(
		`document.querySelectorAll("${overlay} .oper-user-block").length >= 4 && !!document.querySelector("${overlay} .oper-common-chip") && Array.from(document.querySelectorAll("${overlay} .oper-chip-ip")).length >= 4`,
		{label: "the users with their IPs, and the common facts", timeout: 20000}
	);
	// The bots are not on the rig: O3 and ChanServ are "no such nick" and the
	// facts settle on the server's answers (the channel has no modes).
	await page.waitFor(
		`!/asking/.test(Array.from(document.querySelectorAll("${overlay} .oper-facts dd")).map((dd) => dd.textContent).join(" "))`,
		{label: "the facts settled", timeout: 15000}
	);
	const channelCard = await page.evaluate(cardFacts);
	page.check(
		`the channel card's facts (${channelCard.facts.join(" | ")})`,
		channelCard.facts.some((f) => /^Created=(now|\d.* ago)$/.test(f)) &&
			channelCard.facts.some((f) => /^Modes=(\+\S*|\(none\))$/.test(f)) &&
			channelCard.facts.some((f) => /^Topic=/.test(f)) &&
			channelCard.facts.some((f) => /^Registered=—$/.test(f)) &&
			channelCard.facts.some((f) => /^Bans=\d+$/.test(f))
	);
	page.check(
		`the common facts name the server, the /24 and not authed (${channelCard.chips.join(
			" · "
		)})`,
		channelCard.chips.some((c) => /^server irc\.seance\.test/.test(c)) &&
			channelCard.chips.some((c) => /^172\.17\.0\.\*/.test(c)) &&
			channelCard.chips.some((c) => /^not authed/.test(c))
	);
	page.check(
		`every user block has a real IP (${channelCard.users
			.map((u) => `${u.nick}@${u.ip}`)
			.join(", ")})`,
		channelCard.users.length >= 4 &&
			channelCard.users.every((u) => /^\d+\.\d+\.\d+\.\d+$/.test(u.ip ?? ""))
	);
	page.check(
		"the users sharing every fact are tinted",
		channelCard.users.filter((u) => u.sameAll).length >= 3
	);
	await page.screenshot("10-channel-card", {selector: `${overlay} .oper-investigate`});

	// Alert on this…: the builder opens with the common facts as rows — the
	// server and the /24 are wide and arrive off, "not authed" on — the name
	// and reason defaulted from the channel, the command assembled live; the
	// count line and Add alert both report O3's absence (no X3 on the rig).
	const builder = "#oper-alert-overlay";
	await page.click(`${overlay} .oper-common-actions .btn`);
	await page.waitFor(`!!document.querySelector("${builder}.opened .oper-alert-row")`, {
		label: "the alert builder with its rows",
	});
	const builderState = await page.evaluate(`(() => {
		const root = document.querySelector("${builder}");
		return {
			title: root.querySelector(".settings-modal-header h1").textContent.replace(/\\s+/g, " ").trim(),
			name: root.querySelector("#oper-alert-name").value,
			reaction: root.querySelector("#oper-alert-reaction").value,
			expires: root.querySelector("#oper-alert-expires").value,
			rows: Array.from(root.querySelectorAll(".oper-alert-row")).map((r) => ({
				key: r.dataset.key,
				on: r.querySelector(".oper-alert-switch").checked,
				wide: !!r.querySelector(".oper-wide"),
				value: r.querySelector(".oper-alert-value").value,
			})),
			reason: root.querySelector("#oper-alert-reason").value,
			command: root.querySelector(".oper-alert-command").textContent.trim(),
		};
	})()`);
	const rowOf = (key) => builderState.rows.find((r) => r.key === key);
	page.check(
		`the builder is titled for the channel (${builderState.title})`,
		/^Alert on #seance/.test(builderState.title)
	);
	page.check(
		`the name, reaction and expiry default (${builderState.name}, ${builderState.reaction}, ${builderState.expires})`,
		builderState.name === "seance-bots" &&
			builderState.reaction === "notice" &&
			builderState.expires === "1w"
	);
	page.check(
		`the common facts are rows, the wide ones off (${builderState.rows
			.map((r) => `${r.key}${r.wide ? "*" : ""}=${r.value}:${r.on ? "on" : "off"}`)
			.join(" ")})`,
		rowOf("authed")?.on === true &&
			rowOf("authed")?.value === "no" &&
			rowOf("server")?.wide === true &&
			rowOf("server")?.on === false &&
			rowOf("ip")?.wide === true &&
			rowOf("ip")?.on === false &&
			/^172\.17\.0\.0\/24$/.test(rowOf("ip")?.value ?? "")
	);
	page.check(
		`the command is assembled live, reason last (${builderState.command})`,
		builderState.command.startsWith("addalert seance-bots notice expire 1w authed no") &&
			!/ server | ip /.test(builderState.command) &&
			builderState.command.endsWith(`reason bot group in ${CHANNEL}, see ${ME}`) &&
			builderState.reason === `bot group in ${CHANNEL}, see ${ME}`
	);
	await page.waitFor(
		`/not online/.test(document.querySelector("${builder} .oper-alert-matches")?.textContent ?? "")`,
		{label: "the count line reporting O3's absence", timeout: 10000}
	);
	await page.screenshot("10b-alert-builder", {selector: `${builder} .oper-alert-builder`});

	// Switching the server row on puts it into the command; off takes it out.
	await page.evaluate(
		`document.querySelector('${builder} .oper-alert-row[data-key="server"] .oper-alert-switch').click()`
	);
	await page.waitFor(
		`/ server irc\\.seance\\.test/.test(document.querySelector("${builder} .oper-alert-command").textContent)`,
		{label: "the server criterion in the command once switched on"}
	);
	await page.evaluate(
		`document.querySelector('${builder} .oper-alert-row[data-key="server"] .oper-alert-switch').click()`
	);

	// Add alert: O3 is not on the rig, so the 401 path, in the footer.
	await page.click(`${builder} .oper-alert-submit`);
	await page.waitFor(
		`/O3 is not online/.test(document.querySelector("${builder} .oper-alert-error")?.textContent ?? "")`,
		{label: "Add alert reporting O3's absence", timeout: 10000}
	);
	await page.screenshot("10c-alert-builder-result", {selector: `${builder} .oper-alert-builder`});
	await page.click(`${builder} .btn-cancel`);
	await page.waitFor(`!document.querySelector("${builder}.opened")`, {
		label: "Cancel closes the builder",
	});
	await page.sleep(400); // the overlay fades
	// The quiet lookups: no query window opened for O3, ChanServ or AuthServ.
	page.check(
		"no query window was opened for a bot",
		(await page.evaluate(
			`Array.from(document.querySelectorAll('.channel-list-item[data-type="query"]')).map((el) => el.dataset.name).filter((n) => /^(O3|ChanServ|AuthServ)$/i.test(n ?? "")).length`
		)) === 0
	);

	// A nick in the list opens the user card on top; closing it comes back.
	const nickIndex = await page.evaluate(
		`Array.from(document.querySelectorAll("${overlay} .oper-user-nick")).findIndex((b) => b.textContent.trim() === "opbot2")`
	);
	await page.evaluate(
		`document.querySelectorAll("${overlay} .oper-user-nick")[${nickIndex}].scrollIntoView({block: "center"})`
	);
	await page.click(`${overlay} .oper-user-nick`, nickIndex);
	await page.waitFor(
		`!!document.querySelector("${overlay} .oper-investigate-user") && !!document.querySelector("${overlay} .oper-facts .oper-chip-ip")`,
		{label: "the user card on top, with the IP", timeout: 20000}
	);
	const stacked = await page.evaluate(cardFacts);
	page.check(
		`the stacked card is titled from the channel (${stacked.title})`,
		/^#seance › opbot2/.test(stacked.title)
	);
	await page.screenshot("11-user-card-stacked", {selector: `${overlay} .oper-investigate`});
	await page.click(`${overlay} .settings-modal-close`);
	await page.waitFor(`!!document.querySelector("${overlay} .oper-user-list")`, {
		label: "back on the channel card",
	});
	await page.click(`${overlay} .settings-modal-close`);
	await page.waitFor(`!document.querySelector("${overlay}.opened")`, {label: "the card closed"});
	await page.sleep(400); // the overlay fades for 0.2 s and would take the click

	// The user card from the nick menu: the facts grid, the bans, seen before.
	await openUserList(page);
	await page.click(`.userlist .user[data-name="opbot3"]`);
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-oper-investigate")`, {
		label: "Investigate in the nick menu",
	});
	await page.click("#context-menu .context-menu-oper-investigate");
	await page.waitFor(
		`!!document.querySelector("${overlay}.opened .oper-investigate-user") && !!document.querySelector("${overlay} .oper-facts .oper-chip-ip") && /No live|covers/.test(document.querySelector("${overlay} .oper-investigate-user")?.textContent ?? "")`,
		{label: "the user card with its IP and the ban list read", timeout: 25000}
	);
	const userCard = await page.evaluate(cardFacts);
	page.check(
		`the user card's facts (${userCard.facts.join(" | ")})`,
		userCard.facts.some((f) => /^Host=opbot3@/.test(f)) &&
			userCard.facts.some((f) => /^IP=172\.17\.0\.1 .*irc\.seance\.test/.test(f)) &&
			userCard.facts.some((f) => /^Realname=irc client$/.test(f)) &&
			userCard.facts.some((f) => /^Connected=\d/.test(f)) &&
			userCard.facts.some((f) => /^Channels=only #seance$/.test(f))
	);
	// Seen before: the other helper from the same address, never opbot3's
	// own connect notice.
	page.check(
		`seen before finds opbot2 from the same IP and not opbot3 themself (${userCard.seen.join(
			" | "
		)})`,
		userCard.seen.some((s) => /\bopbot2 from 172\.17\.0\.1 \(this IP\)/.test(s)) &&
			!userCard.seen.some((s) => /\bopbot3 /.test(s))
	);
	page.check(
		`the verdict names what matched (${userCard.verdict})`,
		/^Likely the same as \S+ \(\d\d:\d\d\): same IP/.test(userCard.verdict ?? "")
	);
	await page.screenshot("12-user-card", {selector: `${overlay} .oper-investigate`});

	// Compare side by side: a second column, the shared IP tinted. The offer
	// sits at the end of the scrolling body, under the footer on a phone, so
	// let every "asking…" settle (the bots' 401s) before reaching for it.
	await page.waitFor(
		`!/asking…/.test(document.querySelector("${overlay} .oper-investigate-user")?.textContent ?? "")`,
		{label: "every source answered", timeout: 30000}
	);
	// A button at the end of the body can sit in the viewport yet under the
	// footer: scroll it up until the point to click is really its own.
	const reach = async (selector) => {
		await page.waitFor(
			`(() => {
				const b = document.querySelector(${JSON.stringify(selector)});
				if (!b) return false;
				b.scrollIntoView({block: "center"});
				const r = b.getBoundingClientRect();
				return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
			})()`,
			{label: `${selector} in reach`}
		);
		await page.click(selector);
	};
	await reach(`${overlay} .oper-compare-offer .btn`);
	await page.fill(`${overlay} .oper-compare-ask input`, "opbot2");
	await reach(`${overlay} .oper-compare-ask button[type="submit"]`);
	await page.waitFor(
		`!!document.querySelector("${overlay} .oper-compare-b .oper-facts .oper-chip-ip")`,
		{label: "the compared user's IP", timeout: 20000}
	);
	const tinted = await page.evaluate(
		`Array.from(document.querySelectorAll("${overlay} .oper-compare-b .oper-facts .same dt")).map((dt) => dt.textContent.trim())`
	);
	page.check(`the matching rows are tinted (${tinted.join(", ")})`, tinted.includes("IP"));
	await page.screenshot("13-user-compare", {selector: `${overlay} .oper-investigate`});
	await page.click(`${overlay} .settings-modal-close`);
	await page.waitFor(`!document.querySelector("${overlay}.opened")`, {label: "the card closed"});
	await page.sleep(400);
	bot2.quit();
	bot3.quit();
	await Promise.all([bot2.closed, bot3.closed]);
	await page.waitFor(`!document.querySelector('.userlist .user[data-name="opbot3"]')`, {
		label: "the helpers gone from the user list",
	});

	// ------------------------------------------ G-line from a nick's menu
	await openUserList(page);
	await page.click(`.userlist .user[data-name="opvictim"]`);
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-oper-gline")`, {
		label: "the oper entries in the nick menu",
	});
	await page.screenshot("7-nick-menu");

	// With X3 set, the G-line goes through O3 — which the dev rig does not
	// have: the dialog says "via O3", offers no CIDR, and reports the
	// server's "no such nick" in plain words instead of waiting 10 s.
	await page.click("#context-menu .context-menu-oper-gline");
	// The compare card's lookups (CHECK, WHOIS, three STATS) are still being
	// charged fake lag when this is asked: the USERIP behind the suggestions
	// can take ten seconds and more to come back.
	await page.waitFor(
		`!!document.querySelector("#oper-action-dialog .oper-action-suggestions .oper-chip")`,
		{label: "mask suggestions (via O3)", timeout: 25000}
	);
	const viaTitle = await page.evaluate(
		`document.querySelector("#oper-action-dialog .oper-action-title").textContent.trim()`
	);
	page.check(`the dialog says "${viaTitle}"`, viaTitle === "G-line opvictim via O3");
	const viaChips = await page.evaluate(
		`Array.from(document.querySelectorAll("#oper-action-dialog .oper-action-suggestions .oper-chip")).map((b) => b.textContent.trim())`
	);
	page.check(
		`no CIDR mask is offered via O3 (${viaChips.join(", ")})`,
		viaChips.length > 0 && viaChips.every((m) => !/\/\d+$/.test(m))
	);
	page.check(
		"no scope and no force via O3",
		(await page.evaluate(
			`document.querySelectorAll("#oper-action-scope, #oper-action-dialog .oper-action-check").length`
		)) === 0
	);
	await page.fill("#oper-action-reason", "oper-tools scenario");
	await page.click(`#oper-action-dialog button[type="submit"]`);
	await page.waitFor(
		`/O3 is not online/.test(document.querySelector("#oper-action-dialog .oper-action-error")?.textContent ?? "")`,
		{label: "O3's absence reported in the dialog", timeout: 10000}
	);
	await page.screenshot("7b-gline-via-o3", {selector: "#oper-action-dialog"});
	await page.click("#oper-action-dialog .btn-cancel");
	await page.waitFor(`!document.querySelector("#oper-action-dialog")`, {
		label: "the dialog closes",
	});

	// Services support back to None, so the server path below is what is tested.
	await openEditForm();
	await page.evaluate(`(() => {
		const select = document.querySelector("#connect\\\\:servicesPackage");
		select.value = "";
		select.dispatchEvent(new Event("change", {bubbles: true}));
	})()`);
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(
		`JSON.parse(localStorage.getItem("thelounge.networks") ?? "[]")[0]?.services === undefined`,
		{label: "the services block removed"}
	);
	await closeSettings();

	await openUserList(page);
	await page.click(`.userlist .user[data-name="opvictim"]`);
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-oper-gline")`, {
		label: "the nick menu again",
	});
	await page.click("#context-menu .context-menu-oper-gline");
	await page.waitFor(
		`!!document.querySelector("#oper-action-dialog .oper-action-suggestions .oper-chip")`,
		{
			label: "mask suggestions from USERIP/USERHOST",
			timeout: 10000,
		}
	);
	page.check(
		"the dialog is the server's again",
		!/via O3/.test(
			await page.evaluate(
				`document.querySelector("#oper-action-dialog .oper-action-title").textContent`
			)
		)
	);
	// The ident@IP mask: `*@<ip>` would ban every client of the dev rig.
	await page.evaluate(
		`Array.from(document.querySelectorAll("#oper-action-dialog .oper-action-suggestions .oper-chip")).find((b) => b.textContent.trim().startsWith("opvictim@")).click()`
	);
	await page.waitFor(
		`/Matches 1 user: opvictim/.test(document.querySelector("#oper-action-dialog .oper-action-preview")?.textContent ?? "")`,
		{
			label: "the preview names the one user it hits",
			timeout: 10000,
		}
	);
	await page.fill("#oper-action-reason", "oper-tools scenario");
	await page.screenshot("8-gline-dialog", {selector: "#oper-action-dialog"});
	await page.click(`#oper-action-dialog button[type="submit"]`);
	await page.waitFor(
		`/G-line set/.test(document.querySelector("#oper-action-dialog .oper-action-result")?.textContent ?? "")`,
		{
			label: "the G-line confirmed by listing it back",
			timeout: 15000,
		}
	);
	await victim.closed;
	page.check("the G-lined user was disconnected", true);
	await page.waitFor(`!document.querySelector("#oper-action-dialog")`, {
		label: "the dialog closes",
		timeout: 5000,
	});
	await cleanup();

	// -------------------------------------------------- KILL from the menu
	const target = helper("opkillme");
	await target.ready;
	await openUserList(page);
	await page.waitFor(`!!document.querySelector('.userlist .user[data-name="opkillme"]')`, {
		label: "opkillme in the user list",
	});
	await page.click(`.userlist .user[data-name="opkillme"]`);
	await page.waitFor(`!!document.querySelector("#context-menu .context-menu-oper-kill")`, {
		label: "the kill entry",
	});
	await page.click("#context-menu .context-menu-oper-kill");
	await page.waitFor(`!!document.querySelector("#oper-action-reason")`, {
		label: "the kill dialog",
	});
	await page.fill("#oper-action-reason", "oper-tools scenario");
	await page.click(`#oper-action-dialog button[type="submit"]`);
	await page.waitFor(
		`/Killed opkillme/.test(document.querySelector("#oper-action-dialog .oper-action-result")?.textContent ?? "")`,
		{
			label: "the kill reported",
			timeout: 10000,
		}
	);
	await target.closed;
	page.check("the killed user was disconnected", true);
	await page.waitFor(`${msgs("snotice")}.some((m) => m.textContent.includes("opkillme"))`, {
		label: "the kill notice in the channel",
		timeout: 10000,
	});

	// ------------------------------------------ notices survive a reload
	await page.sleep(1500); // the notice log writes a second after the last line
	await page.goto(page.url, {waitForSelector: "#app"});
	await page.waitFor(`document.querySelector('.channel-list-item[data-type="lobby"]')`, {
		label: "the network after the reload",
		timeout: 20000,
	});
	// The reload lands on the last conversation first (helpers/lastChannel.ts).
	await page.waitFor(
		`!!document.querySelector('.channel-list-item[data-name="${CHANNEL}"].active')`,
		{
			label: "the landing on the channel",
			timeout: 20000,
		}
	);
	await page.sleep(500);
	if (MOBILE) {
		await page.click("#viewport .lt");
		await page.sleep(400);
	}
	await page.click(`.channel-list-item[data-type="lobby"] .name`);
	await page.waitFor(`!!document.querySelector('.channel-list-item[data-type="lobby"].active')`, {
		label: "the lobby open",
	});
	await page.waitFor(`${msgs("snotice")}.some((m) => m.textContent.includes("opkillme"))`, {
		label: "the kept notices back in the lobby",
		timeout: 15000,
	});
	await page.screenshot("9-lobby-after-reload", {selector: "#chat"});

	page.check(
		`no console errors (${page.consoleErrors.join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
