// The ps theme in a real browser (docs/projects/ps-theme.md §12). Picking it
// in Appearance swaps the stylesheet and mounts the scene behind the whole
// app — the sky, 190 stars, the sun and the moon, five clouds (nine in rain
// and a storm, each wet day's under a still deck, rain's the lighter), the plains (the land and river, the
// fireflies, the yurt and its smoke, the near grass), the birds and the
// day's weather (client/js/scenes/ps/scene.ts, through the hook in
// client/js/themeScene.ts). The run then:
//
// - reads the type: all nine font files (Source Sans 3 upright and italic,
//   Newsreader; Latin, Latin Extended and Vietnamese each) loaded, each drawing its text
//   rather than leaving it to the fallback (the latin-ext trap, ps-theme.md
//   §8) — the canvas widths the fonts were bundled with, and the fonts
//   Chromium reports it drew the neighbour's italic join, its Latin Extended
//   realname and line, a Latin Extended query name, and a Vietnamese name
//   upright, in italic and as a query in;
// - walks the clock with a time-zone override — noon, 22:00, midnight and
//   dusk (about 45 minutes after today's sunset) — and reads what the scene
//   publishes on <html>: the light (day/night), the words over the plains
//   (white all day and all night; dark ink only where it holds, which is a
//   snowy day), the canvas colour, and the real colour of another user's
//   message;
// - reads the chrome (§6): the sidebar, header, user list and composer are
//   glass — a blur over the day tint at noon, the night tint at 22:00 — and
//   #status-bar-tint never blurs and paints the canvas (style.css's touch
//   rule resolved on it: Chromium never paints it, the rule being WebKit's
//   alone); the send glyph is the generated text accent; the composer's top
//   is one 1px line in the edge, with the caret in it or not, and no band
//   under it (the user's, 2026-09-26 and 2026-09-27: at noon, at 22:00,
//   with the reply bar open and on a phone at noon); at 22:00 the idle channel names are the night soft ink and the
//   open one the night ink; under reduced transparency the glass turns solid
//   (a SKIP line, never a pass, where Chromium cannot emulate it); and the
//   browser's theme-color is the sky's canvas, coffee's own colour after a
//   switch, and the sky again after the switch back; in Settings the theme
//   select and its options are the solid in its ink at 22:00 and at noon
//   (the user's report, 2026-09-26: light text on a light list at night);
// - hides and shows the page: the scene stops (its class, all its SVG clocks
//   — 48, and 49 on a hot day with the haze — and every CSS animation in it)
//   and starts again, every SVG running but those in a layer outside its
//   window (ps-off, layers.ts) and the haze while it bends nothing; stays
//   stopped under reduced motion, its clouds (five, or nine on a wet day)
//   resting in as many places across the sky (--cp, on ps-drift's path)
//   rather than piled at the left edge; and a scene mounted into a hidden
//   page starts stopped;
// - under reduced motion, on a clear, a rainy, a hot, a snowy and a stormy
//   noon and at dusk with the skeins up (spec §9): the scene is stopped,
//   nothing in flight is rendered — no bird, drop, flake, seed, lightning or
//   smoke, out of the render tree rather than parked mid-flight — and no
//   animation on it runs; the veil stays at the weather's level, the
//   fireflies stand still where they are, the near grass upright, the heat
//   band still; on the rainy and the stormy noon all nine clouds rest in
//   nine places on the sky and the storm's deck stands; and the colours are
//   the hour's, the same as without reduced motion at the same minute;
// - pins the clock (a Date shim, in UTC) to fixed days, and reads the plains:
//   a clear noon (no drop, flake or seed in the page, no haze, white words,
//   the stars, the skeins, the fireflies and the smoke out of the render
//   tree, the five clouds alone), a rainy one (130 drops and the rain's 26
//   seeds, no flake; nine clouds, four of them the rain's, and no bird in
//   the render tree), a hot one (the haze on the ground group and not on the
//   near grass), a snowy one (120 flakes, dark ink words, snow on the roof,
//   five clouds) and a stormy one (nine clouds and the deck, no bird); a
//   rainy and a stormy dusk in the autumn passage fly no skein where a clear
//   one flies three (the user, 2026-09-26: birds don't fly in rainstorms); a
//   clear day at dawn, noon, golden hour, dusk and midnight; spring's
//   flowers, summer's dry river and autumn's running one; a clear evening
//   across local midnight into a rainy day and a rainy one into a clear
//   day, the weather layer and the rain's clouds rebuilt by the minute's
//   own timer (Review Focus 3), the rain's four fading in and out over 2 s
//   rather than popping (plan 4's final fix); and the storm's deck and
//   rain's lighter one (the user: "yes to the rain deck") measured
//   and shot at 1280 × 720 and on a 390 × 844 phone, its billows wide and
//   its band's edge closed on both;
// - samples rendered glyphs against the pixels around them (plan 4, spec
//   §11) at noon, golden hour, sunset, dusk, midnight and first light, on a
//   clear 4 August and a snowy 8 January: every message row's words, time
//   and nick in the column, shot as it is and as its twin in magenta
//   (calibrate.mjs's method), each held at the 10th percentile of its ring
//   one CSS px out — the words and times 4.5, the nicks 3 as large text
//   under the light treatment (4.5 otherwise), and the faint colour,
//   composited over the words' ring since nothing in the column paints it,
//   3 — with the scene stopped and the frame shot twice alike;
// - replies to a long line: the quote under the reply stays inside its text
//   column, and on the phone inside its row;
// - toggles the user list twice inside the yurt's 0.4 s fade and samples the
//   yurt every frame: it is never seen anywhere but where it stood and where
//   it ends, and ends fully shown at 72 % of the column (Review Focus 2);
// - follows the open conversation: channel, query, none (Settings); and a
//   query is frosted and still (spec §5.7): at a clear noon the root takes
//   ps-private, the scene's one wrapper (.ps-frost) is blurred, desaturated
//   and scaled while the root and #status-bar-tint are not, every animation
//   document.getAnimations() has on the scene is paused and every SVG
//   reports animationsPaused(), the published values are #seance's at the
//   same minute and the sun keeps its centre in the window; an hour on,
//   inside the query and shown again, the canvas has moved and the scene is
//   still; so at golden hour; and back in #seance it runs, unfrosted;
// - switches to coffee (the scene and its plains go and leave nothing on
//   <html>) and back to ps (one scene again, not two);
// - on a phone: a scene mounted there builds half the fireflies (17) and,
//   on a rainy day, half the drops and seeds (65 and 13); the yurt stands at
//   72 % of the column, kept whole on the screen, and the drawer opening
//   over the chat does not move it (Review Focus 5); the always-on glass
//   unblurred on the generated tint (the measured budget's fallback,
//   ps-theme.md §10), the header and composer at noon; the two overlays
//   glass again (Task 8c, §10.1): at noon the open drawer and the overlaid
//   user list blurred and brightened on the chips' tint the scene publishes
//   (the drawer blurred the moment it opens, and closing, still blurred as
//   it slides and until the slide has taken it off screen), and at 22:00 the
//   open drawer blurred on the night tint, on top of the scrim, not under it;
// - drifts each cloud (five, or nine on a wet day): its loop starts wholly
//   off the scene's left edge and ends wholly off its right, never popping
//   in (each drift is paused at its loop's two ends; late in the run, since
//   an animation paused from script no longer follows animation-play-state);
// - reloads onto Settings: with no message column the yurt stands at 70 % of
//   the scene, and fades to the column's far third once a conversation opens
//   (Review Focus 4);
// - blocks the scene's chunk and reloads: the daylight fallback stays, ink
//   over it, and the console complains of the blocked request and nothing
//   else — the hook's one warning, naming it;
// - and last boots cold with ps saved, straight onto #seance at 4× CPU,
//   four times, three of them with ps.css held back until the scene has
//   mounted (the yurt's boot race, the final review): the place in the
//   first frame the scene is laid out is where the yurt ends, nothing is
//   written at 0, and nothing fades.
//
// Along the way it keeps the older promises: **the browser fetches no animal
// file at all** — not in #seance, not in #kittens, not as a still under
// reduced motion — though the stylesheet still names every one; a message
// fades in, and an own message's echo settles up from its pending copy's
// 0.55 (ps-settle) while the pending copy runs no animation; the timestamp
// stays one line; nothing says "ps <3".
//
// And the embers (plan 4, spec §9), which replaced the <3 theme's glitter:
// one send lights one burst, four sparks on the echo and none on its pending
// copy; a reaction lights two over its chip, as the first chip enters with
// its group and as a second enters alone, both still rising 0.9 s in (the
// enter class held open) with the text column's clip widened meanwhile; a query
// and reduced motion light none; and a send's burst is shot still, mid-rise,
// at noon and at dusk.
//
// The animals are switched off, not removed (client/themes/ps.css, the block
// after `#theme-scene .ps-animals`). The checks must stay able to fail, and
// were watched failing on 2026-09-24 against a served public/themes/ps.css
// with rules appended (rebuild to restore it). One run appended both of
// - `#theme-scene .ps-animals{--ps-slot-a:var(--ps-horse)!important}` — the
//   layer paints and fetches horse.svg (horse-still.svg under reduced
//   motion) and every animal check names it;
// - `#chat .msg.self:last-child::before{content:"";animation:ps-fade .9s}` —
//   the send's glitter check failed (the embers have replaced that check);
// and another, on its own because a hidden scene fetches nothing,
// - `#theme-scene{display:none!important}` — the mount check, the switch
//   back to ps and the fallback check fail (and every "the scene runs", a
//   hidden element having no animations).
// The chrome's checks were watched failing on 2026-09-25 the same way, with
// - `#sidebar{backdrop-filter:none!important}` — the sidebar's glass checks
//   fail, at noon and at 22:00 (the phone's glass has had no filter since
//   the budget's fallback, 2026-09-25, so its checks read it unblurred).
// The phone's overlay checks (Task 8c) were watched failing on 2026-09-26
// against 7b4b521a's ps.css, the fallback's unblurred drawer and list.
// Plan 3's checks were watched failing on 2026-09-26 with
// - `#theme-scene .ps-ground{display:none!important}` appended — 169 of 179:
//   the plains are not drawn (at #seance, a clear noon, a hidden mount and
//   on the phone), and the yurt stands nowhere the design puts it (each
//   toggle, the phone, both halves of the load onto Settings).
// The final fix wave's 17 checks (2026-09-26: the clouds at rest under
// reduced motion, the drawer's blur through its slide, the four cold boots)
// were first run as a scratch port against 894aea43's build, where they
// failed as the bugs said: the five clouds all at 0, the drawer unblurred
// 80 ms into its close, and every held boot writing 0.00px and fading across.
// With the fixes: 196 of 196.
// The private view's 18 checks (2026-09-26: #seance and the query at a clear
// noon, the query an hour on and at golden hour, #seance again) were first
// run against 4cb7f7c3's build, which has neither the frost nor its wrapper:
// 20 failed, every one of them the query not frosted or not still, or the
// layers read through the wrapper that build lacks. With the frost: 214 of
// 214.
// The embers' 9 checks (plan 4, 2026-09-26: a send, the pending copy, two
// reactions, a query, reduced motion, the frames at noon and dusk) were first
// run against the same build serving 462ac945's ps.css, which has none: 215
// of 221, the six that light something failing (the send, both reactions,
// the hold, the two frames) and the three that light nothing passing. With
// the embers: 221 of 221.
// Reduced motion's 24 checks on fixed days (plan 4 task 2, 2026-09-26) were
// first run against 2335d4ab's build, whose reduced-motion block stops every
// animation but hides nothing: each of the six "nothing in flight is
// rendered" checks failed (the buzzard parked on the noon sky, the skeins
// and the seeds off an edge, the drops and flakes just above the top, the
// lightning at 0, the smoke's puffs at 0 — all in the render tree), the rest
// passed. With the layers hidden: 245 of 245.
// Rain and storms' checks (plan 4 task 3, 2026-09-26: cloudier, and no bird)
// were first run against 2f5f744b's build, which has five clouds in every
// weather and flies a skein in rain and a storm: 13 failed — nine clouds and
// the deck missing at the rainy and stormy noons, on the phone, on the
// rainy real-clock day, at 23:59 before the midnight crossing, in the
// drift and in the reduced-motion rests; the wet dusks flying a skein (42
// and 15 bird elements in the render tree); and the two noons' birds, read
// then inside the previous moment's fade (the buzzard's, the larks'). Those
// two now wait the fades out, and on that build the buzzard and the larks
// never flew in the wet: the dusks are the bird checks that tell.
// With the change: 268 of 268 on a rainy real day (26 September), where the
// drift's three checks a cloud cover nine clouds; 256 on a dry one.
// The faces' checks (plan 4 task 4, 2026-09-26: Source Sans 3 and
// Newsreader) were first run against 50115548's build, which still carries
// Mulish and Fraunces: 19 failed — the nine files not declared, the three
// Source Sans 3 canvas pairs equal to their serif, and the seven texts drawn
// in the old faces; the two Newsreader pairs passed, measured then against
// monospace, which is why they are measured against serif now. With the
// faces, the α measured on them and the palette regenerated: 268 of 268 on
// the same rainy real day.
// The reply quote's two checks (plan 4 task 5, fix round 1: a long quote
// stays in its text column, and on the phone in its row) were first run as
// a scratch port against c82ce398's build, whose text column is content-box:
// both failed, the quote's box 14px past the column's content box (its own
// padding and rule, inherited content-box). With the basis restated and the
// column border-box both pass.
// The glyph samples (plan 4 task 6, 2026-09-26) were first run as a scratch
// port of their leg against 45356f39's build with
// `#chat .chat, #chat .chat * { text-shadow: none !important }` appended to
// the served ps.css: 11 of the 12 moments' floor checks failed (the words
// 1.33–3.94, the nicks down to 1.01 at a clear noon); the snowy noon's held,
// dark ink over snow needing no halo. On the build as it is, every moment
// holds with room: the tightest, as a ratio to its floor, the nick at the
// snowy noon under dark ink (6.7 against 4.5), and by margin the faint
// colour at the same moment (5.1 against 3).
// With them, the select, the status bar's value and the reply quote: 304 of
// 304 on a rainy real day (26 September).
// Plan 4's final fix wave (2026-09-26): the storm deck's six checks and the
// midnight fade's four were first run as scratch ports of their legs
// against a build with fd0647c9's client. The deck's billows, sized in % of
// the deck, were tall on the phone (78×149 … 94×161: "wide" failed there,
// held at 1280 × 720); the rain's four were at opacity 1 the instant the day
// turned rainy and gone the instant it turned clear (both fades failed).
// With the billows tied to their width and the sets cross-faded: 314 of 314
// on a rainy real day (26 September).
// The composer's 16 checks (2026-09-26, the user's "a single thin line" and
// "a rounded box inside the frame") were first run as a scratch port against
// the build serving 5bf444d6's ps.css: 15 failed — the strip's top in the
// accent (still easing back 100 ms after the caret left) with a 2px inset
// band under it while the caret was in, a square field with no edge — and
// the phone's no-caret edge, which that build already drew plain, passed.
// With the field: 16 of 16. The field went at the user's word (2026-09-27,
// "nah i don't like the new input box. but the thin divider is good"), and
// its eight checks with it; the divider's eight stay.
//
//   NODE_ENV=production corepack yarn build && python3 -m http.server -d public 8021 &
//   node tools/browser-drive.mjs tools/scenarios/theme-ps.mjs
//
// A development build works too: its i18n tripwire ("[seance i18n] …"
// console warnings, compiled out of production) is one of the two kinds of
// line the fallback check sets aside by name (NOT_THE_SCENE).
//
// The default target is a plain-WS ircd on 127.0.0.1:8067 (the dev ircd's
// ws:// port); SEANCE_IRC_PORT overrides the port for a different rig, and
// SEANCE_HTTP_PORT the port the built `public/` is served on — worth setting
// deliberately, since a stale server already squatting on the default serves
// a *different* build and every check below then reports on that one.

import {mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";

const RUN = Date.now().toString(36);
const NICK = `ps${RUN}`;
/** The neighbour (see `neighbour`). */
const PEER = `${NICK}n`;
/**
 * A name in Latin Extended, for the fonts' second files (the latin-ext trap:
 * a face can load and still draw in the fallback). The ircd refuses it as a
 * nick (432 Erroneous Nickname), so the neighbour carries it as its realname,
 * which its join shows in italic, and says it in its line (upright); and a
 * query of that name puts it in Newsreader in the sidebar.
 */
const EXT_NAME = "Łucja";
/**
 * A Vietnamese name, for the fonts' third files: ễ (U+1EC5) is in neither the
 * Latin nor the Latin Extended file, so without the vietnamese subset the
 * name drew partly in the fallback. The neighbour says it upright and in
 * italic (IRC's ^], U+001D), and a query of that name sets it in Newsreader.
 */
const VI_NAME = "Nguyễn";
const BASE = `http://localhost:${process.env.SEANCE_HTTP_PORT ?? "8021"}/`;
const PORT = process.env.SEANCE_IRC_PORT ?? "8067";

export const url = `${BASE}?host=127.0.0.1&port=${PORT}&tls=false&nick=${NICK}&join=%23seance,%23kittens`;

const THEME_HREF = `document.getElementById("theme").getAttribute("href")`;
const OWN_TEXT = `hello from the plains ${RUN}`;
/** How long the echo of our own message is held back (see INSTALL_SHIM). */
const HOLD_MS = 1500;
/** The message text colour by day (ps.css `--chat-fg`, #1b2638) and from dusk. */
const INK = "rgb(27, 38, 56)";
const WHITE = "rgb(255, 255, 255)";
/** The daylight fallback's sky top (ps.css, `#theme-scene`), #3f8fe6. */
const FALLBACK_SKY = "rgb(63, 143, 230)";
/** What the hook warns when a scene's chunk does not load (themeScene.ts). */
const HOOK_WARNING = "The ps theme's scene did not load; its daylight fallback stays.";
/**
 * Console lines the fallback check sets aside by name, because they are the
 * rig's and not the scene's: a development build's i18n tripwire (compiled
 * out of production), and a GPU-less browser's answer to the translation
 * feature's WebGPU probe (client/js/translate/capability.ts), which runs
 * when a channel opens.
 */
const NOT_THE_SCENE = [
	/^warning \[seance i18n\] /,
	/^warning \[rendering\] No available adapters\. /,
];

/**
 * Hold back the echo of our own message (tools/scenarios/pending-messages.mjs's
 * technique): a real echo on this rig comes back in a couple of
 * milliseconds, too fast for the pending copy — which is where the <3 theme
 * started its send burst — to survive even one CDP round trip. Every other
 * frame passes straight through. Installed once, right after navigation and
 * before the connect form is submitted, so the client's own WebSocket is the
 * shimmed one.
 */
const INSTALL_SHIM = `(() => {
	const Native = WebSocket;
	const slow = new RegExp(${JSON.stringify(`PRIVMSG #seance :${OWN_TEXT}$`)});
	window.WebSocket = class extends Native {
		addEventListener(type, listener, ...rest) {
			if (type !== "message") {
				return super.addEventListener(type, listener, ...rest);
			}
			return super.addEventListener(type, (ev) => {
				if (slow.test(String(ev.data))) {
					setTimeout(() => listener(ev), ${HOLD_MS});
				} else {
					listener(ev);
				}
			}, ...rest);
		}
	};
	return true;
})()`;

/**
 * The page's clock, movable (the Date shim plan 3's own browser runs used):
 * `window.__setClock(ms)` puts the page at the
 * instant `ms`, running on from there, and `__setClock(null)` gives it back
 * the real time. Until then it is the real clock, so the rest of the run is
 * unchanged. Installed for every document before any page script, since the
 * scene reads `new Date()` when it mounts. It seeds no setting: the run picks
 * the theme itself.
 */
const CLOCK_SHIM = `(() => {
	const RealDate = Date;
	const realNow = RealDate.now.bind(RealDate);
	let offset = 0;
	function ShimDate(...a) {
		if (!new.target) return RealDate();
		return a.length ? new RealDate(...a) : new RealDate(realNow() + offset);
	}
	ShimDate.prototype = RealDate.prototype;
	ShimDate.now = () => realNow() + offset;
	ShimDate.UTC = RealDate.UTC;
	ShimDate.parse = RealDate.parse;
	window.Date = ShimDate;
	window.__setClock = (ms) => { offset = ms === null ? 0 : ms - realNow(); };
})()`;

/**
 * Every CSS animation that starts inside #chat, pseudo-elements included
 * (`animationstart` carries `pseudoElement`), logged into `window.__animLog`
 * with the id and classes of the message row it is in. An event log rather
 * than a poll of computed styles: the reaction's enter class lives only as
 * long as its animations, which a poll across CDP round trips can miss, and
 * an ember on a `::before` is exactly what a poll of the element itself would
 * never see.
 */
const INSTALL_ANIMATION_LOG = `(() => {
	if (window.__animLog) return true;
	window.__animLog = [];
	document.addEventListener(
		"animationstart",
		(e) => {
			const t = e.target;
			if (!(t instanceof Element) || !t.closest("#chat")) return;
			const row = t.closest(".msg");
			window.__animLog.push({
				name: e.animationName,
				pseudo: e.pseudoElement || "",
				cls: String(t.className),
				reaction: !!t.closest(".msg-reactions"),
				row: row ? row.id : null,
				rowCls: row ? String(row.className) : "",
				text: t.textContent.slice(0, 40),
			});
		},
		true
	);
	return true;
})()`;

/** The embers (ps.css, spec §9) in an animation log. */
const embersIn = (log) => log.filter((e) => e.name === "ps-ember");

/**
 * Pause every running ember (or those under `within`) `ms` into its own
 * timeline, its delay included, for a still frame of a burst; FINISH_EMBERS
 * ends the ones it paused. An animation paused from script stays paused,
 * so only these are touched.
 */
const FREEZE_EMBERS = (ms, within = null) => `(() => {
	window.__frozen = [];
	for (const a of document.getAnimations()) {
		const t = a.effect && a.effect.target;
		if (a.animationName !== "ps-ember" || a.playState !== "running") continue;
		if (${JSON.stringify(within)} && !t.closest(${JSON.stringify(within ?? "")})) continue;
		a.pause();
		a.currentTime = ${ms};
		window.__frozen.push(a);
	}
	return window.__frozen.length;
})()`;
const FINISH_EMBERS = `(() => { for (const a of window.__frozen ?? []) a.finish(); window.__frozen = []; })()`;

/**
 * Every reaction group or chip as it enters, read by a MutationObserver the
 * moment it is inserted: Vue puts the enter class on before it inserts the
 * element and takes it off a frame or more later, so it is certainly there.
 * For each: its classes, its chip's text, its own animation-name and the
 * animation-name the chip text's ::before and ::after resolve to. These are
 * computed styles at a fixed moment, where an animationstart event depends
 * on frames arriving: the query check once missed style.css's 160 ms pop
 * that way (plan 4, Task 1's fix round 1).
 */
const WATCH_ENTERS = `(() => {
	window.__enters = [];
	window.__entersObserver?.disconnect();
	const read = (el) => {
		const text = el.querySelector(".msg-reaction-text");
		window.__enters.push({
			cls: String(el.className),
			text: text ? text.textContent : "",
			own: getComputedStyle(el).animationName,
			sparks: text ? ["::before", "::after"].map((p) => getComputedStyle(text, p).animationName) : [],
		});
	};
	window.__entersObserver = new MutationObserver((records) => {
		for (const r of records) {
			for (const n of r.addedNodes) {
				if (!(n instanceof Element)) continue;
				for (const el of [n, ...n.querySelectorAll(".msg-reactions, .msg-reaction")]) {
					if (el.matches(".reactions-enter-active, .reaction-enter-active")) read(el);
				}
			}
		}
	});
	window.__entersObserver.observe(document.getElementById("chat"), {childList: true, subtree: true});
	return true;
})()`;

/** The animation-name each of a row's four spark pseudo-elements resolves to, and the row's own. */
const ROW_SPARKS = (row) => `(() => {
	const r = document.querySelector(${JSON.stringify(row)});
	const c = r.querySelector(":scope > .content");
	return {
		own: getComputedStyle(r).animationName,
		sparks: [[r, "::before"], [r, "::after"], [c, "::before"], [c, "::after"]].map(([e, p]) => getComputedStyle(e, p).animationName),
	};
})()`;

/** The newest row, when it is an own message's echo (not its pending copy). */
const LAST_OWN = `#chat .messages > .msg.self:not(.pending):last-child`;

/**
 * A still frame of a send's burst: send `text`, wait for its row, freeze its
 * four sparks 0.9 s in (the last has been rising 0.36 s, the first 0.9 s)
 * and shoot the row and the rows above it at three device pixels a CSS
 * pixel, since a spark is a 0.25rem dot. Says how many sparks it froze.
 */
async function emberFrame(page, text, name) {
	await sendLine(page, text);
	await page.waitFor(
		`(() => { const r = document.querySelector("${LAST_OWN}"); return !!r && r.textContent.includes(${JSON.stringify(
			text
		)}); })()`,
		{label: `${name}: the own row`}
	);
	await page.sleep(300);
	const frozen = await page.evaluate(FREEZE_EMBERS(900));
	const box = await page.evaluate(
		`document.querySelector("${LAST_OWN}").getBoundingClientRect().toJSON()`
	);
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 900,
		deviceScaleFactor: 3,
		mobile: false,
	});
	await page.screenshot(name, {
		clip: {x: box.x, y: Math.max(0, box.y - 100), width: box.width, height: box.height + 108},
	});
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.evaluate(FINISH_EMBERS);
	return frozen;
}

