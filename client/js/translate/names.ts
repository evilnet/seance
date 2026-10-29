// The names one message must not have translated (spec § prompt.ts, the
// names lever). The channel's user list is only part of the answer: a query
// has no user list at all, the sender of an old line may have left since,
// and someone who spoke ten lines ago is still a name rather than prose.
// One set feeds both the protection (`spans.ts` `protectNicks`) and the
// prompt's `Names:` list (`context.ts`), so what the model is told to keep
// is exactly what it never sees. Vue-free, store-free, DOM-free.

/** How far back the channel's own speakers are collected, newest first. */
export const RECENT_SPEAKERS = 50;

export interface NamesMessage {
	from?: {nick?: string};
}

export interface NamesSource {
	/** The channel's user list, when it has one. */
	users: {nick?: string}[];
	/** The nick this line came from: still a name once they have left. */
	sender?: string | null;
	/** The conversation's own name; only a query's is a nick. */
	target?: string | null;
	/** The channel's messages, oldest first; the speakers are read off them. */
	messages?: NamesMessage[];
}

/** A conversation whose name is a channel name, not a person's. */
function isChannelName(name: string): boolean {
	return name.startsWith("#") || name.startsWith("&");
}

/**
 * The nick set to protect, in the order the sources are named: the user
 * list, the sender, a query's target, then the channel's recent speakers
 * (newest first, capped). Empty names and duplicates are dropped; the first
 * spelling of a name wins, since a nick is matched case-insensitively.
 */
export function namesFor(source: NamesSource): string[] {
	const names: string[] = [];
	const seen = new Set<string>();

	const add = (name: string | undefined | null) => {
		if (!name) {
			return;
		}

		const key = name.toLowerCase();

		if (!seen.has(key)) {
			seen.add(key);
			names.push(name);
		}
	};

	for (const user of source.users) {
		add(user.nick);
	}

	add(source.sender);

	if (source.target && !isChannelName(source.target)) {
		add(source.target);
	}

	const messages = source.messages ?? [];
	let speakers = 0;

	for (let i = messages.length - 1; i >= 0 && speakers < RECENT_SPEAKERS; i--) {
		const nick = messages[i].from?.nick;

		if (!nick || seen.has(nick.toLowerCase())) {
			continue;
		}

		add(nick);
		speakers += 1;
	}

	return names;
}
