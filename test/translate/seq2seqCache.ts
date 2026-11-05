import {expect} from "chai";
import {onnxDtype, seq2seqCacheApi} from "../../client/js/translate/engines/seq2seqCache";
import {buildCatalog} from "../../client/js/translate/models";

// OPUS-MT and NLLB-200 with their GPU copies (off in the shipped catalog,
// models.ts CatalogOptions `seq2seqGpu`), so the per-device logic is covered.
const catalog = buildCatalog({seq2seqGpu: true});
const repo = "https://huggingface.co/Xenova/opus-mt-en-de/resolve/main";
const other = "https://huggingface.co/Xenova/opus-mt-de-en/resolve/main";

function store(urls: string[]) {
	const held = new Set(urls);

	return {
		held,
		keys: () => Promise.resolve([...held]),
		delete(url: string) {
			held.delete(url);
			return Promise.resolve();
		},
	};
}

describe("translate/engines/seq2seqCache", () => {
	it("reads a weights file's dtype from transformers.js's suffix", () => {
		expect(onnxDtype(`${repo}/onnx/encoder_model_quantized.onnx`)).to.equal("q8");
		expect(onnxDtype(`${repo}/onnx/decoder_model_merged_fp16.onnx`)).to.equal("fp16");
		expect(onnxDtype(`${repo}/onnx/encoder_model_q4f16.onnx_data`)).to.equal("q4f16");
		expect(onnxDtype(`${repo}/onnx/encoder_model_q4.onnx`)).to.equal("q4");
		expect(onnxDtype(`${repo}/onnx/encoder_model.onnx`)).to.equal("fp32");
		expect(onnxDtype(`${repo}/tokenizer.json`)).to.equal(null);
		expect(onnxDtype(`${repo}/config.json?download=1`)).to.equal(null);
	});

	it("answers per copy, and deleting one copy leaves the other's files", async () => {
		const ref = catalog.opus["en-de"];
		const s = store([
			`${repo}/config.json`,
			`${repo}/tokenizer.json`,
			`${repo}/onnx/encoder_model_quantized.onnx`,
			`${repo}/onnx/decoder_model_merged_quantized.onnx`,
			`${repo}/onnx/encoder_model_fp16.onnx`,
			`${repo}/onnx/decoder_model_merged_fp16.onnx`,
			`${other}/onnx/encoder_model_quantized.onnx`,
		]);
		const api = seq2seqCacheApi(s);

		expect(await api.has(ref, "cpu")).to.equal(true);
		expect(await api.has(ref, "gpu")).to.equal(true);

		await api.delete(ref, "cpu");

		expect(await api.has(ref, "cpu")).to.equal(false);
		expect(await api.has(ref, "gpu")).to.equal(true);
		expect([...s.held]).to.have.members([
			`${repo}/config.json`,
			`${repo}/tokenizer.json`,
			`${repo}/onnx/encoder_model_fp16.onnx`,
			`${repo}/onnx/decoder_model_merged_fp16.onnx`,
			`${other}/onnx/encoder_model_quantized.onnx`,
		]);

		// The last copy takes the shared files with it; another model is untouched.
		await api.delete(ref, "gpu");

		expect([...s.held]).to.deep.equal([`${other}/onnx/encoder_model_quantized.onnx`]);
	});

	it("a device with no copy has nothing downloaded", async () => {
		const ref = {...catalog.nllb, copies: {cpu: catalog.nllb.copies.cpu}};
		const api = seq2seqCacheApi(
			store([`https://huggingface.co/${ref.id}/resolve/main/onnx/encoder_model_q4f16.onnx`])
		);

		expect(await api.has(ref, "gpu")).to.equal(false);
	});
});
