import {expect} from "chai";
import {fuzzyHtml} from "../../client/js/helpers/fuzzyHtml";

// The user list's search and the input's completion render this `string` as
// HTML; the names in it come from the server and from other users.
describe("helpers/fuzzyHtml", () => {
	it("bolds the matched letters", () => {
		const [result] = fuzzyHtml("ad", ["alfred"], (s) => s);

		expect(result.string).to.equal("<b>a</b>lfre<b>d</b>");
		expect(result.original).to.equal("alfred");
	});

	it("escapes markup in a name and keeps the original raw", () => {
		const name = "#x<img/src/onerror=alert(1)>";
		const [result] = fuzzyHtml("#x", [name], (s) => s);

		expect(result.string).to.equal("<b>#</b><b>x</b>&lt;img/src/onerror=alert(1)&gt;");
		expect(result.original).to.equal(name);
	});

	it("matches the characters it escapes", () => {
		const [result] = fuzzyHtml("<&", ["a<b&c"], (s) => s);

		expect(result.string).to.equal("a<b>&lt;</b>b<b>&amp;</b>c");
	});

	it("reads the text through extract", () => {
		const user = {nick: "x<script>"};
		const [result] = fuzzyHtml("x", [user], (u) => u.nick);

		expect(result.string).to.equal("<b>x</b>&lt;script&gt;");
		expect(result.original).to.equal(user);
	});
});
