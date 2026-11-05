import {expect} from "chai";
import {emptyContext, type TranslateRequest} from "../../client/js/translate/engine";
import {QWEN3_1_7B_ID, QWEN3_4B_ID} from "../../client/js/translate/models";
import * as prompt from "../../client/js/translate/prompt";
import {
	QWEN3_1_7B_PROMPT,
	QWEN3_4B_PROMPT,
	promptProfileFor,
} from "../../client/js/translate/prompts";
import {maxTokensFor} from "../../client/js/translate/engines/webllm";
import {placeholder} from "../../client/js/translate/spans";

const name = (code: string) => `<${code}>`;

function request(overrides: Partial<TranslateRequest> = {}): TranslateRequest {
	return {
		id: 1,
		model: QWEN3_1_7B_ID,
		text: "Ich schick dir gleich das Log.",
		from: "de",
		to: "en",
		purpose: "read",
		context: emptyContext(),
		...overrides,
	};
}

/** Every shape the prompt branches on. */
const REQUESTS: [string, TranslateRequest][] = [
	["bare", request()],
	[
		"unknown source with a hint",
		request({from: null, context: {...emptyContext(), sourceHint: "nl"}}),
	],
	[
		"context, names, terms, topic and a reply target",
		request({
			context: {
				...emptyContext(),
				topic: "release day",
				names: ["alice", "bob"],
				terms: [["rig", "Testaufbau"]],
				recent: [
					{nick: "alice", text: "morning"},
					{nick: "bob", text: "hallo", translated: "hello"},
				],
				replyTo: {nick: "alice", text: "where is the log?"},
			},
		}),
	],
	[
		"a write with voice, formality and a variant",
		request({
			purpose: "write",
			context: {
				...emptyContext(),
				formality: "formal",
				variant: "de-CH",
				voice: ["passt", "bin gleich da"],
			},
		}),
	],
	["casual address", request({context: {...emptyContext(), formality: "casual"}})],
	["a batch", request({lines: ["eins", "zwei", "drei"]})],
	["a placeholder", request({text: `siehe ${placeholder(1)} bitte`})],
	["literal marks", request({text: "das *wichtige* Log", markers: "literal"})],
	["tags", request({text: "das <1>wichtige</1> Log", markers: "tags"})],
	["a long line", request({text: "x".repeat(4000)})],
];

describe("translate/prompts", () => {
	it("picks the profile by model id, 1.7B's for any model without one", () => {
		expect(promptProfileFor(QWEN3_1_7B_ID)).to.equal(QWEN3_1_7B_PROMPT);
		expect(promptProfileFor(QWEN3_4B_ID)).to.equal(QWEN3_4B_PROMPT);
		expect(promptProfileFor("gemma-3-1b-it-q4f16_1-MLC")).to.equal(QWEN3_1_7B_PROMPT);
		expect(promptProfileFor(null)).to.equal(QWEN3_1_7B_PROMPT);
		expect(QWEN3_1_7B_PROMPT.modelId).to.equal(QWEN3_1_7B_ID);
		expect(QWEN3_4B_PROMPT.modelId).to.equal(QWEN3_4B_ID);
	});

	it("1.7B's profile is prompt.ts itself, so its output is today's byte for byte", () => {
		expect(QWEN3_1_7B_PROMPT.systemPrompt).to.equal(prompt.systemPrompt);
		expect(QWEN3_1_7B_PROMPT.userPrompt).to.equal(prompt.userPrompt);
		expect(QWEN3_1_7B_PROMPT.buildMessages).to.equal(prompt.buildMessages);
		expect(QWEN3_1_7B_PROMPT.KEEP_MARKS).to.equal(prompt.KEEP_MARKS);
		expect(QWEN3_1_7B_PROMPT.KEEP_TAGS).to.equal(prompt.KEEP_TAGS);
		expect(QWEN3_1_7B_PROMPT.ONLY_THE_TRANSLATION).to.equal(prompt.ONLY_THE_TRANSLATION);

		for (const [label, req] of REQUESTS) {
			expect(QWEN3_1_7B_PROMPT.buildMessages(req, name), label).to.deep.equal(
				prompt.buildMessages(req, name)
			);
			expect(QWEN3_1_7B_PROMPT.maxTokensFor(req), label).to.equal(maxTokensFor(req));
		}
	});

	it("4B's profile is its own module", () => {
		expect(QWEN3_4B_PROMPT.systemPrompt).to.not.equal(prompt.systemPrompt);
		expect(QWEN3_4B_PROMPT.userPrompt).to.not.equal(prompt.userPrompt);
		expect(QWEN3_4B_PROMPT.buildMessages).to.not.equal(prompt.buildMessages);
		expect(QWEN3_4B_PROMPT.maxTokensFor).to.not.equal(QWEN3_1_7B_PROMPT.maxTokensFor);
	});

	// 4B's wording started as a copy of 1.7B's and changes only from 4B's own
	// measurement; 1.7B's has since moved on its own (below). Any other
	// difference is what a 4B rewording is meant to break here.
	it("4B's profile renders what 1.7B's does", () => {
		expect(QWEN3_4B_PROMPT.KEEP_MARKS).to.equal(prompt.KEEP_MARKS);
		expect(QWEN3_4B_PROMPT.KEEP_TAGS).to.equal(prompt.KEEP_TAGS);
		expect(QWEN3_4B_PROMPT.ONLY_THE_TRANSLATION).to.equal(prompt.ONLY_THE_TRANSLATION);

		// Both say the marks sentence only where the line carries a mark,
		// each measured on its own web weights (casual set: 1.7B 32 -> 40,
		// 4B 30 -> 37 of 45 clean).
		const unmarked = request({text: "sounds good to me", markers: "literal"});

		expect(prompt.systemPrompt(unmarked, name)).to.not.include(prompt.KEEP_MARKS);
		expect(
			QWEN3_4B_PROMPT.systemPrompt({...unmarked, model: QWEN3_4B_ID}, name)
		).to.not.include(QWEN3_4B_PROMPT.KEEP_MARKS);

		for (const [label, req] of REQUESTS) {
			const messages = QWEN3_4B_PROMPT.buildMessages({...req, model: QWEN3_4B_ID}, name);

			expect(messages, label).to.deep.equal(prompt.buildMessages(req, name));
			expect(
				messages.map((m) => m.role),
				label
			).to.deep.equal(["system", "user"]);
			expect(QWEN3_4B_PROMPT.maxTokensFor(req), label).to.equal(maxTokensFor(req));
		}
	});
});
