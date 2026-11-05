import {expect} from "chai";
import {EngineError, emptyContext, type TranslateRequest} from "../../client/js/translate/engine";
import {
	SEQ2SEQ_MAX_LOADED,
	Seq2seqEngine,
	splitSentences,
	translationOptions,
	type PipelineLike,
	type Seq2seqDeps,
} from "../../client/js/translate/engines/seq2seq";
import {buildCatalog} from "../../client/js/translate/models";
import {placeholder} from "../../client/js/translate/spans";

// OPUS-MT and NLLB-200 with their GPU copies (off in the shipped catalog,
// models.ts CatalogOptions `seq2seqGpu`), so the per-device logic is covered.
const catalog = buildCatalog({seq2seqGpu: true});

function deps() {
	const calls = {
		pipeline: [] as string[],
		devices: [] as string[],
		copies: [] as unknown[],
		disposed: [] as string[],
		run: [] as [string, string, unknown][],
	};
	const failDispose = new Set<string>();
	const pending = new Map<string, Promise<void>>();
	const d: Seq2seqDeps = {
		pipeline(copy, device, onProgress) {
			const modelId = copy.source;

			calls.pipeline.push(modelId);
			calls.devices.push(device);
			calls.copies.push(copy);
			onProgress({file: "encoder.onnx", loaded: 50, total: 100});
			onProgress({file: "decoder.onnx", loaded: 0, total: 100});
			onProgress({file: "encoder.onnx", loaded: 100, total: 100});
			onProgress({file: "decoder.onnx", loaded: 100, total: 100});
			const pipe = ((text: string, options: unknown) => {
				calls.run.push([modelId, text, options]);

				const result = [{translation_text: `[${modelId}] ${text}`}];
				const block = pending.get(modelId);

				return block ? block.then(() => result) : Promise.resolve(result);
			}) as unknown as PipelineLike;

			pipe.dispose = () => {
				calls.disposed.push(modelId);

				return failDispose.has(modelId)
					? Promise.reject(new Error(`dispose failed: ${modelId}`))
					: Promise.resolve();
			};

			return Promise.resolve(pipe);
		},
		threads: () => false,
	};

	/** Blocks the next `translate()` call on this model until the returned function runs. */
	function gate(modelId: string): () => void {
		let release: () => void = () => {};

		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});

		pending.set(modelId, promise);

		return () => {
			pending.delete(modelId);
			release();
		};
	}

	return {deps: d, calls, failDispose, gate};
}

function request(overrides: Partial<TranslateRequest> = {}): TranslateRequest {
	return {
		id: 1,
		model: catalog.nllb.id,
		text: "Hallo Welt",
		from: "de",
		to: "en",
		purpose: "read",
		context: emptyContext(),
		...overrides,
	};
}

