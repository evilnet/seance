import {expect} from "chai";
import type {LoggedNotice} from "../../client/js/irc/noticelog";
import type {LiveBan} from "../../client/js/irc/profiles/nefarious/stats";
import {
	bansNear,
	fateText,
	type Identity,
	ipInCidr,
	maskCovers,
	seenBefore,
	verdict,
	whenText,
} from "../../client/js/helpers/verdict";

// A Saturday evening, local time, so the day names are predictable.
const NOW = new Date(2026, 9, 10, 21, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

function snotice(
	kind: string,
	fields: Record<string, string>,
	at: number,
	category = "CONNEXIT"
): LoggedNotice {
	return {
		time: NOW + at * MIN,
		type: "snotice",
		text: kind,
		snotice: {kind, category, fields, route: "network"},
	};
}

function snoop(keyword: string, fields: Record<string, string>, at: number): LoggedNotice {
	return {
		time: NOW + at * MIN,
		type: "snoop",
		text: keyword,
		snotice: {kind: `x3.snoop.${keyword}`, category: "SERVICES", fields, route: "network"},
	};
}

const USER: Identity = {
	nick: "spamfan2",
	ident: "r8821",
	host: "203-0-113-7.example.net",
	ip: "203.0.113.7",
	realname: "irc client",
};

describe("the user card's verdict (helpers/verdict.ts)", function () {
	it("matches ban masks against ident, host, IP, CIDR, realname and version", function () {
		expect(ipInCidr("203.0.113.7", "203.0.113.0/24")).to.equal(true);
		expect(ipInCidr("203.0.114.7", "203.0.113.0/24")).to.equal(false);
		expect(ipInCidr("203.0.113.7", "203.0.113.7")).to.equal(false);
		expect(ipInCidr("2001:db8::5", "2001:db8::/32")).to.equal(true);
		expect(ipInCidr("2001:db9::5", "2001:db8::/32")).to.equal(false);
		expect(ipInCidr("2001:db8:0:1::5", "2001:db8:0:1::/64")).to.equal(true);
		expect(ipInCidr("203.0.113.7", "2001:db8::/32")).to.equal(false);
		expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).to.equal(true);
		expect(maskCovers("*@2001:db8::/32", {nick: "v6", ip: "2001:db8::5"})).to.equal(true);
		// a host that is a bare IP (snoop lines carry no IP field)
		expect(maskCovers("*@1.2.3.0/24", {nick: "h", host: "1.2.3.4"})).to.equal(true);

		expect(maskCovers("*@203.0.113.7", USER)).to.equal(true);
		expect(maskCovers("*@203.0.113.*", USER)).to.equal(true);
		expect(maskCovers("*@203.0.113.0/24", USER)).to.equal(true);
		expect(maskCovers("*@203.0.114.0/24", USER)).to.equal(false);
		expect(maskCovers("r*@*.example.net", USER)).to.equal(true);
		expect(maskCovers("bob@*.example.net", USER)).to.equal(false);
		expect(maskCovers("203-0-113-7.example.net", USER)).to.equal(true);
		expect(maskCovers("$Rirc*", USER)).to.equal(true);
		expect(maskCovers("$Vmirc*", USER)).to.equal(false);
		expect(maskCovers("#badchan", USER)).to.equal(false);
		// Unknown ident: a mask that names one cannot be said to match.
		expect(maskCovers("r*@203.0.113.7", {nick: "x", ip: "203.0.113.7"})).to.equal(false);
	});

	it("lists the live bans covering the user with the setter the feed saw, then the recent ones", function () {
		const live: LiveBan[] = [
			{
				type: "G-line",
				mask: "*@203.0.113.0/24",
				expiresAt: NOW + 3 * 24 * HOUR,
				lastModAt: NOW - 2 * HOUR,
				active: true,
				reason: "bot group",
			},
			{
				type: "G-line",
				mask: "*@198.51.100.1",
				expiresAt: NOW + HOUR,
				active: true,
				reason: "x",
			},
			{
				type: "shun",
				mask: "*@203.0.113.7",
				expiresAt: NOW - HOUR,
				active: false,
				reason: "old",
			},
		];
		const feed: LoggedNotice[] = [
			snotice(
				"ban.add",
				{
					oper: "rubin",
					scope: "global",
					type: "G-line",
					mask: "*@203.0.113.0/24",
					expires: String(Math.floor((NOW + 3 * 24 * HOUR) / 1000)),
					reason: "bot group",
				},
				-125,
				"GLINE"
			),
			snotice(
				"ban.remove",
				{oper: "alice", scope: "local", type: "G-line", mask: "r????@*.example.net"},
				-30,
				"GLINE"
			),
		];
		const near = bansNear(live, feed, USER, NOW);

		expect(near.live.map((b) => b.mask)).to.deep.equal(["*@203.0.113.0/24"]);
		expect(near.live[0].by).to.equal("rubin");
		expect(near.live[0].setAt).to.equal(NOW - 125 * MIN);
		expect(near.live[0].reason).to.equal("bot group");
		expect(near.recent.map((b) => [b.mask, b.by, b.live])).to.deep.equal([
			["*@203.0.113.7", undefined, false],
			["r????@*.example.net", "alice", false],
		]);
	});

	it("finds who was seen before with the same IP, host, realname or account, newest first, with their fate", function () {
		const feed: LoggedNotice[] = [
			snotice(
				"client.connect",
				{
					nick: "spamfan",
					user: "r1234",
					host: "r1234@203-0-113-7.example.net",
					ip: "203.0.113.7",
					realname: "irc client",
				},
				-3 * 24 * 60
			),
			snotice(
				"ban.add",
				{oper: "rubin", type: "G-line", mask: "*@203.0.113.7", reason: "bot group"},
				-3 * 24 * 60 + 5,
				"GLINE"
			),
			snoop(
				"connect",
				{
					nick: "bob",
					ident: "bob",
					host: "bob.example.org",
					ip: "198.51.100.3",
					account: "bob",
				},
				-600
			),
			snotice(
				"client.connect",
				{
					nick: "lurker",
					user: "u",
					host: "u@h.example.com",
					ip: "198.51.100.4",
					realname: "irc client",
				},
				-200
			),
			snotice(
				"client.connect",
				{
					nick: "spamfan2",
					user: "r8821",
					host: "r8821@203-0-113-7.example.net",
					ip: "203.0.113.7",
					realname: "irc client",
				},
				-5
			),
			snotice(
				"client.exit",
				{
					nick: "spamfan2",
					user: "r8821",
					host: "r8821@203-0-113-7.example.net",
					ip: "203.0.113.7",
					reason: "bye",
				},
				-4
			),
		];
		const seen = seenBefore(feed, USER);

		// spamfan2's own connect and exit lines are not sightings of someone else.
		expect(seen.map((s) => s.nick)).to.deep.equal(["lurker", "spamfan"]);
		expect(seen[0].time).to.equal(NOW - 200 * MIN);
		expect(seen[0].matched).to.deep.equal(["realname"]);
		expect(seen[1].matched).to.deep.equal(["ip", "host", "realname"]);
		expect(seen[1].fate).to.deep.equal({
			kind: "ban",
			type: "G-line",
			by: "rubin",
			reason: "bot group",
		});
		expect(fateText(seen[1].fate!)).to.equal("G-lined by rubin for 'bot group'");
	});

	it("leaves the user's own lines out, but keeps their nick's earlier session from elsewhere", function () {
		const own = {
			user: "r8821",
			host: "r8821@203-0-113-7.example.net",
			ip: "203.0.113.7",
			realname: "irc client",
		};
		const feed: LoggedNotice[] = [
			// The same nick a day ago from another address: someone else had it.
			snotice(
				"client.connect",
				{
					nick: "SpamFan2",
					user: "x",
					host: "x@other.example.org",
					ip: "198.51.100.9",
					realname: "irc client",
				},
				-24 * 60
			),
			snotice("client.connect", {nick: "spamfan2", ...own}, -5),
			snoop("auth", {nick: "spamfan2", account: "spammy"}, -4),
			snotice("client.exit", {nick: "SPAMFAN2", ...own, reason: "bye"}, -3),
		];
		const user: Identity = {...USER, account: "spammy"};
		const seen = seenBefore(feed, user);

		expect(seen.map((s) => `${s.nick}@${s.ip}`)).to.deep.equal(["SpamFan2@198.51.100.9"]);
		expect(seen[0].matched).to.deep.equal(["realname"]);

		// The network's casemapping decides what "the same nick" is.
		const rfc = seenBefore(
			feed,
			{...user, nick: "spamfan2"},
			(a, b) => a.toLowerCase().replace(/\[/g, "{") === b.toLowerCase().replace(/\[/g, "{")
		);
		expect(rfc.map((s) => s.nick)).to.deep.equal(["SpamFan2"]);

		// And the verdict never names the user as their own match.
		expect(verdict({user, liveBans: [], seen, now: NOW})).to.equal(
			"Nothing conclusive: the nick was seen from 198.51.100.9 (Fri)."
		);
		expect(
			verdict({
				user,
				liveBans: [],
				seen: [{nick: "spamfan2", time: NOW - MIN, matched: ["ip", "host"]}],
				now: NOW,
			})
		).to.equal("Nothing conclusive: the nick was seen from another address (20:59).");
	});

	it("says the time today and the bare day for older sightings", function () {
		expect(whenText(NOW - 20 * MIN, NOW)).to.equal("20:40");
		expect(whenText(NOW - 3 * 24 * HOUR, NOW)).to.equal("Wed");
		expect(whenText(NOW - 10 * 24 * HOUR, NOW)).to.equal("2026-09-30");
	});

	it("writes the sentence: a live ban first, else the strongest sighting, else nothing", function () {
		expect(
			verdict({
				user: USER,
				liveBans: [
					{
						type: "G-line",
						mask: "*@203.0.113.*",
						by: "rubin",
						setAt: NOW - 3 * 24 * HOUR,
						expiresAt: 0,
						reason: "bot group",
						live: true,
					},
				],
				seen: [],
				now: NOW,
			})
		).to.equal("Covered by a live G-line: *@203.0.113.* (rubin, 3 d ago).");

		expect(
			verdict({
				user: USER,
				liveBans: [],
				seen: [
					{nick: "spamfan2", time: NOW - MIN, matched: ["ip"]},
					{
						nick: "spamfan",
						time: NOW - 3 * 24 * HOUR,
						matched: ["ip", "realname"],
						ident: "r1234",
						fate: {kind: "ban", type: "G-line", by: "rubin", reason: "bot group"},
					},
				],
				now: NOW,
			})
		).to.equal(
			"Likely the same as spamfan (Wed): same IP, same realname, same ident shape; G-lined then by rubin for 'bot group'."
		);

		expect(
			verdict({
				user: USER,
				liveBans: [],
				seen: [{nick: "lurker", time: NOW - 200 * MIN, matched: ["realname"]}],
				now: NOW,
			})
		).to.equal("Nothing conclusive: lurker (17:40) shares the realname.");

		expect(verdict({user: USER, liveBans: [], seen: [], now: NOW})).to.equal(
			"No bans cover them and nothing in the kept feed shares their IP, host or realname."
		);
	});
});
