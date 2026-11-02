// Do not disturb and per-network presence (docs/projects/do-not-disturb.md):
// the pill under the logo and its menu, the lobby row's presence dot and its
// four modes, and the AWAY * / AWAY lines they send; that a network in do not
// disturb raises no browser notification and no sound for a highlight while
// one out of it does; and that the pill keeps its whole label inside the
// narrowest sidebar. No account on the dev ircd, so the METADATA writes are
// not exercised here (test/irc/pushMute.ts covers them).
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/dnd.mjs
//   node tools/browser-drive.mjs tools/scenarios/dnd.mjs --mobile --width=390 --height=844
//
// Needs a plain-WS ircd on 127.0.0.1:8067 (the dev ircd's ws:// port); a
// helper connection joins #seance there to send the highlights.

const RUN = Date.now().toString(36);
const NICK = `dndpresence${RUN.slice(-4)}`; // 15 characters, nefarious2's NICKLEN
const BOT = `dndbot${RUN.slice(-5)}`;
const BASE = process.env.SEANCE_URL ?? "http://localhost:8001/";
const IRCD = process.env.SEANCE_IRC_WS ?? "ws://127.0.0.1:8067/";
const IRCD_PORT = Number(new URL(IRCD).port || 8067);
export const url = `${BASE}?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=%23seance`;

const LOBBY = '.channel-list-item[data-type="lobby"]';
const PILL = "#sidebar .presence-pill";
const DOT = `${LOBBY} .lobby-presence .presence-dot`;
const MENU = "#context-menu";
const MENU_ITEM = (cls) => `${MENU} .context-menu-${cls}`;

const outgoing = (page) =>
	page.wsFrames.filter((f) => f.dir === "out").map((f) => String(f.payloadData));
const awayLines = (page) => outgoing(page).filter((l) => /^AWAY( |$)/.test(l));

/** Counts what the page would show or play (client/js/socket-events/msg.ts
 * notifyMessage): a `new Notification`, a "notification" message posted to
 * the service worker (the path a page with a worker takes), and every
 * `play()` of an audio element (the pop). */
const SPIES = `(() => {
	window.__dnd = {notifications: 0, plays: 0};
	if ("Notification" in window) {
		const Real = window.Notification;
		const Spy = function (...args) {
			window.__dnd.notifications++;
			return new Real(...args);
		};
		Spy.prototype = Real.prototype;
		Object.defineProperty(Spy, "permission", {get: () => Real.permission});
		Spy.requestPermission = (...a) => Real.requestPermission(...a);
		window.Notification = Spy;
	}
	if (typeof ServiceWorker !== "undefined") {
		const post = ServiceWorker.prototype.postMessage;
		ServiceWorker.prototype.postMessage = function (data, ...rest) {
			if (data && data.type === "notification") window.__dnd.notifications++;
			return post.call(this, data, ...rest);
		};
	}
	const play = HTMLMediaElement.prototype.play;
	HTMLMediaElement.prototype.play = function (...a) {
		window.__dnd.plays++;
		return play.apply(this, a).catch(() => undefined);
	};
})();`;

/** A second IRC connection, joined to #seance, that says what it is told. */
function helper() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
		const send = (line) => ws.send(line);
		const timer = setTimeout(() => reject(new Error("the helper did not join #seance")), 15000);

		ws.onopen = () => {
			send("CAP LS 302");
			send(`NICK ${BOT}`);
			send(`USER ${BOT} 0 * :seance dnd check`);
		};

		ws.onmessage = (ev) => {
			const line = String(ev.data);

			if (line.startsWith("PING")) {
				send(`PONG${line.slice(4)}`);
				return;
			}

			const rest = line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line;
			const params = rest.split(" ");

			if (params[1] === "CAP" && params[3] === "LS" && params[4] !== "*") {
				send("CAP END");
			} else if (params[1] === "001") {
				send("JOIN #seance");
			} else if (params[0].startsWith(`:${BOT}!`) && params[1] === "JOIN") {
				clearTimeout(timer);
				resolve({
					say: (text) => send(`PRIVMSG #seance :${text}`),
					quit: () => {
						send("QUIT :done");
						setTimeout(() => ws.close(), 200);
					},
				});
			}
		};

		ws.onerror = () => reject(new Error(`the helper could not reach ${IRCD}`));
	});
}

