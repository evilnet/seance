/**
 * A closed query stays closed (irc/closedQueries.ts): a line from before the
 * close never reopens it — the server's catch-up, an unwrapped replay, another
 * device's query log — while a line from after the close does.
 */

import {expect} from "chai";
import sinon from "sinon";
// The client first: pushMute and closedQueries are part of its import cycle.
import "../../client/js/irc/client";
import {ChanType} from "../../shared/types/chan";
import {MessageType} from "../../shared/types/msg";
import {
	CLOSED_TTL_MS,
	ClosedQueries,
	closedStorageChanged,
	onClosedSharingStopped,
	setClosedQueriesKept,
	decodeClosed,
	encodeClosed,
	mergeClosed,
	useStorageBackend,
} from "../../client/js/irc/closedQueries";
import type {SharedNetworkChan} from "../../shared/types/network";
import * as saved from "../../client/js/irc/saved-networks";
import {flushQueryLogs} from "../../client/js/irc/querylog";
import {MUTE_READ_DELAY_MS} from "../../client/js/irc/pushMute";
import {RESTORE_MAX_WAIT_MS} from "../../client/js/irc/persistence";
import {ALL_CAPS, Harness, joined, register, setup, stubStorage} from "./support";

const T0 = "2026-08-28T11:00:00.000Z";
const T1 = "2026-08-28T11:00:01.000Z";

/** The server's cursor replay: an outer `bouncer-replay` batch around one `chathistory` batch. */
function bouncerReplay(h: Harness, target: string, lines: string[]): void {
	h.transport.lines(
		":irc.test BATCH +outer evilnet.github.io/bouncer-replay",
		`@batch=outer; :irc.test BATCH +inner chathistory ${target}`,
		...lines.map((line) => `@batch=inner;${line.slice(1)}`),
		"@batch=outer :irc.test BATCH -inner",
		":irc.test BATCH -outer"
	);
}

/** The `join` payloads for query windows named `nick` (case-insensitive). */
function queryJoins(h: Harness, nick: string): SharedNetworkChan[] {
	return h
		.payloads<{chan: SharedNetworkChan}>("join")
		.map((p) => p.chan)
		.filter((c) => c.type === ChanType.QUERY && c.name.toLowerCase() === nick.toLowerCase());
}

/** A registered client that had a query with `from` (newest line at T0) and closed it. */
function closedQuery(from = "bob"): Harness {
	const h = setup();
	joined(h, ALL_CAPS);
	h.transport.line(`@time=${T0};msgid=p0 :${from}!bob@host PRIVMSG alice :hi`);
	const query = h.client.findChannel(from)!;
	expect(query.type).to.equal(ChanType.QUERY);
	h.client.input(query.id, "/close");
	expect(h.client.findChannel(from)).to.equal(undefined);
	h.dispatch.resetHistory();
	return h;
}

