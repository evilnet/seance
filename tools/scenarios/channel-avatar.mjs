// A channel's avatar (draft/metadata-2 `avatar` on the channel): read from
// the join burst and drawn in its sidebar row ahead of the topic's emoji and
// the bubbles, set and removed from the channel's menu by its ops
// (docs/resources/client-features.md § Avatars, § Channel emoji from the topic).
//
//   pnpm build && python3 -m http.server -d public 8020 &
//   SEANCE_PORT=8020 node tools/browser-drive.mjs tools/scenarios/channel-avatar.mjs \
//     --chrome-arg='--host-resolver-rules=MAP img.test:443 127.0.0.1:9178'
//   SEANCE_THEME=ps …   (any theme: screenshots of the rows and the dialog in it)
//
// No ircd needed: lib/tiny-ircd.mjs registers the connection and this file
// answers JOIN with each channel's avatar and topic, and METADATA GET and
// SET as nefarious2 does. The pictures come from an https server on 9178
// (a throwaway self-signed certificate; `openssl` on the PATH), which the
// --chrome-arg above makes https://img.test/: an avatar URL must use the
// default port. A machine without a colour emoji font draws the emoji as
// empty boxes (the channel-emoji.mjs header says how to add one).
//
// Claims:
//   1. a channel with an avatar draws it, not its topic's emoji; one
//      without draws the emoji, or the bubbles; every row is one height;
//   2. a picture on a host nobody trusts is a veiled tile; the channel's
//      menu leads with showing it, and the dialog says where it is and
//      shows it; "Always show avatars from img.test" loads its host's;
//   3. "Channel avatar…" is in the menu of a channel we are op in, from the
//      row and from the chat header's button, and not in one we are not;
//   4. the dialog: an empty state with the row's emoji; the link field
//      takes the caret, Cancel gives it back; a SET says "Saving…" beside
//      the buttons, dims the picture and keeps Escape from closing it; the
//      op who set a picture on an untrusted host sees it at once; a
//      refusal is an alert in words; Remove (a bare SET) brings the emoji
//      back; Escape closes it;
//   5. a channel opened without an avatar known asks for it, once;
//   6. a change another op makes reaches the row;
//   7. activity pulses the avatar;
//   8. an unsent draft's pen takes the avatar's slot, the row's height kept;
//   9. no console errors.

import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import https from "node:https";
import {tmpdir} from "node:os";
import {join} from "node:path";
import zlib from "node:zlib";
import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const THEME = process.env.SEANCE_THEME ?? "";
const BASE = `http://localhost:${PORT}/`;
// Outside browser-drive.mjs's DevTools ports (9222–10221), which are picked at random.
const IRCD_PORT = 9177;
const IMG_PORT = 9178;
const IMG = "https://img.test";

export const url = BASE;

/** Each channel: its avatar, its topic, and whether we are op there. */
const CHANNELS = {
	"#art": {avatar: `${IMG}/art.png`, topic: "🎨 Drawing and painting", op: true},
	"#games": {avatar: "", topic: "🎮 Games, all of them", op: true},
	"#plain": {avatar: "", topic: "Plain talk", op: true},
	"#garden": {avatar: `${IMG}/garden.png`, topic: "", op: false},
};

const NETWORK = {
	uuid: "chavt-0000",
	name: "Avatars",
	host: "127.0.0.1",
	port: IRCD_PORT,
	tls: false,
	nick: "probe",
	join: Object.keys(CHANNELS).join(","),
	sasl: "",
	saslAccount: "",
	saslPassword: "",
	autoconnect: true,
};

