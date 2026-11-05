import {expect} from "chai";
import {after, describe, it} from "mocha";
import enCatalog from "../../client/locales/en.json";
import {setCatalog} from "../../client/js/i18n/core";
import roundBadgeNumber from "../../client/js/helpers/roundBadgeNumber";

// The unread badge is a localized number now: the small form is the locale's
// grouped integer, the compact form the locale's own abbreviation. Outputs
// pinned against Node 22's full-icu CLDR.
describe("roundBadgeNumber", () => {
	after(() => {
		// The catalog is module state: hand the real English copy back.
		setCatalog("en", enCatalog, undefined);
	});

	it("writes small counts with the active locale's digits", () => {
		setCatalog("en", enCatalog, undefined);
		expect(roundBadgeNumber(999)).to.equal("999");
		setCatalog("ar-EG", enCatalog, undefined);
		expect(roundBadgeNumber(999)).to.equal("٩٩٩"); // Arabic-Indic digits
	});

	it("compacts in en from 1000: 1.5K", () => {
		setCatalog("en", enCatalog, undefined);
		expect(roundBadgeNumber(1500)).to.equal("1.5K");
		expect(roundBadgeNumber(15000)).to.equal("15K");
	});

	it("de has no thousands abbreviation: 1500 stays full-width", () => {
		setCatalog("de", enCatalog, undefined);
		expect(roundBadgeNumber(1500)).to.equal("1500");
		expect(roundBadgeNumber(15000)).to.equal("15.000"); // first de abbreviation
		expect(roundBadgeNumber(1500000)).to.equal("1,5\u00A0Mio."); // NBSP inside
	});
});
