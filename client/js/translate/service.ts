// The main-thread orchestrator (spec § service, § Lifecycle): probes once,
// routes a request, loads the model on demand, marks a candidate down for
// the session when its model cannot load or translate, and takes the next.
// The worker is created lazily. A loaded GPU model with nothing to do is
// unloaded after GPU_IDLE_UNLOAD_MS and a CPU model after
// CPU_IDLE_UNLOAD_MS; a tier switched off in Settings unloads at once;
// everything goes at once when translation is not in use anywhere
// (`setInUse`) and nothing is in flight, and on pagehide. The last model
// going takes the worker with it. Model views feed Settings. A model that
// is not downloaded yet is downloaded only once the user has agreed to it
// (consent.ts, asked through `ServiceDeps.askDownload` when the route is
// resolved); Settings' own Download is that agreement. Vue-free: index.ts
// wires the real worker, the store, the settings and the dialog.

import {Capability} from "./capability";
import {
	ConsentStore,
	DownloadConsent,
	consentId,
	memoryConsent,
	needsDownloadError,
} from "./consent";
import {TranslateClient, TranslateError, WORKER_DISPOSED} from "./client";
import {
	BATCH_REFUSED,
	Device,
	EngineName,
	LoadProgress,
	ModelRef,
	TranslateChunk,
	TranslateRequest,
} from "./engine";
import {ABORTED} from "./outgoing";
import {
	Candidate,
	DeviceChoices,
	EngineSwitches,
	GpuBudget,
	ModelCatalog,
	candidateOf,
	catalogModels,
	copyDevices,
	selectLlm,
} from "./models";
import {DownKey, Route, RouteTable, explainRoute, mergeRoutes, routeInput} from "./router";
import {routesFor as shippedRoutesFor} from "./routes.default";

/** A loaded GPU model with no request for this long gives its memory back. */
export const GPU_IDLE_UNLOAD_MS = 3 * 60 * 1000;
/** A loaded CPU model with no request for this long gives its memory back. */
export const CPU_IDLE_UNLOAD_MS = 5 * 60 * 1000;
export const TRANSLATION_UNAVAILABLE = "no translation engine can take this request";
/**
 * How long a route waits for the worker to say what is downloaded
 * (`cacheOrDeadline`). Generous on purpose: past it the router no longer
 * prefers a downloaded model inside its class, and a first, uncached start
 * of the multi-MiB worker on a slow phone line can take a while.
 */
export const CACHE_WAIT_MS = 60 * 1000;

export interface ServiceDeps {
	createClient(): {client: TranslateClient; terminate(): void};
	probe(): Promise<Capability>;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	/**
	 * The question before a model's copy nobody downloaded by name is
	 * downloaded (consent.ts): true to download it, false for "not now".
	 * `device` is the copy's, for its size. Absent, every download goes
	 * ahead unasked (the tests that are not about consent).
	 */
	askDownload?(ref: ModelRef, device: Device): Promise<boolean>;
	/** Where the yeses are remembered; in memory when absent. */
	consent?: ConsentStore;
}

/**
 * A route, or why there is none that needs no declined download: `refused`
 * is the model the best route would have downloaded, when "not now" is
 * what left the request without one, and `refusedDevice` that copy's device.
 */
export interface RouteResolution {
	route: Route | null;
	refused: ModelRef | null;
	refusedDevice: Device | null;
}

export interface ServiceOptions {
	/** Its `llm` is the selected GPU model; `setLlmModel` changes it. */
	catalog: ModelCatalog;
	/**
	 * The `translateLlmModel` setting as stored — "" (or null) is no choice,
	 * and resolves against the device probe once it lands (models.ts
	 * `llmChoice`). Kept as given so the resolution can be redone; nothing
	 * writes a resolved id back to the settings.
	 */
	selectedLlm?: string | null;
	/** The deploy's `translation.routes`, merged over the selected model's table. */
	routes?: RouteTable;
	/** The shipped table for a GPU model id; `routes.default.ts` `routesFor` unless a test swaps it. */
	routesFor?: (llmModelId: string) => RouteTable;
	ortBase: string;
	enabled: boolean;
}

export interface ServiceSettings {
	/** The switch per model family; NLLB-200's is opt-in (its licence is non-commercial). */
	switches: EngineSwitches;
	/** The device setting per model family (`translate*Device`). */
	devices: DeviceChoices;
}

export type ModelStatus = "idle" | "downloading" | "ready" | "failed";

/** One copy of a model: its download state on this device and its load state. */
export interface ModelView {
	ref: ModelRef;
	device: Device;
	cached: boolean;
	status: ModelStatus;
	fraction: number;
	error: string | null;
}

/** What `loadNote` reports; the phrase itself is the component's (helpers/modelLabel.ts). */
export interface LoadNote {
	phase: "downloading" | "loading";
	ref: ModelRef;
	/** 0-100, already rounded. */
	percent: number;
}

/**
 * What a strip or a reading line says while its model loads, as data. A model
 * not yet on this device is being downloaded; one already downloaded
 * (`cached`, known before the load from the worker's cache state) is being
 * loaded back into memory -- after an idle unload, a GPU model switch or a
 * page reload -- which the user should not mistake for another download.
 * This module is Vue-free and has no copy of its own.
 */
export function loadNote(view: ModelView): LoadNote {
	return {
		phase: view.cached ? "loading" : "downloading",
		ref: view.ref,
		percent: Math.round(view.fraction * 100),
	};
}

/** What a copy's view is kept under. */
function copyKey(ref: Pick<ModelRef, "id">, device: Device): string {
	return `${ref.id}@${device}`;
}

