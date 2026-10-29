import {expect} from "chai";
import sinon from "ts-sinon";
import type {Capability} from "../../client/js/translate/capability";
import {
	BATCH_REFUSED,
	emptyContext,
	type Device,
	type ModelRef,
} from "../../client/js/translate/engine";
import {
	QWEN3_1_7B_ID,
	QWEN3_4B_ID,
	buildCatalog,
	type CacheApi,
	type DeviceChoices,
	type ModelCatalog,
} from "../../client/js/translate/models";
import {ABORTED} from "../../client/js/translate/outgoing";
import {createPortPair} from "../../client/js/translate/protocol";
import type {RouteTable} from "../../client/js/translate/router";
import {DEFAULT_ROUTES} from "../../client/js/translate/routes.default";
import {TranslateClient, WORKER_DISPOSED} from "../../client/js/translate/client";
import {
	CACHE_WAIT_MS,
	CPU_IDLE_UNLOAD_MS,
	GPU_IDLE_UNLOAD_MS,
	TRANSLATION_UNAVAILABLE,
	TranslateService,
	loadNote,
	type ServiceDeps,
} from "../../client/js/translate/service";
import {serveEngines} from "../../client/js/translate/worker";
import {
	PAUSE_AFTER_FAILURES,
	TranslateQueue,
	type QueueUpdate,
} from "../../client/js/translate/queue";
import {protect} from "../../client/js/translate/spans";
import {
	memoryConsent,
	needsDownloadError,
	parseNeedsDownload,
} from "../../client/js/translate/consent";
import {FakeEngine} from "./fakeEngine";

const AUTO: DeviceChoices = {llm: "auto", opus: "auto", nllb: "auto"};

// OPUS-MT and NLLB-200 with their GPU copies (off in the shipped catalog,
// models.ts CatalogOptions `seq2seqGpu`), so the per-device logic is covered.
const catalog = buildCatalog({seq2seqGpu: true});

/**
 * A service whose workers never answer: `dies` fires each one's `error`
 * (client.ts `workerError`) as a script that will not load does, shortly
 * after it is created; otherwise it is a worker that started and hangs.
 * Workers from `healthyFrom` on (counting from 0) are served and answer.
 */
function deadWorkerRig(dies: boolean, healthyFrom = Infinity) {
	const clock = sinon.useFakeTimers();
	const created: {client: TranslateClient; terminated: boolean}[] = [];
	const errors: (string | null)[] = [];
	const service = new TranslateService(
		{
			createClient() {
				const [mainPort, workerPort] = createPortPair();
				const client = new TranslateClient(mainPort);
				const entry = {client, terminated: false};
				const healthy = created.length >= healthyFrom;

				created.push(entry);

				if (healthy) {
					serveEngines(
						workerPort,
						{
							llm: new FakeEngine("llm", (req) => [req.text]),
							seq2seq: new FakeEngine("seq2seq", (req) => [req.text]),
						},
						{
							cache: {
								has: () => Promise.resolve(false),
								delete: () => Promise.resolve(),
							},
							configure() {},
						}
					);
				} else if (dies) {
					setTimeout(() => client.workerError(""), 5);
				}

				return {
					client,
					terminate() {
						entry.terminated = true;
					},
				};
			},
			probe: () => Promise.resolve(capability("gpu")),
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
		},
		{catalog, selectedLlm: QWEN3_1_7B_ID, ortBase: "https://app.test/js/ort/", enabled: true},
		{switches: {llm: true, opus: true, nllb: true}, devices: AUTO}
	);

	service.onWorkerError((message) => errors.push(message));

	return {clock, service, created, errors};
}

function capability(tier: Capability["tier"]): Capability {
	return {
		tier,
		reasons: tier === "gpu" ? [] : ["NO_WEBGPU" as const],
		f16: tier === "gpu",
		// A desktop Chrome adapter: Chrome clamps the binding to ~2 GiB.
		maxBufferBytes: tier === "gpu" ? 2147483644 : 0,
		deviceMemoryGiB: 8,
		storageQuotaBytes: null,
		mobile: false,
	};
}

function rig(
	tier: Capability["tier"] = "gpu",
	enabled = true,
	routes: RouteTable = DEFAULT_ROUTES,
	consent: Pick<ServiceDeps, "askDownload" | "consent"> = {},
	shape: {catalog?: ModelCatalog; maxBufferBytes?: number} = {}
) {
	const clock = sinon.useFakeTimers();
	const workers: {terminated: boolean}[] = [];
	const cached = new Set<string>();
	let failDelete: Error | null = null;
	let failConfigure: Error | null = null;
	let hangDelete = false;
	let probes = 0;
	/** Every copy delete the worker was asked for, as `<id>@<device>`. */
	const deleted: string[] = [];
	// `cached` holds a plain id (every copy of the model is on the device)
	// or `<id>@<device>` (that copy alone).
	const cache: CacheApi = {
		has(ref, device) {
			return Promise.resolve(cached.has(ref.id) || cached.has(`${ref.id}@${device}`));
		},
		delete(ref, device) {
			deleted.push(`${ref.id}@${device}`);

			if (hangDelete) {
				return new Promise<void>(() => {});
			}

			if (failDelete) {
				const error = failDelete;

				failDelete = null;

				return Promise.reject(error);
			}

			if (cached.delete(ref.id)) {
				for (const other of ["gpu", "cpu"] as const) {
					if (other !== device && ref.copies[other]) {
						cached.add(`${ref.id}@${other}`);
					}
				}
			}

			cached.delete(`${ref.id}@${device}`);

			return Promise.resolve();
		},
	};
	const llm = new FakeEngine("llm", (req) => [`llm:${req.text}`]);
	const seq2seq = new FakeEngine("seq2seq", (req) => [`seq:${req.text}`]);
	const deps: ServiceDeps = {
		createClient() {
			const [mainPort, workerPort] = createPortPair();
			const entry = {terminated: false};

			workers.push(entry);
			const stop = serveEngines(
				workerPort,
				{llm, seq2seq},
				{
					cache,
					configure() {
						if (failConfigure) {
							const error = failConfigure;

							failConfigure = null;

							throw error;
						}
					},
				}
			);

			return {
				client: new TranslateClient(mainPort),
				terminate() {
					entry.terminated = true;
					stop();
				},
			};
		},
		probe() {
			probes += 1;
			const probed = capability(tier);

			return Promise.resolve(
				shape.maxBufferBytes === undefined
					? probed
					: {...probed, maxBufferBytes: shape.maxBufferBytes}
			);
		},
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
		...consent,
	};
	const service = new TranslateService(
		deps,
		{
			catalog: shape.catalog ?? catalog,
			// A chosen model, so the probe's own default (an unset choice
			// resolves against the device) leaves these rigs alone.
			selectedLlm: QWEN3_1_7B_ID,
			routesFor: () => routes,
			ortBase: "https://app.test/js/ort/",
			enabled,
		},
		{switches: {llm: true, opus: true, nllb: true}, devices: AUTO}
	);

	return {
		service,
		workers,
		cached,
		deleted,
		clock,
		llm,
		seq2seq,
		/** How many times the device probe ran. */
		get probes() {
			return probes;
		},
		failNextDelete(error: Error) {
			failDelete = error;
		},
		failNextConfigure(error: Error) {
			failConfigure = error;
		},
		hangNextDelete() {
			hangDelete = true;
		},
	};
}

/** Hold the rig's first LLM request before its first chunk until the returned function is called. */
function gateLlm(r: ReturnType<typeof rig>): () => void {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const original = r.llm.translate.bind(r.llm);
	let first = true;

	r.llm.translate = async function* (req, signal) {
		if (first) {
			first = false;
			await gate;
		}

		yield* original(req, signal);
	};

	return release;
}

/** Hold the rig's first seq2seq request before its first chunk until the returned function is called. */
function gateSeq(r: ReturnType<typeof rig>): () => void {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const original = r.seq2seq.translate.bind(r.seq2seq);
	let first = true;

	r.seq2seq.translate = async function* (req, signal) {
		if (first) {
			first = false;
			await gate;
		}

		yield* original(req, signal);
	};

	return release;
}

/** Hold the rig's LLM load of `id` until `release` is called; `asked` records every load asked for. */
function gateLlmLoad(
	r: ReturnType<typeof rig>,
	id: string
): {release: () => void; asked: string[]} {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const original = r.llm.load.bind(r.llm);
	const asked: string[] = [];

	r.llm.load = async (ref, device, onProgress) => {
		asked.push(ref.id);

		if (ref.id === id) {
			await gate;
		}

		return original(ref, device, onProgress);
	};

	return {release: () => release(), asked};
}

async function text(iterable: AsyncIterable<{text: string; done: boolean}>) {
	let last = "";

	for await (const chunk of iterable) {
		last = chunk.text;
	}

	return last;
}

const base = {
	text: "Hallo",
	from: "de",
	to: "en",
	purpose: "read" as const,
	context: emptyContext(),
};

