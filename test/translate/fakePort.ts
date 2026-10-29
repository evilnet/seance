import {expect} from "chai";
import {TranslateClient} from "../../client/js/translate/client";
import {emptyContext} from "../../client/js/translate/engine";
import {FAKE_CAPABILITY, fakePort} from "../../client/js/translate/fakePort";
import {buildCatalog} from "../../client/js/translate/models";
import {parseBatchedOutput} from "../../client/js/translate/prompt";

// OPUS-MT and NLLB-200 with their GPU copies (off in the shipped catalog,
// models.ts CatalogOptions `seq2seqGpu`), so the per-device logic is covered.
const catalog = buildCatalog({seq2seqGpu: true});

describe("translate/fakePort", () => {
	afterEach(() => {
		delete globalThis.__seanceTranslateFake;
	});

	it("downloads with progress, remembers the cache, deletes, and echoes a translation", async () => {
		const {port, terminate} = fakePort({stepMs: 0});
		const client = new TranslateClient(port);

		client.configure(catalog, "https://app.test/js/ort/");
		const progress: number[] = [];

		await client.load(catalog.llm, "gpu", (p) => progress.push(p.fraction));
		expect(progress.length).to.be.greaterThan(2);
		expect(progress[progress.length - 1]).to.equal(1);
		expect((await client.models()).find((m) => m.ref.id === catalog.llm.id)?.cached).to.equal(
			true
		);

		const chunks: string[] = [];

		for await (const chunk of client.translate(
			{
				id: 1,
				model: catalog.llm.id,
				text: "Hallo Welt",
				from: "de",
				to: "en",
				purpose: "read",
				context: emptyContext(),
			},
			catalog.llm
		)) {
			chunks.push(chunk.text);
		}

		expect(chunks[chunks.length - 1]).to.equal("[English] Hallo Welt");
		expect(chunks.length).to.be.greaterThan(1);

		await client.deleteModel(catalog.llm, "gpu");
		expect((await client.models()).find((m) => m.ref.id === catalog.llm.id)?.cached).to.equal(
			false
		);
		expect(FAKE_CAPABILITY.tier).to.equal("gpu");
		terminate();
	});

	it("remembers a download per copy: the CPU copy's load leaves the GPU copy absent", async () => {
		const {port, terminate} = fakePort({stepMs: 0});
		const client = new TranslateClient(port);

		client.configure(catalog, "https://app.test/js/ort/");
		await client.load(catalog.nllb, "cpu", () => {});

		const nllb = (await client.models())
			.filter((m) => m.ref.id === catalog.nllb.id)
			.map((m) => [m.device, m.cached]);

		expect(nllb).to.deep.equal([
			["gpu", false],
			["cpu", true],
		]);
		terminate();
	});

	it("answers a batched request as numbered lines closed by END, and logs the request", async () => {
		const {port, terminate} = fakePort({stepMs: 0});
		const client = new TranslateClient(port);

		client.configure(catalog, "https://app.test/js/ort/");
		await client.load(catalog.llm, "gpu", () => {});

		const lines = ["Hallo", "Wie geht es dir", "Tschüss"];
		let last = "";

		for await (const chunk of client.translate(
			{
				id: 2,
				model: catalog.llm.id,
				text: "",
				lines,
				from: "de",
				to: "en",
				purpose: "read",
				context: emptyContext(),
			},
			catalog.llm
		)) {
			last = chunk.text;
		}

		expect(last.trim().endsWith("END")).to.equal(true);
		const parsed = parseBatchedOutput(last, lines.length);
		expect(parsed).to.not.equal(null);
		expect(parsed).to.deep.equal(lines.map((l) => `[English] ${l}`));

		expect(globalThis.__seanceTranslateFake?.requests).to.have.length(1);
		expect(globalThis.__seanceTranslateFake?.requests[0]).to.deep.equal({
			id: 2,
			model: catalog.llm.id,
			text: "",
			purpose: "read",
			lines: 3,
			from: "de",
			to: "en",
			engine: "llm",
			// The marker form the route chose (spans.ts `renderMarkers`); a
			// request that names none carries the numbered pairs.
			markers: "placeholder",
			// How much of the channel the context carried: a scenario tells
			// the composer's bare second try from the first request by these.
			contextLines: 0,
			voice: 0,
			// The prompt's "probably …": none on this request.
			sourceHint: null,
		});

		terminate();
	});

	it("hands back a request carrying [echo], and one carrying [echo-once] only once", async () => {
		const {port, terminate} = fakePort({stepMs: 0});
		const client = new TranslateClient(port);

		client.configure(catalog, "https://app.test/js/ort/");
		await client.load(catalog.llm, "gpu", () => {});

		const base = {
			id: 4,
			model: catalog.llm.id,
			from: "de",
			to: "en",
			purpose: "read" as const,
			context: emptyContext(),
		};

		const answer = async (text: string): Promise<string> => {
			let last = "";

			for await (const chunk of client.translate({...base, text}, catalog.llm)) {
				last = chunk.text;
			}

			return last;
		};

		// `[echo]` is every time: the echo rule's own scenario step wants both
		// the translation and its bare retry to come back unchanged.
		expect(await answer("this line comes [echo] back")).to.equal("this line comes [echo] back");
		expect(await answer("this line comes [echo] back")).to.equal("this line comes [echo] back");

		// `[echo-once]` is the bare retry succeeding: handed back once, then
		// translated. Keyed on the text, like `[fail]`'s single failure —
		// and a retry is the same text, so it is the same key.
		expect(await answer("this line comes [echo-once] back")).to.equal(
			"this line comes [echo-once] back"
		);
		expect(await answer("this line comes [echo-once] back")).to.equal(
			"[English] this line comes [echo-once] back"
		);

		// A batch hands back only the lines that carry a token: a channel's
		// backlog queued together must not fail every line beside one echo.
		const batchLines = ["erste Zeile hier", "this line comes [echo] back", "dritte Zeile hier"];
		let batched = "";

		for await (const chunk of client.translate(
			{...base, text: "", lines: batchLines},
			catalog.llm
		)) {
			batched = chunk.text;
		}

		expect(parseBatchedOutput(batched, batchLines.length)).to.deep.equal([
			"[English] erste Zeile hier",
			"this line comes [echo] back",
			"[English] dritte Zeile hier",
		]);

		// A reading batch holding a line that has not failed yet answers
		// nothing a parser accepts (the queue falls back to singles), and that
		// line alone then fails once.
		const failLines = ["erste Zeile hier", "this line will [fail] in a batch"];
		let failBatch = "x";

		for await (const chunk of client.translate(
			{...base, text: "", lines: failLines},
			catalog.llm
		)) {
			failBatch = chunk.text;
		}

		expect(parseBatchedOutput(failBatch, failLines.length)).to.equal(null);

		let singleError = "";

		try {
			await answer("this line will [fail] in a batch");
		} catch (e) {
			singleError = e instanceof Error ? e.message : String(e);
		}

		expect(singleError).to.contain("scripted failure");
		expect(await answer("this line will [fail] in a batch")).to.equal(
			"[English] this line will [fail] in a batch"
		);

		// And a batch holding it again -- what a requeue sends -- still falls
		// back to singles rather than failing every line beside it.
		let failAgain = "x";

		for await (const chunk of client.translate(
			{...base, text: "", lines: failLines},
			catalog.llm
		)) {
			failAgain = chunk.text;
		}

		expect(parseBatchedOutput(failAgain, failLines.length)).to.equal(null);

		terminate();
	});

	it("fails a request carrying [fail] once, then succeeds the same text again", async () => {
		const {port, terminate} = fakePort({stepMs: 0});
		const client = new TranslateClient(port);

		client.configure(catalog, "https://app.test/js/ort/");
		await client.load(catalog.llm, "gpu", () => {});

		const req = {
			id: 3,
			model: catalog.llm.id,
			text: "this line will [fail] once",
			from: "de",
			to: "en",
			purpose: "read" as const,
			context: emptyContext(),
		};

		let threw = false;

		try {
			for await (const _chunk of client.translate(req, catalog.llm)) {
				// draining
			}
		} catch (e) {
			threw = true;
		}

		expect(threw).to.equal(true);

		const chunks: string[] = [];

		for await (const chunk of client.translate(req, catalog.llm)) {
			chunks.push(chunk.text);
		}

		expect(chunks[chunks.length - 1]).to.equal("[English] this line will [fail] once");
		terminate();

		// The one-shot is the engine instance's, not the module's: a fresh
		// page (a scenario reload) fails the same text again.
		const second = fakePort({stepMs: 0});
		const reloaded = new TranslateClient(second.port);

		reloaded.configure(catalog, "https://app.test/js/ort/");
		await reloaded.load(catalog.llm, "gpu", () => {});

		let threwAgain = false;

		try {
			for await (const _chunk of reloaded.translate(req, catalog.llm)) {
				// draining
			}
		} catch (e) {
			threwAgain = true;
		}

		expect(threwAgain).to.equal(true);
		second.terminate();
	});
});
