// The system's own translator in the iOS shell: Apple's Translation
// framework through the shell's `AppleTranslate` plugin
// (shells/tauri/src-tauri/ios/Sources/SeanceIOS/AppleTranslate.swift,
// answered by SeancePlugin's `call`). Nothing is downloaded by the page and
// nothing runs in the worker: the shell's bridge (helpers/shell.ts) exists
// only on the main thread, so this engine is called from service.ts
// directly, never through the worker's protocol.
//
// Measured against the page's own engines on the same sets
// (docs/projects/translation-apple-eval.md): the `low` strategy (Apple's
// downloaded language packs, ~80 ms a line on an M2 Max) beat every model
// the page ships, kept ⟦n⟧ placeholders in every line and emoji in nearly
// all. `high` is Apple's on-device 3B model, 13–27× slower and only
// sometimes better.
//
// A pair is taken when its pack is installed (`status`). A pair whose pack
// can be downloaded is offered once (`offer`): the system's own sheet, the
// first time a translation needs it, as the page asks before downloading a
// model of its own (consent.ts). One sheet at a time: a channel opened with
// lines in several languages queues one offer per pair, and every one the
// shell is handed is a sheet the user has to close, so they wait their turn
// and are dropped once the switch goes off or a sheet is declined, which
// holds every other offer back for the page load as consent.ts's "not now"
// does. Declined, or the pair unsupported, the router falls through to the
// route table, so a missing pack never blocks a translation. Settings asks
// about a pack directly (`prepare`).
//
// Vue-free and DOM-free behind `AppleDeps`, so mocha drives it with a fake
// bridge (test/translate/apple.ts).

/** The shell plugin's `jsName`. */
export const APPLE_PLUGIN = "AppleTranslate";

/** `LanguageAvailability`'s answer: the pack is on the device, can be, or the pair does not exist. */
export type AppleStatus = "installed" | "supported" | "unsupported";
export type AppleStrategy = "low" | "high";

export interface AppleDeps {
	/** A call to the plugin; rejects with an error carrying the plugin's `code` (helpers/shell.ts `NativeCallError`). */
	invoke<T>(method: string, options: Record<string, unknown>): Promise<T>;
}

export interface AppleOptions {
	strategy: AppleStrategy;
	/** Mark every ⟦n⟧ placeholder `skipsTranslation` (iOS 26.4+). */
	skip: boolean;
}

/** What the download sheet left: the pair's status, and the plugin's error code when it did not finish. */
export interface PrepareResult {
	status: AppleStatus;
	error?: string;
}

/** A plugin rejection, or a bridge that is not there (`unavailable`). */
export class AppleError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = "AppleError";
	}
}

export class AppleTranslator {
	private statuses = new Map<string, Promise<AppleStatus>>();
	/**
	 * The answers so far, for the UI's synchronous questions (reader.ts
	 * `pairVerdict`): a row that says "a 108 MB download" for a pair Apple
	 * translates is a promise the router never keeps.
	 */
	private known = new Map<string, AppleStatus>();
	/** Told when an answer arrives or the answers are forgotten. */
	private listeners = new Set<() => void>();
	/** Sheets open now, one per pair, every request for the pair waiting on it. */
	private offers = new Map<string, Promise<boolean>>();
	/** Pairs offered on this page load: declined, or downloading in the background. */
	private offered = new Set<string>();
	/** Accepted and still downloading: their status is asked afresh until it is `installed`. */
	private pending = new Set<string>();
	/** The sheet up now, or the last one: the next offer waits for it. */
	private sheet: Promise<unknown> = Promise.resolve();
	/** A sheet was declined: no other is offered on this page load. */
	private declined = false;
	private deps: AppleDeps;
	private options: AppleOptions;

	constructor(deps: AppleDeps, options: AppleOptions = {strategy: "low", skip: false}) {
		this.deps = deps;
		this.options = options;
	}

	setOptions(options: AppleOptions): void {
		if (options.strategy !== this.options.strategy) {
			this.statuses.clear();
			this.known.clear();
			this.notify();
		}

		this.options = options;
	}

	/**
	 * The pair's status, asked once and kept: a pack only changes when the
	 * user downloads or deletes one, and `forget` is called on both paths
	 * this engine sees (`prepare`, a `notInstalled` answer). A bridge that
	 * does not answer is `unsupported`.
	 */
	status(from: string, to: string): Promise<AppleStatus> {
		const key = this.key(from, to);
		let status = this.pending.has(key) ? undefined : this.statuses.get(key);

		if (!status) {
			status = this.deps
				.invoke<{status: AppleStatus}>("availability", {
					from,
					to,
					strategy: this.options.strategy,
				})
				.then(
					(answer) => {
						if (answer.status === "installed") {
							this.pending.delete(key);
						}

						this.learn(key, answer.status);

						return answer.status;
					},
					() => {
						this.learn(key, "unsupported");

						return "unsupported" as const;
					}
				);
			this.statuses.set(key, status);
		}

		return status;
	}

