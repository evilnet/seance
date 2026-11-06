// The composer's emoji picker (ChatInput.vue): typing `:` and two letters of
// a name opens the same picker the message toolbar's smiley does, its search
// seeded with what was typed, and the emoji picked takes the place of the
// `:name` in the draft. Vue-free: test/helpers/emojiTrigger.ts.

/** The `:name` being typed: where it starts (the colon) and ends (the caret). */
export type EmojiToken = {start: number; end: number; term: string};

// A colon at the start or after a space, then two or more name characters
// up to the caret: `:smi`, `:+1`, `:thumbs_up`. A time (10:30), a URL
// (https:) or a lone smiley (:-) or :)) never opens it.
const TOKEN = /(?:^|\s):([-+\w]{2,})$/;
// The same name with its closing colon just typed: `:tada:`.
const CLOSED = /(?:^|\s):([-+\w]{2,}):$/;

/** The token ending at `caret` in `text`, if one is being typed there. */
export function emojiToken(text: string, caret: number): EmojiToken | null {
	const match = TOKEN.exec(text.slice(0, caret));

	if (!match) {
		return null;
	}

	return {start: caret - match[1].length - 1, end: caret, term: match[1]};
}

/** `text` with the token replaced by `emoji`, and where the caret goes. */
export function replaceToken(
	text: string,
	token: EmojiToken,
	emoji: string
): {text: string; caret: number} {
	return {
		text: text.slice(0, token.start) + emoji + text.slice(token.end),
		caret: token.start + emoji.length,
	};
}

/**
 * A `:name:` whose closing colon ends at `caret`: the whole of it, both
 * colons, with the name as `term`. The composer turns it into its emoji
 * when the name is a shortcode (emoji.ts `emojiForName`), as typing
 * `:tada:` does in most chat apps.
 */
export function closedShortcode(text: string, caret: number): EmojiToken | null {
	const match = CLOSED.exec(text.slice(0, caret));

	if (!match) {
		return null;
	}

	return {start: caret - match[1].length - 2, end: caret, term: match[1]};
}