export class TranslateService {
	private worker: {client: TranslateClient; terminate(): void} | null = null;
	private capability: Promise<Capability> | null = null;
	/** The probe's answer once it has one; the GPU default follows it. */
	private probed: Capability | null = null;
	private selectedLlm: string | null = null;
	private down = new Set<DownKey>();
	private idleTimer: unknown = null;
	private inFlight = 0;
	private nextId = 1;
	/** By copy (`copyKey`). */
	private views = new Map<string, ModelView>();
	private listeners = new Set<(views: ModelView[]) => void>();
	private workerErrorListeners = new Set<(message: string | null) => void>();
	/** `workerDied` reported a worker that never started; a later answer clears it. */
	private deadReported = false;
	private generation = 0;
	private disposed = false;
	/** Once per service: which models are downloaded, for the router's in-class preference. */
	private cacheKnown: Promise<void> | null = null;
	/** Moves on every download progress event (`loadTicks`). */
	private ticks = 0;
	/** The selected GPU model's table with the deploy's overrides merged in. */
	private table: RouteTable;
	/** Running LLM streams by model id: a model is unloaded only once its own are done. */
	private llmRunning = new Map<string, number>();
	private llmWaiters: {ready: () => boolean; resolve: () => void}[] = [];
	/** Bumped on every GPU request or download claimed; per model, the last one's number. */
	private llmStartSeq = 0;
	private llmLastStart = new Map<string, number>();
	/**
	 * A GPU model switch still settling: the old model's running requests
	 * finishing, then its unload. LLM work waits for it, since loading
	 * another model into WebLLM tears down the engine a request is still
	 * generating on.
	 */
	private llmSwitch: Promise<void> | null = null;
	/** Requests and downloads running per engine: an engine is never unloaded under one. */
	private engineRunning: Record<EngineName, number> = {llm: 0, seq2seq: 0};
	/** Waiting for an engine to fall idle: a delete that must not unload under a request. */
	private engineWaiters: {engine: EngineName; resolve: () => void}[] = [];
	/** Engines given a model since they were last unloaded. */
	private loadedEngines = new Set<EngineName>();
	/**
	 * The device each slot was last given work on: the slot holds one
	 * device's models at a time (engines/onDevice.ts), so this is the device
	 * its models are on. It picks the idle wait and whether deleting a copy
	 * has to unload it first.
	 */
	private engineDevice: Record<EngineName, Device | null> = {llm: null, seq2seq: null};
	/**
	 * The families the seq2seq engine has held since it was last loaded
	 * (OPUS-MT, NLLB-200): its unload follows their own switches.
	 */
	private seq2seqFamilies = new Set<ModelRef["family"]>();
	private engineTimers: Record<EngineName, unknown> = {llm: null, seq2seq: null};
	/** Whether translation is wanted anywhere (reader.ts `translationInUse`); unset, it always is. */
	private inUse: (() => boolean) | null = null;
	private usageTimer: unknown = null;
	/** The download question (consent.ts); null when no dialog was wired. */
	private consent: DownloadConsent | null;
	/** Settings (or a route) has asked the worker what is downloaded: asked again once the probe lands. */
	private modelsAsked = false;
	/**
	 * The CPU engine has been given work in the current worker. ONNX
	 * Runtime's WebAssembly heap grows and never shrinks, so unloading its
	 * models gives none of it back: on a phone the GPU model is only loaded
	 * into a fresh worker once it has (`makeRoom`).
	 */
	private cpuHeapUsed = false;
	/** An engine's unload `makeRoom` posted, until the worker answers: every caller waits on it. */
	private evicting: Record<EngineName, Promise<void> | null> = {llm: null, seq2seq: null};

	constructor(
		private deps: ServiceDeps,
		private options: ServiceOptions,
		private settings: ServiceSettings
	) {
		for (const ref of catalogModels(options.catalog)) {
			for (const device of copyDevices(ref)) {
				this.view(ref, device);
			}
		}

		this.selectedLlm = options.selectedLlm ?? null;
		this.table = this.buildTable();
		// The catalog was built without the device setting: a language model
		// pinned to the CPU resolves an unset choice differently.
		this.applyLlmSelection();
		this.consent = deps.askDownload
			? new DownloadConsent(
					(ref, device) => deps.askDownload!(ref, device),
					deps.consent ?? memoryConsent()
			  )
			: null;
	}

	get enabled(): boolean {
		return this.options.enabled;
	}

	/** The catalog as it stands: `catalog.llm` is the selected GPU model. */
	get catalog(): ModelCatalog {
		return this.options.catalog;
	}

	/**
	 * The route table for the selected GPU model, deploy overrides merged:
	 * what the UI asks `explainRoute` against before it offers an action.
	 */
	get routeTable(): RouteTable {
		return this.table;
	}

	/**
	 * Selects the GPU model (an id that is not a choice selects the default).
	 * Nothing in flight is cancelled or failed: a running LLM request
	 * finishes on the old model, which is unloaded after it, and every LLM
	 * request routed from now on — a queued reading line included — goes to
	 * the new one. The LLM candidate's down-mark is lifted: it was the old
	 * model's.
	 */
	setLlmModel(id: string | null): void {
		this.selectedLlm = id;
		this.applyLlmSelection();
	}

	/** Re-resolve the stored selection (a change, or the probe landing). */
	private applyLlmSelection(): void {
		const next = selectLlm(
			this.options.catalog,
			this.selectedLlm,
			this.probed,
			this.settings.devices.llm
		);

		if (next === this.options.catalog) {
			return;
		}

		const previous = this.options.catalog.llm.id;

		this.options = {...this.options, catalog: next};
		this.table = this.buildTable();
		this.forgetDown("llm");
		this.retireLlm(previous);
	}

	private buildTable(): RouteTable {
		const shipped = (this.options.routesFor ?? shippedRoutesFor)(this.options.catalog.llm.id);

		return mergeRoutes(shipped, this.options.routes ?? {});
	}

	/** Unload `id` once its running requests are done, unless it is selected again by then. */
	private retireLlm(id: string): void {
		const worker = this.worker;

		if (!worker) {
			// No worker, nothing loaded.
			return;
		}

		const gen = this.generation;
		const before = this.llmSwitch ?? Promise.resolve();
		const settling: Promise<void> = before
			.then(() => this.whenLlm(() => !this.llmRunning.get(id)))
			.then(async () => {
				if (
					this.generation !== gen ||
					this.worker !== worker ||
					this.options.catalog.llm.id === id
				) {
					return;
				}

				const status = await worker.client.status();

				if (status.llm.models.includes(id)) {
					await worker.client.unload("llm");
				}
			})
			.catch(() => {
				// A worker torn down meanwhile unloaded everything anyway.
			})
			.then(() => {
				if (this.llmSwitch === settling) {
					this.llmSwitch = null;
				}
			});

		this.llmSwitch = settling;
	}

	private whenLlm(ready: () => boolean): Promise<void> {
		if (ready()) {
			return Promise.resolve();
		}

		return new Promise((resolve) => this.llmWaiters.push({ready, resolve}));
	}