export default async function run(page) {
	const mobile = page.flags.has("--mobile");

	/** A finger's tap on a touch device, a mouse click elsewhere. */
	const press = async (selector) => {
		if (!mobile) {
			await page.click(selector);
			return;
		}

		const r = await page.rect(selector);
		const touch = [{x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1}];
		await page.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: touch});
		await page.sleep(60);
		await page.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
		await page.sleep(250);
	};

	/** The phone layout's sidebar is a drawer: open it before touching it. */
	const openDrawer = async () => {
		if (mobile && !(await page.evaluate(`!!document.querySelector("#viewport.menu-open")`))) {
			await press("#viewport .lt");
			await page.waitFor(`document.querySelector("#viewport.menu-open")`, {
				label: "the drawer open",
			});
			await page.sleep(400); // the slide
		}
	};

	/** Open a menu from `opener`, pick `cls`, and wait for the menu to go. */
	const choose = async (opener, cls) => {
		await openDrawer();
		await press(opener);
		await page.waitFor(`document.querySelector('${MENU_ITEM(cls)}')`, {
			label: `menu item ${cls}`,
		});
		await press(MENU_ITEM(cls));
		await page.waitFor(`!document.querySelector('${MENU}')`, {label: "the menu to close"});
	};

	const counts = () => page.evaluate(`({...window.__dnd})`);

	const bot = await helper();

	try {
		await body();
	} finally {
		bot.quit();
	}

	async function body() {
		await page.grantPermissions(["notifications"], new URL(BASE).origin);
		await page.addInitScript(SPIES);

		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.click("#connect button[type=submit]");
		await page.waitFor(
			`document.querySelector('${LOBBY} .connection-status-icon.is-connected')`,
			{
				timeout: 30000,
				label: "connected",
			}
		);
		await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
			label: "#seance joined",
		});
		await openDrawer();

		// ---- The pill and the dot at rest.
		page.check(
			"the pill is under the logo",
			(await page.count("#sidebar .logo-container .presence-pill")) === 1
		);
		const pillText = await page.evaluate(
			`document.querySelector('${PILL}').textContent.trim()`
		);
		page.check(
			`the pill starts on the global mode Auto (${pillText})`,
			/^Auto$/.test(pillText)
		);
		page.check("the dot starts green", (await page.count(`${DOT}.is-online`)) === 1);

		const geometry = await page.evaluate(`(() => {
		const r = (s) => document.querySelector(s).getBoundingClientRect();
		const logo = r("#sidebar .logo-container"), pill = r(${JSON.stringify(PILL)});
		const dot = r(${JSON.stringify(DOT)}), nick = r(${JSON.stringify(`${LOBBY} .lobby-nick`)});
		const row = r(${JSON.stringify(LOBBY)});
		return {
			pillOffset: (pill.left + pill.right) / 2 - (logo.left + logo.right) / 2,
			dotOffset: (dot.top + dot.bottom) / 2 - (nick.top + nick.bottom) / 2,
			// The hit box overlaps the nick on purpose; the visible 0.5rem
			// dot at its centre must not.
			dotBeforeNick:
				(dot.left + dot.right) / 2 +
					parseFloat(getComputedStyle(document.documentElement).fontSize) / 4 <=
				nick.left + 0.5,
			nickInside: nick.right <= row.right + 0.5,
			nickShown: nick.width,
			nickEllipsis:
				getComputedStyle(document.querySelector(${JSON.stringify(`${LOBBY} .lobby-nick`)}))
					.textOverflow === "ellipsis",
		};
	})()`);
		page.check(
			`the pill is centred under the logo (${geometry.pillOffset.toFixed(1)}px off)`,
			Math.abs(geometry.pillOffset) <= 1.5
		);
		page.check(
			`the dot is level with the nick (${geometry.dotOffset.toFixed(1)}px off)`,
			Math.abs(geometry.dotOffset) <= 1.5
		);
		page.check("the dot stands before the nick", geometry.dotBeforeNick);
		page.check("the nick stays inside the row", geometry.nickInside);
		page.check(
			`a long nick trims with an ellipsis (${geometry.nickShown.toFixed(0)}px shown)`,
			geometry.nickEllipsis && geometry.nickShown > 0
		);

		// ---- A highlight out of do not disturb: notified and played. A
		// highlight in the open conversation of a focused page notifies nothing
		// anyway, so the lobby is opened first.
		await press(`${LOBBY} .lobby-title .name`);
		await page.waitFor(`document.querySelector('${LOBBY}.active')`, {label: "the lobby open"});
		await openDrawer();
		const quiet = await counts();
		bot.say(`${NICK}: first, out of do not disturb`);
		await page
			.waitFor(`window.__dnd.notifications > ${quiet.notifications}`, {
				label: "a notification for the highlight",
			})
			.catch(() => undefined);
		const loud = await counts();
		page.check(
			`a highlight out of DND notifies (${loud.notifications - quiet.notifications})`,
			loud.notifications === quiet.notifications + 1
		);
		page.check(
			`a highlight out of DND plays the pop (${loud.plays - quiet.plays})`,
			loud.plays > quiet.plays
		);

		// ---- Global DND, indefinite.
		const before = awayLines(page).length;
		await choose(PILL, "dnd-indefinite");
		await page.waitFor(`document.querySelector('${PILL}.is-dnd')`, {label: "pill in DND"});
		page.check("the dot turns red", (await page.count(`${DOT}.is-dnd`)) === 1);
		await page.sleep(500);
		page.check("DND sent AWAY *", awayLines(page).slice(before).includes("AWAY *"));
		await openDrawer();
		await page.screenshot("dnd-on", {selector: "#sidebar"});

		const mid = await counts();
		bot.say(`${NICK}: second, in do not disturb`);
		const deadline = Date.now() + 10000;

		while (
			!page.wsFrames.some(
				(f) => f.dir === "in" && String(f.payloadData).includes("second, in do")
			)
		) {
			if (Date.now() > deadline) {
				throw new Error("the DND highlight never reached the page");
			}

			await page.sleep(100);
		}

		await page.sleep(800);
		const after = await counts();
		page.check(
			`a highlight in DND notifies nothing (${after.notifications - mid.notifications})`,
			after.notifications === mid.notifications
		);
		page.check(
			`a highlight in DND plays nothing (${after.plays - mid.plays})`,
			after.plays === mid.plays
		);

		// ---- Off.
		await choose(PILL, "status-auto");
		await page.waitFor(`!document.querySelector('${PILL}.is-dnd')`, {label: "pill off"});
		await page.sleep(500);
		page.check("Off sent AWAY", awayLines(page).at(-1) === "AWAY");
		page.check("the dot is green again", (await page.count(`${DOT}.is-online`)) === 1);

		// ---- The global mode (docs/projects/shared-presence-modes.md § 2).
		const pillNowText = () =>
			page.evaluate(`document.querySelector('${PILL}').textContent.trim()`);
		const dotTitle = () =>
			page.evaluate(`document.querySelector('${DOT}').getAttribute("title")`);
		page.check(
			`a network starts on Same as global (${await dotTitle()})`,
			(await dotTitle()) === "Auto · global"
		);
		await choose(PILL, "status-away");
		await page.sleep(500);
		page.check(
			`global Away: the pill reads Away (${await pillNowText()})`,
			/^Away/.test(await pillNowText())
		);
		page.check("global Away sent AWAY *", awayLines(page).at(-1) === "AWAY *");
		page.check(
			`global Away: the dot reads Away · global (${await dotTitle()})`,
			(await dotTitle()) === "Away · global"
		);
		await choose(DOT, "presence-online");
		await page.sleep(500);
		page.check(
			`its own Online overrides it (${await dotTitle()})`,
			(await dotTitle()) === "Online"
		);
		page.check("its own Online sent AWAY", awayLines(page).at(-1) === "AWAY");
		await choose(DOT, "presence-global");
		await page.sleep(300);
		await choose(PILL, "status-online");
		await page.sleep(500);
		page.check(`global Online (${await dotTitle()})`, (await dotTitle()) === "Online · global");
		await choose(PILL, "status-auto");
		await page.sleep(500);
		page.check(
			`global Auto: the pill reads Auto (${await pillNowText()})`,
			/^Auto/.test(await pillNowText())
		);
		// Auto with nobody looking: the networks following it are away, and so
		// is the pill's dot (spec § 2: "Auto green, or amber while this
		// device is unattended").
		await page.evaluate(`(() => {
			Object.defineProperty(document, "visibilityState", {configurable: true, get: () => "hidden"});
			Object.defineProperty(document, "hidden", {configurable: true, get: () => true});
			window.dispatchEvent(new Event("blur"));
			document.dispatchEvent(new Event("visibilitychange"));
		})()`);
		await page.sleep(500);
		page.check(
			"global Auto, unattended: the pill's dot is amber",
			(await page.count(`${PILL} .presence-dot.is-away`)) === 1
		);
		await page.evaluate(`(() => {
			delete document.visibilityState;
			delete document.hidden;
			document.dispatchEvent(new Event("visibilitychange"));
			window.dispatchEvent(new Event("focus"));
		})()`);
		await page.sleep(500);
		page.check(
			"global Auto, attended again: the pill's dot is green",
			(await page.count(`${PILL} .presence-dot.is-online`)) === 1
		);

		// ---- The dot: no navigation, no drag, its own context menu. With a
		// channel open, so a click that reached the lobby row would move the view.
		await openDrawer();
		await press('.channel-list-item[data-name="#seance"]');
		await page.waitFor(
			`document.querySelector('.channel-list-item[data-name="#seance"].active')`,
			{
				label: "#seance open again",
			}
		);
		await openDrawer();
		const hash = await page.evaluate("location.hash");

		if (!mobile) {
			const r = await page.rect(DOT);
			const x = r.x + r.width / 2;
			const y = r.y + r.height / 2;
			await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", x, y});
			await page.send("Input.dispatchMouseEvent", {
				type: "mousePressed",
				x,
				y,
				button: "left",
				buttons: 1,
				clickCount: 1,
			});

			for (let step = 1; step <= 6; step++) {
				await page.send("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x,
					y: y + step * 8,
					buttons: 1,
				});
				await page.sleep(30);
			}

			const dragging = await page.count(
				"#sidebar .sortable-chosen, #sidebar .ui-sortable-ghost, .ui-sortable-dragging"
			);
			await page.send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x,
				y: y + 48,
				button: "left",
				buttons: 0,
				clickCount: 1,
			});
			page.check(`a press and drag on the dot starts no drag (${dragging})`, dragging === 0);
			await page.evaluate(
				`document.querySelector('${MENU}') && document.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}))`
			);
			await page.sleep(200);

			// A right-click: the presence menu, not the lobby's own.
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
			await page.waitFor(`document.querySelector('${MENU}')`, {
				label: "a menu on right-click",
			});
			page.check(
				"a right-click on the dot opens the presence menu",
				(await page.count(`${MENU} [class*="context-menu-presence-"]`)) === 5 // Same as global and the four modes
			);
			page.check(
				"and not the lobby's menu",
				(await page.count(`${MENU} .context-menu-edit, ${MENU} .context-menu-list`)) === 0
			);
			await page.click(MENU_ITEM("presence-global")); // the current mode: closes it
			await page.waitFor(`!document.querySelector('${MENU}')`, {label: "the menu to close"});
		}

		// ---- Per-network Away, then Online.
		await choose(DOT, "presence-away");
		await page.waitFor(`document.querySelector('${DOT}.is-away')`, {label: "dot amber"});
		page.check(
			`a click on the dot leaves the route alone (${hash})`,
			(await page.evaluate("location.hash")) === hash
		);
		await page.sleep(500);
		page.check("Away sent AWAY *", awayLines(page).at(-1) === "AWAY *");
		const awayPill = await page.evaluate(
			`document.querySelector('${PILL}').textContent.trim()`
		);
		page.check(
			`a network's own Away: the pill keeps the global mode, Auto (${awayPill})`,
			awayPill === "Auto"
		);
		await choose(DOT, "presence-online");
		await page.waitFor(`document.querySelector('${DOT}.is-online')`, {label: "dot green"});
		await page.sleep(500);
		page.check("Online sent AWAY", awayLines(page).at(-1) === "AWAY");
		page.check(
			`its own Online: the dot reads Online (${await dotTitle()})`,
			(await dotTitle()) === "Online"
		);

		// ---- The mode is saved on the network entry.
		await choose(DOT, "presence-dnd");
		await page.waitFor(`document.querySelector('${DOT}.is-dnd')`, {label: "dot red"});
		const stored = await page.evaluate(
			`JSON.parse(localStorage.getItem("thelounge.networks") || "[]").some((n) => n.presenceMode === "dnd")`
		);
		page.check("the dnd mode is saved", stored === true);
		await page.sleep(500);
		page.check("the network's DND sent AWAY *", awayLines(page).at(-1) === "AWAY *");

		// A network in mode dnd, the global switch off: the pill keeps the
		// global mode (it no longer sums the networks) and ticks it.
		await openDrawer();
		await press(PILL);
		await page.waitFor(`document.querySelector('${MENU_ITEM("status-auto")}')`, {
			label: "the pill menu",
		});
		const globalTicks = await page.evaluate(
			`[...document.querySelectorAll('${MENU} [aria-checked="true"]')].map((e) => e.textContent.trim())`
		);
		const pillNow = await page.evaluate(`document.querySelector('${PILL}').textContent.trim()`);
		page.check(
			`a network in mode dnd: the pill keeps Auto, and only Auto is ticked (${pillNow}; ticked ${JSON.stringify(
				globalTicks
			)})`,
			pillNow === "Auto" && JSON.stringify(globalTicks) === JSON.stringify(["Auto"])
		);

		// A menu opened over another: the first trigger is told it closed.
		await page.evaluate(
			`document.querySelector('${DOT}').dispatchEvent(new MouseEvent("contextmenu", {bubbles: true, cancelable: true, clientX: 40, clientY: 40}))`
		);
		await page.waitFor(`document.querySelector('${MENU_ITEM("presence-auto")}')`, {
			label: "the dot menu over the pill menu",
		});
		const expanded = await page.evaluate(
			`[document.querySelector('${PILL}').getAttribute("aria-expanded"), document.querySelector('${DOT}').getAttribute("aria-expanded")]`
		);
		page.check(
			`a menu opened over another moves aria-expanded (pill ${expanded[0]}, dot ${expanded[1]})`,
			expanded[0] === "false" && expanded[1] === "true"
		);
		await press(MENU_ITEM("presence-auto"));
		await page.waitFor(`!document.querySelector('${MENU}')`, {label: "the menu to close"});
		page.check(
			"the menu closed: the dot's aria-expanded is false again",
			(await page.evaluate(
				`document.querySelector('${DOT}').getAttribute("aria-expanded")`
			)) === "false"
		);
		await page.waitFor(`document.querySelector('${DOT}.is-online')`, {
			label: "dot back to auto",
		});

		// ---- Follow schedule with no days: unticked, and a click turns it on.
		const dndWas = await page.evaluate(`localStorage.getItem("thelounge.dnd")`);
		await page.evaluate(`(() => {
			const s = JSON.parse(localStorage.getItem("thelounge.dnd") || "null") ?? {manual: {kind: "off"}, scheduleSkippedUntil: null};
			s.schedule = {enabled: true, start: "23:00", end: "07:00", days: []};
			const v = JSON.stringify(s);
			localStorage.setItem("thelounge.dnd", v);
			window.dispatchEvent(new StorageEvent("storage", {key: "thelounge.dnd", newValue: v}));
		})()`);
		await openDrawer();
		await press(PILL);
		await page.waitFor(`document.querySelector('${MENU_ITEM("dnd-schedule")}')`, {
			label: "the schedule item",
		});
		const noDays = await page.evaluate(
			`document.querySelector('${MENU_ITEM("dnd-schedule")}').getAttribute("aria-checked")`
		);
		await press(MENU_ITEM("dnd-schedule"));
		await page.waitFor(`!document.querySelector('${MENU}')`, {label: "the menu to close"});
		const afterClick = await page.evaluate(
			`JSON.parse(localStorage.getItem("thelounge.dnd")).schedule.enabled`
		);
		page.check(
			`Follow schedule with no days: unticked (${noDays}), and the click keeps it on (${afterClick})`,
			noDays === "false" && afterClick === true
		);
		await page.evaluate(`(() => {
			const v = ${JSON.stringify(dndWas)};
			if (v === null) localStorage.removeItem("thelounge.dnd"); else localStorage.setItem("thelounge.dnd", v);
			window.dispatchEvent(new StorageEvent("storage", {key: "thelounge.dnd", newValue: v}));
		})()`);
		await page.waitFor(`document.querySelector('${DOT}.is-online')`, {
			label: "dot back to auto",
		});

		// ---- The narrowest sidebar: the huge step, the longest label.
		const step = await page.evaluate(`document.documentElement.dataset.fontSize ?? ""`);
		await page.evaluate(`document.documentElement.dataset.fontSize = "huge"`);
		await choose(PILL, "dnd-1h");
		await page.waitFor(`document.querySelector('${PILL}.is-dnd')`, {
			label: "pill in DND for 1 h",
		});
		await openDrawer();
		await page.sleep(300);
		const huge = await page.evaluate(`(() => {
		const sidebar = document.getElementById("sidebar");
		const probe = document.createElement("div");
		probe.style.cssText = "position:absolute;visibility:hidden;width:var(--sidebar-width)";
		sidebar.parentElement.appendChild(probe);
		const allowed = probe.getBoundingClientRect().width;
		probe.remove();
		const text = document.querySelector(${JSON.stringify(`${PILL} .presence-pill-text`)});
		const pill = document.querySelector(${JSON.stringify(PILL)}).getBoundingClientRect();
		const side = sidebar.getBoundingClientRect();
		const nick = document.querySelector(${JSON.stringify(`${LOBBY} .lobby-nick`)});
		return {
			label: text.textContent.trim(),
			whole: text.scrollHeight <= text.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1,
			lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)),
			width: side.width,
			allowed,
			pillInside: pill.left >= side.left - 0.5 && pill.right <= side.right + 0.5,
			nickWidth: nick.getBoundingClientRect().width,
			dotShown: document.querySelector(${JSON.stringify(
				DOT
			)}).getBoundingClientRect().right <= side.right + 0.5,
		};
	})()`);
		page.check(
			`at the huge step the pill's label is whole (${huge.label}, ${huge.lines} line(s))`,
			huge.whole
		);
		page.check(
			`the sidebar is no wider than --sidebar-width (${huge.width.toFixed(
				1
			)} ≤ ${huge.allowed.toFixed(1)})`,
			huge.width <= huge.allowed + 0.5
		);
		page.check("the pill stays inside the sidebar", huge.pillInside);
		// The tools never shrink (network-panel.mjs), so at this step the nick
		// can be trimmed to nothing; the dot must still be on screen.
		page.check(
			`the dot stays inside the sidebar (nick ${huge.nickWidth.toFixed(0)}px)`,
			huge.dotShown
		);
		await page.screenshot("dnd-huge", {selector: "#sidebar"});
		await choose(PILL, "status-auto");
		await page.evaluate(`document.documentElement.dataset.fontSize = ${JSON.stringify(step)}`);

		// ---- The schedule's window in the menu follows the clock setting.
		const scheduleText = async () => {
			await openDrawer();
			await press(PILL);
			await page.waitFor(`document.querySelector('${MENU_ITEM("dnd-schedule")}')`, {
				label: "the schedule item",
			});
			const raw = await page.evaluate(
				`document.querySelector('${MENU_ITEM("dnd-schedule")}').textContent.trim()`
			);
			// The range never breaks: no-break spaces in a time, word joiners at its dash.
			page.check(
				`the schedule's range holds together (${JSON.stringify(raw)})`,
				/\u2060–\u2060/.test(raw) && !/\d [AP]M/.test(raw)
			);
			const text = raw.replace(/\u2060/g, "").replace(/\u00a0/g, " ");
			// Off closes it and changes nothing here (DND is off by now).
			await press(MENU_ITEM("status-auto"));
			await page.waitFor(`!document.querySelector('${MENU}')`, {label: "the menu to close"});
			return text;
		};
		const setClock = (on) =>
			page.evaluate(`(() => {
			const root = document.querySelector("[data-v-app]");
			const store = root.__vue_app__.config.globalProperties.$store;
			return store.dispatch("settings/update", {name: "use12hClock", value: ${on}, sync: true});
		})()`);
		const clockWas = await page.evaluate(`(() => {
		const root = document.querySelector("[data-v-app]");
		return !!root.__vue_app__.config.globalProperties.$store.state.settings.use12hClock;
	})()`);
		await setClock(false);
		const in24 = await scheduleText();
		await setClock(true);
		const in12 = await scheduleText();
		await setClock(clockWas);
		page.check(
			`the schedule's window follows the clock (${in24} / ${in12})`,
			in24.includes("23:00–07:00") && in12.includes("11:00 PM–7:00 AM")
		);

		page.check("no console errors", page.consoleErrors.length === 0);
	}
}
