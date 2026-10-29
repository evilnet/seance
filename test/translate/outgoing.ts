import {expect} from "chai";
import sinon from "ts-sinon";
import {
	emptyContext,
	type TranslateChunk,
	type TranslateRequest,
} from "../../client/js/translate/engine";
import {
	ABORTED,
	BARE_RETRY_ERRORS,
	DEGENERATE,
	EMPTY_TRANSLATION,
	ANSWERED,
	NARRATION,
	REPETITION,
	TERM_MAX_WORDS,
	TIMED_OUT,
	UNCHANGED,
	WRITE_DETECT_MIN_GAP,
	WRITE_TIMEOUT_MS,
	CPU_WRITE_TIMEOUT_MS,
	answerError,
	isAnsweredQuestion,
	bareRetry,
	draftGate,
	tidyAnswer,
	echoingSoFar,
	hasNoLetters,
	isDegenerate,
	isNarration,
	isRepetition,
	isUnchanged,
	reverseTarget,
	onceTargetDefault,
	sourceHintFor,
	termPair,
	translateDraft,
	writeSource,
	type OutgoingDeps,
	type OutgoingRequest,
	stripPolishLabel,
} from "../../client/js/translate/outgoing";
import {protect} from "../../client/js/translate/spans";

type Req = Omit<TranslateRequest, "id" | "model">;
type Script = (req: Req) => string[] | Error;

function rig(script: Script) {
	const clock = sinon.useFakeTimers();
	const requests: Req[] = [];
	const signals: AbortSignal[] = [];
	const deps: OutgoingDeps = {
		translate(req, signal) {
			requests.push(req);
			signals.push(signal);

			return (async function* (): AsyncIterable<TranslateChunk> {
				await Promise.resolve();
				const out = script(req);

				if (out instanceof Error) {
					throw out;
				}

				for (const text of out) {
					if (signal.aborted) {
						return;
					}

					yield {id: 0, text, done: false};
				}

				yield {id: 0, text: out[out.length - 1], done: true};
			})();
		},
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
	};

	return {clock, requests, signals, deps};
}

function request(overrides: Partial<OutgoingRequest> = {}): OutgoingRequest {
	return {
		text: "please keep the log",
		from: "en",
		to: "de",
		purpose: "write",
		context: emptyContext(),
		batches: true,
		...overrides,
	};
}

/** The fake's shape: the target in brackets, then the text as given. */
const echo: Script = (req) =>
	req.lines
		? [
				`1. [de] ${req.lines[0]}`,
				req.lines.map((l, i) => `${i + 1}. [de] ${l}`).join("\n") + "\nEND",
		  ]
		: [`[de]`, `[de] ${req.text}`];

