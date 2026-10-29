import {expect} from "chai";
import en from "../../client/locales/en.json";
import {
	defaultOwnMessageStyle,
	normalizeOwnMessageStyle,
	ownMessageStyles,
} from "../../client/js/helpers/ownMessages";

// The three names are the contract: Appearance.vue's radios carry them,
// settings.ts normalizes whatever localStorage held, and style.css keys the
// three looks off `html[data-own-messages=…]`.
describe("ownMessages", () => {
	it("offers greyed text, a band and nothing, greyed being the default", () => {
		expect(ownMessageStyles).to.deep.equal(["muted", "band", "plain"]);
		expect(defaultOwnMessageStyle).to.equal("muted");
	});

	it("passes the three names through", () => {
		for (const style of ownMessageStyles) {
			expect(normalizeOwnMessageStyle(style)).to.equal(style);
		}
	});

	it("falls back to the default for anything else", () => {
		expect(normalizeOwnMessageStyle(undefined)).to.equal("muted");
		expect(normalizeOwnMessageStyle("")).to.equal("muted");
		expect(normalizeOwnMessageStyle("grey")).to.equal("muted");
		expect(normalizeOwnMessageStyle(2)).to.equal("muted");
	});

	it("has an English label and hint for every style (Appearance.vue's keys)", function () {
		const catalog = en as Record<string, unknown>;

		for (const style of ownMessageStyles) {
			const key = `settings.appearance.ownMessages${style
				.charAt(0)
				.toUpperCase()}${style.slice(1)}`;
			expect(catalog[key], style).to.be.a("string").and.not.equal("");
			expect(catalog[`${key}Hint`], style).to.be.a("string").and.not.equal("");
		}
	});
});
