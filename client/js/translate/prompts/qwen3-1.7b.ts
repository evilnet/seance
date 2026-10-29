// Qwen3-1.7B's prompt profile: exactly the prompt this layer was measured
// with (prompt.ts, where the reasons for every clause are written down) —
// its builders and sentences are prompt.ts's own, not copies, so
// test/translate/prompt.ts pins this profile byte for byte.

import {TranslateRequest} from "../engine";
import {QWEN3_1_7B_ID} from "../models";
import {
	KEEP_MARKS,
	KEEP_TAGS,
	ONLY_THE_TRANSLATION,
	buildMessages,
	estimateTokens,
	systemPrompt,
	userPrompt,
} from "../prompt";
import {PromptProfile} from "./profile";

export function maxTokensFor(req: TranslateRequest): number {
	const input = req.lines ? req.lines.join("\n") : req.text;

	// 3 × the input: room for the model to echo the line once before it
	// translates (the scan drops the echo) and still finish. + 16: the empty
	// thinking block WebLLM prepends when thinking is off. Measured against
	// the real model, the longest case of the evaluation set (four sentences,
	// ~60 input tokens) finished well inside it.
	return Math.min(512, 3 * estimateTokens(input) + 48 + 16);
}

export const QWEN3_1_7B_PROMPT: PromptProfile = {
	modelId: QWEN3_1_7B_ID,
	systemPrompt,
	userPrompt,
	buildMessages,
	maxTokensFor,
	KEEP_MARKS,
	KEEP_TAGS,
	ONLY_THE_TRANSLATION,
};