describe("translate/outgoing", () => {
	afterEach(() => sinon.restore());

	describe("draftGate", () => {
		it("lets text through and stops commands, edits and empty drafts", () => {
			expect(draftGate("hello there", false)).to.deep.equal({
				kind: "ok",
				text: "hello there",
			});
			// `//x` is the text `/x` to the IRC layer, and the escape is the
			// text: what goes out is what is translated.
			expect(draftGate("//not a command", false)).to.deep.equal({
				kind: "ok",
				text: "//not a command",
			});
			expect(draftGate("/connect", false)).to.deep.equal({
				kind: "command",
				text: "/connect",
			});
			expect(draftGate("hello there", true)).to.deep.equal({
				kind: "edit",
				text: "hello there",
			});
			expect(draftGate("   \n", false)).to.deep.equal({kind: "empty", text: "   \n"});
		});

		// An ACTION is prose -- the reading side translates everyone else's --
		// so what follows `/me ` is translated and the composer puts the
		// command back on the front of the translation.
		it("takes the text of a /me as a draft to translate", () => {
			expect(draftGate("/me waves", false)).to.deep.equal({kind: "action", text: "waves"});
			expect(draftGate("/ME WAVES slowly", false)).to.deep.equal({
				kind: "action",
				text: "WAVES slowly",
			});
			// Nothing to translate: an empty action is the command's business.
			expect(draftGate("/me", false)).to.deep.equal({kind: "command", text: "/me"});
			expect(draftGate("/me   ", false)).to.deep.equal({kind: "command", text: "/me   "});
			// A command that merely starts with the letters is not one.
			expect(draftGate("/mention bob", false)).to.deep.equal({
				kind: "command",
				text: "/mention bob",
			});
			// Editing is editing, whatever the line says.
			expect(draftGate("/me waves", true)).to.deep.equal({kind: "edit", text: "/me waves"});
		});
	});

	// The queue retries all five judged failures bare (`failJudged`); the
	// composer used to name four of them, so a draft the model looped on in
	// four or five repeats (DEGENERATE) got no second try while a six-repeat
	// one (REPETITION) did.
	describe("BARE_RETRY_ERRORS", () => {
		it("is every judged failure a bare second try can answer", () => {
			expect([...BARE_RETRY_ERRORS].sort()).to.deep.equal(
				[UNCHANGED, NARRATION, ANSWERED, REPETITION, DEGENERATE].sort()
			);
			expect(BARE_RETRY_ERRORS.has(DEGENERATE)).to.equal(true);
			// Not a judged failure: nothing came back at all.
			expect(BARE_RETRY_ERRORS.has(EMPTY_TRANSLATION)).to.equal(false);
		});
	});

	describe("onceTargetDefault", () => {
		const fallback = ["en", "de", "fr", "es"];
		const pick = (
			routes: (to: string) => boolean,
			last = "",
			declared: string[] = [],
			reading = "en"
		) => onceTargetDefault({reading, last, declared, fallback, routes});
		// A device without the GPU model: every pair but the cleanup pass.
		const cpuOnly = (to: string) => to !== "en";

		it("never opens a device without the GPU model on the cleanup pass", () => {
			// Reading English, no earlier pick: the dialog used to open on
			// English -> English, disabled, "Correcting a message needs the
			// GPU model".
			expect(pick(cpuOnly)).to.equal("de");
			expect(pick(cpuOnly, "", ["fr"])).to.equal("fr");
		});

		it("keeps the cleanup pass where it runs, after a language the channel speaks", () => {
			const all = () => true;
			expect(pick(all)).to.equal("en");
			expect(pick(all, "", ["en", "es"])).to.equal("es");
			expect(pick(all, "fr", ["es"])).to.equal("fr");
		});

		it("passes over a last pick the device can no longer serve", () => {
			expect(pick(cpuOnly, "en")).to.equal("de");
			expect(pick((to) => to === "es", "fr")).to.equal("es");
		});

		it("keeps the old preselection when nothing routes, so the dialog says why", () => {
			const none = () => false;
			expect(pick(none)).to.equal("en");
			expect(pick(none, "fr")).to.equal("fr");
		});
	});

	describe("writeSource and reverseTarget", () => {
		it("trusts the reading language for an unplaced draft, then nobody", () => {
			expect(writeSource({lang: null, confidence: 0}, "en", "de")).to.equal("en");
			expect(writeSource({lang: null, confidence: 0}, "de", "de")).to.equal(null);
		});

		it("trusts a verdict that agrees with the reading language outright", () => {
			expect(writeSource({lang: "en", confidence: 0.05}, "en", "de")).to.equal("en");
		});

		it("falls back to the reading language when a differing verdict is weak", () => {
			// An English draft the detector calls Italian at a weak 0.12: not
			// sure enough to override the reading language.
			expect(writeSource({lang: "it", confidence: 0.12}, "en", "de")).to.equal("en");
		});

		it("trusts a differing verdict once it clears WRITE_DETECT_MIN_GAP", () => {
			expect(WRITE_DETECT_MIN_GAP).to.equal(0.3);
			expect(writeSource({lang: "it", confidence: 0.4}, "en", "de")).to.equal("it");
			expect(
				writeSource({lang: "it", confidence: WRITE_DETECT_MIN_GAP}, "en", "de")
			).to.equal("it");
		});

		// "From German into German" is a request the model answers by handing
		// the line back, so where the reading language is the write target
		// there is nothing to fall back to: the source is left to the LLM.
		it("never falls back to the reading language when that is the target", () => {
			expect(writeSource({lang: "en", confidence: 0.28}, "de", "de")).to.equal(null);
			expect(writeSource({lang: "en", confidence: 0.28}, "en", "de")).to.equal("en");
			expect(writeSource({lang: "it", confidence: 0.12}, "en", "de")).to.equal("en");
			expect(writeSource({lang: "it", confidence: 0.4}, "de", "de")).to.equal("it");
			// A weak verdict for the target itself (a strong one is sent as
			// typed before this is asked) names no source either.
			expect(writeSource({lang: "de", confidence: 0.2}, "de", "de")).to.equal(null);
		});

		it("sourceHintFor: the named source, else the detector's verdict unless it is the target", () => {
			expect(sourceHintFor({lang: "tl"}, "en", "de")).to.equal("en");
			// writeSource left the source to the LLM; a weak Filipino verdict is
			// still what lets a seq2seq route take the draft.
			expect(sourceHintFor({lang: "tl"}, null, "en")).to.equal("tl");
			expect(sourceHintFor({lang: "en"}, null, "en")).to.equal(null);
			expect(sourceHintFor({lang: null}, null, "en")).to.equal(null);
		});

		it("targets the reading language, never the draft's detected language", () => {
			expect(reverseTarget("en", "de")).to.equal("en");
			expect(reverseTarget("de", "de")).to.equal(null);
		});
	});

	describe("isUnchanged and hasNoLetters", () => {
		// An echo is judged loosely: a model handing a line back rather than
		// translating it often normalises the case, the spacing or the full
		// stop, and that is still the line that went in.
		it("takes back the same line through case, spacing and trailing punctuation", () => {
			expect(isUnchanged("please keep the log", "Please keep the log")).to.equal(true);
			expect(isUnchanged("please keep  the   log", "  please keep the log  ")).to.equal(true);
			expect(isUnchanged("please keep the log.", "please keep the log")).to.equal(true);
			expect(isUnchanged("wirklich?!", "wirklich")).to.equal(true);
			expect(isUnchanged("das war es…", "Das war es")).to.equal(true);
			// Marks round the line or round a word are packaging.
			expect(isUnchanged("sounds good to me", "*sounds good to me*")).to.equal(true);
			expect(isUnchanged("no problem", "||No problem||")).to.equal(true);
			expect(isUnchanged("wait what?", "**wait** what?")).to.equal(true);
			expect(isUnchanged("", "   ")).to.equal(true);
		});

		it("is no echo when the answer is another line, or the line with a word added", () => {
			expect(isUnchanged("please keep the log", "bitte behalte das Log")).to.equal(false);
			expect(isUnchanged("please keep the log", "please keep the whole log")).to.equal(false);
			expect(isUnchanged("ok", "ok dann")).to.equal(false);
			expect(isUnchanged("log", "Log file")).to.equal(false);
		});

		it("has no letters where nothing in the text could be a language", () => {
			expect(hasNoLetters("")).to.equal(true);
			expect(hasNoLetters("   ")).to.equal(true);
			expect(hasNoLetters("⟹ ")).to.equal(true);
			expect(hasNoLetters("--- ---")).to.equal(true);
			// A placeholder is span syntax, not content, digit and all.
			expect(hasNoLetters("⟦1⟧")).to.equal(true);
			expect(hasNoLetters("⟹ ⟦1⟧")).to.equal(true);
		});

		it("takes a word, a number or another script as an answer", () => {
			expect(hasNoLetters("ok")).to.equal(false);
			expect(hasNoLetters("42")).to.equal(false);
			expect(hasNoLetters("Hallo")).to.equal(false);
			expect(hasNoLetters("Привет")).to.equal(false);
			expect(hasNoLetters("こんにちは")).to.equal(false);
		});
	});

	describe("isNarration", () => {
		it("catches the model talking about the request", () => {
			// The answer the offline runner produced, token budget and all.
			const narrated =
				'okay, let\'s see. The user wants the translation of "sounds good to me" into French. The phrase is casual and friendly. In French, "sounds good to me" can be translated as "C\'est bien pour moi" or';

			expect(isNarration("sounds good to me", narrated)).to.equal(true);
			expect(
				isNarration("hey there", "The user wants me to translate this into German.")
			).to.equal(true);
			expect(answerError("sounds good to me", narrated, "en")).to.equal(NARRATION);
		});

		it("leaves translations alone, including ones that mention users or translating", () => {
			expect(isNarration("sounds good to me", "C'est bien pour moi.")).to.equal(false);
			expect(isNarration("ok", 'd\'accord "ok"')).to.equal(false);
			expect(
				isNarration(
					"the user asked us to translate the docs",
					"the user asked us to translate the docs, please"
				)
			).to.equal(false);
			expect(
				isNarration(
					"Translate into French: the meeting is at noon",
					"Die Sitzung ist um 12 Uhr."
				)
			).to.equal(false);
			expect(isNarration("l'utilisateur", "the user")).to.equal(false);
		});
	});

	describe("isRepetition", () => {
		it("catches a model stuck repeating a word", () => {
			expect(isRepetition("Höfðu ekki ekki ekki ekki ekki ekki ekki ekki …")).to.equal(true);
			expect(isRepetition("Nafaka ya kisasa kama kama kama kama kama kama kama")).to.equal(
				true
			);
			// Case and punctuation aside.
			expect(isRepetition("Kama, kama, KAMA. kama kama kama!")).to.equal(true);
		});

		it("catches a repeated run in a script written without spaces", () => {
			expect(isRepetition("我们我们我们我们我们我们")).to.equal(true);
			expect(isRepetition("ですですですですですです")).to.equal(true);
			expect(isRepetition("ไม่ไม่ไม่ไม่ไม่ไม่")).to.equal(true);
		});

		it("leaves emphasis, laughter and ordinary lines alone", () => {
			expect(isRepetition("no no no no")).to.equal(false);
			expect(isRepetition("hahahaha")).to.equal(false);
			expect(isRepetition("hahahahahahahahaha")).to.equal(false);
			expect(isRepetition("very very very very very good, not very very")).to.equal(false);
			expect(isRepetition("我们把部署改到了周四。")).to.equal(false);
			expect(isRepetition("哈哈哈哈")).to.equal(false);
			expect(isRepetition("")).to.equal(false);
		});

		it("leaves drawn-out surprise and laughter alone", () => {
			expect(isRepetition("ええええええ、本当に？")).to.equal(false);
			expect(isRepetition("哈哈哈哈哈哈，太好了")).to.equal(false);
			expect(isRepetition("え".repeat(11))).to.equal(false);
		});

		it("counts a single repeated character only at twelve in a row", () => {
			expect(isRepetition("ええええええええええええ")).to.equal(true);
			expect(isRepetition("哈".repeat(12))).to.equal(true);
			// Whole words keep the six.
			expect(isRepetition("ekki ekki ekki ekki ekki ekki")).to.equal(true);
		});
	});

	describe("tidyAnswer", () => {
		it("takes off a preamble about the translation and a wrapper round the whole answer", () => {
			// The read-back the user saw, English → Korean read back into English.
			expect(
				tidyAnswer(
					"큰 테스트가 다가옵니다",
					"Here comes the translation of the last messsage: **Here comes the big test**."
				)
			).to.equal("Here comes the big test.");
			expect(tidyAnswer("wichtig", "**important**")).to.equal("important");
			expect(tidyAnswer("wichtig", "*important*")).to.equal("important");
			expect(tidyAnswer("wichtig", "\u201cimportant\u201d")).to.equal("important");
			expect(tidyAnswer("hallo", "The translation is: hello!")).to.equal("hello!");
			expect(tidyAnswer("wichtig", "||important||")).to.equal("important");
			expect(tidyAnswer("wichtig", "~~important~~")).to.equal("important");
		});

		it("takes off an empty mark the model copied from the prompt", () => {
			// Measured on the web build's 1.7B weights, casual English lines.
			expect(tidyAnswer("no problem", "Non problème ||…||")).to.equal("Non problème");
			expect(tidyAnswer("no problem", "No problem ||...||")).to.equal("No problem");
			expect(tidyAnswer("no problem", "~~…~~ kein Problem")).to.equal("kein Problem");
			// The judge then sees the echo that was hiding behind it.
			expect(
				answerError(
					"sounds good to me",
					tidyAnswer("sounds good to me", "sounds good to me ||…||"),
					"fr"
				)
			).to.equal(UNCHANGED);
			// A source with the same mark keeps it, and a mark with words inside is content.
			expect(tidyAnswer("wait ||…||", "attends ||…||")).to.equal("attends ||…||");
			expect(tidyAnswer("a spoiler", "un ||spoiler||")).to.equal("un ||spoiler||");
			// Nothing but the mark: left for the judge.
			expect(tidyAnswer("hm", "||…||")).to.equal("||…||");
		});

		it("leaves an answer alone when the source has the same shape", () => {
			// The source talks about a translation: its colon is content.
			expect(
				tidyAnswer("Übersetzung für die Doku: fertig", "translation for the docs: done")
			).to.equal("translation for the docs: done");
			// A colon that is not about a translation.
			expect(tidyAnswer("Hinweis: der Build ist grün", "Note: the build is green")).to.equal(
				"Note: the build is green"
			);
			// The source is wrapped too.
			expect(tidyAnswer("*wichtig*", "*important*")).to.equal("*important*");
			// Two emphasised spans are not one wrapper.
			expect(tidyAnswer("a und b", "**a** and **b**")).to.equal("**a** and **b**");
			// Nothing but a preamble: left for the judge to refuse.
			expect(tidyAnswer("hallo", "Here is the translation:")).to.equal(
				"Here is the translation:"
			);
			expect(tidyAnswer("hallo", "hello")).to.equal("hello");
		});
	});

	describe("answerError", () => {
		it("passes a translation and names the failure an echo or a letterless answer is", () => {
			expect(answerError("das ist wichtig", "this is important", "en")).to.equal(null);
			expect(answerError("ok, brb", "Ok,  brb.", "en")).to.equal(UNCHANGED);
			expect(answerError("hello there", "\u27f9 ", "en")).to.equal(EMPTY_TRANSLATION);
		});

		it("reports a loop after the letterless rule, unless the source repeats itself too", () => {
			expect(answerError("is it not?", "ekki ekki ekki ekki ekki ekki ekki", "en")).to.equal(
				REPETITION
			);
			expect(
				answerError("no no no no no no no", "nein nein nein nein nein nein nein", "en")
			).to.equal(null);
			expect(answerError("...", "!!! !!! !!! !!! !!! !!!", "en")).to.equal(EMPTY_TRANSLATION);
		});

		it("reports a letterless answer as letterless even where it is also the source", () => {
			expect(answerError("", "", "en")).to.equal(EMPTY_TRANSLATION);
			expect(answerError("--- ---", "--- ---", "en")).to.equal(EMPTY_TRANSLATION);
		});

		it("reports symbol padding as degenerate, and passes the source's own emphasis", () => {
			// The measured OPUS failure: real words padded with dozens of dots.
			expect(
				answerError(
					"Highlight exceptions",
					`Ausnahmen von der Höchstgrenze${".".repeat(40)}`,
					"de"
				)
			).to.equal(DEGENERATE);

			// Spaced tildes over real words — the other measured shape.
			expect(answerError("Highlight messages", "Wort ~ ~ ~ ~ ~", "de")).to.equal(DEGENERATE);

			// A translation that carries the source's own run over is the
			// line's emphasis, not the model's padding.
			expect(answerError("che meraviglia!!!!!", "what a marvel!!!!!", "en")).to.equal(null);

			// Three dots and a typographic ellipsis are ordinary punctuation.
			expect(answerError("Loading...", "Wird geladen...", "de")).to.equal(null);
			expect(answerError("Wait…", "Warte…", "de")).to.equal(null);
		});
	});

	describe("isDegenerate", () => {
		it("names the shapes the fill measured and nothing a chat line can be", () => {
			expect(isDegenerate("~ ~ ~ ~ ~ ~ ~")).to.equal(true);
			expect(isDegenerate("Ausnahmen von der Höchstgrenze..........")).to.equal(true);
			expect(isDegenerate("a line, then @@@@@@")).to.equal(true);

			// Six emoji nobody's source had is padding; three is excitement.
			expect(isDegenerate("fantastic 😀😀😀😀😀😀")).to.equal(true);
			expect(isDegenerate("fantastic 😀😀😀")).to.equal(false);

			// Ordinary punctuation, and words with a stray mark in them.
			expect(isDegenerate("Wird geladen...")).to.equal(false);
			expect(isDegenerate("e.g. — see p. 12 (fig. 3)")).to.equal(false);
		});

		it("exempts a run the source carries itself", () => {
			expect(isDegenerate("what a marvel!!!!!", "che meraviglia!!!!!")).to.equal(false);
			expect(isDegenerate("what a marvel!!!!!", "che meraviglia!")).to.equal(true);
		});

		it("catches a word or a phrase repeated four times over", () => {
			// The shape the shipped af/hi catalogs are full of: a word the
			// model could not leave, sometimes after a punctuation run the
			// old rule was one character short of seeing.
			expect(isDegenerate("Sluit - - - - Κοντά Κοντά Κοντά Κοντά Κοντά")).to.equal(true);
			// A two-word phrase four times over, which no single-token run
			// would see: the tokens alternate.
			expect(isDegenerate("एक बार एक बार एक बार एक बार")).to.equal(true);
			// Case and edge punctuation are not what makes a token different.
			expect(isDegenerate("Kama, kama, KAMA. kama")).to.equal(true);
			expect(isDegenerate("no no no no no")).to.equal(true);
		});

		it("leaves three of a thing, and a line that merely rhymes, alone", () => {
			// Three is emphasis; the fourth token differs here, so the run
			// the model is in is three long.
			expect(isDegenerate("Ýary Ýary Ýary Ýaryş")).to.equal(false);
			expect(isDegenerate("ha ha ha")).to.equal(false);
			expect(
				isDegenerate("the cat sat on the mat", "le chat est assis sur le tapis")
			).to.equal(false);
		});

		it("exempts a repetition the source is in itself", () => {
			// A chat line that really does say it five times translates into
			// one that does; only the model inventing the run is degenerate.
			expect(isDegenerate("no no no no no", "нет нет нет нет нет")).to.equal(false);
			expect(isDegenerate("no no no no no", "нет")).to.equal(true);
		});
	});

	describe("isAnsweredQuestion", () => {
		it("catches a question answered instead of translated", () => {
			expect(
				isAnsweredQuestion("во сколько начинается встреча?", "It starts at nine.", "en")
			).to.equal(true);
			expect(
				answerError("во сколько начинается встреча?", "It starts at nine.", "en")
			).to.equal(ANSWERED);
		});

		it("passes a translated question, which keeps its mark", () => {
			expect(
				isAnsweredQuestion(
					"во сколько начинается встреча?",
					"What time does the meeting start?",
					"en"
				)
			).to.equal(false);
			expect(
				isAnsweredQuestion("kommst du morgen?", "Are you coming tomorrow？", "en")
			).to.equal(false);
			expect(isAnsweredQuestion("are you coming?", "هل ستأتي؟", "ar")).to.equal(false);
		});

		it("reads a Spanish question by its closing mark", () => {
			expect(
				isAnsweredQuestion("¿Vienes mañana?", "Are you coming tomorrow?", "en")
			).to.equal(false);
			expect(isAnsweredQuestion("¿Vienes mañana?", "Yes, I will be there.", "en")).to.equal(
				true
			);
		});

		it("looks past closing quotes, brackets and emoji after the mark", () => {
			expect(
				isAnsweredQuestion('er fragte "kommst du?"', "Sure, I am coming.", "en")
			).to.equal(true);
			expect(isAnsweredQuestion("kommst du morgen? 🙂", "Yes, see you then.", "en")).to.equal(
				true
			);
			expect(
				isAnsweredQuestion("(kommst du morgen?)", "(Yes, see you then.)", "en")
			).to.equal(true);
		});

		it("leaves a statement alone", () => {
			expect(
				isAnsweredQuestion("das Treffen beginnt um neun.", "It starts at nine.", "en")
			).to.equal(false);
		});

		it("does not take a mark inside the line for a question", () => {
			expect(isAnsweredQuestion("Memorizar? Hm...", "Memorise. Hm...", "en")).to.equal(false);
		});

		it("does not judge a target whose questions often go without a mark", () => {
			for (const to of ["ja", "zh", "ko", "th", "el"]) {
				expect(
					isAnsweredQuestion("what time does it start?", "何時に始まりますか", to),
					to
				).to.equal(false);
			}

			expect(answerError("what time does it start?", "何時に始まりますか", "ja")).to.equal(
				null
			);
		});
	});

	describe("echoingSoFar", () => {
		it("holds while the stream is still the source coming back", () => {
			expect(echoingSoFar("We moved the deploy to Thursday", "We moved")).to.equal(true);
			expect(echoingSoFar("We moved  the deploy", "we moved the")).to.equal(true);
			expect(
				echoingSoFar("the build is green\nI'll merge it", "the build is green\nI'll")
			).to.equal(true);
		});

		it("lets go once the answer departs from the source, and never holds nothing", () => {
			expect(echoingSoFar("We moved the deploy", "Wir haben")).to.equal(false);
			expect(echoingSoFar("ps, are you coming?", "ps, kommst")).to.equal(false);
			expect(echoingSoFar("hello there", "")).to.equal(false);
			expect(echoingSoFar("hello there", "   ")).to.equal(false);
		});
	});

	describe("stripPolishLabel", () => {
		it("takes the copied label off a corrected line", () => {
			expect(stripPolishLabel("Correct: the quick brown fox")).to.equal(
				"the quick brown fox"
			);
			expect(stripPolishLabel("Corrected: fine")).to.equal("fine");
			expect(stripPolishLabel("correction: fine")).to.equal("fine");
			expect(stripPolishLabel("fine")).to.equal("fine");
			expect(stripPolishLabel("Correct me if I am wrong")).to.equal(
				"Correct me if I am wrong"
			);
		});
	});

	describe("bareRetry", () => {
		const full = (): OutgoingRequest =>
			request({
				text: "bis sp\u00e4ter",
				from: "de",
				to: "en",
				markers: "literal",
				nicks: ["ada", "jonas"],
				protected: protect("bis sp\u00e4ter"),
				context: {
					recent: [{nick: "ada", text: "hat jemand das Log?"}],
					replyTo: {nick: "jonas", text: "ich schau mal"},
					topic: "release day",
					sourceHint: "de",
					names: ["ada", "jonas"],
					terms: [["rig", "Testaufbau"]],
					voice: ["ich schau es mir an"],
					formality: "formal",
					variant: "de-AT",
				},
			});

		it("leaves the source to the model and keeps nothing of the context but the register", () => {
			const original = full();
			const bare = bareRetry(original);

			expect(bare.from).to.equal(null);
			expect(bare.context).to.deep.equal({
				recent: [],
				names: [],
				terms: [],
				voice: [],
				formality: "formal",
				variant: "de-AT",
			});
			expect(bare.context.sourceHint).to.equal(undefined);
			expect(bare.context.topic).to.equal(undefined);
			expect(bare.context.replyTo).to.equal(undefined);
			expect(bare.context.topic).to.equal(undefined);
			expect(bare.context.replyTo).to.equal(undefined);
		});

		it("keeps the source as the routing hint, which never reaches the prompt", () => {
			// A seq2seq route takes the hint as its source: the retry goes down
			// the same route, which without it would have no source at all.
			expect(bareRetry(full()).hint).to.equal("de");
			expect(bareRetry(full()).context.sourceHint).to.equal(undefined);
			expect(bareRetry({...full(), from: null, hint: "tl"}).hint).to.equal("tl");
			expect(bareRetry({...full(), from: null, hint: null}).hint).to.equal(null);
		});

		it("keeps the draft, the target and the route it is going down", () => {
			const original = full();
			const bare = bareRetry(original);

			expect(bare.text).to.equal("bis sp\u00e4ter");
			expect(bare.to).to.equal("en");
			expect(bare.purpose).to.equal("write");
			expect(bare.batches).to.equal(original.batches);
			expect(bare.markers).to.equal("literal");
			expect(bare.nicks).to.deep.equal(["ada", "jonas"]);
			expect(bare.protected).to.equal(original.protected);
		});

		it("carries no variant where the request had none", () => {
			const bare = bareRetry(
				request({context: {...emptyContext(), formality: "casual", variant: ""}})
			);

			expect(bare.context.formality).to.equal("casual");
			expect("variant" in bare.context).to.equal(false);
		});

		it("does not touch the request it was given", () => {
			const original = full();
			const before = JSON.stringify(original);

			bareRetry(original);

			expect(JSON.stringify(original)).to.equal(before);
			expect(original.from).to.equal("de");
			expect(original.context.recent).to.have.length(1);
			expect(original.context.sourceHint).to.equal("de");
		});
	});

	describe("termPair", () => {
		it("keeps a short pair and drops sentences, commands, placeholders and identical text", () => {
			expect(termPair("rig", "Testaufbau")).to.deep.equal(["rig", "Testaufbau"]);
			expect(termPair("  log file ", "Protokolldatei")).to.deep.equal([
				"log file",
				"Protokolldatei",
			]);
			expect(termPair("please keep the log", "bitte behalte das Log")).to.equal(null);
			expect(termPair("a".repeat(41), "b")).to.equal(null);
			expect(termPair("rig", "a very long translation of a short term indeed")).to.equal(
				null
			);
			expect(termPair("/me", "ich")).to.equal(null);
			expect(termPair("see ⟦1⟧", "siehe ⟦1⟧")).to.equal(null);
			// A side with nothing in it a language could be is no term: it
			// would be quoted into every later prompt as a real word's
			// translation.
			expect(termPair("rig", "⟹")).to.equal(null);
			expect(termPair("rig", "--- ---")).to.equal(null);
			expect(termPair("→", "Pfeil")).to.equal(null);
			expect(termPair("Rig", "rig")).to.equal(null);
			expect(termPair("one\ntwo", "eins zwei")).to.equal(null);
			expect(TERM_MAX_WORDS).to.equal(3);
		});
	});

	describe("translateDraft", () => {
		it("translates one line, streaming restored text, and restores the spans at the end", async () => {
			const r = rig((req) => [`[de]`, `[de] ${req.text}`]);
			const chunks: string[] = [];
			const text = await translateDraft(
				r.deps,
				request({text: "see https://example.org/x?y=1 now"}),
				new AbortController().signal,
				(t) => chunks.push(t)
			);

			expect(r.requests).to.have.length(1);
			expect(r.requests[0].text).to.equal("see ⟦1⟧ now");
			expect(r.requests[0].purpose).to.equal("write");
			expect(text).to.equal("[de] see https://example.org/x?y=1 now");
			expect(chunks[chunks.length - 1]).to.equal(text);
		});

		it("appends a span the engine dropped", async () => {
			const r = rig(() => ["[de] gone"]);
			const text = await translateDraft(
				r.deps,
				request({text: "see https://example.org/"}),
				new AbortController().signal,
				() => {}
			);

			expect(text).to.equal("[de] gone https://example.org/");
		});

		it("sends a multi-line draft as numbered lines and keeps blank lines in place", async () => {
			const r = rig(echo);
			const chunks: string[] = [];
			const text = await translateDraft(
				r.deps,
				request({text: "one\n\ntwo\nthree"}),
				new AbortController().signal,
				(t) => chunks.push(t)
			);

			expect(r.requests).to.have.length(1);
			expect(r.requests[0].lines).to.deep.equal(["one", "two", "three"]);
			expect(r.requests[0].text).to.equal("");
			expect(text).to.equal("[de] one\n\n[de] two\n[de] three");
			expect(chunks[0]).to.equal("[de] one\n\n\n");
		});

		it("goes line by line when the numbering does not parse, and when the engine does not batch", async () => {
			const r = rig((req) => (req.lines ? ["garbage"] : [`[de] ${req.text}`]));
			const text = await translateDraft(
				r.deps,
				request({text: "one\ntwo"}),
				new AbortController().signal,
				() => {}
			);

			expect(r.requests.map((q) => q.lines?.length ?? 0)).to.deep.equal([2, 0, 0]);
			expect(text).to.equal("[de] one\n[de] two");

			const single = rig((req) => [`[de] ${req.text}`]);
			const plain = await translateDraft(
				single.deps,
				request({text: "one\ntwo", batches: false}),
				new AbortController().signal,
				() => {}
			);

			expect(single.requests.map((q) => q.text)).to.deep.equal(["one", "two"]);
			expect(plain).to.equal("[de] one\n[de] two");
		});

		it("goes line by line when the engine refuses the batch before it yields", async () => {
			const r = rig((req) =>
				req.lines ? new Error("seq2seq engines do not batch") : [`[de] ${req.text}`]
			);
			const text = await translateDraft(
				r.deps,
				request({text: "one\ntwo"}),
				new AbortController().signal,
				() => {}
			);

			expect(r.requests.map((q) => q.lines?.length ?? 0)).to.deep.equal([2, 0, 0]);
			expect(text).to.equal("[de] one\n[de] two");
		});

		it("hides markdown markers and the channel's nicks from the engine, and puts them back", async () => {
			const r = rig((req) => [`[de] ${req.text}`]);
			const text = await translateDraft(
				r.deps,
				request({
					text: "this is supposed to be in *German*. Ask hilde.",
					nicks: ["hilde", "otto"],
				}),
				new AbortController().signal,
				() => {}
			);

			expect(r.requests[0].text).to.equal("this is supposed to be in ⟦1⟧German⟦2⟧. Ask ⟦3⟧.");
			expect(text).to.equal("[de] this is supposed to be in *German*. Ask hilde.");
		});

		it("a marker whose partner the engine lost leaves no stray marker behind", async () => {
			const r = rig(() => ["[de] ⟦1⟧so wichtig"]);
			const text = await translateDraft(
				r.deps,
				request({text: "*so wichtig*"}),
				new AbortController().signal,
				() => {}
			);

			expect(text).to.equal("[de] so wichtig");
		});

		it("re-prepends a line prefix the engine dropped", async () => {
			const r = rig(() => ["[de] Titel"]);
			const text = await translateDraft(
				r.deps,
				request({text: "# Title"}),
				new AbortController().signal,
				() => {}
			);

			expect(r.requests[0].text).to.equal("⟦1⟧Title");
			expect(text).to.equal("# [de] Titel");
		});

		it("ships a fenced code block whole and never sends it for translation", async () => {
			const r = rig(echo);
			const text = await translateDraft(
				r.deps,
				request({text: "look at this\n```\nx = 1\n```\nand that is all"}),
				new AbortController().signal,
				() => {}
			);

			expect(r.requests).to.have.length(1);
			expect(r.requests[0].lines).to.deep.equal(["look at this", "and that is all"]);
			expect(text).to.equal("[de] look at this\n```\nx = 1\n```\n[de] and that is all");
		});

		it("takes an already-protected text and restores against its spans", async () => {
			const r = rig(echo);
			const info = protect("erste Zeile\nzweite *Zeile*");
			const text = await translateDraft(
				r.deps,
				request({text: info.text, protected: info}),
				new AbortController().signal,
				() => {}
			);

			expect(r.requests[0].lines).to.deep.equal(["erste Zeile", "zweite ⟦1⟧Zeile⟦2⟧"]);
			expect(text).to.equal("[de] erste Zeile\n[de] zweite *Zeile*");
		});

		it("keeps inline math intact through a draft's translation", async () => {
			const r = rig((req) => [`[de] ${req.text}`]);
			const text = await translateDraft(
				r.deps,
				request({text: "the result is $`x^2`$ and it is final"}),
				new AbortController().signal,
				() => {}
			);

			expect(r.requests[0].text).to.equal("the result is ⟦1⟧ and it is final");
			expect(text).to.equal("[de] the result is $`x^2`$ and it is final");
		});

		it("sends the routing hint with every request, outside the prompt's context", async () => {
			const r = rig(echo);

			await translateDraft(
				r.deps,
				request({from: null, hint: "tl", batches: false}),
				new AbortController().signal,
				() => {}
			);

			expect(r.requests.map((q) => q.hint)).to.deep.equal(["tl"]);
			expect(r.requests[0].context.sourceHint).to.equal(undefined);
			r.clock.restore();
		});

		it("times out, aborting the request it made", async () => {
			const r = rig(() => ["never"]);
			const never: OutgoingDeps = {
				...r.deps,
				translate(_req, signal) {
					r.signals.push(signal);

					// eslint-disable-next-line require-yield -- ends only by abort or timeout, never yields
					return (async function* (): AsyncIterable<TranslateChunk> {
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve())
						);
					})();
				},
			};
			const promise = translateDraft(
				never,
				request(),
				new AbortController().signal,
				() => {}
			);
			const failed = promise.catch((e: Error) => e.message);

			await r.clock.tickAsync(WRITE_TIMEOUT_MS + 1);
			expect(await failed).to.equal(TIMED_OUT);
			expect(r.signals[0].aborted).to.equal(true);
		});

		const neverOn = (r: ReturnType<typeof rig>): OutgoingDeps => ({
			...r.deps,
			translate(_req, signal) {
				r.signals.push(signal);

				// eslint-disable-next-line require-yield -- ends only by abort or timeout, never yields
				return (async function* (): AsyncIterable<TranslateChunk> {
					await new Promise<void>((resolve) =>
						signal.addEventListener("abort", () => resolve())
					);
				})();
			},
		});

		it("the language model on the CPU has CPU_WRITE_TIMEOUT_MS", async () => {
			const r = rig(() => ["never"]);
			const promise = translateDraft(
				neverOn(r),
				{...request(), device: "cpu", engine: "llm"},
				new AbortController().signal,
				() => {}
			);
			const failed = promise.catch((e: Error) => e.message);

			await r.clock.tickAsync(WRITE_TIMEOUT_MS + 1);
			expect(r.signals[0].aborted).to.equal(false);
			await r.clock.tickAsync(CPU_WRITE_TIMEOUT_MS - WRITE_TIMEOUT_MS);
			expect(await failed).to.equal(TIMED_OUT);
		});

		it("OPUS-MT or NLLB-200 on the CPU keeps WRITE_TIMEOUT_MS", async () => {
			const r = rig(() => ["never"]);
			const promise = translateDraft(
				neverOn(r),
				{...request(), device: "cpu", engine: "seq2seq"},
				new AbortController().signal,
				() => {}
			);
			const failed = promise.catch((e: Error) => e.message);

			await r.clock.tickAsync(WRITE_TIMEOUT_MS + 1);
			expect(await failed).to.equal(TIMED_OUT);
		});

		it("waits out a model download, and times out once the download stalls", async () => {
			const r = rig(() => ["never"]);
			let ticks = 0;
			const never: OutgoingDeps = {
				...r.deps,
				loadTicks: () => ticks,
				translate(_req, signal) {
					r.signals.push(signal);

					// eslint-disable-next-line require-yield -- ends only by abort or timeout, never yields
					return (async function* (): AsyncIterable<TranslateChunk> {
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve())
						);
					})();
				},
			};
			let outcome: string | null = null;

			void translateDraft(never, request(), new AbortController().signal, () => {}).catch(
				(e: Error) => {
					outcome = e.message;
				}
			);

			for (let i = 0; i < 3; i++) {
				ticks += 7;
				await r.clock.tickAsync(WRITE_TIMEOUT_MS + 1);
			}

			expect(outcome).to.equal(null);
			expect(r.signals[0].aborted).to.equal(false);

			await r.clock.tickAsync(WRITE_TIMEOUT_MS + 1);

			expect(outcome).to.equal(TIMED_OUT);
			expect(r.signals[0].aborted).to.equal(true);
			r.clock.restore();
		});

		it("reports the caller's abort as ABORTED and passes it down", async () => {
			const r = rig(() => ["never"]);
			const controller = new AbortController();
			const never: OutgoingDeps = {
				...r.deps,
				translate(_req, signal) {
					r.signals.push(signal);

					// eslint-disable-next-line require-yield -- ends only by abort or timeout, never yields
					return (async function* (): AsyncIterable<TranslateChunk> {
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => resolve())
						);
					})();
				},
			};
			const failed = translateDraft(never, request(), controller.signal, () => {}).catch(
				(e: Error) => e.message
			);

			await Promise.resolve();
			controller.abort();
			expect(await failed).to.equal(ABORTED);
			expect(r.signals[0].aborted).to.equal(true);
		});

		it("passes the engine's own error through", async () => {
			const r = rig(() => new Error("no translation engine can take this request"));
			const failed = translateDraft(
				r.deps,
				request(),
				new AbortController().signal,
				() => {}
			).catch((e: Error) => e.message);

			expect(await failed).to.equal("no translation engine can take this request");
		});
	});
});
