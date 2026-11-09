import {expect} from "chai";
import {
	AGREE_MIN,
	ALONE_MIN,
	DETECT_CANDIDATES,
	DETECT_MIN_LENGTH,
	ELD_MISSING,
	LanguagePrior,
	type LidResult,
	decide,
	declaredLanguages,
	detectLanguage,
	detectionSkip,
	scriptLanguage,
	setIdentifier,
	SENDER_OVERRULE_MIN,
	sourceFor,
	withSenderLanguage,
} from "../../client/js/translate/detect";
import {isSupported} from "../../client/js/translate/languages";

/** What the identifiers say, shorthand: fastText's ranking, then ELD. */
const lid = (fast: [string, number][], eld: string | null = null, reliable = false): LidResult => ({
	fast: fast.map(([lang, p]) => ({lang, p})),
	eld: {lang: eld, reliable},
});

describe("translate/detect", () => {
	afterEach(() => setIdentifier(null));

	describe("decide", () => {
		it("places a line both identifiers agree on", () => {
			expect(
				decide(
					lid(
						[
							["de", 0.8],
							["nl", 0.1],
						],
						"de"
					)
				)
			).to.deep.equal({
				lang: "de",
				confidence: 0.8,
				candidates: ["de", "nl"],
			});
		});

		it("asks agreement for no more than AGREE_MIN of fastText", () => {
			expect(decide(lid([["fr", AGREE_MIN]], "fr")).lang).to.equal("fr");
			expect(decide(lid([["fr", AGREE_MIN - 0.01]], "fr")).lang).to.equal(null);
		});

		// "uncanny" and "I know what to do tho" were Polish to the old
		// detector; here neither identifier is sure, so nothing is placed.
		it("leaves alone a line the identifiers disagree on", () => {
			const detection = decide(
				lid(
					[
						["pl", 0.4],
						["en", 0.3],
					],
					"it"
				)
			);

			expect(detection.lang).to.equal(null);
			expect(detection.candidates).to.deep.equal(["pl", "en", "it"]);
		});

		it("takes fastText alone for a language ELD cannot name", () => {
			expect(ELD_MISSING).to.include("id");
			expect(
				decide(
					lid(
						[
							["id", ALONE_MIN],
							["ms", 0.2],
						],
						"ms"
					)
				).lang
			).to.equal("id");
			expect(decide(lid([["id", ALONE_MIN - 0.01]], null)).lang).to.equal(null);
		});

		// "ya" is Swahili to fastText at 0.96: a lone verdict with English
		// in the running is no verdict.
		it("refuses a lone verdict with the reading language among the rivals", () => {
			expect(
				decide(
					lid([
						["sw", 0.96],
						["en", 0.01],
					])
				).lang
			).to.equal(null);
			expect(
				decide(
					lid([
						["sw", 0.96],
						["en", 0.01],
					]),
					"de"
				).lang
			).to.equal("sw");
		});

		it("takes ELD alone where it calls itself reliable and English is no rival", () => {
			const detection = decide(
				lid(
					[
						["it", 0.25],
						["es", 0.2],
					],
					"es",
					true
				)
			);

			expect(detection.lang).to.equal("es");
			expect(detection.confidence).to.equal(0.2);
			expect(
				decide(
					lid(
						[
							["it", 0.25],
							["en", 0.2],
						],
						"es",
						true
					)
				).lang
			).to.equal(null);
			expect(decide(lid([["it", 0.25]], "es", false)).lang).to.equal(null);
		});

		it("gives an ELD verdict fastText did not rank AGREE_MIN", () => {
			expect(decide(lid([["it", 0.25]], "es", true)).confidence).to.equal(AGREE_MIN);
		});

		it("falls back to a declared language either identifier names", () => {
			const result = lid(
				[
					["pl", 0.2],
					["en", 0.2],
				],
				"cs"
			);

			expect(decide(result, "en", ["pl"]).lang).to.equal("pl");
			expect(decide(result, "en", ["cs"]).lang).to.equal("cs");
			expect(decide(result, "en", ["de"]).lang).to.equal(null);
			// The reading language is never a fallback: it is what is read.
			expect(decide(lid([["en", 0.2]]), "en", ["en"]).lang).to.equal(null);
		});

		it("ignores languages the build cannot route", () => {
			expect(isSupported("la")).to.equal(false);
			const detection = decide(
				lid(
					[
						["la", 0.9],
						["it", 0.05],
					],
					"la",
					true
				)
			);

			expect(detection.lang).to.equal(null);
			expect(detection.candidates).to.deep.equal(["it"]);
		});

		it("names at most DETECT_CANDIDATES contenders, the verdict first", () => {
			const detection = decide(
				lid(
					[
						["nl", 0.5],
						["de", 0.2],
						["af", 0.1],
						["da", 0.1],
					],
					"de",
					true
				),
				"fr"
			);

			expect(detection.lang).to.equal("de");
			expect(detection.candidates).to.deep.equal(["de", "nl", "af"]);
			expect(detection.candidates.length).to.equal(DETECT_CANDIDATES);
		});
	});

	describe("scriptLanguage", () => {
		it("places the scripts only one supported language writes", () => {
			expect(scriptLanguage("谢谢")).to.equal("zh");
			expect(scriptLanguage("ありがとう")).to.equal("ja");
			expect(scriptLanguage("誰か直し方を知っていますか")).to.equal("ja");
			expect(scriptLanguage("고마워")).to.equal("ko");
			expect(scriptLanguage("ขอบคุณ")).to.equal("th");
			expect(scriptLanguage("תודה")).to.equal("he");
			expect(scriptLanguage("ευχαριστώ")).to.equal("el");
		});

		it("leaves Latin, Cyrillic and Arabic to the identifiers", () => {
			expect(scriptLanguage("thanks")).to.equal(null);
			expect(scriptLanguage("спасибо")).to.equal(null);
			expect(scriptLanguage("شكرا")).to.equal(null);
			expect(scriptLanguage("1234 :)")).to.equal(null);
		});

		it("settles a line only when most of its letters are in the script", () => {
			expect(scriptLanguage("the variable λ is unset")).to.equal(null);
			expect(scriptLanguage("see 東京 on the map")).to.equal(null);
			expect(scriptLanguage("ok ありがとう")).to.equal("ja");
			expect(scriptLanguage("Seanceのバグを直した")).to.equal("ja");
		});
	});

	it("keeps the declared languages the build can route, once each", () => {
		expect(declaredLanguages(["pl", "xx", "pl", "en"])).to.deep.equal(["pl", "en"]);
	});

	describe("detectionSkip", () => {
		it("skips a line in the reading language and one nobody placed", () => {
			expect(detectionSkip({lang: "en", confidence: 0.9, candidates: []}, "en")).to.equal(
				"same"
			);
			expect(detectionSkip({lang: null, confidence: 0, candidates: ["pl"]}, "en")).to.equal(
				"unsure"
			);
			expect(detectionSkip({lang: "fr", confidence: 0.9, candidates: []}, "en")).to.equal(
				null
			);
		});
	});

	describe("withSenderLanguage (+draft/language)", () => {
		it("places a line the detector could not, as the sender's language", () => {
			const unplaced = {lang: null, confidence: 0, candidates: ["nl", "en"]};

			expect(withSenderLanguage(unplaced, "en")).to.deep.equal({
				lang: "en",
				confidence: AGREE_MIN,
				candidates: ["en", "nl"],
			});
		});

		it("takes a weak verdict for another language as the sender's", () => {
			const weak = {lang: "nl", confidence: 0.5, candidates: ["nl", "de", "en"]};

			expect(withSenderLanguage(weak, "en")).to.deep.equal({
				lang: "en",
				confidence: AGREE_MIN,
				candidates: ["en", "nl", "de"],
			});
		});

		it("keeps an agreeing verdict as it is", () => {
			const agrees = {lang: "es", confidence: 0.8, candidates: ["es", "pt"]};

			expect(withSenderLanguage(agrees, "es")).to.deep.equal(agrees);
		});

		it("loses to a verdict close to certain, and stays on the menu", () => {
			const sure = {
				lang: "ru",
				confidence: SENDER_OVERRULE_MIN,
				candidates: ["ru", "uk", "bg"],
			};
			const script = {lang: "zh", confidence: 1, candidates: ["zh"]};

			expect(withSenderLanguage(sure, "en")).to.deep.equal({
				lang: "ru",
				confidence: SENDER_OVERRULE_MIN,
				candidates: ["ru", "en", "uk"],
			});
			expect(withSenderLanguage(script, "en").lang).to.equal("zh");
		});

		it("changes nothing without a supported sender language", () => {
			const any = {lang: "fr", confidence: 0.4, candidates: ["fr"]};

			expect(withSenderLanguage(any, undefined)).to.equal(any);
			expect(withSenderLanguage(any, "tlh")).to.equal(any);
		});

		it("makes a tagged line in the reader's language a skip, not a polish", () => {
			const tagged = withSenderLanguage({lang: null, confidence: 0, candidates: []}, "en");

			expect(detectionSkip(tagged, "en")).to.equal("same");
			expect(detectionSkip(tagged, "de")).to.equal(null);
		});
	});

	describe("sourceFor", () => {
		const fr = {lang: "fr", confidence: 0.4, candidates: []};
		const none = {lang: null, confidence: 0, candidates: []};

		it("names the detected source", () => {
			expect(sourceFor(fr, null, "en")).to.deep.equal({
				source: "fr",
				unsure: false,
				routeHint: "fr",
			});
		});

		it("lets a chosen source win, even the reading language", () => {
			expect(sourceFor(fr, "es", "en", "de")).to.deep.equal({
				source: "es",
				unsure: false,
				routeHint: "es",
			});
			expect(sourceFor(fr, "en", "en").source).to.equal("en");
		});

		it("marks a line nobody placed unsure", () => {
			expect(sourceFor(none, null, "en", "fr")).to.deep.equal({
				source: null,
				unsure: true,
				routeHint: null,
			});
		});

		it("names no source for a line in the reading language, routing by the prior", () => {
			expect(
				sourceFor({lang: "en", confidence: 0.9, candidates: []}, null, "en", "de")
			).to.deep.equal({source: null, unsure: false, routeHint: "de"});
		});
	});

	it("learns a channel's dominant language over a window", () => {
		const prior = new LanguagePrior(3);

		expect(prior.top()).to.equal(null);
		prior.note("de");
		prior.note("fr");
		prior.note("fr");
		expect(prior.top()).to.equal("fr");
		prior.note("de");
		prior.note("de");
		expect(prior.top()).to.equal("de");
	});

	describe("detectLanguage", () => {
		const long = "Guten Morgen zusammen";

		it("places a line by its script without asking the identifiers", async () => {
			let asked = 0;
			setIdentifier(() => {
				asked++;
				return Promise.resolve(lid([]));
			});

			expect(await detectLanguage("谢谢", null)).to.deep.equal({
				lang: "zh",
				confidence: 1,
				candidates: ["zh"],
			});
			expect(asked).to.equal(0);
		});

		it("passes the reading language and the declared ones to the rule", async () => {
			setIdentifier(() =>
				Promise.resolve(
					lid(
						[
							["sw", 0.96],
							["de", 0.01],
						],
						"de"
					)
				)
			);

			expect((await detectLanguage("ya", null)).lang).to.equal("sw");
			expect((await detectLanguage("ya", null, [], {exclude: "de"})).lang).to.equal(null);

			setIdentifier(() => Promise.resolve(lid([["pl", 0.2]])));
			expect((await detectLanguage("tak", null, ["pl"])).lang).to.equal("pl");
		});

		it("teaches the prior placed lines long enough, not the user's own", async () => {
			setIdentifier(() => Promise.resolve(lid([["de", 0.9]], "de")));
			const prior = new LanguagePrior();

			await detectLanguage("ja", prior);
			expect(prior.top()).to.equal(null);
			expect("ja".length).to.be.below(DETECT_MIN_LENGTH);

			await detectLanguage(long, prior, [], {learn: false});
			expect(prior.top()).to.equal(null);

			await detectLanguage(long, prior);
			expect(prior.top()).to.equal("de");
		});

		it("teaches the prior nothing from a line it could not place", async () => {
			setIdentifier(() => Promise.resolve(lid([["pl", 0.4]], "en")));
			const prior = new LanguagePrior();

			await detectLanguage("I know what to do tho", prior);
			expect(prior.top()).to.equal(null);
		});
	});
});
