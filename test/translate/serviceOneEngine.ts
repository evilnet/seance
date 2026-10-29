// One engine in memory at a time on a phone or tablet (service.ts
// `makeRoom`): WebKit counts the GPU model's memory against the page's own
// process, which also holds the worker's ONNX Runtime heap, so the other
// engine is unloaded before one loads, the two never run side by side, and
// the GPU model is loaded into a fresh worker once the CPU engine has grown
// the old one's heap (which never shrinks). A computer keeps both.

import {expect} from "chai";
import sinon from "ts-sinon";
import type {Capability} from "../../client/js/translate/capability";
import {emptyContext} from "../../client/js/translate/engine";
import {
	QWEN3_1_7B_ID,
	buildCatalog,
	type CacheApi,
	type DeviceChoices,
} from "../../client/js/translate/models";
import {createPortPair} from "../../client/js/translate/protocol";
import type {RouteTable} from "../../client/js/translate/router";
import {TranslateClient} from "../../client/js/translate/client";
import {TranslateService, type ServiceDeps} from "../../client/js/translate/service";
import {serveEngines} from "../../client/js/translate/worker";
import {FakeEngine} from "./fakeEngine";

const AUTO: DeviceChoices = {llm: "auto", opus: "auto", nllb: "auto"};

const catalog = buildCatalog();

/** de → en on an OPUS-MT pair (the CPU engine), fr → en on the GPU model. */
const ROUTES: RouteTable = {en: {de: ["opus:de-en"], fr: ["llm"]}};

function capability(mobile: boolean): Capability {
	return {
		tier: "gpu",
		reasons: [],
		f16: true,
		maxBufferBytes: 2147483644,
		deviceMemoryGiB: 8,
		storageQuotaBytes: null,
		mobile,
	};
}

function rig(mobile: boolean) {
	const clock = sinon.useFakeTimers();
	const workers: {terminated: boolean}[] = [];
	const log: string[] = [];
	const cache: CacheApi = {has: () => Promise.resolve(true), delete: () => Promise.resolve()};
	const llm = new FakeEngine("llm", (req) => [`llm:${req.text}`]);
	const seq2seq = new FakeEngine("seq2seq", (req) => [`seq:${req.text}`]);

	// Every load, unload and generation, in order, by worker.
	for (const engine of [llm, seq2seq]) {
		const load = engine.load.bind(engine);
		const unload = engine.unload.bind(engine);
		const translate = engine.translate.bind(engine);

		engine.load = (ref, device, onProgress) => {
			log.push(`w${workers.length - 1} load ${engine.name}`);
			return load(ref, device, onProgress);
		};

		engine.unload = () => {
			log.push(`w${workers.length - 1} unload ${engine.name}`);
			return unload();
		};

		engine.translate = async function* (req, signal) {
			log.push(`w${workers.length - 1} start ${engine.name}`);
			yield* translate(req, signal);
			log.push(`w${workers.length - 1} end ${engine.name}`);
		};
	}

	const deps: ServiceDeps = {
		createClient() {
			const [mainPort, workerPort] = createPortPair();
			const entry = {terminated: false};

			workers.push(entry);

			const stop = serveEngines(workerPort, {llm, seq2seq}, {cache, configure() {}});

			return {
				client: new TranslateClient(mainPort),
				terminate() {
					entry.terminated = true;
					stop();
				},
			};
		},
		probe: () => Promise.resolve(capability(mobile)),
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
	};
	const service = new TranslateService(
		deps,
		{
			catalog,
			selectedLlm: QWEN3_1_7B_ID,
			routesFor: () => ROUTES,
			ortBase: "https://app.test/js/ort/",
			enabled: true,
		},
		{switches: {llm: true, opus: true, nllb: true}, devices: AUTO}
	);

	return {service, workers, log, clock, llm, seq2seq};
}

/** Holds `engine`'s next generation before its first chunk until the returned function is called. */
function gate(engine: FakeEngine): () => void {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const original = engine.translate.bind(engine);
	let first = true;

	engine.translate = async function* (req, signal) {
		if (first) {
			first = false;
			await held;
		}

		yield* original(req, signal);
	};

	return release;
}

async function text(iterable: AsyncIterable<{text: string; done: boolean}>) {
	let last = "";

	for await (const chunk of iterable) {
		last = chunk.text;
	}

	return last;
}

function request(from: string) {
	return {text: "hello", from, to: "en", purpose: "read" as const, context: emptyContext()};
}

