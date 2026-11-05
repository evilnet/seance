import {expect} from "chai";
import {chatDetect} from "../../client/js/translate/chatdetect";
import stopwords from "../../client/js/translate/stopwords.json";

// Not in the test project's file list, so it resolves as `any` there.
const TABLES = stopwords as Record<string, string[]>;
const TABLE_LANGS = Object.keys(TABLES);

describe("translate/chatdetect", () => {
	describe("table", () => {
		it("covers the supported languages with clean tables", () => {
			expect(TABLE_LANGS.length).to.be.at.least(45);

			for (const words of TABLE_LANGS.map((t) => TABLES[t])) {
				expect(words.length).to.be.within(10, 60);
				expect(new Set(words).size).to.equal(words.length);
			}
		});
	});

	it("places the measured chat lines franc gets wrong", () => {
		expect(chatDetect("I just woke up again.", ["en", "de", "nl"]).lang).to.equal("en");
		expect(chatDetect("helo their friend", ["en", "de"]).lang).to.equal("en");
	});

	it("hands chat content to the fall-through", () => {
		// Chat-frequency words no function-word table carries: franc places
		// these and the engine echo covers the miss — not this classifier's job.
		expect(chatDetect("good morning", ["en", "sv", "da"]).lang).to.equal(null);
		expect(chatDetect("lol", ["en", "de"]).lang).to.equal(null);
	});

	it("places German chat on its function words", () => {
		expect(chatDetect("ich bin es nur", ["en", "de"]).lang).to.equal("de");
	});

	it("is substring-based for scripts without spaces", () => {
		expect(chatDetect("おはよう、まだ眠い。", ["ja", "en"]).lang).to.equal("ja");
		expect(chatDetect("我醒了。", ["zh", "en"]).lang).to.equal("zh");
	});

	it("refuses to guess on noise", () => {
		expect(chatDetect("xyzzy", ["en", "de"]).lang).to.equal(null);
		expect(chatDetect("...", ["en", "de"]).lang).to.equal(null);
	});

	it("restricts its verdict to the allowed candidates", () => {
		expect(chatDetect("I just woke up again.", ["de", "nl"]).lang).to.not.equal("en");
	});
});