/**
 * The first pending copy of OWN_TEXT and the first echo row of it, each read
 * the moment it lands (a MutationObserver runs before the next frame): its
 * animation-name and opacity, and the animations it runs with their first and
 * last keyframes' opacity. Read at once, because the echo's settle is over in
 * 340 ms and a finished animation leaves getAnimations().
 */
const WATCH_OWN = `(() => {
	window.__own = {pending: null, echo: null};
	const text = ${JSON.stringify(OWN_TEXT)};
	const read = (el) => {
		const anims = el.getAnimations().map((a) => {
			const k = a.effect ? a.effect.getKeyframes() : [];
			return {name: a.animationName, from: k.length ? k[0].opacity : null, to: k.length ? k[k.length - 1].opacity : null};
		});
		const cs = getComputedStyle(el);
		return {name: cs.animationName, opacity: cs.opacity, anims};
	};
	const seen = (el) => {
		if (!el.matches("#chat .msg.self") || !el.textContent.includes(text)) return;
		if (el.classList.contains("pending")) window.__own.pending ??= read(el);
		else window.__own.echo ??= read(el);
	};
	new MutationObserver((records) => {
		for (const r of records) {
			if (r.type === "attributes" && r.target instanceof Element) seen(r.target);
			for (const node of r.addedNodes) {
				if (node instanceof Element) {
					seen(node);
					node.querySelectorAll("#chat .msg.self").forEach(seen);
				}
			}
		}
	}).observe(document.getElementById("chat"), {childList: true, subtree: true, attributes: true, attributeFilter: ["class"]});
	return true;
})()`;

/** One line per logged animation, for a check's label. */
const describeLog = (log) =>
	log.map((e) => `${e.name}${e.pseudo} on .${e.cls.split(/\s+/)[0]}`).join(", ") || "none";

/**
 * What the animal files are doing, from the page's own point of view:
 *
 * - `declared`: every `ps/<file>.svg` the theme's stylesheet names anywhere
 *   — the animal tokens, their `-far` tints and the reduced-motion stills.
 *   The files are kept, so this is never empty.
 * - `layer`/`image`: the scene's animal layer (`#theme-scene .ps-animals`)
 *   and its computed `background-image`, which is three slots.
 * - `cast`: the files the layer's slots would substitute, read off its
 *   computed `--ps-slot-a/-b/-f`.
 * - `painted`: animal files in that `background-image`.
 * - `fetched`: what the browser has actually asked the network for, from
 *   Resource Timing. Background images fetched by CSS appear here like any
 *   other subresource.
 * - `control`: whether Resource Timing is recording this theme's own
 *   subresources at all — the stylesheet and a font from `ps/`. Without it an
 *   empty `fetched` proves nothing (a full buffer, a read before the swap).
 *
 * All of it is read out of the running page rather than written down here:
 * this file has already shipped a hardcoded cast that went stale the moment a
 * scene was recast.
 */
const ANIMAL_FILES = `(() => {
	const files = (s) => [...String(s).matchAll(/(?<![a-z])ps\\/([a-z-]+\\.svg)/g)].map((m) => m[1]);
	const declared = new Set();

	for (const sheet of document.styleSheets) {
		let rules;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // a cross-origin sheet; the theme is not one
		}
		for (const rule of rules) for (const f of files(rule.cssText || "")) declared.add(f);
	}

	const layer = document.querySelector("#theme-scene .ps-animals");
	const cs = layer ? getComputedStyle(layer) : null;
	const cast = new Set();

	for (const slot of ["a", "b", "f"]) {
		for (const f of files(cs ? cs.getPropertyValue("--ps-slot-" + slot) : "")) cast.add(f);
	}

	const image = cs ? cs.backgroundImage : null;
	const names = performance.getEntriesByType("resource").map((e) => e.name);
	return {
		declared: [...declared].sort(),
		layer: !!layer,
		image,
		cast: [...cast].sort(),
		painted: files(image || "").sort(),
		fetched: [...new Set(files(names.join(" ")))].sort(),
		entries: names.length,
		control:
			names.some((n) => /\\/themes\\/ps\\.css(\\?|$)/.test(n)) &&
			names.some((n) => /\\/themes\\/ps\\/[a-z0-9-]+\\.woff2/.test(n)),
	};
})()`;

/** How long after the scene is painted a background image, had one been
 * substituted, has been requested and has finished on a local server. The
 * falsification in the header is what shows this is long enough. */
const SETTLE_MS = 2500;

/** ANIMAL_FILES once the theme's own subresources are on the record and the
 * scene has had time to request anything it was going to. */
async function animalFiles(page, label) {
	await page.waitFor(`${ANIMAL_FILES}.control`, {label});
	await page.sleep(SETTLE_MS);
	return page.evaluate(ANIMAL_FILES);
}

/** Every check that no animal is cast, painted or fetched, at one moment of
 * the run. */
function checkNoAnimals(page, m, where) {
	page.check(
		`${where}: Resource Timing records the theme's stylesheet and fonts (${m.entries} entries)`,
		m.control
	);
	page.check(
		`${where}: the stylesheet still names ${m.declared.length} animal files`,
		m.declared.length > 0
	);
	page.check(`${where}: the scene has its animal layer`, m.layer);
	page.check(
		`${where}: the animal layer paints three empty slots (${m.image})`,
		m.image === "none, none, none"
	);
	page.check(
		`${where}: every animal slot is empty${m.cast.length ? ` — ${m.cast.join(" ")}` : ""}`,
		m.layer && m.cast.length === 0
	);
	page.check(
		`${where}: the layer paints no animal${
			m.painted.length ? ` — ${m.painted.join(" ")}` : ""
		}`,
		m.layer && m.painted.length === 0
	);
	page.check(
		`${where}: no animal file was fetched${
			m.fetched.length ? ` — ${m.fetched.join(" ")}` : ""
		}`,
		m.fetched.length === 0
	);
}

/** The IANA zone whose local hour is `hour` right now: Etc/GMT-N is UTC+N. */
function zoneFor(hour) {
	let off = (((hour - new Date().getUTCHours()) % 24) + 24) % 24;
	if (off > 14) off -= 24;
	return off === 0 ? "Etc/GMT" : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
}

/**
 * Sunrise and sunset in local minutes on a day of the year, copied from
 * client/js/scenes/ps/engine.ts `sunTimes` with its LATITUDE (45) and
 * SOLAR_NOON (750): this file runs under plain node and cannot import
 * TypeScript. Keep the two in step.
 */
function sunTimes(doy) {
	const RAD = Math.PI / 180;
	const decl = -23.44 * Math.cos((2 * Math.PI * (doy + 10)) / 365) * RAD;
	const cosH = -Math.tan(45 * RAD) * Math.tan(decl);
	const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosH))) / RAD;
	const half = (hourAngle / 15) * 60;
	return {rise: 750 - half, set: 750 + half};
}

/** engine.ts DUSK: how long after sunset the dusk stops run. */
const DUSK = 105;

/** engine.ts `dayOfYear`: 1 on 1 January of the local calendar date. */
const dayOfYear = (d) =>
	(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) /
	86400000;

const hhmm = (minute) =>
	`${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(
		Math.floor(minute % 60)
	).padStart(2, "0")}`;

/**
 * Someone else in #seance: a bare IRC connection from node (Node 22's global
 * WebSocket, one line per frame, as tools/irc-ws-probe.mjs speaks it), so the
 * message column has another user's line to read the text colour off — our
 * own lines are dimmed by style.css's `.self` rule, and the rig keeps no
 * history of a channel nobody is in. Its realname, when it differs from the
 * nick, is shown in its join (extended-join), in italic.
 */
async function neighbour(nick, realname = nick) {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, ["text.ircv3.net"]);
	ws.binaryType = "arraybuffer";
	const text = (data) => (typeof data === "string" ? data : new TextDecoder().decode(data));
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error(`the neighbour ${nick} could not connect`));
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`the neighbour ${nick} did not register`)),
			15000
		);
		ws.onmessage = (ev) => {
			const line = text(ev.data);

			if (line.startsWith("PING ")) {
				ws.send(`PONG ${line.slice(5)}`);
			} else if (/^:\S+ 001 /.test(line)) {
				clearTimeout(timer);
				resolve();
			}
		};
		ws.send(`NICK ${nick}`);
		ws.send(`USER ${nick} 0 * :${realname}`);
	});
	ws.send("JOIN #seance");
	return {
		say: (line) => ws.send(`PRIVMSG #seance :${line}`),
		quit: () => {
			ws.send("QUIT");
			ws.close();
		},
	};
}

/** Wait, without failing the run, for `expression` to hold; says whether it did. */
async function settle(page, expression, ms) {
	for (const until = Date.now() + ms; Date.now() < until; ) {
		if (await page.evaluate(`!!(${expression})`)) {
			return true;
		}

		await page.sleep(150);
	}

	return page.evaluate(`!!(${expression})`);
}

/** Someone else's message line in the open conversation. */
const OTHERS_LINE = `document.querySelector('#chat .chat .msg[data-type="message"]:not(.self) .content')`;

/** Make the page believe it was hidden or shown, and tell it. */
const VISIBILITY = (state) => `(() => {
	Object.defineProperty(document, "visibilityState", {configurable: true, get: () => ${JSON.stringify(
		state
	)}});
	Object.defineProperty(document, "hidden", {configurable: true, get: () => ${state === "hidden"}});
	document.dispatchEvent(new Event("visibilitychange"));
})()`;

/** How far apart SCENE_STATE samples the scene's clocks to tell what moves: several of the stepper's 24 frames a second. */
const MOTION_SAMPLE_MS = 250;

/**
 * The scene and what it publishes, in one read. `layers` are the scene's
 * layers by class (the children of its one wrapper, `.ps-frost`, which
 * `children` counts as the root's one child) and `off` every layer out of the render tree
 * outside its window (layers.ts), both without the `ps-off` class itself;
 * `land`, `blades`, `yurt` and `ground` say whether those are rendered
 * (checkVisibility: in the page is not enough, a hidden ground holds them
 * too); `svgs` is each SVG's clock and whether it sits in a layer that is
 * out, or is the heat haze, `paused` there meaning its clock did not move
 * over MOTION_SAMPLE_MS; `ink` is the colour of someone else's message
 * text (the neighbour's), null when there is none; `running` counts the
 * animations in the scene whose clock moved over the same span; `meta` is the browser's
 * theme-color; the clock is the page's own, under whatever time zone is
 * emulated.
 */
const SCENE_STATE = `(async () => {
	const s = document.getElementById("theme-scene"), h = document.documentElement;
	// What moves (stepper.ts): every animation and SVG clock is held and
	// stepped 24 times a second, so playState and animationsPaused() say
	// nothing; a clock moving between two samples ${MOTION_SAMPLE_MS} ms apart does.
	// A layer that leaves or joins the page inside the window (its fade's
	// clean-up, layers.ts) moved for part of it only: such a sample says
	// nothing, so it is taken again (three tries).
	let anims, animAt, allSvgs, svgAt, svgOff;
	for (let tries = 0; tries < 3; tries++) {
		anims = s.getAnimations({subtree: true});
		animAt = anims.map((a) => a.currentTime);
		allSvgs = [...s.querySelectorAll("svg")];
		svgAt = allSvgs.map((v) => v.getCurrentTime());
		svgOff = allSvgs.map((v) => !!v.closest(".ps-off"));
		await new Promise((r) => setTimeout(r, ${MOTION_SAMPLE_MS}));
		if (allSvgs.every((v, i) => !!v.closest(".ps-off") === svgOff[i])) break;
	}
	const content = ${OTHERS_LINE};
	const d = new Date();
	const n = (sel) => s.querySelectorAll(sel).length;
	const shown = (sel) => { const e = s.querySelector(sel); return !!e && e.checkVisibility(); };
	const style = (sel, p) => { const e = s.querySelector(sel); return e ? getComputedStyle(e)[p] : null; };
	const named = (e) => [...e.classList].filter((c) => c !== "ps-off").join(" ");
	const weather = s.querySelector(".ps-weather");
	const frost = s.querySelector(":scope > .ps-frost");
	return {
		display: getComputedStyle(s).display,
		background: getComputedStyle(s).backgroundImage,
		children: s.children.length,
		layers: frost ? [...frost.children].map(named) : [],
		off: [...s.querySelectorAll(".ps-off")].map(named),
		starFields: n(".ps-stars"),
		stars: n(".ps-stars i"),
		sun: !!s.querySelector(".ps-sun"),
		moon: !!s.querySelector(".ps-moon"),
		clouds: n(".ps-cloud-field .ps-cloud") - n(".ps-overcast-set.ps-leaving .ps-cloud"),
		overcast: n(".ps-cloud-field > .ps-overcast > .ps-overcast-set:not(.ps-leaving) > .ps-cloud"),
		deck: n(".ps-cloud-field > .ps-overcast > .ps-overcast-set:not(.ps-leaving) > .ps-deck"),
		sets: [...s.querySelectorAll(".ps-cloud-field > .ps-overcast > *")].map((e) => ({
			cls: e.className, op: +(+getComputedStyle(e).opacity).toFixed(3), clouds: e.querySelectorAll(".ps-cloud").length,
		})),
		deckBottom: (() => { const e = s.querySelector(".ps-deck"); return e ? +(e.getBoundingClientRect().bottom / s.getBoundingClientRect().height * 100).toFixed(1) : null; })(),
		rainDeck: n(".ps-overcast-set:not(.ps-leaving) > .ps-deck.ps-deck-rain"),
		birds: {
			skeins: [...s.querySelectorAll(".ps-skeins, .ps-flock, .ps-bird")].filter((e) => e.checkVisibility()).length,
			buzzard: [...s.querySelectorAll(".ps-buzzard")].filter((e) => e.checkVisibility()).length,
			larks: [...s.querySelectorAll(".ps-lark")].filter((e) => e.checkVisibility()).length,
		},
		ground: shown(".ps-ground"),
		land: shown(".ps-ground > .ps-land"),
		yurt: shown(".ps-ground > .ps-yurt"),
		blades: shown(":scope > .ps-frost > .ps-blades"),
		fireflies: n(".ps-ground > .ps-fireflies i"),
		drops: n(".ps-rain i"),
		flakes: n(".ps-snow i"),
		seeds: n(".ps-seeds i"),
		flash: n(".ps-flash"),
		heatband: shown(".ps-heatband"),
		haze: n(".ps-heat-haze"),
		weatherLayer: weather ? weather.children.length : null,
		groundFilter: style(".ps-ground", "filter"),
		bladesFilter: style(":scope > .ps-frost > .ps-blades", "filter"),
		weather: s.dataset.weather,
		season: s.dataset.season,
		hot: s.classList.contains("ps-hot"),
		water: s.style.getPropertyValue("--ps-water"),
		flowers: s.style.getPropertyValue("--ps-flowers"),
		snowcap: s.style.getPropertyValue("--ps-snowcap"),
		paused: s.classList.contains("ps-paused"),
		svgs: allSvgs.map((v, i) => ({
			paused: v.getCurrentTime() === svgAt[i],
			off: svgOff[i],
			haze: v.classList.contains("ps-heat-haze"),
		})),
		running: anims.filter((a, i) => a.playState !== "idle" && a.currentTime !== animAt[i]).length,
		view: s.dataset.view,
		light: h.dataset.psLight,
		text: h.dataset.psText,
		canvas: h.style.getPropertyValue("--canvas-bg-color"),
		skyTop: s.style.getPropertyValue("--ps-sky-top"),
		meta: document.querySelector('meta[name="theme-color"]').content,
		ink: content ? getComputedStyle(content).color : null,
		minute: d.getHours() * 60 + d.getMinutes(),
		doy: (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 86400000,
		date: d.toISOString(),
	};
})()`;

/**
 * Under reduced motion (spec §9): every animation document.getAnimations()
 * holds on the scene that is running (CSS animations and transitions alike);
 * how many of what exists only in flight are rendered — checkVisibility(),
 * the render tree and not the screen, so a drop parked just above the top
 * or a skein waiting off the edge counts; and what stays: the veil's opacity
 * beside the one the scene wrote, the near grass's lean, the fireflies
 * rendered and where the first stands, the heat band.
 */
const REDUCED_STATE = `(() => {
	const s = document.getElementById("theme-scene");
	const rendered = (sel) => [...s.querySelectorAll(sel)].filter((e) => e.checkVisibility()).length;
	const veil = s.querySelector(".ps-veil");
	const ff = s.querySelector(".ps-fireflies i");
	const sway = s.querySelector(".ps-blades .ps-sway");
	return {
		running: document
			.getAnimations()
			.filter((a) => a.playState === "running" && a.effect && a.effect.target && s.contains(a.effect.target))
			.map((a) => a.animationName || a.transitionProperty || "?"),
		flight: {
			skeins: rendered(".ps-skeins, .ps-bird"),
			buzzard: rendered(".ps-buzzard"),
			larks: rendered(".ps-lark"),
			rain: rendered(".ps-rain, .ps-rain i"),
			snow: rendered(".ps-snow, .ps-snow i"),
			seeds: rendered(".ps-seeds, .ps-seeds i"),
			lightning: rendered(".ps-flash"),
			smoke: rendered(".ps-smoke, .ps-smoke i"),
		},
		veil: veil.checkVisibility() ? getComputedStyle(veil).opacity : null,
		veilVar: s.style.getPropertyValue("--ps-veil"),
		blades: sway.checkVisibility() ? getComputedStyle(sway).transform : null,
		fireflies: rendered(".ps-fireflies i"),
		fireflyTransform: ff ? getComputedStyle(ff).transform : null,
		heatband: rendered(".ps-heatband"),
	};
})()`;

/** `.msg` eases its colour over 0.8 s (ps.css, the words over the plains). */
const TEXT_EASE_MS = 1200;

/** Emulate the local hour `hour`, then hide and show the page: the scene
 * ticks at once on becoming visible. */
async function atHour(page, hour) {
	await page.send("Emulation.setTimezoneOverride", {timezoneId: zoneFor(hour)});
	await page.evaluate(VISIBILITY("hidden"));
	await page.evaluate(VISIBILITY("visible"));
	await page.sleep(TEXT_EASE_MS);
	return page.evaluate(SCENE_STATE);
}

/**
 * The scene's SVGs (scene.ts sceneMarkup): the moon, the sun, the land, the
 * near grass and the yurt; the skeins' 38 birds (geese and cranes) and the
 * one holding their belly gradient; the buzzard and the three larks. A hot day's weather layer
 * adds the heat haze.
 */
const SVGS = 48;
const svgsOn = (s) => SVGS + (s.weather === "heat" ? 1 : 0);

/** The scene's layers, back to front (scene.ts sceneMarkup, docs/projects/ps-theme.md §5.1). */
const LAYERS = [
	"ps-milky",
	"ps-stars",
	"ps-glow",
	"ps-moon",
	"ps-sun",
	"ps-cloud-field",
	"ps-ground",
	"ps-blades",
	"ps-skeins",
	"ps-daybirds",
	"ps-veil",
	"ps-weather",
];

/** Fireflies over the far fields (plains.ts FIREFLIES); a scene mounted on a phone gets half. */
const FIREFLIES = 34;

/**
 * The clouds a scene holds on a day of `weather` (plains.ts): the five, and
 * rain's four more in rain and a storm (plan 4 task 3). Keyed on the
 * weather the scene reports at that moment, never on the date: the real
 * clock's day is whatever day the run falls on.
 */
const cloudsFor = (weather) => (weather === "rain" || weather === "storm" ? 9 : 5);

/**
 * The day's deck as drawn (the storm's, or rain's lighter one): each billow's box, and at the band's lower edge
 * (the deck's top 58 %, plains.ts DECK_BAND) the chord each billow's ellipse
 * has there, joined across the scene; `gap` is the first x no billow covers.
 */
const DECK_GEOMETRY = `(() => {
	const s = document.getElementById("theme-scene");
	const deck = s.querySelector(".ps-deck");
	if (!deck) return null;
	const sb = s.getBoundingClientRect(), db = deck.getBoundingClientRect();
	const edge = db.top + db.height * 0.58;
	const boxes = [...deck.querySelectorAll("i")].map((i) => i.getBoundingClientRect());
	const spans = boxes.map((b) => {
		const ry = b.height / 2, dy = (edge - (b.top + ry)) / ry;
		const half = Math.abs(dy) < 1 ? (b.width / 2) * Math.sqrt(1 - dy * dy) : 0;
		return [b.left + b.width / 2 - half, b.left + b.width / 2 + half];
	}).sort((a, b) => a[0] - b[0]);
	let reach = sb.left, gap = null;
	for (const [from, to] of spans) { if (gap === null && from > reach + 0.5) gap = Math.round(reach); reach = Math.max(reach, to); }
	if (gap === null && reach < sb.right - 0.5) gap = Math.round(reach);
	return {
		n: boxes.length,
		sizes: boxes.map((b) => [Math.round(b.width), Math.round(b.height)]),
		wide: boxes.every((b) => b.width > 1.5 * b.height),
		gap,
		width: Math.round(sb.width),
		height: Math.round(sb.height),
	};
})()`;

/** The day's deck on this window: its billows wide ellipses, and the band's edge closed all the way across (plans' final fix, item 3). */
function checkDeck(page, d, where) {
	page.check(
		`${where}: the deck's ${d?.n} billows are wide, not tall drips, on the ${d?.width} × ${
			d?.height
		} scene (${d?.sizes.map(([w, h]) => `${w}×${h}`).join(", ")})`,
		!!d && d.n >= 6 && d.wide
	);
	page.check(
		`${where}: the band's edge is closed all the way across${
			d?.gap === null ? "" : ` (a gap at ${d?.gap}px)`
		}`,
		!!d && d.gap === null
	);
}

/** The scene is stopped: its class, every SVG clock and every CSS animation. */
function checkStopped(page, s, where) {
	const going = s.svgs.filter((v) => !v.paused).length;
	page.check(
		`${where}: the scene is stopped (ps-paused ${s.paused}; ${s.svgs.length} of ${svgsOn(
			s
		)} SVG clocks, ${going} going; ${s.running} CSS animations running)`,
		s.paused && s.svgs.length === svgsOn(s) && going === 0 && s.running === 0
	);
}

/**
 * The scene runs: no pause class, CSS animations playing, and every SVG
 * clock going but those in a layer outside its window (ps-off) and the heat
 * haze's while the day is not hot (scene.ts syncSvgs, layers.ts: nothing
 * animates unseen).
 */
function checkRunning(page, s, where) {
	const live = (v) => !v.off && (s.hot || !v.haze);
	const wrong = s.svgs.filter((v) => v.paused === live(v));
	const going = s.svgs.filter((v) => !v.paused).length;
	page.check(
		`${where}: the scene runs (ps-paused ${s.paused}; ${s.svgs.length} of ${svgsOn(
			s
		)} SVG clocks, ${going} going, ${s.svgs.length - going} held in layers out of their window${
			wrong.length ? `, ${wrong.length} the wrong way` : ""
		}; ${s.running} CSS animations running)`,
		!s.paused && s.svgs.length === svgsOn(s) && wrong.length === 0 && going > 0 && s.running > 0
	);
}

/**
 * The private view's frost (spec §5.7): whether the root carries ps-private,
 * the wrapper's computed filter and transform and the frost it should be at
 * this font step, the root's own filter and #status-bar-tint's (neither is
 * frosted), the halo on <html>, every animation `document.getAnimations()`
 * holds on the scene (CSS animations and transitions, pseudo-elements
 * included) by play state, whether every SVG's clock is paused, and the
 * sun's centre on the screen while it is shown.
 */
const FROST_STATE = `(() => {
	const s = document.getElementById("theme-scene");
	const f = s.querySelector(":scope > .ps-frost");
	const cs = f ? getComputedStyle(f) : null;
	const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
	const mine = document.getAnimations().filter((a) => a.effect && a.effect.target && s.contains(a.effect.target));
	const sun = s.querySelector(".ps-sun");
	const b = sun.getBoundingClientRect();
	const svgs = [...s.querySelectorAll("svg")];
	return {
		private: s.classList.contains("ps-private"),
		filter: cs ? cs.filter : null,
		transform: cs ? cs.transform : null,
		frost: "blur(" + 1.125 * rem + "px) saturate(0.85)",
		rootFilter: getComputedStyle(s).filter,
		tint: getComputedStyle(document.getElementById("status-bar-tint")).filter,
		halo: document.documentElement.style.getPropertyValue("--ps-halo"),
		paused: mine.filter((a) => a.playState === "paused").length,
		running: mine.filter((a) => a.playState === "running").map((a) => a.animationName || a.transitionProperty || "?"),
		svgs: svgs.length,
		svgsPaused: svgs.filter((v) => v.animationsPaused()).length,
		sun: {
			shown: !sun.closest(".ps-off") && Number(getComputedStyle(sun).opacity) > 0,
			cx: Math.round(b.left + b.width / 2),
			cy: Math.round(b.top + b.height / 2),
		},
		width: innerWidth,
		height: innerHeight,
	};
})()`;

/** The frost's ease (--ps-flip, 0.8 s) and the yurt's fade to its new place (0.4 s, then 0.38 s), over. */
const FROST_SETTLE_MS = 1500;

/** A layer's fade at the tick that comes with a new hour (layers.ts: 1.8 s at most), over. */
const FADE_SETTLE_MS = 1000;

