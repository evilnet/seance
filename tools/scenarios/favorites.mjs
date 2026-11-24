// Favorites: conversations starred from their menu sit in a block above the
// networks, mixing networks, out of their own network's list
// (docs/resources/client-features.md § Favorites).
//
//   pnpm build && python3 -m http.server -d public 8020 &
//   SEANCE_PORT=8020 node tools/browser-drive.mjs tools/scenarios/favorites.mjs
//   … --mobile --width=390 --height=844
//   SEANCE_THEME=ps …   (any theme: screenshots of the block in it)
//
// No ircd needed: lib/tiny-ircd.mjs registers the connections (and answers
// PART here).
//
// Claims:
//   1. "Add to favorites" in a channel's menu puts it in a block above the
//      networks, and takes it out of its network's list;
//   2. two favorites with one name carry their networks' names, one alone does not;
//   3. a drag reorders the block, and the order is kept;
//   4. Alt+↓ walks the block before the networks;
//   5. a favorite stays when its network is collapsed; a network whose every
//      conversation is starred has no chevron;
//   6. closing a favorite leaves a placeholder; a tap joins it again;
//   7. a favorite on a saved network not connected is a placeholder; a tap
//      connects the network and lands on it;
//   8. the block collapses, kept across a reload;
//   9. "Remove from favorites" puts it back under its network;
//  10. no console errors.

import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const THEME = process.env.SEANCE_THEME ?? "";
const BASE = `http://localhost:${PORT}/`;
// Outside browser-drive.mjs's DevTools ports (9222–10221), which are picked at random.
const IRCD_PORT = 9174;

export const url = BASE;

const net = (uuid, name, join, extra) => ({
	uuid,
	name,
	host: "127.0.0.1",
	port: IRCD_PORT,
	tls: false,
	nick: uuid.slice(0, 5),
	join,
	sasl: "",
	saslAccount: "",
	saslPassword: "",
	autoconnect: true,
	...extra,
});

const NETWORKS = [
	net("alpha-0000", "Alpha", "#tiny,#help"),
	net("beta0-0000", "Beta", "#help,#other"),
	net("gamma-0000", "Gamma", "#far", {autoconnect: false}),
];