/** A w × h PNG: a diagonal blend of two colours, so it reads as a picture. */
function png(w, h, from, to) {
	const raw = Buffer.alloc((w * 3 + 1) * h);

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const t = (x + y) / (w + h - 2);
			const o = y * (w * 3 + 1) + 1 + x * 3;

			for (let c = 0; c < 3; c++) {
				raw[o + c] = Math.round(from[c] + (to[c] - from[c]) * t);
			}
		}
	}

	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(zlib.crc32(body));
		return Buffer.concat([len, body, crc]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolour
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const PICTURES = {
	"/art.png": png(64, 64, [233, 84, 32], [142, 68, 173]),
	"/garden.png": png(64, 64, [46, 204, 113], [241, 196, 15]),
	"/games.png": png(64, 64, [52, 152, 219], [26, 188, 156]),
	"/plain.png": png(64, 64, [149, 165, 166], [44, 62, 80]),
	"/slow.png": png(64, 64, [52, 152, 219], [26, 188, 156]),
};

/** The image host: https with a throwaway self-signed certificate. */
function startImageHost() {
	const dir = mkdtempSync(join(tmpdir(), "seance-channel-avatar-"));
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-subj",
			"/CN=img.test",
			"-days",
			"1",
			"-keyout",
			join(dir, "key.pem"),
			"-out",
			join(dir, "cert.pem"),
		],
		{stdio: "ignore"}
	);
	const fetched = [];
	const server = https.createServer(
		{key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem"))},
		(req, res) => {
			fetched.push(req.url);
			const body = PICTURES[req.url ?? ""];
			res.writeHead(body ? 200 : 404, {"content-type": "image/png"});
			res.end(body);
		}
	);
	server.listen(IMG_PORT, "127.0.0.1");
	return {
		fetched,
		close: () =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
				rmSync(dir, {recursive: true, force: true});
			}),
	};
}

const row = (name) => `#sidebar .channel-list-item[data-name="${name}"]`;
const exists = (sel) => `!!document.querySelector(${JSON.stringify(sel)})`;
const MENU = "#context-menu";
const DIALOG = "#channel-avatar-dialog";

/** What the row draws in its icon's place. */
const icon = (page, name) =>
	page.evaluate(`(() => {
		const el = document.querySelector(${JSON.stringify(row(name))});
		if (!el) return null;
		const avatar = el.querySelector(":scope > .avatar");
		const img = avatar?.querySelector("img");
		const before = getComputedStyle(el, "::before");
		return {
			avatar: avatar ? [...avatar.classList].filter((c) => c !== "avatar").join(" ") : null,
			loaded: !!img && img.complete && img.naturalWidth > 0,
			src: img?.getAttribute("src") ?? null,
			before: before.display === "none" ? null : before.content,
			animation: avatar ? getComputedStyle(avatar).animationName : null,
		};
	})()`);

async function rightClick(page, selector) {
	const r = await page.rect(selector);
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
	await page.waitFor(exists(MENU), {label: `menu on ${selector}`});
}

const activeIs = (name) =>
	`document.querySelector(${JSON.stringify(row(name))})?.classList.contains("active")`;

const menuLabels = (page) =>
	page.evaluate(
		`[...document.querySelectorAll("${MENU} .context-menu-item")].map((el) => el.className.replace(/.*context-menu-/, "") + ":" + el.textContent.trim())`
	);

async function escape(page) {
	for (const type of ["keyDown", "keyUp"]) {
		await page.send("Input.dispatchKeyEvent", {
			type,
			key: "Escape",
			code: "Escape",
			windowsVirtualKeyCode: 27,
		});
	}
}

