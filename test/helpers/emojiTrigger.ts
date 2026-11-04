import {expect} from "chai";
import {emojiToken, replaceToken} from "../../client/js/helpers/emojiTrigger";

describe("composer emoji trigger (helpers/emojiTrigger.ts)", function () {
	it("finds a :name being typed at the start or after a space", function () {
		expect(emojiToken(":sm", 3)).to.deep.equal({start: 0, end: 3, term: "sm"});
		expect(emojiToken("nice :thumbs_up", 15)).to.deep.equal({
			start: 5,
			end: 15,
			term: "thumbs_up",
		});
		expect(emojiToken("ok :+1", 6)?.term).to.equal("+1");
	});

	it("looks only at the text before the caret", function () {
		expect(emojiToken("hi :tad there", 7)).to.deep.equal({start: 3, end: 7, term: "tad"});
		expect(emojiToken("hi :tad there", 13)).to.equal(null);
	});

	it("needs two name characters, and a colon that starts a word", function () {
		expect(emojiToken(":s", 2)).to.equal(null);
		expect(emojiToken("at 10:30", 8)).to.equal(null);
		expect(emojiToken("see https://x", 13)).to.equal(null);
		expect(emojiToken("smile :-)", 9)).to.equal(null);
		expect(emojiToken(":tada: ", 7)).to.equal(null);
	});

	it("replaces the token with the emoji and puts the caret after it", function () {
		const text = "so :tad cool";
		const token = emojiToken(text, 7);

		expect(token).to.not.equal(null);
		expect(replaceToken(text, token!, "🎉")).to.deep.equal({text: "so 🎉 cool", caret: 5});
	});
});
