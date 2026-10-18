import {expect} from "chai";
import {GROUPS, groupOverride, groupsFor, type Group} from "../../../client/js/scenes/psng/groups";

const store = (value: string | null) => ({get: () => value});

describe("ps NG groups (psng/groups.ts)", function () {
	it("full runs every group, calm the clouds, still none", function () {
		expect([...groupsFor("full")].sort()).to.deep.equal([...GROUPS].sort());
		expect([...groupsFor("calm")]).to.deep.equal(["clouds"]);
		expect(groupsFor("still").size).to.equal(0);
	});

	it("`only` narrows full and calm and leaves still empty", function () {
		const only = new Set<Group>(["clouds"]);
		expect([...groupsFor("full", only)]).to.deep.equal(["clouds"]);
		expect([...groupsFor("calm", only)]).to.deep.equal(["clouds"]);
		expect(groupsFor("still", only).size).to.equal(0);
	});

	it("`only` cannot add a group the tier lacks", function () {
		expect(groupsFor("calm", new Set<Group>(["stars"])).size).to.equal(0);
		expect(groupsFor("calm", new Set<Group>(["smoke", "weather"])).size).to.equal(0);
	});

	it("groupOverride reads names, ignores unknown ones, and is undefined when unset", function () {
		expect([...(groupOverride(store("clouds,stars")) ?? [])].sort()).to.deep.equal([
			"clouds",
			"stars",
		]);
		expect([...(groupOverride(store("clouds,nope")) ?? [])]).to.deep.equal(["clouds"]);
		expect(groupOverride(store(null))).to.equal(undefined);
	});
});
