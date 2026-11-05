import {expect} from "chai";
import {directionText, GUESS_NAMES} from "../../client/js/translate/labels";

const NAMES: Record<string, string> = {
	da: "Danish",
	de: "German",
	en: "English",
	fr: "French",
	nb: "Norwegian",
	nl: "Dutch",
};

const nameOf = (code: string) => NAMES[code] ?? code;

describe("translate/labels", () => {
	it("names the source when the line has one", () => {
		expect(directionText("fr", "en", ["fr", "nl"], nameOf)).to.equal("French → English");
	});

	// The reported chip: "→ English" on a line whose source the detector
	// could not place.
	it("names the detector's contenders when the source was not placed", () => {
		expect(directionText("", "en", ["nb", "da"], nameOf)).to.equal(
			"Norwegian / Danish → English"
		);
		expect(directionText("", "en", ["fr"], nameOf)).to.equal("French? → English");
	});

	it("never names the target as a contender, and stops at a few", () => {
		expect(directionText("", "en", ["en", "de"], nameOf)).to.equal("German? → English");
		expect(directionText("", "en", ["nb", "da", "nl"], nameOf).split(" / ")).to.have.length(
			GUESS_NAMES
		);
	});

	it("marks an unplaced source with no contenders as unknown, never a bare arrow", () => {
		expect(directionText("", "en", [], nameOf)).to.equal("? → English");
		expect(directionText("", "en", ["en"], nameOf)).to.equal("? → English");
	});
});