export default async function run(page) {
	const received = [];
	let push = null;
	const avatars = Object.fromEntries(
		Object.entries(CHANNELS).map(([name, c]) => [name.toLowerCase(), c.avatar])
	);

	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		caps: "batch draft/metadata-2",
		onLine(raw, {send, nick}) {
			push = send;
			const line = raw.startsWith("@") ? raw.slice(raw.indexOf(" ") + 1) : raw;
			received.push(line);
			const [cmd, target, sub, key] = line.split(" ");

			if (cmd.toUpperCase() === "JOIN") {
				for (const chan of target.split(",").filter(Boolean)) {
					const c = CHANNELS[chan];
					send(`:${nick}!u@tiny JOIN ${chan}`);

					if (c?.avatar) {
						send(`:tiny.test METADATA ${chan} avatar * :${c.avatar}`);
					}

					if (c?.topic) {
						send(`:tiny.test 332 ${nick} ${chan} :${c.topic}`);
					}

					send(`:tiny.test 353 ${nick} = ${chan} :${c?.op ? "@" : ""}${nick} @bob`);
					send(`:tiny.test 366 ${nick} ${chan} :End of /NAMES list.`);
				}

				return true;
			}

			if (cmd.toUpperCase() !== "METADATA") {
				return false;
			}

			const who = target === "*" ? nick : target;
			const value = avatars[who.toLowerCase()] ?? "";

			if (sub === "GET" && key === "avatar") {
				send(
					value
						? `:tiny.test 761 ${nick} ${who} avatar * :${value}`
						: `:tiny.test 766 ${nick} ${who} avatar :key not set`
				);
			} else if (sub === "SET" && key === "avatar" && target.startsWith("#")) {
				if (!CHANNELS[target]?.op) {
					send(
						`FAIL METADATA KEY_NO_PERMISSION ${target} avatar :You don't have permission to set metadata on this target`
					);
					return true;
				}

				const next = line.includes(" :") ? line.slice(line.indexOf(" :") + 2) : "";

				// The scenario's own cases: a refusal, and a server slow to answer.
				if (next.endsWith("/refuse.png")) {
					send(
						`FAIL METADATA KEY_NO_PERMISSION ${target} avatar :You don't have permission to set metadata on this target`
					);
					return true;
				}

				const answer = () => {
					avatars[target.toLowerCase()] = next;
					send(
						next
							? `:tiny.test 761 ${nick} ${target} avatar * :${next}`
							: `:tiny.test 766 ${nick} ${target} avatar :key not set`
					);
					send(`:tiny.test METADATA ${target} avatar *${next ? ` :${next}` : ""}`);
				};

				if (next.endsWith("/slow.png")) {
					setTimeout(answer, 1500);
				} else {
					answer();
				}
			}

			return true;
		},
	});
	const images = startImageHost();

	try {
		await page.goto(page.url, {waitForSelector: "#connect form"});
		await page.evaluate(
			`localStorage.setItem("thelounge.networks", ${JSON.stringify(
				JSON.stringify([NETWORK])
			)})`
		);

		if (THEME) {
			await page.evaluate(
				`localStorage.setItem("settings", ${JSON.stringify(
					JSON.stringify({theme: THEME})
				)})`
			);
		}

		await page.goto(page.url, {waitForSelector: "#sidebar"});
		await page.waitFor(exists(`${row("#garden")} > .avatar`), {label: "channels joined"});
		await page.sleep(500);

		// 1–2. Avatars ahead of the emoji, veiled until trusted; nothing fetched yet.
		const art = await icon(page, "#art");
		page.check(
			`#art: a veiled avatar (${art?.avatar})`,
			/avatar-veiled/.test(art?.avatar ?? "")
		);
		page.check("#art: its topic's emoji is not drawn", art?.before === null);
		const games = await icon(page, "#games");
		page.check(
			`#games: the emoji (${games?.before})`,
			games?.avatar === null && games?.before === '"🎮"'
		);
		const plain = await icon(page, "#plain");
		page.check(
			`#plain: the bubbles (${plain?.before})`,
			plain?.avatar === null && plain?.before === '""'
		);
		page.check(
			`no picture fetched before it is trusted (${images.fetched.join(", ")})`,
			images.fetched.length === 0
		);
		const heights = {};

		for (const name of Object.keys(CHANNELS)) {
			if (!(await page.evaluate(exists(`${row(name)}.active`)))) {
				heights[name] = Math.round((await page.rect(row(name)))?.height ?? 0);
			}
		}

		page.check(
			`rows with an avatar are as tall as the others (${JSON.stringify(heights)})`,
			new Set(Object.values(heights)).size === 1
		);
		await page.screenshot("veiled", {selector: "#sidebar"});

		// 5. #plain opened with nothing known: asked once.
		const asked = () => received.filter((l) => l === "METADATA #plain GET avatar").length;
		await page.click(row("#plain"));
		await page.waitFor(activeIs("#plain"), {label: "#plain open"});
		await page.sleep(1500);
		page.check(`#plain: asked for its avatar once (${asked()})`, asked() === 1);
		await page.click(row("#games"));
		await page.click(row("#plain"));
		await page.sleep(800);
		page.check(`#plain: not asked again (${asked()})`, asked() === 1);

		// 2–3. #art (op, veiled): its menu leads with showing it, then has
		// "Channel avatar…"; the dialog says where the picture is and loads it.
		await rightClick(page, row("#art"));
		const artMenu = await menuLabels(page);
		page.check(
			`#art menu: showing it first (${artMenu.slice(0, 3).join(" | ")})`,
			artMenu[1] === "action-avatar:Show this channel's avatar" &&
				artMenu[2] === "action-avatar:Always show avatars from img.test"
		);
		page.check(
			`#art menu: "Channel avatar…" (${artMenu.join(" | ")})`,
			artMenu.includes("channel-avatar:Channel avatar…")
		);
		await page.click(`${MENU} .context-menu-channel-avatar`);
		await page.waitFor(exists(`#channel-avatar-overlay.opened ${DIALOG}`), {
			label: "#art dialog",
		});
		const veiledNote = await page.evaluate(
			`document.querySelector("${DIALOG} .avatar-settings-veiled p")?.textContent.trim()`
		);
		page.check(
			`#art dialog: says where the picture is (${veiledNote})`,
			veiledNote ===
				"This channel's avatar is on img.test. Loading it tells that site your IP address."
		);
		await page.screenshot("dialog-veiled", {selector: DIALOG, pad: 16});
		await page.click(`${DIALOG} .avatar-settings-veiled button`);
		await page.waitFor(
			`document.querySelector("${DIALOG} .avatar-settings-preview img")?.naturalWidth > 0`,
			{label: "#art picture in the dialog"}
		);
		page.check(
			"#art dialog: the note goes once it shows",
			(await page.count(`${DIALOG} .avatar-settings-veiled`)) === 0
		);
		page.check("#art row: the picture too", (await icon(page, "#art"))?.loaded === true);
		await page.click("#channel-avatar-dialog .channel-avatar-close");
		await page.waitFor(`!document.querySelector("#channel-avatar-overlay.opened")`, {
			label: "#art dialog closed",
		});

		// 4. #games from the chat header's button: the empty state shows what
		// the row shows; a link on a host nobody trusts shows at once to the
		// op who set it; Escape waits for a change on its way.
		await page.click(row("#games"));
		await page.waitFor(activeIs("#games"), {label: "#games open"});
		await page.click("#chat button.menu");
		await page.waitFor(exists(MENU), {label: "header menu"});
		await page.click(`${MENU} .context-menu-channel-avatar`);
		await page.waitFor(exists(`#channel-avatar-overlay.opened ${DIALOG}`), {
			label: "dialog open",
		});
		const heading = await page.evaluate(`document.querySelector("${DIALOG} h3")?.textContent`);
		page.check(`dialog heading (${heading})`, heading === "Avatar for #games");
		const placeholder = await page.evaluate(
			`document.querySelector("${DIALOG} .avatar-settings-placeholder")?.textContent.trim()`
		);
		page.check(
			`dialog: the row's emoji while there is none (${placeholder})`,
			placeholder === "🎮"
		);
		page.check(
			"dialog: no Remove while there is none",
			(await page.count(`${DIALOG} .avatar-settings-buttons .btn-cancel`)) === 0
		);
		page.check(
			"dialog: no network switch",
			(await page.count(`${DIALOG} .avatar-settings-switch`)) === 0
		);
		page.check(
			"dialog: focus is inside",
			await page.evaluate(`!!document.activeElement?.closest("${DIALOG}")`)
		);
		await page.screenshot("dialog-empty", {selector: DIALOG, pad: 16});

		const toggle = `${DIALOG} .avatar-settings-buttons button[aria-expanded]`;
		const field = `${DIALOG} input[type="url"]`;
		const statusOf = () =>
			page.evaluate(`(() => {
				const el = document.querySelector("${DIALOG} .avatar-settings-body .avatar-settings-status");
				return el ? {text: el.textContent.trim(), kind: el.className, role: el.getAttribute("role")} : null;
			})()`);

		await page.click(toggle);
		await page.waitFor(
			`document.activeElement === document.querySelector(${JSON.stringify(field)})`,
			{
				label: "the link field takes the caret",
			}
		);
		await page.click(`${DIALOG} .avatar-settings-link-actions button[type="button"]`);
		await page.waitFor(`!document.querySelector(${JSON.stringify(field)})`, {
			label: "Cancel closes it",
		});
		page.check(
			"Cancel: the caret goes back to Use a link",
			await page.evaluate(
				`document.activeElement === document.querySelector(${JSON.stringify(toggle)})`
			)
		);

		await page.click(toggle);
		await page.waitFor(exists(field), {label: "link field"});
		await page.fill(field, `${IMG}/slow.png`);
		await page.click(`${DIALOG} .avatar-settings-link button[type="submit"]`);
		await page.waitFor(exists(`${DIALOG} .avatar-settings-preview.busy`), {label: "busy"});
		const saving = await statusOf();
		page.check(
			`saving: said beside the buttons (${JSON.stringify(saving)})`,
			saving?.text === "Saving…" && saving.kind.includes("is-busy")
		);
		await escape(page);
		await page.sleep(200);
		page.check(
			"saving: Escape leaves the dialog up",
			await page.evaluate(exists("#channel-avatar-overlay.opened"))
		);
		await page.screenshot("dialog-saving", {selector: DIALOG, pad: 16});
		await page.waitFor(
			`document.querySelector("${DIALOG} .avatar-settings-status")?.textContent.trim() === "The channel's avatar was changed."`,
			{label: "saved"}
		);
		page.check(
			"SET went out",
			received.includes(`METADATA #games SET avatar :${IMG}/slow.png`)
		);
		page.check(
			`saved: plain, not muted (${(await statusOf())?.kind})`,
			(await statusOf())?.kind.includes("is-ok")
		);
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				`${row("#games")} > .avatar img`
			)})?.naturalWidth > 0`,
			{label: "#games picture, though img.test is not trusted"}
		);
		page.check(
			"#games: the picture now, not the emoji",
			(await icon(page, "#games"))?.before === null
		);
		page.check(
			"#games: other pictures on img.test still veiled",
			/avatar-veiled/.test((await icon(page, "#garden"))?.avatar ?? "")
		);
		page.check(
			"saved: the caret is back on Use a link",
			await page.evaluate(
				`document.activeElement === document.querySelector(${JSON.stringify(toggle)})`
			)
		);
		await page.screenshot("dialog-saved", {selector: DIALOG, pad: 16});

		// A refusal reads as one, in words.
		await page.click(toggle);
		await page.waitFor(exists(field), {label: "link field again"});
		page.check("reopening the form clears the old status", (await statusOf()) === null);
		await page.fill(field, `${IMG}/refuse.png`);
		await page.click(`${DIALOG} .avatar-settings-link button[type="submit"]`);
		await page.waitFor(exists(`${DIALOG} .avatar-settings-status.is-error`), {
			label: "refused",
		});
		const refused = await statusOf();
		page.check(
			`refused: an alert in words (${JSON.stringify(refused)})`,
			refused?.role === "alert" &&
				refused.text ===
					"The network refused: only #games's half-ops and ops can change its avatar."
		);
		await page.screenshot("dialog-refused", {selector: DIALOG, pad: 16});
		await page.click(`${DIALOG} .avatar-settings-link-actions button[type="button"]`);

		await page.click(`${DIALOG} .avatar-settings-buttons .btn-cancel`);
		await page.waitFor(
			`document.querySelector("${DIALOG} .avatar-settings-status")?.textContent.trim() === "The channel's avatar was removed."`,
			{label: "removed"}
		);
		page.check("bare SET went out", received.includes("METADATA #games SET avatar"));
		const back = await icon(page, "#games");
		page.check(
			`#games: the emoji again (${back?.before})`,
			back?.avatar === null && back?.before === '"🎮"'
		);
		await escape(page);
		await page.waitFor(`!document.querySelector("#channel-avatar-overlay.opened")`, {
			label: "dialog closed by Escape",
		});

		// 3. Not op in #garden: no "Channel avatar…"; "Always" loads its host's.
		await rightClick(page, row("#garden"));
		const gardenMenu = await menuLabels(page);
		page.check(
			`#garden menu: no "Channel avatar…" (${gardenMenu.join(" | ")})`,
			!gardenMenu.some((l) => l.startsWith("channel-avatar:"))
		);
		await page.click(`${MENU} .context-menu-action-avatar`, 1);
		await page.waitFor(`!document.querySelector(${JSON.stringify(MENU)})`, {
			label: "menu closed",
		});
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				`${row("#garden")} > .avatar img`
			)})?.naturalWidth > 0`,
			{label: "#garden picture"}
		);

		// 6. Another op's change.
		push(`:tiny.test METADATA #plain avatar * :${IMG}/plain.png`);
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				`${row("#plain")} > .avatar img`
			)})?.naturalWidth > 0`,
			{label: "#plain picture from a change"}
		);

		// 7. Activity pulses the avatar.
		push(":bob!u@tiny PRIVMSG #art :hello");
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				row("#art")
			)})?.classList.contains("has-activity")`,
			{
				label: "#art activity",
			}
		);
		const pulsing = await icon(page, "#art");
		page.check(
			`#art: the avatar pulses (${pulsing?.animation})`,
			pulsing?.animation === "avatar-typing-pulse"
		);
		await page.screenshot("sidebar", {selector: "#sidebar"});

		// 8. An unsent draft's pen takes the avatar's slot, as it takes the
		// icon's and the emoji's.
		await page.click(row("#art"));
		await page.waitFor(activeIs("#art"), {label: "#art active"});
		await page.fill("#input", "half a thought");
		await page.click(row("#games"));
		await page.waitFor(
			`document.querySelector(${JSON.stringify(
				row("#art")
			)})?.classList.contains("has-draft")`,
			{label: "#art has a draft"}
		);
		const drafted = await page.evaluate(`(() => {
			const el = document.querySelector(${JSON.stringify(row("#art"))});
			const avatar = el.querySelector(":scope > .avatar");
			return {
				pen: getComputedStyle(el, "::before").content,
				avatar: avatar ? getComputedStyle(avatar).display : null,
				height: el.getBoundingClientRect().height,
				plain: document.querySelector(${JSON.stringify(row("#plain"))}).getBoundingClientRect().height,
			};
		})()`);
		page.check(
			`#art with a draft: the pen (${drafted.pen}), not the avatar (${drafted.avatar})`,
			drafted.pen.includes("\uf304") && drafted.avatar === "none"
		);
		page.check(
			`#art with a draft: the row keeps its height (${drafted.height} vs ${drafted.plain})`,
			Math.abs(drafted.height - drafted.plain) < 0.5
		);
		await page.screenshot("sidebar-draft", {selector: "#sidebar"});

		page.check(
			`no console errors${
				page.consoleErrors.length ? `: ${page.consoleErrors.join(" | ")}` : ""
			}`,
			page.consoleErrors.length === 0
		);
	} finally {
		await ircd.close();
		await images.close();
	}
}
