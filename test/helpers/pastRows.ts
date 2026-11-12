import {expect} from "chai";
import {editRow, linkEdits, mergePage, pageEdge} from "../../client/js/helpers/pastRows";
import type {SharedMsg} from "../../shared/types/msg";

const row = (id: number, msgid?: string, nick = "bob") =>
	({id, msgid, from: {nick, mode: ""}, time: new Date(id), text: `t${id}`} as SharedMsg);

describe("helpers/pastRows.ts", function () {
	it("adds a page on the side it belongs, without repeats", function () {
		const rows = [row(2, "b"), row(3, "c")];
		const before = mergePage(rows, [row(1, "a"), row(9, "b")], "BEFORE");
		expect(before.rows.map((r) => r.id)).to.deep.equal([1, 2, 3]);
		expect(before.added).to.equal(1);
		const after = mergePage(rows, [row(9, "c"), row(4, "d")], "AFTER");
		expect(after.rows.map((r) => r.id)).to.deep.equal([2, 3, 4]);
	});

	it("keeps rows that have no msgid", function () {
		expect(mergePage([row(1)], [row(2)], "AFTER").added).to.equal(1);
	});

	it("places an edit and its original that came on different pages", function () {
		const edit = {...row(5, "e", "BOB"), editOf: "a"} as SharedMsg;
		// AFTER: the edit lands behind its original's page.
		const after = mergePage([row(1, "a"), row(2, "b")], [edit], "AFTER").rows;
		linkEdits(after);
		expect(after.map((r) => r.id)).to.deep.equal([1, 5, 2]);
		expect(after[0].supersededBy).to.equal(5);

		// BEFORE: the original lands in front of its edit's page.
		const before = mergePage([row(2, "b"), {...edit}], [row(1, "a")], "BEFORE").rows;
		linkEdits(before);
		expect(before[0].supersededBy).to.equal(5);
	});

	it("leaves another author's line with the same editOf alone", function () {
		const rows = [row(1, "a"), {...row(5, "e", "mallory"), editOf: "a"} as SharedMsg];
		linkEdits(rows);
		expect(rows[0].supersededBy).to.equal(undefined);
	});

	it("pages from the outermost row with a msgid", function () {
		const rows = [row(1), row(2, "b"), row(3, "c"), row(4)];
		expect(pageEdge(rows, "BEFORE")).to.equal("b");
		expect(pageEdge(rows, "AFTER")).to.equal("c");
		expect(pageEdge([row(1)], "AFTER")).to.equal(undefined);
	});

	it("puts an edit in its original's place", function () {
		const rows = [row(1, "a"), row(2, "b")];
		const edit = {...row(9, "e"), editOf: "a"};
		expect(editRow(rows, edit)).to.equal(true);
		expect(rows[0].supersededBy).to.equal(9);
		expect(rows.map((r) => r.id)).to.deep.equal([1, 9, 2]);
	});

	it("leaves the caller's edit as it came, for the channel's buffer", function () {
		const rows = [row(1, "a")];
		const edit = {...row(9, "e"), editOf: "a", time: new Date(9000)} as SharedMsg;

		expect(editRow(rows, edit)).to.equal(true);
		expect(edit.time).to.deep.equal(new Date(9000));
		expect(rows.find((r) => r.id === 9)).to.not.equal(edit);
	});

	it("ignores an edit by anyone but the author, or of a line not here", function () {
		const rows = [row(1, "a")];
		expect(editRow(rows, {...row(9, "e", "eve"), editOf: "a"})).to.equal(false);
		expect(editRow(rows, {...row(9, "e"), editOf: "gone"})).to.equal(false);
		expect(rows).to.have.length(1);
	});

	it("decides authorship by account when a line carries one", function () {
		const acct = (r: SharedMsg, fromAccount?: string) => ({...r, fromAccount} as SharedMsg);
		const rows = [acct(row(1, "a"), "bob")];
		expect(editRow(rows, {...acct(row(9, "e"), "mallory"), editOf: "a"})).to.equal(false);
		expect(editRow(rows, {...acct(row(9, "e", "robert"), "bob"), editOf: "a"})).to.equal(true);
	});
});
