// The network header in the sidebar is two rows: the name alone on the first
// line (chevron, name, unread badge); on the second the tools (connection
// state, notifications, edit, join) on the left and the nick on the right
// (NetworkLobby.vue, the `.lobby-wrap` rules in style.css). What `pnpm test`
// cannot see: that the name gets its whole line and is not clipped, that the
// tools sit under it as an evenly spaced toolbar with every glyph centred in
// its box, that the nick is the one the connection uses (and follows a /nick),
// that a long nick trims itself rather than pushing the tools, and how the
// header looks hovered, active, collapsed, disconnected and in the jump-to
// results.
//
//   pnpm build && python3 -m http.server -d public 8001 &
//   node tools/browser-drive.mjs tools/scenarios/network-panel.mjs
//
// The default target is a plain-WS ircd on 127.0.0.1:8067 (the testnet rig,
// or the dev ircd's ws:// port). Against the dev ircd over TLS:
//   node tools/browser-drive.mjs tools/scenarios/network-panel.mjs \
//     --url='http://localhost:8000/?host=localhost&port=8443&tls=true&nick=npanelcheck&join=%23seance'

const RUN = Date.now().toString(36);
const NICK = `np${RUN}`; // 10 characters: an ordinary nick, must fit whole
const LONG_NICK = `npanel${RUN}`; // 14: proves a /nick reaches the header and the tools stay put
const BASE = "http://localhost:8001/";

export const url = `${BASE}?host=127.0.0.1&port=8067&tls=false&nick=${NICK}&join=%23seance`;

const LOBBY = '.channel-list-item[data-type="lobby"]';
const CHANNEL_ROW = '.channel-list-item[data-name="#seance"]';
const TOOLS = [".connection-status-icon", ".notify-status-icon", ".edit-network", ".add-channel"];
const text = (selector) =>
	`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "").trim()`;
const NICK_SHOWN = `document.querySelector('${LOBBY} .lobby-nick').textContent.replace(/^\\s*Nickname:\\s*/, "").trim()`;