	/**
	 * GPU work claimed on model `id`: a request or a download. WebLLM holds one
	 * model, and loading another tears down the engine this work runs on, so
	 * work on another model waits until every claim on this one is released.
	 * Claim synchronously after checking `otherLlmWork`, with no await between.
	 */
	private llmStarted(id: string): void {
		this.llmRunning.set(id, (this.llmRunning.get(id) ?? 0) + 1);
		this.llmLastStart.set(id, ++this.llmStartSeq);
	}

	/** GPU work (a request or a download) running on a model other than `id`. */
	private otherLlmWork(id: string): boolean {
		return [...this.llmRunning.keys()].some((running) => running !== id);
	}

	/** Whether work on another GPU model was claimed after claim number `seq`. */
	private otherLlmStartedSince(id: string, seq: number): boolean {
		for (const [model, started] of this.llmLastStart) {
			if (model !== id && started > seq) {
				return true;
			}
		}

		return false;
	}

	private llmEnded(id: string): void {
		const left = (this.llmRunning.get(id) ?? 1) - 1;

		if (left > 0) {
			this.llmRunning.set(id, left);
		} else {
			this.llmRunning.delete(id);
		}

		const waiting = this.llmWaiters;

		this.llmWaiters = [];

		for (const waiter of waiting) {
			if (waiter.ready()) {
				waiter.resolve();
			} else {
				this.llmWaiters.push(waiter);
			}
		}
	}

	capabilities(): Promise<Capability> {
		// A deploy that switched translation off never asks the GPU or the
		// storage anything: the probe starts adapter enumeration in the GPU
		// process, and a channel view reads availability on every load.
		// Nothing shows the capability while disabled (Settings says so and
		// stops there; models.ts `modelBlock` answers "disabled" first).
		if (!this.capability && !this.options.enabled) {
			this.capability = Promise.resolve({
				tier: "none",
				reasons: [],
				f16: false,
				maxBufferBytes: 0,
				deviceMemoryGiB: null,
				storageQuotaBytes: null,
				mobile: false,
			});
		}

		if (!this.capability) {
			this.capability = this.deps
				.probe()
				.catch(
					(): Capability => ({
						tier: "none",
						reasons: ["PROBE_FAILED"],
						f16: false,
						maxBufferBytes: 0,
						deviceMemoryGiB: null,
						storageQuotaBytes: null,
						mobile: false,
					})
				)
				.then((capability) => {
					this.probed = capability;
					// An unset choice is the device's: now that the device
					// has answered, the selection is resolved again.
					this.applyLlmSelection();
					this.probeLanded();
					return capability;
				});
		}

		return this.capability;
	}

	/**
	 * What the worker is told about the GPU (models.ts `GpuBudget`): which
	 * build of a GPU model loads follows the probe's binding limit, so a
	 * worker started before the probe answered is told again once it has
	 * (`probeLanded`). Undefined until then.
	 */
	private gpuBudget(): GpuBudget | undefined {
		return this.probed
			? {
					maxBufferBytes: this.probed.maxBufferBytes,
					capBytes: this.probed.bufferCapBytes ?? null,
					// The phone's smaller context window (models.ts
					// `contextWindowFor`); a computer's message is unchanged.
					...(this.probed.mobile ? {mobile: true} : {}),
			  }
			: undefined;
	}

	/**
	 * One engine in memory at a time, on a phone or tablet: WebKit counts
	 * the GPU model's memory against the page's own process, which also
	 * holds the worker's ONNX Runtime heap (NLLB-200 ~900 MB, an OPUS-MT
	 * pair ~110 MB), and past about 2.1 GB the page is killed. A computer
	 * keeps both, and runs them side by side.
	 */
	private oneEngineAtATime(): boolean {
		return this.probed?.mobile === true;
	}

	/**
	 * What has to happen before `engine` may load or run here: null when
	 * nothing (a computer; or the other engine idle and out of memory), else
	 * a wait, after which the caller checks again. Never claims anything
	 * itself, so a caller claims (`engineStarted`) right after a null, with
	 * no await between — and nobody ever waits while holding a claim, so two
	 * callers on the two engines cannot wait on each other. The other
	 * engine running: wait for it. The GPU model wanted in a worker the CPU
	 * engine has used: a fresh worker (`recycleWorker`), since that heap does
	 * not shrink. The other engine loaded: unload it.
	 */
	private makeRoom(engine: EngineName): Promise<void> | null {
		if (!this.oneEngineAtATime()) {
			return null;
		}

		const other: EngineName = engine === "llm" ? "seq2seq" : "llm";

		if (this.engineRunning[other] > 0) {
			return this.whenEngineIdle(other);
		}

		if (this.evicting[other]) {
			return this.evicting[other];
		}

		if (engine === "llm" && this.cpuHeapUsed && this.engineRunning.llm === 0) {
			this.recycleWorker();
			return Promise.resolve();
		}

		const worker = this.worker;

		if (worker && this.loadedEngines.has(other)) {
			this.clearEngineTimer(other);
			this.loadedEngines.delete(other);

			const evicting = worker.client
				.unload(other)
				.catch(() => {
					// A worker torn down meanwhile unloaded it anyway.
				})
				.then(() => {
					if (this.evicting[other] === evicting) {
						this.evicting[other] = null;
					}
				});

			this.evicting[other] = evicting;
			return evicting;
		}

		return null;
	}

	/**
	 * A fresh worker in place of this one, everything it held gone with it,
	 * without the teardown's generation step: nothing runs on it (`makeRoom`
	 * checks), and the request that asked carries on in the next one.
	 */
	private recycleWorker(): void {
		const worker = this.worker;

		if (!worker) {
			return;
		}

		this.worker = null;
		this.cpuHeapUsed = false;
		this.clearEngineTimer("llm");
		this.clearEngineTimer("seq2seq");
		this.loadedEngines.clear();
		worker.client.dispose();
		worker.terminate();
	}

	/**
	 * The probe has answered. A worker already running was configured
	 * without it and may have answered "is it downloaded" for the wrong
	 * build: tell it, and ask again (Settings mounts before the probe lands).
	 */
	private probeLanded(): void {
		const worker = this.worker;

		if (!worker) {
			return;
		}

		worker.client.configure(this.options.catalog, this.options.ortBase, this.gpuBudget());

		if (this.modelsAsked) {
			this.models().catch(() => {
				// The next ask reports it; a refresh nobody waits for has no one to tell.
			});
		}
	}

