// A narrow desktop window keeps the channel list beside the messages, and
// the user list, which would lie over them there, starts closed even when a
// wide window left it open (helpers/device.ts PHONE_LAYOUT_QUERY,
// userlistOverlay.ts). The toggle still opens it over the messages, and a
// wide window still gets the saved state back.
//
//   pnpm build && python3 -m http.server -d public 8000 &
//   tools/nefarious-dev/run.sh -d
//   node tools/browser-drive.mjs tools/scenarios/narrow-desktop.mjs --no-ws

const RUN = Date.now().toString(36);
const NICK = `nar${RUN}`;
const BASE = process.env.SEANCE_BASE ?? "http://localhost:8000/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance`;

const STATE = `(() => {
	const sidebar = document.querySelector("#sidebar");
	const ul = document.querySelector("#chat .userlist");
	const shown = (el) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.right > 0 && r.left < innerWidth && getComputedStyle(el).visibility !== "hidden";
	};
	const ulShown = (() => {
		if (!ul) return false;
		const r = ul.getBoundingClientRect();
		const chat = document.querySelector("#chat").getBoundingClientRect();
		return r.width > 0 && r.left < chat.right - 1 && r.right > chat.left + 1;
	})();
	return {
		width: innerWidth,
		sidebar: getComputedStyle(sidebar).position === "absolute" ? (shown(sidebar) && document.querySelector("#viewport").classList.contains("menu-open") ? "drawer-open" : "drawer") : "panel",
		userlist: ul ? (ulShown ? getComputedStyle(ul).position === "absolute" ? "overlay" : "beside" : "closed") : "none",
		chatWidth: Math.round(document.querySelector("#chat").getBoundingClientRect().width),
	};
})()`;

async function resize(page, width, height = 800) {
	await page.send("Emulation.setDeviceMetricsOverride", {
		width,
		height,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.sleep(400);
}

export default async function run(page) {
	// A wide window left the user list open.
	await page.addInitScript(
		`if (!sessionStorage.getItem("seeded")) { localStorage.setItem("thelounge.state.userlist", "true"); sessionStorage.setItem("seeded", "1"); }`
	);
	await resize(page, 1280);
	await page.goto(url, {waitForSelector: "#connect form"});
	await page.click('#connect button[type="submit"]');
	await page.waitFor(`document.querySelector("#chat .userlist .names .user")`, {
		timeout: 30000,
		label: "the user list fills",
	});

	let s = await page.evaluate(STATE);
	console.log("wide", JSON.stringify(s));
	page.check("wide: channel list is a panel", s.sidebar === "panel");
	page.check("wide: user list beside the messages", s.userlist === "beside");
	await page.screenshot("wide");

	await resize(page, 640);
	s = await page.evaluate(STATE);
	console.log("640", JSON.stringify(s));
	page.check("640: channel list stays a panel", s.sidebar === "panel");
	page.check("640: user list closed", s.userlist === "closed");
	await page.screenshot("narrow-640");

	await page.click("#chat .header .rt");
	await page.sleep(400);
	s = await page.evaluate(STATE);
	page.check("640: the toggle opens it over the messages", s.userlist === "overlay");
	await page.screenshot("narrow-640-userlist");
	page.check(
		"640: opening it there leaves the saved state alone",
		(await page.evaluate(`localStorage.getItem("thelounge.state.userlist")`)) === "true"
	);

	await page.click("#chat .header .rt");
	await page.sleep(400);
	s = await page.evaluate(STATE);
	page.check("640: the toggle closes it again", s.userlist === "closed");

	await resize(page, 1280);
	s = await page.evaluate(STATE);
	page.check("back to wide: user list beside again", s.userlist === "beside");

	// Reload narrow: a fresh start in a narrow window, the network saved.
	await resize(page, 560);
	await page.goto(BASE, {waitForSelector: "#connect form"});
	await page.click('#connect button[type="submit"]');
	await page.waitFor(
		`document.querySelector('#chat .chat-view[data-type="channel"] .userlist')`,
		{
			timeout: 30000,
			label: "the channel opens again",
		}
	);
	await page.sleep(500);
	s = await page.evaluate(STATE);
	console.log("560 reload", JSON.stringify(s));
	page.check("560 after reload: channel list is a panel", s.sidebar === "panel");
	page.check("560 after reload: user list closed", s.userlist === "closed");
	await page.screenshot("narrow-560");

	await resize(page, 460);
	s = await page.evaluate(STATE);
	console.log("460", JSON.stringify(s));
	page.check("460: the phone layout (channel list is a drawer)", s.sidebar.startsWith("drawer"));
	page.check("no console errors", page.consoleErrors.length === 0);
}
