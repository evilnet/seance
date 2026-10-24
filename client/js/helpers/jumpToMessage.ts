// Taking a conversation to one message (the inbox's "open at the mention",
// docs/projects/inbox.md): find it in what is loaded, or page back through
// history with the ordinary `more` request until it is, then scroll to it.
// Paging back keeps the buffer one unbroken run (CHATHISTORY AROUND would
// leave a gap MessageList cannot show). Vue-free; MessageList.vue drives it,
// and Message.vue's jump to a reply's parent shares revealMessage.

/** Where to go. `id` is a message this page already holds (a query's first unread). */
export type JumpTarget = {
	chanId: number;
	msgid?: string;
	/** ISO 8601 server time: where to stop paging back, and the fallback. */
	time?: string;
	id?: number;
};

/** Pages of history a jump may ask for: each costs ~2 s of the server's fake lag. */
export const MAX_JUMP_PAGES = 3;

export type JumpStep =
	| {kind: "found"; id: number}
	| {kind: "more"}
	/** Not loaded and no more to ask: the first message at or after the time. */
	| {kind: "nearest"; id: number}
	| {kind: "none"};

type Loaded = {id: number; msgid?: string; time: Date | string};

const timeOf = (m: {time: Date | string}) => new Date(m.time).getTime();

/**
 * What to do next for `target` given the loaded `messages` (oldest first),
 * whether an older page can be asked for, and how many this jump has asked
 * for already.
 */
export function jumpStep(
	messages: readonly Loaded[],
	target: Omit<JumpTarget, "chanId">,
	canLoadMore: boolean,
	pagesAsked: number
): JumpStep {
	const hit = messages.find(
		(m) =>
			(target.id !== undefined && m.id === target.id) ||
			(!!target.msgid && m.msgid === target.msgid)
	);

	if (hit) {
		return {kind: "found", id: hit.id};
	}

	const time = target.time ? new Date(target.time).getTime() : NaN;

	if (Number.isNaN(time)) {
		return {kind: "none"};
	}

	const oldest = messages[0];

	if (canLoadMore && pagesAsked < MAX_JUMP_PAGES && (!oldest || timeOf(oldest) > time)) {
		return {kind: "more"};
	}

	const after = messages.find((m) => timeOf(m) >= time);
	return after ? {kind: "nearest", id: after.id} : {kind: "none"};
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
