import {expect} from "chai";
import {DEFAULT_OPUS_PAIRS, QWEN3_1_7B_ID, QWEN3_4B_ID} from "../../client/js/translate/models";
import {classesOf} from "../../client/js/translate/router";
import {
	DEFAULT_ROUTES,
	LIMITED_LANGUAGES,
	NLLB_FIRST,
	NLLB_TIED,
	OPUS_TIED,
	QWEN3_1_7B,
	QWEN3_4B,
	QWEN3_4B_LIMITED_LANGUAGES,
	QWEN3_4B_NLLB_FIRST,
	QWEN3_4B_NLLB_TIED,
	QWEN3_4B_OPUS_TIED,
	buildRoutes,
	isLimitedLanguage,
	limitedLanguagesFor,
	placementFor,
	routesFor,
} from "../../client/js/translate/routes.default";

describe("translate/routes.default", () => {
	// OPUS-MT (Apache-2.0 code, CC-BY weights) before NLLB-200 (CC-BY-NC-4.0)
	// wherever a pair exists, in either model's table: NLLB is only ever the
	// class after the pair's own model.
	it("puts an OPUS-MT pair ahead of NLLB-200 wherever the pair exists", () => {
		for (const id of [QWEN3_1_7B_ID, QWEN3_4B_ID]) {
			const table = routesFor(id);

			for (const pair of Object.keys(DEFAULT_OPUS_PAIRS)) {
				const [from, to] = pair.split("-");
				const classes = classesOf(table[to][from]);
				const opus = classes.findIndex((group) => group.includes(`opus:${pair}`));
				const nllb = classes.findIndex((group) => group.includes("nllb"));

				expect(opus, `${id} ${pair}`).to.be.at.least(0);
				expect(nllb, `${id} ${pair}`).to.be.greaterThan(opus);
			}
		}
	});

	it("routesFor gives each GPU model its table, 1.7B's for any other id", () => {
		expect(routesFor(QWEN3_1_7B_ID)).to.equal(DEFAULT_ROUTES);
		expect(routesFor("gemma-3-1b-it-q4f16_1-MLC")).to.equal(DEFAULT_ROUTES);
		expect(routesFor(null)).to.equal(DEFAULT_ROUTES);
		expect(routesFor(QWEN3_4B_ID)).to.not.equal(DEFAULT_ROUTES);
		expect(routesFor(QWEN3_4B_ID)).to.equal(routesFor(QWEN3_4B_ID));
	});

	it("1.7B's placements are the exported lists", () => {
		expect(placementFor(QWEN3_1_7B_ID)).to.equal(QWEN3_1_7B);
		expect(QWEN3_1_7B.nllbFirst).to.equal(NLLB_FIRST);
		expect(QWEN3_1_7B.nllbTied).to.equal(NLLB_TIED);
		expect(QWEN3_1_7B.opusTied).to.equal(OPUS_TIED);
		expect(QWEN3_1_7B.limited).to.equal(LIMITED_LANGUAGES);
	});

	it("4B has lists of its own", () => {
		expect(placementFor(QWEN3_4B_ID)).to.equal(QWEN3_4B);
		expect(QWEN3_4B.nllbFirst).to.equal(QWEN3_4B_NLLB_FIRST).and.not.equal(NLLB_FIRST);
		expect(QWEN3_4B.nllbTied).to.equal(QWEN3_4B_NLLB_TIED).and.not.equal(NLLB_TIED);
		expect(QWEN3_4B.opusTied).to.equal(QWEN3_4B_OPUS_TIED).and.not.equal(OPUS_TIED);
		expect(QWEN3_4B.limited)
			.to.equal(QWEN3_4B_LIMITED_LANGUAGES)
			.and.not.equal(LIMITED_LANGUAGES);
	});

	// Each model placed from its own web weights (2026-09-13-web-weights.md):
	// 4B leads NLLB outright where 1.7B trailed it, and fewer languages are
	// limited.
	it("4B's table differs from 1.7B's where 4B measured differently", () => {
		const small = routesFor(QWEN3_1_7B_ID);
		const large = routesFor(QWEN3_4B_ID);

		expect(small).to.not.deep.equal(large);

		// Hungarian and Hindi: NLLB first for 1.7B, the LLM first for 4B.
		for (const code of ["hu", "hi"]) {
			expect(NLLB_FIRST, code).to.include(code);
			expect(QWEN3_4B_NLLB_FIRST, code).to.not.include(code);
			expect(QWEN3_4B_NLLB_TIED, code).to.not.include(code);
		}

		// Irish: the LLM first for 1.7B, NLLB first for 4B.
		expect(NLLB_FIRST).to.not.include("ga");
		expect(QWEN3_4B_NLLB_FIRST).to.include("ga");
		// French: tied with OPUS-MT for 1.7B, the LLM ahead for 4B.
		expect(OPUS_TIED).to.include("fr");
		expect(QWEN3_4B_OPUS_TIED).to.not.include("fr");
		expect(QWEN3_4B_LIMITED_LANGUAGES).to.deep.equal([]);
		// Arabic stays LLM-first for both, by ruling.
		expect([...NLLB_FIRST, ...QWEN3_4B_NLLB_FIRST, ...QWEN3_4B_NLLB_TIED]).to.not.include("ar");
	});

	it("a table follows its placement lists", () => {
		const table = buildRoutes({
			nllbFirst: ["fi"],
			nllbTied: [],
			opusTied: [],
			limited: [],
		});

		expect(table["*"].fi).to.deep.equal(["nllb", "llm"]);
		expect(table["*"].sr).to.equal(undefined);
		// de-en is an OPUS pair not tied in this placement: the LLM, then OPUS.
		expect(table.en.de).to.deep.equal(["llm", "opus:de-en", "nllb"]);
	});

	it("the limited languages are per model", () => {
		expect(limitedLanguagesFor(QWEN3_1_7B_ID)).to.equal(LIMITED_LANGUAGES);
		expect(limitedLanguagesFor(QWEN3_4B_ID)).to.equal(QWEN3_4B_LIMITED_LANGUAGES);
		expect(limitedLanguagesFor("gemma-3-1b-it-q4f16_1-MLC")).to.equal(LIMITED_LANGUAGES);
		expect(isLimitedLanguage("ko", QWEN3_4B_ID)).to.equal(false);
		expect(isLimitedLanguage("ko")).to.equal(true);
		expect(isLimitedLanguage("hu", QWEN3_4B_ID)).to.equal(false);
		expect(isLimitedLanguage("hu")).to.equal(true);
		expect(isLimitedLanguage(null, QWEN3_4B_ID)).to.equal(false);
	});
});
