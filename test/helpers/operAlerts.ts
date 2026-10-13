import {expect} from "chai";
import {
	alertLinesFor,
	endOfToday,
	HERE_DURATIONS,
	lineRoute,
	reconcileMask,
	untilText,
} from "../../client/js/helpers/operAlerts";
import {ALERT_LINES} from "../../client/js/irc/profiles/nefarious/alerts";
import {nefarious} from "../../client/js/irc/profiles/nefarious";
import {generic} from "../../client/js/irc/profiles/generic";
import {NEFARIOUS_SNOMASK} from "../../client/js/irc/profiles/nefarious/snomask";
import {allNoticeKinds} from "../../client/js/irc/snotice";
import type {Route} from "../../shared/types/oper";

describe("oper alert lines (helpers/operAlerts.ts, profiles/nefarious/alerts.ts)", function () {
	it("every nefarious2 kind is in exactly one line, or in the folded rest", function () {
		const kinds = allNoticeKinds(nefarious).map((k) => k.kind);
		const seen = new Map<string, number>();

		for (const line of ALERT_LINES) {
			for (const kind of line.kinds) {
				expect(kinds, `${line.id} names ${kind}`).to.include(kind);
				seen.set(kind, (seen.get(kind) ?? 0) + 1);
			}
		}

		for (const [kind, n] of seen) {
			expect(n, `${kind} is in one line`).to.equal(1);
		}

		const {lines, rest} = alertLinesFor(nefarious);
		expect(lines.map((l) => l.id)).to.deep.equal(ALERT_LINES.map((l) => l.id));
		expect(lines.map((l) => l.section)).to.deep.equal([
			...Array(7).fill("actions"),
			...Array(5).fill("network"),
		]);

		const restKinds = rest.map((l) => l.kinds[0]);
		expect(rest.every((l) => l.section === "else" && l.kinds.length === 1)).to.equal(true);
		expect(restKinds).to.include.members([
			"whois.notify",
			"webirc.host",
			"config.error",
			"iauth",
			"log.alert",
			"tls.fail",
			"webpush.error",
			"nick.collision",
			"bouncer.event",
			"bouncer.oreset",
			"server.internal",
			"store.defrag",
			"gitsync",
			"unknown",
		]);
		expect([...seen.keys(), ...restKinds].sort()).to.deep.equal([...kinds].sort());
	});

	it("a profile without lines gets one line per kind under the rest", function () {
		const {lines, rest} = alertLinesFor(generic);
		expect(lines).to.deep.equal([]);
		expect(rest.map((l) => l.kinds[0])).to.deep.equal([
			"wallops",
			"wallusers",
			"wallops.server",
			"desynch",
			"unknown",
		]);
		expect(rest[0]).to.include({id: "kind:wallops", label: "WALLOPS from opers"});
	});

	it("a line shows its first kind's route", function () {
		const routes: Record<string, Route> = {"ban.add": "off", "ban.activate": "active"};
		const line = ALERT_LINES[0];
		expect(lineRoute(line, (k) => routes[k] ?? "network")).to.equal("off");
		expect(lineRoute({kinds: ["kill.oper"]}, (k) => routes[k] ?? "network")).to.equal(
			"network"
		);
	});

	it("Off clears a server bit once every kind on it is off; a kind back on sets it", function () {
		const kinds = allNoticeKinds(nefarious);
		const model = NEFARIOUS_SNOMASK;
		const GLINE = 0x200;
		const OLDREALOP = 0x2000;
		const OLDSNO = 0x1;
		const off = new Set<string>();
		const isOff = (k: string) => off.has(k);
		const glineKinds = kinds.filter((k) => k.category === "GLINE").map((k) => k.kind);

		// Not every GLINE kind is off: the bit stays.
		off.add("ban.add");
		expect(reconcileMask(GLINE | OLDSNO, model, kinds, isOff, ["ban.add"])).to.equal(
			GLINE | OLDSNO
		);

		// All of them: cleared.
		glineKinds.forEach((k) => off.add(k));
		expect(reconcileMask(GLINE | OLDSNO, model, kinds, isOff, ["ban.hit"])).to.equal(OLDSNO);

		// One back on, with the bit clear: set again.
		off.delete("ban.add");
		expect(reconcileMask(OLDSNO, model, kinds, isOff, ["ban.add"])).to.equal(OLDSNO | GLINE);

		// Only the changed kinds' bits are touched: a change about failed
		// OPER never turns on a clear GLINE, and never clears OLDSNO.
		off.add("oper.fail");
		expect(reconcileMask(OLDSNO | OLDREALOP, model, kinds, isOff, ["oper.fail"])).to.equal(
			OLDSNO
		);
		off.delete("oper.fail");
		expect(reconcileMask(OLDSNO, model, kinds, isOff, ["oper.fail"])).to.equal(
			OLDSNO | OLDREALOP
		);

		// WALLOPS has no bit; nothing changes.
		off.add("wallops");
		expect(reconcileMask(OLDSNO, model, kinds, isOff, ["wallops", "desynch"])).to.equal(OLDSNO);

		// A dead bit is never set even with its kinds on (THROTTLE has none anyway).
		const dead = model.bits.find((b) => b.dead)!;
		expect(
			reconcileMask(
				0,
				model,
				[{kind: "x", label: "x", category: dead.name, route: "network"}],
				() => false,
				["x"]
			)
		).to.equal(0);
	});

	it("says what a temporary route has left", function () {
		const now = new Date(2026, 9, 10, 21, 0, 0).getTime();
		const tonight = new Date(2026, 9, 11, 0, 0, 0).getTime();
		expect(endOfToday(now)).to.equal(tonight);
		expect(untilText(tonight, now)).to.equal("until tonight");
		expect(untilText(now + 3600_000, now)).to.equal("until tonight");
		expect(untilText(tonight + 3600_000, now)).to.equal("until tomorrow");
		expect(untilText(now + 3 * 86400_000, now)).to.equal("3 more days");
		expect(untilText(now + 7 * 86400_000, now)).to.equal("7 more days");

		expect(HERE_DURATIONS.map((d) => d.label)).to.deep.equal([
			"for today",
			"for 3 days",
			"for a week",
			"until I change it",
		]);
		expect(HERE_DURATIONS[0].until(now)).to.equal(tonight);
		expect(HERE_DURATIONS[1].until(now)).to.equal(now + 3 * 86400_000);
		expect(HERE_DURATIONS[3].until(now)).to.equal(undefined);
	});
});
