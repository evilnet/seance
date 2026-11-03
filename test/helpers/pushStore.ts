import {expect} from "chai";
import {
	anyStale,
	entryStale,
	parseStoredSubscriptions,
	type PushEntry,
} from "../../client/js/helpers/pushStore";

const material = {endpoint: "https://push.example/e1", keys: {p256dh: "P", auth: "A"}};
const entry: PushEntry = {vapid: "K", ...material};

describe("pushStore — parseStoredSubscriptions", () => {
	it("reads the per-network shape", () => {
		const {entries, legacy} = parseStoredSubscriptions(JSON.stringify({net1: entry}));

		expect(entries).to.deep.equal({net1: entry});
		expect(legacy).to.deep.equal([]);
	});

	it("recognises the old per-key shape as legacy, keeping the key with the endpoint", () => {
		const {entries, legacy} = parseStoredSubscriptions(JSON.stringify({K: material}));

		expect(entries).to.deep.equal({});
		expect(legacy).to.deep.equal([{vapid: "K", endpoint: material.endpoint}]);
	});

	it("keeps both when a map mixes the shapes", () => {
		const {entries, legacy} = parseStoredSubscriptions(
			JSON.stringify({K: material, net1: entry})
		);

		expect(Object.keys(entries)).to.deep.equal(["net1"]);
		expect(legacy).to.deep.equal([{vapid: "K", endpoint: material.endpoint}]);
	});

	it("drops garbage and survives unparsable storage", () => {
		expect(parseStoredSubscriptions(null)).to.deep.equal({entries: {}, legacy: []});
		expect(parseStoredSubscriptions("nonsense")).to.deep.equal({entries: {}, legacy: []});
		expect(parseStoredSubscriptions("[1,2]")).to.deep.equal({entries: {}, legacy: []});
		expect(
			parseStoredSubscriptions(JSON.stringify({net1: {vapid: "K"}, net2: 7, net3: null}))
		).to.deep.equal({entries: {}, legacy: []});
	});
});

describe("pushStore — entryStale", () => {
	it("is true only for an entry made against another key than the one announced", () => {
		expect(entryStale(entry, "K")).to.equal(false);
		expect(entryStale(entry, "K2")).to.equal(true);
	});

	it("is false with nothing stored or nothing announced yet", () => {
		expect(entryStale(undefined, "K")).to.equal(false);
		expect(entryStale(entry, undefined)).to.equal(false);
	});
});

describe("pushStore — keys from outside", () => {
	it("has no entry for a name every object has", () => {
		const {entries} = parseStoredSubscriptions(JSON.stringify({net1: entry}));

		expect(entries.constructor).to.equal(undefined);
		expect(anyStale(entries, new Map([["constructor", "K"]]))).to.equal(false);
	});
});

describe("pushStore — anyStale", () => {
	it("scans the connected networks against their entries", () => {
		const entries = {net1: entry, net2: {...entry, vapid: "K2"}};

		expect(
			anyStale(
				entries,
				new Map([
					["net1", "K"],
					["net2", "K2"],
				])
			)
		).to.equal(false);
		expect(
			anyStale(
				entries,
				new Map([
					["net1", "K"],
					["net2", "K3"],
				])
			)
		).to.equal(true);
		expect(anyStale(entries, new Map([["net3", "K"]]))).to.equal(false);
		expect(anyStale(entries, new Map([["net1", undefined]]))).to.equal(false);
	});
});
