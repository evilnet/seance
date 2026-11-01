import {expect} from "chai";
import {after, before, describe, it} from "mocha";
import sinon from "sinon";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {parsePo, type PoEntry, serializePo} from "../../tools/i18n/po";
import {addToPot} from "../../tools/i18n/add";
import {
	ALLOWED_UNREFERENCED,
	ALLOWED_DYNAMIC,
	adjacentFragments,
	checkPot,
	opensUnclosed,
	collectStaticCallSiteKeys,
} from "../../tools/i18n/check";
import {POT_PATH} from "../../tools/i18n/paths";
import {DEV_ONLY_TAGS, readAvailableLocales} from "../../tools/i18n/available-locales";
import {categoryIndexMap, compileLocales, Catalog, CompileResult} from "../../tools/i18n/compile";
import {parseTargets, TARGETS_SOURCE} from "../../tools/i18n/targets";
import {
	countsReadingSlot,
	PLURAL_RULES,
	planPluralSlots,
	pluralEval,
} from "../../tools/i18n/plural";
import {isRTL} from "../../client/js/i18n/core";
import {pseudo} from "../../tools/i18n/pseudo";
import {mergePo} from "../../tools/i18n/merge";
import {
	fenceSpans,
	fromTags,
	planEngines,
	substituteLabels,
	targetName,
	toTags,
	unfenceSpans,
} from "../../tools/i18n/fill";
import {protect, restoreAll} from "../../client/js/translate/spans";
import {scaffoldTag} from "../../tools/i18n/scaffold";
import {pluralEchoes, sweepEntries} from "../../tools/i18n/sweep";
import {isSuspectCatalogEntry, repad, slotVerdict} from "../../tools/i18n/quality";
import {EXPECTED_SCRIPTS, OWN_SCRIPTS} from "../../tools/i18n/scripts";
import instrument from "../../tools/i18n/instrument-loader.mjs";

const FIXTURES = resolve("tools/i18n/fixtures");

interface AvailableEntry {
	tag: string;
	devOnly?: boolean;
}