export default async function run(page) {
	const unclipped = (selector) =>
		page.evaluate(
			`(() => { const el = document.querySelector(${JSON.stringify(
				selector
			)}); return el.scrollWidth <= el.clientWidth; })()`
		);

	await page.goto(page.url, {waitForSelector: "#connect form"});
	await page.click("#connect button[type=submit]");
	await page.waitFor(`document.querySelector('${CHANNEL_ROW}')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.waitFor(`document.querySelector('${LOBBY} .connection-status-icon.is-connected')`, {
		timeout: 30000,
		label: "the lobby's status icon to show connected",
	});

	// Structure: two rows; every tool in the second one, before the nick.
	page.check("lobby has a title row", (await page.count(`${LOBBY} .lobby-title .name`)) === 1);
	page.check("lobby has a status row", (await page.count(`${LOBBY} .lobby-status`)) === 1);

	for (const tool of TOOLS) {
		page.check(
			`${tool} lives in the status row's toolbar`,
			(await page.count(`${LOBBY} .lobby-status .lobby-tools ${tool}`)) === 1
		);
	}

	page.check(
		"the title row carries no tool",
		(await page.count(`${LOBBY} .lobby-title button:not(.collapse-network)`)) === 0
	);
	page.check(
		"the toolbar comes before the nick",
		await page.evaluate(
			`(() => { const t = document.querySelector('${LOBBY} .lobby-tools'); const n = document.querySelector('${LOBBY} .lobby-nick'); return !!(t.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); })()`
		)
	);

	// Geometry: the name is on a line of its own, wide and unclipped; the
	// tools under it at the left, the nick on the same line at the right.
	const lobby = await page.rect(LOBBY);
	const name = await page.rect(`${LOBBY} .lobby-title .name`);
	const tools = await page.rect(`${LOBBY} .lobby-tools`);
	const nick = await page.rect(`${LOBBY} .lobby-nick`);
	page.check("header rects found", !!lobby && !!name && !!tools && !!nick);

	if (lobby && name && tools && nick) {
		const lobbyRight = lobby.x + lobby.width;
		const nickRight = nick.x + nick.width;
		page.check(`name spans its line (${Math.round(name.width)}px wide)`, name.width >= 120);
		page.check("tools sit below the name", tools.y >= name.y + name.height - 1);
		page.check(
			"nick and tools share a line",
			Math.abs(nick.y + nick.height / 2 - (tools.y + tools.height / 2)) <= 2
		);
		page.check(
			`tools start at the left edge (${Math.round(tools.x - lobby.x)}px in)`,
			tools.x - lobby.x >= 10 && tools.x - lobby.x <= 20
		);
		page.check(
			`nick ends at the right edge (${Math.round(lobbyRight - nickRight)}px from it)`,
			lobbyRight - nickRight >= 10 && lobbyRight - nickRight <= 20
		);
		page.check(`header height is modest (${Math.round(lobby.height)}px)`, lobby.height <= 72);
	}

	// The toolbar is evenly spaced: same box for every tool, same pitch
	// between neighbours, and each glyph centred in its box (the bell is a
	// span, which unlike a button does not centre its content on its own).
	const boxes = [];

	for (const tool of TOOLS) {
		boxes.push(await page.rect(`${LOBBY} .lobby-tools ${tool}`));
	}

	const widths = boxes.map((b) => Math.round(b.width));
	const pitches = boxes.slice(1).map((b, i) => Math.round((b.x - boxes[i].x) * 10) / 10);
	page.check(
		`every tool is the same box (${widths.join("/")}px)`,
		widths.every((w) => w === widths[0])
	);
	page.check(
		`tools are evenly pitched (${pitches.join("/")}px)`,
		pitches.every((p) => Math.abs(p - pitches[0]) <= 0.5)
	);
	page.check(
		"every tool box centres its glyph",
		await page.evaluate(
			`[${TOOLS.map((t) => JSON.stringify(`${LOBBY} .lobby-tools ${t}`)).join(
				","
			)}].every((s) => getComputedStyle(document.querySelector(s)).textAlign === "center")`
		)
	);

	// Even boxes are not what the eye measures: the gaps between the glyphs'
	// ink are. Measure each glyph with a canvas in the font, size and centring
	// the page uses, and require the ink widths and the ink-to-ink gaps to
	// match — a thin text "+" or a smaller bell would fail this while every
	// box check above still passed.
	const ink = await page.evaluate(`(() => {
		const ctx = document.createElement("canvas").getContext("2d");
		return ${JSON.stringify(TOOLS)}.map((sel) => {
			const el = document.querySelector('${LOBBY} .lobby-tools ' + sel);
			const box = el.getBoundingClientRect();
			const ps = getComputedStyle(el, "::before");
			const content = JSON.parse(ps.content.replace(/^'(.*)'$/, '"$1"'));
			ctx.font = ps.fontStyle + " " + ps.fontWeight + " " + ps.fontSize + " " + ps.fontFamily;
			ctx.textAlign = "center";
			const m = ctx.measureText(content);
			const centre = box.x + box.width / 2;
			return {
				left: centre - m.actualBoundingBoxLeft,
				right: centre + m.actualBoundingBoxRight,
				width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
				family: ps.fontFamily,
			};
		});
	})()`);
	const inkWidths = ink.map((g) => Math.round(g.width * 10) / 10);
	const inkGaps = ink.slice(1).map((g, i) => Math.round((g.left - ink[i].right) * 10) / 10);
	page.check(
		`glyphs are the same size (ink ${inkWidths.join("/")}px)`,
		Math.max(...inkWidths) - Math.min(...inkWidths) <= 2
	);
	page.check(
		`gaps between glyphs are equal (${inkGaps.join("/")}px)`,
		Math.max(...inkGaps) - Math.min(...inkGaps) <= 1.5
	);
	page.check(
		"every glyph comes from the icon font",
		ink.every((g) => /FontAwesome/.test(g.family))
	);

	// Every tooltip in the sidebar must open on screen. The tools sit at the
	// sidebar's left edge now, so a west-pointing tooltip (primer-tooltips:
	// right: 100% of its element) would hang past x = 0. The tooltip is an
	// ::after that is display: none until its element is hovered, so hover
	// each one with real mouse events, then read the resolved width and place
	// it by the direction class. Elements that are not shown (a channel's
	// Leave button off the active row) are skipped.
	const TOOLTIPPED = "#sidebar .tooltipped";
	const tooltipCount = await page.count(TOOLTIPPED);
	const viewportWidth = await page.evaluate("window.innerWidth");

	for (let i = 0; i < tooltipCount; i++) {
		const host = await page.rect(TOOLTIPPED, i);

		if (!host || host.width === 0) {
			continue;
		}

		await page.hover(TOOLTIPPED, i);
		const t = await page.evaluate(`(() => {
			const el = document.querySelectorAll(${JSON.stringify(TOOLTIPPED)})[${i}];
			const r = el.getBoundingClientRect();
			const w = parseFloat(getComputedStyle(el, "::after").width) || 0;
			const gap = 6;
			const dir = [...el.classList].find((c) => /^tooltipped-(n|s|e|w|ne|nw|se|sw)$/.test(c)) ?? "tooltipped-n";
			let left;
			if (dir === "tooltipped-w") left = r.left - gap - w;
			else if (dir === "tooltipped-e") left = r.right + gap;
			else if (dir === "tooltipped-ne" || dir === "tooltipped-se") left = r.left;
			else if (dir === "tooltipped-nw" || dir === "tooltipped-sw") left = r.right - w;
			else left = r.left + r.width / 2 - w / 2;
			return {label: el.getAttribute("aria-label") ?? el.dataset.tooltip ?? "?", dir, left: Math.round(left), right: Math.round(left + w), width: Math.round(w)};
		})()`);
		page.check(`tooltip "${t.label}" renders on hover`, t.width > 0);
		page.check(
			`tooltip "${t.label}" (${t.dir}) opens on screen (x ${t.left}..${t.right})`,
			t.left >= 0 && t.right <= viewportWidth
		);
	}

	await page.hover(`${LOBBY} .edit-network-tooltip`);
	await page.sleep(700); // primer-tooltips fades the tooltip in after a delay
	await page.screenshot("0-tooltip-on-the-gear", {selector: "#sidebar"});

	page.check("name is not clipped", await unclipped(`${LOBBY} .lobby-title .name`));
	page.check("an ordinary nick is not clipped", await unclipped(`${LOBBY} .lobby-nick`));
	const shownName = await page.evaluate(text(`${LOBBY} .lobby-title .name`));
	page.check(`the title row shows the network name (${shownName})`, shownName.length > 0);

	// The nick shown is the nick the connection uses (the input's own label).
	const shownNick = await page.evaluate(NICK_SHOWN);
	page.check(`status row shows the nick (${shownNick})`, shownNick === NICK);
	page.check(
		"status row nick matches the input's nick",
		shownNick === (await page.evaluate(text("#nick")))
	);

	await page.screenshot("1-channel-active", {selector: "#sidebar"});

	await page.hover(LOBBY);
	await page.screenshot("2-lobby-hovered", {selector: "#sidebar"});

	await page.click(`${LOBBY} .lobby-title .name`);
	await page.waitFor(`document.querySelector('${LOBBY}.active')`, {label: "lobby to be active"});
	await page.screenshot("3-lobby-active", {selector: "#sidebar"});

	await page.click(`${LOBBY} .collapse-network`);
	await page.waitFor(`!document.querySelector('${CHANNEL_ROW}')`, {
		label: "channels to collapse",
	});
	await page.screenshot("4-collapsed", {selector: "#sidebar"});
	await page.click(`${LOBBY} .collapse-network`);
	await page.waitFor(`document.querySelector('${CHANNEL_ROW}')`, {label: "channels to expand"});

	// Jump-to results render the same header next to the server glyph. The
	// results leave out the open conversation, so open the channel first.
	await page.click(CHANNEL_ROW);
	await page.waitFor(`document.querySelector('${CHANNEL_ROW}.active')`, {
		label: "channel to be active again",
	});
	await page.click("#channel-search-input");
	await page.fill("#channel-search-input", shownName.slice(0, 3));
	await page.waitFor(`document.querySelector('.jump-to-results ${LOBBY}')`, {
		label: "the lobby among the jump-to results",
	});
	page.check(
		"results keep the nick",
		(await page.count(`.jump-to-results ${LOBBY} .lobby-nick`)) === 1
	);
	page.check(
		"results hide the toolbar",
		await page.evaluate(
			`getComputedStyle(document.querySelector('.jump-to-results ${LOBBY} .lobby-tools')).display === "none"`
		)
	);
	await page.screenshot("5-jump-to-results", {selector: "#sidebar"});
	await page.fill("#channel-search-input", "");
	await page.evaluate(`document.querySelector("#channel-search-input").blur()`);
	await page.waitFor(`!document.querySelector('.jump-to-results')`, {label: "results to close"});

	// A nick change reaches the header, and a nick too long for the room the
	// toolbar leaves it trims itself instead of moving the tools.
	await page.fill("#input", `/nick ${LONG_NICK}`);
	await page.click("#submit");
	await page.waitFor(`${NICK_SHOWN} === ${JSON.stringify(LONG_NICK)}`, {
		timeout: 15000,
		label: "the header to show the new nick",
	});
	page.check(
		"the new nick matches the input's nick",
		LONG_NICK === (await page.evaluate(text("#nick")))
	);
	const toolsAfter = await page.rect(`${LOBBY} .lobby-tools`);
	page.check(
		"a long nick does not move the tools",
		!!toolsAfter &&
			Math.abs(toolsAfter.x - tools.x) < 1 &&
			Math.abs(toolsAfter.width - tools.width) < 1
	);
	page.check(
		"a long nick trims itself with an ellipsis",
		await page.evaluate(
			`getComputedStyle(document.querySelector('${LOBBY} .lobby-nick')).textOverflow === "ellipsis"`
		)
	);
	await page.screenshot("6-long-nick", {selector: "#sidebar"});

	// Disconnected: the header turns red, the status icon shows unlink. The
	// ircd answers the QUIT with a close frame and then its ERROR line, which
	// Chrome reports as a socket error ("Data frame received after close");
	// that is the server's close handshake, not the sidebar's business.
	page.expectWsErrors = true;
	await page.fill("#input", "/disconnect");
	await page.click("#submit");
	await page.waitFor(`document.querySelector('${LOBBY}.not-connected')`, {
		timeout: 15000,
		label: "the lobby to show disconnected",
	});
	await page.sleep(300);
	page.check(
		"disconnected status icon",
		(await page.count(`${LOBBY} .lobby-tools .connection-status-icon.is-disconnected`)) === 1
	);
	page.check("nick survives the disconnect", (await page.count(`${LOBBY} .lobby-nick`)) === 1);
	await page.screenshot("7-disconnected", {selector: "#sidebar"});

	page.check("no console errors", page.consoleErrors.length === 0);
}
