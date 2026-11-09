import {expect} from "chai";
import {
	claimPack,
	clearPacks,
	notePack,
	packShownOn,
	takePack,
} from "../../client/js/translate/applePacks";

describe("translate/applePacks", () => {
	afterEach(() => clearPacks());

	it("offers a pair on the first line translated from it, and only there", () => {
		claimPack(1, "pt", "en");
		expect(packShownOn(1, "pt", "en")).to.equal(false);

		notePack("pt", "en");
		claimPack(2, "pt", "en");
		claimPack(3, "pt", "en");
		expect(packShownOn(2, "pt", "en")).to.equal(true);
		expect(packShownOn(3, "pt", "en")).to.equal(false);
		expect(packShownOn(2, "pt", "de")).to.equal(false);
	});

	it("offers a pair no more once taken, nor again when noted again", () => {
		notePack("pt", "en");
		claimPack(2, "pt", "en");
		takePack("pt", "en");
		notePack("pt", "en");
		claimPack(4, "pt", "en");
		expect(packShownOn(2, "pt", "en")).to.equal(false);
		expect(packShownOn(4, "pt", "en")).to.equal(false);
	});

	it("names no line without a source", () => {
		notePack("pt", "en");
		claimPack(2, null, "en");
		expect(packShownOn(2, null, "en")).to.equal(false);
	});
});
