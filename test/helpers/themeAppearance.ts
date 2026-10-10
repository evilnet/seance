import {expect} from "chai";
import {
	describeThemePairs,
	effectiveTheme,
	pairLabel,
	themeChoices,
	themePartner,
	THEME_PAIRS,
} from "../../client/js/helpers/themeAppearance";

describe("themeAppearance", function () {
	it("pairs each light theme with its dark one, both ways", function () {
		for (const [a, b] of [
			["coffee", "creama"],
			["cobalt", "frost"],
			["princess_", "princess"],
			["morning", "day"],
		]) {
			expect(themePartner(a)).to.equal(b);
			expect(themePartner(b)).to.equal(a);
		}

		expect(themePartner("keeki")).to.equal(null);
	});

	it("shows the chosen theme when not following the system", function () {
		expect(effectiveTheme("coffee", false, false)).to.equal("coffee");
		expect(effectiveTheme("creama", false, true)).to.equal("creama");
	});

	it("swaps to the partner whose mode matches the system", function () {
		expect(effectiveTheme("coffee", true, true)).to.equal("coffee");
		expect(effectiveTheme("coffee", true, false)).to.equal("creama");
		expect(effectiveTheme("creama", true, true)).to.equal("coffee");
		expect(effectiveTheme("frost", true, true)).to.equal("cobalt");
		expect(effectiveTheme("princess_", true, false)).to.equal("princess");
		expect(effectiveTheme("day", true, true)).to.equal("morning");
	});

	it("names every pair in the settings hint, dark first", function () {
		const label = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
		expect(describeThemePairs(label)).to.equal(
			"Coffee / Creama, Cobalt / Frost, Princess and Morning / Day"
		);
		expect(THEME_PAIRS).to.have.length(4);
	});

	it("leaves a theme without a partner alone", function () {
		expect(effectiveTheme("keeki", true, false)).to.equal("keeki");
		expect(effectiveTheme("gates", true, true)).to.equal("gates");
	});

	it("names a pair by both halves, dark first, or by the name they share", function () {
		expect(pairLabel("Coffee", "Creama")).to.equal("Coffee / Creama");
		expect(pairLabel("Morning", "Day")).to.equal("Morning / Day");
		expect(pairLabel("Princess_", "Princess")).to.equal("Princess");
	});

	describe("the theme picker's entries", function () {
		const themes = [
			{name: "coffee", displayName: "Coffee"},
			{name: "creama", displayName: "Creama"},
			{name: "molokai", displayName: "Molokai"},
			{name: "princess", displayName: "Princess"},
			{name: "princess_", displayName: "Princess_"},
			{name: "day", displayName: "Day"},
		];

		it("lists every theme on its own when not following the system", function () {
			expect(themeChoices(themes, false, "creama")).to.deep.equal(
				themes.map((t) => ({value: t.name, label: t.displayName}))
			);
		});

		it("lists a pair once when following the system", function () {
			expect(themeChoices(themes, true, "molokai")).to.deep.equal([
				{value: "coffee", label: "Coffee / Creama"},
				{value: "molokai", label: "Molokai"},
				{value: "princess_", label: "Princess"},
				// morning is not in this build, so day stands alone.
				{value: "day", label: "Day"},
			]);
		});

		it("keeps the stored half as the pair's value, so it stays selected", function () {
			const choices = themeChoices(themes, true, "creama");
			expect(choices[0]).to.deep.equal({value: "creama", label: "Coffee / Creama"});
			expect(themeChoices(themes, true, "princess")[2].value).to.equal("princess");
		});
	});
});
