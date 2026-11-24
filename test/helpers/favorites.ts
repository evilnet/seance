import {expect} from "chai";
import {
	addFavorite,
	FAVORITES_COLLAPSED_KEY,
	FAVORITES_KEY,
	favoriteKey,
	favorites,
	favoritesCollapsed,
	forgetNetworkFavorites,
	isFavorite,
	moveFavorite,
	parseFavorites,
	removeFavorite,
	setFavoritesCollapsed,
	useStorageBackend,
} from "../../client/js/favorites";

describe("favorites (favorites.ts)", function () {
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

	const names = () => favorites.value.map((f) => `${f.network}/${f.name}`);

	it("stars at the end of the list, once, and stores it", function () {
		addFavorite("a", "#seance", "channel");
		addFavorite("b", "alice", "query");
		addFavorite("a", "#SEANCE", "channel");

		expect(names()).to.deep.equal(["a/#seance", "b/alice"]);
		expect(JSON.parse(store.get(FAVORITES_KEY)!)).to.deep.equal([
			{network: "a", name: "#seance", type: "channel"},
			{network: "b", name: "alice", type: "query"},
		]);
	});

	it("knows a favorite by network and name, folded as the network folds", function () {
		addFavorite("a", "#foo[bar]", "channel");

		expect(isFavorite("a", "#FOO{BAR}")).to.equal(true);
		expect(isFavorite("a", "#FOO{BAR}", "ascii")).to.equal(false);
		expect(isFavorite("a", "#FOO[BAR]", "ascii")).to.equal(true);
		expect(isFavorite("b", "#foo[bar]")).to.equal(false);
	});

	it("keeps nick[ and nick{ apart on an ascii network, under keys of their own", function () {
		addFavorite("a", "nick[", "query", "ascii");
		addFavorite("a", "nick{", "query", "ascii");
		addFavorite("a", "NICK{", "query", "ascii");

		expect(names()).to.deep.equal(["a/nick[", "a/nick{"]);
		expect(favoriteKey("a", "nick[")).to.not.equal(favoriteKey("a", "nick{"));
		expect(favoriteKey("a", "Nick{")).to.equal(favoriteKey("a", "nick{"));

		// Both survive a reload; unstarring one leaves the other.
		useStorageBackend({
			get: (key) => store.get(key) ?? null,
			set: (key, value) => void store.set(key, value),
			remove: (key) => void store.delete(key),
		});
		expect(names()).to.deep.equal(["a/nick[", "a/nick{"]);
		removeFavorite({network: "a", name: "nick["});
		expect(names()).to.deep.equal(["a/nick{"]);
	});

	it("unstars, and drops the key once the list is empty", function () {
		addFavorite("a", "#one", "channel");
		addFavorite("a", "#two", "channel");
		removeFavorite({network: "a", name: "#ONE"});

		expect(names()).to.deep.equal(["a/#two"]);

		removeFavorite({network: "a", name: "#two"});

		expect(names()).to.deep.equal([]);
		expect(store.has(FAVORITES_KEY)).to.equal(false);
	});

	it("moves a favorite, and ignores an index out of range", function () {
		addFavorite("a", "#one", "channel");
		addFavorite("a", "#two", "channel");
		addFavorite("a", "#three", "channel");

		moveFavorite(2, 0);
		expect(names()).to.deep.equal(["a/#three", "a/#one", "a/#two"]);

		moveFavorite(0, 2);
		expect(names()).to.deep.equal(["a/#one", "a/#two", "a/#three"]);

		moveFavorite(0, 3);
		moveFavorite(-1, 0);
		expect(names()).to.deep.equal(["a/#one", "a/#two", "a/#three"]);
	});

	it("forgets a removed network's favorites", function () {
		addFavorite("a", "#one", "channel");
		addFavorite("b", "#two", "channel");
		forgetNetworkFavorites("a");

		expect(names()).to.deep.equal(["b/#two"]);
	});

	it("reads only well-formed entries, the first of a duplicate", function () {
		expect(parseFavorites(null)).to.deep.equal([]);
		expect(parseFavorites("not json")).to.deep.equal([]);
		expect(parseFavorites('{"a":1}')).to.deep.equal([]);
		expect(
			parseFavorites(
				JSON.stringify([
					{network: "a", name: "#one", type: "channel"},
					{network: "a", name: "#ONE", type: "channel"},
					{network: "a", name: "", type: "channel"},
					{network: "", name: "#x", type: "channel"},
					{network: "a", name: "#y", type: "lobby"},
					{network: "a", name: 5, type: "channel"},
					null,
					"#z",
					{network: "b", name: "bob", type: "query", extra: true},
				])
			)
		).to.deep.equal([
			{network: "a", name: "#one", type: "channel"},
			{network: "b", name: "bob", type: "query"},
		]);
	});

	it("reads what is stored when the backend changes", function () {
		const other = new Map<string, string>([
			[FAVORITES_KEY, JSON.stringify([{network: "n", name: "#x", type: "channel"}])],
			[FAVORITES_COLLAPSED_KEY, "true"],
		]);
		useStorageBackend({
			get: (key) => other.get(key) ?? null,
			set: (key, value) => void other.set(key, value),
			remove: (key) => void other.delete(key),
		});

		expect(names()).to.deep.equal(["n/#x"]);
		expect(favoritesCollapsed.value).to.equal(true);
	});

	it("keeps the block's collapse, stored only while collapsed", function () {
		setFavoritesCollapsed(true);
		expect(favoritesCollapsed.value).to.equal(true);
		expect(store.get(FAVORITES_COLLAPSED_KEY)).to.equal("true");

		setFavoritesCollapsed(false);
		expect(favoritesCollapsed.value).to.equal(false);
		expect(store.has(FAVORITES_COLLAPSED_KEY)).to.equal(false);
	});
});
