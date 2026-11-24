import {expect} from "chai";
import fs from "fs";
import path from "path";
import {THEME_PAIRS} from "../../client/js/helpers/themeAppearance";
import {THEMES} from "../../client/js/themeRegistry";
import configuration from "../../client/js/configuration";

// The theme registry (docs/resources/themes.md § The theme registry): one
// entry per stylesheet in client/themes/, and nothing it names that the
// build does not have. tools/scenarios/gallery.mjs makes the same check
// against the running app.

const THEMES_DIR = path.join(process.cwd(), "client", "themes");

describe("the theme registry (client/js/themeRegistry.ts)", function () {
	const names = THEMES.map((theme) => theme.name);

	it("has one entry for every client/themes/*.css and a file for every entry", function () {
		const files = fs
			.readdirSync(THEMES_DIR)
			.filter((file) => file.endsWith(".css"))
			.map((file) => file.slice(0, -".css".length));

		// A file name is unique, so a theme named twice is a list longer than the files.
		expect([...names].sort()).to.deep.equal(files.sort());
	});

	it("gives every theme a display name and a colour or none", function () {
		for (const theme of THEMES) {
			expect(theme.displayName, theme.name).to.be.a("string").that.is.not.empty;

			if (theme.themeColor !== null) {
				expect(theme.themeColor, theme.name).to.match(/^#[0-9a-f]{6}$/);
			}
		}
	});

	it("pairs only themes it lists, each in one pair at most", function () {
		const paired = THEME_PAIRS.flat();

		for (const name of paired) {
			expect(names, name).to.include(name);
		}

		expect(new Set(paired).size).to.equal(paired.length);
	});

	it("is the list Settings shows, in its order", function () {
		expect(configuration.themes).to.deep.equal(
			THEMES.map(({name, displayName, themeColor}) => ({name, displayName, themeColor}))
		);
	});
});
