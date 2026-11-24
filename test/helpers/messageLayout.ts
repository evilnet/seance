import {expect} from "chai";
import {
	bubbleThemes,
	defaultMessageLayout,
	messageLayoutFor,
	messageLayouts,
	normalizeMessageLayout,
	themeOffersBubbles,
	themePaintsBubbles,
} from "../../client/js/helpers/messageLayout";
import configuration from "../../client/js/configuration";

// The names are the contract: Appearance.vue's radios carry them,
// settings.ts normalizes whatever localStorage held, and style.css keys the
// layout off `html[data-message-layout="bubbles"]`.
describe("messageLayout", () => {
	it("offers lines and bubbles, lines being the default", () => {
		expect(messageLayouts).to.deep.equal(["lines", "bubbles"]);
		expect(defaultMessageLayout).to.equal("lines");
	});

	it("falls back to lines for anything else", () => {
		expect(normalizeMessageLayout("bubbles")).to.equal("bubbles");
		expect(normalizeMessageLayout(undefined)).to.equal("lines");
		expect(normalizeMessageLayout("Bubbles")).to.equal("lines");
		expect(normalizeMessageLayout(1)).to.equal("lines");
	});

	it("names only themes that exist", () => {
		const names = new Set(configuration.themes.map((theme) => theme.name));

		for (const theme of bubbleThemes) {
			expect(names.has(theme), theme).to.equal(true);
		}
	});

	it("keeps ps on Bubbles, painted by ps, whatever the setting says", () => {
		expect(themeOffersBubbles("ps")).to.equal(false);
		expect(messageLayoutFor("lines", "ps")).to.equal("bubbles");
		expect(messageLayoutFor(undefined, "ps")).to.equal("bubbles");
		expect(themePaintsBubbles("ps")).to.equal(true);
		expect(themePaintsBubbles("keeki")).to.equal(false);
	});

	it("leaves the period themes and TheLounge's own without the choice", () => {
		for (const theme of [
			"day",
			"morning",
			"sandrof",
			"oikarinen",
			"bourbaki",
			"gates",
			"mardam",
			"zelenzy",
			"panasync",
		]) {
			expect(themeOffersBubbles(theme), theme).to.equal(false);
			expect(messageLayoutFor("bubbles", theme), theme).to.equal(null);
		}
	});

	it("applies the reader's choice where the theme offers it", () => {
		expect(messageLayoutFor("bubbles", "keeki")).to.equal("bubbles");
		expect(messageLayoutFor("lines", "macos")).to.equal("lines");
		expect(messageLayoutFor("nonsense", "coffee")).to.equal("lines");
	});
});
