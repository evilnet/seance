import {expect} from "chai";
import {migrateStoredSettings, readStoredSettings} from "../../client/js/helpers/settingsMigration";

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
			matchSystemTextSize: true,
			matchSystemAppearance: false,
		});
		expect(migrateStoredSettings({fontSize: "small", theme: "coffee"}, shell)).to.deep.equal({
			fontSize: "small",
			theme: "coffee",
			matchSystemTextSize: false,
			matchSystemAppearance: true,
		});
	});

	it("leaves appearance on for a theme with no light/dark partner", function () {
		// An unpaired theme is shown as chosen either way, so following the
		// system overrides nothing; picking a paired theme later follows it.
		const stored = {fontSize: "large", theme: "gates"};
		expect(migrateStoredSettings(stored, shell)).to.deep.equal({
			...stored,
			matchSystemTextSize: true,
			matchSystemAppearance: true,
		});
	});

	it("gives the new default to a user who never changed what it overrides, stored", function () {
		// Stored, so the early theme loader reads the answer next launch.
		const stored = {fontSize: "large", theme: "coffee", media: false};
		expect(migrateStoredSettings(stored, shell)).to.deep.equal({
			...stored,
			matchSystemTextSize: true,
			matchSystemAppearance: true,
		});
	});

	it("never overrides a stored value for the new setting", function () {
		const stored = {fontSize: "huge", matchSystemTextSize: true};
		expect(migrateStoredSettings(stored, shell)).to.deep.equal({
			...stored,
			matchSystemAppearance: true,
		});
	});

	it("measures the stored theme against the deploy's default, not the build's", function () {
		// boot.ts stores a branded default theme without the user picking it.
		const branded = {...shell, theme: "princess"};
		expect(migrateStoredSettings({theme: "princess"}, branded)).to.deep.equal({
			theme: "princess",
			matchSystemTextSize: true,
			matchSystemAppearance: true,
		});
		expect(migrateStoredSettings({theme: "coffee"}, branded)).to.deep.equal({
			theme: "coffee",
			matchSystemTextSize: true,
			matchSystemAppearance: false,
		});
		// A paired branded default: stored on, since the early theme loader,
		// which knows only the build's default, would guess off every launch.
		const cobalt = {...shell, theme: "cobalt"};
		expect(migrateStoredSettings({theme: "cobalt"}, cobalt)).to.deep.equal({
			theme: "cobalt",
			matchSystemTextSize: true,
			matchSystemAppearance: true,
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

describe("readStoredSettings", function () {
	it("reads a damaged entry as nothing stored", function () {
		for (const stored of [5, "x", null, [], undefined]) {
			expect(readStoredSettings(stored)).to.deep.equal({});
		}
	});

	it("joins an old highlights list back into a string, its strings only", function () {
		expect(readStoredSettings({highlights: ["a", "b"]})).to.deep.equal({highlights: "a, b"});
		// An element that cannot become a string threw inside join
		expect(readStoredSettings({highlights: ["a", {toString: 1}, 2, "b"]})).to.deep.equal({
			highlights: "a, b",
		});
	});

	it("leaves any other highlights to the store's type check", function () {
		// `{}` has no join: it threw here and the app did not start
		expect(readStoredSettings({highlights: {}})).to.deep.equal({highlights: {}});
		expect(readStoredSettings({highlights: "a, b"})).to.deep.equal({highlights: "a, b"});
	});
});