	/** The id a copy's consent is kept under (consent.ts `consentId`). */
	private consentId(ref: ModelRef, device: Device): string {
		return consentId(ref, device, this.probed?.maxBufferBytes);
	}

	/** A tier switched off gives its memory back at once, once nothing runs on it. */
	setSettings(settings: ServiceSettings): void {
		const before = this.settings;

		this.settings = settings;

		if (before.switches.llm && !settings.switches.llm) {
			this.afterEngineIdle("llm");
		}

		if (
			(before.switches.opus && !settings.switches.opus) ||
			(before.switches.nllb && !settings.switches.nllb)
		) {
			this.afterEngineIdle("seq2seq");
		}

		// Pinned to the CPU, an unset choice resolves to a model with a CPU
		// copy (models.ts `llmChoice`), and back again when it is not.
		if (before.devices.llm !== settings.devices.llm) {
			this.applyLlmSelection();
		}
	}

	/**
	 * Lifts the session's down-mark off `candidate`'s copy for `device`, or
	 * off every copy when no device is named (another model now answers
	 * for the candidate).
	 */
	private forgetDown(candidate: Candidate, device?: Device): void {
		for (const d of device ? [device] : (["gpu", "cpu"] as const)) {
			this.down.delete(`${candidate}@${d}`);
		}
	}

	/**
	 * What says translation is wanted anywhere — a channel reading or writing
	 * through it, a queued line, an open composer strip. Once it says no and
	 * nothing is in flight, every model is unloaded at once.
	 */
	setInUse(inUse: (() => boolean) | null): void {
		this.inUse = inUse;
		this.usageChanged();
	}

	/**
	 * Something the usage reads has changed (a channel switched off, a strip
	 * closed, a queue drained). Checked on the next tick rather than now, so
	 * a queue or a composer about to start its next request has done so.
	 */
	usageChanged(): void {
		if (!this.inUse || !this.worker || this.usageTimer !== null) {
			return;
		}

		this.usageTimer = this.deps.setTimeout(() => {
			this.usageTimer = null;

			if (this.worker && this.inFlight === 0 && this.inUse && !this.inUse()) {
				this.teardown();
			}
		}, 0);
	}

	/**
	 * The route for a pair. `hint` is the request's source hint: it picks the
	 * table row when `from` is null and lets a seq2seq candidate run with it
	 * as the source (router.ts). The first call asks the worker what is
	 * downloaded, once: without that every model counts as absent until
	 * Settings is opened, and the router could not prefer a downloaded one.
	 */
	async route(
		from: string | null,
		to: string,
		hint: string | null = null
	): Promise<Route | null> {
		return (await this.resolve(from, to, hint)).route;
	}

	/**
	 * `route`, with the model a declined download left the request without
	 * (`RouteResolution.refused`). A route whose model is not on the device
	 * and was never agreed to asks first (`ServiceDeps.askDownload`), once
	 * per model however many requests wait on it; after a "not now" the
	 * walk takes only what needs no download -- a downloaded model, one
	 * agreed to, one downloading already -- for this request and every
	 * later one this session, so a channel's queued lines ask once and the
	 * fallback never asks about a second model. Every caller routes through
	 * here before its request deadline is armed (the queue's `enqueueAt`,
	 * the composer's `route`), so an unanswered dialog times nothing out.
	 */
	async resolve(
		from: string | null,
		to: string,
		hint: string | null = null
	): Promise<RouteResolution> {
		if (!this.options.enabled) {
			return {route: null, refused: null, refusedDevice: null};
		}

		const capability = await this.capabilities();

		if (capability.tier !== "none") {
			await this.cacheOrDeadline();
		}

		const consent = this.consent;
		let cachedOnly = !!consent?.anyDeclined;

		const input = (refuse: boolean) => ({
			...routeInput(
				capability,
				this.settings.switches,
				this.settings.devices,
				{from, to, hint},
				this.down
			),
			// Per copy: one device's download, or its yes, says nothing of
			// the other's.
			cached: (ref: ModelRef, device: Device) =>
				this.views.get(copyKey(ref, device))?.cached === true,
			refuse: refuse
				? (ref: ModelRef, device: Device) => this.needsConsent(ref, device)
				: undefined,
		});

		for (;;) {
			const route = explainRoute(this.table, this.options.catalog, input(cachedOnly)).route;

			if (!route) {
				// What the request was left without: the route it would have
				// taken with the download allowed. Not the walk's own reason,
				// which may name a switch further down (NLLB-200 off) while
				// the model the user declined is what would have served.
				const refused = cachedOnly
					? explainRoute(this.table, this.options.catalog, input(false)).route
					: null;

				return {
					route: null,
					refused: refused?.ref ?? null,
					refusedDevice: refused?.device ?? null,
				};
			}

			if (!consent || !this.needsConsent(route.ref, route.device)) {
				return {route, refused: null, refusedDevice: null};
			}

			const yes = await consent.ask(
				{...route.ref, id: this.consentId(route.ref, route.device)},
				route.device,
				() => this.needsConsent(route.ref, route.device)
			);

			// Yes: route again, the model now agreed to (the selection or the
			// cache may have moved meanwhile). Not now: again, taking only
			// what needs no download.
			if (!yes) {
				cachedOnly = true;
			}
		}
	}

	/**
	 * Whether the download of `ref`'s copy for `device` needs the user's yes
	 * first: not on the device, not downloading already (a Settings download
	 * in flight is joined, not started), and never agreed to.
	 */
	private needsConsent(ref: ModelRef, device: Device): boolean {
		if (!this.consent) {
			return false;
		}

		const view = this.views.get(copyKey(ref, device));

		return (
			!view?.cached &&
			view?.status !== "downloading" &&
			!this.consent.granted(this.consentId(ref, device))
		);
	}

	/**
	 * A Retry on a line, an explicit act: the session's "not now" is over,
	 * and the next route that needs a download asks again.
	 */
	forgetDeclines(): void {
		this.consent?.forgetDeclines();
	}

