import {expect} from "chai";
import {
	notificationText,
	splitAction,
	stripFormatting,
	stripMarkdown,
} from "../../client/js/push/strip";

describe("push/strip", function () {
	describe("stripFormatting", function () {
		it("removes IRC colour and style bytes and trims", function () {
			expect(stripFormatting("\x02bold\x02 \x034,1red\x03 \x1funder\x1f ")).to.equal(
				"bold red under"
			);
		});
	});

	describe("stripMarkdown", function () {
		it("removes inline markers", function () {
			expect(stripMarkdown("**bold** and *it* and `code` and ~~gone~~")).to.equal(
				"bold and it and code and gone"
			);
		});

		it("removes block markers across lines", function () {
			expect(stripMarkdown("# Title\n```js\nlet x = 1;\n```\n> quoted")).to.equal(
				"Title\nlet x = 1;\nquoted"
			);
		});

		it("keeps a line break after a code block", function () {
			expect(stripMarkdown("```\ncode\n```\nafter")).to.equal("code\nafter");
		});

		it("leaves an unclosed marker literal and never loses characters", function () {
			expect(stripMarkdown("**bold that got cut")).to.equal("**bold that got cut");
			expect(stripMarkdown("```js\nlet x = 1;")).to.equal("```js\nlet x = 1;");
		});

		it("inline markers join with no added breaks", function () {
			expect(stripMarkdown("**a** b")).to.equal("a b");
		});

		it("strips math spans to their TeX source", function () {
			expect(stripMarkdown("see $" + "`x^2`" + "$ here")).to.equal("see x^2 here");
			expect(stripMarkdown("$$\\sum_i x_i$$")).to.equal("\\sum_i x_i");
		});
	});

	describe("splitAction", function () {
		it("splits a CTCP ACTION, with or without the closing byte", function () {
			expect(splitAction("\x01ACTION waves\x01")).to.deep.equal({
				action: true,
				body: "waves",
			});
			expect(splitAction("\x01ACTION waves")).to.deep.equal({action: true, body: "waves"});
			expect(splitAction("plain")).to.deep.equal({action: false, body: "plain"});
		});

		it("reads an empty action, which has no space after the word", function () {
			expect(splitAction("\x01ACTION\x01")).to.deep.equal({action: true, body: ""});
			expect(splitAction("\x01ACTION")).to.deep.equal({action: true, body: ""});
			expect(splitAction("\x01ACTIONS\x01")).to.deep.equal({
				action: false,
				body: "\x01ACTIONS\x01",
			});
		});
	});

	describe("notificationText", function () {
		it("strips formatting always and markdown only when asked", function () {
			expect(notificationText("\x02**hi**\x02", {markdown: false})).to.equal("**hi**");
			expect(notificationText("\x02**hi**\x02", {markdown: true})).to.equal("hi");
		});

		it("keeps the action marks around a stripped action", function () {
			expect(notificationText("\x01ACTION *waves*\x01", {markdown: true})).to.equal(
				"*waves*"
			);
			expect(notificationText("\x01ACTION waves\x01", {markdown: false})).to.equal("*waves*");
		});

		it("shows an empty action as one, never as the word ACTION", function () {
			// The same as the page's own empty action, `\x01ACTION \x01` (msg.ts).
			expect(notificationText("\x01ACTION\x01", {markdown: false})).to.equal("**");
			expect(notificationText("\x01ACTION\x01", {markdown: true})).to.equal("**");
			expect(notificationText("\x01ACTION \x01", {markdown: true})).to.equal("**");
		});

		it("strips a joined multiline message as one text", function () {
			expect(notificationText("```\nlet x;\n```", {markdown: true})).to.equal("let x;");
		});
	});
});
