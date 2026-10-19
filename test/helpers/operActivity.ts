import {expect} from "chai";
import type {LoggedNotice} from "../../client/js/irc/noticelog";
import {
	actorOf,
	coarseKindOf,
	COARSE_KINDS,
	countLabel,
	inPeriod,
	isCounted,
	isOperAction,
	KIND_COARSE,
	periodStart,
	rollupByKind,
	rollupByOper,
} from "../../client/js/helpers/operActivity";
import {NOTICE_KINDS} from "../../client/js/irc/profiles/nefarious/notices";

const T0 = Date.UTC(2026, 9, 10, 20, 0, 0);
const MIN = 60_000;

function snotice(
	kind: string,
	fields: Record<string, string>,
	at = 0,
	extra: Partial<LoggedNotice> = {}
): LoggedNotice {
	const category = NOTICE_KINDS.find((k) => k.kind === kind)?.category ?? "OTHER";
	return {
		time: T0 + at * MIN,
		type: "snotice",
		text: `${kind} ${JSON.stringify(fields)}`,
		snotice: {kind, category, fields, route: "network"},
		...extra,
	};
}

function wallops(from: string, kind = "wallops", at = 0): LoggedNotice {
	return {
		time: T0 + at * MIN,
		type: "wallops",
		text: "hello",
		from,
		snotice: {kind, category: "WALLOPS", fields: {}, route: "active"},
	};
}

