import {expect} from "chai";
import {
	DISCOVER_LINES,
	type DiscoverMessage,
	discoverLanguage,
} from "../../client/js/translate/discover";

const languages = {reading: "en", alsoRead: ["es"]};
const lines = (count: number, extra: Partial<DiscoverMessage> = {}, start = 1): DiscoverMessage[] =>
	Array.from({length: count}, (_, i) => ({
		id: start + i,
		type: "message",
		text: `line ${start + i}`,
		...extra,
	}));
/** A detector that reads the language off the text: "pt: …". */
const byPrefix = (text: string) => Promise.resolve(/^([a-z]{2}):/.exec(text)?.[1] ?? null);
const said = (code: string, count: number, start = 1) =>
	lines(count, {}, start).map((m) => ({...m, text: `${code}: ${m.text}`}));

describe("translate/discover", () => {
	it("offers the language most of the others write, by the detector", async () => {
		expect(await discoverLanguage(said("pt", 6), languages, byPrefix)).to.equal("pt");
	});

	it("needs five placed lines and half of them", async () => {
		expect(await discoverLanguage(said("pt", 4), languages, byPrefix)).to.equal(null);
		expect(
			await discoverLanguage([...said("pt", 5), ...said("de", 6, 10)], languages, byPrefix)
		).to.equal("de");
		expect(
			await discoverLanguage(
				[...said("pt", 5), ...said("de", 4, 10), ...said("fr", 3, 20)],
				languages,
				byPrefix
			)
		).to.equal(null);
	});

	it("goes by the sender's tag before the detector, machine-translated or not", async () => {
		const tagged = lines(6, {language: "pl"});
		let asked = 0;

		expect(
			await discoverLanguage(tagged, languages, () => {
				asked++;
				return Promise.resolve(null);
			})
		).to.equal("pl");
		expect(asked).to.equal(0);
	});

	it("passes over the user's own lines, notices, redacted, superseded and empty ones", async () => {
		const messages = [
			...said("pt", 5),
			...lines(10, {self: true, text: "pt: mine"}, 50),
			...lines(3, {type: "notice", text: "pt: notice"}, 70),
			...lines(3, {redacted: {}, text: "pt: gone"}, 80),
			...lines(3, {supersededBy: 1, text: "pt: old"}, 90),
			...lines(3, {text: "  "}, 100),
		];

		expect(await discoverLanguage(messages, languages, byPrefix)).to.equal("pt");
	});

	it(`looks at the newest ${DISCOVER_LINES} lines from others only`, async () => {
		const messages = [...said("pt", 10), ...said("de", DISCOVER_LINES, 100)];

		expect(await discoverLanguage(messages, languages, byPrefix)).to.equal("de");
	});

	it("no offer for a language the user reads or also reads", async () => {
		expect(await discoverLanguage(said("en", 8), languages, byPrefix)).to.equal(null);
		expect(await discoverLanguage(said("es", 8), languages, byPrefix)).to.equal(null);
	});

	it("asks the detector nothing where too few lines could be placed", async () => {
		let asked = 0;
		const counting = async (text: string) => {
			asked++;
			return byPrefix(text);
		};
		const short = (text: string) => text.split(/\s+/).length >= 3;
		const messages = [
			...said("pt", 4),
			...lines(10, {text: "ok"}, 50),
			...lines(10, {self: true, text: "pt: mine and long enough"}, 70),
		];

		expect(await discoverLanguage(messages, languages, counting, short)).to.equal(null);
		expect(asked).to.equal(0);
		// One more line worth asking about, and the detector is asked.
		expect(
			await discoverLanguage([...messages, ...said("pt", 1, 90)], languages, counting, short)
		).to.equal("pt");
		expect(asked).to.equal(5);
	});

	it("a tagged line counts whatever its length", async () => {
		const messages = [...lines(3, {language: "pt", text: "oi"}), ...said("pt", 2, 10)];

		expect(
			await discoverLanguage(messages, languages, byPrefix, (text) => text.length > 3)
		).to.equal("pt");
	});
});
