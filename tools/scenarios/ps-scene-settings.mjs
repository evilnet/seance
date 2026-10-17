// The ps theme's own settings (Settings → Appearance, shown under the theme
// select while ps is the theme): Scene animation (auto, full, calm,
// still), Pause the scene when
// the window isn't in use, and Combine messages from the same person.
//
//   NODE_ENV=production corepack yarn build && python3 -m http.server -d public 8006 &
//   node tools/browser-drive.mjs tools/scenarios/ps-scene-settings.mjs
//
// Needs the dev ircd (a second user says two lines). Pins a clear noon on
// 25 September with a Date shim, so the scene is the same every run. Each
// level is read off the motion classes on `#theme-scene.psng` (psng/groups.ts):
// Full is every group's `psng-m-<group>`, Calm is `psng-calm` with only
// calm's groups (clouds, smoke, weather, skeins, sun), Still is no `psng-m-`
// class at all.

const IRCD = process.env.SEANCE_IRC_URL ?? "ws://127.0.0.1:8067/";
const PORT = process.env.SEANCE_PORT ?? "8006";
const RUN = Math.random().toString(36).slice(2, 6);
const CHANNEL = `#set${RUN}`;
const NICK = `set${RUN}`;
const AT = Date.UTC(2026, 8, 25, 12, 30);
const ircd = new URL(IRCD);

export const url =
	`http://localhost:${PORT}/?host=${ircd.hostname}&port=${ircd.port}&tls=false&nick=${NICK}` +
	`&join=${encodeURIComponent(CHANNEL)}`;
export const sceneRest = true;

function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};
	ws.onopen = () => {
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :${nick}`);
	};
	ws.onmessage = (ev) => {
		const line = String(ev.data);
		if (line.startsWith("PING")) return ws.send(`PONG${line.slice(4)}`);
		const p = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");
		if (p[1] === "001") ws.send(`JOIN ${CHANNEL}`);
		else if (p[1] === "JOIN" && p[0].startsWith(`:${nick}`)) onJoin();
	};
	return {
		joined: new Promise((r) => (onJoin = r)),
		say: (t) => ws.send(`PRIVMSG ${CHANNEL} :${t}`),
		quit: () => ws.send("QUIT"),
	};
}

const ALL = [
	"clouds",
	"stars",
	"fireflies",
	"smoke",
	"grass",
	"weather",
	"skeins",
	"daybirds",
	"sun",
];
const CALM = ["clouds", "smoke", "weather", "skeins", "sun"];

/** The scene root's motion classes: its groups (sorted), `psng-calm` and `psng-frozen`. */
const motion = (page) =>
	page.evaluate(`(() => {
		const c = document.querySelector("#theme-scene").classList;
		return {
			ng: c.contains("psng"),
			groups: [...c].filter((n) => n.startsWith("psng-m-")).map((n) => n.slice(7)).sort().join(","),
			calm: c.contains("psng-calm"),
			frozen: c.contains("psng-frozen"),
		};
	})()`);

const sorted = (list) => [...list].sort().join(",");

const SETTING = (name) => `document.querySelector('#settings [name="${name}"]')`;

async function openAppearance(page) {
	await page.evaluate(`location.hash = "#/settings/appearance"`);
	await page.waitFor(`document.querySelector("#theme-select")`, {label: "Appearance"});
}

async function closeSettings(page) {
	await page.click("#settings .settings-modal-done");
	await page.waitFor(`!document.querySelector("#theme-select")`, {label: "settings closed"});
}

async function setLevel(page, level) {
	await openAppearance(page);
	await page.click(`#settings input[name="psAnimation"][value="${level}"]`);
	await closeSettings(page);
	await page.sleep(1500);
}

