import {expect} from "chai";
import {matchColorCodes} from "../../client/js/helpers/colorMatch";

const ENTRIES: [string, string][] = [
	["00", "White"],
	["01", "Black"],
	["02", "Blue"],
	["03", "Green"],
	["04", "Red"],
	["05", "Brown"],
	["06", "Magenta"],
	["07", "Orange"],
	["08", "Yellow"],
	["09", "Light Green"],
	["10", "Cyan"],
	["11", "Light Cyan"],
	["12", "Light Blue"],
	["13", "Pink"],
	["14", "Grey"],
	["15", "Light Grey"],
];

/** A "locale" that renders four of the names in German and leaves the rest. */
const GERMAN: Record<string, string> = {
	"02": "Blau",
	"03": "Grün",
	"04": "Rot",
	"14": "Grau",
};

const german = (code: string, en: string): string => GERMAN[code] ?? en;
const english = (_code: string, en: string): string => en;

describe("matchColorCodes", function () {
	it("matches the colour code itself", function () {
		const matches = matchColorCodes("0", ENTRIES, english);

		expect(matches.map(([code]) => code)).to.deep.equal([
			"00",
			"01",
			"02",
			"03",
			"04",
			"05",
			"06",
			"07",
			"08",
			"09",
		]);
		// A code match shows the name as it is; there is nothing to highlight.
		expect(matches[4]).to.deep.equal(["04", "Red"]);
	});

	it("matches a full code", function () {
		expect(matchColorCodes("13", ENTRIES, english)).to.deep.equal([["13", "Pink"]]);
	});

	it("matches the localized name and highlights it", function () {
		expect(matchColorCodes("ro", ENTRIES, german)).to.deep.equal([
			["04", "<b>R</b><b>o</b>t"],
			["05", "B<b>r</b><b>o</b>wn"],
		]);
	});

	it("matches the English name when the localized one does not", function () {
		// "red" is nothing like "Rot", but the wire name still finds it, and
		// the result is shown in the reader's language.
		expect(matchColorCodes("red", ENTRIES, german)).to.deep.equal([["04", "Rot"]]);
	});

	it("is case-insensitive and lists everything for an empty term", function () {
		expect(matchColorCodes("PINK", ENTRIES, english)).to.deep.equal([
			["13", "<b>P</b><b>i</b><b>n</b><b>k</b>"],
		]);
		expect(matchColorCodes("", ENTRIES, english)).to.have.length(ENTRIES.length);
	});

	it("finds nothing for a term no name and no code carries", function () {
		expect(matchColorCodes("zzz", ENTRIES, german)).to.deep.equal([]);
	});
});
