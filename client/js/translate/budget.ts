// The token budget of one LLM request (spec § engines/webllm.ts, docs/
// resources/translation.md § Phones and small GPUs): the prompt WebLLM is
// handed must fit the context window the model was loaded with, with room
// for the reply. WebLLM checks only the prompt (and throws
// `ContextWindowSizeExceededError` past it); a reply that reaches the end of
// the window just stops, so a batch comes back with lines missing and a
// single line comes back cut — both look like answers. So the reply's own
// budget (`PromptProfile.maxTokensFor`) is reserved here too.
//
// There is no tokenizer in the worker before the model is loaded, and none
// under mocha, so the count is a bound: `tokenBound` gives every character
// class at least the tokens Qwen3's byte-level BPE spends on it in chat text
// (calibrated against the real tokenizer, test/translate/budget.ts holds the
// fixtures). It over-counts prose — English by about 1.3×, Japanese 1.6× —
// and can under-count adversarial text (a run of rare CJK ideographs, a
// long random string without digits), which is what the engine's
// backstop is for: WebLLM's own overflow is retried bare and alone
// (engines/webllm.ts, queue.ts).
//
// Over the window, the context goes first, least useful first: the oldest
// earlier lines, then the channel's terms (oldest first, the deploy's
// glossary last), the names, the user's earlier lines, each batched line's
// reply note, the topic and the reply target. A request that still does not
// fit is refused (`fitToWindow` answers null): a batch is then sent one line
// at a time, and a single line is too long for this window. Vue-free.

import {ContextLine, TranslateRequest} from "./engine";
import type {ChatMessage} from "./prompt";
import type {LanguageNamer, PromptProfile} from "./prompts/profile";

/**
 * The chat frame around the two messages, in tokens: WebLLM's Qwen3
 * template (`<|im_start|>system\n…<|im_end|>\n<|im_start|>user\n…<|im_end|>\n
 * <|im_start|>assistant\n`) and the empty `<think>\n\n</think>\n\n` block it
 * pushes with thinking off — 15 tokens with the real tokenizer — with room
 * to spare for a template that adds a little.
 */
export const CHAT_FRAME_TOKENS = 24;

/** Tokens per character class (`tokenBound`): see the fixtures in test/translate/budget.ts. */
const PER_DIGIT = 1; // Qwen3 splits numbers into single digits
const PER_ASCII_SYMBOL = 1;
const PER_NEWLINE = 1;
/** An ASCII word costs a token per this many letters, rounded up (a word is at least one). */
const LETTERS_PER_TOKEN = 4;
/**
 * An accented Latin letter (Latin-1, Latin Extended, Vietnamese's Latin
 * Extended Additional) is part of the word it is in, and costs this much
 * more: it is usually a token boundary.
 */
const LATIN_ACCENT_SURCHARGE = 1;
/** The other two-byte scripts: Greek, Cyrillic, Armenian, Hebrew, Arabic, … */
const PER_TWO_BYTE = 0.6;
/** Hangul, and the CJK ideographs, kana and punctuation chat uses. */
const PER_HANGUL = 0.8;
const PER_CJK = 0.8;
const PER_THAI = 0.7;
/** Every other three-byte character: Devanagari, symbols, rare scripts. */
const PER_THREE_BYTE = 1;
/** Four bytes: emoji and the rest of the astral planes. */
const PER_ASTRAL = 2;
/** A two-byte combining mark (Latin diacritics stacked as in zalgo, Arabic harakat): rarely merged. */
const PER_MARK = 2;

const MARK = /\p{M}/u;

/**
 * An upper bound on the Qwen3 tokens of `text`, for chat text: never below
 * the real count on the calibration fixtures (every script the app
 * translates, URLs, digits, hex, emoji, rare CJK, zalgo).
 */