export default async function run(page) {
	await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/GMT"});
	await page.send("Emulation.setFocusEmulationEnabled", {enabled: true});
	await page.addInitScript(`try { localStorage.setItem("settings", JSON.stringify({theme: "ps"})); } catch (e) {}
		(() => { const R = Date, off = ${AT} - R.now(); function S(...a){ if (!new.target) return R(); return a.length ? new R(...a) : new R(R.now() + off); }
		S.prototype = R.prototype; S.now = () => R.now() + off; S.UTC = R.UTC; S.parse = R.parse; window.Date = S; })();`);
	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
	});
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);

	// The section is there under ps, with its defaults.
	await openAppearance(page);
	const defaults = await page.evaluate(`JSON.stringify({
		level: document.querySelector('#settings [name="psAnimation"]:checked')?.value,
		pause: ${SETTING("psPauseWhenAway")}?.checked,
		group: ${SETTING("psGroupMessages")}?.checked,
		levels: [...document.querySelectorAll('#settings [name="psAnimation"]')].map((i) => i.value),
	})`);
	const d = JSON.parse(defaults);
	page.check(
		`under ps, Appearance has the theme's settings: Scene animation ${d.levels.join("/")} at ${
			d.level
		}, pause when away ${d.pause}, combine ${d.group}`,
		d.levels.join() === "auto,full,calm,still" &&
			d.level === "auto" &&
			d.pause === true &&
			d.group === true
	);
	await page.evaluate(`document.querySelector("#theme-select").scrollIntoView({block: "start"})`);
	await page.sleep(200);
	await page.screenshot("ps-settings-section");
	await closeSettings(page);

	// Each level, by the scene's motion classes.
	const at = {};
	for (const level of ["still", "calm", "full"]) {
		await setLevel(page, level);
		at[level] = await motion(page);
	}
	page.check(
		`still: no psng-m- class (${at.still.groups || "none"}, psng-calm ${at.still.calm})`,
		at.still.ng && at.still.groups === "" && !at.still.calm
	);
	page.check(
		`calm: psng-calm with only calm's groups (${at.calm.groups})`,
		at.calm.ng && at.calm.calm && at.calm.groups === sorted(CALM)
	);
	page.check(
		`full: every group of the moment, no psng-calm (${at.full.groups})`,
		at.full.ng && !at.full.calm && at.full.groups === sorted(ALL)
	);

	// Pause when away, off: a window without the focus keeps moving.
	await setLevel(page, "full");
	await openAppearance(page);
	await page.click(`#settings input[name="psPauseWhenAway"]`);
	await closeSettings(page);
	await page.evaluate(`window.dispatchEvent(new Event("blur"))`);
	await page.sleep(16000);
	const away = await motion(page);
	page.check(
		`pause when away off: a window without the focus still moves (${away.groups}, psng-frozen ${away.frozen})`,
		away.groups === sorted(ALL) && !away.frozen
	);
	await page.evaluate(`window.dispatchEvent(new Event("focus"))`);

	// Combine messages: on, the second of two lines is a continuation; off, it is not.
	const peer = speaker(`peer${RUN}`);
	await peer.joined;
	peer.say(`one of two ${RUN}`);
	peer.say(`two of two ${RUN}`);
	const SECOND = `[...document.querySelectorAll("#chat .msg")].find((m) => m.textContent.includes("two of two ${RUN}"))`;
	await page.waitFor(`${SECOND} !== undefined`, {label: "the two lines"});
	await page.sleep(300);
	const grouped = await page.evaluate(
		`${SECOND}.classList.contains("previous-source") && getComputedStyle(${SECOND}.querySelector(".from")).display`
	);
	page.check(`combine on: the second line shows no nick (${grouped})`, grouped === "none");
	await openAppearance(page);
	await page.click(`#settings input[name="psGroupMessages"]`);
	await closeSettings(page);
	await page.sleep(300);
	const apart = await page.evaluate(
		`${SECOND}.classList.contains("previous-source") + " " + getComputedStyle(${SECOND}.querySelector(".from")).display`
	);
	page.check(
		`combine off: every line shows its nick and time (${apart})`,
		apart === "false block"
	);
	await page.screenshot("ps-settings-combine-off");
	peer.quit();

	// Under another theme the section is not there.
	await openAppearance(page);
	await page.evaluate(
		`(() => { const s = document.querySelector("#theme-select"); s.value = "coffee"; s.dispatchEvent(new Event("change", {bubbles: true})); })()`
	);
	await page.sleep(500);
	page.check(
		"under coffee, Appearance has no ps settings",
		!(await page.evaluate(`!!${SETTING("psAnimation")} || !!${SETTING("psGroupMessages")}`))
	);
}
