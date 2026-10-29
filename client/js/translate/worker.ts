// The worker's side of the protocol: one handler per message, the engines
// behind it. A translate request loads its model first when the engine does
// not have it (the page's service also loads explicitly, for Settings). A
// cancel aborts the request's signal; the engine stops at its next chunk.
// Nothing here knows about the libraries: worker-entry.ts hands in the real
// engines, tests and fakePort.ts hand in scripted ones.

import {Device, Engine, EngineError, EngineName, ModelRef} from "./engine";
import {CacheApi, GpuBudget, ModelCatalog, cacheStates, copyDevices} from "./models";
import {EngineSnapshot, MainToWorker, WorkerPort, errorMessage} from "./protocol";

export interface EngineSet {
	llm: Engine;
	seq2seq: Engine;
}

export interface WorkerDeps {
	/** The libraries' global configuration (mirror base, ORT wasm path, the GPU's budget). */
	configure(catalog: ModelCatalog, ortBase: string, gpu?: GpuBudget): void;
	cache: CacheApi;
}

export function serveEngines(port: WorkerPort, engines: EngineSet, deps: WorkerDeps): () => void {
	const controllers = new Map<number, AbortController>();
	const loading = new Map<string, Promise<void>>();
	let catalog: ModelCatalog | null = null;

	// A copy has two ways in — Settings' explicit `load` and the implicit one
	// a `translate` needs — and they can ask for the same copy at once, so the
	// second joins the first rather than starting a second download. The two
	// devices' copies of one model are two loads, never joined. Progress is
	// posted once per report and client.ts fans it out to the `load` caller
	// and to every stream waiting on that copy.
	const load = (ref: ModelRef, device: Device): Promise<void> => {
		const key = `${ref.id}@${device}`;
		const inFlight = loading.get(key);

		if (inFlight) {
			return inFlight;
		}

		const promise = engines[ref.engine]
			.load(ref, device, (progress) =>
				port.postMessage({type: "progress", ref, device, progress})
			)
			.finally(() => loading.delete(key));

		loading.set(key, promise);

		return promise;
	};

	/**
	 * Where a translate request runs: the device it names (the service names
	 * one on every request). Without one, where the model is loaded already,
	 * else its first copy (the GPU's when it has one).
	 */
	const deviceFor = (engine: Engine, ref: ModelRef, device: Device | undefined): Device =>
		device ??
		(["gpu", "cpu"] as const).find((d) => engine.isLoaded(ref.id, d)) ??
		copyDevices(ref)[0] ??
		"cpu";

	const snapshot = (): Record<EngineName, EngineSnapshot> => ({
		llm: {status: engines.llm.status(), models: engines.llm.loadedModels()},
		seq2seq: {
			status: engines.seq2seq.status(),
			models: engines.seq2seq.loadedModels(),
			threads: engines.seq2seq.capabilities().threads,
		},
	});

	const handle = async (message: MainToWorker): Promise<void> => {
		switch (message.type) {
			case "configure":
				try {
					catalog = message.catalog;
					deps.configure(message.catalog, message.ortBase, message.gpu);
				} catch (e) {
					port.postMessage({type: "error", scope: "worker", message: errorMessage(e)});
				}

				break;

			case "load": {
				try {
					await load(message.ref, message.device);
					port.postMessage({type: "loaded", ref: message.ref, device: message.device});
				} catch (e) {
					port.postMessage({
						type: "error",
						scope: "load",
						ref: message.ref,
						device: message.device,
						message: errorMessage(e),
					});
				}

				break;
			}

			case "unload":
				try {
					await engines[message.engine].unload();
					port.postMessage({type: "unloaded", engine: message.engine});
				} catch (e) {
					port.postMessage({
						type: "error",
						scope: "unload",
						engine: message.engine,
						message: errorMessage(e),
					});
				}

				break;

			case "translate": {
				const engine = engines[message.ref.engine];
				const controller = new AbortController();
				const device = deviceFor(engine, message.ref, message.req.device);
				const req = {...message.req, device};

				controllers.set(message.req.id, controller);

				try {
					if (!engine.isLoaded(message.ref.id, device)) {
						try {
							await load(message.ref, device);
						} catch (e) {
							// The model could not load: that is the model's
							// failure, not this request's, and the page tells
							// the two apart by the scope (the id says which
							// stream to fail).
							if (!controller.signal.aborted) {
								port.postMessage({
									type: "error",
									scope: "load",
									id: message.req.id,
									ref: message.ref,
									device,
									message: errorMessage(e),
								});
							}

							return;
						}
					}

					for await (const chunk of engine.translate(req, controller.signal)) {
						if (controller.signal.aborted) {
							break;
						}

						port.postMessage({type: "chunk", chunk});
					}

					if (!controller.signal.aborted) {
						port.postMessage({type: "done", id: message.req.id});
					}
				} catch (e) {
					if (!controller.signal.aborted) {
						port.postMessage({
							type: "error",
							scope:
								e instanceof EngineError && e.cause === "load"
									? "load"
									: "translate",
							id: message.req.id,
							ref: message.ref,
							message: errorMessage(e),
						});
					}
				} finally {
					controllers.delete(message.req.id);
				}

				break;
			}

			case "cancel":
				controllers.get(message.id)?.abort();
				break;
			case "status":
				try {
					port.postMessage({type: "status", engines: snapshot()});
				} catch (e) {
					port.postMessage({type: "error", scope: "status", message: errorMessage(e)});
				}

				break;
			case "models":
				try {
					port.postMessage({
						type: "models",
						models: catalog ? await cacheStates(catalog, deps.cache) : [],
					});
				} catch (e) {
					port.postMessage({type: "error", scope: "models", message: errorMessage(e)});
				}

				break;
			case "delete":
				try {
					await deps.cache.delete(message.ref, message.device);
					port.postMessage({type: "deleted", ref: message.ref, device: message.device});
				} catch (e) {
					port.postMessage({
						type: "error",
						scope: "delete",
						ref: message.ref,
						device: message.device,
						message: errorMessage(e),
					});
				}

				break;
		}
	};

	port.onmessage = (event) => {
		handle(event.data).catch((e) =>
			port.postMessage({type: "error", scope: "worker", message: errorMessage(e)})
		);
	};

	return () => {
		port.onmessage = null;

		for (const controller of controllers.values()) {
			controller.abort();
		}
	};
}
