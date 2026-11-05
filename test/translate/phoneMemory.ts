// A phone's page memory (docs/resources/translation.md § Phones and small
// GPUs): which devices are phones or tablets, the window the GPU model gets
// there, and the 4B that no phone's page can hold — one rule for Settings'
// row, the GPU select, the default and the router.

import {expect} from "chai";
import {isMobile, type Capability} from "../../client/js/translate/capability";
import {
	DEFAULT_CONTEXT_WINDOW,
	MOBILE_CONTEXT_WINDOW,
	QWEN3_1_7B_ID,
	QWEN3_4B_ID,
	buildCatalog,
	contextWindowFor,
	defaultLlmForAdapter,
	llmChoice,
	llmRunsOn,
	modelBlock,
	tooLargeForPhone,
	type DeviceChoices,
} from "../../client/js/translate/models";
import {explainRoute, routeInput} from "../../client/js/translate/router";
import {routesFor} from "../../client/js/translate/routes.default";

const AUTO: DeviceChoices = {llm: "auto", opus: "auto", nllb: "auto"};

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;
const all = {llm: true, opus: true, nllb: true};

function device(overrides: Partial<Capability> = {}): Capability {
	return {
		tier: "gpu",
		reasons: [],
		f16: true,
		maxBufferBytes: 2 * GiB,
		deviceMemoryGiB: 8,
		storageQuotaBytes: null,
		mobile: true,
		...overrides,
	};
}

