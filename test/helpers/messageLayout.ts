import {expect} from "chai";
import {
	defaultMessageLayout,
	lookThemes,
	messageLayoutFor,
	messageLayouts,
	normalizeMessageLayout,
	themeOffersLooks,
	themePaintsBubbles,
} from "../../client/js/helpers/messageLayout";
import configuration from "../../client/js/configuration";

// The names are the contract: Appearance.vue's radios carry them,
// settings.ts normalizes whatever localStorage held, and style.css keys the
// looks off `html[data-message-layout]`. "lines" and "bubbles" are what
// Classic and Messenger were stored as before they had those names, so they
// stay.
describe("messageLayout", () => {
	it("offers Classic, Messenger and Workspace, Classic being the default", () => {
		expect(messageLayouts).to.deep.equal(["lines", "bubbles", "workspace"]);
		expect(defaultMessageLayout).to.equal("lines");
	});

	it("falls back to lines for anything else", () => {
		expect(normalizeMessageLayout("bubbles")).to.equal("bubbles");
		expect(normalizeMessageLayout("workspace")).to.equal("workspace");
		expect(normalizeMessageLayout("Workspace")).to.equal("lines");
		expect(normalizeMessageLayout("terminal")).to.equal("lines");
		expect(normalizeMessageLayout(undefined)).to.equal("lines");
		expect(normalizeMessageLayout("Bubbles")).to.equal("lines");
		expect(normalizeMessageLayout(1)).to.equal("lines");
	});

	it("names only themes that exist", () => {
		const names = new Set(configuration.themes.map((theme) => theme.name));

		for (const theme of lookThemes) {
			expect(names.has(theme), theme).to.equal(true);
		}
	});

	it("keeps ps on Messenger, painted by ps, whatever the setting says", () => {
		expect(themeOffersLooks("ps")).to.equal(false);
		expect(messageLayoutFor("lines", "ps")).to.equal("bubbles");
		expect(messageLayoutFor("workspace", "ps")).to.equal("bubbles");
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
			expect(themeOffersLooks(theme), theme).to.equal(false);
			expect(messageLayoutFor("bubbles", theme), theme).to.equal(null);
			expect(messageLayoutFor("workspace", theme), theme).to.equal(null);
		}
	});

	it("applies the reader's choice where the theme offers it", () => {
		expect(messageLayoutFor("bubbles", "keeki")).to.equal("bubbles");
		expect(messageLayoutFor("workspace", "frost")).to.equal("workspace");
		expect(messageLayoutFor("lines", "macos")).to.equal("lines");
		expect(messageLayoutFor("nonsense", "coffee")).to.equal("lines");
	});

	it("offers the looks in the themes on coffee's tokens, macOS included", () => {
		expect([...lookThemes].sort()).to.deep.equal(
			[
				"coffee",
				"creama",
				"cobalt",
				"frost",
				"molokai",
				"princess",
				"princess_",
				"keeki",
				"keekiblush",
				"macos",
			].sort()
		);
	});
});
