import {Part} from "./merge";
import shortcodes from "./shortcodes.json";

// What the shortcode finder found: the character the alias stands for, and
// the `:name:` that was typed.
export type ShortcodePart = Part & {
	emoji: string;
	shortcode: string;
};

// The aliases as a Map, never the JSON object itself: the names come from
// other people's messages, and indexing a plain object with `constructor` or
// `__proto__` (both fit the pattern below) finds Object.prototype's members —
// truthy, not strings — which crashed the render for everyone who saw the
// line. A Map only knows the keys it was given.
const aliases = new Map(Object.entries(shortcodes as Record<string, string>));

/** The emoji a shortcode name (without its colons) stands for, if any. */
export function emojiForShortcode(name: string): string | undefined {
	return aliases.get(name);
}

// `:name:` for a name the map knows. Gating the match on the map is what
// keeps `10:30:45` from turning into emoji: `30` is not an alias, so nothing
// fires at all. Gemoji's aliases are lower-case words, digits, `_`, `-`, `+`.
const shortcodeRx = /:([a-z0-9_+-]+):/g;

function findShortcode(text: string): ShortcodePart[] {
	const result: ShortcodePart[] = [];
	let match: RegExpExecArray | null;

	while ((match = shortcodeRx.exec(text))) {
		const emoji = emojiForShortcode(match[1]);

		if (emoji) {
			result.push({
				start: match.index,
				end: match.index + match[0].length,
				emoji,
				shortcode: match[0],
			});
		}
	}

	return result;
}

export default findShortcode;
