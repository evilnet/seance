import {expect} from "chai";
import {
	emojiForShortcode,
	shortcodesForEmoji,
} from "../../../client/js/helpers/ircmessageparser/findShortcode";

// The emoji's tooltip (parse.ts) names the shortcodes that write it.
describe("shortcodesForEmoji", () => {
	it("names every alias of an emoji, in the map's order", () => {
		expect(shortcodesForEmoji("\u{1F44D}")).to.deep.equal(["+1", "thumbsup"]);
		expect(shortcodesForEmoji("\u{1F4A9}")).to.include.members(["hankey", "poop", "shit"]);
	});

	it("finds an emoji whatever its skin tone", () => {
		expect(shortcodesForEmoji("\u{1F44D}\u{1F3FD}")).to.deep.equal(["+1", "thumbsup"]);
	});

	it("finds an emoji with or without the presentation selector", () => {
		expect(shortcodesForEmoji("❤️")).to.deep.equal(["heart"]);
		expect(shortcodesForEmoji("❤")).to.deep.equal(["heart"]);
	});

	it("finds a joined sequence as one emoji", () => {
		// 🏳️‍🌈, written with and without its selector
		expect(shortcodesForEmoji("\u{1F3F3}️‍\u{1F308}")).to.deep.equal(["rainbow_flag"]);
		expect(shortcodesForEmoji("\u{1F3F3}‍\u{1F308}")).to.deep.equal(["rainbow_flag"]);
	});

	it("names nothing for text the map does not know", () => {
		expect(shortcodesForEmoji("a")).to.deep.equal([]);
		expect(shortcodesForEmoji("")).to.deep.equal([]);
		expect(shortcodesForEmoji("constructor")).to.deep.equal([]);
	});

	it("names only shortcodes that write the emoji back", () => {
		for (const name of shortcodesForEmoji("\u{1F44D}")) {
			expect(emojiForShortcode(name), name).to.equal("\u{1F44D}");
		}
	});
});