/**
 * A query's scene: frosted — the wrapper blurred 1.125rem and desaturated
 * to 0.85, scaled 1.2, the root and #status-bar-tint unfiltered — and
 * completely still: stopped as a hidden page's is (its class, every SVG
 * clock, no CSS animation running), every animation document.getAnimations()
 * has on it paused, and the sun, when up, still centred in the window.
 */
function checkFrosted(page, s, f, where) {
	page.check(
		`${where}: frosted (ps-private ${f.private}; the wrapper's filter ${f.filter}, transform ${f.transform}; the root's own filter ${f.rootFilter}, #status-bar-tint's ${f.tint})`,
		f.private &&
			f.filter === f.frost &&
			f.transform === "matrix(1.2, 0, 0, 1.2, 0, 0)" &&
			f.rootFilter === "none" &&
			f.tint === "none"
	);
	checkStopped(page, s, where);
	page.check(
		`${where}: every animation on the scene paused (document.getAnimations(): ${
			f.paused
		} paused, ${f.running.length} running${
			f.running.length ? ` — ${f.running.slice(0, 4).join(", ")}` : ""
		}; ${f.svgsPaused} of ${f.svgs} SVGs report animationsPaused())`,
		f.paused > 0 && f.running.length === 0 && f.svgs > 0 && f.svgsPaused === f.svgs
	);

	if (f.sun.shown) {
		page.check(
			`${where}: the sun keeps its centre in the window under the frost's scale (${f.sun.cx}, ${f.sun.cy} in ${f.width} × ${f.height})`,
			f.sun.cx > 0 && f.sun.cx < f.width && f.sun.cy > 0 && f.sun.cy < f.height
		);
	}
}

/** A channel's scene: no frost on the wrapper, and the scene runs. */
function checkUnfrosted(page, s, f, where) {
	page.check(
		`${where}: not frosted (ps-private ${f.private}; the wrapper's filter ${f.filter}, transform ${f.transform})`,
		!f.private && f.filter === "none" && f.transform === "none"
	);
	checkRunning(page, s, where);
}

/**
 * One scene, whole: shown, its twelve layers in order in its one wrapper
 * (.ps-frost), one field of 190 stars, a sun, a moon and the day's clouds
 * (five, nine on a wet day: cloudsFor); and
 * the plains drawn, the land, the near grass and the yurt rendered, the
 * fireflies in the ground group.
 */
function checkMounted(page, s, where, fireflies = FIREFLIES) {
	page.check(
		`${where}: the scene is mounted and shown (display ${s.display}; ${s.children} wrapper of ${
			s.layers.length
		} layers: ${s.layers.join(" ")}; ${s.starFields} star field of ${s.stars}, sun ${
			s.sun
		}, moon ${s.moon}, ${s.clouds} clouds)`,
		s.display === "block" &&
			s.children === 1 &&
			s.layers.join() === LAYERS.join() &&
			s.starFields === 1 &&
			s.stars === 190 &&
			s.sun &&
			s.moon &&
			s.clouds === cloudsFor(s.weather)
	);
	page.check(
		`${where}: the plains are drawn (ground ${s.ground}, land ${s.land}, near grass ${s.blades}, yurt ${s.yurt}; ${s.fireflies} fireflies, ${fireflies} due)`,
		s.ground && s.land && s.blades && s.yurt && s.fireflies === fireflies
	);
}

/**
 * Put the page's clock at the instant `ms` (UTC; the run sets the time zone
 * to Etc/GMT first), then hide and show the page so the scene ticks at once.
 */
async function at(page, ms) {
	await page.evaluate(`window.__setClock(${ms})`);
	await page.evaluate(VISIBILITY("hidden"));
	await page.evaluate(VISIBILITY("visible"));
	await page.sleep(TEXT_EASE_MS);
	return page.evaluate(SCENE_STATE);
}

/**
 * The birds in the render tree once every gate's fade is over: a layer that
 * was up at the moment before leaves the tree only after its fade (layers.ts:
 * a flock's 1.8 s and the margin, 1.9 s), and `at` has waited 1.2 s of it.
 */
async function birdsSettled(page) {
	await page.sleep(1000);
	return (await page.evaluate(SCENE_STATE)).birds;
}

/** The real clock again, and a tick on it. */
async function realClock(page) {
	await page.evaluate(`window.__setClock(null)`);
	await page.evaluate(VISIBILITY("hidden"));
	await page.evaluate(VISIBILITY("visible"));
	await page.sleep(300);
}

/** 12:30 local on a day of 2026 (month from 1), as the UTC instant the shim takes under Etc/GMT. */
const noonOn = (month, day) => Date.UTC(2026, month - 1, day, 12, 30);

/** The neighbour's join line, shown on its own (not condensed). */
const PEER_JOIN = `#chat .msg[data-type="join"][data-from="${PEER}"]`;
/** The query named EXT_NAME in the sidebar. */
const EXT_QUERY_ROW = `.channel-list-item[data-type="query"][data-name="${EXT_NAME}"]`;
/** The query named VI_NAME in the sidebar. */
const VI_QUERY_ROW = `.channel-list-item[data-type="query"][data-name="${VI_NAME}"]`;
/** The neighbour's lines. */
const PEER_LINES = `#chat .msg[data-type="message"][data-from="${PEER}"] .content`;

/**
 * The theme's nine font files as `document.fonts` has them: family, style,
 * which block (Latin, U+0000-00FF first; Latin Extended, U+0100-02BA first;
 * Vietnamese, U+0102-0103 first) and status.
 */
const FONT_FACES = `[...document.fonts]
	.filter((f) => /^"?(Source Sans 3|Newsreader)"?$/.test(f.family))
	.map((f) => {
		const first = f.unicodeRange.split(",")[0].trim();
		return {
			family: f.family.replace(/"/g, ""),
			style: f.style,
			block: /^U\\+0+-0*FF$/i.test(first)
				? "latin"
				: /^U\\+0*100-/i.test(first)
				? "latin-ext"
				: /^U\\+0*102-/i.test(first)
				? "vietnamese"
				: first,
			status: f.status,
		};
	})`;

/**
 * The rendered proof the fonts were bundled with (the latin-ext trap,
 * docs/projects/ps-theme.md §8), as it was first run: each face against a
 * fallback the same text would otherwise draw in, on a canvas. A pair of
 * equal widths means the bundled face did not draw the text. "Source Sans
 * 3" is quoted in each font string: unquoted, the figure makes the whole
 * string invalid, the canvas keeps the font it had and the pair compares
 * two other fonts. The names are measured against serif, not monospace (as
 * they were until plan 4): a family the canvas cannot find draws in its
 * default, which is the serif, so a monospace pair differed with the face
 * missing (seen on the previous build: Newsreader, absent there, "passed").
 */
const FONT_WIDTHS = `(async () => {
	await document.fonts.ready;
	const c = document.createElement("canvas").getContext("2d");
	const w = (font, s) => ((c.font = "10px monospace"), (c.font = font), c.font === "10px monospace" ? NaN : c.measureText(s).width);
	const probe = {latin: "Handgloves 0123", ext: "Łucja Ősz ăĕ şţ"};
	return {
		sourceSans: [w('500 20px "Source Sans 3"', probe.latin), w("500 20px serif", probe.latin)],
		sourceSansExt: [w('500 20px "Source Sans 3"', probe.ext), w("500 20px serif", probe.ext)],
		sourceSansItalic: [w('italic 500 20px "Source Sans 3"', probe.ext), w("italic 500 20px serif", probe.ext)],
		newsreader: [w("700 20px Newsreader", probe.latin), w("700 20px serif", probe.latin)],
		newsreaderExt: [w("700 20px Newsreader", probe.ext), w("700 20px serif", probe.ext)],
	};
})()`;

/** The element whose own text (a direct text child) first contains
 * `needle`, under the elements `scope` selects; null when there is none. */
const TEXT_HOLDER = (scope, needle) => `(() => {
	for (const root of document.querySelectorAll(${JSON.stringify(scope)})) {
		const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walk.nextNode(); n; n = walk.nextNode()) {
			if (n.data.includes(${JSON.stringify(needle)})) return n.parentElement;
		}
	}
	return null;
})()`;

/**
 * The fonts Chromium drew an element's own text in (CSS.getPlatformFontsForNode,
 * which counts the element's direct text children): `document.fonts` can say
 * a face has loaded while these glyphs went to the fallback, which shows here.
 * Needs the DOM and CSS domains enabled; null when `expression` finds nothing.
 */
async function drawnFonts(page, expression) {
	const {result} = await page.send("Runtime.evaluate", {expression, returnByValue: false});

	if (!result.objectId) {
		return null;
	}

	const {nodeId} = await page.send("DOM.requestNode", {objectId: result.objectId});
	const {fonts} = await page.send("CSS.getPlatformFontsForNode", {nodeId});
	return fonts;
}

const describeFonts = (fonts) =>
	fonts
		? fonts
				.map(
					(f) =>
						`${f.familyName} ${f.postScriptName}${f.isCustomFont ? "" : " (system)"} ×${
							f.glyphCount
						}`
				)
				.join(", ")
		: "nothing";

/**
 * Some text of the page is set in the family `family` (italic or not), and
 * drawn by that bundled face: its computed style says so, and so does every
 * font Chromium drew it in. A missing italic file would draw the upright one
 * slanted, whose name says no italic.
 */
async function checkDrawnIn(page, label, holder, family, italic, {clippedBy = null} = {}) {
	const css = await page.evaluate(`(() => {
		const e = ${holder};
		if (!e) return null;
		const cs = getComputedStyle(e);
		const clip = ${JSON.stringify(clippedBy)} && e.closest(${JSON.stringify(clippedBy ?? "")});
		return {
			style: cs.fontStyle,
			family: cs.fontFamily,
			clipped: !!clip && clip.scrollWidth > clip.clientWidth,
			clipFamily: clip ? getComputedStyle(clip).fontFamily : null,
		};
	})()`);
	const fonts = await drawnFonts(page, holder);
	const re = new RegExp(`^${family}\\b`);
	// The computed list quotes a name with a space or a figure ("Source Sans 3").
	const first = css?.family.split(",")[0].trim().replace(/^"|"$/g, "");
	// A clipped column draws its ellipsis in the column's own face, one glyph
	// that CSS.getPlatformFontsForNode counts with the text it ends.
	const clipFirst = css?.clipFamily?.split(",")[0].trim().replace(/^"|"$/g, "");
	const ellipsis = (f) =>
		css?.clipped && f.isCustomFont && f.glyphCount === 1 && f.familyName.startsWith(clipFirst);
	page.check(
		`fonts: ${label} (font-style ${css?.style}, font-family ${
			css?.family
		}; drawn in ${describeFonts(fonts)}${
			css?.clipped ? `; clipped, its ellipsis in ${clipFirst}` : ""
		})`,
		css !== null &&
			css.style === (italic ? "italic" : "normal") &&
			re.test(first) &&
			fonts !== null &&
			fonts.some((f) => re.test(f.familyName)) &&
			fonts.every(
				(f) =>
					ellipsis(f) ||
					(f.isCustomFont &&
						re.test(f.familyName) &&
						/italic/i.test(f.postScriptName) === italic)
			)
	);
}

/** The chrome's glass surfaces (docs/projects/ps-theme.md §6). */
const GLASS = ["#sidebar", "#chat .header", "#chat .userlist", "#form"];
/** The glass tints' colours, day and night (ps.css, the chrome section). */
const DAY_GLASS = "255, 251, 244";
const NIGHT_GLASS = "12, 17, 32";

/**
 * The chrome in one read: each glass surface's background and backdrop
 * filter, #status-bar-tint's, whether reduced transparency is in force, and
 * the send glyph's colour beside the generated text accent it should be.
 */
const CHROME = `(() => {
	const read = (el) => {
		if (!el) return null;
		const cs = getComputedStyle(el);
		return {bg: cs.backgroundColor, blur: cs.backdropFilter};
	};
	return {
		glass: Object.fromEntries(${JSON.stringify(
			GLASS
		)}.map((s) => [s, read(document.querySelector(s))])),
		tint: read(document.getElementById("status-bar-tint")),
		reducedTransparency: matchMedia("(prefers-reduced-transparency: reduce)").matches,
		accent: getComputedStyle(document.getElementById("form")).getPropertyValue("--ps-g-accent-text").trim(),
		send: getComputedStyle(document.querySelector("#form #submit"), "::before").color,
	};
})()`;

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` as {rgb: "r, g, b", a}; null otherwise. */
function rgba(s) {
	const m = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(s ?? "");
	return m ? {rgb: `${m[1]}, ${m[2]}, ${m[3]}`, a: m[4] === undefined ? 1 : Number(m[4])} : null;
}

/** `#rrggbb` as the `rgb(r, g, b)` a computed colour is written in. */
function hexRgb(hex) {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);

	if (!m) {
		return `not a #rrggbb colour: ${hex}`;
	}

	const n = parseInt(m[1], 16);
	return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Glass: a blur, over a tint of `rgb` that lets the plains through. */