const UA = {
	iPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
	iPadDesktop:
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
	iPadMobile:
		"Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
	chromeIos:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
	androidPhone:
		"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
	androidTablet:
		"Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	firefoxAndroid: "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
	mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	windows:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

describe("translate: a phone's page memory", () => {
	describe("isMobile", () => {
		it("is a phone or tablet on iOS, iPadOS and Android, whatever the browser", () => {
			expect(isMobile({userAgent: UA.iPhone, maxTouchPoints: 5})).to.equal(true);
			expect(isMobile({userAgent: UA.iPadMobile, maxTouchPoints: 5})).to.equal(true);
			expect(isMobile({userAgent: UA.chromeIos, maxTouchPoints: 5})).to.equal(true);
			expect(isMobile({userAgent: UA.firefoxAndroid, maxTouchPoints: 5})).to.equal(true);
			expect(
				isMobile({
					userAgent: UA.androidPhone,
					maxTouchPoints: 5,
					userAgentData: {mobile: true},
				})
			).to.equal(true);
		});

		it("is a tablet on an Android tablet, whose Chrome says mobile: false", () => {
			expect(
				isMobile({
					userAgent: UA.androidTablet,
					maxTouchPoints: 10,
					userAgentData: {mobile: false},
				})
			).to.equal(true);
		});

		it("is an iPad asking for desktop sites: a Mac with a touch screen", () => {
			expect(isMobile({userAgent: UA.iPadDesktop, maxTouchPoints: 5})).to.equal(true);
		});

		it("is a computer on a Mac, a Windows or Linux machine, a touch laptop included", () => {
			expect(isMobile({userAgent: UA.iPadDesktop, maxTouchPoints: 0})).to.equal(false);
			expect(isMobile({userAgent: UA.mac, maxTouchPoints: 0})).to.equal(false);
			expect(isMobile({userAgent: UA.mac})).to.equal(false);
			expect(
				isMobile({
					userAgent: UA.windows,
					maxTouchPoints: 10,
					userAgentData: {mobile: false},
				})
			).to.equal(false);
			expect(isMobile({userAgent: UA.linux, maxTouchPoints: 0})).to.equal(false);
			expect(isMobile({})).to.equal(false);
		});
	});

	describe("the context window", () => {
		it("is MOBILE_CONTEXT_WINDOW on a phone, the record's own elsewhere", () => {
			expect(MOBILE_CONTEXT_WINDOW).to.equal(2048);
			expect(DEFAULT_CONTEXT_WINDOW).to.equal(4096);
			expect(
				contextWindowFor({maxBufferBytes: 128 * MiB, capBytes: null, mobile: true})
			).to.equal(MOBILE_CONTEXT_WINDOW);
			expect(contextWindowFor({maxBufferBytes: 2 * GiB, capBytes: null})).to.equal(null);
			expect(contextWindowFor(null)).to.equal(null);
			expect(contextWindowFor(undefined)).to.equal(null);
		});
	});

	describe("the 4B on a phone", () => {
		const catalog = buildCatalog();
		const small = catalog.llmChoices.find((ref) => ref.id === QWEN3_1_7B_ID)!;
		const large = catalog.llmChoices.find((ref) => ref.id === QWEN3_4B_ID)!;

		it("is too large for a phone's page; the 1.7B is not", () => {
			expect(tooLargeForPhone(large)).to.equal(true);
			expect(tooLargeForPhone(small)).to.equal(false);
			expect(tooLargeForPhone(catalog.nllb)).to.equal(false);
		});

		it("is a memory block on a phone, whatever the GPU binds and the switch says", () => {
			expect(modelBlock(large, "gpu", device(), all)).to.deep.equal({
				kind: "memory",
				needed: large.vramBytes,
			});
			expect(modelBlock(large, "gpu", device(), {...all, llm: false})).to.deep.include({
				kind: "memory",
			});
			expect(modelBlock(small, "gpu", device(), all)).to.equal(null);
		});

		it("runs on a computer", () => {
			expect(modelBlock(large, "gpu", device({mobile: false}), all)).to.equal(null);
		});

		it("names the device's own reason first: no GPU is no GPU", () => {
			expect(
				modelBlock(large, "gpu", device({tier: "cpu", reasons: ["NO_F16"]}), all)
			).to.deep.equal({kind: "device", reason: "NO_F16"});
		});

		it("is never the default on a phone, nor what an explicit choice of it runs", () => {
			const phone = device({deviceMemoryGiB: 16});

			expect(llmRunsOn(large, phone)).to.equal(false);
			expect(llmRunsOn(small, phone)).to.equal(true);
			expect(defaultLlmForAdapter(phone)).to.equal(QWEN3_1_7B_ID);
			expect(llmChoice(catalog, QWEN3_4B_ID, phone).id).to.equal(QWEN3_1_7B_ID);
			// A computer runs what was chosen.
			expect(llmChoice(catalog, QWEN3_4B_ID, device({mobile: false})).id).to.equal(
				QWEN3_4B_ID
			);
		});

		it("is not what a deploy that ships the 4B runs on a phone", () => {
			const deploy = buildCatalog({llm: {model: QWEN3_4B_ID}});

			expect(llmChoice(deploy, "", device()).id).to.equal(QWEN3_1_7B_ID);
			expect(llmChoice(deploy, "", device({mobile: false})).id).to.equal(QWEN3_4B_ID);
			// While the probe runs, the deploy's model stands.
			expect(llmChoice(deploy, "", null).id).to.equal(QWEN3_4B_ID);
		});

		it("is the router's reason too: a route through the 4B on a phone says memory", () => {
			const deploy = buildCatalog({llm: {model: QWEN3_4B_ID}});
			const table = routesFor(QWEN3_4B_ID);
			const verdict = explainRoute(table, deploy, {
				...routeInput(device(), all, AUTO, {from: "de", to: "en"}),
				cached: () => true,
			});

			// The 4B is the deploy's catalog.llm here (no probe resolved it
			// away): the LLM candidate is blocked by memory, and the route
			// falls through to a CPU model.
			expect(deploy.llm.id).to.equal(QWEN3_4B_ID);
			expect(verdict.route?.ref.engine).to.equal("seq2seq");

			const llmOnly = explainRoute({en: {de: ["llm"]}}, deploy, {
				...routeInput(device(), all, AUTO, {from: "de", to: "en"}),
				cached: () => true,
			});

			expect(llmOnly.route).to.equal(null);
			expect(llmOnly.route === null && llmOnly.why).to.deep.include({kind: "memory"});
		});
	});
});