describe("translate/engines/seq2seq", () => {
	it("translationOptions gives NLLB its FLORES codes and OPUS nothing", () => {
		expect(translationOptions(request())).to.deep.equal({
			src_lang: "deu_Latn",
			tgt_lang: "eng_Latn",
		});
		expect(translationOptions(request({model: "Xenova/opus-mt-de-en"}))).to.deep.equal({});
	});

	it("translationOptions falls back to the source hint and refuses an unknown pair", () => {
		expect(
			translationOptions(
				request({from: null, context: {...emptyContext(), sourceHint: "fr"}})
			)
		).to.deep.equal({src_lang: "fra_Latn", tgt_lang: "eng_Latn"});
		expect(() => translationOptions(request({from: null}))).to.throw(
			"NLLB needs a source language"
		);
		expect(() => translationOptions(request({to: "xx"}))).to.throw("no NLLB code for xx");
	});

	it("load creates the pipeline once and reports progress across files", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		const progress: number[] = [];

		await engine.load(catalog.nllb, "cpu", (p) => progress.push(p.fraction));
		await engine.load(catalog.nllb, "cpu", (p) => progress.push(p.fraction));

		expect(d.calls.pipeline).to.deep.equal([catalog.nllb.id]);
		expect(progress).to.deep.equal([0.5, 0.25, 0.5, 1]);
		expect(engine.status()).to.equal("ready");
		expect(engine.isLoaded(catalog.nllb.id)).to.equal(true);
	});

	it("the pipeline dep gets the copy's source and dtype and the device", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		const gpuCopy = catalog.nllb.copies.gpu;
		const cpuCopy = catalog.nllb.copies.cpu;

		await engine.load(catalog.nllb, "gpu", () => {});
		expect(d.calls.devices).to.deep.equal(["gpu"]);
		expect(d.calls.copies[0]).to.equal(gpuCopy);
		expect(engine.isLoaded(catalog.nllb.id, "gpu")).to.equal(true);
		expect(engine.isLoaded(catalog.nllb.id, "cpu")).to.equal(false);

		const cpu = new Seq2seqEngine(d.deps);

		await cpu.load(catalog.nllb, "cpu", () => {});
		expect(d.calls.copies[1]).to.equal(cpuCopy);
		expect((d.calls.copies[1] as {dtype: string}).dtype).to.equal("q8");
	});

	it("a device with no copy is a load failure", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		const noGpu = {...catalog.nllb, copies: {cpu: catalog.nllb.copies.cpu}};
		let error: unknown = null;

		try {
			await engine.load(noGpu, "gpu", () => {});
		} catch (e) {
			error = e;
		}

		expect(error).to.be.instanceOf(EngineError);
		expect((error as EngineError).cause).to.equal("load");
	});

	it("a seq2seq GPU failure after a device loss says the GPU stopped", async () => {
		const d = deps();
		let lost: {reason: string; message: string} | null = null;
		const gpuDeps: Seq2seqDeps = {
			...d.deps,
			takeDeviceLoss() {
				const taken = lost;

				lost = null;
				return taken;
			},
			async pipeline(copy, device, onProgress) {
				const pipe = await d.deps.pipeline(copy, device, onProgress);
				const failing = (() => {
					lost = {reason: "unknown", message: "the device was removed"};
					return Promise.reject(new Error("Failed to execute"));
				}) as unknown as PipelineLike;

				failing.dispose = () => pipe.dispose();
				return failing;
			},
		};
		const engine = new Seq2seqEngine(gpuDeps);

		await engine.load(catalog.nllb, "gpu", () => {});

		let message = "";

		try {
			for await (const _c of engine.translate(
				{
					id: 1,
					model: catalog.nllb.id,
					text: "hi",
					from: "en",
					to: "de",
					purpose: "read",
					context: emptyContext(),
				},
				new AbortController().signal
			)) {
				// consume
			}
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal(
			"the GPU device was lost: the device was removed\nFailed to execute"
		);
	});

	it("translate yields once, done, with the pipeline's text", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		await engine.load(catalog.nllb, "cpu", () => {});
		const chunks: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(request(), new AbortController().signal)) {
			chunks.push({text: chunk.text, done: chunk.done});
		}

		expect(chunks).to.deep.equal([{text: `[${catalog.nllb.id}] Hallo Welt`, done: true}]);
		expect(d.calls.run[0][2]).to.deep.equal({src_lang: "deu_Latn", tgt_lang: "eng_Latn"});
	});

	describe("splitSentences", () => {
		it("splits after a full stop, a question mark and an exclamation mark", () => {
			expect(
				splitSentences(
					"We moved the deploy to Thursday. Please keep the timestamps in the log this time."
				)
			).to.deep.equal([
				"We moved the deploy to Thursday.",
				"Please keep the timestamps in the log this time.",
			]);
			expect(splitSentences("really? yes! see you")).to.deep.equal([
				"really?",
				"yes!",
				"see you",
			]);
			expect(splitSentences("wait… what?! no")).to.deep.equal(["wait…", "what?!", "no"]);
		});

		it("never at a decimal point, a version number or a mark with no space after it", () => {
			expect(splitSentences("v2.4 is out. update now")).to.deep.equal([
				"v2.4 is out.",
				"update now",
			]);
			expect(splitSentences("it costs 2.50 today")).to.deep.equal(["it costs 2.50 today"]);
			expect(splitSentences("see example.com for it")).to.deep.equal([
				"see example.com for it",
			]);
		});

		it("keeps a placeholder whole and a closing quote with its sentence", () => {
			expect(splitSentences(`see ${placeholder(0)}. it has the log`)).to.deep.equal([
				`see ${placeholder(0)}.`,
				"it has the log",
			]);
			expect(splitSentences('she said "done." then left')).to.deep.equal([
				'she said "done."',
				"then left",
			]);
		});

		it("splits after CJK full-width marks with no space after them", () => {
			expect(splitSentences("我们把部署改到了周四。请保留日志！可以吗？")).to.deep.equal([
				"我们把部署改到了周四。",
				"请保留日志！",
				"可以吗？",
			]);
		});

		it("gives one sentence back as it is, and trims around several", () => {
			expect(splitSentences("can you send me the log from yesterday?")).to.deep.equal([
				"can you send me the log from yesterday?",
			]);
			expect(splitSentences("no full stop here  ")).to.deep.equal(["no full stop here  "]);
			expect(splitSentences("  One.   Two.  ")).to.deep.equal(["One.", "Two."]);
			expect(splitSentences("")).to.deep.equal([""]);
		});
	});

	it("NLLB translates sentence by sentence and streams the text so far", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		await engine.load(catalog.nllb, "cpu", () => {});
		const chunks: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(
			request({text: `Wir sind da. ${placeholder(0)}. Bis bald`}),
			new AbortController().signal
		)) {
			chunks.push({text: chunk.text, done: chunk.done});
		}

		const id = catalog.nllb.id;

		// The placeholder on its own is kept, never sent to the model.
		expect(d.calls.run.map(([, text]) => text)).to.deep.equal(["Wir sind da.", "Bis bald"]);
		expect(chunks).to.deep.equal([
			{text: `[${id}] Wir sind da.`, done: false},
			{text: `[${id}] Wir sind da. ${placeholder(0)}.`, done: false},
			{text: `[${id}] Wir sind da. ${placeholder(0)}. [${id}] Bis bald`, done: true},
		]);
	});

	it("OPUS-MT gets a multi-sentence text whole", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		const opus = catalog.opus["de-en"];
		await engine.load(opus, "cpu", () => {});
		const chunks: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(
			request({model: opus.id, text: "Wir sind da. Bis bald"}),
			new AbortController().signal
		)) {
			chunks.push({text: chunk.text, done: chunk.done});
		}

		expect(d.calls.run.map(([, text]) => text)).to.deep.equal(["Wir sind da. Bis bald"]);
		expect(chunks).to.deep.equal([{text: `[${opus.id}] Wir sind da. Bis bald`, done: true}]);
	});

	it("a cancel between two sentences stops before the next one", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		await engine.load(catalog.nllb, "cpu", () => {});
		const controller = new AbortController();
		const chunks: string[] = [];

		for await (const chunk of engine.translate(
			request({text: "Eins. Zwei. Drei."}),
			controller.signal
		)) {
			chunks.push(chunk.text);
			controller.abort();
		}

		expect(d.calls.run.length).to.equal(2);
		expect(chunks.length).to.equal(1);
	});

	it("keeps two models and evicts the least recently used", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		const a = catalog.opus["de-en"];
		const b = catalog.opus["fr-en"];
		const c = catalog.opus["es-en"];

		expect(SEQ2SEQ_MAX_LOADED).to.equal(2);
		await engine.load(a, "cpu", () => {});
		await engine.load(b, "cpu", () => {});

		// use a, so b is the least recently used
		for await (const _chunk of engine.translate(
			request({model: a.id}),
			new AbortController().signal
		)) {
			// consume
		}

		await engine.load(c, "cpu", () => {});
		expect(d.calls.disposed).to.deep.equal([b.id]);
		expect(engine.loadedModels()).to.deep.equal([a.id, c.id]);
	});

	it("refuses batched requests and unknown models", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		await engine.load(catalog.nllb, "cpu", () => {});
		const messages: string[] = [];

		for (const req of [request({lines: ["a", "b"]}), request({model: "nope"})]) {
			try {
				for await (const _c of engine.translate(req, new AbortController().signal)) {
					// consume
				}
			} catch (e) {
				messages.push((e as Error).message);
			}
		}

		expect(messages).to.deep.equal(["seq2seq engines do not batch", "model not loaded: nope"]);
	});

	it("unload disposes everything; a failed load keeps the others", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		await engine.load(catalog.nllb, "cpu", () => {});

		d.deps.pipeline = () => Promise.reject(new Error("404"));

		let message = "";

		try {
			await engine.load(catalog.opus["de-en"], "cpu", () => {});
		} catch (e) {
			message = (e as Error).message;
		}

		expect(message).to.equal("404");
		expect(engine.status()).to.equal("ready");
		expect(engine.loadedModels()).to.deep.equal([catalog.nllb.id]);
		await engine.unload();
		expect(d.calls.disposed).to.deep.equal([catalog.nllb.id]);
		expect(engine.status()).to.equal("cold");
		expect(engine.capabilities()).to.deep.equal({
			streams: false,
			batches: false,
			threads: false,
		});
	});

	it("dedupes two concurrent loads of the same model", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);

		await Promise.all([
			engine.load(catalog.nllb, "cpu", () => {}),
			engine.load(catalog.nllb, "cpu", () => {}),
		]);

		expect(d.calls.pipeline).to.deep.equal([catalog.nllb.id]);
		expect(engine.isLoaded(catalog.nllb.id)).to.equal(true);
	});

	it("never evicts a pipeline mid-translate, and re-admits it to eviction once free", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		const a = catalog.opus["de-en"];
		const b = catalog.opus["fr-en"];
		const c = catalog.opus["es-en"];
		const e = catalog.opus["it-en"];

		await engine.load(a, "cpu", () => {});
		await engine.load(b, "cpu", () => {});

		const release = d.gate(a.id);
		const consumed = (async () => {
			const chunks: {text: string; done: boolean}[] = [];

			for await (const chunk of engine.translate(
				request({model: a.id}),
				new AbortController().signal
			)) {
				chunks.push({text: chunk.text, done: chunk.done});
			}

			return chunks;
		})();

		// a is mid-translate (blocked on the gate): loading a third model must
		// evict b, the least recently used pipeline that is not in use, and
		// must not touch a.
		await engine.load(c, "cpu", () => {});
		expect(d.calls.disposed).to.deep.equal([b.id]);
		expect(engine.loadedModels()).to.deep.equal([a.id, c.id]);

		release();
		const chunks = await consumed;

		expect(chunks).to.deep.equal([{text: `[${a.id}] Hallo Welt`, done: true}]);
		// a's translate has ended, but the cache is not over capacity, so
		// nothing is evicted yet — a is merely eligible again.
		expect(d.calls.disposed).to.deep.equal([b.id]);
		expect(engine.loadedModels()).to.deep.equal([a.id, c.id]);

		// Now that a is free, it is the least recently used pipeline and a
		// fourth model finally evicts it.
		await engine.load(e, "cpu", () => {});
		expect(d.calls.disposed).to.deep.equal([b.id, a.id]);
		expect(engine.loadedModels()).to.deep.equal([c.id, e.id]);
	});

	it("unload resolves even if a dispose throws, and attempts every pipeline", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		const a = catalog.opus["de-en"];
		const b = catalog.opus["fr-en"];

		await engine.load(a, "cpu", () => {});
		await engine.load(b, "cpu", () => {});
		d.failDispose.add(a.id);

		await engine.unload();

		expect(d.calls.disposed).to.deep.equal([a.id, b.id]);
		expect(engine.status()).to.equal("cold");
		expect(engine.loadedModels()).to.deep.equal([]);
	});

	it("an eviction whose dispose throws still lets the new model load", async () => {
		const d = deps();
		const engine = new Seq2seqEngine(d.deps);
		const a = catalog.opus["de-en"];
		const b = catalog.opus["fr-en"];
		const c = catalog.opus["es-en"];

		await engine.load(a, "cpu", () => {});
		await engine.load(b, "cpu", () => {});
		d.failDispose.add(a.id);

		await engine.load(c, "cpu", () => {});

		expect(d.calls.disposed).to.deep.equal([a.id]);
		expect(engine.status()).to.equal("ready");
		expect(engine.loadedModels()).to.deep.equal([b.id, c.id]);
	});
});
