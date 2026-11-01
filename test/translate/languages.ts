import {expect} from "chai";
import {
	SUPPORTED_LANGUAGES,
	browserLanguage,
	fromLocaleTag,
	isSupported,
	languageEndonym,
	languageName,
	nllbCode,
} from "../../client/js/translate/languages";

describe("translate/languages", () => {
	it("names a language in full, in the asked-for locale", () => {
		expect(languageName("de")).to.equal("German");
		expect(languageName("de", "de")).to.equal("Deutsch");
		expect(languageName("pt-BR")).to.equal("Brazilian Portuguese");
	});

	it("falls back to the bundled English table, then to the code", () => {
		expect(languageName("de", "zz-not-a-locale")).to.equal("German");
		expect(languageName("xx")).to.equal("xx");
	});

	it("maps an interface locale tag to a supported reading language", () => {
		expect(fromLocaleTag("de")).to.equal("de");
		expect(fromLocaleTag("pt-PT")).to.equal("pt");
		// The interface roadmap names Tagalog by its BCP-47 tag; the
		// translation engines know it as tl.
		expect(fromLocaleTag("fil")).to.equal("tl");
		expect(fromLocaleTag("sv")).to.equal("sv");
		// The dev-only qqx rig is not a language anyone translates into.
		expect(fromLocaleTag("qqx")).to.equal("en");
		expect(fromLocaleTag("xx-not-a-language")).to.equal("en");
	});

	it("maps the browser language to a supported code", () => {
		expect(browserLanguage("de-AT")).to.equal("de");
		expect(browserLanguage("pt-BR")).to.equal("pt");
		expect(browserLanguage("nb-NO")).to.equal("nb");
		expect(browserLanguage("tlh")).to.equal("en");
		expect(browserLanguage(undefined)).to.equal("en");
		// zh is Simplified: a Traditional reader gets English, as the
		// interface's automatic choice gives them.
		expect(browserLanguage("zh-CN")).to.equal("zh");
		expect(browserLanguage("zh")).to.equal("zh");
		expect(browserLanguage("zh-Hans-TW")).to.equal("zh");
		expect(browserLanguage("zh-TW")).to.equal("en");
		expect(browserLanguage("zh-HK")).to.equal("en");
		expect(browserLanguage("zh-Hant")).to.equal("en");
		expect(browserLanguage("pt-PT")).to.equal("pt");
	});

	it("knows the NLLB (FLORES-200) code for every supported language", () => {
		for (const code of SUPPORTED_LANGUAGES) {
			expect(nllbCode(code), code).to.match(/^[a-z]{3}_[A-Z][a-z]{3}$/);
		}

		expect(nllbCode("de")).to.equal("deu_Latn");
		expect(nllbCode("zh")).to.equal("zho_Hans");
		expect(nllbCode("xx")).to.equal(null);
	});

	it("names a language in itself", () => {
		expect(languageEndonym("de")).to.equal("Deutsch");
		expect(languageEndonym("ja")).to.equal("日本語");
		expect(languageEndonym("en")).to.equal("English");
	});

	it("falls back without throwing for a made-up code", () => {
		expect(() => languageEndonym("xx")).to.not.throw();
		expect(languageEndonym("xx")).to.equal("xx");
	});

	it("isSupported is the list membership", () => {
		expect(isSupported("en")).to.equal(true);
		expect(isSupported("xx")).to.equal(false);
	});
});
