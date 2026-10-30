// The system's own translator in the iOS shell: Apple's Translation
// framework through the shell's `AppleTranslate` plugin
// (shells/capacitor/ios/App/App/AppleTranslatePlugin.swift). Nothing is
// downloaded by the page and nothing runs in the worker: the Capacitor
// bridge exists only on the main thread, so this engine is called from
// service.ts directly, never through the worker's protocol.
//
// Measured against the page's own engines on the same sets
// (docs/projects/translation-apple-eval.md): the `low` strategy (Apple's
// downloaded language packs, ~80 ms a line on an M2 Max) beat every model
// the page ships, kept ⟦n⟧ placeholders in every line and emoji in nearly
// all. `high` is Apple's on-device 3B model, 13–27× slower and only
// sometimes better.
//
// A pair is taken only when its pack is installed (`status`): the router
// tries this engine first and falls through to the route table otherwise,
// so a missing pack never blocks a translation. `prepare` asks the user to
// download one in the system's own sheet.
//
// Vue-free and DOM-free behind `AppleDeps`, so mocha drives it with a fake
// bridge (test/translate/apple.ts).

/** The shell plugin's `jsName`. */
export const APPLE_PLUGIN = "AppleTranslate";

/** `LanguageAvailability`'s answer: the pack is on the device, can be, or the pair does not exist. */
export type AppleStatus = "installed" | "supported" | "unsupported";
export type AppleStrategy = "low" | "high";

export interface AppleDeps {
	/** A call to the plugin; rejects with `{code, message}` when the plugin rejected. */
	invoke<T>(method: string, options: Record<string, unknown>): Promise<T>;
}

export interface AppleOptions {
	strategy: AppleStrategy;
	/** Mark every ⟦n⟧ placeholder `skipsTranslation` (iOS 26.4+). */
	skip: boolean;
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
	private deps: AppleDeps;
	private options: AppleOptions;

	constructor(deps: AppleDeps, options: AppleOptions = {strategy: "low", skip: false}) {
		this.deps = deps;
		this.options = options;
	}

	setOptions(options: AppleOptions): void {
		if (options.strategy !== this.options.strategy) {
			this.statuses.clear();
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
		let status = this.statuses.get(key);

		if (!status) {
			status = this.deps
				.invoke<{status: AppleStatus}>("availability", {
					from,
					to,
					strategy: this.options.strategy,
				})
				.then(
					(answer) => answer.status,
					() => "unsupported" as const
				);
			this.statuses.set(key, status);
		}

		return status;
	}

	async installed(from: string, to: string): Promise<boolean> {
		return (await this.status(from, to)) === "installed";
	}

	/** Every pair's status asked again on next use. */
	forget(): void {
		this.statuses.clear();
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

	/** The system's download sheet for the pair's pack; the status after it. */
	async prepare(from: string, to: string): Promise<AppleStatus> {
		this.forget();

		const answer = await this.deps
			.invoke<{status: AppleStatus}>("prepare", {from, to, strategy: this.options.strategy})
			.catch((e: unknown) => {
				throw asAppleError(e);
			});

		return answer.status;
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