	/**
	 * A counter that moves on every progress event of a load a translation
	 * is waiting for. The reading queue and the composer re-arm a request
	 * deadline that runs out while it is still moving (outgoing.ts
	 * `armDeadline`): the router sends a request to the best class whether
	 * its model is downloaded or not, and a request waiting for a 620 MB
	 * download must not time out while the download progresses. A download
	 * started from Settings does not move it on its own (a translation that
	 * joins that download does, through its own progress callback: client.ts
	 * hands every joined load the same events), so a request stuck on an
	 * engine is kept alive at most as long as another request's download.
	 */
	loadTicks(): number {
		return this.ticks;
	}

	/**
	 * Tries the candidates in route order; a candidate that fails is down for
	 * the session. A model that is not downloaded is downloaded here, its
	 * progress on the model views; one that fails to download is down, and
	 * the next class takes the request with the reason kept for the error.
	 */
	async *translate(
		request: Omit<TranslateRequest, "id" | "model">,
		signal?: AbortSignal
	): AsyncIterable<TranslateChunk> {
		if (signal?.aborted) {
			return;
		}

		this.inFlight++;
		this.clearIdle();

		let attemptedView: ModelView | null = null;
		let completed = false;
		// "<model id>: <reason>" of the last candidate whose model would not
		// load in this call. Every candidate failing that way is still
		// TRANSLATION_UNAVAILABLE to the caller, but a bare "no translation
		// engine can take this request" is what a broken CPU tier looked like
		// for a whole live test: the reason has to travel with it.
		let lastLoadError: string | null = null;
		// One listener for the whole call, whichever candidate is currently
		// running: a candidate that fails to load falls through to the next,
		// which would otherwise register another listener on the caller's
		// signal every time, each closing over an id already abandoned.
		let currentId = 0;
		const hint = request.hint ?? request.context.sourceHint ?? null;
		// A teardown (pagehide, unload all) while the route was still being
		// resolved -- the first route asks the worker what is downloaded --
		// ends this call like one during the translation itself, rather than
		// creating a new worker to carry on.
		const startGeneration = this.generation;

		const onAbort = () => {
			if (currentId) {
				this.worker?.client.cancel(currentId);
			}
		};

		// Not `{once: true}`: the listener has to survive every candidate this
		// call tries, and an abort before the request has an id is re-read
		// after each await below rather than fired and forgotten.
		signal?.addEventListener("abort", onAbort);

		// Every await before the request is posted is a wait the caller may
		// abort: the route (whose first call asks the worker what is
		// downloaded), a GPU model switch settling, another model's work
		// finishing. Without this the queue had already given the line up
		// while the request went to the worker, model download and all.
		const checkAborted = () => {
			if (signal?.aborted) {
				throw new Error(ABORTED);
			}
		};

		try {
			for (;;) {
				const {route, refused, refusedDevice} = await this.resolve(
					request.from,
					request.to,
					hint
				);

				// After the teardown check: a worker torn down while the route
				// resolved is the truer report of the two.
				if (this.generation !== startGeneration) {
					throw new Error(WORKER_DISPOSED);
				}

				checkAborted();

				// "Not now" to the download this request needed: the reason
				// names the model and its size (helpers/translateErrors.ts).
				if (!route && refused) {
					throw new Error(needsDownloadError(refused, refusedDevice ?? undefined));
				}

				if (!route) {
					throw new Error(
						lastLoadError
							? `${TRANSLATION_UNAVAILABLE}: ${lastLoadError}`
							: TRANSLATION_UNAVAILABLE
					);
				}

				// A GPU model switch is settling: the old model's requests
				// are still generating, and loading the new one would tear
				// their engine down. Wait, then route again, since the
				// selection may have moved on meanwhile.
				if (route.ref.engine === "llm" && this.llmSwitch) {
					await this.llmSwitch;
					checkAborted();
					continue;
				}

				// Another GPU model's work is running — a Settings download of the
				// unselected model, say: loading this one now would tear that
				// load down. Wait for it, then route again.
				if (route.ref.engine === "llm" && this.otherLlmWork(route.ref.id)) {
					const waitingFor = route.ref.id;

					await this.whenLlm(() => !this.otherLlmWork(waitingFor));
					checkAborted();
					continue;
				}

				// A batch made for the GPU model that now routes elsewhere (the
				// model switched off, or down after a failed load): say so
				// before posting, rather than loading a seq2seq model only to
				// have it refuse. The caller sends the lines one at a time.
				if (request.lines && route.ref.engine !== "llm") {
					throw new TranslateError(BATCH_REFUSED, "request");
				}

				// On a phone the other engine goes first (`makeRoom`); then
				// route again, since the wait may have moved things.
				const room = this.makeRoom(route.ref.engine);

				if (room) {
					await room;
					checkAborted();
					continue;
				}

				const client = this.client();

				if (route.ref.engine === "seq2seq") {
					this.cpuHeapUsed = true;
				}

				const gen = this.generation;
				const id = this.nextId++;
				// A seq2seq model has no prompt to detect a source in: it takes
				// the hint as its source. The LLM keeps `from: null`.
				const from = request.from ?? (route.ref.engine === "seq2seq" ? hint : null);
				const req: TranslateRequest = {
					...request,
					from,
					id,
					model: route.ref.id,
					device: route.device,
				};
				const view = this.view(route.ref, route.device);
				let yielded = false;

				attemptedView = view;
				currentId = id;

				const llmId = route.ref.engine === "llm" ? route.ref.id : null;

				this.engineStarted(route.ref, route.device);

				if (llmId) {
					this.llmStarted(llmId);
				}

				const llmSeq = this.llmStartSeq;

				try {
					for await (const chunk of client.translate(
						req,
						route.ref,
						(progress: LoadProgress) => {
							this.ticks++;
							view.status = "downloading";
							view.fraction = progress.fraction;
							this.publish();
						}
					)) {
						yielded = true;
						yield chunk;
					}

					// A cancel ends the stream normally (client.ts closes it at
					// once, without waiting for the engine), so arriving here is
					// no proof the model did: leave the view to the `finally`,
					// which puts a half-downloaded one back to idle.
					if (signal?.aborted) {
						return;
					}

					if (view.status === "downloading") {
						view.status = "ready";
						view.fraction = 1;
						view.cached = true;
						this.publish();
					}

					completed = true;

					return;
				} catch (e) {
					if (this.generation !== gen) {
						throw e;
					}

					if (yielded) {
						throw e;
					}

					// Only the model failing takes the candidate out of the
					// session: a request this model cannot serve (an unknown
					// pair, a batch a seq2seq engine will not take) is the
					// caller's to see, and the next candidate would refuse it
					// the same way.
					if (!(e instanceof TranslateError) || e.cause !== "load") {
						throw e;
					}

					// The same record `download()` keeps, so Settings' model row
					// says why this one is out and the caller's error carries
					// the reason of the last candidate that would not load.
					const message = e instanceof Error ? e.message : String(e);

					view.status = "failed";
					view.error = message;
					this.publish();

					lastLoadError = `${route.ref.id}: ${message}`;

					// A GPU model that was switched away from while it loaded
					// is no longer what the candidate runs: its failure does
					// not take the new model down with it. Nor does a load that
					// another GPU model's load may have torn down.
					if (
						!llmId ||
						(llmId === this.options.catalog.llm.id &&
							!this.otherLlmStartedSince(llmId, llmSeq))
					) {
						this.down.add(`${route.candidate}@${route.device}`);
					}
				} finally {
					if (llmId) {
						this.llmEnded(llmId);
					}

					this.engineEnded(route.ref.engine);
				}
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);

			if (attemptedView && attemptedView.status === "downloading" && !completed) {
				attemptedView.status = "idle";
				attemptedView.fraction = 0;
				this.publish();
			}

			this.inFlight--;
			this.scheduleIdle();
		}
	}

