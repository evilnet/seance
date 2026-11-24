import {expect} from "chai";
import {
	clashingNames,
	favoriteChannelIds,
	favoriteRows,
	foldedName,
	sidebarWindows,
} from "../../client/js/helpers/sidebarOrder";
import type {Favorite} from "../../client/js/favorites";
import type {ClientChan, ClientNetwork} from "../../client/js/types";
import {ChanType} from "../../shared/types/chan";

let nextId = 1;

function chan(name: string, type: ChanType = ChanType.CHANNEL): ClientChan {
	return {id: nextId++, name, type} as ClientChan;
}

function network(
	uuid: string,
	names: string[],
	opts: {collapsed?: boolean; ascii?: boolean} = {}
): ClientNetwork {
	return {
		uuid,
		name: uuid.toUpperCase(),
		isCollapsed: !!opts.collapsed,
		channels: [
			chan(uuid, ChanType.LOBBY),
			...names.map((n) => chan(n, /^[#&]/.test(n) ? ChanType.CHANNEL : ChanType.QUERY)),
		],
		serverOptions: {
			CHANTYPES: ["#", "&"],
			PREFIX: {prefix: [], modeToSymbol: {}, symbols: []},
			NETWORK: uuid,
			...(opts.ascii ? {CASEMAPPING: "ascii" as const} : {}),
		},
	} as unknown as ClientNetwork;
}

const fav = (net: string, name: string, type: Favorite["type"] = "channel"): Favorite => ({
	network: net,
	name,
	type,
});

const names = (list: ClientChan[]) => list.map((c) => c.name);

describe("sidebar order (helpers/sidebarOrder.ts)", function () {
	it("makes a row of every favorite: live, closed, or on a saved network not here", function () {
		const a = network("a", ["#one", "#Two"]);
		const rows = favoriteRows(
			[fav("a", "#two"), fav("a", "#gone"), fav("z", "#far"), fav("x", "#orphan")],
			[a],
			[{uuid: "z"}]
		);

		expect(rows.map((r) => r.kind)).to.deep.equal(["live", "closed", "dormant"]);
		expect(rows[0].kind === "live" && rows[0].channel.name).to.equal("#Two");
	});

	it("marks a saved network's favorites dialling while boot is about to dial it", function () {
		const rows = favoriteRows(
			[fav("y", "#soon"), fav("z", "#later")],
			[],
			[{uuid: "y"}, {uuid: "z"}],
			(entry) => entry.uuid === "y"
		);

		expect(rows.map((r) => r.kind === "dormant" && r.dialling)).to.deep.equal([true, false]);
	});

	it("finds the window as its network folds names", function () {
		const rfc = network("r", ["#foo{bar}"]);
		const ascii = network("s", ["#foo{bar}"], {ascii: true});
		const rows = favoriteRows([fav("r", "#foo[bar]"), fav("s", "#foo[bar]")], [rfc, ascii], []);

		expect(rows.map((r) => r.kind)).to.deep.equal(["live", "closed"]);
	});

	it("never takes a lobby for a favorite of the same name", function () {
		const a = network("a", []);
		const rows = favoriteRows([fav("a", "a", "query")], [a], []);

		expect(rows.map((r) => r.kind)).to.deep.equal(["closed"]);
	});

	it("puts the favorites first and leaves them out of their networks", function () {
		const a = network("a", ["#one", "#two"]);
		const b = network("b", ["#three", "bob"]);
		const rows = favoriteRows([fav("b", "bob", "query"), fav("a", "#two")], [a, b], []);

		expect(names(sidebarWindows([a, b], rows))).to.deep.equal([
			"bob",
			"#two",
			"a",
			"#one",
			"b",
			"#three",
		]);
		expect(favoriteChannelIds(rows).size).to.equal(2);
	});

	it("leaves a collapsed network's conversations out, its favorites in", function () {
		const a = network("a", ["#one", "#two"], {collapsed: true});
		const rows = favoriteRows([fav("a", "#two")], [a], []);

		expect(names(sidebarWindows([a], rows))).to.deep.equal(["#two", "a"]);
		expect(names(sidebarWindows([a], rows, {withCollapsed: true}))).to.deep.equal([
			"#two",
			"a",
			"#one",
		]);
	});

	it("leaves the favorites out while their block is collapsed", function () {
		const a = network("a", ["#one", "#two"]);
		const rows = favoriteRows([fav("a", "#two")], [a], []);

		expect(names(sidebarWindows([a], rows, {favoritesCollapsed: true}))).to.deep.equal([
			"a",
			"#one",
		]);
		expect(
			names(sidebarWindows([a], rows, {favoritesCollapsed: true, withCollapsed: true}))
		).to.deep.equal(["#two", "a", "#one"]);
	});

	it("names the clashes: a name two favorites share, whatever its case", function () {
		const a = network("a", ["#help"]);
		const b = network("b", ["#HELP", "#own"]);
		const rows = favoriteRows(
			[fav("a", "#help"), fav("b", "#HELP"), fav("b", "#own")],
			[a, b],
			[]
		);
		const clashes = clashingNames(rows);

		expect(rows.map((r) => clashes.has(foldedName(r)))).to.deep.equal([true, true, false]);
	});
});
