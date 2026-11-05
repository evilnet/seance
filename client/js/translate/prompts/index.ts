// Which prompt profile a GPU model is asked with (prompts/profile.ts): 4B's
// for Qwen3-4B, 1.7B's — the measured prompt — for Qwen3-1.7B and for any
// model without a profile of its own (a deploy's).

import {QWEN3_4B_ID} from "../models";
import {PromptProfile} from "./profile";
import {QWEN3_1_7B_PROMPT} from "./qwen3-1.7b";
import {QWEN3_4B_PROMPT} from "./qwen3-4b";

export type {PromptProfile} from "./profile";
export {QWEN3_1_7B_PROMPT} from "./qwen3-1.7b";
export {QWEN3_4B_PROMPT} from "./qwen3-4b";

const PROFILES: Record<string, PromptProfile> = {
	[QWEN3_4B_ID]: QWEN3_4B_PROMPT,
};

export function promptProfileFor(modelId: string | null | undefined): PromptProfile {
	return (modelId && PROFILES[modelId]) || QWEN3_1_7B_PROMPT;
}
