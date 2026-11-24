// Live rows (client/js/liveRows.ts, docs/resources/themes.md § Live rows) in a
// real browser. In the open channel: someone else's line arriving is drawn
// with `data-live` (`message`, or `mention` when it names us), even while a
// pending copy of our own line sits below it; our own line confirmed by its
// echo is `self`; a part, a quit and a kick are `part`, `quit`, `kick`, and a
// status line folded into a condensed group marks the group's row; a reaction
// arriving marks its chip `data-arrived` (`first`, `new`, `more`). A mention in
// another channel marks that channel's sidebar row `data-mentioned`, and
// opening it ends that. A line in another channel is not live when read later,
// coming back to a channel draws none of its rows as live again, every hook
// is gone after the hold, and a reload draws the kept lines, and a catch-up
// with a line and a reaction (one of them named `constructor`), with none. A
// chip taken off in the same breath as it came leaves no note behind for the
// same reaction put back later, not live. Under reduced motion every hook is
// still set. style.css animates nothing on any of them.
//
//   pnpm build && python3 -m http.server -d "$PWD/public" 8000 &
//   node tools/browser-drive.mjs tools/scenarios/live-rows.mjs
//
// No ircd needed: lib/tiny-ircd.mjs, whose socket the scenario writes to.
// `SEANCE_PORT` serves the app from another port.

import {chathistory, coldLoad} from "./lib/kept.mjs";
import {startTinyIrcd} from "./lib/tiny-ircd.mjs";

const PORT = process.env.SEANCE_PORT ?? "8000";
const IRCD_PORT = 9878;
const CHANNEL = "#live";
const OTHER = "#elsewhere";
const NICK = "liver";

export const url = `http://localhost:${PORT}/?host=127.0.0.1&port=${IRCD_PORT}&tls=false&nick=${NICK}&join=${encodeURIComponent(
	`${CHANNEL},${OTHER}`
)}`;
export const allowWsFrameErrors = /after close/;

const ROW = (text) =>
	`[...document.querySelectorAll("#chat .msg")].find((m) => m.textContent.includes(${JSON.stringify(
		text
	)}))`;
const LIVE = (text) => `(${ROW(text)}?.dataset.live ?? null)`;
const LAST = (type) =>
	`[...document.querySelectorAll('#chat .messages > .msg[data-type="${type}"]')].at(-1)`;
const LAST_LIVE = (type) => `(${LAST(type)}?.dataset.live ?? null)`;
const CHIP = (emoji) =>
	`[...document.querySelectorAll("#chat .msg-reaction")].find((b) => b.querySelector(".msg-reaction-text")?.textContent === ${JSON.stringify(
		emoji
	)})`;
const ARRIVED = (emoji) => `(${CHIP(emoji)}?.dataset.arrived ?? null)`;
const ANY_LIVE = `document.querySelectorAll("#chat .msg[data-live], #chat .msg-reaction[data-arrived]").length`;
const ANY_MENTIONED = `document.querySelectorAll(".channel-list-item[data-mentioned]").length`;
const INPUT = `document.querySelector("#input")`;

