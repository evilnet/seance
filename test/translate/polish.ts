import {expect} from "chai";
import {emptyContext, PromptContext, TranslateRequest} from "../../client/js/translate/engine";
import {bareRetry, keepQuestionMark, OutgoingRequest} from "../../client/js/translate/outgoing";
import {
	buildMessages as buildMessages17,
	POLISH_EXAMPLES_EN,
	systemPrompt as systemPrompt17,
	userPrompt as userPrompt17,
} from "../../client/js/translate/prompt";
import {
	buildMessages as buildMessages4B,
	POLISH_EXAMPLE_TURNS,
	systemPrompt as systemPrompt4B,
	userPrompt as userPrompt4B,
} from "../../client/js/translate/prompts/qwen3-4b";

const name = (code: string) => (code === "en" ? "English" : code);

/** Everything a channel would put in a prompt, none of which a polish sends. */
function channelContext(): PromptContext {
	const context = emptyContext();

	context.topic = "release day";
	context.names = ["ada", "sean"];
	context.terms = [["rig", "Testaufbau"]];
	context.recent = [
		{nick: "sean", text: "Todavia estoy probando", translated: "I'm still testing."},
	];
	context.voice = ["I'm still testing."];

	return context;
}

function polish(text: string, context = channelContext()): TranslateRequest {
	return {id: 1, model: "m", text, from: "en", to: "en", purpose: "polish", context};
}

// Measured on the web build's 4B weights (2026-09-19,
// tmp/experiments/polish-context.ts): with the channel's names, terms or
// earlier lines above the line, the model stopped correcting -- 4 of 5 lines
// handed back as written, the fifth with the "Correct:" label copied in
// front; with nothing above it, 5 of 5 corrected. So a polish's prompt is
// the line and nothing else, whatever the request carries.
describe("translate/polish", () => {
	for (const [label, user, system] of [
		["Qwen3-1.7B", userPrompt17, systemPrompt17],
		["Qwen3-4B", userPrompt4B, systemPrompt4B],
	] as const) {
		it(`${label}: the prompt is the line alone, however full the context`, () => {
			expect(user(polish("corected text being sent hear"), name)).to.equal(
				"Correct: corected text being sent hear"
			);
			expect(user(polish("corected text being sent hear", emptyContext()), name)).to.equal(
				"Correct: corected text being sent hear"
			);
		});

		it(`${label}: the system prompt is the copy editor's, not the engine's`, () => {
			const text = system(polish("corected text being sent hear"), name);

			expect(text).to.include("Correct the user's English message");
			// The clause that makes it fix a word that is spelled right.
			expect(text).to.include("the wrong word for the sentence");
			expect(text).to.include("comes back unchanged");
			expect(text).to.not.include("translation engine");
			// The sentence about the data block and the earlier lines stays
			// in: it was part of the wording measured, and a polish sends
			// neither, so it says nothing about this request either way.
		});

		it(`${label}: a translation still carries the channel's context`, () => {
			const text = user({...polish("hallo"), purpose: "read", from: "de", to: "en"}, name);

			expect(text).to.include("Earlier lines");
			expect(text).to.include("Translate into English: hallo");
		});
	}

	// A polish can still fail as a narration or a loop, and the bare retry
	// must stay a polish: same purpose, so the copy editor's prompt; the
	// source kept as the routing hint, so `resolveRoute` still takes the
	// same-language branch to the LLM (router.ts) instead of finding no route.
	it("the retry of a polish is still a polish, and still routable", () => {
		const request: OutgoingRequest = {
			text: "corected text being sent hear",
			from: "en",
			to: "en",
			purpose: "polish",
			context: channelContext(),
			batches: false,
		};
		const retry = bareRetry(request);

		expect(retry.purpose).to.equal("polish");
		expect(retry.hint).to.equal("en");
		expect(retry.to).to.equal("en");
		expect(retry.context.recent).to.deep.equal([]);
		expect(retry.context.names).to.deep.equal([]);
	});
});

// Measured on the web build's 4-bit weights (2026-10-28,
// tools/translate-eval/results/2026-10-28-polish.md): examples lift the
// English cleanup -- as earlier turns for the 4B, inside the system prompt
// for the 1.7B. Nothing was measured for another language, which keeps the
// bare shape.
describe("translate/polish examples", () => {
	const req = (to: string): TranslateRequest => ({
		id: 1,
		model: "m",
		text: "your going to love this",
		from: to,
		to,
		purpose: "polish",
		context: emptyContext(),
	});

	it("the 4B's English cleanup has three earlier exchanges before the line", () => {
		const messages = buildMessages4B(req("en"), name);

		expect(messages.map((m) => m.role)).to.deep.equal([
			"system",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
		]);
		expect(messages.slice(1, 7)).to.deep.equal([...POLISH_EXAMPLE_TURNS]);
		expect(messages[7].content).to.equal("Correct: your going to love this");

		// Every example asks in the line's own shape.
		for (const turn of POLISH_EXAMPLE_TURNS.filter((m) => m.role === "user")) {
			expect(turn.content).to.match(/^Correct: /);
		}
	});

	it("the 1.7B's English cleanup carries the examples in its system prompt", () => {
		expect(systemPrompt17(req("en"), name)).to.include(POLISH_EXAMPLES_EN);
		expect(buildMessages17(req("en"), name)).to.have.length(2);
	});

	it("another language's cleanup, and any translation, carries no examples", () => {
		expect(buildMessages4B(req("de"), name)).to.have.length(2);
		expect(systemPrompt17(req("de"), name)).to.not.include(POLISH_EXAMPLES_EN);

		const write: TranslateRequest = {...req("de"), from: "en", purpose: "write"};

		expect(buildMessages4B(write, name)).to.have.length(2);
		expect(systemPrompt17({...write, to: "en", from: "de"}, name)).to.not.include(
			POLISH_EXAMPLES_EN
		);
	});
});

describe("translate/polish keepQuestionMark", () => {
	it("puts back the question mark a cleanup dropped", () => {
		expect(
			keepQuestionMark(
				"were going to the store, wanna come?",
				"we're going to the store, wanna come"
			)
		).to.equal("we're going to the store, wanna come?");
		expect(keepQuestionMark("is this you're car？", "is this your car")).to.equal(
			"is this your car？"
		);
	});

	it("leaves a line that kept its mark, a draft that asked nothing, and an actual answer", () => {
		expect(keepQuestionMark("is this you're car?", "is this your car?")).to.equal(
			"is this your car?"
		);
		expect(keepQuestionMark("your going to love this", "you're going to love this")).to.equal(
			"you're going to love this"
		);
		// An answer shares few of the question's words: answerError refuses it.
		expect(keepQuestionMark("wanna come to the store?", "Sure, I would love to")).to.equal(
			"Sure, I would love to"
		);
	});
});
