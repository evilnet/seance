// Whether translation runs at all, and the life of the one service that
// does it. Vue-free and store-free, so mocha loads it: index.ts holds the
// app's switch over the store's settings and branding, reader.ts and
// writer.ts listen to it (test/translate/switch.ts, and the off sequence
// over a real service and queue in test/translate/service.ts).
//
// Translation ships switched off (settings.ts `translationEnabled`, default
// false). While it is off nothing of it exists: no service, so no device
// probe and no worker, no queue, no strip, and every surface that offers it
// renders nothing. The per-channel choices (`thelounge.translate`), the
// downloaded models and the download consents are left alone, so switching
// it back on picks up where it was, without a reload.

/** The deploy's `translation` block, as far as this rule reads it (branding.ts). */
export interface DeployTranslation {
	/** Default true: a deploy switches the feature off with `false`. */
	enabled?: boolean;
}

/**
 * The one rule every surface asks: translation is on only where the deploy
 * allows it (config.json `translation.enabled`, default true) and the user
 * switched it on (Settings → Translation, `translationEnabled`, default
 * false). A setting that was never stored, or is not a boolean, is off.
 */
export function translationAllowed(
	deploy: DeployTranslation | null | undefined,
	setting: unknown
): boolean {
	return deploy?.enabled !== false && setting === true;
}

/**
 * Why translation is off, as the block the rule reports (models.ts
 * `ModelBlock`), or null while it is on: the deploy's `disabled` when the
 * deploy switched it off, whatever the setting says; the user's
 * (`by: "user"`) otherwise. Null exactly where `translationAllowed` is true.
 */
export function translationOffBlock(
	deploy: DeployTranslation | null | undefined,
	setting: unknown
): {kind: "disabled"; by?: "user"} | null {
	if (deploy?.enabled === false) {
		return {kind: "disabled"};
	}

	return setting === true ? null : {kind: "disabled", by: "user"};
}

/**
 * Whether the reading pipeline looks at a line at all: never while
 * translation is off, not even one someone asked for (`force`, the
 * toolbar's Translate and the chip's Retranslate, which are not offered
 * then); while on, a line of a conversation that reads (`readsHere`), or
 * one someone asked for -- in an excluded conversation too, which is the
 * way past an exclusion for one line.
 */
export function considersLine(on: boolean, reads: boolean, force: boolean): boolean {
	return on && (force || reads);
}

/** The kinds of conversation reading covers: a channel and a query, never a lobby or a list. */
export const READ_KINDS: readonly string[] = ["channel", "query"];

/**
 * The one effective-reading rule (spec § Reading), asked at every way into
 * reading -- a live line, a history page, a replay, the topic, a change of
 * language, a retry: translation is on, the conversation is a channel or a
 * query, and the user did not say "Don't translate here" in it
 * (channelStore.ts `exclude`). Nothing else switches reading on or off; a
 * write target in particular does not.
 */
export function readsHere(on: boolean, kind: string, excluded: boolean): boolean {
	return on && READ_KINDS.includes(kind) && !excluded;
}

export interface SwitchDeps<S> {
	/** The rule as it stands now (`translationAllowed` over the store, in the app). */
	on(): boolean;
	/** Make the service: called on the first ask while on, never while off. */
	create(): S;
	/** Take a service down for good: its worker, its timers, what it registered. */
	destroy(service: S): void;
}

/**
 * The service while translation is on, made on the first ask; nothing while
 * it is off, and nothing is made. A change of the rule is acted on at the
 * next ask or `sync()`, whichever comes first (index.ts also syncs from a
 * store watch, so a switch-off tears down at once even when nothing asks):
 *
 * - **Off**: the service is out of reach first (`service()` and `current()`
 *   answer null), then the listeners hear it -- the reader cancels its
 *   queues and the composer its strips while the service still stands, so
 *   a line in flight is dropped by its own queue rather than failing on a
 *   disposed worker and counting toward a pause -- and only then is it
 *   destroyed.
 * - **On**: the listeners hear it (the reader starts its reading channels
 *   over); the service itself is made by the first thing that needs it.
 *
 * A listener that throws is logged and passed over: the others still hear
 * the change and an off still destroys the service.
 */
export class TranslationSwitch<S> {
	private made: S | null = null;
	private was: boolean;
	private listeners: ((on: boolean) => void)[] = [];

	constructor(private deps: SwitchDeps<S>) {
		this.was = deps.on();
	}

	/** Whether translation is on, the change acted on first. */
	get on(): boolean {
		this.sync();

		return this.was;
	}

	/** The service, made now if it is not yet; null while off. */
	service(): S | null {
		this.sync();

		if (!this.was) {
			return null;
		}

		this.made ??= this.deps.create();

		return this.made;
	}

	/** The service if one has been made and translation is still on; never makes one. */
	current(): S | null {
		this.sync();

		return this.made;
	}

	/** Act on a change of the rule; nothing when it has not changed. */
	sync(): void {
		const now = this.deps.on();

		if (now === this.was) {
			return;
		}

		this.was = now;

		const going = now ? null : this.made;

		if (!now) {
			this.made = null;
		}

		// One listener that throws must not stop the others, nor leave the
		// worker running: each is heard on its own, and the destroy comes
		// whatever they did. sync() runs inside every ask and the store's
		// watch, so a failure is logged here rather than thrown into them.
		try {
			for (const listener of [...this.listeners]) {
				try {
					listener(now);
				} catch (error) {
					// eslint-disable-next-line no-console
					console.error("translation switch: a listener failed", error);
				}
			}
		} finally {
			if (going) {
				try {
					this.deps.destroy(going);
				} catch (error) {
					// eslint-disable-next-line no-console
					console.error("translation switch: taking the service down failed", error);
				}
			}
		}
	}

	/** Hear every change; the returned function stops it. */
	onChange(listener: (on: boolean) => void): () => void {
		this.listeners.push(listener);

		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}
}
