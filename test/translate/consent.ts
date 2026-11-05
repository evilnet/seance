import {expect} from "chai";
import {
	CONSENT_KEY,
	DownloadConsent,
	NEEDS_DOWNLOAD,
	memoryConsent,
	consentId,
	needsDownloadError,
	parseNeedsDownload,
	storedConsent,
} from "../../client/js/translate/consent";
import {QWEN3_1_7B_SPLIT_ID, buildCatalog, listedSize} from "../../client/js/translate/models";
import type {ModelRef} from "../../client/js/translate/engine";

const catalog = buildCatalog();

function mapBackend() {
	const map = new Map<string, string>();

	return {
		map,
		get: (key: string) => map.get(key) ?? null,
		set: (key: string, value: string) => void map.set(key, value),
	};
}

describe("translate/consent", () => {
	it("carries the model in the failure and reads it back", () => {
		const message = needsDownloadError(catalog.opus["de-en"]);

		expect(message.startsWith(`${NEEDS_DOWNLOAD}: `)).to.equal(true);
		expect(parseNeedsDownload(message)).to.deep.equal({
			id: catalog.opus["de-en"].id,
			sizeBytes: listedSize(catalog.opus["de-en"]),
			label: catalog.opus["de-en"].label,
		});
		expect(parseNeedsDownload("timed out")).to.equal(null);
		expect(parseNeedsDownload(`${NEEDS_DOWNLOAD}: {broken`)).to.equal(null);
	});

	it("names the declined copy's own size", () => {
		const need = parseNeedsDownload(needsDownloadError(catalog.llm, "cpu"));

		expect(need?.sizeBytes).to.equal(catalog.llm.copies.cpu!.sizeBytes);
		expect(need?.id).to.equal(catalog.llm.id);
	});

	it("keeps the old id for the copy the model ran on before, the other is <id>@<device>", () => {
		const MiB = 1024 * 1024;

		// OPUS-MT and NLLB-200 ran on the CPU: a yes given then was a yes to that copy.
		expect(consentId(catalog.nllb, "cpu", 2147483644)).to.equal(catalog.nllb.id);
		expect(consentId(catalog.nllb, "gpu", 2147483644)).to.equal(`${catalog.nllb.id}@gpu`);
		expect(consentId(catalog.opus["de-en"], "gpu", 2147483644)).to.equal(
			`${catalog.opus["de-en"].id}@gpu`
		);
		// The language model ran on the GPU.
		// The GPU copy's build follows the binding; the CPU copy has one build.
		expect(consentId(catalog.llm, "gpu", 128 * MiB)).to.equal(QWEN3_1_7B_SPLIT_ID);
		expect(consentId(catalog.llm, "cpu", 128 * MiB)).to.equal(`${catalog.llm.id}@cpu`);
	});

	it("hands the dialog the copy's device", async () => {
		const devices: string[] = [];
		const consent = new DownloadConsent((_ref, device) => {
			devices.push(device);

			return Promise.resolve(true);
		}, memoryConsent());

		await consent.ask({...catalog.llm, id: `${catalog.llm.id}@cpu`}, "cpu", () => true);
		expect(devices).to.deep.equal(["cpu"]);
		expect(consent.granted(`${catalog.llm.id}@cpu`)).to.equal(true);
		expect(consent.granted(catalog.llm.id)).to.equal(false);
	});

	it("remembers a yes under thelounge.state.*, which the settings backup never carries", () => {
		const backend = mapBackend();
		const store = storedConsent(backend);

		expect(CONSENT_KEY.startsWith("thelounge.state.")).to.equal(true);
		store.grant("a");
		store.grant("a");
		store.grant("b");
		expect(JSON.parse(backend.map.get(CONSENT_KEY)!)).to.deep.equal(["a", "b"]);
		expect(storedConsent(backend).has("b")).to.equal(true);
		store.revoke("a");
		expect(store.has("a")).to.equal(false);
		// A broken entry reads as no yes at all.
		backend.map.set(CONSENT_KEY, "{");
		expect(store.has("b")).to.equal(false);
	});

	it("asks one model at a time, shares a question, and a no holds every later one back", async () => {
		const asked: string[] = [];
		const answers: ((yes: boolean) => void)[] = [];
		const consent = new DownloadConsent((ref: ModelRef) => {
			asked.push(ref.id);

			return new Promise<boolean>((resolve) => answers.push(resolve));
		}, memoryConsent());
		const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
		const a1 = consent.ask(catalog.llm, "gpu", () => true);
		const a2 = consent.ask(catalog.llm, "gpu", () => true);
		const b = consent.ask(catalog.nllb, "gpu", () => true);

		await tick();
		expect(asked).to.deep.equal([catalog.llm.id]);
		answers.shift()!(false);
		expect(await a1).to.equal(false);
		expect(await a2).to.equal(false);
		expect(await b).to.equal(false);
		expect(asked).to.have.length(1);
		expect(consent.anyDeclined).to.equal(true);

		consent.forgetDeclines();

		const c = consent.ask(catalog.nllb, "gpu", () => true);

		await tick();
		answers.shift()!(true);
		expect(await c).to.equal(true);
		expect(consent.granted(catalog.nllb.id)).to.equal(true);
	});

	it("does not ask about a model that needs no download any more by its turn", async () => {
		let asked = 0;
		const consent = new DownloadConsent(() => {
			asked++;

			return Promise.resolve(true);
		}, memoryConsent());

		expect(await consent.ask(catalog.llm, "gpu", () => false)).to.equal(true);
		expect(asked).to.equal(0);
		expect(consent.granted(catalog.llm.id)).to.equal(false);
	});

	it("keeps a yes for the session when the storage cannot write", async () => {
		let asked = 0;
		const deaf = {has: () => false, grant() {}, revoke() {}};
		const consent = new DownloadConsent(() => {
			asked++;

			return Promise.resolve(true);
		}, deaf);

		expect(await consent.ask(catalog.llm, "gpu", () => true)).to.equal(true);
		expect(consent.granted(catalog.llm.id)).to.equal(true);
		expect(await consent.ask(catalog.llm, "gpu", () => true)).to.equal(true);
		expect(asked).to.equal(1);
		consent.revoke(catalog.llm.id);
		expect(consent.granted(catalog.llm.id)).to.equal(false);
	});

	it("reads a dialog that fails as a no", async () => {
		const consent = new DownloadConsent(
			() => Promise.reject(new Error("gone")),
			memoryConsent()
		);

		expect(await consent.ask(catalog.llm, "gpu", () => true)).to.equal(false);
		expect(consent.declined(catalog.llm.id)).to.equal(true);
	});
});
