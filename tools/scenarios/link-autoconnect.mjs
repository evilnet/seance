// A `?uri=` link to a saved network opens that network's channel and leaves
// the other autoconnect networks to come up as they would without it
// (client/js/boot.ts `handleQueryParams`, its "saved" branch). It used to
// return before `autoconnectSavedNetworks()`, so a link meant only its own
// network was online.
//
//   corepack yarn build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/link-autoconnect.mjs
//
// Two saved networks on the dev ircd, both autoconnect: A on `localhost`,
// which the link names, joining #seance; B on `127.0.0.1`, joining
// #seance-other, and B's channel is the remembered conversation — so the
// check also covers the view: it must end on the link's channel, not land on
// B's when B joins later.

const PORT = process.env.SEANCE_PORT ?? "8000";
const BASE = `http://127.0.0.1:${PORT}/`;
const RUN = Date.now().toString(36).slice(-5);
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "#seance-other";

export const url = BASE;

const LINK = `${BASE}?uri=${encodeURIComponent("web+irc://localhost:8443/%23seance")}`;
const NETWORKS = `document.querySelectorAll("#sidebar .network").length`;
const ACTIVE = `(document.querySelector("#chat-container")?.dataset.currentChannel ?? null)`;
const joined = (name) =>
	`!!document.querySelector('.channel-list-item[data-name="${name}"]:not(.parted-channel)')`;

export default async function run(page) {
	const networks = [
		{uuid: A, name: "A", host: "localhost", port: 8443, tls: true, nick: `la${RUN}`},
		{uuid: B, name: "B", host: "127.0.0.1", port: 8443, tls: true, nick: `lb${RUN}`},
	].map((net, i) => ({...net, join: i === 0 ? "#seance" : OTHER, autoconnect: true}));

	await page.goto(BASE);
	await page.waitFor(`!!document.querySelector("#connect")`, {label: "the start page"});
	await page.evaluate(`(() => {
		localStorage.setItem("thelounge.networks", ${JSON.stringify(JSON.stringify(networks))});
		localStorage.setItem("thelounge.state.lastChannel",
			${JSON.stringify(JSON.stringify({network: B, target: OTHER}))});
	})()`);

	// A query that differs is a real load: boot runs again and reads the link.
	await page.goto(LINK);

	await page.waitFor(`${NETWORKS} === 2`, {timeout: 30000, label: "both networks"});
	await page.waitFor(`${joined("#seance")} && ${joined(OTHER)}`, {
		timeout: 30000,
		label: "both networks' channels joined",
	});

	// Give B's landing its chance to steal the view before reading it.
	await new Promise((resolve) => setTimeout(resolve, 3000));
	const active = await page.evaluate(ACTIVE);

	page.check("the other autoconnect network came up too", (await page.evaluate(NETWORKS)) === 2);
	page.check(`the view is the link's channel (${active})`, active === "#seance");
	await page.screenshot("link-autoconnect");
	page.check("no console errors", page.consoleErrors.length === 0);
}