describe("closed queries (irc/closedQueries.ts)", function () {
	let clock: sinon.SinonFakeTimers;

	beforeEach(function () {
		stubStorage();
		clock = sinon.useFakeTimers({now: Date.parse("2026-08-28T12:00:00.000Z")});
	});

	afterEach(function () {
		clock.restore();
		sinon.restore();
		setClosedQueriesKept(true);
		onClosedSharingStopped(null);
	});

	describe("the reopen paths", function () {
		it("a catch-up line from before the close does not reopen it", function () {
			const h = closedQuery();
			bouncerReplay(h, "bob", [`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`]);
			expect(queryJoins(h, "bob")).to.deep.equal([]);
		});

		it("an unwrapped replayed line from before the close does not reopen it", function () {
			const h = closedQuery();
			h.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			expect(queryJoins(h, "bob")).to.deep.equal([]);
		});

		it("a replayed line in a batch keeps it closed, past the settling window too", function () {
			const h = closedQuery();
			clock.tick(RESTORE_MAX_WAIT_MS);
			h.transport.line(":irc.test BATCH +r1 example.org/replay");
			h.transport.line(`@batch=r1;time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			h.transport.line(":irc.test BATCH -r1");
			expect(queryJoins(h, "bob")).to.deep.equal([]);
		});

		it("a live line opens it whatever its time, and a reload keeps it open", function () {
			// bob's server stamps his reply before our last line (it crossed
			// ours, or his clock is behind); it arrives after the close.
			const uuid = "closed-live-net";
			const first = setup({uuid});
			joined(first, ALL_CAPS);
			first.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			first.transport.line(`@time=${T1};msgid=p1 :alice!a@h PRIVMSG bob :bye`);
			first.client.input(first.client.findChannel("bob")!.id, "/close");
			clock.tick(RESTORE_MAX_WAIT_MS);
			first.dispatch.resetHistory();
			const crossed = new Date(Date.parse(T1) - 2000).toISOString();
			first.transport.line(`@time=${crossed};msgid=p2 :bob!bob@host PRIVMSG alice :wait`);
			expect(queryJoins(first, "bob")).to.have.length(1);

			// The next page load replays it: it stays.
			const second = setup({uuid});
			joined(second, ALL_CAPS);
			second.transport.line(`@time=${crossed};msgid=p2 :bob!bob@host PRIVMSG alice :wait`);
			expect(queryJoins(second, "bob")).to.have.length(1);
		});

		it("a line after the close reopens it", function () {
			const h = closedQuery();
			h.transport.line(`@time=${T1};msgid=p1 :bob!bob@host PRIVMSG alice :again`);
			expect(queryJoins(h, "bob")).to.have.length(1);
		});

		it("a catch-up line from after the close reopens it, without the older ones", function () {
			const h = closedQuery();
			bouncerReplay(h, "bob", [
				`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`,
				`@time=${T1};msgid=p1 :bob!bob@host PRIVMSG alice :while you were away`,
			]);
			expect(queryJoins(h, "bob")).to.have.length(1);
			const id = h.client.findChannel("bob")!.id;
			expect(h.messages(id).map((m) => m.text)).to.deep.equal(["while you were away"]);
		});

		it("a query log from before another tab closed it is not restored", function () {
			const uuid = "closed-restore-net";
			saved.save({
				uuid,
				name: "",
				host: "irc.test",
				port: 8443,
				tls: true,
				nick: "alice",
				join: "#seance",
				sasl: "",
				saslAccount: "",
				saslPassword: "",
			});
			const first = setup({uuid});
			joined(first, ALL_CAPS);
			first.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			flushQueryLogs();
			// Another tab closed it.
			new ClosedQueries(uuid, (n) => n.toLowerCase()).close("bob", Date.parse(T0));

			const second = setup({uuid});
			expect(second.client.findChannel("bob")).to.equal(undefined);
			expect(second.client.queryLog.names()).to.deep.equal([]);
		});

		it("the user's /query forgets the close", function () {
			const h = closedQuery();
			h.client.input(h.client.lobby.id, "/query bob");
			expect(h.client.closed.suppresses("bob", new Date(T0))).to.equal(false);
		});

		it("a line made on this device does not move the close", function () {
			const h = setup();
			joined(h, ALL_CAPS);
			h.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			const query = h.client.findChannel("bob")!;
			// An error the client itself pushes into the query, at the device's 12:00.
			h.client.pushMessage(query, {type: MessageType.ERROR, text: "not here"});
			h.client.input(query.id, "/close");
			h.dispatch.resetHistory();
			h.transport.line(
				`@time=2026-08-28T11:30:00.000Z;msgid=p1 :bob!bob@host PRIVMSG alice :later`
			);
			expect(queryJoins(h, "bob")).to.have.length(1);
		});

		it("a query with no line from the server leaves no tombstone", function () {
			const h = setup();
			joined(h, ALL_CAPS);
			h.client.input(h.client.lobby.id, "/query bob");
			const query = h.client.findChannel("bob")!;
			h.client.pushMessage(query, {type: MessageType.ERROR, text: "not here"});
			h.client.input(query.id, "/close");
			expect(h.client.closed.entries()).to.deep.equal([]);
		});

		it("matches the nick by the network's casemapping", function () {
			const h = closedQuery("Bob");
			bouncerReplay(h, "bob", [`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`]);
			expect(queryJoins(h, "bob")).to.deep.equal([]);
		});
	});

	describe("the tombstone model", function () {
		const NOW = Date.parse("2026-08-28T12:00:00.000Z");
		const close = (nick: string, at: number, when: number) => ({nick, at, when});
		const reopened = (nick: string, when: number) => ({nick, at: 0, when, open: true});

		afterEach(function () {
			useStorageBackend(null);
			setClosedQueriesKept(true);
		});

		it("round-trips closes and reopens through the wire form", function () {
			const entries = [
				close("bob", NOW - 60000, NOW - 1000),
				reopened("[c]arol", NOW - 5000),
			];
			expect(decodeClosed(encodeClosed(entries, 300, NOW), NOW)).to.deep.equal(entries);
		});

		it("reads a close made at its boundary, which carries no offset", function () {
			expect(decodeClosed(`bob:${(NOW - 1000).toString(36)}`, NOW)).to.deep.equal([
				close("bob", NOW - 1000, NOW - 1000),
			]);
		});

		it("keeps the newest events within the byte limit", function () {
			const entries = Array.from({length: 40}, (_, i) =>
				close(`nick${i}`, NOW - i * 1000 - 5000, NOW - i * 1000)
			);
			const value = encodeClosed(entries, 300, NOW);
			expect(new TextEncoder().encode(value).length).to.be.at.most(300);
			const kept = decodeClosed(value, NOW);
			expect(kept).to.deep.equal(entries.slice(0, kept.length));
			expect(kept.length).to.be.greaterThan(5);
		});

		it("drops events older than the TTL", function () {
			const value = encodeClosed(
				[
					close("old", NOW - CLOSED_TTL_MS - 2, NOW - CLOSED_TTL_MS - 1),
					close("new", NOW - 2, NOW - 1),
				],
				300,
				NOW
			);
			expect(decodeClosed(value, NOW).map((e) => e.nick)).to.deep.equal(["new"]);
		});

		it("keeps a close's event time to the millisecond on the wire", function () {
			const entries = [close("bob", NOW - 60000, NOW - 54400)];
			expect(decodeClosed(encodeClosed(entries, 300, NOW), NOW)).to.deep.equal(entries);
		});

		it("drops expired events when reading, as when writing", function () {
			const old = NOW - CLOSED_TTL_MS - 1000;
			expect(decodeClosed(`bob:${old.toString(36)}`, NOW)).to.deep.equal([]);
		});

		it("skips malformed items", function () {
			expect(
				decodeClosed(`x:${NOW.toString(36)} bad :: y:! z:+1`, NOW).map((e) => e.nick)
			).to.deep.equal(["x"]);
		});

		it("drops anything dated in the future (a clock ahead, or a value written to silence a nick)", function () {
			expect(decodeClosed("bob:zzzzzzzzzz carol:!zzzzzzzzzz", NOW)).to.deep.equal([]);
			expect(decodeClosed(`dave:${(NOW + 30000).toString(36)}`, NOW)).to.have.length(1); // within the skew allowance
			// The account's values keep to a minute, not this device's 15.
			expect(decodeClosed(`erin:${(NOW + 5 * 60000).toString(36)}`, NOW)).to.deep.equal([]);
		});

		it("merges by keeping each nick's newer event, a close or a reopen", function () {
			expect(
				mergeClosed([close("bob", NOW - 9000, NOW - 5000)], [reopened("bob", NOW - 3000)])
			).to.deep.equal([reopened("bob", NOW - 3000)]);
			expect(
				mergeClosed([reopened("bob", NOW - 3000)], [close("bob", NOW - 9000, NOW - 1000)])
			).to.deep.equal([close("bob", NOW - 9000, NOW - 1000)]);
		});

		it("suppresses a line at the close's boundary but not one after it, and nothing once reopened", function () {
			const closed = new ClosedQueries("net-a", (s) => s.toLowerCase());
			closed.close("Bob", NOW - 60000);
			expect(closed.suppresses("bob", new Date(NOW - 60000))).to.equal(true);
			expect(closed.suppresses("BOB", new Date(NOW - 59999))).to.equal(false);
			closed.reopen("bob");
			expect(closed.suppresses("bob", new Date(0))).to.equal(false);
		});

		it("never dates its own close more than 15 minutes after now", function () {
			const closed = new ClosedQueries("net-g", (s) => s);
			closed.close("bob", NOW + 3600000);
			expect(closed.entries()[0].at).to.be.at.most(NOW + 15 * 60000);
		});

		it("keeps tombstones per network across instances", function () {
			const data = new Map<string, string>();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
			new ClosedQueries("net-c", (s) => s).close("bob", NOW - 1000);
			expect(
				new ClosedQueries("net-c", (s) => s).suppresses("bob", new Date(NOW - 1000))
			).to.equal(true);
			expect(
				new ClosedQueries("net-d", (s) => s).suppresses("bob", new Date(NOW - 1000))
			).to.equal(false);
		});

		it("removing the network forgets its tombstones", function () {
			const closed = new ClosedQueries("net-f", (s) => s);
			closed.close("bob", NOW - 1000);
			saved.remove("net-f");
			expect(closed.entries()).to.deep.equal([]);
		});

		it("adopts only events newer than the ones held, and reports them", function () {
			const closed = new ClosedQueries("net-e", (s) => s.toLowerCase());
			closed.close("bob", NOW - 10000);
			expect(
				closed.adopt([
					close("BOB", NOW - 20000, NOW - 50000),
					close("carol", NOW - 80000, NOW - 70000),
				])
			).to.deep.equal([close("carol", NOW - 80000, NOW - 70000)]);
			expect(closed.entries().map((e) => e.nick)).to.deep.equal(["bob", "carol"]);
		});

		it("holds closes in memory only while private conversations are not kept", function () {
			const data = new Map<string, string>();
			useStorageBackend({
				get: (k) => data.get(k) ?? null,
				set: (k, v) => void data.set(k, v),
				remove: (k) => void data.delete(k),
			});
			setClosedQueriesKept(false);
			const closed = new ClosedQueries("net-h", (s) => s);
			closed.close("bob", NOW - 1000);
			expect(closed.suppresses("bob", new Date(NOW - 1000))).to.equal(true);
			expect(data.size).to.equal(0);
		});
	});

	describe("shared between devices and tabs", function () {
		const META_CAPS = `${ALL_CAPS} draft/metadata-2=max-subs=50,max-keys=20,max-value-bytes=300`;
		const t0 = Date.parse(T0);
		const t36 = (ms: number) => ms.toString(36);

		/** Registered with an account and draft/metadata-2. */
		function account(): Harness {
			const h = setup();
			register(h, META_CAPS, [
				":irc.test 900 alice alice!a@h alice :You are now logged in as alice",
			]);
			return h;
		}

		const sets = (h: Harness) =>
			h.transport.sent.filter((l) => l.startsWith("METADATA * SET seance/closed"));

		/** A query with bob opened by his line at T0, then closed by the user. */
		function closeBob(h: Harness): void {
			h.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			h.client.input(h.client.findChannel("bob")!.id, "/close");
		}

		it("subscribes and reads seance/closed with the other shared keys", function () {
			const h = account();
			clock.tick(MUTE_READ_DELAY_MS);
			const read = h.transport.sent.filter((l) => / (SUB|GET) /.test(l));
			expect(read).to.have.length(2);
			expect(read[0]).to.match(/^METADATA \* SUB .* seance\/closed$/);
			expect(read[1]).to.match(/^METADATA \* GET .* seance\/closed$/);
		});

		it("writes a close private, merged with what the server holds", function () {
			const h = account();
			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(
				`:irc.test 761 alice alice seance/closed private :carol:${t36(t0 - 60000)}`
			);
			closeBob(h);
			expect(sets(h)).to.deep.equal([
				// Closed 3610 s after its newest line: 12:00:10, after the 10 s login read.
				`METADATA * SET seance/closed private :bob:${t36(t0)}+${(3610000).toString(
					36
				)} carol:${t36(t0 - 60000)}`,
			]);
		});

		it("waits for the read before writing", function () {
			const h = account();
			closeBob(h);
			expect(sets(h)).to.deep.equal([]);
			clock.tick(MUTE_READ_DELAY_MS);
			expect(sets(h)).to.deep.equal([]);
			h.transport.line(":irc.test 766 alice alice seance/closed :key not set");
			expect(sets(h)).to.deep.equal([
				`METADATA * SET seance/closed private :bob:${t36(t0)}+${(3600000).toString(36)}`,
			]);
		});

		it("does not take a notification alone as the read (the burst can be stale)", function () {
			const h = account();
			closeBob(h);
			h.transport.line(`:irc.test METADATA alice seance/closed * :carol:${t36(t0 - 60000)}`);
			expect(sets(h)).to.deep.equal([]);
		});

		it("removes a window it opened by itself once a later-arriving tombstone covers it", function () {
			const h = account();
			h.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			const id = h.client.findChannel("bob")!.id;
			h.dispatch.resetHistory();
			h.transport.line(`:irc.test 761 alice alice seance/closed private :bob:${t36(t0)}`);
			expect(h.payloads<{chan: number}>("part")).to.deep.equal([{chan: id}]);
			expect(h.client.findChannel("bob")).to.equal(undefined);
		});

		it("never removes a window the user opened or read", function () {
			const h = account();
			h.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			h.client.open(h.client.findChannel("bob")!.id);
			h.dispatch.resetHistory();
			h.transport.line(`:irc.test 761 alice alice seance/closed private :bob:${t36(t0)}`);
			expect(h.payloads("part")).to.deep.equal([]);
		});

		it("keeps a window whose newest line is after the tombstone", function () {
			const h = account();
			h.transport.line(`@time=${T1};msgid=p1 :bob!bob@host PRIVMSG alice :again`);
			h.dispatch.resetHistory();
			h.transport.line(`:irc.test 761 alice alice seance/closed private :bob:${t36(t0)}`);
			expect(h.payloads("part")).to.deep.equal([]);
		});

		it("keeps both closes when two devices close different queries", function () {
			const h = account();
			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(":irc.test 766 alice alice seance/closed :key not set");
			closeBob(h);
			// The other device's write, made without ours.
			h.transport.line(`:irc.test METADATA alice seance/closed * :erin:${t36(t0 - 5000)}`);
			h.transport.line(`@time=${T1};msgid=d1 :dave!dave@host PRIVMSG alice :yo`);
			h.client.input(h.client.findChannel("dave")!.id, "/close");
			expect(sets(h).pop()).to.equal(
				`METADATA * SET seance/closed private :dave:${t36(
					Date.parse(T1)
				)}+${(3609000).toString(36)} bob:${t36(t0)}+${(3610000).toString(36)} erin:${t36(
					t0 - 5000
				)}`
			);
		});

		it("keeps the write within the 500-byte line cap whatever the server allows", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/metadata-2=max-value-bytes=2000`, [
				":irc.test 900 alice alice!a@h alice :You are now logged in as alice",
			]);

			for (let i = 0; i < 40; i++) {
				h.client.closed.close(`somewhatlongnick${i}`, t0 - i * 1000);
			}

			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(":irc.test 766 alice alice seance/closed :key not set");
			closeBob(h);
			const line = sets(h).pop() as string;
			expect(new TextEncoder().encode(line).length).to.be.at.most(500);
			expect(line).to.match(/[ :]bob:/);
		});

		it("does not adopt a close dated in the future, so it silences nothing", function () {
			const h = account();
			h.transport.line(":irc.test 761 alice alice seance/closed private :bob:zzzzzzzzzz");
			h.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			expect(queryJoins(h, "bob")).to.have.length(1);
		});

		it("shares a /query reopen, and the next read does not undo it", function () {
			const h = account();
			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(":irc.test 766 alice alice seance/closed :key not set");
			closeBob(h);
			h.client.input(h.client.lobby.id, "/query bob");
			expect(sets(h).pop()).to.match(/ :bob:!/);
			// A copy of the account's value from before the reopen.
			h.transport.line(`:irc.test 761 alice alice seance/closed private :bob:${t36(t0)}`);
			expect(h.client.closed.suppresses("bob", new Date(T0))).to.equal(false);
		});

		it("turning private conversations off deletes the account's shared list and shares no more", function () {
			const h = account();
			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(":irc.test 766 alice alice seance/closed :key not set");
			closeBob(h);
			onClosedSharingStopped(() => h.client.unshareClosed());
			setClosedQueriesKept(false);
			expect(sets(h).pop()).to.equal("METADATA * SET seance/closed");
			const before = sets(h).length;
			h.transport.line(`@time=${T1};msgid=d1 :dave!dave@host PRIVMSG alice :yo`);
			h.client.input(h.client.findChannel("dave")!.id, "/close");
			expect(sets(h).length).to.equal(before);
		});

		it("reads a max-value-bytes it cannot take as a plain number as nefarious2's 300", function () {
			const h = setup();
			register(h, `${ALL_CAPS} draft/metadata-2=max-value-bytes=1e3`, [
				":irc.test 900 alice alice!a@h alice :You are now logged in as alice",
			]);
			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(":irc.test 766 alice alice seance/closed :key not set");
			closeBob(h);
			expect(sets(h).pop()).to.match(/ :bob:/);
		});

		it("a /query of a nick with nothing to reopen writes nothing", function () {
			const h = account();
			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(":irc.test 766 alice alice seance/closed :key not set");
			h.client.input(h.client.lobby.id, "/query dave");
			expect(sets(h)).to.deep.equal([]);
		});

		it("a /query before the login read outranks an older close that arrives with it", function () {
			const h = account();
			h.client.input(h.client.lobby.id, "/query bob");
			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(`:irc.test 761 alice alice seance/closed private :bob:${t36(t0)}`);
			expect(h.client.closed.suppresses("bob", new Date(T0))).to.equal(false);
			expect(sets(h).pop()).to.match(/ :bob:!/);
		});

		it("a device clock behind the server does not cut a close's boundary short", function () {
			const h = account();
			// The server's time is 30 s ahead of this device's 12:00.
			const ahead = "2026-08-28T12:00:30.000Z";
			h.transport.line(`@time=${ahead};msgid=p9 :bob!bob@host PRIVMSG alice :hi`);
			h.client.input(h.client.findChannel("bob")!.id, "/close");
			h.dispatch.resetHistory();
			h.transport.line(`@time=${ahead};msgid=p9 :bob!bob@host PRIVMSG alice :hi`);
			expect(queryJoins(h, "bob")).to.deep.equal([]);
		});

		it("a device clock minutes behind the server does not cut a close's boundary short", function () {
			const h = account();
			const ahead = "2026-08-28T12:02:00.000Z"; // the server, two minutes ahead
			h.transport.line(`@time=${ahead};msgid=p8 :bob!bob@host PRIVMSG alice :hi`);
			h.client.input(h.client.findChannel("bob")!.id, "/close");
			h.dispatch.resetHistory();
			h.transport.line(`@time=${ahead};msgid=p8 :bob!bob@host PRIVMSG alice :hi`);
			expect(queryJoins(h, "bob")).to.deep.equal([]);
		});

		it("a device clock behind the server keeps its own close through a reload and the login read", function () {
			const uuid = "closed-slow-clock";
			const ahead = "2026-08-28T12:02:00.000Z"; // the server, two minutes ahead
			const login = [":irc.test 900 alice alice!a@h alice :You are now logged in as alice"];
			const first = setup({uuid});
			register(first, META_CAPS, login);
			clock.tick(MUTE_READ_DELAY_MS);
			first.transport.line(":irc.test 766 alice alice seance/closed :key not set");
			first.transport.line(`@time=${ahead};msgid=p8 :bob!bob@host PRIVMSG alice :hi`);
			first.client.input(first.client.findChannel("bob")!.id, "/close");
			const [written] = sets(first);
			expect(written).to.be.a("string");

			// A reload: the account hands back what this device wrote, still
			// dated after this device's clock.
			const second = setup({uuid});
			register(second, META_CAPS, login);
			second.transport.line(`@time=${ahead};msgid=p8 :bob!bob@host PRIVMSG alice :hi`);
			clock.tick(MUTE_READ_DELAY_MS);
			second.transport.line(
				`:irc.test 761 alice alice seance/closed private :${written.slice(
					written.indexOf(" :") + 2
				)}`
			);
			expect(queryJoins(second, "bob")).to.deep.equal([]);
			expect(sets(second)).to.deep.equal([]);
		});

		it("takes a 761 only for our own key, not another user's an oper asked for", function () {
			const h = account();
			h.transport.line(`:irc.test 761 alice mallory seance/closed private :bob:${t36(t0)}`);
			expect(h.client.closed.entries()).to.deep.equal([]);
		});

		it("with private conversations not kept, the next login read deletes the account's list once", function () {
			setClosedQueriesKept(false);
			const h = account();
			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(`:irc.test 761 alice alice seance/closed private :bob:${t36(t0)}`);
			expect(sets(h)).to.deep.equal(["METADATA * SET seance/closed"]);
			// The server confirms the delete as "key not set".
			h.transport.line(":irc.test 766 alice alice seance/closed :key not set");
			h.transport.line(`:irc.test 761 alice alice seance/closed private :carol:${t36(t0)}`);
			expect(sets(h)).to.have.length(1);
		});

		it("tries the delete again at the next read when the server never confirmed it", function () {
			setClosedQueriesKept(false);
			const uuid = "closed-unconfirmed-net";
			const login = [":irc.test 900 alice alice!a@h alice :You are now logged in as alice"];
			const first = setup({uuid});
			register(first, META_CAPS, login);
			clock.tick(MUTE_READ_DELAY_MS);
			first.transport.line(`:irc.test 761 alice alice seance/closed private :bob:${t36(t0)}`);
			expect(sets(first)).to.have.length(1);
			// The socket goes before the server read the delete.
			first.transport.closed();

			const second = setup({uuid});
			register(second, META_CAPS, login);
			clock.tick(MUTE_READ_DELAY_MS);
			second.transport.line(
				`:irc.test 761 alice alice seance/closed private :bob:${t36(t0)}`
			);
			expect(sets(second)).to.deep.equal(["METADATA * SET seance/closed"]);
		});

		it("turning it off while a network is down deletes that network's list when it next reads it", function () {
			const h = account();
			onClosedSharingStopped(() => h.client.unshareClosed());
			h.transport.closed();
			setClosedQueriesKept(false);
			expect(sets(h)).to.deep.equal([]);
			register(h, META_CAPS, [
				":irc.test 900 alice alice!a@h alice :You are now logged in as alice",
			]);
			clock.tick(MUTE_READ_DELAY_MS);
			h.transport.line(`:irc.test 761 alice alice seance/closed private :bob:${t36(t0)}`);
			expect(sets(h)).to.deep.equal(["METADATA * SET seance/closed"]);
		});

		it("another tab's close applies here", function () {
			const h = account();
			h.transport.line(`@time=${T0};msgid=p0 :bob!bob@host PRIVMSG alice :hi`);
			const id = h.client.findChannel("bob")!.id;
			h.dispatch.resetHistory();
			new ClosedQueries(h.client.uuid, (n) => n.toLowerCase()).close("bob", t0);
			closedStorageChanged([h.client]);
			expect(h.payloads<{chan: number}>("part")).to.deep.equal([{chan: id}]);
		});
	});
});
