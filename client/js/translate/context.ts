// The PromptContext for one message (spec § prompt.ts, the context levers):
// the last CONTEXT_LINES chat lines before it with the translations we
// already have, the reply target (the parent by msgid, else the last line
// of the nick the text addresses), the topic, the names the model must not
// translate (capped: the nicks in the context and the ones the text
// mentions, never the whole NAMES list; drawn from `opts.nicks`, the set
// `names.ts` built and `spans.ts` fenced, so every name listed was
// protected), the newest TERM_LINES of the
// channel's term memory merged with the deploy's glossary, and the
// detector's source hint. Vue-free: it reads plain channel-shaped objects.

import {ContextLine, PromptContext} from "./engine";
import {Formality} from "./channelStore";

export const CONTEXT_LINES = 10;
export const NAMES_CAP = 20;
/** How many of the channel's own terms one prompt carries, newest first out. */
export const TERM_LINES = 20;
/** The user's own recent lines in the target language quoted for a write (spec § prompt.ts). */
export const VOICE_LINES = 5;

const CHAT_TYPES = new Set(["message", "action", "notice"]);

export interface ContextMessage {
	id: number;
	type?: string;
	text?: string;
	from?: {nick?: string};
	msgid?: string;
	replyTo?: string;
	supersededBy?: number;
}

export interface ContextChannel {
	messages: ContextMessage[];
	users: {nick?: string}[];
	topic: string;
}

export interface ContextOptions {
	translated: (id: number) => string | undefined;
	/** The channel's term memory, oldest first (channelStore.ts). */
	terms: [string, string][];
	/** The deploy's `translation.glossary` (branding.ts), merged into the terms. */
	glossary: [string, string][];
	formality: Formality;
	variant: string;
	sourceHint: string | null;
	/** The user's earlier lines in the target language, oldest first (a write only). */
	voice?: string[];
	/**
	 * The names to match a mention and an address against, and the pool the
	 * prompt's `Names:` list is drawn from: `names.ts` `namesFor`, the same
	 * set `spans.ts` fenced. Without it the channel's user list stands in,
	 * which is what a caller with no message in hand (a tool, a test) has.
	 */
	nicks?: string[];
}

function nickMatching(word: string, nicks: string[]): string | null {
	const lower = word.toLowerCase();

	return nicks.find((nick) => nick.toLowerCase() === lower) ?? null;
}

/** `nick:` or `nick,` at the start of the line: IRC's way of addressing someone. */
export function addressedNick(text: string, nicks: string[]): string | null {
	const match = /^\s*([^\s:,]+)[:,]\s/.exec(text);

	return match ? nickMatching(match[1], nicks) : null;
}

export function mentionedNicks(text: string, nicks: string[]): string[] {
	const found: string[] = [];

	for (const word of text.split(/[^\p{L}\p{N}_\-[\]{}\\^`|]+/u)) {
		const nick = word ? nickMatching(word, nicks) : null;

		if (nick && !found.includes(nick)) {
			found.push(nick);
		}
	}

	return found;
}

function isChat(message: ContextMessage): boolean {
	return (
		message.type !== undefined &&
		CHAT_TYPES.has(message.type) &&
		message.supersededBy === undefined &&
		typeof message.text === "string" &&
		message.from !== undefined &&
		typeof message.from.nick === "string"
	);
}

function lineOf(message: ContextMessage, translated?: string): ContextLine {
	const line: ContextLine = {nick: message.from?.nick ?? "", text: message.text ?? ""};

	if (translated) {
		line.translated = translated;
	}

	return line;
}

export function buildContext(
	channel: ContextChannel,
	message: ContextMessage,
	opts: ContextOptions
): PromptContext {
	const index = channel.messages.findIndex((m) => m.id === message.id);
	const before = index >= 0 ? channel.messages.slice(0, index) : channel.messages;
	const recentMessages = before.filter(isChat).slice(-CONTEXT_LINES);
	const recent = recentMessages.map((m) => lineOf(m, opts.translated(m.id)));
	const nicks =
		opts.nicks ??
		channel.users.map((u) => u.nick).filter((n): n is string => typeof n === "string");
	const text = message.text ?? "";

	let replyTo: ContextLine | undefined;

	if (message.replyTo) {
		const parent = before.find((m) => m.msgid === message.replyTo && isChat(m));

		if (parent) {
			replyTo = lineOf(parent, opts.translated(parent.id));
		}
	}

	if (!replyTo) {
		const addressed = addressedNick(text, nicks);

		if (addressed) {
			const parent = [...before]
				.reverse()
				.find((m) => isChat(m) && m.from?.nick === addressed);

			if (parent) {
				replyTo = lineOf(parent, opts.translated(parent.id));
			}
		}
	}

	// Every name listed is a name the protection fenced, by construction and
	// not by the two windows happening to coincide: a recent speaker outside
	// `nicks` is dropped rather than listed, since asking the model to keep a
	// name it was never shown a placeholder for is the one thing this list
	// must not do. `mentionedNicks` is already drawn from `nicks`.
	const fenced = new Map(nicks.map((nick) => [nick.toLowerCase(), nick]));
	const names: string[] = [];

	for (const nick of [
		...recentMessages.map((m) => fenced.get((m.from?.nick ?? "").toLowerCase()) ?? ""),
		...mentionedNicks(text, nicks),
	]) {
		if (nick && !names.includes(nick)) {
			names.push(nick);
		}
	}

	// The newest TERM_LINES of the channel's own memory (rememberTerm
	// appends, so the tail is the newest) and the deploy's glossary behind
	// them, keyed by the source term with the channel's own winning; the
	// glossary is not subject to TERM_LINES, a deploy decides its own size.
	// Built fresh rather than copied: `opts.terms` can be a channel's live
	// term list (a Vue reactive Proxy), and the built context must be plain
	// data on its own, independent of any boundary guard.
	const terms: [string, string][] = [];
	const seen = new Set<string>();

	for (const [source, target] of [...opts.terms.slice(-TERM_LINES), ...opts.glossary]) {
		if (!seen.has(source)) {
			seen.add(source);
			terms.push([source, target]);
		}
	}

	const context: PromptContext = {
		recent,
		names: names.slice(0, NAMES_CAP),
		terms,
		voice: (opts.voice ?? []).slice(-VOICE_LINES),
		formality: opts.formality,
	};

	if (replyTo) {
		context.replyTo = replyTo;
	}

	if (channel.topic) {
		context.topic = channel.topic;
	}

	if (opts.sourceHint) {
		context.sourceHint = opts.sourceHint;
	}

	if (opts.variant) {
		context.variant = opts.variant;
	}

	return context;
}
