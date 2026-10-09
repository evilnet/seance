/**
 * The conventional field names a classified server notice carries, and how
 * the UI shows each one. A profile's classifier should use these names so a
 * template renders a nick as a nick, an IP as an IP chip with oper actions,
 * an expiry as a relative time. Anything else renders as plain text.
 */

export type FieldType = "nick" | "ip" | "host" | "mask" | "server" | "channel" | "expiry" | "text";

export const FIELD_TYPES: Record<string, FieldType> = {
	nick: "nick", // the user the notice is about
	newNick: "nick",
	oper: "nick", // the oper who did it
	killer: "nick",
	ip: "ip",
	host: "host", // user@host or host
	mask: "mask", // a ban mask
	server: "server",
	uplink: "server",
	channel: "channel",
	/** Unix seconds when something expires. */
	expires: "expiry",
	// Plain text: user, realname, class, reason, type, scope, modes, count,
	// numnick, level, changes, path, …
};

export function fieldType(name: string): FieldType {
	return FIELD_TYPES[name] ?? "text";
}

/**
 * Split a template into literal text and `{field}` placeholders, for a
 * renderer to interleave. A placeholder whose field is missing is dropped
 * along with nothing else, so a template should not depend on optional
 * fields for its grammar.
 */
export function splitTemplate(
	template: string,
	fields: Record<string, string>
): ({text: string} | {field: string; value: string})[] {
	const parts: ({text: string} | {field: string; value: string})[] = [];
	const re = /\{(\w+)\}/g;
	let last = 0;
	let m: RegExpExecArray | null;

	while ((m = re.exec(template))) {
		if (m.index > last) {
			parts.push({text: template.slice(last, m.index)});
		}

		const value = fields[m[1]];

		if (value !== undefined && value !== "") {
			parts.push({field: m[1], value});
		}

		last = re.lastIndex;
	}

	if (last < template.length) {
		parts.push({text: template.slice(last)});
	}

	return parts;
}

/** A template filled in as plain text (tooltips, notifications, copy). */
export function fillTemplate(template: string, fields: Record<string, string>): string {
	return splitTemplate(template, fields)
		.map((part) => ("text" in part ? part.text : part.value))
		.join("");
}
