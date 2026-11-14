import {expect} from "chai";
import {describe, it} from "mocha";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {addToPot} from "../../tools/i18n/add";
import {parsePo, type PoEntry} from "../../tools/i18n/po";
import {
	applyReuse,
	changedKeys,
	driftReport,
	foldEnglish,
	lineOfKey,
	newKeyFindings,
	planReuse,
} from "../../tools/i18n/reuse";

const POT = `msgid ""
msgstr ""

msgctxt "a.cancel"
msgid "Cancel"
msgstr ""

msgctxt "b.cancel"
msgid "Cancel"
msgstr ""

msgctxt "c.cancel"
msgid "Cancel"
msgstr ""

#, distinct
msgctxt "d.cancel"
msgid "Cancel"
msgstr ""

msgctxt "a.edit"
msgid "Edit"
msgstr ""

msgctxt "b.edit"
msgid "Edit"
msgstr ""

msgctxt "c.edit"
msgid "Edit"
msgstr ""

msgctxt "a.users"
msgid "{count} user"
msgid_plural "{count} users"
msgstr[0] ""
msgstr[1] ""

msgctxt "b.users"
msgid "{count} user"
msgid_plural "{count} users"
msgstr[0] ""
msgstr[1] ""

msgctxt "a.join"
msgid "Join {channel}"
msgstr ""

msgctxt "b.join"
msgid "Join {channel}"
msgstr ""
`;

const DE = `msgid ""
msgstr ""
"Language: de\\n"

msgctxt "a.cancel"
msgid "Cancel"
msgstr "Abbrechen"

msgctxt "b.cancel"
msgid "Cancel"
msgstr ""

msgctxt "c.cancel"
msgid "Cancel"
msgstr "Abbrechen"

msgctxt "d.cancel"
msgid "Cancel"
msgstr ""

msgctxt "a.edit"
msgid "Edit"
msgstr "Bearbeiten"

msgctxt "b.edit"
msgid "Edit"
msgstr "Ändern"

msgctxt "c.edit"
msgid "Edit"
msgstr ""

msgctxt "a.users"
msgid "{count} user"
msgid_plural "{count} users"
msgstr[0] "{count} Benutzer"
msgstr[1] "{count} Benutzer"

msgctxt "b.users"
msgid "{count} user"
msgid_plural "{count} users"
msgstr[0] ""
msgstr[1] ""

#, fuzzy
msgctxt "a.join"
msgid "Join {channel}"
msgstr "{channel} betreten"

msgctxt "b.join"
msgid "Join {channel}"
msgstr ""
`;

const entries = (text: string): PoEntry[] => parsePo(text).entries.filter((e) => e.msgctxt);

