import {expect} from "chai";
import sinon from "sinon";
import storage from "../../client/js/localStorage";
import collapseNetwork, {collapsedNetworks} from "../../client/js/helpers/collapseNetwork";

const KEY = "thelounge.networks.collapsed";

describe("collapsed networks (helpers/collapseNetwork.ts)", function () {
	let data: Map<string, string>;
	let stubs: sinon.SinonStub[];

	beforeEach(function () {
		data = new Map<string, string>();
		stubs = [
			sinon.stub(storage, "get").callsFake((key: string) => data.get(key) ?? null),
			sinon.stub(storage, "set").callsFake((key: string, v: string) => void data.set(key, v)),
		];
	});

	afterEach(function () {
		stubs.forEach((stub) => stub.restore());
	});

	it("remembers which networks are collapsed", function () {
		const a = {uuid: "a", isCollapsed: false};
		const b = {uuid: "b", isCollapsed: false};

		collapseNetwork(a, true);
		collapseNetwork(b, true);
		collapseNetwork(a, false);

		expect(a.isCollapsed).to.equal(false);
		expect(b.isCollapsed).to.equal(true);
		expect([...collapsedNetworks()]).to.deep.equal(["b"]);
		expect(JSON.parse(data.get(KEY)!)).to.deep.equal(["b"]);
	});

	// A settings restore writes the key verbatim; `init` reads it on every
	// registration, so a throw there kept the networks from the store.
	it("reads anything but an array of uuids as none collapsed, and does not throw", function () {
		for (const raw of ["{}", "5", "null", '"ab"', "{not json"]) {
			data.set(KEY, raw);
			expect([...collapsedNetworks()], raw).to.deep.equal([]);
		}

		data.set(KEY, '["a", 5, null, "b"]');
		expect([...collapsedNetworks()]).to.deep.equal(["a", "b"]);

		data.set(KEY, "{}");
		const net = {uuid: "c", isCollapsed: false};
		collapseNetwork(net, true);
		expect(JSON.parse(data.get(KEY)!)).to.deep.equal(["c"]);
	});
});
