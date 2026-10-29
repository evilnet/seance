import {expect} from "chai";
import sinon from "sinon";
import {hasNoLetters} from "../../client/js/translate/outgoing";
import {
	LLM_MARKERS,
	type MarkerForm,
	appendMissing,
	placeholder,
	placeholdersIn,
	protect,
	renderMarkers,
	restore,
	restoreAll,
	stripCopiedNickPrefix,
	stripNickPrefix,
} from "../../client/js/translate/spans";

describe("translate/spans", () => {
	it("replaces URLs, code spans, shortcodes and formatting codes with numbered placeholders", () => {
		const {text, spans} = protect(
			"see `git rebase -i` at https://example.test/a?b=1 :tada: \x02bold\x02 \x0304red\x03 ok"
		);

		expect(spans).to.deep.equal([
			"`git rebase -i`",
			"https://example.test/a?b=1",
			":tada:",
			"\x02",
			"\x02",
			"\x0304",
			"\x03",
		]);
		expect(text).to.equal(
			`see ${placeholder(1)} at ${placeholder(2)} ${placeholder(3)} ${placeholder(
				4
			)}bold${placeholder(5)} ${placeholder(6)}red${placeholder(7)} ok`
		);
	});

	it("a code span containing a URL is one span", () => {
		const {spans} = protect("run `curl https://x.test` now");

		expect(spans).to.deep.equal(["`curl https://x.test`"]);
	});

	it("leaves plain text alone", () => {
		expect(protect("Ja, gestern.")).to.deep.equal({
			text: "Ja, gestern.",
			spans: [],
			meta: [],
			markers: "placeholder",
		});
	});

	it("restores placeholders in any order and tolerates spaces inside them", () => {
		const {text, spans} = protect("a https://x.test b `c`");
		const translated = `${placeholder(2)} und ⟦ 1 ⟧ dann`;

		expect(restore(translated, spans)).to.deep.equal({
			text: "https://x.test und `c` dann",
			missing: [],
		});
	});

	it("reports placeholders the model dropped and appends them", () => {
		const {spans} = protect("a https://x.test b `c`");
		const result = restore("nur text", spans);

		expect(result).to.deep.equal({text: "nur text", missing: [1, 2]});
		expect(appendMissing(result.text, spans, result.missing)).to.equal(
			"nur text `c` https://x.test"
		);
	});

	it("leaves an unknown placeholder number as it is", () => {
		expect(restore(`x ${placeholder(9)}`, ["a"])).to.deep.equal({
			text: `x ${placeholder(9)}`,
			missing: [1],
		});
	});

	it("a URL containing www. is one span (later patterns don't match inside protected text)", () => {
		const {text, spans} = protect("see https://www.example.test now");

		expect(spans).to.deep.equal(["https://www.example.test"]);
		expect(text).to.equal(`see ${placeholder(1)} now`);
	});

	it("a URL containing a shortcode-shaped substring is one span", () => {
		const {text, spans} = protect("see http://x.test:80:something end");

		expect(spans).to.deep.equal(["http://x.test:80:something"]);
		expect(text).to.equal(`see ${placeholder(1)} end`);
	});

	it("span numbering follows pattern order, not text position", () => {
		const {text, spans} = protect(":tada: see https://example.test/a");

		expect(spans).to.deep.equal(["https://example.test/a", ":tada:"]);
		expect(text).to.equal(`${placeholder(2)} see ${placeholder(1)}`);
	});

	it("a time is not a shortcode", () => {
		expect(protect("um 10:30:45 Uhr :+1:")).to.deep.equal({
			text: `um 10:30:45 Uhr ${placeholder(1)}`,
			spans: [":+1:"],
			meta: [{kind: "verbatim"}],
			markers: "placeholder",
		});
	});

	describe("markdown, prefixes and nicks", () => {
		/** What an engine does to a line it translates: the placeholders survive. */
		const translated = (text: string) => `[en] ${text}`;

		it("makes an emphasis pair two markers that know each other", () => {
			const info = protect("this is supposed to be in *German*.");

			expect(info.text).to.equal(
				`this is supposed to be in ${placeholder(1)}German${placeholder(2)}.`
			);
			expect(info.spans).to.deep.equal(["*", "*"]);
			expect(info.meta).to.deep.equal([
				{kind: "marker", partner: 2},
				{kind: "marker", partner: 1},
			]);
			expect(restoreAll(info.text, info)).to.equal("this is supposed to be in *German*.");
		});

		it("a lost closer takes the opener with it, rather than leaving a stray marker", () => {
			const info = protect("*German*");

			expect(restoreAll(`${placeholder(1)}German`, info)).to.equal("German");
			expect(restoreAll("German", info)).to.equal("German");
		});

		it("matches the longest marker first, so ** is bold and not two italics", () => {
			const source = "**laut** und __unterstrichen__ und ~~weg~~ und ||geheim|| und *kursiv*";
			const info = protect(source);

			expect(info.spans).to.deep.equal([
				"**",
				"**",
				"__",
				"__",
				"~~",
				"~~",
				"||",
				"||",
				"*",
				"*",
			]);
			expect(info.text).to.equal(
				`${placeholder(1)}laut${placeholder(2)} und ${placeholder(
					3
				)}unterstrichen${placeholder(4)} und ${placeholder(5)}weg${placeholder(
					6
				)} und ${placeholder(7)}geheim${placeholder(8)} und ${placeholder(
					9
				)}kursiv${placeholder(10)}`
			);
			expect(restoreAll(info.text, info)).to.equal(source);
		});

		it("leaves arithmetic alone: 2*3*4 is not emphasis", () => {
			expect(protect("2*3*4 und 5_6_7")).to.deep.equal({
				text: "2*3*4 und 5_6_7",
				spans: [],
				meta: [],
				markers: "placeholder",
			});
		});

		it("a link's text is translated between two markers and the target is untouched", () => {
			const info = protect("see [the build log](https://example.test/log) please");

			expect(info.text).to.equal(
				`see ${placeholder(2)}the build log${placeholder(3)} please`
			);
			expect(info.spans).to.deep.equal([
				"https://example.test/log",
				"[",
				`](${placeholder(1)})`,
			]);
			expect(restoreAll(translated(info.text), info)).to.equal(
				"[en] see [the build log](https://example.test/log) please"
			);
		});

		it("a fenced block spanning three lines is one span and the line count is kept", () => {
			const source = "erste Zeile\n```\nx = 1\n```\nletzte Zeile";
			const info = protect(source);

			expect(info.spans).to.deep.equal(["```\nx = 1\n```"]);
			expect(info.meta).to.deep.equal([{kind: "verbatim"}]);
			expect(info.text).to.equal(`erste Zeile\n${placeholder(1)}\nletzte Zeile`);

			const out = restoreAll(info.text, info);

			expect(out).to.equal(source);
			expect(out.split("\n")).to.have.length(source.split("\n").length);
		});

		it("a line's leading syntax is one prefix span, put back on its line when lost", () => {
			const info = protect("# Überschrift\n- erster Punkt\n> zitiert");

			expect(info.spans).to.deep.equal(["# ", "- ", "> "]);
			expect(info.meta).to.deep.equal([
				{kind: "prefix", line: 0},
				{kind: "prefix", line: 1},
				{kind: "prefix", line: 2},
			]);
			expect(info.text).to.equal(
				`${placeholder(1)}Überschrift\n${placeholder(2)}erster Punkt\n${placeholder(
					3
				)}zitiert`
			);
			// The engine dropped every prefix but kept the line count.
			expect(restoreAll("Heading\nfirst item\nquoted", info)).to.equal(
				"# Heading\n- first item\n> quoted"
			);
		});

		it("a prefix lost from a single line goes back to the front of it", () => {
			const info = protect("## Kapitel zwei");

			expect(restoreAll("Chapter two", info, placeholdersIn(info.text))).to.equal(
				"## Chapter two"
			);
		});

		it("protects a nick only as a whole word, longest first", () => {
			const info = protect("hallo alice, aliceland kennt alice nicht", {
				nicks: ["alice", "al", "x"],
			});

			expect(info.spans).to.deep.equal(["alice", "alice"]);
			expect(info.text).to.equal(
				`hallo ${placeholder(1)}, aliceland kennt ${placeholder(2)} nicht`
			);
			expect(restoreAll(translated(info.text), info)).to.equal(
				"[en] hallo alice, aliceland kennt alice nicht"
			);
		});

		it("matches a nick in any case, keeps the line's spelling, and the longer of two sharing a start", () => {
			const info = protect("Bob-2 und BOB sagen: [x] und _a und bobby", {
				nicks: ["bob", "BoB-2", "[x]", "_A", "bobby2"],
			});

			// `bobby` is no name: `bob` is inside a word there and `bobby2`
			// is not in the line.
			expect(info.spans).to.deep.equal(["Bob-2", "BOB", "[x]", "_a"]);
			expect(info.text).to.equal(
				`${placeholder(1)} und ${placeholder(2)} sagen: ${placeholder(3)} und ${placeholder(
					4
				)} und bobby`
			);
		});

		it("lowercases each nick once per line, not once per character", () => {
			// 2000 names and a 400-character line used to lowercase every
			// name at every position (~800k calls); a history load runs 40
			// such lines in one task.
			const nicks = Array.from({length: 2000}, (_, i) => `user${i}`);
			const line = "ein Satz mit user7 und mehr Text dazu. ".repeat(10);
			const spy = sinon.spy(String.prototype, "toLowerCase");
			let info: ReturnType<typeof protect>;

			try {
				info = protect(line, {nicks});
			} finally {
				spy.restore();
			}

			expect(info.spans).to.have.length(10);
			expect(spy.callCount).to.be.below(nicks.length * 2 + 100);
		});

		it("a nick is never found inside a placeholder an earlier stage left", () => {
			const info = protect("siehe https://example.test/12 und 12 dort", {nicks: ["12"]});

			expect(info.spans).to.deep.equal(["https://example.test/12", "12"]);
			expect(info.text).to.equal(`siehe ${placeholder(1)} und ${placeholder(2)} dort`);
		});

		it("round-trips a line carrying every kind of syntax at once", () => {
			const source =
				"# Notiz für alice: siehe `make test`, *wichtig*, [Log](https://example.test/l) :tada:";
			const info = protect(source, {nicks: ["alice"]});

			expect(restoreAll(info.text, info)).to.equal(source);
			expect(restoreAll(translated(info.text), info)).to.equal(`[en] ${source}`);
		});

		it("drops a placeholder number the engine invented", () => {
			const info = protect("*so*");

			expect(
				restoreAll(`${placeholder(1)}so${placeholder(2)} ${placeholder(9)}`, info)
			).to.equal("*so* ");
		});
	});

	describe("math and tables", () => {
		it("keeps inline math ($`…`$) intact and translates the words around it", () => {
			const info = protect("see $`e^{i\\pi}`$ now");

			expect(info.spans).to.deep.equal(["$`e^{i\\pi}`$"]);
			expect(info.meta).to.deep.equal([{kind: "verbatim"}]);
			expect(info.text).to.equal(`see ${placeholder(1)} now`);
			expect(restoreAll(`[en] ${info.text}`, info)).to.equal("[en] see $`e^{i\\pi}`$ now");
		});

		it("a dollar amount is not math", () => {
			expect(protect("$5 and $10")).to.deep.equal({
				text: "$5 and $10",
				spans: [],
				meta: [],
				markers: "placeholder",
			});
		});

		it("display math ($$…$$) spanning lines is one span and the line count survives", () => {
			const source = "vorher\n$$\n\\int_0^1 x\\,dx\n$$\nnachher";
			const info = protect(source);

			expect(info.spans).to.deep.equal(["$$\n\\int_0^1 x\\,dx\n$$"]);
			expect(info.meta).to.deep.equal([{kind: "verbatim"}]);
			expect(info.text).to.equal(`vorher\n${placeholder(1)}\nnachher`);

			const out = restoreAll(info.text, info);

			expect(out).to.equal(source);
			expect(out.split("\n")).to.have.length(source.split("\n").length);
		});

		it("a backtick inside math is not read as inline code (runs before the code pattern)", () => {
			const info = protect("$`a \\cdot b`$ und `code`");

			expect(info.spans).to.deep.equal(["$`a \\cdot b`$", "`code`"]);
			expect(info.meta).to.deep.equal([{kind: "verbatim"}, {kind: "verbatim"}]);
		});

		it("a three-row table round-trips with the cells transformed and the separators in place", () => {
			const source = "| Name | Price |\n|---|---:|\n| Tea | 3 |";
			const info = protect(source);
			const lines = info.text.split("\n");

			expect(lines[0]).to.equal(
				`${placeholder(1)} Name ${placeholder(2)} Price ${placeholder(3)}`
			);
			expect(lines[1]).to.equal(placeholder(4));
			expect(lines[2]).to.equal(
				`${placeholder(5)} Tea ${placeholder(6)} 3 ${placeholder(7)}`
			);
			expect(info.meta[3]).to.deep.equal({kind: "prefix", line: 1});
			expect(restoreAll(info.text, info)).to.equal(source);

			// The engine sees `⟦1⟧ Name ⟦2⟧ Price ⟦3⟧` and translates the
			// cells; the separator row is never sent at all (nothing but a
			// placeholder), so the fake here stands in for what comes back.
			const translated = [
				`${placeholder(1)} Name ${placeholder(2)} Preis ${placeholder(3)}`,
				lines[1],
				`${placeholder(5)} Tee ${placeholder(6)} 3 ${placeholder(7)}`,
			].join("\n");

			expect(restoreAll(translated, info)).to.equal(
				"| Name | Preis |\n|---|---:|\n| Tee | 3 |"
			);
		});

		it("a lost cell separator is appended, today's verbatim policy", () => {
			const source = "| A | B |\n|---|---|\n| 1 | 2 |";
			const info = protect(source);
			const withoutOne = info.text.replace(placeholder(2), "");

			expect(restoreAll(withoutOne, info)).to.equal("| A  B |\n|---|---|\n| 1 | 2 | |");
		});

		it("a lost alignment row is re-prepended to its own line", () => {
			const source = "| A | B |\n|---|---|\n| 1 | 2 |";
			const info = protect(source);
			const withoutSep = info.text.replace(placeholder(4), "");

			expect(restoreAll(withoutSep, info)).to.equal(source);
		});

		it("a table cell keeps a URL protected within it", () => {
			const info = protect("| Link |\n|---|\n| https://example.test/a |");

			expect(info.spans).to.deep.equal([
				"|",
				"|",
				"|---|",
				"|",
				"|",
				"https://example.test/a",
			]);
		});
	});

	// The form a marker pair takes for the route the request is about to
	// take (spans.ts `MarkerForm`). Measured on the runner: the LLM route
	// gets the marks themselves, the seq2seq engines keep the numbered pairs
	// (docs/resources/translation.md § Emphasis marks on the LLM route).
	describe("marker forms", () => {
		it("the LLM route asks for the marks themselves", () => {
			expect(LLM_MARKERS).to.equal("literal");
		});

		it("literal leaves the marks in the text and protects everything else", () => {
			const info = protect("please keep the *timestamps*, I need the **ordering**, ps", {
				nicks: ["ps"],
				markers: "literal",
			});

			expect(info.text).to.equal(
				`please keep the *timestamps*, I need the **ordering**, ${placeholder(5)}`
			);
			expect(info.markers).to.equal("literal");
			// The pairs are still spans: the numbering and the meta are the
			// canonical protection's, so the same info restores the answer.
			expect(info.spans).to.deep.equal(["**", "**", "*", "*", "ps"]);
		});

		it("literal restores what the model wrote, marks and all", () => {
			const info = protect("das ist *wichtig*", {markers: "literal"});
			// The model's own marks, around its own words.
			expect(restoreAll("this is *important*", info, placeholdersIn(info.text))).to.equal(
				"this is *important*"
			);
			// A mark the model dropped is simply gone — and the sentence is
			// still a translation, which is the whole point of the form.
			expect(restoreAll("this is important", info, placeholdersIn(info.text))).to.equal(
				"this is important"
			);
			// A half the model kept is not put back as an orphan either: it
			// is the model's own text now, and nothing here invented it.
			expect(restoreAll("this is *important", info, placeholdersIn(info.text))).to.equal(
				"this is *important"
			);
		});

		it("literal keeps a link well-formed with only its target hidden", () => {
			const info = protect("see [the log](https://example.test/log) *now*", {
				markers: "literal",
			});

			expect(info.text).to.equal(`see [the log](${placeholder(1)}) *now*`);
			expect(restoreAll(`siehe [das Log](${placeholder(1)}) *jetzt*`, info)).to.equal(
				"siehe [das Log](https://example.test/log) *jetzt*"
			);
			// The URL is verbatim, so a target the model dropped is shown
			// late rather than lost.
			expect(restoreAll("siehe [das Log] *jetzt*", info)).to.equal(
				"siehe [das Log] *jetzt* https://example.test/log"
			);
		});

		it("tags number a pair on its opening half and restore both ways", () => {
			const info = protect("please keep the *timestamps*, I need the **ordering**", {
				markers: "tags",
			});

			// `**` is matched before `*`, so the bold pair is spans 1 and 2:
			// the numbers are span indices, not the order the pairs read in.
			expect(info.text).to.equal(
				"please keep the <3>timestamps</3>, I need the <1>ordering</1>"
			);
			expect(
				restoreAll(
					"behalte die <3>Zeitstempel</3>, ich brauche die <1>Reihenfolge</1>",
					info,
					placeholdersIn(info.text)
				)
			).to.equal("behalte die *Zeitstempel*, ich brauche die **Reihenfolge**");
			// Half a pair is still no pair: neither half comes back.
			expect(restoreAll("behalte die <3>Zeitstempel", info)).to.equal(
				"behalte die Zeitstempel"
			);
		});

		it("a tag number the spans do not account for is left as text", () => {
			const info = protect("kaufe *heute*", {markers: "tags"});

			// Span 1 is the pair's opening half, so <1>…</1> is a pair; <2>
			// is its closer's number and <9> is nobody's, and neither is a
			// tag this module wrote.
			expect(restoreAll("buy <1>today</1> <2> <9>", info)).to.equal("buy *today* <2> <9>");
		});

		it("placeholder is the default and renderMarkers is idempotent", () => {
			const canonical = protect("das ist *wichtig*");

			expect(canonical.text).to.equal(`das ist ${placeholder(1)}wichtig${placeholder(2)}`);
			expect(renderMarkers(canonical, "placeholder")).to.equal(canonical);

			const literal = renderMarkers(canonical, "literal");

			expect(literal.text).to.equal("das ist *wichtig*");
			expect(renderMarkers(literal, "literal")).to.equal(literal);
			// Rendering never touches the spans or what each of them is.
			expect(literal.spans).to.equal(canonical.spans);
			expect(literal.meta).to.equal(canonical.meta);
		});

		it("every other protection is the same on every route", () => {
			const source =
				"siehe `git log` und https://example.test/a :tada: um 10:30:45, ps — *wichtig*";

			for (const markers of ["placeholder", "literal", "tags"] as MarkerForm[]) {
				const info = protect(source, {nicks: ["ps"], markers});

				// Code, URL, shortcode, the pair, the nick: the same spans in
				// the same order, however the pair is written in the text.
				expect(info.spans, markers).to.deep.equal([
					"`git log`",
					"https://example.test/a",
					":tada:",
					"*",
					"*",
					"ps",
				]);
				// Whatever the form, the round trip is the text itself.
				expect(restoreAll(info.text, info, placeholdersIn(info.text)), markers).to.equal(
					source
				);
			}
		});
	});

	describe("stripNickPrefix", () => {
		const nicks = ["alice", "bob-2", "de1a2b"];

		it("drops a channel member's name copied in front of the translation", () => {
			expect(stripNickPrefix("alice: hello there", nicks)).to.equal("hello there");
			expect(stripNickPrefix("Alice: hello there", nicks)).to.equal("hello there");
			expect(stripNickPrefix("alice - hello there", nicks)).to.equal("hello there");
			expect(stripNickPrefix("alice – hello there", nicks)).to.equal("hello there");
			expect(stripNickPrefix("  alice : hello there", nicks)).to.equal("hello there");
			// A nick may carry the separator character itself.
			expect(stripNickPrefix("bob-2: hello there", nicks)).to.equal("hello there");
		});

		it("keeps a prefix that is not a name in the channel", () => {
			expect(stripNickPrefix("Moment: bitte warten", nicks)).to.equal("Moment: bitte warten");
			expect(stripNickPrefix("hello there", nicks)).to.equal("hello there");
			expect(stripNickPrefix("alice: hello there", [])).to.equal("alice: hello there");
			// Not a single token before the separator.
			expect(stripNickPrefix("dear alice: hello", nicks)).to.equal("dear alice: hello");
			// No space after the separator: a time, a ratio, a URL.
			expect(stripNickPrefix("alice:hello", nicks)).to.equal("alice:hello");
		});

		it("never crosses into a later line", () => {
			expect(stripNickPrefix("alice: one\ntwo", nicks)).to.equal("one\ntwo");
			expect(stripNickPrefix("one\nalice: two", nicks)).to.equal("one\nalice: two");
			expect(stripNickPrefix("alice:\nhello", nicks)).to.equal("alice:\nhello");
		});

		it("keeps the prefix the source itself carried", () => {
			// Addressing somebody is the commonest shape on IRC, and nick
			// protection sees it through the engine intact: that prefix is
			// not the model's to lose.
			expect(
				stripCopiedNickPrefix(
					"alice: can you check this?",
					"alice: kannst du das prüfen?",
					nicks
				)
			).to.equal("alice: can you check this?");
			// A prefix nobody wrote is the model copying its context.
			expect(
				stripCopiedNickPrefix("alice: can you check this?", "kannst du das prüfen?", nicks)
			).to.equal("can you check this?");
			// A source addressed to one name, an answer addressed to another:
			// still the source's prefix, so it stays.
			expect(stripCopiedNickPrefix("bob-2: hallo", "alice: hello", nicks)).to.equal(
				"bob-2: hallo"
			);
			// Neither side has one: nothing to do.
			expect(stripCopiedNickPrefix("hello there", "hallo zusammen", nicks)).to.equal(
				"hello there"
			);
		});
	});

	// The brackets are ordinary characters someone can type, and a line that
	// carried `⟦2⟧` used to come back as span 2 -- a URL, a nickname, half a
	// code span -- spliced into the middle of it.
	describe("a marker the user typed", () => {
		it("is a span of its own, and comes back as itself", () => {
			const info = protect("keep ⟦9⟧ please");

			expect(info.spans).to.deep.equal(["⟦9⟧"]);
			expect(info.text).to.equal(`keep ${placeholder(1)} please`);
			expect(restoreAll(info.text, info)).to.equal("keep ⟦9⟧ please");
		});

		it("never stands for another span in the answer", () => {
			const info = protect("siehe ⟦2⟧ und https://x.test bitte");

			// The engine is shown numbers of the protection's own making, and
			// the one the user typed is not among them.
			expect(info.text).to.not.include("⟦2⟧ und");
			expect(restoreAll(`see ${placeholder(1)} and ${placeholder(2)} please`, info)).to.equal(
				"see ⟦2⟧ and https://x.test please"
			);
		});

		it("survives inside a fenced block and inside code", () => {
			const info = protect("```\ndraw ⟦1⟧ here\n```");

			expect(restoreAll(info.text, info)).to.equal("```\ndraw ⟦1⟧ here\n```");

			const inline = protect("run `echo ⟦3⟧` now");

			expect(restoreAll(inline.text, inline)).to.equal("run `echo ⟦3⟧` now");
		});

		// A whole line of them is still nothing a language could be: the
		// judgement `hasNoLetters` makes of a protected text is unchanged.
		it("is still no content at all on its own", () => {
			expect(hasNoLetters("⟦9⟧")).to.equal(true);
			expect(protect("⟦9⟧").spans).to.deep.equal(["⟦9⟧"]);
		});
	});

	// Bug A: a channel name is an address, not prose. Fenced whole, after the
	// line prefixes (so `### Heading` is still a header) and before the
	// nicknames.
	describe("channel names", () => {
		it("fences every channel name as its own verbatim span", () => {
			const source = "join #seance and #help-desk, not #1";
			const info = protect(source);

			expect(info.spans).to.deep.equal(["#seance", "#help-desk"]);
			expect(info.text).to.equal(`join ${placeholder(1)} and ${placeholder(2)}, not #1`);
			expect(restoreAll(info.text, info)).to.equal(source);
		});

		it("the span ends before the sentence's punctuation", () => {
			const info = protect("treffen in #seance.");

			expect(info.spans).to.deep.equal(["#seance"]);
			expect(info.text).to.equal(`treffen in ${placeholder(1)}.`);
			expect(restoreAll(info.text, info)).to.equal("treffen in #seance.");

			// A dot inside the name is part of it: only a trailing run goes.
			expect(protect("siehe #a.b dort").spans).to.deep.equal(["#a.b"]);
			expect(protect("sag es in #seance!!").spans).to.deep.equal(["#seance"]);
			expect(protect("(siehe #seance)").spans).to.deep.equal(["#seance"]);

			// Trimmed below two characters it was never a channel name.
			expect(protect("das #a. dort").spans).to.deep.equal([]);
		});

		// Numbers are never translated anyway, and a numeric channel is a
		// real one on IRC: `#1234` is fenced, `#1` is too short to be.
		it("a numeric channel is a channel", () => {
			expect(protect("siehe #1234 und #1").spans).to.deep.equal(["#1234"]);
		});

		it("an ampersand channel is one too, a lone ampersand is not", () => {
			const info = protect("say hi in &local, Tom & Jerry, R&D");

			expect(info.spans).to.deep.equal(["&local"]);
			expect(restoreAll(info.text, info)).to.equal("say hi in &local, Tom & Jerry, R&D");
		});

		it("a header is still a header, at every level", () => {
			for (const source of ["# Heading", "### Heading", "###### x"]) {
				const info = protect(source);

				expect(info.meta[0]).to.deep.equal({kind: "prefix", line: 0});
				expect(restoreAll(info.text, info)).to.equal(source);
			}
		});

		it("a quoted or bulleted channel keeps both", () => {
			const info = protect("> #seance\n- #help");

			expect(info.spans).to.include("#seance");
			expect(info.spans).to.include("#help");
			expect(restoreAll(info.text, info)).to.equal("> #seance\n- #help");
		});

		it("a channel inside a code span or a URL is left to them", () => {
			const code = protect("run `join #seance` now");

			expect(code.spans).to.deep.equal(["`join #seance`"]);

			const url = protect("see https://example.test/a#seance now");

			expect(url.spans).to.deep.equal(["https://example.test/a#seance"]);
		});

		it("an emphasised channel keeps its pair whole", () => {
			const source = "*#seance* now";
			const info = protect(source);

			expect(restoreAll(info.text, info)).to.equal(source);
		});

		it("a channel and a nickname in one line both come back", () => {
			const source = "frag jonas im #seance-translate";
			const info = protect(source, {nicks: ["jonas"]});

			expect(info.text).to.not.contain("jonas");
			expect(info.text).to.not.contain("#seance-translate");
			expect(restoreAll(info.text, info)).to.equal(source);
		});
	});
});
