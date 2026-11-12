// What the reader is looking at (spec § Reading, scope): the one
// conversation on screen, and which of its lines are in view. Reading is on
// in every conversation, but only the one on screen does translation work:
// a conversation in the background routes nothing, downloads nothing and
// asks about nothing, and its lines are read when it is opened. Vue-free
// and DOM-free, so mocha loads it; reader.ts owns the one instance and
// feeds it from the store (the active channel), the document's visibility,
// and MessageList.vue's line observer.
//
// "On screen" is the chat view showing a conversation in a visible page.
// The active channel alone is not enough: it stays set while a phone has
// the app in the background, and router.ts clears it while Settings is
// open, which is the same answer for a different reason.

export type OnScreenChange =
	/** Another conversation is on screen (`to`), or none; `from` was, and is no longer. */
	| {kind: "conversation"; from: number | null; to: number | null}
	/** Lines of the conversation on screen came into view. */
	| {kind: "lines"; chanId: number}
	/** A line of the conversation on screen went out of view. */
	| {kind: "left"; chanId: number; messageId: number};

export class OnScreen {
	private conversation: number | null = null;
	private pageShown = true;
	private lines = new Map<number, Set<number>>();
	private shown = new Map<number, Set<number>>();
	private listeners: ((change: OnScreenChange) => void)[] = [];

	/** The conversation on screen: the chat's channel in a visible page, or null. */
	current(): number | null {
		return this.pageShown ? this.conversation : null;
	}

	/** The chat view shows `chanId` (or nothing). */
	show(chanId: number | null): void {
		this.update(() => {
			this.conversation = chanId;
		});
	}

	/** The page became visible or hidden (`document.visibilityState`). */
	setPageShown(shown: boolean): void {
		this.update(() => {
			this.pageShown = shown;
		});
	}

	/**
	 * A line came into view or left it (MessageList.vue's observer, which
	 * counts a margin around the visible part as in view). Kept for every
	 * conversation, so that coming back to one knows where its reader is;
	 * heard only for the one on screen.
	 */
	setLine(chanId: number, messageId: number, inView: boolean): void {
		let ids = this.lines.get(chanId);

		if (inView) {
			if (!ids) {
				ids = new Set();
				this.lines.set(chanId, ids);
			}

			if (ids.has(messageId)) {
				return;
			}

			ids.add(messageId);
		} else if (!ids?.delete(messageId)) {
			return;
		}

		if (chanId === this.current()) {
			this.emit(inView ? {kind: "lines", chanId} : {kind: "left", chanId, messageId});
		}
	}

	/**
	 * A line is on the visible part of the scroller itself, not only in the
	 * margin around it (MessageList.vue's second observer). Heard by no one:
	 * it only orders a scan, which reads what the reader sees before what
	 * they may scroll to (`linesToRead`).
	 */
	setVisible(chanId: number, messageId: number, visible: boolean): void {
		let ids = this.shown.get(chanId);

		if (visible) {
			if (!ids) {
				ids = new Set();
				this.shown.set(chanId, ids);
			}

			ids.add(messageId);
		} else {
			ids?.delete(messageId);
		}
	}

	/** The ids of `chanId`'s lines in view, in no particular order. */
	inView(chanId: number): ReadonlySet<number> {
		return this.lines.get(chanId) ?? new Set();
	}

	/** The ids of `chanId`'s lines on the visible part itself (`setVisible`). */
	visible(chanId: number): ReadonlySet<number> {
		return this.shown.get(chanId) ?? new Set();
	}

	/** A conversation that is gone (a part, a quit): its lines are forgotten. */
	forget(chanId: number): void {
		this.lines.delete(chanId);
		this.shown.delete(chanId);
	}

	/** Hear every change; the returned function stops it. */
	onChange(listener: (change: OnScreenChange) => void): () => void {
		this.listeners.push(listener);

		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	private update(change: () => void): void {
		const before = this.current();

		change();

		const after = this.current();

		if (before !== after) {
			this.emit({kind: "conversation", from: before, to: after});
		}
	}

	private emit(change: OnScreenChange): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(change);
			} catch (error) {
				// eslint-disable-next-line no-console
				console.error("translation: an on-screen listener failed", error);
			}
		}
	}
}

/**
 * The lines to read now: those of `messages` (oldest first, as a channel
 * keeps them) that are in view and that `wanted` still asks for, at most
 * `cap` of them. The ones on the visible part itself (`visible`) come
 * first, then the rest of the margin around it, each newest first: newest
 * because the reader of a live conversation is usually at its end, and the
 * newest of a page that just landed are the ones nearest where they were.
 */
export function linesToRead<T extends {id: number}>(
	messages: readonly T[],
	inView: ReadonlySet<number>,
	wanted: (message: T) => boolean,
	cap: number,
	visible: ReadonlySet<number> = new Set()
): T[] {
	const seen: T[] = [];
	const near: T[] = [];

	if (inView.size === 0 || cap <= 0) {
		return seen;
	}

	for (let i = messages.length - 1; i >= 0 && seen.length < cap; i--) {
		const message = messages[i];

		if (inView.has(message.id) && wanted(message)) {
			(visible.has(message.id) ? seen : near).push(message);
		}
	}

	return [...seen, ...near].slice(0, cap);
}
