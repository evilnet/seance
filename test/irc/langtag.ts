/**
 * The language client tags (irc/langtag.ts, docs/resources/translation.md
 * § Language tags): `+draft/language` and `+evilnet.github.io/machine-translated`
 * on the composer's translations, and read back onto messages.
 */

import {expect} from "chai";
import sinon from "sinon";
import socket from "../../client/js/socket";
import {
	codeOfLanguageTag,
	languageFieldsOf,
	languageTagFor,
	languageTags,
	LANGUAGE_TAG,
	MACHINE_TRANSLATED_TAG,
} from "../../client/js/irc/langtag";
import {ALL_CAPS, batch, Harness, joined, labelOf, register, setup, stubStorage} from "./support";

const NO_ECHO = ALL_CAPS.replace("echo-message ", "");
const NO_TAGS = "server-time echo-message batch";
const MT = "+evilnet.github.io/machine-translated";

describe("Language tags (irc/langtag.ts)", function () {
	beforeEach(function () {
		stubStorage();
	});

	afterEach(function () {
		sinon.restore();
		socket.removeAllListeners();
	});

	describe("values", function () {
		it("names Seance's Simplified zh and its tl in BCP 47", function () {
			expect(languageTagFor("zh")).to.equal("zh-Hans");
			expect(languageTagFor("tl")).to.equal("fil");
			expect(languageTagFor("es")).to.equal("es");
		});

		it("reads a tag as a supported code on its primary subtag", function () {
			expect(codeOfLanguageTag("es")).to.equal("es");
			expect(codeOfLanguageTag("en-US")).to.equal("en");
			expect(codeOfLanguageTag("pt-BR")).to.equal("pt");
			expect(codeOfLanguageTag("ES")).to.equal("es");
			expect(codeOfLanguageTag("zh-Hans")).to.equal("zh");
			expect(codeOfLanguageTag("zh")).to.equal("zh");
		});

		it("maps the aliases other clients send", function () {
			expect(codeOfLanguageTag("fil")).to.equal("tl");
			expect(codeOfLanguageTag("iw")).to.equal("he");
			expect(codeOfLanguageTag("in")).to.equal("id");
			expect(codeOfLanguageTag("no")).to.equal("nb");
		});

		it("names no language for und, mul, zxx, private use, junk or the unsupported", function () {
			for (const value of [
				"und",
				"mul",
				"zxx",
				"mis",
				"x-klingon",
				"i-default",
				"",
				"e",
				"en_US",
				"-en",
				"tlh",
				"a".repeat(40),
			]) {
				expect(codeOfLanguageTag(value), value).to.equal(null);
			}

			expect(codeOfLanguageTag(undefined)).to.equal(null);
		});

		it("leaves Traditional Chinese to detection: Seance's zh is Simplified", function () {
			expect(codeOfLanguageTag("zh-Hant")).to.equal(null);
			expect(codeOfLanguageTag("zh-TW")).to.equal(null);
			expect(codeOfLanguageTag("zh-Hant-CN")).to.equal(null);
		});

		it("drops the machine-translated flag without a usable language", function () {
			const of = (tags: Record<string, string>) => languageFieldsOf((name) => tags[name]);

			expect(of({[LANGUAGE_TAG]: "es", [MACHINE_TRANSLATED_TAG]: ""})).to.deep.equal({
				language: "es",
				machineTranslated: true,
			});
			expect(of({[LANGUAGE_TAG]: "es"})).to.deep.equal({language: "es"});
			expect(of({[MACHINE_TRANSLATED_TAG]: ""})).to.deep.equal({});
			expect(of({[LANGUAGE_TAG]: "und", [MACHINE_TRANSLATED_TAG]: ""})).to.deep.equal({});
		});

		it("tags a polish with its language only", function () {
			expect(languageTags("en", false)).to.deep.equal({[LANGUAGE_TAG]: "en"});
			expect(languageTags("zh", true)).to.deep.equal({
				[LANGUAGE_TAG]: "zh-Hans",
				[MACHINE_TRANSLATED_TAG]: "",
			});
			expect(languageTags(undefined, true)).to.deep.equal({});
		});
	});

	describe("outbound", function () {
		it("puts the language and the machine-translated flag on a translated line", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);

			h.client.input(id, "Acabo de despertarme.", {language: "es", machineTranslated: true});
			expect(h.sent()).to.deep.equal([
				`@+draft/language=es;${MT} PRIVMSG #seance :Acabo de despertarme.`,
			]);
		});

		it("rides with the reply tags, and on a /me", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);

			h.client.input(id, "gracias", {reply: "m1", language: "es", machineTranslated: true});
			h.client.input(id, "/me saluda", {language: "es", machineTranslated: true});
			expect(h.sent()).to.deep.equal([
				`@+reply=m1;+draft/reply=m1;+draft/language=es;${MT} PRIVMSG #seance :gracias`,
				`@+draft/language=es;${MT} PRIVMSG #seance :\x01ACTION saluda\x01`,
			]);
		});

		it("names Simplified Chinese and a polish's language without the flag", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);

			h.client.input(id, "谢谢", {language: "zh", machineTranslated: true});
			h.client.input(id, "Thanks.", {language: "en", machineTranslated: false});
			expect(h.sent()).to.deep.equal([
				`@+draft/language=zh-Hans;${MT} PRIVMSG #seance :谢谢`,
				"@+draft/language=en PRIVMSG #seance :Thanks.",
			]);
		});

		it("repeats the tags on every chunk of a long line", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);

			h.client.input(id, "palabra ".repeat(120).trim(), {
				language: "es",
				machineTranslated: true,
			});
			const lines = h.sent();

			expect(lines.length).to.be.greaterThan(1);

			for (const line of lines) {
				expect(
					line.startsWith(`@+draft/language=es;${MT} PRIVMSG #seance :`),
					line
				).to.equal(true);
			}
		});

		it("goes on each line of a draft split without draft/multiline", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);

			h.client.input(id, "uno\ndos", {language: "es", machineTranslated: true});
			expect(h.sent()).to.deep.equal([
				`@+draft/language=es;${MT} PRIVMSG #seance :uno`,
				`@+draft/language=es;${MT} PRIVMSG #seance :dos`,
			]);
		});

		it("goes on a multiline batch's opener, not its lines", function () {
			const h = setup();
			const id = joined(h, `${NO_ECHO} draft/multiline=max-bytes=4096,max-lines=10`);

			h.client.input(id, "uno\ndos", {language: "es", machineTranslated: true});
			const lines = h.sent();

			expect(lines[0]).to.match(
				new RegExp(
					`^@\\+draft/language=es;\\+evilnet\\.github\\.io/machine-translated BATCH \\+\\S+ draft/multiline #seance$`
				)
			);
			expect(lines.slice(1, -1).every((line) => !line.includes(LANGUAGE_TAG))).to.equal(true);
		});

		it("never goes on /msg, a notice, or an edit's resend", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);

			h.client.input(id, "/msg bob hola", {language: "es", machineTranslated: true});
			h.client.input(id, "/notice bob hola", {language: "es", machineTranslated: true});
			const lines = h.sent();

			expect(lines.some((line) => line.includes(LANGUAGE_TAG))).to.equal(false);
		});

		it("needs message-tags", function () {
			const h = setup();
			const id = joined(h, NO_TAGS);

			h.client.input(id, "hola", {language: "es", machineTranslated: true});
			expect(h.sent()).to.deep.equal(["PRIVMSG #seance :hola"]);
		});

		it("shows the pending copy with the fields its echo will carry", function () {
			const h = setup();
			const id = joined(h);

			h.client.input(id, "hola", {language: "es", machineTranslated: true});
			const copy = h.lastMessage(id);

			expect(copy.pending).to.equal(true);
			expect(copy.language).to.equal("es");
			expect(copy.machineTranslated).to.equal(true);
		});
	});

	describe("inbound", function () {
		it("puts the sender's language and the flag on the message", function () {
			const h = setup();
			const id = joined(h);

			h.transport.lines(
				`@msgid=a1;+draft/language=es-MX;${MT} :bob!bob@host PRIVMSG #seance :Acabo de despertarme.`,
				"@msgid=a2;+draft/language=fil :bob!bob@host PRIVMSG #seance :Salamat",
				`@msgid=a3;${MT} :bob!bob@host PRIVMSG #seance :no language, no note`,
				"@msgid=a4;+draft/language=und :bob!bob@host PRIVMSG #seance :undetermined"
			);
			const [first, second, third, fourth] = h.messages(id).slice(-4);

			expect([first.language, first.machineTranslated]).to.deep.equal(["es", true]);
			expect([second.language, second.machineTranslated]).to.deep.equal(["tl", undefined]);
			expect([third.language, third.machineTranslated]).to.deep.equal([undefined, undefined]);
			expect([fourth.language, fourth.machineTranslated]).to.deep.equal([
				undefined,
				undefined,
			]);
		});

		it("reads them on our own line looped back without echo-message", function () {
			const h = setup();
			const id = joined(h, NO_ECHO);

			h.client.input(id, "hola", {language: "es", machineTranslated: true});
			const own = h.lastMessage(id);

			expect(own.self).to.equal(true);
			expect([own.language, own.machineTranslated]).to.deep.equal(["es", true]);
		});

		it("reads them on a multiline message from its opener", function () {
			const h = setup();
			const id = joined(h, `${ALL_CAPS} draft/multiline=max-bytes=4096,max-lines=10`);

			h.transport.lines(
				`@msgid=b1;+draft/language=de;${MT} :bob!bob@host BATCH +ml draft/multiline #seance`,
				"@batch=ml :bob!bob@host PRIVMSG #seance :Guten",
				"@batch=ml :bob!bob@host PRIVMSG #seance :Morgen",
				":bob!bob@host BATCH -ml"
			);
			const last = h.lastMessage(id);

			expect(last.text).to.equal("Guten\nMorgen");
			expect([last.language, last.machineTranslated]).to.deep.equal(["de", true]);
		});

		it("comes back with a history replay", function () {
			const h = setup();

			register(h);
			h.transport.lines(
				"@time=2026-08-25T12:00:00.000Z;msgid=join-1 :alice!alice@host.example JOIN #seance",
				":irc.test 366 alice #seance :End of /NAMES list."
			);
			batch(
				h,
				[
					`@time=2026-08-25T11:00:00.000Z;msgid=old;+draft/language=fr;${MT} :bob!bob@host PRIVMSG #seance :Bonjour`,
				],
				{label: labelOf(h.sent())}
			);
			// The replay's lines reach the store in whichever payload carries
			// them; the message is found by its msgid wherever it is.
			const found: {msgid?: string; language?: string; machineTranslated?: boolean}[] = [];
			const walk = (value: unknown, depth = 0): void => {
				if (!value || typeof value !== "object" || depth > 4) {
					return;
				}

				if ((value as {msgid?: string}).msgid === "old") {
					found.push(value as never);
				}

				for (const child of Object.values(value)) {
					walk(child, depth + 1);
				}
			};

			h.dispatch.getCalls().forEach((call) => walk(call.args[1]));
			expect(found.length).to.be.greaterThan(0);
			expect(found[0].language).to.equal("fr");
			expect(found[0].machineTranslated).to.equal(true);
		});
	});
});
