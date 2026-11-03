import {expect} from "chai";
import type {UserModel} from "../../client/js/irc/investigate";
import type {SeenEntry} from "../../client/js/helpers/verdict";
import {compareSummary, mergeSeen, sameFact} from "../../client/js/helpers/operCompare";

const model = (target: string, user: object, seen: SeenEntry[] = []): UserModel =>
	({
		kind: "user",
		target,
		user: {nick: target, ...user},
		liveBans: [],
		recentBans: [],
		serviceBans: [],
		seen,
		verdict: "",
	} as unknown as UserModel);

describe("operCompare", function () {
	const a = model("opbot3", {
		host: "172.17.0.1",
		ip: "172.17.0.1",
		server: "irc.seance.test",
		realname: "irc client",
	});

	it("calls a fact the same only when both users have it", function () {
		const b = model("opbot2", {host: "172.17.0.1", ip: "172.17.0.1", account: "opbot"});
		expect(sameFact(a, b, "ip")).to.equal(true);
		expect(sameFact(a, b, "account")).to.equal(false);
		expect(sameFact(model("x", {}), model("y", {}), "account")).to.equal(false);
	});

	it("ignores case, as the ircd does", function () {
		const b = model("opbot2", {realname: "IRC Client"});
		expect(sameFact(a, b, "realname")).to.equal(true);
	});

	it("reads the same address and two more facts as one person", function () {
		const b = model("opbot2", {
			host: "172.17.0.1",
			ip: "172.17.0.1",
			server: "irc.seance.test",
			realname: "irc client",
			account: "opbot",
		});
		const s = compareSummary(a, b);
		expect(s.lead).to.equal("Likely same person");
		expect(s.tone).to.equal("warn");
		expect(s.same).to.deep.equal(["host", "IP", "server", "realname"]);
		expect(s.known).to.equal(4);
	});

	it("reads a shared server and realname alone as overlap", function () {
		const b = model("opbot2", {
			ip: "10.0.0.9",
			server: "irc.seance.test",
			realname: "irc client",
		});
		const s = compareSummary(a, b);
		expect(s.lead).to.equal("Some in common");
		expect(s.tone).to.equal("plain");
	});

	it("says when nothing matches", function () {
		expect(compareSummary(a, model("opbot2", {ip: "10.0.0.9"})).lead).to.equal(
			"Nothing in common"
		);
	});

	it("merges both users' sightings, newest first, without the two users", function () {
		const seen = (nick: string, time: number): SeenEntry => ({nick, time, matched: ["ip"]});
		const left = model("opbot3", {}, [seen("O3", 3), seen("opbot2", 5), seen("opfriend", 1)]);
		const right = model("opbot2", {}, [seen("o3", 4), seen("opbot3", 6), seen("kitten", 2)]);
		const merged = mergeSeen(left, right).map((s) => [s.entry.nick, s.a, s.b]);
		expect(merged).to.deep.equal([
			["o3", true, true],
			["kitten", false, true],
			["opfriend", true, false],
		]);
	});
});
