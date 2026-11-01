import {expect} from "chai";
import type {ClientChan} from "../../client/js/types";
import {
	CONTEXT_LINES,
	NAMES_CAP,
	TERM_LINES,
	VOICE_LINES,
	addressedNick,
	buildContext,
	mentionedNicks,
	type ContextChannel,
	type ContextMessage,
} from "../../client/js/translate/context";

// The client's channel must satisfy the builder's structural type without a cast.
const _assignable: (chan: ClientChan) => ContextChannel = (chan) => chan;
void _assignable;

function m(
	id: number,
	nick: string,
	text: string,
	extra: Partial<ContextMessage> = {}
): ContextMessage {
	return {id, type: "message", text, from: {nick}, msgid: `m${id}`, ...extra};
}

const users = ["ada", "jonas", "mira", "Storm"].map((nick) => ({nick}));

describe("translate/context", () => {
	it("addressedNick reads the IRC address convention", () => {
		const nicks = users.map((u) => u.nick);

		expect(addressedNick("ada: schau mal", nicks)).to.equal("ada");
		expect(addressedNick("Ada, schau mal", nicks)).to.equal("ada");
		expect(addressedNick("schau mal ada:", nicks)).to.equal(null);
		expect(addressedNick("nobody: hi", nicks)).to.equal(null);
	});

	it("mentionedNicks finds nicks as whole words, case-insensitively", () => {
		expect(
			mentionedNicks(
				"frag Jonas oder storm, nicht ada2",
				users.map((u) => u.nick)
			)
		).to.deep.equal(["jonas", "Storm"]);
	});

	it("builds the recent lines before the message, with their translations", () => {
		const channel: ContextChannel = {
			topic: "multiline batches",
			users,
			messages: [
				m(1, "ada", "anyone tried it?"),
				m(2, "jonas", "Ja, gestern."),
				{id: 3, type: "join", from: {nick: "mira"}},
				m(4, "mira", "nice"),
				m(5, "jonas", "Ich schick dir gleich das Log."),
				m(6, "ada", "later"),
			],
		};
		const context = buildContext(channel, channel.messages[4], {
			translated: (id) => (id === 2 ? "Yes, yesterday." : undefined),
			terms: [["rig", "Testaufbau"]],
			glossary: [],
			formality: "formal",
			variant: "",
			sourceHint: "de",
		});

		expect(context.recent).to.deep.equal([
			{nick: "ada", text: "anyone tried it?"},
			{nick: "jonas", text: "Ja, gestern.", translated: "Yes, yesterday."},
			{nick: "mira", text: "nice"},
		]);
		expect(context.topic).to.equal("multiline batches");
		expect(context.terms).to.deep.equal([["rig", "Testaufbau"]]);
		expect(context.formality).to.equal("formal");
		expect(context.variant).to.equal(undefined);
		expect(context.sourceHint).to.equal("de");
		expect(context.names).to.deep.equal(["ada", "jonas", "mira"]);
		expect(context.voice).to.deep.equal([]);
		expect(context.replyTo).to.equal(undefined);
	});

	it("keeps only the last CONTEXT_LINES chat lines", () => {
		const messages = Array.from({length: 30}, (_, i) => m(i + 1, "ada", `line ${i + 1}`));
		const channel: ContextChannel = {topic: "", users, messages};
		const context = buildContext(channel, messages[29], {
			translated: () => undefined,
			terms: [],
			glossary: [],
			formality: "auto",
			variant: "",
			sourceHint: null,
		});

		expect(context.recent.length).to.equal(CONTEXT_LINES);
		expect(context.recent[0].text).to.equal("line 20");
		expect(context.recent[CONTEXT_LINES - 1].text).to.equal("line 29");
		expect(context.topic).to.equal(undefined);
	});

	it("the reply target is the parent by msgid, else the addressed nick's last line", () => {
		const channel: ContextChannel = {
			topic: "",
			users,
			messages: [
				m(1, "ada", "anyone tried it?"),
				m(2, "mira", "nope"),
				m(3, "jonas", "Ja, gestern.", {replyTo: "m1"}),
				m(4, "jonas", "ada: und das Log?"),
				m(5, "jonas", "storm: hallo", {}),
			],
		};
		const opts = {
			translated: () => undefined,
			terms: [],
			glossary: [],
			formality: "auto" as const,
			variant: "",
			sourceHint: null,
		};

		expect(buildContext(channel, channel.messages[2], opts).replyTo).to.deep.equal({
			nick: "ada",
			text: "anyone tried it?",
		});
		expect(buildContext(channel, channel.messages[3], opts).replyTo).to.deep.equal({
			nick: "ada",
			text: "anyone tried it?",
		});
		expect(buildContext(channel, channel.messages[4], opts).replyTo).to.equal(undefined);
		expect(buildContext(channel, channel.messages[4], opts).names).to.include("Storm");
	});

	it("caps the names and includes the variant when set", () => {
		const many = Array.from({length: 40}, (_, i) => ({nick: `n${i}`}));
		const messages = Array.from({length: 12}, (_, i) => m(i + 1, `n${i}`, `hi n${i + 20}`));
		const channel: ContextChannel = {topic: "", users: many, messages};
		const context = buildContext(channel, messages[11], {
			translated: () => undefined,
			terms: [],
			glossary: [],
			formality: "auto",
			variant: "Brazilian Portuguese",
			sourceHint: null,
		});

		expect(context.names.length).to.be.at.most(NAMES_CAP);
		expect(context.variant).to.equal("Brazilian Portuguese");
	});

	it("keeps the newest TERM_LINES of the channel's terms", () => {
		const channel: ContextChannel = {topic: "", users, messages: [m(1, "ada", "hi")]};
		// channelStore.rememberTerm appends, so the tail is the newest.
		const terms: [string, string][] = Array.from({length: TERM_LINES + 5}, (_, i) => [
			`term${i}`,
			`Begriff${i}`,
		]);
		const context = buildContext(channel, channel.messages[0], {
			translated: () => undefined,
			terms,
			glossary: [],
			formality: "auto",
			variant: "",
			sourceHint: null,
		});

		expect(context.terms.length).to.equal(TERM_LINES);
		expect(context.terms[0][0]).to.equal("term5");
		expect(context.terms[TERM_LINES - 1][0]).to.equal(`term${terms.length - 1}`);
	});

	it("merges the deploy glossary behind the channel's terms, uncapped", () => {
		const channel: ContextChannel = {topic: "", users, messages: [m(1, "ada", "hi")]};
		const terms: [string, string][] = Array.from({length: TERM_LINES + 2}, (_, i) => [
			`term${i}`,
			`Begriff${i}`,
		]);

		// The channel's own memory of a term wins over the deploy's; the
		// glossary itself is not subject to TERM_LINES.
		terms.push(["rig", "Testaufbau"]);

		const glossary: [string, string][] = [
			["rig", "Aufbau"],
			...Array.from({length: TERM_LINES + 3}, (_, i): [string, string] => [
				`deploy${i}`,
				`Einsatz${i}`,
			]),
		];
		const context = buildContext(channel, channel.messages[0], {
			translated: () => undefined,
			terms,
			glossary,
			formality: "auto",
			variant: "",
			sourceHint: null,
		});

		expect(context.terms.length).to.equal(TERM_LINES + glossary.length - 1);
		expect(context.terms.find(([source]) => source === "rig")).to.deep.equal([
			"rig",
			"Testaufbau",
		]);
		expect(context.terms.filter(([source]) => source === "rig").length).to.equal(1);
		expect(context.terms[context.terms.length - 1]).to.deep.equal([
			`deploy${TERM_LINES + 2}`,
			`Einsatz${TERM_LINES + 2}`,
		]);
	});

	it("copies terms, so the built context does not hold the caller's array", () => {
		const channel: ContextChannel = {topic: "", users, messages: [m(1, "ada", "hi")]};
		const terms: [string, string][] = [["rig", "Testaufbau"]];
		const context = buildContext(channel, channel.messages[0], {
			translated: () => undefined,
			terms,
			glossary: [],
			formality: "auto",
			variant: "",
			sourceHint: null,
		});

		expect(context.terms).to.deep.equal(terms);
		expect(context.terms).to.not.equal(terms);
	});

	it("quotes the newest VOICE_LINES of the user's own lines, and none by default", () => {
		const channel: ContextChannel = {messages: [m(1, "ada", "hi")], users, topic: ""};
		const opts = {
			translated: () => undefined,
			terms: [] as [string, string][],
			glossary: [] as [string, string][],
			formality: "auto" as const,
			variant: "",
			sourceHint: null,
		};
		const voice = ["one", "two", "three", "four", "five", "six", "seven"];

		expect(buildContext(channel, m(2, "me", "x"), opts).voice).to.deep.equal([]);
		expect(buildContext(channel, m(2, "me", "x"), {...opts, voice}).voice).to.deep.equal(
			voice.slice(-VOICE_LINES)
		);
	});

	// Bug A: the names the prompt lists must be the names the protection
	// fenced, so `opts.nicks` — the one set (`names.ts` `namesFor`) — is what
	// a mention is matched against, the user list only its fallback.
	it("matches mentions against the given nick set, not only the user list", () => {
		const channel: ContextChannel = {
			topic: "",
			users: [{nick: "ada"}],
			messages: [m(1, "ada", "hi"), m(2, "ada", "frag gone mal")],
		};
		const opts = {
			translated: () => undefined,
			terms: [] as [string, string][],
			glossary: [] as [string, string][],
			formality: "auto" as const,
			variant: "",
			sourceHint: null,
		};

		expect(buildContext(channel, channel.messages[1], opts).names).to.deep.equal(["ada"]);
		// Structural, not incidental: a speaker outside the set is not listed,
		// because a name the prompt asks the model to keep it never saw
		// fenced is the inversion this option exists to rule out.
		expect(
			buildContext(channel, channel.messages[1], {...opts, nicks: ["gone"]}).names
		).to.deep.equal(["gone"]);
		expect(
			buildContext(channel, channel.messages[1], {...opts, nicks: ["ada", "gone"]}).names
		).to.deep.equal(["ada", "gone"]);
	});
});