const BLOCK = "#sidebar .network.favorites";
const live = (uuid) => `#network-${uuid}`;
const row = (scope, name) => `${scope} .channel-list-item[data-name="${name}"]`;
const exists = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`;
const MENU = "#context-menu";

async function openSidebar(page) {
	// The phone layout keeps the sidebar off-canvas.
	if (
		(await page.evaluate(`window.innerWidth <= 768`)) &&
		!(await page.evaluate(`!!document.querySelector("#viewport.menu-open")`))
	) {
		await page.sleep(500);
		await page.click("#viewport .lt");
		await page.waitFor(`document.querySelector("#viewport.menu-open")`, {label: "drawer open"});
		await page.sleep(500);
	}
}

async function centre(page, selector) {
	const r = await page.rect(selector);

	if (!r) {
		throw new Error(`no element for ${selector}`);
	}

	return {x: r.x + r.width / 2, y: r.y + r.height / 2};
}

async function rightClick(page, selector) {
	const {x, y} = await centre(page, selector);
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
	await page.waitFor(exists(MENU), {label: `menu on ${selector}`});
}

/** Pick from a row's menu. */
async function menuPick(page, selector, itemClass) {
	await rightClick(page, selector);
	await page.click(`${MENU} .context-menu-${itemClass}`);
	await page.waitFor(`!document.querySelector(${JSON.stringify(MENU)})`, {label: "menu closed"});
}

/** A mouse drag from one row's centre to just above another's. */
async function drag(page, from, to) {
	const a = await centre(page, from);
	const b = await centre(page, to);
	const target = {x: b.x, y: b.y - 4};
	await page.send("Input.dispatchMouseEvent", {type: "mouseMoved", ...a});
	await page.send("Input.dispatchMouseEvent", {
		type: "mousePressed",
		...a,
		button: "left",
		buttons: 1,
		clickCount: 1,
	});

	for (let i = 1; i <= 12; i++) {
		await page.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: a.x + ((target.x - a.x) * i) / 12,
			y: a.y + ((target.y - a.y) * i) / 12,
			button: "left",
			buttons: 1,
		});
		await page.sleep(30);
	}

	await page.send("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		...target,
		button: "left",
		buttons: 0,
		clickCount: 1,
	});
	await page.sleep(300);
}

const blockNames = (page) =>
	page.evaluate(
		`[...document.querySelectorAll(${JSON.stringify(
			`${BLOCK} .channels .channel-list-item`
		)})].map((el) => el.dataset.name)`
	);

const stored = (page) =>
	page.evaluate(
		`JSON.parse(localStorage.getItem("thelounge.favorites") || "[]").map((f) => f.network.slice(0, 5) + "/" + f.name)`
	);

const activeName = (page) =>
	page.evaluate(`document.querySelector("#sidebar .channel-list-item.active")?.dataset.name`);

export default async function run(page) {
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		onLine(line, {send, nick}) {
			const [cmd, chan] = line.split(" ");

			if (cmd.toUpperCase() === "PART") {
				send(`:${nick}!u@tiny PART ${chan}`);
				return true;
			}

			return false;
		},
	});

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(
			`localStorage.setItem("thelounge.networks", ${JSON.stringify(
				JSON.stringify(NETWORKS)
			)})`
		);

		if (THEME) {
			await page.evaluate(
				`localStorage.setItem("settings", ${JSON.stringify(
					JSON.stringify({theme: THEME})
				)})`
			);
		}

		await page.goto(page.url, {waitForSelector: live("beta0-0000")});
		await page.waitFor(exists(row(live("alpha-0000"), "#help")), {label: "alpha joined"});
		await page.waitFor(exists(row(live("beta0-0000"), "#other")), {label: "beta joined"});
		await openSidebar(page);

		page.check("no block before a favorite", (await page.count(BLOCK)) === 0);

		// 1
		await menuPick(page, row(live("alpha-0000"), "#help"), "favorite");
		await page.waitFor(exists(BLOCK), {label: "favorites block"});
		page.check(
			"the block comes before every network",
			await page.evaluate(
				`document.querySelector("#sidebar .network") === document.querySelector(${JSON.stringify(
					BLOCK
				)})`
			)
		);
		page.check(
			"the favorite is in the block",
			JSON.stringify(await blockNames(page)) === JSON.stringify(["#help"])
		);
		page.check(
			"and not under its network",
			(await page.count(row(live("alpha-0000"), "#help"))) === 0
		);
		page.check(
			"a lone name carries no network",
			(await page.count(`${BLOCK} .network-tag`)) === 0
		);

		// 2
		await menuPick(page, row(live("beta0-0000"), "#help"), "favorite");
		await page.waitFor(
			`document.querySelectorAll(${JSON.stringify(`${BLOCK} .network-tag`)}).length === 2`,
			{
				label: "two tagged rows",
			}
		);
		page.check(
			"the clashing rows name their networks",
			JSON.stringify(
				await page.evaluate(
					`[...document.querySelectorAll(${JSON.stringify(
						`${BLOCK} .network-tag`
					)})].map((el) => el.textContent.trim())`
				)
			) === JSON.stringify(["Alpha", "Beta"])
		);
		page.check(
			"the row's label names its network",
			/Alpha/.test(
				await page.evaluate(
					`document.querySelector(${JSON.stringify(
						row(BLOCK, "#help")
					)}).getAttribute("aria-label")`
				)
			)
		);
		await menuPick(page, row(live("alpha-0000"), "#tiny"), "favorite");
		await page.waitFor(
			`document.querySelectorAll(${JSON.stringify(
				`${BLOCK} .channels .channel-list-item`
			)}).length === 3`,
			{
				label: "three favorites",
			}
		);
		await page.screenshot("favorites-block", {selector: "#sidebar"});

		// 3
		await drag(page, row(BLOCK, "#tiny"), `${BLOCK} .channels .channel-list-item`);
		page.check(
			"a drag moves #tiny to the top",
			JSON.stringify(await blockNames(page)) === JSON.stringify(["#tiny", "#help", "#help"])
		);
		page.check(
			"and the order is stored",
			JSON.stringify(await stored(page)) ===
				JSON.stringify(["alpha/#tiny", "alpha/#help", "beta0/#help"])
		);

		// 4
		await page.click(row(BLOCK, "#tiny"));
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				row(BLOCK, "#tiny")
			)}).classList.contains("active")`,
			{
				label: "#tiny open",
			}
		);
		await page.evaluate(`document.activeElement?.blur()`);
		const altDown = async () => {
			for (const type of ["keyDown", "keyUp"]) {
				await page.send("Input.dispatchKeyEvent", {
					type,
					modifiers: 1,
					key: "ArrowDown",
					code: "ArrowDown",
					windowsVirtualKeyCode: 40,
				});
			}

			await page.sleep(300);
		};
		await altDown();
		const second = await page.evaluate(
			`(() => { const a = document.querySelector("#sidebar .channel-list-item.active"); return a && a.closest(".favorites") ? a.dataset.name + "@" + [...a.parentElement.children].indexOf(a) : a?.dataset.name; })()`
		);
		page.check(
			`Alt+↓ from the first favorite goes to the second (got ${second})`,
			second === "#help@1"
		);
		await openSidebar(page);

		// 5: Alpha has nothing left under it, so no chevron; Beta still has #other.
		page.check(
			"a network whose every conversation is starred has no chevron",
			(await page.count(`${live("alpha-0000")} button.collapse-network`)) === 0
		);
		await page.click(`${live("beta0-0000")} button.collapse-network`);
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				live("beta0-0000")
			)}).classList.contains("collapsed")`,
			{label: "beta collapsed"}
		);
		page.check(
			"beta's favorite stays in the block while beta is collapsed",
			JSON.stringify(await blockNames(page)) ===
				JSON.stringify(["#tiny", "#help", "#help"]) &&
				(await page.count(row(live("beta0-0000"), "#other"))) === 0
		);
		await page.click(`${live("beta0-0000")} button.collapse-network`);

		// 6
		// The close button is the open row's.
		await page.click(row(BLOCK, "#tiny"));
		await page.waitFor(exists(`${row(BLOCK, "#tiny")}.active`), {label: "#tiny open again"});
		await openSidebar(page);
		await page.click(`${row(BLOCK, "#tiny")} button.close`);
		await page.waitFor(exists(`${BLOCK} .favorite-placeholder[data-name="#tiny"]`), {
			label: "placeholder after close",
		});
		page.check(
			"the placeholder keeps its place",
			JSON.stringify(await blockNames(page)) === JSON.stringify(["#tiny", "#help", "#help"])
		);
		page.check(
			"the closed channel is not under its network either",
			(await page.count(row(live("alpha-0000"), "#tiny"))) === 0
		);
		await openSidebar(page);
		await page.screenshot("favorites-placeholder", {selector: "#sidebar"});
		await page.click(
			`${BLOCK} .favorite-placeholder[data-name="#tiny"] .favorite-placeholder-open`
		);
		await page.waitFor(exists(`${row(BLOCK, "#tiny")}.active`), {
			label: "a tap joins it again and opens it",
		});
		page.check(
			"the placeholder is gone",
			(await page.count(`${BLOCK} .favorite-placeholder`)) === 0
		);
		await openSidebar(page);

		// 7
		await page.evaluate(
			`localStorage.setItem("thelounge.favorites", JSON.stringify([
				...JSON.parse(localStorage.getItem("thelounge.favorites")),
				{network: "gamma-0000", name: "#far", type: "channel"},
			]))`
		);
		await page.goto(page.url, {waitForSelector: BLOCK});
		await page.waitFor(exists(`${BLOCK} .favorite-placeholder[data-name="#far"]`), {
			label: "placeholder for a network not connected",
		});
		await openSidebar(page);
		page.check(
			"it says a tap connects",
			(await page.count(
				`${BLOCK} .favorite-placeholder[data-name="#far"] .favorite-open-icon.dormant`
			)) === 1
		);
		await page.screenshot("favorites-dormant", {selector: "#sidebar"});
		await page.click(
			`${BLOCK} .favorite-placeholder[data-name="#far"] .favorite-placeholder-open`
		);
		await page.waitFor(exists(`${row(BLOCK, "#far")}.active`), {
			label: "the network connects and lands on #far",
		});
		page.check("Gamma is live", (await page.count(live("gamma-0000"))) === 1);
		await openSidebar(page);

		// 8
		await page.click(`${BLOCK} .favorites-header .collapse-network`);
		await page.waitFor(
			`document.querySelector(${JSON.stringify(BLOCK)}).classList.contains("collapsed")`,
			{
				label: "block collapsed",
			}
		);
		page.check(
			"its rows are hidden",
			(await page.evaluate(
				`getComputedStyle(document.querySelector("#favorites-list")).display`
			)) === "none"
		);
		await page.goto(page.url, {waitForSelector: BLOCK});
		page.check(
			"still collapsed after a reload",
			await page.evaluate(
				`document.querySelector(${JSON.stringify(BLOCK)}).classList.contains("collapsed")`
			)
		);
		await openSidebar(page);
		await page.screenshot("favorites-collapsed", {selector: "#sidebar"});
		await page.click(`${BLOCK} .favorites-header`);
		await page.waitFor(
			`!document.querySelector(${JSON.stringify(BLOCK)}).classList.contains("collapsed")`,
			{
				label: "block open again",
			}
		);

		// 9: the first #help in the block is Alpha's.
		await page.waitFor(
			exists(row(BLOCK, "#help")) +
				" && " +
				exists(`${row(BLOCK, "#help")}:not(.network-down)`),
			{
				label: "Alpha back after the reload",
			}
		);
		await menuPick(page, row(BLOCK, "#help"), "unfavorite");
		await page.waitFor(exists(row(live("alpha-0000"), "#help")), {
			label: "#help back under Alpha",
		});
		page.check("the tags go with the clash", (await page.count(`${BLOCK} .network-tag`)) === 0);

		page.check("no console errors", page.consoleErrors.length === 0);
	} finally {
		await ircd.close();
	}
}
