import {expect} from "chai";
import {
	canonical,
	DEFER_MS,
	diff,
	DocumentError,
	FORMAT,
	join,
	MARKER_TTL_MS,
	merge,
	parseDocument,
	reconcile,
	sameValue,
	SKEW_MS,
	stampAfter,
	toDocument,
	type Entries,
	type Local,
} from "../../client/js/sync/document";

const NOW = 1_800_000_000_000;

/** A device holding `current`; ids ending in `?` are ones this build does not know. */
function local(current: Record<string, unknown>, defaults: Record<string, unknown> = {}): Local {
	return {
		current,
		owns: (id) => !id.endsWith("?"),
		isDefault: (id, value) => id in defaults && sameValue(defaults[id], value),
	};
}

describe("settings sync document (sync/document.ts)", function () {
	describe("canonical", function () {
		it("gives equal values one text, whatever order their keys were written in", function () {
			expect(canonical({b: 1, a: [2, {d: 3, c: 4}]})).to.equal(
				'{"a":[2,{"c":4,"d":3}],"b":1}'
			);
			expect(sameValue({a: 1, b: 2}, {b: 2, a: 1})).to.equal(true);
			expect(sameValue([1, 2], [2, 1])).to.equal(false);
		});
	});

	describe("stampAfter", function () {
		it("is the clock, or one millisecond past the newest entry held if that is later", function () {
			expect(stampAfter({a: {t: NOW - 5}}, NOW)).to.equal(NOW);
			expect(stampAfter({a: {t: NOW + 40, v: 1}, b: {t: NOW + 9}}, NOW)).to.equal(NOW + 41);
		});
	});

	describe("merge", function () {
		it("takes the newer choice for each entry", function () {
			const mine: Entries = {theme: {t: 10, v: "coffee"}, clock: {t: 30, v: true}};
			const theirs: Entries = {theme: {t: 20, v: "day"}, clock: {t: 5, v: false}};
			const merged = merge(mine, theirs, NOW);

			expect(merged.entries).to.deep.equal({
				theme: {t: 20, v: "day"},
				clock: {t: 30, v: true},
			});
			expect(merged.taken).to.deep.equal(["theme"]);
			expect(merged.ahead).to.equal(true);
		});

		it("is not ahead when the file holds everything the device does", function () {
			const mine: Entries = {a: {t: 10, v: 1}};
			const merged = merge(mine, {a: {t: 10, v: 1}, b: {t: 3, v: 2}}, NOW);

			expect(merged.taken).to.deep.equal(["b"]);
			expect(merged.ahead).to.equal(false);
		});

		it("gives an equal time to the later text, on both devices alike", function () {
			const a: Entries = {x: {t: 10, v: "a"}};
			const b: Entries = {x: {t: 10, v: "b"}};

			expect(merge(a, b, NOW).entries.x.v).to.equal("b");
			expect(merge(b, a, NOW).entries.x.v).to.equal("b");
		});

		it("keeps a removal so the entry does not come back", function () {
			const removed = {alias: {t: NOW - 20}};
			const old = {alias: {t: NOW - 30, v: "old"}};
			const merged = merge(removed, old, NOW);

			expect(merged.entries).to.deep.equal(removed);
			expect(merged.ahead).to.equal(true);
			expect(merge(old, removed, NOW).taken).to.deep.equal(["alias"]);
		});

		it("drops a marker past 90 days without calling that a difference", function () {
			const old = NOW - MARKER_TTL_MS - 1;
			const merged = merge({gone: {t: old}}, {gone: {t: old}, kept: {t: old, v: 1}}, NOW);

			expect(merged.entries).to.deep.equal({kept: {t: old, v: 1}});
			expect(merged.ahead).to.equal(false);
			expect(merge({gone: {t: old}}, {}, NOW).ahead).to.equal(false);
		});

		it("takes nothing dated more than a minute after this device's clock", function () {
			const merged = merge(
				{},
				{soon: {t: NOW + SKEW_MS, v: 1}, late: {t: NOW + SKEW_MS + 1, v: 2}},
				NOW
			);

			expect(merged.taken).to.deep.equal(["soon"]);
			// Kept to pass on, marked as not taken yet.
			expect(merged.entries.late).to.deep.equal({t: NOW + SKEW_MS + 1, v: 2, d: true});
		});

		it("says when the earliest of them comes, within a day", function () {
			const ahead = {
				a: {t: NOW + 3 * SKEW_MS, v: 1},
				b: {t: NOW + 2 * SKEW_MS, v: 2},
				far: {t: NOW + DEFER_MS + 1, v: 3},
			};

			expect(merge({}, ahead, NOW).deferred).to.equal(NOW + 2 * SKEW_MS);
			expect(join(ahead, local({}), NOW).deferred).to.equal(NOW + 2 * SKEW_MS);
			expect(merge({}, {far: ahead.far}, NOW).deferred).to.equal(0);
			expect(merge({}, {far: ahead.far}, NOW).entries).to.deep.equal({});
			// Not one the device already holds as new.
			expect(merge({a: {t: NOW + 3 * SKEW_MS, v: 1}}, {a: ahead.a}, NOW).deferred).to.equal(
				0
			);
		});

		it("keeps an entry this build does not know, as received", function () {
			const merged = merge({}, {"future?": {t: 5, v: {any: "thing"}}}, NOW);

			expect(merged.entries["future?"]).to.deep.equal({t: 5, v: {any: "thing"}});
			expect(merged.ahead).to.equal(false);
		});

		it("makes two devices that saved at once agree after one more round", function () {
			const a: Entries = {x: {t: 10, v: 1}, y: {t: 50, v: "a"}};
			const b: Entries = {x: {t: 40, v: 2}, y: {t: 20, v: "b"}};
			const onA = merge(a, b, NOW);
			const onB = merge(b, onA.entries, NOW);

			expect(onA.ahead).to.equal(true);
			expect(onB.entries).to.deep.equal(onA.entries);
			expect(onB.ahead).to.equal(false);
		});

		it("ignores entries that are not entries", function () {
			const theirs = {a: {t: "soon", v: 1}, b: null, c: {t: 4, v: 1}} as unknown as Entries;

			expect(Object.keys(merge({}, theirs, NOW).entries)).to.deep.equal(["c"]);
		});
	});

	describe("diff", function () {
		it("dates a changed value, a new entry and a removal now", function () {
			const copy: Entries = {a: {t: 5, v: 1}, b: {t: 5, v: 2}, c: {t: 5, v: 3}};
			const result = diff(copy, local({a: 1, b: 20, d: 4}), NOW);

			expect(result.changed).to.equal(true);
			expect(result.entries).to.deep.equal({
				a: {t: 5, v: 1},
				b: {t: NOW, v: 20},
				c: {t: NOW},
				d: {t: NOW, v: 4},
			});
		});

		it("leaves out a value nobody chose, and keeps one chosen back to the default", function () {
			const defaults = {clock: true};

			expect(diff({}, local({clock: true}, defaults), NOW).changed).to.equal(false);

			const back = diff({clock: {t: 5, v: false}}, local({clock: true}, defaults), NOW);

			expect(back.entries.clock).to.deep.equal({t: NOW, v: true});
		});

		it("dates a change past a newer entry it holds, however slow the clock", function () {
			const result = diff({a: {t: NOW + 30_000, v: 1}}, local({a: 2}), NOW);

			expect(result.entries.a).to.deep.equal({t: NOW + 30_001, v: 2});
		});

		it("does not touch what this build does not know", function () {
			const copy: Entries = {"new?": {t: 5, v: 1}};
			const result = diff(copy, local({}), NOW);

			expect(result.changed).to.equal(false);
			expect(result.entries).to.deep.equal(copy);
		});

		it("does not bring back a removed entry the device no longer holds", function () {
			expect(diff({a: {t: 5}}, local({}), NOW).changed).to.equal(false);
		});

		it("reads what the device could not take as no change", function () {
			const copy: Entries = {
				theme: {t: 5, v: "elsewhere", l: {v: "coffee"}},
				alias: {t: 5, v: {bad: true}, l: {}},
			};

			expect(diff(copy, local({theme: "coffee"}), NOW).changed).to.equal(false);
			expect(diff(copy, local({theme: "day"}), NOW).entries.theme).to.deep.equal({
				t: NOW,
				v: "day",
			});
		});
	});

	describe("join", function () {
		it("lets the account win, adds what only the device holds, keeps removals", function () {
			const theirs: Entries = {both: {t: 5, v: "theirs"}, removed: {t: NOW - 6}};
			const joined = join(
				theirs,
				local({both: "mine", removed: "still here", only: 1, plain: true}, {plain: true}),
				NOW
			);

			expect(joined.entries).to.deep.equal({
				both: {t: 5, v: "theirs"},
				removed: {t: NOW - 6},
				only: {t: NOW, v: 1},
			});
			expect(joined.taken).to.have.members(["both", "removed"]);
			expect(joined.ahead).to.equal(true);
		});

		it("is not ahead when the device adds nothing", function () {
			expect(join({a: {t: 5, v: 1}}, local({a: 2}), NOW).ahead).to.equal(false);
		});
	});

	describe("reconcile", function () {
		it("notes what the device holds where it is not the entry's value", function () {
			const entries: Entries = {
				same: {t: 5, v: 1},
				other: {t: 5, v: "theirs"},
				missing: {t: 5, v: 1},
				removed: {t: 5},
				kept: {t: 5},
				"new?": {t: 5, v: 9},
			};
			const out = reconcile(entries, local({same: 1, other: "mine", kept: "still"}));

			expect(out).to.deep.equal({
				same: {t: 5, v: 1},
				other: {t: 5, v: "theirs", l: {v: "mine"}},
				missing: {t: 5, v: 1, l: {}},
				removed: {t: 5},
				kept: {t: 5, l: {v: "still"}},
				// Not this build's: marked as never taken.
				"new?": {t: 5, v: 9, u: true},
			});
		});
	});

	describe("the document", function () {
		it("travels without the device's notes and without expired markers", function () {
			const doc = toDocument(
				{b: {t: 5, v: 1, l: {v: 2}}, a: {t: NOW - MARKER_TTL_MS - 1}, c: {t: NOW}},
				NOW
			);

			expect(doc).to.deep.equal({
				format: FORMAT,
				version: 1,
				entries: {b: {t: 5, v: 1}, c: {t: NOW}},
			});
			expect(parseDocument(JSON.parse(JSON.stringify(doc)))).to.deep.equal(doc);
		});

		it("refuses what is not a document, and a newer version", function () {
			const code = (value: unknown) => {
				try {
					parseDocument(value);
				} catch (e) {
					return (e as DocumentError).code;
				}

				return "read";
			};

			expect(code([])).to.equal("not-sync");
			expect(code({format: "other", version: 1, entries: {}})).to.equal("not-sync");
			expect(code({format: FORMAT, version: 2, entries: {}})).to.equal("newer-version");
			expect(code({format: FORMAT, version: 1, entries: []})).to.equal("damaged");
			expect(code({format: FORMAT, version: 1, entries: {}})).to.equal("read");
		});

		it("holds exactly the ids put into it", function () {
			const doc = parseDocument({
				format: FORMAT,
				version: 1,
				entries: JSON.parse('{"__proto__":{"t":5,"v":1},"constructor":{"t":6}}'),
			});

			expect(Object.keys(doc.entries).sort()).to.deep.equal(["__proto__", "constructor"]);
		});
	});
});
