// Taking a conversation to one message (a mention, a quote, a search hit): find
// it in what is loaded and scroll to it; if it is not, MessageList.vue opens a
// past view around it (client/js/pastView.ts). Vue-free.

/** Where to go. `id` is a message this page already holds. */
export type JumpTarget = {
	chanId: number;
	msgid?: string;
	id?: number;
};

export type JumpStep =
	| {kind: "found"; id: number}
	/** Nothing can be told until the channel's first page has landed. */
	| {kind: "first-page"}
	| {kind: "missing"};

type Loaded = {id: number; msgid?: string; supersededBy?: number};

/**
 * What to do next for `target` given the loaded `messages`, and whether the
 * channel's first page may still be to come.
 */
export function jumpStep(
	messages: readonly Loaded[],
	target: Omit<JumpTarget, "chanId">,
	firstPageDue: boolean
): JumpStep {
	const hit = messages.find(
		(m) =>
			(target.id !== undefined && m.id === target.id) ||
			(!!target.msgid && m.msgid === target.msgid)
	);

	if (hit) {
		return {kind: "found", id: hit.supersededBy ?? hit.id};
	}

	return firstPageDue ? {kind: "first-page"} : {kind: "missing"};
}

/** Scroll `el` (a message row) to the middle of its list and flash it once. */
export function revealMessage(el: HTMLElement): void {
	el.scrollIntoView({block: "center", inline: "nearest"});

	if (typeof el.animate === "function") {
		el.animate(
			[{backgroundColor: "var(--highlight-bg-color)"}, {backgroundColor: "transparent"}],
			{duration: 1500, easing: "ease-out"}
		);
	}
}