describe("i18n reuse", function () {
	describe("planReuse", function () {
		const plan = planReuse(entries(POT), entries(DE), "de");
		const filled = Object.fromEntries(plan.fills.map((f) => [f.key, f]));

		it("copies the one translation the catalog has for the same English", function () {
			expect(filled["b.cancel"]?.msgstr).to.deep.equal(["Abbrechen"]);
			expect(filled["b.cancel"]?.from).to.deep.equal(["a.cancel", "c.cancel"]);
		});

		it("leaves a key marked distinct alone", function () {
			expect(filled["d.cancel"]).to.equal(undefined);
		});

		it("leaves a key whose English the catalog translates two ways for a person", function () {
			expect(filled["c.edit"]).to.equal(undefined);
			expect(plan.ambiguous).to.deep.equal([
				{key: "c.edit", texts: ["Bearbeiten", "Ändern"]},
			]);
		});

		it("copies every plural slot from an entry with the same singular and plural", function () {
			expect(filled["b.users"]?.msgstr).to.deep.equal([
				"{count} Benutzer",
				"{count} Benutzer",
			]);
		});

		it("never copies from a fuzzy (stale) entry", function () {
			expect(filled["b.join"]).to.equal(undefined);
		});

		it("never fills an entry that already has text", function () {
			expect(filled["a.cancel"]).to.equal(undefined);
			expect(filled["a.edit"]).to.equal(undefined);
		});

		it("leaves a note naming where the text came from", function () {
			const po = entries(DE);
			applyReuse(po, plan);
			const entry = po.find((e) => e.msgctxt === "b.cancel");
			expect(entry?.msgstr).to.deep.equal(["Abbrechen"]);
			expect(entry?.translatorComments).to.deep.equal(["reused-from: a.cancel c.cancel"]);
		});

		it("does not copy a translation the sweep would empty", function () {
			// English left standing as the "translation": sweep.ts empties it
			// (unchanged), so the fill must not copy it either, or the two loop.
			const po = entries(
				DE.replace('msgstr "Abbrechen"', 'msgstr "Cancel"').replace(
					/msgctxt "c\.cancel"\nmsgid "Cancel"\nmsgstr "Abbrechen"/,
					'msgctxt "c.cancel"\nmsgid "Cancel"\nmsgstr "Cancel"'
				)
			);
			const again = planReuse(entries(POT), po, "de");
			expect(again.fills.map((f) => f.key)).to.not.include("b.cancel");
		});
	});

	describe("driftReport", function () {
		it("lists English translated more than one way, with the keys behind each", function () {
			expect(driftReport(entries(POT), entries(DE))).to.deep.equal([
				{
					english: "Edit",
					variants: [
						{text: "Bearbeiten", keys: ["a.edit"]},
						{text: "Ändern", keys: ["b.edit"]},
					],
				},
			]);
		});
	});

	describe("newKeyFindings", function () {
		const base = entries(`msgctxt "common.cancel"
msgid "Cancel"
msgstr ""

msgctxt "x.save"
msgid "Save"
msgstr ""

msgctxt "x.edit"
msgid "Edit…"
msgstr ""

msgctxt "x.old"
msgid "Old text"
msgstr ""
`);

		const head = entries(`msgctxt "common.cancel"
msgid "Cancel"
msgstr ""

msgctxt "x.save"
msgid "Save"
msgstr ""

msgctxt "x.edit"
msgid "Edit…"
msgstr ""

msgctxt "x.old"
msgid "Save"
msgstr ""

msgctxt "y.cancel"
msgid "Cancel"
msgstr ""

msgctxt "y.edit"
msgid "edit"
msgstr ""

#, distinct
msgctxt "y.save"
msgid "Save"
msgstr ""

msgctxt "y.fresh"
msgid "Something new"
msgstr ""
`);

		const findings = newKeyFindings(base, head);
		const byKey = Object.fromEntries(findings.map((f) => [f.key, f]));

		it("flags a new key whose English another key has", function () {
			expect(byKey["y.cancel"]).to.deep.equal({
				key: "y.cancel",
				english: "Cancel",
				kind: "duplicate",
				others: ["common.cancel"],
			});
		});

		it("flags a reworded key that now repeats another key's English", function () {
			expect(byKey["x.old"]?.kind).to.equal("duplicate");
			expect(byKey["x.old"]?.others).to.include("x.save");
		});

		it("flags a near match: case and a trailing ellipsis", function () {
			expect(byKey["y.edit"]).to.deep.include({kind: "near", others: ["x.edit"]});
		});

		it("does not flag a key marked distinct, nor fresh English", function () {
			expect(byKey["y.save"]).to.equal(undefined);
			expect(byKey["y.fresh"]).to.equal(undefined);
		});

		it("does not flag keys that did not change", function () {
			expect(byKey["x.save"]).to.equal(undefined);
			expect(changedKeys(base, head).map((e) => e.msgctxt)).to.deep.equal([
				"x.old",
				"y.cancel",
				"y.edit",
				"y.save",
				"y.fresh",
			]);
		});
	});

	describe("foldEnglish", function () {
		it("folds case, spacing and one trailing period, colon or ellipsis", function () {
			for (const text of ["Edit", "edit", "Edit…", "Edit...", " Edit. ", "Edit:"]) {
				expect(foldEnglish(text)).to.equal("edit");
			}
		});

		it("keeps question marks and inner punctuation", function () {
			expect(foldEnglish("Edit?")).to.equal("edit?");
			expect(foldEnglish("Edit… now")).to.equal("edit… now");
		});
	});

	describe("lineOfKey", function () {
		it("finds the msgctxt line, 1-based", function () {
			expect(lineOfKey('msgid ""\nmsgstr ""\n\nmsgctxt "a.b"\nmsgid "x"\n', "a.b")).to.equal(
				4
			);
		});
	});

	describe("add.ts --distinct", function () {
		it("marks the entry, keeps the mark on a later update", function () {
			const dir = mkdtempSync(join(tmpdir(), "reuse-"));

			try {
				const pot = join(dir, "messages.pot");
				addToPot(pot, {
					key: "a.save",
					msgid: "Save",
					context: ["Button."],
					loc: [],
					distinct: true,
				});
				addToPot(pot, {
					key: "a.save",
					msgid: "Save",
					context: ["Button that saves."],
					loc: [],
				});
				const entry = parsePo(readFileSync(pot, "utf8")).entries.find(
					(e) => e.msgctxt === "a.save"
				);
				expect(entry?.flags).to.deep.equal(["distinct"]);
			} finally {
				rmSync(dir, {recursive: true, force: true});
			}
		});
	});
});
