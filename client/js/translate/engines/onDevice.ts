// One engine slot that can run on either device (spec
// docs/projects/translation-devices.md § Engines and the worker): it holds
// an engine per device and keeps one device's models in memory at a time.
// Loading on the other device unloads this one's first, after the requests
// already running on it have finished and after a load still in flight on it
// has settled (a language model's reload is not listed in `loadedModels`
// until it finishes, so an unload before then would leave both resident).
// Vue-free and library-free: the engines arrive through the constructor.

import {
	Device,
	Engine,
	EngineCapabilities,
	EngineName,
	EngineStatus,
	LoadProgress,
	ModelRef,
	TranslateChunk,
	TranslateRequest,
} from "../engine";

export class OnDevice implements Engine {
	readonly name: EngineName;
	private engines: Record<Device, Engine>;
	private active: Device = "gpu";
	/** The requests streaming on each device, settled when their stream ends. */
	private running: Record<Device, Set<Promise<void>>> = {gpu: new Set(), cpu: new Set()};
	/** Each device's newest `load`, from its call until it settles. */
	private loading: Record<Device, Promise<void> | null> = {gpu: null, cpu: null};

	constructor(name: EngineName, engines: Record<Device, Engine>) {
		this.name = name;
		this.engines = engines;
	}

	load(ref: ModelRef, device: Device, onProgress: (p: LoadProgress) => void): Promise<void> {
		const other: Device = device === "gpu" ? "cpu" : "gpu";
		// Taken at the call, so two loads can never wait for each other.
		const otherLoad = this.loading[other];
		const run = (async () => {
			if (otherLoad) {
				// Its failure is its caller's to hear.
				await otherLoad.catch(() => {});
			}

			if (this.engines[other].loadedModels().length > 0) {
				// The running request finishes on its device first.
				while (this.running[other].size > 0) {
					await Promise.allSettled([...this.running[other]]);
				}

				await this.engines[other].unload();
			}

			this.active = device;
			await this.engines[device].load(ref, device, onProgress);
		})();

		const settle = () => {
			if (this.loading[device] === run) {
				this.loading[device] = null;
			}
		};

		this.loading[device] = run;
		run.then(settle, settle);

		return run;
	}

	async unload(): Promise<void> {
		await Promise.all([this.engines.gpu.unload(), this.engines.cpu.unload()]);
	}

	status(): EngineStatus {
		return this.engines[this.active].status();
	}

	loadedModels(): string[] {
		return [...this.engines.gpu.loadedModels(), ...this.engines.cpu.loadedModels()];
	}

	isLoaded(id: string, device?: Device): boolean {
		return device === undefined
			? this.engines.gpu.isLoaded(id) || this.engines.cpu.isLoaded(id)
			: this.engines[device].isLoaded(id);
	}

	capabilities(): EngineCapabilities {
		return this.engines[this.active].capabilities();
	}

	async *translate(req: TranslateRequest, signal: AbortSignal): AsyncIterable<TranslateChunk> {
		const device = req.device ?? this.deviceOf(req.model);

		let finish: () => void = () => {};

		const settled = new Promise<void>((resolve) => {
			finish = resolve;
		});

		this.running[device].add(settled);

		try {
			yield* this.engines[device].translate(req, signal);
		} finally {
			this.running[device].delete(settled);
			finish();
		}
	}

	/** The device `id` is loaded on, else the active one. */
	private deviceOf(id: string): Device {
		if (this.engines[this.active].isLoaded(id)) {
			return this.active;
		}

		return this.engines[this.active === "gpu" ? "cpu" : "gpu"].isLoaded(id)
			? this.active === "gpu"
				? "cpu"
				: "gpu"
			: this.active;
	}
}