	async installed(from: string, to: string): Promise<boolean> {
		return (await this.status(from, to)) === "installed";
	}

	/**
	 * The pair's status as last answered, without asking: undefined until an
	 * answer has come. `lookup` asks for it once.
	 */
	knownStatus(from: string, to: string): AppleStatus | undefined {
		return this.known.get(this.key(from, to));
	}

	/** Ask for the pair's status unless it is known or already asked; `onKnown` hears the answer. */
	lookup(from: string, to: string): void {
		const key = this.key(from, to);

		if (!this.known.has(key) && !this.statuses.has(key)) {
			void this.status(from, to);
		}
	}

	/** `listener` runs when a status arrives or the statuses are forgotten. */
	onKnown(listener: () => void): void {
		this.listeners.add(listener);
	}

	/** Every pair's status asked again on next use. */
	forget(): void {
		this.statuses.clear();
		this.known.clear();
		this.notify();
	}

	private learn(key: string, status: AppleStatus): void {
		if (this.known.get(key) !== status) {
			this.known.set(key, status);
			this.notify();
		}
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	/**
	 * One text, line by line: a multi-line message keeps its lines (the
	 * span restore puts a lost line prefix back on its own line), and an
	 * empty line is not sent.
	 */
	async translate(text: string, from: string, to: string): Promise<string> {
		const lines = text.split("\n");
		const sent = lines.filter((line) => line.trim() !== "");

		if (sent.length === 0) {
			return text;
		}

		let answer: {lines: string[]};

		try {
			answer = await this.deps.invoke<{lines: string[]}>("translate", {
				lines: sent,
				from,
				to,
				strategy: this.options.strategy,
				skip: this.options.skip,
			});
		} catch (e) {
			const error = asAppleError(e);

			if (error.code === "notInstalled") {
				this.forget();
			}

			throw error;
		}

		if (!Array.isArray(answer?.lines) || answer.lines.length !== sent.length) {
			throw new AppleError("the translator answered a different number of lines", "failed");
		}

		let next = 0;

		return lines.map((line) => (line.trim() === "" ? line : answer.lines[next++])).join("\n");
	}

	/** The languages the system translates (ISO 639 codes); none when the bridge does not answer. */
	async languages(): Promise<string[]> {
		const answer = await this.deps
			.invoke<{languages: string[]}>("languages", {})
			.catch(() => ({languages: [] as string[]}));

		return Array.isArray(answer.languages) ? answer.languages : [];
	}

	/**
	 * The pair's pack offered in the system's sheet, once per page load:
	 * true when it is installed afterwards. Every request for the pair while
	 * the sheet is up waits on the one answer, and another pair's offer
	 * waits for the sheet to close. `allowed` is asked just before the sheet
	 * would open (the user's switch, which may have gone off while the offer
	 * waited). Declined (closed, or failed), no pair is offered again until
	 * the next load; accepted, the pair's status is asked afresh until the
	 * background download lands.
	 */
	offer(from: string, to: string, allowed: () => boolean = () => true): Promise<boolean> {
		const key = this.key(from, to);
		const open = this.offers.get(key);

		if (open) {
			return open;
		}

		if (this.declined || this.offered.has(key)) {
			return Promise.resolve(false);
		}

		this.offered.add(key);

		const answer = this.sheet
			.then(() => {
				if (this.declined || !allowed()) {
					// Not shown, so not asked: a later request may offer it.
					this.offered.delete(key);

					return false;
				}

				return this.prepare(from, to).then(
					(result) => {
						if (result.status === "installed") {
							return true;
						}

						if (result.error) {
							this.declined = true;
						} else {
							this.pending.add(key);
						}

						return false;
					},
					() => {
						this.declined = true;

						return false;
					}
				);
			})
			.finally(() => this.offers.delete(key));

		this.offers.set(key, answer);
		this.sheet = answer;

		return answer;
	}

	/** The system's download sheet for the pair's pack; the status after it. */
	async prepare(from: string, to: string): Promise<PrepareResult> {
		this.forget();

		const answer = await this.deps
			.invoke<PrepareResult>("prepare", {from, to, strategy: this.options.strategy})
			.catch((e: unknown) => {
				throw asAppleError(e);
			});

		// Anything asked while the sheet was up (a row's `lookup`) was
		// answered with the status before the download: asked again.
		this.forget();

		return {status: answer.status, ...(answer.error ? {error: answer.error} : {})};
	}

	private key(from: string, to: string): string {
		return `${from}>${to}`;
	}
}

function asAppleError(e: unknown): AppleError {
	if (e instanceof AppleError) {
		return e;
	}

	const raw = (e ?? {}) as {message?: unknown; code?: unknown};

	return new AppleError(
		typeof raw.message === "string" ? raw.message : String(e),
		typeof raw.code === "string" ? raw.code : "failed"
	);
}
