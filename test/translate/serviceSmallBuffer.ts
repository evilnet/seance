// The page's side of the small-buffer build: the worker is told what the
// probe measured (it decides which build loads and has no localStorage for
// the test switch), told again when a worker started before the probe
// landed, and a download's consent is kept per build.

import {expect} from "chai";
import sinon from "ts-sinon";
import type {Capability} from "../../client/js/translate/capability";
import type {ModelRef} from "../../client/js/translate/engine";
import {
	type GpuBudget,
	type ModelCatalog,
	QWEN3_1_7B_ID,
	QWEN3_1_7B_SPLIT_ID,
	buildCatalog,
	type DeviceChoices,
} from "../../client/js/translate/models";
import {createPortPair} from "../../client/js/translate/protocol";
import {TranslateClient} from "../../client/js/translate/client";
import {TranslateService} from "../../client/js/translate/service";
import {serveEngines} from "../../client/js/translate/worker";
import {memoryConsent} from "../../client/js/translate/consent";
import {DEFAULT_ROUTES} from "../../client/js/translate/routes.default";
import {FakeEngine} from "./fakeEngine";

const AUTO: DeviceChoices = {llm: "auto", opus: "auto", nllb: "auto"};

const MiB = 1024 * 1024;

function phone(overrides: Partial<Capability> = {}): Capability {
	return {
		tier: "gpu",
		reasons: [],
		f16: true,
		maxBufferBytes: 128 * MiB,
		deviceMemoryGiB: 8,
		storageQuotaBytes: null,
		mobile: true,
		bufferCapBytes: null,
		...overrides,
	};
}

function rig(capability: Capability, consent?: {ask: (ref: ModelRef) => Promise<boolean>}) {
	const configured: (GpuBudget | undefined)[] = [];
	const asked: string[] = [];
	const modelsAsked: number[] = [];
	let release!: () => void;
	const probeGate = new Promise<void>((resolve) => (release = resolve));
	const store = memoryConsent();
	const service = new TranslateService(
		{
			createClient() {
				const [mainPort, workerPort] = createPortPair();
				const client = new TranslateClient(mainPort);

				serveEngines(
					workerPort,
					{
						llm: new FakeEngine("llm", (req) => [req.text]),
						seq2seq: new FakeEngine("seq2seq", (req) => [req.text]),
					},
					{
						cache: {
							has(ref) {
								modelsAsked.push(configured.length);

								return Promise.resolve(ref.id === "never");
							},
							delete: () => Promise.resolve(),
						},
						configure(_catalog: ModelCatalog, _ortBase: string, gpu?: GpuBudget) {
							configured.push(gpu);
						},
					}
				);

				return {client, terminate() {}};
			},
			probe: () => probeGate.then(() => capability),
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
			...(consent
				? {
						askDownload(ref: ModelRef) {
							asked.push(ref.id);

							return consent.ask(ref);
						},
						consent: store,
				  }
				: {}),
		},
		{
			catalog: buildCatalog(),
			selectedLlm: QWEN3_1_7B_ID,
			routesFor: () => DEFAULT_ROUTES,
			ortBase: "https://app.test/js/ort/",
			enabled: true,
		},
		{switches: {llm: true, opus: true, nllb: true}, devices: AUTO}
	);

	return {service, configured, asked, modelsAsked, store, releaseProbe: () => release()};
}

describe("translate/service and the small-buffer build", () => {
	let clock: sinon.SinonFakeTimers;

	beforeEach(() => {
		clock = sinon.useFakeTimers();
	});

	afterEach(() => {
		clock.restore();
	});

	it("tells a worker started before the probe what it measured, and asks the cache again", async () => {
		const r = rig(phone({bufferCapBytes: 128 * MiB}));
		const first = r.service.models();

		await clock.tickAsync(1);
		await first;
		expect(r.configured).to.deep.equal([undefined]);

		const askedBefore = r.modelsAsked.length;

		r.releaseProbe();
		await r.service.capabilities();
		await clock.tickAsync(1);

		expect(r.configured).to.deep.equal([
			undefined,
			{maxBufferBytes: 128 * MiB, capBytes: 128 * MiB, mobile: true},
		]);
		// Settings' rows are asked again, now against the build that loads here.
		expect(r.modelsAsked.length).to.be.greaterThan(askedBefore);
		expect(r.modelsAsked.slice(askedBefore).every((n) => n === 2)).to.equal(true);
		r.service.dispose();
	});

	it("starts a worker after the probe with the budget in its first configure", async () => {
		const r = rig(phone());

		r.releaseProbe();
		await r.service.capabilities();
		await r.service.models();
		expect(r.configured).to.deep.equal([
			{maxBufferBytes: 128 * MiB, capBytes: null, mobile: true},
		]);
		r.service.dispose();
	});

	it("tells a computer's worker no more than it always did: no mobile flag", async () => {
		const r = rig(phone({mobile: false}));

		r.releaseProbe();
		await r.service.capabilities();
		await r.service.models();
		expect(r.configured).to.deep.equal([{maxBufferBytes: 128 * MiB, capBytes: null}]);
		r.service.dispose();
	});

	it("keeps a download's yes per build: a yes for the model itself does not cover a phone's", async () => {
		const answers: boolean[] = [];
		const r = rig(phone(), {
			ask() {
				answers.push(true);

				return Promise.resolve(true);
			},
		});

		// Given on a desktop for the model itself (or before the test switch).
		r.store.grant(QWEN3_1_7B_ID);
		r.releaseProbe();

		const route = await r.service.route("de", "en");

		expect(route?.ref.id).to.equal(QWEN3_1_7B_ID);
		expect(r.asked).to.deep.equal([QWEN3_1_7B_SPLIT_ID]);
		expect(r.store.has(QWEN3_1_7B_SPLIT_ID)).to.equal(true);
		r.service.dispose();
	});

	it("Settings' Download is the yes for the build that downloads here", async () => {
		const r = rig(phone(), {ask: () => Promise.resolve(false)});

		r.releaseProbe();
		await r.service.capabilities();
		await r.service.download(r.service.catalog.llm, "gpu").catch(() => undefined);
		expect(r.store.has(QWEN3_1_7B_SPLIT_ID)).to.equal(true);
		expect(r.store.has(QWEN3_1_7B_ID)).to.equal(false);

		await r.service.remove(r.service.catalog.llm, "gpu");
		expect(r.store.has(QWEN3_1_7B_SPLIT_ID)).to.equal(false);
		r.service.dispose();
	});
});
