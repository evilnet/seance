// A prompt profile: everything about how one GPU model is asked to translate
// — the system and user messages, the sentences said about marks and tags,
// the closing instruction, and the token budget a reply gets. The prompt was
// tuned on one model, and another reacts differently to the same wording
// (the float16 1.7B build already wrapped casual answers in markdown marks),
// so each model has its own profile and its wording changes without
// touching another's. `WebLlmEngine` picks the loaded model's profile.
//
// What is not per model stays in prompt.ts: the batch sentinel and the
// output parsing the queue and the composer share (`END_SENTINEL`,
// `parseBatchedOutput`, `cleanOutput`), and the canned answers the engine
// refuses (`EXAMPLES`).

import {TranslateRequest} from "../engine";
import {ChatMessage} from "../prompt";

export type LanguageNamer = (code: string) => string;

export interface PromptProfile {
	/** The GPU model id the profile was written for. */
	modelId: string;
	// Function-typed fields rather than methods: a profile is a record of
	// plain functions (prompt.ts's own, for 1.7B), never bound to it.
	systemPrompt: (req: TranslateRequest, name: LanguageNamer) => string;
	userPrompt: (req: TranslateRequest, name: LanguageNamer) => string;
	buildMessages: (req: TranslateRequest, name: LanguageNamer) => ChatMessage[];
	/** The reply's token budget (`max_tokens`). */
	maxTokensFor: (req: TranslateRequest) => number;
	/** Said when the text carries markdown marks (`markers: "literal"`). */
	KEEP_MARKS: string;
	/** Said when the text carries numbered tags (`markers: "tags"`). */
	KEEP_TAGS: string;
	/** The last instruction before the line, when anything stands above it. */
	ONLY_THE_TRANSLATION: string;
}