describe("i18n toolchain", () => {
	let tmp: string;

	before(() => {
		tmp = mkdtempSync(join(tmpdir(), "seance-i18n-"));
	});

	after(() => {
		rmSync(tmp, {recursive: true, force: true});
	});

	/** Compile one fixture tree into its own scratch directory. */
	function compileFixture(name: string): CompileResult {
		const outDir = join(tmp, name.split("/").join("-"));
		return compileLocales({
			localesDir: join(FIXTURES, name),
			outDir,
			availablePath: join(outDir, "available.ts"),
			tagsPath: join(outDir, "tags.json"),
		});
	}

	describe("po", () => {
		it("round-trips headers, translator comments, flags and previous lines byte for byte", () => {
			const text = [
				'msgid ""',
				'msgstr ""',
				'"Project-Id-Version: seance\\n"',
				'"Language: de\\n"',
				'"MIME-Version: 1.0\\n"',
				'"Content-Type: text/plain; charset=UTF-8\\n"',
				'"Content-Transfer-Encoding: 8bit\\n"',
				'"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
				'"Last-Translator: Jane Doe <jane@example.com>\\n"',
				'"PO-Revision-Date: 2026-09-17 12:00+0000\\n"',
				'"X-Generator: Poedit 3.4\\n"',
				"",
				"# translator note",
				"#. Button on the connect form: submits it and dials the server.",
				"#: client/components/Windows/Connect.vue:295",
				"#, no-wrap",
				'#| msgid "old"',
				'msgctxt "connect.submit"',
				'msgid "Connect"',
				'msgstr "Verbinden"',
				"",
			].join("\n");

			const {headers, headerOrder, entries} = parsePo(text);
			expect(headers["last-translator"]).to.equal("Jane Doe <jane@example.com>");
			expect(headers["po-revision-date"]).to.equal("2026-09-17 12:00+0000");
			expect(headers["x-generator"]).to.equal("Poedit 3.4");
			expect(entries[0].translatorComments).to.deep.equal(["translator note"]);
			expect(entries[0].previous).to.deep.equal(['msgid "old"']);
			expect(entries[0].flags).to.deep.equal(["no-wrap"]);

			const again = serializePo(headers, entries, headerOrder);
			expect(again).to.equal(text);
		});
	});

	describe("compile", () => {
		it("maps a CLDR category to the gettext slot of the count CLDR samples it with", () => {
			// The probe is what CLDR's categories expect, not what gettext's
			// expression hits first: CLDR puts pt's 0 in "one" while the
			// expression (n != 1) puts it in slot 1, so scanning from n = 0
			// used to send "one" to the plural slot and leave the singular
			// slot unreadable (pt lost condensed.away entirely).
			expect(categoryIndexMap("pt", "n != 1")).to.deep.equal({one: 0, other: 1});
			// tr's (n > 1) is 0 at n = 0, where CLDR says "other" — the
			// singular slot would swallow the plural.
			expect(categoryIndexMap("tr", "(n > 1)")).to.deep.equal({one: 0, other: 1});
			// A five-slot rule, every category reached by an integer.
			expect(
				categoryIndexMap("ga", "(n==1) ? 0 : (n==2) ? 1 : (n<7) ? 2 : (n<11) ? 3 : 4")
			).to.deep.equal({one: 0, two: 1, few: 2, many: 3, other: 4});
			// ru has no integer in CLDR "other" (it is the fractions'
			// category), so "other" takes the expression's catch-all slot.
			expect(
				categoryIndexMap(
					"ru",
					"(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2)"
				)
			).to.deep.equal({one: 0, few: 1, many: 2, other: 2});
			// fa is not a shipped target, but its rule is in the table and
			// "n > 0 ? 1 : 0" sent both categories to slot 1 — the singular
			// for every count, invisibly (the slot is filled, so the
			// all-or-nothing gate is happy).
			expect(categoryIndexMap("fa", PLURAL_RULES.fa.expr)).to.deep.equal({
				one: 0,
				other: 1,
			});
		});

		it("omits a plural entry that has not filled every mapped slot", () => {
			// "partial.plural" carries msgstr[0] only. A half-translated
			// plural rendered every count as the singular; the key is left
			// out instead, so the runtime serves the whole entry from en.
			const warn = sinon.stub(console, "warn");

			try {
				const result = compileFixture("compile/fuzzy");
				expect(result.catalogs.fr).to.not.have.property("partial.plural");
			} finally {
				warn.restore();
			}
		});

		it("maps a de.po plural entry through nplurals=2 onto the CLDR categories", () => {
			expect(new Intl.PluralRules("de").select(1)).to.equal("one");
			expect(new Intl.PluralRules("de").select(3)).to.equal("other");

			const result = compileFixture("compile/plural");
			expect(result.catalogs.de).to.deep.equal({
				"condensed.join": {
					one: "{count} Benutzer ist beigetreten",
					other: "{count} Benutzer sind beigetreten",
				},
				"connect.submit": "Verbinden",
			});
			// The written file parses back to the same catalog.
			const written = JSON.parse(
				readFileSync(join(tmp, "compile-plural", "de.json"), "utf8")
			);
			expect(written).to.deep.equal(result.catalogs.de);
		});

		it("drops a plural whose count-less form CLDR also serves for other counts", () => {
			// fil's CLDR "one" covers 0, 2, 3, 5, … and ru's covers 21, 31, …:
			// a "once" compiled there read "once" for five. de's "one" is 1
			// alone, so the same shape is sound there.
			expect(new Intl.PluralRules("fil").select(5)).to.equal("one");
			const warn = sinon.stub(console, "warn");

			try {
				const result = compileFixture("compile/countless");
				expect(result.catalogs.fil).to.not.have.property("condensed.away");
				expect(result.catalogs.de["condensed.away"]).to.deep.equal({
					one: "einmal als abwesend markiert",
					other: "{count}-mal als abwesend markiert",
				});
				expect(result.warnings.join("\n")).to.match(/condensed\.away.*"one" form/);
			} finally {
				warn.restore();
			}
		});

		it("prunes a compiled catalog whose tag is no longer a target", () => {
			// A dropped language leaves its .po behind (sync.ts archives it)
			// but its compiled catalog used to sit in client/locales until
			// someone deleted it by hand — and the build copies whatever is
			// there into public/.
			const outDir = join(tmp, "compile-plural");
			compileFixture("compile/plural");
			writeFileSync(join(outDir, "zz.json"), "{}\n");
			compileFixture("compile/plural");
			expect(existsSync(join(outDir, "zz.json")), "stray zz.json pruned").to.equal(false);
			// The catalogs of this run, and the generated tag list, stay.
			expect(existsSync(join(outDir, "de.json"))).to.equal(true);
			expect(existsSync(join(outDir, "en.json"))).to.equal(true);
			expect(existsSync(join(outDir, "tags.json"))).to.equal(true);
		});

		it("compiles en from the pot itself: the msgids are the English copy", () => {
			const result = compileFixture("compile/plural");
			expect(result.catalogs.en).to.deep.equal({
				"condensed.join": {
					one: "{count} user has joined",
					other: "{count} users have joined",
				},
				"connect.submit": "Connect",
			});
		});

		it("skips #, fuzzy entries and warns about them on stderr", () => {
			const warn = sinon.stub(console, "warn");

			try {
				const result = compileFixture("compile/fuzzy");
				// The fuzzy entry is left out entirely so the runtime falls back
				// to en for its key.
				expect(result.catalogs.fr).to.deep.equal({"good.key": "Bon"});
				expect(result.warnings.join("\n")).to.match(/fuzzy\.target/);
				expect(warn.calledWithMatch(/fuzzy\.target/)).to.equal(true);
				expect(result.warnings.join("\n")).to.not.contain("untranslated.key");
			} finally {
				warn.restore();
			}
		});

		it("fails on a {placeholder} the translation lost, naming the key", () => {
			expect(() => compileFixture("compile/placeholder")).to.throw(/activity\.join/);
		});

		it("omits untranslated entries so the runtime falls back to en", () => {
			// "untranslated.key" (singular) and "untranslated.plural" (no filled
			// category) carry no translation in the fixture. The runtime falls
			// back to en on key ABSENCE, so a present-but-empty value would
			// shadow en: compile leaves the key out entirely — without
			// inventing a translation and without failing.
			const warn = sinon.stub(console, "warn");

			try {
				const result = compileFixture("compile/fuzzy");
				expect(result.catalogs.fr).to.deep.equal({"good.key": "Bon"});
				expect(result.warnings.join("\n")).to.not.contain("untranslated.key");
				expect(result.warnings.join("\n")).to.not.contain("untranslated.plural");
			} finally {
				warn.restore();
			}
		});

		it("keeps the intentional empty copy in en.json and omits it from qqx", () => {
			// "intentional.empty" is English copy that happens to be empty
			// (like connect.signInIntro): en.json keeps it verbatim, while the
			// qqx overlay leaves it out — en serves the key at runtime.
			const warn = sinon.stub(console, "warn");

			try {
				const result = compileFixture("compile/fuzzy");
				expect(result.catalogs.en["intentional.empty"]).to.equal("");
				expect(result.catalogs.qqx).to.not.have.property("intentional.empty");
			} finally {
				warn.restore();
			}
		});
	});

	describe("pseudo locale", () => {
		it("qqx mirrors en: same keys, same text in every plural category", () => {
			const result = compileFixture("compile/plural");
			const en = result.catalogs.en;
			const qqx = result.catalogs.qqx;
			expect(Object.keys(qqx).sort()).to.deep.equal(Object.keys(en).sort());
			const forms = qqx["condensed.join"] as Record<string, string>;
			expect(forms.one).to.equal(forms.other);
			expect(forms.one).to.contain("{count}");
			// Written next to the real catalogs.
			const written = JSON.parse(
				readFileSync(join(tmp, "compile-plural", "qqx.json"), "utf8")
			);
			expect(written).to.deep.equal(qqx);
		});

		it("pseudo() wraps in RLE/PDF, doubles the text, keeps {name} tokens", () => {
			const out = pseudo("{count} users have joined");
			expect(out.startsWith("\u202B")).to.equal(true);
			expect(out.endsWith("\u202C")).to.equal(true);
			const inner = out.slice(1, -1);
			expect(inner.length % 2).to.equal(0);
			expect(inner.slice(inner.length / 2)).to.equal(inner.slice(0, inner.length / 2));
			expect(out).to.contain("{count}");
			// Brackets mirror, letters turn into accented lookalikes.
			expect(pseudo("(a)")).to.equal("\u202B)à()à(\u202C");
		});
	});

	describe("the committed catalogs", () => {
		// The REAL shipped files, not fixtures: qqx is regenerated from en on
		// every compile, so these two pins fail the moment the generator and
		// the compile rulings drift apart (committed en.json is the source of
		// truth for both).
		const en = JSON.parse(readFileSync(resolve("client/locales/en.json"), "utf8")) as Catalog;
		const qqx = JSON.parse(readFileSync(resolve("client/locales/qqx.json"), "utf8")) as Catalog;

		/** An en value with nothing in it: the intentional-empty copy the
		 * compile ruling keeps out of qqx (en serves the key at runtime). */
		const isEmptyEn = (value: string | Record<string, string>): boolean =>
			value === "" || Object.keys(value).length === 0;

		it("covers every en key whose en value is non-empty, and nothing else", () => {
			const expected = Object.keys(en).filter((key) => !isEmptyEn(en[key]));
			expect(expected.length, "en keys the runtime can serve").to.be.greaterThan(0);
			expect(
				expected.filter((key) => !(key in qqx)),
				"non-empty en keys missing from qqx"
			).to.deep.equal([]);
			expect(
				Object.keys(qqx).filter((key) => !(key in en) || isEmptyEn(en[key])),
				"keys qqx carries without a translatable en value"
			).to.deep.equal([]);
			expect(Object.keys(qqx).length).to.equal(expected.length);
		});

		it("carries every plural category the en entry has, with the same doubled text", () => {
			const pluralKeys = Object.keys(en).filter(
				(key) => typeof en[key] !== "string" && !isEmptyEn(en[key])
			);
			expect(pluralKeys.length, "en plural entries").to.be.greaterThan(0);

			for (const key of pluralKeys) {
				const enCats = Object.keys(en[key] as Record<string, string>);
				const forms = qqx[key];

				expect(forms, `${key} is plural under qqx too`).to.be.an("object");
				// Same categories, none missing, none invented.
				expect(
					Object.keys(forms as Record<string, string>).sort(),
					`${key} categories`
				).to.deep.equal([...enCats].sort());
				// The rig's shape: one text in every category, RLE-wrapped,
				// so every plural form renders right-to-left.
				const texts = new Set(Object.values(forms as Record<string, string>));
				expect(texts.size, `${key} carries one text across its categories`).to.equal(1);
				const text = (forms as Record<string, string>)[enCats[0]];
				expect(text.startsWith("\u202B"), `${key} is RLE-wrapped`).to.equal(true);
			}
		});

		it("compiles a real key to exactly what pseudo() makes of its en value", () => {
			// The generator now lives in tools/i18n/pseudo.ts; this rider pins
			// the moved code to the committed output: one real singular key,
			// end to end from en.json through pseudo() to qqx.json.
			const key = "connect.submit";
			const enValue = en[key];
			expect(enValue, "a singular en copy to pin").to.be.a("string");
			expect(qqx[key]).to.equal(pseudo(enValue as string));
		});
	});

	describe("generated available.ts and tags.json", () => {
		it("parses and lists en, the fixture's tag and the dev-only pseudo locale", () => {
			compileFixture("compile/plural");
			const text = readFileSync(join(tmp, "compile-plural", "available.ts"), "utf8");
			const literal = /export const AVAILABLE = ([\s\S]*?) as const;/.exec(text);
			expect(literal).to.not.equal(null);
			// The generated literal is TS (bare keys, trailing comma); read it
			// back as JSON by quoting the keys and dropping the comma.
			const json = literal![1]
				.replace(/([{,]\s*)(\w+):/g, '$1"$2":')
				.replace(/,(\s*\])$/, "$1");
			const available = JSON.parse(json) as AvailableEntry[];
			expect(available).to.deep.equal([
				{tag: "en"},
				{tag: "de"},
				{tag: "qqx", devOnly: true},
			]);
			expect(text).to.contain("export type AvailableLocale = ");
			// No DEV constant: the runtime reads the bundler's own NODE_ENV
			// fold (core.ts DEV_I18N), so a tracked generated file never
			// carries a build mode.
			expect(text).to.not.contain("DEV");
			// The pre-paint list carries the rig too — it is the generated
			// file, mode-free like available.ts; webpack.config.ts drops the
			// dev-only tags when it bakes the list into index.html.
			expect(
				JSON.parse(readFileSync(join(tmp, "compile-plural", "tags.json"), "utf8"))
			).to.deep.equal(["en", "de", "qqx"]);
		});

		it("the pre-paint list drops the dev-only rig for a production build only", () => {
			// webpack.config.ts bakes this list into index.html, so it is the
			// one consumer that cannot fold on NODE_ENV at runtime. Asserted
			// on the real generated file, through the very function
			// webpack.config.ts calls.
			const file = resolve("client/locales/tags.json");
			const development = readAvailableLocales(file, false);
			const production = readAvailableLocales(file, true);
			const all = JSON.parse(readFileSync(file, "utf8")) as string[];

			expect(development).to.deep.equal(all);
			expect(DEV_ONLY_TAGS.length).to.be.greaterThan(0);

			for (const tag of DEV_ONLY_TAGS) {
				expect(development, `${tag} in a development build`).to.include(tag);
				expect(production, `${tag} out of a production build`).to.not.include(tag);
			}

			expect(production).to.deep.equal(all.filter((tag) => !DEV_ONLY_TAGS.includes(tag)));
			expect(() => readAvailableLocales(resolve("client/locales/nope.json"), false)).to.throw(
				'run "yarn i18n:compile" first'
			);
		});

		it("the lazy locale import excludes the rig and the tag list in production", () => {
			// Nothing in this suite bundles, so the magic comment is what
			// there is to pin: without it a production build emits a chunk
			// for qqx.json and one for tags.json, neither of which it can
			// ever load (F27).
			const source = readFileSync(resolve("client/js/i18n/index.ts"), "utf8");

			expect(source).to.contain('process.env.NODE_ENV === "production"');
			expect(source).to.match(
				/webpackExclude: \/\(qqx\|tags\)\\\.json\$\/[\s\S]{0,80}locales\/\$\{tag\}\.json/
			);
		});

		it("writes the same available.ts and tags.json whatever NODE_ENV says", () => {
			// The generated files are tracked, and `yarn watch`, `yarn test:e2e`
			// and a bare `webpack` skip the compile: a mode-dependent generator
			// meant those builds shipped whichever flavor was committed last,
			// and that a production build dirtied the tree.
			const read = () => ({
				available: readFileSync(join(tmp, "compile-plural", "available.ts"), "utf8"),
				tags: readFileSync(join(tmp, "compile-plural", "tags.json"), "utf8"),
			});

			compileFixture("compile/plural");

			const development = read();
			const saved = process.env.NODE_ENV;

			process.env.NODE_ENV = "production";

			try {
				compileFixture("compile/plural");
			} finally {
				process.env.NODE_ENV = saved;
			}

			expect(read()).to.deep.equal(development);
			// qqx.json itself is generated either way (the rig's artifact);
			// the production copy into public/ is what leaves it out
			// (webpack.config.ts CopyPlugin).
			expect(existsSync(join(tmp, "compile-plural", "qqx.json"))).to.equal(true);
		});
	});

	describe("scaffold", () => {
		it("writes one empty msgstr slot per nplurals, not always two", () => {
			// ru's rule has three forms. Two slots meant the fill could never
			// write the third, and the compile then dropped every plural key.
			const dir = join(tmp, "scaffold");
			mkdirSync(dir, {recursive: true});
			copyFileSync(join(FIXTURES, "compile/plural/messages.pot"), join(dir, "messages.pot"));
			expect(scaffoldTag("ru", dir)).to.equal(true);

			const {headers, entries} = parsePo(readFileSync(join(dir, "ru.po"), "utf8"));
			expect(headers["plural-forms"]).to.contain("nplurals=3;");

			const plural = entries.find((entry) => entry.msgctxt === "condensed.join");
			expect(plural?.msgstr).to.deep.equal(["", "", ""]);
			const singular = entries.find((entry) => entry.msgctxt === "connect.submit");
			expect(singular?.msgstr).to.deep.equal([""]);
		});
	});

	describe("the plural slot planner", () => {
		// What fill.ts translates into each gettext slot. The singular form
		// belongs to the slot the expression yields for n = 1 — slot 0 for
		// (n != 1), but slot 1 where the rule orders them the other way —
		// and every other slot
		// translates msgid_plural. The fill used to write one slot and leave
		// the rest empty, which the compile then dropped (or, worse, served
		// as the singular for every count).
		const entry = {msgid: "marked away once", msgidPlural: "marked away {count} times"};

		it("sends msgid to the n = 1 slot and msgid_plural to every other one", () => {
			expect(planPluralSlots(entry, 2, "n != 1")).to.deep.equal([
				{index: 0, source: "msgid"},
				{index: 1, source: "msgidPlural"},
			]);
			// A rule that does not put the singular first: slot 1 is the one
			// n = 1 reads, so that is where msgid goes. (No target ships this
			// shape — fa's rule was one and is now "n > 1" — but the planner
			// must not assume slot 0.)
			expect(planPluralSlots(entry, 2, "n > 0 ? 1 : 0")).to.deep.equal([
				{index: 0, source: "msgidPlural"},
				{index: 1, source: "msgid"},
			]);
			expect(
				planPluralSlots(
					entry,
					3,
					"(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2)"
				)
			).to.deep.equal([
				{index: 0, source: "msgid"},
				{index: 1, source: "msgidPlural"},
				{index: 2, source: "msgidPlural"},
			]);
			// One slot (ja, zh, ko, th, vi): the only form has to serve every
			// count, so it translates the plural text — the one carrying
			// {count}. The n = 1 rule is for languages that HAVE a singular.
			expect(planPluralSlots(entry, 1, "0")).to.deep.equal([
				{index: 0, source: "msgidPlural"},
			]);
		});

		it("maps a target's categories onto distinct slots — all nplurals of them", () => {
			// Two categories sharing one slot is the bug that made fa's
			// "n > 0 ? 1 : 0" render the singular for every count: both
			// categories read slot 1, which the fill writes msgid into, and
			// the all-or-nothing gate cannot see it (the slot IS filled).
			// Scoped to the shipped targets: cy's four-form rule genuinely
			// collapses categories onto slots and is not a target.
			const targets = parseTargets(readFileSync(TARGETS_SOURCE, "utf8"));
			expect(targets.length, "target languages").to.be.greaterThan(0);

			for (const {tag} of targets) {
				const rule = PLURAL_RULES[tag];
				expect(rule, `${tag} has a plural rule`).to.not.equal(undefined);

				const slots = Object.values(categoryIndexMap(tag, rule.expr));
				expect(new Set(slots).size, `${tag} distinct slots`).to.equal(rule.nplurals);
			}
		});

		it("gives every rule in the table as many slots as its expression yields", () => {
			// The invariant compileEntry now depends on: too few slots and the
			// map asks for an index the fill never writes, so the key is
			// dropped however well it is translated; too many (ru said 4 for a
			// three-branch rule) and the fill translates a slot nothing reads.
			for (const [tag, rule] of Object.entries(PLURAL_RULES)) {
				let highest = 0;

				for (let n = 0; n <= 999; n++) {
					highest = Math.max(highest, pluralEval(rule.expr, n));
				}

				expect(rule.nplurals, `${tag} nplurals`).to.equal(highest + 1);
			}
		});

		it("gives the singular only to a slot that n = 1 alone reads, by CLDR", () => {
			// The runtime picks a slot through Intl.PluralRules, not the gettext
			// expression: fil's "one" also serves 0, 2, 3, 5, 7, …, ru's and uk's
			// 21, 31, …, fr's and pt's 0. Those slots translate the plural
			// text, the one carrying {count}; de's and pl's "one" is 1 alone.
			const plan = (tag: string) =>
				planPluralSlots(entry, PLURAL_RULES[tag].nplurals, PLURAL_RULES[tag].expr, tag).map(
					(slot) => slot.source
				);

			expect(countsReadingSlot("fil", PLURAL_RULES.fil.expr, 0).slice(0, 6)).to.deep.equal([
				0, 1, 2, 3, 5, 7,
			]);
			expect(plan("fil")).to.deep.equal(["msgidPlural", "msgidPlural"]);
			expect(plan("ru")).to.deep.equal(["msgidPlural", "msgidPlural", "msgidPlural"]);
			expect(plan("fr")).to.deep.equal(["msgidPlural", "msgidPlural"]);
			expect(plan("de")).to.deep.equal(["msgid", "msgidPlural"]);
			expect(plan("pl")).to.deep.equal(["msgid", "msgidPlural", "msgidPlural"]);
			// ar: slot 0 is "zero", slot 1 "one" (1 alone) takes the singular.
			expect(plan("ar")[1]).to.equal("msgid");
			expect(plan("ar")[0]).to.equal("msgidPlural");
		});

		it("plans nothing for a singular entry", () => {
			expect(planPluralSlots({msgid: "Connect"}, 2, "n != 1")).to.deep.equal([]);
		});
	});

	describe("sweep", () => {
		/** Parse a sweep fixture and empty what its placeholders no longer match. */
		function sweepFixture(tag: string) {
			const {entries} = parsePo(readFileSync(join(FIXTURES, "sweep", `${tag}.po`), "utf8"));
			const outcome = sweepEntries(entries, PLURAL_RULES[tag], tag);
			return {entries, ...outcome};
		}

		it("checks a one-form locale's only slot against the plural text it holds", () => {
			// ja, zh, ko, th and vi have one form and it translates
			// msgid_plural, so it carries {count} while the msgid does not.
			// Checked against msgid, every such slot is emptied — and the next
			// fill writes it again: a silent fill/sweep loop.
			const {entries} = sweepFixture("ja");
			const kept = entries.find((entry) => entry.msgctxt === "condensed.away");
			expect(kept?.msgstr[0], "the plural text survives").to.equal("{count}回離席しました");

			const lost = entries.find((entry) => entry.msgctxt === "condensed.back");
			expect(lost?.msgstr[0], "the slot that lost {count} is emptied").to.equal("");

			const singular = entries.find((entry) => entry.msgctxt === "connect.submit");
			expect(singular?.msgstr[0]).to.equal("接続");
		});

		it("keeps a plural form that reads as the English when its sibling is translated", () => {
			// "{count} Byte" is German's singular; refusing it alone sent the
			// whole key back to English. Both forms echoing is still an echo.
			const entry = (msgstr: string[]): PoEntry => ({
				translatorComments: [],
				context: [],
				loc: [],
				flags: [],
				previous: [],
				msgctxt: "oper.report.bytes",
				msgid: "{count} byte",
				msgidPlural: "{count} bytes",
				msgstr,
			});
			const kept = entry(["{count} Byte", "{count} Byte"]);
			const echoed = entry(["{count} byte", "{count} bytes"]);
			sweepEntries([kept, echoed], PLURAL_RULES.de, "de");
			expect(kept.msgstr).to.deep.equal(["{count} Byte", "{count} Byte"]);
			expect(echoed.msgstr).to.deep.equal(["", ""]);
		});

		it("reports (and keeps) plural forms that are one text across counts", () => {
			// ru condensed.join had "пользователей" for 2 as well as for 5: the
			// fill copied one English plural into few and many alike. Not an
			// error -- a label frame is the same for every count -- so the
			// report lists it for review and empties nothing.
			const entry = (key: string, msgstr: string[]) => ({
				translatorComments: [],
				context: [],
				loc: [],
				flags: [],
				previous: [],
				msgctxt: key,
				msgid: "{count} user has joined",
				msgidPlural: "{count} users have joined",
				msgstr,
			});
			const echoed = entry("condensed.join", [
				"{count} пользователь вошёл",
				"{count} пользователей вошли",
				"{count} пользователей вошли",
			]);
			const sound = entry("condensed.left", [
				"{count} пользователь вышел",
				"{count} пользователя вышли",
				"{count} пользователей вышли",
			]);
			expect(pluralEchoes([echoed, sound], PLURAL_RULES.ru, "ru")).to.deep.equal([
				{key: "condensed.join", slots: [1, 2], counts: [2, 0]},
			]);
			expect(echoed.msgstr[1]).to.equal("{count} пользователей вошли");
			// Two forms (de) cannot disagree that way.
			expect(pluralEchoes([echoed], PLURAL_RULES.de, "de")).to.deep.equal([]);
		});

		it("checks every slot of a three-form locale, not just the first two", () => {
			// Slots >= 2 (ru, pl, uk, cs, sk, ro — and ar's six) were never
			// brace-checked at all, so a form that ate {count} reached the
			// compile, which then refuses the whole catalog.
			const {entries} = sweepFixture("ru");
			const entry = entries.find((item) => item.msgctxt === "condensed.away");
			// Slot 0 is emptied too: ru's CLDR "one" also serves 21, 31, …, so
			// it translates the plural text, and "однажды" has no {count}.
			expect(entry?.msgstr).to.deep.equal(["", "помечено {count} раза", ""]);
		});

		it("empties a machine answer that loops, runs away or leaves the script", () => {
			const {entries, reports} = sweepFixture("de");
			const text = (key: string, slot = 0) =>
				entries.find((entry) => entry.msgctxt === key)?.msgstr[slot];

			expect(text("channel.close"), "the loop").to.equal("");
			expect(text("connect.username"), "six times the English").to.equal("");
			expect(text("connect.password"), "Devanagari in a Latin locale").to.equal("");
			// An ordinary translation is left where it is.
			expect(text("connect.submit")).to.equal("Verbinden");
			// Per slot: each is judged against the English text IT holds, so
			// the German singular survives its Cyrillic plural.
			expect(text("condensed.away", 0)).to.equal("einmal abwesend gemeldet");
			expect(text("condensed.away", 1)).to.equal("");

			expect(reports).to.deep.equal([
				{key: "channel.close", reason: "degenerate"},
				{key: "connect.username", reason: "runaway-length"},
				{key: "connect.password", reason: "foreign-script"},
				{key: "condensed.away", reason: "foreign-script"},
			]);
		});

		describe("isSuspectCatalogEntry", () => {
			it("allows Latin everywhere and each target its own writing system", () => {
				expect(isSuspectCatalogEntry("ru", "Connect", "Подключиться")).to.equal(null);
				expect(isSuspectCatalogEntry("th", "Connect", "เชื่อมต่อ")).to.equal(null);
				expect(isSuspectCatalogEntry("ko", "Connect", "연결")).to.equal(null);
				expect(isSuspectCatalogEntry("zh", "Connect", "连接")).to.equal(null);
				// Brand names and untranslatable terms stay Latin.
				expect(isSuspectCatalogEntry("ja", "Connect to IRC", "IRC に接続")).to.equal(null);
				// The marks that carry no script of their own: a Japanese long
				// vowel and an Arabic tatweel are letters whose Script is
				// Common, so a bare \p{Script=…} table would empty both.
				expect(isSuspectCatalogEntry("ja", "Computer", "コンピューター")).to.equal(null);
				expect(isSuspectCatalogEntry("ar", "Connect", "اتصـــال")).to.equal(null);
				// A {placeholder}'s name belongs to the deploy, not to the
				// translator, so nothing inside the braces is judged.
				expect(
					isSuspectCatalogEntry("de", "Network {ネット}", "Netzwerk {ネット}")
				).to.equal(null);
			});

			it("names the reason, judging the loop first", () => {
				expect(isSuspectCatalogEntry("fi" as string, "Close", "ไม่")).to.equal(null);
				expect(isSuspectCatalogEntry("de", "Close", "Sluit ~~~~~~")).to.equal("degenerate");
				expect(isSuspectCatalogEntry("de", "Close", "x".repeat(41))).to.equal(
					"runaway-length"
				);
				expect(isSuspectCatalogEntry("de", "Close", "x".repeat(40))).to.equal(null);
				expect(isSuspectCatalogEntry("fr", "Password", "パスワード")).to.equal(
					"foreign-script"
				);
				// Cyrillic is not Ukrainian's mistake, and is not German's answer.
				expect(isSuspectCatalogEntry("uk", "Password", "Пароль")).to.equal(null);
				expect(isSuspectCatalogEntry("de", "Password", "Пароль")).to.equal(
					"foreign-script"
				);
			});
		});

		describe("slotVerdict", () => {
			// fill.ts cannot be imported (it runs main() on import), so the
			// verdict the fill refuses a slot by lives in quality.ts and is
			// tested here. The fill and the sweep MUST judge by the same one:
			// a fill that writes back what the sweep empties is a loop.
			it("refuses a run of English inside an answer, the old msgid's included", () => {
				// The echo rule sees only an answer that is ALL its current
				// English; these shipped through it.
				expect(
					slotVerdict(
						"ja",
						"{nick} is now known as {newNick}",
						"{nick} が now known as {newNick} になりました"
					)
				).to.equal("english");
				expect(
					slotVerdict("fr", "{count} users were kicked", "{count} users have been kicked")
				).to.equal("english");
				// One quoted menu word, a command in capitals, a word the target
				// writes itself: not English prose.
				expect(
					slotVerdict("fil", "Choose Add to Dock…", "Piliin ang Add to Dock…")
				).to.equal(null);
				expect(
					slotVerdict("pl", "Nobody matches WHO {mask}", "Nikt nie pasuje do WHO {mask}")
				).to.equal(null);
				expect(
					slotVerdict(
						"de",
						"{nick} has joined the channel",
						"{nick} ist dem Kanal beigetreten"
					)
				).to.equal(null);
			});

			it("is what the fill refuses a filled slot by, and the sweep empties one by", () => {
				expect(slotVerdict("de", "Password", "Passwort")).to.equal(null);
				expect(slotVerdict("de", "Password", "पासवर्ड")).to.equal("foreign-script");
				expect(
					slotVerdict(
						"de",
						"Username",
						"Benutzername, also der Name, unter dem du dich hier anmeldest und der dann oben steht"
					)
				).to.equal("runaway-length");
				expect(slotVerdict("de", "Close", "zu zu zu zu zu")).to.equal("degenerate");
				// The brace gate the fill had of its own, judged against the
				// slot's own source: a plural form carries {count} where the
				// singular does not.
				expect(slotVerdict("de", "Network {network}", "Netzwerk {netz}")).to.equal(
					"placeholder"
				);
				expect(
					slotVerdict("de", "marked away {count} times", "{count}-mal abwesend")
				).to.equal(null);
			});

			it("refuses an answer with none of the target's own script in it", () => {
				// Latin is allowed in every catalog (brand names, protocol
				// words, {placeholder} names), so an answer in the wrong
				// LATIN language passed every other rule: uk shipped French,
				// Polish, Malay and invented pseudo-Welsh.
				expect(slotVerdict("uk", "Connection lost", "connexion perdue")).to.equal(
					"foreign-script:no-target-script"
				);
				expect(slotVerdict("uk", "Edit this network", "Edytuj ten sieć")).to.equal(
					"foreign-script:no-target-script"
				);
				expect(slotVerdict("uk", "Cancel upload", "Cance upload")).to.equal(
					"foreign-script:no-target-script"
				);
				expect(isSuspectCatalogEntry("ja", "Translate", "Translation")).to.equal(
					"foreign-script:no-target-script"
				);
				// Its own script is all it takes; so is a body that is only
				// product words, acronyms and language tags, which every
				// catalog writes the same way.
				expect(slotVerdict("uk", "Close", "Закрити")).to.equal(null);
				expect(slotVerdict("ja", "Translation", "翻訳")).to.equal(null);
				expect(
					slotVerdict("ru", "OPUS-MT {from} → {to} (CPU)", "OPUS-MT {from} → {to} (CPU)")
				).to.equal(null);
				// A Latin-script target is judged by the old rule alone.
				expect(slotVerdict("de", "Connection lost", "Verbindung verloren")).to.equal(null);
			});

			it("refuses an answer that is its English source again", () => {
				// The engines hand the English back often enough to fill a
				// catalog with it (uk came back 864 entries English) and
				// nothing else notices: Latin letters are allowed in every
				// script, the length is right, the placeholders match.
				expect(slotVerdict("uk", "Close", "Close")).to.equal("unchanged");
				expect(slotVerdict("cs", "Channel", "channel.")).to.equal("unchanged");
				expect(
					slotVerdict("fil", "Currently open {type}", "Currently open {type}")
				).to.equal("unchanged");
				// A real translation is not an echo, and neither is a word
				// every language writes the same way or a source with no
				// letters of its own to translate.
				expect(slotVerdict("uk", "Close", "Закрити")).to.equal(null);
				expect(slotVerdict("de", "OK", "OK")).to.equal(null);
				expect(slotVerdict("de", "{count}", "{count}")).to.equal(null);
				// Oper jargon is kept as is, so a plural slot can read the
				// same as the English and still be the translation.
				expect(slotVerdict("hu", "{count} G-line", "{count} G-line")).to.equal(null);
				expect(slotVerdict("de", "Kill", "Kill")).to.equal(null);
				expect(slotVerdict("de", "Kill this user", "Kill this user")).to.equal("unchanged");
			});

			it("refuses an answer that dropped the source's own padding", () => {
				// A msgid with a space at one end has it on purpose: it is
				// rendered beside something else (a screen-reader prefix
				// before a nick). Every engine trims its answer, so all 23
				// catalogs came back with the padding gone and the two texts
				// ran together — and nothing else noticed, because the words
				// themselves were a fine translation.
				expect(slotVerdict("de", "Nickname: ", "Name:")).to.equal("padding");
				expect(
					slotVerdict("de", " The file includes it.", "Die Datei enthält es.")
				).to.equal("padding");
				// Kept, and the words judged as usual.
				expect(slotVerdict("de", "Nickname: ", "Name: ")).to.equal(null);
				expect(slotVerdict("de", "Nickname: ", "Nickname: ")).to.equal("unchanged");
				// Padding the source does not have is refused the same way:
				// it would show as a gap nobody asked for.
				expect(slotVerdict("de", "Close", " Schließen")).to.equal("padding");
				expect(slotVerdict("de", "Close", "Schließen ")).to.equal("padding");
				// An unpadded source is not judged on whitespace at all, and
				// an all-whitespace slot is nobody's mistake.
				expect(slotVerdict("de", "Close", "Schließen")).to.equal(null);
				expect(slotVerdict("de", " ", " ")).to.equal(null);
			});

			it("refuses a machine-translation artifact the source never carried", () => {
				// What NLLB and OPUS-MT leave behind when they run out of
				// sentence: a sentencepiece control token written out as text
				// (_BAR_ for a pipe), a stray musical note, an HTML entity
				// where the source has a plain character, and an underscore
				// glued onto the end of the sentence. 22 ru entries shipped
				// with one, and every other gate found them well-formed.
				expect(
					slotVerdict(
						"ru",
						"Enter the password for {account} to connect.",
						"Введите пароль для {account} для подключения._"
					)
				).to.equal("artifact");
				expect(
					slotVerdict(
						"ru",
						"Cannot join {channel}.",
						"Невозможно присоединиться к {channel}._BAR_"
					)
				).to.equal("artifact");
				expect(
					slotVerdict(
						"ru",
						"You already have {max} aliases.",
						"У вас уже есть {max} псевдонимы ♫ Aliases."
					)
				).to.equal("artifact");
				expect(
					slotVerdict(
						"ru",
						"Client-to-client protocol",
						"Протокол &quot; клиент-клиент &quot;"
					)
				).to.equal("artifact");
				// An underscore the SOURCE carries is copy, not an artifact:
				// two catalogs name the character the way the English does,
				// and a placeholder or a code span may hold a snake_case
				// identifier of the deploy's own.
				expect(
					slotVerdict(
						"de",
						"Alias names are letters, digits, _ and - (up to {max} characters).",
						"Alias-Namen sind Buchstaben, Ziffern, _ und - (bis zu {max} Zeichen)."
					)
				).to.equal(null);
				expect(slotVerdict("de", "Rename {old_name}", "{old_name} umbenennen")).to.equal(
					null
				);
				expect(
					slotVerdict(
						"de",
						"Type `/alias my_alias` to start",
						"Tippe `/alias my_alias` zum Starten"
					)
				).to.equal(null);
			});

			it("refuses a Latin stray the English never had", () => {
				// Glued to Han, kana or Thai, where the mixed-script rule
				// cannot see a word: all three shipped in the catalogs.
				expect(slotVerdict("ja", "Variant", "変iaz")).to.equal("stray-latin");
				expect(
					slotVerdict(
						"ja",
						"Highlight messages that mention you",
						"あなたをmentionsするメッセージをハイライトする"
					)
				).to.equal("stray-latin");
				expect(
					slotVerdict("th", "Toggle Markdown rendering.", "ตั้งค่าการเรnder Markdown")
				).to.equal("stray-latin");
				expect(
					slotVerdict(
						"ko",
						"Expand all previews in the current channel (opposite of {command})",
						"현재 채널의 모든 미리보기를 펼칩니다 (Commands의 반대: {command})"
					)
				).to.equal("stray-latin");
				// Another Latin language inside Arabic prose.
				expect(
					slotVerdict(
						"ar",
						"Lines others send are shown with a translation underneath.",
						"تظهر الأ líneas الأخرى مع ترجمة تحتها."
					)
				).to.equal("stray-latin");

				// A word of the source, or one it begins (the answer dropped
				// the ending), an acronym, a hyphenated jargon word, and any
				// Latin in a Latin-script catalog: copy.
				expect(
					slotVerdict("ja", "Toggle Markdown rendering.", "Markdownの表示を切り替える")
				).to.equal(null);
				expect(slotVerdict("ko", "Killed {nick}.", "{nick}을(를) kill했습니다.")).to.equal(
					null
				);
				expect(
					slotVerdict("ko", "The bot that takes G-lines", "G-line을 처리하는 봇")
				).to.equal(null);
				expect(slotVerdict("ja", "Connect", "IRCに接続")).to.equal(null);
				expect(slotVerdict("de", "Variant", "Variante")).to.equal(null);
			});

			it("refuses a word that mixes two scripts", () => {
				// ru came back with "нickname" — a Cyrillic н glued to the
				// English word the model gave up on. Every other gate found it
				// well-formed: the answer is mostly Cyrillic, so the script
				// rules pass, and the English word is not the whole text, so
				// the echo rule passes.
				expect(
					slotVerdict(
						"ru",
						") a user from the current channel. This can be a nickname or a hostmask.",
						") Пользователя из текущего канала. Это может быть нickname или hostmask."
					)
				).to.equal("mixed-script");

				// A whole Latin word inside Cyrillic prose is how every
				// catalog writes a protocol word or a brand, and a hyphen or a
				// {placeholder} ends a word like any other separator.
				expect(slotVerdict("ru", "Connect to IRC", "Подключиться к IRC")).to.equal(null);
				expect(slotVerdict("ru", "{count} bytes", "{count} байт")).to.equal(null);
				expect(
					slotVerdict(
						"ru",
						"The WebSocket closed.",
						"Соединение WebSocket закрыто, IRC-сеть недоступна."
					)
				).to.equal(null);

				// Japanese writes Han, Hiragana and Katakana in one run with
				// no spaces, so a "word" there is a whole clause: it is never
				// judged by this rule. Thai writes without spaces too, and a
				// Latin token glued to Thai is one such clause, not a mangled
				// word.
				expect(slotVerdict("ja", "Connect to IRC", "IRCサーバーに接続します")).to.equal(
					null
				);
				expect(
					slotVerdict(
						"th",
						"No message to react to: none here carries a msgid.",
						"ไม่มีข้อความใดที่มีmsgid"
					)
				).to.equal(null);

				// A combining mark carries the Script_Extensions of every
				// script that uses it, so a marked word is not a mixed one:
				// U+0301 is the Russian stress accent.
				expect(slotVerdict("ru", "word", "сло́во")).to.equal(null);
			});

			it("refuses an answer that doubled the source's full stop", () => {
				// ru shipped "…в этом браузере.." and "…сеть IRC..." for
				// sources ending in one period: the engine padded the end of
				// a sentence it had already finished.
				expect(
					slotVerdict(
						"ru",
						"Manage the IRC networks saved in this browser.",
						"Управлять сетями IRC, сохраненными в этом браузере.."
					)
				).to.equal("artifact");
				expect(
					slotVerdict(
						"ru",
						"Send a raw message to the current IRC network.",
						"Отправьте сообщение в текущую сеть IRC..."
					)
				).to.equal("artifact");

				// A source that ends in an ellipsis of its own — "…" or the
				// three periods some copy writes — is asking for exactly that
				// back, and a single period matching a single period is the
				// normal case.
				expect(slotVerdict("de", "Loading…", "Wird geladen…")).to.equal(null);
				expect(slotVerdict("de", "Loading...", "Wird geladen...")).to.equal(null);
				expect(slotVerdict("de", "Close the window.", "Fenster schließen.")).to.equal(null);
			});

			it("refuses an answer that dropped one of the source's sentences", () => {
				// A destructive confirmation lost the sentence that said so:
				// de's clear-history dialog kept the question and dropped
				// "This cannot be undone." Nothing else noticed — the length
				// is right, the script is right, the placeholders match.
				expect(
					slotVerdict(
						"de",
						"Are you sure you want to clear history for {channel}? This cannot be undone.",
						"Bist du sicher, dass du die Geschichte für {channel} löschen willst?"
					)
				).to.equal("sentences");
				expect(
					slotVerdict(
						"de",
						"Disconnected from {host}{detail}. Not reconnecting.",
						"Von {host}{detail} getrennt."
					)
				).to.equal("sentences");
				// Both sentences there, in the punctuation the target writes
				// them with: a CJK full stop needs no space after it, and a
				// semicolon is a break a translator may legitimately choose.
				expect(
					slotVerdict(
						"ja",
						"This app only connects to {network}. The link to {host} was ignored.",
						"このアプリは {network} にのみ接続します。{host} へのリンクは無視されました。"
					)
				).to.equal(null);
				expect(
					slotVerdict(
						"de",
						"Are you sure you want to clear history for {channel}? This cannot be undone.",
						"Willst du den Verlauf für {channel} wirklich löschen? Das kann nicht rückgängig gemacht werden."
					)
				).to.equal(null);
				// A one-sentence source is not judged on sentence count at
				// all, an abbreviation is not a sentence end, and an ellipsis
				// before a number is a continuation rather than a full stop.
				expect(slotVerdict("de", "Connection lost.", "Verbindung verloren")).to.equal(null);
				expect(
					slotVerdict("de", "Nick postfix (e.g. ', ')", "Nick-Postfix (z. B. ', ')")
				).to.equal(null);
				expect(
					slotVerdict(
						"ja",
						"Downloading {model}… {percent}%",
						"{model}のダウンロード…{percent}%"
					)
				).to.equal(null);
				// Thai marks a sentence break with a space, not with
				// punctuation, so there is nothing for this rule to count.
				expect(
					slotVerdict(
						"th",
						"Disconnected from {host}{detail}. Not reconnecting.",
						"แยกตัวจาก {host}{detail} ไม่พยายามเชื่อมต่อใหม่"
					)
				).to.equal(null);
			});

			it("re-pads a fill's answer rather than refusing it", () => {
				// What fill.ts does before it judges: the engine trims, the
				// source's own ends go back on, and the verdict is then about
				// the words. Nothing is invented for a source with no padding,
				// and an answer with nothing in it is left alone.
				expect(repad("Nickname: ", "Name:")).to.equal("Name: ");
				expect(repad(" It includes it.", "Es enthält es.")).to.equal(" Es enthält es.");
				expect(repad("Close", "  Schließen ")).to.equal("Schließen");
				expect(repad("Nickname: ", "")).to.equal("");
				expect(slotVerdict("de", "Nickname: ", repad("Nickname: ", "Name:"))).to.equal(
					null
				);
			});
		});
	});

	describe("the fill's engine plan and prompt", () => {
		it("--force-engine overrides the route table's placement", () => {
			// ru is OPUS-placed by routes.default.ts; --engine only scopes to
			// that placement, --force-engine moves it.
			expect(planEngines(["ru"], {})).to.deep.equal([{tag: "ru", engine: "opus"}]);
			expect(planEngines(["ru"], {engine: "llm"})).to.deep.equal([]);
			expect(planEngines(["ru"], {forceEngine: "llm"})).to.deep.equal([
				{tag: "ru", engine: "llm"},
			]);
		});

		it("names the target language for the prompt instead of passing the tag", () => {
			// "translate into uk" came back in English (UK).
			expect(targetName("uk")).to.equal("Ukrainian");
			expect(targetName("fil")).to.equal("Filipino");
		});
	});

	describe("the fill's placeholder protection", () => {
		it("fences a catalog placeholder so the protection carries it", () => {
			// spans.ts protects chat syntax; a {placeholder} is none of it, so
			// the fill fences each one as a code span first — and the engine
			// then only ever sees a numbered marker.
			const fenced = fenceSpans("Connecting to {network} as {nick}…");
			expect(fenced).to.equal("Connecting to `{network}` as `{nick}`…");

			const info = protect(fenced, {nicks: [], markers: "tags"});
			expect(info.text).to.equal("Connecting to \u27E61\u27E7 as \u27E62\u27E7…");

			// What an engine hands back, with the sentence translated around
			// the markers it was told to keep.
			const answer = info.text
				.replace("Connecting to", "Verbinde mit")
				.replace(" as ", " als ");
			expect(unfenceSpans(restoreAll(answer, info))).to.equal(
				"Verbinde mit {network} als {nick}…"
			);
		});

		it("fences an unkeyed quoted segment and a protocol token so they come back verbatim", () => {
			// A quoted segment with no key of its own and a protocol word are
			// not prose: ru answered "or pick \"No authentication\" there"
			// with "выберите \"No trible\"" and de turned "SASL PLAIN" into
			// "SASL-PLATZ". Fenced, the engine never sees either, and the
			// marker gate refuses an answer that loses one.
			const fenced = fenceSpans('or pick "No authentication" there (SASL PLAIN over TLS)');
			expect(fenced).to.equal(
				'or pick `"No authentication"` there (`SASL PLAIN` over `TLS`)'
			);

			const info = protect(fenced, {nicks: [], markers: "placeholder"});
			expect(info.text).to.equal(
				"or pick \u27E61\u27E7 there (\u27E62\u27E7 over \u27E63\u27E7)"
			);

			const answer = info.text
				.replace("or pick", "oder wähle")
				.replace(" there (", " dort (")
				.replace(" over ", " über ");
			expect(unfenceSpans(restoreAll(answer, info))).to.equal(
				'oder wähle "No authentication" dort (SASL PLAIN über TLS)'
			);
		});

		it("leaves a quoted UI label with a key of its own unfenced", () => {
			// connect.saslRequiredHint tells the user to pick the button
			// form.noAuth renders, and that button is in their language: the
			// label has to be translated with the sentence, not carried
			// through in English. A quoted segment matching no msgid is not a
			// label and is still fenced.
			const labels = new Set(["No authentication", "Connect"]);

			expect(
				fenceSpans('or pick "No authentication" there to connect (TLS)', labels)
			).to.equal('or pick "No authentication" there to connect (`TLS`)');

			expect(fenceSpans('or pick "foo" there', labels)).to.equal('or pick `"foo"` there');
		});

		it("matches the label against the msgid as the po parser decodes it", () => {
			// The fill builds its label set from the catalog's own entries, so
			// the carve-out only fires if parsePo hands back the DECODED text:
			// a msgid holding \" on disk is a plain quote in the sentence the
			// fence runs over.
			const {entries} = parsePo(
				[
					'msgid ""',
					'msgstr ""',
					"",
					'msgctxt "form.noAuth"',
					'msgid "No authentication"',
					'msgstr ""',
					"",
					'msgctxt "connect.saslRequiredHint"',
					'msgid "Pick \\"No authentication\\" to skip SASL."',
					'msgstr ""',
					"",
				].join("\n")
			);

			const labels = new Set(entries.map((entry) => entry.msgid).filter(Boolean));
			const hint = entries.find((e) => e.msgctxt === "connect.saslRequiredHint")!;

			expect(fenceSpans(hint.msgid, labels)).to.equal(
				'Pick "No authentication" to skip `SASL`.'
			);
		});

		it("puts the catalog's own translation of a label into the answer", () => {
			// The carve-out lets the model translate the label, and the model
			// invents a different button every time it is asked. What the user
			// has to find is the string form.noAuth renders, so the answer's
			// quoted segment is replaced with that catalog's own msgstr —
			// keeping the answer's own quotation marks, since a German answer
			// quotes with „…“.
			const labels = new Map([
				["No authentication", "Keine Authentifizierung"],
				["Connect", ""],
			]);

			expect(
				substituteLabels(
					'Pick "No authentication" to skip SASL.',
					"Wähle „Keine Anmeldung“, um SASL zu überspringen.",
					labels
				)
			).to.equal("Wähle „Keine Authentifizierung“, um SASL zu überspringen.");

			// A label the catalog has not translated yet keeps what the model
			// wrote: English serves both the button and the sentence.
			expect(
				substituteLabels('Press "Connect" now.', "Нажмите «Подключить» сейчас.", labels)
			).to.equal("Нажмите «Подключить» сейчас.");

			// A quoted segment that is no key at all is left alone, and so is
			// an answer that came back with a different number of quoted
			// segments — nothing then says which segment is which.
			expect(substituteLabels('Say "hello".', "Sag „hallo“.", labels)).to.equal(
				"Sag „hallo“."
			);
			expect(
				substituteLabels('Pick "No authentication".', "Wähle etwas aus.", labels)
			).to.equal("Wähle etwas aus.");
		});

		it("reads a quoted label in the target's own quotation marks", () => {
			// The label rules run over both texts, and an answer quotes the
			// way its language does: „…“, «…», 「…」.
			const labels = new Set(["No authentication"]);

			expect(fenceSpans("wähle „No authentication“ aus", labels)).to.equal(
				"wähle „No authentication“ aus"
			);
			expect(fenceSpans("выберите «No authentication» там", labels)).to.equal(
				"выберите «No authentication» там"
			);
			expect(fenceSpans("「No authentication」を選択", labels)).to.equal(
				"「No authentication」を選択"
			);

			// The two curly pairs most catalogs actually write: “…” in 15 of
			// them, „…” in hu, pl and ro. Missing either one leaves
			// substituteLabels with no quoted segment to work on there.
			expect(fenceSpans("vyberte “No authentication” tam", labels)).to.equal(
				"vyberte “No authentication” tam"
			);
			expect(fenceSpans("válaszd a „No authentication” lehetőséget", labels)).to.equal(
				"válaszd a „No authentication” lehetőséget"
			);
			expect(
				substituteLabels(
					'Pick "No authentication" to skip SASL.',
					"Válaszd a „Nincs hitelesítés” lehetőséget.",
					new Map([["No authentication", "Nincs autentikáció"]])
				)
			).to.equal("Válaszd a „Nincs autentikáció” lehetőséget.");
			expect(
				substituteLabels(
					'Pick "No authentication" to skip SASL.',
					"Vyberte “Žádné ověření” zde.",
					new Map([["No authentication", "Bez ověřování"]])
				)
			).to.equal("Vyberte “Bez ověřování” zde.");
			expect(fenceSpans("wähle „SASL PLAIN“ aus", labels)).to.equal(
				"wähle `„SASL PLAIN“` aus"
			);
		});

		it("fences a quoted label around a {placeholder} as one span", () => {
			// The two quoted msgids that hold nothing but a placeholder:
			// fencing the quotes and the braces separately would nest, so the
			// quoted segment wins and carries the brace back untouched.
			const fenced = fenceSpans('Upload failed: no "{field}" URL');
			expect(fenced).to.equal('Upload failed: no `"{field}"` URL');

			const info = protect(fenced, {nicks: [], markers: "placeholder"});
			expect(info.text).to.equal("Upload failed: no \u27E61\u27E7 URL");
			expect(unfenceSpans(restoreAll(info.text, info))).to.equal(
				'Upload failed: no "{field}" URL'
			);
		});

		it("speaks the seq2seq engines' marker form both ways", () => {
			// ⟦n⟧ is not in the Marian vocabulary — measured, it comes back as
			// ",1," — so the seq2seq routes are handed <n> and mapped back.
			expect(toTags("Connecting to \u27E61\u27E7…")).to.equal("Connecting to <1>…");
			expect(fromTags("Verbindung zu < 1 >…")).to.equal("Verbindung zu \u27E61\u27E7…");
			expect(fromTags(toTags("a \u27E61\u27E7 b \u27E62\u27E7"))).to.equal(
				"a \u27E61\u27E7 b \u27E62\u27E7"
			);
		});
	});

	describe("merge", () => {
		const options = {
			potPath: join(FIXTURES, "merge/messages.pot"),
			poPath: join(FIXTURES, "merge/de.po"),
			tag: "de",
		};

		it("keeps msgstr on exact match, fuzzies drift, appends new keys empty, drops orphans", () => {
			const outcome = mergePo(options);
			expect(outcome.added).to.deep.equal(["condensed.join"]);
			expect(outcome.fuzzied).to.deep.equal(["connect.title"]);
			expect(outcome.dropped).to.deep.equal(["old.key"]);

			const {headers, entries} = parsePo(outcome.text);
			expect(entries.map((entry) => entry.msgctxt)).to.deep.equal([
				"connect.title",
				"help.about",
				"condensed.join",
			]);
			// Drifted: the pot's msgid is adopted, the translation survives, the
			// entry is marked for review.
			expect(entries[0].msgid).to.equal("Connect to IRC");
			expect(entries[0].msgstr).to.deep.equal(["Mit IRC verbinden"]);
			// The drift mark is ADDED to the flags the entry carried; a
			// fuzzy entry that drifts again does not collect two marks.
			expect(entries[0].flags).to.deep.equal(["c-format", "fuzzy"]);
			expect(entries[0].context).to.deep.equal([
				"Heading of the connect form (features.signIn off).",
			]);
			expect(entries[0].loc).to.deep.equal(["client/components/Windows/Connect.vue:107"]);
			// Exact match: translation kept, no fuzzy.
			expect(entries[1].msgstr).to.deep.equal(["Über"]);
			expect(entries[1].flags).to.deep.equal([]);
			// New from the pot: plural shape, empty slots.
			expect(entries[2].msgid).to.equal("{count} user has joined");
			expect(entries[2].msgidPlural).to.equal("{count} users have joined");
			expect(entries[2].msgstr).to.deep.equal(["", ""]);
			expect(entries[2].flags).to.deep.equal([]);
			// And it round-trips.
			expect(parsePo(outcome.text).entries).to.deep.equal(entries);
		});

		it("keeps the catalog's own translator comments", () => {
			// "#." and "#:" are the pot's to own; a "# " note is the
			// translator's and must survive a merge.
			const {entries} = parsePo(mergePo(options).text);
			const about = entries.find((entry) => entry.msgctxt === "help.about");
			expect(about?.translatorComments).to.deep.equal([
				"Kept short: the Help window's link column is narrow.",
			]);
			expect(about?.context).to.deep.equal(["About link in the Help window."]);
		});

		it("rewrites the Language and Plural-Forms headers from plural-rules.json", () => {
			const {headers} = parsePo(mergePo(options).text);
			expect(headers.language).to.equal("de");
			expect(headers["plural-forms"]).to.equal("nplurals=2; plural=(n != 1);");
		});
	});

	describe("add", () => {
		const args = {
			key: "connect.title",
			msgid: "Connect to IRC",
			context: ["Heading of the connect form."],
			loc: ["client/js/branding.ts"],
		};

		it("creates the pot on first use, then upserts idempotently", () => {
			const potPath = join(tmp, "add", "messages.pot");
			const first = addToPot(potPath, args);
			expect(first.created).to.equal(true);
			expect(first.drifted).to.equal(false);
			const {headers, entries} = parsePo(first.text);
			expect(headers.language).to.equal("");
			expect(headers["plural-forms"]).to.equal("nplurals=2; plural=(n != 1);");
			expect(entries).to.deep.equal([
				{
					translatorComments: [],
					context: ["Heading of the connect form."],
					loc: ["client/js/branding.ts"],
					flags: [],
					previous: [],
					msgctxt: "connect.title",
					msgid: "Connect to IRC",
					// serializePo writes `msgstr ""`; parsing it back yields [""].
					msgstr: [""],
				},
			]);

			// The same call again: no new entry, no drift, same bytes.
			const again = addToPot(potPath, args);
			expect(again.created).to.equal(false);
			expect(again.drifted).to.equal(false);
			expect(parsePo(again.text).entries).to.deep.equal(entries);
		});

		it("replaces context, unions loc, sorts by key and flags msgid drift", () => {
			const potPath = join(tmp, "add-drift", "messages.pot");
			addToPot(potPath, {key: "b.key", msgid: "B", context: ["One."], loc: ["a.ts:1"]});
			addToPot(potPath, {key: "a.key", msgid: "A", context: ["Two.", "Three."], loc: []});

			const outcome = addToPot(potPath, {
				key: "b.key",
				msgid: "B2",
				context: ["Replaced."],
				loc: ["b.ts:2"],
			});
			expect(outcome.created).to.equal(false);
			expect(outcome.drifted).to.equal(true);

			const {entries} = parsePo(readFileSync(potPath, "utf8"));
			expect(entries.map((entry) => entry.msgctxt)).to.deep.equal(["a.key", "b.key"]);
			expect(entries[1].context).to.deep.equal(["Replaced."]);
			expect(entries[1].loc).to.deep.equal(["a.ts:1", "b.ts:2"]);
			expect(entries[1].msgid).to.equal("B2");
		});

		it("adds plural entries with empty msgstr slots", () => {
			const potPath = join(tmp, "add-plural", "messages.pot");
			addToPot(potPath, {
				key: "condensed.join",
				msgid: "{count} user has joined",
				plural: "{count} users have joined",
				context: ["Condensed."],
				loc: [],
			});
			const {entries} = parsePo(readFileSync(potPath, "utf8"));
			expect(entries[0].msgidPlural).to.equal("{count} users have joined");
			expect(entries[0].msgstr).to.deep.equal(["", ""]);
		});
	});

	describe("check", () => {
		const potPath = join(FIXTURES, "check/messages.pot");
		const tree = join(FIXTURES, "check/client");

		it("fails a call-site key that is missing from the pot", () => {
			const problems = checkPot(potPath, [tree]);
			expect(problems.missing).to.deep.equal(["widget.missing"]);
		});

		it("fails a pot key that no call site references", () => {
			const problems = checkPot(potPath, [tree]);
			expect(problems.unreferenced).to.deep.equal(["orphan.key"]);
		});

		it("fails a pot entry without a #. context line", () => {
			const problems = checkPot(potPath, [tree]);
			expect(problems.missingContext).to.deep.equal(["nocontext.key"]);
		});

		it("flags English that opens a parenthesis it never closes", () => {
			// One t() followed by an element is no adjacent pair, so Help's
			// "(opposite of" + <code>/collapse</code> + ")" passed the scan;
			// de closed the fragment itself and the page read "…(Opposit von)
			// /collapse)".
			expect(
				opensUnclosed("Expand all previews in the current channel (opposite of")
			).to.equal(true);
			expect(opensUnclosed("Expand all previews (opposite of {command})")).to.equal(false);
			expect(opensUnclosed("Bytes: {count} (of {total})")).to.equal(false);
			// A placeholder's own text is not the sentence's.
			expect(opensUnclosed("Shown as {open(}")).to.equal(false);
		});

		it("flags a sentence cut into t() fragments around an element in a template", () => {
			// `combined` sees only `+`; Help.vue's "{{ t('connectA') }} <code>port</code>
			// {{ t('connectB') }}" passed check and reached translators as
			// "starts with a".
			expect(
				adjacentFragments(
					'<template>\n<p>\n{{ t("a") }} <code>port</code>\n{{ t("b") }}\n</p>\n</template>'
				)
			).to.deep.equal([3]);
			// A fragment inside a link of the same sentence is one too.
			expect(
				adjacentFragments('<p>{{ t("a") }}\n<a href="x">{{ t("b") }}</a>.</p>')
			).to.deep.equal([1]);
			// Separate elements, a hint beside a label, a line break: not one sentence.
			expect(
				adjacentFragments('<p>{{ t("a") }} <code>x</code></p>\n<p>{{ t("b") }}</p>')
			).to.deep.equal([]);
			expect(
				adjacentFragments(
					'<label>{{ t("a") }} <span class="opt-hint">{{ t("b") }}</span></label>'
				)
			).to.deep.equal([]);
			expect(adjacentFragments('<p>{{ t("a") }}<br />{{ t("b") }}</p>')).to.deep.equal([]);
			// The script block is not a template.
			expect(
				adjacentFragments(
					'<template><p>{{ t("a") }}</p></template>\n<script>const x = `{{ t("b") }} <i/> {{ t("c") }}`</script>'
				)
			).to.deep.equal([]);
		});

		it("collects a single-quoted key as a call site, not an unreferenced one", () => {
			// t('widget.singleQuoted') in widget.ts — CALL_SITE must accept
			// single quotes the same as double quotes.
			const keys = collectStaticCallSiteKeys(tree);
			expect(keys.has("widget.singleQuoted")).to.equal(true);

			const problems = checkPot(potPath, [tree]);
			expect(problems.unreferenced).to.not.include("widget.singleQuoted");
			expect(problems.missing).to.not.include("widget.singleQuoted");
			// A single-quoted literal is still a literal: the assembled-site
			// scan must not mistake it for a non-literal key.
			expect(problems.dynamic).to.deep.equal([]);
		});

		it("reports a non-literal brandingT() call as a dynamic site", () => {
			const potDir = mkdtempSync(join(tmpdir(), "seance-i18n-brandingt-"));
			const clientDir = join(potDir, "client");
			mkdirSync(clientDir, {recursive: true});
			writeFileSync(
				join(potDir, "messages.pot"),
				'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n'
			);
			writeFileSync(
				join(clientDir, "branded.ts"),
				["const someVar = pick();", "brandingT(someVar);"].join("\n")
			);

			const problems = checkPot(join(potDir, "messages.pot"), [clientDir]);
			expect(problems.dynamic).to.deep.equal([
				{file: "branded.ts", line: 2, kind: "key", code: "brandingT(someVar);"},
			]);

			rmSync(potDir, {recursive: true, force: true});
		});

		it("reports a translated fragment glued to brandingT() as combined", () => {
			const potDir = mkdtempSync(join(tmpdir(), "seance-i18n-brandingt-combined-"));
			const clientDir = join(potDir, "client");
			mkdirSync(clientDir, {recursive: true});
			writeFileSync(
				join(potDir, "messages.pot"),
				'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n' +
					'\n#. k\nmsgctxt "k"\nmsgid "K"\nmsgstr ""\n'
			);
			writeFileSync(join(clientDir, "branded.ts"), 'const s = "x " + brandingT("k");');

			const problems = checkPot(join(potDir, "messages.pot"), [clientDir]);
			expect(problems.dynamic).to.deep.equal([
				{
					file: "branded.ts",
					line: 1,
					kind: "combined",
					code: 'const s = "x " + brandingT("k");',
				},
			]);

			rmSync(potDir, {recursive: true, force: true});
		});

		it("ignores commented-out call sites and the i18n implementation itself", () => {
			const problems = checkPot(potPath, [tree]);
			// "widget.gone" appears only in a comment and "i18n.internal" only
			// in the i18n implementation directory: neither is a call site, so
			// the missing list stays at the one genuinely missing key.
			expect(problems.missing).to.deep.equal(["widget.missing"]);
		});

		it("flags every assembled call site, naming file, line and kind", () => {
			// The dynamic fixture carries every assembly shape: a variable
			// key, a template-literal key, a literal glued to code, a
			// translated fragment concatenated with a literal and with
			// another call. The two lookalikes (obj.t(, function t() {) must
			// not appear. DOLLAR keeps the expected source text out of a
			// ${…} string (the lint rule reads that as an interpolation).
			const DOLLAR = "$";
			const templateKeySite = `t(\`prefix.${DOLLAR}{key}\`);`;
			const problems = checkPot(join(FIXTURES, "dynamic/messages.pot"), [
				join(FIXTURES, "dynamic/client"),
			]);
			expect(problems.dynamic).to.deep.equal([
				{file: "js/dynamic.ts", line: 3, kind: "key", code: "t(key);"},
				{file: "js/dynamic.ts", line: 4, kind: "key", code: templateKeySite},
				{
					file: "js/dynamic.ts",
					line: 5,
					kind: "combined",
					code: 't("glued." + key);',
				},
				{
					file: "js/dynamic.ts",
					line: 6,
					kind: "combined",
					code: 'const joined = t("clean.key") + " more";',
				},
				{
					file: "js/dynamic.ts",
					line: 7,
					kind: "combined",
					code: 'const gluedCall = "see " + t("clean.key");',
				},
			]);
		});

		it("honours the assembled-site ledger and reports stale entries", () => {
			const options = {
				allowedDynamic: new Set(["js/dynamic.ts", "js/clean.ts"]),
			};
			const problems = checkPot(
				join(FIXTURES, "dynamic/messages.pot"),
				[join(FIXTURES, "dynamic/client")],
				options
			);
			// The whole file is ledgered: its sites are excused, clean.ts's
			// zero hits visible for the staleness check.
			expect(problems.dynamic).to.deep.equal([]);
			expect(problems.dynamicHits["js/dynamic.ts"]).to.equal(5);
			expect(problems.dynamicHits["js/clean.ts"]).to.equal(undefined);
		});
	});

	describe("translation targets", () => {
		// The generated selector list vs its source of truth, the curated
		// translation-languages.txt, and the direction facts the selector
		// derives from it.
		const committed = JSON.parse(
			readFileSync(resolve("client/js/i18n/targets.ts"), "utf8")
				.replace(/^[\s\S]*?export const TRANSLATION_TARGETS = /, "")
				.replace(/ as const;[\s\S]*$/, "")
		) as {tag: string; en: string}[];

		it("targets.ts is exactly translation-languages.txt, in order", () => {
			const parsed = parseTargets(readFileSync(TARGETS_SOURCE, "utf8"));
			expect(parsed.length, "target languages").to.be.greaterThan(0);
			expect(committed).to.deep.equal(parsed);
		});

		it("maps every name to a unique lowercase primary tag", () => {
			const tags = committed.map((target) => target.tag);
			expect(new Set(tags).size).to.equal(tags.length);

			for (const tag of tags) {
				expect(tag, `${tag} is a primary subtag`).to.match(/^[a-z]{2,3}$/);
			}
		});

		it("marks the right-to-left targets, and only those", () => {
			// core's RTL_TAGS decides direction at runtime; the target list
			// must agree with it for every tag it offers.
			const rtl = committed.filter((target) => isRTL(target.tag)).map((t) => t.tag);
			expect(new Set(rtl)).to.deep.equal(new Set(["ar"]));
		});

		it("writes each language's own name for the one RTL target", () => {
			// The selector's label is Intl.DisplayNames of the tag itself —
			// the native name, never the English one. Pinned for the RTL
			// target (where a wrong name would hide the language from its
			// own readers) and German as an LTR spot check; Node's CLDR and
			// browsers agree on these mainstream tags.
			const native = (tag: string) =>
				new Intl.DisplayNames([tag], {type: "language"}).of(tag);
			expect(native("ar")).to.equal("العربية");
			expect(native("de")).to.equal("Deutsch");
			expect(native("en")).to.equal("English");
		});
	});

	describe("the instrument loader", () => {
		const ctx = {resourcePath: "/repo/client/components/Foo.vue"};

		it("renames non-literal t()/tCount() calls to the dynamic globals", () => {
			const out = instrument.call(
				ctx,
				[
					"const a = t(foo);",
					"const b = tCount(bar, n);",
					'const c = t("static.key");',
					'const d = tCount("static.k", n);',
					"const e = obj.t(x);",
					"// t(commented)",
					'const s = "call t(str) later";',
				].join("\n")
			) as string;
			expect(out).to.contain("__tDyn(foo)");
			expect(out).to.contain("__tDynC(bar, n)");
			expect(out).to.contain('t("static.key")');
			expect(out).to.contain('tCount("static.k", n)');
			expect(out).to.contain("obj.t(x)");
			expect(out).to.not.contain("__tDyn(commented");
			expect(out).to.contain("call t(str) later");
		});

		it("masks only the <script> block of a .vue file, so template prose can't desync the scan", () => {
			// The lone apostrophe in "don't" used to be read as a JS string
			// delimiter with no matching close ahead of it, which swallowed
			// everything after it — the whole <script> block included — as
			// one long "string" and masked it from the scan.
			const src = [
				"<template>",
				"  <p>don't stop</p>",
				"</template>",
				"<script>",
				"const a = t(foo);",
				'const s = "embed t(str) inside a literal";',
				"</script>",
			].join("\n");
			const out = instrument.call(
				{resourcePath: "/repo/client/components/Weird.vue"},
				src
			) as string;
			expect(out).to.contain("__tDyn(foo)");
			expect(out).to.contain('"embed t(str) inside a literal"');
		});

		it("stands down for the implementation's own files", () => {
			const src = "const a = t(foo);";
			expect(instrument.call({resourcePath: "/repo/client/js/i18n/core.ts"}, src)).to.equal(
				src
			);
			expect(instrument.call({resourcePath: "/repo/client/js/branding.ts"}, src)).to.equal(
				src
			);
		});
	});

	describe("the live tree", () => {
		it("gives every shipped catalog a writing system to be judged by", () => {
			// The sweep's script rules are table-driven: a tag missing from
			// EXPECTED_SCRIPTS is never judged on its script at all, so a new
			// language could ship machine noise in the wrong alphabet and the
			// sweep would pass it. The tables must therefore cover every tag
			// that has a catalog -- the archived ones under attic/ are
			// deliberately not targets and are not read.
			const tags = readdirSync(resolve("client/locales"))
				.filter((name) => name.endsWith(".po"))
				.map((name) => name.replace(/\.po$/, ""));
			expect(tags.length, "catalogs to cover").to.be.greaterThan(0);
			expect(
				tags.filter((tag) => !(tag in EXPECTED_SCRIPTS)),
				"tags with a .po and no EXPECTED_SCRIPTS entry"
			).to.deep.equal([]);

			// A target whose own script is demanded must be allowed to write
			// in it, and in Latin besides: OWN_SCRIPTS says what a sentence
			// has to contain, EXPECTED_SCRIPTS what a character may be, and a
			// script in the first that is missing from the second would empty
			// every entry of that catalog. Compared by the regexes themselves
			// — the tables share their constants, so identity is the check.
			for (const [tag, own] of Object.entries(OWN_SCRIPTS)) {
				const allowed = EXPECTED_SCRIPTS[tag] ?? [];

				for (const script of own) {
					expect(
						allowed.includes(script),
						`${tag} demands ${String(script)} and is not allowed to write it`
					).to.equal(true);
				}

				expect(
					allowed.some((script) => script.test("Latin")),
					`${tag} must allow Latin for brand names and {placeholder}s`
				).to.equal(true);
			}
		});

		it("messages.pot and the real client/ call sites agree", () => {
			// The gate Task 6 Step 1 mandates: from this task on, yarn test
			// fails when a t()/tCount() key is missing from the pot or a pot
			// key is referenced by no call site. Runs against the real tree,
			// not the fixtures.
			const problems = checkPot(POT_PATH, [resolve("client")]);
			expect(problems.missing).to.deep.equal([]);
			expect(problems.unreferenced).to.deep.equal([]);
			expect(problems.missingContext).to.deep.equal([]);
			// No assembled call sites outside the ledger: every t() key is a
			// literal and no translated fragment is glued into a sentence
			// (the runtime warnings' build-time half — the ledger in
			// ALLOWED_DYNAMIC is the only way out, and every entry must
			// still be earning its place).
			expect(problems.dynamic).to.deep.equal([]);

			for (const file of ALLOWED_DYNAMIC) {
				expect(
					problems.dynamicHits[file],
					`${file} is on the assembled-site ledger but has no site left — remove the entry`
				).to.be.greaterThan(0);
			}
		});

		it("keeps every allowlisted key pinned to the source that resolves it", () => {
			// ALLOWED_UNREFERENCED keys are referenced from places the
			// .ts/.vue scanner cannot see, and each group has one file that
			// resolves it: the splash keys live in the splash id/key table in
			// client/js/i18n/index.ts (a data table, not t() call sites, fed
			// by client/index.html's static copy), and the dates.* labels are
			// resolved inside client/js/i18n/dates.ts (formatRelativeDay
			// takes the caller's t(), so DateMarker.vue — their UI owner —
			// never names the keys). Pin each group's keys as quoted literals
			// in its resolver's source text, so a key that leaves it cannot
			// linger on the allowlist.
			const groups: ReadonlyArray<{file: string; keys: readonly string[]}> = [
				{
					file: "client/js/i18n/index.ts",
					keys: ["loading.reload", "loading.requiresJs", "loading.slow"],
				},
				{file: "client/js/i18n/dates.ts", keys: ["dates.today", "dates.yesterday"]},
				{
					file: "client/js/loading-error-handlers.js",
					keys: [
						"loading.starting",
						"loading.error",
						"loading.errorDetails",
						"loading.errorDevtools",
					],
				},
			];

			const allowlisted = [...ALLOWED_UNREFERENCED].sort();
			const pinned = groups.flatMap((group) => group.keys).sort();
			expect(allowlisted).to.deep.equal(pinned);

			for (const group of groups) {
				const source = readFileSync(resolve(group.file), "utf8");

				for (const key of group.keys) {
					expect(
						source,
						`${key} is allowlisted in check.ts but no longer appears in ${group.file}`
					).to.contain(`"${key}"`);
				}
			}
		});
	});
});