	async models(): Promise<ModelView[]> {
		if (!this.options.enabled) {
			return [];
		}

		this.inFlight++;
		this.clearIdle();
		this.modelsAsked = true;

		try {
			const states = await this.client().models();

			// A fresh worker answered after one that never started (the deploy
			// finished, the page came back online): what Settings says about
			// the dead one is over. Null clears it.
			if (this.deadReported) {
				this.deadReported = false;
				this.reportWorkerError(null);
			}

			for (const state of states) {
				const view = this.views.get(copyKey(state.ref, state.device));

				if (view) {
					view.cached = state.cached;

					if (state.cached && (view.status === "idle" || view.status === "failed")) {
						view.status = "ready";
						view.fraction = 1;
						view.error = null;
					}

					if (!state.cached && view.status === "ready") {
						view.status = "idle";
						view.fraction = 0;
					}
				}
			}

			this.publish();

			return this.snapshot();
		} finally {
			this.inFlight--;
			this.scheduleIdle();
		}
	}

	/**
	 * The cache question, waited for at most CACHE_WAIT_MS: a worker that
	 * started but never answers would otherwise hold every route -- the
	 * reading lines and the composer's strip before its own deadline is
	 * armed -- for good. Past it the route counts every model as absent, and
	 * the request's own deadline is what fails it.
	 */
	private async cacheOrDeadline(): Promise<void> {
		let handle: unknown = null;
		const deadline = new Promise<void>((resolve) => {
			handle = this.deps.setTimeout(resolve, CACHE_WAIT_MS);
		});

		try {
			await Promise.race([this.primeCache(), deadline]);
		} finally {
			this.deps.clearTimeout(handle);
		}
	}

	private primeCache(): Promise<void> {
		if (!this.cacheKnown) {
			this.cacheKnown = this.models().then(
				() => undefined,
				(e: unknown) => {
					// Torn down mid-question: ask again next time. Any other
					// failure is left alone, and every model counts as absent.
					if (e instanceof Error && e.message === WORKER_DISPOSED) {
						this.cacheKnown = null;
					}
				}
			);
		}

		return this.cacheKnown;
	}

	/** The listener is called at once with what the rows look like now. */
	onModels(listener: (views: ModelView[]) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot());

