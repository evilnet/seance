import {expect} from "chai";
import {
	assignStoredSettings,
	parseStoredSettings,
	settingsToStore,
	storedChanges,
} from "../../client/js/helpers/settingsSync";
import {migrateStoredSettings} from "../../client/js/helpers/settingsMigration";

describe("settingsSync", function () {
	const defaults = {
		use12hClock: true,
		theme: "coffee",
		fontSize: "large",
		media: true,
		translateAlsoRead: [] as string[],
	};

	describe("parseStoredSettings", function () {
		it("reads nothing from no entry, broken JSON or a non-object", function () {
			expect(parseStoredSettings(null)).to.deep.equal({});
			expect(parseStoredSettings("{")).to.deep.equal({});
			expect(parseStoredSettings("5")).to.deep.equal({});
			expect(parseStoredSettings("null")).to.deep.equal({});
			expect(parseStoredSettings("[1]")).to.deep.equal({});
		});

		it("reads an object as the store does", function () {
			expect(parseStoredSettings('{"theme":"creama","highlights":["a","b"]}')).to.deep.equal({
				theme: "creama",
				highlights: "a, b",
			});
		});
	});

	describe("assignStoredSettings", function () {
		it("takes a stored value only when it has the default's type", function () {
			expect(
				assignStoredSettings(defaults, {use12hClock: "no", theme: "creama", stale: 1})
			).to.deep.equal({...defaults, theme: "creama"});
		});
	});

	describe("settingsToStore", function () {
		it("keeps what another tab stored and this one has not seen", function () {
			// Tab A switched to 24-hour; this tab (B) still holds 12-hour and
			// changes the theme.
			const stored = {...defaults, use12hClock: false};
			const stale = {...defaults};

			expect(settingsToStore(stored, stale, defaults, "theme", "creama")).to.deep.equal({
				...defaults,
				use12hClock: false,
				theme: "creama",
			});
		});

		it("stores a whole object for a fresh profile", function () {
			const state = {...defaults, fontSize: "huge"};
			expect(settingsToStore({}, state, defaults, "theme", "creama")).to.deep.equal({
				...state,
				theme: "creama",
			});
		});

		it("fills what is stored without a usable value from this tab", function () {
			// Saved before `media` existed, and a clock of the wrong type.
			const stored = {use12hClock: "yes", theme: "creama", fontSize: "small"};
			const state = {...defaults, use12hClock: false, media: false};

			expect(settingsToStore(stored, state, defaults, "fontSize", "huge")).to.deep.equal({
				use12hClock: false,
				theme: "creama",
				fontSize: "huge",
				media: false,
				translateAlsoRead: [],
			});
		});

		it("drops keys this build does not know", function () {
			const stored = {...defaults, desktopNotifications: false};
			expect(
				settingsToStore(stored, defaults, defaults, "media", false)
			).to.not.have.property("desktopNotifications");
		});

		it("leaves nothing the upgrade migration would take for a new setting", function () {
			// A stored object missing a key reads as one saved before that
			// setting existed; every write still carries every key.
			const written = settingsToStore(
				{theme: "creama"},
				{...defaults, matchSystemAppearance: true},
				{...defaults, matchSystemAppearance: true},
				"fontSize",
				"huge"
			);
			expect(written).to.have.property("matchSystemAppearance", true);
			expect(
				migrateStoredSettings(written, {...defaults, matchSystemAppearance: true})
			).to.deep.equal(written);
		});
	});

	describe("storedChanges", function () {
		it("finds the setting another tab changed", function () {
			const stored = {...defaults, use12hClock: false};
			expect(storedChanges(stored, defaults, defaults)).to.deep.equal([
				["use12hClock", false],
			]);
		});

		it("finds nothing when this tab already has it", function () {
			expect(storedChanges({...defaults}, defaults, defaults)).to.deep.equal([]);
		});

		it("compares a list by what it holds", function () {
			const state = {...defaults, translateAlsoRead: ["de", "fr"]};
			const stored = {...defaults, translateAlsoRead: ["de", "fr"]};
			expect(storedChanges(stored, state, defaults)).to.deep.equal([]);
			expect(
				storedChanges({...stored, translateAlsoRead: ["de"]}, state, defaults)
			).to.deep.equal([["translateAlsoRead", ["de"]]]);
		});

		it("ignores a stored value of the wrong type and keys it does not know", function () {
			const stored = {...defaults, use12hClock: "no", stale: true};
			expect(storedChanges(stored, defaults, defaults)).to.deep.equal([]);
		});

		it("returns cleared settings to the defaults", function () {
			// Another tab signed out (storage cleared) or removed the entry: a
			// reload here would show the defaults, and keeping this tab's
			// values would write them back with its next change.
			const state = {...defaults, use12hClock: false, theme: "creama"};
			expect(storedChanges({}, state, defaults)).to.deep.equal([
				["use12hClock", true],
				["theme", "coffee"],
			]);
		});

		it("returns a cleared theme to the deploy's default", function () {
			const state = {...defaults, theme: "creama"};
			expect(storedChanges({}, state, {...defaults, theme: "gates"})).to.deep.equal([
				["theme", "gates"],
			]);
		});

		it("keeps a setting another build left out of its write", function () {
			// A tab on a build without `media` changed the clock: its write
			// has no `media`, which this tab has switched off. Only the clock
			// changes here, and this tab's next write stores `media` again.
			const state = {...defaults, media: false};
			const older: Record<string, unknown> = {...defaults, use12hClock: false};
			delete older.media;
			expect(storedChanges(older, state, defaults)).to.deep.equal([["use12hClock", false]]);
			expect(settingsToStore(older, state, defaults, "fontSize", "huge")).to.include({
				media: false,
				use12hClock: false,
			});
		});

		it("keeps this tab's value over a stored one of the wrong type", function () {
			const state = {...defaults, use12hClock: false};
			expect(storedChanges({...defaults, use12hClock: "no"}, state, defaults)).to.deep.equal(
				[]
			);
		});
	});

	it("keeps a change made in one tab through a stale tab's write", function () {
		// The report: A sets 24-hour, B (still 12-hour) changes the font
		// size, and the clock is 12-hour again after a reload.
		let storage = JSON.stringify(defaults);
		const tabA: Record<string, unknown> = assignStoredSettings(
			defaults,
			parseStoredSettings(storage)
		);
		const tabB: Record<string, unknown> = assignStoredSettings(
			defaults,
			parseStoredSettings(storage)
		);

		tabA.use12hClock = false;
		storage = JSON.stringify(
			settingsToStore(parseStoredSettings(storage), tabA, defaults, "use12hClock", false)
		);

		// B writes before it has taken A's change.
		tabB.fontSize = "huge";
		storage = JSON.stringify(
			settingsToStore(parseStoredSettings(storage), tabB, defaults, "fontSize", "huge")
		);

		expect(assignStoredSettings(defaults, parseStoredSettings(storage))).to.deep.equal({
			...defaults,
			use12hClock: false,
			fontSize: "huge",
		});

		// And each tab, once its storage event lands, takes the other's.
		expect(storedChanges(parseStoredSettings(storage), tabB, defaults)).to.deep.equal([
			["use12hClock", false],
		]);
		expect(storedChanges(parseStoredSettings(storage), tabA, defaults)).to.deep.equal([
			["fontSize", "huge"],
		]);
	});
});
