import {expect} from "chai";
import {MessageType} from "../../shared/types/msg";
import {
	ALL_CHANNELS,
	dayStart,
	formatSearchQuery,
	hasCriteria,
	matchesFilters,
	matchSpans,
	parseSearchQuery,
	readyToSearch,
	resolveScope,
	rowKey,
	serverAttrs,
} from "../../client/js/searchQuery";

function row(text: string, extra: {nick?: string; account?: string; time?: Date} = {}) {
	return {
		text,
		type: MessageType.MESSAGE,
		time: extra.time ?? new Date(2026, 9, 15, 12),
		from: {nick: extra.nick ?? "kitten", mode: ""},
		fromAccount: extra.account,
	};
}

describe("searchQuery", function () {
	describe("readyToSearch", function () {
		const ready = (raw: string) => readyToSearch(raw, parseSearchQuery(raw));

		it("waits for a word of three letters", function () {
			expect(ready("")).to.equal(false);
			expect(ready("ol")).to.equal(false);
			expect(ready("old")).to.equal(true);
			expect(ready("in:#linux ol")).to.equal(false);
			expect(ready("-older")).to.equal(false);
		});

		it("waits for a filter or a quote still being typed", function () {
			expect(ready("old from:kit")).to.equal(false);
			expect(ready("old in:")).to.equal(false);
			expect(ready("old from:kitten ")).to.equal(true);
			expect(ready('"fake la')).to.equal(false);
			expect(ready('"fake lag"')).to.equal(true);
		});

		it("takes a word that only looks like a filter", function () {
			expect(ready("https://example.test")).to.equal(true);
		});
	});

	describe("what scope a query asks for", function () {
		it("reads a bare * as every channel, wherever it stands", function () {
			for (const q of ["* fake lag", "fake * lag", "fake lag *"]) {
				const filters = parseSearchQuery(q);
				expect(filters.in, q).to.equal(ALL_CHANNELS);
				expect(filters.words, q).to.deep.equal(["fake", "lag"]);
				expect(serverAttrs(filters, "#here").in, q).to.equal(undefined);
			}
		});

		it("still finds a literal * when quoted", function () {
			const filters = parseSearchQuery('"*" lag');
			expect(filters.in).to.equal(undefined);
			expect(filters.words).to.deep.equal(["*", "lag"]);
		});

		it("takes what follows a spaced in:", function () {
			expect(parseSearchQuery("in: #linux lag")).to.include({in: "#linux"});
			expect(parseSearchQuery("in: * lag")).to.include({in: ALL_CHANNELS});
			expect(parseSearchQuery("lag in:").words).to.deep.equal(["lag"]);
			expect(hasCriteria(parseSearchQuery("in:"))).to.equal(false);
		});

		it("does not let a spaced in: swallow another filter", function () {
			const filters = parseSearchQuery("in: from:kitten lag");
			expect(filters.in).to.equal(undefined);
			expect(filters.from).to.equal("kitten");
		});

		it("finds a channel named without its #", function () {
			const known = new Set(["#linux", "linuxfan"]);
			const exists = (name: string) => known.has(name);
			const scoped = (q: string) => resolveScope(parseSearchQuery(q), exists).in;
			expect(scoped("in:linux lag")).to.equal("#linux");
			expect(scoped("in:linuxfan lag")).to.equal("linuxfan");
			expect(scoped("in:nobody lag")).to.equal("nobody");
			expect(scoped("in:* lag")).to.equal(ALL_CHANNELS);
		});
	});

	describe("parseSearchQuery", function () {
		it("reads words, phrases, exclusions and filters", function () {
			expect(
				parseSearchQuery(
					'fake "the lag" -docker -"dev image" from:kitten account:kit in:#seance has:link after:2026-10-01 before:2026-11-01'
				)
			).to.deep.equal({
				words: ["fake", "the lag"],
				without: ["docker", "dev image"],
				from: "kitten",
				account: "kit",
				in: "#seance",
				has: ["link"],
				after: "2026-10-01",
				before: "2026-11-01",
			});
		});

		it("keeps what only looks like a filter as a word", function () {
			const filters = parseSearchQuery("http://x.test after:soon has:cats note:this");

			expect(filters.words).to.deep.equal([
				"http://x.test",
				"after:soon",
				"has:cats",
				"note:this",
			]);
			expect(filters.after).to.equal(undefined);
			expect(filters.has).to.deep.equal([]);
		});

		it("treats a quoted filter and a negated filter as text", function () {
			const filters = parseSearchQuery('"from:kitten" -from:moss');

			expect(filters.from).to.equal(undefined);
			expect(filters.words).to.deep.equal(["from:kitten"]);
			expect(filters.without).to.deep.equal(["from:moss"]);
		});

		it("refuses a day that does not exist", function () {
			expect(dayStart("2026-02-31")).to.equal(undefined);
			expect(parseSearchQuery("after:2026-02-31").after).to.equal(undefined);
		});
	});

	it("formats back to a query that parses the same", function () {
		for (const raw of [
			'fake "the lag" -docker -"dev image" in:* from:kitten has:image after:2026-10-01',
			'"from:kitten" "-dash"',
		]) {
			const once = parseSearchQuery(raw);

			expect(parseSearchQuery(formatSearchQuery(once))).to.deep.equal(once);
		}
	});

	it("knows a row across pages, msgid or not", function () {
		const time = new Date(2026, 9, 15);
		const row1 = {time, text: "hi", from: {nick: "a", mode: ""}};

		expect(rowKey({...row1, msgid: "m1"})).to.equal("m1");
		expect(rowKey(row1)).to.equal(rowKey({...row1, time: new Date(time)}));
		expect(rowKey(row1)).to.not.equal(rowKey({...row1, text: "ho"}));
	});

	it("needs something to look for, not only a scope or an exclusion", function () {
		expect(hasCriteria(parseSearchQuery("in:#seance -docker"))).to.equal(false);
		expect(hasCriteria(parseSearchQuery("from:kitten"))).to.equal(true);
		expect(hasCriteria(parseSearchQuery("has:link"))).to.equal(true);
	});

	describe("serverAttrs", function () {
		it("sends the longest word and the current channel by default", function () {
			expect(
				serverAttrs(parseSearchQuery("a longest mid from:kitten"), "#here")
			).to.deep.equal({
				in: "#here",
				from: "kitten",
				text: "longest",
			});
		});

		it("leaves `in` out for every channel", function () {
			expect(serverAttrs(parseSearchQuery(`x in:${ALL_CHANNELS}`), "#here").in).to.equal(
				undefined
			);
		});

		it("asks for http only where the device needs http", function () {
			expect(serverAttrs(parseSearchQuery("has:image"), "#here").text).to.equal("http");
			expect(serverAttrs(parseSearchQuery("has:link"), "#here").text).to.equal(undefined);
			expect(serverAttrs(parseSearchQuery("word has:link"), "#here").text).to.equal("word");
		});

		it("pages back from the older of the cursor and before:", function () {
			const filters = parseSearchQuery("x before:2026-10-10");
			const bound = dayStart("2026-10-10") as Date;
			const older = new Date(bound.getTime() - 1000);
			const newer = new Date(bound.getTime() + 1000);

			expect(serverAttrs(filters, "#h", older).before).to.equal(older.toISOString());
			expect(serverAttrs(filters, "#h", newer).before).to.equal(bound.toISOString());
		});
	});

	describe("matchesFilters", function () {
		it("needs every word, case-insensitively, and none of the exclusions", function () {
			const filters = parseSearchQuery("FAKE lag -docker");

			expect(matchesFilters(row("the fake lag clock"), filters)).to.equal(true);
			expect(matchesFilters(row("the fake clock"), filters)).to.equal(false);
			expect(matchesFilters(row("fake lag in docker"), filters)).to.equal(false);
		});

		it("matches from exactly, not as a substring", function () {
			const filters = parseSearchQuery("from:kit");

			expect(matchesFilters(row("x", {nick: "KIT"}), filters)).to.equal(true);
			expect(matchesFilters(row("x", {nick: "kitten"}), filters)).to.equal(false);
		});

		it("follows an account across nicks and skips senders with none", function () {
			const filters = parseSearchQuery("account:kit");

			expect(matchesFilters(row("x", {nick: "a", account: "kit"}), filters)).to.equal(true);
			expect(matchesFilters(row("x", {nick: "b"}), filters)).to.equal(false);
		});

		it("tells links from images", function () {
			const link = parseSearchQuery("has:link");
			const image = parseSearchQuery("has:image");

			expect(matchesFilters(row("see https://a.test/x"), link)).to.equal(true);
			expect(matchesFilters(row("no url here"), link)).to.equal(false);
			expect(matchesFilters(row("see example.com please"), link)).to.equal(true);
			expect(matchesFilters(row("ircs://irc.test/#chan"), link)).to.equal(true);
			expect(matchesFilters(row("see https://a.test/x"), image)).to.equal(false);
			expect(matchesFilters(row("see https://a.test/x.PNG?w=1 ok"), image)).to.equal(true);
		});

		it("takes after: from the start of that day and stops before before:", function () {
			const filters = parseSearchQuery("after:2026-10-10 before:2026-10-12");

			expect(matchesFilters(row("x", {time: new Date(2026, 9, 10)}), filters)).to.equal(true);
			expect(matchesFilters(row("x", {time: new Date(2026, 9, 9, 23)}), filters)).to.equal(
				false
			);
			expect(matchesFilters(row("x", {time: new Date(2026, 9, 12)}), filters)).to.equal(
				false
			);
		});

		it("skips what is not chat", function () {
			const join = {...row("x"), type: MessageType.JOIN};

			expect(matchesFilters(join, parseSearchQuery("x"))).to.equal(false);
		});
	});

	describe("matchSpans", function () {
		it("gives offsets into the text as written", function () {
			expect(matchSpans("İx", ["x"])).to.deep.equal([[1, 2]]);
			expect(matchSpans("Fake fake", ["FAKE"])).to.deep.equal([
				[0, 4],
				[5, 9],
			]);
		});

		it("reads a word literally, and skips an empty one", function () {
			expect(matchSpans("a.b axb", ["a.b"])).to.deep.equal([[0, 3]]);
			expect(matchSpans("abc", [""])).to.deep.equal([]);
		});
	});
});