		return () => this.listeners.delete(listener);
	}

	/**
	 * Errors the worker reports for itself: a configure that threw, a
	 * handler that did, a worker that never started. Null: the last of
	 * those is over (a fresh worker answered).
	 */
	onWorkerError(listener: (message: string | null) => void): () => void {
		this.workerErrorListeners.add(listener);

		return () => this.workerErrorListeners.delete(listener);
	}

	/** Settings' Download of `ref`'s copy for `device`. */
	async download(ref: ModelRef, device: Device): Promise<void> {
		const view = this.view(ref, device);

		// Settings' Download, which shows the size: the user's yes.
		this.consent?.grant(this.consentId(ref, device));

		view.status = "downloading";
		view.fraction = 0;
		view.error = null;
		this.publish();
		this.inFlight++;
		this.clearIdle();

		const startGeneration = this.generation;
		let llmClaimed = false;
		let engineClaimed = false;

		try {
			// On a phone the other engine goes first (`makeRoom`), waited
			// out before this download claims its own engine — the last
			// check and the claim with no await between them. Whether this
			// is a phone is the probe's to say (it has usually answered by
			// the time Settings offers a Download).
			await this.capabilities();

			if (this.generation !== startGeneration) {
				throw new Error(WORKER_DISPOSED);
			}

			for (let wait = this.makeRoom(ref.engine); wait; wait = this.makeRoom(ref.engine)) {
				await wait;

				if (this.generation !== startGeneration) {
					throw new Error(WORKER_DISPOSED);
				}
			}

			this.engineStarted(ref, device);
			engineClaimed = true;

			if (ref.engine === "llm") {
				// WebLLM holds one model: loading this one while a request or a
				// download runs on another would end that work. Wait until none
				// does, then claim this download as work on its model at once,
				// so a request for another model waits for it in turn.
				for (;;) {
					if (this.llmSwitch) {
						await this.llmSwitch;
						continue;
					}

					if (this.otherLlmWork(ref.id)) {
						await this.whenLlm(() => !this.otherLlmWork(ref.id));
						continue;
					}

					break;
				}

				// Torn down (a page hide) while it waited: start no new worker.
				if (this.generation !== startGeneration) {
					throw new Error(WORKER_DISPOSED);
				}

				this.llmStarted(ref.id);
				llmClaimed = true;
			}

			const client = this.client();

			if (ref.engine === "seq2seq") {
				this.cpuHeapUsed = true;
			}

			await client.load(ref, device, (progress: LoadProgress) => {
				// On a phone a request for the other engine waits for this
				// download (`makeRoom`): its deadline is kept alive while the
				// download moves, as a request's own download keeps it.
				if (this.oneEngineAtATime()) {
					this.ticks++;
				}

				view.fraction = progress.fraction;
				this.publish();
			});
			view.status = "ready";
			view.fraction = 1;
			view.cached = true;
			// This copy loads again: whatever took it out of the session (a
			// download that failed, a device that was lost) is over. The
			// other device's copy keeps its own mark.
			this.forgetDown(candidateOf(ref), device);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);

			if (message === WORKER_DISPOSED) {
				view.status = "idle";
				view.fraction = 0;
				view.error = null;
			} else {
				view.status = "failed";
				view.error = message;
			}

			throw e;
		} finally {
			if (llmClaimed) {
				this.llmEnded(ref.id);
			}

			if (engineClaimed) {
				this.engineEnded(ref.engine);
			}

			this.inFlight--;
			this.scheduleIdle();
			this.publish();
		}
	}

	/**
	 * Settings' Remove of `ref`'s copy for `device`: unloaded first when that
	 * copy is the one in memory, then its files deleted. The other device's
	 * copy -- its files, and the model in memory when it runs there -- is
	 * left alone.
	 */
	async remove(ref: ModelRef, device: Device): Promise<void> {
		const view = this.view(ref, device);

		this.inFlight++;
		this.clearIdle();

		try {
			if (ref.engine === "llm") {
				await this.releaseLlmForDelete(ref.id, device);
			} else {
				await this.releaseEngineForDelete(ref.engine, device);
			}

			await this.client().deleteModel(ref, device);

			// Deleted on purpose: downloading this copy again is a new
			// question; the other copy's yes is its own. The worker deletes
			// every build of the language model's GPU copy, so every build's
			// yes goes.
			this.consent?.revoke(this.consentId(ref, device));

			if (ref.engine === "llm" && device === "gpu") {
				this.consent?.revoke(ref.id);

				if (ref.smallBuffer) {
					this.consent?.revoke(ref.smallBuffer.id);
				}
			}

			view.cached = false;
			view.status = "idle";
			view.fraction = 0;
			view.error = null;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);

			if (message === WORKER_DISPOSED) {
				view.error = null;
			} else {
				view.status = "failed";
				view.error = message;
			}

			throw e;
		} finally {
			this.inFlight--;
			this.scheduleIdle();
			this.publish();
		}
	}

	/**
	 * Before a language model's copy is deleted: once no request or download
	 * runs on the model, unload the slot only if it holds that model on that
	 * copy's device. Deleting the unselected model, or the copy of the other
	 * device, never touches the model another request is using, and the
	 * slot's idle clock is left to that work.
	 */
	private async releaseLlmForDelete(id: string, device: Device): Promise<void> {
		if (this.llmSwitch) {
			await this.llmSwitch;
		}

		await this.whenLlm(() => !this.llmRunning.get(id));

		if (this.engineDevice.llm !== device) {
			return;
		}

		const client = this.client();
		const status = await client.status();

		// Work on it started again while the worker answered: it is in use.
		if (
			!status.llm.models.includes(id) ||
			this.llmRunning.get(id) ||
			this.engineDevice.llm !== device
		) {
			return;
		}

		await client.unload("llm");
		this.loadedEngines.delete("llm");
	}

	/**
	 * Before a seq2seq copy's files are deleted: the slot holds every seq2seq
	 * model of its device at once, so it is unloaded when it is on that
	 * copy's device — but not out from under a request still generating on
	 * it, the way the language model's path waits in `releaseLlmForDelete`.
	 * `engineRunning` counts downloads too, so a delete also waits behind
	 * another seq2seq download, exactly as that path does. Only the unload
	 * waits: the files go either way. A slot on the other device holds none
	 * of this copy and stays.
	 *
	 * Not `async`: with nothing running the unload is posted in the caller's
	 * own tick, so a teardown in that same tick rejects it as a disposal
	 * rather than leaving it posted to a worker that will never answer.
	 */
	private releaseEngineForDelete(engine: EngineName, device: Device): Promise<void> {
		const onDevice = () =>
			this.engineDevice[engine] === null || this.engineDevice[engine] === device;

		if (this.engineRunning[engine] === 0) {
			return onDevice() ? this.unloadForDelete(engine) : Promise.resolve();
		}

		const worker = this.worker;

		return this.whenEngineIdle(engine).then(() => {
			// Work on it started again while we waited, or the worker went
			// with a teardown that unloaded everything anyway.
			if (
				this.engineRunning[engine] > 0 ||
				this.worker !== worker ||
				!this.worker ||
				!onDevice()
			) {
				return;
			}

			return this.unloadForDelete(engine);
		});
	}

	private unloadForDelete(engine: EngineName): Promise<void> {
		return this.client()
			.unload(engine)
			.then(() => {
				this.loadedEngines.delete(engine);
			});
	}

	/** Resolves once nothing runs on `engine`; at once when nothing does. */
	private whenEngineIdle(engine: EngineName): Promise<void> {
		if (this.engineRunning[engine] === 0) {
			return Promise.resolve();
		}

		return new Promise((resolve) => this.engineWaiters.push({engine, resolve}));
	}

	/** Drop every loaded model and the worker with them. */
	unloadAll(): Promise<void> {
		this.teardown();

		return Promise.resolve();
	}

	pagehide(): void {
		this.teardown();
	}

	dispose(): void {
		this.disposed = true;
		this.inUse = null;

		if (this.usageTimer !== null) {
			this.deps.clearTimeout(this.usageTimer);
			this.usageTimer = null;
		}

		this.teardown();
		this.listeners.clear();
		this.workerErrorListeners.clear();
	}

	private client(): TranslateClient {
		if (this.disposed || !this.options.enabled) {
			throw new Error(TRANSLATION_UNAVAILABLE);
		}

		if (!this.worker) {
			const worker = this.deps.createClient();

			this.worker = worker;
			this.cpuHeapUsed = false;
			worker.client.onWorkerError = (message: string) => this.reportWorkerError(message);
			worker.client.onDead = (detail: string) => this.workerDied(worker, detail);
			worker.client.configure(this.options.catalog, this.options.ortBase, this.gpuBudget());
		}

		return this.worker.client;
	}

	private reportWorkerError(message: string | null): void {
		for (const listener of this.workerErrorListeners) {
			listener(message);
		}
	}

	/**
	 * A worker that never started (client.ts `workerError`). What it was
	 * asked fails as unavailable -- a real failure, which the reading queue
	 * counts toward a pause, not the WORKER_DISPOSED it puts back and
	 * retries a second later, which against a script that will not load
	 * was a fresh worker every second -- and the worker is dropped without
	 * the teardown's generation step (nothing ran on it), so the next call
	 * asks for a fresh one: a deploy that finishes, or a page back online,
	 * is picked up without a reload. Settings says so too.
	 */
	private workerDied(worker: {client: TranslateClient; terminate(): void}, detail: string): void {
		if (this.worker !== worker) {
			return;
		}

		const message = detail ? `${TRANSLATION_UNAVAILABLE}: ${detail}` : TRANSLATION_UNAVAILABLE;

		this.worker = null;
		this.clearIdle();
		this.clearEngineTimer("llm");
		this.clearEngineTimer("seq2seq");
		this.loadedEngines.clear();
		worker.client.fail(new Error(message));
		worker.terminate();
		this.deadReported = true;
		this.reportWorkerError(message);
	}

	private teardown(): void {
		this.clearIdle();
		this.clearEngineTimer("llm");
		this.clearEngineTimer("seq2seq");
		this.loadedEngines.clear();
		this.generation++;

		if (this.worker) {
			this.worker.client.dispose();
			this.worker.terminate();
			this.worker = null;
		}
	}

	/**
	 * Nothing in flight any more. The models themselves go by their own
	 * engine's timer (`afterEngineIdle`); a worker holding none (Settings only
	 * asked what is downloaded) goes after the longer wait. And translation
	 * may no longer be in use at all.
	 */
	private scheduleIdle(): void {
		this.clearIdle();

		if (!this.worker || this.inFlight !== 0) {
			return;
		}

		this.usageChanged();

		if (this.loadedEngines.size === 0) {
			this.idleTimer = this.deps.setTimeout(() => {
				this.idleTimer = null;

				if (this.inFlight === 0 && this.loadedEngines.size === 0) {
					this.teardown();
				}
			}, CPU_IDLE_UNLOAD_MS);
		}
	}

	private engineStarted(ref: ModelRef, device: Device): void {
		const engine = ref.engine;

		this.engineDevice[engine] = device;

		if (engine === "seq2seq") {
			if (!this.loadedEngines.has("seq2seq")) {
				this.seq2seqFamilies.clear();
			}

			this.seq2seqFamilies.add(ref.family);
		}

		this.engineRunning[engine]++;
		// Counted as loaded from the first request on: unloading an engine
		// whose load then failed costs nothing, missing one costs its memory.
		this.loadedEngines.add(engine);
		this.clearEngineTimer(engine);
	}

	private engineEnded(engine: EngineName): void {
		this.engineRunning[engine] = Math.max(0, this.engineRunning[engine] - 1);

		if (this.engineRunning[engine] === 0) {
			const waiting = this.engineWaiters;

			this.engineWaiters = waiting.filter((w) => w.engine !== engine);

			for (const waiter of waiting) {
				if (waiter.engine === engine) {
					waiter.resolve();
				}
			}
		}

		this.afterEngineIdle(engine);
	}

	/**
	 * An engine with nothing running: unloaded at once when its tier is
	 * switched off, otherwise after its idle wait unless a request arrives
	 * first -- by the device its models are on, 3 minutes on the GPU and 5 on
	 * the CPU.
	 */
	private afterEngineIdle(engine: EngineName): void {
		if (this.engineRunning[engine] > 0 || !this.loadedEngines.has(engine)) {
			return;
		}

		if (!this.engineAllowed(engine)) {
			this.unloadEngine(engine);
			return;
		}

		this.clearEngineTimer(engine);
		this.engineTimers[engine] = this.deps.setTimeout(
			() => {
				this.engineTimers[engine] = null;

				if (this.engineRunning[engine] === 0) {
					this.unloadEngine(engine);
				}
			},
			(this.engineDevice[engine] ?? (engine === "llm" ? "gpu" : "cpu")) === "gpu"
				? GPU_IDLE_UNLOAD_MS
				: CPU_IDLE_UNLOAD_MS
		);
	}

	/**
	 * Whether the user's switches still want what `engine` holds: the
	 * language model's switch, or for the seq2seq engine the switch of a
	 * family it has loaded (NLLB-200 needs no OPUS-MT switch, nor the other
	 * way round). The engine unloads whole, so it stays while any of its
	 * families is still on.
	 */
	private engineAllowed(engine: EngineName): boolean {
		const switches = this.settings.switches;

		if (engine === "llm") {
			return switches.llm;
		}

		if (this.seq2seqFamilies.size === 0) {
			return switches.opus || switches.nllb;
		}

		return [...this.seq2seqFamilies].some((family) => switches[family]);
	}

	/** The engine's models out of memory; the last engine going takes the worker. */
	private unloadEngine(engine: EngineName): void {
		this.clearEngineTimer(engine);

		const worker = this.worker;

		if (!worker || !this.loadedEngines.has(engine)) {
			return;
		}

		this.loadedEngines.delete(engine);

		if (this.loadedEngines.size === 0 && this.inFlight === 0) {
			this.teardown();
			return;
		}

		worker.client.unload(engine).catch(() => {
			// A worker torn down meanwhile unloaded it anyway.
		});
	}

	private clearEngineTimer(engine: EngineName): void {
		if (this.engineTimers[engine] !== null) {
			this.deps.clearTimeout(this.engineTimers[engine]);
			this.engineTimers[engine] = null;
		}
	}

	private clearIdle(): void {
		if (this.idleTimer !== null) {
			this.deps.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	private view(ref: ModelRef, device: Device): ModelView {
		const key = copyKey(ref, device);
		let view = this.views.get(key);

		if (!view) {
			view = {ref, device, cached: false, status: "idle", fraction: 0, error: null};
			this.views.set(key, view);
		}

		return view;
	}

	/** One row per copy, in catalog order, a model's GPU copy first. */
	private snapshot(): ModelView[] {
		return catalogModels(this.options.catalog).flatMap((ref) =>
			copyDevices(ref).map((device) => {
				const view: ModelView = this.views.get(copyKey(ref, device)) ?? {
					ref,
					device,
					cached: false,
					status: "idle",
					fraction: 0,
					error: null,
				};

				return {...view};
			})
		);
	}

	private publish(): void {
		const views = this.snapshot();

		for (const listener of this.listeners) {
			listener(views);
		}
	}
}
