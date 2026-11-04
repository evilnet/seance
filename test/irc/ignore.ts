import {expect} from "chai";
import sinon from "sinon";
import storage from "../../client/js/localStorage";
import {IgnoreList, ignoreListFor, ignoreStorageKey} from "../../client/js/ignore";

/** Replace the localStorage wrapper with an in-memory map for the test. */
function fakeStorage(): Map<string, string> {
	const data = new Map<string, string>();
	sinon.stub(storage, "get").callsFake((key: string) => data.get(key) ?? null);
	sinon.stub(storage, "set").callsFake((key: string, value: string) => void data.set(key, value));
	sinon.stub(storage, "remove").callsFake((key: string) => void data.delete(key));
	return data;
}

describe("ignore list", function () {
	let data: Map<string, string>;

	beforeEach(function () {
		data = fakeStorage();
	});

	afterEach(function () {
		sinon.restore();
	});

	it("adds parsed entries and persists them under the network key", function () {
		const list = new IgnoreList("net-1");
		const entry = list.add("Troll!~t@Evil.Example");

		expect(entry).to.include({nick: "troll", ident: "~t", hostname: "evil.example"});
		expect(entry?.when).to.be.a("number");
		expect(list.list).to.have.length(1);

		const stored = JSON.parse(data.get(ignoreStorageKey("net-1")) ?? "[]");
		expect(stored).to.deep.equal([entry]);
	});

	it("refuses masks already covered by an existing entry", function () {
		const list = new IgnoreList("net-1");
		expect(list.add("*!*@evil.example")).to.not.equal(undefined);
		expect(list.add("troll!t@evil.example")).to.equal(undefined);
		expect(list.add("Troll")).to.not.equal(undefined);
		expect(list.list).to.have.length(2);
	});

	it("removes entries and clears storage when the list empties", function () {
		const list = new IgnoreList("net-1");
		list.add("troll");
		list.add("spammer@spam.example");

		expect(list.remove("nobody")).to.equal(undefined);
		expect(list.remove("spammer@spam.example")?.nick).to.equal("spammer");
		expect(list.list.map((e) => e.nick)).to.deep.equal(["troll"]);
		expect(data.has(ignoreStorageKey("net-1"))).to.equal(true);

		list.remove("troll");
		expect(data.has(ignoreStorageKey("net-1"))).to.equal(false);
	});

	it("matches senders with wildcards, case-insensitively", function () {
		const list = new IgnoreList("net-1");
		list.add("*!*@*.evil.example");
		list.add("Bob");

		expect(list.matches("troll", "t", "lair.evil.example")).to.equal(true);
		expect(list.matches("BOB", "any", "host")).to.equal(true);
		expect(list.matches("bobby", "any", "host")).to.equal(false);
		expect(list.matches("carol", "c", "nice.example")).to.equal(false);
		expect(list.matches("carol")).to.equal(false);
	});

	it("loads what a previous session stored and drops malformed entries", function () {
		data.set(
			ignoreStorageKey("net-2"),
			JSON.stringify([
				{nick: "old", ident: "*", hostname: "*", when: 1},
				{nick: "broken"},
				"junk",
			])
		);

		const list = new IgnoreList("net-2");
		expect(list.list).to.deep.equal([{nick: "old", ident: "*", hostname: "*", when: 1}]);
	});

	it("recovers from corrupt storage by clearing it", function () {
		data.set(ignoreStorageKey("net-3"), "{not json");
		const list = new IgnoreList("net-3");
		expect(list.list).to.deep.equal([]);
		expect(data.has(ignoreStorageKey("net-3"))).to.equal(false);
	});

	it("reloads from storage on demand", function () {
		const list = new IgnoreList("net-4");
		data.set(
			ignoreStorageKey("net-4"),
			JSON.stringify([{nick: "later", ident: "*", hostname: "*", when: 2}])
		);
		expect(list.list).to.have.length(0);
		list.reload();
		expect(list.list.map((e) => e.nick)).to.deep.equal(["later"]);
	});

	it("caches one list per network uuid", function () {
		const a = ignoreListFor("net-cache-a");
		expect(ignoreListFor("net-cache-a")).to.equal(a);
		expect(ignoreListFor("net-cache-b")).to.not.equal(a);
	});
});
