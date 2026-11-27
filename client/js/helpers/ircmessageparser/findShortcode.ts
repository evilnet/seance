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

// U+FE0F (the emoji presentation selector) and the five skin tones: the map
// writes some emoji with the selector and none with a tone, and text brings
// either, so both sides of the lookup below are keyed without them.
const variantRx = /[\u{1f3fb}-\u{1f3ff}]|\u{fe0f}/gu;

// The other way round, for an emoji's tooltip (parse.ts): built the first
// time it is asked for, not at load, so the push worker, which loads this
// file for the finder below, never builds it.
let namesByEmoji: Map<string, string[]> | null = null;

/** Every shortcode name (without colons) that writes `emoji`, in the map's
 * (alphabetical) order: ["+1", "thumbsup"] for a thumbs up, whatever its skin
 * tone, and [] for one the map does not know. */
export function shortcodesForEmoji(emoji: string): string[] {
	if (!namesByEmoji) {
		namesByEmoji = new Map();

		for (const [name, char] of aliases) {
			const key = char.replace(variantRx, "");
			const names = namesByEmoji.get(key);

			if (names) {
				names.push(name);
			} else {
				namesByEmoji.set(key, [name]);
			}
		}
	}

	return namesByEmoji.get(emoji.replace(variantRx, "")) ?? [];
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
