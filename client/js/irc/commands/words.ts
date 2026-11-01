/**
 * The words of a command line, and the free text after them.
 *
 * `args` holds only the words: a doubled space (`/join  #foo`) is no empty
 * word in front of the channel. Free text — a reason, an action — is cut from
 * `rest`, so the spaces the user typed inside it stay as typed.
 */

/** The words of `rest`, split on runs of spaces. */
export function wordsOf(rest: string): string[] {
	return rest.split(" ").filter((word) => word.length > 0);
}

/** What follows the first `count` words of `rest`, as typed. */
export function textAfter(rest: string, count: number): string {
	let at = 0;

	const skipSpaces = () => {
		while (rest[at] === " ") {
			at++;
		}
	};

	for (let i = 0; i < count; i++) {
		skipSpaces();

		while (at < rest.length && rest[at] !== " ") {
			at++;
		}
	}

	skipSpaces();

	return rest.slice(at);
}
