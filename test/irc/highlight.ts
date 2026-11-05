import {expect} from "chai";
import {
	buildHighlightRegex,
	escapeRegExp,
	createHighlightTester,
	isHighlight,
	isHighlightException,
	mentionSpans,
	parseKeywordList,
} from "../../client/js/highlight";

describe("highlight", function () {
	describe("escapeRegExp", function () {
		it("escapes regex metacharacters", function () {
			expect(escapeRegExp("c++")).to.equal("c\\+\\+");
			expect(escapeRegExp("a.b")).to.equal("a\\.b");
			expect(escapeRegExp("[x]{1}$^|?()\\")).to.equal("\\[x\\]\\{1\\}\\$\\^\\|\\?\\(\\)\\\\");
		});

		it("leaves plain text alone", function () {
			expect(escapeRegExp("nick_123-é")).to.equal("nick_123-é");
		});
	});

	describe("parseKeywordList", function () {
		it("splits on commas and trims each token", function () {
			expect(parseKeywordList(" foo , bar,baz ")).to.deep.equal(["foo", "bar", "baz"]);
		});

		it("drops empty tokens", function () {
			expect(parseKeywordList("foo,, ,bar,")).to.deep.equal(["foo", "bar"]);
		});

		it("returns an empty list for undefined or empty input", function () {
			expect(parseKeywordList(undefined)).to.deep.equal([]);
			expect(parseKeywordList("")).to.deep.equal([]);
			expect(parseKeywordList("  ")).to.deep.equal([]);
		});
	});

	describe("buildHighlightRegex", function () {
		it("returns null when there is nothing to match", function () {
			expect(buildHighlightRegex("", [])).to.equal(null);
			expect(buildHighlightRegex("  ", ["", " "])).to.equal(null);
		});

		it("returns a stateless case-insensitive regex", function () {
			const regex = buildHighlightRegex("nick", []);
			expect(regex).to.be.instanceOf(RegExp);
			expect(regex!.flags).to.include("i");
			expect(regex!.global).to.equal(false);
			expect(regex!.test("hi nick")).to.equal(true);
			expect(regex!.test("hi nick")).to.equal(true);
		});

		it("builds a regex from keywords alone when nick is empty", function () {
			const regex = buildHighlightRegex("", ["lounge"]);
			expect(regex!.test("the lounge is nice")).to.equal(true);
		});
	});

	describe("isHighlight", function () {
		describe("nick matching", function () {
			it("matches the nick at the start, middle and end of the text", function () {
				expect(isHighlight("nick hello", "nick", [])).to.equal(true);
				expect(isHighlight("hello nick how are you", "nick", [])).to.equal(true);
				expect(isHighlight("hello nick", "nick", [])).to.equal(true);
				expect(isHighlight("nick", "nick", [])).to.equal(true);
			});

			it("matches the nick with surrounding punctuation", function () {
				expect(isHighlight("nick: hi", "nick", [])).to.equal(true);
				expect(isHighlight("(nick) hi", "nick", [])).to.equal(true);
				expect(isHighlight("that is nick's", "nick", [])).to.equal(true);
				expect(isHighlight("@nick, hi!", "nick", [])).to.equal(true);
				expect(isHighlight("cc nick.", "nick", [])).to.equal(true);
			});

			it("does not match the nick inside a longer word", function () {
				expect(isHighlight("nickname", "nick", [])).to.equal(false);
				expect(isHighlight("my nickname is", "nick", [])).to.equal(false);
				expect(isHighlight("picnick", "nick", [])).to.equal(false);
				expect(isHighlight("nick2", "nick", [])).to.equal(false);
			});

			it("is case-insensitive", function () {
				expect(isHighlight("hello NICK", "nick", [])).to.equal(true);
				expect(isHighlight("hello nick", "NiCk", [])).to.equal(true);
			});

			it("treats regex metacharacters in the nick literally", function () {
				expect(isHighlight("hi n[i]ck^", "n[i]ck^", [])).to.equal(true);
				expect(isHighlight("hi nick", "n[i]ck^", [])).to.equal(false);
				expect(isHighlight("hi n.ck", "n.ck", [])).to.equal(true);
				expect(isHighlight("hi nack", "n.ck", [])).to.equal(false);
			});

			it("ignores IRC formatting codes around the nick", function () {
				expect(isHighlight("\x02nick\x02: hi", "nick", [])).to.equal(true);
				expect(isHighlight("\x0304nick\x03 hi", "nick", [])).to.equal(true);
				expect(isHighlight("\x034,12nick", "nick", [])).to.equal(true);
			});

			it("does not match when the nick is empty and there are no keywords", function () {
				expect(isHighlight("hello there", "", [])).to.equal(false);
			});
		});

		describe("keyword matching", function () {
			it("matches a keyword as a separate token", function () {
				expect(isHighlight("i like coffee", "nick", ["coffee"])).to.equal(true);
				expect(isHighlight("coffee!", "nick", ["coffee"])).to.equal(true);
				expect(isHighlight("(coffee)", "nick", ["coffee"])).to.equal(true);
				expect(isHighlight("i like coffeecake", "nick", ["coffee"])).to.equal(false);
			});

			it("is case-insensitive for keywords", function () {
				expect(isHighlight("I LIKE COFFEE", "nick", ["coffee"])).to.equal(true);
				expect(isHighlight("i like coffee", "nick", ["COFFEE"])).to.equal(true);
			});

			it("treats regex metacharacters in keywords literally", function () {
				expect(isHighlight("i write c++ daily", "nick", ["c++"])).to.equal(true);
				expect(isHighlight("i write c daily", "nick", ["c++"])).to.equal(false);
				expect(isHighlight("see a.b here", "nick", ["a.b"])).to.equal(true);
				expect(isHighlight("see axb here", "nick", ["a.b"])).to.equal(false);
				expect(isHighlight("cost is $5", "nick", ["$5"])).to.equal(true);
			});

			it("matches multi-word keywords", function () {
				expect(isHighlight("the lounge rocks", "nick", ["the lounge"])).to.equal(true);
				expect(isHighlight("the lounges rock", "nick", ["the lounge"])).to.equal(false);
			});

			it("supports unicode keywords", function () {
				expect(isHighlight("meet at the café", "nick", ["café"])).to.equal(true);
				expect(isHighlight("meet at the CAFÉ", "nick", ["café"])).to.equal(true);
				expect(isHighlight("こんにちは 世界", "nick", ["世界"])).to.equal(true);
				expect(isHighlight("party 🎉 time", "nick", ["🎉"])).to.equal(true);
			});

			it("matches any keyword from the list and ignores blanks", function () {
				const keywords = ["", "tea", " ", "coffee"];
				expect(isHighlight("tea?", "nick", keywords)).to.equal(true);
				expect(isHighlight("coffee?", "nick", keywords)).to.equal(true);
				expect(isHighlight("water?", "nick", keywords)).to.equal(false);
			});

			it("does not match anything with an empty keyword list", function () {
				expect(isHighlight("i like coffee", "nick", [])).to.equal(false);
				expect(isHighlight("i like coffee", "nick", ["", "  "])).to.equal(false);
			});

			it("strips IRC formatting before testing keywords", function () {
				expect(isHighlight("i like \x02coffee\x02", "nick", ["coffee"])).to.equal(true);
			});
		});

		describe("exceptions", function () {
			it("suppresses a nick highlight when an exception matches", function () {
				expect(isHighlight("nick: build failed", "nick", [], ["build failed"])).to.equal(
					false
				);
				expect(isHighlight("nick: build passed", "nick", [], ["build failed"])).to.equal(
					true
				);
			});

			it("suppresses a keyword highlight when an exception matches", function () {
				expect(isHighlight("bot: coffee ready", "nick", ["coffee"], ["bot:"])).to.equal(
					false
				);
				expect(isHighlight("coffee ready", "nick", ["coffee"], ["bot:"])).to.equal(true);
			});

			it("matches exceptions as delimited tokens, case-insensitively", function () {
				expect(isHighlight("nick FOO", "nick", [], ["foo"])).to.equal(false);
				expect(isHighlight("nick foobar", "nick", [], ["foo"])).to.equal(true);
			});

			it("ignores empty or blank exception lists", function () {
				expect(isHighlight("hello nick", "nick", [], [])).to.equal(true);
				expect(isHighlight("hello nick", "nick", [], ["", " "])).to.equal(true);
				expect(isHighlight("hello nick", "nick", [], undefined)).to.equal(true);
			});

			it("tests exceptions on their own (for highlights not based on the text)", function () {
				// A query auto-highlight has no positive match to fold the
				// exceptions into; isHighlightException checks them alone.
				expect(isHighlightException("want to grab lunch?", ["lunch"])).to.equal(true);
				expect(isHighlightException("urgent, ping me", ["lunch"])).to.equal(false);
				expect(isHighlightException("LUNCH time", ["lunch"])).to.equal(true);
				expect(isHighlightException("lunchbox", ["lunch"])).to.equal(false);
				expect(isHighlightException("\x02lunch\x02 now", ["lunch"])).to.equal(true);
				expect(isHighlightException("anything", [])).to.equal(false);
				expect(isHighlightException("anything", ["", " "])).to.equal(false);
			});

			it("applies exceptions through buildHighlightRegex too", function () {
				const regex = buildHighlightRegex("nick", ["coffee"], ["ignore me"]);
				expect(regex!.test("nick, coffee?")).to.equal(true);
				expect(regex!.test("ignore me nick, coffee?")).to.equal(false);
				expect(regex!.test("nick coffee (ignore me)")).to.equal(false);
			});
		});
	});

	describe("createHighlightTester", function () {
		it("matches like the plain functions and never serves a stale cache", function () {
			const tester = createHighlightTester();
			expect(tester.isHighlight("hello nick", "nick", [], [])).to.equal(true);
			expect(tester.isHighlight("hello there", "nick", [], [])).to.equal(false);

			// Nick change invalidates.
			expect(tester.isHighlight("hello nick", "other", [], [])).to.equal(false);
			// Keyword change invalidates.
			expect(tester.isHighlight("get coffee", "other", ["coffee"], [])).to.equal(true);
			// Exception change invalidates.
			expect(tester.isHighlight("get coffee now", "other", ["coffee"], ["now"])).to.equal(
				false
			);
			// A multi-word keyword is not confused with two keywords.
			expect(tester.isHighlight("a b", "x", ["a b"], [])).to.equal(true);
			expect(tester.isHighlight("b alone", "x", ["a", "b"], [])).to.equal(true);

			expect(tester.isHighlightException("at lunch", ["lunch"])).to.equal(true);
			expect(tester.isHighlightException("at lunch", ["dinner"])).to.equal(false);
			expect(tester.isHighlightException("at lunch", [])).to.equal(false);
		});
	});

	describe("mentionSpans", function () {
		it("finds the nick in any case, without what surrounds it", function () {
			expect(mentionSpans("Wren: thanks (wren)", "wren", [])).to.deep.equal([
				[0, 4],
				[14, 18],
			]);
		});

		it("does not find the nick inside a longer word", function () {
			expect(mentionSpans("really al also", "al", [])).to.deep.equal([[7, 9]]);
		});

		it("holds a keyword to the delimiters that make it a highlight", function () {
			expect(mentionSpans("foo #foo foo_bar, foo.", "", ["foo"])).to.deep.equal([
				[0, 3],
				[18, 21],
			]);
			expect(isHighlight("#foo", "", ["foo"])).to.equal(false);
		});

		it("finds both, and treats them as literal text", function () {
			expect(mentionSpans("wren [a.b] axb", "wren", ["[a.b]"])).to.deep.equal([
				[0, 4],
				[5, 10],
			]);
		});

		it("marks the whole of a longer keyword", function () {
			expect(mentionSpans("wren bird says", "wren", ["wren bird"])).to.deep.equal([[0, 9]]);
			expect(mentionSpans("foo bar", "", ["foo", "foo bar"])).to.deep.equal([[0, 7]]);
		});

		it("finds nothing with nothing to look for", function () {
			expect(mentionSpans("wren", "", [])).to.deep.equal([]);
		});
	});
});
