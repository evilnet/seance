import {expect} from "chai";
import findEmoji from "../../../client/js/helpers/ircmessageparser/findEmoji";

describe("findEmoji", () => {
	it("should find default emoji presentation character", () => {
		const input = "test \u{231A} test";
		const expected = [
			{
				start: 5,
				end: 6,
				emoji: "\u{231A}",
			},
		];

		const actual = findEmoji(input);

		expect(actual).to.deep.equal(expected);
	});

	it("should find emoji the previous emoji-regex did not know", () => {
		for (const emoji of ["\u{1F6D9}", "\u{1FA8B}", "\u{1FAFA}"]) {
			expect(findEmoji(`test ${emoji} test`)).to.deep.equal([
				{start: 5, end: 5 + emoji.length, emoji},
			]);
		}
	});

	it("should find default text presentation character rendered as emoji", () => {
		const input = "test \u{2194}\u{FE0F} test";
		const expected = [
			{
				start: 5,
				end: 7,
				emoji: "\u{2194}\u{FE0F}",
			},
		];

		const actual = findEmoji(input);

		expect(actual).to.deep.equal(expected);
	});

	it("should find emoji modifier base", () => {
		const input = "test\u{1F469}test";
		const expected = [
			{
				start: 4,
				end: 6,
				emoji: "\u{1F469}",
			},
		];

		const actual = findEmoji(input);

		expect(actual).to.deep.equal(expected);
	});

	it("should find emoji modifier base followed by a modifier", () => {
		const input = "test\u{1F469}\u{1F3FF}test";
		const expected = [
			{
				start: 4,
				end: 8,
				emoji: "\u{1F469}\u{1F3FF}",
			},
		];

		const actual = findEmoji(input);

		expect(actual).to.deep.equal(expected);
	});
});
