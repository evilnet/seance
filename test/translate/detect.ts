import {expect} from "chai";
import {
	CHAT_STRENGTH_MIN,
	DECLARED_MARGIN,
	DETECT_CANDIDATES,
	DETECT_MIN_GAP,
	DETECT_MIN_LENGTH,
	ISO3_OF,
	LanguagePrior,
	type Scores,
	WEAK_CONFIDENCE,
	detectLanguage,
	detectWith,
	detectionSkip,
	iso3ToIso1,
	setDetector,
	sourceFor,
} from "../../client/js/translate/detect";
import {SUPPORTED_LANGUAGES} from "../../client/js/translate/languages";
import {setWordlist, setWordlistLoader, type Wordlist} from "../../client/js/translate/wordlookup";
import rawWordlist from "../../client/js/translate/wordlist.json";

const wordlist = rawWordlist as unknown as Wordlist;

describe("translate/detect", () => {
	afterEach(() => setDetector(null));

	it("maps every supported language to a three-letter code and back", () => {
		for (const code of SUPPORTED_LANGUAGES) {
			expect(ISO3_OF[code], code).to.match(/^[a-z]{3}$/);
			expect(iso3ToIso1(ISO3_OF[code]), code).to.equal(code);
		}

		expect(ISO3_OF.zh).to.equal("cmn");
		expect(iso3ToIso1("zho")).to.equal("zh");
		expect(iso3ToIso1("und")).to.equal(null);
		expect(ISO3_OF.ms).to.equal("zlm");
		expect(iso3ToIso1("zsm")).to.equal("ms");
	});

	it("names the best language with the gap to the runner-up as confidence", () => {
		expect(
			detectWith(
				[
					["deu", 1],
					["nld", 0.6],
					["eng", 0.5],
				],
				null
			)
		).to.deep.equal({lang: "de", confidence: 0.4, candidates: ["de", "nl", "en"]});
	});

	it("names nothing when franc cannot tell or the gap is too small", () => {
		expect(detectWith([["und", 1]], null)).to.deep.equal({
			lang: null,
			confidence: 0,
			candidates: [],
		});
		expect(detectWith([], null)).to.deep.equal({lang: null, confidence: 0, candidates: []});
		expect(
			detectWith(
				[
					["nob", 1],
					["dan", 0.97],
				],
				null
			)
		).to.deep.equal({lang: null, confidence: 0.03, candidates: ["nb", "da"]});
	});

	it("lets the channel's prior settle a near tie", () => {
		expect(
			detectWith(
				[
					["nob", 1],
					["dan", 0.97],
				],
				"da"
			)
		).to.deep.equal({lang: "da", confidence: DETECT_MIN_GAP, candidates: ["nb", "da"]});
		// not a tie: the prior does not override a clear winner
		expect(
			detectWith(
				[
					["deu", 1],
					["dan", 0.5],
				],
				"da"
			).lang
		).to.equal("de");
	});

	it("an unknown best language is undetermined; an unknown runner-up is ignored", () => {
		expect(
			detectWith(
				[
					["xxx", 1],
					["fra", 0.8],
				],
				null
			)
		).to.deep.equal({lang: null, confidence: 0, candidates: ["fr"]});
		expect(
			detectWith(
				[
					["deu", 1],
					["xxx", 0.9],
					["fra", 0.5],
				],
				null
			)
		).to.deep.equal({lang: "de", confidence: 0.5, candidates: ["de", "fr"]});
	});

	it("carries at most DETECT_CANDIDATES known contenders, deduplicated, in franc's order", () => {
		expect(DETECT_CANDIDATES).to.equal(3);
		expect(
			detectWith(
				[
					["deu", 1],
					["nld", 0.9],
					["xxx", 0.8],
					["fra", 0.7],
					["spa", 0.6],
				],
				null
			).candidates
		).to.deep.equal(["de", "nl", "fr"]);
		// Two franc codes, one language: `cmn` and `zho` are both Chinese.
		expect(
			detectWith(
				[
					["cmn", 1],
					["zho", 0.99],
					["jpn", 0.4],
				],
				null
			).candidates
		).to.deep.equal(["zh", "ja"]);
	});

	// The channel's declared languages (channelStore.ts `languages`): what
	// the reader says people write here, weighed above franc's own lead.
	it("a declared language wins over a close undeclared best", () => {
		expect(DECLARED_MARGIN).to.equal(0.25);
		expect(
			detectWith(
				[
					["nld", 1],
					["deu", 0.8],
				],
				null,
				["de"]
			)
		).to.deep.equal({lang: "de", confidence: DETECT_MIN_GAP, candidates: ["de", "nl"]});
		// The margin is the edge, and it is inclusive.
		expect(
			detectWith(
				[
					["nld", 1],
					["deu", 0.75],
				],
				null,
				["de"]
			).lang
		).to.equal("de");
		// Further behind than the margin: franc's best stands.
		expect(
			detectWith(
				[
					["nld", 1],
					["deu", 0.7],
				],
				null,
				["de"]
			).lang
		).to.equal("nl");
		// Franc's best is itself declared and clear: unchanged, real gap.
		expect(
			detectWith(
				[
					["deu", 1],
					["nld", 0.3],
				],
				null,
				["de"]
			)
		).to.deep.equal({lang: "de", confidence: 0.7, candidates: ["de", "nl"]});
	});

	it("two declared contenders resolve by their own gap, then the prior", () => {
		const close: Scores = [
			["deu", 1],
			["nld", 0.95],
			["eng", 0.9],
		];

		// Neither can be separated and no prior names one: the line is left
		// alone rather than translated from a coin toss.
		expect(detectWith(close, null, ["de", "nl"])).to.deep.equal({
			lang: null,
			confidence: 0.05,
			candidates: ["de", "nl", "en"],
		});
		// The prior breaks the tie between the two declared languages.
		expect(detectWith(close, "nl", ["de", "nl"]).lang).to.equal("nl");
		// A prior naming neither of them decides nothing.
		expect(detectWith(close, "en", ["de", "nl"]).lang).to.equal(null);
		// Their own gap is enough: the better declared one wins, and the
		// undeclared language between them does not enter the gap.
		expect(
			detectWith(
				[
					["deu", 1],
					["eng", 0.99],
					["nld", 0.8],
				],
				null,
				["de", "nl"]
			)
		).to.deep.equal({lang: "de", confidence: 0.2, candidates: ["de", "nl", "en"]});
	});

	it("a best franc cannot place is rescued by a declared contender", () => {
		expect(
			detectWith(
				[
					["xxx", 1],
					["deu", 0.6],
				],
				null,
				["de"]
			)
		).to.deep.equal({lang: "de", confidence: DETECT_MIN_GAP, candidates: ["de"]});
		// None of the contenders is declared: undetermined as before.
		expect(
			detectWith(
				[
					["xxx", 1],
					["deu", 0.6],
				],
				null,
				["fr"]
			).lang
		).to.equal(null);
	});

	it("declared contenders lead the candidate list", () => {
		expect(
			detectWith(
				[
					["deu", 1],
					["nld", 0.9],
					["fra", 0.8],
					["spa", 0.7],
				],
				null,
				["es"]
			).candidates
		).to.deep.equal(["es", "de", "nl"]);
	});

	it("declaring nothing, or nothing routable, changes nothing", () => {
		const tie: Scores = [
			["nob", 1],
			["dan", 0.97],
		];

		expect(detectWith(tie, null, [])).to.deep.equal(detectWith(tie, null));
		expect(detectWith(tie, "da", [])).to.deep.equal(detectWith(tie, "da"));
		expect(detectWith(tie, null, ["xx"])).to.deep.equal(detectWith(tie, null));
	});

	it("a short line is placed when one declared language is not the target", async () => {
		setDetector(() => {
			throw new Error("the detector must not run on a line this short");
		});

		// Nine characters: too short for trigrams. One function-word hit on a
		// 3-word line is decisive (chatdetect.ts), so the German verdict
		// returns with the classifier's own confidence ahead of any
		// declared-only placement.
		const soIst = await detectLanguage("So ist es", null, ["de", "en"], {
			exclude: "en",
		});
		expect(soIst.lang).to.equal("de");
		expect(soIst.confidence).to.equal(0.1);
		expect(soIst.candidates[0]).to.equal("de");
		// The chatdetect table is not bound to the declarations: a decisive
		// short-line verdict is returned even with more declared candidates,
		// or none routable at all.
		expect(
			(await detectLanguage("So ist es", null, ["de", "nl", "en"], {exclude: "en"})).lang
		).to.equal("de");
		expect((await detectLanguage("So ist es", null, ["xx"], {exclude: "en"})).lang).to.equal(
			"de"
		);
		const noDeclared = await detectLanguage("So ist es", null);
		expect(noDeclared.lang).to.equal("de");
		expect(noDeclared.candidates[0]).to.equal("de");
	});

	it("the prior is the most frequent language of the recent window", () => {
		const prior = new LanguagePrior(3);

		expect(prior.top()).to.equal(null);
		prior.note("de");
		prior.note("de");
		prior.note("en");
		expect(prior.top()).to.equal("de");
		prior.note("en");
		prior.note("en");
		expect(prior.top()).to.equal("en");
	});

	it("detectLanguage runs the detector on long enough text, with the prior", async () => {
		const calls: string[] = [];

		setDetector((text) => {
			calls.push(text);
			return [
				["deu", 1],
				["eng", 0.3],
			];
		});
		// "lol": no function word, and no language's frequency table lists it
		// either, so neither the classifier nor the lookup has anything to say
		// and franc is never asked ("kurz" would now be placed German by the
		// lookup — see "the short-line lookup" below).
		expect(await detectLanguage("lol", null)).to.deep.equal({
			lang: null,
			confidence: 0,
			candidates: [],
			short: true,
		});
		expect(calls).to.deep.equal([]);

		const prior = new LanguagePrior();

		expect(
			await detectLanguage("Ja, gestern, der Batch-Cooldown greift jetzt.", prior)
		).to.deep.equal({
			lang: "de",
			confidence: 0.7,
			candidates: ["de", "en"],
		});
		expect(calls.length).to.equal(1);
		expect(prior.top()).to.equal("de");
	});

	it("the chat classifier decides a chat-length line franc misplaces", async function () {
		this.timeout(10000);
		setDetector(null);

		// franc places this line in Dutch at 1.0 (chatdetect.ts); the
		// function-word classifier is decisive (strength 2) and returns with
		// the trigram ranking's runners-up riding along as the chip menu's
		// corrections.
		const dutch = await detectLanguage("I just woke up again.", null);
		expect(dutch.lang).to.equal("en");
		expect(dutch.confidence).to.equal(0.2);
		expect(dutch.candidates[0]).to.equal("en");
		expect(dutch.candidates.length).to.be.at.most(3);
	});

	it("a misspelled short line with one function word places via the classifier", async function () {
		this.timeout(10000);
		setDetector(null);

		// "helo their friend" hits "their" — one distinctive hit on a 3-word
		// line is decisive on chatDetect's own terms at 17 characters too, so
		// it places as English instead of deferring to the trigrams that
		// ranked it Scots and left it an unsure skip.
		const helo = await detectLanguage("helo their friend", null);
		expect(helo.lang).to.equal("en");
		expect(helo.confidence).to.equal(0.1);
		expect(helo.candidates[0]).to.equal("en");
	});

	it("the real detector recognises German", async function () {
		this.timeout(10000);
		const result = await detectLanguage("Guten Tag zusammen, wie geht es euch heute?", null);

		expect(result.lang).to.equal("de");
		expect(DETECT_MIN_LENGTH).to.equal(10);
		// The runners-up the chip's menu offers as one-click corrections:
		// German leads, and there is more than one contender to correct to.
		expect(result.candidates[0]).to.equal("de");
		expect(result.candidates.length).to.equal(DETECT_CANDIDATES);
	});

	// F4: one function word on a short line places "je suis la" in Vietnamese
	// and "hasta luego" in Polish. Such a verdict is a hint -- good enough to
	// skip a line that could be the reading language, never good enough to
	// translate *from*.
	describe("a thin verdict is weak", () => {
		it("marks a single-hit classifier verdict weak", async function () {
			this.timeout(10000);
			setDetector(null);

			expect(CHAT_STRENGTH_MIN).to.equal(2);

			const vi = await detectLanguage("je suis là", null);

			expect(vi.lang).to.equal("vi");
			expect(vi.weak).to.equal(true);

			const fr = await detectLanguage("bonjour à tous", null);

			expect(fr.lang).to.equal("fr");
			expect(fr.weak).to.equal(true);

			// A short line the classifier places on one hit is weak too.
			const short = await detectLanguage("helo their friend", null);

			expect(short.lang).to.equal("en");
			expect(short.weak).to.equal(true);
		});

		it("leaves a multi-hit classifier verdict alone", async function () {
			this.timeout(10000);
			setDetector(null);

			const fr = await detectLanguage("Nous allons manger avec les amis ce soir", null);

			expect(fr.lang).to.equal("fr");
			expect(fr.confidence).to.be.at.least(0.2);
			expect(fr.weak).to.equal(undefined);
		});

		it("marks a trigram lead under WEAK_CONFIDENCE weak, and no wider one", () => {
			expect(WEAK_CONFIDENCE).to.equal(0.2);
			expect(
				detectWith(
					[
						["deu", 1],
						["nld", 0.85],
					],
					null
				)
			).to.deep.equal({lang: "de", confidence: 0.15, candidates: ["de", "nl"], weak: true});
			expect(
				detectWith(
					[
						["deu", 1],
						["nld", 0.8],
					],
					null
				).weak
			).to.equal(undefined);
		});

		// The reader's claim, not a measurement: a declared language or the
		// channel's prior placed the line, and `DETECT_MIN_GAP` is what that
		// is written as. Those are not thin trigram leads.
		it("never calls a declared or prior placement weak", () => {
			expect(
				detectWith(
					[
						["nld", 1],
						["deu", 0.8],
					],
					null,
					["de"]
				).weak
			).to.equal(undefined);
			expect(
				detectWith(
					[
						["nob", 1],
						["dan", 0.97],
					],
					"da"
				).weak
			).to.equal(undefined);
		});
	});

	describe("sourceFor", () => {
		const weakVi = {lang: "vi", weak: true, confidence: 0.1, candidates: []};

		it("names no source for a weak verdict, and marks the line unsure", () => {
			expect(sourceFor(weakVi, null, "en")).to.deep.equal({
				source: null,
				unsure: true,
				routeHint: "vi",
			});
		});

		it("names the source of a verdict that is not weak", () => {
			expect(
				sourceFor({lang: "fr", confidence: 0.4, candidates: []}, null, "en")
			).to.deep.equal({source: "fr", unsure: false, routeHint: "fr"});
		});

		it("lets a chosen source win over any verdict", () => {
			expect(sourceFor(weakVi, "es", "en")).to.deep.equal({
				source: "es",
				unsure: false,
				routeHint: "es",
			});
		});

		it("names no source for a line already in the reading language, and is sure of it", () => {
			expect(
				sourceFor({lang: "en", confidence: 0.4, candidates: []}, null, "en")
			).to.deep.equal({source: null, unsure: false, routeHint: null});
		});

		it("marks a line it could not place unsure", () => {
			expect(
				sourceFor({lang: null, confidence: 0, candidates: []}, null, "en")
			).to.deep.equal({
				source: null,
				unsure: true,
				routeHint: null,
			});
		});

		// A weak verdict names no source in the prompt, but a seq2seq route
		// has no other way to know one: without a hint a CPU-only device
		// cannot route the line at all (router.ts), which would leave it
		// untranslated rather than translated from a guess.
		describe("the routing hint", () => {
			it("prefers the channel's prior to a weak verdict", () => {
				expect(sourceFor(weakVi, null, "en", "fr").routeHint).to.equal("fr");
			});

			it("falls back to the weak verdict when there is no prior", () => {
				expect(sourceFor(weakVi, null, "en", null).routeHint).to.equal("vi");
			});

			it("is the source itself when the verdict is not weak", () => {
				expect(
					sourceFor({lang: "fr", confidence: 0.4, candidates: []}, null, "en", "de")
						.routeHint
				).to.equal("fr");
			});

			it("is a chosen source whatever the prior says", () => {
				expect(sourceFor(weakVi, "es", "en", "fr").routeHint).to.equal("es");
			});

			// Nothing was placed at all: the prior announced a Spanish line in
			// a German channel as German, so it is not offered here either.
			it("stays empty for a line the detector could not place", () => {
				expect(
					sourceFor({lang: null, confidence: 0, candidates: []}, null, "en", "de")
						.routeHint
				).to.equal(null);
			});
		});
	});

	describe("detectionSkip", () => {
		it("skips a line placed in the reading language as the same", () => {
			expect(
				detectionSkip({lang: "en", confidence: 0.3, candidates: ["en", "fr"]}, "en")
			).to.equal("same");
		});

		it("translates a line placed in another language", () => {
			expect(
				detectionSkip({lang: "de", confidence: 0.3, candidates: ["de", "en"]}, "en")
			).to.equal(null);
		});

		// franc's measured Spanish/Portuguese/Galician near tie: nothing names
		// English, so the line is translated with its source left to the engine.
		it("translates an unplaced line whose candidates leave the reading language out", () => {
			expect(
				detectionSkip({lang: null, confidence: 0.007, candidates: ["es", "pt", "gl"]}, "en")
			).to.equal(null);
		});

		it("skips an unplaced line that could be the reading language as unsure", () => {
			expect(
				detectionSkip({lang: null, confidence: 0.04, candidates: ["fr", "en", "ca"]}, "en")
			).to.equal("unsure");
		});

		it("skips an unplaced long line with no candidates at all as unsure", () => {
			expect(detectionSkip({lang: null, confidence: 0, candidates: []}, "en")).to.equal(
				"unsure"
			);
		});

		// A one-word line ("Hallo", "lol") carries no function words and is too
		// short for franc — no verdict is not evidence it is already readable.
		// The engine detects the source; an echo lands on the Not-translated chip.
		it("translates a too-short line with no verdict instead of skipping it", () => {
			expect(
				detectionSkip({lang: null, confidence: 0, candidates: [], short: true}, "en")
			).to.equal(null);
		});
	});

	// The short-line lookup (wordlookup.ts): a line of one to three words the
	// function-word classifier cannot place is placed by frequency instead of
	// being left to the engine with no source named.
	describe("the short-line lookup", () => {
		before(() => setWordlist(wordlist));
		after(() => setWordlist(null));

		const never = () => {
			throw new Error("the detector must not run on a line the lookup answers");
		};

		it("places a lone word only one language lists", async () => {
			setDetector(never);

			const test = await detectLanguage("test", null, [], {exclude: "es"});

			expect(test.lang).to.equal("en");
			expect(test.weak).to.equal(undefined);
			expect(test.short).to.equal(undefined);
			expect(test.candidates).to.deep.equal(["en"]);
			// It is a source, not a hint: the line translates *from* English.
			expect(sourceFor(test, null, "es").source).to.equal("en");
			expect((await detectLanguage("Hola", null)).lang).to.equal("es");
		});

		it("never overrules the function-word classifier", async () => {
			setDetector(never);

			// "So ist es" scores in the word list too; the classifier's own
			// verdict is what comes back.
			expect((await detectLanguage("So ist es", null)).lang).to.equal("de");
		});

		it("leaves a word it cannot place short, as before", async () => {
			setDetector(never);

			expect(await detectLanguage("lol", null)).to.deep.equal({
				lang: null,
				confidence: 0,
				candidates: [],
				short: true,
			});
		});

		it("names the contenders of a word it will not choose between", async () => {
			setDetector(never);

			const no = await detectLanguage("no", null);

			expect(no.lang).to.equal(null);
			expect(no.short).to.equal(true);
			expect(no.candidates[0]).to.equal("es");
			// Still translated: short says the line is no evidence of English.
			expect(detectionSkip(no, "en")).to.equal(null);
			// The channel's prior settles it.
			const prior = new LanguagePrior();

			prior.note("es");
			expect((await detectLanguage("no", prior)).lang).to.equal("es");
		});

		it("places a line too long for the lookup's own minimum, before franc", async () => {
			setDetector(never);

			// Eleven characters: franc would be asked, and the lookup answers
			// first because two words are too few for trigrams to be trusted.
			const hasta = await detectLanguage("hasta luego", null);

			expect(hasta.lang).to.equal("es");
			expect(hasta.short).to.equal(undefined);
		});

		it("hands a line it cannot place back to franc when it is long enough", async () => {
			let asked = 0;

			setDetector((text) => {
				asked += 1;
				return [
					["deu", 1],
					["swe", 0.5],
				] as Scores;
			});

			const musik = await detectLanguage("musik video", null);

			expect(asked).to.equal(1);
			expect(musik.lang).to.equal("de");
		});

		it("falls back to the bare short verdict when the table cannot be fetched", async () => {
			// A short line needed no chunk before the lookup existed. Offline,
			// or with the deploy's chunks rotated under an open page, the
			// fetch fails -- and detectLanguage still answers, or the line
			// would never be translated at all (its callers `void` it).
			setDetector(never);
			setWordlistLoader(() => Promise.reject(new Error("chunk gone")));

			expect(await detectLanguage("hola", null)).to.deep.equal({
				lang: null,
				confidence: 0,
				candidates: [],
				short: true,
			});

			setWordlistLoader(null);
			setWordlist(wordlist);
			expect((await detectLanguage("hola", null)).lang).to.equal("es");
		});

		it("leaves the channel's prior untouched", async () => {
			setDetector(never);

			const prior = new LanguagePrior();

			await detectLanguage("test", prior);
			expect(prior.top()).to.equal(null);
		});

		it("a single declared language still places a line the lookup would", async () => {
			setDetector(never);

			// The reader's own claim about the channel outranks a frequency
			// guess: "hola" in a channel declared German, read in English.
			const hola = await detectLanguage("hola", null, ["de", "en"], {exclude: "en"});

			expect(hola.lang).to.equal("de");
		});
	});
});
