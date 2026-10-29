import {expect} from "chai";
import en from "../../client/locales/en.json";
import {
	defaultPsWords,
	normalizePsWords,
	psWords,
	SHADOW_WORDS,
	SURFACE_WORDS,
} from "../../client/js/helpers/psWords";

describe("helpers/psWords (the ps theme's Words over the plains setting)", function () {
	it("lists the six treatments in the setting's order, Bubbles first and the default", function () {
		expect(psWords).to.deep.equal(["bubbles", "glass", "scrim", "outline", "rim", "glow"]);
		expect(defaultPsWords).to.equal("bubbles");
		expect([...SURFACE_WORDS, ...SHADOW_WORDS]).to.have.members([...psWords]);
		expect(SURFACE_WORDS).to.deep.equal(["bubbles", "glass", "scrim"]);
		expect(SHADOW_WORDS).to.deep.equal(["outline", "rim", "glow"]);
	});

	it("reads a stored value: a known one as itself, anything else as bubbles", function () {
		for (const w of psWords) {
			expect(normalizePsWords(w)).to.equal(w);
		}

		for (const bad of [undefined, null, "", "halo", 3, {}, "Bubbles"]) {
			expect(normalizePsWords(bad), String(bad)).to.equal("bubbles");
		}
	});

	it("has an English label and a one-line hint for each (Appearance.vue's keys)", function () {
		const catalog = en as Record<string, unknown>;
		const key = (w: string) =>
			`settings.appearance.psWords${w.charAt(0).toUpperCase()}${w.slice(1)}`;

		for (const w of psWords) {
			expect(catalog[key(w)], w).to.be.a("string").and.not.empty;
			expect(catalog[`${key(w)}Hint`], w).to.be.a("string").and.not.empty;
			expect(catalog[`${key(w)}Hint`], w).to.not.include("\n");
		}

		// The two that read under the theme's usual floor by day say so (the
		// build's own figures, docs/projects/ps-words.md §10).
		expect(catalog["settings.appearance.psWordsGlowHint"]).to.include("by day");
		expect(catalog["settings.appearance.psWordsRimHint"]).to.include("by day");
	});
});
