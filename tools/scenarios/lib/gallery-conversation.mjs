// The fixed conversation tools/scenarios/gallery.mjs draws under every theme:
// what lib/tiny-ircd.mjs sends when the page joins. Every line carries a
// pinned `time` tag and a `msgid`, so the same rows, times and nick colours
// come out of every run.
//
// One channel holds the rows a theme styles: a run of lines from one nick, a
// join, a reply, a /me, a mention of us, a link, a notice, a mode change, a
// topic change, a part and a quit, our own line with a reaction under it, and
// a line after it from someone else. One private conversation follows, two
// lines in and one of ours out.

export const NICK = "seer";
export const CHANNEL = "#gallery";
export const PEER = "carol";

/** The day every line is on, and the instant the page's clock is held at. */
export const DAY = "2026-09-25";
export const CLOCK = Date.parse(`${DAY}T12:30:00Z`);

const at = (hhmm) => `${DAY}T${hhmm}:00.000Z`;
const from = (nick) => `:${nick}!${nick}@gallery.test`;

/** [time, msgid, line] for each line, in the order they are sent. */
function script(server) {
	const c = CHANNEL;
	return [
		["11:58", "g01", `${from(NICK)} JOIN ${c}`],
		[null, null, `:${server} 332 ${NICK} ${c} :Release week | be kind`],
		[null, null, `:${server} 333 ${NICK} ${c} alice ${Date.parse(at("09:00")) / 1000}`],
		[null, null, `:${server} 353 ${NICK} = ${c} :@${NICK} @alice +bob carol dave erin`],
		[null, null, `:${server} 366 ${NICK} ${c} :End of /NAMES list.`],
		["11:59", "g02", `${from("frank")} JOIN ${c}`],
		["12:00", "g03", `${from("alice")} PRIVMSG ${c} :morning all`],
		["12:00", "g04", `${from("alice")} PRIVMSG ${c} :the build went green overnight`],
		["12:01", "g05", `${from("alice")} PRIVMSG ${c} :so the release can go out today`],
		["12:02", "g06", `${from("bob")} PRIVMSG ${c} :nice, I will write the notes`],
		["12:03", "g07", `${from("carol")} PRIVMSG ${c} :which commit was it?`, "+draft/reply=g04"],
		["12:04", "g08", `${from("dave")} PRIVMSG ${c} :\x01ACTION waves at everyone\x01`],
		[
			"12:05",
			"g09",
			`${from("bob")} PRIVMSG ${c} :${NICK}: can you look at the theme gallery?`,
		],
		[
			"12:06",
			"g10",
			`${from("alice")} PRIVMSG ${c} :notes draft: https://example.com/notes/release`,
		],
		["12:07", "g11", `${from("alice")} NOTICE ${c} :Maintenance window at 18:00 UTC`],
		["12:08", "g12", `${from("alice")} MODE ${c} +v carol`],
		["12:09", "g13", `${from("alice")} TOPIC ${c} :Release day | notes in the wiki`],
		["12:10", "g14", `${from("erin")} PART ${c} :lunch`],
		["12:11", "g15", `${from("dave")} QUIT :Quit: see you tomorrow`],
		["12:12", "g16", `${from(NICK)} PRIVMSG ${c} :on it, capturing every theme now`],
		["12:13", "g17", `${from("bob")} TAGMSG ${c}`, "+draft/react=👍;+draft/reply=g16"],
		["12:14", "g18", `${from("carol")} PRIVMSG ${c} :looks good from here`],
		["12:15", "g19", `${from(PEER)} PRIVMSG ${NICK} :hey, got a minute?`],
		["12:15", "g20", `${from(PEER)} PRIVMSG ${NICK} :the phone layout looks off to me`],
		["12:16", "g21", `${from(NICK)} PRIVMSG ${PEER} :sure, sending you a screenshot`],
	];
}

/** The lines to send, tags included, when the page joins. */
export function conversation(server) {
	return script(server).map(([time, msgid, line, extra]) => {
		const tags = [time && `time=${at(time)}`, msgid && `msgid=${msgid}`, extra].filter(Boolean);
		return tags.length > 0 ? `@${tags.join(";")} ${line}` : line;
	});
}
