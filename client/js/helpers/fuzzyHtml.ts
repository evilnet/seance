import {filter} from "fuzzy";
import escape from "lodash/escape";

// Private-use characters mark the matched letters while the text is raw, so
// the escape below cannot touch them and a name holding `<` still matches.
const PRE = "\uE000";
const POST = "\uE001";

/**
 * `fuzzy.filter` whose `string` is safe to render as HTML: the item's text
 * escaped, the matched letters in `<b>`. A nick or channel name comes from
 * the server or another user and may hold markup (`#x<img onerror=…>`).
 */
export function fuzzyHtml<T>(
	term: string,
	items: T[],
	extract: (item: T) => string
): {string: string; original: T}[] {
	return filter(term, items, {pre: PRE, post: POST, extract}).map((result) => ({
		string: escape(result.string).split(PRE).join("<b>").split(POST).join("</b>"),
		original: result.original,
	}));
}
