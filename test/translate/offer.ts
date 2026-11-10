import {expect} from "chai";
import {
	type OfferInput,
	type OfferMessage,
	QUERY_LINES,
	composerOffer,
	lineLanguage,
	queryOffer,
	replyOffer,
} from "../../client/js/translate/offer";

const languages = {reading: "en", alsoRead: ["fr"], routes: () => true};
const line = (id: number, extra: Partial<OfferMessage> = {}): OfferMessage => ({
	id,
	type: "message",
	text: `line ${id}`,
	...extra,
});
const done = (from: string) => ({status: "done", from});

describe("translate/offer", () => {
	describe("lineLanguage", () => {
		it("goes by the reader's verdict", () => {
			expect(lineLanguage(line(1), done("pt"))).to.equal("pt");
			expect(lineLanguage(line(1), {status: "skipped", reason: "same", from: "en"})).to.equal(
				"en"
			);
		});

		it("an unplaced line names nothing", () => {
			expect(lineLanguage(line(1), {status: "skipped", reason: "unsure", from: ""})).to.equal(
				null
			);
			expect(lineLanguage(line(1), done(""))).to.equal(null);
		});

		it("a machine-translated line names nothing, whatever its tag", () => {
			expect(
				lineLanguage(line(1, {language: "en", machineTranslated: true}), done("en"))
			).to.equal(null);
		});

		it("falls back on the sender's tag where nothing read the line", () => {
			expect(lineLanguage(line(1, {language: "pl"}), undefined)).to.equal("pl");
			expect(lineLanguage(line(1), undefined)).to.equal(null);
		});
	});

	describe("replyOffer", () => {
		it("offers the parent's language", () => {
			expect(replyOffer(line(1), done("pt"), languages)).to.equal("pt");
		});

		it("not for the user's own line", () => {
			expect(replyOffer(line(1, {self: true}), done("pt"), languages)).to.equal(null);
		});

		it("not for a language the user reads or also reads, regional forms included", () => {
			expect(replyOffer(line(1), done("en"), languages)).to.equal(null);
			expect(replyOffer(line(1), done("fr"), languages)).to.equal(null);
			expect(replyOffer(line(1), done("fr-CA"), languages)).to.equal(null);
		});

		it("not where the device cannot write it", () => {
			expect(
				replyOffer(line(1), done("pt"), {...languages, routes: (to) => to !== "pt"})
			).to.equal(null);
		});

		it("not for a machine-translated, redacted or non-prose parent", () => {
			expect(replyOffer(line(1, {machineTranslated: true}), done("pt"), languages)).to.equal(
				null
			);
			expect(replyOffer(line(1, {redacted: {}}), done("pt"), languages)).to.equal(null);
			expect(replyOffer(line(1, {type: "notice"}), done("pt"), languages)).to.equal(null);
		});
	});

	describe("queryOffer", () => {
		it("offers the other person's newest placed language", () => {
			const messages = [line(1), line(2), line(3)];

			expect(
				queryOffer(messages, {1: done("pl"), 2: done("pl"), 3: done("pl")}, languages)
			).to.equal("pl");
		});

		it("passes over the user's own lines, unplaced, pending and superseded ones", () => {
			const messages = [
				line(1),
				line(2, {self: true}),
				line(3),
				line(4, {pending: true}),
				line(5, {supersededBy: 9}),
			];

			expect(
				queryOffer(
					messages,
					{
						1: done("pl"),
						2: done("en"),
						3: {status: "skipped", reason: "unsure", from: ""},
					},
					languages
				)
			).to.equal("pl");
		});

		it("a machine-translated line is passed over, not taken as the person's language", () => {
			const messages = [line(1), line(2, {machineTranslated: true, language: "en"})];

			expect(queryOffer(messages, {1: done("pl"), 2: done("en")}, languages)).to.equal("pl");
		});

		it("two newest placed lines in different languages are ambiguous: no offer", () => {
			expect(
				queryOffer([line(1), line(2)], {1: done("pl"), 2: done("de")}, languages)
			).to.equal(null);
		});

		it(`looks no further back than ${QUERY_LINES} of their lines`, () => {
			const messages = [line(0), ...Array.from({length: QUERY_LINES}, (_, i) => line(i + 1))];

			expect(queryOffer(messages, {0: done("pl")}, languages)).to.equal(null);
		});

		it("an empty or new query offers nothing", () => {
			expect(queryOffer([], {}, languages)).to.equal(null);
		});
	});

	describe("composerOffer", () => {
		const base: OfferInput = {
			query: true,
			replyTo: null,
			messages: [line(1)],
			entries: {1: done("pl"), 2: done("pt")},
			editing: false,
			writeTarget: null,
			declined: false,
			languages,
		};

		it("a reply's offer comes before a query's", () => {
			expect(composerOffer({...base, replyTo: line(2)})).to.deep.equal({
				kind: "reply",
				code: "pt",
			});
			expect(composerOffer(base)).to.deep.equal({kind: "query", code: "pl"});
		});

		it("a reply to a line that names nothing offers nothing, not the query's language", () => {
			expect(composerOffer({...base, replyTo: line(3)})).to.equal(null);
		});

		it("a channel offers only a reply", () => {
			expect(composerOffer({...base, query: false})).to.equal(null);
			expect(composerOffer({...base, query: false, replyTo: line(2)})?.code).to.equal("pt");
		});

		it("nothing over a chosen language, an edit or a decline", () => {
			expect(composerOffer({...base, writeTarget: "de"})).to.equal(null);
			// The cleanup pass (a target equal to the reading language) is a choice too.
			expect(composerOffer({...base, writeTarget: "en"})).to.equal(null);
			expect(composerOffer({...base, editing: true, replyTo: line(2)})).to.equal(null);
			expect(composerOffer({...base, declined: true, replyTo: line(2)})).to.equal(null);
		});
	});
});