describe("oper activity rollup (helpers/operActivity.ts)", function () {
	it("names the actor of each kind of action, and nobody for plumbing", function () {
		expect(actorOf(snotice("ban.add", {oper: "alice", mask: "*@1.2.3.4"}))).to.deep.equal({
			type: "nick",
			name: "alice",
		});
		expect(actorOf(snotice("kill.oper", {killer: "bob", nick: "victim"}))).to.deep.equal({
			type: "nick",
			name: "bob",
		});
		expect(actorOf(snotice("oper.up", {nick: "carol", host: "c@h"}))).to.deep.equal({
			type: "nick",
			name: "carol",
		});
		expect(actorOf(snotice("hack.mode", {nick: "X3", channel: "#a"}))).to.deep.equal({
			type: "nick",
			name: "X3",
		});
		expect(actorOf(snotice("rehash", {oper: "dave"}))).to.deep.equal({
			type: "nick",
			name: "dave",
		});
		expect(actorOf(snotice("squit", {oper: "dave", server: "leaf.test"}))).to.deep.equal({
			type: "nick",
			name: "dave",
		});

		// A ban set by a server, a server's own kill, a hit: the servers row.
		expect(actorOf(snotice("ban.add", {server: "hub.test", mask: "*@1.2.3.4"}))).to.deep.equal({
			type: "server",
			name: "hub.test",
		});
		expect(actorOf(snotice("kill.server", {server: "hub.test", nick: "v"}))).to.deep.equal({
			type: "server",
			name: "hub.test",
		});
		expect(actorOf(snotice("ban.hit", {nick: "victim", type: "G-line"}))).to.deep.equal({
			type: "server",
			name: "server",
		});
		expect(
			actorOf(
				snotice("dnsbl.block", {nick: "v"}, 0, {
					snotice: {
						kind: "dnsbl.block",
						category: "GLINE",
						fields: {nick: "v"},
						origin: "leaf.test",
					},
				})
			)
		).to.deep.equal({type: "server", name: "leaf.test"});

		// The network running itself is not anybody's action.
		for (const kind of [
			"client.connect",
			"client.exit",
			"nick.change",
			"net.junction",
			"net.break",
			"net.burst",
			"link.established",
			"log.info",
			"tls.loaded",
			"webpush.key",
			"conn.unauth",
			"iauth",
			"webirc.host",
			"config.error",
			"clock",
			"gitsync",
			"server.internal",
			"bouncer.event",
			"unknown",
		]) {
			expect(actorOf(snotice(kind, {nick: "x", server: "s.test"})), kind).to.equal(undefined);
			expect(isOperAction(snotice(kind, {})), kind).to.equal(false);
		}

		// WALLOPS: a person, or a server.
		expect(actorOf(wallops("alice"))).to.deep.equal({type: "nick", name: "alice"});
		expect(actorOf(wallops("hub.test", "wallops.server"))).to.deep.equal({
			type: "server",
			name: "hub.test",
		});
		expect(actorOf(wallops("hub.test", "desynch"))).to.deep.equal({
			type: "server",
			name: "hub.test",
		});
	});

	it("folds every kind into a coarse kind, in a fixed order", function () {
		expect(coarseKindOf(snotice("ban.add", {}))).to.equal("glines");
		expect(coarseKindOf(snotice("ban.hit", {}))).to.equal("glines");
		expect(coarseKindOf(snotice("shun.match", {}))).to.equal("glines");
		expect(coarseKindOf(snotice("kill.server", {}))).to.equal("kills");
		expect(coarseKindOf(snotice("hack.kick", {}))).to.equal("modes");
		expect(coarseKindOf(snotice("deop.service", {}))).to.equal("modes");
		expect(coarseKindOf(snotice("oper.fail", {}))).to.equal("opers");
		expect(coarseKindOf(snotice("jupe.deactivate", {}))).to.equal("jupes");
		expect(coarseKindOf(snotice("net.break", {}))).to.equal("links");
		expect(coarseKindOf(snotice("sendq.exceeded", {}))).to.equal("links");
		expect(coarseKindOf(snotice("restart", {}))).to.equal("rehash");
		expect(coarseKindOf(wallops("a"))).to.equal("wallops");
		expect(coarseKindOf(wallops("hub.test", "desynch"))).to.equal("wallops");
		expect(coarseKindOf(snotice("client.connect", {}))).to.equal("other");
		expect(coarseKindOf(snotice("unknown", {}))).to.equal("other");
		expect(coarseKindOf(snotice("whois.notify", {}))).to.equal("other");

		// Every kind in the table is a real nefarious2 kind (or a WALLOPS one).
		const known = new Set([
			...NOTICE_KINDS.map((k) => k.kind),
			"wallops",
			"wallusers",
			"wallops.server",
			"desynch",
		]);

		for (const kind of Object.keys(KIND_COARSE)) {
			expect(known.has(kind), kind).to.equal(true);
		}

		expect(COARSE_KINDS.map((k) => k.id)).to.deep.equal([
			"glines",
			"kills",
			"modes",
			"opers",
			"alerts",
			"jupes",
			"links",
			"rehash",
			"wallops",
			"other",
		]);
	});

	it("counts a kind in the singular when there is one", function () {
		expect(countLabel("opers", 1)).to.equal("1 oper-up");
		expect(countLabel("opers", 3)).to.equal("3 oper-ups");
		expect(countLabel("glines", 1)).to.equal("1 G-line");
		expect(countLabel("glines", 12)).to.equal("12 G-lines");
		expect(countLabel("kills", 1)).to.equal("1 kill");
		expect(countLabel("modes", 2)).to.equal("2 channel modes");
		expect(countLabel("modes", 1)).to.equal("1 channel mode");
		expect(countLabel("wallops", 1)).to.equal("1 WALLOPS");
		expect(countLabel("other", 1)).to.equal("1 other action");
	});

	describe("the services feed (irc/servicesfeed.ts entries)", function () {
		const bots = {serviceNicks: ["O3", "AuthServ", "ChanServ"]};

		function audit(coarse: string, from: string, at = 0): LoggedNotice {
			return {
				time: T0 + at * MIN,
				type: "audit",
				text: `() [${from}!i@h:acct]: something`,
				from,
				snotice: {
					kind: `x3.audit.${coarse}`,
					category: "SERVICES",
					fields: {nick: from, ident: "i", host: "h", command: "something", args: ""},
					route: "network",
				},
			};
		}

		function snoop(keyword: string, fields: Record<string, string>, at = 0): LoggedNotice {
			return {
				time: T0 + at * MIN,
				type: "snoop",
				text: `[21:14:00] ${keyword.toUpperCase()} …`,
				snotice: {
					kind: `x3.snoop.${keyword}`,
					category: "SERVICES",
					fields,
					route: "network",
				},
			};
		}

		it("credits an audit line to the person who typed it, by its coarse kind", function () {
			expect(actorOf(audit("glines", "Rubin"), bots)).to.deep.equal({
				type: "nick",
				name: "Rubin",
			});
			expect(coarseKindOf(audit("glines", "Rubin"))).to.equal("glines");
			expect(coarseKindOf(audit("modes", "n"))).to.equal("modes");
			expect(coarseKindOf(audit("alerts", "n"))).to.equal("alerts");
			expect(coarseKindOf(audit("opers", "n"))).to.equal("opers");
			expect(coarseKindOf(audit("other", "n"))).to.equal("other");
			expect(coarseKindOf(audit("nonsense", "n"))).to.equal("other");
			expect(isOperAction(audit("other", "n"), bots)).to.equal(true);

			// A module log line has no human behind it.
			const log: LoggedNotice = {
				...audit("x", "n"),
				from: undefined,
				snotice: {
					kind: "x3.log.info",
					category: "SERVICES",
					fields: {facility: "OpServ", severity: "info", message: "m"},
				},
			};
			expect(actorOf(log, bots)).to.equal(undefined);
			expect(coarseKindOf(log)).to.equal("other");
		});

		it("counts a snoop line nowhere: not an action, not a kind, not everything else", function () {
			// The snoop channel is the cards' source and a place to click,
			// never oper actions (rubin, 2026-10-11) — whatever the keyword,
			// an oper-up and a bot's kill or mode included.
			const lines: [string, Record<string, string>][] = [
				["oper", {nick: "rubin", ident: "~r", host: "h"}],
				["kill", {nick: "troll", killer: "O3"}],
				["mode", {channel: "#a", modes: "+o x", setter: "ChanServ"}],
				["mode", {channel: "#a", modes: "+m", setter: "alice"}],
				["connect", {nick: "x", ip: "1.2.3.4"}],
				["join", {channel: "#a", nick: "x"}],
				["part", {channel: "#a", nick: "x"}],
				["quit", {nick: "x"}],
				["nick", {nick: "x", newNick: "y"}],
				["auth", {nick: "x", account: "x"}],
				["umode", {nick: "x", modes: "+x", cloak: "AN-1A2B3C4D.example.net"}],
			];

			for (const [keyword, fields] of lines) {
				expect(isCounted(snoop(keyword, fields)), keyword).to.equal(false);
				expect(actorOf(snoop(keyword, fields), bots), keyword).to.equal(undefined);
				expect(actorOf(snoop(keyword, fields)), keyword).to.equal(undefined);
				expect(isOperAction(snoop(keyword, fields), bots), keyword).to.equal(false);
			}

			const entries = lines.map(([keyword, fields], i) => snoop(keyword, fields, i));
			expect(rollupByOper(entries, T0 - MIN, bots)).to.deep.equal([]);
			expect(rollupByKind(entries, T0 - MIN)).to.deep.equal([]);

			// The notices and the audit lines count as before.
			expect(isCounted(snotice("client.connect", {nick: "x"}))).to.equal(true);
			expect(isCounted(audit("glines", "Rubin"))).to.equal(true);
			expect(isCounted(wallops("alice"))).to.equal(true);
		});

		it("rolls the audit lines up with the notices: humans, then the services row", function () {
			const entries = [
				snotice("ban.add", {oper: "alice", mask: "a"}, 0),
				audit("glines", "alice", 1),
				audit("glines", "Rubin", 2),
				audit("opers", "Rubin", 3),
				snoop("oper", {nick: "Rubin"}, 4),
				snoop("kill", {nick: "troll", killer: "O3"}, 5),
				snoop("join", {channel: "#a", nick: "x"}, 6),
				snotice("hack.mode", {nick: "ChanServ", channel: "#a"}, 7),
				snotice("client.connect", {nick: "x"}, 8),
			];

			const rows = rollupByOper(entries, T0 - MIN, bots);
			expect(rows.map((r) => [r.key, r.count])).to.deep.equal([
				["nick:alice", 2],
				["nick:rubin", 2],
				["services", 1],
			]);
			expect(rows[1].groups.map((g) => [g.coarse, g.count])).to.deep.equal([
				["glines", 1],
				["opers", 1],
			]);
			expect(rows[2].actor).to.deep.equal({type: "service", name: "services"});
			expect(rows[2].groups.map((g) => [g.coarse, g.count])).to.deep.equal([["modes", 1]]);

			const kinds = rollupByKind(entries, T0 - MIN);
			expect(kinds.map((g) => [g.coarse, g.count])).to.deep.equal([
				["glines", 3],
				["modes", 1],
				["opers", 1],
				["other", 1],
			]);
			expect(kinds[3].entries.map((e) => e.snotice.kind)).to.deep.equal(["client.connect"]);
		});
	});

	it("periods: local midnight, a day back, the page load", function () {
		const now = new Date(2026, 9, 10, 21, 14, 0).getTime();
		expect(periodStart("today", now)).to.equal(new Date(2026, 9, 10, 0, 0, 0).getTime());
		expect(periodStart("24h", now)).to.equal(now - 24 * 3600_000);
		expect(periodStart("reload", now, now - 5000)).to.equal(now - 5000);
		expect(
			inPeriod(
				[snotice("rehash", {oper: "a"}, 0), snotice("rehash", {oper: "a"}, 10)],
				T0 + 5 * MIN
			)
		).to.have.length(1);
	});

	it("by oper: a row per actor, busiest first, kinds in order, notices newest first", function () {
		const entries = [
			snotice("ban.add", {oper: "alice", mask: "a"}, 0),
			snotice("ban.add", {oper: "alice", mask: "b"}, 2),
			snotice("hack.mode", {nick: "alice", channel: "#x"}, 5),
			snotice("kill.oper", {killer: "Bob", nick: "v"}, 1),
			snotice("ban.add", {oper: "bob", mask: "c"}, 3),
			snotice("ban.add", {oper: "bob", mask: "d"}, 4),
			snotice("client.connect", {nick: "nobody"}, 6),
			snotice("kill.server", {server: "hub.test", nick: "v"}, 7),
			wallops("carol", "wallops", 8),
			wallops("hub.test", "wallops.server", 9),
		];

		const rows = rollupByOper(entries, T0 - MIN);
		expect(rows.map((r) => [r.key, r.count])).to.deep.equal([
			["nick:alice", 3],
			["nick:bob", 3],
			["nick:carol", 1],
			["servers", 2],
		]);
		expect(rows[0].actor).to.deep.equal({type: "nick", name: "alice"});
		expect(rows[0].last).to.equal(T0 + 5 * MIN);
		expect(rows[0].groups.map((g) => [g.coarse, g.count, g.first, g.last])).to.deep.equal([
			["glines", 2, T0, T0 + 2 * MIN],
			["modes", 1, T0 + 5 * MIN, T0 + 5 * MIN],
		]);
		expect(rows[0].groups[0].entries.map((e) => e.time)).to.deep.equal([T0 + 2 * MIN, T0]);

		// Bob's and bob's are one row, named as first seen, with kills before G-lines.
		expect(rows[1].actor.name).to.equal("Bob");
		expect(rows[1].groups.map((g) => g.coarse)).to.deep.equal(["glines", "kills"]);

		// The servers row holds the server's kill and the server's WALLOPS.
		expect(rows[3].actor).to.deep.equal({type: "server", name: "servers"});
		expect(rows[3].groups.map((g) => g.coarse)).to.deep.equal(["kills", "wallops"]);

		expect(rollupByOper(entries, T0 + 60 * MIN)).to.deep.equal([]);
	});

	it("by oper: an outlying total is hot — over three times the others' median, and at least five", function () {
		const many = (oper: string, n: number, from: number) =>
			Array.from({length: n}, (_, i) => snotice("ban.add", {oper, mask: `m${i}`}, from + i));

		let rows = rollupByOper(
			[...many("alice", 13, 0), ...many("bob", 2, 20), ...many("carol", 3, 30)],
			T0 - MIN
		);
		expect(rows.map((r) => [r.actor.name, r.hot])).to.deep.equal([
			["alice", true],
			["carol", false],
			["bob", false],
		]);

		// Four is never hot; nor is a lone oper, with nobody to compare to.
		rows = rollupByOper([...many("alice", 4, 0), ...many("bob", 1, 20)], T0 - MIN);
		expect(rows[0].hot).to.equal(false);
		rows = rollupByOper(many("alice", 40, 0), T0 - MIN);
		expect(rows[0].hot).to.equal(false);

		// The servers row is never hot and never counted among the others.
		rows = rollupByOper(
			[
				...many("alice", 6, 0),
				...many("bob", 1, 20),
				...many("hub.test", 50, 30).map((e) =>
					snotice("kill.server", {server: "hub.test"}, 0)
				),
			],
			T0 - MIN
		);
		expect(rows.map((r) => [r.key, r.hot])).to.deep.equal([
			["nick:alice", true],
			["nick:bob", false],
			["servers", false],
		]);
	});

	it("by kind: a row per coarse kind in order, everything else last, with the plumbing", function () {
		const entries = [
			snotice("client.connect", {nick: "x"}, 0),
			snotice("net.junction", {server: "leaf.test"}, 1),
			snotice("ban.add", {oper: "alice", mask: "a"}, 2),
			snotice("oper.up", {nick: "bob"}, 3),
			snotice("client.exit", {nick: "x"}, 4),
			wallops("carol", "wallops", 5),
		];

		const groups = rollupByKind(entries, T0 - MIN);
		expect(groups.map((g) => [g.coarse, g.label, g.count])).to.deep.equal([
			["glines", "G-lines", 1],
			["opers", "Opers coming up", 1],
			["links", "Server links and splits", 1],
			["wallops", "WALLOPS", 1],
			["other", "Everything else", 2],
		]);
		expect(groups[4].entries.map((e) => e.snotice.kind)).to.deep.equal([
			"client.exit",
			"client.connect",
		]);
		expect(groups[4].last).to.equal(T0 + 4 * MIN);

		expect(rollupByKind(entries, T0 + 3 * MIN).map((g) => g.coarse)).to.deep.equal([
			"opers",
			"wallops",
			"other",
		]);
	});
});
