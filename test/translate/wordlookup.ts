import {expect} from "chai";
import {LanguagePrior} from "../../client/js/translate/detect";
import {
	LOOKUP_LEAD,
	LOOKUP_MAX_WORDS,
	lookupShortLine,
	setWordlist,
	setWordlistLoader,
	type Wordlist,
} from "../../client/js/translate/wordlookup";
// The JSON import widens the `[tag, rank]` tuples, hence the cast.
import rawTable from "../../client/js/translate/wordlist.json";

const table = rawTable as unknown as Wordlist;

const prior = (...langs: string[]) => {
	const p = new LanguagePrior();

	for (const lang of langs) {
		p.note(lang);
	}

	return p;
};

describe("translate/wordlookup", () => {
	// The committed table is the table: the lookup is only as good as what
	// the generator put in it, so the tests read the real thing rather than a
	// fixture. The dynamic import is webpack's concern (its own chunk); mocha
	// injects.
	before(() => setWordlist(table));
	after(() => setWordlist(null));

	it("places a word only one language lists", async () => {
		const test = await lookupShortLine(["test"], null);

		expect(test).to.not.equal(null);
		expect(test!.lang).to.equal("en");
		expect(test!.candidates).to.deep.equal(["en"]);
		expect(test!.weak).to.equal(undefined);
		expect(test!.short).to.equal(undefined);
		expect(test!.confidence).to.be.greaterThan(0).and.at.most(1);

		expect((await lookupShortLine(["hola"], null))!.lang).to.equal("es");
		expect((await lookupShortLine(["danke"], null))!.lang).to.equal("de");
		expect((await lookupShortLine(["gracias"], null))!.lang).to.equal("es");
		expect((await lookupShortLine(["merci"], null))!.lang).to.equal("fr");
	});

	it("has no opinion on a word no language lists", async () => {
		expect(await lookupShortLine(["zzqqxx"], null)).to.equal(null);
		expect(await lookupShortLine(["lol"], null)).to.equal(null);
	});

	it("has no opinion on nothing, or on more than three words", async () => {
		expect(await lookupShortLine([], null)).to.equal(null);
		expect(
			await lookupShortLine(
				["hola", "muy", "bien", "gracias"].slice(0, LOOKUP_MAX_WORDS + 1),
				null
			)
		).to.equal(null);
	});

	it("leaves an ambiguous word unplaced, with its contenders named", async () => {
		const no = await lookupShortLine(["no"], null);

		expect(no).to.not.equal(null);
		expect(no!.lang).to.equal(null);
		expect(no!.short).to.equal(true);
		// Ranked by score: Spanish leads Portuguese, both ahead of English.
		expect(no!.candidates.slice(0, 3)).to.deep.equal(["es", "pt", "en"]);
	});

	it("lets the channel's prior settle an ambiguous word", async () => {
		const no = await lookupShortLine(["no"], prior("es", "es", "de"));

		expect(no!.lang).to.equal("es");
		expect(no!.weak).to.equal(undefined);
		expect(no!.candidates[0]).to.equal("es");
	});

	it("ignores a prior naming a language the word does not belong to", async () => {
		const no = await lookupShortLine(["no"], prior("tr", "tr"));

		expect(no!.lang).to.equal(null);
		expect(no!.short).to.equal(true);
	});

	it("places a leader that is LOOKUP_LEAD ahead of the runner-up", async () => {
		const hasta = await lookupShortLine(["hasta", "luego"], null);

		expect(hasta!.lang).to.equal("es");
		expect(hasta!.candidates[0]).to.equal("es");

		// Two words summed, but not far enough ahead: Spanish leads French by
		// 1.8x here, under LOOKUP_LEAD, so the engine is left to place it.
		const muyBien = await lookupShortLine(["muy", "bien"], null);

		expect(LOOKUP_LEAD).to.be.greaterThan(1.9);
		expect(muyBien!.lang).to.equal(null);
		expect(muyBien!.candidates.slice(0, 2)).to.deep.equal(["es", "fr"]);
		expect((await lookupShortLine(["muy", "bien"], prior("es")))!.lang).to.equal("es");
	});

	it("places the reading language like any other candidate", async () => {
		// `exclude` is the language the reader already reads. A line placed in
		// it is placed all the same: detectionSkip then skips it as "same",
		// which is the right answer for a lone "hola" read in Spanish.
		const hola = await lookupShortLine(["hola"], null, "es");

		expect(hola!.lang).to.equal("es");

		const test = await lookupShortLine(["test"], null, "en");

		expect(test!.lang).to.equal("en");
	});

	it("lets a runaway leader win before the prior is asked", async () => {
		// "the" is English rank 1 (score 1.0) and Spanish rank 301 (0.0033):
		// a 300x lead is not a tie for the channel to settle, or a lone "the"
		// in a Spanish channel would be translated from Spanish.
		expect((await lookupShortLine(["the"], prior("es", "es")))!.lang).to.equal("en");
		// Where nothing leads, the prior still decides.
		expect((await lookupShortLine(["no"], prior("es", "es")))!.lang).to.equal("es");
	});

	it("does not fetch the table for a line that cannot match it", async () => {
		setWordlistLoader(() => {
			throw new Error("the table must not be fetched for this line");
		});

		// A Japanese sentence is one token (tokens() splits on spaces), longer
		// than any space-free language's longest entry, so it can match
		// nothing; punctuation carries no letter at all.
		expect(await lookupShortLine(["こんにちは元気ですか今日はいい天気ですね"], null)).to.equal(
			null
		);
		expect(await lookupShortLine(["!!!"], null)).to.equal(null);
		expect(await lookupShortLine(["123"], null)).to.equal(null);

		setWordlistLoader(null);
		setWordlist(table);
		// A lone word in one of those scripts is still looked up.
		expect((await lookupShortLine(["ありがとう"], null))!.lang).to.equal("ja");
	});

	it("is case-insensitive", async () => {
		expect((await lookupShortLine(["Danke"], null))!.lang).to.equal("de");
		expect((await lookupShortLine(["HOLA"], null))!.lang).to.equal("es");
	});
});
