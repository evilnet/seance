#!/usr/bin/env node
/* eslint-disable no-console */
// Live two-bot test of Lua scripting: every event a script can subscribe to,
// seen by a real script in a real browser over a real ircd. Runs against the
// dev ircd (tools/nefarious-dev/run.sh); `SEANCE_IRC_URL` points it at
// another server (default wss://localhost:8443/) and `SEANCE_IRC_CHANNEL`
// names the channel (default #seance-testing). The channel must be empty:
// Bot B joins first, takes ops, and kicks, voices and sets the topic.
//
//   SEANCE_IRC_URL=wss://fractalrealities.afternet.org:9998/ \
//     node tools/scenarios/test-lua-live.mjs
//
// Two headless Chromium instances:
//   Bot B: channel operator; responds to pings and records join, part,
//          quit, nick and kick
//   Bot A: initiator; records send, kick (of itself), topic and mode, and
//          runs the custom /testcmd
//
// Events covered: message (channel and private, with seance.reply), send,
// join, part, quit, kick, nick, topic, mode; plus a custom command and
// seance.storage surviving a reload.

import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {join, extname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {startDevice} from "./lib/device.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ircd = new URL(process.env.SEANCE_IRC_URL ?? "wss://localhost:8443/");
const IRC_HOST = ircd.hostname + ircd.pathname.replace(/\/$/, "");
const IRC_PORT = Number(ircd.port || (ircd.protocol === "wss:" ? 443 : 80));
const IRC_TLS = ircd.protocol === "wss:";
const CHANNEL = process.env.SEANCE_IRC_CHANNEL ?? "#seance-testing";
const PUBLIC_DIR = resolve(__dirname, "../../public");

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startStaticServer() {
	const server = createServer(async (req, res) => {
		try {
			const parsed = new URL(req.url, "http://localhost");
			let path = parsed.pathname;
			if (path === "/" || path === "") {
				path = "/index.html";
			}

			let filePath = join(PUBLIC_DIR, path);
			let ext = extname(filePath).toLowerCase();
			let data;

			try {
				data = await readFile(filePath);
			} catch {
				// Fallback to index.html for SPA router
				filePath = join(PUBLIC_DIR, "index.html");
				ext = ".html";
				data = await readFile(filePath);
			}

			res.writeHead(200, {
				"Content-Type": MIME[ext] || "application/octet-stream",
				"Content-Length": data.length,
				"Cache-Control": "no-store",
			});
			res.end(data);
		} catch (err) {
			res.writeHead(500);
			res.end(`Internal error: ${err.message}`);
		}
	});

	await new Promise((res) => server.listen(0, "127.0.0.1", res));
	const port = server.address().port;
	return {
		server,
		port,
		url: `http://127.0.0.1:${port}/`,
	};
}

const inChannel = `!!document.querySelector('.channel-list-item[data-name="${CHANNEL}"]:not(.parted-channel)')`;
const RATE_MS = 2500;

/** What a bot's script stored under `key`, as an expression for waitFor. */
function stored(scriptId, key, value) {
	return `JSON.parse(localStorage.getItem("thelounge.script_storage.${scriptId}") || "{}")[${JSON.stringify(
		key
	)}] === ${JSON.stringify(value)}`;
}

async function main() {
	console.log("=== Lua scripting live test ===");
	const {server, url} = await startStaticServer();
	console.log(`[HTTP] Seance served at ${url}; ircd ${ircd.href}; channel ${CHANNEL}`);

	const runId = Math.floor(1000 + Math.random() * 9000);
	const nickA = `sbot_a_${runId}`;
	const nickB = `sbot_b_${runId}`;
	const tok = {chan: `c${runId}`, pm: `p${runId}`, cmd: `k${runId}`};
	const topic = `Lua topic test ${runId}`;
	let curA = nickA;
	let botA, botB;

	const say = async (bot, text) => {
		await bot.fill("#input", text);
		await bot.click("#submit");
	};
	const pass = (n, what) => console.log(`>>> TEST ${n} PASSED: ${what}`);

	const scriptB = {
		id: "bot_b",
		name: "bot_b",
		folder: "Automation",
		description: "Live test: operator and responder",
		enabled: true,
		code: `
			local CH = "${CHANNEL}"
			local function rec(k, v) seance.storage.set(k, v) end
			local joins = 0

			seance.on("join", function(d)
				if not d.self and d.channel == CH then
					joins = joins + 1
					rec("join", d.nick .. "#" .. joins)
				end
			end)
			seance.on("part", function(d)
				if not d.self and d.channel == CH then rec("part", d.nick .. "|" .. (d.message or "")) end
			end)
			seance.on("quit", function(d)
				if string.find(d.nick, "${nickA}", 1, true) then rec("quit", d.nick) end
			end)
			seance.on("nick", function(d)
				if not d.self then rec("nick", d.oldNick .. "->" .. d.newNick) end
			end)
			seance.on("kick", function(d)
				if d.channel == CH then rec("kick", d.nick .. ">" .. d.kicked) end
			end)
			seance.on("message", function(msg)
				if msg.self then return end
				local text = msg.text or ""
				if msg.target == CH then
					local t = string.match(text, "^!ping_chan_(%w+)")
					if t then rec("chan", t); seance.reply(msg, "!pong_chan_" .. t) end
					t = string.match(text, "^!cmd_ping_(%w+)")
					if t then rec("cmd", t) end
				elseif not string.find(msg.target, "^[#&]") then
					local t = string.match(text, "^!ping_pm_(%w+)")
					if t then rec("pm", t); seance.reply(msg, "!pong_pm_" .. t) end
				end
			end)
		`,
	};

	const scriptA = {
		id: "bot_a",
		name: "bot_a",
		folder: "Automation",
		description: "Live test: initiator and target",
		enabled: true,
		code: `
			local CH = "${CHANNEL}"
			local function rec(k, v) seance.storage.set(k, v) end

			seance.on("send", function(d) rec("send", d.line or "") end)
			seance.on("kick", function(d)
				if d.channel == CH and d.self then rec("kicked", d.nick .. "|" .. (d.reason or "")) end
			end)
			seance.on("topic", function(d)
				if d.channel == CH then rec("topic", d.nick .. "|" .. d.topic) end
			end)
			seance.on("mode", function(d)
				if d.target == CH then
					rec("mode", d.from .. "|" .. d.mode .. "|" .. table.concat(d.params or {}, ","))
				end
			end)
			seance.on("message", function(msg)
				if msg.self then return end
				local text = msg.text or ""
				local t = string.match(text, "^!pong_chan_(%w+)")
				if t and msg.target == CH then rec("chan_ack", t) end
				t = string.match(text, "^!pong_pm_(%w+)")
				if t then rec("pm_ack", t) end
			end)
			seance.register_command("testcmd", function(args, rest)
				seance.send("PRIVMSG " .. CH .. " :!cmd_ping_" .. rest)
			end)
		`,
	};

	const seed = (nick, script) => {
		const net = {
			uuid: `net-${nick}`,
			name: "ScriptTest",
			host: IRC_HOST,
			port: IRC_PORT,
			tls: IRC_TLS,
			nick,
			username: nick,
			realname: "Seance Lua live test",
			join: CHANNEL,
			autoconnect: true,
		};
		return `
			try {
				localStorage.setItem("thelounge.state.installGuide", "dismissed");
				localStorage.setItem("settings", JSON.stringify({enableScripting: true}));
				localStorage.setItem("thelounge.networks", ${JSON.stringify(JSON.stringify([net]))});
				localStorage.setItem("thelounge.scripts", ${JSON.stringify(JSON.stringify([script]))});
				localStorage.setItem("thelounge.state.lastChannel", ${JSON.stringify(
					JSON.stringify({network: net.uuid, target: CHANNEL})
				)});
			} catch (e) {}
		`;
	};

	try {
		// --- Setup: Bot B first, so it creates the channel and holds ops ---
		botB = await startDevice({name: "bot-b", width: 1280, height: 900, logFrames: true});
		await botB.addInitScript(seed(nickB, scriptB));
		await botB.goto(url);
		await botB.waitFor(inChannel, {timeout: 60000, label: `Bot B joined ${CHANNEL}`});
		const op = `(document.querySelector('.userlist .user[data-name="${nickB}"]')?.textContent ?? "").trim().startsWith("@")`;

		try {
			await botB.waitFor(op, {timeout: 10000, label: "Bot B has ops"});
		} catch {
			throw new Error(
				`Bot B is not an operator in ${CHANNEL}: the channel must be empty (or set SEANCE_IRC_CHANNEL)`
			);
		}

		console.log(`[OK] Bot B joined ${CHANNEL} with ops.`);

		botA = await startDevice({name: "bot-a", width: 1280, height: 900, logFrames: true});
		await botA.addInitScript(seed(nickA, scriptA));
		await botA.goto(url);
		await botA.waitFor(inChannel, {timeout: 60000, label: `Bot A joined ${CHANNEL}`});
		await botA.click(`.channel-list-item[data-name="${CHANNEL}"]`);
		await botB.click(`.channel-list-item[data-name="${CHANNEL}"]`);

		// --- 1. join ---
		await botB.waitFor(stored("bot_b", "join", `${nickA}#1`), {
			timeout: 15000,
			label: "B saw A join",
		});
		pass(1, "join");
		await sleep(RATE_MS);

		// --- 2. message in the channel, seance.reply, and send ---
		await say(botA, `!ping_chan_${tok.chan}`);
		await botB.waitFor(stored("bot_b", "chan", tok.chan), {
			timeout: 15000,
			label: "B got the ping",
		});
		await botA.waitFor(stored("bot_a", "chan_ack", tok.chan), {
			timeout: 15000,
			label: "A got the pong",
		});
		await botA.waitFor(stored("bot_a", "send", `!ping_chan_${tok.chan}`), {
			timeout: 5000,
			label: "A saw its send",
		});
		pass(2, "channel message, seance.reply in a channel, send");
		await sleep(RATE_MS);

		// --- 3. private message and seance.reply ---
		await say(botA, `/msg ${nickB} !ping_pm_${tok.pm}`);
		await botB.waitFor(stored("bot_b", "pm", tok.pm), {timeout: 15000, label: "B got the PM"});
		await botA.waitFor(stored("bot_a", "pm_ack", tok.pm), {
			timeout: 15000,
			label: "A got the PM pong",
		});
		pass(3, "private message, seance.reply in a query");
		await sleep(RATE_MS);

		// --- 4. a custom command ---
		await botA.click(`.channel-list-item[data-name="${CHANNEL}"]`);
		await say(botA, `/testcmd ${tok.cmd}`);
		await botB.waitFor(stored("bot_b", "cmd", tok.cmd), {
			timeout: 15000,
			label: "B got the command's line",
		});
		pass(4, "custom command (seance.register_command, seance.send)");
		await sleep(RATE_MS);

		// --- 5. topic ---
		await say(botB, `/topic ${topic}`);
		await botA.waitFor(stored("bot_a", "topic", `${nickB}|${topic}`), {
			timeout: 15000,
			label: "A saw the topic",
		});
		pass(5, "topic");
		await sleep(RATE_MS);

		// --- 6. mode ---
		await say(botB, `/mode ${CHANNEL} +v ${curA}`);
		await botA.waitFor(stored("bot_a", "mode", `${nickB}|+v|${curA}`), {
			timeout: 15000,
			label: "A saw +v",
		});
		await sleep(RATE_MS);
		await say(botB, `/mode ${CHANNEL} -v ${curA}`);
		await botA.waitFor(stored("bot_a", "mode", `${nickB}|-v|${curA}`), {
			timeout: 15000,
			label: "A saw -v",
		});
		pass(6, "mode (+v and -v)");
		await sleep(RATE_MS);

		// --- 7. kick, then A rejoins ---
		await say(botB, `/kick ${curA} Lua kick test`);
		await botA.waitFor(stored("bot_a", "kicked", `${nickB}|Lua kick test`), {
			timeout: 15000,
			label: "A saw its kick",
		});
		await botB.waitFor(stored("bot_b", "kick", `${nickB}>${curA}`), {
			timeout: 15000,
			label: "B saw the kick",
		});
		await sleep(RATE_MS);
		await say(botA, "/join"); // the kicked channel is still the open one
		await botB.waitFor(stored("bot_b", "join", `${curA}#2`), {
			timeout: 15000,
			label: "B saw A rejoin",
		});
		await botA.waitFor(inChannel, {timeout: 15000, label: "A back in the channel"});
		pass(7, "kick (seen by the kicked and by the kicker)");
		await sleep(RATE_MS);

		// --- 8. part, then A rejoins ---
		await botA.click(`.channel-list-item[data-name="${CHANNEL}"]`);
		await say(botA, `/part ${CHANNEL} Lua part test`);
		await botB.waitFor(stored("bot_b", "part", `${curA}|Lua part test`), {
			timeout: 15000,
			label: "B saw the part",
		});
		await sleep(RATE_MS);
		await say(botA, `/join ${CHANNEL}`);
		await botB.waitFor(stored("bot_b", "join", `${curA}#3`), {
			timeout: 15000,
			label: "B saw A rejoin",
		});
		await botA.waitFor(inChannel, {timeout: 15000, label: "A back in the channel"});
		pass(8, "part");
		await sleep(RATE_MS);

		// --- 9. nick ---
		const newNick = `${nickA}x`;
		await botA.click(`.channel-list-item[data-name="${CHANNEL}"]`);
		await say(botA, `/nick ${newNick}`);
		await botB.waitFor(stored("bot_b", "nick", `${curA}->${newNick}`), {
			timeout: 15000,
			label: "B saw the nick change",
		});
		curA = newNick;
		pass(9, "nick");
		await sleep(RATE_MS);

		// --- 10. quit (the reload) and storage across it ---
		const persist = `persist_${runId}`;
		await say(botA, `/lua seance.storage.set("persist", "${persist}")`);
		await botA.waitFor(stored("global", "persist", persist), {
			timeout: 5000,
			label: "A stored the value",
		});
		console.log("[RELOAD] Reloading Bot A (its QUIT is the quit event)...");
		await botA.goto(url);
		await botB.waitFor(stored("bot_b", "quit", curA), {timeout: 15000, label: "B saw A quit"});
		// Generous: the reload is another connection from this address within
		// seconds, and the client waits out the server's connection throttle
		// (40 s gaps on nefarious2) rather than dial into it.
		await botA.waitFor(inChannel, {timeout: 90000, label: "A reconnected after the reload"});
		const kept = await botA.evaluate(
			`JSON.parse(localStorage.getItem("thelounge.script_storage.global") || "{}").persist`
		);

		if (kept !== persist) {
			throw new Error(
				`seance.storage did not survive the reload: expected ${persist}, got ${kept}`
			);
		}

		pass(10, "quit, and seance.storage across a reload");

		await sleep(RATE_MS);
		await say(botA, "/quit :Lua live test done").catch(() => {});
		await say(botB, "/quit :Lua live test done").catch(() => {});
		await sleep(1000);
		console.log("=== ALL LUA SCRIPTING LIVE TESTS PASSED ===");
		process.exitCode = 0;
	} catch (err) {
		console.error("\n❌ TEST FAILED:", err);

		for (const [name, bot] of [
			["Bot A", botA],
			["Bot B", botB],
		]) {
			if (!bot) {
				continue;
			}

			const storage = await bot
				.evaluate(
					`Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith("thelounge.script")))`
				)
				.catch(() => ({}));
			console.error(`${name} script storage:`, JSON.stringify(storage, null, 2));

			if (bot.consoleErrors?.length) {
				console.error(`${name} console errors:`, bot.consoleErrors);
			}
		}

		process.exitCode = 1;
	} finally {
		if (botA) await botA.close().catch(() => {});
		if (botB) await botB.close().catch(() => {});
		server.close();
	}
}

main();
