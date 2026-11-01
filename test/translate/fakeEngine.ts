import type {
	Device,
	Engine,
	EngineName,
	EngineStatus,
	LoadProgress,
	ModelRef,
	TranslateChunk,
	TranslateRequest,
} from "../../client/js/translate/engine";

/**
 * A scripted engine: `script(req)` returns the cumulative chunk texts to
 * yield; the last one is repeated with `done: true`. `failLoad` /
 * `failTranslate` make the next call reject; `loadTicks` is how many
 * progress reports a load emits before resolving.
 */
export class FakeEngine implements Engine {
	readonly name: EngineName;
	/** `devices[i]` is the device `load[i]` was asked for. */
	calls = {
		load: [] as ModelRef[],
		devices: [] as Device[],
		translate: [] as TranslateRequest[],
		unload: 0,
	};
	failLoad: Error | null = null;
	failTranslate: Error | null = null;
	loadTicks = 2;
	private loaded: string[] = [];
	/** The device `loaded` is on: one device at a time, as engines/onDevice.ts holds a slot. */
	private device: Device | null = null;
	private state: EngineStatus = "cold";

	constructor(name: EngineName, private script: (req: TranslateRequest) => string[]) {
		this.name = name;
	}

	async load(
		ref: ModelRef,
		device: Device,
		onProgress: (p: LoadProgress) => void
	): Promise<void> {
		this.calls.load.push(ref);
		this.calls.devices.push(device);
		this.state = "loading";

		if (this.failLoad) {
			const error = this.failLoad;
			this.failLoad = null;
			this.state = "failed";
			throw error;
		}

		for (let i = 1; i <= this.loadTicks; i++) {
			await Promise.resolve();
			onProgress({fraction: i / this.loadTicks, text: `part ${i}`});
		}

		if (this.device !== device) {
			this.loaded = [];
			this.device = device;
		}

		if (this.name === "llm") {
			this.loaded = [ref.id];
		} else if (!this.loaded.includes(ref.id)) {
			this.loaded.push(ref.id);
		}

		this.state = "ready";
	}

	unload(): Promise<void> {
		this.calls.unload++;
		this.loaded = [];
		this.device = null;
		this.state = "cold";
		return Promise.resolve();
	}

	status(): EngineStatus {
		return this.state;
	}

	loadedModels(): string[] {
		return [...this.loaded];
	}

	isLoaded(id: string, device?: Device): boolean {
		return this.loaded.includes(id) && (device === undefined || device === this.device);
	}

	/** The device the loaded models are on; null when none is. */
	loadedOn(): Device | null {
		return this.device;
	}

	capabilities() {
		return {streams: this.name === "llm", batches: this.name === "llm"};
	}

	async *translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateChunk> {
		this.calls.translate.push(req);

		if (!this.isLoaded(req.model, req.device)) {
			throw new Error(`model not loaded: ${req.model}`);
		}

		if (this.failTranslate) {
			const error = this.failTranslate;
			this.failTranslate = null;
			throw error;
		}

		const texts = this.script(req);

		for (const text of texts) {
			if (signal.aborted) {
				return;
			}

			await Promise.resolve();
			yield {id: req.id, text, done: false};
		}

		if (!signal.aborted) {
			yield {id: req.id, text: texts[texts.length - 1] ?? "", done: true};
		}
	}
}
