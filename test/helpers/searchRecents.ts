import {expect} from "chai";
import {
	forgetSearches,
	MAX_RECENT,
	mergeRecent,
	recentSearches,
	rememberSearch,
	STORAGE_KEY,
	useStorageBackend,
} from "../../client/js/helpers/searchRecents";

describe("recent searches (helpers/searchRecents.ts)", function () {
	let store: Map<string, string>;

	beforeEach(function () {
		store = new Map<string, string>();
		useStorageBackend({
			get: (key) => store.get(key) ?? null,
			set: (key, value) => void store.set(key, value),
			remove: (key) => void store.delete(key),
		});
	});

	afterEach(function () {
		useStorageBackend(null);
	});

	it("keeps a thelounge.* key", function () {
		expect(STORAGE_KEY).to.match(/^thelounge\./);
	});

	it("puts the newest first, once", function () {
		expect(mergeRecent(["a", "b"], "b")).to.deep.equal(["b", "a"]);
		expect(mergeRecent([], ' "fake   lag" ')).to.deep.equal(['"fake   lag"']);
		expect(mergeRecent(["a"], "   ")).to.deep.equal(["a"]);
	});

	it("remembers the last ten", function () {
		for (let i = 0; i < 12; i++) {
			rememberSearch(`q${i}`);
		}

		const list = recentSearches();
		expect(list).to.have.length(MAX_RECENT);
		expect(list[0]).to.equal("q11");
		expect(list).not.to.include("q1");
	});

	it("drops a list it cannot read, and forgets on request", function () {
		store.set(STORAGE_KEY, "{nope");
		expect(recentSearches()).to.deep.equal([]);
		expect(store.has(STORAGE_KEY)).to.equal(false);

		rememberSearch("from:nick fake");
		expect(recentSearches()).to.deep.equal(["from:nick fake"]);
		forgetSearches();
		expect(recentSearches()).to.deep.equal([]);
	});
});
