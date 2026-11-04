// A notification click opens its conversation on a cold start with more
// than one network to autoconnect.
//
//   pnpm build && python3 -m http.server -d public 8045 &
//   node tools/browser-drive.mjs tools/scenarios/notification-click.mjs
//
// Needs an ircd on ws://127.0.0.1:8067/. A click lands on the deep link
// `#/net/<uuid>/<target>` (the worker's `openApp`), so the scenario opens
// that URL directly.
//
// Claims:
//   1. a cold start on the deep link lands on that network's channel and
//      stays there while a second network, announced after it, comes up — it
//      used to move the view to its own last channel (the last announce won),
//      so a notification for any network but the last opened the wrong
//      conversation;
//   2. no console errors.

const ORIGIN = process.env.SEANCE_URL ?? "http://127.0.0.1:8045";
const RUN = Date.now().toString(36).slice(-5);
const NICK = `ncpage${RUN.slice(-4)}`;
const UUID = "nc-" + Math.random().toString(36).slice(2, 10);
const SECOND = "nc2-" + Math.random().toString(36).slice(2, 10);
const CHAN = `#nc${RUN}`;

export const url = `${ORIGIN}/robots.txt`;

/** The deep-linked network is the most recently used, so boot announces it first. */
const NETWORKS = [
	{
		uuid: UUID,
		name: "Clicked",
		host: "127.0.0.1",
		port: 8067,
		tls: false,
		nick: NICK,
		join: `#seance,${CHAN}`,
		autoconnect: true,
		lastUsed: 2,
	},
	{
		uuid: SECOND,
		name: "Second",
		host: "127.0.0.1",
		port: 8067,
		tls: false,
		nick: `${NICK}b`,
		join: "#seance",
		autoconnect: true,
		lastUsed: 1,
	},
];

/** The open conversation: its title and its network's name. */
const shown = (page) =>
	page.evaluate(`(() => {
		const row = document.querySelector(".channel-list-item.active");
		const name = row && row.closest(".network").querySelector(".lobby-title .name");
		return (document.querySelector("#chat .header .title") || {textContent: "?"}).textContent.trim()
			+ " on " + (name ? name.textContent.trim() : "?");
	})()`);

export default async function run(page) {
	// Seeded from a document of the origin that is not the app, with nothing
	// remembered to come back to.
	await page.goto(page.url);
	await page.evaluate(`(() => {
		localStorage.setItem("thelounge.networks", JSON.stringify(${JSON.stringify(NETWORKS)}));
		localStorage.removeItem("thelounge.state.lastChannel");
	})()`);
	await page.goto(`${ORIGIN}/#/net/${UUID}/${encodeURIComponent(CHAN)}`);
	await page.waitFor(
		`[...document.querySelectorAll(".lobby-nick")].filter((e) => e.textContent.includes(${JSON.stringify(
			NICK
		)})).length === 2`,
		{label: "both networks registered", timeout: 30000}
	);
	await page.sleep(1500);
	const cold = await shown(page);
	page.check(`1. the deep link's conversation is open (${cold})`, cold === `${CHAN} on Clicked`);
	await page.screenshot("cold-two-networks");

	page.check(
		`2. no console errors (${page.consoleErrors.map((e) => e.text).join(" | ")})`,
		page.consoleErrors.length === 0
	);
}