describe("translate/service: one engine at a time on a phone", () => {
	let r: ReturnType<typeof rig>;

	afterEach(() => {
		r.service.dispose();
		r.clock.restore();
	});

	it("unloads the GPU model before the CPU engine loads", async () => {
		r = rig(true);

		expect(await text(r.service.translate(request("fr")))).to.equal("llm:hello");
		expect(await text(r.service.translate(request("de")))).to.equal("seq:hello");

		const unloadLlm = r.log.indexOf("w0 unload llm");

		expect(unloadLlm).to.be.greaterThan(r.log.indexOf("w0 end llm"));
		expect(unloadLlm).to.be.lessThan(r.log.indexOf("w0 load seq2seq"));
		expect(r.workers).to.have.length(1);
	});

	it("loads the GPU model into a fresh worker once the CPU engine has run", async () => {
		r = rig(true);

		expect(await text(r.service.translate(request("de")))).to.equal("seq:hello");
		expect(await text(r.service.translate(request("fr")))).to.equal("llm:hello");

		// ONNX Runtime's heap never shrinks: the worker that held it goes.
		expect(r.workers).to.have.length(2);
		expect(r.workers[0].terminated).to.equal(true);
		expect(r.log).to.include("w1 load llm");
		expect(r.log).not.to.include("w0 load llm");
	});

	it("never runs the two engines side by side: a request waits for the other engine's", async () => {
		r = rig(true);

		const release = gate(r.seq2seq);
		const seq = text(r.service.translate(request("de")));

		await r.clock.tickAsync(10);
		// Held inside its generation, before the first chunk.
		expect(r.log).to.include("w0 load seq2seq");

		const llm = text(r.service.translate(request("fr")));

		await r.clock.tickAsync(10);
		expect(r.log.some((line) => line.endsWith("start llm"))).to.equal(false);

		release();
		expect(await seq).to.equal("seq:hello");
		expect(await llm).to.equal("llm:hello");

		expect(r.log.findIndex((line) => line.endsWith("start llm"))).to.be.greaterThan(
			r.log.indexOf("w0 end seq2seq")
		);
	});

	it("unloads the GPU model before a Settings download of a CPU model", async () => {
		r = rig(true);

		expect(await text(r.service.translate(request("fr")))).to.equal("llm:hello");
		await r.service.download(catalog.nllb, "cpu");

		expect(r.log).to.include("w0 unload llm");
		expect(r.log.indexOf("w0 unload llm")).to.be.lessThan(r.log.indexOf("w0 load seq2seq"));
	});

	it("does not deadlock two downloads on the two engines", async () => {
		r = rig(true);

		const both = Promise.all([
			r.service.download(catalog.llm, "gpu"),
			r.service.download(catalog.opus["de-en"], "cpu"),
		]);

		await r.clock.tickAsync(100);
		await both;

		// Each loaded once, and the second only once the first was out of
		// memory: an unload (or a fresh worker) between the two loads.
		const loads = r.log
			.map((line, i) => ({line, i}))
			.filter(({line}) => line.includes(" load "));

		expect(loads).to.have.length(2);

		const between = r.log.slice(loads[0].i + 1, loads[1].i);

		expect(
			between.some((line) => line.includes("unload")) || loads[1].line.startsWith("w1")
		).to.equal(true);
	});

	it("keeps a waiting request's deadline alive while a Settings download moves, on a phone only", async () => {
		for (const mobile of [true, false]) {
			r = rig(mobile);
			r.llm.loadTicks = 4;
			await r.service.capabilities();

			const before = r.service.loadTicks();

			await r.service.download(catalog.llm, "gpu");
			expect(r.service.loadTicks() - before, mobile ? "phone" : "computer").to.equal(
				mobile ? 4 : 0
			);

			r.service.dispose();
			r.clock.restore();
		}

		r = rig(false);
	});

	it("holds every waiting request until the other engine's unload has answered", async () => {
		r = rig(true);

		expect(await text(r.service.translate(request("fr")))).to.equal("llm:hello");

		// An unload that takes its time, as freeing a GPU model does.
		const unload = r.llm.unload.bind(r.llm);

		r.llm.unload = async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			await unload();
			r.log.push("unloaded llm");
		};

		const all = Promise.all([
			text(r.service.translate(request("de"))),
			text(r.service.translate(request("de"))),
			text(r.service.translate(request("de"))),
		]);

		await r.clock.tickAsync(200);
		await all;

		const unloaded = r.log.indexOf("unloaded llm");

		expect(unloaded).to.be.greaterThan(-1);
		expect(r.log.filter((line) => line === "unloaded llm")).to.have.length(1);
		expect(r.log.findIndex((line) => line.endsWith("load seq2seq"))).to.be.greaterThan(
			unloaded
		);
	});

	it("keeps both engines in one worker on a computer, side by side", async () => {
		r = rig(false);

		const release = gate(r.seq2seq);
		const seq = text(r.service.translate(request("de")));

		await r.clock.tickAsync(10);

		expect(await text(r.service.translate(request("fr")))).to.equal("llm:hello");

		release();
		expect(await seq).to.equal("seq:hello");
		expect(await text(r.service.translate(request("fr")))).to.equal("llm:hello");

		expect(r.workers).to.have.length(1);
		expect(r.log.filter((line) => line.includes("unload"))).to.deep.equal([]);
	});
});
