import {expect} from "chai";
import {
	escapeTagValue,
	formatLine,
	formatSource,
	formatTags,
	graphemeCut,
	MAX_LINE_BYTES,
	parseLine,
	parseSource,
	parseTags,
	splitMessage,
	unescapeTagValue,
	utf8ByteLength,
} from "../../client/js/irc/message";

describe("irc/message", function () {
	describe("parseLine", function () {
		it("returns null for empty and whitespace-only lines", function () {
			expect(parseLine("")).to.equal(null);
			expect(parseLine("   ")).to.equal(null);
			expect(parseLine("\r\n")).to.equal(null);
		});

		it("returns null for a tags-only line", function () {
			expect(parseLine("@a=b;c")).to.equal(null);
			expect(parseLine("@a=b :nick!u@h")).to.equal(null);
		});

		it("parses a bare command", function () {
			const msg = parseLine("PING");
			expect(msg).to.deep.include({command: "PING", params: [], raw: "PING"});
			expect(msg!.tags.size).to.equal(0);
			expect(msg!.source).to.equal(undefined);
		});

		it("uppercases the command", function () {
			expect(parseLine("privmsg #a :hi")!.command).to.equal("PRIVMSG");
		});

		it("keeps numeric commands as 3-digit strings", function () {
			const msg = parseLine(":irc.seance.test 001 seance2 :Welcome to the network");
			expect(msg!.command).to.equal("001");
			expect(msg!.params).to.deep.equal(["seance2", "Welcome to the network"]);
		});

		it("strips CR/LF and reports the stripped line as raw", function () {
			const msg = parseLine("PING :abc\r\n");
			expect(msg!.params).to.deep.equal(["abc"]);
			expect(msg!.raw).to.equal("PING :abc");
			expect(parseLine("PING :abc\n")!.raw).to.equal("PING :abc");
			expect(parseLine("PING :abc\r")!.raw).to.equal("PING :abc");
		});

		it("parses a server source", function () {
			const msg = parseLine(":irc.seance.test NOTICE * :*** Looking up your hostname");
			expect(msg!.source).to.deep.equal({name: "irc.seance.test"});
			expect(msg!.params).to.deep.equal(["*", "*** Looking up your hostname"]);
		});

		it("parses a nick!user@host source", function () {
			const msg = parseLine(":seance2!seance2@172.17.0.1 MODE seance2 +xz");
			expect(msg!.source).to.deep.equal({
				name: "seance2",
				user: "seance2",
				host: "172.17.0.1",
			});
			expect(msg!.params).to.deep.equal(["seance2", "+xz"]);
		});

		it("parses an empty trailing param", function () {
			const msg = parseLine("PRIVMSG #chan :");
			expect(msg!.params).to.deep.equal(["#chan", ""]);
		});

		it("parses a trailing param with only spaces", function () {
			expect(parseLine("PRIVMSG #chan :   ")!.params).to.deep.equal(["#chan", "   "]);
		});

		it("keeps a colon inside a middle param", function () {
			const msg = parseLine("PRIVMSG a:b :hello");
			expect(msg!.params).to.deep.equal(["a:b", "hello"]);
		});

		it("keeps a colon inside the trailing param", function () {
			const msg = parseLine("PRIVMSG #chan :a :b : c");
			expect(msg!.params).to.deep.equal(["#chan", "a :b : c"]);
		});

		it("tolerates multiple spaces between tokens", function () {
			const msg = parseLine("@a=b   :nick!u@h   PRIVMSG   #chan   x   :hi  there");
			expect(msg!.tags.get("a")).to.equal("b");
			expect(msg!.source!.name).to.equal("nick");
			expect(msg!.command).to.equal("PRIVMSG");
			expect(msg!.params).to.deep.equal(["#chan", "x", "hi  there"]);
		});

		it("tolerates trailing spaces without a trailing param", function () {
			expect(parseLine("PING abc   ")!.params).to.deep.equal(["abc"]);
		});

		it("parses tags without a value as empty string", function () {
			const msg = parseLine("@a;b=;c=d PRIVMSG #chan :hi");
			expect(msg!.tags.get("a")).to.equal("");
			expect(msg!.tags.get("b")).to.equal("");
			expect(msg!.tags.get("c")).to.equal("d");
		});

		it("parses client-only and vendor-prefixed tag keys", function () {
			const msg = parseLine(
				"@+draft/reply=abc;example.com/foo=bar;time=2026-08-24T00:00:00.000Z PRIVMSG #chan :hi"
			);
			expect(msg!.tags.get("+draft/reply")).to.equal("abc");
			expect(msg!.tags.get("example.com/foo")).to.equal("bar");
			expect(msg!.tags.get("time")).to.equal("2026-08-24T00:00:00.000Z");
		});

		it("unescapes tag values", function () {
			const msg = parseLine("@a=x\\:y\\sz\\\\w\\r\\n;b=tail\\ PRIVMSG #chan :hi");
			expect(msg!.tags.get("a")).to.equal("x;y z\\w\r\n");
			expect(msg!.tags.get("b")).to.equal("tail");
		});

		it("parses a message with tags and source but no params", function () {
			const msg = parseLine("@time=x :nick!u@h AWAY");
			expect(msg!.command).to.equal("AWAY");
			expect(msg!.params).to.deep.equal([]);
			expect(msg!.source).to.deep.equal({name: "nick", user: "u", host: "h"});
		});

		it("parses the nefarious2 CAP LS continuation line", function () {
			const msg = parseLine(
				":irc.seance.test CAP * LS * :multi-prefix userhost-in-names draft/chathistory=100"
			);
			expect(msg!.params).to.deep.equal([
				"*",
				"LS",
				"*",
				"multi-prefix userhost-in-names draft/chathistory=100",
			]);
		});

		it("parses the nefarious2 CAP LS final line with a leading space in the trailer", function () {
			const msg = parseLine(":irc.seance.test CAP * LS : tls");
			expect(msg!.params).to.deep.equal(["*", "LS", " tls"]);
		});

		it("preserves non-ASCII text", function () {
			const msg = parseLine("PRIVMSG #chan :héllo 🎉 世界");
			expect(msg!.params[1]).to.equal("héllo 🎉 世界");
		});
	});

	describe("tag escaping", function () {
		it("unescapes every entry of the escape table", function () {
			expect(unescapeTagValue("\\:")).to.equal(";");
			expect(unescapeTagValue("\\s")).to.equal(" ");
			expect(unescapeTagValue("\\\\")).to.equal("\\");
			expect(unescapeTagValue("\\r")).to.equal("\r");
			expect(unescapeTagValue("\\n")).to.equal("\n");
		});

		it("drops a lone trailing backslash", function () {
			expect(unescapeTagValue("abc\\")).to.equal("abc");
			expect(unescapeTagValue("\\")).to.equal("");
		});

		it("yields the bare character for unknown escapes", function () {
			expect(unescapeTagValue("\\x\\y;")).to.equal("xy;");
		});

		it("handles consecutive escapes", function () {
			expect(unescapeTagValue("\\\\\\s")).to.equal("\\ ");
			expect(unescapeTagValue("\\\\s")).to.equal("\\s");
		});

		it("escapes every entry of the escape table", function () {
			expect(escapeTagValue("; \\\r\n")).to.equal("\\:\\s\\\\\\r\\n");
		});

		it("round-trips arbitrary values", function () {
			const values = ["", "plain", "a;b c\\d\r\ne", "\\", "trailing\\", "🎉;🎉"];

			for (const value of values) {
				expect(unescapeTagValue(escapeTagValue(value))).to.equal(value);
			}
		});

		it("parseTags/formatTags round-trip preserving order", function () {
			const tags = parseTags("b=1;a=x\\sy;c");
			expect(Array.from(tags.keys())).to.deep.equal(["b", "a", "c"]);
			expect(formatTags(tags)).to.equal("b=1;a=x\\sy;c");
		});

		it("formatTags accepts a plain object", function () {
			expect(formatTags({"+draft/reply": "id;1", label: "x"})).to.equal(
				"+draft/reply=id\\:1;label=x"
			);
		});

		it("formatTags rejects invalid keys", function () {
			expect(() => formatTags({"a b": "x"})).to.throw();
			expect(() => formatTags({"": "x"})).to.throw();
			expect(() => formatTags({"a=b": "x"})).to.throw();
		});
	});

	describe("parseSource / formatSource", function () {
		it("parses all shapes", function () {
			expect(parseSource("irc.example.org")).to.deep.equal({name: "irc.example.org"});
			expect(parseSource("nick")).to.deep.equal({name: "nick"});
			expect(parseSource("nick!user@host")).to.deep.equal({
				name: "nick",
				user: "user",
				host: "host",
			});
			expect(parseSource("nick@host")).to.deep.equal({name: "nick", host: "host"});
			expect(parseSource("nick!user")).to.deep.equal({name: "nick", user: "user"});
		});

		it("handles @ inside the host", function () {
			expect(parseSource("nick!~u@a@b")).to.deep.equal({
				name: "nick",
				user: "~u",
				host: "a@b",
			});
		});

		it("formats back to the wire form", function () {
			for (const src of ["irc.example.org", "nick!user@host", "nick@host", "nick!user"]) {
				expect(formatSource(parseSource(src))).to.equal(src);
			}
		});
	});

	describe("formatLine", function () {
		it("formats a bare command", function () {
			expect(formatLine({command: "CAP", params: ["LS", "302"]})).to.equal("CAP LS 302");
		});

		it("uppercases the command", function () {
			expect(formatLine({command: "privmsg", params: ["#a", "b"]})).to.equal("PRIVMSG #a b");
		});

		it("adds a colon when the last param contains a space", function () {
			expect(formatLine({command: "PRIVMSG", params: ["#chan", "hello world"]})).to.equal(
				"PRIVMSG #chan :hello world"
			);
		});

		it("adds a colon when the last param is empty", function () {
			expect(formatLine({command: "PRIVMSG", params: ["#chan", ""]})).to.equal(
				"PRIVMSG #chan :"
			);
		});

		it("adds a colon when the last param starts with a colon", function () {
			expect(formatLine({command: "PRIVMSG", params: ["#chan", ":)"]})).to.equal(
				"PRIVMSG #chan ::)"
			);
		});

		it("does not add a colon to a single-word last param", function () {
			expect(formatLine({command: "JOIN", params: ["#chan"]})).to.equal("JOIN #chan");
			expect(formatLine({command: "PRIVMSG", params: ["#chan", "a:b"]})).to.equal(
				"PRIVMSG #chan a:b"
			);
		});

		it("includes tags and source", function () {
			expect(
				formatLine({
					tags: new Map([
						["label", "abc"],
						["+draft/reply", "x y"],
					]),
					source: {name: "nick", user: "u", host: "h"},
					command: "PRIVMSG",
					params: ["#chan", "hi"],
				})
			).to.equal("@label=abc;+draft/reply=x\\sy :nick!u@h PRIVMSG #chan hi");
		});

		it("omits the tag prefix when tags are empty", function () {
			expect(formatLine({tags: new Map(), command: "PING", params: ["x"]})).to.equal(
				"PING x"
			);
			expect(formatLine({tags: {}, command: "PING", params: ["x"]})).to.equal("PING x");
		});

		it("throws when a non-last param contains a space", function () {
			expect(() => formatLine({command: "PRIVMSG", params: ["a b", "c"]})).to.throw();
		});

		it("throws when a non-last param is empty", function () {
			expect(() => formatLine({command: "PRIVMSG", params: ["", "c"]})).to.throw();
		});

		it("throws when a non-last param starts with a colon", function () {
			expect(() => formatLine({command: "PRIVMSG", params: [":a", "c"]})).to.throw();
		});

		it("throws on CR, LF or NUL in any param", function () {
			expect(() => formatLine({command: "PRIVMSG", params: ["#a", "x\r"]})).to.throw();
			expect(() => formatLine({command: "PRIVMSG", params: ["#a", "x\ny"]})).to.throw();
			expect(() => formatLine({command: "PRIVMSG", params: ["#a\0", "x"]})).to.throw();
		});

		it("throws on an invalid command", function () {
			expect(() => formatLine({command: "", params: []})).to.throw();
			expect(() => formatLine({command: "A B", params: []})).to.throw();
		});

		it("round-trips through parseLine", function () {
			const lines = [
				"PING abc",
				"PRIVMSG #chan :",
				"PRIVMSG #chan :a :b",
				"@a=b\\:c;d :n!u@h NOTICE * :*** hi",
				":irc.seance.test 005 me CHANTYPES=#& PREFIX=(ov)@+ :are supported by this server",
			];

			for (const line of lines) {
				const msg = parseLine(line)!;
				expect(formatLine(msg)).to.equal(line);
			}
		});
	});

	describe("utf8ByteLength", function () {
		it("counts bytes per code point", function () {
			expect(utf8ByteLength("")).to.equal(0);
			expect(utf8ByteLength("abc")).to.equal(3);
			expect(utf8ByteLength("é")).to.equal(2);
			expect(utf8ByteLength("世")).to.equal(3);
			expect(utf8ByteLength("🎉")).to.equal(4);
			expect(utf8ByteLength("a é 世 🎉")).to.equal(1 + 1 + 2 + 1 + 3 + 1 + 4);
		});

		it("counts a lone surrogate as 3 bytes (U+FFFD)", function () {
			expect(utf8ByteLength("\ud83c")).to.equal(3);
			expect(utf8ByteLength("\udf89")).to.equal(3);
		});

		it("agrees with TextEncoder", function () {
			const samples = ["plain", "héllo wörld", "日本語テキスト", "🎉🎊 mixed é", "\ud83c x"];

			for (const s of samples) {
				expect(utf8ByteLength(s)).to.equal(new TextEncoder().encode(s).length);
			}
		});
	});

	describe("graphemeCut", function () {
		it("moves a cut back to the last character boundary", function () {
			const text = "ab\u{1F1E8}\u{1F1E6}cd"; // a b [flag: 4 units] c d
			expect(graphemeCut(text, 0, 4)).to.equal(2); // between the flag's halves
			expect(graphemeCut(text, 0, 6)).to.equal(6);
			expect(graphemeCut(text, 2, 4)).to.equal(4); // nothing whole fits: cut as asked
			expect(graphemeCut(text, 0, text.length)).to.equal(text.length);
		});
	});

	describe("splitMessage", function () {
		const prefix = "PRIVMSG #channel :";

		function check(chunks: string[], budget: number): void {
			for (const chunk of chunks) {
				expect(chunk.length).to.be.greaterThan(0);
				expect(prefix.length + utf8ByteLength(chunk)).to.be.at.most(budget);
			}
		}

		it("returns the text unchanged when it fits", function () {
			expect(splitMessage(prefix.length, "hello world")).to.deep.equal(["hello world"]);
		});

		it("cuts a run with no space between visible characters", function () {
			const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // 18 bytes
			const flag = "\u{1F1E8}\u{1F1E6}"; // 8 bytes
			const accented = "e\u0301"; // 3 bytes

			for (const unit of [family, flag, accented]) {
				const text = unit.repeat(40);
				const chunks = splitMessage(prefix.length, text, prefix.length + 50);

				expect(chunks.length).to.be.greaterThan(1);
				expect(chunks.join("")).to.equal(text);

				for (const chunk of chunks) {
					expect(chunk.split(unit).join("")).to.equal("", `${chunk} split a character`);
					expect(utf8ByteLength(chunk)).to.be.at.most(50);
				}
			}
		});

		it("still cuts a single character larger than the whole budget", function () {
			const zalgo = "a" + "\u0301".repeat(60); // one character, 121 bytes
			const chunks = splitMessage(prefix.length, zalgo, prefix.length + 50);

			expect(chunks.join("")).to.equal(zalgo);
			check(chunks, prefix.length + 50);
		});

		it("returns [] for empty text", function () {
			expect(splitMessage(prefix.length, "")).to.deep.equal([]);
		});

		it("uses MAX_LINE_BYTES by default", function () {
			const text = "a".repeat(MAX_LINE_BYTES - prefix.length);
			expect(splitMessage(prefix.length, text)).to.deep.equal([text]);
			expect(splitMessage(prefix.length, text + "b")).to.have.length(2);
		});

		it("splits at whitespace and consumes the separator", function () {
			const chunks = splitMessage(prefix.length, "aaaa bbbb cccc dddd", prefix.length + 10);
			expect(chunks).to.deep.equal(["aaaa bbbb", "cccc dddd"]);
			check(chunks, prefix.length + 10);
		});

		it("collapses a run of spaces at the break", function () {
			const chunks = splitMessage(prefix.length, "aaaa    bbbb", prefix.length + 6);
			expect(chunks).to.deep.equal(["aaaa", "bbbb"]);
		});

		it("hard-splits a single long word", function () {
			const chunks = splitMessage(prefix.length, "a".repeat(25), prefix.length + 10);
			expect(chunks).to.deep.equal(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
		});

		it("does not break at leading whitespace producing an empty chunk", function () {
			const chunks = splitMessage(prefix.length, " aaaaaaaaaaaa", prefix.length + 5);
			expect(chunks).to.deep.equal([" aaaa", "aaaaa", "aaa"]);
		});

		it("never splits inside a multi-byte UTF-8 sequence", function () {
			// Each 世 is 3 bytes; budget of 7 fits two (6 bytes), not three.
			const chunks = splitMessage(prefix.length, "世世世世世", prefix.length + 7);
			expect(chunks).to.deep.equal(["世世", "世世", "世"]);
			check(chunks, prefix.length + 7);
		});

		it("never splits a surrogate pair", function () {
			// Each 🎉 is 4 bytes / 2 UTF-16 units; budget 9 fits two.
			const chunks = splitMessage(prefix.length, "🎉🎉🎉🎉🎉", prefix.length + 9);
			expect(chunks).to.deep.equal(["🎉🎉", "🎉🎉", "🎉"]);

			for (const chunk of chunks) {
				expect(chunk).to.equal(Array.from(chunk).join(""));
				expect(/[\ud800-\udfff]$/.test(chunk.slice(-1)) && chunk.length % 2 !== 0).to.equal(
					false
				);
			}
		});

		it("handles mixed-width text against the byte budget", function () {
			const text = "héllo wörld 🎉 日本語 the end";
			const budget = prefix.length + 12;
			const chunks = splitMessage(prefix.length, text, budget);
			check(chunks, budget);
			expect(chunks.join(" ")).to.equal(text);
		});

		it("reassembles to the original text when every break is at whitespace", function () {
			const words: string[] = [];

			for (let i = 0; i < 200; i++) {
				words.push(`w${i}`);
			}

			const text = words.join(" ");
			const chunks = splitMessage(prefix.length, text, prefix.length + 40);
			check(chunks, prefix.length + 40);
			expect(chunks.join(" ")).to.equal(text);
		});

		it("throws when the prefix leaves no room", function () {
			expect(() => splitMessage(MAX_LINE_BYTES, "x")).to.throw(RangeError);
			expect(() => splitMessage(MAX_LINE_BYTES + 5, "x")).to.throw(RangeError);
		});

		it("throws when a single character cannot fit", function () {
			expect(() => splitMessage(MAX_LINE_BYTES - 2, "🎉")).to.throw(RangeError);
		});
	});
});
