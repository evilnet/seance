import {expect} from "chai";
import {migrateStoredSettings} from "../../client/js/helpers/settingsMigration";

describe("settingsMigration", function () {
	const shell = {
		fontSize: "large",
		theme: "coffee",
		matchSystemTextSize: true,
		matchSystemAppearance: true,
	};
	const web = {...shell, matchSystemTextSize: false, matchSystemAppearance: false};

	it("leaves a fresh install on the new defaults", function () {
		expect(migrateStoredSettings({}, shell)).to.deep.equal({});
	});

	it("keeps a step and a theme the user picked before the settings existed", function () {
		const stored = {fontSize: "huge", theme: "creama"};
		expect(migrateStoredSettings(stored, shell)).to.deep.equal({
			fontSize: "huge",
			theme: "creama",
			matchSystemTextSize: false,
			matchSystemAppearance: false,
		});
	});

	it("turns each setting off only for its own choice", function () {
		expect(migrateStoredSettings({fontSize: "large", theme: "creama"}, shell)).to.deep.equal({
			fontSize: "large",
			theme: "creama",
			matchSystemAppearance: false,
		});
		expect(migrateStoredSettings({fontSize: "small", theme: "coffee"}, shell)).to.deep.equal({
			fontSize: "small",
			theme: "coffee",
			matchSystemTextSize: false,
		});
	});

	it("leaves appearance on for a theme with no light/dark partner", function () {
		// An unpaired theme is shown as chosen either way, so following the
		// system overrides nothing; picking a paired theme later follows it.
		const stored = {fontSize: "large", theme: "gates"};
		expect(migrateStoredSettings(stored, shell)).to.deep.equal(stored);
	});

	it("gives the new default to a user who never changed what it overrides", function () {
		const stored = {fontSize: "large", theme: "coffee", media: false};
		expect(migrateStoredSettings(stored, shell)).to.deep.equal(stored);
	});

	it("never overrides a stored value for the new setting", function () {
		const stored = {fontSize: "huge", matchSystemTextSize: true};
		expect(migrateStoredSettings(stored, shell)).to.deep.equal(stored);
	});

	it("measures the stored theme against the deploy's default, not the build's", function () {
		// boot.ts stores a branded default theme without the user picking it.
		const branded = {...shell, theme: "princess"};
		expect(migrateStoredSettings({theme: "princess"}, branded)).to.deep.equal({
			theme: "princess",
		});
		expect(migrateStoredSettings({theme: "coffee"}, branded)).to.deep.equal({
			theme: "coffee",
			matchSystemAppearance: false,
		});
	});

	it("reads a damaged entry as nothing stored", function () {
		for (const stored of [5, "5", null, true, ["theme"]]) {
			expect(migrateStoredSettings(stored, shell)).to.deep.equal({});
		}
	});

	it("does nothing where the new setting defaults to off", function () {
		const stored = {fontSize: "huge", theme: "creama"};
		expect(migrateStoredSettings(stored, web)).to.deep.equal(stored);
	});
});