export function tokenBound(text: string): number {
	let tokens = 0;
	let word = 0;
	let spaces = 0;

	const settleSpaces = (code: number, char: string) => {
		if (spaces > 0) {
			const rides = code < 0x80 ? isAsciiLetter(code) : code < 0x800 && !MARK.test(char);

			tokens += rides ? spaces - 1 : spaces;
			spaces = 0;
		}
	};

	const endWord = () => {
		if (word > 0) {
			tokens += Math.ceil(word / LETTERS_PER_TOKEN);
			word = 0;
		}
	};

	for (const char of text) {
		const code = char.codePointAt(0)!;

		if (isAsciiLetter(code) || isLatinAccented(code)) {
			settleSpaces(code, char);
			word++;

			if (code >= 0x80) {
				tokens += LATIN_ACCENT_SURCHARGE;
			}

			continue;
		}

		endWord();

		if (code === 0x20) {
			spaces++;
			continue;
		}

		// A space rides on the letter word after it (" word", " слово" are
		// one token each) but is a token of its own before a digit, a
		// symbol or an ideograph.
		settleSpaces(code, char);

		if (code >= 0x30 && code <= 0x39) {
			tokens += PER_DIGIT;
		} else if (code === 0x0a || code === 0x0d || code === 0x09) {
			tokens += PER_NEWLINE;
		} else if (code < 0x80) {
			tokens += PER_ASCII_SYMBOL;
		} else if (code < 0x800) {
			tokens += MARK.test(char) ? PER_MARK : PER_TWO_BYTE;
		} else if (code < 0x10000) {
			tokens += threeByte(code);
		} else {
			tokens += PER_ASTRAL;
		}
	}

	endWord();
	tokens += spaces;

	return Math.ceil(tokens);
}

function isAsciiLetter(code: number): boolean {
	return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** Latin-1 and Latin Extended-A/B letters (not × or ÷), and Latin Extended Additional. */
function isLatinAccented(code: number): boolean {
	return (
		(code >= 0xc0 && code <= 0x24f && code !== 0xd7 && code !== 0xf7) ||
		(code >= 0x1e00 && code <= 0x1eff)
	);
}

function threeByte(code: number): number {
	if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) {
		return PER_HANGUL;
	}

	if (
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0x3000 && code <= 0x30ff) ||
		(code >= 0xff00 && code <= 0xffef)
	) {
		return PER_CJK;
	}

	if (code >= 0x0e00 && code <= 0x0e7f) {
		return PER_THAI;
	}

	return PER_THREE_BYTE;
}

/** The bound on a whole prompt: every message's text and the chat frame. */
export function promptBound(messages: ChatMessage[]): number {
	return (
		CHAT_FRAME_TOKENS + messages.reduce((sum, message) => sum + tokenBound(message.content), 0)
	);
}

/** What one request costs in the window: its prompt's bound and its reply's budget. */
export function requestTokens(
	req: TranslateRequest,
	profile: PromptProfile,
	name: LanguageNamer
): number {
	return promptBound(profile.buildMessages(req, name)) + profile.maxTokensFor(req);
}

/** The request with a copy of its context (and of the parts `fitToWindow` takes from). */
function withOwnContext(req: TranslateRequest): TranslateRequest {
	const c = req.context;

	return {
		...req,
		context: {
			...c,
			recent: [...c.recent],
			names: [...c.names],
			terms: [...c.terms],
			voice: [...c.voice],
		},
		...(req.lineContexts ? {lineContexts: req.lineContexts.map((lc) => ({...lc}))} : {}),
	};
}

/**
 * `req` as it fits a window of `window` tokens (`requestTokens`), the
 * context trimmed least useful first; `req` itself when it fits as it is,
 * and null when it does not fit even with no context at all. Never
 * modifies `req`.
 */
export function fitToWindow(
	req: TranslateRequest,
	window: number,
	profile: PromptProfile,
	name: LanguageNamer
): TranslateRequest | null {
	const fits = (r: TranslateRequest) => requestTokens(r, profile, name) <= window;

	if (fits(req)) {
		return req;
	}

	const r = withOwnContext(req);
	const c = r.context;
	// One step at a time, cheapest loss first; each returns false once
	// there is nothing left for it to take.
	const steps: (() => boolean)[] = [
		() => c.recent.shift() !== undefined,
		() => c.terms.shift() !== undefined,
		() => c.names.shift() !== undefined,
		() => c.voice.shift() !== undefined,
		() => {
			const notes = r.lineContexts;
			const i = notes ? notes.findIndex((lc) => lc.replyTo) : -1;

			if (!notes || i < 0) {
				return false;
			}

			notes[i] = {};
			return true;
		},
		() => dropKey(c, "topic"),
		() => dropKey(c, "replyTo"),
	];

	for (const step of steps) {
		while (step()) {
			if (fits(r)) {
				return r;
			}
		}
	}

	return null;
}

function dropKey(
	context: {topic?: string; replyTo?: ContextLine},
	key: "topic" | "replyTo"
): boolean {
	if (context[key] === undefined) {
		return false;
	}

	delete context[key];
	return true;
}
