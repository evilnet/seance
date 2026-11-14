import {expect} from "chai";
import {describe, it} from "mocha";
import {readdirSync, readFileSync} from "node:fs";
import {resolve} from "node:path";
import {parsePo} from "../../tools/i18n/po";
import {
	type LocaleTerms,
	loadLocaleTerms,
	loadTermIndex,
	promptTerms,
	proseOf,
	type TermIndex,
	termCollisions,
	termFindings,
	termsIn,
	TERMS_DIR,
} from "../../tools/i18n/terms";

const INDEX: TermIndex = {
	channel: {en: ["channel", "channels"]},
	away: {en: ["away"], except: ["going away"]},
	notice: {en: ["notice", "notices"]},
	notification: {en: ["notification", "notifications"]},
};

const DE: LocaleTerms = {
	channel: {term: "Kanal", match: ["kanal", "kanäle"], avoid: ["channel"]},
	away: {term: "abwesend"},
	notice: {term: "Notice"},
	notification: {term: "Benachrichtigung"},
};

const POT = `msgid ""
msgstr ""

msgctxt "a"
msgid "Join a channel"
msgstr ""

msgctxt "b"
msgid "Leave the channel"
msgstr ""

msgctxt "c"
msgid "Open channels"
msgstr ""

msgctxt "d"
msgid "Server going away"
msgstr ""

msgctxt "e"
msgid "Failed OPER attempts on {channel}"
msgstr ""

msgctxt "f"
msgid "Show server notices"
msgstr ""

msgctxt "g"
msgid "Your channel"
msgid_plural "Your channels"
msgstr[0] ""
msgstr[1] ""
`;

const PO = `msgid ""
msgstr ""

msgctxt "a"
msgid "Join a channel"
msgstr "Einen Kanal betreten"

msgctxt "b"
msgid "Leave the channel"
msgstr "Den Channel verlassen"

msgctxt "c"
msgid "Open channels"
msgstr "Offene Räume"

msgctxt "d"
msgid "Server going away"
msgstr "Server wird beendet"

msgctxt "e"
msgid "Failed OPER attempts on {channel}"
msgstr "Fehlgeschlagene OPER-Versuche auf {channel}"

#, fuzzy
msgctxt "f"
msgid "Show server notices"
msgstr "Server-Hinweise anzeigen"

msgctxt "g"
msgid "Your channel"
msgid_plural "Your channels"
msgstr[0] "Dein Kanal"
msgstr[1] "Deine Räume"
`;

describe("i18n terms", function () {
	const pot = parsePo(POT).entries;
	const po = parsePo(PO).entries;

	it("finds a term as a whole word, either form, any case", function () {
		expect(termsIn("Channels on this network", INDEX)).to.deep.equal(["channel"]);
		expect(termsIn("A channelling ritual", INDEX)).to.deep.equal([]);
	});

	it("leaves out placeholders, syntax, commands, masks and channel names", function () {
		expect(proseOf("/join <channel> on {channel} as #channel or nick@channel")).to.not.match(
			/channel/
		);
		expect(termsIn("Usage: /topic <channel>", INDEX)).to.deep.equal([]);
	});

	it("does not count an all-capitals protocol token", function () {
		expect(termsIn("Send a NOTICE", INDEX)).to.deep.equal([]);
		expect(termsIn("Send a notice", INDEX)).to.deep.equal(["notice"]);
	});

	it("takes the term's except phrases out first", function () {
		expect(termsIn("Server going away", INDEX)).to.deep.equal([]);
		expect(termsIn("Set yourself away", INDEX)).to.deep.equal(["away"]);
	});

	it("reports an avoided stem and a missing term, and passes a match", function () {
		const findings = termFindings(pot, po, INDEX, DE);
		const byKey = Object.fromEntries(findings.map((f) => [f.key, f]));

		expect(byKey.a).to.equal(undefined);
		expect(byKey.b).to.include({kind: "avoid", term: "channel", found: "channel"});
		expect(byKey.c).to.include({kind: "missing", term: "channel"});
	});

	it("skips the except phrase, placeholders and fuzzy entries", function () {
		const keys = termFindings(pot, po, INDEX, DE).map((f) => f.key);

		expect(keys).to.not.include("d");
		expect(keys).to.not.include("e");
		expect(keys).to.not.include("f");
	});

	it("checks every plural slot", function () {
		const finding = termFindings(pot, po, INDEX, DE).find((f) => f.key === "g");

		expect(finding).to.include({kind: "missing", translation: "Deine Räume"});
	});

	it("checks no term the catalog has no word for", function () {
		expect(termFindings(pot, po, INDEX, {})).to.deep.equal([]);
	});

	it("reports two terms with one stem, and not one stem inside another", function () {
		expect(
			termCollisions({
				notice: {term: "通知"},
				notification: {term: "通知"},
				channel: {term: "チャンネル"},
			})
		).to.deep.equal([{terms: ["notice", "notification"], stem: "通知"}]);
		expect(
			termCollisions({
				message: {term: "Nachricht"},
				notification: {term: "Benachrichtigung"},
			})
		).to.deep.equal([]);
	});

	it("gives the prompt each term the lines mention, once", function () {
		expect(
			promptTerms(["Join a channel", "Two channels", "Send a notice"], INDEX, DE)
		).to.deep.equal([
			["channel", "Kanal"],
			["notice", "Notice"],
		]);
		expect(promptTerms(["Join a channel"], INDEX, {})).to.deep.equal([]);
	});

	describe("the shipped term files", function () {
		const index = loadTermIndex();
		const tags = readdirSync(TERMS_DIR)
			.filter((f) => f.endsWith(".json") && f !== "index.json")
			.map((f) => f.replace(/\.json$/, ""));

		it("name only terms the index defines, each with a word", function () {
			for (const tag of tags) {
				for (const [id, target] of Object.entries(loadLocaleTerms(tag))) {
					expect(index, `${tag}: ${id}`).to.have.property(id);
					expect(target.term, `${tag}: ${id}`).to.be.a("string").and.not.equal("");
				}
			}
		});

		it("have a catalog each, and stems the term itself matches", function () {
			for (const tag of tags) {
				expect(
					readFileSync(resolve("client/locales", `${tag}.po`), "utf8"),
					tag
				).to.contain("msgid");

				for (const [id, target] of Object.entries(loadLocaleTerms(tag))) {
					const stems = target.match ?? [target.term.toLowerCase()];

					expect(
						stems.some((s) => target.term.toLowerCase().includes(s)),
						`${tag}: ${id} (${target.term})`
					).to.equal(true);
					expect(
						stems.every((s) => s === s.toLowerCase()),
						`${tag}: ${id}`
					).to.equal(true);
				}
			}
		});
	});
});
