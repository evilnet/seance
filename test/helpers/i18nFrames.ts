import {expect} from "chai";
import enCatalog from "../../client/locales/en.json";
import {framePieces} from "../../client/js/i18n/core";

// The sentences that were cut into t() fragments around an element are one
// key each now (I18nFrame.vue renders the elements into them). Pin the
// English an English reader saw before: each frame with its elements' text
// put back must read as the upstream sentence, spaces included -- three
// commits on this branch were lost spaces beside an inline element.
const en = enCatalog as Record<string, string | Record<string, string>>;

/** The frame rendered as text: each {name} replaced by what its slot shows. */
function render(key: string, slots: Record<string, string>, vars: Record<string, string> = {}) {
	let text = en[key] as string;
	expect(text, key).to.be.a("string");

	for (const [name, value] of Object.entries(vars)) {
		text = text.replace(`{${name}}`, value);
	}

	return framePieces(text, Object.keys(slots))
		.map((piece) => (typeof piece === "string" ? piece : slots[piece.name]))
		.join("");
}

describe("whole-sentence frames keep the English", () => {
	const cases: Array<[string, Record<string, string>, string, Record<string, string>?]> = [
		[
			"help.autocomplete.intro",
			{up: "↑", down: "↓", tab: "Tab", enter: "Enter"},
			"To auto-complete nicknames, channels, commands, and emoji, type one of the characters below to open a suggestion list. Use the ↑ and ↓ keys to highlight an item, and insert it by pressing Tab or Enter (or by clicking the desired item).",
		],
		[
			"help.autocomplete.emoji",
			{example: ":)"},
			"Emoji (note: requires two search characters, to avoid conflicting with common emoticons like :))",
		],
		[
			"help.commands.collapse",
			{command: "/expand"},
			"Collapse all previews in the current channel (opposite of /expand)",
		],
		[
			"help.commands.expand",
			{command: "/collapse"},
			"Expand all previews in the current channel (opposite of /collapse)",
		],
		["help.commands.back", {command: "/away"}, "Remove your away status (set with /away)."],
		["msg.modeChannelIs", {modes: "+nt"}, "Channel mode is +nt"],
		["msg.modeUserIs", {modes: "+iwx"}, "Your user mode is +iwx"],
		["settings.aliases.varLiteral", {character: "$"}, "a literal $"],
		[
			"help.commands.ban",
			{mode: "+b"},
			"Ban (+b) a user from the current channel. This can be a nickname or a hostmask.",
		],
		[
			"help.commands.connect",
			{port: "port", plus: "+"},
			"Connect to a new IRC network. If port starts with a + sign, the connection will be made secure using TLS.",
		],
		[
			"help.commands.ctcp",
			{ctcp: "CTCP", link: "the dedicated Wikipedia article"},
			"Send a CTCP request. Read more about this on the dedicated Wikipedia article.",
		],
		[
			"help.commands.ver",
			{ctcp: "CTCP", command: "/ctcp nick version"},
			"Ask a user which client they run: a CTCP VERSION request, the same as /ctcp nick version. The answer shows where you asked.",
		],
		[
			"help.commands.kickban",
			{mode: "+b", ban: "/ban"},
			"Kick and ban (+b) a user from the current channel. Unlike /ban, only nicknames (and not host masks) can be used.",
		],
		[
			"help.commands.part",
			{channel: "channel"},
			"Close the specified channel or private message window, or the current channel if channel is omitted.",
		],
		[
			"help.commands.unmute",
			{mute: "/mute"},
			"Un-mutes the given channel(s) or the current channel if no channel is provided. See /mute for more information.",
		],
		[
			"help.formatting.markAs",
			{style: "bold"},
			"Mark all text typed after this shortcut as bold.",
		],
		["help.formatting.colorReference", {link: "here"}, "A color reference can be found here."],
		["msg.topicSet", {nick: "alice"}, "Topic set by alice on 10/28/2026", {time: "10/28/2026"}],
		[
			"settings.aliases.intro",
			{example: "/wave", first: "$1", rest: "$2-", all: "$*"},
			"An alias is a slash command of your own. Typing /wave runs what you define here — one command per line, with the arguments filled in where the body says $1, $2- or $*.",
		],
		[
			"settings.aliases.nested",
			{command: "/join", expansion: "/join #lobby $*"},
			"A body line can invoke another alias, and an alias named after a built-in command replaces it — /join can become /join #lobby $* without looping.",
		],
		["search.results.searchingIn", {channel: "#seance"}, "Searching in #seance for"],
		[
			"settings.appearance.trustedHelp",
			{button: "Always show"},
			"Media in these scopes loads without asking. Add one with Always show on any preview.",
		],
		[
			"help.builtFromCommit",
			{commit: "commit 1a2b3c4"},
			"Seance is built from commit 1a2b3c4, after v5.2.0.",
			{app: "Seance", version: "5.2.0"},
		],
		["help.commitHash", {hash: "1a2b3c4"}, "commit 1a2b3c4"],
		[
			"help.compareSince",
			{range: "between v5.2.0 and 1a2b3c4"},
			"Compare between v5.2.0 and 1a2b3c4 to see what changed since the release",
		],
		[
			"windows.changelog.pastReleaseLine",
			{commit: "commit 1a2b3c4", since: "what changed since the release"},
			"This build is commit 1a2b3c4, after v5.2.0: what changed since the release.",
			{version: "5.2.0"},
		],
		[
			"windows.changelog.notBundledLine",
			{readNotes: "Read the notes for v5.2.0", allReleases: "see all releases"},
			"Release notes are not bundled with the build. Read the notes for v5.2.0 or see all releases.",
		],
	];

	for (const [key, slots, english, vars] of cases) {
		it(key, () => {
			expect(render(key, slots, vars)).to.equal(english);
		});
	}

	it("upload.confirmCount is a plural entry", () => {
		expect(en["upload.confirmCount"]).to.deep.equal({
			one: "Upload {count} file",
			other: "Upload {count} files",
		});
	});
});