describe("translate/service", () => {
	let clock: sinon.SinonFakeTimers | null = null;

	afterEach(() => {
		clock?.restore();
		clock = null;
	});

	it("routes to the LLM on a gpu device and to a CPU model otherwise", async () => {
		const gpu = rig("gpu");
		clock = gpu.clock;
		expect((await gpu.service.route("de", "en"))?.candidate).to.equal("llm");
		expect(await text(gpu.service.translate(base))).to.equal("llm:Hallo");
		expect(gpu.llm.calls.load.map((r) => r.id)).to.deep.equal([catalog.llm.id]);
		gpu.service.dispose();
		gpu.clock.restore();

		const cpu = rig("cpu");
		clock = cpu.clock;
		expect((await cpu.service.route("de", "en"))?.candidate).to.equal("opus:de-en");
		expect(await text(cpu.service.translate(base))).to.equal("seq:Hallo");
		cpu.service.dispose();
	});

	it("a seq2seq route takes the source hint as its source; the LLM keeps from: null", async () => {
		const hinted = {...base, from: null, context: {...emptyContext(), sourceHint: "de"}};
		const cpu = rig("cpu");
		clock = cpu.clock;

		expect((await cpu.service.route(null, "en", "de"))?.candidate).to.equal("opus:de-en");
		expect(await text(cpu.service.translate(hinted))).to.equal("seq:Hallo");
		expect(cpu.seq2seq.calls.translate[0].from).to.equal("de");
		cpu.service.dispose();
		cpu.clock.restore();

		const gpu = rig("gpu");
		clock = gpu.clock;

		expect(await text(gpu.service.translate(hinted))).to.equal("llm:Hallo");
		expect(gpu.llm.calls.translate[0].from).to.equal(null);
		gpu.service.dispose();
	});

	it("the request's routing hint wins over the context's and never changes the prompt context", async () => {
		const r = rig("cpu");
		clock = r.clock;
		const request = {
			...base,
			from: null,
			hint: "de",
			context: {...emptyContext(), sourceHint: "fr"},
		};

		expect(await text(r.service.translate(request))).to.equal("seq:Hallo");
		expect(r.seq2seq.calls.translate[0].from).to.equal("de");
		expect(r.seq2seq.calls.translate[0].context.sourceHint).to.equal("fr");
		r.service.dispose();
	});

	it("a download started from Settings does not move loadTicks on its own", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const ticks = r.service.loadTicks();

		await r.service.download(catalog.nllb, "gpu");

		expect(r.service.loadTicks()).to.equal(ticks);
		r.service.dispose();
	});

	it("the first route knows what is downloaded without Settings having asked", async () => {
		const r = rig("gpu", true, {en: {de: [["llm", "opus:de-en"]]}});
		clock = r.clock;
		r.cached.add(catalog.opus["de-en"].id);

		expect((await r.service.route("de", "en"))?.candidate).to.equal("opus:de-en");
		r.service.dispose();
	});

	it("a better class is downloaded on demand rather than skipped for a downloaded worse one", async () => {
		const r = rig("gpu", true, {en: {sw: ["nllb", "llm"]}});
		clock = r.clock;
		r.cached.add(catalog.llm.id);
		const seen: string[] = [];

		r.service.onModels((views) => {
			const nllb = views.find((v) => v.ref.id === catalog.nllb.id);

			if (nllb) {
				seen.push(nllb.status);
			}
		});

		const ticks = r.service.loadTicks();

		expect(await text(r.service.translate({...base, from: "sw"}))).to.equal("seq:Hallo");
		expect(r.seq2seq.calls.load.map((ref) => ref.id)).to.deep.equal([catalog.nllb.id]);
		expect(r.llm.calls.load).to.deep.equal([]);
		expect(seen).to.include("downloading");
		// The deadlines of the queue and the composer watch this counter.
		expect(r.service.loadTicks()).to.be.greaterThan(ticks);
		r.service.dispose();
	});

	it("a better class whose download fails falls to the next class, the reason kept", async () => {
		const r = rig("gpu", true, {en: {sw: ["nllb", "llm"]}});
		clock = r.clock;
		// NLLB-200 on one device: its one copy failing takes it out.
		r.service.setSettings({
			switches: {llm: true, opus: true, nllb: true},
			devices: {...AUTO, nllb: "cpu"},
		});
		r.seq2seq.failLoad = new Error("quota exceeded");

		expect(await text(r.service.translate({...base, from: "sw"}))).to.equal("llm:Hallo");
		expect((await r.service.route("sw", "en"))?.candidate).to.equal("llm");

		const views = await r.service.models();
		const cpu = views.find((v) => v.ref.id === catalog.nllb.id && v.device === "cpu");

		expect(cpu?.error).to.equal("quota exceeded");
		r.service.dispose();
	});

	it("loadNote reports the phase, the model and how far it has got", () => {
		const view = {
			ref: catalog.nllb,
			cached: false,
			status: "downloading" as const,
			fraction: 0.424,
			error: null,
		};

		// Data, not copy: the phrase is helpers/modelLabel.ts's.
		expect(loadNote(view)).to.deep.equal({
			phase: "downloading",
			ref: catalog.nllb,
			percent: 42,
		});
		// Already on this device: loaded back into memory, not downloaded again.
		expect(loadNote({...view, cached: true})).to.deep.equal({
			phase: "loading",
			ref: catalog.nllb,
			percent: 42,
		});
	});

	it("marks a candidate down when its model fails to load and takes the next", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await r.service.capabilities();
		// the worker exists only after the first request; create it, then break the LLM
		expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
		await r.llm.unload();
		r.llm.failLoad = new Error("device lost");
		expect(await text(r.service.translate({...base, text: "Zwei"}))).to.equal("seq:Zwei");
		expect((await r.service.route("de", "en"))?.candidate).to.equal("opus:de-en");
		r.service.dispose();
	});

	it("a load failure lands on the model view and travels with the error", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await r.service.models();
		r.llm.failLoad = new Error("device lost");
		// failLoad is one-shot; both seq2seq candidates (the OPUS pair, then
		// NLLB) have to refuse for the loop to run out of route.
		r.seq2seq.load = () => Promise.reject(new Error("Can't create a session"));

		let message = "";

		try {
			await text(r.service.translate(base));
		} catch (e) {
			message = (e as Error).message;
		}

		// The generic message would say nothing about why the tier is dead;
		// the last candidate's model and reason ride with it.
		expect(message).to.equal(
			`${TRANSLATION_UNAVAILABLE}: ${catalog.nllb.id}: Can't create a session`
		);

		const views = await r.service.models();

		expect(views.find((v) => v.ref.id === catalog.llm.id)).to.include({
			status: "failed",
			error: "device lost",
		});
		expect(views.find((v) => v.ref.id === catalog.opus["de-en"].id)).to.include({
			status: "failed",
			error: "Can't create a session",
		});
		r.service.dispose();
	});

	it("a request the model cannot serve is reported, not blamed on the model", async () => {
		const r = rig("gpu");
		clock = r.clock;
		r.llm.failTranslate = new Error("no NLLB code for xx");

		let message = "";

		try {
			await text(r.service.translate(base));
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal("no NLLB code for xx");
		// not retried on the next candidate, and the LLM is still the route
		expect(r.seq2seq.calls.translate.length).to.equal(0);
		expect((await r.service.route("de", "en"))?.candidate).to.equal("llm");
		r.service.dispose();
	});

	// The reading queue batches lines for the GPU model when they are
	// queued, and the route is resolved again when the batch runs: the model
	// switched off, or down after a failed load, sends it to a seq2seq
	// candidate, which cannot take it. Said before anything is loaded, in
	// the one message the queue knows to split the batch on.
	it("a batch routed to a seq2seq candidate is refused before its model loads", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await text(r.service.translate(base));
		await r.llm.unload();
		r.llm.failLoad = new Error("device lost");

		let message = "";

		try {
			await text(r.service.translate({...base, text: "", lines: ["Eins", "Zwei"]}));
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal(BATCH_REFUSED);
		expect(r.seq2seq.calls.load).to.deep.equal([]);
		expect(r.seq2seq.calls.translate).to.deep.equal([]);

		r.service.setSettings({switches: {llm: false, opus: true, nllb: true}, devices: AUTO});
		message = "";

		try {
			await text(r.service.translate({...base, text: "", lines: ["Eins", "Zwei"]}));
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal(BATCH_REFUSED);
		expect(r.seq2seq.calls.load).to.deep.equal([]);
		r.service.dispose();
	});

	it("downloading a model that failed puts its candidate back in the route", async () => {
		const r = rig("gpu");
		clock = r.clock;
		r.llm.failLoad = new Error("device lost");

		expect(await text(r.service.translate(base))).to.equal("seq:Hallo");
		expect((await r.service.route("de", "en"))?.candidate).to.equal("opus:de-en");

		await r.service.download(catalog.llm, "gpu");

		expect((await r.service.route("de", "en"))?.candidate).to.equal("llm");
		r.service.dispose();
	});

	it("a download and a translation of the same model share one load", async () => {
		const r = rig("gpu");
		clock = r.clock;
		// long enough that the translation certainly arrives while Settings'
		// download is still running: it must join that load, not start a second
		r.llm.loadTicks = 50;

		const [, translated] = await Promise.all([
			r.service.download(catalog.llm, "gpu"),
			text(r.service.translate(base)),
		]);

		expect(translated).to.equal("llm:Hallo");
		expect(r.llm.calls.load.length).to.equal(1);
		r.service.dispose();
	});

	it("gives up when no candidate is left", async () => {
		const r = rig("none");
		clock = r.clock;
		let message = "";

		try {
			await text(r.service.translate(base));
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal(TRANSLATION_UNAVAILABLE);
		r.service.dispose();
	});

	it("a copy whose load fails is down alone: Auto goes on to the model's other copy", async () => {
		const r = rig("gpu", true, {en: {sw: ["nllb", "llm"]}});
		clock = r.clock;
		// A computer: NLLB-200's GPU copy first under Auto.
		expect(await r.service.route("sw", "en")).to.deep.include({
			candidate: "nllb",
			device: "gpu",
		});
		r.seq2seq.failLoad = new Error("device lost");

		expect(await text(r.service.translate({...base, from: "sw"}))).to.equal("seq:Hallo");
		expect(r.seq2seq.calls.load.map((ref) => ref.id)).to.deep.equal([
			catalog.nllb.id,
			catalog.nllb.id,
		]);
		// The GPU copy, then the CPU copy: loads are keyed by device.
		expect(r.seq2seq.calls.devices).to.deep.equal(["gpu", "cpu"]);
		expect(await r.service.route("sw", "en")).to.deep.include({
			candidate: "nllb",
			device: "cpu",
		});
		r.service.dispose();
	});

	it("the engine settings narrow the route", async () => {
		const r = rig("gpu");
		clock = r.clock;
		r.service.setSettings({switches: {llm: false, opus: true, nllb: true}, devices: AUTO});
		expect((await r.service.route("de", "en"))?.candidate).to.equal("opus:de-en");
		// NLLB-200 has its own switch: OPUS-MT's off leaves it serving.
		r.service.setSettings({switches: {llm: false, opus: false, nllb: true}, devices: AUTO});
		expect((await r.service.route("de", "en"))?.candidate).to.equal("nllb");
		r.service.setSettings({switches: {llm: false, opus: false, nllb: false}, devices: AUTO});
		expect(await r.service.route("de", "en")).to.equal(null);
		r.service.dispose();
	});

	it("a GPU model switch unloads the old model and routes the next LLM request to the new one", async () => {
		const r = rig("gpu");
		clock = r.clock;
		expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
		expect(r.llm.calls.load.map((ref) => ref.id)).to.deep.equal([QWEN3_1_7B_ID]);

		r.service.setLlmModel(QWEN3_4B_ID);
		await r.clock.tickAsync(0);
		expect(r.llm.calls.unload).to.equal(1);
		expect(r.service.catalog.llm.id).to.equal(QWEN3_4B_ID);
		expect((await r.service.route("de", "en"))?.ref.id).to.equal(QWEN3_4B_ID);

		expect(await text(r.service.translate({...base, text: "Welt"}))).to.equal("llm:Welt");
		expect(r.llm.calls.load.map((ref) => ref.id)).to.deep.equal([QWEN3_1_7B_ID, QWEN3_4B_ID]);
		expect(r.llm.calls.translate.map((req) => req.model)).to.deep.equal([
			QWEN3_1_7B_ID,
			QWEN3_4B_ID,
		]);
		// No worker was torn down for it.
		expect(r.workers.length).to.equal(1);
		expect(r.workers[0].terminated).to.equal(false);
		r.service.dispose();
	});

	it("a switch to the model already selected changes nothing; an id that is no choice follows the device", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await text(r.service.translate(base));
		const before = r.service.catalog;

		r.service.setLlmModel(QWEN3_1_7B_ID);
		await r.clock.tickAsync(0);
		expect(r.service.catalog).to.equal(before);
		expect(r.llm.calls.unload).to.equal(0);

		// A stored id a later deploy no longer offers is no choice at all:
		// it resolves like an unset one, against the device (8 GiB here).
		r.service.setLlmModel("gone-model-q4f16_1-MLC");
		await r.clock.tickAsync(0);
		expect(r.service.catalog.llm.id).to.equal(QWEN3_4B_ID);
		r.service.dispose();
	});

	it("a switch with nothing loaded yet creates no worker", async () => {
		const r = rig("gpu");
		clock = r.clock;
		r.service.setLlmModel(QWEN3_4B_ID);
		await r.clock.tickAsync(0);
		expect(r.workers.length).to.equal(0);
		expect((await r.service.route("de", "en"))?.ref.id).to.equal(QWEN3_4B_ID);
		r.service.dispose();
	});

	it("a request in flight finishes on the old model; the switch waits for it", async () => {
		const r = rig("gpu");
		clock = r.clock;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const original = r.llm.translate.bind(r.llm);
		let started = 0;

		r.llm.translate = async function* (req, signal) {
			started++;

			if (started === 1) {
				await gate;
			}

			yield* original(req, signal);
		};

		const running = text(r.service.translate(base));

		await r.clock.tickAsync(0);
		expect(started).to.equal(1);

		r.service.setLlmModel(QWEN3_4B_ID);
		const next = text(r.service.translate({...base, text: "Welt"}));

		await r.clock.tickAsync(0);
		// Neither unloaded under the running request nor replaced by the new load.
		expect(r.llm.calls.unload).to.equal(0);
		expect(r.llm.calls.load.map((ref) => ref.id)).to.deep.equal([QWEN3_1_7B_ID]);
		expect(started).to.equal(1);

		release();
		expect(await running).to.equal("llm:Hallo");
		expect(await next).to.equal("llm:Welt");
		expect(r.llm.calls.unload).to.equal(1);
		expect(r.llm.calls.load.map((ref) => ref.id)).to.deep.equal([QWEN3_1_7B_ID, QWEN3_4B_ID]);
		expect(r.llm.calls.translate.map((req) => req.model)).to.deep.equal([
			QWEN3_1_7B_ID,
			QWEN3_4B_ID,
		]);
		r.service.dispose();
	});

	it("an unset GPU choice follows the device once the probe lands", async () => {
		// "" is no choice: the service resolves it against the probe's
		// answer, and the resolution happens when that answer arrives — the
		// catalog starts on the shipped default and moves to the 4B because
		// the rig's device reports 8 GiB.
		const r = rig("gpu");

		clock = r.clock;
		r.service.setLlmModel("");
		expect(r.service.catalog.llm.id).to.equal(QWEN3_1_7B_ID);
		expect(await r.service.capabilities()).to.include({tier: "gpu"});
		expect(r.service.catalog.llm.id).to.equal(QWEN3_4B_ID);
		// A choice of the user's outranks it, and survives the probe.
		r.service.setLlmModel(QWEN3_1_7B_ID);
		expect(r.service.catalog.llm.id).to.equal(QWEN3_1_7B_ID);
		r.service.dispose();
	});

	it("an unset choice resolves to a model with a CPU copy while the language model is pinned to the CPU", async () => {
		const r = rig("gpu");
		const on = {llm: true, opus: true, nllb: true};

		clock = r.clock;
		r.service.setLlmModel("");
		await r.service.capabilities();
		expect(r.service.catalog.llm.id).to.equal(QWEN3_4B_ID);
		// The 4B has no CPU copy: pinned there, the unset choice is the 1.7B.
		r.service.setSettings({switches: on, devices: {...AUTO, llm: "cpu"}});
		expect(r.service.catalog.llm.id).to.equal(QWEN3_1_7B_ID);
		r.service.setSettings({switches: on, devices: AUTO});
		expect(r.service.catalog.llm.id).to.equal(QWEN3_4B_ID);
		// A chosen 4B stands: the router says it cannot run there.
		r.service.setLlmModel(QWEN3_4B_ID);
		r.service.setSettings({switches: on, devices: {...AUTO, llm: "cpu"}});
		expect(r.service.catalog.llm.id).to.equal(QWEN3_4B_ID);
		r.service.dispose();
	});

	it("a Settings download of the other GPU model holds a request for the selected one until it is done", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const large = catalog.llmChoices.find((ref) => ref.id === QWEN3_4B_ID) as ModelRef;
		const load = gateLlmLoad(r, QWEN3_4B_ID);
		const jaFr = {...base, from: "ja", to: "fr"};
		const downloading = r.service.download(large, "gpu");

		await r.clock.tickAsync(0);
		expect(load.asked).to.deep.equal([QWEN3_4B_ID]);

		const running = text(r.service.translate(jaFr));

		await r.clock.tickAsync(0);
		// The 1.7B load does not start under the 4B one.
		expect(load.asked).to.deep.equal([QWEN3_4B_ID]);
		expect(r.llm.calls.translate).to.deep.equal([]);

		load.release();
		await downloading;
		expect(await running).to.equal("llm:Hallo");
		expect(load.asked).to.deep.equal([QWEN3_4B_ID, QWEN3_1_7B_ID]);
		expect(r.llm.calls.translate.map((req) => req.model)).to.deep.equal([QWEN3_1_7B_ID]);
		// Nothing was marked down on the way.
		expect((await r.service.route("ja", "fr"))?.candidate).to.equal("llm");
		r.service.dispose();
	});

	it("a switch waits for the old model's download before unloading it and loading the new one", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const small = catalog.llmChoices.find((ref) => ref.id === QWEN3_1_7B_ID) as ModelRef;
		const load = gateLlmLoad(r, QWEN3_1_7B_ID);
		const jaFr = {...base, from: "ja", to: "fr"};
		const downloading = r.service.download(small, "gpu");

		await r.clock.tickAsync(0);
		expect(load.asked).to.deep.equal([QWEN3_1_7B_ID]);

		r.service.setLlmModel(QWEN3_4B_ID);

		const running = text(r.service.translate(jaFr));

		await r.clock.tickAsync(0);
		expect(r.llm.calls.unload).to.equal(0);
		expect(load.asked).to.deep.equal([QWEN3_1_7B_ID]);

		load.release();
		await downloading;
		expect(await running).to.equal("llm:Hallo");
		expect(r.llm.calls.unload).to.equal(1);
		expect(load.asked).to.deep.equal([QWEN3_1_7B_ID, QWEN3_4B_ID]);
		expect(r.llm.calls.translate.map((req) => req.model)).to.deep.equal([QWEN3_4B_ID]);
		expect((await r.service.route("ja", "fr"))?.ref.id).to.equal(QWEN3_4B_ID);
		r.service.dispose();
	});

	it("deleting the unselected GPU model leaves the selected one's request and idle clock alone", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const large = catalog.llmChoices.find((ref) => ref.id === QWEN3_4B_ID) as ModelRef;
		const release = gateLlm(r);
		const running = text(r.service.translate(base));

		await r.clock.tickAsync(0);
		await r.service.remove(large, "gpu");
		expect(r.llm.calls.unload).to.equal(0);

		release();
		expect(await running).to.equal("llm:Hallo");
		expect(r.llm.isLoaded(QWEN3_1_7B_ID)).to.equal(true);
		expect(r.llm.calls.unload).to.equal(0);

		// The idle unload still fires: 1.7B is the only engine loaded, so the
		// worker goes with it.
		await r.clock.tickAsync(GPU_IDLE_UNLOAD_MS);
		expect(r.workers[0].terminated).to.equal(true);
		r.service.dispose();
	});

	it("deleting the loaded GPU model waits for its request, then unloads it", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const small = catalog.llmChoices.find((ref) => ref.id === QWEN3_1_7B_ID) as ModelRef;
		const release = gateLlm(r);
		const running = text(r.service.translate(base));

		await r.clock.tickAsync(0);

		const deleting = r.service.remove(small, "gpu");

		await r.clock.tickAsync(0);
		expect(r.llm.calls.unload).to.equal(0);

		release();
		expect(await running).to.equal("llm:Hallo");
		await deleting;
		expect(r.llm.calls.unload).to.equal(1);
		expect(r.llm.isLoaded(QWEN3_1_7B_ID)).to.equal(false);
		r.service.dispose();
	});

	// The GPU path has waited for its model's work since the switch landed;
	// the CPU path unloaded the engine under whatever was running on it, so
	// deleting a model from Settings killed a translation in flight.
	it("deleting a CPU model waits for the request running on it, then unloads it", async () => {
		const r = rig("cpu");
		clock = r.clock;
		r.cached.add(catalog.nllb.id);

		const release = gateSeq(r);
		const running = text(r.service.translate(base));

		await r.clock.tickAsync(0);

		const deleting = r.service.remove(catalog.nllb, "cpu");

		await r.clock.tickAsync(0);
		expect(r.seq2seq.calls.unload).to.equal(0);

		release();
		expect(await running).to.equal("seq:Hallo");
		await deleting;

		expect(r.seq2seq.calls.unload).to.equal(1);
		expect(r.cached.has(catalog.nllb.id)).to.equal(false);
		r.service.dispose();
	});

	it("a switch lifts the old model's down-mark; the new model failing marks it down as today", async () => {
		const r = rig("gpu");
		clock = r.clock;
		// Japanese into French: the LLM strictly first, NLLB the next class.
		const jaFr = {...base, from: "ja", to: "fr"};

		r.llm.failLoad = new Error("out of memory");
		expect(await text(r.service.translate(jaFr))).to.equal("seq:Hallo");
		expect((await r.service.route("ja", "fr"))?.candidate).to.equal("nllb");

		r.service.setLlmModel(QWEN3_4B_ID);
		await r.clock.tickAsync(0);
		expect((await r.service.route("ja", "fr"))?.ref.id).to.equal(QWEN3_4B_ID);

		r.llm.failLoad = new Error("no adapter memory");
		expect(await text(r.service.translate(jaFr))).to.equal("seq:Hallo");
		const view = (await r.service.models()).find((v) => v.ref.id === QWEN3_4B_ID);

		expect(view).to.include({status: "failed", error: "no adapter memory"});
		expect((await r.service.route("ja", "fr"))?.candidate).to.equal("nllb");
		r.service.dispose();
	});

	it("builds its table from the selected model's routes with the deploy's merged over them", async () => {
		const asked: string[] = [];
		clock = sinon.useFakeTimers();
		const service = new TranslateService(
			{
				// No worker: the cache question fails and every model counts as absent.
				createClient() {
					throw new Error("no worker in this test");
				},
				probe: () => Promise.resolve(capability("gpu")),
				setTimeout: (fn, ms) => setTimeout(fn, ms),
				clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
			},
			{
				catalog,
				selectedLlm: QWEN3_1_7B_ID,
				routesFor(id) {
					asked.push(id);
					return id === QWEN3_4B_ID ? {"*": {"*": ["nllb"]}} : {"*": {"*": ["llm"]}};
				},
				routes: {en: {de: ["opus:de-en"]}},
				ortBase: "",
				enabled: true,
			},
			{switches: {llm: true, opus: true, nllb: true}, devices: AUTO}
		);

		expect((await service.route("fr", "ja"))?.candidate).to.equal("llm");
		expect((await service.route("de", "en"))?.candidate).to.equal("opus:de-en");

		service.setLlmModel(QWEN3_4B_ID);
		expect(asked).to.deep.equal([QWEN3_1_7B_ID, QWEN3_4B_ID]);
		expect((await service.route("fr", "ja"))?.candidate).to.equal("nllb");
		// The deploy's override survives the switch.
		expect((await service.route("de", "en"))?.candidate).to.equal("opus:de-en");
		service.dispose();
	});

	it("a GPU model unloads after three idle minutes and a CPU model after five", async () => {
		const r = rig("gpu", true, {en: {de: ["llm"], fr: ["nllb"]}});
		clock = r.clock;
		// The idle wait follows the device: NLLB-200 on the CPU copy.
		r.service.setSettings({
			switches: {llm: true, opus: true, nllb: true},
			devices: {...AUTO, nllb: "cpu"},
		});
		expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
		expect(await text(r.service.translate({...base, from: "fr"}))).to.equal("seq:Hallo");

		await r.clock.tickAsync(GPU_IDLE_UNLOAD_MS - 1);
		expect(r.llm.calls.unload).to.equal(0);
		await r.clock.tickAsync(1);
		expect(r.llm.calls.unload).to.equal(1);
		expect(r.seq2seq.calls.unload).to.equal(0);
		expect(r.workers[0].terminated).to.equal(false);

		await r.clock.tickAsync(CPU_IDLE_UNLOAD_MS - GPU_IDLE_UNLOAD_MS - 1);
		expect(r.workers[0].terminated).to.equal(false);
		await r.clock.tickAsync(1);
		// The last model going takes the worker with it.
		expect(r.workers[0].terminated).to.equal(true);

		// A model that unloaded loads again on the next request.
		expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
		expect(r.llm.calls.load.length).to.equal(2);
		expect(r.workers.length).to.equal(2);
		r.service.dispose();
	});

	it("a request keeps its model's idle clock from starting", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const release = gateLlm(r);
		const running = text(r.service.translate(base));

		await r.clock.tickAsync(CPU_IDLE_UNLOAD_MS * 2);
		expect(r.llm.calls.unload).to.equal(0);
		expect(r.workers[0].terminated).to.equal(false);

		release();
		expect(await running).to.equal("llm:Hallo");
		await r.clock.tickAsync(GPU_IDLE_UNLOAD_MS - 1);
		expect(r.workers[0].terminated).to.equal(false);
		await r.clock.tickAsync(1);
		expect(r.workers[0].terminated).to.equal(true);
		r.service.dispose();
	});

	it("unloads everything at once when translation is not in use and nothing is in flight", async () => {
		const r = rig("gpu");
		clock = r.clock;
		let inUse = true;

		r.service.setInUse(() => inUse);
		expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
		await r.clock.tickAsync(0);
		expect(r.workers[0].terminated).to.equal(false);

		inUse = false;
		r.service.usageChanged();
		await r.clock.tickAsync(0);
		expect(r.workers[0].terminated).to.equal(true);

		// And it comes back when asked: a fresh worker (the rig's engines
		// outlive their workers, so the load itself is not counted here).
		inUse = true;
		expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
		expect(r.workers.length).to.equal(2);
		r.service.dispose();
	});

	it("translation not in use waits for the request in flight, then unloads", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const release = gateLlm(r);

		r.service.setInUse(() => false);

		const running = text(r.service.translate(base));

		await r.clock.tickAsync(0);
		r.service.usageChanged();
		await r.clock.tickAsync(0);
		expect(r.workers[0].terminated).to.equal(false);

		release();
		expect(await running).to.equal("llm:Hallo");
		await r.clock.tickAsync(0);
		expect(r.workers[0].terminated).to.equal(true);
		r.service.dispose();
	});

	it("a tier switched off in Settings unloads that tier at once", async () => {
		const r = rig("gpu", true, {en: {de: ["llm"], fr: ["nllb"]}});
		clock = r.clock;
		await text(r.service.translate(base));
		await text(r.service.translate({...base, from: "fr"}));

		r.service.setSettings({switches: {llm: false, opus: true, nllb: true}, devices: AUTO});
		await r.clock.tickAsync(0);
		expect(r.llm.calls.unload).to.equal(1);
		expect(r.seq2seq.calls.unload).to.equal(0);
		expect(r.workers[0].terminated).to.equal(false);

		// OPUS-MT's switch is not NLLB-200's: the loaded NLLB stays.
		r.service.setSettings({switches: {llm: false, opus: false, nllb: true}, devices: AUTO});
		await r.clock.tickAsync(0);
		expect(r.seq2seq.calls.unload).to.equal(0);
		expect(r.workers[0].terminated).to.equal(false);

		r.service.setSettings({switches: {llm: false, opus: false, nllb: false}, devices: AUTO});
		await r.clock.tickAsync(0);
		// The last loaded tier going takes the worker with it.
		expect(r.workers[0].terminated).to.equal(true);
		r.service.dispose();
	});

	it("a loaded OPUS-MT pair unloads with OPUS-MT's switch, not NLLB-200's", async () => {
		const r = rig("gpu", true, {en: {fr: ["opus:fr-en"]}});
		clock = r.clock;
		await text(r.service.translate({...base, from: "fr"}));

		r.service.setSettings({switches: {llm: true, opus: true, nllb: false}, devices: AUTO});
		await r.clock.tickAsync(0);
		expect(r.seq2seq.calls.unload).to.equal(0);
		expect(r.workers[0].terminated).to.equal(false);

		r.service.setSettings({switches: {llm: true, opus: false, nllb: false}, devices: AUTO});
		await r.clock.tickAsync(0);
		// The only engine loaded: the worker goes with it.
		expect(r.workers[0].terminated).to.equal(true);
		r.service.dispose();
	});

	it("an NLLB-200 request with OPUS-MT switched off keeps NLLB-200 loaded", async () => {
		const r = rig("gpu", true, {en: {fr: ["nllb"]}});
		clock = r.clock;
		r.service.setSettings({switches: {llm: true, opus: false, nllb: true}, devices: AUTO});

		expect(await text(r.service.translate({...base, from: "fr"}))).to.equal("seq:Hallo");
		await r.clock.tickAsync(0);
		expect(r.seq2seq.calls.unload).to.equal(0);
		expect(r.workers[0].terminated).to.equal(false);
		expect(await text(r.service.translate({...base, from: "fr"}))).to.equal("seq:Hallo");
		expect(r.seq2seq.calls.unload).to.equal(0);
		expect(r.workers).to.have.length(1);
		r.service.dispose();
	});

	it("a tier switched off while its request runs unloads when the request ends", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const release = gateLlm(r);
		const running = text(r.service.translate(base));

		await r.clock.tickAsync(0);
		r.service.setSettings({switches: {llm: false, opus: true, nllb: true}, devices: AUTO});
		await r.clock.tickAsync(0);
		// Not under the running request.
		expect(r.llm.calls.unload).to.equal(0);
		expect(r.workers[0].terminated).to.equal(false);

		release();
		expect(await running).to.equal("llm:Hallo");
		await r.clock.tickAsync(0);
		expect(r.llm.calls.unload).to.equal(1);
		r.service.dispose();
	});

	it("pagehide unloads at once", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await text(r.service.translate(base));
		r.service.pagehide();
		expect(r.workers[0].terminated).to.equal(true);
		r.service.dispose();
	});

	it("models() lists the catalog with cached flags and download/delete move them", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const seen: string[][] = [];

		r.service.onModels((views) =>
			seen.push(views.map((v) => `${v.ref.id}@${v.device}:${v.status}:${v.cached}`))
		);
		const views = await r.service.models();
		// One row per copy, the GPU copy first.
		const copies = (ref: ModelRef) =>
			(["gpu", "cpu"] as const).filter((d) => ref.copies[d]).map((d) => `${ref.id}@${d}`);

		expect(views.map((v) => `${v.ref.id}@${v.device}`)).to.deep.equal([
			...catalog.llmChoices.flatMap(copies),
			...copies(catalog.nllb),
			...Object.values(catalog.opus).flatMap(copies),
		]);
		expect(views.every((v) => !v.cached && v.status === "idle")).to.equal(true);

		await r.service.download(catalog.nllb, "gpu");
		r.cached.add(catalog.nllb.id);
		const after = await r.service.models();
		const nllb = after.find((v) => v.ref.id === catalog.nllb.id);

		expect(nllb).to.include({cached: true, status: "ready", fraction: 1});
		expect(seen.some((s) => s.includes(`${catalog.nllb.id}@gpu:downloading:false`))).to.equal(
			true
		);

		await r.service.remove(catalog.nllb, "gpu");
		const gone = (await r.service.models()).find((v) => v.ref.id === catalog.nllb.id);

		expect(gone).to.include({cached: false, status: "idle"});
		r.service.dispose();
	});

	it("a failed download is reported on the view", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await r.service.models();
		r.llm.failLoad = new Error("out of memory");
		let message = "";

		try {
			await r.service.download(catalog.llm, "gpu");
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal("out of memory");
		const view = (await r.service.models()).find((v) => v.ref.id === catalog.llm.id);

		expect(view).to.include({status: "failed", error: "out of memory"});
		r.service.dispose();
	});

	it("onModels hands the new listener the rows as they are now", () => {
		const r = rig("gpu");
		clock = r.clock;
		const seen: string[][] = [];

		r.service.onModels((views) => seen.push(views.map((v) => `${v.ref.id}:${v.status}`)));

		expect(seen.length).to.equal(1);
		expect(seen[0][0]).to.equal(`${catalog.llm.id}:idle`);
		expect(seen[0].length).to.equal(
			// one row per copy: every language model choice, nllb and the pairs
			[...catalog.llmChoices, catalog.nllb, ...Object.values(catalog.opus)].reduce(
				(n, ref) => n + Object.keys(ref.copies).length,
				0
			)
		);
		r.service.dispose();
	});

	it("a worker error of its own reaches the onWorkerError listeners", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const seen: string[] = [];

		r.service.onWorkerError((message) => seen.push(message));
		r.failNextConfigure(new Error("no WebAssembly"));
		await r.service.models();

		expect(seen).to.deep.equal(["no WebAssembly"]);
		r.service.dispose();
	});

	// A translate-worker.js that will not load (a 404 mid-deploy, a CSP) or
	// throws at its top level answers nothing; its only word is the Worker's
	// `error` event. What it was asked fails as unavailable -- a failure the
	// reading queue counts toward its pause, so a dead script is tried a few
	// times and then left for a minute rather than a fresh worker a second.
	it("a worker that never starts fails what it was asked, and the queue pauses on it", async () => {
		const r = deadWorkerRig(true);
		clock = r.clock;
		const updates: [number, QueueUpdate][] = [];
		const paused: string[] = [];
		const queue = new TranslateQueue({
			route: (from, to, hint) =>
				r.service
					.route(from, to, hint)
					.then((route) =>
						route ? {engine: route.ref.engine, device: route.device} : null
					),
			translate: (req, signal) => r.service.translate(req, signal),
			priority: () => 0,
			arrivals: () => 0,
			onUpdate: (id, update) => updates.push([id, update]),
			onPause: (engine) => paused.push(engine),
		});

		for (let i = 1; i <= PAUSE_AFTER_FAILURES + 1; i++) {
			const p = protect(`Zeile ${i}`);

			queue.enqueue({
				id: i,
				chanId: 1,
				text: p.text,
				spans: p.spans,
				meta: p.meta,
				from: "de",
				to: "en",
				context: emptyContext(),
				arrivalsAtEnqueue: 0,
				// One request each, so each failure is one count.
				single: true,
			});
		}

		await r.clock.tickAsync(10 * 1000);

		const failed = updates.filter(([, u]) => u.status === "failed");

		expect(failed.map(([id]) => id)).to.deep.equal([1, 2, 3]);
		expect(failed[0][1]).to.include({error: TRANSLATION_UNAVAILABLE});
		expect(paused).to.deep.equal(["llm"]);
		// The cache question's worker, then one per request -- not one a
		// second through a requeue loop.
		expect(r.created.length).to.equal(PAUSE_AFTER_FAILURES + 1);
		expect(r.created.every((w) => w.terminated)).to.equal(true);
		expect(r.errors[0]).to.equal(TRANSLATION_UNAVAILABLE);
		queue.cancelAll();
		r.service.dispose();
	});

	it("Settings' word about a worker that never started clears once a fresh one answers", async () => {
		const r = deadWorkerRig(true, 1);
		clock = r.clock;
		const first = r.service.models().catch((e: Error) => e.message);

		await r.clock.tickAsync(10);
		expect(await first).to.equal(TRANSLATION_UNAVAILABLE);
		expect(r.errors).to.deep.equal([TRANSLATION_UNAVAILABLE]);

		await r.service.models();
		expect(r.created.length).to.equal(2);
		expect(r.errors).to.deep.equal([TRANSLATION_UNAVAILABLE, null]);

		// Only once: a healthy worker's answers say nothing more.
		await r.service.models();
		expect(r.errors).to.deep.equal([TRANSLATION_UNAVAILABLE, null]);
		r.service.dispose();
	});

	it("a worker that started but never answers holds no route past CACHE_WAIT_MS", async () => {
		const r = deadWorkerRig(false);
		clock = r.clock;
		let route: string | null | undefined;

		void r.service.route("de", "en").then((found) => (route = found?.candidate ?? null));
		await r.clock.tickAsync(CACHE_WAIT_MS - 1);
		expect(route).to.equal(undefined);
		await r.clock.tickAsync(1);
		expect(route).to.equal("llm");
		r.service.dispose();
	});

	it("a disabled deploy has no worker and no route", async () => {
		const r = rig("gpu", false);
		clock = r.clock;
		expect(r.service.enabled).to.equal(false);
		expect(await r.service.route("de", "en")).to.equal(null);
		expect(await r.service.models()).to.deep.equal([]);
		expect(r.workers.length).to.equal(0);
		r.service.dispose();
	});

	it("a disabled deploy never probes the device", async () => {
		const r = rig("gpu", false);
		clock = r.clock;
		expect(await r.service.capabilities()).to.include({tier: "none"});
		expect(r.probes).to.equal(0);
		r.service.dispose();
		r.clock.restore();

		const on = rig("gpu");
		clock = on.clock;
		expect(await on.service.capabilities()).to.include({tier: "gpu"});
		expect(on.probes).to.equal(1);
		on.service.dispose();
	});

	it("a teardown during a translation aborts it without marking the candidate down", async () => {
		const r = rig("gpu");
		clock = r.clock;
		r.llm.loadTicks = 50;
		let intervened = false;

		r.service.onModels((views) => {
			const llmView = views.find((v) => v.ref.id === catalog.llm.id);

			if (!intervened && llmView?.status === "downloading") {
				intervened = true;
				r.service.pagehide();
			}
		});

		let message = "";

		try {
			await text(r.service.translate(base));
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal(WORKER_DISPOSED);
		expect(r.workers.length).to.equal(1);
		expect((await r.service.route("de", "en"))?.candidate).to.equal("llm");
		r.service.dispose();
	});

	it("an implicit download during a translation shows on the views", async () => {
		const r = rig("gpu");
		clock = r.clock;
		const seen: {status: string; cached: boolean}[] = [];

		r.service.onModels((views) => {
			const llmView = views.find((v) => v.ref.id === catalog.llm.id);

			if (llmView) {
				seen.push({status: llmView.status, cached: llmView.cached});
			}
		});

		expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
		expect(seen.some((s) => s.status === "downloading")).to.equal(true);
		expect(seen[seen.length - 1]).to.deep.equal({status: "ready", cached: true});
		r.service.dispose();
	});

	it("models() clears a failed view once the model is cached", async () => {
		const r = rig("gpu");
		clock = r.clock;
		r.seq2seq.failLoad = new Error("boom");
		let message = "";

		try {
			await r.service.download(catalog.nllb, "gpu");
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal("boom");
		r.cached.add(catalog.nllb.id);
		const view = (await r.service.models()).find((v) => v.ref.id === catalog.nllb.id);

		expect(view).to.include({status: "ready", error: null, cached: true});
		r.service.dispose();
	});

	it("a failed delete is recorded on the view", async () => {
		const r = rig("gpu");
		clock = r.clock;
		r.failNextDelete(new Error("locked"));
		let message = "";

		try {
			await r.service.remove(catalog.nllb, "gpu");
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal("locked");
		const view = (await r.service.models()).find((v) => v.ref.id === catalog.nllb.id);

		expect(view).to.include({status: "failed", error: "locked"});
		r.service.dispose();
	});

	it("dispose is terminal", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await text(r.service.translate(base));
		expect(r.workers.length).to.equal(1);
		r.service.dispose();

		let message = "";

		try {
			await text(r.service.translate(base));
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal(TRANSLATION_UNAVAILABLE);
		expect(r.workers.length).to.equal(1);
	});

	it("a teardown during a delete leaves the view as it was", async () => {
		const r = rig("gpu");
		clock = r.clock;
		r.hangNextDelete();

		let message = "";
		const pending = r.service.remove(catalog.nllb, "gpu").catch((e: Error) => {
			message = e.message;
		});

		r.service.pagehide();
		await pending;

		expect(message).to.equal(WORKER_DISPOSED);
		const view = (await r.service.models()).find((v) => v.ref.id === catalog.nllb.id);

		expect(view).to.include({status: "idle", error: null});
	});

	it("an abandoned translation does not leave its view downloading", async () => {
		const r = rig("gpu");
		clock = r.clock;
		let last: {status: string; fraction: number} | null = null;

		r.service.onModels((views) => {
			const llmView = views.find((v) => v.ref.id === catalog.llm.id);

			if (llmView) {
				last = {status: llmView.status, fraction: llmView.fraction};
			}
		});

		for await (const chunk of r.service.translate(base)) {
			expect(chunk.text).to.equal("llm:Hallo");
			break;
		}

		expect(last).to.deep.equal({status: "idle", fraction: 0});
		r.service.dispose();
	});

	it("an abort during a download leaves the model neither ready nor cached", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await r.service.capabilities();

		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		// A load that reports progress and then hangs: the view is
		// "downloading" when the abort arrives.
		r.llm.load = async (ref, device, onProgress) => {
			onProgress({fraction: 0.4, text: "part 1"});
			await gate;
		};

		let last: {status: string; fraction: number; cached: boolean} | null = null;

		r.service.onModels((views) => {
			const llmView = views.find((v) => v.ref.id === catalog.llm.id);

			if (llmView) {
				last = {
					status: llmView.status,
					fraction: llmView.fraction,
					cached: llmView.cached,
				};
			}
		});

		const controller = new AbortController();
		const chunks: string[] = [];
		const iteration = (async () => {
			for await (const chunk of r.service.translate(base, controller.signal)) {
				chunks.push(chunk.text);
			}
		})();

		for (let i = 0; i < 100 && last?.status !== "downloading"; i++) {
			await Promise.resolve();
		}

		expect(last?.status).to.equal("downloading");

		controller.abort();
		await iteration;
		release?.();

		expect(chunks).to.deep.equal([]);
		expect(last).to.deep.equal({status: "idle", fraction: 0, cached: false});
		r.service.dispose();
	});

	it("an abort signal cancels the client stream at once, before any chunk arrives", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await r.service.capabilities();

		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		// A translate that never yields until released: proves the cancel
		// does not wait on the engine, rather than racing its usual speed.
		r.llm.translate = (req, signal) => {
			r.llm.calls.translate.push(req);

			return (async function* () {
				await gate;

				if (!signal.aborted) {
					yield {id: req.id, text: "too late", done: true};
				}
			})();
		};

		const controller = new AbortController();
		const chunks: string[] = [];
		const iteration = (async () => {
			for await (const chunk of r.service.translate(base, controller.signal)) {
				chunks.push(chunk.text);
			}
		})();

		while (r.llm.calls.translate.length === 0) {
			await Promise.resolve();
		}

		controller.abort();
		await iteration;
		release?.();

		expect(chunks).to.deep.equal([]);
		expect(r.llm.calls.translate.length).to.equal(1);
		r.service.dispose();
	});

	it("one abort listener serves the whole call, whichever candidate ends up running", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await r.service.capabilities();
		// the first candidate (llm) fails to load and falls through to the
		// second (opus): the abort must still reach whichever one is current,
		// not a listener left behind closing over the abandoned llm id.
		r.llm.failLoad = new Error("device lost");

		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		r.seq2seq.translate = (req, signal) => {
			r.seq2seq.calls.translate.push(req);

			return (async function* () {
				await gate;

				if (!signal.aborted) {
					yield {id: req.id, text: "too late", done: true};
				}
			})();
		};

		const controller = new AbortController();
		const chunks: string[] = [];
		const iteration = (async () => {
			for await (const chunk of r.service.translate(base, controller.signal)) {
				chunks.push(chunk.text);
			}
		})();

		while (r.seq2seq.calls.translate.length === 0) {
			await Promise.resolve();
		}

		controller.abort();
		await iteration;
		release?.();

		expect(chunks).to.deep.equal([]);
		expect(r.seq2seq.calls.translate.length).to.equal(1);
		expect(r.llm.calls.translate.length).to.equal(0);
		expect((await r.service.route("de", "en"))?.candidate).to.equal("opus:de-en");
		r.service.dispose();
	});

	it("an abort after a teardown creates no worker", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await r.service.capabilities();

		const controller = new AbortController();
		let message = "";
		const iteration = (async () => {
			for await (const chunk of r.service.translate(base, controller.signal)) {
				void chunk; // unreachable: torn down before anything is ever yielded
			}
		})().catch((e: Error) => {
			message = e.message;
		});

		while (r.workers.length === 0) {
			await Promise.resolve();
		}

		// pagehide tears the worker down synchronously (this.worker = null);
		// the abort that follows, in the same tick, must not go through
		// this.client() (which would create a fresh one just to cancel).
		r.service.pagehide();
		controller.abort();
		await iteration;

		expect(message).to.equal(WORKER_DISPOSED);
		expect(r.workers.length).to.equal(1);
	});

	// The wait phase is everything before the request is posted: the route
	// (whose first call asks the worker what is downloaded), a GPU model
	// switch settling, another model's work finishing. An abort there used to
	// cancel nothing -- the listener was registered `{once: true}` while the
	// request had no id yet -- and the request was then sent to the worker,
	// model download included, long after the queue had moved on.
	it("an abort while the route is still being resolved never reaches the worker", async () => {
		const r = rig("gpu");
		clock = r.clock;
		await r.service.capabilities();

		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const route = r.service.route.bind(r.service);

		r.service.route = async (from, to, hint) => {
			await gate;
			return route(from, to, hint);
		};

		const controller = new AbortController();
		let message = "";
		const iteration = (async () => {
			for await (const chunk of r.service.translate(base, controller.signal)) {
				void chunk; // unreachable: aborted before the request is posted
			}
		})().catch((e: Error) => {
			message = e.message;
		});

		await Promise.resolve();
		controller.abort();
		release();
		await iteration;

		expect(message).to.equal(ABORTED);
		expect(r.llm.calls.translate).to.deep.equal([]);
		r.service.dispose();
	});

	describe("download consent", () => {
		/** A dialog the test answers: every question it was asked, and how to answer the next. */
		function dialog() {
			const asked: string[] = [];
			const devices: Device[] = [];
			const answers: ((yes: boolean) => void)[] = [];

			const askDownload = (ref: ModelRef, device: Device) => {
				asked.push(ref.id);
				devices.push(device);

				return new Promise<boolean>((resolve) => answers.push(resolve));
			};

			const answer = (yes: boolean) => {
				const next = answers.shift();

				expect(next, "a question is open").to.not.equal(undefined);
				next!(yes);
			};

			return {
				asked,
				devices,
				askDownload,
				answer,
				get open() {
					return answers.length;
				},
			};
		}

		function line(i: number, from = "de") {
			const p = protect(`Zeile ${i}`);

			return {
				id: i,
				chanId: 1,
				text: p.text,
				spans: p.spans,
				meta: p.meta,
				from,
				to: "en",
				context: emptyContext(),
				arrivalsAtEnqueue: 0,
				single: true,
			};
		}

		/** The reading queue as reader.ts builds it: a declined download fails the line. */
		function queueOn(service: TranslateService) {
			const updates: [number, QueueUpdate][] = [];
			const paused: string[] = [];
			const queue = new TranslateQueue({
				route: (from, to, hint) =>
					service.resolve(from, to, hint).then(({route, refused}) => {
						if (!route && refused) {
							throw new Error(needsDownloadError(refused));
						}

						return route ? {engine: route.ref.engine, device: route.device} : null;
					}),
				translate: (req, signal) => service.translate(req, signal),
				priority: () => 0,
				arrivals: () => 0,
				onUpdate: (id, update) => updates.push([id, update]),
				onPause: (engine) => paused.push(engine),
			});

			return {queue, updates, paused};
		}

		it("asks once for many requests waiting on the same model, and remembers the yes", async () => {
			const ask = dialog();
			const store = memoryConsent();
			const r = rig("gpu", true, DEFAULT_ROUTES, {
				askDownload: ask.askDownload,
				consent: store,
			});
			clock = r.clock;
			const routes = Array.from({length: 8}, () => r.service.route("de", "en"));

			await r.clock.tickAsync(10);
			expect(ask.asked).to.deep.equal([catalog.llm.id]);
			ask.answer(true);

			for (const route of await Promise.all(routes)) {
				expect(route?.candidate).to.equal("llm");
			}

			expect(store.has(catalog.llm.id)).to.equal(true);
			// Agreed to: the next request is not asked about it.
			expect((await r.service.route("de", "en"))?.candidate).to.equal("llm");
			expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
			expect(ask.asked).to.have.length(1);
			r.service.dispose();
		});

		it("a yes the storage cannot keep still routes, with one question", async () => {
			const ask = dialog();
			const deaf = {has: () => false, grant() {}, revoke() {}};
			const r = rig("gpu", true, DEFAULT_ROUTES, {
				askDownload: ask.askDownload,
				consent: deaf,
			});
			clock = r.clock;
			const routed = r.service.route("de", "en");

			await r.clock.tickAsync(10);
			ask.answer(true);
			expect((await routed)?.candidate).to.equal("llm");
			expect(ask.asked).to.have.length(1);
			expect(ask.open).to.equal(0);
			r.service.dispose();
		});

		it("never asks about a model on the device, or one agreed to before", async () => {
			const ask = dialog();
			const store = memoryConsent();

			store.grant(catalog.opus["en-fr"].id);

			const r = rig("gpu", true, DEFAULT_ROUTES, {
				askDownload: ask.askDownload,
				consent: store,
			});
			clock = r.clock;
			r.cached.add(catalog.llm.id);

			expect((await r.service.route("de", "en"))?.candidate).to.equal("llm");
			// The GPU model switched off: English to French falls to the OPUS pair.
			r.service.setSettings({
				switches: {llm: false, opus: true, nllb: true},
				devices: {...AUTO, opus: "cpu"},
			});
			expect((await r.service.route("en", "fr"))?.candidate).to.equal("opus:en-fr");
			expect(ask.asked).to.deep.equal([]);
			r.service.dispose();
		});

		it("not now: a cached model takes the request, and no second model is asked about", async () => {
			const ask = dialog();
			const r = rig("gpu", true, DEFAULT_ROUTES, {askDownload: ask.askDownload});
			clock = r.clock;
			// Spanish to English: the LLM is a better class than the OPUS pair,
			// which is the one on the device.
			r.cached.add(catalog.opus["es-en"].id);

			const routed = r.service.route("es", "en");

			await r.clock.tickAsync(10);
			expect(ask.asked).to.deep.equal([catalog.llm.id]);
			ask.answer(false);
			expect((await routed)?.candidate).to.equal("opus:es-en");
			expect(await text(r.service.translate({...base, from: "es"}))).to.equal("seq:Hallo");
			expect(r.llm.calls.load).to.deep.equal([]);
			expect(ask.open).to.equal(0);
			expect(ask.asked).to.have.length(1);
			r.service.dispose();
		});

		it("not now with nothing on the device: the request fails naming the model, and nothing loads", async () => {
			const ask = dialog();
			const r = rig("gpu", true, DEFAULT_ROUTES, {askDownload: ask.askDownload});
			clock = r.clock;
			const failed = text(r.service.translate(base)).catch((e: Error) => e.message);

			await r.clock.tickAsync(10);
			ask.answer(false);

			const message = await failed;

			expect(parseNeedsDownload(message)).to.deep.equal({
				id: catalog.llm.id,
				sizeBytes: catalog.llm.copies.gpu!.sizeBytes,
				label: catalog.llm.label,
				device: "gpu",
			});
			// The rest of the session: no question, the same answer, for any pair.
			expect(await r.service.resolve("fr", "en")).to.deep.include({route: null});
			// Each names the model its best class would download: Swahili is NLLB-first.
			expect((await r.service.resolve("en", "sw")).refused?.id).to.equal(catalog.nllb.id);
			expect(ask.asked).to.have.length(1);
			expect(r.llm.calls.load).to.deep.equal([]);
			expect(r.seq2seq.calls.load).to.deep.equal([]);
			r.service.dispose();
		});

		it("names the declined model even where a switch further down blocks the rest", async () => {
			const ask = dialog();
			const r = rig("gpu", true, DEFAULT_ROUTES, {askDownload: ask.askDownload});
			clock = r.clock;
			// NLLB-200 off, as it ships: the walk's own last reason is that switch.
			r.service.setSettings({switches: {llm: true, opus: true, nllb: false}, devices: AUTO});

			const resolved = r.service.resolve("de", "en");

			await r.clock.tickAsync(10);
			ask.answer(false);
			expect((await resolved).refused?.id).to.equal(catalog.llm.id);
			r.service.dispose();
		});

		it("a reading queue of many lines asks once, fails them all with the reason, and pauses nothing", async () => {
			const ask = dialog();
			const r = rig("gpu", true, DEFAULT_ROUTES, {askDownload: ask.askDownload});
			clock = r.clock;
			const {queue, updates, paused} = queueOn(r.service);

			for (let i = 1; i <= 2 * PAUSE_AFTER_FAILURES + 2; i++) {
				queue.enqueue(line(i, i % 2 ? "de" : "fr"));
			}

			await r.clock.tickAsync(10);
			expect(ask.asked).to.deep.equal([catalog.llm.id]);
			ask.answer(false);
			await r.clock.tickAsync(10);

			const failed = updates.filter(([, u]) => u.status === "failed");

			expect(failed).to.have.length(2 * PAUSE_AFTER_FAILURES + 2);

			for (const [, update] of failed) {
				expect(
					parseNeedsDownload(update.status === "failed" ? update.error : "")?.id
				).to.equal(catalog.llm.id);
			}

			expect(paused).to.deep.equal([]);
			expect(queue.paused("llm")).to.equal(false);
			expect(queue.paused("seq2seq")).to.equal(false);
			expect(ask.asked).to.have.length(1);
			queue.cancelAll();
			r.service.dispose();
		});

		it("a declined download reported by translate() counts toward no pause either", async () => {
			const updates: [number, QueueUpdate][] = [];
			const paused: string[] = [];
			const refusal = needsDownloadError(catalog.llm);
			const queue = new TranslateQueue({
				route: () => Promise.resolve({engine: "llm" as const, device: "gpu" as const}),
				async *translate() {
					await Promise.resolve();

					if (refusal) {
						throw new Error(refusal);
					}

					yield {id: 0, text: "", done: true};
				},
				priority: () => 0,
				arrivals: () => 0,
				onUpdate: (id, update) => updates.push([id, update]),
				onPause: (engine) => paused.push(engine),
			});

			for (let i = 1; i <= PAUSE_AFTER_FAILURES + 1; i++) {
				queue.enqueue(line(i));
			}

			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(updates.filter(([, u]) => u.status === "failed")).to.have.length(
				PAUSE_AFTER_FAILURES + 1
			);
			expect(paused).to.deep.equal([]);
			queue.cancelAll();
		});

		it("asks about one model at a time, and a no answers the one waiting behind it", async () => {
			const ask = dialog();
			const r = rig("gpu", true, DEFAULT_ROUTES, {askDownload: ask.askDownload});
			clock = r.clock;
			const llm = r.service.resolve("de", "en");
			// Swahili is NLLB-first: a second model, asked about after the first.
			const nllb = r.service.resolve("en", "sw");

			await r.clock.tickAsync(10);
			// One dialog open, the second question waiting its turn.
			expect(ask.asked).to.deep.equal([catalog.llm.id]);
			ask.answer(false);
			await r.clock.tickAsync(10);
			expect((await llm).route).to.equal(null);
			expect((await nllb).refused?.id).to.equal(catalog.nllb.id);
			expect(ask.asked).to.have.length(1);
			r.service.dispose();
		});

		it("a Retry asks again; Settings' Download is a yes, and a delete takes it back", async () => {
			const ask = dialog();
			const store = memoryConsent();
			const r = rig("gpu", true, DEFAULT_ROUTES, {
				askDownload: ask.askDownload,
				consent: store,
			});
			clock = r.clock;
			const first = r.service.resolve("de", "en");

			await r.clock.tickAsync(10);
			ask.answer(false);
			expect((await first).route).to.equal(null);

			r.service.forgetDeclines();

			const again = r.service.resolve("de", "en");

			await r.clock.tickAsync(10);
			expect(ask.asked).to.deep.equal([catalog.llm.id, catalog.llm.id]);
			ask.answer(false);
			await again;

			// Settings' Download: agreed to, downloaded, and the decline is over.
			await r.service.download(catalog.nllb, "cpu");
			expect(store.has(catalog.nllb.id)).to.equal(true);
			expect(store.has(`${catalog.nllb.id}@gpu`)).to.equal(false);
			await r.service.remove(catalog.nllb, "cpu");
			expect(store.has(catalog.nllb.id)).to.equal(false);
			r.service.dispose();
		});

		it("the CPU copy is asked about under <id>@cpu, and its yes does not cover the GPU copy", async () => {
			const ask = dialog();
			const store = memoryConsent();
			const r = rig("gpu", true, DEFAULT_ROUTES, {
				askDownload: ask.askDownload,
				consent: store,
			});
			clock = r.clock;
			r.service.setSettings({
				switches: {llm: true, opus: true, nllb: true},
				devices: {...AUTO, llm: "cpu"},
			});
			const cpu = r.service.route("de", "en");

			await r.clock.tickAsync(10);
			expect(ask.asked).to.deep.equal([`${catalog.llm.id}@cpu`]);
			expect(ask.devices).to.deep.equal(["cpu"]);
			ask.answer(true);
			expect(await cpu).to.deep.include({candidate: "llm", device: "cpu"});
			expect(store.has(`${catalog.llm.id}@cpu`)).to.equal(true);
			expect(store.has(catalog.llm.id)).to.equal(false);

			r.service.setSettings({switches: {llm: true, opus: true, nllb: true}, devices: AUTO});
			const gpu = r.service.route("de", "en");

			await r.clock.tickAsync(10);
			// A GPU copy keeps the id it always had: existing yeses stand.
			expect(ask.asked).to.deep.equal([`${catalog.llm.id}@cpu`, catalog.llm.id]);
			ask.answer(true);
			expect(await gpu).to.deep.include({candidate: "llm", device: "gpu"});

			// Deleting the CPU copy takes back its yes alone.
			await r.service.remove(catalog.llm, "cpu");
			expect(store.has(`${catalog.llm.id}@cpu`)).to.equal(false);
			expect(store.has(catalog.llm.id)).to.equal(true);
			r.service.dispose();
		});

		it("a yes given before devices covers the seq2seq copy it was for, not the GPU copy", async () => {
			const ask = dialog();
			const store = memoryConsent();

			// NLLB-200 downloaded (and agreed to) when it ran on the CPU alone.
			store.grant(catalog.nllb.id);

			const r = rig(
				"gpu",
				true,
				{en: {sw: ["nllb", "llm"]}},
				{
					askDownload: ask.askDownload,
					consent: store,
				}
			);
			clock = r.clock;
			r.cached.add(`${catalog.nllb.id}@cpu`);
			const routed = r.service.route("sw", "en");

			await r.clock.tickAsync(10);
			// Auto on a computer wants the GPU copy first: a new download, asked about.
			expect(ask.asked).to.deep.equal([`${catalog.nllb.id}@gpu`]);
			expect(ask.devices).to.deep.equal(["gpu"]);
			ask.answer(false);
			// Not now: the CPU copy on the device serves.
			expect(await routed).to.deep.include({candidate: "nllb", device: "cpu"});

			await r.service.remove(catalog.nllb, "cpu");
			expect(store.has(catalog.nllb.id)).to.equal(false);
			r.service.dispose();
		});

		it("the shipped catalog runs OPUS-MT and NLLB-200 on the CPU under Auto, never asking for a GPU copy", async () => {
			const ask = dialog();
			const shipped = buildCatalog();
			// A computer whose GPU binds 1 GiB with f16: either GPU copy would
			// fit it, were there one (translation-devices.md § Not in this build).
			const r = rig(
				"gpu",
				true,
				{en: {de: ["opus:de-en"], sw: ["nllb"]}},
				{askDownload: ask.askDownload},
				{catalog: shipped, maxBufferBytes: 1024 * 1024 * 1024}
			);
			clock = r.clock;

			const opus = r.service.route("de", "en");

			await r.clock.tickAsync(10);
			expect(ask.devices).to.deep.equal(["cpu"]);
			expect(ask.asked).to.deep.equal([shipped.opus["de-en"].id]);
			ask.answer(true);
			expect(await opus).to.deep.include({candidate: "opus:de-en", device: "cpu"});

			const nllb = r.service.route("sw", "en");

			await r.clock.tickAsync(10);
			expect(ask.devices).to.deep.equal(["cpu", "cpu"]);
			expect(ask.asked).to.deep.equal([shipped.opus["de-en"].id, shipped.nllb.id]);
			ask.answer(true);
			expect(await nllb).to.deep.include({candidate: "nllb", device: "cpu"});
			r.service.dispose();
		});

		it("without a dialog wired, every download goes ahead unasked", async () => {
			const r = rig("gpu");
			clock = r.clock;

			expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
			r.service.dispose();
		});
	});

	describe("per device", () => {
		const ON = {llm: true, opus: true, nllb: true};

		it("a request routed to the CPU copy loads that copy and carries the device", async () => {
			const r = rig("gpu");
			clock = r.clock;
			r.service.setSettings({switches: ON, devices: {...AUTO, llm: "cpu"}});

			expect(await r.service.route("de", "en")).to.deep.include({
				candidate: "llm",
				device: "cpu",
			});
			expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
			expect(r.llm.calls.devices).to.deep.equal(["cpu"]);
			expect(r.llm.calls.translate[0].device).to.equal("cpu");

			// Settings' Download of the GPU copy posts that copy's load.
			await r.service.download(catalog.llm, "gpu");
			expect(r.llm.calls.devices).to.deep.equal(["cpu", "gpu"]);
			r.service.dispose();
		});

		it("deleting the CPU copy leaves the GPU copy", async () => {
			const r = rig("gpu");
			clock = r.clock;
			r.cached.add(catalog.llm.id);
			r.service.setSettings({switches: ON, devices: {...AUTO, llm: "cpu"}});
			expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
			expect(r.llm.loadedOn()).to.equal("cpu");

			await r.service.remove(catalog.llm, "cpu");

			expect(r.deleted).to.deep.equal([`${catalog.llm.id}@cpu`]);
			// Loaded on the CPU: unloaded before its files went.
			expect(r.llm.calls.unload).to.equal(1);

			const views = await r.service.models();
			const copy = (device: string) =>
				views.find((v) => v.ref.id === catalog.llm.id && v.device === device);

			expect(copy("gpu")).to.include({cached: true, status: "ready"});
			expect(copy("cpu")).to.include({cached: false, status: "idle"});
			r.service.dispose();
		});

		it("deleting the CPU copy does not unload the GPU copy in memory", async () => {
			const r = rig("gpu");
			clock = r.clock;
			r.cached.add(catalog.llm.id);
			expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
			expect(r.llm.loadedOn()).to.equal("gpu");

			await r.service.remove(catalog.llm, "cpu");

			expect(r.deleted).to.deep.equal([`${catalog.llm.id}@cpu`]);
			expect(r.llm.calls.unload).to.equal(0);
			expect(r.llm.isLoaded(catalog.llm.id, "gpu")).to.equal(true);
			r.service.dispose();
		});

		it("a GPU load failure marks llm@gpu down; a CPU-pinned request still routes", async () => {
			// Two classes: a downloaded OPUS pair does not win over the language model's CPU copy.
			const r = rig("gpu", true, {en: {de: ["llm", "opus:de-en"]}});
			clock = r.clock;
			r.llm.failLoad = new Error("device lost");

			expect(await text(r.service.translate(base))).to.equal("seq:Hallo");
			expect((await r.service.route("de", "en"))?.candidate).to.equal("opus:de-en");

			r.service.setSettings({switches: ON, devices: {...AUTO, llm: "cpu"}});
			expect(await r.service.route("de", "en")).to.deep.include({
				candidate: "llm",
				device: "cpu",
			});
			expect(await text(r.service.translate(base))).to.equal("llm:Hallo");
			expect(r.llm.calls.devices).to.deep.equal(["gpu", "cpu"]);

			// Back on Auto the GPU copy is still down for the session.
			r.service.setSettings({switches: ON, devices: AUTO});
			expect((await r.service.route("de", "en"))?.candidate).to.equal("opus:de-en");
			r.service.dispose();
		});

		it("Settings' download of one copy lifts that copy's down-mark alone", async () => {
			const r = rig("gpu", true, {en: {sw: ["nllb", "llm"]}});
			clock = r.clock;
			const original = r.seq2seq.load.bind(r.seq2seq);

			r.seq2seq.load = (ref, device, onProgress) =>
				ref.id === catalog.nllb.id
					? Promise.reject(new Error(`no ${device}`))
					: original(ref, device, onProgress);

			// Both copies fail: the next class takes it.
			expect(await text(r.service.translate({...base, from: "sw"}))).to.equal("llm:Hallo");
			r.seq2seq.load = original;

			await r.service.download(catalog.nllb, "cpu");

			// The CPU copy is back; the GPU copy's loss stands.
			expect(await r.service.route("sw", "en")).to.deep.include({
				candidate: "nllb",
				device: "cpu",
			});
			r.service.dispose();
		});

		it("a better class whose download fails on both copies under Auto falls to the next class", async () => {
			const r = rig("gpu", true, {en: {sw: ["nllb", "llm"]}});
			clock = r.clock;
			const devices: string[] = [];

			r.seq2seq.load = (ref, device) => {
				devices.push(device);

				return Promise.reject(new Error(`quota exceeded on ${device}`));
			};

			expect(await text(r.service.translate({...base, from: "sw"}))).to.equal("llm:Hallo");
			// The GPU copy, then the other device's copy, then the next class.
			expect(devices).to.deep.equal(["gpu", "cpu"]);
			expect((await r.service.route("sw", "en"))?.candidate).to.equal("llm");

			const views = await r.service.models();
			const copy = (device: string) =>
				views.find((v) => v.ref.id === catalog.nllb.id && v.device === device);

			expect(copy("gpu")?.error).to.equal("quota exceeded on gpu");
			expect(copy("cpu")?.error).to.equal("quota exceeded on cpu");
			r.service.dispose();
		});

		it("an idle CPU-loaded language model unloads after CPU_IDLE_UNLOAD_MS", async () => {
			const r = rig("gpu", true, {en: {de: ["llm"]}});
			clock = r.clock;
			r.service.setSettings({switches: ON, devices: {...AUTO, llm: "cpu"}});
			expect(await text(r.service.translate(base))).to.equal("llm:Hallo");

			await r.clock.tickAsync(GPU_IDLE_UNLOAD_MS);
			expect(r.workers[0].terminated).to.equal(false);
			expect(r.llm.calls.unload).to.equal(0);
			await r.clock.tickAsync(CPU_IDLE_UNLOAD_MS - GPU_IDLE_UNLOAD_MS - 1);
			expect(r.workers[0].terminated).to.equal(false);
			await r.clock.tickAsync(1);
			expect(r.workers[0].terminated).to.equal(true);
			r.service.dispose();
		});

		it("the model views list one row per copy", async () => {
			const r = rig("gpu");
			clock = r.clock;
			r.cached.add(`${catalog.nllb.id}@cpu`);
			const views = await r.service.models();
			const nllb = views.filter((v) => v.ref.id === catalog.nllb.id);

			expect(nllb.map((v) => [v.device, v.cached])).to.deep.equal([
				["gpu", false],
				["cpu", true],
			]);
			// The 4B has no CPU copy, so no CPU row.
			expect(
				views.filter((v) => v.ref.id === QWEN3_4B_ID).map((v) => v.device)
			).to.deep.equal(["gpu"]);
			r.service.dispose();
		});
	});

	describe("NLLB-200 opt-in", () => {
		it("off: a pair NLLB would lead goes to the GPU model, and none goes to NLLB", async () => {
			const r = rig("gpu", true, {en: {sw: ["nllb", "llm"]}, "*": {"*": ["nllb"]}});
			clock = r.clock;
			r.service.setSettings({switches: {llm: true, opus: true, nllb: false}, devices: AUTO});

			expect(await text(r.service.translate({...base, from: "sw"}))).to.equal("llm:Hallo");
			expect((await r.service.route("ja", "ko"))?.candidate ?? null).to.equal(null);
			expect(r.seq2seq.calls.load).to.deep.equal([]);

			r.service.setSettings({switches: {llm: true, opus: true, nllb: true}, devices: AUTO});
			expect((await r.service.route("sw", "en"))?.candidate).to.equal("nllb");
			r.service.dispose();
		});
	});
});