export default async function run(page) {
	let send = () => {};
	let joins = 0;
	const ircd = startTinyIrcd({
		port: IRCD_PORT,
		// echo-message: a line of ours stays pending until its echo, which
		// comes only for a line that says so. chathistory: the reload's
		// catch-up brings a line and a reaction.
		caps: "echo-message message-tags batch draft/chathistory",
		isupport: "CHATHISTORY=100 MSGREFTYPES=timestamp,msgid",
		onLine(line, ctx) {
			send = ctx.send;
			const bare = line.replace(/^@\S+ /, "");
			const [cmd, ...args] = bare.split(" ");

			if (cmd === "JOIN") {
				joins++;

				for (const chan of [CHANNEL, OTHER]) {
					ctx.send(`:${ctx.nick}!u@tiny JOIN ${chan}`);
					ctx.send(
						`:tiny.test 353 ${ctx.nick} = ${chan} :${ctx.nick} alice bob carol dave erin`
					);
					ctx.send(`:tiny.test 366 ${ctx.nick} ${chan} :End of /NAMES list.`);
				}

				return true;
			}

			if (cmd === "CHATHISTORY") {
				if (args[0] === "LATEST" && args[1] === CHANNEL && joins > 1) {
					// After the reload, once the page has settled on the channel.
					setTimeout(() => {
						const now = new Date().toISOString();
						chathistory(ctx.send, CHANNEL, [
							`@time=${now};msgid=c1 :alice!u@tiny PRIVMSG ${CHANNEL} :caught up line`,
							`@time=${now};msgid=c2;+draft/react=🚀;+draft/reply=r1 :erin!u@tiny TAGMSG ${CHANNEL}`,
							`@time=${now};msgid=c3;+draft/react=constructor;+draft/reply=r1 :erin!u@tiny TAGMSG ${CHANNEL}`,
						]);
					}, 1500);
				} else {
					chathistory(ctx.send, args[1] ?? CHANNEL, [], true);
				}

				return true;
			}

			if (cmd === "PRIVMSG" && bare.endsWith(":mine, echoed")) {
				ctx.send(`:${ctx.nick}!u@tiny ${bare}`);
				return true;
			}

			// Swallow our other PRIVMSGs: no echo, so the copy stays pending.
			return cmd === "PRIVMSG" || cmd === "TAGMSG" || cmd === "MODE" || cmd === "WHO";
		},
	});
	const from = (nick) => `:${nick}!u@tiny`;
	const say = (nick, text, chan = CHANNEL, tags = "") =>
		send(`${tags ? `@${tags} ` : ""}${from(nick)} PRIVMSG ${chan} :${text}`);
	const react = (nick, emoji, msgid) =>
		send(`@+draft/react=${emoji};+draft/reply=${msgid} ${from(nick)} TAGMSG ${CHANNEL}`);
	const shows = (text) => page.waitFor(`!!${ROW(text)}`, {label: text});
	const liveIs = async (text, want, label) => {
		const got = await page.evaluate(LIVE(text));
		page.check(`${label}: data-live ${want} (${got})`, got === want);
	};
	const lastLiveIs = async (type, want, label) => {
		await page.waitFor(`!!${LAST(type)}`, {label: `a ${type} row`});
		const got = await page.evaluate(LAST_LIVE(type));
		page.check(`${label}: data-live ${want} (${got})`, got === want);
	};
	const arrivedIs = async (emoji, want, label) => {
		await page.waitFor(`!!${CHIP(emoji)}`, {label: `the ${emoji} chip`});
		const got = await page.evaluate(ARRIVED(emoji));
		page.check(`${label}: data-arrived ${want} (${got})`, got === want);
	};
	const item = (name) => `document.querySelector('.channel-list-item[data-name="${name}"]')`;
	// The page hidden or shown, as a phone's lock would (gallery.mjs's shim).
	const visibility = (state) =>
		page.evaluate(`(() => {
			Object.defineProperty(document, "visibilityState", {configurable: true, get: () => ${JSON.stringify(
				state
			)}});
			Object.defineProperty(document, "hidden", {configurable: true, get: () => ${state === "hidden"}});
			document.dispatchEvent(new Event("visibilitychange"));
		})()`);
	const mentioned = (name) => page.evaluate(`!!${item(name)}?.hasAttribute("data-mentioned")`);
	const enter = async (text) => {
		await page.click("#input");
		await page.send("Input.insertText", {text});
		const key = {key: "Enter", code: "Enter", windowsVirtualKeyCode: 13};
		await page.send("Input.dispatchKeyEvent", {type: "keyDown", text: "\r", ...key});
		await page.send("Input.dispatchKeyEvent", {type: "keyUp", ...key});
	};

	try {
		await page.send("Emulation.setFocusEmulationEnabled", {enabled: true});
		await page.goto(page.url, {waitForSelector: "#connect form"});
		// Saved to connect on its own, so the reload below reconnects.
		await page.evaluate(`document.querySelector('#connect input[name="autoconnect"]').click()`);
		await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
		await page.waitFor(item(CHANNEL), {label: CHANNEL});
		await page.evaluate(`${item(CHANNEL)}.click()`);
		await page.waitFor(INPUT, {label: "the channel"});
		await page.sleep(1000);
		page.check("after our own joins: no live row", (await page.evaluate(ANY_LIVE)) === 0);

		say("alice", "hello");
		await shows("hello");
		await liveIs("hello", "message", "a message");

		say("bob", `${NICK}: ping`);
		await shows("ping");
		await liveIs("ping", "mention", "a mention");
		page.check(
			"a mention in the open channel: its sidebar row is not data-mentioned",
			!(await mentioned(CHANNEL))
		);

		// Our own line, confirmed by its echo: the row that replaces the
		// pending copy.
		await enter("mine, echoed");
		await page.waitFor(
			`${ROW("mine, echoed")} && !${ROW("mine, echoed")}.classList.contains("pending")`,
			{
				label: "the echo",
			}
		);
		await liveIs("mine, echoed", "self", "our own line, echoed");

		// Reactions: the message's first chip, another chip, another nick.
		say("alice", "react to me", CHANNEL, "msgid=r1");
		await shows("react to me");
		react("bob", "👍", "r1");
		await arrivedIs("👍", "first", "the first reaction");
		react("carol", "🎉", "r1");
		await arrivedIs("🎉", "new", "another chip");
		await page.sleep(100);
		react("dave", "🎉", "r1");
		await page.waitFor(
			`${CHIP("🎉")}?.querySelector(".msg-reaction-count")?.textContent === "2"`,
			{
				label: "two on 🎉",
			}
		);
		await arrivedIs("🎉", "more", "another nick on a chip");

		// Put on and taken off in one go (one frame), so the chip is never
		// drawn: its note goes with it. The same reaction put back while the
		// page is hidden is not live, and finds no note to take.
		send(
			`@+draft/react=👀;+draft/reply=r1 ${from("bob")} TAGMSG ${CHANNEL}\r\n` +
				`@+draft/unreact=👀;+draft/reply=r1 ${from("bob")} TAGMSG ${CHANNEL}`
		);
		await page.sleep(100);
		await visibility("hidden");
		react("carol", "👀", "r1");
		await page.waitFor(`!!${CHIP("👀")}`, {label: "the 👀 chip"});
		const putBack = await page.evaluate(ARRIVED("👀"));
		await visibility("visible");
		page.check(
			`a chip taken off unseen, put back while hidden: no data-arrived (${putBack})`,
			putBack === null
		);

		// Someone leaving: a part on its own row, then a quit that folds it
		// into a condensed group, which is the row drawn and takes the mark.
		say("alice", "before leaving");
		await shows("before leaving");
		send(`${from("bob")} PART ${CHANNEL} :later`);
		await lastLiveIs("part", "part", "a part");
		send(`${from("carol")} QUIT :gone`);
		await lastLiveIs("condensed", "quit", "a quit folded into a condensed group");
		page.check(
			"the part has no row of its own now",
			(await page.evaluate(`!${LAST("part")}`)) === true
		);
		say("alice", "between");
		await shows("between");
		send(`${from("alice")} KICK ${CHANNEL} dave :out`);
		await lastLiveIs("kick", "kick", "a kick");

		// A pending copy of ours at the bottom: the line that arrives goes in
		// above it and is still marked.
		await enter("mine, pending");
		await page.waitFor(`!!document.querySelector("#chat .msg.pending")`, {label: "pending"});
		say("alice", "under the pending one");
		await shows("under the pending one");
		await liveIs("under the pending one", "message", "above a pending copy");
		page.check(
			"the pending copy is still last",
			await page.evaluate(
				`[...document.querySelectorAll("#chat .msg")].at(-1).classList.contains("pending")`
			)
		);

		// A mention elsewhere: that channel's sidebar row, not a plain line.
		say("erin", "just chatting", OTHER);
		await page.waitFor(`!!${item(OTHER)}?.classList.contains("has-unread")`, {
			label: "a line in the other channel",
		});
		page.check("a plain line elsewhere: no data-mentioned", !(await mentioned(OTHER)));
		say("erin", `${NICK}: over here`, OTHER);
		await page.waitFor(`!!${item(OTHER)}?.hasAttribute("data-mentioned")`, {
			label: "a mention elsewhere marks its sidebar row",
		});
		page.check("a mention elsewhere: data-mentioned", true);

		// The arrival is over (LIVE_HOLD_MS, 3 s): the attributes are gone, so
		// nothing can replay them.
		await page.sleep(3300);
		page.check(
			`three seconds on: no row or chip keeps its mark (${await page.evaluate(ANY_LIVE)})`,
			(await page.evaluate(ANY_LIVE)) === 0
		);
		// The sidebar's hold is swept once a second, like the activity pulse.
		await page.waitFor(`${ANY_MENTIONED} === 0`, {
			label: "the sidebar row drops data-mentioned",
			timeout: 2000,
		});
		page.check("a second more: the sidebar row drops data-mentioned", true);

		// Elsewhere, then back: nothing drawn again is live. The other channel
		// is opened at once, inside LIVE_MS, so a note wrongly taken for a
		// channel not on screen would still be fresh.
		say("alice", "somewhere else", OTHER);
		say("alice", `${NICK}: and again`, OTHER);
		await page.waitFor(`!!${item(OTHER)}?.hasAttribute("data-mentioned")`, {
			label: "mentioned again",
		});
		await page.evaluate(`${item(OTHER)}.click()`);
		await shows("somewhere else");
		await liveIs("somewhere else", null, "a line read later in its channel");
		await liveIs("and again", null, "a mention read later in its channel");
		page.check(
			"opened: no sidebar row is data-mentioned",
			(await page.evaluate(ANY_MENTIONED)) === 0
		);
		await page.evaluate(`${item(CHANNEL)}.click()`);
		await shows("hello");
		page.check("back again: no row or chip is live", (await page.evaluate(ANY_LIVE)) === 0);
		page.check("and the channel just left keeps no data-mentioned", !(await mentioned(OTHER)));

		await page.send("Emulation.setEmulatedMedia", {
			features: [{name: "prefers-reduced-motion", value: "reduce"}],
		});
		await page.waitFor(`document.documentElement.hasAttribute("data-reduce-motion")`, {
			label: "reduced motion on",
		});
		say("alice", "still here");
		await shows("still here");
		await liveIs("still here", "message", "reduced motion");
		react("erin", "🔥", "r1");
		await arrivedIs("🔥", "new", "reduced motion, a reaction");
		send(`${from("erin")} PART ${CHANNEL}`);
		await lastLiveIs("part", "part", "reduced motion, a part");
		say("bob", `${NICK}: quietly`, OTHER);
		await page.waitFor(`!!${item(OTHER)}?.hasAttribute("data-mentioned")`, {
			label: "reduced motion, a mention elsewhere",
		});
		page.check("reduced motion, a mention elsewhere: data-mentioned", true);

		const animations = await page.evaluate(`[
			getComputedStyle(${ROW("still here")}).animationName,
			getComputedStyle(${LAST("part")}).animationName,
			getComputedStyle(${item(OTHER)}).animationName,
		]`);
		page.check(
			`style.css animates nothing on them (${animations})`,
			animations.every((name) => name === "none")
		);
		await page.send("Emulation.setEmulatedMedia", {features: []});

		// A reload draws what the device kept, and the catch-up brings a line
		// and a reaction into the open channel: none of it is live.
		await page.sleep(1200); // past the store's write throttle
		await coldLoad(page, `${ROW("react to me")}`);
		page.check(
			`after the reload: no live row or chip (${await page.evaluate(ANY_LIVE)})`,
			(await page.evaluate(ANY_LIVE)) === 0
		);
		await page.waitFor(`!!${ROW("caught up line")} && !!${CHIP("🚀")}`, {
			label: "the catch-up's line and reaction",
			timeout: 15000,
		});
		page.check(
			`the catch-up landed in the open channel (${await page.evaluate(
				`document.querySelector(".channel-list-item.active")?.dataset.name`
			)})`,
			(await page.evaluate(`!!${item(CHANNEL)}?.classList.contains("active")`)) === true
		);
		await liveIs("caught up line", null, "a catch-up line");
		await arrivedIs("🚀", null, "a catch-up reaction");
		await arrivedIs("constructor", null, "a catch-up reaction named constructor");
		page.check(
			`after the catch-up: nothing live anywhere (${await page.evaluate(
				ANY_LIVE
			)}, ${await page.evaluate(ANY_MENTIONED)})`,
			(await page.evaluate(ANY_LIVE)) === 0 && (await page.evaluate(ANY_MENTIONED)) === 0
		);
	} finally {
		await ircd.close();
	}
}
