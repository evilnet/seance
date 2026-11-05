import {expect} from "chai";
import {after, before, describe, it} from "mocha";
import sinon from "sinon";
import {copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {runSync, SyncResult} from "../../tools/i18n/sync";

// The shape of a scaffolded catalog: standard headers with the language's
// Plural-Forms, then entries (copied from a real scaffolded file, da). The
// sync only checks existence for targets, so a small file with the right
// shape stands in for a filled one.
const TARGET_PO = [
	'msgid ""',
	'msgstr ""',
	'"Language: da\\n"',
	'"MIME-Version: 1.0\\n"',
	'"Content-Type: text/plain; charset=UTF-8\\n"',
	'"Content-Transfer-Encoding: 8bit\\n"',
	'"Plural-Forms: nplurals=2; plural=((n != 1));\\n"',
	"",
	"#: client/components/Channel.vue",
	"#. Tooltip and aria-label of the ✕ button on a channel row in the sidebar network list; clicking leaves the channel on the server and closes its window.",
	'msgctxt "channel.leave"',
	'msgid "Leave"',
	'msgstr "Afslut"',
	"",
].join("\n");

// A catalog for a tag that is no target: same shape, no plural rule.
const STRAY_PO = [
	'msgid ""',
	'msgstr ""',
	'"Language: qq\\n"',
	'"MIME-Version: 1.0\\n"',
	'"Content-Type: text/plain; charset=UTF-8\\n"',
	'"Content-Transfer-Encoding: 8bit\\n"',
	"",
	'msgctxt "stray.key"',
	'msgid "Left the list"',
	'msgstr ""',
	"",
].join("\n");

describe("i18n sync", () => {
	let tmp: string;
	let targetPo: string;
	let strayPo: string;
	let targetBytes: Buffer;
	let strayBytes: Buffer;
	let first: SyncResult;

	before(() => {
		tmp = mkdtempSync(join(tmpdir(), "seance-i18n-sync-"));
		// runSync scaffolds every target the directory lacks, and its writer
		// reads <localesDir>/messages.pot — the scratch tree carries the real
		// one so those scaffolds have somewhere to write from.
		copyFileSync(resolve("client/locales/messages.pot"), join(tmp, "messages.pot"));
		targetPo = join(tmp, "da.po");
		strayPo = join(tmp, "qq.po");
		writeFileSync(targetPo, TARGET_PO);
		writeFileSync(strayPo, STRAY_PO);
		targetBytes = readFileSync(targetPo);
		strayBytes = readFileSync(strayPo);
	});

	after(() => {
		rmSync(tmp, {recursive: true, force: true});
	});

	it("scaffolds missing targets, archives the stray, leaves the target untouched", () => {
		first = runSync(tmp);

		// da was seeded by hand: not scaffolded, byte-for-byte untouched.
		expect(first.scaffolded).to.not.include("da");
		expect(readFileSync(targetPo).equals(targetBytes), "da.po must be untouched byte-for-byte")
			.to.be.true;

		// Every target the directory lacked was scaffolded from the pot.
		expect(first.scaffolded).to.include("de");
		expect(existsSync(join(tmp, "de.po"))).to.be.true;

		// qq is no target: moved whole into attic/, and listed.
		expect(first.archived).to.deep.equal(["qq"]);
		expect(existsSync(strayPo)).to.be.false;
		expect(readFileSync(join(tmp, "attic", "qq.po")).equals(strayBytes)).to.be.true;
	});

	it("does nothing on the second run", () => {
		expect(runSync(tmp)).to.deep.equal({scaffolded: [], archived: []});
		expect(readFileSync(targetPo).equals(targetBytes), "da.po must stay untouched").to.be.true;
	});

	it("leaves a stray in place when attic/ already holds one for its tag", () => {
		// The stray came back with different content; the archived copy is
		// the older one and wins.
		const restored = STRAY_PO.replace("Left the list", "Left the list (restored)");
		writeFileSync(strayPo, restored);

		const warn = sinon.stub(console, "warn");
		let result: SyncResult;

		try {
			result = runSync(tmp);
		} finally {
			warn.restore();
		}

		expect(result.archived).to.deep.equal([]);
		const messages = warn.getCalls().map((call) => call.args.join(" "));
		expect(
			messages.some((message) => message.includes("attic/qq.po already exists")),
			"the attic clash must be warned about"
		).to.be.true;

		// Still in the locales directory, attic's copy untouched.
		expect(readFileSync(strayPo, "utf8")).to.equal(restored);
		expect(readFileSync(join(tmp, "attic", "qq.po")).equals(strayBytes)).to.be.true;
	});
});
