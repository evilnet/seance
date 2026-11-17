import {expect} from "chai";
import {cleanIrcMessage, matchFormatting} from "../../shared/irc";

describe("cleanIrcMessage", function () {
	it("should remove all formatting", function () {
		const testCases = [
			{
				input: "\x0303",
				expected: "",
			},
			{
				input: "\x02bold",
				expected: "bold",
			},
			{
				input: "\x038yellowText",
				expected: "yellowText",
			},
			{
				input: "\x030,0white,white",
				expected: "white,white",
			},
			{
				input: "\x034,8yellowBGredText",
				expected: "yellowBGredText",
			},
			{
				input: "\x1ditalic",
				expected: "italic",
			},
			{
				input: "\x1estrikethrough",
				expected: "strikethrough",
			},
			{
				input: "\x11monospace",
				expected: "monospace",
			},
			{
				input: "\x16reset color",
				expected: "reset color",
			},
			{
				input: "\x1funderline",
				expected: "underline",
			},
			{
				input: "\x02bold\x038yellow\x02nonBold\x03default",
				expected: "boldyellownonBolddefault",
			},
			{
				input: "\x02bold\x02 \x02bold\x02",
				expected: "bold bold",
			},
			{
				input: "\x02irc\x0f://\x1dirc.example.com\x0f/\x034,8thelounge",
				expected: "irc://irc.example.com/thelounge",
			},
			{
				input: "\x02#\x038,9thelounge",
				expected: "#thelounge",
			},
			{
				input: "\x04DDEEAA,BBEEFF#\x038,9thelou\x04FFAACC\x0311\x04nge",
				expected: "#thelounge",
			},
			{
				input: "\x04ddEEffhex\x04 color\x04EEffCC,AAaaCC clean",
				expected: "hex color clean",
			},
			{
				input: "\x04 AAaaAA\x03 11 \x04Invalid,Hex ",
				expected: "AAaaAA 11 Invalid,Hex",
			},
		];

		const actual = testCases.map((testCase) => cleanIrcMessage(testCase.input));
		const expected = testCases.map((testCase) => testCase.expected);

		expect(actual).to.deep.equal(expected);
	});

	// MessageActions.vue's Copy text strips with matchFormatting alone: the
	// message as read, line breaks and indentation kept.
	it("matchFormatting takes the codes and leaves line breaks and spaces", function () {
		const text = "  \x02one\x02\n\x0304,08two\x0f\n\n\x1dthree\x1d ";

		expect(text.replace(matchFormatting, "")).to.equal("  one\ntwo\n\nthree ");
	});
});
