import {expect} from "chai";
import {MessageType} from "../../shared/types/msg";
import {
	ALL_CHANNELS,
	dayStart,
	formatSearchQuery,
	hasCriteria,
	matchesFilters,
	parseSearchQuery,
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

		it("asks for http when has: is all there is", function () {
			expect(serverAttrs(parseSearchQuery("has:image"), "#here").text).to.equal("http");
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
});
