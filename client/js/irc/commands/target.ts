/**
 * Splitting `<target> <body>` off the rest of a command line.
 */

/** A command's target and everything after it. */
export interface TargetAndBody {
	/** The first token (past any leading spaces), or "" when there is none. */
	target: string;
	/** Everything after the single separator, line feeds included. */
	body: string;
}

/**
 * Take the leading target off `rest`.
 *
 * The separator is a space **or a line feed**: with `draft/multiline` the
 * user's second line follows the first straight after `/msg nick`, and the
 * target must never take the line feed with it — `formatLine` throws on a
 * parameter containing CR/LF (outside the sender's try/catch), and `/query`
 * would open a window for the garbage name first. A target is one run of
 * non-whitespace by construction, so nothing that reaches the wire or
 * {@link Channel} names can carry a separator.
 */
export function splitTarget(rest: string): TargetAndBody {
	const match = /^ *(\S+)(?:[ \n]([\s\S]*))?$/.exec(rest);

	return match ? {target: match[1], body: match[2] ?? ""} : {target: "", body: ""};
}
