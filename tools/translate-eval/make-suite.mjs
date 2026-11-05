// Generates tools/translate-eval/suite.json: the round-trip suite for the
// offline runner (tools/translate-llm.ts --eval …). Every case is one shape
// of chat line sent from English into one of the LLM's languages, and the
// runner's round-trip mode translates the answer back into English so the
// two can be compared. Shapes cover what a channel actually carries: a
// plain question, a long sentence with clauses, a four-sentence paragraph,
// a three-line draft, words that do not translate (commands, shorthand),
// markdown with code and a URL, an idiom, a line addressed to a nick, and
// numbers, times and units.
//
//   node tools/translate-eval/make-suite.mjs > tools/translate-eval/suite.json
//   npx tsx tools/translate-llm.ts --eval tools/translate-eval/suite.json --round-trip

const SHAPES = {
	question: {
		text: "can you send me the log from yesterday?",
		expect: "a question, not an answer; the log and yesterday kept",
	},
	complex: {
		text: "If the build is still red after you rebase onto main, ping me before you force-push, because the deploy job reads the tag that CI writes.",
		expect: "one sentence with all three clauses; rebase, main, force-push, CI as terms",
	},
	paragraph: {
		text: "We moved the deploy to Thursday because the build bot was flaky again. Please keep the timestamps in the log this time. If anyone still sees the login loop, paste the console output in here. Thanks for the patience, it has been a long week.",
		expect: "all four sentences, in order, on one line",
	},
	lines: {
		text: "the build is green\nI'll merge it after lunch\ncan someone restart the bot?",
		expect: "three lines, in order, the second in the first person, the third a question",
		purpose: "write",
	},
	untranslatable: {
		text: "brb, need to kubectl the pod on staging, the nginx ingress is 502ing again, lol",
		expect: "brb, kubectl, staging, nginx, 502, lol carried through; the rest translated",
	},
	markdown: {
		text: "see https://example.org/x?y=1 and run `tail -f irc.log` first, it's *urgent*",
		expect: "the URL and the backticked command unchanged; *urgent* translated inside its marks",
		markers: "literal",
	},
	idiom: {
		text: "it's not rocket science, just don't bite off more than you can chew",
		expect: "the meaning (it is easy; do not take on too much), not the words",
	},
	nick: {
		text: "ps, are you coming to the standup tonight or should we move it?",
		expect: "ps kept as the address; a question with both alternatives",
		nicks: ["ps"],
		context: {names: ["ps"]},
	},
	numbers: {
		text: "the meeting moved from 14:30 to 3pm on March 3rd; bring the 2.4 GB dump",
		expect: "both times, the date and 2.4 GB intact",
	},
};

/** Every shape for the languages the user is likeliest to test. */
const FULL = ["de", "fr", "es", "it", "pt", "ja", "zh", "ru"];
/** Three shapes for the rest of the LLM's stronger languages. */
const LIGHT = ["nl", "pl", "uk", "tr", "ko", "sv", "cs", "ar", "hi", "vi", "id", "el"];
const LIGHT_SHAPES = ["question", "paragraph", "lines"];

const cases = [];
let n = 0;

function add(lang, shapeName) {
	const shape = SHAPES[shapeName];

	n++;
	cases.push({
		note: `${n}: en→${lang} ${shapeName}`,
		expect: shape.expect,
		text: shape.text,
		from: "en",
		to: lang,
		purpose: shape.purpose ?? "write",
		...(shape.markers ? {markers: shape.markers} : {}),
		...(shape.nicks ? {nicks: shape.nicks} : {}),
		...(shape.context ? {context: shape.context} : {}),
	});
}

for (const lang of FULL) {
	for (const shapeName of Object.keys(SHAPES)) {
		add(lang, shapeName);
	}
}

for (const lang of LIGHT) {
	for (const shapeName of LIGHT_SHAPES) {
		add(lang, shapeName);
	}
}

process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
