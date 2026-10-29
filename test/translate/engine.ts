import {expect} from "chai";
import {emptyContext, type TranslateRequest} from "../../client/js/translate/engine";
import {FakeEngine} from "./fakeEngine";

function request(text: string, overrides: Partial<TranslateRequest> = {}): TranslateRequest {
	return {
		id: 1,
		model: "fake-model",
		text,
		from: "de",
		to: "en",
		purpose: "read",
		context: emptyContext(),
		...overrides,
	};
}

describe("translate/engine", () => {
	it("emptyContext is a context with nothing in it", () => {
		expect(emptyContext()).to.deep.equal({
			recent: [],
			names: [],
			terms: [],
			voice: [],
			formality: "auto",
		});
	});

	it("the fake engine streams cumulative chunks and ends with done", async () => {
		const engine = new FakeEngine("llm", (req) => [`Hello`, `Hello world`]);
		await engine.load(
			{
				engine: "llm",
				family: "llm",
				id: "fake-model",
				label: {kind: "llm", name: "Fake"},
				copies: {gpu: {sizeBytes: 0, source: "fake-model"}},
			},
			"gpu",
			() => {}
		);
		const seen: {text: string; done: boolean}[] = [];

		for await (const chunk of engine.translate(
			request("Hallo Welt"),
			new AbortController().signal
		)) {
			seen.push({text: chunk.text, done: chunk.done});
		}

		expect(seen).to.deep.equal([
			{text: "Hello", done: false},
			{text: "Hello world", done: false},
			{text: "Hello world", done: true},
		]);
		expect(engine.calls.translate.map((r) => r.text)).to.deep.equal(["Hallo Welt"]);
	});

	it("the fake engine stops when the signal aborts", async () => {
		const engine = new FakeEngine("llm", () => ["a", "ab", "abc"]);
		await engine.load(
			{
				engine: "llm",
				family: "llm",
				id: "fake-model",
				label: {kind: "llm", name: "Fake"},
				copies: {gpu: {sizeBytes: 0, source: "fake-model"}},
			},
			"gpu",
			() => {}
		);
		const controller = new AbortController();
		const seen: string[] = [];

		for await (const chunk of engine.translate(request("x"), controller.signal)) {
			seen.push(chunk.text);
			controller.abort();
		}

		expect(seen).to.deep.equal(["a"]);
	});

	it("the fake engine refuses to translate with a model it has not loaded", async () => {
		const engine = new FakeEngine("seq2seq", () => ["x"]);
		let error: Error | null = null;

		try {
			for await (const _chunk of engine.translate(
				request("x"),
				new AbortController().signal
			)) {
				// consume
			}
		} catch (e) {
			error = e as Error;
		}

		expect(error?.message).to.equal("model not loaded: fake-model");
	});
});
