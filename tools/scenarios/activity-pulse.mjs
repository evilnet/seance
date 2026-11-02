// The sidebar activity pulse, end to end in a real browser.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/activity-pulse.mjs
//
// The claim under test is a CSS class on a sidebar row, which `pnpm test`
// cannot see: `has-activity` goes on when somebody *says* something in a
// channel you are not reading, and only then. Joins and quits must leave the
// row alone, the deadline must lapse on its own, and the active and muted
// channels must never pulse.
//
// A second IRC user does the talking, driven straight from here over the
// dev ircd's WebSocket port so the scenario controls exactly when each line
// lands. Only the browser side is asserted.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // dev ircd's self-signed cert

const IRCD = "wss://localhost:8443/";
const CHANNEL = "#seance";

export const url =
	"http://localhost:8000/?host=localhost&port=8443&tls=true&nick=pulsewatch&join=%23seance";

/** Whether the #seance row is pulsing for activity right now. */
const PULSING = `!!document.querySelector('.channel-list-item[data-name="${CHANNEL}"].has-activity')`;
/** Whether the row shows the typing pulse, which must win over activity. */
const TYPING = `!!document.querySelector('.channel-list-item[data-name="${CHANNEL}"].is-typing')`;

/**
 * Sample the icon's rendered colour across ~1.4 s. The class alone proves
 * nothing — a typo in the selector or the keyframes would leave a still grey
 * icon — so this reads what the compositor actually paints.
 */
const SAMPLE_ICON = `(async () => {
	const row = document.querySelector('.channel-list-item[data-name="${CHANNEL}"]');
	if (!row) return null;
	const seen = [];
	for (let i = 0; i < 14; i++) {
		seen.push(getComputedStyle(row, "::before").color);
		await new Promise((r) => setTimeout(r, 100));
	}
	return seen;
})()`;

/** `--channel-activity-color`, the blue the icon must reach. */
const ACTIVITY_RGB = [0x7f, 0xb8, 0xe8];

const parseRgb = (value) => (value.match(/\d+/g) ?? []).slice(0, 3).map(Number);
const distance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** A second user on the dev ircd, one line at a time. */
function speaker(nick) {
	const ws = new WebSocket(IRCD, ["text.ircv3.net"]);
	let onJoin = () => {};

	const send = (line) => ws.send(line);

	ws.onopen = () => {
		send(`NICK ${nick}`);
		send(`USER ${nick} 0 * :seance activity pulse`);
	};

	ws.onmessage = (ev) => {
		const line = String(ev.data);

		if (line.startsWith("PING")) {
			ws.send(`PONG${line.slice(4)}`);
			return;
		}

		const params = (line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line).split(" ");

		if (params[1] === "001") {
			send(`JOIN ${CHANNEL}`);
		} else if (params[1] === "JOIN" && params[0].includes(nick)) {
			onJoin();
		} else if (params[1] === "433") {
			send(`NICK ${nick}${Math.floor(Math.random() * 1000)}`);
		}
	};

	return {
		send,
		/** Resolves once this user is in the channel. */
		joined: new Promise((resolve, reject) => {
			onJoin = resolve;
			ws.onerror = (e) => reject(new Error(String(e.message ?? e)));
			setTimeout(() => reject(new Error(`${nick} never joined ${CHANNEL}`)), 20000);
		}),
		say: (text) => send(`PRIVMSG ${CHANNEL} :${text}`),
		quit: () => send("QUIT :done"),
	};
}

export default async function run(page) {
	await page.goto(page.url, {waitForSelector: "#connect form"});

	// A fresh profile has no saved network, so the form is pre-filled from the
	// query parameters and only needs submitting.
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="${CHANNEL}"]')`, {
		timeout: 30000,
		label: `${CHANNEL} in the sidebar`,
	});

	// Read the lobby somewhere else so #seance is a background channel: the
	// pulse is deliberately suppressed for the channel already on screen.
	await page.click(`.channel-list-item[data-type="lobby"]`);
	await page.sleep(500);
	await page.check("nothing pulses before anyone speaks", !(await page.evaluate(PULSING)));

	const talker = speaker("pulsetalk");
	await talker.joined;
	await page.sleep(800);

	// 1. A join is not activity.
	await page.check("a JOIN does not pulse the row", !(await page.evaluate(PULSING)));
	await page.screenshot("1-join-no-pulse", {selector: "#sidebar"});

	// 2. A message is.
	talker.say("this one should light the icon up");
	await page.waitFor(PULSING, {timeout: 5000, label: "the row to start pulsing"});
	await page.check("a PRIVMSG pulses the row", await page.evaluate(PULSING));
	await page.check("the typing pulse is not what we are seeing", !(await page.evaluate(TYPING)));
	await page.screenshot("2-message-pulsing", {selector: "#sidebar"});

	// What the icon is actually painted, not just which class it carries.
	const samples = (await page.evaluate(SAMPLE_ICON)) ?? [];
	const colours = samples.map(parseRgb).filter((c) => c.length === 3);
	const nearest = Math.min(...colours.map((c) => distance(c, ACTIVITY_RGB)));
	await page.check(
		`the icon colour animates (${new Set(samples).size} distinct of ${samples.length})`,
		new Set(samples).size > 2
	);
	await page.check(
		`the icon reaches the activity blue (closest off by ${nearest})`,
		nearest <= 12
	);

	// 3. A second message extends the deadline rather than restarting a
	//    separate one; either way it must still be pulsing.
	await page.sleep(2000);
	talker.say("and so should this one");
	await page.sleep(2500);
	await page.check("a second message keeps it pulsing", await page.evaluate(PULSING));

	// 4. It lapses on its own, without anything else arriving.
	await page.waitFor(`!(${PULSING})`, {timeout: 8000, label: "the pulse to lapse"});
	await page.check("the pulse stops on its own", !(await page.evaluate(PULSING)));
	await page.screenshot("3-lapsed-quiet", {selector: "#sidebar"});

	// 5. A quit is not activity either.
	talker.quit();
	await page.sleep(1500);
	await page.check("a QUIT does not pulse the row", !(await page.evaluate(PULSING)));

	// 6. Muted channels stay still.
	await page.fill("#input", `/mute ${CHANNEL}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.sleep(300);

	const muted = speaker("pulsemute");
	await muted.joined;
	await page.sleep(500);
	muted.say("nobody asked to hear this");
	await page.sleep(2000);
	await page.check("a muted channel does not pulse", !(await page.evaluate(PULSING)));
	await page.screenshot("4-muted-quiet", {selector: "#sidebar"});

	await page.fill("#input", `/unmute ${CHANNEL}`);
	await page.evaluate(`document.querySelector("#form").requestSubmit()`);
	await page.sleep(300);

	// 7. The channel you are reading never pulses: the messages are right there.
	await page.click(`.channel-list-item[data-name="${CHANNEL}"]`);
	await page.sleep(500);
	muted.say("you are looking straight at this");
	await page.sleep(2000);
	await page.check("the active channel does not pulse", !(await page.evaluate(PULSING)));
	await page.screenshot("5-active-quiet", {selector: "#sidebar"});

	muted.quit();
	await page.check("no console errors", page.consoleErrors.length === 0);
}