function isGlass(surface, rgb) {
	const c = rgba(surface?.bg);
	return !!c && c.rgb === rgb && c.a < 1 && /blur\(/.test(surface.blur);
}

/** The phone's glass: the `rgb` tint at `alpha`, with no backdrop filter. */
function isUnblurredTint(surface, rgb, alpha) {
	const c = rgba(surface?.bg);
	return !!c && c.rgb === rgb && Math.abs(c.a - alpha) < 0.005 && surface.blur === "none";
}

/** The phone's overlays: glass of the `rgb` tint at `alpha`, blurred, and brightened or not. */
function isOverlayGlass(surface, rgb, alpha, brightened) {
	const c = rgba(surface?.bg);
	return (
		!!c &&
		c.rgb === rgb &&
		Math.abs(c.a - alpha) < 0.005 &&
		/blur\(/.test(surface.blur) &&
		/brightness\(/.test(surface.blur) === brightened
	);
}

/** Every glass surface is glass of the `rgb` tint. */
function checkGlass(page, chrome, where, rgb) {
	for (const selector of GLASS) {
		const s = chrome.glass[selector];
		page.check(
			`${where}: ${selector} is glass over rgb(${rgb}) (${
				s ? `${s.bg}, ${s.blur}` : "missing"
			})`,
			isGlass(s, rgb)
		);
	}
}

/** The send glyph is the generated text accent (ps.css's glass palette). */
function checkAccent(page, chrome, where) {
	page.check(
		`${where}: the send glyph is the text accent ${chrome.accent} (${chrome.send})`,
		chrome.send === hexRgb(chrome.accent)
	);
}

/**
 * The composer's divider (the user's "a single thin line", 2026-09-26, and
 * "the thin divider is good", 2026-09-27): the strip's top edge and shadow,
 * and the edge token, read through a probe in #form (a computed colour in the
 * form the border's is).
 */
const COMPOSER = `(() => {
	const form = document.getElementById("form");
	const input = document.getElementById("input");
	const fs = getComputedStyle(form);
	const probe = document.createElement("span");
	form.appendChild(probe);
	probe.style.color = "var(--ps-g-edge)";
	const out = {
		edge: getComputedStyle(probe).color,
		top: fs.borderTopWidth + " " + fs.borderTopStyle + " " + fs.borderTopColor,
		shadow: fs.boxShadow,
		focused: document.activeElement === input,
	};
	probe.remove();
	return out;
})()`;

/**
 * The composer, unfocused and then with the caret: the strip's top is one 1px
 * line in the edge and no band, either way. The caret is put back where it
 * was.
 */
async function checkComposer(page, where) {
	const had = await page.evaluate(`document.activeElement === document.getElementById("input")`);
	await page.evaluate(`document.getElementById("input").blur()`);
	await page.sleep(100);
	const idle = await page.evaluate(COMPOSER);
	await page.evaluate(`document.getElementById("input").focus()`);
	await page.sleep(100);
	const lit = await page.evaluate(COMPOSER);

	if (!had) {
		await page.evaluate(`document.getElementById("input").blur()`);
	}

	for (const [state, c] of [
		["no caret", idle],
		["the caret in it", lit],
	]) {
		page.check(
			`${where}, ${state}: #form's top is one 1px line in the edge ${c.edge}, no band (${c.top}; shadow ${c.shadow})`,
			c.focused === (state !== "no caret") &&
				c.top === `1px solid ${c.edge}` &&
				c.shadow === "none"
		);
	}
}

/**
 * The sidebar's channel names: an idle one (a connected channel, not open,
 * highlighted, muted or under the pointer) and the open one, with the soft
 * ink the idle one should be in.
 */
const RAIL_NAMES = `(() => {
	const rows = [...document.querySelectorAll('#sidebar .channel-list-item[data-type="channel"]')];
	const name = (row) => row && {row: row.dataset.name, color: getComputedStyle(row.querySelector(".name")).color};
	return {
		soft: getComputedStyle(document.getElementById("sidebar")).getPropertyValue("--ps-g-soft").trim(),
		idle: name(rows.find((r) => !r.matches(".active, .has-highlight, .is-muted, .not-connected, .parted-channel, :hover"))),
		open: name(rows.find((r) => r.matches(".active"))),
	};
})()`;

/** The night glass's ink (spec §6), which the open row's name is written in. */
const NIGHT_INK = "rgb(233, 238, 247)";

/**
 * Under reduced transparency the glass is solid: no blur, an opaque fill.
 * Chromium may not emulate the feature; then the check is skipped, loudly,
 * rather than passed. Lifted again at the end, and the glass of the `rgb`
 * tint must be back.
 */
async function checkReducedTransparency(page, where, rgb) {
	await page.send("Emulation.setEmulatedMedia", {
		features: [{name: "prefers-reduced-transparency", value: "reduce"}],
	});
	await page.sleep(TEXT_EASE_MS); // the glass's colour flips over --ps-flip
	const reduced = await page.evaluate(CHROME);

	if (!reduced.reducedTransparency) {
		console.log(
			`  SKIP ${where}, reduced transparency: matchMedia("(prefers-reduced-transparency: reduce)") ` +
				`stays false under Emulation.setEmulatedMedia — this Chromium does not emulate the feature`
		);
	} else {
		for (const selector of GLASS) {
			const s = reduced.glass[selector];
			const c = rgba(s?.bg);
			page.check(
				`${where}, reduced transparency: ${selector} is solid (${
					s ? `${s.bg}, ${s.blur}` : "missing"
				})`,
				!!c && c.a === 1 && s.blur === "none"
			);
		}
	}

	await page.send("Emulation.setEmulatedMedia", {features: []});
	await page.sleep(TEXT_EASE_MS);
	const back = await page.evaluate(CHROME);
	page.check(
		`${where}: reduced transparency lifted, the glass is back (${GLASS.map(
			(s) => back.glass[s]?.blur
		).join(" | ")})`,
		GLASS.every((s) => isGlass(back.glass[s], rgb))
	);
}

/** The phone's sidebar: its glass, and whether it is on top at its centre. */
const DRAWER = `(() => {
	const s = document.getElementById("sidebar");
	const r = s.getBoundingClientRect();
	const cs = getComputedStyle(s);
	const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
	return {
		bg: cs.backgroundColor,
		blur: cs.backdropFilter,
		onTop: !!hit && s.contains(hit),
		hit: hit ? hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + [...hit.classList].map((c) => "." + c).join("") : "nothing",
	};
})()`;

/**
 * The phone's drawer through one slide, opening (`open`) or closing: its
 * backdrop filter and right edge the moment #viewport's menu-open class
 * changes, 80 ms and 500 ms after, and as each of its transitions ends (the
 * slide's transform, the filter's own delayed change), all timed from the
 * class change, which the click reaches only after Vue has rendered it.
 */
const DRAWER_SLIDE = (open) => `new Promise((done) => {
	const v = document.getElementById("viewport");
	const s = document.getElementById("sidebar");
	const read = () => ({blur: getComputedStyle(s).backdropFilter, right: Math.round(s.getBoundingClientRect().right)});
	const out = {ended: {}};
	let t0 = 0;
	const since = () => Math.round(performance.now() - t0);
	const onEnd = (e) => {
		if (e.target === s && t0) out.ended[e.propertyName] = {t: since(), ...read()};
	};
	s.addEventListener("transitionend", onEnd);
	const watch = new MutationObserver(() => {
		if (t0 || v.classList.contains("menu-open") !== ${open}) return;
		watch.disconnect();
		t0 = performance.now();
		out.at0 = read();
		setTimeout(() => (out.at80 = {t: since(), ...read()}), 80);
		setTimeout(() => {
			out.at500 = {t: since(), ...read()};
			s.removeEventListener("transitionend", onEnd);
			done(out);
		}, 500);
	});
	watch.observe(v, {attributes: true, attributeFilter: ["class"]});
	setTimeout(() => t0 || (watch.disconnect(), done({missed: true})), 5000);
	(${open} ? document.querySelector("#chat .header .lt") : document.getElementById("sidebar-overlay")).click();
})`;

/** Each cloud's box, its blobs included, against the scene's, and its animation. */
const CLOUD_RESTS = `(() => {
	const scene = document.getElementById("theme-scene").getBoundingClientRect();
	return [...document.querySelectorAll("#theme-scene .ps-cloud")].map((el) => {
		const boxes = [el, ...el.querySelectorAll("i")].map((e) => e.getBoundingClientRect());
		return {
			left: Math.min(...boxes.map((b) => b.left)) - scene.left,
			right: Math.max(...boxes.map((b) => b.right)) - scene.left,
			width: scene.width,
			animation: getComputedStyle(el).animationName,
		};
	});
})()`;

/**
 * For the cold boots (the yurt's boot race), from the first line of every
 * document: each --ps-yurt-left the scene writes; whether the yurt ever
 * fades (ps-yurt-moving); and, from an observer of the scene made after the
 * scene's own (once it has mounted), the place in the rendering update where
 * the scene is first laid out with a box, which runs after the scene's
 * observers and just before that frame is painted.
 */
const BOOT_SAMPLER = `(() => {
	const T0 = performance.now();
	const rec = (window.__boot = {writes: [], moved: false, laidOut: null});
	const now = () => Math.round(performance.now() - T0);
	const start = () => {
		const root = document.getElementById("theme-scene");
		if (!root) return requestAnimationFrame(start);
		new MutationObserver(() => {
			const v = root.style.getPropertyValue("--ps-yurt-left");
			if (v && rec.writes.at(-1)?.v !== v) rec.writes.push({t: now(), v});
			rec.moved ||= root.classList.contains("ps-yurt-moving");
		}).observe(root, {attributes: true, attributeFilter: ["style", "class"]});
		const mounted = new MutationObserver(() => {
			if (!root.querySelector(".ps-yurt")) return;
			mounted.disconnect();
			new ResizeObserver((entries) => {
				if (rec.laidOut || !entries.some((e) => e.contentRect.width > 0)) return;
				rec.laidOut = {
					t: now(),
					left: root.style.getPropertyValue("--ps-yurt-left") || "(unset: 70 %)",
					moving: root.classList.contains("ps-yurt-moving"),
				};
			}).observe(root);
		});
		mounted.observe(root, {childList: true});
	};
	start();
})()`;

/**
 * Forces the race: every write of ps.css to #theme's href (the early one in
 * loading-error-handlers.js, by setAttribute, and settings.ts's, through the
 * Attr) is held until the scene has mounted and the message column exists,
 * and two frames more, so the column's first observation lands while
 * #theme-scene is still display: none; then the last one is let through.
 */
const HOLD_THEME = `(() => {
	const T0 = performance.now();
	const value = Object.getOwnPropertyDescriptor(Attr.prototype, "value");
	const setAttribute = Element.prototype.setAttribute;
	const ps = (v) => /(^|\\/)ps\\.css$/.test(String(v));
	let pending = null;
	const wait = () => {
		if (!document.querySelector("#theme-scene .ps-yurt") || !document.querySelector("#chat .chat")) {
			return requestAnimationFrame(wait);
		}
		window.__held.ready = Math.round(performance.now() - T0);
		requestAnimationFrame(() => requestAnimationFrame(() => {
			window.__held.released = Math.round(performance.now() - T0);
			Object.defineProperty(Attr.prototype, "value", value);
			Element.prototype.setAttribute = setAttribute;
			pending();
		}));
	};
	const hold = (write) => {
		pending = write;
		if (!window.__held) {
			window.__held = {at: Math.round(performance.now() - T0)};
			wait();
		}
	};
	Object.defineProperty(Attr.prototype, "value", {
		configurable: true,
		get() { return value.get.call(this); },
		set(v) {
			if (this.ownerElement?.id === "theme" && ps(v)) return hold(() => value.set.call(this, v));
			value.set.call(this, v);
		},
	});
	Element.prototype.setAttribute = function (name, v) {
		if (this.id === "theme" && name === "href" && ps(v)) return hold(() => setAttribute.call(this, name, v));
		return setAttribute.call(this, name, v);
	};
})()`;

/** Reload the page, its address first put at `path`, and wait for the new document to show `expression`. */
async function coldReload(page, path, expression, label) {
	await page.evaluate(
		`(() => { window.__coldLoad = true; history.replaceState(null, "", ${JSON.stringify(
			path
		)}); })()`
	);
	await page.send("Page.reload");

	for (const until = Date.now() + 45000; ; ) {
		try {
			if (await page.evaluate(`!window.__coldLoad && !!(${expression})`)) {
				return;
			}
		} catch {
			// the page is between documents
		}

		if (Date.now() > until) {
			throw new Error(`${label} did not come up`);
		}

		await page.sleep(200);
	}
}

/**
 * The yurt against the message column (docs/projects/ps-theme.md §5.3):
 * its centre, opacity and whether it is moving, the place the scene wrote
 * (--ps-yurt-left, unset before it has measured a column), the column's box
 * and the scene's width, all in the viewport's pixels. `due` is where the
 * design puts it: 72 % of the column, kept whole on the scene; with no
 * column, 70 % of the scene.
 */
const YURT = `(() => {
	const s = document.getElementById("theme-scene");
	const y = s.querySelector(".ps-yurt");
	const b = y.getBoundingClientRect(), sc = s.getBoundingClientRect();
	const c = document.querySelector("#chat .chat");
	const cb = c && c.getBoundingClientRect().width > 0 ? c.getBoundingClientRect() : null;
	const half = b.width / 2;
	const at = cb ? cb.left - sc.left + 0.72 * cb.width : 0.7 * sc.width;
	return {
		cx: b.left - sc.left + half,
		op: Number(getComputedStyle(y).opacity),
		moving: s.classList.contains("ps-yurt-moving"),
		left: s.style.getPropertyValue("--ps-yurt-left"),
		column: cb && {left: Math.round(cb.left), width: Math.round(cb.width)},
		sceneWidth: sc.width,
		due: Math.min(Math.max(at, half), sc.width - half),
	};
})()`;

/**
 * Sample the yurt every animation frame (its centre, opacity, whether it is
 * moving, and the place written) until YURT_STOP; its smoke goes with it.
 */
const YURT_START = `(() => {
	const s = document.getElementById("theme-scene");
	const y = s.querySelector(".ps-yurt"), sm = s.querySelector(".ps-smoke");
	window.__yurt = [];
	const take = () => {
		const b = y.getBoundingClientRect(), k = sm.getBoundingClientRect(), sc = s.getBoundingClientRect();
		window.__yurt.push({
			cx: Math.round((b.left - sc.left + b.width / 2) * 10) / 10,
			op: Number(getComputedStyle(y).opacity),
			smokeX: Math.round((k.left - sc.left) * 10) / 10,
			smokeOp: Number(getComputedStyle(sm).opacity),
			left: s.style.getPropertyValue("--ps-yurt-left") || "(unset)",
			moving: s.classList.contains("ps-yurt-moving"),
		});
		window.__yurtFrame = requestAnimationFrame(take);
	};
	take();
	return true;
})()`;
const YURT_STOP = `(() => { cancelAnimationFrame(window.__yurtFrame); return window.__yurt; })()`;

/**
 * Across `action`, the yurt is never seen anywhere but where it stood and
 * where it ends (its smoke likewise, at the pipe above either), and it ends
 * fully shown, still, where the design puts it. Returns the trace.
 */
async function checkYurtMove(page, label, action, settleMs = 1600) {
	const before = await page.evaluate(YURT);
	const smokeBefore = await page.evaluate(
		`document.querySelector("#theme-scene .ps-smoke").getBoundingClientRect().left - document.getElementById("theme-scene").getBoundingClientRect().left`
	);
	await page.evaluate(YURT_START);
	await action();
	await page.sleep(settleMs);
	const trace = await page.evaluate(YURT_STOP);
	const after = await page.evaluate(YURT);
	const smokeAfter = trace.at(-1).smokeX;
	const near = (x, a, b) => Math.min(Math.abs(x - a), Math.abs(x - b)) <= 1;
	const elsewhere = trace.filter((p) => p.op > 0.01 && !near(p.cx, before.cx, after.cx));
	const smokeElsewhere = trace.filter(
		(p) => p.smokeOp > 0.01 && !near(p.smokeX, smokeBefore, smokeAfter)
	);
	const last = trace.at(-1);
	page.check(
		`${label}: the yurt is never seen between its places (${elsewhere.length} of ${
			trace.length
		} frames elsewhere than ${before.cx.toFixed(1)} or ${after.cx.toFixed(1)}${
			elsewhere.length ? `: ${JSON.stringify(elsewhere.slice(0, 2))}` : ""
		}; its smoke ${smokeElsewhere.length})`,
		trace.length > 10 && elsewhere.length === 0 && smokeElsewhere.length === 0
	);
	page.check(
		`${label}: it ends fully shown and still, where the design puts it (opacity ${
			last.op
		}, moving ${last.moving}, centre ${after.cx.toFixed(1)}, due ${after.due.toFixed(1)}${
			after.column ? ` in the column ${JSON.stringify(after.column)}` : ", no column"
		})`,
		last.op > 0.99 && !last.moving && Math.abs(after.cx - after.due) <= 1
	);
	return {before, after, trace, minOp: Math.min(...trace.map((p) => p.op))};
}

/** Toggle the user list `times` times, 100 ms apart, from the header's button. */
const toggleUserlist = (page, times) =>
	page.evaluate(`(() => {
		for (let i = 0; i < ${times}; i++) setTimeout(() => document.querySelector("#chat .header .rt").click(), i * 100);
		return true;
	})()`);

async function openAppearance(page) {
	await page.click(`#footer button.settings`);
	await page.waitFor(`document.querySelector(".settings-menu button.appearance")`, {
		label: "settings open",
	});
	await page.click(`.settings-menu button.appearance`);
	await page.waitFor(`document.querySelector("#theme-select")`, {label: "the theme select"});
}

/** The window's generic @change handler stores the select's value as the
 * setting; a bubbling `change` is what picking an option produces. */
async function chooseTheme(page, name) {
	await page.evaluate(
		`(() => {
			const el = document.querySelector("#theme-select");
			el.value = ${JSON.stringify(name)};
			el.dispatchEvent(new Event("change", {bubbles: true}));
		})()`
	);
	await page.sleep(700);
}

/** Settings is a modal over the whole app: nothing behind its backdrop
 * takes a click, so leave through Done before touching the sidebar. */
async function closeSettings(page) {
	await page.click(`.settings-modal-done`);
	await page.waitFor(`!document.querySelector(".settings-modal-done")`, {
		label: "settings closed",
	});
}

async function openSeance(page, label) {
	await page.click(`.channel-list-item[data-name="#seance"]`);
	await page.waitFor(`document.querySelector("#input")`, {label});
	await page.sleep(300);
}

// ---- the glyph samples (plan 4: docs/projects/ps-theme.md §11, §12)

/**
 * The glyph samples read rendered words off the page, over the real scene,
 * with calibrate.mjs's method (tools/ps/calibrate.mjs): a frame of the
 * message column as it is, and its twin, the same frame with every glyph in
 * the column drawn in TWIN_COLOUR (the text shadows are explicit colours, so
 * they do not change). Core pixels are where the two differ; the ring is the
 * non-core pixels one CSS px out (Chebyshev distance DPR device px from the
 * core). Each ring pixel is the ground the treatment leaves right around a
 * glyph — the scene, the shadow and its rings or the halo, all as painted —
 * and each element's figure is the 10th percentile (calibrate's rank) of its
 * text colour's contrast against those pixels. The kinds: the words of every
 * message row (their own colour, 4.5), the times (4.5), the nicks in the nick
 * column (3 as large text under the light treatment at the default step and
 * above, the user's names-large; 4.5 otherwise), and the words' ring again
 * against the faint colour composited over it (3): nothing in the column
 * paints --chat-fg-faint, so that figure is derived, not rendered.
 */
const GLYPH_STILL = "ps-glyph-still";
const GLYPH_TWIN = "ps-glyph-twin";
const TWIN_COLOUR = "#ff00ff";
/** calibrate.mjs's: real and twin differing by more than this is glyph paint. */
const GLYPH_CORE_DIFF = 2;
/** An element whose ring holds fewer pixels than this is not measured. */
const GLYPH_MIN_RING = 40;
/** At least this many elements of each kind, or the sample is vacuous. */
const GLYPH_MIN_ELEMENTS = 4;
/** How far past an element's text boxes its ring is gathered, in CSS px. */
const GLYPH_REACH = 3;
/** The wait after the last change before a frame is shot. */
const GLYPH_SETTLE_MS = 300;

/** What still eases on the scene (a transition) or in the column (anything). */
const EASING = `document.getAnimations().filter((a) => {
	const t = a.effect && a.effect.target;
	if (a.playState !== "running" || !(t instanceof Element)) return false;
	return (a instanceof CSSTransition && !!t.closest("#theme-scene")) || !!t.closest("#chat .chat");
}).length`;

/** Add or take away one of the samples' style elements. */
const glyphStyle = (id, css) => `(() => {
	document.getElementById(${JSON.stringify(id)})?.remove();
	const css = ${JSON.stringify(css)};
	if (css) {
		const s = document.createElement("style");
		s.id = ${JSON.stringify(id)};
		s.textContent = css;
		document.head.append(s);
	}
	return true;
})()`;
const STILL_CSS =
	"#chat .chat *, #chat .chat *::before, #chat .chat *::after { transition: none !important; }";
const TWIN_CSS = `#chat .chat *, #chat .chat *::before, #chat .chat *::after { color: ${TWIN_COLOUR} !important; -webkit-text-fill-color: ${TWIN_COLOUR} !important; }`;

/**
 * The column's visible band as a whole-px clip, and every element to
 * measure in it, with its text colour and its text boxes relative to the
 * clip. An element is measured only if every box lies inside the band, clear
 * of its edges (the header above, the composer below) and of the
 * jump-to-recent disc. A message row's words are the text inside .content
 * in .content's own colour, outside links, nicks, code, buttons and chips.
 */
const GLYPH_TARGETS = `(() => {
	const col = document.querySelector("#chat .chat");
	const r = col.getBoundingClientRect();
	const clip = {x: Math.ceil(r.left), y: Math.ceil(r.top)};
	clip.width = Math.floor(r.right) - clip.x;
	clip.height = Math.floor(r.bottom) - clip.y;
	const INSET = 6;
	const disc = document.querySelector("#chat .scroll-down-shown");
	const d = disc ? disc.getBoundingClientRect() : null;
	const inside = (b) =>
		b.left >= clip.x + INSET && b.top >= clip.y + INSET &&
		b.right <= clip.x + clip.width - INSET && b.bottom <= clip.y + clip.height - INSET &&
		!(d && b.right > d.left - INSET && b.left < d.right + INSET && b.bottom > d.top - INSET && b.top < d.bottom + INSET);
	const boxesOf = (nodes) => {
		const out = [];
		for (const n of nodes) {
			const range = document.createRange();
			range.selectNodeContents(n);
			for (const b of range.getClientRects()) if (b.width > 0 && b.height > 0) out.push(b);
		}
		return out;
	};
	const targets = [];
	let cut = 0;
	const add = (kind, el, nodes, color) => {
		const boxes = boxesOf(nodes);
		if (!boxes.length) return;
		if (!boxes.every(inside)) { cut++; return; }
		targets.push({
			kind,
			label: el.textContent.replace(/\\s+/g, " ").trim().slice(0, 40),
			color,
			boxes: boxes.map((b) => [b.left - clip.x, b.top - clip.y, b.width, b.height]),
		});
	};
	const SKIP = "a, .user, code, pre, button, .msg-reactions, .msg-edited, .preview, .msg-shown-in-active";
	for (const row of col.querySelectorAll('.msg[data-type="message"]')) {
		const content = row.querySelector(":scope > .content");
		if (!content) continue;
		const color = getComputedStyle(content).color;
		const nodes = [];
		const walk = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
		for (let n = walk.nextNode(); n; n = walk.nextNode()) {
			if (!n.data.trim()) continue;
			const p = n.parentElement;
			if (p.closest(SKIP) || getComputedStyle(p).color !== color) continue;
			nodes.push(n);
		}
		add("words", content, nodes, color);
	}
	for (const t of col.querySelectorAll(".msg > .time")) add("time", t, [t], getComputedStyle(t).color);
	for (const u of col.querySelectorAll(".msg > .from .user")) add("nick", u, [u], getComputedStyle(u).color);
	const h = document.documentElement;
	return {
		clip,
		targets,
		cut,
		text: h.dataset.psText,
		step: h.dataset.fontSize ?? null,
		dpr: devicePixelRatio,
	};
})()`;

/**
 * The column's faint colour as a computed colour: a probe span in the
 * column, read and taken away again — before the frames are shot, since it
 * changes the page.
 */
const FAINT_PROBE = `(() => {
	const col = document.querySelector("#chat .chat");
	const p = document.createElement("span");
	p.style.color = "var(--chat-fg-faint)";
	col.append(p);
	const c = getComputedStyle(p).color;
	p.remove();
	return c;
})()`;

/**
 * Decode the two frames in the page and measure every element (the page
 * has the decoder; node has none). Runs in the page; everything arrives as
 * JSON.
 */
function glyphMeasure(a64, b64, sample, again64) {
	return `(async () => {
		const load = async (b64) => {
			const img = new Image();
			img.src = "data:image/png;base64," + b64;
			await img.decode();
			const c = document.createElement("canvas");
			c.width = img.naturalWidth;
			c.height = img.naturalHeight;
			const ctx = c.getContext("2d", {willReadFrequently: true});
			ctx.drawImage(img, 0, 0);
			return {W: c.width, H: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data};
		};
		const A = await load(${JSON.stringify(a64)});
		const B = await load(${JSON.stringify(b64)});
		const A2 = await load(${JSON.stringify(again64)});
		const sample = ${JSON.stringify(sample)};
		const dpr = sample.dpr, W = A.W, H = A.H, n = W * H;
		const out = {W, H, BW: B.W, BH: B.H};
		if (B.W !== W || B.H !== H || A2.W !== W || A2.H !== H) return out;

		// The frame is still: shot twice, no pixel differs by more than the
		// core's threshold. A layer the freeze paused mid-animation (the near
		// grass's sway) can be rastered again a moment later, a level apart
		// here and there: that rounding is counted, not held, since it could
		// never pass for glyph paint.
		let moved = 0, rounding = 0;
		const movedAt = [];
		for (let i = 0; i < n; i++) {
			const k = i * 4;
			const diff = Math.max(Math.abs(A.d[k] - A2.d[k]), Math.abs(A.d[k + 1] - A2.d[k + 1]), Math.abs(A.d[k + 2] - A2.d[k + 2]));
			if (!diff) continue;
			if (diff <= ${GLYPH_CORE_DIFF}) { rounding++; continue; }
			moved++;
			if (movedAt.length < 8) movedAt.push([i % W, (i - (i % W)) / W, diff]);
		}
		out.moved = moved;
		out.rounding = rounding;
		out.movedAt = movedAt;

		// The core, and every pixel's Chebyshev distance from it (a
		// multi-source breadth-first search over the 8-neighbourhood).
		const MAXD = Math.max(3, dpr + 1);
		const dist = new Uint8Array(n).fill(255);
		const queue = new Int32Array(n);
		let head = 0, tail = 0, coreCount = 0;
		for (let i = 0; i < n; i++) {
			const k = i * 4;
			const diff = Math.max(Math.abs(A.d[k] - B.d[k]), Math.abs(A.d[k + 1] - B.d[k + 1]), Math.abs(A.d[k + 2] - B.d[k + 2]));
			if (diff > ${GLYPH_CORE_DIFF}) { dist[i] = 0; queue[tail++] = i; coreCount++; }
		}
		while (head < tail) {
			const i = queue[head++];
			const dd = dist[i];
			if (dd >= MAXD) continue;
			const x = i % W, y = (i - x) / W;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const j = ny * W + nx;
					if (dist[j] === 255) { dist[j] = dd + 1; queue[tail++] = j; }
				}
			}
		}
		out.core = coreCount;

		// Where else the twin differs, more than 2 device px from any glyph:
		// by at most the core's threshold, by construction (anything more is
		// core) — the raster's rounding again. Reported, not held.
		let off = 0, offMax = 0;
		for (let i = 0; i < n; i++) {
			if (dist[i] <= 2) continue;
			const k = i * 4;
			const diff = Math.max(Math.abs(A.d[k] - B.d[k]), Math.abs(A.d[k + 1] - B.d[k + 1]), Math.abs(A.d[k + 2] - B.d[k + 2]));
			if (diff > 0) { off++; offMax = Math.max(offMax, diff); }
		}
		out.off = off;
		out.offMax = offMax;

		const LIN = new Float64Array(256);
		for (let v = 0; v < 256; v++) { const c = v / 255; LIN[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
		const lum = (r, g, b) => 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
		const ratio = (p, q) => (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05);
		const parse = (s) => {
			const m = /rgba?\\(([\\d.]+),? ([\\d.]+),? ([\\d.]+)(?:,? \\/? ?([\\d.]+%?))?\\)/.exec(s);
			if (!m) return null;
			let a = m[4] === undefined ? 1 : parseFloat(m[4]);
			if (m[4] && m[4].endsWith("%")) a /= 100;
			return [+m[1], +m[2], +m[3], a];
		};
		/** A colour at alpha a over the ground pixel, as the browser composites it (sRGB, 8 bit). */
		const over = (c, R) => c[3] >= 1 ? c : [0, 1, 2].map((k) => Math.round(R[k] + (c[k] - R[k]) * c[3]));
		const faint = parse(sample.faintProbe);
		const pct = (v, q) => v[Math.floor(q * (v.length - 1))];
		const stamp = new Int32Array(n).fill(-1);
		const results = [];
		sample.targets.forEach((t, ti) => {
			const colour = parse(t.color);
			const main = [], dim = [];
			for (const [bx, by, bw, bh] of t.boxes) {
				const x0 = Math.max(0, Math.floor((bx - ${GLYPH_REACH}) * dpr)), y0 = Math.max(0, Math.floor((by - ${GLYPH_REACH}) * dpr));
				const x1 = Math.min(W, Math.ceil((bx + bw + ${GLYPH_REACH}) * dpr)), y1 = Math.min(H, Math.ceil((by + bh + ${GLYPH_REACH}) * dpr));
				for (let y = y0; y < y1; y++) {
					for (let x = x0; x < x1; x++) {
						const i = y * W + x;
						if (dist[i] !== dpr || stamp[i] === ti) continue;
						stamp[i] = ti;
						const k = i * 4, R = [A.d[k], A.d[k + 1], A.d[k + 2]];
						const lR = lum(R[0], R[1], R[2]);
						const T = over(colour, R);
						main.push(ratio(lum(T[0], T[1], T[2]), lR));
						if (t.kind === "words" && faint) {
							const F = over(faint, R);
							dim.push(ratio(lum(F[0], F[1], F[2]), lR));
						}
					}
				}
			}
			if (main.length < ${GLYPH_MIN_RING}) {
				results.push({kind: t.kind, label: t.label, ring: main.length, skipped: true});
				return;
			}
			main.sort((p, q) => p - q);
			const r = {kind: t.kind, label: t.label, color: t.color, ring: main.length, p10: pct(main, 0.1), min: main[0], median: pct(main, 0.5)};
			results.push(r);
			if (dim.length) {
				dim.sort((p, q) => p - q);
				results.push({kind: "faint", label: t.label, color: sample.faintProbe, ring: dim.length, p10: pct(dim, 0.1), min: dim[0], median: pct(dim, 0.5)});
			}
		});
		out.results = results;
		return out;
	})()`;
}

/**
 * One glyph sample: the page at the instant `ms`, settled, frozen (the
 * scene stops for a hidden page), shot as it is and as its twin, then shown
 * again. Returns the scene's state, the sample's elements and the measure.
 */
async function glyphSample(page, ms, slug) {
	const s = await at(page, ms);
	// A layer's fade and a weather rebuild outlast at()'s wait: let
	// everything that eases on the scene or in the column finish first.
	for (const until = Date.now() + 8000; Date.now() < until; ) {
		if ((await page.evaluate(EASING)) === 0) break;
		await page.sleep(250);
	}
	const faintProbe = await page.evaluate(FAINT_PROBE);
	await page.evaluate(VISIBILITY("hidden"));
	await page.evaluate(glyphStyle(GLYPH_STILL, STILL_CSS));
	await page.evaluate(PAINTED);
	const frozen = await page.evaluate(SCENE_STATE);
	const easing = await page.evaluate(EASING);
	const sample = {...(await page.evaluate(GLYPH_TARGETS)), faintProbe};
	const clip = {...sample.clip, scale: 1};
	// Every change is made: let the page finish painting it before the
	// first frame (a frame shot straight after a change can still hold
	// tiles rastered a level or two apart).
	await page.evaluate(PAINTED);
	await page.sleep(GLYPH_SETTLE_MS);
	const a = await page.send("Page.captureScreenshot", {format: "png", clip});
	// The same frame again: it must come back identical, or something moved.
	await page.evaluate(PAINTED);
	await page.sleep(GLYPH_SETTLE_MS);
	const a2 = await page.send("Page.captureScreenshot", {format: "png", clip});
	await page.evaluate(glyphStyle(GLYPH_TWIN, TWIN_CSS));
	await page.evaluate(PAINTED);
	await page.sleep(GLYPH_SETTLE_MS);
	const b = await page.send("Page.captureScreenshot", {format: "png", clip});
	await page.evaluate(glyphStyle(GLYPH_TWIN, ""));
	await page.evaluate(PAINTED);
	await page.evaluate(glyphStyle(GLYPH_STILL, ""));
	await page.evaluate(VISIBILITY("visible"));
	mkdirSync(page.outDir, {recursive: true});
	writeFileSync(join(page.outDir, `ps-glyphs-${slug}.png`), Buffer.from(a.data, "base64"));
	writeFileSync(join(page.outDir, `ps-glyphs-${slug}-twin.png`), Buffer.from(b.data, "base64"));
	const m = await page.evaluate(glyphMeasure(a.data, b.data, sample, a2.data));
	return {s, frozen, easing, sample, m};
}

/** Two frames painted since the last change. */
const PAINTED = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`;

/**
 * What style.css's touch rule paints #status-bar-tint with, resolved on the
 * element. Chromium never paints the tint — the rule sits behind WebKit's
 * `@supports (-webkit-touch-callout: none)` — so the scenario reads the value
 * the rule declares, applies it to the tint for the length of one read, and
 * returns the colour it resolves to (null if the rule is not found).
 */
const TINT_PAINT = `(() => {
	const find = (rules) => {
		for (const r of rules) {
			if (r.selectorText === "#status-bar-tint" && r.style.getPropertyValue("background-color")) return r.style.getPropertyValue("background-color");
			if (r.cssRules) { const v = find(r.cssRules); if (v) return v; }
		}
		return null;
	};
	let declared = null;
	for (const sheet of document.styleSheets) {
		try { declared = find(sheet.cssRules); } catch { continue; }
		if (declared) break;
	}
	if (!declared) return null;
	const tint = document.getElementById("status-bar-tint");
	const was = tint.style.getPropertyValue("background-color");
	tint.style.setProperty("background-color", declared);
	const painted = getComputedStyle(tint).backgroundColor;
	tint.style.setProperty("background-color", was);
	return {declared, painted};
})()`;

/**
 * The native select's colours (the user's report, 2026-09-26: at night its
 * list drew light text on a light ground): the theme select's own fill and
 * text, every option's, and the solid and ink they should be.
 */
const SELECT_COLOURS = `(() => {
	const sel = document.querySelector("#theme-select");
	const cs = getComputedStyle(sel);
	const root = getComputedStyle(document.documentElement);
	return {
		light: document.documentElement.dataset.psLight,
		scheme: cs.colorScheme,
		select: {bg: cs.backgroundColor, color: cs.color},
		options: [...sel.options].map((o) => { const c = getComputedStyle(o); return {bg: c.backgroundColor, color: c.color}; }),
		solid: root.getPropertyValue("--ps-g-solid").trim(),
		ink: root.getPropertyValue("--ps-g-ink").trim(),
	};
})()`;

/** WCAG contrast between two `rgb(r, g, b)` colours. */
function contrastRgb(p, q) {
	const lin = (v) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const lum = (s) => {
		const [r, g, b] = rgba(s).rgb.split(", ").map(Number);
		return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
	};
	const [hi, lo] = [lum(p), lum(q)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * The reply quote under the neighbour's long line (plan 4 task 5, fix round
 * 1): its box, the text column's content box and the row's, whether the
 * column is inline (the phone's flow), the quote's box-sizing, and whether
 * its text is clamped (an ellipsis).
 */
const QUOTE_BOX = (run) => `(() => {
	const q = [...document.querySelectorAll("#chat .msg:not(.pending) .msg-reply-quote")].find((e) =>
		e.closest(".msg").textContent.includes(${JSON.stringify(`a reply ${run}`)})
	);
	if (!q) return null;
	const c = q.closest(".content"), m = q.closest(".msg");
	const cs = getComputedStyle(c), ms = getComputedStyle(m);
	const qr = q.getBoundingClientRect(), cr = c.getBoundingClientRect(), mr = m.getBoundingClientRect();
	return {
		quote: [qr.left, qr.right],
		content: [cr.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), cr.right - parseFloat(cs.paddingRight)],
		row: [mr.left + parseFloat(ms.paddingLeft), mr.right - parseFloat(ms.paddingRight)],
		display: cs.display,
		sizing: getComputedStyle(q).boxSizing,
		clamped: q.scrollWidth > q.clientWidth,
	};
})()`;

/** `box` [left, right] lies within `within` [left, right], to half a pixel. */
const insideOf = (box, within) => box[0] >= within[0] - 0.5 && box[1] <= within[1] + 0.5;

/** Type a line into the composer and send it. */
async function sendLine(page, text) {
	await page.evaluate(
		`(() => {
			const i = document.getElementById("input");
			i.value = ${JSON.stringify(text)};
			i.dispatchEvent(new Event("input", {bubbles: true}));
			document.getElementById("form").requestSubmit();
		})()`
	);
}

export default async function run(page) {
	// The real clock until the plains' fixed days move it.
	await page.addInitScript(CLOCK_SHIM);
	// A ?host link only pre-fills the connect form (a link is a suggestion,
	// boot.ts handleQueryParams); connect for real.
	await page.goto(page.url, {waitForSelector: "#connect form"});
	// Resource Timing drops entries silently past its default 250, which would
	// let "no animal file was fetched" pass on a busy page; the control in
	// ANIMAL_FILES catches that too, this makes it not happen.
	await page.evaluate(`performance.setResourceTimingBufferSize(10000)`);
	await page.evaluate(INSTALL_SHIM);
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar",
	});
	await page.click(`.channel-list-item[data-name="#seance"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "the input box"});
	await page.waitFor(`document.querySelector("#chat .msg")`, {label: "the join burst"});
	await page.sleep(1000); // let the join burst and the catch-up settle

	// A line of our own first: joins are condensed by default, and the
	// neighbour's must stand alone to show its hostmask and realname, not
	// fold into the join burst's last event.
	await sendLine(page, `waiting on the plains ${RUN}`);
	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {
		label: "our line before the neighbour",
	});

	const peer = await neighbour(PEER, EXT_NAME);
	peer.say(`hello from the neighbour ${RUN}`);
	peer.say(`${EXT_NAME} says hello too ${RUN}`);
	peer.say(`${VI_NAME} says xin chào ${RUN}`);
	peer.say(`\x1d${VI_NAME}\x1d, in italic ${RUN}`);
	// A nick inside the text: the client links it (findNames) as a .user
	// span in .content, which the words' face sets, not the names' (I2).
	peer.say(`${PEER} is my name ${RUN}`);
	await page.waitFor(OTHERS_LINE, {label: "the neighbour's line"});
	await page.waitFor(`document.querySelector('${PEER_JOIN} .realname')`, {
		label: "the neighbour's join, on its own, with its realname",
	});

	// ---- pick ps from Appearance

	await openAppearance(page);
	// The theme is called ps, shown as "ps"; the ancestor's "ps <3" is gone.
	const options = await page.evaluate(
		`[...document.querySelectorAll("#theme-select option")].map((o) => [o.value, o.textContent.trim()])`
	);
	page.check(
		`the theme list offers ps as "ps" (${JSON.stringify(options.find(([v]) => v === "ps"))})`,
		options.some(([v, text]) => v === "ps" && text === "ps")
	);
	page.check(
		`no theme is called heart or shown as "ps <3" (${options.length} themes)`,
		options.every(([v, text]) => v !== "heart" && !text.includes("<3"))
	);
	await chooseTheme(page, "ps");
	await closeSettings(page);
	await openSeance(page, "back in #seance");

	page.check(
		"the stylesheet is themes/ps.css",
		(await page.evaluate(THEME_HREF)) === "themes/ps.css"
	);
	checkMounted(page, await page.evaluate(SCENE_STATE), "#seance");

	// The animals are off: every slot of the scene's animal layer empty,
	// nothing painted, and — the part only a browser can say — no animal file
	// requested, although the stylesheet still names all of them. A `url()`
	// sitting in a custom property that no resolved background-image
	// substitutes is never fetched (tools/heart/README.md § Budget and
	// browsers).
	checkNoAnimals(page, await animalFiles(page, "the theme's subresources recorded"), "#seance");

	// ---- the fonts
	//
	// Every one of the nine files has text of its own on the page: the
	// neighbour's join (its hostmask and its realname, EXT_NAME, in italic),
	// its lines (EXT_NAME upright, VI_NAME upright and in italic), and queries
	// called EXT_NAME and VI_NAME, whose names the sidebar sets in Newsreader.
	// Each face must have loaded, and — the latin-ext trap — each must have
	// drawn that text.

	await sendLine(page, `/query ${EXT_NAME}`);
	await page.waitFor(`document.querySelector('${EXT_QUERY_ROW}')`, {
		label: `the query ${EXT_NAME} in the sidebar`,
	});
	await sendLine(page, `/query ${VI_NAME}`);
	await page.waitFor(`document.querySelector('${VI_QUERY_ROW}')`, {
		label: `the query ${VI_NAME} in the sidebar`,
	});
	await openSeance(page, `back in #seance from ${EXT_NAME}`);
	await page.evaluate(`document.fonts.ready.then(() => true)`);
	await page.sleep(500);

	const faces = await page.evaluate(FONT_FACES);

	for (const [family, style] of [
		["Source Sans 3", "normal"],
		["Source Sans 3", "italic"],
		["Newsreader", "normal"],
	]) {
		for (const block of ["latin", "latin-ext", "vietnamese"]) {
			const face = faces.filter(
				(f) => f.family === family && f.style === style && f.block === block
			);
			page.check(
				`fonts: ${family} ${style}, ${block}, is loaded (${
					face.map((f) => f.status).join(", ") || "not declared"
				})`,
				face.length === 1 && face[0].status === "loaded"
			);
		}
	}

	const widths = await page.evaluate(FONT_WIDTHS);

	for (const [probe, [own, fallback]] of Object.entries(widths)) {
		// NaN is a font string the canvas refused (FONT_WIDTHS).
		page.check(
			`fonts: ${probe} measures unlike its fallback (${own.toFixed(2)} vs ${fallback.toFixed(
				2
			)})`,
			Number.isFinite(own) && Number.isFinite(fallback) && own !== fallback
		);
	}

	await page.send("DOM.enable");
	await page.send("DOM.getDocument", {depth: 0});
	await page.send("CSS.enable");
	await checkDrawnIn(
		page,
		"the neighbour's join shows its hostmask in Source Sans 3 italic",
		TEXT_HOLDER(`${PEER_JOIN} .hostmask`, "@"),
		"Source Sans 3",
		true
	);
	await checkDrawnIn(
		page,
		`the neighbour's join shows its realname, ${EXT_NAME}, in Source Sans 3 italic`,
		TEXT_HOLDER(`${PEER_JOIN} .realname`, EXT_NAME),
		"Source Sans 3",
		true
	);
	await checkDrawnIn(
		page,
		`the neighbour's line says ${EXT_NAME} in Source Sans 3`,
		TEXT_HOLDER(PEER_LINES, EXT_NAME),
		"Source Sans 3",
		false
	);
	await checkDrawnIn(
		page,
		`the sidebar names the query ${EXT_NAME} in Newsreader`,
		TEXT_HOLDER(`${EXT_QUERY_ROW} .name`, EXT_NAME),
		"Newsreader",
		false
	);
	await checkDrawnIn(
		page,
		`the neighbour's line says ${VI_NAME} in Source Sans 3`,
		TEXT_HOLDER(PEER_LINES, `${VI_NAME} says`),
		"Source Sans 3",
		false
	);
	await checkDrawnIn(
		page,
		`the neighbour's line says ${VI_NAME} in Source Sans 3 italic`,
		TEXT_HOLDER(`${PEER_LINES} .irc-italic`, VI_NAME),
		"Source Sans 3",
		true
	);
	await checkDrawnIn(
		page,
		`the sidebar names the query ${VI_NAME} in Newsreader`,
		TEXT_HOLDER(`${VI_QUERY_ROW} .name`, VI_NAME),
		"Newsreader",
		false
	);

	// The nick column keeps the names' face; the same nick named inside the
	// text takes the text's face, bold, in the same colour (the user's I2).
	await page.waitFor(`document.querySelector('${PEER_LINES} .user')`, {
		label: `the neighbour's line naming ${PEER}, linked`,
	});
	await checkDrawnIn(
		page,
		`the nick column names ${PEER} in Newsreader`,
		TEXT_HOLDER(`#chat .msg[data-type="message"][data-from="${PEER}"] .from .user`, PEER),
		"Newsreader",
		false,
		// A nick wider than the column's 12ch (a run id with a w or two) ends
		// in the column's ellipsis, which is .from's, the words' face.
		{clippedBy: ".from"}
	);
	await checkDrawnIn(
		page,
		`the neighbour's line names ${PEER} in Source Sans 3, not Newsreader`,
		TEXT_HOLDER(`${PEER_LINES} .user`, PEER),
		"Source Sans 3",
		false
	);
	const inTextNick = await page.evaluate(`(() => {
		const inText = document.querySelector('${PEER_LINES} .user');
		const column = inText.closest(".msg").querySelector(".from .user");
		const a = getComputedStyle(inText), b = getComputedStyle(column);
		return {weight: a.fontWeight, color: a.color, columnColor: b.color, textWeight: getComputedStyle(inText.closest(".content")).fontWeight};
	})()`);
	page.check(
		`the in-text nick is bold, 700 against the text's ${inTextNick.textWeight}, in the nick column's colour (${inTextNick.color} vs ${inTextNick.columnColor})`,
		inTextNick.weight === "700" &&
			inTextNick.textWeight === "500" &&
			inTextNick.color === inTextNick.columnColor
	);
	await page.send("CSS.disable");
	await page.send("DOM.disable");

	// ---- messages: the fade, no glitter, the reaction's pop

	const anim = await page.evaluate(
		`getComputedStyle(document.querySelector("#chat .msg")).animationName`
	);
	page.check(`messages fade in (${anim})`, anim.includes("ps-fade"));

	// The neighbour's own line, not the first .time in the log: that can be a
	// condensed group's empty one, stretched to a two-line summary beside it
	// (the rig's #seance history is whatever earlier runs left).
	const timeMetrics = await page.evaluate(
		`(() => {
			const el = document.querySelector('#chat .msg[data-type="message"][data-from="${PEER}"] .time');
			const cs = getComputedStyle(el);
			return [el.getBoundingClientRect().height, parseFloat(cs.lineHeight)];
		})()`
	);
	page.check(
		`timestamp is one line (${timeMetrics[0].toFixed(1)}px height, ${timeMetrics[1].toFixed(
			1
		)}px line-height)`,
		timeMetrics[0] < timeMetrics[1] * 1.6
	);

	// One send, one burst of embers (ps.css, spec §9), and no flash as the
	// echo lands. The echo of this line is held back by INSTALL_SHIM, so the
	// pending copy is on screen for a while before the echo replaces it; every
	// animation that starts in #chat meanwhile is logged, and both rows are
	// read the moment they land (WATCH_OWN). The pending copy stands at
	// style.css's 0.55 with no animation and lights nothing; the echo is a new
	// row, and it settles up from that 0.55 (ps.css ps-settle) rather than
	// fading in from nothing, which blinked every sent line out and back (the
	// user, 2026-09-25), and lights the embers: four sparks, on its own
	// ::before/::after and its text's. The settle is also the control that the
	// log is live.
	await page.evaluate(INSTALL_ANIMATION_LOG);
	await page.evaluate(`window.__animLog.length = 0`);
	await page.evaluate(WATCH_OWN);
	await sendLine(page, OWN_TEXT);
	await page.waitFor(`document.querySelector("#chat .msg.self.pending")`, {
		label: "the pending own message",
	});
	await page.sleep(HOLD_MS / 3);
	const heldAnims = await page.evaluate(
		`(() => { const p = document.querySelector("#chat .msg.self.pending"); return p ? p.getAnimations().length : null; })()`
	);
	const heldLog = await page.evaluate(`window.__animLog.slice()`);
	await page.waitFor(`!document.querySelector("#chat .msg.pending")`, {
		timeout: HOLD_MS + 10000,
		label: "the held-back echo",
	});
	await page.sleep(1500); // the last spark starts 0.54 s in
	const sendLog = await page.evaluate(`window.__animLog.slice()`);
	const own = await page.evaluate(`window.__own`);
	page.check(
		`the pending copy runs no animation, at 0.55 (landed: animation-name ${
			own.pending?.name
		}, opacity ${own.pending?.opacity}, ${JSON.stringify(
			own.pending?.anims
		)}; ${heldAnims} animations while held)`,
		!!own.pending &&
			own.pending.name === "none" &&
			own.pending.anims.length === 0 &&
			Number(own.pending.opacity) === 0.55 &&
			heldAnims === 0
	);
	const settleAnim = own.echo?.anims.find((a) => a.name === "ps-settle");
	page.check(
		`the echo settles up from its pending copy's 0.55: ps-settle alone, keyframes ${
			settleAnim?.from
		} → ${settleAnim?.to}, opacity ${own.echo?.opacity} as it lands (${JSON.stringify(
			own.echo?.anims
		)})`,
		!!own.echo &&
			own.echo.anims.length === 1 &&
			!!settleAnim &&
			Number(settleAnim.from) === 0.55 &&
			Number(settleAnim.to) === 1 &&
			Number(own.echo.opacity) === 0.55
	);
	page.check(
		`the echo's settle is logged as it starts (${describeLog(sendLog)})`,
		sendLog.some((e) => e.name === "ps-settle" && !e.pseudo)
	);
	page.check(
		`the pending copy lights no ember while it is held (${describeLog(embersIn(heldLog))})`,
		embersIn(heldLog).length === 0
	);
	const echoId = await page.evaluate(`document.querySelector("${LAST_OWN}")?.id`);
	const sparks = embersIn(sendLog);
	page.check(
		`one send, one burst: four sparks on the echo ${echoId}, its ::before/::after and its text's (${describeLog(
			sparks
		)})`,
		sparks.length === 4 &&
			sparks.every((e) => e.row === echoId && !/(^|\s)pending(\s|$)/.test(e.rowCls)) &&
			new Set(sparks.map((e) => `${e.cls.split(/\s+/)[0]}${e.pseudo}`)).size === 4 &&
			sparks.filter((e) => e.cls === "content").length === 2
	);

	// A reaction lights a smaller burst over its chip, as the chip arrives.
	// The first on a message enters with its whole group
	// (.reactions-enter-active), a later one on its own
	// (.reaction-enter-active); style.css pops either in over 160 ms, ps.css
	// holds the class open for the burst (ps-ember-hold) and widens the text
	// column's clip by the sparks' rise and glow while it runs (overflow:
	// clip with a margin; style.css's anti-Zalgo clip otherwise). About a
	// second in, both sparks must still be rising: Vue would have taken the
	// class, and them, at 160 ms. The group is read as it lands
	// (WATCH_ENTERS), which is also the control for the query's check below.
	const RUNNING_ON_CHIPS = `document.getAnimations().filter((a) => a.animationName === "ps-ember" && a.playState === "running" && a.effect.target.closest(".msg-reaction")).map((a) => a.effect.target.textContent)`;
	const TEXT_CLIP = `(() => { const c = getComputedStyle(document.querySelector("${LAST_OWN} > .content")); return c.overflow + (c.overflow === "clip" ? " " + c.overflowClipMargin : ""); })()`;
	await page.evaluate(`window.__animLog.length = 0`);
	await page.evaluate(WATCH_ENTERS);
	await sendLine(page, "/react 💖");
	await page.waitFor(`window.__enters.length > 0`, {
		timeout: 20000,
		label: "the reaction's group entering",
	});
	await page.sleep(900);
	const firstHeld = await page.evaluate(RUNNING_ON_CHIPS);
	const firstClip = await page.evaluate(TEXT_CLIP);
	await page.sleep(2000);
	const reactLog = await page.evaluate(`window.__animLog.slice()`);
	const afterClip = await page.evaluate(TEXT_CLIP);
	const rootPx = await page.evaluate(
		`parseFloat(getComputedStyle(document.documentElement).fontSize)`
	);
	const firstEnter = await page.evaluate(`window.__enters.slice()`);
	page.check(
		`the first reaction enters with its group, which pops and holds, and its chip's text lights both sparks, read as it lands (${JSON.stringify(
			firstEnter
		)})`,
		firstEnter.length === 1 &&
			/(^|\s)reactions-enter-active(\s|$)/.test(firstEnter[0].cls) &&
			firstEnter[0].own === "reaction-pop, ps-ember-hold" &&
			firstEnter[0].sparks.join() === "ps-ember,ps-ember"
	);
	page.check(
		`the first reaction: one burst, two sparks off the chip's text, none on the row (${describeLog(
			embersIn(reactLog)
		)})`,
		embersIn(reactLog).length === 2 &&
			embersIn(reactLog).every((e) => e.cls === "msg-reaction-text" && e.text.includes("💖"))
	);
	page.check(
		`the group's class is held for the burst: both sparks rising 0.9 s in (${JSON.stringify(
			firstHeld
		)}), the text column's clip widened then (${firstClip}) and back to its own, 0.75rem out, after (${afterClip})`,
		firstHeld.length === 2 &&
			/^clip \S+px$/.test(firstClip) &&
			// back to the column's own clip, 0.75rem out for the text's outline
			afterClip === `clip ${0.75 * rootPx}px`
	);

	await page.evaluate(`window.__animLog.length = 0`);
	await page.evaluate(WATCH_ENTERS);
	await sendLine(page, "/react 🌾");
	await page.waitFor(`window.__enters.some((e) => e.text.includes("🌾"))`, {
		timeout: 20000,
		label: "the second reaction's chip entering",
	});
	await page.sleep(900);
	const secondHeld = await page.evaluate(RUNNING_ON_CHIPS);
	await page.sleep(2000);
	const secondLog = await page.evaluate(`window.__animLog.slice()`);
	page.check(
		`a second reaction: one burst on the new chip alone, held 0.9 s in (${describeLog(
			embersIn(secondLog)
		)}; rising ${JSON.stringify(secondHeld)})`,
		embersIn(secondLog).length === 2 &&
			embersIn(secondLog).every(
				(e) => e.cls === "msg-reaction-text" && e.text.includes("🌾")
			) &&
			secondHeld.length === 2 &&
			secondHeld.every((t) => t.includes("🌾"))
	);

	await page.screenshot("ps-seance");

	// ---- no embers in a query: the plains stand still there (spec §5.7)

	// A query with the neighbour, so a line and a reaction have their echoes.
	// Read at fixed moments, not from animation events alone (the check once
	// lost style.css's 160 ms pop from the log and failed on its control):
	// the echo's four spark pseudo-elements once it is the newest row, whose
	// own ps-settle is the control that the stylesheet and the row are live;
	// and the reaction's group as it is inserted, its enter class on, whose
	// pop is the control that it entered, the same reading that lit both
	// sparks in #seance above. And no ember or hold in the event log.
	const PEER_ROW = `.channel-list-item[data-type="query"][data-name="${PEER}"]`;
	await sendLine(page, `/query ${PEER}`);
	await page.waitFor(
		`document.querySelector('${PEER_ROW}.active') && document.querySelector('#chat .chat-view[data-type="query"] #input, #chat .chat-view[data-type="query"]')`,
		{label: `the query with ${PEER}`}
	);
	await page.sleep(500);
	await page.evaluate(`window.__animLog.length = 0`);
	const QUERY_TEXT = `in a query ${RUN}`;
	await sendLine(page, QUERY_TEXT);
	await page.waitFor(
		`(() => { const r = document.querySelector("${LAST_OWN}"); return !!r && r.textContent.includes(${JSON.stringify(
			QUERY_TEXT
		)}); })()`,
		{label: "the query's own line"}
	);
	const queryRow = await page.evaluate(ROW_SPARKS(LAST_OWN));
	await page.sleep(300);
	await page.evaluate(WATCH_ENTERS);
	await sendLine(page, "/react 💖");
	await page.waitFor(`window.__enters.length > 0`, {
		timeout: 20000,
		label: "the query's reaction entering",
	});
	await page.sleep(1200);
	const queryLog = await page.evaluate(`window.__animLog.slice()`);
	const queryEnter = await page.evaluate(`window.__enters.slice()`);
	page.check(
		`a query lights no ember, on a send or a reaction, and holds nothing: the echo settles (${
			queryRow.own
		}) with no spark (${queryRow.sparks.join(
			", "
		)}), its reaction's group pops in with none (${JSON.stringify(
			queryEnter
		)}), and no ember or hold in the log (${describeLog(queryLog)})`,
		queryRow.own === "ps-settle" &&
			queryRow.sparks.every((n) => n === "none") &&
			queryEnter.length === 1 &&
			/(^|\s)reactions-enter-active(\s|$)/.test(queryEnter[0].cls) &&
			queryEnter[0].own === "reaction-pop" &&
			queryEnter[0].sparks.join() === "none,none" &&
			embersIn(queryLog).length === 0 &&
			!queryLog.some((e) => e.name === "ps-ember-hold")
	);

	// ---- a second channel, the same place

	await page.click(`.channel-list-item[data-name="#kittens"]`);
	await page.waitFor(`document.querySelector("#input")`, {label: "in #kittens"});
	await page.sleep(300);
	checkNoAnimals(page, await animalFiles(page, "#kittens settled"), "#kittens");
	await page.screenshot("ps-kittens");

	// ---- reduced motion

	// Reduced motion repoints every animal token at its still. The slots stay
	// empty, so no still is painted or fetched either. The repointing itself
	// is the control that the emulation took: without it this leg would be a
	// second look at the animated tokens. The scene stops outright, visible
	// or not.
	await page.send("Emulation.setEmulatedMedia", {
		features: [{name: "prefers-reduced-motion", value: "reduce"}],
	});
	await openSeance(page, "back in #seance, reduced");
	const still = await page.evaluate(
		`getComputedStyle(document.documentElement).getPropertyValue("--ps-horse").trim()`
	);
	page.check(
		`reduced motion points the animals at their stills (${still})`,
		/-still\.svg/.test(still)
	);
	checkNoAnimals(page, await animalFiles(page, "the reduced scene settled"), "reduced motion");
	checkStopped(page, await page.evaluate(SCENE_STATE), "reduced motion, visible");
	await page.evaluate(VISIBILITY("hidden"));
	checkStopped(page, await page.evaluate(SCENE_STATE), "reduced motion, hidden");
	await page.evaluate(VISIBILITY("visible"));
	await page.sleep(300);
	checkStopped(page, await page.evaluate(SCENE_STATE), "reduced motion, shown again");
	// Still, each cloud rests where its delay puts it in its drift (--cp,
	// plains.ts), on ps-drift's own path: with the animation gone they all
	// stood at left: 0, piled up at the scene's left edge.
	const rests = await page.evaluate(CLOUD_RESTS);
	const restLefts = rests.map((c) => c.left).sort((a, b) => a - b);
	const restWeather = await page.evaluate(
		`document.getElementById("theme-scene").dataset.weather`
	);
	page.check(
		`reduced motion (${restWeather}): the ${cloudsFor(
			restWeather
		)} clouds rest in as many places, not animating (${rests
			.map((c) => c.left.toFixed(1))
			.join(", ")} of ${rests[0]?.width}; ${[...new Set(rests.map((c) => c.animation))]})`,
		rests.length === cloudsFor(restWeather) &&
			rests.every((c) => c.animation === "none") &&
			restLefts.every((x, i) => i === 0 || x - restLefts[i - 1] > 20)
	);
	page.check(
		`reduced motion: each cloud on the sky, at least partly (${rests
			.map((c) => `${c.left.toFixed(0)}..${c.right.toFixed(0)}`)
			.join(" | ")})`,
		rests.every((c) => c.right > 0 && c.left < c.width)
	);
	// No embers either: a send and a reaction light nothing, and nothing
	// holds the reaction's class open (style.css's own stand-down applies).
	await page.evaluate(`window.__animLog.length = 0`);
	const REDUCED_TEXT = `reduced ${RUN}`;
	await sendLine(page, REDUCED_TEXT);
	await page.waitFor(
		`(() => { const r = document.querySelector("${LAST_OWN}"); return !!r && r.textContent.includes(${JSON.stringify(
			REDUCED_TEXT
		)}); })()`,
		{label: "the reduced own line"}
	);
	await page.sleep(300);
	await sendLine(page, "/react 💖");
	await page.waitFor(`document.querySelector("${LAST_OWN} .msg-reaction")`, {
		timeout: 20000,
		label: "the reduced reaction",
	});
	await page.sleep(1200);
	const reducedLog = await page.evaluate(`window.__animLog.slice()`);
	const reducedEmbers = await page.evaluate(
		`document.getAnimations().filter((a) => /^ps-ember/.test(a.animationName)).length`
	);
	page.check(
		`reduced motion lights no ember on a send or a reaction, and holds nothing (${describeLog(
			reducedLog
		)}; ${reducedEmbers} ember animations)`,
		embersIn(reducedLog).length === 0 &&
			!reducedLog.some((e) => e.name === "ps-ember-hold") &&
			reducedEmbers === 0
	);
	await page.screenshot("ps-reduced");
	await page.send("Emulation.setEmulatedMedia", {features: []});
	await page.sleep(300);
	checkRunning(page, await page.evaluate(SCENE_STATE), "reduced motion lifted");

	// ---- the hours

	// The words are white all day, and dark ink only where it holds over
	// every ground of the moment (the user's "A", 2026-09-25): over the year
	// that is a snowy day, from before 08:50 to after 15:45 on every one
	// (grounds.ts inkWindow). Today's weather decides which.
	const noon = await atHour(page, 12);
	const noonInk = noon.weather === "snow";
	page.check(
		`noon (${hhmm(noon.minute)}, ${noon.weather}): daylight, ${
			noonInk ? "dark ink on a snowy day" : "white words"
		} ${noon.ink} (light ${noon.light}, text ${noon.text})`,
		noon.light === "day" &&
			noon.text === (noonInk ? "ink" : "light") &&
			noon.ink === (noonInk ? INK : WHITE)
	);
	page.check(
		`noon: the canvas is the sky's top (${noon.canvas} = ${noon.skyTop})`,
		noon.canvas !== "" && noon.canvas === noon.skyTop
	);
	// The browser's own bar runs on into the sky (scene.ts themeColorFor).
	page.check(
		`noon: theme-color is the canvas (${noon.meta} = ${noon.canvas})`,
		noon.canvas !== "" && noon.meta === noon.canvas
	);

	// The chrome floats over the plains as day glass; the iOS status bar's
	// tint is never blurred (iOS would not sample it: CLAUDE.md, "The iOS
	// status bar").
	const noonChrome = await page.evaluate(CHROME);
	checkGlass(page, noonChrome, "noon", DAY_GLASS);
	page.check(
		`noon: #status-bar-tint has no backdrop filter (${noonChrome.tint?.blur})`,
		noonChrome.tint?.blur === "none"
	);
	// And it paints the sky's top: style.css's touch rule, resolved on the
	// tint (Chromium never paints it; the rule is WebKit's alone, and the
	// device check is the user's: spec §12).
	const noonTint = await page.evaluate(TINT_PAINT);
	page.check(
		`noon: #status-bar-tint paints the canvas, the sky's top (style.css's rule: ${
			noonTint?.declared
		}, resolved ${noonTint?.painted} = ${hexRgb(noon.canvas)})`,
		!!noonTint && noonTint.painted === hexRgb(noon.canvas)
	);
	checkAccent(page, noonChrome, "noon");
	await checkComposer(page, "noon");
	await page.screenshot("ps-noon");
	// A send's embers at noon, still, over the row and the rows above it.
	const noonSparks = await emberFrame(page, `embers at noon ${RUN}`, "ps-embers-noon");
	page.check(
		`noon: a send's four sparks, held mid-burst for the frame (${noonSparks})`,
		noonSparks === 4
	);

	for (const hour of [22, 0]) {
		const s = await atHour(page, hour);
		page.check(
			`${hhmm(s.minute)}: night, white text ${s.ink} (light ${s.light}, text ${s.text})`,
			s.light === "night" && s.text === "light" && s.ink === WHITE
		);
		page.check(
			`${hhmm(s.minute)}: the canvas is the sky's top (${s.canvas} = ${s.skyTop})`,
			s.canvas !== "" && s.canvas === s.skyTop
		);

		if (hour === 22) {
			// Night glass, and the chrome's words in the night glass's inks.
			const at = hhmm(s.minute);
			const night = await page.evaluate(CHROME);
			checkGlass(page, night, at, NIGHT_GLASS);
			page.check(
				`${at}: #status-bar-tint has no backdrop filter (${night.tint?.blur})`,
				night.tint?.blur === "none"
			);
			const nightTint = await page.evaluate(TINT_PAINT);
			page.check(
				`${at}: #status-bar-tint paints the canvas, the night sky's top (style.css's rule: ${
					nightTint?.declared
				}, resolved ${nightTint?.painted} = ${hexRgb(s.canvas)})`,
				!!nightTint && nightTint.painted === hexRgb(s.canvas)
			);
			checkAccent(page, night, at);
			await checkComposer(page, at);
			const rail = await page.evaluate(RAIL_NAMES);
			page.check(
				`${at}: an idle channel name is the night soft ink ${rail.soft} (${
					rail.idle ? `${rail.idle.row} ${rail.idle.color}` : "no idle channel row"
				})`,
				!!rail.idle && rail.idle.color === hexRgb(rail.soft)
			);
			page.check(
				`${at}: the open channel's name is the night ink ${NIGHT_INK} (${
					rail.open ? `${rail.open.row} ${rail.open.color}` : "no open channel row"
				})`,
				!!rail.open && rail.open.color === NIGHT_INK
			);
		}

		await page.screenshot(`ps-${String(hour).padStart(2, "0")}00`);

		if (hour === 22) {
			await checkReducedTransparency(page, hhmm(s.minute), NIGHT_GLASS);
		}
	}

	// Dusk: 45 minutes after today's sunset, by the engine's own formula. A
	// time-zone override moves the clock in whole hours and the minute is
	// whatever it is now, so the hour is the one that puts the current minute
	// nearest that moment: 15 to 75 minutes after sunset, whatever the day or
	// the minute. The control checks the page's clock is inside the dusk
	// window before the colour check means anything.
	const today = sunTimes(dayOfYear(new Date()));
	const duskHour = Math.round((today.set + 45 - new Date().getUTCMinutes()) / 60);
	const dusk = await atHour(page, ((duskHour % 24) + 24) % 24);
	const set = sunTimes(dusk.doy).set;
	page.check(
		`the dusk leg is at dusk (${hhmm(dusk.minute)}, sunset ${hhmm(set)}, dusk until ${hhmm(
			set + DUSK
		)})`,
		dusk.minute > set && dusk.minute <= set + DUSK
	);
	page.check(
		`dusk (${hhmm(dusk.minute)}): white words ${dusk.ink} (light ${dusk.light}, text ${
			dusk.text
		})`,
		dusk.text === "light" && dusk.ink === WHITE
	);
	await page.screenshot("ps-dusk");
	const duskSparks = await emberFrame(page, `embers at dusk ${RUN}`, "ps-embers-dusk");
	page.check(
		`dusk: a send's four sparks, held mid-burst for the frame (${duskSparks})`,
		duskSparks === 4
	);

	// ---- a hidden page stops the scene

	await atHour(page, 12);
	// Late in the UTC day the noon zone is already on the next date, whose
	// weather can differ from the dusk leg's: a layer then fades in or out
	// (the buzzard's opacity, 1.4–1.8 s). ps-paused holds animations, not
	// transitions, so a fade still in flight read as running. Wait the fades
	// out first, as the plains' checks below wait out theirs.
	await page.waitFor(
		`!document.getElementById("theme-scene").getAnimations({subtree: true}).some((a) => a instanceof CSSTransition && a.playState === "running")`,
		{timeout: 5000, label: "the scene's fades settled"}
	);
	checkRunning(page, await page.evaluate(SCENE_STATE), "shown");
	await page.evaluate(VISIBILITY("hidden"));
	checkStopped(page, await page.evaluate(SCENE_STATE), "hidden");
	await page.evaluate(VISIBILITY("visible"));
	await page.sleep(300);
	checkRunning(page, await page.evaluate(SCENE_STATE), "shown again");

	// ---- the plains on fixed days (docs/projects/ps-theme.md §5)

	// The clock pinned (CLOCK_SHIM) in UTC, so each moment is a known day of
	// 2026 and its weather the engine's for that day: 25 September clear,
	// 26 September rain, 1 July heat, 19 July storm, 8 January snow.
	await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/GMT"});

	const clear = await at(page, noonOn(9, 25));
	page.check(`25 September at 12:30 is clear (${clear.weather})`, clear.weather === "clear");
	checkMounted(page, clear, "a clear noon");
	// Only the weather that is happening exists in the page (spec §10).
	page.check(
		`a clear noon: no rain drop, snowflake or seed in the page (${clear.drops}, ${clear.flakes}, ${clear.seeds}; the weather layer holds ${clear.weatherLayer})`,
		clear.drops + clear.flakes + clear.seeds === 0 && clear.weatherLayer === 0
	);
	page.check(
		`a clear noon: no heat haze (the ground's filter ${clear.groundFilter}; ${clear.haze} haze, ps-hot ${clear.hot})`,
		clear.groundFilter === "none" && clear.haze === 0 && !clear.hot
	);
	page.check(
		`a clear noon: the five clouds alone, no deck (${clear.clouds} clouds, ${clear.overcast} of the weather's, ${clear.deck} deck)`,
		clear.clouds === 5 && clear.overcast === 0 && clear.deck === 0
	);
	page.check(
		`a clear noon: day glass and white words ${clear.ink} (light ${clear.light}, text ${clear.text})`,
		clear.light === "day" && clear.text === "light" && clear.ink === WHITE
	);
	// Nothing animates unseen (layers.ts): the night's layers are out of the
	// render tree by day, the sun in it.
	page.check(
		`a clear noon: the stars, the skeins, the fireflies and the smoke out of the render tree, the sun in it (out: ${clear.off.join(
			", "
		)})`,
		["ps-stars", "ps-skeins", "ps-fireflies", "ps-smoke"].every((k) => clear.off.includes(k)) &&
			!clear.off.includes("ps-sun")
	);
	checkRunning(page, clear, "a clear noon");
	await page.screenshot("ps-day-sep25-1230");

	const rain = await at(page, noonOn(9, 26));
	page.check(
		`a rainy noon (${rain.weather}): 130 drops and the rain's wind's 26 seeds, no snowflake (${rain.drops}, ${rain.seeds}, ${rain.flakes})`,
		rain.weather === "rain" && rain.drops === 130 && rain.seeds === 26 && rain.flakes === 0
	);
	page.check(
		`a rainy noon: no heat haze (the ground's filter ${rain.groundFilter}, ${rain.haze} haze)`,
		rain.groundFilter === "none" && rain.haze === 0
	);
	// Cloudier, and no bird (the user, 2026-09-26).
	page.check(
		`a rainy noon: nine clouds, four of them the rain's, in front of rain's lighter deck, down to ${rain.deckBottom} % (${rain.clouds}, ${rain.overcast}, ${rain.deck} deck, ${rain.rainDeck} the rain's)`,
		rain.clouds === 9 &&
			rain.overcast === 4 &&
			rain.deck === 1 &&
			rain.rainDeck === 1 &&
			rain.deckBottom > 19 &&
			rain.deckBottom < 25
	);
	checkDeck(page, await page.evaluate(DECK_GEOMETRY), "a rainy noon");
	const rainBirds = await birdsSettled(page);
	page.check(
		`a rainy noon: no bird in the render tree (${JSON.stringify(rainBirds)})`,
		rainBirds.skeins + rainBirds.buzzard + rainBirds.larks === 0
	);
	checkRunning(page, rain, "a rainy noon");
	await page.screenshot("ps-rain-sep26-1230");
	// And on a 16:9 desktop, beside the storm's (below) and the phone's.
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 720,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.sleep(400);
	checkDeck(page, await page.evaluate(DECK_GEOMETRY), "a rainy noon at 1280 × 720");
	await page.screenshot("ps-rain-sep26-1230-1280x720");
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: Number(page.opt("width", 1280)),
		height: Number(page.opt("height", 900)),
		deviceScaleFactor: 1,
		mobile: page.flags.has("--mobile"),
	});
	await page.sleep(400);

	const heat = await at(page, noonOn(7, 1));
	// The haze bends the ground group (land, river, fireflies, yurt, smoke)
	// as one and leaves the near grass crisp (spec §5.5).
	page.check(
		`a hot noon (${heat.weather}): the haze on the ground group and not on the near grass (ground ${heat.groundFilter}, near grass ${heat.bladesFilter}; ${heat.haze} haze, ps-hot ${heat.hot}, the heat band shown ${heat.heatband})`,
		heat.weather === "heat" &&
			heat.hot &&
			heat.groundFilter === 'url("#ps-heat")' &&
			heat.bladesFilter === "none" &&
			heat.haze === 1 &&
			heat.heatband
	);
	page.check(
		`a hot noon: no drop, flake or seed (${heat.drops}, ${heat.flakes}, ${heat.seeds})`,
		heat.drops + heat.flakes + heat.seeds === 0
	);
	checkRunning(page, heat, "a hot noon");
	await page.screenshot("ps-heat-jul01-1230");

	// Review Focus 1: the stormy noon, whose veil made dark words fail before
	// the user's "A"; the words are white over it.
	const storm = await at(page, noonOn(7, 19));
	page.check(
		`a stormy noon (${storm.weather}): 130 drops, the lightning, white words ${storm.ink} (text ${storm.text})`,
		storm.weather === "storm" &&
			storm.drops === 130 &&
			storm.flash === 1 &&
			storm.text === "light" &&
			storm.ink === WHITE
	);
	page.check(
		`a stormy noon: nine clouds and the low deck across the top of the sky, down to ${storm.deckBottom} % (${storm.clouds}, ${storm.overcast} of the rain's, ${storm.deck} deck)`,
		storm.clouds === 9 &&
			storm.overcast === 4 &&
			storm.deck === 1 &&
			storm.deckBottom > 30 &&
			storm.deckBottom < 37
	);
	const stormBirds = await birdsSettled(page);
	page.check(
		`a stormy noon: no bird in the render tree (${JSON.stringify(stormBirds)})`,
		stormBirds.skeins + stormBirds.buzzard + stormBirds.larks === 0
	);
	await page.screenshot("ps-storm-jul19-1230");
	checkDeck(page, await page.evaluate(DECK_GEOMETRY), "a stormy noon");
	// And on a 16:9 desktop, to read beside the portrait phone's (below).
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 720,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await page.sleep(400);
	checkDeck(page, await page.evaluate(DECK_GEOMETRY), "a stormy noon at 1280 × 720");
	await page.screenshot("ps-storm-jul19-1230-1280x720");
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: Number(page.opt("width", 1280)),
		height: Number(page.opt("height", 900)),
		deviceScaleFactor: 1,
		mobile: page.flags.has("--mobile"),
	});
	await page.sleep(400);

	// Dark ink where it holds: a snowy day, the one weather it does.
	const snow = await at(page, noonOn(1, 8));
	page.check(
		`a snowy noon (${snow.weather}): 120 flakes and the snow's 26 seeds, no drop (${snow.flakes}, ${snow.seeds}, ${snow.drops})`,
		snow.weather === "snow" && snow.flakes === 120 && snow.seeds === 26 && snow.drops === 0
	);
	page.check(
		`a snowy noon: the five clouds, no deck (${snow.clouds}, ${snow.deck})`,
		snow.clouds === 5 && snow.deck === 0
	);
	page.check(
		`a snowy noon: dark ink words ${snow.ink} (text ${snow.text}), snow on the roof (--ps-snowcap ${snow.snowcap}), no flowers (${snow.flowers})`,
		snow.text === "ink" &&
			snow.ink === INK &&
			Number(snow.snowcap) > 0.5 &&
			Number(snow.flowers) === 0
	);
	await page.screenshot("ps-winter-snow-jan08-1230");

	// The seasons at noon: spring's flowers, summer's dry river, autumn's running one.
	const spring = await at(page, noonOn(5, 12));
	page.check(
		`spring, 12 May at noon (${spring.weather}): the flowers out (--ps-flowers ${spring.flowers}), the river running (--ps-water ${spring.water})`,
		spring.weather === "clear" && Number(spring.flowers) > 0.5 && Number(spring.water) > 0.5
	);
	await page.screenshot("ps-spring-may12-1230");
	const summer = await at(page, noonOn(8, 4));
	page.check(
		`summer, 4 August at noon (${summer.weather}): the river dry (--ps-water ${summer.water})`,
		summer.weather === "clear" && Number(summer.water) === 0
	);
	await page.screenshot("ps-summer-aug04-1230");
	const autumn = await at(page, noonOn(10, 22));
	page.check(
		`autumn, 22 October at noon (${autumn.weather}): the river running again (--ps-water ${autumn.water}), the flowers nearly over (${autumn.flowers})`,
		autumn.weather === "clear" && Number(autumn.water) > 0.5 && Number(autumn.flowers) < 0.1
	);
	await page.screenshot("ps-autumn-oct22-1230");

	// A clear day through (25 September, sunrise and sunset from the engine's
	// formula): the words stay white at every hour of it.
	const sep25 = sunTimes(268);
	const sep25At = (minute) => Date.UTC(2026, 8, 25, 0, Math.round(minute));
	/** Each hour's scene, for the same minutes under reduced motion (below). */
	const sep25States = {};

	for (const [name, minute] of [
		["dawn", sep25.rise - 30],
		["golden-hour", sep25.set - 60],
		["dusk", sep25.set + 45],
		["midnight", 0],
	]) {
		const s = await at(page, sep25At(minute));
		sep25States[name] = s;
		page.check(
			`25 September, ${name} (${hhmm(s.minute)}, ${s.weather}): white words ${s.ink} (light ${
				s.light
			}, text ${s.text})`,
			s.doy === 268 && s.weather === "clear" && s.text === "light" && s.ink === WHITE
		);

		if (name === "midnight") {
			page.check(
				`25 September at midnight: the sun out of the render tree, the stars in it (out: ${s.off.join(
					", "
				)})`,
				s.off.includes("ps-sun") && !s.off.includes("ps-stars") && s.light === "night"
			);
			checkRunning(page, s, "25 September at midnight");
		}

		await page.screenshot(`ps-day-sep25-${name}`);
	}

	// No bird flies in rain or a storm (the user, 2026-09-26). At dusk in
	// the autumn passage, when a clear evening flies the skeins (the
	// control: 25 September, above), a rainy one (26 September) and a stormy
	// one (17 September) fly none: the skeins' layer, every flock and bird,
	// the buzzard and the larks out of the render tree.
	page.check(
		`25 September at dusk, the control: the skeins fly (${JSON.stringify(
			sep25States.dusk.birds
		)})`,
		sep25States.dusk.birds.skeins > 0
	);

	for (const [name, doy, day, want] of [
		["a rainy dusk, 26 September", 269, 26, "rain"],
		["a stormy dusk, 17 September", 260, 17, "storm"],
	]) {
		const s = await at(page, Date.UTC(2026, 8, day, 0, Math.round(sunTimes(doy).set + 45)));
		const birds = await birdsSettled(page);
		page.check(
			`${name} (${hhmm(s.minute)}, ${
				s.weather
			}): no bird in the render tree (${JSON.stringify(birds)}); ${s.clouds} clouds, ${
				s.deck
			} deck`,
			s.doy === doy &&
				s.weather === want &&
				birds.skeins + birds.buzzard + birds.larks === 0 &&
				s.clouds === 9 &&
				s.deck === 1 &&
				s.rainDeck === (want === "rain" ? 1 : 0)
		);
		await page.screenshot(`ps-${want}-dusk-sep${day}`);
	}

	// ---- the glyph samples (plan 4, spec §11)

	// Rendered words against the pixels around them, over the real scene, at
	// noon, golden hour, sunset, dusk, midnight and first light (an hour
	// before sunrise, the skeins' "first light"), on a clear summer day and
	// a snowy winter one: dusk is where a palette that is fine at both ends
	// goes wrong. Every message row's words, time and nick in the column is
	// measured (GLYPH_TARGETS, glyphMeasure), and each kind holds its floor
	// at its worst element's 10th percentile — the rank calibrate.mjs's α is
	// defined on; the minimum over the ring is printed, not held, since
	// the scene's own marks (a star, a flake, a blade's edge) sit in rings
	// too. The neighbour says one line of calibrate's real phrases first.
	peer.say(`tea's ready, it's ok — yes, the wind's dropped. good night, plains ${RUN}`);
	await page.waitFor(
		`[...document.querySelectorAll('${PEER_LINES}')].some((c) => c.textContent.includes("good night, plains ${RUN}"))`,
		{label: "the neighbour's phrase"}
	);

	for (const [season, month, day, doy, want] of [
		["summer, 4 August", 8, 4, 216, "clear"],
		["snowy winter, 8 January", 1, 8, 8, "snow"],
	]) {
		const sun = sunTimes(doy);

		for (const [moment, minute] of [
			["noon", 750],
			["golden hour", sun.set - 60],
			["sunset", sun.set],
			["dusk", sun.set + 45],
			["midnight", 0],
			["first light", sun.rise - 60],
		]) {
			const slug = `${month === 8 ? "summer" : "winter"}-${moment.replace(" ", "-")}`;
			const {s, frozen, easing, sample, m} = await glyphSample(
				page,
				Date.UTC(2026, month - 1, day, 0, Math.round(minute)),
				slug
			);
			const where = `glyphs, ${season}, ${moment} (${hhmm(s.minute)}, ${s.weather}, ${
				s.text
			} words, ${s.light} glass)`;
			const measured = (m.results ?? []).filter((r) => !r.skipped);
			const kinds = {words: [], time: [], nick: [], faint: []};

			for (const r of measured) {
				kinds[r.kind].push(r);
			}

			const worst = (list) => list.reduce((w, r) => (!w || r.p10 < w.p10 ? r : w), null);
			const large = ["large", "xlarge", "huge"].includes(sample.step);
			const floors = {
				words: 4.5,
				time: 4.5,
				nick: sample.text === "light" && large ? 3 : 4.5,
				faint: 3,
			};
			page.check(
				`${where}: the sample stands — the day's weather, the scene stopped (${
					frozen.running
				} running, ${
					frozen.svgs.filter((v) => !v.paused).length
				} SVG clocks going, ${easing} easing), the frames ${m.W}×${m.H} and ${m.BW}×${
					m.BH
				} for a ${sample.clip.width}×${sample.clip.height} clip at DPR ${
					sample.dpr
				}, the frame still (shot twice, ${
					m.moved
				} px apart by more than ${GLYPH_CORE_DIFF} levels${
					m.moved ? ` at ${JSON.stringify(m.movedAt)}` : ""
				}; ${
					m.rounding
				} by the raster's rounding), the twin elsewhere within the raster's rounding (${
					m.off
				} px more than 2 px from a glyph, by up to ${m.offMax}), ${Object.entries(kinds)
					.map(([k, v]) => `${v.length} ${k}`)
					.join(", ")} measured (${sample.cut} outside the band or cut by its edges)`,
				s.doy === doy &&
					s.weather === want &&
					frozen.paused &&
					frozen.running === 0 &&
					frozen.svgs.every((v) => v.paused) &&
					easing === 0 &&
					m.W === sample.clip.width * sample.dpr &&
					m.H === sample.clip.height * sample.dpr &&
					m.BW === m.W &&
					m.BH === m.H &&
					m.moved === 0 &&
					m.offMax <= GLYPH_CORE_DIFF &&
					Object.values(kinds).every((v) => v.length >= GLYPH_MIN_ELEMENTS)
			);
			const figure = (k) => {
				const w = worst(kinds[k]);
				return w
					? `${k} ${w.p10.toFixed(2)} (floor ${floors[k]}; min ${w.min.toFixed(
							2
					  )}, median ${w.median.toFixed(2)}, "${w.label}")`
					: `${k} none`;
			};
			page.check(
				`${where}: every glyph holds its floor at the 10th percentile of its ring, worst element each — ${[
					"words",
					"time",
					"nick",
					"faint",
				]
					.map(figure)
					.join("; ")} (faint: ${sample.faintProbe} composited over the words' ring)`,
				Object.entries(kinds).every(
					([k, v]) => v.length > 0 && v.every((r) => r.p10 >= floors[k])
				)
			);
			console.log(
				`glyphs ${JSON.stringify({
					season,
					moment,
					at: hhmm(s.minute),
					weather: s.weather,
					text: s.text,
					light: s.light,
					step: sample.step,
					dpr: sample.dpr,
					kinds: Object.fromEntries(
						Object.entries(kinds).map(([k, v]) => {
							const w = worst(v);
							const all = v.map((r) => r.min);
							return [
								k,
								{
									n: v.length,
									worstP10: w && +w.p10.toFixed(3),
									worstLabel: w && w.label,
									worstMedian: w && +w.median.toFixed(3),
									minOverAll: all.length ? +Math.min(...all).toFixed(3) : null,
								},
							];
						})
					),
				})}`
			);
		}
	}

	// ---- reduced motion on fixed days (spec §9)

	// Nothing moves, in any weather, and the hour still shows. What exists
	// only in flight (the birds, the rain, snow and seeds, the lightning, the
	// smoke) is out of the render tree, not parked mid-flight (the buzzard
	// stood on the noon sky, a drop just above the top); the veil, the
	// fireflies, the near grass and the heat band stay, still; and the
	// colours are the hour's, the same as without reduced motion at the same
	// minute. In #seance: a query stops the scene by itself.
	await page.send("Emulation.setEmulatedMedia", {
		features: [{name: "prefers-reduced-motion", value: "reduce"}],
	});

	for (const {name, ms, motion} of [
		{name: "a clear noon", ms: noonOn(9, 25), motion: clear},
		{name: "a rainy noon", ms: noonOn(9, 26), motion: rain},
		{name: "a hot noon", ms: noonOn(7, 1), motion: heat},
		{name: "a snowy noon", ms: noonOn(1, 8), motion: snow},
		{name: "a stormy noon", ms: noonOn(7, 19), motion: storm},
		{name: "dusk on 25 September", ms: sep25At(sep25.set + 45), motion: sep25States.dusk},
	]) {
		const where = `${name}, reduced motion`;
		const s = await at(page, ms);
		const r = await page.evaluate(REDUCED_STATE);
		checkStopped(page, s, where);
		const flying = Object.entries(r.flight).filter(([, n]) => n > 0);
		page.check(
			`${where}: nothing in flight is rendered (${
				flying.map(([k, n]) => `${k} ${n}`).join(", ") || "none"
			}) and nothing on the scene runs (document.getAnimations(): ${
				r.running.join(", ") || "none"
			})`,
			flying.length === 0 && r.running.length === 0
		);
		const wet = ["rain", "storm", "snow"].includes(s.weather);
		page.check(
			`${where}: what stays stands still (the veil at ${r.veil}, the scene's --ps-veil ${r.veilVar}; the near grass ${r.blades}; ${r.fireflies} fireflies at ${r.fireflyTransform}; the heat band ${r.heatband})`,
			r.veil !== null &&
				Math.abs(Number(r.veil) - Number(r.veilVar)) < 0.001 &&
				Number(r.veil) > 0 === wet &&
				r.blades === "none" &&
				(r.fireflies === 0 || r.fireflyTransform === "none") &&
				(name.startsWith("dusk") ? r.fireflies > 0 : true) &&
				r.heatband === (s.weather === "heat" ? 1 : 0)
		);
		if (s.weather === "rain" || s.weather === "storm") {
			// The rain's four rest by the five's rule (--cp), nine places on the
			// sky; the deck (the storm's, or rain's lighter one) never moved, so
			// it stands as it was.
			const rests = await page.evaluate(CLOUD_RESTS);
			const lefts = rests.map((c) => c.left).sort((a, b) => a - b);
			page.check(
				`${where}: the nine clouds rest in nine places on the sky (${rests
					.map((c) => c.left.toFixed(0))
					.join(", ")} of ${rests[0]?.width})${`, and the deck stands (${s.deck})`}`,
				rests.length === 9 &&
					rests.every((c) => c.animation === "none" && c.right > 0 && c.left < c.width) &&
					lefts.every((x, i) => i === 0 || x - lefts[i - 1] > 20) &&
					s.deck === 1
			);
		}

		page.check(
			`${where}: the colours are the hour's (${s.weather}, light ${s.light}, canvas ${s.canvas} = sky-top ${s.skyTop}; without reduced motion: ${motion.weather}, ${motion.light}, ${motion.canvas})`,
			s.canvas === s.skyTop &&
				s.canvas === motion.canvas &&
				s.light === motion.light &&
				s.weather === motion.weather
		);
		await page.screenshot(
			`ps-reduced-${name.replace(/^an? /, "").replace(/ on /, "-").replace(/\s+/g, "-")}`
		);
	}

	await page.send("Emulation.setEmulatedMedia", {features: []});
	await page.sleep(300);

	// ---- the yurt never slides (Review Focus 2)

	// At night, so its smoke is up and goes with it. One toggle first, the
	// control: the column changes width and the yurt fades out and back in
	// at its new place. Then the brief's case: the user list toggled twice,
	// 100 ms apart, inside one 0.4 s fade.
	await at(page, Date.UTC(2026, 8, 25, 22, 0));
	const one = await checkYurtMove(page, "the user list toggled once", () =>
		toggleUserlist(page, 1)
	);
	page.check(
		`the user list toggled once: the column changed (${JSON.stringify(
			one.before.column
		)} → ${JSON.stringify(one.after.column)}) and the yurt faded (lowest opacity ${one.minOp})`,
		one.before.column?.width !== one.after.column?.width && one.minOp < 0.05
	);
	await checkYurtMove(page, "the user list toggled back", () => toggleUserlist(page, 1));
	const twice = await checkYurtMove(page, "the user list toggled twice inside the fade", () =>
		toggleUserlist(page, 2)
	);
	// The first toggle started a fade (the second came inside it and only
	// retargeted it), and only the place it stood at was ever written.
	const lefts = [...new Set(twice.trace.map((p) => p.left))];
	page.check(
		`the user list toggled twice: the yurt faded and ends where it stood (lowest opacity ${
			twice.minOp
		}; ${twice.before.cx.toFixed(1)} → ${twice.after.cx.toFixed(
			1
		)}; places written ${JSON.stringify(lefts)})`,
		twice.minOp < 0.05 && Math.abs(twice.before.cx - twice.after.cx) <= 1 && lefts.length === 1
	);

	// ---- the wind rises at midnight and the clouds stay where they are

	// A clear 4 October into a windy 5th, by the scene's own minute timer.
	// The wind shortens the clouds' drift (ps.css ps-windy); the same time
	// under a shorter loop is another place, and the clouds jumped hundreds of
	// pixels (measured 126 to 1006 px before scene.ts kept their place).
	// Sampled every 100 ms across the flip: they move only as they drift.
	const CLOUD_X = `JSON.stringify({windy: document.getElementById("theme-scene").classList.contains("ps-windy"), x: [...document.querySelectorAll("#theme-scene .ps-cloud-field > .ps-cloud")].map((e) => e.getBoundingClientRect().left)})`;
	await at(page, Date.UTC(2026, 9, 4, 23, 59, 52));
	let lastClouds = JSON.parse(await page.evaluate(CLOUD_X));
	let windMoved = null;

	for (const until = Date.now() + 15000; Date.now() < until && !windMoved; ) {
		await page.sleep(100);
		const now = JSON.parse(await page.evaluate(CLOUD_X));

		if (now.windy !== lastClouds.windy) {
			windMoved = now.x.map((x, i) => Math.abs(x - lastClouds.x[i]));
		}

		lastClouds = now;
	}

	page.check(
		`the wind rising at midnight leaves every cloud where it was (moved ${
			windMoved ? windMoved.map((v) => v.toFixed(0)).join(", ") : "—"
		} px across the flip)`,
		!!windMoved && windMoved.length === 5 && windMoved.every((v) => v < 20)
	);

	// ---- across local midnight with the page open (Review Focus 3)

	// A clear 25 September into a rainy 26th, by the scene's own minute
	// timer: the rain's four fade in over 2 s rather than popping in (plan
	// 4's final fix, item 5; the user dislikes clouds popping).
	const clearEve = await at(page, Date.UTC(2026, 8, 25, 23, 59, 52));
	page.check(
		`25 September at ${hhmm(clearEve.minute)}: clear, no set in the overcast (${JSON.stringify(
			clearEve.sets
		)})`,
		clearEve.weather === "clear" && clearEve.sets.length === 0
	);
	await settle(page, `document.getElementById("theme-scene").dataset.weather === "rain"`, 15000);
	await page.sleep(500); // into the fade: it starts at 0 on the frame after the flip
	const fadingIn = await page.evaluate(SCENE_STATE);
	page.check(
		`past local midnight into a rainy 26th: the rain's four fade in, not pop (${JSON.stringify(
			fadingIn.sets
		)})`,
		fadingIn.sets.length === 1 &&
			fadingIn.sets[0].cls === "ps-overcast-set" &&
			fadingIn.sets[0].clouds === 4 &&
			fadingIn.sets[0].op > 0 &&
			fadingIn.sets[0].op < 0.95
	);
	await page.screenshot("ps-midnight-sep26-fade-in");
	await page.sleep(1800);
	const inRain = await page.evaluate(SCENE_STATE);
	page.check(
		`and 2 s on, the four are in whole (${JSON.stringify(inRain.sets)}; ${
			inRain.clouds
		} clouds)`,
		inRain.sets.length === 1 && inRain.sets[0].op === 1 && inRain.clouds === 9
	);

	// A rainy 26 September into a clear 27th, by the scene's own minute timer:
	// no visibility poke once the clock is set. The tick is due at 00:00:00.02.
	const eve = await at(page, Date.UTC(2026, 8, 26, 23, 59, 45));
	page.check(
		`26 September at ${hhmm(eve.minute)}: rain, ${eve.drops} drops, ${eve.clouds} clouds (${
			eve.overcast
		} of the rain's)`,
		eve.weather === "rain" && eve.drops === 130 && eve.clouds === 9 && eve.overcast === 4
	);
	await settle(page, `document.getElementById("theme-scene").dataset.weather !== "rain"`, 25000);
	// The rain's four fade out over 2 s (plan 4's final fix, item 5), still
	// in the page, and then leave it.
	await page.sleep(500);
	const fadingOut = await page.evaluate(SCENE_STATE);
	page.check(
		`past local midnight into a clear 27th: the rain's four fade out, not pop (${JSON.stringify(
			fadingOut.sets
		)})`,
		fadingOut.sets.length === 1 &&
			fadingOut.sets[0].cls === "ps-overcast-set ps-leaving" &&
			fadingOut.sets[0].clouds === 4 &&
			fadingOut.sets[0].op > 0.05 &&
			fadingOut.sets[0].op < 1
	);
	await page.screenshot("ps-midnight-sep27-fade-out");
	await page.sleep(1800);
	const morning = await page.evaluate(SCENE_STATE);
	page.check(
		`after local midnight (${morning.date}): 27 September is clear and the rain is gone (${morning.weather}, ${morning.drops} drops, ${morning.seeds} seeds, the weather layer holds ${morning.weatherLayer}; ${morning.clouds} clouds, ${morning.overcast} of the rain's, ${morning.sets.length} sets left)`,
		morning.doy === 270 &&
			morning.weather === "clear" &&
			morning.drops + morning.flakes + morning.seeds === 0 &&
			morning.weatherLayer === 0 &&
			morning.clouds === 5 &&
			morning.overcast === 0 &&
			morning.sets.length === 0
	);
	await page.screenshot("ps-midnight-sep27-0000");
	await realClock(page);

	// ---- the view follows the conversation; a query is frosted and still (spec §5.7)

	// Its own query: EXT_NAME's is in the sidebar too. A clear noon, pinned,
	// in #seance first: what a channel shows and publishes at that minute.
	const QUERY_ROW = `.channel-list-item[data-type="query"][data-name="${NICK}x"]`;
	await sendLine(page, `/query ${NICK}x`);
	await page.waitFor(`document.querySelector('${QUERY_ROW}')`, {
		label: "the query in the sidebar",
	});
	await openSeance(page, "#seance, before the query");
	const noonChannel = await at(page, noonOn(9, 25));
	const noonChannelFrost = await page.evaluate(FROST_STATE);
	checkUnfrosted(page, noonChannel, noonChannelFrost, "#seance at a clear noon");
	await page.screenshot("ps-channel-noon");

	await page.click(QUERY_ROW);
	await page.sleep(FROST_SETTLE_MS);
	const inQuery = await page.evaluate(SCENE_STATE);
	page.check(`a query: the scene's view is query (${inQuery.view})`, inQuery.view === "query");
	checkFrosted(page, inQuery, await page.evaluate(FROST_STATE), "a query at a clear noon");
	page.check(
		`a query at a clear noon publishes what #seance did (canvas ${inQuery.canvas}, light ${inQuery.light}, text ${inQuery.text}, theme-color ${inQuery.meta}, halo ${noonChannelFrost.halo})`,
		inQuery.minute === noonChannel.minute &&
			inQuery.canvas === noonChannel.canvas &&
			inQuery.light === noonChannel.light &&
			inQuery.text === noonChannel.text &&
			inQuery.meta === noonChannel.meta &&
			(await page.evaluate(FROST_STATE)).halo === noonChannelFrost.halo
	);
	await page.screenshot("ps-private-noon");

	// The colours still follow the hour: an hour on inside the query (the
	// page hidden and shown again, which leaves it still).
	await at(page, noonOn(9, 25) + 3600000);
	await page.sleep(FADE_SETTLE_MS);
	const hourOn = await page.evaluate(SCENE_STATE);
	page.check(
		`a query an hour on: the canvas followed the hour (${inQuery.canvas} → ${
			hourOn.canvas
		}, ${hhmm(hourOn.minute)})`,
		hourOn.view === "query" &&
			hourOn.minute === inQuery.minute + 60 &&
			hourOn.canvas !== inQuery.canvas
	);
	checkFrosted(page, hourOn, await page.evaluate(FROST_STATE), "a query an hour on, shown again");

	await at(page, sep25At(sep25.set - 60));
	await page.sleep(FADE_SETTLE_MS);
	const goldenQuery = await page.evaluate(SCENE_STATE);
	checkFrosted(page, goldenQuery, await page.evaluate(FROST_STATE), "a query at golden hour");
	await page.screenshot("ps-private-golden-hour");

	await openSeance(page, "back in #seance from the query");
	await page.sleep(FROST_SETTLE_MS);
	const inChannel = await page.evaluate(SCENE_STATE);
	page.check(
		`a channel: the scene's view is channel (${inChannel.view})`,
		inChannel.view === "channel"
	);
	checkUnfrosted(page, inChannel, await page.evaluate(FROST_STATE), "#seance at golden hour");
	await page.screenshot("ps-channel-golden-hour");
	await realClock(page);

	// ---- theme switches

	await openAppearance(page);
	const inSettings = await page.evaluate(SCENE_STATE);
	page.check(
		`no conversation (Settings): the scene's view is other (${inSettings.view})`,
		inSettings.view === "other"
	);

	// The font-size sample under the slider shows chat lines in the theme's
	// own faces: the names in Newsreader, the times and lines in Source Sans 3
	// (the user's report, 2026-09-26: it "does not use the theme fonts
	// properly" — its names drew in the words' face).
	await page.send("DOM.enable");
	await page.send("DOM.getDocument", {depth: 0});
	await page.send("CSS.enable");
	await checkDrawnIn(
		page,
		"the font-size sample's name in Newsreader",
		`document.querySelector(".font-size-sample .line .from")`,
		"Newsreader",
		false
	);
	await checkDrawnIn(
		page,
		"the font-size sample's line in Source Sans 3",
		`document.querySelector(".font-size-sample .line .text")`,
		"Source Sans 3",
		false
	);
	await checkDrawnIn(
		page,
		"the font-size sample's time in Source Sans 3",
		`document.querySelector(".font-size-sample .line .time")`,
		"Source Sans 3",
		false
	);
	await page.send("CSS.disable");
	await page.send("DOM.disable");
	await page.evaluate(
		`document.querySelector(".font-size-sample").scrollIntoView({block: "center"})`
	);
	await page.sleep(200);
	await page.screenshot("ps-settings-font-size-sample");

	// The native select by the hour (the user's report, 2026-09-26: at night
	// its list drew light text on a light ground). Its fill and every
	// option's are the solid, opaque, in the ink, at night and by day.
	for (const hour of [22, 12]) {
		const at = hhmm((await atHour(page, hour)).minute);
		const c = await page.evaluate(SELECT_COLOURS);
		const solid = hexRgb(c.solid);
		const ink = hexRgb(c.ink);
		const worst = Math.min(
			contrastRgb(c.select.color, c.select.bg),
			...c.options.map((o) => contrastRgb(o.color, o.bg))
		);
		page.check(
			`${at}, Settings: the theme select and its ${c.options.length} options are the ${
				c.light
			} solid ${solid} in its ink ${ink}, opaque (select ${c.select.bg} / ${
				c.select.color
			}, scheme ${c.scheme}; worst contrast ${worst.toFixed(2)})`,
			c.light === (hour === 22 ? "night" : "day") &&
				c.options.length > 1 &&
				[c.select, ...c.options].every((o) => o.bg === solid && o.color === ink) &&
				worst >= 4.5
		);

		if (hour === 22) {
			await page.evaluate(
				`document.querySelector("#theme-select").scrollIntoView({block: "center"})`
			);
			await page.sleep(200);
			await page.screenshot("ps-settings-select-night");
		}
	}

	await chooseTheme(page, "coffee");
	const coffee = await page.evaluate(SCENE_STATE);
	page.check(
		`coffee: no scene (display ${coffee.display}, ${coffee.children} children)`,
		coffee.display === "none" && coffee.children === 0
	);
	const leftovers = await page.evaluate(
		`document.querySelectorAll(".ps-land, .ps-blades, .ps-yurt, .ps-fireflies, .ps-weather, .ps-skeins").length`
	);
	page.check(
		`coffee: the plains are gone with it (land ${coffee.land}, near grass ${
			coffee.blades
		}, yurt ${coffee.yurt}, ${coffee.fireflies} fireflies, ${coffee.svgs.length} SVGs, ${
			coffee.drops + coffee.flakes + coffee.seeds
		} particles; ${leftovers} of their elements anywhere in the page)`,
		!coffee.land &&
			!coffee.blades &&
			!coffee.yurt &&
			coffee.fireflies === 0 &&
			coffee.svgs.length === 0 &&
			coffee.drops + coffee.flakes + coffee.seeds === 0 &&
			leftovers === 0
	);
	page.check(
		`coffee: nothing left on <html> (light ${coffee.light}, text ${coffee.text}, canvas "${coffee.canvas}")`,
		coffee.light === undefined && coffee.text === undefined && coffee.canvas === ""
	);
	// coffee's own themeColor (client/js/configuration.ts), not the sky's.
	page.check(
		`coffee: theme-color is coffee's own #1a1816 (${coffee.meta})`,
		coffee.meta.toLowerCase() === "#1a1816"
	);

	// A scene mounted into a hidden page starts stopped; showing the page
	// starts it.
	await page.evaluate(VISIBILITY("hidden"));
	await chooseTheme(page, "ps");
	const back = await page.evaluate(SCENE_STATE);
	checkMounted(page, back, "ps again, applied while hidden");
	checkStopped(page, back, "ps again, applied while hidden");
	await page.evaluate(VISIBILITY("visible"));
	await page.sleep(300);
	const shown = await page.evaluate(SCENE_STATE);
	checkRunning(page, shown, "ps again, shown");
	// Only a visible scene ticks, so only now is theme-color the sky again.
	page.check(
		`ps again, shown: theme-color follows the sky again (${shown.meta} = ${shown.canvas})`,
		shown.canvas !== "" && shown.meta === shown.canvas
	);
	await closeSettings(page);
	await openSeance(page, "back in #seance after the switches");

	// ---- a reply quote stays in its column (plan 4 task 5, fix round 1)

	// A long line from the neighbour, replied to through the toolbar. The
	// quote under the reply is a `max-width: 100%` button with its own padding
	// and rule, clamped with an ellipsis: in columns its box stays inside the
	// text column's content box, and on the phone (below) inside the row's.
	// With the text column content-box (Task 5's first squeeze fix) the quote
	// inherited it and overflowed by its padding and rule.
	peer.say(
		`a long line to reply to: ${"the wind over the plains, the smoke from the yurt, ".repeat(
			4
		)}${RUN}`
	);
	const LONG_ROW = `[...document.querySelectorAll("#chat .msg")].find((m) => m.querySelector(".content")?.textContent.includes(${JSON.stringify(
		`from the yurt, ${RUN}`
	)}))`;
	await page.waitFor(`${LONG_ROW} !== undefined`, {label: "the neighbour's long line"});
	const longId = await page.evaluate(`${LONG_ROW}.id`);
	await page.hover(`#${longId} .content`);
	await page.sleep(150);
	await page.click(`#${longId} .msg-action-reply`);
	await page.waitFor(`document.querySelector("#form .compose-bar")`, {label: "the reply bar"});
	// The reply bar is the strip's own row: no second line comes with it.
	await checkComposer(page, "the reply bar open");
	await sendLine(page, `a reply ${RUN}`);
	await page.waitFor(`${QUOTE_BOX(RUN)} !== null`, {timeout: 20000, label: "the echoed reply"});
	await page.sleep(300);
	const quoteCols = await page.evaluate(QUOTE_BOX(RUN));
	page.check(
		`a long reply quote stays in the message's text, under the nick (quote ${quoteCols.quote.map(
			(v) => v.toFixed(1)
		)}, the column's content box ${quoteCols.content.map((v) => v.toFixed(1))}; ${
			quoteCols.sizing
		}, clamped ${quoteCols.clamped}, the column ${quoteCols.display})`,
		// Stacked rows (spec §8): the text is a block under the nick at every
		// width. The quote is cut at 80 characters (quoteLayout), so on a wide
		// pane it may not need its ellipsis; clamped or not, it stays inside.
		quoteCols.display === "block" &&
			quoteCols.sizing === "border-box" &&
			insideOf(quoteCols.quote, quoteCols.content)
	);

	// ---- stacked rows (spec §8, the user's B and the time first): the time,
	// then the nick, and the text under the nick; the second of two lines
	// from one sender shows no nick, its time only when pointed at; a row
	// with an icon has its time, then the icon.
	peer.say(`one of two ${RUN}`);
	peer.say(`two of two ${RUN}`);
	const ROW_OF = (text) =>
		`[...document.querySelectorAll("#chat .msg")].find((m) => m.querySelector(".content")?.textContent.includes(${JSON.stringify(
			text
		)}))`;
	await page.waitFor(`${ROW_OF(`two of two ${RUN}`)} !== undefined`, {
		label: "the neighbour's two lines",
	});
	await page.sleep(300);
	const stacked = await page.evaluate(`(() => {
		const box = (e) => { const r = e.getBoundingClientRect(); return {l: r.left, r: r.right, t: r.top, b: r.bottom}; };
		const first = ${ROW_OF(`one of two ${RUN}`)}, second = ${ROW_OF(`two of two ${RUN}`)};
		const f = first.querySelector(".from"), t = first.querySelector(".time"), c = first.querySelector(".content");
		const range = document.createRange();
		range.selectNodeContents(c);
		const text = range.getClientRects()[0];
		const icon = [...document.querySelectorAll('#chat .msg:not([data-type="message"], [data-type="notice"], [data-type="condensed"])')]
			.find((m) => getComputedStyle(m.querySelector(".from"), "::before").content !== "none" && m.querySelector(".time")?.textContent.trim());
		const iconRow = icon && {type: icon.dataset.type, from: box(icon.querySelector(".from")), time: box(icon.querySelector(".time"))};
		return {
			from: box(f), time: box(t), text: {l: text.left, t: text.top},
			whole: f.scrollWidth <= f.clientWidth + 1,
			continuation: second.classList.contains("previous-source"),
			hidden: [getComputedStyle(second.querySelector(".from")).display, getComputedStyle(second.querySelector(".time")).visibility],
			secondTime: box(second.querySelector(".time")),
			afterMarker: (() => {
				const marker = document.createElement("div");
				marker.className = "unread-marker";
				second.before(marker);
				const shown = [getComputedStyle(second.querySelector(".from")).display, getComputedStyle(second.querySelector(".time")).visibility];
				marker.remove();
				return shown;
			})(),
			secondText: (() => { const r = document.createRange(); r.selectNodeContents(second.querySelector(".content")); return r.getClientRects()[0].left; })(),
			iconRow,
			rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
		};
	})()`);
	page.check(
		`stacked: the time, then the nick on the same line (time ${stacked.time.l.toFixed(
			0
		)}–${stacked.time.r.toFixed(0)}, nick from ${stacked.from.l.toFixed(
			0
		)}; tops ${stacked.time.t.toFixed(0)}, ${stacked.from.t.toFixed(0)})`,
		stacked.time.r <= stacked.from.l &&
			stacked.time.t < stacked.from.b &&
			stacked.time.b > stacked.from.t
	);
	page.check(
		`stacked: the text on the next line, under the nick (text at ${stacked.text.l.toFixed(
			0
		)},${stacked.text.t.toFixed(0)}; the nick from ${stacked.from.l.toFixed(
			0
		)}, its bottom ${stacked.from.b.toFixed(0)}; the time from ${stacked.time.l.toFixed(0)})`,
		stacked.text.t >= stacked.from.b - 2 &&
			Math.abs(stacked.text.l - stacked.from.l) < 1.5 &&
			stacked.text.l - stacked.time.l >= 3 * stacked.rem
	);
	page.check(`stacked: the nick is drawn whole, never cut`, stacked.whole);
	page.check(
		`stacked: the second of two lines shows no nick, its time kept but not drawn (previous-source ${
			stacked.continuation
		}; ${stacked.hidden.join(", ")}), its text under the first's (${stacked.secondText.toFixed(
			0
		)})`,
		stacked.continuation &&
			stacked.hidden[0] === "none" &&
			stacked.hidden[1] === "hidden" &&
			Math.abs(stacked.secondTime.l - stacked.time.l) < 1.5 &&
			Math.abs(stacked.secondText - stacked.text.l) < 2
	);
	// Pointing at the second line shows its time, in the time column beside it.
	const secondId = await page.evaluate(`${ROW_OF(`two of two ${RUN}`)}.id`);
	await page.hover(`#${secondId} .content`);
	await page.sleep(150);
	const chip = await page.evaluate(`(() => {
		const m = document.getElementById(${JSON.stringify(secondId)}), t = m.querySelector(".time");
		const tr = t.getBoundingClientRect(), mr = m.getBoundingClientRect(), cs = getComputedStyle(t);
		const r = document.createRange(); r.selectNodeContents(m.querySelector(".content")); const text = r.getClientRects()[0];
		return {visibility: cs.visibility, text: t.textContent.trim(), left: tr.left, sameLine: tr.top < text.bottom && tr.bottom > text.top, beforeText: tr.right <= text.left};
	})()`);
	page.check(
		`stacked: pointing at the second line shows its time in the column beside it (${
			chip.visibility
		}, "${chip.text}" at ${chip.left.toFixed(0)}, the same line ${
			chip.sameLine
		}, before the text ${chip.beforeText})`,
		chip.visibility === "visible" &&
			chip.text !== "" &&
			Math.abs(chip.left - stacked.time.l) < 1.5 &&
			chip.sameLine &&
			chip.beforeText
	);
	await page.hover(`#${await page.evaluate(`${ROW_OF(`one of two ${RUN}`)}.id`)} .content`);
	await page.sleep(100);
	page.check(
		"stacked: and hides it when the pointer leaves",
		(await page.evaluate(
			`getComputedStyle(document.getElementById(${JSON.stringify(
				secondId
			)}).querySelector(".time")).visibility`
		)) === "hidden"
	);
	page.check(
		`stacked: after the unread line the second shows its nick and time again (${stacked.afterMarker.join(
			", "
		)})`,
		stacked.afterMarker[0] === "block" && stacked.afterMarker[1] === "visible"
	);
	page.check(
		`stacked: a ${
			stacked.iconRow?.type
		} row puts its time before its icon, in the same column as the messages' (time ${stacked.iconRow?.time.l.toFixed(
			0
		)}–${stacked.iconRow?.time.r.toFixed(0)}, icon from ${stacked.iconRow?.from.l.toFixed(0)})`,
		!!stacked.iconRow &&
			stacked.iconRow.time.r <= stacked.iconRow.from.l &&
			Math.abs(stacked.iconRow.time.l - stacked.time.l) < 1.5
	);

	// ---- a phone, at noon: the scene behind the conversation alone

	const viewportHas = (cls) =>
		page.evaluate(
			`document.getElementById("viewport").classList.contains(${JSON.stringify(cls)})`
		);
	await page.send("Emulation.setDeviceMetricsOverride", {
		width: 390,
		height: 844,
		deviceScaleFactor: 1,
		mobile: true,
	});
	await page.sleep(500);

	// The sidebar and the user list are overlays at this width; put both
	// away (the overlay's own click handler, and the header's toggle).
	if (await viewportHas("menu-open")) {
		await page.evaluate(`document.getElementById("sidebar-overlay").click()`);
	}

	const userlistWasOpen = await viewportHas("userlist-open");

	if (userlistWasOpen) {
		await page.evaluate(`document.querySelector("#chat .header button.rt").click()`);
	}

	await page.sleep(800);

	// ---- a phone: half the particles, the yurt in the column (Review Focus 5)

	// The fireflies are built when the scene mounts and the weather when a day
	// begins, each for the layout of the moment, so the scene is mounted
	// afresh here (coffee and back, from Settings: the drawer that holds its
	// button is shut, so the button is clicked in the page) on a rainy noon.
	await page.send("Emulation.setTimezoneOverride", {timezoneId: "Etc/GMT"});
	await page.evaluate(`window.__setClock(${noonOn(9, 26)})`);
	await page.evaluate(`document.querySelector("#footer button.settings").click()`);
	await page.waitFor(`document.querySelector(".settings-menu button.appearance")`, {
		label: "settings open on the phone",
	});
	await page.evaluate(`document.querySelector(".settings-menu button.appearance").click()`);
	await page.waitFor(`document.querySelector("#theme-select")`, {
		label: "the theme select on the phone",
	});
	await chooseTheme(page, "coffee");
	await chooseTheme(page, "ps");
	await closeSettings(page);
	await page.evaluate(
		`document.querySelector('.channel-list-item[data-name="#seance"]').click()`
	);
	await page.waitFor(
		`document.querySelector("#chat .chat") && document.querySelector('#chat .chat-view[data-type="channel"]')`,
		{label: "back in #seance on the phone"}
	);
	await page.sleep(1500); // the first place, and the column's rise into place
	const phone = await page.evaluate(SCENE_STATE);
	checkMounted(page, phone, "a phone, mounted there", FIREFLIES / 2);
	// The reply quote on the phone: the same stacked row, inside the text.
	const quotePhone = await page.evaluate(QUOTE_BOX(RUN));
	page.check(
		`a phone: the long reply quote stays in the message's text, clamped (quote ${quotePhone?.quote.map(
			(v) => v.toFixed(1)
		)}, the text's content box ${quotePhone?.content.map((v) => v.toFixed(1))}; ${
			quotePhone?.sizing
		}, clamped ${quotePhone?.clamped}, the column ${quotePhone?.display})`,
		!!quotePhone &&
			quotePhone.display === "block" &&
			quotePhone.sizing === "border-box" &&
			quotePhone.clamped &&
			insideOf(quotePhone.quote, quotePhone.content)
	);
	page.check(
		`a phone on a rainy noon (${phone.weather}): half the drops and seeds, 65 and 13 (${phone.drops}, ${phone.seeds}; ${phone.flakes} flakes)`,
		phone.weather === "rain" && phone.drops === 65 && phone.seeds === 13 && phone.flakes === 0
	);
	checkDeck(page, await page.evaluate(DECK_GEOMETRY), "a phone on a rainy noon");
	await page.screenshot("ps-phone-rain-sep26-1230");
	const phoneYurt = await page.evaluate(YURT);
	page.check(
		`a phone: the yurt at 72 % of the column, kept whole on the screen (centre ${phoneYurt.cx.toFixed(
			1
		)}, due ${phoneYurt.due.toFixed(1)}, column ${JSON.stringify(phoneYurt.column)}, place ${
			phoneYurt.left
		})`,
		!!phoneYurt.column &&
			phoneYurt.left !== "" &&
			phoneYurt.op > 0.99 &&
			Math.abs(phoneYurt.cx - phoneYurt.due) <= 1
	);
	// The drawer lies over the chat: the column does not resize under it, so
	// the yurt stays where it stands.
	await page.click(`#chat .header .lt`);
	await page.waitFor(`document.getElementById("viewport").classList.contains("menu-open")`, {
		label: "the phone's sidebar open over the yurt",
	});
	await page.sleep(1000);
	const drawnOver = await page.evaluate(YURT);
	page.check(
		`a phone: opening the drawer does not move the yurt (place ${phoneYurt.left} → ${
			drawnOver.left
		}, centre ${phoneYurt.cx.toFixed(1)} → ${drawnOver.cx.toFixed(1)}, moving ${
			drawnOver.moving
		})`,
		drawnOver.left === phoneYurt.left &&
			Math.abs(drawnOver.cx - phoneYurt.cx) < 0.5 &&
			!drawnOver.moving &&
			drawnOver.op > 0.99
	);
	await page.screenshot("ps-phone-rain-sidebar");
	await page.evaluate(`document.getElementById("sidebar-overlay").click()`);
	await page.waitFor(`!document.getElementById("viewport").classList.contains("menu-open")`, {
		label: "the phone's sidebar closed again",
	});
	await page.sleep(500);
	// A stormy noon on the portrait phone: the deck's billows as wide as the
	// desktop's (sized in % of the deck, they hung as tall drips here).
	const phoneStorm = await at(page, noonOn(7, 19));
	checkDeck(
		page,
		phoneStorm.weather === "storm" ? await page.evaluate(DECK_GEOMETRY) : null,
		`a phone on a stormy noon (${phoneStorm.weather})`
	);
	await page.screenshot("ps-phone-storm-jul19-1230");
	await realClock(page);

	await page.screenshot("ps-phone-noon");

	// On the phone layout the glass has no backdrop filter and keeps the
	// generated tint (ps.css, the phones section: the measured budget's
	// fallback, ps-theme.md §10): the header and the composer at noon.
	await atHour(page, 12);
	const phoneNoon = await page.evaluate(CHROME);

	for (const selector of ["#chat .header", "#form"]) {
		const s = phoneNoon.glass[selector];
		page.check(
			`a phone at noon: ${selector} is the day tint at 78 %, unblurred (${
				s ? `${s.bg}, ${s.blur}` : "missing"
			})`,
			isUnblurredTint(s, DAY_GLASS, 0.78)
		);
	}

	await checkComposer(page, "a phone at noon");

	// ---- the phone at noon, the overlays open: glass again (Task 8c)

	// The open drawer and the user list laid over the chat keep their glass
	// (ps.css, the phones section, after the fallback): blurred, brightened by
	// day, on the chips' tint the scene publishes, so the conversation's words
	// behind them are frosted away rather than showing through.
	const floatTint = Number(
		await page.evaluate(`document.documentElement.style.getPropertyValue("--ps-g-tint-float")`)
	);
	// Opening, the blur comes at once (the open drawer's own 0 s change).
	const opening = await page.evaluate(DRAWER_SLIDE(true));
	page.check(
		`a phone at noon: opening, the drawer is blurred at once (${opening.at0?.blur}; 80 ms in, ${opening.at80?.blur})`,
		!opening.missed && opening.at0.blur !== "none" && opening.at80.blur !== "none"
	);
	await page.sleep(1000); // the drawer's slide, and the tint's flip from the fallback's
	const noonDrawer = await page.evaluate(DRAWER);
	page.check(
		`a phone at noon: the open drawer is glass, blurred and brightened, on the chips' tint ${floatTint} (${noonDrawer.bg}, ${noonDrawer.blur})`,
		isOverlayGlass(noonDrawer, DAY_GLASS, floatTint, true)
	);
	await page.screenshot("ps-phone-noon-sidebar");
	// Closing, it keeps its blur until it has slid off screen (the final
	// review, 2026-09-26): dropped at the slide's start, the words behind it
	// showed through all the way out. The filter changes 160 ms late, as the
	// slide ends.
	const closing = await page.evaluate(DRAWER_SLIDE(false));
	const slid = closing.ended?.transform;
	const unblurred = closing.ended?.["backdrop-filter"];
	page.check(
		`a phone at noon: closing, the drawer is still blurred as it starts and 80 ms in, on screen to ${closing.at80?.right} px (${closing.at0?.blur}; ${closing.at80?.blur})`,
		!closing.missed &&
			closing.at0.blur !== "none" &&
			closing.at80.blur !== "none" &&
			closing.at80.right > 0
	);
	page.check(
		`a phone at noon: the blur goes as the slide ends, the drawer off screen (the slide ended at ${slid?.t} ms, the blur at ${unblurred?.t} ms, the drawer to ${unblurred?.right} px, ${unblurred?.blur}; at ${closing.at500?.t} ms ${closing.at500?.blur})`,
		!!slid &&
			!!unblurred &&
			unblurred.blur === "none" &&
			unblurred.right <= 0 &&
			Math.abs(unblurred.t - slid.t) < 50 &&
			closing.at500.blur === "none"
	);
	await page.evaluate(`document.querySelector("#chat .header button.rt").click()`);
	await page.waitFor(`document.getElementById("viewport").classList.contains("userlist-open")`, {
		label: "the phone's user list open",
	});
	await page.sleep(1000);
	const noonList = await page.evaluate(
		`(() => { const cs = getComputedStyle(document.querySelector("#chat .userlist")); return {bg: cs.backgroundColor, blur: cs.backdropFilter}; })()`
	);
	page.check(
		`a phone at noon: the user list laid over the chat is glass, blurred and brightened, on the chips' tint ${floatTint} (${noonList.bg}, ${noonList.blur})`,
		isOverlayGlass(noonList, DAY_GLASS, floatTint, true)
	);
	await page.screenshot("ps-phone-noon-userlist");
	await page.evaluate(`document.querySelector("#chat .header button.rt").click()`);
	await page.waitFor(`!document.getElementById("viewport").classList.contains("userlist-open")`, {
		label: "the phone's user list closed",
	});

	// ---- the phone at night, the drawer open: the night glass over the plains

	// The scrim starts at the drawer's edge (ps.css, the phone block), so the
	// drawer lies over the plains themselves, not a dimmed grey.
	await atHour(page, 22);
	await page.click(`#chat .header .lt`);
	await page.waitFor(`document.getElementById("viewport").classList.contains("menu-open")`, {
		label: "the phone's sidebar open",
	});
	await page.sleep(700); // the drawer's slide
	const drawer = await page.evaluate(DRAWER);
	page.check(
		`a phone at night: the open drawer is glass on the night tint at 74 %, blurred and not brightened (${drawer.bg}, ${drawer.blur})`,
		isOverlayGlass(drawer, NIGHT_GLASS, 0.74, false)
	);
	page.check(
		`a phone at night: the drawer is on top, not under the scrim (${drawer.hit})`,
		drawer.onTop
	);
	await page.screenshot("ps-phone-night-sidebar");
	await page.evaluate(`document.getElementById("sidebar-overlay").click()`);
	await page.waitFor(`!document.getElementById("viewport").classList.contains("menu-open")`, {
		label: "the phone's sidebar closed",
	});

	await page.send("Emulation.setDeviceMetricsOverride", {
		width: Number(page.opt("width", 1280)),
		height: Number(page.opt("height", 900)),
		deviceScaleFactor: 1,
		mobile: page.flags.has("--mobile"),
	});
	await page.sleep(300);

	if (userlistWasOpen) {
		await page.evaluate(`document.querySelector("#chat .header button.rt").click()`);
	}

	const oldName = await page.evaluate(
		`/ps\\s*(<|&lt;)3/.test(document.documentElement.outerHTML + document.title)`
	);
	page.check(`the page says "ps <3" nowhere`, oldName === false);

	page.check(`no console errors (${page.consoleErrors.length})`, page.consoleErrors.length === 0);

	// ---- the clouds drift in and out of sight

	// The user saw them "pop in on the left side" (2026-09-25): each loop
	// began with the cloud already mostly on screen. Now a cloud, its blobs
	// and its blur included, starts wholly past the scene's left edge and
	// ends wholly past its right one. Each drift is paused and put at its
	// loop's start, middle and end (a millisecond before the end), in the
	// first whole loop after its delay: the delays are negative, and in the
	// wind (ps-windy, the duration at 0.4) a delay can run past a whole loop,
	// so "the second iteration" would seek before the animation's start, where
	// no fill draws it and the cloud sits untransformed at the left edge (the
	// 2026-10-06 failures, on a windy pinned day). Pausing an animation
	// from script leaves it deaf to animation-play-state for good, which is
	// why this comes after every stopped-and-running check; the reloads below
	// build the scene afresh.
	const DRIFT = (p) => `(() => {
		const scene = document.getElementById("theme-scene").getBoundingClientRect();
		return [...document.querySelectorAll("#theme-scene .ps-cloud")].map((el) => {
			const a = el.getAnimations().find((x) => x.animationName === "ps-drift");
			if (!a) return null;
			const t = a.effect.getTiming();
			a.pause();
			const loop = Math.max(1, Math.ceil(-t.delay / t.duration));
			a.currentTime = t.delay + t.duration * (loop + ${p}) - (${p} === 1 ? 1 : 0);
			const boxes = [el, ...el.querySelectorAll("i")].map((e) => e.getBoundingClientRect());
			const blur = 0.025 * parseFloat(getComputedStyle(document.documentElement).fontSize);
			return {
				left: Math.min(...boxes.map((b) => b.left)) - blur - scene.left,
				right: Math.max(...boxes.map((b) => b.right)) + blur - scene.left,
				width: scene.width,
			};
		});
	})()`;
	const driftWeather = await page.evaluate(
		`document.getElementById("theme-scene").dataset.weather`
	);
	const loopStart = await page.evaluate(DRIFT(0));
	const loopMid = await page.evaluate(DRIFT(0.5));
	const loopEnd = await page.evaluate(DRIFT(1));
	page.check(
		`${cloudsFor(driftWeather)} clouds drift on a ${driftWeather} day (${
			loopStart.filter(Boolean).length
		} with ps-drift)`,
		loopStart.length === cloudsFor(driftWeather) && loopStart.every(Boolean)
	);
	loopStart.forEach((c, i) =>
		page.check(
			`cloud ${
				i + 1
			}: its loop starts wholly left of the scene (its right edge at ${c?.right.toFixed(1)})`,
			!!c && c.right <= 0
		)
	);
	loopMid.forEach((c, i) =>
		page.check(
			`cloud ${i + 1}: in mid-loop it is on the scene (${c?.left.toFixed(
				1
			)} to ${c?.right.toFixed(1)} of ${c?.width})`,
			!!c && c.left > 0 && c.right < c.width
		)
	);
	loopEnd.forEach((c, i) =>
		page.check(
			`cloud ${
				i + 1
			}: its loop ends wholly right of the scene (its left edge at ${c?.left.toFixed(1)} of ${
				c?.width
			})`,
			!!c && c.left >= c.width
		)
	);

	// ---- a load straight onto Settings (Review Focus 4)

	// No message column: the yurt stands at the scene's 70 % (ps.css, before
	// the scene has measured a column), and when a conversation opens it
	// fades out and back in at the column's 72 %, never sliding there.
	await page.evaluate(
		`(() => { window.__coldLoad = true; history.replaceState(null, "", "/#/settings/appearance"); })()`
	);
	await page.send("Page.reload");

	for (const until = Date.now() + 30000; ; ) {
		try {
			if (
				await page.evaluate(
					`!window.__coldLoad && !!document.querySelector("#theme-scene .ps-yurt") && !!document.querySelector(".settings-modal-done")`
				)
			) {
				break;
			}
		} catch {
			// the page is between documents
		}

		if (Date.now() > until) {
			throw new Error("the load onto Settings did not come up");
		}

		await page.sleep(200);
	}

	await page.sleep(1500);
	const cold = await page.evaluate(YURT);
	page.check(
		`a load onto Settings: no column, the yurt at 70 % of the scene (centre ${cold.cx.toFixed(
			1
		)}, due ${cold.due.toFixed(1)} of ${cold.sceneWidth}; place "${cold.left}", opacity ${
			cold.op
		})`,
		cold.column === null &&
			cold.left === "" &&
			cold.op > 0.99 &&
			Math.abs(cold.cx - cold.due) <= 1
	);
	await page.screenshot("ps-settings-first");
	await closeSettings(page);
	await page.waitFor(`document.querySelector("#connect form")`, {
		label: "the connect form, after Settings",
	});
	const opened = await checkYurtMove(
		page,
		"a load onto Settings, then a conversation",
		async () => {
			await page.fill(`[id="connect:nick"]`, `${NICK}c`);
			await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
			await page.waitFor(
				`document.querySelector('.channel-list-item[data-name="#seance"]')`,
				{
					timeout: 30000,
					label: "#seance in the sidebar, after Settings",
				}
			);
			await page.waitFor(`document.querySelector("#chat .chat")`, {
				label: "a message column",
			});
		},
		2500
	);
	// Long after the load's first second, so it fades rather than jumping in sight.
	page.check(
		`a load onto Settings, then a conversation: the yurt faded on its way (lowest opacity ${opened.minOp})`,
		opened.minOp < 0.05
	);
	await page.screenshot("ps-settings-first-then-seance");

	// ---- last: the scene's chunk does not load

	// The service worker fetches on the page's behalf and the memory cache
	// holds the chunk: either would mount the scene past the block.
	await page.send("Network.enable");
	await page.send("Network.setBypassServiceWorker", {bypass: true});
	await page.send("Network.setCacheDisabled", {cacheDisabled: true});
	await page.send("Network.setBlockedURLs", {urls: ["*scene-ps*"]});
	const logsFrom = page.consoleLogs.length;
	const entriesFrom = page.logEntries.length;
	await page.send("Page.reload", {ignoreCache: true});

	const warned = () =>
		page.consoleLogs.slice(logsFrom).some((l) => l.text.startsWith(HOOK_WARNING));
	for (let i = 0; i < 200 && !warned(); i++) {
		await page.sleep(100);
	}

	page.check(`the reload tried the scene and it did not load (the hook warned)`, warned());

	// The reload lands on the connect form, filled from the saved network
	// (a fresh nick, in case the old one is still leaving). Back in #seance,
	// the neighbour speaks again: the ink is read off that line.
	await page.waitFor(`document.querySelector("#connect form")`, {label: "the connect form"});
	await page.fill(`[id="connect:nick"]`, `${NICK}b`);
	await page.evaluate(`document.querySelector("#connect form").requestSubmit()`);
	await page.waitFor(`document.querySelector('.channel-list-item[data-name="#seance"]')`, {
		timeout: 30000,
		label: "#seance in the sidebar after the reload",
	});
	await page.click(`.channel-list-item[data-name="#seance"]`);
	await page.sleep(1000); // the join burst
	peer.say(`still here ${RUN}`);
	await settle(page, OTHERS_LINE, 10000);
	await page.sleep(TEXT_EASE_MS);
	page.check(
		"after the reload the stylesheet is still themes/ps.css",
		(await page.evaluate(THEME_HREF)) === "themes/ps.css"
	);
	const soft = await page.evaluate(SCENE_STATE);
	page.check(
		`no chunk: an empty scene element, still shown (display ${soft.display}, ${soft.children} children)`,
		soft.display === "block" && soft.children === 0
	);
	page.check(
		`no chunk: the daylight fallback paints the sky (${soft.background})`,
		soft.background.includes(FALLBACK_SKY)
	);
	page.check(
		`no chunk: ink text, nothing published (text ${soft.text}, ink ${soft.ink})`,
		soft.text === undefined && soft.ink === INK
	);
	await page.screenshot("ps-no-scene");

	// The console may say two things and no more: the blocked request, and
	// the hook's one warning. The Chromium this was written against writes no
	// console line at all for a request DevTools blocked (Log.entryAdded
	// carries nothing for it), so the request is witnessed by the warning,
	// whose ChunkLoadError names it; a browser that does log it may log it
	// once. NOT_THE_SCENE's lines are the rig's, and set aside by name.
	const complaints = [
		...page.logEntries
			.slice(entriesFrom)
			.filter((e) => e.level === "error" || e.level === "warning")
			.map((e) => `${e.level} [${e.source}] ${e.text} ${e.url}`),
		...page.consoleLogs
			.slice(logsFrom)
			.filter((l) => ["error", "warning", "assert", "exception"].includes(l.type))
			.map((l) => `${l.type} ${l.text}`),
	];
	const setAside = complaints.filter((c) => NOT_THE_SCENE.some((re) => re.test(c)));
	const blocked = complaints.filter((c) =>
		/^error \[network\] .* \S*\/js\/scene-ps\.js$/.test(c)
	);
	const warning = complaints.filter((c) => c.startsWith(`warning ${HOOK_WARNING}`));
	const unexpected = complaints.filter(
		(c) => !setAside.includes(c) && !blocked.includes(c) && !warning.includes(c)
	);
	const firstLine = (c) => c.split("\n")[0].slice(0, 110);
	page.check(
		`no chunk: the hook warned once, naming the blocked js/scene-ps.js (${warning.length})`,
		warning.length === 1 && /\/js\/scene-ps\.js\b/.test(warning[0])
	);
	page.check(
		`no chunk: the console says nothing else (${blocked.length} blocked-request line, ` +
			`${setAside.length} set aside${
				unexpected.length ? `; unexpected: ${unexpected.map(firstLine).join(" | ")}` : ""
			})`,
		unexpected.length === 0 && blocked.length <= 1 && warning.length === 1
	);
	console.log(`   set aside: ${setAside.map(firstLine).join(" | ") || "nothing"}`);

	await page.send("Network.setBlockedURLs", {urls: []});
	await page.send("Network.setBypassServiceWorker", {bypass: false});
	await page.send("Network.setCacheDisabled", {cacheDisabled: false});

	// ---- a cold boot with ps saved, straight onto #seance, at 4× (the yurt's boot race)

	// The scene can mount before ps.css shows #theme-scene (display: none,
	// 0 × 0 until then). The column's first observation used to put the yurt
	// at 0 and spend the load's first second on it: painted cut in half at
	// the left edge, then faded across to its place (the final review,
	// 2026-09-26). Here the network autoconnects and each reload lands
	// straight on #seance with the CPU at 4×; in the first three ps.css is
	// held until the scene has mounted and the column exists (HOLD_THEME), so
	// each is the race, and the fourth boots as it comes. In every one the
	// place in the first frame the scene is laid out is where the yurt ends,
	// nothing is written at 0, and nothing fades.
	await page.evaluate(`(() => {
		const nets = JSON.parse(localStorage.getItem("thelounge.networks") || "[]");
		for (const n of nets) n.autoconnect = true;
		localStorage.setItem("thelounge.networks", JSON.stringify(nets));
	})()`);
	const sampler = await page.send("Page.addScriptToEvaluateOnNewDocument", {
		source: BOOT_SAMPLER,
	});
	let holding = await page.send("Page.addScriptToEvaluateOnNewDocument", {source: HOLD_THEME});

	for (const boot of ["held 1", "held 2", "held 3", "as it comes"]) {
		if (boot === "as it comes") {
			await page.send("Page.removeScriptToEvaluateOnNewDocument", holding);
			holding = null;
		}

		await page.send("Emulation.setCPUThrottlingRate", {rate: 4});
		await coldReload(
			page,
			"/",
			`window.__boot && window.__boot.laidOut && document.querySelector("#chat .chat")`,
			`the cold boot (${boot})`
		);
		await page.sleep(4000); // the load's second and a fade's worth, at 4×
		const b = await page.evaluate(
			`({boot: window.__boot, held: window.__held ?? null, route: location.hash})`
		);
		const end = await page.evaluate(YURT);
		await page.send("Emulation.setCPUThrottlingRate", {rate: 1});
		const label = `a cold boot onto ${b.route} at 4×, ${boot}`;
		page.check(
			`${label}: ${
				b.held
					? `ps.css held until the scene had mounted (${b.held.at} → ${b.held.released} ms)`
					: "ps.css as it comes"
			}, and no place written at 0 (${b.boot.writes
				.map((w) => `${w.t} ms ${w.v}`)
				.join(", ")})`,
			(boot === "as it comes") === (b.held === null) &&
				b.boot.writes.length > 0 &&
				!b.boot.writes.some((w) => parseFloat(w.v) === 0)
		);
		page.check(
			`${label}: the place in the first frame the scene is laid out is where it ends (${
				b.boot.laidOut.left
			} at ${b.boot.laidOut.t} ms, then ${end.left}; centre ${end.cx.toFixed(
				1
			)}, due ${end.due.toFixed(1)})`,
			b.boot.laidOut.left === end.left &&
				!!end.column &&
				end.op > 0.99 &&
				Math.abs(end.cx - end.due) <= 1
		);
		page.check(
			`${label}: and it never fades across (moving ${b.boot.moved || b.boot.laidOut.moving})`,
			!b.boot.moved && !b.boot.laidOut.moving && !end.moving
		);
	}

	await page.screenshot("ps-cold-boot");
	await page.send("Page.removeScriptToEvaluateOnNewDocument", sampler);

	peer.quit();
	await page.send("Emulation.setTimezoneOverride", {timezoneId: ""});
}
