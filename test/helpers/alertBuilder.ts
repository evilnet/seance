import {expect} from "chai";
import {
	buildCommand,
	buildCriteria,
	criterionWord,
	defaultName,
	defaultReason,
	EXPIRIES,
	expiryFor,
	factCriterion,
	formFromAlert,
	isValidName,
	matchesText,
	newRow,
	parseCriteria,
	REACTIONS,
	reactionTooLow,
	rowsFromFacts,
	wideReason,
} from "../../client/js/helpers/alertBuilder";

describe("the alert builder's form (helpers/alertBuilder.ts)", function () {
	it("turns a channel card's facts into rows, the wide ones switched off", function () {
		const rows = rowsFromFacts([
			{key: "authed", value: "no"},
			{key: "connectAge", value: "< 15 min"},
			{key: "realname", value: "irc client"},
			{key: "identShape", value: "r????"},
			{key: "ipRange", value: "203.0.113.0/24"},
			{key: "server", value: "leaf2.example.net"},
			{key: "version", value: "mIRC v7.73"},
		]);

		expect(rows.map((r) => `${r.key}=${r.value}:${r.on ? "on" : "off"}`)).to.deep.equal([
			"authed=no:on",
			"info=irc client:on",
			"ident=r????:on",
			"ip=203.0.113.0/24:off",
			"server=leaf2.example.net:off",
			"version=mIRC v7.73:on",
		]);
		expect(rows.map((r) => r.id)).to.have.length(new Set(rows.map((r) => r.id)).size);

		// A user card's facts: an exact IP is not wide, a lone `authed no` is.
		expect(rowsFromFacts([{key: "ipRange", value: "203.0.113.7"}])[0].on).to.equal(true);
		expect(rowsFromFacts([{key: "authed", value: "no"}])[0].on).to.equal(false);
		expect(rowsFromFacts([{key: "authed", value: "yes"}])[0].on).to.equal(true);
		expect(factCriterion({key: "connectAge", value: "< 1 h"})).to.equal(undefined);
	});

	it("marks the wide criteria and says why, judged against the rows that are on", function () {
		const authed = newRow("authed", "no");
		const ident = newRow("ident", "r????");
		const rows = [authed, ident];

		expect(wideReason(authed, rows)).to.equal(undefined);
		ident.on = false;
		expect(wideReason(authed, rows)).to.equal("every unauthed user");
		expect(wideReason(newRow("ip", "203.0.113.*"), [])).to.equal("an IP range");
		expect(wideReason(newRow("ip", "203.0.113.0/24"), [])).to.equal("an IP range");
		expect(wideReason(newRow("ip", "203.0.113.7"), [])).to.equal(undefined);
		expect(wideReason(newRow("nickage", "<300"), [])).to.equal("a nick age");
		expect(wideReason(newRow("last", "1h"), [])).to.equal("a time window");
		expect(wideReason(newRow("server", "leaf2"), [])).to.equal("a whole server");
		expect(wideReason(newRow("clones", "2"), [])).to.equal("2 clones or fewer");
		expect(wideReason(newRow("clones", "3"), [])).to.equal(undefined);
		expect(wideReason(newRow("info", "irc client"), [])).to.equal(undefined);
	});

	it("assembles the command: expire in X3's units, info and version as one word, reason last", function () {
		const rows = [
			newRow("authed", "no"),
			newRow("info", "irc  client"),
			newRow("ident", "r????"),
			newRow("ip", "203.0.113.0/24", false),
			newRow("version", "mIRC v7.73"),
			newRow("host", "   "),
		];

		expect(criterionWord("info", " irc client ")).to.equal("irc?client");
		expect(criterionWord("ident", "r????")).to.equal("r????");
		expect(buildCriteria(rows)).to.equal(
			"authed no info irc?client ident r???? version mIRC?v7.73"
		);
		expect(
			buildCommand({
				name: "seance-bots",
				reaction: "notice",
				expires: "1w",
				rows,
				reason: "bot group in #seance, see rubin",
			})
		).to.equal(
			"addalert seance-bots notice expire 1w authed no info irc?client ident r???? version mIRC?v7.73 reason bot group in #seance, see rubin"
		);

		// Never: no expire; no reason: none; no name yet: a placeholder.
		expect(
			buildCommand({name: " ", reaction: "gline", expires: "never", rows: [], reason: " "})
		).to.equal("addalert <name> gline");
		expect(EXPIRIES.map((e) => e.id)).to.deep.equal(["1d", "3d", "1w", "1M", "never"]);
	});

	it("parses a stored criteria string back into rows and round-trips it", function () {
		const text =
			"authed no info irc?client ident r???? ip 203.0.113.0/24 reason bot group, see rubin";
		const {rows, reason} = parseCriteria(text);

		expect(rows.map((r) => [r.key, r.value, r.on])).to.deep.equal([
			["authed", "no", true],
			["info", "irc?client", true],
			["ident", "r????", true],
			["ip", "203.0.113.0/24", true],
		]);
		expect(reason).to.equal("bot group, see rubin");
		expect(
			buildCommand({
				name: "x",
				reaction: "notice",
				expires: "never",
				rows,
				reason: reason ?? "",
			})
		).to.equal(`addalert x notice ${text}`);

		// A keyword the builder does not list survives as typed; a dangling one is dropped.
		expect(parseCriteria("Numchannels 3 silent yes mask")).to.deep.equal({
			rows: [
				{id: rows[3].id + 1, key: "numchannels", value: "3", on: true},
				{id: rows[3].id + 2, key: "silent", value: "yes", on: true},
			],
		});
		expect(parseCriteria("")).to.deep.equal({rows: []});
	});

	it("builds the form of an existing alert: the nearest expiry option, an unknown reaction as notice", function () {
		const now = Date.parse("2026-10-11T12:00:00Z");
		const form = formFromAlert(
			{
				name: "seance-bots",
				reaction: "gline",
				owner: "rubin",
				expires: "2026-10-13 21:00:00 +0000",
				criteria: "ident r???? reason see rubin",
				triggered: "Never",
			},
			now
		);

		expect(form.name).to.equal("seance-bots");
		expect(form.reaction).to.equal("gline");
		expect(form.expires).to.equal("3d");
		expect(form.rows.map((r) => r.value)).to.deep.equal(["r????"]);
		expect(form.reason).to.equal("see rubin");

		expect(expiryFor(undefined, now)).to.equal("never");
		expect(expiryFor("2026-10-11 20:00:00 +0000", now)).to.equal("1d");
		expect(expiryFor("2026-10-17 12:00:00 +0000", now)).to.equal("1w");
		expect(expiryFor("2027-01-01 00:00:00 +0000", now)).to.equal("1M");
		expect(expiryFor("whenever", now)).to.equal("1w");
		expect(
			formFromAlert({name: "a", reaction: "track", owner: "o", criteria: ""}, now).reaction
		).to.equal("notice");
	});

	it("knows the defaults, the names O3 takes and the reaction levels", function () {
		expect(defaultName({channel: "#seance"})).to.equal("seance-bots");
		expect(defaultName({channel: "#my chan!"})).to.equal("my-chan-bots");
		expect(defaultName({nick: "spam[fan]"})).to.equal("spam-fan-alert");
		expect(defaultName({})).to.equal("");
		expect(defaultReason({channel: "#seance", me: "rubin"})).to.equal(
			"bot group in #seance, see rubin"
		);
		expect(defaultReason({me: "rubin"})).to.equal("see rubin");

		expect(isValidName("seance-bots")).to.equal(true);
		expect(isValidName("no spaces")).to.equal(false);
		expect(isValidName("")).to.equal(false);

		const byId = Object.fromEntries(REACTIONS.map((r) => [r.id, r.level]));
		expect(byId).to.deep.equal({
			notice: 800,
			noticeuser: 800,
			msguser: 800,
			gline: 900,
			shun: 900,
			tempshun: 900,
			kill: 900,
			mark: 999,
			version: 999,
			svsjoin: 999,
			svspart: 999,
		});
		expect(REACTIONS.find((r) => r.id === "svsjoin")?.needs).to.equal("chantarget");
		expect(reactionTooLow(REACTIONS[3], 800)).to.equal(true);
		expect(reactionTooLow(REACTIONS[3], 900)).to.equal(false);
		expect(reactionTooLow(REACTIONS[3], undefined)).to.equal(false);
	});

	it("words the count line and warns past 25", function () {
		expect(matchesText(0, [])).to.deep.equal({text: "Nothing matches right now.", warn: false});
		expect(matchesText(1, [])).to.deep.equal({
			text: "Matches 1 user right now · none are opers",
			warn: false,
		});
		expect(matchesText(3, ["rubin"])).to.deep.equal({
			text: "Matches 3 users right now · one is an oper: rubin",
			warn: false,
		});
		expect(matchesText(3, undefined).text).to.equal("Matches 3 users right now");
		expect(matchesText(40, ["a", "b"])).to.deep.equal({
			text: "Matches 40 users right now · 2 are opers: a, b — that's a lot; check the criteria",
			warn: true,
		});
	});
});
