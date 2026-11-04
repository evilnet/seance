// The ps theme's own settings (Settings → Appearance, shown under the theme
// select while ps is the theme): Scene animation (auto, full, calm,
// still), Pause the scene when the window isn't in use, Words over the
// plains (bubbles, glass, scrim, outline, rim, glow; docs/projects/ps-words.md)
// and Combine messages from the same person.
//
//   NODE_ENV=production pnpm build && python3 -m http.server -d public 8006 &
//   node tools/browser-drive.mjs tools/scenarios/ps-scene-settings.mjs
//
// Needs the dev ircd (a second user says two lines). Pins a clear noon on
// 25 September with a Date shim, so the scene is the same every run. Each
// level is read off the motion classes on `#theme-scene.psng` (psng/groups.ts):
// Full is every group's `psng-m-<group>`, Calm is `psng-calm` with only
// calm's groups (clouds, smoke, weather, skeins, sun), Still is no `psng-m-`
// class at all. Each words treatment is chosen through its radio and read off
// the page: the attribute on <html>, a card's fit-to-content width and fill on
// a row, the column's backdrop blur, the scrim's gradient, each shadow's
// shape; a screenshot of each.

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
/** Calm is the clouds alone (psng/groups.ts CALM; plan 5, spec §11). */
const CALM = ["clouds"];
const WORDS = ["bubbles", "glass", "scrim", "outline", "rim", "glow"];

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

async function setWords(page, words) {
	await openAppearance(page);
	await page.click(`#settings input[name="psWords"][value="${words}"]`);
	await closeSettings(page);
	await page.sleep(400);
}

/** What the page shows under a words treatment: the attribute and the probe its CSS proves it by. */
const WORDS_PROBE = `(() => {
	const html = document.documentElement;
	const column = document.querySelector("#chat .chat-content > .chat");
	// A plain message row of someone else's (not a pending copy, not a condensed group): the card is on every row, this one is the probe.
	const row =
		[...document.querySelectorAll('#chat .chat .msg[data-type="message"]:not(.pending)')].at(-1) ??
		[...document.querySelectorAll("#chat .chat .msg")].at(-1);
	const cs = getComputedStyle(row);
	const shadow = cs.textShadow;
	return {
		words: html.dataset.psWords ?? null,
		row: row.dataset.type + " " + row.className,
		rowWidth: row.getBoundingClientRect().width,
		columnWidth: column.getBoundingClientRect().width,
		rowFill: cs.backgroundColor,
		columnBlur: getComputedStyle(column).backdropFilter,
		columnImage: getComputedStyle(column).backgroundImage,
		shadow,
		rings78: shadow.split("0.78)").length - 1,
		rings60: shadow.split("0.6)").length - 1,
		rings28: shadow.split("0.28)").length - 1,
		layers: shadow === "none" ? 0 : shadow.split(/,\\s*(?![^()]*\\))/).length,
	};
})()`;

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
		words: document.querySelector('#settings [name="psWords"]:checked')?.value,
		wordsList: [...document.querySelectorAll('#settings [name="psWords"]')].map((i) => i.value),
	})`);
	const d = JSON.parse(defaults);
	page.check(
		`under ps, Appearance has the theme's settings: Scene animation ${d.levels.join("/")} at ${
			d.level
		}, pause when away ${d.pause}, words ${d.wordsList.join("/")} at ${d.words}, combine ${
			d.group
		}`,
		d.levels.join() === "auto,full,calm,still" &&
			d.level === "auto" &&
			d.pause === true &&
			d.wordsList.join() === WORDS.join() &&
			d.words === "bubbles" &&
			d.group === true
	);
	await page.evaluate(`document.querySelector("#theme-select").scrollIntoView({block: "start"})`);
	await page.sleep(200);
	await page.screenshot("ps-settings-section");
	await closeSettings(page);

	// Each words treatment, through its radio: the attribute and the CSS that proves it.
	const words = {};
	for (const w of WORDS) {
		await setWords(page, w);
		words[w] = await page.evaluate(WORDS_PROBE);
		await page.screenshot(`ps-words-${w}`);
	}
	const transparent = (fill) => /^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/.test(fill);
	page.check(
		`bubbles: a row is a card narrower than the column with a fill (${words.bubbles.rowWidth} of ${words.bubbles.columnWidth}px, ${words.bubbles.rowFill}), no shadow on the words`,
		words.bubbles.words === "bubbles" &&
			words.bubbles.rowWidth < words.bubbles.columnWidth - 40 &&
			!transparent(words.bubbles.rowFill) &&
			words.bubbles.shadow === "none"
	);
	page.check(
		`glass: the column carries the backdrop blur (${words.glass.columnBlur}), the rows are plain`,
		words.glass.words === "glass" &&
			words.glass.columnBlur.includes("blur") &&
			transparent(words.glass.rowFill) &&
			words.glass.shadow === "none"
	);
	page.check(
		`scrim: the column carries the gradient and no blur (${words.scrim.columnImage.slice(
			0,
			40
		)}…, ${words.scrim.columnBlur})`,
		words.scrim.words === "scrim" &&
			words.scrim.columnImage.startsWith("linear-gradient") &&
			words.scrim.columnBlur === "none" &&
			words.glass.columnImage === "none"
	);
	page.check(
		`outline: eight 1px offsets at 78 % and the 28 % ring (${words.outline.rings78}/${words.outline.rings28}), no card`,
		words.outline.words === "outline" &&
			words.outline.rings78 === 8 &&
			words.outline.rings28 === 8 &&
			transparent(words.outline.rowFill)
	);
	page.check(
		`rim: eight offsets at 60 % in the rim's colour and no 28 % ring (${words.rim.rings60}/${words.rim.rings28}), no 78 % ring`,
		words.rim.words === "rim" &&
			words.rim.rings60 === 8 &&
			words.rim.rings28 === 0 &&
			words.rim.rings78 === 0 &&
			!words.rim.shadow.includes("rgba(0, 0, 0")
	);
	page.check(
		`glow: four layers and no ring (${words.glow.layers} layers, ${words.glow.rings78}/${words.glow.rings60} ring offsets)`,
		words.glow.words === "glow" &&
			words.glow.layers === 4 &&
			words.glow.rings78 === 0 &&
			words.glow.rings60 === 0
	);
	await setWords(page, "bubbles");

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
		!(await page.evaluate(
			`!!${SETTING("psAnimation")} || !!${SETTING("psGroupMessages")} || !!${SETTING(
				"psWords"
			)}`
		))
	);
}
