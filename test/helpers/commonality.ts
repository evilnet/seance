import {expect} from "chai";
import type {LoggedNotice} from "../../client/js/irc/noticelog";
import {
	commonality,
	type CommonUser,
	connectAgeBucket,
	connectTimes,
	identGlob,
	identShape,
	identShapeLabel,
	ipRange,
	joinTimes,
	lastHourHere,
} from "../../client/js/helpers/commonality";

const NOW = Date.UTC(2026, 9, 10, 21, 0, 0);
const MIN = 60_000;

function snoop(keyword: string, fields: Record<string, string>, at: number): LoggedNotice {
	return {
		time: NOW + at * MIN,
		type: "snoop",
		text: `${keyword} ${JSON.stringify(fields)}`,
		snotice: {kind: `x3.snoop.${keyword}`, category: "SERVICES", fields, route: "network"},
	};
}

function snotice(kind: string, fields: Record<string, string>, at: number): LoggedNotice {
	return {
		time: NOW + at * MIN,
		type: "snotice",
		text: kind,
		snotice: {kind, category: "CONNEXIT", fields, route: "network"},
	};
}

/** A bot-looking user: not authed, realname "irc client", ident r + 4 digits, one /24. */
function bot(n: number, extra: Partial<CommonUser> = {}): CommonUser {
	return {
		nick: `bot${n}`,
		authed: false,
		connectedAt: NOW - 5 * MIN,
		realname: "irc client",
		ident: `r${1000 + n * 1111}`,
		ip: `203.0.113.${n}`,
		server: "leaf2.example.org",
		...extra,
	};
}

describe("commonality (helpers/commonality.ts)", function () {
	it("shapes an ident per character and finds the literal glob of a group", function () {
		expect(identShape("r8821")).to.equal("a####");
		expect(identShape("~ab12")).to.equal("~aa##");
		expect(identGlob(["r8821", "r1234", "r9999"])).to.equal("r????");
		expect(identGlob(["ab12", "cd12"])).to.equal("??12");
		expect(identShapeLabel("r8821", "r????")).to.equal("r + 4 digits");
		expect(identShapeLabel("ab12", "??12")).to.equal("2 letters + 12");
		expect(identShapeLabel("~r8821", "~r????")).to.equal("~ + r + 4 digits");
	});

	it("buckets the connect age and ranges an IP", function () {
		expect(connectAgeBucket(NOW - 2 * MIN, NOW)).to.equal("< 15 min");
		expect(connectAgeBucket(NOW - 30 * MIN, NOW)).to.equal("< 1 h");
		expect(connectAgeBucket(NOW - 5 * 60 * MIN, NOW)).to.equal("< 1 d");
		expect(connectAgeBucket(NOW - 48 * 60 * MIN, NOW)).to.equal("> 1 d");
		expect(ipRange("203.0.113.7")).to.deep.equal({
			cidr: "203.0.113.0/24",
			label: "203.0.113.*",
		});
		expect(ipRange("2001:db8:1:2:3:4:5:6")).to.deep.equal({
			cidr: "2001:db8:1:2::/64",
			label: "2001:db8:1:2:*",
		});
		expect(ipRange("2001:db8::1")).to.deep.equal({
			cidr: "2001:db8:0:0::/64",
			label: "2001:db8:0:0:*",
		});
		expect(ipRange("example.org")).to.equal(undefined);
	});

	it("names what at least max(3, two thirds) of the users share, and who is the odd one out", function () {
		const users: CommonUser[] = [
			...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => bot(n)),
			{
				nick: "rubin",
				authed: true,
				connectedAt: NOW - 3 * 24 * 60 * MIN,
				realname: "Alex",
				ident: "rubin",
				ip: "198.51.100.9",
				server: "hub.example.org",
			},
		];
		const result = commonality(users, NOW);

		expect(result.total).to.equal(9);
		expect(result.threshold).to.equal(6);
		expect(result.facts.map((f) => f.label)).to.deep.equal([
			"not authed",
			"connected < 15 min",
			"realname 'irc client'",
			"ident r + 4 digits",
			"203.0.113.*",
			"server leaf2.example.org",
		]);
		expect(result.facts.map((f) => f.value)).to.deep.equal([
			"no",
			"< 15 min",
			"irc client",
			"r????",
			"203.0.113.0/24",
			"leaf2.example.org",
		]);
		expect(result.facts.every((f) => f.count === 8)).to.equal(true);
		expect(result.sharingAll).to.have.length(8);
		expect(result.sharingNone).to.deep.equal(["rubin"]);
	});

	it("takes the largest group per fact and counts it, leaving unknown fields out", function () {
		const users: CommonUser[] = [
			bot(1),
			bot(2, {realname: "other"}),
			bot(3, {connectedAt: undefined}),
			bot(4, {ip: undefined}),
		];
		const result = commonality(users, NOW);
		const by = Object.fromEntries(result.facts.map((f) => [f.key, f]));

		expect(result.threshold).to.equal(3);
		expect(by.realname.count).to.equal(3);
		expect(by.realname.nicks).to.deep.equal(["bot1", "bot3", "bot4"]);
		expect(by.connectAge.count).to.equal(3);
		expect(by.ipRange.count).to.equal(3);
		expect(by.authed.count).to.equal(4);
		expect(result.sharingAll).to.deep.equal(["bot1"]);
		expect(result.sharingNone).to.deep.equal([]);
	});

	it("finds nothing in common among two users", function () {
		const result = commonality([bot(1), bot(2)], NOW);
		expect(result.facts).to.deep.equal([]);
		expect(result.sharingAll).to.deep.equal([]);
		expect(result.sharingNone).to.deep.equal([]);
	});

	it("folds the last hour in a channel: joins within a minute become one line", function () {
		const feed: LoggedNotice[] = [
			snoop("join", {channel: "#seance", nick: "old"}, -90),
			snoop("create", {channel: "#seance", nick: "alice"}, -30),
			snoop("join", {channel: "#seance", nick: "bob"}, -29.5),
			snoop("join", {channel: "#seance", nick: "carol"}, -29.2),
			snoop("join", {channel: "#other", nick: "dave"}, -29),
			snoop("join", {channel: "#seance", nick: "dave"}, -20),
			snoop("part", {channel: "#seance", nick: "bob", reason: "bye"}, -10),
			snoop("kick", {channel: "#seance", nick: "carol", kicker: "alice"}, -5),
			snoop("mode", {channel: "#seance", modes: "+m", setter: "alice"}, -4),
		];
		const events = lastHourHere(feed, "#Seance", NOW);

		expect(events.map((e) => e.text)).to.deep.equal([
			"alice created the channel",
			"bob and carol joined",
			"dave joined",
			"bob left (bye)",
			"alice kicked carol",
			"+m by alice",
		]);
		expect(events[1].time).to.equal(NOW - 29.5 * MIN);
	});

	it("reads connect and join times off the feed, the newest per nick", function () {
		const feed: LoggedNotice[] = [
			snotice("client.connect", {nick: "Alice", ip: "1.2.3.4"}, -50),
			snoop("connect", {nick: "alice", ip: "1.2.3.4"}, -40),
			snoop("join", {channel: "#seance", nick: "alice"}, -39),
			snoop("join", {channel: "#seance", nick: "alice"}, -9),
			snoop("join", {channel: "#other", nick: "alice"}, -8),
		];

		expect(connectTimes(feed).get("alice")).to.equal(NOW - 40 * MIN);
		expect(joinTimes(feed, "#seance").get("alice")).to.equal(NOW - 9 * MIN);
	});
});
