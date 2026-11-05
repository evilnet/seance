import {expect} from "chai";
import {describe, it} from "mocha";
import {parsePo, serializePo, PoEntry} from "../../tools/i18n/po";

const SAMPLE = [
	"#: client/components/Windows/Connect.vue:295",
	"#. Button on the connect form: submits it and dials the server.",
	'msgctxt "connect.submit"',
	'msgid "Connect"',
	'msgstr "Verbinden"',
	"",
	"#. Condensed summary; {count} joined while collapsed.",
	'msgctxt "condensed.join"',
	'msgid "{count} user has joined"',
	'msgid_plural "{count} users have joined"',
	'msgstr[0] "ein Benutzer ist beigetreten"',
	'msgstr[1] "{count} Benutzer sind beigetreten"',
	"",
].join("\n");

describe("i18n .po reader/writer", () => {
	it("round-trips singular and plural entries", () => {
		const {headers, entries} = parsePo(SAMPLE);
		expect(entries).to.have.lengthOf(2);
		expect(entries[0].msgctxt).to.equal("connect.submit");
		expect(entries[0].msgid).to.equal("Connect");
		expect(entries[0].msgstr[0]).to.equal("Verbinden");
		expect(entries[1].msgstr).to.deep.equal([
			"ein Benutzer ist beigetreten",
			"{count} Benutzer sind beigetreten",
		]);
		// serialize → parse → identical
		const again = parsePo(serializePo(headers, entries));
		expect(again.entries).to.deep.equal(entries);
	});

	it('unescapes \\n, \\t, \\" and multi-line strings', () => {
		const {entries} = parsePo(
			['msgid ""', '"line one\\n"', '"line \\"two\\""', 'msgstr ""'].join("\n")
		);
		expect(entries[0].msgid).to.equal('line one\nline "two"');
	});

	it("parses the header entry into headers and drops it from entries", () => {
		const {headers, entries} = parsePo(
			[
				'msgid ""',
				'msgstr ""',
				'"Language: de\\n"',
				'"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
				"",
				"#: a.vue:1",
				'msgctxt "x"',
				'msgid "X"',
				'msgstr ""',
			].join("\n")
		);
		expect(headers.language).to.equal("de");
		expect(headers["plural-forms"]).to.contain("nplurals=2");
		expect(entries).to.have.lengthOf(1);
	});

	it("throws on a line it cannot read instead of guessing", () => {
		expect(() => parsePo("garbage line\n")).to.throw(/cannot parse/);
	});
});
