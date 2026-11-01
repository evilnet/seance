import {expect} from "chai";
import {
	SENT_READ_BACK_KEEP,
	SENT_READ_BACK_TTL_MS,
	SentReadBacks,
	type SentReadBackValue,
	takesReadBack,
} from "../../client/js/translate/sentReadBack";

const value = (text: string): SentReadBackValue => ({
	text,
	from: "de",
	to: "en",
	engine: "llm",
});

describe("translate/sentReadBack", function () {
	it("hands a settled line without an echo its read-back once", function () {
		const map = new SentReadBacks();

		map.record(1, "[German] hallo", value("hello"), 0);

		expect(map.match(1, "[German] hallo", {id: 10}, 5)).to.deep.equal({value: value("hello")});
		expect(map.match(1, "[German] hallo", {id: 11}, 6)).to.equal(undefined);
		expect(map.size).to.equal(0);
	});

	it("gives the pending copy the read-back and keeps it for the echo", function () {
		const map = new SentReadBacks();

		map.record(1, "[German] hallo", value("hello"), 0);

		expect(map.match(1, "[German] hallo", {id: 10, pending: true}, 1)).to.deep.equal({
			value: value("hello"),
		});
		expect(map.size).to.equal(1);
		expect(map.match(1, "[German] hallo", {id: 12}, 2)).to.deep.equal({
			value: value("hello"),
			replacesCopy: 10,
		});
		expect(map.size).to.equal(0);
	});

	it("matches by channel and exact text", function () {
		const map = new SentReadBacks();

		map.record(1, "[German] hallo", value("hello"), 0);

		expect(map.match(2, "[German] hallo", {id: 10}, 1)).to.equal(undefined);
		expect(map.match(1, "[German] hallo ", {id: 10}, 1)).to.equal(undefined);
		expect(map.match(1, "[German] Hallo", {id: 10}, 1)).to.equal(undefined);
		expect(map.size).to.equal(1);
	});

	it("pairs two sends of the same text with their own copies and echoes, in order", function () {
		const map = new SentReadBacks();

		map.record(1, "ja", value("yes (first)"), 0);
		map.record(1, "ja", value("yes (second)"), 1);

		expect(map.match(1, "ja", {id: 10, pending: true}, 2)?.value.text).to.equal("yes (first)");
		expect(map.match(1, "ja", {id: 11, pending: true}, 2)?.value.text).to.equal("yes (second)");
		expect(map.match(1, "ja", {id: 12, pending: true}, 2)).to.equal(undefined);
		expect(map.match(1, "ja", {id: 20}, 3)).to.deep.equal({
			value: value("yes (first)"),
			replacesCopy: 10,
		});
		expect(map.match(1, "ja", {id: 21}, 3)).to.deep.equal({
			value: value("yes (second)"),
			replacesCopy: 11,
		});
	});

	it("drops a record its line never came back for", function () {
		const map = new SentReadBacks();

		map.record(1, "[German] hallo", value("hello"), 0);

		expect(map.match(1, "[German] hallo", {id: 10}, SENT_READ_BACK_TTL_MS)).to.equal(undefined);
		expect(map.size).to.equal(0);
	});

	it("keeps a bounded number of records, the oldest going first", function () {
		const map = new SentReadBacks();

		for (let i = 0; i <= SENT_READ_BACK_KEEP; i++) {
			map.record(1, `line ${i}`, value(`read ${i}`), i);
		}

		expect(map.size).to.equal(SENT_READ_BACK_KEEP);
		expect(map.match(1, "line 0", {id: 1}, 100)).to.equal(undefined);
		expect(map.match(1, `line ${SENT_READ_BACK_KEEP}`, {id: 2}, 100)?.value.text).to.equal(
			`read ${SENT_READ_BACK_KEEP}`
		);
	});

	it("covers a line without taking its record, by the same channel and text", function () {
		const map = new SentReadBacks();

		map.record(1, "[German] hallo", value("hello"), 0);

		expect(map.covers(1, "[German] hallo", 1)).to.equal(true);
		expect(map.covers(2, "[German] hallo", 1)).to.equal(false);
		expect(map.covers(1, "[German] Hallo", 1)).to.equal(false);
		expect(map.covers(1, "[German] hallo", SENT_READ_BACK_TTL_MS)).to.equal(false);
		expect(map.size).to.equal(0);

		map.record(1, "[German] hallo", value("hello"), 0);
		map.covers(1, "[German] hallo", 1);
		expect(map.match(1, "[German] hallo", {id: 10}, 2)?.value.text).to.equal("hello");
	});

	describe("takesReadBack", function () {
		const own = {self: true, text: "[German] hallo"};

		it("the reader's listener first: the record still covers the line", function () {
			const map = new SentReadBacks();

			map.record(1, own.text, value("hello"), 0);

			expect(takesReadBack(map, 1, own, false, false, 1)).to.equal(true);
			// The writer then takes the record: nothing was lost by skipping.
			expect(map.match(1, own.text, {id: 10}, 2)?.value.text).to.equal("hello");
		});

		it("the writer's listener first: the line already carries the read-back", function () {
			const map = new SentReadBacks();

			map.record(1, own.text, value("hello"), 0);
			map.match(1, own.text, {id: 10}, 1);

			expect(map.size).to.equal(0);
			expect(takesReadBack(map, 1, own, false, true, 2)).to.equal(true);
		});

		it("the echo of a pending copy is covered in either order", function () {
			const map = new SentReadBacks();

			map.record(1, own.text, value("hello"), 0);
			// The pending copy took the read-back; the record waits for the echo.
			map.match(1, own.text, {id: 10, pending: true}, 1);

			// Reader first on the echo.
			expect(takesReadBack(map, 1, own, false, false, 2)).to.equal(true);
			// Writer first on the echo: the record is gone, the entry is there.
			map.match(1, own.text, {id: 11}, 2);
			expect(takesReadBack(map, 1, own, false, true, 3)).to.equal(true);
		});

		it("an own line with no read-back coming is read", function () {
			const map = new SentReadBacks();

			expect(takesReadBack(map, 1, own, false, false, 0)).to.equal(false);

			map.record(1, own.text, value("hello"), 0);

			// Replayed (history, a rejoin, a reload): the writer ignores it.
			expect(takesReadBack(map, 1, own, true, false, 1)).to.equal(false);
			// Another channel, other text, or the record expired.
			expect(takesReadBack(map, 2, own, false, false, 1)).to.equal(false);
			expect(takesReadBack(map, 1, {self: true, text: "other"}, false, false, 1)).to.equal(
				false
			);
			expect(takesReadBack(map, 1, own, false, false, SENT_READ_BACK_TTL_MS)).to.equal(false);
		});

		it("never concerns someone else's line", function () {
			const map = new SentReadBacks();

			map.record(1, own.text, value("hello"), 0);

			expect(takesReadBack(map, 1, {self: false, text: own.text}, false, true, 1)).to.equal(
				false
			);
		});
	});

	it("forgets a channel's records", function () {
		const map = new SentReadBacks();

		map.record(1, "a", value("a"), 0);
		map.record(2, "b", value("b"), 0);
		map.forget(1);

		expect(map.match(1, "a", {id: 1}, 1)).to.equal(undefined);
		expect(map.match(2, "b", {id: 2}, 1)?.value.text).to.equal("b");
	});
});
